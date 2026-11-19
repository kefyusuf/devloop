import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { StackAdapter, TestRunResult } from '../types.js';
import type { Finding } from '../../contracts/schemas.js';
import { safeEnv } from '../../shell/safeEnv.js';
import { parseEslintJson, parseTscOutput, parseVitestOutput } from './parsers.js';

const run = promisify(execFile);
const SPAWN = { timeout: 120_000, maxBuffer: 10 * 1024 * 1024, shell: false } as const; // A5: sabit executable, shell yok

/** Reddedilen execFile hatasının sınıflandırma için gereken yüzü. */
type Rejection = { killed?: boolean; signal?: unknown; code?: unknown; stdout?: string; stderr?: string };

/**
 * A6: başarısız komut hiçbir zaman sessizce pass olmaz.
 * - 'fatal': timeout/kill (killed/signal), maxBuffer taşması (ENOBUFS — çıktı kesik, güvenle parse edilemez)
 *   veya stdout yok/boş (spawn sınıfı hata, örn. binary çözülemedi; ya da çıktısız başarısızlık).
 * - 'nonzero': normal nonzero exit — çıktı olduğu gibi parse edilir (lint/tsc/vitest başarısızlık yolu).
 */
export function classifyRejection(e: Rejection): 'fatal' | 'nonzero' {
  if (e.killed === true || !!e.signal) return 'fatal';
  if (e.code === 'ENOBUFS') return 'fatal';
  if (!e.stdout) return 'fatal';
  return 'nonzero';
}

interface ToolOutput { stdout: string; stderr: string; exitedCleanly: boolean; killed: boolean; truncated: boolean }

/**
 * Araç koşumu üç yolla sonuçlanır:
 * - exit 0 → { stdout, exitedCleanly: true, killed: false, truncated: false }
 * - nonzero exit → çıktı aynen döner (exitedCleanly: false, bayraklar false) — parse yolu
 * - fatal (timeout kill / ENOBUFS, stdout var) → bayraklı döner; ÇAĞIRAN throw eder → stage 'error'
 * - fatal ve stdout yok (spawn sınıfı hata) → burada THROW edilir → stage catch → 'error'
 */
async function runTool(repoPath: string, bin: string, args: string[]): Promise<ToolOutput> {
  // I2 (final review): sırlar (API anahtarları vb.) çocuk sürece sızmaz — env seçilmiş ayak izi.
  try {
    const r = await run(process.execPath, [bin, ...args], { cwd: repoPath, env: safeEnv(), ...SPAWN });
    return { stdout: r.stdout, stderr: r.stderr ?? '', exitedCleanly: true, killed: false, truncated: false };
  } catch (e) {
    const err = e as Rejection;
    if (classifyRejection(err) === 'fatal' && !err.stdout) {
      const stderr = err.stderr ? ` — stderr: ${err.stderr.slice(0, 300)}` : '';
      throw new Error(`araç koşumu fatal (stdout yok): ${String(err.code ?? err.signal ?? 'bilinmeyen hata')}${stderr}`);
    }
    // nonzero exit → parse edilebilir çıktı; fatal ama çıktı var (timeout kill / ENOBUFS) → bayrakla dön
    return { stdout: err.stdout ?? '', stderr: err.stderr ?? '', exitedCleanly: false, killed: err.killed === true || !!err.signal, truncated: err.code === 'ENOBUFS' };
  }
}

/**
 * Windows'ta `execFile('npx', {shell:false})` ENOENT verir (npx.cmd spawn'ı Node tarafından EINVAL ile
 * engelli) → sessiz boş bulgu → stage 'pass' (A6 ihlali). Bu yüzden npx yerine araç girdisi doğrudan
 * çözümlenir: önce hedef reponun kendi toolchain'i (node çözümlemesi parent walk yapar), sonra
 * devloop'un kendi node_modules'u. Hiçbir yerde bulunamazsa null döner — adapter metodu throw eder →
 * stage 'error' (sessiz pass yok).
 */
