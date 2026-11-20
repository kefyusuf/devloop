import { z } from 'zod';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

const Weights = z.object({ diffSize: z.number(), testDiff: z.number(), scopePaths: z.number() });
const Llm = z.object({
  provider: z.enum(['anthropic', 'openai']).default('anthropic'),
  model: z.string(), fallbackModel: z.string(),
  maxTokens: z.number().int().positive(),
  backoffMs: z.number().min(0).default(500),
  costPer1kInput: z.number(), costPer1kOutput: z.number(),
  openai: z.object({
    model: z.string().default('gpt-4.1'), fallbackModel: z.string().default('gpt-4.1-mini'),
    maxTokens: z.number().int().positive().default(8192),
    costPer1kInput: z.number().min(0).default(0.0025), costPer1kOutput: z.number().min(0).default(0.01),
  }).default({ model: 'gpt-4.1', fallbackModel: 'gpt-4.1-mini', maxTokens: 8192, costPer1kInput: 0.0025, costPer1kOutput: 0.01 }),
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
  ensembleRiskThreshold: z.number().min(0).max(100).default(40),
  mutationScoreThreshold: z.number().min(0).max(100).default(60),
  mutationTimeoutMinutes: z.number().positive().default(15),
  l2MinDecisions: z.number().int().positive().default(100),
  l3MinGoldenTasks: z.number().int().positive().default(50),
  ciEnsembleRiskThreshold: z.number().min(0).max(100).default(20),
  mutationScopeLow: z.number().int().positive().default(5),
  mutationScopeHigh: z.number().int().positive().default(10),
  sandbox: z.object({
    mode: z.enum(['host', 'docker']).default('host'),
    image: z.string().default('node:20-bookworm-slim'),
  }).default({ mode: 'host', image: 'node:20-bookworm-slim' }),
  risk: z.object({ weights: Weights }),
  llm: Llm,
// R22 (faz 4 T3): çapraz değişken invariant — mutationScopeLow mutationScopeHigh'dan küçük olmalı
// (mutation stage low-risk'te Low, yüksek riskte High kullanır; eşit/ters aralık geçersiz politikadır).
}).superRefine((p, ctx) => {
  if (p.mutationScopeLow >= p.mutationScopeHigh) ctx.addIssue({ code: 'custom', message: "mutationScopeLow mutationScopeHigh'dan küçük olmalı" });
});
export type Policy = z.infer<typeof Policy>;

export interface DevloopConfig { apiKeyEnvVar: string }
// Final fix wave (review Minor #1): mutation-testing gate'tir (spec R3) — DEFAULT_POLICY'de de
// advisory'den gates'e taşındı; authorizedSkips unchanged (stryker.config.json'suz repo skip eder).
const DEFAULT_POLICY: Policy = {
  version: 1, gates: ['risk-triage', 'static-gates', 'tests', 'secret-scan', 'mutation-testing'],
  advisory: ['llm-ensemble'], authorizedSkips: ['mutation-testing'],
  maxFixTours: 3, maxIterations: 10, budgetUsd: 2.0, wallClockMinutes: 30,
  ensembleRiskThreshold: 40, mutationScoreThreshold: 60, mutationTimeoutMinutes: 15, l2MinDecisions: 100,
  l3MinGoldenTasks: 50, ciEnsembleRiskThreshold: 20, mutationScopeLow: 5, mutationScopeHigh: 10,
  sandbox: { mode: 'host', image: 'node:20-bookworm-slim' },
  risk: { weights: { diffSize: 0.3, testDiff: 0.5, scopePaths: 0.2 } },
  llm: { provider: 'anthropic', model: 'claude-sonnet-4-5', fallbackModel: 'claude-haiku-3-5',
    maxTokens: 8192, backoffMs: 500, costPer1kInput: 0.003, costPer1kOutput: 0.015,
    openai: { model: 'gpt-4.1', fallbackModel: 'gpt-4.1-mini', maxTokens: 8192, costPer1kInput: 0.0025, costPer1kOutput: 0.01 } },
};

export function loadConfig(dir: string): { config: DevloopConfig; policy: Policy } {
  const path = join(dir, 'policy.yaml');
  const policy = existsSync(path) ? Policy.parse(parse(readFileSync(path, 'utf8'))) : DEFAULT_POLICY;
  return { config: { apiKeyEnvVar: 'ANTHROPIC_API_KEY' }, policy };
}
