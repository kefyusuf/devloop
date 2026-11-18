import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { LlmGeneratorBackend, readRepoContext } from '../../src/generator/generator.js';
import { applyArtifact } from '../../src/generator/apply.js';
import { mkdtempSync, writeFileSync, readFileSync, symlinkSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LlmGateway } from '../../src/gateway/gateway.js';
import type { TaskSpec, Finding } from '../../src/contracts/schemas.js';

const task: TaskSpec = { id: 't1', description: 'toplama ekle', acceptanceCriteria: ['sum(2,3)===5'], filesScope: ['src/'] };
const gatewayOk = (files: Array<{ path: string; content: string }>): LlmGateway => ({
  complete: vi.fn(async (req: { user: string }) => {
    return { data: { intent: 'sum eklendi', rejectedAlternatives: ['mathjs'], testEvidence: '3 test', files },
      usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 } };
  }),
} as unknown as LlmGateway);

describe('readRepoContext', () => {
  it('kapsamdaki dosyaları içerikleriyle verir; node_modules atlanır', () => {
    const dir = mkdtempSync(join(tmpdir(), 'repoctx-'));
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'svc.ts'), 'export class Svc {}');
    mkdirSync(join(dir, 'node_modules'), { recursive: true });
    writeFileSync(join(dir, 'node_modules', 'x.js'), 'junk');
    const ctx = readRepoContext(dir, ['src/']);
    expect(ctx.repoFiles.map((f) => f.path)).toEqual(['src/svc.ts']);
    expect(ctx.repoFiles[0].content).toContain('Svc');
    expect(ctx.repoTree).toContain('src/svc.ts');
  });
  it('limit: maxFiles aşılırsa kesilir', () => {
    const dir = mkdtempSync(join(tmpdir(), 'repolim-'));
    mkdirSync(join(dir, 'src'), { recursive: true });
    for (let i = 0; i < 50; i++) writeFileSync(join(dir, 'src', `f${i}.ts`), 'export {}');
    expect(readRepoContext(dir, ['src/'], { maxFiles: 10, maxBytesPerFile: 20000, maxTotalBytes: 120000 }).repoFiles).toHaveLength(10);
  });
});

describe('LlmGeneratorBackend', () => {
  it('repo bağlamı + feedback + dersler prompt\'a girer', async () => {
    let captured = '';
    const gw: LlmGateway = { complete: vi.fn(async (req: { user: string; schema: z.Zod<unknown> }) => {
      captured = req.user;
      return { data: { intent: 'i', rejectedAlternatives: [], testEvidence: 'e', files: [{ path: 'src/math.ts', content: 'export const sum=(a:number,b:number)=>a+b;' }] }, usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 } };
    }) } as unknown as LlmGateway;
    const feedback: Finding[] = [{ id: 'f', stage: 'static-gates', category: 'lint', severity: 'required', confidence: 1, evidence: { file: 'a.ts' }, suggestion: 'unused var' }];
    const backend = new LlmGeneratorBackend(gw, { contextFor: () => 'AKTİF DERS: fiil isimleri.' });
    const dir = mkdtempSync(join(tmpdir(), 'gb-'));
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'svc.ts'), 'export class Svc {}');
    const base = readRepoContext(dir, ['src/']);
    await backend.generate(task, { ...base, lessons: 'AKTİF DERS: fiil isimleri.', feedback });
    expect(captured).toContain('AKTİF DERS');
    expect(captured).toContain('ÖNCEKİ TUR BULGULARI');
    expect(captured).toContain('unused var');
    expect(captured).toContain('export class Svc'); // repo içeriği — yoksa Generator gerçek kodu değiştiremez
  });
});

describe('applyArtifact güvenliği', () => {
  it('dosyaları yazar', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ap-'));
    await applyArtifact(dir, { diff: '', intent: 'i', rejectedAlternatives: [], testEvidence: '', files: [{ path: 'src/new.ts', content: 'export {};' }] });
    expect(readFileSync(join(dir, 'src', 'new.ts'), 'utf8')).toBe('export {};');
  });
  it('yol kaçışı reddedilir', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ap2-'));
    await expect(applyArtifact(dir, { diff: '', intent: 'i', rejectedAlternatives: [], testEvidence: '', files: [{ path: '../escape.ts', content: 'x' }] })).rejects.toThrow('kaçış');
  });
  it('sembolik bağ hedefi reddedilir', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ap3-'));
    const outside = mkdtempSync(join(tmpdir(), 'ap3-out-'));
    mkdirSync(join(dir, 'link-dir'));
    symlinkSync(outside, join(dir, 'link-dir', 'target'));
    await expect(applyArtifact(dir, { diff: '', intent: 'i', rejectedAlternatives: [], testEvidence: '', files: [{ path: 'link-dir/target/evil.ts', content: 'x' }] })).rejects.toThrow();
  });
  it('hedef dosyanın kendisi sembolik bağ ise reddedilir', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ap4-'));
    const outsideDir = mkdtempSync(join(tmpdir(), 'ap4-out-'));
    const outsideFile = join(outsideDir, 'real.ts');
    writeFileSync(outsideFile, 'real');
    mkdirSync(join(dir, 'src'));
    symlinkSync(outsideFile, join(dir, 'src', 'evil.ts'));
    await expect(applyArtifact(dir, { diff: '', intent: 'i', rejectedAlternatives: [], testEvidence: '', files: [{ path: 'src/evil.ts', content: 'x' }] })).rejects.toThrow();
  });
  it('derin sembolik bağ reddedilir; bağ ötesinde dizin oluşturulmaz', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ap5-'));
    const outsideDir = mkdtempSync(join(tmpdir(), 'ap5-out-'));
    mkdirSync(join(dir, 'link-dir'));
    symlinkSync(outsideDir, join(dir, 'link-dir', 'target'));
    await expect(applyArtifact(dir, { diff: '', intent: 'i', rejectedAlternatives: [], testEvidence: '', files: [{ path: 'link-dir/target/sub/evil.ts', content: 'x' }] })).rejects.toThrow();
    expect(existsSync(join(outsideDir, 'sub'))).toBe(false);
  });
});