export function resolveBin(repoPath: string, subpath: string): string | null {
  const candidates = [
    () => trySubpath(createRequire(join(repoPath, 'package.json')), subpath),   // hedef reponun kendi toolchain'i
    () => trySubpath(createRequire(import.meta.url), subpath),                  // devloop'un kendi node_modules'u
  ];
  for (const tryResolve of candidates) { const found = tryResolve(); if (found !== null) return found; }
  return null;
}

/**
 * A2 (C2) eki: eslint 9/10 `exports` haritası `./bin/eslint.js` alt yolunu export ETMEZ —
 * doğrudan require.resolve ERR_PACKAGE_PATH_NOT_EXPORTED fırlatır (dosya diskte vardır).
 * `./package.json` export edildiğinden paket kökü çözülür ve bin alt yolu köke sabitlenir
 * (varlık denetimi existsSync ile — kökten sapma yok). `@scope/...` v1 kapsamı dışıdır.
 */
function trySubpath(req: NodeRequire, subpath: string): string | null {
  try { return req.resolve(subpath); } catch { /* exports kısıtı ya da paket yok — kök çözümünü dene */ }
  const [pkg, ...rest] = subpath.split('/');
  if (rest.length === 0 || pkg.startsWith('@')) return null;
  try {
    const pkgRoot = dirname(req.resolve(join(pkg, 'package.json')));
    const candidate = join(pkgRoot, ...rest);
    return existsSync(candidate) ? candidate : null;
  } catch { return null; }
}

/**
 * parseVitestOutput + exit-kod birleştirmesi (A6): runner nonzero çıktıysa ama özet "N passed"
 * bildiriyorsa passed=false'a çekilir ve critical bulgu eklenir — özet tek başına güvenilmez.
 */
export function evaluateTestResult(summary: string, fullOutput: string, exitedCleanly: boolean): TestRunResult {
  const parsed = parseVitestOutput(summary, fullOutput);
  if (!exitedCleanly && parsed.passed) {
    parsed.passed = false;
    parsed.findings.unshift({ id: randomUUID(), stage: 'tests', category: 'tests', severity: 'critical',
      confidence: 1, evidence: { file: '(test-output)' },
      suggestion: 'test runner exit kodu sıfır değil ama özet geçiş bildiriyor — fail-closed' });
  }
  return parsed;
}

export class TypeScriptAdapter implements StackAdapter {
  readonly id = 'typescript';

  async lint(repoPath: string): Promise<Finding[]> {
    const bin = resolveBin(repoPath, 'eslint/bin/eslint.js');
    if (bin === null) throw new Error(`eslint çözümlenemedi (hedef repo + devloop node_modules): static-gates gate hatası`);
    const { stdout, killed, truncated } = await runTool(repoPath, bin, ['-f', 'json', '.']);
    if (killed || truncated) throw new Error('eslint koşumu timeout/maxBuffer ile kesildi — çıktı güvenilmez: static-gates gate hatası');
    return parseEslintJson(stdout);
  }

  async typecheck(repoPath: string): Promise<Finding[]> {
    const bin = resolveBin(repoPath, 'typescript/bin/tsc');
    if (bin === null) throw new Error(`tsc çözümlenemedi (hedef repo + devloop node_modules): static-gates gate hatası`);
    const { stdout, killed, truncated } = await runTool(repoPath, bin, ['--noEmit', '--pretty', 'false']);
    if (killed || truncated) throw new Error('tsc koşumu timeout/maxBuffer ile kesildi — çıktı güvenilmez: static-gates gate hatası');
    return parseTscOutput(stdout);
  }

  async runTests(repoPath: string): Promise<TestRunResult> {
    const bin = resolveBin(repoPath, 'vitest/vitest.mjs');
    if (bin === null) throw new Error(`vitest çözümlenemedi (hedef repo + devloop node_modules): tests gate hatası`);
    const { stdout, exitedCleanly, killed, truncated } = await runTool(repoPath, bin, ['run']);
    if (killed || truncated) throw new Error('vitest koşumu timeout/maxBuffer ile kesildi — çıktı güvenilmez: tests gate hatası');
    const summary = stdout.split('\n').find((l) => l.includes('Tests')) ?? 'Tests  failed';
    return evaluateTestResult(summary, stdout, exitedCleanly);
  }
}
