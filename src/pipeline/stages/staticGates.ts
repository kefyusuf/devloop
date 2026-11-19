import type { ReviewStage, ReviewContext, StageResult } from '../../contracts/review.js';
import type { StackAdapter } from '../../adapters/types.js';

export class StaticGatesStage implements ReviewStage {
  readonly name = 'static-gates';
  readonly kind = 'gate' as const;
  constructor(private readonly adapter: StackAdapter) {}

  async evaluate(ctx: ReviewContext): Promise<StageResult> {
    const t0 = Date.now();
    try {
      const findings = [...(await this.adapter.lint(ctx.repoPath)), ...(await this.adapter.typecheck(ctx.repoPath))]
        .map((f) => ({ ...f, stage: this.name }));
      return { status: findings.length === 0 ? 'pass' : 'fail', findings, durationMs: Date.now() - t0 };
    } catch (e) {
      return { status: 'error', findings: [], durationMs: Date.now() - t0, errorMessage: String(e) }; // fail-closed: sessiz pass yok
    }
  }
}
