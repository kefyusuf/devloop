import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { StackAdapter, TestRunResult } from '../types.js';
import type { Finding } from '../../contracts/schemas.js';
import type { Policy } from '../../config/config.js';
import { safeEnv } from '../../shell/safeEnv.js';
import { dockerizeSpawn } from '../../shell/sandbox.js';
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
 *
 * R13: spawn hedefi çağıranın seçimine bağlı — host modda process.execPath + [bin, ...args],
 * docker modda dockerizeSpawn çıktısı (cmd=docker, konteyner içi npx). A6 sınıflandırma
 * mantığı iki mod için AYNIdır — başarısız komut hiçbir zaman sessizce pass olmaz.
 */
export async function spawnTool(cmd: string, toolArgs: string[], repoPath: string, timeoutMs: number = SPAWN.timeout): Promise<ToolOutput> {
  // I2 (final review): sırlar (API anahtarları vb.) çocuk sürece sızmaz — env seçilmiş ayak izi.
  try {
    const r = await run(cmd, toolArgs, { cwd: repoPath, env: safeEnv(), ...SPAWN, timeout: timeoutMs });
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

/** R13 öncesi imza korunur (mutationStage ve mevcut testler host modda bu yolu kullanır). */
export async function runTool(repoPath: string, bin: string, args: string[], timeoutMs: number = SPAWN.timeout): Promise<ToolOutput> {
  return spawnTool(process.execPath, [bin, ...args], repoPath, timeoutMs);
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
 * (varlık denetimi existsSync ile — kökten sapma yok).
 * R3 eki: `@scope/paket/alt/yol` da desteklenir — paket adı kapsam alırken ilk İKİ segmenttir
 * (ör. `@stryker-mutator/core/bin/stryker.js`: exports haritası bin alt yolunu export etmez,
 * kökten `bin/stryker.js` dosyası existsSync ile doğrulanır).
 */
function trySubpath(req: NodeRequire, subpath: string): string | null {
  try { return req.resolve(subpath); } catch { /* exports kısıtı ya da paket yok — kök çözümünü dene */ }
  const parts = subpath.split('/');
  const scoped = parts[0].startsWith('@');
  if (scoped && parts.length < 3) return null;
  const [pkg, ...rest] = scoped ? [parts.slice(0, 2).join('/'), ...parts.slice(2)] : parts;
  if (rest.length === 0) return null;
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
      suggestion: 'test runner exit kodu sıfır değil ama özet geçiş bildiriyor — fail-closed', corroborated: false });
  }
  return parsed;
}

/**
 * I8 (final review): statik araç nonzero exit ile dönerse ama çıktısından bulgu ayrıştırılamıyorsa
 * bu, "temiz geçiş" ile AYRIŞTIRILAMAZ — gate bozuk ya da çıktı kesik demektir → fail-closed throw.
 * Nonzero exit + ayrıştırılabilir bulgu → normal lint/tip hata yolu ('pass': bulgular gate'i fail eder).
 */
export function evaluateStaticTool(stdout: string, exitedCleanly: boolean, findings: ReadonlyArray<unknown>): 'pass' | 'throw' {
  if (!exitedCleanly && findings.length === 0) return 'throw';
  return 'pass';
}

export class TypeScriptAdapter implements StackAdapter {
  readonly id = 'typescript';

  /**
   * R13: policy verilirse sandbox modu uygulanır — docker modda araç koşumları dockerizeSpawn ile
   * konteynere sarılır (bin resolve ATLANIR); verilmmezse/default host modunda mevcut davranış
   * (resolveBin + process.execPath) korunur. Mevcut çağrılar (default-ctor) etkilenmez.
   * I2 (fix round 1): originalRepoPath — ORİJİNAL reponun yolu (CLI'da repoDir()/deps.repoPath);
   * docker modda node_modules'u /workspace/node_modules'a bind edilir (hedef repo kendi
   * toolchain'i). Verilmediyse ikinci bind yok — repo toolchain'i yoksa npx fail-closed error
   * üretir (dokümante davranış).
   */
  constructor(private readonly policy?: Policy, private readonly originalRepoPath?: string) {}

