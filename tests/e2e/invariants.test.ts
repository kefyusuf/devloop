import { describe, it, expect, vi } from 'vitest';
import { ReviewPipeline } from '../../src/pipeline/pipeline.js';
import { Orchestrator, BudgetedGateway, type OrchestratorDeps } from '../../src/orchestrator/orchestrator.js';
import { generateCandidates, generateProposals, applyProposal } from '../../src/learning/learn.js';
import { VerdictStore, validateChain } from '../../src/store/store.js';
import { LessonMemory } from '../../src/memory/memory.js';
import { RiskTriageStage, computeRisk } from '../../src/pipeline/stages/riskTriage.js';
import { LlmEnsembleStage } from '../../src/pipeline/stages/llmEnsemble.js';
import { SecretScanStage } from '../../src/pipeline/stages/secretScan.js';
import { MutationStage } from '../../src/pipeline/stages/mutationStage.js';
import { parseDiff, runReviewDiff } from '../../src/shell/reviewDiff.js';
import { runEval } from '../../src/eval/evalRunner.js';
import { generateEvolutionCandidates, applyEvolution, type EvolveContext } from '../../src/evolution/evolve.js';
import { loadConfig } from '../../src/config/config.js';
import { mkdtempSync, readFileSync, mkdirSync, readdirSync, cpSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';
import * as adapter from '../../src/adapters/typescript/index.js';
import type { ReviewContext, ReviewStage, StageResult } from '../../src/contracts/review.js';
import type { Finding } from '../../src/contracts/schemas.js';
import type { Artifact } from '../../src/contracts/schemas.js';
import type { DevloopEvent } from '../../src/contracts/events.js';
import type { LlmGateway } from '../../src/gateway/gateway.js';

// R15 (faz 3 T9): mutantId uçtan uca değişmezi GERÇEK MutationStage ile koşar — resolveBin/runTool
// stub'lanır (gerçek Stryker koşumu burada YOK; gerçek koşum kanıtı tests/pipeline/mutationStage.test.ts
// gerçek-Stryker testinde). Diğer değişmezler adapter fonksiyonları çağırmaz — mock etkisiz kalır.
vi.mock('../../src/adapters/typescript/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/adapters/typescript/index.js')>();
  return {
    ...actual,
    resolveBin: vi.fn(() => 'C:/fake/bin/stryker.js') as unknown as typeof actual.resolveBin,
    runTool: vi.fn(async () => ({ stdout: 'mutation score 90.00%\nAll files |  90.00 |', stderr: '', exitedCleanly: true, killed: false, truncated: false })) as unknown as typeof actual.runTool,
  };
});

// Düzeltme 5: "type":"module" altında require geçersiz — statik ESM import.
const base = loadConfig(process.cwd()).policy;
const ctx = (): ReviewContext => ({ taskSpec: { id: 't', description: 'd', acceptanceCriteria: ['a'], filesScope: [] }, artifact: { diff: 'x', intent: 'i', rejectedAlternatives: [], testEvidence: '', files: [] }, repoPath: '.', riskScore: 0 });
const F = (id: string, category: string, severity: Finding['severity']): Finding => ({ id, stage: 's', category, severity, confidence: 1, evidence: { file: 'a.ts', line: 1 } });
const mkStage = (name: string, status: 'pass' | 'fail' | 'error' | 'skipped') => ({ name, kind: 'gate' as const, evaluate: vi.fn(async () => ({ status, findings: [], durationMs: 1 })) });

