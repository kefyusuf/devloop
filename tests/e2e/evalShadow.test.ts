import { describe, it, expect, vi } from 'vitest';
import { buildCli } from '../../src/shell/cli.js';
import { VerdictStore, validateChain } from '../../src/store/store.js';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Finding } from '../../src/contracts/schemas.js';
import type { DevloopEvent } from '../../src/contracts/events.js';

// R15 (faz 3 T9): eval/shadow E2E — R9 kabul kriterlerinin uçtan uca kanıtı.
//
// SÖZLEŞME (dispatch):
// 1. Üretim eval: `devloop eval` (candidate'sız) → EvalRun configSnapshot.mode='production',
//    skor 2/3 ≈ 66.7 (g1 clean pass, g2 test-diff required met, g3 secret-scan GERÇEK gate fail).
// 2. Shadow: `devloop eval --candidate <dir>` — candidate policy.yaml üretim kopyası + gates
//    gevşetildi (secret-scan KALDIRILDI) → g3 artık koşar+geçer → skor 100; comparedTo = üretim
//    evalId; configSnapshot.candidate set.
// 3. No-write: üretim policy.yaml içeriği before/after birebir aynı.
// 4. Deterministik kanıt: koşumda LLM stage yok — tüm FindingEmitted stage'leri deterministik gate
//    kümesinden (llm-* Yasak); non-full eval assembly'sinde ensemble kurulmaz (cli.ts T3 hükmü).
// 5. validateChain tüm store'da ok.
//
// hüküm (dispatch iç tutarlılığı): g3 için "expected gatesPass false" taslağı, dispatch'in KENDİ
// assert'leriyle (üretim 66.7 + shadow secret-scan kaldırınca 100) matematiksel olarak bağdaşmaz —
// gevşetilen candidate koşumu geçerli skorlamaz (passed=true ≠ expected false yine mismatch olurdu).
// Assert'ler esas alınır: g3 expected.gatesPass=true (diff'te AWS örnek anahtarı — golden bu diff'in
// gate'leri geçmesini bekler); üretim secret-scan fail → mismatch → g3 0 → 66.7; gevşek candidate →
// 100. Böylece R9 donmuş yargıç karşılaştırması (comparedTo + skor farkı) gerçek koşumla kanılanır.

// Adapter stub (reviewDiff.test.ts CleanAdapterStub deseni): E2E'de gerçek eslint/tsc/vitest spawn
// EDİLMEZ — deterministik + hızlı; gate davranışı gerçek RiskTriage/SecretScan/Mutation'dan gelir.
vi.mock('../../src/adapters/typescript/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/adapters/typescript/index.js')>();
  class CleanAdapterStub {
    readonly id = 'typescript';
    async lint() { return []; }
    async typecheck() { return []; }
    async runTests() { return { passed: true, output: 'stub-clean', findings: [] as Finding[] }; }
  }
  return { ...actual, TypeScriptAdapter: CleanAdapterStub as unknown as typeof actual.TypeScriptAdapter };
});

const GATES5 = ['risk-triage', 'static-gates', 'tests', 'secret-scan', 'mutation-testing'];
// Deterministik gate kümesi — FindingEmitted stage'leri bunun dışına ÇIKMAZ (LLM stage adları yok).
const DETERMINISTIC_STAGES = new Set([...GATES5, 'risk-triage', 'static-gates', 'tests', 'secret-scan', 'mutation-testing']);

// Tam şema geçerli policy.yaml (zod şeması full alan ister) — üretim kopyası bu şablon;
// candidate aynı şablonun gates'i gevşetilmiş hali (dispatch: "policy.yaml copied from production").
const policyYaml = (gates: string[]) => `version: 1
gates: [${gates.join(', ')}]
advisory: [llm-ensemble]
authorizedSkips: [mutation-testing]
maxFixTours: 3
maxIterations: 10
budgetUsd: 2.0
wallClockMinutes: 30
ensembleRiskThreshold: 40
mutationScoreThreshold: 60
mutationTimeoutMinutes: 15
l2MinDecisions: 100
l3MinGoldenTasks: 50
ciEnsembleRiskThreshold: 20
mutationScopeLow: 5
mutationScopeHigh: 10
sandbox: { mode: host, image: node:20-bookworm-slim }
risk:
  weights: { diffSize: 0.3, testDiff: 0.5, scopePaths: 0.2 }
llm:
  provider: anthropic
  model: claude-sonnet-4-5
  fallbackModel: claude-haiku-3-5
  maxTokens: 8192
  backoffMs: 500
  costPer1kInput: 0.003
  costPer1kOutput: 0.015
  openai: { model: gpt-4.1, fallbackModel: gpt-4.1-mini, maxTokens: 8192, costPer1kInput: 0.0025, costPer1kOutput: 0.01 }
`;

