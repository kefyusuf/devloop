import type { ReviewStage, ReviewContext, StageResult } from '../../contracts/review.js';
import type { Artifact, Finding } from '../../contracts/schemas.js';
import { randomUUID } from 'node:crypto';
import type { Policy } from '../../config/config.js';

const TEST_FILE_RE = /(^|\/)(tests?|__tests__)\/|\.test\.|\.spec\./;

export function computeRisk(artifact: Artifact, policy: Policy): { score: number; signals: Record<string, number> } {
  const diffLines = artifact.diff.split('\n').length;
  const diffSize = Math.min(1, diffLines / 500);
  const testDiff = artifact.files.some((f) => TEST_FILE_RE.test(f.path)) ? 1 : 0;
  const scopePaths = artifact.files.some((f) => /(^|\/)(src|lib)\//.test(f.path)) ? 1 : 0;
  const w = policy.risk.weights;
  const score = Math.round(100 * Math.min(1, w.diffSize * diffSize + w.testDiff * testDiff + w.scopePaths * scopePaths));
  return { score, signals: { diffSize: Number(diffSize.toFixed(3)), testDiff, scopePaths } };
}

export class RiskTriageStage implements ReviewStage {
  readonly name = 'risk-triage';
  readonly kind = 'gate' as const;
  constructor(private readonly policy: Policy) {}

  async evaluate(ctx: ReviewContext): Promise<StageResult> {
    const t0 = Date.now();
    const { score, signals } = computeRisk(ctx.artifact, this.policy);
    ctx.riskScore = score;
    ctx.riskSignals = signals;
    const findings: Finding[] = signals.testDiff === 1 ? [{
      id: randomUUID(), stage: this.name, category: 'test-diff', severity: 'required', confidence: 1,
      evidence: { file: ctx.artifact.files.find((f) => TEST_FILE_RE.test(f.path))!.path },
      suggestion: 'Test değişiklikleri önce review edilmeli; assert değişimleri kırık davranışı gizleyebilir.',
      corroborated: false,
    }] : [];
    return { status: 'pass', findings, durationMs: Date.now() - t0 };
  }
}
