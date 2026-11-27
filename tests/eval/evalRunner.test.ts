import { describe, it, expect, vi } from 'vitest';
import { runEval, scoreEval } from '../../src/eval/evalRunner.js';
import { VerdictStore } from '../../src/store/store.js';
import { validateChain } from '../../src/store/store.js';
import { loadConfig } from '../../src/config/config.js';
import type { Policy } from '../../src/config/config.js';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ReviewPipeline } from '../../src/pipeline/pipeline.js';
import type { StageResult, ReviewStage } from '../../src/contracts/review.js';
import type { LlmGateway } from '../../src/gateway/gateway.js';
// hüküm: tsconfig.test kapsamı (R26h) — payload union daraltma yardımcısı
import { queryTyped } from '../helpers/events.js';

const policy = loadConfig(process.cwd()).policy;
const GOLDEN_DIFF = '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1,2 @@\n const x=1;\n+const y=2;';
const GOLDEN = {
  goldenId: 'g1',
  taskSpec: { id: 'gt1', description: 'd', acceptanceCriteria: ['a'], filesScope: [] },
  fixtureDiff: GOLDEN_DIFF,
  expected: { gatesPass: true, requiredFindings: [], forbiddenCategories: [] },
};

function makeRepo(tasks: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'ev-'));
  mkdirSync(join(dir, '.devloop', 'golden'), { recursive: true });
  tasks.forEach((t, i) => writeFileSync(join(dir, '.devloop', 'golden', `g${i}.task.json`), JSON.stringify(t)));
  return dir;
}
const passPipeline = (): ReviewPipeline => {
  // hüküm: tsconfig.test kapsamı — evaluate sıfır-parametre ilan edilmişti; çağrı ctx geçirir
  const s = { name: 'static-gates', kind: 'gate' as const, evaluate: async (_ctx: unknown): Promise<StageResult> => ({ status: 'pass', findings: [], durationMs: 1 }) };
  return { ordered: () => [s], run: vi.fn(async (ctx) => { await s.evaluate(ctx); return { verdicts: [{ stage: 'static-gates', status: 'pass', durationMs: 1 }], findings: [], gateFailed: null, passed: true }; }) } as unknown as ReviewPipeline;
};

describe('scoreEval', () => {
  it('gates pass + required yakalanmış + forbidden yok → pass', () => {
    // hüküm: tsconfig.test kapsamı — corroborated Finding düzeyinde zorunlu (evidence içinde değil)
    const r = scoreEval({ passed: true, findings: [{ id: 'f', stage: 's', category: 'lint', severity: 'required', confidence: 1, corroborated: false, evidence: { file: 'a' } }] },
      { gatesPass: true, requiredFindings: [{ category: 'lint' }], forbiddenCategories: [] });
    expect(r.pass).toBe(true);
  });
  it('gates beklenenin tersi → fail + gerekçe', () => {
    const r = scoreEval({ passed: false, findings: [] }, { gatesPass: true, requiredFindings: [], forbiddenCategories: [] });
    expect(r.pass).toBe(false);
    expect(r.reasons[0]).toContain('gate');
  });
  it('forbidden kategori ihlali → fail', () => {
    // hüküm: tsconfig.test kapsamı — corroborated Finding düzeyinde zorunlu (evidence içinde değil)
    const r = scoreEval({ passed: true, findings: [{ id: 'f', stage: 's', category: 'secret', severity: 'critical', confidence: 1, corroborated: false, evidence: { file: 'a' } }] },
      { gatesPass: true, requiredFindings: [], forbiddenCategories: ['secret'] });
    expect(r.pass).toBe(false);
  });
});

