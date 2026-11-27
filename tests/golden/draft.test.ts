import { describe, it, expect } from 'vitest';
import { acceptedRuns, generateGoldenDrafts, acceptDraft, discardDraft, readGoldenDraftFiles } from '../../src/golden/draft.js';
import { VerdictStore, validateChain } from '../../src/store/store.js';
import { loadGoldenTasks } from '../../src/eval/golden.js';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Brief notu: store.append async'tir — seed'i await'li yapmak zorunlu (test gövdeleri
// `await seedAcceptedRun(...)` çağırır; aksi halde event_id undefined kalır ve
// ArtifactProduced payload'ı şema doğrulamasından geçmez).
async function seedAcceptedRun(store: VerdictStore, runId: string, withPr = true) {
  await store.append('RunStarted', runId, '-', 'o', { configSnapshot: {} });
  const picked = await store.append('TaskPicked', runId, 't1', 'o', { taskSpec: { id: 't1', description: 'toplama ekle', acceptanceCriteria: ['sum(2,3)===5'], filesScope: [] } });
  const art = await store.append('ArtifactProduced', runId, 't1', 'b', { artifact: { diff: '--- a/src/math.ts\n+++ b/src/math.ts\n@@ -1 +1,2 @@\n const x=1;\n+export const sum=(a:number,b:number)=>a+b;', intent: 'sum eklendi', rejectedAlternatives: [], testEvidence: 'vitest 3 passed', files: [] }, parentTaskEventId: picked.event_id });
  if (withPr) await store.append('PRCreated', runId, 't1', 'o', { url: 'https://pr/x', title: 't1', commitSha: null, diffDigest: 'd' });
  const f = await store.append('FindingEmitted', runId, 't1', 'llm-ensemble', { finding: { id: 'f1', stage: 'llm-ensemble', category: 'lint', severity: 'required', confidence: 0.9, evidence: { file: 'src/math.ts', line: 2 }, corroborated: false }, parentArtifactEventId: art.event_id });
  await store.append('HumanDecision', runId, 't1', 'h', { decision: 'accept', reason: 'real-issue-accepted', parentFindingEventIds: [f.event_id] });
  // Brief test 1 adı 'reject kategorisi forbidden olur' vaadini taşır — gövdesi seed'e reject
  // kararı eklemeden bu davranışı doğrulayamıyordu; false-positive ret kategorisi forbidden'a
  // düşer (brief gövdesindeki mevcut iddialar aynen korunur, yalnız ek iddia yazılır).
  const f2 = await store.append('FindingEmitted', runId, 't1', 'llm-reviewer', { finding: { id: 'f2', stage: 'llm-reviewer', category: 'style', severity: 'nit', confidence: 0.8, evidence: { file: 'src/math.ts', line: 1 }, corroborated: false }, parentArtifactEventId: art.event_id });
  await store.append('HumanDecision', runId, 't1', 'h', { decision: 'reject', reason: 'false-positive', parentFindingEventIds: [f2.event_id] });
  return { picked, art, f };
}

