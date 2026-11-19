import { describe, it, expect } from 'vitest';
import { generateCandidates, confirmCandidate } from '../../src/learning/learn.js';
import { VerdictStore } from '../../src/store/store.js';
import { LessonMemory } from '../../src/memory/memory.js';
import { buildCli } from '../../src/shell/cli.js';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

async function seed(store: VerdictStore, category: string, count: number, reason: 'false-positive' | 'real-issue-accepted') {
  for (let i = 0; i < count; i++) {
    const art = await store.append('ArtifactProduced', 'r1', `t${category}${i}`, 'backend', { artifact: { diff: 'x', intent: 'i', rejectedAlternatives: [], testEvidence: '', files: [] }, parentTaskEventId: 'p' });
    const f = await store.append('FindingEmitted', 'r1', `t${category}${i}`, 'llm-reviewer', { finding: { id: `f${i}`, stage: 'llm-reviewer', category, severity: 'required', confidence: 0.8, evidence: { file: 'a.ts', line: 1 } }, parentArtifactEventId: art.event_id });
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
    const events = store.query({ type: 'LessonLearned' });
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
