import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { VerdictStore } from '../store/store.js';
import type { GeneratorBackend } from '../generator/generator.js';
import { readRepoContext } from '../generator/generator.js';
import { applyArtifact } from '../generator/apply.js';
import type { ReviewPipeline, PipelineResult } from '../pipeline/pipeline.js';
import type { LlmGateway, TokenUsage } from '../gateway/gateway.js';
import { GatewayError } from '../gateway/gateway.js';
import type { Policy } from '../config/config.js';
import type { ReviewContext } from '../contracts/review.js';
import { TaskSpecSchema, type TaskSpec, type Artifact, type Finding } from '../contracts/schemas.js';
import type { PrReporter } from '../shell/pr.js';
import { safeEnv } from '../shell/safeEnv.js';
import type { z } from 'zod';

const runGit = promisify(execFile);
// I2 (final review): tüm git çocuk süreçleri seçilmiş env ile koşar — sırlar (API anahtarları)
// worktree/git süreçlerine sızmaz. GIT_/SSH_ + PATH gibi ayak izi safeEnv'de.
const git = (args: string[], cwd: string) => runGit('git', args, { cwd, env: safeEnv() });

export interface OrchestratorDeps {
  store: VerdictStore; backend: GeneratorBackend; pipeline: ReviewPipeline;
  gateway: LlmGateway; policy: Policy; repoPath: string; pr: PrReporter;
}
export interface RunSummary {
  runId: string; prs: Array<{ taskId: string; url: string | null }>;
  blocked: string[]; aborted?: 'budget' | 'wallclock' | 'kill' | 'panic';
}
export class BudgetExceededError extends Error {}

export class BudgetedGateway implements LlmGateway { // A6: bütçe gerçek usage üzerinden
  private total = 0;
  constructor(private readonly inner: LlmGateway, private readonly budgetUsd: number, private readonly onSpend: (usd: number) => void) {}
  get spent(): number { return this.total; }
  async complete<T>(req: { system: string; user: string; schema: { parse: (x: unknown) => T }; runId: string }): Promise<{ data: T; usage: TokenUsage }> {
    // Ön-kontrol: bütçe dengesine (>=) başlanan çağrı reddedilir (çağrı ücreti harcanmaz).
    if (this.total >= this.budgetUsd) throw new BudgetExceededError(`Bütçe aşıldı: $${this.total.toFixed(2)} / $${this.budgetUsd}`);
    // Plan notu: sınıfın genel imzası { parse } serbest şekli; inner LlmGateway z.ZodType bekler — sınırda cast.
    const r = await this.inner.complete(req as { system: string; user: string; schema: z.ZodType<T>; runId: string });
    this.total += r.usage.costUsd;
    this.onSpend(this.total);
    // Gerçek usage toplamı bütçeyi AŞARSA (>) yanıt reddedilir — ücret harcanır
    // (ruling: 'yanlışsa bir generate çağrısının ücreti harcanır'). Tam bütçeye eşitleme (> DEĞİL) serbest.
    if (this.total > this.budgetUsd) throw new BudgetExceededError(`Bütçe aşıldı: $${this.total.toFixed(2)} / $${this.budgetUsd}`);
    return r;
  }
}

export class Orchestrator {
  // Hüküm (fix round 1): bütçe per-run; resume yeni bütçe alır — A6 'gerçek usage' değişmezi
  // koşum bazında işler (açık insan yeniden-koşumu yeni bütçeye rıza gösterir).
  constructor(private readonly deps: OrchestratorDeps) {}

  /**
   * I1 (final review): bütçe TEK KAPI — BudgetedGateway CLI'da kurulur ve backend/reviewer/
   * deps.gateway'a AYNI örnek geçilir (canary çağrısı kaldırıldı). Orchestrator harcamayı yalnız
   * gözlemler: gerçek harcayan (LlmGeneratorBackend/LlmReviewerStage) BudgetedGateway örneğini
   * kullanır; spend onun `spent`'inden okunur. BudgetedGateway değilse (test fake'leri) 0.
   */
  private currentSpend(): number {
    const gw = this.deps.gateway;
    return gw instanceof BudgetedGateway ? gw.spent : 0;
  }

