import { Command } from 'commander';
import { join, resolve } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { loadConfig } from '../config/config.js';
import { VerdictStore, validateChain } from '../store/store.js';
import { AnthropicGateway } from '../gateway/gateway.js';
import { LlmGeneratorBackend } from '../generator/generator.js';
import { LessonMemory } from '../memory/memory.js';
import { generateCandidates, confirmCandidate, generateProposals, applyProposal } from '../learning/learn.js';
import { Orchestrator, BudgetedGateway } from '../orchestrator/orchestrator.js';
import { PrReporter } from './pr.js';
import { runReviewDiff } from './reviewDiff.js';
import { ReviewPipeline } from '../pipeline/pipeline.js';
import { RiskTriageStage } from '../pipeline/stages/riskTriage.js';
import { StaticGatesStage } from '../pipeline/stages/staticGates.js';
import { TestGateStage } from '../pipeline/stages/testGate.js';
import { SecretScanStage } from '../pipeline/stages/secretScan.js';
import { MutationStage } from '../pipeline/stages/mutationStage.js';
import { LlmReviewerStage } from '../pipeline/stages/llmReviewer.js';
import { LlmReviewerAltStage } from '../pipeline/stages/llmReviewerAlt.js';
import { LlmEnsembleStage } from '../pipeline/stages/llmEnsemble.js';
import { TypeScriptAdapter } from '../adapters/typescript/index.js';

