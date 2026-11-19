import { Command } from 'commander';
import { join, resolve } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { loadConfig } from '../config/config.js';
import { VerdictStore, validateChain } from '../store/store.js';
import { AnthropicGateway } from '../gateway/gateway.js';
import { LlmGeneratorBackend } from '../generator/generator.js';
import { LessonMemory } from '../memory/memory.js';
import { generateCandidates, confirmCandidate } from '../learning/learn.js';
import { Orchestrator, BudgetedGateway } from '../orchestrator/orchestrator.js';
import { PrReporter } from './pr.js';
import { ReviewPipeline } from '../pipeline/pipeline.js';
import { RiskTriageStage } from '../pipeline/stages/riskTriage.js';
import { StaticGatesStage } from '../pipeline/stages/staticGates.js';
import { TestGateStage } from '../pipeline/stages/testGate.js';
import { SecretScanStage } from '../pipeline/stages/secretScan.js';
import { MutationStubStage } from '../pipeline/stages/mutationStub.js';
import { LlmReviewerStage } from '../pipeline/stages/llmReviewer.js';
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
    const pipeline = new ReviewPipeline([
      new RiskTriageStage(policy), new StaticGatesStage(adapter), new TestGateStage(adapter),
      new SecretScanStage(), new MutationStubStage(),
      new LlmReviewerStage(gateway, mem), // A4: reviewer dersleri buraya
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
  return program;
}