// Golden görevler (dispatch fixture'ı):
// g1 — temiz source diff, gate'ler geçer, bulgu yok.
// g2 — test dosyası diff'i: RiskTriageStage test-diff bulgusunu DETERİNİSTİK üretir (eslint'siz).
// g3 — AWS örnek anahtarı içeren diff: SecretScanStage GERÇEK gate fail üretir (gerçekçilik).
const GOLDEN = [
  {
    goldenId: 'g1',
    taskSpec: { id: 'gt1', description: 'temiz source değişikliği', acceptanceCriteria: ['a1'], filesScope: [] },
    fixtureDiff: '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1,2 @@\n const x=1;\n+const y=2;',
    expected: { gatesPass: true, requiredFindings: [], forbiddenCategories: [] },
  },
  {
    goldenId: 'g2',
    taskSpec: { id: 'gt2', description: 'test dosyası değişikliği', acceptanceCriteria: ['a2'], filesScope: [] },
    fixtureDiff: '--- a/tests/util.test.ts\n+++ b/tests/util.test.ts\n@@ -1 +1,2 @@\n const a=1;\n+const b=2;',
    expected: { gatesPass: true, requiredFindings: [{ category: 'test-diff' }], forbiddenCategories: [] },
  },
  {
    goldenId: 'g3',
    taskSpec: { id: 'gt3', description: 'AWS örnek anahtarı içeren diff', acceptanceCriteria: ['a3'], filesScope: [] },
    fixtureDiff: '--- a/src/k.ts\n+++ b/src/k.ts\n@@ -1 +1,2 @@\n const x=1;\n+const k = "AKIAIOSFODNN7EXAMPLE";',
    expected: { gatesPass: true, requiredFindings: [], forbiddenCategories: [] },
  },
];

function makeFixtureRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'evalshadow-'));
  mkdirSync(join(repo, '.devloop', 'golden'), { recursive: true });
  GOLDEN.forEach((g) => writeFileSync(join(repo, '.devloop', 'golden', `${g.goldenId}.task.json`), JSON.stringify(g), 'utf8'));
  writeFileSync(join(repo, 'policy.yaml'), policyYaml(GATES5), 'utf8'); // üretim policy — no-write kanıtının hedefi
  return repo;
}

function evalRunEvents(store: VerdictStore): Extract<DevloopEvent, { type: 'EvalRun' }>[] {
  return store.query({ type: 'EvalRun' }).filter((e): e is Extract<DevloopEvent, { type: 'EvalRun' }> => e.type === 'EvalRun');
}