export function buildCli(workDir = process.cwd()): Command {
  const program = new Command();
  program.name('devloop').description('AI geliştirme + otomatik review döngüsü (trusted repos only)');
  const repoDir = () => process.env.DEVLOOP_REPO ?? workDir;
  const store = () => new VerdictStore(join(repoDir(), '.devloop', 'events.jsonl'));
  const memory = () => new LessonMemory(store(), join(repoDir(), '.devloop', 'lessons.md'));

  program.command('run').argument('[tasksFile]', 'görev listesi', 'tasks.json').action(async (tasksFile: string) => {
    const { policy } = loadConfig(repoDir());
    const s = store();
    const mem = memory();
    // I1 (final review): bütçe TEK KAPI — BudgetedGateway CLI'da kurulur ve backend, reviewer
    // stage ve deps.gateway'a AYNI örnek geçilir. Böylece gerçek harcayan her çağrı bütçe sayacına
    // düşer; orchestrator içi ayrı sarmalama/canary çağrısı yoktur (kaldırıldı).
    const gateway = new BudgetedGateway(new AnthropicGateway(policy), policy.budgetUsd, () => {});
    const adapter = new TypeScriptAdapter();
    // R2 (T4): advisory zinciri llm-reviewer → llm-ensemble. Primary daima koşar; alt (güvenlik+
    // performans rubriği, fallbackModel override) yalnız primary bulgulu veya risk ≥ eşikte koşar.
    // Bu kayıt, policy advisory [llm-ensemble, ...] ile PipelineConfigError penceresini kapatır.
    const ensemble = new LlmEnsembleStage(
      new LlmReviewerStage(gateway, mem), // A4: reviewer dersleri buraya
      new LlmReviewerAltStage(gateway, { model: policy.llm.fallbackModel, reviewerLessons: mem }),
      policy,
    );
    const pipeline = new ReviewPipeline([
      new RiskTriageStage(policy), new StaticGatesStage(adapter), new TestGateStage(adapter),
      new SecretScanStage(), new MutationStage(policy),
      ensemble,
    ], policy);
    const orchestrator = new Orchestrator({
      store: s,
      backend: new LlmGeneratorBackend(gateway, mem), // A4: generator dersleri buraya
      pipeline, gateway, policy, repoPath: repoDir(), pr: new PrReporter(repoDir()),
    });
    // §7.3 acil durdurma: SIGINT → kill marker dosyası; abort orchestrator'ın mevcut
    // görev-topu guard'ı (STOP varlığı) ile bir sonraki görev sınırında yapılır — zorla çıkış yok.
    const onSigint = () => {
      try {
        mkdirSync(join(repoDir(), '.devloop'), { recursive: true });
        writeFileSync(join(repoDir(), '.devloop', 'STOP'), new Date().toISOString(), 'utf8');
      } catch { /* marker yazımı best-effort */ }
    };
    process.on('SIGINT', onSigint);
    try {
      // I7 (final review): resolve — absolute tasksFile yolu bozulmaz (join ile aykırı davranış vardı)
      const summary = await orchestrator.run(resolve(repoDir(), tasksFile));
      mem.render(); // aktif dersler dosyaya (commit edilir — Generator okur)
      console.log(JSON.stringify(summary, null, 2));
    } finally {
      // Listener kalkmazsa SIGINT'in varsayılan sonlandırması süresiz baskılanır (Ctrl+C ölümlü olmaz) — koşum sonrası kaldır.
      process.removeListener('SIGINT', onSigint);
    }
  });

  program.command('status').action(async () => {
    const s = store();
    const chain = validateChain(s.readAll());
    console.log(`runs=${s.query({ type: 'RunStarted' }).length} prs=${s.query({ type: 'PRCreated' }).length} blocked=${s.query({ type: 'TaskBlocked' }).length} decisions=${s.query({ type: 'HumanDecision' }).length} lessons=${s.query({ type: 'LessonLearned' }).length} chain=${chain.ok ? 'ok' : 'BROKEN: ' + chain.errors.join('; ')}`);
  });

  const learn = program.command('learn').description('aday dersleri listele/onayla');
  learn.action(async () => {
    const candidates = generateCandidates(store());
    console.log(candidates.map((c) => `${c.lessonId}  [${c.pattern}→${c.targetComponent}]  ${c.rule}`).join('\n') || '(aday yok)');
  });
  learn.command('confirm').argument('<lessonId>').action(async (lessonId: string) => {
    const s = store();
    const c = generateCandidates(s).find((x) => x.lessonId === lessonId);
    if (!c) throw new Error('Aday bulunamadı');
    const mem = memory();
    await confirmCandidate(s, mem, c);
    console.log('Aktif edildi + render edildi.');
  });
  learn.command('reject').argument('<lessonId>').action(async (lessonId: string) => {
    const s = store();
    const mem = memory();
    // I4 (final review): ret için iki yol — (1) ID bir CANDIDATE ise tombstone yaz (retired
    // LessonLearned; rule/scope/confidence adaydan türetilir, deterministik ID retired filtresiyle
    // yeniden listelenmez), (2) aktif ders ise mevcut markRetired yolu; ikisi de değilse hata.
    const candidate = generateCandidates(s).find((x) => x.lessonId === lessonId);
    if (candidate) {
      await mem.appendLesson({
        lessonId: candidate.lessonId, rule: candidate.rule, scope: candidate.scope,
        confidence: candidate.confidence, status: 'retired', targetComponent: candidate.targetComponent,
        parentDecisionEventIds: [],
      });
      await mem.render();
      console.log('Aday reddedildi (tombstone yazıldı).');
      return;
    }
    const isActive = s.query({ type: 'LessonLearned' }).some((e) => e.type === 'LessonLearned' && e.payload.lessonId === lessonId && e.payload.status === 'active');
    if (!isActive) throw new Error('Aday veya aktif ders bulunamadı');
    await mem.markRetired(lessonId, []);
    console.log('Retired.');
  });

  // R5 (faz 2 T7): L2 kural önerileri — eşik l2MinDecisions policy'den okunur (varsayılan 100).
  learn.command('proposals').action(async () => {
    const { policy } = loadConfig(repoDir());
    const proposals = generateProposals(store(), policy.l2MinDecisions);
    console.log(proposals.map((p) => `${p.proposalId}  [${p.kind}]  ${p.category} — ${p.title}`).join('\n') || '(öneri yok)');
  });
  learn.command('apply').argument('<proposalId>').action(async (proposalId: string) => {
    const { policy } = loadConfig(repoDir());
    const s = store();
    const p = generateProposals(s, policy.l2MinDecisions).find((x) => x.proposalId === proposalId);
    if (!p) throw new Error('Öneri bulunamadı veya eşik altında');
    await applyProposal(s, join(repoDir(), '.devloop', 'proposals'), p);
    console.log('Öneri kaydedildi (ProposalCreated) + PROPOSAL.md yazıldı — insan onayı bekler.');
  });

  program.command('decide').requiredOption('--task <id>').option('--accept').option('--reject')
    .requiredOption('--reason <reason>').option('--note <note>').option('--findings <ids>')
    .action(async (opts: { task: string; accept?: boolean; reject?: boolean; reason: string; note?: string; findings?: string }) => {
      const decision = opts.accept ? 'accept' : opts.reject ? 'reject' : null;
      if (!decision) throw new Error('--accept veya --reject gerekli');
      await store().append('HumanDecision', 'manual', opts.task, 'human', {
        decision, reason: opts.reason as never, note: opts.note,
        parentFindingEventIds: (opts.findings ?? '').split(',').filter(Boolean),
      });
      console.log('Karar kaydedildi.');
    });

  // R6 (faz 2 T8): CI trigger mode — review-diff. Uygulanmamış PR diff'i (unified) parse edilip
  // artifact olarak pipeline'a verilir; kanıt aynı store'a yazılır (runId `ci-<task>`).
  // Exit sözleşmesi: 0 = gate'ler geçti + critical bulgu yok, 1 = gate fail VEYA critical bulgu,
  // 2 = yalnız advisory bulgular. Komut process.exitCode'u string olarak set eder (CI yakalar).
  // Pipeline kurulumu `run` komutuyla aynı desen (gerçek stage'ler; policy.yaml hangi stage'lerin
  // koşacağını belirler — CI'da LLM çağrısı için ANTHROPIC_API_KEY ortam değişkeni gerekir).
  program.command('review-diff').description('PR diff review (CI trigger mode — diff uygulanmaz)')
    .requiredOption('--diff <path>', 'unified diff dosyası; - ise stdin')
    .requiredOption('--task <id>', 'görev/kimlik (ör. pr-12)')
    .action(async (opts: { diff: string; task: string }) => {
      const { policy } = loadConfig(repoDir());
      const diffText = opts.diff === '-' ? readFileSync(0, 'utf8') : readFileSync(opts.diff, 'utf8');
      const mem = memory();
      const gateway = new BudgetedGateway(new AnthropicGateway(policy), policy.budgetUsd, () => {});
      const adapter = new TypeScriptAdapter();
      const ensemble = new LlmEnsembleStage(
        new LlmReviewerStage(gateway, mem),
        new LlmReviewerAltStage(gateway, { model: policy.llm.fallbackModel, reviewerLessons: mem }),
        policy,
      );
      const pipeline = new ReviewPipeline([
        new RiskTriageStage(policy), new StaticGatesStage(adapter), new TestGateStage(adapter),
        new SecretScanStage(), new MutationStage(policy),
        ensemble,
      ], policy);
      const r = await runReviewDiff({
        diffText, taskSpecId: opts.task, pipeline, store: store(), policy, repoPath: repoDir(),
      });
      console.log(`review-diff: exit=${r.exitCode} gateFailed=${r.gateFailed ?? '-'} findings=${r.findings.length}`);
      process.exitCode = String(r.exitCode);
    });
  return program;
}
