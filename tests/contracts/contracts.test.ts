import { describe, it, expect } from 'vitest';
import { FindingSchema, TaskSpecSchema, SEVERITY_ORDER } from '../../src/contracts/schemas.js';
import { DevloopEventSchema, makeEnvelope } from '../../src/contracts/events.js';

describe('kontrat şemaları', () => {
  it('Finding doğrular; geçersiz şiddet reddedilir', () => {
    const f = FindingSchema.parse({ id: 'f1', stage: 's', category: 'lint', severity: 'required', confidence: 1, evidence: { file: 'a.ts', line: 3 } });
    expect(f.suggestion).toBeUndefined();
    expect(() => FindingSchema.parse({ id: 'x', stage: 's', category: 'c', severity: 'mega', confidence: 1, evidence: { file: 'a' } })).toThrow();
  });
  it('severity sırası sabit', () => expect(SEVERITY_ORDER).toEqual(['critical', 'required', 'optional', 'nit', 'fyi']));
  it('TaskSpec kabul kriterleri zorunlu', () => expect(() => TaskSpecSchema.parse({ id: 't1', description: 'd' })).toThrow());
});

describe('event union (tip güvenli payload)', () => {
  it('TaskPicked payload alanları tipli erişilir', () => {
    const env = makeEnvelope('r1', 't1', 'o');
    const ev = DevloopEventSchema.parse({ ...env, type: 'TaskPicked', payload: { taskSpec: { id: 't1', description: 'd', acceptanceCriteria: ['ok'], filesScope: [] } } });
    expect(ev.payload.taskSpec.id).toBe('t1'); // payload: unknown DEĞİL — derleme zamanı erişim
  });
  it('PRCreated commitSha + diffDigest zorunlu', () => {
    const env = makeEnvelope('r', 't', 'o');
    const ok = DevloopEventSchema.safeParse({ ...env, type: 'PRCreated', payload: { url: null, title: 'x', commitSha: null, diffDigest: 'abc' } });
    const bad = DevloopEventSchema.safeParse({ ...env, type: 'PRCreated', payload: { url: null, title: 'x' } });
    expect(ok.success).toBe(true);
    expect(bad.success).toBe(false);
  });
  it('LessonLearned targetComponent zorunlu', () => {
    const env = makeEnvelope('r', 't', 'o');
    const bad = DevloopEventSchema.safeParse({ ...env, type: 'LessonLearned', payload: { lessonId: 'l1', rule: 'x', scope: 's', confidence: 0.5, status: 'active', parentDecisionEventIds: [] } });
    expect(bad.success).toBe(false);
  });
  it('TaskBlocked parse edilir', () => {
    const env = makeEnvelope('r', 't', 'o');
    const ev = DevloopEventSchema.parse({ ...env, type: 'TaskBlocked', payload: { reason: 'gate-fail: static-gates' } });
    expect(ev.payload.reason).toContain('gate-fail');
  });
  it('tolerant: idempotencyKey opsiyonel', () => {
    const env = makeEnvelope('r', 't', 'o', 'key-1');
    const ev = DevloopEventSchema.parse({ ...env, type: 'RunStarted', payload: { configSnapshot: {} } });
    expect(ev.idempotencyKey).toBe('key-1');
  });
});
