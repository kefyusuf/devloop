import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import * as adapter from '../../src/adapters/typescript/index.js';
import { MutationStage, parseMutationScore } from '../../src/pipeline/stages/mutationStage.js';
import { ReviewPipeline } from '../../src/pipeline/pipeline.js';
import { loadConfig } from '../../src/config/config.js';
import type { ReviewContext } from '../../src/contracts/review.js';

// Adapter modülü mock'lanır: birim testlerde resolveBin/runTool kontrol edilir; mock ayarlanmadığında
// GERÇEK implementasyona geçilir (gerçek Stryker koşum testi bununla çalışır). Orijinal fonksiyonlar
// fabrikada BİR KEZ yakalanır — passthrough mock'un kendisine değil, gerçeğe devretmesi için.
// vi.hoisted: vi.mock fabrikası dosyanın en üstüne çekilir; holder fabrikadan ÖNCE hazır olmalı.
type ActualImpls = { resolveBin?: (repoPath: string, subpath: string) => string | null; runTool?: (...args: unknown[]) => unknown };
const actualImpls = vi.hoisted(() => ({}) as ActualImpls);
vi.mock('../../src/adapters/typescript/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/adapters/typescript/index.js')>();
  actualImpls.resolveBin = actual.resolveBin;
  actualImpls.runTool = actual.runTool as (...args: unknown[]) => unknown;
  return {
    ...actual,
    resolveBin: vi.fn((repoPath: string, subpath: string) => actualImpls.resolveBin!(repoPath, subpath)),
    runTool: vi.fn(((...args: Parameters<typeof actual.runTool>) => actualImpls.runTool!(...args)) as typeof actual.runTool),
  };
});

const resolveBinMock = vi.mocked(adapter.resolveBin);
const runToolMock = vi.mocked(adapter.runTool);

const policy = () => loadConfig(mkdtempSync(join(tmpdir(), 'pol-'))).policy; // DEFAULT_POLICY: eşik 60, timeout 15dk

const mkCtx = (repoPath: string, files: Array<{ path: string; content: string }> = []): ReviewContext => ({
  taskSpec: { id: 't', description: 'd', acceptanceCriteria: ['a'], filesScope: [] },
  artifact: { diff: '', intent: 'i', rejectedAlternatives: [], testEvidence: '', files },
  repoPath, riskScore: 10,
});

/** stryker.config.json'I olan (ama stryker kurulu olmayan) minimal fixture repo. */
const repoWithConfig = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'mut-'));
  writeFileSync(join(dir, 'stryker.config.json'), JSON.stringify({ testRunner: 'vitest' }));
  return dir;
};

const toolOut = (stdout: string) => ({ stdout, stderr: '', exitedCleanly: true, killed: false, truncated: false });

beforeEach(() => {
  // Passthrough'i her test başında tazele: Once-mock kalıntıları testler arası sızmaz.
  // Devretme yakalanan GERÇEK implementasyona — mock'a değil (sonsuz özyineleme olmasın).
  resolveBinMock.mockImplementation((repoPath: string, subpath: string) => actualImpls.resolveBin!(repoPath, subpath));
  runToolMock.mockImplementation(((...args: unknown[]) => actualImpls.runTool!(...args)) as typeof adapter.runTool);
});

afterEach(() => {
  vi.mocked(adapter.resolveBin).mockReset();
  vi.mocked(adapter.runTool).mockReset();
});

