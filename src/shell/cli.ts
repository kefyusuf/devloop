import { Command } from 'commander';
import { join, resolve } from 'node:path';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { loadConfig, type Policy } from '../config/config.js';
import { VerdictStore, validateChain } from '../store/store.js';
import { createGatewayOrChain, altModelFor } from '../gateway/factory.js';
import { LlmGeneratorBackend } from '../generator/generator.js';
import { LessonMemory } from '../memory/memory.js';
import { generateCandidates, confirmCandidate, generateProposals, applyProposal } from '../learning/learn.js';
import {
  generateEvolutionCandidates, writeShadowCandidates, applyEvolution, loadCandidate, candidatePlaybookProvider,
  loadAppliedPlaybooks, generateLlmMutations, type EvolveContext, type EvolutionCandidate, type LlmMutationDraft,
} from '../evolution/evolve.js';
import { runEval, type EvalSummary } from '../eval/evalRunner.js';
import { loadGoldenTasks } from '../eval/golden.js';
import { generateGoldenDrafts, acceptDraft, discardDraft } from '../golden/draft.js';
import { Orchestrator, BudgetedGateway } from '../orchestrator/orchestrator.js';
import { PrReporter } from './pr.js';
import { runReviewDiff } from './reviewDiff.js';
import { composeReviewerLessons } from './composeLessons.js'; // R22 (faz 4 T3): per-line 'yok.' filtresi — 3 site tek helper
import { ReviewPipeline } from '../pipeline/pipeline.js';
import type { ReviewStage } from '../contracts/review.js';
import type { DevloopEvent, EventPayloadMap } from '../contracts/events.js';
import { RiskTriageStage } from '../pipeline/stages/riskTriage.js';
import { StaticGatesStage } from '../pipeline/stages/staticGates.js';
import { TestGateStage } from '../pipeline/stages/testGate.js';
import { SecretScanStage } from '../pipeline/stages/secretScan.js';
import { MutationStage } from '../pipeline/stages/mutationStage.js';
import { LlmReviewerStage } from '../pipeline/stages/llmReviewer.js';
import { LlmReviewerAltStage } from '../pipeline/stages/llmReviewerAlt.js';
import { LlmEnsembleStage } from '../pipeline/stages/llmEnsemble.js';
import { TypeScriptAdapter } from '../adapters/typescript/index.js';

// R10 (faz 3 T4): store'daki EvalRun payload'undan EvalSummary rekonstrüksiyonu — l3Active
// payload'da yoktur, goldenCount >= eşik ile türetilir (evalRunner summary'siyle aynı anlam).
// R15 fix round 1: invalid listesi payload'dan aynen taşınır (eski satırlarda şema default'u [] verir).
type EvalRunEvent = Extract<DevloopEvent, { type: 'EvalRun' }>;
function evalRunToSummary(p: EventPayloadMap['EvalRun'], l3MinGoldenTasks: number): EvalSummary {
  return {
    evalId: p.evalId, goldenCount: p.goldenCount, passed: p.passed, failed: p.failed, score: p.score,
    invalid: p.invalid,
    perTask: p.perTask, configSnapshot: p.configSnapshot, l3Active: p.goldenCount >= l3MinGoldenTasks,
    ...(p.comparedTo ? { comparedTo: p.comparedTo } : {}),
  };
}
// Son production eval = configSnapshot'ta 'candidate' OLMAYAN son EvalRun (evalRunner ile aynı kural);
// shadow eval = candidate='evolve-shadow' etiketli son EvalRun.
function lastEvalRun(s: VerdictStore, kind: 'production' | 'shadow'): EvalRunEvent | undefined {
  const runs = s.query({ type: 'EvalRun' }).filter((e): e is EvalRunEvent => e.type === 'EvalRun');
  const filtered = runs.filter((e) => kind === 'production'
    ? !('candidate' in e.payload.configSnapshot)
    : e.payload.configSnapshot['candidate'] === 'evolve-shadow');
  return filtered[filtered.length - 1];
}

