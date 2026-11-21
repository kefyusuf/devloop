import { describe, it, expect, vi } from 'vitest';
import { parseDiff, runReviewDiff } from '../../src/shell/reviewDiff.js';
import { buildCli } from '../../src/shell/cli.js';
import { ReviewPipeline } from '../../src/pipeline/pipeline.js';
import { VerdictStore, validateChain } from '../../src/store/store.js';
import { loadConfig } from '../../src/config/config.js';
import { computeRisk } from '../../src/pipeline/stages/riskTriage.js';
import type { ReviewStage } from '../../src/contracts/review.js';
import type { Finding } from '../../src/contracts/schemas.js';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// R11 (faz 3 T5) CLI hüküm: review-diff assembly'si artık SABİT beş gate'i içerir (policy gates/advisory
// override ile) — CLI seviyesi testlerdeki geçici fixture dizinlerinde gerçek eslint/tsc/vitest
// koşulmamalıdır; TypeScriptAdapter temiz stub ile değiştirilir (yalnız CLI yolunu etkiler — birim
// fake stage'ler adapter kullanmaz; resolveBin/runTool/parsers gerçek implementasyon kalır).
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

const basePolicy = loadConfig(process.cwd()).policy;
// Pre-flight hüküm: exit kodu testleri policy-overridden pipeline ile — fake stage'ler (gerçek
// LLM/stryker çağrısı yok). Exit 0/1: gates ['risk-triage'], advisory []. Exit 2: geçen advisory fake.
const ciPolicy = { ...basePolicy, gates: ['risk-triage'], advisory: [] };
const advPolicy = { ...basePolicy, gates: ['risk-triage'], advisory: ['fake-advisory'] };
// R11 hüküm: runReviewDiff ÇİFT pipeline alır — gatePipeline ensemble'sız (advisory: [] override),
// fullPipeline policy advisory'li; ikisi aynı stage örneklerini paylaşır (CLI assembly deseni).
const GATES = ['risk-triage', 'static-gates', 'tests', 'secret-scan', 'mutation-testing'];

function stage(name: string, kind: 'gate' | 'advisory', status: 'pass' | 'fail' | 'error' | 'skipped', findings: Finding[] = []): ReviewStage {
  return { name, kind, evaluate: async () => ({ status, findings, durationMs: 1 }) };
}
const F = (id: string, severity: Finding['severity'], stageName = 'fake-advisory'): Finding =>
  ({ id, stage: stageName, category: 'security', severity, confidence: 1, evidence: { file: 'src/a.ts', line: 1 } });

const DIFF = ['--- a/src/a.ts', '+++ b/src/a.ts', '@@ -1,2 +1,3 @@', ' const x=1;', '+const y=2;', '+const z=3;'].join('\n');

async function runWith(stages: ReviewStage[], policy = ciPolicy) {
  const dir = mkdtempSync(join(tmpdir(), 'reviewdiff-'));
  const store = new VerdictStore(join(dir, '.devloop', 'events.jsonl'));
  const result = await runReviewDiff({
    diffText: DIFF, taskSpecId: 't1',
    gatePipeline: new ReviewPipeline(stages, { ...policy, advisory: [] }),
    fullPipeline: new ReviewPipeline(stages, policy),
    store, policy, repoPath: dir,
  });
  return { result, store, dir };
}

