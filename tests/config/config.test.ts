import { describe, it, expect } from 'vitest';
import { loadConfig } from '../../src/config/config.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const POLICY = `version: 1
gates: [static-gates, tests]
advisory: [llm-reviewer]
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