describe('A6 değişmez kural paketi', () => {
  it('PASS yalnız tüm zorunlu gate pass ile (fail/error/skipped her biri fail)', async () => {
    const policy = { ...base, gates: ['g1'], advisory: [], authorizedSkips: [] };
    for (const status of ['fail', 'error', 'skipped'] as const) {
      const r = await new ReviewPipeline([mkStage('g1', status)], policy).run(ctx());
      expect(r.passed).toBe(false);
    }
    const r = await new ReviewPipeline([mkStage('g1', 'pass')], policy).run(ctx());
    expect(r.passed).toBe(true);
  });

  it('bütçe: çok çağrılı gerçek usage toplamı ile durur', async () => {
    let n = 0;
    const inner: LlmGateway = { complete: vi.fn(async () => { n++; return { data: {}, usage: { inputTokens: 0, outputTokens: 0, costUsd: 0.5 } }; }) };
    const bg = new BudgetedGateway(inner, 1.0, () => {});
    await bg.complete({ system: 's', user: 'u', schema: { parse: (x) => x } as never, runId: 'r' });
    await bg.complete({ system: 's', user: 'u', schema: { parse: (x) => x } as never, runId: 'r' }); // toplam 1.0
    await expect(bg.complete({ system: 's', user: 'u', schema: { parse: (x) => x } as never, runId: 'r' })).rejects.toThrow('Bütçe');
    expect(n).toBe(2);
  });

  it('HumanDecision gerçek bulguya bağlı (parent validation)', async () => {
    const store = new VerdictStore(join(mkdtempSync(join(tmpdir(), 'inv-')), 'e.jsonl'));
    // Düzeltme 5 uyarlaması: değişmez başlığına birebir — olmayan bulgu event'ine bağlı
    // HumanDecision; validateChain eksik parent'ı yakalar (sessiz kanıt yok).
    await store.append('HumanDecision', 'r', 't', 'h', { decision: 'reject', reason: 'false-positive', parentFindingEventIds: ['bulgu-event-yok'] });
    const chain = validateChain(store.readAll());
    expect(chain.ok).toBe(false);
    expect(chain.errors[0]).toContain('bulgu-event-yok');
  });

  it('LessonLearned(active) insan onayı gerektirir: onaysız candidate contextFor\'a girmez', async () => {
    const store = new VerdictStore(join(mkdtempSync(join(tmpdir(), 'inv2-')), 'e.jsonl'));
    await store.append('LessonLearned', 'r', 'l', 'learning', { lessonId: 'l1', rule: 'kural', scope: 's', confidence: 0.9, status: 'candidate', targetComponent: 'generator', parentDecisionEventIds: [] });
    const mem = new LessonMemory(store, join(mkdtempSync(join(tmpdir(), 'inv3-')), 'l.md'));
    expect(mem.contextFor({ id: 't', description: 'kural', acceptanceCriteria: ['a'], filesScope: [] })).not.toContain('kural');
  });

  it('aday ders ID\'leri karar setine deterministik', async () => {
    const store = new VerdictStore(join(mkdtempSync(join(tmpdir(), 'inv4-')), 'e.jsonl'));
    const art = await store.append('ArtifactProduced', 'r', 't', 'b', { artifact: { diff: '', intent: 'i', rejectedAlternatives: [], testEvidence: '', files: [] }, parentTaskEventId: 'p' });
    const f1 = await store.append('FindingEmitted', 'r', 't', 'llm', { finding: F('f1', 'perf', 'required'), parentArtifactEventId: art.event_id });
    const f2 = await store.append('FindingEmitted', 'r', 't2', 'llm', { finding: F('f2', 'perf', 'required'), parentArtifactEventId: art.event_id });
    await store.append('HumanDecision', 'r', 't', 'h', { decision: 'reject', reason: 'false-positive', parentFindingEventIds: [f1.event_id] });
    await store.append('HumanDecision', 'r', 't2', 'h', { decision: 'reject', reason: 'false-positive', parentFindingEventIds: [f2.event_id] });
    expect(generateCandidates(store)[0].lessonId).toBe(generateCandidates(store)[0].lessonId);
  });
});