describe('E2E eval + shadow (R9 — faz 3 T9)', () => {
  it('üretim eval 66.7 (2/3) + deterministik kanıt; shadow --candidate 100 + comparedTo + üretim policy no-write', async () => {
    const repo = makeFixtureRepo();
    const candidateDir = mkdtempSync(join(tmpdir(), 'evalshadow-cand-'));
    writeFileSync(join(candidateDir, 'policy.yaml'), policyYaml(GATES5.filter((g) => g !== 'secret-scan')), 'utf8'); // gevşetildi

    // NO-WRITE kanıtının temeli: üretim policy.yaml içeriği koşumlar ÖNCESİNDE sabitlenir.
    const policyBefore = readFileSync(join(repo, 'policy.yaml'), 'utf8');

    const out: string[] = [];
    const origLog = console.log; console.log = (m: string) => out.push(m);
    try {
      // 1) ÜRETİM eval — candidate'sız.
      await buildCli(repo).parseAsync(['node', 'devloop', 'eval']);
      // 2) SHADOW eval — gevşek candidate policy.
      await buildCli(repo).parseAsync(['node', 'devloop', 'eval', '--candidate', candidateDir]);
    } finally { console.log = origLog; }

    const [prodSummary, shadowSummary] = out.map((chunk) => JSON.parse(chunk));
    const store = new VerdictStore(join(repo, '.devloop', 'events.jsonl'));
    const runs = evalRunEvents(store);
    expect(runs).toHaveLength(2);

    // (1) ÜRETİM EvalRun: mode=production, skor tam 2/3 → 66.7, perTask dağılımı pin'li.
    const prod = runs[0];
    expect(prod.payload.configSnapshot).toMatchObject({ mode: 'production' });
    expect(typeof prod.payload.configSnapshot.policyHash).toBe('string');
    expect(prod.payload.goldenCount).toBe(3);
    expect(prod.payload.passed).toBe(2);
    expect(prod.payload.failed).toBe(1);
    expect(prod.payload.score).toBe(66.7); // Math.round(2000/3)/10 — dispatch assert'i
    const byId = new Map(prod.payload.perTask.map((p) => [p.goldenId, p]));
    expect(byId.get('g1')).toMatchObject({ pass: true, reasons: [] });
    expect(byId.get('g2')).toMatchObject({ pass: true, reasons: [] }); // test-diff bulgusu gerekliyi karşılar
    expect(byId.get('g3')!.pass).toBe(false);
    expect(byId.get('g3')!.reasons[0]).toContain('gate'); // pipeline fail ≠ expected pass → mismatch
    // CLI özet kanıtı (stdout JSON) store ile aynı hikayeyi taşır
    expect(prodSummary.score).toBe(66.7);
    expect(prodSummary.configSnapshot.mode).toBe('production');

    // (4) DETERMİNİSTİK kanıt: koşumdaki tüm bulgular deterministik gate stage'lerinden —
    // llm-reviewer/llm-ensemble adlı stage'den FindingEmitted YOK; StageVerdict'ler de eval-aggregate.
    const findings = store.query({ type: 'FindingEmitted' })
      .filter((e): e is Extract<DevloopEvent, { type: 'FindingEmitted' }> => e.type === 'FindingEmitted');
    expect(findings.length).toBeGreaterThanOrEqual(3); // g2 test-diff (×2 koşum) + g3 secret (üretim) — boş olamaz
    for (const f of findings) {
      expect(DETERMINISTIC_STAGES.has(f.actor)).toBe(true);
      expect(f.actor.startsWith('llm-')).toBe(false);
    }
    // Ek yapısal kanıt: store'daki HİÇBİR event LLM stage aktörü taşımaz — koşuma LLM stage'i
    // hiç kurulmadı (--full'suz eval assembly'sinde ensemble yok, cli.ts T3 hükmü).
    for (const e of store.readAll()) expect(e.actor.startsWith('llm-')).toBe(false);
    const categories = new Set(findings.map((f) => f.payload.finding.category));
    expect(categories.has('test-diff')).toBe(true);  // g2 — RiskTriageStage deterministik bulgusu
    expect(categories.has('secret')).toBe(true);     // g3 — SecretScanStage gerçek gate fail bulgusu

    // (2) SHADOW EvalRun: candidate etiketi + comparedTo = üretim evalId + gevşek policy ile 100.
    const shadow = runs[1];
    expect(typeof shadow.payload.configSnapshot.candidate).toBe('string');
    expect((shadow.payload.configSnapshot.candidate as string).length).toBeGreaterThan(0);
    expect(shadow.payload.comparedTo).toBe(prod.payload.evalId);
    expect(shadow.payload.goldenCount).toBe(3);
    expect(shadow.payload.passed).toBe(3);
    expect(shadow.payload.failed).toBe(0);
    expect(shadow.payload.score).toBe(100); // secret-scan gevşetildi → g3 koşar + beklenenle eşleşir
    // policyHash farklı: candidate policy gerçekten FARKLI (karşılaştırma aynı policy'yi yeniden koşmuyor)
    expect(shadow.payload.configSnapshot.policyHash).not.toBe(prod.payload.configSnapshot.policyHash);
    expect(shadowSummary.comparedTo).toBe(prodSummary.evalId);
    expect(shadowSummary.score).toBe(100);

    // (3) NO-WRITE: üretim policy.yaml içeriği birebir korundu; shadow salt-okunur karşılaştırmadır.
    expect(readFileSync(join(repo, 'policy.yaml'), 'utf8')).toBe(policyBefore);
    expect(existsSync(join(repo, '.devloop', 'lessons.md'))).toBe(false); // eval koşumu ders render'ı tetiklemez
    expect(existsSync(join(candidateDir, 'lessons.md'))).toBe(false);

    // (5) Kanıt zinciri: tüm store (her iki eval koşumu) ok.
    expect(validateChain(store.readAll()).ok).toBe(true);
  });

  it('aday policy dizini policy.yaml içermiyorsa fail-closed (sessiz DEFAULT_POLICY düşüşü yok)', async () => {
    const repo = makeFixtureRepo();
    const emptyDir = mkdtempSync(join(tmpdir(), 'evalshadow-empty-'));
    await expect(buildCli(repo).parseAsync(['node', 'devloop', 'eval', '--candidate', emptyDir]))
      .rejects.toThrow('policy.yaml yok');
    // red yolunda store'a EvalRun YAZILMAZ — başarısız shadow kanıt bırakmaz
    const store = new VerdictStore(join(repo, '.devloop', 'events.jsonl'));
    expect(evalRunEvents(store)).toHaveLength(0);
  });
});
