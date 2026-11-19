import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ReviewStage, ReviewContext, StageResult } from '../../contracts/review.js';
import type { Finding } from '../../contracts/schemas.js';
import type { Policy } from '../../config/config.js';
import { resolveBin, runTool } from '../../adapters/typescript/index.js';

export function parseMutationScore(stdout: string): number | null {
  const m = /mutation score\D*(\d+(?:\.\d+)?)/i.exec(stdout);
  return m ? Number(m[1]) : null;
}

export class MutationStage implements ReviewStage {
  readonly name = 'mutation-testing';
  readonly kind = 'gate' as const;
  constructor(private readonly policy: Policy) {}

  async evaluate(ctx: ReviewContext): Promise<StageResult> {
    const t0 = Date.now();
    if (!existsSync(join(ctx.repoPath, 'stryker.config.json'))) {
      return { status: 'skipped', findings: [], durationMs: Date.now() - t0 };
    }
    const bin = resolveBin(ctx.repoPath, '@stryker-mutator/core/bin/stryker.js');
    if (!bin) throw new Error('stryker çözümlenemedi (fail-closed)');
    const mutate = ctx.artifact.files.slice(0, 10).map((f) => f.path).join(',');
    const res = await runTool(ctx.repoPath, bin, ['run', '--mutate', mutate, '--concurrency', '1'], this.policy.mutationTimeoutMinutes * 60_000);
    if (res.killed || res.truncated) throw new Error('stryker timeout/çıktı taşması — fail-closed');
    const score = parseMutationScore(res.stdout);
    if (score === null) throw new Error(`stryker skorları ayrıştırılamadı (stderr: ${res.stderr.slice(0, 300)})`);
    const findings: Finding[] = [];
    if (score < this.policy.mutationScoreThreshold) {
      findings.push({ id: randomUUID(), stage: this.name, category: 'mutation', severity: 'critical', confidence: 1,
        evidence: { file: '(mutation-report)' }, corroborated: false,
        suggestion: `Mutation skoru ${score}% < ${this.policy.mutationScoreThreshold}% — testler mutantları öldürmüyor.` });
    }
    return { status: findings.length === 0 ? 'pass' : 'fail', findings, durationMs: Date.now() - t0 };
  }
}
