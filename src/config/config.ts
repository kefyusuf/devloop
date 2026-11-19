import { z } from 'zod';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

const Weights = z.object({ diffSize: z.number(), testDiff: z.number(), scopePaths: z.number() });
const Llm = z.object({
  provider: z.literal('anthropic'), model: z.string(), fallbackModel: z.string(),
  maxTokens: z.number().int().positive(),
  costPer1kInput: z.number(), costPer1kOutput: z.number(),
});
const Policy = z.object({
  version: z.number().int(),
  gates: z.array(z.string()),
  advisory: z.array(z.string()),
  authorizedSkips: z.array(z.string()).default(['mutation-testing']),
  maxFixTours: z.number().int().positive(),
  maxIterations: z.number().int().positive(),
  budgetUsd: z.number().positive(),
  wallClockMinutes: z.number().positive(),
  risk: z.object({ weights: Weights }),
  llm: Llm,
});
export type Policy = z.infer<typeof Policy>;

export interface DevloopConfig { apiKeyEnvVar: string }
const DEFAULT_POLICY: Policy = {
  version: 1, gates: ['risk-triage', 'static-gates', 'tests', 'secret-scan'],
  advisory: ['llm-reviewer', 'mutation-testing'], authorizedSkips: ['mutation-testing'],
  maxFixTours: 3, maxIterations: 10, budgetUsd: 2.0, wallClockMinutes: 30,
  risk: { weights: { diffSize: 0.3, testDiff: 0.5, scopePaths: 0.2 } },
  llm: { provider: 'anthropic', model: 'claude-sonnet-4-5', fallbackModel: 'claude-haiku-3-5',
    maxTokens: 8192, costPer1kInput: 0.003, costPer1kOutput: 0.015 },
};

export function loadConfig(dir: string): { config: DevloopConfig; policy: Policy } {
  const path = join(dir, 'policy.yaml');
  const policy = existsSync(path) ? Policy.parse(parse(readFileSync(path, 'utf8'))) : DEFAULT_POLICY;
  return { config: { apiKeyEnvVar: 'ANTHROPIC_API_KEY' }, policy };
}
