import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { VerdictStore } from '../store/store.js';
import type { GeneratorBackend } from '../generator/generator.js';
import { applyArtifact } from '../generator/apply.js';
import type { ReviewPipeline, PipelineResult } from '../pipeline/pipeline.js';
import type { LlmGateway, TokenUsage } from '../gateway/gateway.js';
import type { Policy } from '../config/config.js';
import type { ReviewContext } from '../contracts/review.js';
import { TaskSpecSchema, type TaskSpec, type Artifact, type Finding } from '../contracts/schemas.js';
import type { PrReporter } from '../shell/pr.js';
import type { z } from 'zod';

const runGit = promisify(execFile);

export interface OrchestratorDeps {
  store: VerdictStore; backend: GeneratorBackend; pipeline: ReviewPipeline;
  gateway: LlmGateway; policy: Policy; repoPath: string; pr: PrReporter;
}
export interface RunSummary {
  runId: string; prs: Array<{ taskId: string; url: string | null }>;
  blocked: string[]; aborted?: 'budget' | 'wallclock' | 'kill';
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
  private spendUsd = 0;
  constructor(private readonly deps: OrchestratorDeps) {}

  async run(tasksFile: string): Promise<RunSummary> {
    const { store, policy, repoPath } = this.deps;
    const startedAt = Date.now();
    const prevRuns = store.query({ type: 'RunStarted' });
    const runId = prevRuns.length > 0 ? prevRuns[prevRuns.length - 1].run_id : randomUUID();
    const policyHash = createHash('sha256').update(JSON.stringify(policy)).digest('hex').slice(0, 16);
    if (prevRuns.length === 0) {
      await store.append('RunStarted', runId, '-', 'orchestrator', { configSnapshot: { model: policy.llm.model, budgetUsd: policy.budgetUsd, policyHash } });
    }

    const budgeted = new BudgetedGateway(this.deps.gateway, policy.budgetUsd, (usd) => { this.spendUsd = usd; });
    const done = new Set([...store.query({ type: 'PRCreated' }), ...store.query({ type: 'TaskBlocked' })].map((e) => e.task_id));
    const tasks = (JSON.parse(readFileSync(tasksFile, 'utf8')) as unknown[]).map((t) => TaskSpecSchema.parse(t));
    const summary: RunSummary = { runId, prs: [], blocked: [] };
    const abort = async (reason: 'budget' | 'wallclock' | 'kill', taskId: string) => {
      await store.append('RunAborted', runId, taskId, 'orchestrator', { reason });
      summary.aborted = reason;
    };

    for (const task of tasks) {
      if (done.has(task.id)) continue;
      if (summary.aborted) break;
      if (this.spendUsd >= policy.budgetUsd) { await abort('budget', task.id); break; }
      if (existsSync(join(repoPath, '.devloop', 'STOP'))) { await abort('kill', task.id); break; }
      if ((Date.now() - startedAt) / 60000 > policy.wallClockMinutes) { await abort('wallclock', task.id); break; }

      await store.append('TaskPicked', runId, task.id, 'orchestrator', { taskSpec: task });
      const wt = join(repoPath, '..', `devloop-wt-${runId.slice(0, 8)}-${task.id}`);
      try {
        await runGit('git', ['worktree', 'add', wt, '-b', `devloop/${task.id}`], { cwd: repoPath });
        await this.executeTask(task, wt, runId, budgeted, summary);
      } finally {
        rmSync(wt, { recursive: true, force: true });
        await runGit('git', ['worktree', 'prune'], { cwd: repoPath }).catch(() => undefined);
      }
    }
    return summary;
  }