// R25 (faz 5 T1): decide → GERÇEK run bağlantısı — L3 veri yolu (golden draft acceptedRuns:
// accept ∩ PRCreated) gerçek decide kararlarıyla kapanır. taskId'ye göre store'daki SON eşleşen
// TaskPicked'in run_id'si döner (dosya sırası kronolojiktir → pop() en yeni koşum); eşleşme yoksa
// null (fail-closed çağrı noktasında). TaskPicked zarfı task_id, payload.taskSpec.id ORCHESTRATOR
// GÖREV ID'sidir (multi-run store'da taskId tekil değil — taskSpec.id filtresi plan kontratıdır);
// 'manual' sentinel'i BURAYA girmez: yalnız decide '--run manual' explicit yolu yazar.
type TaskPickedEvent = Extract<DevloopEvent, { type: 'TaskPicked' }>;
function resolveRunIdForTask(s: VerdictStore, taskId: string): string | null {
  const picked = s.query({ type: 'TaskPicked' })
    .filter((e): e is TaskPickedEvent => e.type === 'TaskPicked' && e.payload.taskSpec.id === taskId)
    .pop();
  return picked ? picked.run_id : null;
}

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
    // R21 (faz 4 T6): cross-provider fallback — R26b helper (tek ayakta düz gateway, çok ayakta
    // chain, 0 ayakta fail-closed GatewayError); BudgetedGateway sarması aynen ve TÜM chain'i
    // kapsar (A6: her ayak harcaması budget'a işler).
    const gateway = new BudgetedGateway(createGatewayOrChain(policy), policy.budgetUsd, () => {});
    // R13: adapter policy alır — sandbox.mode docker ise lint/typecheck/tests koşumları konteynere
    // sarılır (dockerizeSpawn); host modda davranış değişmez. I2: originalRepoPath (deps.repoPath)
    // — docker modda orijinal repo node_modules'u /workspace/node_modules'a bind edilir.
    const adapter = new TypeScriptAdapter(policy, repoDir());
    // R2 (T4): advisory zinciri llm-reviewer → llm-ensemble. Primary daima koşar; alt (güvenlik+
    // performans rubriği, fallbackModel override) yalnız primary bulgulu veya risk ≥ eşikte koşar.
    // Bu kayıt, policy advisory [llm-ensemble, ...] ile PipelineConfigError penceresini kapatır.
    // I2 (final fix wave): reviewerLessons ARTIK KOMPOZE — aktif reviewer dersleri (mem) + apply
    // edilmiş playbook'lar (loadAppliedPlaybooks: .devloop/playbooks staging'i) aynı prompt'a girer.
    // R22 (faz 4 T3): kompozisyon composeReviewerLessons helper'ına taşındı — 'yok.' filtresi
    // SATIR bazlıdır (blok düşürme yok: tek kaynağın 'yok.' bildirimi diğerinin satırlarını düşürmez).
    const playbooks = loadAppliedPlaybooks(repoDir());
    const reviewerLessons = composeReviewerLessons([mem, playbooks]);
    const ensemble = new LlmEnsembleStage(
      new LlmReviewerStage(gateway, reviewerLessons), // A4: reviewer dersleri + I2 applied playbook'lar
      // I3: alt model provider-aware (anthropic/openai) — hardcode anthropic fallbackModel yerine
      new LlmReviewerAltStage(gateway, { model: altModelFor(policy), reviewerLessons }),
      policy,
    );
    const pipeline = new ReviewPipeline([
      new RiskTriageStage(policy), new StaticGatesStage(adapter), new TestGateStage(adapter),
      // R20 (faz 4 T5): mutation gate docker modda konteynerde koşar (faz 3.1 guard'ı kalktı);
      // originalRepoPath — dockerizeSpawn node_modules :ro çift mount kaynağı (adapter wiring'iyle aynı).
      new SecretScanStage(), new MutationStage(policy, undefined, repoDir()),
      ensemble,
    ], policy);
    const orchestrator = new Orchestrator({
      store: s,
      // R18 (faz 4 T2): 3. param — applied playbook-generator staging'i generator prompt'una girer
      // (loadAppliedPlaybooks çift bağlam: reviewerContext I2 kompozisyonunda, generatorContext burada).
      // Yalnız üretim yolu (`run`) taşır; evolve --shadow candidatePlaybookProvider ile sınırlı kalır
      // (faz 3 hükmü aynen — applied playbooklar shadow yargısına karışmaz), review-diff/eval --full
      // üretim yapan generator kurmaz (reviewerLessons I2 kompozisyonu zaten applied playbook'ludur).
      backend: new LlmGeneratorBackend(gateway, mem, loadAppliedPlaybooks(repoDir())), // A4: generator dersleri + R18 applied generator playbook'ları
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
    // R27 (faz 5 T7): golden ≥50 aktivasyon görünürlüğü — mevcut alanların YANINA additive:
    // goldenCount = loadGoldenTasks(repoDir()).tasks.length (evolve ctx.goldenCount ile AYNI kaynak:
    // .devloop/golden/*.task.json, şema-geçerli + duplicate-temiz);
    // goldenDrafts = golden-drafts/ staging .task.json sayımı (golden list ile aynı kural);
    // l3Active = goldenCount >= policy.l3MinGoldenTasks (evalRunner l3Active + evolve Kapı 1 ile
    // AYNI tanım — yeni tanım uydurulmadı);
    // lastEvalScore = lastEvalRun(s,'production').payload.score (lastEvalRun helper — shadow eval
    // hariç); konsol kuralı: alan daima yazılır, eval koşumu yoksa literal 'null'.
    const { policy } = loadConfig(repoDir());
    const goldenCount = loadGoldenTasks(repoDir()).tasks.length;
    const draftsDir = join(repoDir(), '.devloop', 'golden-drafts');
    const goldenDrafts = existsSync(draftsDir) ? readdirSync(draftsDir).filter((n) => n.endsWith('.task.json')).length : 0;
    const lastEvalScore = lastEvalRun(s, 'production')?.payload.score ?? null;
    const l3Active = goldenCount >= policy.l3MinGoldenTasks;
    console.log(`runs=${s.query({ type: 'RunStarted' }).length} prs=${s.query({ type: 'PRCreated' }).length} blocked=${s.query({ type: 'TaskBlocked' }).length} decisions=${s.query({ type: 'HumanDecision' }).length} lessons=${s.query({ type: 'LessonLearned' }).length} chain=${chain.ok ? 'ok' : 'BROKEN: ' + chain.errors.join('; ')} goldenCount=${goldenCount} goldenDrafts=${goldenDrafts} l3Active=${l3Active} lastEvalScore=${lastEvalScore}`);
  });

  const learn = program.command('learn').description('aday dersleri listele/onayla');
  learn.action(async () => {
    const { policy } = loadConfig(repoDir());
    const s = store();
    const candidates = generateCandidates(s);
    const listed = candidates.map((c) => `${c.lessonId}  [${c.pattern}→${c.targetComponent}]  ${c.rule}`).join('\n');
    if (listed) { console.log(listed); return; }
    // R14 (faz 3 T8): boş liste çıplak '(aday yok)' demez — karar sayısı L2 indüksiyon eşiğinin
    // (l2MinDecisions) altındaysa açık bildirim verir: kullanıcı L2'nin neden devre dışı olduğunu
    // ve ne kadar karar biriktiğini görür (SHIP kalıntısı: sessiz boş çıktı diagnoza kapalıydı).
    const decisions = s.query({ type: 'HumanDecision' });
    console.log(decisions.length < policy.l2MinDecisions
      ? `L2 devre dışı (l2MinDecisions=${policy.l2MinDecisions}, mevcut: ${decisions.length})`
      : '(aday yok)');
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

  // R25 (faz 5 T1): decide → gerçek run bağlantısı (fail-closed). '--run' verilirse AYNEN
  // kullanılır (auto-resolve atlanır; '--run manual' tek explicit 'manual' yolu); verilmezse
  // store'daki son eşleşen TaskPicked'in run_id'si auto-resolve edilir; çözülemezse fail-closed
  // hata — sessiz 'manual' yazımı YOK (faz 4 final review keşfi bu kontratla kapanır).
  program.command('decide').requiredOption('--task <id>').option('--accept').option('--reject')
    .option('--run <runId>', 'run_id (auto-resolve override; manuel karar için --run manual)')
    .requiredOption('--reason <reason>').option('--note <note>').option('--findings <ids>')
    .action(async (opts: { task: string; accept?: boolean; reject?: boolean; run?: string; reason: string; note?: string; findings?: string }) => {
      const decision = opts.accept ? 'accept' : opts.reject ? 'reject' : null;
      if (!decision) throw new Error('--accept veya --reject gerekli');
      const runId = opts.run ?? resolveRunIdForTask(store(), opts.task);
      if (!runId) throw new Error(`Görev için koşum bulunamadı: ${opts.task} — önce run, sonra decide veya --run ile belirtin`);
      await store().append('HumanDecision', runId, opts.task, 'human', {
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
      // R21 (faz 4 T6): cross-provider fallback chain (R26b helper) — BudgetedGateway sarması aynen (tüm chain budget'a işler).
      const gateway = new BudgetedGateway(createGatewayOrChain(policy), policy.budgetUsd, () => {});
      const adapter = new TypeScriptAdapter(policy, repoDir()); // R13 + I2: docker modda wt mount + orijinal node_modules bind
      // R11 (faz 3 T5): risk-tiered çift pipeline — stage örnekleri paylaşımlı kurulur; runReviewDiff
      // triaj skoru < ciEnsembleRiskThreshold → gatePipeline, değilse fullPipeline seçer.
      // Gate pipeline'ı ensemble'sızdır (advisory: [] override — low-risk CI koşumu LLM harcamaz);
      // full pipeline aynı gates + llm-ensemble advisory override ile koşar.
      const gateStages = [
        new RiskTriageStage(policy), new StaticGatesStage(adapter), new TestGateStage(adapter),
        new SecretScanStage(), new MutationStage(policy, undefined, repoDir()),
      ];
      // I2 (final fix wave): review-diff CI yolu da `run` assembly'siyle aynı kompozisyonu kullanır —
      // applied playbook'lar CI reviewer prompt'undan da eksik kalmasın.
      // R22 (faz 4 T3): composeReviewerLessons — per-line 'yok.' filtresi (blok düşürme yok).
      const playbooks = loadAppliedPlaybooks(repoDir());
      const reviewerLessons = composeReviewerLessons([mem, playbooks]);
      const ensemble = new LlmEnsembleStage(
        new LlmReviewerStage(gateway, reviewerLessons),
        new LlmReviewerAltStage(gateway, { model: altModelFor(policy), reviewerLessons }), // I3: provider-aware alt model
        policy,
      );
      const gateOverride = { ...policy, gates: ['risk-triage', 'static-gates', 'tests', 'secret-scan', 'mutation-testing'], advisory: [] };
      const fullOverride = { ...policy, gates: ['risk-triage', 'static-gates', 'tests', 'secret-scan', 'mutation-testing'], advisory: ['llm-ensemble'] };
      const gatePipeline = new ReviewPipeline(gateStages, gateOverride);
      const fullPipeline = new ReviewPipeline([...gateStages, ensemble], fullOverride);
      const r = await runReviewDiff({
        diffText, taskSpecId: opts.task, gatePipeline, fullPipeline, store: store(), policy, repoPath: repoDir(),
      });
      console.log(`review-diff: exit=${r.exitCode} gateFailed=${r.gateFailed ?? '-'} findings=${r.findings.length}`);
      process.exitCode = String(r.exitCode);
    });

  // R9/R10 (faz 3 T3): eval komutu — golden set üzerinde ya production pipeline (candidate yoksa)
  // ya da aday-policy pipeline (--candidate) koşar; karşılaştırma raporu JSON yazdırılır.
  // SHADOW/SALT-OKUNUR: üretim config'ine SIFIR yazım — policy.yaml/lessons.md/proposals
  // dokunulmaz; yalnız eval kanıtı (EvalRun, TaskPicked vb.) store'a yazılır. `run` komutunun
  // aksine mem.render() çağrılmaz ve SIGINT marker yazılmaz.
  program.command('eval')
    .description('golden task eval — production pipeline veya aday policy karşılaştırması (shadow)')
    .option('--candidate <policyDir>', 'aday policy dizini (policy.yaml içerir)')
    .option('--full', 'ensemble dahil koş (LLM çağrısı yapar)')
    .action(async (opts: { candidate?: string; full?: boolean }) => {
      // Fail-closed: candidate policy.yaml içermiyorsa loadConfig sessizce DEFAULT_POLICY'ye düşer —
      // farkında olmadan varsayılan policy'yle karşılaştırma yapmak R9 ölçümünü geçersiz kılar.
      if (opts.candidate && !existsSync(join(opts.candidate, 'policy.yaml'))) {
        throw new Error(`aday policy dizininde policy.yaml yok: ${opts.candidate}`);
      }
      const effPolicy = opts.candidate ? loadConfig(opts.candidate).policy : loadConfig(repoDir()).policy;
      const adapter = new TypeScriptAdapter(effPolicy, repoDir()); // R13 + I2: eval pipeline'ı da sandbox moduna uyar
      const stages: ReviewStage[] = [
        new RiskTriageStage(effPolicy), new StaticGatesStage(adapter), new TestGateStage(adapter),
        new SecretScanStage(), new MutationStage(effPolicy, undefined, repoDir()),
      ];
      if (opts.full) {
        // T6: gateway R26b helper ile kurulur (provider'a göre; R21 cross-fallback chain dahil).
        // Eval yolu bütçe sayacı TUTMAZ: aday değerlendirme shadow,
        // production eval salt-okunur karşılaştırmadır; BudgetedGateway sarması bilinçli yapılmadı.
        const gateway = createGatewayOrChain(effPolicy);
        const mem = memory();
        // I2 (final fix wave): eval --full üretim pipeline'ının donmuş yargıcıdır — reviewerLessons
        // `run` assembly'siyle AYNI kompozisyon (mem + applied playbook'lar), aksi halde eval üretim
        // reviewer'ından FARKLI bir prompt'la ölçer (karşılaştırma geçersizleşir).
        // R22 (faz 4 T3): composeReviewerLessons — per-line 'yok.' filtresi (blok düşürme yok).
        const playbooks = loadAppliedPlaybooks(repoDir());
        const reviewerLessons = composeReviewerLessons([mem, playbooks]);
        stages.push(new LlmEnsembleStage(
          new LlmReviewerStage(gateway, reviewerLessons),
          new LlmReviewerAltStage(gateway, { model: altModelFor(effPolicy), reviewerLessons }), // I3: provider-aware alt model
          effPolicy,
        ));
      }
      // PipelineConfigError penceresi: advisory yalnız --full'da policy'den alınır; --full'suz
      // koşum ensemble'suz gate setiyle tamamlanır ([] = yalnız gates).
      const pipeline = new ReviewPipeline(stages, { ...effPolicy, gates: effPolicy.gates, advisory: opts.full ? effPolicy.advisory : [] });
      const summary = await runEval({
        repoPath: repoDir(), pipeline, policy: effPolicy, store: store(),
        l3MinGoldenTasks: effPolicy.l3MinGoldenTasks,
        ...(opts.candidate ? { candidate: { label: opts.candidate } } : {}),
      });
      console.log(JSON.stringify(summary, null, 2));
    });

  // R10 (faz 3 T4): L3 evrim — `evolve --shadow` golden eşikli playbook adaylarını üretir ve aynı
  // golden seti üzerinde shadow eval koşar; `evolve apply <evoId>` adayı golden-gerileme kapısıyla
  // playbook staging'e yazar (A5: yalnız staging dosyası + ProposalCreated kanıtı — policy/lint
  // otomatik değişmez, insan devreye alır; policy-tweak shadow'u faz 4'tür, v3 playbook-only shadow).
  const evolveCtx = (policy: Policy): EvolveContext => ({
    store: store(),
    playbookDir: join(repoDir(), '.devloop', 'playbooks'),
    candidateDir: join(repoDir(), '.devloop', 'candidates'),
    goldenCount: loadGoldenTasks(repoDir()).tasks.length,
    l3MinGoldenTasks: policy.l3MinGoldenTasks,
  });
  const evolve = program.command('evolve').description('L3 evrim: shadow aday üretimi + golden-gerileme kapılı apply');
  evolve.option('--shadow', 'playbook aday üretimi + shadow eval')
    // R19 (faz 4 T4): --llm — deterministik shadow akışı bittikten SONRA LLM üretimli playbook
    // mutasyon taslakları da candidate/'e yazılır. --llm YOKSA davranış aynen (mutasyon gateway
    // çağrısı hiç yapılmaz — deterministik mod). R19 kapılar: yalnız l3Active + golden gerileme
    // YOKken çalışır; anahtarsız ortamda GatewayError fail-closed yukarı fırlar.
    .option('--llm', 'shadow sonrası LLM üretimli mutasyon taslakları (R19 — l3Active + gerileme kapılı, anahtarsız fail-closed)')
    .action(async (opts: { shadow?: boolean; llm?: boolean }) => {
      if (!opts.shadow) throw new Error('--shadow gerekli (v3: yalnız shadow modu desteklenir)');
      const { policy } = loadConfig(repoDir());
      const s = store();
      const ctx = evolveCtx(policy);
      const baseEv = lastEvalRun(s, 'production');
      if (!baseEv) throw new Error('Önce production eval koşun');
      const baseline = evalRunToSummary(baseEv.payload, policy.l3MinGoldenTasks);
      // I4 (final fix wave, spec R9/R10 "eşik altı bildirir"): golden set l3MinGoldenTasks
      // eşiğinin altındaysa L3 AKTİF DEĞİL — shadow eval HİÇ kurulmaz/koşulmaz (ücretli LLM
      // ensemble koşumu harcanmaz) ve yalnız açık bildirim döner. Eşik kontrolü baseline ön
      // koşulundan SONRA: production eval yokluğu ayrı bir kullanıcı hatasıdır ('Önce production
      // eval koşun' — mevcut sözleşme korunur); eşik altı ise eval harcamanın kendisini engeller.
      if (ctx.goldenCount < policy.l3MinGoldenTasks) {
        console.log(JSON.stringify({ l3Active: false, message: `L3 eşik altı (l3MinGoldenTasks=${policy.l3MinGoldenTasks}, golden=${ctx.goldenCount}) — eval koşulmadı` }, null, 2));
        return;
      }
      const candidates = generateEvolutionCandidates(ctx, baseline);
      writeShadowCandidates(ctx, candidates); // ÖNCE yazılır — provider shadow eval'e aday notlarını taşır
      // hüküm (I2 final fix wave): shadow eval reviewerLessons KAYNAĞI BİLINÇLİ OLARAK
      // loadAppliedPlaybooks DEĞİL — candidatePlaybookProvider. Shadow ADAY playbook'ları
      // (candidates/) değerlendirir; apply edilmiş staging playbook'lar (.devloop/playbooks)
      // shadow yargısına karışması istenmez (değerlendirilen şey adayın kendisidir).
      const provider = candidatePlaybookProvider(ctx);
      // Shadow pipeline: `run` komutu assembly'siyle aynı; TEK fark reviewer stage'lerine
      // reviewerLessons olarak candidatePlaybookProvider verilir — aday playbook böylece eval'e
      // GERÇEKTEN girer. Policy = production policy (playbook-only shadow). Eval yolu bütçe sayacı
      // TUTMAZ (eval komutuyla aynı hüküm — shadow, harcayan üretim çağrısı değildir).
      const adapter = new TypeScriptAdapter(policy, repoDir()); // R13 + I2: shadow eval pipeline'ı da sandbox moduna uyar
      // R21 (faz 4 T6): cross-provider fallback chain (R26b helper) — eval yolu gibi budget sayacı tutmaz (aynen).
      const gateway = createGatewayOrChain(policy);
      const pipeline = new ReviewPipeline([
        new RiskTriageStage(policy), new StaticGatesStage(adapter), new TestGateStage(adapter),
        new SecretScanStage(), new MutationStage(policy, undefined, repoDir()),
        new LlmEnsembleStage(
          new LlmReviewerStage(gateway, provider),
          new LlmReviewerAltStage(gateway, { model: altModelFor(policy), reviewerLessons: provider }), // I3: provider-aware alt model
          policy,
        ),
      ], policy);
      const shadowEval = await runEval({
        repoPath: repoDir(), pipeline, policy, store: s, l3MinGoldenTasks: policy.l3MinGoldenTasks,
        candidate: { label: 'evolve-shadow' },
      });
      const out: {
        candidates: EvolutionCandidate[];
        shadowEval: EvalSummary;
        baseline: { evalId: string; failed: number; score: number };
        llmMutations?: LlmMutationDraft[];
      } = { candidates, shadowEval, baseline: { evalId: baseline.evalId, failed: baseline.failed, score: baseline.score } };
      // R19 (faz 4 T4): --llm yalnız shadow koşumu SONRASINDA devreye girer; gateway tamamen
      // dışarıdan inject edilir (generateLlmMutations). --llm YOKSA mutasyon gateway çağrısı hiç
      // yapılmaz — deterministik davranış aynen. Hatalar (eşik-altı throw, golden-gerileme throw,
      // GatewayError) yakalanır: anlamlı mesaj stderr'e + exit non-zero; deterministik sonuç
      // JSON'u stdout'ta aynen yazılır (parse edilebilir kalır).
      if (opts.llm) {
        try {
          // R21 (faz 4 T6): mutasyon gateway'i de chain (R26b helper) — yalnız --llm'de kurulur.
          const mutGateway = createGatewayOrChain(policy);
          out.llmMutations = await generateLlmMutations({ ctx, gateway: mutGateway, baseline, shadowEval });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          console.error(`evolve --llm başarısız: ${msg}`);
          process.exitCode = '1';
        }
      }
      console.log(JSON.stringify(out, null, 2));
    });
  evolve.command('apply').argument('<evoId>')
    .description('adayı golden-gerileme kapısıyla playbook staging dizinine yaz')
    .action(async (evoId: string) => {
      const { policy } = loadConfig(repoDir());
      const s = store();
      const ctx = evolveCtx(policy);
      const candidate = loadCandidate(ctx, evoId);
      if (!candidate) throw new Error('Aday bulunamadı');
      const baseEv = lastEvalRun(s, 'production');
      if (!baseEv) throw new Error('Önce production eval koşun');
      const shadowEv = lastEvalRun(s, 'shadow');
      if (!shadowEv) throw new Error('Önce evolve --shadow koşun');
      await applyEvolution(ctx, candidate, evalRunToSummary(shadowEv.payload, policy.l3MinGoldenTasks), evalRunToSummary(baseEv.payload, policy.l3MinGoldenTasks));
      console.log(`Evrim uygulandı: ${evoId} — playbook staging dosyası yazıldı (insan devreye alır) + ProposalCreated kaydedildi.`);
    });

  // R17 (faz 4 T1): golden dataset küratörlüğü — kabul koşum kanıtından taslak üretimi + insan
  // onaylı kabul/ret. A5 değişmezi: `draft` YALNIZ .devloop/golden-drafts/ staging'ine yazar;
  // golden/ dizinine yalnız `accept` (rename) dokunur — otomatik golden büyümesi kapalıdır.
  const goldenCmd = program.command('golden').description('golden dataset küratörlüğü');
  goldenCmd.command('draft').option('--from-run <runId>').action(async (opts: { fromRun?: string }) => {
    const r = await generateGoldenDrafts({ store: store(), repoPath: repoDir(), draftsDir: join(repoDir(), '.devloop', 'golden-drafts'), ...(opts.fromRun ? { fromRun: opts.fromRun } : {}) });
    console.log(JSON.stringify(r, null, 2));
  });
  goldenCmd.command('list').action(async () => {
    const d = join(repoDir(), '.devloop', 'golden-drafts');
    const names = existsSync(d) ? readdirSync(d).filter((n) => n.endsWith('.task.json')) : [];
    console.log(names.join('\n') || '(taslak yok)');
  });
  goldenCmd.command('accept').argument('<draftId>').action(async (id: string) => {
    acceptDraft(join(repoDir(), '.devloop', 'golden-drafts'), join(repoDir(), '.devloop', 'golden'), id);
    console.log('Golden görev kabul edildi.');
  });
  goldenCmd.command('discard').argument('<draftId>').action(async (id: string) => {
    discardDraft(join(repoDir(), '.devloop', 'golden-drafts'), id);
    console.log('Taslak atıldı.');
  });
  return program;
}
