import { describe, it, expect } from 'vitest';
import { generateCandidates, confirmCandidate, generateProposals, applyProposal } from '../../src/learning/learn.js';
import { VerdictStore } from '../../src/store/store.js';
import { LessonMemory } from '../../src/memory/memory.js';
import { buildCli } from '../../src/shell/cli.js';
import { mkdtempSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
// hüküm: tsconfig.test kapsamı (R26h) — payload union daraltma yardımcısı
import { queryTyped } from '../helpers/events.js';

async function seed(store: VerdictStore, category: string, count: number, reason: 'false-positive' | 'real-issue-accepted') {
  for (let i = 0; i < count; i++) {
    const art = await store.append('ArtifactProduced', 'r1', `t${category}${i}`, 'backend', { artifact: { diff: 'x', intent: 'i', rejectedAlternatives: [], testEvidence: '', files: [] }, parentTaskEventId: 'p' });
    // hüküm: tsconfig.test kapsamı — corroborated Finding şemasında zorunlu alan
    const f = await store.append('FindingEmitted', 'r1', `t${category}${i}`, 'llm-reviewer', { finding: { id: `f${i}`, stage: 'llm-reviewer', category, severity: 'required', confidence: 0.8, corroborated: false, evidence: { file: 'a.ts', line: 1 } }, parentArtifactEventId: art.event_id });
    await store.append('HumanDecision', 'r1', `t${category}${i}`, 'human', { decision: reason === 'false-positive' ? 'reject' : 'accept', reason, parentFindingEventIds: [f.event_id] });
  }
}

describe('generateCandidates', () => {
  it('≥2 false-positive reject → reviewer hedefli aday', async () => {
    const store = new VerdictStore(join(mkdtempSync(join(tmpdir(), 'lrn-')), 'e.jsonl'));
    await seed(store, 'performance', 2, 'false-positive');
    const c = generateCandidates(store);
    expect(c).toHaveLength(1);
    expect(c[0].pattern).toBe('repeated-false-positive');
    expect(c[0].targetComponent).toBe('reviewer');
    expect(c[0].rule).toContain('performance');
  });
  it('lessonId deterministik: iki sorgu aynı ID', async () => {
    const store = new VerdictStore(join(mkdtempSync(join(tmpdir(), 'lrn2-')), 'e.jsonl'));
    await seed(store, 'security', 2, 'false-positive');
    expect(generateCandidates(store)[0].lessonId).toBe(generateCandidates(store)[0].lessonId);
  });
  it('tek karar aday üretmez', async () => {
    const store = new VerdictStore(join(mkdtempSync(join(tmpdir(), 'lrn3-')), 'e.jsonl'));
    await seed(store, 'security', 1, 'false-positive');
    expect(generateCandidates(store)).toHaveLength(0);
  });
});

describe('confirmCandidate', () => {
  it('active LessonLearned yazar (targetComponent korunur) + render', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lrn4-'));
    const store = new VerdictStore(join(dir, 'e.jsonl'));
    await seed(store, 'performance', 2, 'false-positive');
    const [c] = generateCandidates(store);
    const mem = new LessonMemory(store, join(dir, 'lessons.md'));
    const ev = await confirmCandidate(store, mem, c);
    // hüküm: tsconfig.test kapsamı — union daraltma (aynen evolve.test.ts desen)
    if (ev.type !== 'LessonLearned') return; // union daraltma
    expect(ev.payload.status).toBe('active');
    expect(ev.payload.targetComponent).toBe('reviewer');
    expect(mem.reviewerContext()).toContain('performance');
  });
});

// I4 (final review): aday ret tombstone'u — retire edilmiş deterministik ID yeniden listelenmez.
describe('CLI learn reject (aday tombstone)', () => {
  it('aday listede → reject → yeniden listelenmez; tombstone event retired status taşır', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-lrn-'));
    const store = new VerdictStore(join(dir, '.devloop', 'events.jsonl'));
    await seed(store, 'security', 2, 'false-positive');
    const [c] = generateCandidates(store);
    expect(c).toBeDefined();
    await buildCli(dir).parseAsync(['node', 'devloop', 'learn', 'reject', c!.lessonId]);
    // retired filtre: aynı karar seti deterministik ID'yi yeniden üretse de aday listede YOK
    expect(generateCandidates(store).some((x) => x.lessonId === c!.lessonId)).toBe(false);
    // hüküm: tsconfig.test kapsamı — query payload union döndürür; queryTyped ile daraltılır
    const events = queryTyped(store, { type: 'LessonLearned' });
    const tomb = events[events.length - 1].payload;
    expect(tomb.status).toBe('retired');
    expect(tomb.lessonId).toBe(c!.lessonId);
    expect(tomb.targetComponent).toBe('reviewer');
    expect(tomb.rule).toBe(c!.rule);
  });
  it('bilinmeyen ID → hata (aday veya aktif ders yok)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-lrn2-'));
    const store = new VerdictStore(join(dir, '.devloop', 'events.jsonl'));
    await seed(store, 'security', 2, 'false-positive');
    await expect(buildCli(dir).parseAsync(['node', 'devloop', 'learn', 'reject', 'yok-boyle-id']))
      .rejects.toThrow('Aday veya aktif ders bulunamadı');
  });
});

// R5 (faz 2 T7): L2 kural indüksiyonu — deterministik proposal üretimi + ProposalCreated staging.
describe('generateProposals (L2)', () => {
  it('≥2 reject + ≥3 ayrı koşum + global eşik → lint-rule proposal; applied olan listelenmez', async () => {
    const store = new VerdictStore(join(mkdtempSync(join(tmpdir(), 'l2-')), 'e.jsonl'));
    await store.append('RunStarted', 'r1', '-', 'o', { configSnapshot: {} });
    await store.append('RunStarted', 'r2', '-', 'o', { configSnapshot: {} });
    await store.append('RunStarted', 'r3', '-', 'o', { configSnapshot: {} });
    for (const [i, run] of ['r1', 'r2', 'r3'].entries()) {
      const art = await store.append('ArtifactProduced', run, `t${i}`, 'b', { artifact: { diff: 'x', intent: 'i', rejectedAlternatives: [], testEvidence: '', files: [] }, parentTaskEventId: 'p' });
      // hüküm: tsconfig.test kapsamı — corroborated Finding şemasında zorunlu alan
      const f = await store.append('FindingEmitted', run, `t${i}`, 'llm-ensemble', { finding: { id: `f${i}`, stage: 'llm-ensemble', category: 'off-by-one', severity: 'required', confidence: 0.9, corroborated: false, evidence: { file: 'a.ts', line: i + 1 } }, parentArtifactEventId: art.event_id });
      await store.append('HumanDecision', run, `t${i}`, 'h', { decision: 'reject', reason: 'false-positive', parentFindingEventIds: [f.event_id] });
    }
    const proposals = generateProposals(store, 3); // l2MinDecisions=3 (test küçültmesi)
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({ kind: 'lint-rule', category: 'off-by-one' });
    const ev = await applyProposal(store, join(tmpdir(), 'l2stage'), proposals[0]);
    expect(ev.type).toBe('ProposalCreated');
    expect(existsSync(join(tmpdir(), 'l2stage', proposals[0].proposalId, 'PROPOSAL.md'))).toBe(true);
    expect(generateProposals(store, 3)).toHaveLength(0); // applied → listelenmez
  });
  it('l2MinDecisions altında → boş', async () => {
    const store = new VerdictStore(join(mkdtempSync(join(tmpdir(), 'l2b-')), 'e.jsonl'));
    expect(generateProposals(store, 100)).toHaveLength(0);
  });
});
