import { describe, it, expect } from 'vitest';
import { StaticGatesStage } from '../../src/pipeline/stages/staticGates.js';
import { TestGateStage } from '../../src/pipeline/stages/testGate.js';
import { SecretScanStage } from '../../src/pipeline/stages/secretScan.js';
import { MutationStubStage } from '../../src/pipeline/stages/mutationStub.js';
import { TypeScriptAdapter } from '../../src/adapters/typescript/index.js';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import type { StackAdapter } from '../../src/adapters/types.js';
import type { ReviewContext } from '../../src/contracts/review.js';

// Controller-ruled: gerçek tsc entegrasyon testlerinde npx'in OS-temp bağımlılığı aşıılır —
// doğrudan node.exe + devloop'un kendi node_modules'undaki typescript girdisi kullanılır.
const realTscOverride = {
  typecheck: {
    cmd: process.execPath,
    args: [createRequire(import.meta.url).resolve('typescript/bin/tsc'), '--noEmit', '--pretty', 'false'],
  },
} as const;

const ctx = (diff = '', files: Array<{ path: string; content: string }> = []): ReviewContext => ({
  taskSpec: { id: 't', description: 'd', acceptanceCriteria: ['a'], filesScope: [] },
  artifact: { diff, intent: 'i', rejectedAlternatives: [], testEvidence: '', files }, repoPath: '.', riskScore: 10,
});

const failingAdapter: StackAdapter = {
  id: 'fake',
  async lint() { return [{ id: 'l1', stage: 's', category: 'lint', severity: 'required', confidence: 1, evidence: { file: 'a.ts', line: 1 } }]; },
  async typecheck() { return [{ id: 't1', stage: 's', category: 'typecheck', severity: 'critical', confidence: 1, evidence: { file: 'b.ts' } }]; },
  async runTests() { return { passed: false, output: 'Tests  1 failed | 2 passed (3)', findings: [{ id: 'x', stage: 'tests', category: 'tests', severity: 'critical', confidence: 1, evidence: { file: '(test-output)' } }] }; },
};
const crashingAdapter: StackAdapter = {
  id: 'crash',
  async lint() { throw new Error('eslint spawn patladı'); },
  async typecheck() { return []; },
  async runTests() { return { passed: true, output: '', findings: [] }; },
};

describe('deterministik stage\'ler', () => {
  it('static-gates: bulgu varsa fail', async () => {
    const r = await new StaticGatesStage(failingAdapter).evaluate(ctx());
    expect(r.status).toBe('fail');
    expect(r.findings).toHaveLength(2);
  });
  it('static-gates: adapter crash → status ERROR (sessiz pass yok)', async () => {
    const r = await new StaticGatesStage(crashingAdapter).evaluate(ctx());
    expect(r.status).toBe('error');
    expect(r.errorMessage).toBeDefined();
    expect(r.findings).toEqual([]);
  });
  it('tests: geçemeyen test → fail', async () => {
    expect((await new TestGateStage(failingAdapter).evaluate(ctx())).status).toBe('fail');
  });
  it('secret-scan: geçerli regex, AWS key → critical fail', async () => {
    const r = await new SecretScanStage().evaluate(ctx('const k = "AKIAIOSFODNN7EXAMPLE";', [{ path: 'src/k.ts', content: 'x' }]));
    expect(r.status).toBe('fail');
    expect(r.findings[0].severity).toBe('critical');
  });
  it('secret-scan: lowercase secret (i flag ile) yakalanır', async () => {
    const r = await new SecretScanStage().evaluate(ctx('api_key = "abcdef1234567890abcdef12"', [{ path: 'src/k.ts', content: 'x' }]));
    expect(r.status).toBe('fail');
  });
  it('mutation stub: skipped', async () => {
    expect((await new MutationStubStage().evaluate(ctx())).status).toBe('skipped');
  });
});

describe('TypeScriptAdapter gerçek koşum (gerçek araç zinciri — tsc)', () => {
  it('bilinçli tip hatasını critical bulguya çevirir', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tsad-'));
    writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, noEmit: true, skipLibCheck: true }, include: ['*.ts'] }));
    writeFileSync(join(dir, 'bad.ts'), 'const n: number = "yazı";\n');
    const findings = await new TypeScriptAdapter(realTscOverride).typecheck(dir);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings[0].severity).toBe('critical');
  });
  it('temiz dosya → boş bulgu', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tsok-'));
    writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, noEmit: true, skipLibCheck: true }, include: ['*.ts'] }));
    writeFileSync(join(dir, 'ok.ts'), 'export const a: number = 1;\n');
    expect(await new TypeScriptAdapter(realTscOverride).typecheck(dir)).toEqual([]);
  });
});
