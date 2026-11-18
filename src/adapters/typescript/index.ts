import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { StackAdapter, TestRunResult } from '../types.js';
import type { Finding } from '../../contracts/schemas.js';
import { parseEslintJson, parseTscOutput, parseVitestOutput } from './parsers.js';

const run = promisify(execFile);
const SPAWN = { timeout: 120_000, maxBuffer: 10 * 1024 * 1024, shell: false } as const; // A5: sabit executable, shell yok

/** exit-code ≠ 0 normaldir (lint hatası) — stdout'u döndür; gerçek spawn hatasında undefined döner. */
async function safeStdout(cmd: string, args: string[], cwd: string): Promise<string | undefined> {
  try { return (await run(cmd, args, { cwd, ...SPAWN })).stdout; }
  catch (e) { return (e as { stdout?: string }).stdout; }
}

export class TypeScriptAdapter implements StackAdapter {
  readonly id = 'typescript';

  // Controller-ruled: production spawn npx kalır (hedef repo'nun kendi araç zinciri, cwd: repoPath ile
  // repo-local → parent → global çözümleme). OS-temp fixture'larda gerçek tsc entegrasyon testleri için
  // opsiyonel override enjeksiyonu; override yolu da aynı SPAWN kurallarını (timeout, maxBuffer, shell:false) kullanır.
  constructor(private readonly toolOverride?: { typecheck?: { cmd: string; args: string[] } }) {}

  async lint(repoPath: string): Promise<Finding[]> {
    const out = await safeStdout('npx', ['eslint', '-f', 'json', '.'], repoPath);
    return out === undefined ? [] : parseEslintJson(out);
  }

  async typecheck(repoPath: string): Promise<Finding[]> {
    const o = this.toolOverride?.typecheck;
    const out = o
      ? await safeStdout(o.cmd, o.args, repoPath)
      : await safeStdout('npx', ['tsc', '--noEmit', '--pretty', 'false'], repoPath);
    return out === undefined ? [] : parseTscOutput(out);
  }

  async runTests(repoPath: string): Promise<TestRunResult> {
    const out = await safeStdout('npx', ['vitest', 'run'], repoPath);
    if (out === undefined) return { passed: false, output: '(spawn başarısız)', findings: [] };
    const summary = out.split('\n').find((l) => l.includes('Tests')) ?? 'Tests  failed';
    return parseVitestOutput(summary, out);
  }
}