  /**
   * Araç koşumu — mod seçimi tek kapı:
   * - docker modda `npx <pkg> ...` konteyner içi toolchain'i çözer (toolArgs başına pkg eklenir;
   *   resolveBin çağrılmaz — hedef reponun mount'taki node_modules'u yerleşik çözüm sağlar).
   * - host modda mevcut yol: resolveBin → process.execPath + [bin, ...args].
   * A6 sınıflandırma (spawnTool) iki modda aynıdır.
   */
  private async runToolIn(repoPath: string, pkg: string, subpath: string, errorSuffix: string, args: string[], timeoutMs?: number): Promise<ToolOutput> {
    if (this.policy?.sandbox.mode === 'docker') {
      const sp = dockerizeSpawn({ repoPath, originalRepoPath: this.originalRepoPath, policy: this.policy, bin: '', toolArgs: [pkg, ...args] });
      return spawnTool(sp.cmd, sp.args, repoPath, timeoutMs ?? SPAWN.timeout);
    }
    const bin = resolveBin(repoPath, subpath);
    if (bin === null) throw new Error(`${pkg} çözümlenemedi (hedef repo + devloop node_modules): ${errorSuffix}`);
    return spawnTool(process.execPath, [bin, ...args], repoPath, timeoutMs ?? SPAWN.timeout);
  }

  async lint(repoPath: string): Promise<Finding[]> {
    const { stdout, stderr, killed, truncated, exitedCleanly } = await this.runToolIn(repoPath, 'eslint', 'eslint/bin/eslint.js', 'static-gates gate hatası', ['-f', 'json', '.']);
    if (killed || truncated) throw new Error('eslint koşumu timeout/maxBuffer ile kesildi — çıktı güvenilmez: static-gates gate hatası');
    const findings = parseEslintJson(stdout);
    // I8: nonzero exit + ayrıştırılabilir bulgu yok → sessiz pass riski — fail-closed (stderr tanı ile)
    if (evaluateStaticTool(stdout, exitedCleanly, findings) === 'throw') {
      throw new Error(`eslint nonzero exit ama ayrıştırılabilir bulgu yok — çıktı güvenilmez, fail-closed: static-gates gate hatası${stderr ? ` — stderr: ${stderr.slice(0, 300)}` : ''}`);
    }
    return findings;
  }

  async typecheck(repoPath: string): Promise<Finding[]> {
    const { stdout, stderr, killed, truncated, exitedCleanly } = await this.runToolIn(repoPath, 'tsc', 'typescript/bin/tsc', 'static-gates gate hatası', ['--noEmit', '--pretty', 'false']);
    if (killed || truncated) throw new Error('tsc koşumu timeout/maxBuffer ile kesildi — çıktı güvenilmez: static-gates gate hatası');
    const findings = parseTscOutput(stdout);
    // I8: nonzero exit + ayrıştırılabilir bulgu yok → sessiz pass riski — fail-closed (stderr tanı ile)
    if (evaluateStaticTool(stdout, exitedCleanly, findings) === 'throw') {
      throw new Error(`tsc nonzero exit ama ayrıştırılabilir bulgu yok — çıktı güvenilmez, fail-closed: static-gates gate hatası${stderr ? ` — stderr: ${stderr.slice(0, 300)}` : ''}`);
    }
    return findings;
  }

  async runTests(repoPath: string): Promise<TestRunResult> {
    const { stdout, exitedCleanly, killed, truncated } = await this.runToolIn(repoPath, 'vitest', 'vitest/vitest.mjs', 'tests gate hatası', ['run']);
    if (killed || truncated) throw new Error('vitest koşumu timeout/maxBuffer ile kesildi — çıktı güvenilmez: tests gate hatası');
    const summary = stdout.split('\n').find((l) => l.includes('Tests')) ?? 'Tests  failed';
    return evaluateTestResult(summary, stdout, exitedCleanly);
  }
}