describe('MutationStage birim', () => {
  it('stryker.config.json yok → skipped (bulgu yok)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mut-'));
    const r = await new MutationStage(policy()).evaluate(mkCtx(dir));
    expect(r.status).toBe('skipped');
    expect(r.findings).toEqual([]);
  });

  it('skor < eşik → fail + critical mutation bulgusu', async () => {
    const dir = repoWithConfig();
    resolveBinMock.mockReturnValueOnce('C:/fake/node_modules/@stryker-mutator/core/bin/stryker.js');
    runToolMock.mockResolvedValueOnce(toolOut('Ran 3 tests\n% Mutation score tablosu:\nAll files |  25.00 |   25.00 |'));
    const r = await new MutationStage(policy()).evaluate(mkCtx(dir, [{ path: 'src/a.ts', content: 'x' }]));
    expect(r.status).toBe('fail');
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].severity).toBe('critical');
    expect(r.findings[0].category).toBe('mutation');
    expect(r.findings[0].evidence.file).toBe('(mutation-report)');
    expect(r.findings[0].corroborated).toBe(false);
    expect(r.findings[0].suggestion).toContain('25');
  });

  it('skor ≥ eşik → pass (bulgu yok)', async () => {
    const dir = repoWithConfig();
    resolveBinMock.mockReturnValueOnce('C:/fake/bin/stryker.js');
    runToolMock.mockResolvedValueOnce(toolOut('mutation score 80.00%\nAll files |  80.00 |   80.00 |'));
    const r = await new MutationStage(policy()).evaluate(mkCtx(dir, [{ path: 'src/a.ts', content: 'x' }]));
    expect(r.status).toBe('pass');
    expect(r.findings).toEqual([]);
  });

  it('stryker çözümlenemez → throw (fail-closed); pipeline catch bunu ERROR hükmüne çevirir', async () => {
    const dir = repoWithConfig();
    resolveBinMock.mockReturnValue(null); // stage iki kez çağrılır (doğrudan + pipeline) — her ikisinde de null
    const stage = new MutationStage(policy());
    await expect(stage.evaluate(mkCtx(dir))).rejects.toThrow('stryker çözümlenemedi');
    const p = policy();
    p.gates = []; // yalnız mutation-testing koşsun — diğer policy stage'leri bu testte yok
    p.advisory = ['mutation-testing'];
    const r = await new ReviewPipeline([stage], p).run(mkCtx(dir));
    expect(r.gateFailed).toBe('mutation-testing');
    expect(r.verdicts[0].stage).toBe('mutation-testing');
    expect(r.verdicts[0].status).toBe('error');
    expect(r.verdicts[0].errorMessage).toBeDefined();
  });

  it('killed/truncated koşum → throw (timeout/çıktı taşması fail-closed)', async () => {
    const dir = repoWithConfig();
    resolveBinMock.mockReturnValueOnce('C:/fake/bin/stryker.js');
    runToolMock.mockResolvedValueOnce({ stdout: 'kısmi çıktı', stderr: '', exitedCleanly: false, killed: true, truncated: false });
    await expect(new MutationStage(policy()).evaluate(mkCtx(dir, [{ path: 'src/a.ts', content: 'x' }]))).rejects.toThrow('fail-closed');
  });

  it('skor ayrıştırılamaz → throw (stderr tanılı)', async () => {
    const dir = repoWithConfig();
    resolveBinMock.mockReturnValueOnce('C:/fake/bin/stryker.js');
    runToolMock.mockResolvedValueOnce({ stdout: 'beklenmedik çıktı', stderr: 'EPIPE bir yerde', exitedCleanly: true, killed: false, truncated: false });
    await expect(new MutationStage(policy()).evaluate(mkCtx(dir, [{ path: 'src/a.ts', content: 'x' }]))).rejects.toThrow('EPIPE');
  });

  it('--mutate artifact ilk 10 dosyayı alır + runTool timeout policy MutationTimeout ile çağrılır', async () => {
    const dir = repoWithConfig();
    resolveBinMock.mockReturnValueOnce('C:/fake/bin/stryker.js');
    runToolMock.mockResolvedValueOnce(toolOut('mutation score 90.00%\nAll files |  90.00 |'));
    const files = Array.from({ length: 12 }, (_, i) => ({ path: `src/f${i}.ts`, content: 'x' }));
    const p = policy(); // mutationTimeoutMinutes: 15
    const r = await new MutationStage(p).evaluate(mkCtx(dir, files));
    expect(r.status).toBe('pass');
    expect(runToolMock).toHaveBeenCalledOnce();
    const [repo, bin, args, timeoutMs] = runToolMock.mock.calls[0];
    expect(repo).toBe(dir);
    expect(bin).toBe('C:/fake/bin/stryker.js');
    expect(args).toEqual(['run', '--mutate', 'src/f0.ts,src/f1.ts,src/f2.ts,src/f3.ts,src/f4.ts,src/f5.ts,src/f6.ts,src/f7.ts,src/f8.ts,src/f9.ts', '--concurrency', '1']);
    expect(timeoutMs).toBe(p.mutationTimeoutMinutes * 60_000);
  });
});

