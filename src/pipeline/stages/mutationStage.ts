import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ReviewStage, ReviewContext, StageResult } from '../../contracts/review.js';
import type { Finding } from '../../contracts/schemas.js';
import type { Policy } from '../../config/config.js';
import { resolveBin, runTool, runToolDockerAware, type ToolOutput } from '../../adapters/typescript/index.js';

export function parseMutationScore(stdout: string): number | null {
  const m = /mutation score\D*(\d+(?:\.\d+)?)/i.exec(stdout);
  return m ? Number(m[1]) : null;
}

export interface SurvivedMutant {
  file: string; line: number; id: string; status: string;
}

/** `\` → `/` ve öndeki `./` temizliği — yollar karşılaştırılabilir hale gelir. */
const normPath = (p: string): string => p.replace(/\\/g, '/').replace(/^\.\//, '');

/**
 * I1 (final fix wave, spec R3 tamamlanması): "değişen dosyalarda survived mutant → fail".
 * Stryker JSON raporundan survived mutantları çıkarır ve yalnız artifact tarafından DEĞEN
 * dosyalardaki (touchedPaths) mutantları döndürür. Saf yardımcı — unit test direkt çağırır.
 *
 * Kabul edilen Stryker JSON şekilleri:
 * - Mutation testing protocol (Stryker 5-8 gerçeği, empirik doğrulandı @ 8.7.1):
 *   `{ files: { "<path>": { mutants: [{ id, status, location: { start: { line } } }] } }, projectRoot }`
 *   — dosya bilgisi `files` haritasının ANAHTARIDIR (mutant.location'da file YOKTUR).
 * - Görev-brief'in varsaydığı dizi şekli: `[{ id, status, location: { file, start: { line } } }]`
 *   — diğer sürüm/rapor varyantları için toleranslı destek.
 */
export function survivedInTouchedFiles(resultsJson: string, touchedPaths: string[]): SurvivedMutant[] {
  const parsed: unknown = JSON.parse(resultsJson); // bozuk rapor → throw → stage fail-closed (skor ayrıştırma hükmüyle aynı)
  const touched = new Set(touchedPaths.map(normPath));
  type RawMutant = { id?: unknown; status?: unknown; location?: { file?: unknown; start?: { line?: unknown } } };
  type RawReport = { files?: Record<string, { mutants?: unknown }> };
  const raw = parsed as RawReport | RawMutant[] | null;
  const entries: Array<{ file: unknown; mutant: RawMutant }> = [];
  if (raw && !Array.isArray(raw) && raw.files) {
    for (const [fileKey, fileEntry] of Object.entries(raw.files)) {
      const mutants = fileEntry?.mutants;
      if (Array.isArray(mutants)) for (const m of mutants as RawMutant[]) entries.push({ file: m.location?.file ?? fileKey, mutant: m });
    }
  } else if (Array.isArray(raw)) {
    for (const m of raw as RawMutant[]) entries.push({ file: m.location?.file, mutant: m });
  }
  const out: SurvivedMutant[] = [];
  for (const { file: rawFile, mutant } of entries) {
    if (typeof rawFile !== 'string' || mutant.status !== 'Survived') continue;
    const file = normPath(rawFile);
    const match = touched.has(file) || [...touched].some((t) => file.endsWith('/' + t)); // abs repo-içi yol da eşleşir
    const line = (mutant.location as { start?: { line?: unknown } } | undefined)?.start?.line;
    if (!match || typeof line !== 'number' || !Number.isInteger(line)) continue;
    out.push({ file, line, id: String(mutant.id), status: String(mutant.status) });
  }
  return out;
}

/**
 * R20 (faz 4 T5): stryker koşum tek kesit — injectable runner. Testler sahte runner enjekte eder
 * (ctor 2. param); default runner gerçek koşumdur (aşağıda).
 */
export interface MutationRunnerDesc {
  repoPath: string;
  /** Docker modda node_modules :ro çift mount kaynağı (orijinal repo); verilmezse bind YOK. */
  originalRepoPath?: string;
  policy: Policy;
  pkg: string;
  args: string[];
  timeoutMs?: number;
}
export type MutationRunner = (desc: MutationRunnerDesc) => Promise<ToolOutput>;

/** stryker host-mode çözümleme alt yolu (scoped pkg ilk İKİ segment — R3 eki). */
const STRYKER_SUBPATH = '@stryker-mutator/core/bin/stryker.js';

/**
 * R20 (faz 4 T5): default runner.
 * - docker mod: runToolDockerAware — dockerizeSpawn (worktree mount + orijinal node_modules :ro
 *   çift mount, --network none, konteyner içi `npx stryker ...`) ile stryker hedef reponun
 *   KENDİ toolchain'iyle konteynerde koşar. Faz 3.1 fail-closed guard'ı KALDIRILDI (R13 Docker-yok
 *   abortu aktivasyon kapısında aynen sürer); sessiz host-run yok.
 * - host mod: mevcut yol AYNEN — resolveBin + runTool. Bilinçli olarak runToolDockerAware'a
 *   devredilmedi: mevcut host-mode testler adapter.resolveBin/runTool mock'larıyla bu kesitte
 *   çalışmaya devam eder (hüküm: host-mode default testler bozulmaz); davranış birebir aynıdır.
 */
const defaultRunner: MutationRunner = (desc) => {
  if (desc.policy.sandbox.mode === 'docker') {
    return runToolDockerAware(desc.repoPath, desc.originalRepoPath, desc.policy, desc.pkg, desc.args, desc.timeoutMs);
  }
  const bin = resolveBin(desc.repoPath, STRYKER_SUBPATH);
  if (!bin) throw new Error(`${desc.pkg} çözümlenemedi (fail-closed)`);
  return runTool(desc.repoPath, bin, desc.args, desc.timeoutMs);
};

export class MutationStage implements ReviewStage {
  readonly name = 'mutation-testing';
  readonly kind = 'gate' as const;
  /**
   * R20 (faz 4 T5): ctor `(policy, runner?, originalRepoPath?)` — runner enjeksiyonu test kesiti;
   * originalRepoPath docker modda dockerizeSpawn çift mount'una (orijinal node_modules :ro) girer
   * (CLI'da repoDir() — TypeScriptAdapter wiring'iyle aynı). Verilmezse docker modda node_modules
   * bind YOK (npx fail-closed error — dokümante davranış).
   */
  constructor(private readonly policy: Policy, private readonly runner: MutationRunner = defaultRunner, private readonly originalRepoPath?: string) {}

  async evaluate(ctx: ReviewContext): Promise<StageResult> {
    const t0 = Date.now();
    if (!existsSync(join(ctx.repoPath, 'stryker.config.json'))) {
      return { status: 'skipped', findings: [], durationMs: Date.now() - t0 };
    }
    // R11 (faz 3 T5): risk-tiered kapsam — sabit ilk-10 yerine risk-ölçekli seçim. Triaj proxy'si
    // olarak dosyalar içerik-uzunluğu DESC sıralanır (deterministik: JS sort stabil, eşit uzunlukta
    // orijinal artifact sırası korunur), sonra scope kadar dilim alınır.
    const scope = ctx.riskScore < 30 ? this.policy.mutationScopeLow : this.policy.mutationScopeHigh;
    const mutate = [...ctx.artifact.files]
      .sort((a, b) => b.content.length - a.content.length) // triaj proxy: en büyük içerik önce (deterministik)
      .slice(0, scope)
      .map((f) => f.path)
      .join(',');
    // I1 (R3): json reporter eklendi — survived mutant kanıtı `reports/mutation/` raporundan okunur
    // (Stryker 8.7.1 varsayılan dosya adı `mutation.json`; eski `results.json` adı da aranır).
    // R20: docker modda koşum konteynerdedir; mutation.json worktree mount'undan host yolunda
    // (join(repoPath, 'reports', 'mutation', 'mutation.json')) belirir — çift yol aranışı aynen.
    const res = await this.runner({
      repoPath: ctx.repoPath,
      originalRepoPath: this.originalRepoPath,
      policy: this.policy,
      pkg: 'stryker',
      args: ['run', '--mutate', mutate, '--concurrency', '1', '--reporters', 'clear-text,json'],
      timeoutMs: this.policy.mutationTimeoutMinutes * 60_000,
    });
    if (res.killed || res.truncated) throw new Error('stryker timeout/çıktı taşması — fail-closed');
    const score = parseMutationScore(res.stdout);
    if (score === null) throw new Error(`stryker skorları ayrıştırılamadı (stderr: ${res.stderr.slice(0, 300)})`);
    const findings: Finding[] = [];
    if (score < this.policy.mutationScoreThreshold) {
      findings.push({ id: randomUUID(), stage: this.name, category: 'mutation', severity: 'critical', confidence: 1,
        evidence: { file: '(mutation-report)' }, corroborated: false,
        suggestion: `Mutation skoru ${score}% < ${this.policy.mutationScoreThreshold}% — testler mutantları öldürmüyor.` });
    }
    // R3: değişen dosyalarda survived mutant → fail; HER mutant ayrı Finding (kanıt: dosya+mutant no).
    const reportPath = [join(ctx.repoPath, 'reports', 'mutation', 'results.json'), join(ctx.repoPath, 'reports', 'mutation', 'mutation.json')]
      .find((p) => existsSync(p));
    if (reportPath) {
      const survived = survivedInTouchedFiles(readFileSync(reportPath, 'utf8'), ctx.artifact.files.map((f) => f.path));
      for (const m of survived) {
        findings.push({ id: randomUUID(), stage: this.name, category: 'mutation', severity: 'critical', confidence: 1,
          // R14 (faz 3 T8): mutant kimliği evidence.mutantId'ye yazılır (şema alanı faz 3 T1'den beri
          // mevcuttu — faz 2 final dalgası bulguları bu alanı doldurmuyordu; kanıt zinciri tamamlanır).
          evidence: { file: m.file, line: m.line, mutantId: m.id }, corroborated: false,
          suggestion: `Survived mutant (${m.status}, id ${m.id}) @ ${m.file}:${m.line} — test bu mutasyonu öldürmüyor (R3).` });
      }
    }
    return { status: findings.length === 0 ? 'pass' : 'fail', findings, durationMs: Date.now() - t0 };
  }
}
