import type { ReviewStage, ReviewContext, StageResult } from '../../contracts/review.js';

/** v1 stub (spec §5.1 #4). Faz 2'de Stryker bağlanır. Skip yetkisi policy.authorizedSkips'ten gelir. */
export class MutationStubStage implements ReviewStage {
  readonly name = 'mutation-testing';
  readonly kind = 'gate' as const;
  async evaluate(_ctx: ReviewContext): Promise<StageResult> {
    return { status: 'skipped', findings: [], durationMs: 0 };
  }
}