// Faz 2 değişmezleri (R7): her faz-2 kabul kriteri değişmez olarak burada pinlenir.
describe('Faz 2 değişmezleri (R7)', () => {
  const req = { system: 's', user: 'u', schema: { parse: (x: unknown) => x } as never, runId: 'r' };

  it('bütçe iki kaynak: TEK BudgetedGateway örneği generator+reviewer harcamasını birleştirir', async () => {
    // R1 değişmezi: her kaynak tek başına bütçe altında (0.6 < 1.0); yalnız PAYLAŞILAN örnek üzerindeki
    // kümülasyon (0.6+0.6=1.2) reddi tetikler — per-source sayım bu senaryoyu geçerdi, tek kapı geçmez.
    // Hüküm: BudgetedGateway post-call eşiği `>` olduğundan 0.6+0.6 aşımı İKİNCİ çağrıda (toplam bütçeyi
    // o an geçtiği için) post-call BudgetExceededError verir; üçüncü çağrı ise ön-kontrolle kapalıdır.
    let n = 0;
    const inner: LlmGateway = { complete: vi.fn(async () => { n++; return { data: {}, usage: { inputTokens: 0, outputTokens: 0, costUsd: 0.6 } }; }) };
    const bg = new BudgetedGateway(inner, 1.0, () => {});
    await bg.complete(req); // generator kaynağı: 0.6 — tek başına serbest
    await expect(bg.complete(req)).rejects.toThrow('Bütçe'); // reviewer kaynağı: kümülatif 1.2 > 1.0 → post-call reddi
    await expect(bg.complete(req)).rejects.toThrow('Bütçe'); // üçüncü çağrı: ön-kontrol reddi (kapı kapalı kalır)
    expect(n).toBe(2);
  });

  it('L2 staging izolasyonu: applyProposal yalnız proposals/<id>/ altına yazar, repoya hiçbir şey yazmaz', async () => {
    const root = mkdtempSync(join(tmpdir(), 'inv-l2-'));
    const repoDir = join(root, 'repo'); // boş fixture repo — izolasyon kanıtı için before/after karşılaştırma
    const proposalsDir = join(root, 'proposals');
    mkdirSync(repoDir); mkdirSync(proposalsDir);
    expect(readdirSync(repoDir)).toEqual([]); // önce: repo boş

    const store = new VerdictStore(join(mkdtempSync(join(tmpdir(), 'inv-l2s-')), 'e.jsonl'));
    // Seed: 3 ayrı koşumda aynı kategori bulgu + reject kararı → generateProposals koşulları (≥2 ret,
    // ≥3 koşum, l2MinDecisions=3) sağlanır ve bir öneri üretilir.
    const art = await store.append('ArtifactProduced', 'r0', 't', 'b', { artifact: { diff: '', intent: 'i', rejectedAlternatives: [], testEvidence: '', files: [] }, parentTaskEventId: 'p' });
    for (const run of ['r1', 'r2', 'r3']) {
      const f = await store.append('FindingEmitted', run, 't', 'llm', { finding: F(`f-${run}`, 'perf', 'required'), parentArtifactEventId: art.event_id });
      await store.append('HumanDecision', run, 't', 'h', { decision: 'reject', reason: 'false-positive', parentFindingEventIds: [f.event_id] });
    }
    const proposals = generateProposals(store, 3);
    expect(proposals).toHaveLength(1);
    const p = proposals[0];

    await applyProposal(store, proposalsDir, p);
    // Sonra: repo dir HÂLÂ boş — devloop otomatik yazım yapmadı (A5/R5 değişmezi).
    expect(readdirSync(repoDir)).toEqual([]);
    // Staging dışına taşma yok: proposalsDir'in tek girdisi <proposalId>/; içinde yalnız PROPOSAL.md.
    expect(readdirSync(proposalsDir)).toEqual([p.proposalId]);
    expect(readdirSync(join(proposalsDir, p.proposalId))).toEqual(['PROPOSAL.md']);
    expect(store.query({ type: 'ProposalCreated' })).toHaveLength(1);
  });

  it('koraborasyon değişmezi (tam ensemble, eşik altı): tek reviewer → false; iki reviewer aynı anahtar → true', async () => {
    // T4'ün aksine burada corroborated=FALSE hali de pinlenir; risk 0 < ensembleRiskThreshold → alt
    // reviewer yalnız primary bulgulu olduğundan koşar (çağrı sayısıyla eşik kablolaması pinlenir).
    const mkReviewer = (name: string, findings: Finding[]) => {
      const evaluate = vi.fn(async (): Promise<StageResult> => ({ status: 'pass', findings, durationMs: 1 }));
      return { stage: { name, kind: 'advisory' as const, evaluate } as ReviewStage, evaluate };
    };
    const R = (id: string, stage: string, category: string): Finding => ({ id, stage, category, severity: 'required', confidence: 0.9, evidence: { file: 'a.ts', line: 1 }, corroborated: false });

    const p1 = mkReviewer('llm-reviewer', [R('p1', 'llm-reviewer', 'perf')]);
    const a1 = mkReviewer('llm-reviewer-alt', []);
    const single = await new LlmEnsembleStage(p1.stage, a1.stage, base).evaluate(ctx());
    expect(p1.evaluate).toHaveBeenCalledTimes(1);
    expect(a1.evaluate).toHaveBeenCalledTimes(1); // primary bulgulu → alt koşar (eşik değil, bulgu tetikler)
    expect(single.findings).toHaveLength(1);
    expect(single.findings[0].corroborated).toBe(false); // alt aynı anahtarda bulgu vermedi → tek kaynak

    const p2 = mkReviewer('llm-reviewer', [R('p2', 'llm-reviewer', 'perf')]);
    const a2 = mkReviewer('llm-reviewer-alt', [R('a2', 'llm-reviewer-alt', 'perf')]); // aynı kategori+konum → çifte kaynak
    const both = await new LlmEnsembleStage(p2.stage, a2.stage, base).evaluate(ctx());
    expect(both.findings).toHaveLength(1);
    expect(both.findings[0].corroborated).toBe(true);
  });

  it('gate-config parmak izi: farklı tsconfig içerikli iki orchestrator koşumu → farklı gateConfigHash', async () => {
    const fixture = join(process.cwd(), 'tests', 'fixtures', 'sample-repo');
    // Minimal pipeline + ona uyan policy override'u (varsayılan policy tests/secret-scan/ensemble/mutation ister — A2 fail-closed).
    const gchPolicy = { ...base, gates: ['risk-triage', 'static-gates'], advisory: [] };
    const ART = { diff: '', intent: 'i', rejectedAlternatives: [], testEvidence: '', files: [{ path: 'src/new.ts', content: 'export const n=1;\n' }] };
    const orchDeps = (repo: string, store: VerdictStore): OrchestratorDeps => ({
      store,
      backend: { id: 'fake', generate: vi.fn(async () => ART) } as never,
      pipeline: new ReviewPipeline([
        new RiskTriageStage(gchPolicy),
        { name: 'static-gates', kind: 'gate' as const, evaluate: async (): Promise<StageResult> => ({ status: 'pass', findings: [], durationMs: 1 }) },
      ], gchPolicy),
      gateway: { complete: vi.fn(async () => ({ data: {}, usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } })) } as never,
      policy: gchPolicy, repoPath: repo, pr: { openPr: vi.fn(async () => ({ url: 'u' })) } as never,
    });
    const runRepo = async (tsconfig: string): Promise<string> => {
      const repo = mkdtempSync(join(tmpdir(), 'inv-gch-'));
      cpSync(fixture, repo, { recursive: true });
      writeFileSync(join(repo, 'tsconfig.json'), tsconfig, 'utf8');
      execSync('git init -b main && git config user.email t@t && git config user.name t && git add . && git commit -m init', { cwd: repo });
      const store = new VerdictStore(join(repo, '.devloop', 'events.jsonl'));
      const summary = await new Orchestrator(orchDeps(repo, store)).run(join(repo, 'tasks.json'));
      expect(summary.prs).toHaveLength(1); // koşum gerçekten tamlandı (erken abort boş kanıt bırakmaz)
      const snap = store.query({ type: 'RunStarted' })[0].payload.configSnapshot;
      return String(snap.gateConfigHash);
    };
    const h1 = await runRepo('{"compilerOptions":{"strict":true}}');
    const h2 = await runRepo('{"compilerOptions":{"strict":false}}');
    expect(h1).not.toBe(h2); // R4a duyarlılık: gate config içeriği parmak izini değiştirir
    expect(h1).toMatch(/^[0-9a-f]{16}/); // her iki dosya da mevcut → düz hex (absent marker yok)
  });
});