// I1 (final fix wave, R17 binding): çok-görevli kabul koşumu — task1 temiz kabul (real-issue
// bulgusu lint), task2 kendi false-positive ret'li bulgusu (style). Eski run-bazlı kod yalnız
// İLK görevin taslağını üretiyor ve TÜM run kararlarını ona yansıtıyordu.
async function seedTwoTaskRun(store: VerdictStore, runId: string) {
  await store.append('RunStarted', runId, '-', 'o', { configSnapshot: {} });
  // task 1: temiz kabul — real-issue bulgusu (lint) accepted
  const p1 = await store.append('TaskPicked', runId, 't1', 'o', { taskSpec: { id: 't1', description: 'toplama ekle', acceptanceCriteria: ['sum(2,3)===5'], filesScope: [] } });
  const a1 = await store.append('ArtifactProduced', runId, 't1', 'b', { artifact: { diff: '--- a/src/math.ts\n+++ b/src/math.ts\n@@ -1 +1,2 @@\n const x=1;\n+export const sum=(a:number,b:number)=>a+b;', intent: 'sum eklendi', rejectedAlternatives: [], testEvidence: 'vitest 3 passed', files: [] }, parentTaskEventId: p1.event_id });
  await store.append('PRCreated', runId, 't1', 'o', { url: 'https://pr/1', title: 't1', commitSha: null, diffDigest: 'd1' });
  const f1 = await store.append('FindingEmitted', runId, 't1', 'llm-ensemble', { finding: { id: 'f1', stage: 'llm-ensemble', category: 'lint', severity: 'required', confidence: 0.9, evidence: { file: 'src/math.ts', line: 2 }, corroborated: false }, parentArtifactEventId: a1.event_id });
  await store.append('HumanDecision', runId, 't1', 'h', { decision: 'accept', reason: 'real-issue-accepted', parentFindingEventIds: [f1.event_id] });
  // task 2: kabul + kendi bulgusuna false-positive ret (style)
  const p2 = await store.append('TaskPicked', runId, 't2', 'o', { taskSpec: { id: 't2', description: 'çarpma ekle', acceptanceCriteria: ['mul(2,3)===6'], filesScope: [] } });
  const a2 = await store.append('ArtifactProduced', runId, 't2', 'b', { artifact: { diff: '--- a/src/mul.ts\n+++ b/src/mul.ts\n@@ -1 +1,2 @@\n const y=2;\n+export const mul=(a:number,b:number)=>a*b;', intent: 'mul eklendi', rejectedAlternatives: [], testEvidence: 'vitest 4 passed', files: [] }, parentTaskEventId: p2.event_id });
  await store.append('PRCreated', runId, 't2', 'o', { url: 'https://pr/2', title: 't2', commitSha: null, diffDigest: 'd2' });
  const f2 = await store.append('FindingEmitted', runId, 't2', 'llm-reviewer', { finding: { id: 'f2', stage: 'llm-reviewer', category: 'style', severity: 'nit', confidence: 0.8, evidence: { file: 'src/mul.ts', line: 1 }, corroborated: false }, parentArtifactEventId: a2.event_id });
  await store.append('HumanDecision', runId, 't2', 'h', { decision: 'accept', reason: 'real-issue-accepted', parentFindingEventIds: [] });
  await store.append('HumanDecision', runId, 't2', 'h', { decision: 'reject', reason: 'false-positive', parentFindingEventIds: [f2.event_id] });
}