describe('runEval', () => {
  it('golden seti koşar, EvalRun yazar, skor 100, kanıt zinciri ok', async () => {
    const dir = makeRepo([GOLDEN]);
    const store = new VerdictStore(join(dir, '.devloop', 'events.jsonl'));
    const r = await runEval({ repoPath: dir, pipeline: passPipeline(), policy, store, l3MinGoldenTasks: policy.l3MinGoldenTasks });
    expect(r.goldenCount).toBe(1);
    expect(r.passed).toBe(1);
    expect(r.score).toBe(100);
    expect(r.l3Active).toBe(false); // 1 < 50
    // hüküm: tsconfig.test kapsamı — events() payload union döndürür; queryTyped ile daraltılır
    const ev = queryTyped(store, { type: 'EvalRun' })[0];
    expect(ev.payload.score).toBe(100);
    expect(validateChain(store.readAll()).ok).toBe(true);
  });
  it('LLM-siz: eval, pipeline stage\'lerinin gerektirdiği dışında gateway çağrısı EKLEMEZ', async () => {
    const dir = makeRepo([GOLDEN]);
    const store = new VerdictStore(join(dir, '.devloop', 'events.jsonl'));
    const spyGateway = { complete: vi.fn(async () => ({ data: { findings: [] }, usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } })) };
    const primary: ReviewStage = { name: 'llm-reviewer', kind: 'advisory', evaluate: async (ctx) => {
      // hüküm: tsconfig.test kapsamı — parse parametresi implicit any idi; unknown anotasyonu
      await (spyGateway as unknown as LlmGateway).complete({ system: 's', user: 'u', schema: { parse: (x: unknown) => x } as never, runId: ctx.taskSpec.id });
      return { status: 'pass', findings: [], durationMs: 1 };
    } };
    const gateStage: ReviewStage = { name: 'static-gates', kind: 'gate', evaluate: async () => ({ status: 'pass', findings: [], durationMs: 1 }) };
    const pipeline = { run: vi.fn(async (ctx) => { await primary.evaluate(ctx); return { verdicts: [], findings: [], gateFailed: null, passed: true }; }) } as unknown as ReviewPipeline;
    const r = await runEval({ repoPath: dir, pipeline, policy, store, l3MinGoldenTasks: policy.l3MinGoldenTasks });
    expect(r.score).toBe(100);
    expect(spyGateway.complete).toHaveBeenCalledTimes(1); // 1 görev × 1 stage çağrısı — runEval fazladan eklemez
  });

  // R15 fix round 1: şemaya uymayan golden dosyası sessizce hariç tutulMAZ — dosya adı summary.invalid
  // VE EvalRun payload.invalid ile raporlanır (eval harness için zayıf sinyal düzeltmesi).
  it('geçersiz golden dosyası summary.invalid + EvalRun payload.invalid ile raporlanır', async () => {
    const dir = makeRepo([GOLDEN]);
    writeFileSync(join(dir, '.devloop', 'golden', 'bad.task.json'), '{"goldenId": "x"}'); // şema dışı (fixtureDiff/expected yok)
    const store = new VerdictStore(join(dir, '.devloop', 'events.jsonl'));
    const r = await runEval({ repoPath: dir, pipeline: passPipeline(), policy, store, l3MinGoldenTasks: policy.l3MinGoldenTasks });
    expect(r.goldenCount).toBe(1); // yalnız GEÇERLİ görev koşar
    expect(r.invalid).toEqual(['bad.task.json']);
    // hüküm: tsconfig.test kapsamı — events() payload union döndürür; queryTyped ile daraltılır
    const ev = queryTyped(store, { type: 'EvalRun' })[0];
    expect(ev.payload.invalid).toEqual(['bad.task.json']); // kanıt zincirinde de taşınır
    expect(validateChain(store.readAll()).ok).toBe(true);
  });
  it('geçersiz dosya yokken invalid boş listedir', async () => {
    const dir = makeRepo([GOLDEN]);
    const store = new VerdictStore(join(dir, '.devloop', 'events.jsonl'));
    const r = await runEval({ repoPath: dir, pipeline: passPipeline(), policy, store, l3MinGoldenTasks: policy.l3MinGoldenTasks });
    expect(r.invalid).toEqual([]);
    // hüküm: tsconfig.test kapsamı — events() payload union döndürür; queryTyped ile daraltılır
    expect(queryTyped(store, { type: 'EvalRun' })[0].payload.invalid).toEqual([]);
  });

  // R22 (faz 4 T3): evalId çarpışma — seed yalnız repoPath+tasks.length+invalid iken aynı repo +
  // aynı golden setten arka arkaya iki koşum Date.now() AYNI milisaniyeye düşerse ÇAKIŞIRDI;
  // randomUUID seed'e eklendi — evalId (ve runId) her koşumda benzersiz. Date.now dondurulur:
  // aynen eski seed'le iki koşum birebir aynı evalId'yi üretir (RED kanıtı), randomUUID ile ayrışır.
  it('R22: aynı repo+golden setten arka arkaya iki runEval → farklı evalId (aynı ms dahil)', async () => {
    const dir = makeRepo([GOLDEN]);
    const store = new VerdictStore(join(dir, '.devloop', 'events.jsonl'));
    const args = { repoPath: dir, pipeline: passPipeline(), policy, store, l3MinGoldenTasks: policy.l3MinGoldenTasks };
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_000_000); // aynı-milisaniye çakışması simülasyonu
    let r1: Awaited<ReturnType<typeof runEval>>;
    let r2: Awaited<ReturnType<typeof runEval>>;
    try {
      r1 = await runEval(args);
      r2 = await runEval(args);
    } finally {
      nowSpy.mockRestore();
    }
    expect(r1.evalId).not.toBe(r2.evalId);
    // hüküm: tsconfig.test kapsamı — events() payload union döndürür; queryTyped ile daraltılır
    const ids = queryTyped(store, { type: 'EvalRun' }).map((e) => e.payload.evalId);
    expect(new Set(ids).size).toBe(2); // kanıtta da çarpışma yok
  });

  // R31 (faz 6 T1): policyHash seed'i canonicalJson — key-order determinizmi. Aynı alanlar farklı
  // key-sırasıyla kurulmuş iki policy → AYNI hash. Bilinen davranış değişikliği (hüküm): hash
  // DEĞERLERİ değişir (policy çok-anahtarlı); resume-mismatch karşılaştırması iki tarafı da aynı
  // algoritmayla hesapladığından tutarlı kalır.
  it('R31: policyHash key-order duyarlı DEĞİL (canonicalJson seed)', async () => {
    const dir = makeRepo([GOLDEN]);
    const store = new VerdictStore(join(dir, '.devloop', 'events.jsonl'));
    const policyA: Policy = { ...policy, gates: ['risk-triage'], advisory: [] };
    // aynı alanlar, farklı key-sırası: entries ters çevrilerek yeniden kurulur (değerler birebir)
    const policyB = Object.fromEntries(Object.entries(policyA).reverse()) as Policy;
    // önkoşul: JSON.stringify seed'i sıra farkını gerçekten yansıtır (test boşa koşmuyor)
    expect(JSON.stringify(policyA)).not.toBe(JSON.stringify(policyB));
    const common = { repoPath: dir, pipeline: passPipeline(), store, l3MinGoldenTasks: policy.l3MinGoldenTasks };
    const r1 = await runEval({ ...common, policy: policyA });
    const r2 = await runEval({ ...common, policy: policyB });
    expect(r1.configSnapshot.policyHash).toBe(r2.configSnapshot.policyHash);
  });

  // R30 (faz 6 T2): multi-repo eval — runEval repo parametresi EvalRun payload KÖKÜNE yazılır
  // (configSnapshot'a DEĞİL — aggregate perRepo alanı payload.repo'dan okunur). Tek-repo koşumda
  // alan TANIMSIZ kalır (geriye-uyumlu — mevcut koşumlar ve eski store satırları alanı taşımaz).
  it('R30: runEval repo parametresi EvalRun payload köküne yazılır', async () => {
    const dir = makeRepo([GOLDEN]);
    const store = new VerdictStore(join(dir, '.devloop', 'events.jsonl'));
    await runEval({ repoPath: dir, pipeline: passPipeline(), policy, store, l3MinGoldenTasks: policy.l3MinGoldenTasks, repo: 'fixture-a' });
    // hüküm: tsconfig.test kapsamı — events() payload union döndürür; queryTyped ile daraltılır
    const evs = queryTyped(store, { type: 'EvalRun' });
    expect(evs).toHaveLength(1);
    expect(evs[0].payload.repo).toBe('fixture-a');
  });
  it('R30: repo verilmeyen koşumda payload.repo undefined (geriye-uyumlu regrezyon pini)', async () => {
    const dir = makeRepo([GOLDEN]);
    const store = new VerdictStore(join(dir, '.devloop', 'events.jsonl'));
    await runEval({ repoPath: dir, pipeline: passPipeline(), policy, store, l3MinGoldenTasks: policy.l3MinGoldenTasks });
    // hüküm: tsconfig.test kapsamı — events() payload union döndürür; queryTyped ile daraltılır
    expect(queryTyped(store, { type: 'EvalRun' })[0].payload.repo).toBeUndefined();
  });

  // R35 (faz 7 T1): comparedTo cross-repo scope — aday koşumu yalnız AYNI reponun EN SON
  // production koşumuyla karşılaştırılır (prevRuns filtresi payload.repo ile daraltılır;
  // tanımsız↔tanımsız eşleşir). Filtresiz davranışta B (son koşum) referans verilirdi —
  // farklı reponun skoruyla çapraz karşılaştırma ölçüm hatasıdır.
  it('R35: comparedTo yalnız AYNI reponun en son production koşumuna referans verir', async () => {
    const dir = makeRepo([GOLDEN]);
    const store = new VerdictStore(join(dir, '.devloop', 'events.jsonl'));
    const common = { repoPath: dir, pipeline: passPipeline(), policy, store, l3MinGoldenTasks: policy.l3MinGoldenTasks };
    const runA = await runEval({ ...common, repo: 'A' }); // repo A production koşumu (ÖNCE)
    const runB = await runEval({ ...common, repo: 'B' }); // repo B production koşumu (SONRA — filtresiz son koşum)
    const candidate = await runEval({ ...common, repo: 'A', candidate: { label: 'aday' } });
    expect(candidate.comparedTo).toBe(runA.evalId); // A'nın evalId'si — B'nin DEĞİL
    expect(runA.evalId).not.toBe(runB.evalId); // önkoşul: evalId'ler gerçekten ayrışıyor (test boşa koşmuyor)
  });
  it('R35: repo tanımsız koşumlar yalnız repo tanımsız production koşumlarla eşleşir', async () => {
    const dir = makeRepo([GOLDEN]);
    const store = new VerdictStore(join(dir, '.devloop', 'events.jsonl'));
    const common = { repoPath: dir, pipeline: passPipeline(), policy, store, l3MinGoldenTasks: policy.l3MinGoldenTasks };
    const plain = await runEval(common); // repo TANIMSIZ production koşumu (ÖNCE)
    const runX = await runEval({ ...common, repo: 'X' }); // repo'lu production koşumu (SONRA — filtresiz son koşum)
    const candidate = await runEval({ ...common, candidate: { label: 'aday' } }); // repo yok (tanımsız)
    expect(candidate.comparedTo).toBe(plain.evalId); // tanımsız koşumun evalId'si — X'in DEĞİL
    expect(plain.evalId).not.toBe(runX.evalId); // önkoşul: evalId'ler gerçekten ayrışıyor (test boşa koşmuyor)
  });

  // R37 (faz 7 T3): multi-eval batch işareti — aynı `--repos` koşumunun TÜM per-repo EvalRun'ları
  // AYNI multiEvalId değerini payload KÖKÜNDE taşır (repo gibi; configSnapshot'a DEĞİL). resolveL3
  // en son batch'i bu alandan gruplar. Tek-repo koşumda verilmez → alan hiç yazılmaz (geriye-uyumlu).
  it('R37: runEval multiEvalId payload köküne yazılır', async () => {
    const dir = makeRepo([GOLDEN]);
    const store = new VerdictStore(join(dir, '.devloop', 'events.jsonl'));
    await runEval({ repoPath: dir, pipeline: passPipeline(), policy, store, l3MinGoldenTasks: policy.l3MinGoldenTasks, multiEvalId: 'multi-1' });
    // hüküm: tsconfig.test kapsamı — events() payload union döndürür; queryTyped ile daraltılır
    const evs = queryTyped(store, { type: 'EvalRun' });
    expect(evs).toHaveLength(1);
    expect(evs[0].payload.multiEvalId).toBe('multi-1');
  });
  it('R37: multiEvalId verilmezse payload.multiEvalId tanımsız kalır (geriye-uyumlu regrezyon pini)', async () => {
    const dir = makeRepo([GOLDEN]);
    const store = new VerdictStore(join(dir, '.devloop', 'events.jsonl'));
    await runEval({ repoPath: dir, pipeline: passPipeline(), policy, store, l3MinGoldenTasks: policy.l3MinGoldenTasks });
    // hüküm: tsconfig.test kapsamı — events() payload union döndürür; queryTyped ile daraltılır
    expect(queryTyped(store, { type: 'EvalRun' })[0].payload.multiEvalId).toBeUndefined();
  });
});
