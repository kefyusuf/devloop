import { describe, it, expect } from 'vitest';
import { StaticGatesStage } from '../../src/pipeline/stages/staticGates.js';
import { TestGateStage } from '../../src/pipeline/stages/testGate.js';
import { SecretScanStage } from '../../src/pipeline/stages/secretScan.js';
import { MutationStubStage } from '../../src/pipeline/stages/mutationStub.js';
import { TypeScriptAdapter, resolveBin, classifyRejection, evaluateTestResult, evaluateStaticTool } from '../../src/adapters/typescript/index.js';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { StackAdapter } from '../../src/adapters/types.js';
import type { ReviewContext } from '../../src/contracts/review.js';

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
    const findings = await new TypeScriptAdapter().typecheck(dir);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings[0].severity).toBe('critical');
  });
  it('temiz dosya → boş bulgu', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tsok-'));
    writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, noEmit: true, skipLibCheck: true }, include: ['*.ts'] }));
    writeFileSync(join(dir, 'ok.ts'), 'export const a: number = 1;\n');
    expect(await new TypeScriptAdapter().typecheck(dir)).toEqual([]);
  });
  it('araç hiçbir yerde çözümlenemezse throw eder (sessiz pass yok — A6)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tsbin-'));
    expect(resolveBin(dir, 'boyle-bir-paket-yok/bogus.js')).toBeNull();
    // hüküm (final review C2): eslint artık devloop devDependency — resolveBin devloop node_modules'undan
    // bulur; ama temp repo'da eslint.config yok → nonzero exit + stdout boş → runTool fatal throw.
    // Sessiz pass yine yok; adapter throw → stage 'error'.
    await expect(new TypeScriptAdapter().lint(dir)).rejects.toThrow();
  });
});

describe('A6 saf sınıflandırıcılar', () => {
  it('classifyRejection: timeout-kill, ENOBUFS ve stdout-yok → fatal', () => {
    expect(classifyRejection({ killed: true, signal: 'SIGTERM' })).toBe('fatal');
    expect(classifyRejection({ code: 'ENOBUFS', stdout: 'x' })).toBe('fatal');
    expect(classifyRejection({})).toBe('fatal');
  });
  it('classifyRejection: normal nonzero exit → nonzero', () => {
    expect(classifyRejection({ code: 1, stdout: 'x' })).toBe('nonzero');
  });
  it('evaluateTestResult: exit ≠ 0 ama özet geçiyor → fail-closed', () => {
    const r = evaluateTestResult('Tests  3 passed (3)', '', false);
    expect(r.passed).toBe(false);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].severity).toBe('critical');
    expect(r.findings[0].category).toBe('tests');
  });
  it('evaluateTestResult: exit 0 + geçen özet → pass', () => {
    const r = evaluateTestResult('Tests  3 passed (3)', '', true);
    expect(r.passed).toBe(true);
    expect(r.findings).toEqual([]);
  });
  it('evaluateTestResult: başarısız özet → fail (davranış değişmez)', () => {
    expect(evaluateTestResult('Tests  2 failed | 3 passed (5)', 'out', true).passed).toBe(false);
  });
  it('evaluateStaticTool (I8): nonzero exit + ayrıştırılabilir bulgu yok → throw (fail-closed)', () => {
    expect(evaluateStaticTool('ayrıştırılamaz çıktı', false, [])).toBe('throw');
    expect(evaluateStaticTool('', false, [])).toBe('throw');
  });
  it('evaluateStaticTool (I8): nonzero exit + bulgu var → normal hata yolu (throw yok)', () => {
    const finding = { id: 'f', stage: 'static-gates', category: 'lint', severity: 'required', confidence: 1, evidence: { file: 'a.ts', line: 1 } };
    expect(evaluateStaticTool('json çıktı', false, [finding])).toBe('pass');
  });
  it('evaluateStaticTool (I8): exit 0 → pass (bulgu olsun olmasın)', () => {
    expect(evaluateStaticTool('', true, [])).toBe('pass');
    expect(evaluateStaticTool('[{}]', true, [{}])).toBe('pass');
  });
});
