import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { join } from 'node:path';
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

/**
 * Windows'ta `execFile('npx', {shell:false})` ENOENT verir (npx.cmd spawn'ı Node tarafından EINVAL ile
 * engelli) → sessiz boş bulgu → stage 'pass' (A6 ihlali: "başarısız komut sessizce pass olmaz").
 * Bu yüzden npx yerine araç girdisi doğrudan çözümlenir: önce hedef reponun kendi toolchain'i
 * (node çözümlemesi parent walk yapar), sonra devloop'un kendi node_modules'u.
 * Hiçbir yerde bulunamazsa null döner — adapter metodu throw eder → stage 'error' (sessiz pass yok).
 */
export function resolveBin(repoPath: string, subpath: string): string | null {
  const candidates = [
    () => createRequire(join(repoPath, 'package.json')).resolve(subpath),   // hedef reponun kendi toolchain'i
    () => createRequire(import.meta.url).resolve(subpath),                  // devloop'un kendi node_modules'u
  ];
  for (const tryResolve of candidates) { try { return tryResolve(); } catch { /* sonraki aday */ } }
  return null;
}

export class TypeScriptAdapter implements StackAdapter {
  readonly id = 'typescript';

  async lint(repoPath: string): Promise<Finding[]> {
    const bin = resolveBin(repoPath, 'eslint/bin/eslint.js');
    if (bin === null) throw new Error(`eslint çözümlenemedi (hedef repo + devloop node_modules): static-gates gate hatası`);
    const out = await safeStdout(process.execPath, [bin, '-f', 'json', '.'], repoPath);
    return out === undefined ? [] : parseEslintJson(out);
  }

  async typecheck(repoPath: string): Promise<Finding[]> {
    const bin = resolveBin(repoPath, 'typescript/bin/tsc');
    if (bin === null) throw new Error(`tsc çözümlenemedi (hedef repo + devloop node_modules): static-gates gate hatası`);
    const out = await safeStdout(process.execPath, [bin, '--noEmit', '--pretty', 'false'], repoPath);
    return out === undefined ? [] : parseTscOutput(out);
  }

  async runTests(repoPath: string): Promise<TestRunResult> {
    const bin = resolveBin(repoPath, 'vitest/vitest.mjs');
    if (bin === null) throw new Error(`vitest çözümlenemedi (hedef repo + devloop node_modules): tests gate hatası`);
    const out = await safeStdout(process.execPath, [bin, 'run'], repoPath);
    if (out === undefined) return { passed: false, output: '(spawn başarısız)', findings: [] };
    const summary = out.split('\n').find((l) => l.includes('Tests')) ?? 'Tests  failed';
    return parseVitestOutput(summary, out);
  }
}