describe('golden draft', () => {
  // I1 (final fix wave, R17 binding): görev-bazlı taslak üretimi — her taslağın expected'i
  // YALNIZ kendi görevinin kararlarından türer; kararlar görevler arasında sızmaz.
  it('çok-görevli kabul koşumu görev başına taslak üretir; kararlar görevler arasında sızmaz', async () => {
    const store = new VerdictStore(join(mkdtempSync(join(tmpdir(), 'gd5-')), 'e.jsonl'));
    await seedTwoTaskRun(store, 'r1');
    const repo = mkdtempSync(join(tmpdir(), 'gdm-'));
    const r = await generateGoldenDrafts({ store, repoPath: repo, draftsDir: join(repo, '.devloop', 'golden-drafts') });
    expect(r.drafts).toHaveLength(2); // eski run-bazlı kod 1 taslak üretirdi (2..N görevler taslaksız)
    expect(r.written).toBe(2);
    const byId = new Map(r.drafts.map((d) => [d.taskSpec.id, d]));
    const t1 = byId.get('t1')!;
    const t2 = byId.get('t2')!;
    expect(t1).toBeDefined();
    expect(t2).toBeDefined();
    // her taslak kendi görevinin diff'ini taşır
    expect(t1.fixtureDiff).toContain('sum');
    expect(t2.fixtureDiff).toContain('mul');
    // task1 expected'i yalnız kendi kararlarından: task2'nin false-positive 'style' red'i SIZMAZ
    expect(t1.expected.requiredFindings).toEqual([{ category: 'lint' }]);
    expect(t1.expected.forbiddenCategories).toEqual([]);
    // task2 expected'i yalnız kendi kararlarından: task1'in 'lint' required'ı SIZMAZ
    expect(t2.expected.forbiddenCategories).toEqual(['style']);
    expect(t2.expected.requiredFindings).toEqual([]);
    // goldenId görev-bazlı (taskSpec + görev diff'i) — iki görev farklı
    expect(t1.goldenId).not.toBe(t2.goldenId);
    // her taslak staging'e kendi goldenId'siyle yazılır
    expect(existsSync(join(repo, '.devloop', 'golden-drafts', t1.goldenId + '.task.json'))).toBe(true);
    expect(existsSync(join(repo, '.devloop', 'golden-drafts', t2.goldenId + '.task.json'))).toBe(true);
  });
  it('kabul edilmiş koşumdan taslak üretir; reject kategorisi forbidden olur', async () => {
    const store = new VerdictStore(join(mkdtempSync(join(tmpdir(), 'gd-')), 'e.jsonl'));
    await seedAcceptedRun(store, 'r1');
    const repo = mkdtempSync(join(tmpdir(), 'gdr-'));
    const r = await generateGoldenDrafts({ store, repoPath: repo, draftsDir: join(repo, '.devloop', 'golden-drafts') });
    expect(r.drafts).toHaveLength(1);
    expect(r.drafts[0].expected.gatesPass).toBe(true);
    expect(r.drafts[0].expected.requiredFindings).toEqual([{ category: 'lint' }]);
    expect(r.drafts[0].expected.forbiddenCategories).toEqual(['style']); // false-positive ret → forbidden
    expect(existsSync(join(repo, '.devloop', 'golden-drafts', r.drafts[0].goldenId + '.task.json'))).toBe(true);
    expect(existsSync(join(repo, '.devloop', 'golden'))).toBe(false); // golden/ dokunulmaz
  });
  it('accept: staging → golden/ taşınır ve loadGoldenTasks görür; duplicate throw', async () => {
    const store = new VerdictStore(join(mkdtempSync(join(tmpdir(), 'gd2-')), 'e.jsonl'));
    await seedAcceptedRun(store, 'r1');
    const repo = mkdtempSync(join(tmpdir(), 'gda-'));
    const draftsDir = join(repo, '.devloop', 'golden-drafts');
    const goldenDir = join(repo, '.devloop', 'golden');
    const r = await generateGoldenDrafts({ store, repoPath: repo, draftsDir });
    acceptDraft(draftsDir, goldenDir, r.drafts[0].goldenId);
    expect(loadGoldenTasks(repo).tasks).toHaveLength(1);
    expect(() => acceptDraft(draftsDir, goldenDir, r.drafts[0].goldenId)).toThrow(/duplicate/i);
  });
  it('discard: staging silinir', async () => {
    const store = new VerdictStore(join(mkdtempSync(join(tmpdir(), 'gd3-')), 'e.jsonl'));
    await seedAcceptedRun(store, 'r1');
    const repo = mkdtempSync(join(tmpdir(), 'gdd-'));
    const draftsDir = join(repo, '.devloop', 'golden-drafts');
    const r = await generateGoldenDrafts({ store, repoPath: repo, draftsDir });
    const staged = join(draftsDir, r.drafts[0].goldenId + '.task.json');
    expect(existsSync(staged)).toBe(true);
    discardDraft(draftsDir, r.drafts[0].goldenId);
    expect(existsSync(staged)).toBe(false);
  });
  it('PR olmayan kabul koşumu atlanır', async () => {
    const store = new VerdictStore(join(mkdtempSync(join(tmpdir(), 'gd4-')), 'e.jsonl'));
    await seedAcceptedRun(store, 'r1', false); // yalnız accept kararı — PRCreated yok
    const repo = mkdtempSync(join(tmpdir(), 'gdp-'));
    const r = await generateGoldenDrafts({ store, repoPath: repo, draftsDir: join(repo, '.devloop', 'golden-drafts') });
    expect(r.drafts).toHaveLength(0);
    expect(r.written).toBe(0);
    expect(existsSync(join(repo, '.devloop', 'golden-drafts', 'x.task.json'))).toBe(false);
  });

  // R26d (faz 5 T5): goldenId seed'i canonicalJson üzerinden — AYNI taskSpec içeriği farklı
  // key-sırasıyla geliyorsa AYNI goldenId (key-order duyarlılığı kapanır). Not: gerçek VerdictStore
  // yolu event şema parse'ıyla (zod) taskSpec key-sırasını şekil-sırasına normalize ettiği için bu
  // fark seed'e hiç ulaşmaz (test vacuous pass olurdu) — seed hattı HAM event'lerle (duck-typed
  // store) vurulur; draft.ts'teki gerçek goldenId hesabı aynen koşar.
  it('R26d: aynı taskSpec farklı key-sırasıyla → aynı goldenId (seed canonicalJson)', async () => {
    const specA: Record<string, unknown> = { id: 't1', description: 'toplama ekle', acceptanceCriteria: ['sum(2,3)===5'], filesScope: [] };
    const specB: Record<string, unknown> = { description: 'toplama ekle', filesScope: [], id: 't1', acceptanceCriteria: ['sum(2,3)===5'] };
    const DIFF = '--- a/src/math.ts\n+++ b/src/math.ts\n@@ -1 +1,2 @@\n const x=1;\n+export const sum=(a:number,b:number)=>a+b;';
    const mkRun = (runId: string, taskSpec: Record<string, unknown>) => ([
      { type: 'TaskPicked', run_id: runId, task_id: 't1', payload: { taskSpec } },
      { type: 'ArtifactProduced', run_id: runId, task_id: 't1', payload: { artifact: { diff: DIFF, intent: 'i', rejectedAlternatives: [], testEvidence: '', files: [] }, parentTaskEventId: 'p' } },
      { type: 'PRCreated', run_id: runId, task_id: 't1', payload: { url: 'https://pr/x', title: 't1', commitSha: null, diffDigest: 'd' } },
      { type: 'HumanDecision', run_id: runId, task_id: 't1', payload: { decision: 'accept', reason: 'real-issue-accepted', parentFindingEventIds: [] } },
    ]);
    const fakeStore = (events: { type: string; run_id: string; task_id: string }[]) => ({
      events: (f: { runId?: string; taskId?: string; type?: string }) =>
        events.filter((e) =>
          (f.type === undefined || e.type === f.type) &&
          (f.runId === undefined || e.run_id === f.runId) &&
          (f.taskId === undefined || e.task_id === f.taskId)),
    }) as unknown as VerdictStore;
    const dir = mkdtempSync(join(tmpdir(), 'gd-key-'));
    const r = await generateGoldenDrafts({
      store: fakeStore([...mkRun('r1', specA), ...mkRun('r2', specB)]),
      repoPath: dir, draftsDir: join(dir, 'drafts'),
    });
    expect(r.drafts).toHaveLength(2);
    expect(r.drafts[0].goldenId).toBe(r.drafts[1].goldenId); // key-sırası farkı id'yi değiştirmez
  });

  // R31 (faz 6 T1, T7 minor): golden-drafts okuma TEK KAPI — cli 'status' sayacı ile 'golden list'
  // AYNI helper'ı kullanır (inline *.task.json filtresi duplicate'ti). Dizin yoksa [] (fail-soft).
  it('R31: readGoldenDraftFiles — *.task.json adları, dizin yoksa []', () => {
    const repo = mkdtempSync(join(tmpdir(), 'gd-r31-'));
    mkdirSync(join(repo, '.devloop', 'golden-drafts'), { recursive: true });
    writeFileSync(join(repo, '.devloop', 'golden-drafts', 'a.task.json'), '{}');
    writeFileSync(join(repo, '.devloop', 'golden-drafts', 'b.task.json'), '{}');
    writeFileSync(join(repo, '.devloop', 'golden-drafts', 'notlar.txt'), 'x'); // .task.json değil — filtrelenir
    expect(readGoldenDraftFiles(repo)).toEqual(['a.task.json', 'b.task.json']);
    // golden-drafts/ dizini hiç yokken []
    expect(readGoldenDraftFiles(mkdtempSync(join(tmpdir(), 'gd-r31n-')))).toEqual([]);
  });
});