describe('parseMutationScore', () => {
  it('gerçek Stryker clear-text tablosundan skor çıkarır', () => {
    const out = [
      'Ran 1.50 tests per mutant on average.',
      '----------|------------------|----------|',
      '          | % Mutation score |          |',
      'File      |  total | covered | # killed |',
      '----------|--------|---------|----------|',
      'All files |  50.00 |   50.00 |        1 |',
      ' math.ts  |  50.00 |   50.00 |        1 |',
      '----------|------------------|----------|',
    ].join('\n');
    expect(parseMutationScore(out)).toBe(50);
  });

  it('düz metin "mutation score 74.5%" → 74.5', () => {
    expect(parseMutationScore('...mutation score 74.5%...')).toBe(74.5);
  });

  it('100.00 ve 0.00 uç değerleri', () => {
    expect(parseMutationScore('% Mutation score\nAll files |  100.00 |')).toBe(100);
    expect(parseMutationScore('% Mutation score\nAll files |  0.00 |')).toBe(0);
  });

  it('eşleşmezse null', () => {
    expect(parseMutationScore('skor bulunamadı')).toBeNull();
    expect(parseMutationScore('')).toBeNull();
  });
});

// Gerçek Stryker koşumu — yavaş (1-3 dk olabilir); ayrı test, 300s timeout.
describe('MutationStage gerçek Stryker koşumu', () => {
  const scratch: string[] = [];
  afterEach(() => {
    while (scratch.length) rmSync(scratch.pop()!, { recursive: true, force: true });
  });

  it('fixture testi mutant öldürmez → fail + survived bulgusu', async () => {
    const devloopNodeModules = fileURLToPath(new URL('../../node_modules', import.meta.url));
    const dir = mkdtempSync(join(tmpdir(), 'mutreal-'));
    scratch.push(dir);
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'mutation-fixture', private: true, type: 'module', version: '0.0.0' }));
    writeFileSync(join(dir, 'stryker.config.json'), JSON.stringify({
      testRunner: 'vitest', reporters: ['clear-text'], concurrency: 1, mutate: ['src/math.ts'], incapaciterPlugin: false,
    }));
    writeFileSync(join(dir, 'vitest.config.ts'), "import { defineConfig } from 'vitest/config';\nexport default defineConfig({ test: { environment: 'node' } });\n");
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src/math.ts'), 'export const add=(a:number,b:number)=>a+b;\n');
    // İki basit test — mutant öldürmez: dönüş değeri doğrulanmaz, mutanta rağmen ikisi de geçer
    // (ArrowFunction `()=>undefined` ve ArithmeticOperator `a-b` mutantları survive eder → skor 0%).
    writeFileSync(join(dir, 'src/math.test.ts'), [
      "import { describe, expect, it } from 'vitest';",
      "import { add } from './math.js';",
      '',
      "describe('add', () => {",
      "  it('cagrildiginda patlamaz', () => { add(1, 2); });",
      "  it('fonksiyon olarak import edilir', () => { expect(typeof add).toBe('function'); });",
      '});',
      '',
    ].join('\n'));
    // Fixture'ın kendi node_modules'u yok — vitest çözümlemesi devloop node_modules'una junction ile.
    const linkType = process.platform === 'win32' ? 'junction' : 'dir';
    symlinkSync(devloopNodeModules, join(dir, 'node_modules'), linkType);
    expect(existsSync(join(dir, 'node_modules', 'vitest'))).toBe(true);

    const r = await new MutationStage(policy()).evaluate(mkCtx(dir, [{ path: 'src/math.ts', content: 'export const add=(a:number,b:number)=>a+b;\n' }]));
    expect(r.status).toBe('fail');
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].category).toBe('mutation');
    expect(r.findings[0].severity).toBe('critical');
    expect(r.findings[0].evidence.file).toBe('(mutation-report)');
    expect(r.findings[0].suggestion).toContain('testler mutantları öldürmüyor');
  }, 300_000);
});
