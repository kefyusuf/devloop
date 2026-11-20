import { describe, it, expect } from 'vitest';
import { acceptedRuns, generateGoldenDrafts, acceptDraft, discardDraft } from '../../src/golden/draft.js';
import { VerdictStore, validateChain } from '../../src/store/store.js';
import { loadGoldenTasks } from '../../src/eval/golden.js';
import { mkdtempSync, existsSync } from 'node:fs';
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

describe('golden draft', () => {
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
});
