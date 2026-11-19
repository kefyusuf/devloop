import type { ReviewStage, ReviewContext, StageResult } from '../contracts/review.js';
import type { Finding } from '../contracts/schemas.js';
import { SEVERITY_ORDER } from '../contracts/schemas.js';
import type { Policy } from '../config/config.js';

export interface PipelineResult {
  // I5 (final review): errorMessage kanıt zincirine taşınır — StageVerdict payload'u opsiyonel alır.
  verdicts: Array<{ stage: string; status: StageResult['status']; durationMs: number; errorMessage?: string }>;
  findings: Finding[];
  gateFailed: string | null;
  passed: boolean;
}
export class PipelineConfigError extends Error {}

const rank = (s: Finding['severity']) => SEVERITY_ORDER.indexOf(s);

export class ReviewPipeline {
  constructor(private readonly stages: ReviewStage[], private readonly policy: Policy) {}

  private ordered(): ReviewStage[] {
    const byName = new Map(this.stages.map((s) => [s.name, s]));
    const wanted = [...this.policy.gates, ...this.policy.advisory];
    const missing = wanted.filter((n) => !byName.has(n));
    if (missing.length > 0) throw new PipelineConfigError(`Politikada olup implementasyonu olmayan stage'ler: ${missing.join(', ')}`); // A2 fail-closed
    return wanted.map((n) => byName.get(n)!);
  }

  async run(ctx: ReviewContext): Promise<PipelineResult> {
    const verdicts: PipelineResult['verdicts'] = [];
    const allFindings: Finding[] = [];
    let gateFailed: string | null = null;
    for (const s of this.ordered()) {
      let res: StageResult;
      try { res = await s.evaluate(ctx); }
      catch (e) { res = { status: 'error', findings: [], durationMs: 0, errorMessage: String(e) }; }
      // I5: stage'in hata mesajı (varsa) verdict'e taşınır — event kanıtında diagnoz edilebilir.
      verdicts.push({ stage: s.name, status: res.status, durationMs: res.durationMs, ...(res.errorMessage !== undefined ? { errorMessage: res.errorMessage } : {}) });
      allFindings.push(...res.findings);
      if (s.kind === 'gate') {
        const unauthorizedSkip = res.status === 'skipped' && !this.policy.authorizedSkips.includes(s.name);
        if (res.status === 'fail' || res.status === 'error' || unauthorizedSkip) { gateFailed = s.name; break; }
      }
    }
    return { verdicts, findings: this.dedupe(allFindings), gateFailed, passed: gateFailed === null };
  }

  /** Aynı file+line+category → tek bulgu; en şiddetli birebir korunur. Farklı kategori/stage çelişkisi korunur (§5.2.4). */
  private dedupe(findings: Finding[]): Finding[] {
    const byKey = new Map<string, Finding>();
    for (const f of findings) {
      const key = `${f.evidence.file}:${f.evidence.line ?? '-'}:${f.category}`;
      const cur = byKey.get(key);
      if (!cur || rank(f.severity) < rank(cur.severity)) byKey.set(key, f);
    }
    return [...byKey.values()].sort((a, b) => rank(a.severity) - rank(b.severity));
  }
}
