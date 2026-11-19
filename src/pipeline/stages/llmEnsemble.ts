import type { ReviewStage, ReviewContext, StageResult } from '../../contracts/review.js';
import type { Finding } from '../../contracts/schemas.js';
import { SEVERITY_ORDER } from '../../contracts/schemas.js';
import type { Policy } from '../../config/config.js';

const key = (f: Finding) => `${f.evidence.file}:${f.evidence.line ?? '-'}:${f.category}`;
const rank = (f: Finding) => SEVERITY_ORDER.indexOf(f.severity);

/**
 * T4 hüküm (brief snippet düzeltmesi): brief'in verbatim ensemble gövdesi `all`'ı aynen döndürüyordu;
 * fakat brief'in KENDİ testi ("aynı kategori+konum iki tarafta → corroborated=true") sonuçta TEK bulgu
 * bekliyor ve hüküm notu "pipeline dedupe'ü kazananı birebir taşır ve corroborated bayrağı onunla gelir"
 * diyor. İkisi ancak şu şemayla birlikte sağlanır: ensemble, pipeline ile AYNI anahtar+şiddet kuralına
 * göre (en şiddetli, eşitlikte ilk = primary önceliği) kazananı tutar, kopyası görüldüğünde kazananı
 * corroborated=true işaretler. Böylece (a) doğrudan ensemble çıktısı testin istediği tekil+flagged olur,
 * (b) downstream pipeline dedupe'ü kazananı birebir taşır ve bayrak asla düşmez, (c) §5.2.4'ün
 * "en şiddetli birebir korunur" değişmezi çapraz-stage kopyada da bozulmaz. randomUUID importı
 * kullanılmadığı için brief notuyla kaldırıldı.
 */
export class LlmEnsembleStage implements ReviewStage {
  readonly name = 'llm-ensemble';
  readonly kind = 'advisory' as const;
  constructor(private readonly primary: ReviewStage, private readonly alt: ReviewStage, private readonly policy: Policy) {}

  async evaluate(ctx: ReviewContext): Promise<StageResult> {
    const t0 = Date.now();
    const r1 = await this.primary.evaluate(ctx);
    const runAlt = r1.findings.length > 0 || ctx.riskScore >= this.policy.ensembleRiskThreshold;
    const r2 = runAlt ? await this.alt.evaluate(ctx) : null;
    const byKey = new Map<string, Finding>();
    for (const f of [...r1.findings, ...(r2?.findings ?? [])]) {
      const cur = byKey.get(key(f));
      if (!cur) { byKey.set(key(f), f); continue; }
      const survivor = rank(f) < rank(cur) ? f : cur;
      byKey.set(key(f), survivor);
      survivor.corroborated = true; // işaretleme RAW bulgu üzerinde, pipeline dedupe'ünden ÖNCE
    }
    const findings = [...byKey.values()];
    const status = r1.status === 'error' && (r2?.status ?? 'error') === 'error' ? 'error' : 'pass';
    return { status, findings, durationMs: Date.now() - t0, ...(r1.status === 'error' || r2?.status === 'error' ? { errorMessage: 'ensemble: bir reviewer hata verdi' } : {}) };
  }
}
