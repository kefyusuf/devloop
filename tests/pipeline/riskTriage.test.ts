import { describe, it, expect } from 'vitest';
import { RiskTriageStage, computeRisk } from '../../src/pipeline/stages/riskTriage.js';
import { loadConfig } from '../../src/config/config.js';
import type { Artifact } from '../../src/contracts/schemas.js';
// hüküm: tsconfig.test kapsamı (R26h) — riskSignals stage tarafından ctx'e yazılır
import type { ReviewContext } from '../../src/contracts/review.js';

const policy = loadConfig(process.cwd()).policy;
const artifact = (files: Array<{ path: string; content: string }>): Artifact =>
  ({ diff: files.map((f) => f.path).join('\n'), intent: 'i', rejectedAlternatives: [], testEvidence: '', files });

describe('computeRisk', () => {
  it('küçük diff düşük skor', () => {
    const { score } = computeRisk(artifact([{ path: 'src/a.ts', content: 'x'.repeat(50) }]), policy);
    expect(score).toBeLessThan(40);
  });
  it('test değişimi + büyük diff yüksek skor', () => {
    const { score, signals } = computeRisk(artifact([
      { path: 'src/big.ts', content: 'x'.repeat(8000) },
      { path: 'tests/big.test.ts', content: 'y' },
    ]), policy);
    expect(signals.testDiff).toBe(1);
    expect(score).toBeGreaterThanOrEqual(60);
  });
});

describe('RiskTriageStage.evaluate', () => {
  it('ctx.riskScore/riskSignals doldurur; test-diff required bulgu üretir', async () => {
    const stage = new RiskTriageStage(policy);
    // hüküm: tsconfig.test kapsamı — literal tip riskSignals özelliğini taşımaz; ReviewContext anotasyonu
    const ctx: ReviewContext = { taskSpec: { id: 't', description: 'd', acceptanceCriteria: ['a'], filesScope: [] },
      artifact: artifact([{ path: 'tests/x.test.ts', content: 'x' }]), repoPath: '.', riskScore: 0 };
    const res = await stage.evaluate(ctx);
    expect(res.status).toBe('pass');
    // Controller ruling 2026-11-18: brief asserted >= 60; test-diff sinyali tek başına ağırlık 0.5 ile 50 verir (plan metni aritmetik hatası).
    expect(ctx.riskScore).toBeGreaterThanOrEqual(50);
    expect(ctx.riskSignals?.testDiff).toBe(1);
    expect(res.findings.some((f) => f.category === 'test-diff' && f.severity === 'required')).toBe(true);
  });
});
