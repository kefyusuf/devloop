import { describe, it, expect } from 'vitest';
import { loadConfig } from '../../src/config/config.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const POLICY = `version: 1
gates: [static-gates, tests]
advisory: [llm-ensemble]   # hüküm: eski 'llm-reviewer' policy adı T4 ile llm-ensemble oldu (assembly R2)
authorizedSkips: []
maxFixTours: 2
maxIterations: 5
budgetUsd: 1.0
wallClockMinutes: 10
risk: { weights: { diffSize: 0.3, testDiff: 0.5, scopePaths: 0.2 } }
llm: { provider: anthropic, model: m1, fallbackModel: m2, maxTokens: 1024, costPer1kInput: 0.001, costPer1kOutput: 0.002 }
`;

function tmpDir(): string {
  const dir = join(tmpdir(), `devloop-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'policy.yaml'), POLICY);
  return dir;
}

describe('loadConfig', () => {
  it('policy.yaml yükler; authorizedSkips dahil', () => {
    const { policy } = loadConfig(tmpDir());
    expect(policy.gates).toEqual(['static-gates', 'tests']);
    expect(policy.authorizedSkips).toEqual([]);
    expect(policy.maxFixTours).toBe(2);
  });
  it('geçersiz policy reddedilir (zod)', () => {
    const dir = tmpDir();
    writeFileSync(join(dir, 'policy.yaml'), 'version: "duz-metin"\n');
    expect(() => loadConfig(dir)).toThrow();
  });
  it('eksik policy.yaml → varsayılanlar (mutation-testing yetkili skip)', () => {
    const dir = join(tmpdir(), `devloop-empty-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const { policy } = loadConfig(dir);
    expect(policy.maxFixTours).toBe(3);
    expect(policy.authorizedSkips).toEqual(['mutation-testing']);
  });
});

const POLICY3 = `version: 1
gates: [static-gates, tests]
advisory: [llm-ensemble]
authorizedSkips: []
maxFixTours: 2
maxIterations: 5
budgetUsd: 1.0
wallClockMinutes: 10
risk: { weights: { diffSize: 0.3, testDiff: 0.5, scopePaths: 0.2 } }
llm: { provider: anthropic, model: m1, fallbackModel: m2, maxTokens: 1024, costPer1kInput: 0.001, costPer1kOutput: 0.002 }
`;

function tmpDir3(): string {
  const dir = join(tmpdir(), `devloop-test3-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'policy.yaml'), POLICY3);
  return dir;
}

describe('faz 3 policy alanları', () => {
  it('varsayılanlar: l3MinGoldenTasks=50, ciEnsembleRiskThreshold=20, mutationScope 5/10, sandbox host, openai blok', () => {
    const { policy } = loadConfig(join(tmpdir(), `devloop-p3-${Date.now()}`));
    expect(policy.l3MinGoldenTasks).toBe(50);
    expect(policy.ciEnsembleRiskThreshold).toBe(20);
    expect(policy.mutationScopeLow).toBe(5);
    expect(policy.mutationScopeHigh).toBe(10);
    expect(policy.sandbox.mode).toBe('host');
    expect(policy.sandbox.image).toBe('node:20-bookworm-slim');
    expect(policy.llm.provider).toBe('anthropic');
    expect(policy.llm.openai.model).toBe('gpt-4.1');
    expect(policy.llm.openai.costPer1kOutput).toBe(0.01);
  });
  it('provider openai kabul edilir; sandbox.mode docker kabul edilir', () => {
    const dir = tmpDir3();
    writeFileSync(join(dir, 'policy.yaml'), [
      'version: 1', 'gates: [static-gates]', 'advisory: []', 'authorizedSkips: []',
      'maxFixTours: 2', 'maxIterations: 5', 'budgetUsd: 1.0', 'wallClockMinutes: 10',
      'risk: { weights: { diffSize: 0.3, testDiff: 0.5, scopePaths: 0.2 } }',
      'llm: { provider: openai, model: m, fallbackModel: m2, maxTokens: 100, costPer1kInput: 0, costPer1kOutput: 0,',
      '      openai: { model: gpt-x, fallbackModel: gpt-mini, maxTokens: 100, costPer1kInput: 0, costPer1kOutput: 0 } }',
      'sandbox: { mode: docker, image: node:20 }',
    ].join('\n'));
    const { policy } = loadConfig(dir);
    expect(policy.llm.provider).toBe('openai');
    expect(policy.sandbox.mode).toBe('docker');
  });
});

describe('faz 2 policy alanları', () => {
  it('varsayılanlar: ensembleRiskThreshold=40, mutationScoreThreshold=60, mutationTimeoutMinutes=15, backoffMs=500, l2MinDecisions=100', () => {
    const { policy } = loadConfig(join(tmpdir(), `devloop-p2-${Date.now()}`));
    expect(policy.ensembleRiskThreshold).toBe(40);
    expect(policy.mutationScoreThreshold).toBe(60);
    expect(policy.mutationTimeoutMinutes).toBe(15);
    expect(policy.llm.backoffMs).toBe(500);
    expect(policy.l2MinDecisions).toBe(100);
    // hüküm: final fix wave (review Minor #1) — mutation-testing gate'tir (spec R3); DEFAULT_POLICY'de
    // advisory'den gates'e taşındı. authorizedSkips unchanged → config-less/stryker'sız repo skip eder.
    expect(policy.gates).toEqual(['risk-triage', 'static-gates', 'tests', 'secret-scan', 'mutation-testing']);
    expect(policy.advisory).toEqual(['llm-ensemble']);
    expect(policy.authorizedSkips).toEqual(['mutation-testing']);
  });
});