describe('parseDiff', () => {
  it('unified diff → dosya başına eklenen satırlar', () => {
    const d = ['--- a/src/a.ts', '+++ b/src/a.ts', '@@ -1,2 +1,3 @@', ' const x=1;', '+const y=2;', '+const z=3;'].join('\n');
    expect(parseDiff(d)).toEqual([{ path: 'src/a.ts', addedContent: 'const y=2;\nconst z=3;' }]);
  });
  it('+++ /dev/null (silinen dosya) no-path skip — yol üretilmez, önceki dosyaya sızma olmaz', () => {
    const d = [
      'diff --git a/keep.ts b/keep.ts',
      '--- a/keep.ts', '+++ b/keep.ts', '@@ -1 +1,2 @@', ' const a=1;', '+const b=2;',
      'diff --git a/gone.ts b/gone.ts', 'deleted file mode 100644',
      '--- a/gone.ts', '+++ /dev/null', '@@ -1 +0,0 @@', '-gone();',
    ].join('\n');
    expect(parseDiff(d)).toEqual([{ path: 'keep.ts', addedContent: 'const b=2;' }]);
  });
  it('--- /dev/null (yeni dosya) — yol +++ b/ satırından alınır', () => {
    const d = ['--- /dev/null', '+++ b/new.ts', '@@ -0,0 +1 @@', '+hello();'].join('\n');
    expect(parseDiff(d)).toEqual([{ path: 'new.ts', addedContent: 'hello();' }]);
  });

  // R14 (faz 3 T8) hüküm: parseDiff durum makinesi — hunk içi tırnaklanmış diff başlığı
  // (örn. PR'ın eklediği .patch dosyası gövdesi) kapsam KAPATMAZ/DEĞİŞTİRMEZ. Sözleşme testi:
  // içerik satırı tam olarak `--- a/fake.ts` → sonraki `+` satırları HÂLÂ ilk dosyaya gider.
  it('hunk içi `--- a/fake.ts` içerik satırı kapsam kapatmaz — sonraki + satırları ilk dosyaya gider', () => {
    const d = [
      '--- a/real.ts', '+++ b/real.ts', '@@ -1,2 +1,4 @@',
      ' const x=1;',
      '--- a/fake.ts',
      '+const y=2;', '+const z=3;',
    ].join('\n');
    expect(parseDiff(d)).toEqual([{ path: 'real.ts', addedContent: 'const y=2;\nconst z=3;' }]);
  });

  // Eski kodun trim() hatası: context satırı ` --- a/fake.ts` → trim sonrası `^--- ` eşleşir,
  // orijinal satır '--- a/' ile başlamadığı için kapsam KAPANIYORDU — sonraki + satırları düşüyordu.
  it('hunk içi context ` --- a/fake.ts` kapsam kapatmaz (trim tuzağı)', () => {
    const d = [
      '--- a/docs/p.md', '+++ b/docs/p.md', '@@ -1,2 +1,3 @@',
      ' alıntı:',
      ' --- a/fake.ts',
      '+real content',
    ].join('\n');
    expect(parseDiff(d)).toEqual([{ path: 'docs/p.md', addedContent: 'real content' }]);
  });

  // Eski kodun ikinci trim() hatası: context ` +++ b/fake.ts` → trim sonrası header regex'e
  // yakalanır ve kapsam fake.ts'e ATFEDİLİYORDU — sonraki + satırları yanlış dosyaya gidiyordu.
  it('hunk içi context ` +++ b/fake.ts` kapsamı çalması (misattribution)', () => {
    const d = [
      '--- a/docs/p.md', '+++ b/docs/p.md', '@@ -1,2 +1,3 @@',
      ' alıntı:',
      ' +++ b/fake.ts',
      '+real content',
    ].join('\n');
    expect(parseDiff(d)).toEqual([{ path: 'docs/p.md', addedContent: 'real content' }]);
  });

  // PR'ın eklediği .patch dosyası: içerik `--- a/`, `+++ b/` ile başlıyorsa diff kodlaması
  // `+--- a/…` / `++++ b/…` olur — eski kod `+++` önekini dışladığı için `++++ b/` satırı DÜŞUYORDU.
  it('eklenen .patch dosyası içeriği birebir toplanır (`++++ b/` satırı dahil)', () => {
    const d = [
      '--- a/notes.patch', '+++ b/notes.patch', '@@ -0,0 +1,4 @@',
      '+diff --git a/fake.ts b/fake.ts',
      '+--- a/fake.ts',
      '++++ b/fake.ts',
      '+const y=2;',
    ].join('\n');
    expect(parseDiff(d)).toEqual([{ path: 'notes.patch', addedContent: 'diff --git a/fake.ts b/fake.ts\n--- a/fake.ts\n+++ b/fake.ts\nconst y=2;' }]);
  });

  it('çok dosyalı diff: gerçek başlık çifti (`--- a/` + `+++ b/`) hunk sonrası yeni dosya açar', () => {
    const d = [
      '--- a/a.ts', '+++ b/a.ts', '@@ -1 +1,2 @@', ' ctx', '+one',
      '--- a/b.ts', '+++ b/b.ts', '@@ -1 +1,2 @@', ' ctx', '+two',
    ].join('\n');
    expect(parseDiff(d)).toEqual([
      { path: 'a.ts', addedContent: 'one' },
      { path: 'b.ts', addedContent: 'two' },
    ]);
  });

  // R22 (faz 4 T3): header regex'leri trailing whitespace toleranslı — malformed diff'lerde
  // (`+++ b/x.ts ` sonunda boşluk/tab) eski davranış başlığı tanımaz, kapsam açılmazdı; `[ \t]*$`
  // toleransı başlığı yine tanır (CRLF zaten satır bazında `\r` strip'iyle işlenir).
  it('R22: trailing-space header tanınır (`--- a/x.ts ` + `+++ b/x.ts `)', () => {
    const d = ['--- a/x.ts ', '+++ b/x.ts ', '@@ -1 +1,2 @@', ' const x=1;', '+const y=2;'].join('\n');
    expect(parseDiff(d)).toEqual([{ path: 'x.ts', addedContent: 'const y=2;' }]);
  });

  it('R22: trailing-tab header tanınır; yol duyarlılığı korunur (tab yola sızmaz)', () => {
    const d = ['--- a/y.ts\t', '+++ b/y.ts\t', '@@ -1 +1,2 @@', '+const z=3;'].join('\n');
    expect(parseDiff(d)).toEqual([{ path: 'y.ts', addedContent: 'const z=3;' }]);
  });

  // R26e (faz 5 T6): reDevNull da trailing whitespace toleranslı — malformed diff'te `+++ /dev/null `
  // (silinen dosya başlığı) eski davranışta başlık sayılmıyor, hunk içinde İÇERİK sanılıp `++ /dev/null`
  // olarak önceki dosyaya akıyordu (bogus içerik); `[ \t]*$` toleransı /dev/null skip'ini ws'li satırda
  // da korur (R22 header toleransıyla aynı aile; CRLF zaten satır bazında strip).
  it('R26e: trailing-space `+++ /dev/null ` silinen-dosya başlığı — bogus içerik önceki dosyaya akmaz', () => {
    const d = [
      '--- a/keep.ts', '+++ b/keep.ts', '@@ -1 +1,2 @@', ' const a=1;', '+const b=2;',
      'diff --git a/gone.ts b/gone.ts', 'deleted file mode 100644',
      '--- a/gone.ts', '+++ /dev/null ', '@@ -1 +0,0 @@', '-gone();',
    ].join('\n');
    expect(parseDiff(d)).toEqual([{ path: 'keep.ts', addedContent: 'const b=2;' }]);
  });
});

