import { describe, it, expect, vi } from 'vitest';
import { REVIEWER_DERSI_YOK, GENERATOR_PLAYBOOK_YOK } from '../../src/shell/sentinels.js';
import { composeReviewerLessons } from '../../src/shell/composeLessons.js';
import { LlmGeneratorBackend, readRepoContext } from '../../src/generator/generator.js';
import { loadAppliedPlaybooks } from '../../src/evolution/evolve.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LlmGateway } from '../../src/gateway/gateway.js';
import type { TaskSpec } from '../../src/contracts/schemas.js';

// R26a (faz 5 T2): sentineller TEK yerde (src/shell/sentinels.ts) — tüketici literalleri sabitten
// okur. Bu dosyanın iki görevi: (1) sabit DEĞERLERİNİ pin'lemek (literal burada; sentinels.ts'te
// değer değişirse test kırılır → değişiklik bilinçli olur), (2) DRIFT koruması — composeLessons
// ve generator davranışlarının sabitlerle senkron olduğunu sabiti import ederek doğrulamak
// (tüketici sabiti bırakıp başka literale dönerse test kırılır).

const task: TaskSpec = { id: 't1', description: 'toplama ekle', acceptanceCriteria: ['sum(2,3)===5'], filesScope: ['src/'] };
const captureGateway = (): { gw: LlmGateway; captured: () => string } => {
  let captured = '';
  const gw: LlmGateway = { complete: vi.fn(async (req: { user: string }) => {
    captured = req.user;
    return { data: { intent: 'i', rejectedAlternatives: [], testEvidence: 'e', files: [{ path: 'src/math.ts', content: 'export const sum=(a:number,b:number)=>a+b;' }] }, usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 } };
  }) } as unknown as LlmGateway;
  return { gw, captured: () => captured };
};

describe('shared sentinels (R26a — değer pin + drift koruması)', () => {
  it('değer pin: sabitler birebir bu literallere eşit (sentinels.ts tek kaynak)', () => {
    expect(REVIEWER_DERSI_YOK).toBe('Reviewer dersi yok.');
    expect(GENERATOR_PLAYBOOK_YOK).toBe('Generator playbook önerisi yok.');
  });

  it('drift koruması: composeReviewerLessons boş kompozisyon → REVIEWER_DERSI_YOK (sabit üzerinden)', () => {
    const out = composeReviewerLessons([
      { reviewerContext: () => REVIEWER_DERSI_YOK },
      { reviewerContext: () => 'Reviewer playbook önerisi yok.' },
      { reviewerContext: () => '' },
    ]).reviewerContext();
    expect(out).toBe(REVIEWER_DERSI_YOK);
  });

  it('drift koruması: loadAppliedPlaybooks boş dizin generatorContext → GENERATOR_PLAYBOOK_YOK (sabit üzerinden)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sent-gen-'));
    expect(loadAppliedPlaybooks(dir).generatorContext()).toBe(GENERATOR_PLAYBOOK_YOK);
  });

  it('drift koruması: generator exact-sentinel gating sabitle senkron — birebir sentinel blok düşürür, sentinel+ek not blok yaşatır (R18 hükmü)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sent-gpb-'));
    const base = readRepoContext(dir, ['src/']);
    // birebir sentinel → GENERATOR PLAYBOOK bloğu prompt'a girmez
    const { gw, captured } = captureGateway();
    await new LlmGeneratorBackend(gw, undefined, { generatorContext: () => GENERATOR_PLAYBOOK_YOK }).generate(task, { ...base, lessons: '', feedback: [] });
    expect(captured()).not.toContain('GENERATOR PLAYBOOK');
    // sentinel + ek metin (meşru insan-onaylı not) → blok DÜŞÜRÜLMEZ (exact-match kapı)
    const { gw: gw2, captured: captured2 } = captureGateway();
    const note = `${GENERATOR_PLAYBOOK_YOK} ek kural: isimler fiil olsun.`;
    await new LlmGeneratorBackend(gw2, undefined, { generatorContext: () => note }).generate(task, { ...base, lessons: '', feedback: [] });
    expect(captured2()).toContain('GENERATOR PLAYBOOK');
    expect(captured2()).toContain(note);
  });
});
