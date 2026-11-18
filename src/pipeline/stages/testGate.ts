import type { ReviewStage, ReviewContext, StageResult } from '../../contracts/review.js';
import type { StackAdapter } from '../../adapters/types.js';

export class TestGateStage implements ReviewStage {
  readonly name = 'tests';
  readonly kind = 'gate' as const;
  constructor(private readonly adapter: StackAdapter) {}

  async evaluate(ctx: ReviewContext): Promise<StageResult> {
    const t0 = Date.now();
    try {
      const res = await this.adapter.runTests(ctx.repoPath);
      return { status: res.passed ? 'pass' : 'fail', findings: res.findings, durationMs: Date.now() - t0 };
    } catch (e) {
      return { status: 'error', findings: [], durationMs: Date.now() - t0, errorMessage: String(e) };
    }
  }
}