describe('review-diff exit kodları', () => {
  it('gates pass + bulgu yok → exit 0', async () => {
    const { result, store, dir } = await runWith([stage('risk-triage', 'gate', 'pass')]);
    expect(result.exitCode).toBe(0);
    expect(result.gateFailed).toBeNull();
    expect(result.findings).toEqual([]);
    // I3 (final fix wave): koşum RunStarted kanıtıyla açılır — policyHash + gateConfigHash (R4a)
    const started = store.query({ runId: 'ci-t1', type: 'RunStarted' });
    expect(started).toHaveLength(1);
    const snap = started[0].payload.configSnapshot as Record<string, unknown>;
    expect(typeof snap.policyHash).toBe('string');
    expect((snap.policyHash as string).length).toBe(16);
    expect(typeof snap.gateConfigHash).toBe('string');
    expect(snap.model).toBe(ciPolicy.llm.model);
    expect(snap.budgetUsd).toBe(ciPolicy.budgetUsd);
    // R15 (faz 3 T9) hüküm: configSnapshot.gates — SEÇİLEN pipeline'ın etkin stage kümesi
    // (chosen.stageNames()) kanıta yazılır; ham policy gates'i DEĞİL (T5 ertelenen minor'un
    // kapanışı). Bu testte gate/full pipeline aynı stage setine sahiptir (ciPolicy.advisory boş,
    // ikisi de yalnız risk-triage stage'i) → değer ham gates ile aynıdır; low-risk koşumda
    // llm-ensemble OLMAMASI değişmezi tests/e2e/invariants.test.ts'te pinlenir.
    expect(snap.gates).toEqual(ciPolicy.gates);
    // event zinciri: RunStarted → TaskPicked → ArtifactProduced → StageVerdict/RiskScored; runId ci-<task>
    expect(store.query({ runId: 'ci-t1', type: 'TaskPicked' }).length).toBe(1);
    const art = store.query({ runId: 'ci-t1', type: 'ArtifactProduced' })[0];
    const verdict = store.query({ runId: 'ci-t1', type: 'StageVerdict' })[0];
    const risk = store.query({ runId: 'ci-t1', type: 'RiskScored' })[0];
    expect(art).toBeDefined();
    expect(verdict.payload.parentArtifactEventId).toBe(art.event_id); // T-final D3: parentArtifactEventId zorunlu
    expect(risk.payload.parentArtifactEventId).toBe(art.event_id);
    // A3: tüm parent*EventId referansları gerçek event'lere işaret eder (brief'in 'ci' literal'i değil)
    expect(validateChain(store.readAll()).ok).toBe(true);
    // I3 idempotency: tekrarlı CI koşumu (aynı runId) İKİNCİ RunStarted yazmaz
    await runReviewDiff({
      diffText: DIFF, taskSpecId: 't1',
      gatePipeline: new ReviewPipeline([stage('risk-triage', 'gate', 'pass')], { ...ciPolicy, advisory: [] }),
      fullPipeline: new ReviewPipeline([stage('risk-triage', 'gate', 'pass')], ciPolicy),
      store, policy: ciPolicy, repoPath: dir,
    });
    expect(store.query({ runId: 'ci-t1', type: 'RunStarted' })).toHaveLength(1);
  });
  it('gate fail → exit 1', async () => {
    const { result, store } = await runWith([stage('risk-triage', 'gate', 'fail', [F('f1', 'required', 'risk-triage')])]);
    expect(result.exitCode).toBe(1);
    expect(result.gateFailed).toBe('risk-triage');
    // gate bulguları da kanıta yazılır
    expect(store.query({ runId: 'ci-t1', type: 'FindingEmitted' }).length).toBe(1);
  });
  it('advisory bulgu → exit 2', async () => {
    const { result, store } = await runWith(
      [stage('risk-triage', 'gate', 'pass'), stage('fake-advisory', 'advisory', 'pass', [F('f1', 'required')])], advPolicy);
    expect(result.exitCode).toBe(2);
    expect(result.gateFailed).toBeNull();
    expect(result.findings.map((f) => f.severity)).toEqual(['required']);
    expect(store.query({ runId: 'ci-t1', type: 'FindingEmitted' }).length).toBe(1);
  });
  it('critical bulgu (gate pass) → exit 1', async () => {
    const { result } = await runWith(
      [stage('risk-triage', 'gate', 'pass'), stage('fake-advisory', 'advisory', 'pass', [F('f1', 'critical')])], advPolicy);
    expect(result.exitCode).toBe(1);
    expect(result.gateFailed).toBeNull();
  });
});