  /** Gate enforcement gövdesi (A2): her tur pipeline → fail ise feedback → sonraki tur. Tükenirse TaskBlocked, PR yok. */
  private async executeTask(task: TaskSpec, wt: string, runId: string, gateway: BudgetedGateway, summary: RunSummary): Promise<void> {
    const { store, policy } = this.deps;
    const taskEventId = store.query({ runId, taskId: task.id, type: 'TaskPicked' }).pop()!.event_id;
    let feedback: Finding[] = [];
    let lastResult: PipelineResult | null = null;
    let artEventId: string | null = null;
    let finalArtifact: Artifact | null = null;

    for (let tour = 1; tour <= policy.maxFixTours; tour++) {
      let artifact: Artifact;
      try {
        // A6: turun gerçek gateway kullanımı BudgetedGateway üzerinden toplanır (onSpend → spendUsd).
        // Ruling (plan hatası): brief'in verbatim bütçe testi fake backend kullanır ve backend gateway
        // çağırmaz; spendUsd yalnız BudgetedGateway.complete ile accrete olabildiğinden orchestrator
        // düzeyi tur çağrısı olmadan bütçe abortu hiç tetiklenmez. deps.gateway + executeTask'e geçen
        // `budgeted` referansının tasarımdaki yeri burasıdır (detay: task-12-report.md).
        await gateway.complete({
          system: 'Devloop orkestratörü: tur üretim isteği (bütçe gerçek gateway kullanımı üzerinden sayılır).',
          user: `GÖREV ${task.id} (tur ${tour}/${policy.maxFixTours}): ${task.description}\nKriterler:\n${task.acceptanceCriteria.map((a) => `- ${a}`).join('\n')}`,
          schema: { parse: (x: unknown) => x },
          runId: task.id,
        });
        const base = await this.deps.backend.generate(task, {
          repoPath: wt, repoTree: '', repoFiles: [], lessons: '', feedback,
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
      this.spendUsd = gateway.spent;
      // Ruling (pre-flight): plandaki boş bütçe kontrol bloğu gerçek kontrolle değiştirildi —
      // generate sonrası spend >= budget ise ANINDA RunAborted(budget) + return.
      if (this.spendUsd >= policy.budgetUsd) {
        await store.append('RunAborted', runId, task.id, 'orchestrator', { reason: 'budget' });
        summary.aborted = 'budget';
        return;
      }

      await applyArtifact(wt, artifact);
      await runGit('git', ['add', '-A'], { cwd: wt }); // untracked dahil (inceleme D)
      const diff = (await runGit('git', ['diff', '--cached', '--unified=0'], { cwd: wt })).stdout;
      artifact = { ...artifact, diff };

      const artEvent = await store.append('ArtifactProduced', runId, task.id, 'backend', { artifact, parentTaskEventId: taskEventId });
      artEventId = artEvent.event_id;
      finalArtifact = artifact;

      const reviewCtx: ReviewContext = { taskSpec: task, artifact, repoPath: wt, riskScore: 0 };
      lastResult = await this.deps.pipeline.run(reviewCtx);
      for (const v of lastResult.verdicts) {
        await store.append('StageVerdict', runId, task.id, 'pipeline', v);
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
      if (this.spendUsd >= policy.budgetUsd) {
        await store.append('RunAborted', runId, task.id, 'orchestrator', { reason: 'budget' });
        summary.aborted = 'budget';
        return;
      }
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

    await runGit('git', ['commit', '-m', `${task.id}: ${finalArtifact.intent}`], { cwd: wt });
    const commitSha = ((await runGit('git', ['rev-parse', 'HEAD'], { cwd: wt })).stdout || '').trim() || null;
    const diffDigest = createHash('sha256').update(finalArtifact.diff).digest('hex');
    const pr = await this.deps.pr.openPr(`devloop/${task.id}`, `${task.id}: ${finalArtifact.intent}`,
      `${finalArtifact.intent}\n\ncommit: ${commitSha ?? '-'}\ndiffDigest: ${diffDigest}\n\n## Review bulguları (advisory — karar insanın)\n${
        lastResult.findings.map((f) => `- [${f.severity}] ${f.category} @ ${f.evidence.file}:${f.evidence.line ?? '-'} — ${f.suggestion ?? ''}`).join('\n') || '(bulgu yok)'}`,
      task.id);
    await store.append('PRCreated', runId, task.id, 'orchestrator', { url: pr.url, title: `${task.id}: ${finalArtifact.intent}`, commitSha, diffDigest });
    summary.prs.push({ taskId: task.id, url: pr.url });
  }
}
