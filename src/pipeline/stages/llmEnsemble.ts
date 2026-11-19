import type { ReviewStage, ReviewContext, StageResult } from '../../contracts/review.js';
import type { Finding } from '../../contracts/schemas.js';
import type { Policy } from '../../config/config.js';
import { findingKey, severityRank } from '../findingUtils.js';

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
 *
 * I2 (final fix wave, spec R2 "iki reviewer da işaretledi"): corroborated bayrağı yalnızca kopyanın
 * KAYNAĞI kazananın stage'inden FARKLI bir stage ise set edilir — spec R2 doğrulama kanıtı iki
 * BAĞIMSIZ reviewer (farklı stage) arasındaki uzlaşmadır; aynı stage'in kendi içindeki kopyası
 * (aynı anahtar, farklı id) kanıt değildir ve bayrak false kalır. Anahtar+şiddet kuralı paylaşılan
 * findingUtils'ten gelir (Minor #4: llmEnsemble/pipeline kopyasının sürüklenme riski giderildi).
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
      const cur = byKey.get(findingKey(f));
      if (!cur) { byKey.set(findingKey(f), f); continue; }
      const survivor = severityRank(f) < severityRank(cur) ? f : cur;
      const loser = survivor === f ? cur : f;
      byKey.set(findingKey(f), survivor);
      // I2 (R2): kanıt yalnız ÇAPRAZ-STAGE uzlaşmadır — kopya kazananın stage'iyle aynıysa
      // (aynı reviewer'ın kendi tekrarı) corroborated bayrağı DOKUNULMAZ, false kalır.
      // İşaretleme RAW bulgu üzerinde, pipeline dedupe'ünden ÖNCE.
      if (loser.stage !== survivor.stage) survivor.corroborated = true;
    }
    const findings = [...byKey.values()];
    const status = r1.status === 'error' && (r2?.status ?? 'error') === 'error' ? 'error' : 'pass';
    return { status, findings, durationMs: Date.now() - t0, ...(r1.status === 'error' || r2?.status === 'error' ? { errorMessage: 'ensemble: bir reviewer hata verdi' } : {}) };
  }
}