// R11 (faz 3 T5): risk-tiered tetikleme — RiskTriageStage ÖNCE tek başına koşar (risk skoru hesaplar);
// skor < policy.ciEnsembleRiskThreshold → gatePipeline, değilse fullPipeline koşar. Fixture skorları
// computeRisk ile deterministik: LOW = docs yolu (testDiff 0, scopePaths 0) + 161 diff satırı →
// round(100*0.3*161/500) = 10; HIGH = tests yolu (testDiff 1) + 5 satır → round(100*(0.3*5/500+0.5)) = 50.
describe('review-diff risk-tiered seçim (R11)', () => {
  const LOW_DIFF = ['--- a/docs/notes.md', '+++ b/docs/notes.md', '@@ -0,0 +1,158 @@',
    ...Array.from({ length: 158 }, (_, i) => `+satır ${i}`)].join('\n');
  const TEST_DIFF = ['--- a/tests/x.test.ts', '+++ b/tests/x.test.ts', '@@ -1 +1,2 @@', ' const a=1;', '+const b=2;'].join('\n');

  const asArtifact = (diffText: string) => ({
    diff: diffText, intent: 'ci-review', rejectedAlternatives: [] as string[], testEvidence: 'ci',
    files: parseDiff(diffText).map((f) => ({ path: f.path, content: f.addedContent })),
  });

  const ensembleSpy = () => {
    const calls = { evaluate: 0 };
    const s: ReviewStage = {
      name: 'llm-ensemble', kind: 'advisory',
      evaluate: async () => { calls.evaluate += 1; return { status: 'pass', findings: [], durationMs: 1 }; },
    };
    return { stage: s, calls };
  };

  function runTiered(diffText: string) {
    const dir = mkdtempSync(join(tmpdir(), 'reviewdiff-tier-'));
    const store = new VerdictStore(join(dir, '.devloop', 'events.jsonl'));
    const ens = ensembleSpy();
    const gateStages = GATES.map((n) => stage(n, 'gate', 'pass'));
    const gatePipeline = new ReviewPipeline(gateStages, { ...basePolicy, gates: GATES, advisory: [] });
    const fullPipeline = new ReviewPipeline([...gateStages, ens.stage], { ...basePolicy, gates: GATES, advisory: ['llm-ensemble'] });
    return {
      run: () => runReviewDiff({ diffText, taskSpecId: 't1', gatePipeline, fullPipeline, store, policy: basePolicy, repoPath: dir }),
      store, ens, dir,
    };
  }

  it('(a) risk 10 (< eşik 20) → gatePipeline koşar: ensemble HİÇ çağrılmaz, gates koşar, exit 0', async () => {
    expect(computeRisk(asArtifact(LOW_DIFF), basePolicy).score).toBe(10); // fixture sözleşmesi pin'li
    const { run: doRun, store, ens } = runTiered(LOW_DIFF);
    const result = await doRun();
    expect(ens.calls.evaluate).toBe(0); // LOW risk → fullPipeline'a hiç girilmez (spy sayaç)
    expect(result.exitCode).toBe(0);
    expect(result.gateFailed).toBeNull();
    expect(result.findings).toEqual([]);
    const verdictStages = store.query({ runId: 'ci-t1', type: 'StageVerdict' }).map((e) => e.payload.stage);
    expect(verdictStages).toContain('static-gates'); // gatePipeline GERÇEKTEN koştu
    expect(verdictStages).not.toContain('llm-ensemble');
    // bağımsız triaj koşumu + seçilen pipeline'ın kendi risk-triage'i → iki risk-triage verdict'i
    expect(verdictStages.filter((s) => s === 'risk-triage')).toHaveLength(2);
    expect(validateChain(store.readAll()).ok).toBe(true); // (c)
  });

  it('(b) risk 50 (≥ eşik 20) → fullPipeline: ensemble tam 1 kez, exit 2 + test-diff bulgusu', async () => {
    expect(computeRisk(asArtifact(TEST_DIFF), basePolicy).score).toBe(50); // fixture sözleşmesi pin'li
    const { run: doRun, store, ens } = runTiered(TEST_DIFF);
    const result = await doRun();
    expect(ens.calls.evaluate).toBe(1); // HIGH risk → tam bir ensemble koşumu
    expect(result.exitCode).toBe(2);
    expect(result.gateFailed).toBeNull();
    // test-diff bulgusu kaybolmaz: bağımsız triaj koşumunun bulgusu kanıta akar (§5.2.4 anahtar kuralı)
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].category).toBe('test-diff');
    expect(result.findings[0].stage).toBe('risk-triage');
    const emitted = store.query({ runId: 'ci-t1', type: 'FindingEmitted' });
    expect(emitted).toHaveLength(1);
    expect(emitted[0].actor).toBe('risk-triage');
    expect(emitted[0].payload.parentArtifactEventId).toBe(store.query({ runId: 'ci-t1', type: 'ArtifactProduced' })[0].event_id);
    expect(validateChain(store.readAll()).ok).toBe(true); // (c)
  });
});