// Faz 3 değişmezleri (R15): her faz-3 kabul kriteri değişmez olarak burada pinlenir.
describe('Faz 3 değişmezleri (R15)', () => {
  const GATES5 = ['risk-triage', 'static-gates', 'tests', 'secret-scan', 'mutation-testing'];
  const CLEAN_DIFF = '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1,2 @@\n const x=1;\n+const y=2;';
  const TESTFILE_DIFF = '--- a/tests/u.test.ts\n+++ b/tests/u.test.ts\n@@ -1 +1,2 @@\n const a=1;\n+const b=2;';
  // AWS belgeleme örnek anahtarı — SecretScanStage PATTERNS[0] birebir eşleşir (gerçekçi gate fail).
  const SECRET_DIFF = '--- a/src/k.ts\n+++ b/src/k.ts\n@@ -1 +1,2 @@\n const x=1;\n+const k = "AKIAIOSFODNN7EXAMPLE";';
  const fakeGate = (name: string): ReviewStage => ({ name, kind: 'gate', evaluate: async (): Promise<StageResult> => ({ status: 'pass', findings: [], durationMs: 1 }) });
  const goldenFile = (repo: string, t: { goldenId: string; fixtureDiff: string; expected: unknown; id: string }): void =>
    writeFileSync(join(repo, '.devloop', 'golden', `${t.goldenId}.task.json`), JSON.stringify({
      goldenId: t.goldenId,
      taskSpec: { id: t.id, description: 'd', acceptanceCriteria: ['a'], filesScope: [] },
      fixtureDiff: t.fixtureDiff,
      expected: t.expected,
    }), 'utf8');

  // (a) R10 değişmezi — golden-gerileme kapısı. T4 birim testleri EL YAPIMI EvalSummary kullanıyordu;
  // bu değişmez kapıyı GERÇEK runEval çıktılarıyla kanılar: baseline gevşek policy'de 50/50 geçer,
  // shadow (sıkı policy) secret görevinde GERÇEK secret-scan gate fail'i alır → failed 1 > 0 → apply red.
  it('golden-gerileme kapısı: shadow failed > baseline (gerçek eval koşumları) → applyEvolution RED + staging yazımı YOK + ProposalCreated YOK', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'inv-f3gerileme-'));
    mkdirSync(join(repo, '.devloop', 'golden'), { recursive: true });
    const golden = (goldenId: string, id: string, fixtureDiff: string, expected: unknown) => ({ goldenId, id, fixtureDiff, expected });
    const tasks = [
      ...Array.from({ length: 48 }, (_, i) => golden(`c${i}`, `t${i}`, CLEAN_DIFF, { gatesPass: true, requiredFindings: [], forbiddenCategories: [] })),
      golden('td', 't-td', TESTFILE_DIFF, { gatesPass: true, requiredFindings: [{ category: 'test-diff' }], forbiddenCategories: [] }),
      golden('sec', 't-sec', SECRET_DIFF, { gatesPass: true, requiredFindings: [], forbiddenCategories: [] }),
    ];
    tasks.forEach((t) => goldenFile(repo, t)); // 50 görev = gerçek l3MinGoldenTasks eşiği (50) → l3 aktif

    const store = new VerdictStore(join(repo, '.devloop', 'events.jsonl'));
    const loosePolicy = { ...base, gates: GATES5.filter((g) => g !== 'secret-scan'), advisory: [] }; // gevşek
    const strictPolicy = { ...base, gates: GATES5, advisory: [] }; // sıkı: secret-scan gate'i VAR
    const pipelineFor = (policy: typeof base) => new ReviewPipeline(
      [new RiskTriageStage(policy), fakeGate('static-gates'), fakeGate('tests'), new SecretScanStage(), new MutationStage(policy)],
      policy,
    );

    // baseline: gevşek policy → 50/50 → failed 0, skor 100 (gerçek runEval çıktısı).
    const baseline = await runEval({ repoPath: repo, pipeline: pipelineFor(loosePolicy), policy: loosePolicy, store, l3MinGoldenTasks: base.l3MinGoldenTasks });
    expect(baseline.goldenCount).toBe(50);
    expect(baseline.failed).toBe(0);
    expect(baseline.score).toBe(100);
    // 2. üretim sinyal koşumu: gerçek CI yolu (runReviewDiff) — test dosyası diff'i test-diff bulgusu
    // ayrı run_id'de (ci-*) düşürür → iki farklı koşumda test-diff → playbook-generator adayı.
    // (İki runEval art arda Date.now() çakışması riskine karşı deterministik yol budur.)
    const ciStages = GATES5.map((n) => fakeGate(n));
    await runReviewDiff({
      diffText: TESTFILE_DIFF, taskSpecId: 'td-signal',
      gatePipeline: new ReviewPipeline(ciStages, { ...base, gates: GATES5, advisory: [] }),
      fullPipeline: new ReviewPipeline([...ciStages, { name: 'llm-ensemble', kind: 'advisory', evaluate: async () => ({ status: 'pass', findings: [], durationMs: 1 }) }], { ...base, gates: GATES5, advisory: ['llm-ensemble'] }),
      store, policy: base, repoPath: repo,
    });

    const ctx: EvolveContext = {
      store,
      playbookDir: join(repo, '.devloop', 'playbooks'),
      candidateDir: join(repo, '.devloop', 'candidates'),
      goldenCount: baseline.goldenCount,
      l3MinGoldenTasks: base.l3MinGoldenTasks,
    };
    const candidates = generateEvolutionCandidates(ctx, baseline);
    expect(candidates).toHaveLength(1); // non-vacuous: aday gerçekte üretilir
    expect(candidates[0].kind).toBe('playbook-generator');

    // shadow: sıkı policy → secret görevi GERÇEK secret-scan gate fail'i → failed 1 > baseline 0.
    const shadow = await runEval({ repoPath: repo, pipeline: pipelineFor(strictPolicy), policy: strictPolicy, store, l3MinGoldenTasks: base.l3MinGoldenTasks, candidate: { label: 'evolve-shadow' } });
    expect(shadow.failed).toBe(1);
    expect(shadow.score).toBe(98); // 49/50 — gerçek skor kanıtı

    await expect(applyEvolution(ctx, candidates[0], shadow, baseline)).rejects.toThrow('golden gerileme');
    // A5: kapı throw'u TÜM yazımlardan ÖNCE — staging dosyası da dizin de yok; kanıt event'i de yok.
    expect(existsSync(ctx.playbookDir)).toBe(false);
    expect(existsSync(join(ctx.playbookDir, `${candidates[0].evoId}.json`))).toBe(false);
    expect(store.query({ type: 'ProposalCreated' })).toHaveLength(0);
    expect(validateChain(store.readAll()).ok).toBe(true);
  });

  // (b) R14 değişmezi — mutantId makine-okunur uçtan uca: Stryker raporu → MutationStage bulgusu →
  // runEval FindingEmitted event'i → evidence.mutantId. T8 birimleri stage çıktısını pinliyordu;
  // burada kanıt ZİNCİRİNDeki son halka (store event'i) pinlenir.
  it('mutantId kanıt akışı: golden-style koşumda mutation bulgusu FindingEmitted event\'inde evidence.mutantId taşır', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'inv-f3mut-'));
    writeFileSync(join(repo, 'stryker.config.json'), JSON.stringify({ testRunner: 'vitest' }));
    mkdirSync(join(repo, 'reports', 'mutation'), { recursive: true });
    writeFileSync(join(repo, 'reports', 'mutation', 'results.json'), JSON.stringify({
      files: { 'src/a.ts': { mutants: [{ id: '42', status: 'Survived', location: { start: { line: 7 } } }] } },
      projectRoot: repo,
    }));
    mkdirSync(join(repo, '.devloop', 'golden'), { recursive: true });
    goldenFile(repo, { goldenId: 'm1', id: 't-mut', fixtureDiff: CLEAN_DIFF, expected: { gatesPass: false, requiredFindings: [], forbiddenCategories: [] } });
    const store = new VerdictStore(join(repo, '.devloop', 'events.jsonl'));
    const policy = { ...base, gates: ['risk-triage', 'mutation-testing'], advisory: [] };
    const pipeline = new ReviewPipeline([new RiskTriageStage(policy), new MutationStage(policy)], policy);
    const r = await runEval({ repoPath: repo, pipeline, policy, store, l3MinGoldenTasks: policy.l3MinGoldenTasks });
    expect(r.score).toBe(100); // expected gatesPass=false, gerçek mutation fail → eşleşir

    const emitted = store.query({ type: 'FindingEmitted' })
      .filter((e): e is Extract<DevloopEvent, { type: 'FindingEmitted' }> => e.type === 'FindingEmitted');
    const mut = emitted.filter((e) => e.payload.finding.category === 'mutation');
    expect(mut).toHaveLength(1);
    expect(mut[0].actor).toBe('mutation-testing');
    expect(mut[0].payload.finding.stage).toBe('mutation-testing');
    expect(mut[0].payload.finding.severity).toBe('critical');
    expect(mut[0].payload.finding.evidence.file).toBe('src/a.ts');
    expect(mut[0].payload.finding.evidence.line).toBe(7);
    expect(mut[0].payload.finding.evidence.mutantId).toBe('42'); // rapordaki gerçek mutant kimliği — makine-okunur kanıt
    expect(validateChain(store.readAll()).ok).toBe(true);
  });

  // (c) R14 değişmezi — parseDiff dosya atfı (T8 birimlerinin BİLEŞİK hali): tırnaklanmış diff
  // gövdesi kapsam AÇMAZ/KAPATMAZ, kodlanmış içerik (`+---`, `++++`) eklenen dosyada kalır; hunk
  // sonrası GERÇEK başlık çifti yeni dosya açar. Her satır yalnız doğru dosyaya akar.
  it('parseDiff dosya atfı: tırnaklanmış diff gövdesi + gerçek başlık çifti — satırlar doğru dosyalara gider', () => {
    const d = [
      '--- a/notes.patch', '+++ b/notes.patch', '@@ -0,0 +1,4 @@',
      '+diff --git a/fake.ts b/fake.ts',   // eklenen .patch içeriği: tırnaklanmış diff komutu
      '+--- a/fake.ts',                    // içerik-başlangıçlı `--- a/` — kapsam KAPATMAZ
      '++++ b/fake.ts',                    // diff kodlamasıyla `+++ b/` — kapsam ÇALMAZ, içeriktir
      '+const quoted=1;',
      '--- a/real.ts', '+++ b/real.ts', '@@ -1 +1,2 @@', ' ctx', '+real line', // gerçek çift → yeni dosya
    ].join('\n');
    expect(parseDiff(d)).toEqual([
      { path: 'notes.patch', addedContent: 'diff --git a/fake.ts b/fake.ts\n--- a/fake.ts\n+++ b/fake.ts\nconst quoted=1;' },
      { path: 'real.ts', addedContent: 'real line' },
    ]);
  });

  // (d) R11 değişmezi — risk-tier sınır pini RunStarted sadakatiyle: configSnapshot.gates = SEÇİLEN
  // pipeline'ın etkin stage kümesi (T9 kapanışı). Sözleşme: skor < ciEnsembleRiskThreshold(20) →
  // gate pipeline (llm-ensemble YOK); EŞİKTE (risk 20) → full pipeline (llm-ensemble VAR + koşar).
  it('risk-tier RunStarted sadakati: risk 10 → gates\'te llm-ensemble YOK + spy 0; risk 20 (=eşik) → VAR + spy 1', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'inv-f3tier-'));
    const store = new VerdictStore(join(dir, '.devloop', 'events.jsonl'));
    // LOW fixture (T5 paraleli): docs yolu + 161 satır → round(100*0.3*161/500) = 10.
    const LOW = ['--- a/docs/notes.md', '+++ b/docs/notes.md', '@@ -0,0 +1,158 @@', ...Array.from({ length: 158 }, (_, i) => `+satır ${i}`)].join('\n');
    // BOUNDARY fixture: src dosyası + 6 satır → round(100*(0.3*6/500 + 0.2)) = 20 — eşikle TAM eşit.
    const BOUNDARY = ['--- a/src/a.ts', '+++ b/src/a.ts', '@@ -1,2 +1,3 @@', ' const x=1;', '+const y=2;', '+const z=3;'].join('\n');
    const artifactOf = (diff: string): Artifact => ({ diff, intent: 'ci-review', rejectedAlternatives: [], testEvidence: 'ci', files: parseDiff(diff).map((f) => ({ path: f.path, content: f.addedContent })) });

    let ensCalls = 0;
    const mkPipelines = () => {
      const gateStages = GATES5.map((n) => fakeGate(n));
      const ens: ReviewStage = { name: 'llm-ensemble', kind: 'advisory', evaluate: async () => { ensCalls += 1; return { status: 'pass', findings: [], durationMs: 1 }; } };
      return {
        gate: new ReviewPipeline(gateStages, { ...base, gates: GATES5, advisory: [] }),
        full: new ReviewPipeline([...gateStages, ens], { ...base, gates: GATES5, advisory: ['llm-ensemble'] }),
      };
    };

    // LOW: 10 < 20 → gate pipeline; ensemble çağrılmaz; snapshot gates'te llm-ensemble YOK.
    expect(computeRisk(artifactOf(LOW), base).score).toBe(10); // fixture sözleşmesi pin'li
    const lowPipes = mkPipelines();
    const low = await runReviewDiff({ diffText: LOW, taskSpecId: 'low', gatePipeline: lowPipes.gate, fullPipeline: lowPipes.full, store, policy: base, repoPath: dir });
    expect(low.exitCode).toBe(0);
    expect(ensCalls).toBe(0);
    const snapLow = (store.query({ runId: 'ci-low', type: 'RunStarted' })[0] as Extract<DevloopEvent, { type: 'RunStarted' }>).payload.configSnapshot;
    expect(snapLow.gates).toEqual(GATES5); // llm-ensemble YOK — low-risk koşum LLM harcamaz

    // BOUNDARY: 20 < 20 DEĞİL → full pipeline; ensemble tam 1 kez; snapshot gates'te llm-ensemble VAR.
    expect(computeRisk(artifactOf(BOUNDARY), base).score).toBe(20); // sınır değeri pin'li
    const highPipes = mkPipelines();
    const high = await runReviewDiff({ diffText: BOUNDARY, taskSpecId: 'high', gatePipeline: highPipes.gate, fullPipeline: highPipes.full, store, policy: base, repoPath: dir });
    expect(high.exitCode).toBe(0);
    expect(ensCalls).toBe(1); // eşikteki koşum DERİN — `<` karşılaştırması pin'li (20 dahil değil)
    const snapHigh = (store.query({ runId: 'ci-high', type: 'RunStarted' })[0] as Extract<DevloopEvent, { type: 'RunStarted' }>).payload.configSnapshot;
    expect(snapHigh.gates).toEqual([...GATES5, 'llm-ensemble']); // seçilen pipeline birebir kanıtta
    expect(validateChain(store.readAll()).ok).toBe(true);
  });
});

// Düzeltme 9 (opsiyonel — dahil edildi): README/CLI fiil hizası koruması; ucuz, gürültü değil.
describe('README hizası', () => {
  it('README, CLI fiilleriyle hizalı (run/decide/learn/status + faz 3: eval/evolve)', () => {
    const readme = readFileSync(join(process.cwd(), 'README.md'), 'utf8');
    expect(readme).toContain('run tasks.json');
    expect(readme).toContain('devloop decide');
    expect(readme).toContain('devloop learn');
    expect(readme).toContain('devloop status');
    // R15 (faz 3 T9): faz 3 komutları da README'de belgelenir
    expect(readme).toContain('devloop eval');
    expect(readme).toContain('devloop evolve');
  });
});