  async run(tasksFile: string): Promise<RunSummary> {
    const { store, policy, repoPath } = this.deps;
    const startedAt = Date.now();
    const prevRuns = store.query({ type: 'RunStarted' });
    const lastRun = prevRuns.length > 0 ? prevRuns[prevRuns.length - 1] : null;
    const runId = lastRun ? lastRun.run_id : randomUUID();
    const policyHash = createHash('sha256').update(JSON.stringify(policy)).digest('hex').slice(0, 16);
    const summary: RunSummary = { runId, prs: [], blocked: [] };
    if (lastRun) {
      // Minor (fix round 1): resume'da politika kayması sessiz karışım değil — panic ile dur.
      const storedHash = lastRun.type === 'RunStarted' ? lastRun.payload.configSnapshot.policyHash : undefined;
      if (storedHash !== policyHash) {
        await store.append('RunAborted', runId, '-', 'orchestrator', { reason: 'panic' });
        summary.aborted = 'panic';
        return summary;
      }
    } else {
      await store.append('RunStarted', runId, '-', 'orchestrator', { configSnapshot: { model: policy.llm.model, budgetUsd: policy.budgetUsd, policyHash } });
    }

    // A2 (C2): worktree artık repo içinde (<repo>/.devloop/worktrees/) — .devloop/ hedef reponun
    // .git/info/exclude'una yazılır (kullanıcının .gitignore'una dokunulmaz); koşum başına bir kez.
    this.ensureDevloopExcluded(repoPath);

    const done = new Set([...store.query({ type: 'PRCreated' }), ...store.query({ type: 'TaskBlocked' })].map((e) => e.task_id));
    const tasks = (JSON.parse(readFileSync(tasksFile, 'utf8')) as unknown[]).map((t) => TaskSpecSchema.parse(t));
    const abort = async (reason: 'budget' | 'wallclock' | 'kill', taskId: string) => {
      await store.append('RunAborted', runId, taskId, 'orchestrator', { reason });
      summary.aborted = reason;
    };

    for (const task of tasks) {
      if (done.has(task.id)) continue;
      if (summary.aborted) break;
      // Fix round 1: görev-topu guardı > — tam bütçeye eşitleme (==) geçen görevi TAMAMLAR;
      // sonraki görev, gateway pre-call reject (total >= budget) ile RunAborted(budget) alır (run-level).
      // I1: spend, CLI'nın kurduğu BudgetedGateway örneğinden okunur (canary çağrısı yok).
      if (this.currentSpend() > policy.budgetUsd) { await abort('budget', task.id); break; }
      if (existsSync(join(repoPath, '.devloop', 'STOP'))) { await abort('kill', task.id); break; }
      if ((Date.now() - startedAt) / 60000 > policy.wallClockMinutes) { await abort('wallclock', task.id); break; }

      await store.append('TaskPicked', runId, task.id, 'orchestrator', { taskSpec: task });
      // A2 (C2): worktree repo İÇİNDE — Node'un parent-walk'ı hedef reponun node_modules'una
      // ulaşır (araç çözümlemesi lint/typecheck'te worktree'de çalışır; sibling path'te asla erişemezdi).
      const wt = join(repoPath, '.devloop', 'worktrees', `${runId.slice(0, 8)}-${task.id}`);
      try {
        // Fix round 1 (Important): çöken/abort olan önceki koşumun bıraktığı stale branch worktree
        // add'i ölümcül kılar (tam resume vakası) — varsa sil, worktree add taze branch açar.
        await git(['branch', '-D', `devloop/${task.id}`], repoPath).catch(() => undefined);
        await git(['worktree', 'add', wt, '-b', `devloop/${task.id}`], repoPath);
        await this.executeTask(task, wt, runId, summary);
      } catch (e) {
        if (e instanceof BudgetExceededError) {
          // bütçe → run-level semantik korunur (kill/wallclock döngü-topunda zaten run-level).
          await store.append('RunAborted', runId, task.id, 'orchestrator', { reason: 'budget' });
          summary.aborted = 'budget';
        } else if (e instanceof GatewayError) {
          // I5 (final review, spec §7.4): gateway/altyapı hatası (ağ/API) görev-düzeyi blok DEĞİL —
          // run-level suspend (panic): resume edilebilir, kalan görev listesi yanmaz (done setine
          // TaskBlocked/PRCreated yazılmaz); TaskBlocked spam'i oluşmaz.
          await store.append('RunAborted', runId, task.id, 'orchestrator', { reason: 'panic' });
          summary.aborted = 'panic';
        } else {
          // Fix round 1 (Important): görev düzeyi izolasyon — git arızası tüm koşumu düşürmez.
          const msg = (e instanceof Error ? e.message : String(e)).slice(0, 200);
          await store.append('TaskBlocked', runId, task.id, 'orchestrator', { reason: `git-hata: ${msg}` });
          summary.blocked.push(task.id);
        }
      } finally {
        try { rmSync(wt, { recursive: true, force: true }); } catch { /* Windows EBUSY — prune aşağıda */ }
        await git(['worktree', 'prune'], repoPath).catch(() => undefined);
      }
    }
    return summary;
  }