describe('review-diff CLI (buildCli → process.exitCode)', () => {
  // policy.yaml tam şema ister (zod) — yük/tipler minimal geçerli politika.
  // hüküm (R11, faz 3 T5): review-diff assembly'si policy gates/advisory'i OVERRIDE eder (sabit beş gate
  // + advisory override) — gates paramı artık yalnız şema geçerliliği içindir.
  const policyYaml = (gates: string[]) => `version: 1
gates: [${gates.join(', ')}]
advisory: []
maxFixTours: 3
maxIterations: 10
budgetUsd: 2.0
wallClockMinutes: 30
risk: { weights: { diffSize: 0.3, testDiff: 0.5, scopePaths: 0.2 } }
llm: { provider: anthropic, model: m1, fallbackModel: m2, maxTokens: 1024, costPer1kInput: 0.001, costPer1kOutput: 0.002 }
`;

  function tmpRepo(gates: string[], diff: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'reviewdiff-cli-'));
    writeFileSync(join(dir, 'policy.yaml'), policyYaml(gates), 'utf8');
    writeFileSync(join(dir, 'pr.diff'), diff, 'utf8');
    return dir;
  }

  it('exit 0: gates pass + bulgu yok → process.exitCode "0"', async () => {
    // hüküm (R11): LOW-risk fixture (docs yolu — testDiff 0, scopePaths 0, 5 satır → risk 0 < eşik 20)
    // → gatePipeline koşar; fullPipeline/ensemble'a hiç girilmez (API anahtarı gerekmez).
    // R26b hüküm: gateway kurulumu 0-ayakta fail-closed → sahte anahtar ile 1 ayak kurulur
    // (fetch stub 401: ensemble girilse bile fail-fast GatewayError; gerçek ağ/backoff YOK).
    const dir = tmpRepo(['risk-triage'], ['--- a/docs/notes.md', '+++ b/docs/notes.md', '@@ -1 +1,2 @@', ' satır', '+yeni satır'].join('\n'));
    const prevKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'k-dummy';
    const prevFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response('unauthorized', { status: 401 });
    const prev = process.exitCode;
    try {
      await buildCli(dir).parseAsync(['node', 'devloop', 'review-diff', '--diff', join(dir, 'pr.diff'), '--task', 't1']);
      expect(Number(process.exitCode)).toBe(0); // vitest worker exitCode'u number'a çevirir — üretimde String('0') kalır
    } finally {
      process.exitCode = prev;
      globalThis.fetch = prevFetch;
      if (prevKey !== undefined) process.env.ANTHROPIC_API_KEY = prevKey;
    }
    const store = new VerdictStore(join(dir, '.devloop', 'events.jsonl'));
    expect(store.query({ runId: 'ci-t1', type: 'StageVerdict' })[0].payload.status).toBe('pass'); // bağımsız triaj verdict'i ilk sırada
    const verdictStages = store.query({ runId: 'ci-t1', type: 'StageVerdict' }).map((e) => e.payload.stage);
    expect(verdictStages).toContain('static-gates'); // sabit beş gate koşar (policy gates override)
    expect(verdictStages).not.toContain('llm-ensemble'); // LOW risk → ensemble koşmaz
    expect(validateChain(store.readAll()).ok).toBe(true);
  });

  it('exit 1: sır içeren diff → secret-scan gate fail → process.exitCode "1"', async () => {
    // R26b hüküm: gateway kurulumu 0-ayakta fail-closed → sahte anahtar ile 1 ayak kurulur
    // (fetch stub 401: ensemble girilse bile fail-fast; secret-scan gate zaten exit 1 verir).
    const dir = tmpRepo(['risk-triage', 'secret-scan'], DIFF + "\n+const K = 'AKIAIOSFODNN7EXAMPLE';\n");
    const prevKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'k-dummy';
    const prevFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response('unauthorized', { status: 401 });
    const prev = process.exitCode;
    try {
      await buildCli(dir).parseAsync(['node', 'devloop', 'review-diff', '--diff', join(dir, 'pr.diff'), '--task', 't1']);
      expect(Number(process.exitCode)).toBe(1);
    } finally {
      process.exitCode = prev;
      globalThis.fetch = prevFetch;
      if (prevKey !== undefined) process.env.ANTHROPIC_API_KEY = prevKey;
    }
    const store = new VerdictStore(join(dir, '.devloop', 'events.jsonl'));
    const secretVerdict = store.query({ runId: 'ci-t1', type: 'StageVerdict' }).find((e) => e.payload.stage === 'secret-scan');
    expect(secretVerdict?.payload.status).toBe('fail');
  });

  // hüküm (R11): eski exit-2 testi artık FULL yolu koşturur (test dosyası → risk 50 ≥ eşik 20 →
  // fullPipeline + ensemble). Assertion'lar korunur; assembly adaptasyonu: ensemble fail-fast
  // GatewayError verir (advisory — gate düşürmez) diye koşum süresince sahte anahtar + fetch stub
  // kullanılır (R26b hüküm: 0-ayak kurulum fail-closed olduğundan anahtar SİLME artık kullanılamaz —
  // sahte anahtar → 1 ayak; HTTP 401 → reviewer retry'sız ve bekleme yapmadan fail-fast).
  it('exit 2: test dosyası ekleyen diff → risk-triage required bulgu → process.exitCode "2"', async () => {
    const dir = tmpRepo(['risk-triage'], ['--- a/tests/x.test.ts', '+++ b/tests/x.test.ts', '@@ -1 +1,2 @@', ' const a=1;', '+const b=2;'].join('\n'));
    const prevKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'k-dummy';
    const prevFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response('unauthorized', { status: 401 });
    const prev = process.exitCode;
    try {
      await buildCli(dir).parseAsync(['node', 'devloop', 'review-diff', '--diff', join(dir, 'pr.diff'), '--task', 't1']);
      expect(Number(process.exitCode)).toBe(2);
    } finally {
      process.exitCode = prev;
      globalThis.fetch = prevFetch;
      if (prevKey !== undefined) process.env.ANTHROPIC_API_KEY = prevKey;
    }
    const store = new VerdictStore(join(dir, '.devloop', 'events.jsonl'));
    const findings = store.query({ runId: 'ci-t1', type: 'FindingEmitted' });
    expect(findings.length).toBe(1); // bağımsız triaj + pipeline içi triaj aynı anahtar → tek bulgu (§5.2.4)
    expect(findings[0].payload.finding.category).toBe('test-diff');
  });
});
