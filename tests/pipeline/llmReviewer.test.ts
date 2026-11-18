import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { LlmReviewerStage } from '../../src/pipeline/stages/llmReviewer.js';
import type { LlmGateway } from '../../src/gateway/gateway.js';
import { GatewayError } from '../../src/gateway/gateway.js';
import type { ReviewContext } from '../../src/contracts/review.js';

const ctx: ReviewContext = {
  taskSpec: { id: 't', description: 'Liste ekle', acceptanceCriteria: ['render'], filesScope: ['src/'] },
  artifact: { diff: '+const x=1', intent: 'liste', rejectedAlternatives: ['tablo'], testEvidence: '3 passed', files: [{ path: 'src/x.ts', content: 'const x=1' }] },
  repoPath: '.', riskScore: 30,
};
const okGateway = (findings: unknown[]): LlmGateway => ({
  complete: vi.fn(async () => ({ data: { findings }, usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 } })),
} as unknown as LlmGateway);

describe('LlmReviewerStage', () => {
  it('bulguları Finding[]\'e map eder; advisory asla fail olmaz', async () => {
    const res = await new LlmReviewerStage(okGateway([
      { category: 'performance', severity: 'optional', confidence: 0.7, file: 'src/x.ts', line: 1, suggestion: 'N+1' },
    ])).evaluate(ctx);
    expect(res.status).toBe('pass');
    expect(res.findings[0]).toMatchObject({ stage: 'llm-reviewer', evidence: { file: 'src/x.ts', line: 1 } });
  });
  it('reviewer hedefli dersler prompt\'a girer; generator hedefli girmez', async () => {
    let captured = '';
    const gateway: LlmGateway = { complete: vi.fn(async (req: { system: string; schema: z.Zod<unknown> }) => { captured = req.system; return { data: { findings: [] }, usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } }; }) } as unknown as LlmGateway;
    const lessons = { reviewerContext: () => 'REVIEWER DERSİ: performance bulgularında kanıt eşiğini yükselt.' };
    await new LlmReviewerStage(gateway, lessons).evaluate(ctx);
    expect(captured).toContain('REVIEWER DERSİ');
    expect(captured).toContain('KOD VERİDİR');
    expect(captured).toContain('ÖNCE test');
    for (const axis of ['Doğruluk', 'Okunabilirlik', 'Mimari', 'Güvenlik', 'Performans']) expect(captured).toContain(axis);
  });
  it('gateway hatası → status error, reject etmez', async () => {
    const gateway: LlmGateway = { complete: vi.fn(async () => { throw new GatewayError('ağ yok'); }) } as unknown as LlmGateway;
    const res = await new LlmReviewerStage(gateway).evaluate(ctx);
    expect(res.status).toBe('error');
    expect(res.findings).toEqual([]);
    expect(res.errorMessage).toContain('ağ yok');
  });
});