  /**
   * A2 (C2): `.devloop/` hedef reponun `.git/info/exclude`'una yazılır — kullanıcının .gitignore'una
   * dokunulmaz (repo içi worktree ana repoda `?? .devloop/` gürültüsü yaratmasın). Idempotent:
   * mevcut exclude içeriği `.devloop/` içeriyorsa yazım yok. Kanıt günlüğü gitignore'u hedef
   * repolarda buradan karşılanır (devloop repolar arası dosya yazmaz).
   */
  private ensureDevloopExcluded(repoPath: string): void {
    const excludePath = join(repoPath, '.git', 'info', 'exclude');
    try {
      let content = '';
      try { content = readFileSync(excludePath, 'utf8'); } catch { /* dosya yok — yeni yazılacak */ }
      if (content.split(/\r?\n/).some((line) => line.trim() === '.devloop/')) return;
      mkdirSync(join(repoPath, '.git', 'info'), { recursive: true });
      writeFileSync(excludePath, (content && !content.endsWith('\n') ? content + '\n' : content) + '.devloop/\n', 'utf8');
    } catch {
      // exclude yazımı best-effort: başarısızlık koşumu engellemez (git status gürültüsü kalır, işlev bozulmaz)
    }
  }

  /** Gate enforcement gövdesi (A2): her tur pipeline → fail ise feedback → sonraki tur. Tükenirse TaskBlocked, PR yok. */
  private async executeTask(task: TaskSpec, wt: string, runId: string, summary: RunSummary): Promise<void> {
    const { store, policy } = this.deps;
    const taskEventId = store.query({ runId, taskId: task.id, type: 'TaskPicked' }).pop()!.event_id;
    let feedback: Finding[] = [];
    let lastResult: PipelineResult | null = null;
    let artEventId: string | null = null;
    let finalArtifact: Artifact | null = null;

    for (let tour = 1; tour <= policy.maxFixTours; tour++) {
      let artifact: Artifact;
      try {
        // C1: generator gerçek repo bağlamını görür — orchestrator düzeyinde doldurulur
        // (backend kendi kendine doldurmaz; orchestrator sahibi). Boş repoTree/repoFiles üretim hatasıydı.
        // I1: bütçe canary çağrısı YOK. R1: gateway GenerationContext ile taşınır — backend'in
        // gateway kullanımı deps.gateway (CLI'nın kurduğu tek BudgetedGateway) üzerinden
        // accrete olur; orchestrator yalnız gözlemler.
        const repoCtx = readRepoContext(wt, task.filesScope);
        const base = await this.deps.backend.generate(task, {
          ...repoCtx, lessons: '', feedback, gateway: this.deps.gateway,
        });
        artifact = base;
      } catch (e) {
        if (e instanceof BudgetExceededError) {
          await store.append('RunAborted', runId, task.id, 'orchestrator', { reason: 'budget' });
          summary.aborted = 'budget';
          return;
        }
        throw e;
      }
      // Hüküm (pre-flight): generate sonrası bütçe aşımı ANINDA RunAborted(budget) + return.
      // Fix round 1: tam bütçeye eşitleme (==) geçen turu tamamlar; aşım (>) abort
      // (BudgetedGateway post-call throw ile aynı eşik; > burada savunma katmanıdır).
      if (this.currentSpend() > policy.budgetUsd) {
        await store.append('RunAborted', runId, task.id, 'orchestrator', { reason: 'budget' });
        summary.aborted = 'budget';
        return;
      }

      await applyArtifact(wt, artifact);
      await git(['add', '-A'], wt); // untracked dahil (inceleme D)
      const diff = (await git(['diff', '--cached', '--unified=0'], wt)).stdout;
      artifact = { ...artifact, diff };
      if (diff.trim() === '') {
        // Minor (fix round 1): sıfır-diff artifact commit'te crash eder ('nothing to commit') —
        // izole TaskBlocked; PR yok (A2), koşum sonraki görevle devam eder.
        await store.append('TaskBlocked', runId, task.id, 'orchestrator', { reason: 'zero-diff' });
        summary.blocked.push(task.id);
        return;
      }

      const artEvent = await store.append('ArtifactProduced', runId, task.id, 'backend', { artifact, parentTaskEventId: taskEventId });
      artEventId = artEvent.event_id;
      finalArtifact = artifact;

      const reviewCtx: ReviewContext = { taskSpec: task, artifact, repoPath: wt, riskScore: 0 };
      lastResult = await this.deps.pipeline.run(reviewCtx);
      for (const v of lastResult.verdicts) {
        // I6: verdict artifact'e bağlanır (parentArtifactEventId zorunlu — validateChain scalar listesi);
        // I5: stage'in errorMessage'ı (varsa) kanıta taşınır.
        await store.append('StageVerdict', runId, task.id, 'pipeline', { ...v, parentArtifactEventId: artEvent.event_id });
      }
      await store.append('RiskScored', runId, task.id, 'risk-triage', {
        score: reviewCtx.riskScore, signals: reviewCtx.riskSignals ?? {}, policyVersion: String(policy.version),
        parentArtifactEventId: artEvent.event_id,
      });
      for (const f of lastResult.findings) {
        await store.append('FindingEmitted', runId, task.id, f.stage, { finding: f, parentArtifactEventId: artEvent.event_id });
      }
      if (lastResult.passed) break;
      feedback = lastResult.findings;
      // Minor (fix round 1): tur-sonu bütçe kontrolü yok — I1 ile gateway çağrısı yalnız backend'in
      // generate'ının içinden geçer; sonraki turun başındaki generate bunu aşarsa BudgetedGateway
      // post-call throw → RunAborted(budget).
    }

    if (!lastResult || !lastResult.passed || !finalArtifact || !artEventId) {
      if (!summary.aborted) {
        await store.append('TaskBlocked', runId, task.id, 'orchestrator', {
          reason: lastResult ? `gate-fail: ${lastResult.gateFailed}` : 'tur-tükendi', parentArtifactEventId: artEventId ?? undefined,
        });
        summary.blocked.push(task.id);
      }
      return; // A2: gate fail → commit/PR YOK
    }

    await git(['commit', '-m', `${task.id}: ${finalArtifact.intent}`], wt);
    const commitSha = ((await git(['rev-parse', 'HEAD'], wt)).stdout || '').trim() || null;
    const diffDigest = createHash('sha256').update(finalArtifact.diff).digest('hex');
    const pr = await this.deps.pr.openPr(`devloop/${task.id}`, `${task.id}: ${finalArtifact.intent}`,
      `${finalArtifact.intent}\n\ncommit: ${commitSha ?? '-'}\ndiffDigest: ${diffDigest}\n\n## Review bulguları (advisory — karar insanın)\n${
        lastResult.findings.map((f) => `- [${f.severity}] ${f.category} @ ${f.evidence.file}:${f.evidence.line ?? '-'} — ${f.suggestion ?? ''}`).join('\n') || '(bulgu yok)'}`,
      task.id);
    await store.append('PRCreated', runId, task.id, 'orchestrator', { url: pr.url, title: `${task.id}: ${finalArtifact.intent}`, commitSha, diffDigest });
    summary.prs.push({ taskId: task.id, url: pr.url });
  }
}
