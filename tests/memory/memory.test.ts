import { describe, it, expect } from 'vitest';
import { LessonMemory } from '../../src/memory/memory.js';
import { VerdictStore } from '../../src/store/store.js';
import { readFileSync, existsSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { TaskSpec } from '../../src/contracts/schemas.js';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'mem-'));
  return { store: new VerdictStore(join(dir, 'events.jsonl')), file: join(dir, 'lessons.md') };
}
const task: TaskSpec = { id: 't', description: 'HTTP client yaz', acceptanceCriteria: ['fetch kullanır'], filesScope: [] };

describe('LessonMemory (targetComponent ayrımı)', () => {
  it('generator dersi contextFor\'a, reviewer dersi reviewerContext\'e gider; çapraz sızma yok', async () => {
    const { store, file } = setup();
    await store.append('LessonLearned', 'r1', 't1', 'learning', { lessonId: 'l1', rule: 'HTTP çağrılarında timeout set edilmeli.', scope: 'src/net', confidence: 0.8, status: 'active', targetComponent: 'generator', parentDecisionEventIds: [] });
    await store.append('LessonLearned', 'r1', 't1', 'learning', { lessonId: 'l2', rule: 'performance bulgularında kanıt eşiğini yükselt.', scope: 'review-rubric', confidence: 0.7, status: 'active', targetComponent: 'reviewer', parentDecisionEventIds: [] });
    const mem = new LessonMemory(store, file);
    expect(mem.contextFor(task)).toContain('timeout');
    expect(mem.contextFor(task)).not.toContain('eşiğini');
    expect(mem.reviewerContext()).toContain('eşiğini');
    expect(mem.reviewerContext()).not.toContain('timeout');
  });
  it('render: aktif dersler markdown; retired düşer', async () => {
    const { store, file } = setup();
    await store.append('LessonLearned', 'r1', 't1', 'learning', { lessonId: 'l1', rule: 'eski kural', scope: '*', confidence: 0.9, status: 'active', targetComponent: 'generator', parentDecisionEventIds: [] });
    const mem = new LessonMemory(store, file);
    mem.render();
    expect(readFileSync(file, 'utf8')).toContain('eski kural');
    await mem.markRetired('l1', ['d1']);
    mem.render();
    expect(readFileSync(file, 'utf8')).not.toContain('eski kural');
    expect(existsSync(file)).toBe(true);
  });
});
