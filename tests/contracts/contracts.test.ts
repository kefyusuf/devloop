import { describe, it, expect } from 'vitest';
import { FindingSchema, TaskSpecSchema, SEVERITY_ORDER } from '../../src/contracts/schemas.js';
import { DevloopEventSchema, makeEnvelope } from '../../src/contracts/events.js';
// hüküm: tsconfig.test kapsamı (R26h) — DevloopEventSchema.parse union döndürür; Envelope daraltması
import { Envelope } from '../helpers/events.js';

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
    // hüküm: tsconfig.test kapsamı — parse çıktısı union; testin kurduğu tip Envelope ile daraltılır
    const ev = DevloopEventSchema.parse({ ...env, type: 'TaskPicked', payload: { taskSpec: { id: 't1', description: 'd', acceptanceCriteria: ['ok'], filesScope: [] } } }) as Envelope<'TaskPicked'>;
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
    // hüküm: tsconfig.test kapsamı — parse çıktısı union; Envelope daraltması
    const ev = DevloopEventSchema.parse({ ...env, type: 'TaskBlocked', payload: { reason: 'gate-fail: static-gates' } }) as Envelope<'TaskBlocked'>;
    expect(ev.payload.reason).toContain('gate-fail');
  });
  it('StageVerdict parentArtifactEventId zorunlu (I6); errorMessage opsiyonel', () => {
    const env = makeEnvelope('r', 't', 'o');
    // I6: artifact parent'sız verdict artık şemaya aykırı — kanıt zinciri binding zorunlu
    const bad = DevloopEventSchema.safeParse({ ...env, type: 'StageVerdict', payload: { stage: 'static-gates', status: 'pass', durationMs: 1 } });
    const ok = DevloopEventSchema.safeParse({ ...env, type: 'StageVerdict', payload: { stage: 'static-gates', status: 'error', durationMs: 2, parentArtifactEventId: 'art-1', errorMessage: 'eslint patladı' } });
    const minimal = DevloopEventSchema.safeParse({ ...env, type: 'StageVerdict', payload: { stage: 'static-gates', status: 'pass', durationMs: 1, parentArtifactEventId: 'art-1' } });
    expect(bad.success).toBe(false);
    expect(ok.success).toBe(true);
    expect(minimal.success).toBe(true);
  });
  it('tolerant: idempotencyKey opsiyonel', () => {
    const env = makeEnvelope('r', 't', 'o', 'key-1');
    const ev = DevloopEventSchema.parse({ ...env, type: 'RunStarted', payload: { configSnapshot: {} } });
    expect(ev.idempotencyKey).toBe('key-1');
  });
});

describe('faz 3 kontratları', () => {
  it('evidence.mutantId opsiyonel taşınır', () => {
    const f = FindingSchema.parse({ id: 'f', stage: 'mutation-testing', category: 'mutation', severity: 'critical', confidence: 1, evidence: { file: 'a.ts', line: 3, mutantId: 'm5' } });
    expect(f.evidence.mutantId).toBe('m5');
  });
  it('EvalRun gerçek payload doğrulanır', () => {
    const env = makeEnvelope('r', '-', 'eval');
    // hüküm: tsconfig.test kapsamı — parse çıktısı union; Envelope daraltması (EvalRun)
    const ev = DevloopEventSchema.parse({ ...env, type: 'EvalRun', payload: {
      evalId: 'e1', goldenCount: 3, passed: 2, failed: 1, score: 66.7,
      perTask: [{ goldenId: 'g1', pass: true, reasons: [] }],
      configSnapshot: { mode: 'production' },
    } }) as Envelope<'EvalRun'>;
    expect(ev.payload.comparedTo).toBeUndefined();
    // R15 fix round 1: invalid alanı default'lu — alansız (eski store satırları) payload okunur kalır
    // ve boş listeye düşer; alanlı payload birebir taşınır.
    expect(ev.payload.invalid).toEqual([]);
    // hüküm: tsconfig.test kapsamı — parse çıktısı union; Envelope daraltması (EvalRun)
    const ev2 = DevloopEventSchema.parse({ ...env, event_id: 'e2', type: 'EvalRun', payload: {
      evalId: 'e2', goldenCount: 1, passed: 1, failed: 0, score: 100, invalid: ['bad.task.json'],
      perTask: [], configSnapshot: { mode: 'production' },
    } }) as Envelope<'EvalRun'>;
    expect(ev2.payload.invalid).toEqual(['bad.task.json']);
  });
});

describe('faz 2 kontratları', () => {
  it('Finding.corroborated default false', () => {
    const f = FindingSchema.parse({ id: 'f', stage: 's', category: 'c', severity: 'nit', confidence: 1, evidence: { file: 'a' } });
    expect(f.corroborated).toBe(false);
  });
  it('ProposalCreated event doğrulanır; kind enum dışı reddedilir', () => {
    const env = makeEnvelope('r', 't', 'o');
    const ok = DevloopEventSchema.safeParse({ ...env, type: 'ProposalCreated', payload: { proposalId: 'p1', kind: 'lint-rule', category: 'lint', title: 't', content: { rule: 'x' }, parentDecisionEventIds: [] } });
    const bad = DevloopEventSchema.safeParse({ ...env, type: 'ProposalCreated', payload: { proposalId: 'p1', kind: 'sihirli', category: 'lint', title: 't', content: {}, parentDecisionEventIds: [] } });
    expect(ok.success).toBe(true);
    expect(bad.success).toBe(false);
  });
});

// R22 (faz 4 T3): EvalRun çapraz değişken invariant — passed + failed goldenCount ile toplamı
// eşleşmeli (perTask.length = goldenCount sözleşmesinin şema düzeyinde zorlanması).
describe('EvalRun invariant (R22 superRefine)', () => {
  const env = () => makeEnvelope('r', 't', 'o');
  it('passed + failed === goldenCount → kabul', () => {
    const ok = DevloopEventSchema.safeParse({ ...env(), type: 'EvalRun', payload: {
      evalId: 'e1', goldenCount: 2, passed: 1, failed: 1, score: 50, invalid: [], perTask: [], configSnapshot: {},
    } });
    expect(ok.success).toBe(true);
  });
  it('passed + failed !== goldenCount → reddedilir (custom mesaj)', () => {
    const bad = DevloopEventSchema.safeParse({ ...env(), type: 'EvalRun', payload: {
      evalId: 'e1', goldenCount: 3, passed: 1, failed: 1, score: 50, invalid: [], perTask: [], configSnapshot: {},
    } });
    expect(bad.success).toBe(false);
    if (!bad.success) expect(bad.error.issues[0].message).toBe('passed + failed goldenCount ile toplamı eşleşmeli');
  });
});
