import { createHash } from 'node:crypto';
import type { Finding } from '../contracts/schemas.js';
import type { ReviewContext } from '../contracts/review.js';
import type { ReviewPipeline } from '../pipeline/pipeline.js';
import { RiskTriageStage } from '../pipeline/stages/riskTriage.js';
import { findingKey, severityRank } from '../pipeline/findingUtils.js';
import type { VerdictStore } from '../store/store.js';
import type { Policy } from '../config/config.js';
import { computeGateConfigHash } from '../orchestrator/orchestrator.js';
import { canonicalJson } from '../util/canonicalJson.js'; // R31: policyHash seed key-order duyarlılığı kapanır

/**
 * R6 (faz 2 T8): CI trigger mode — review-diff. Unified diff'ten dosya başına EKLENEN satırları
 * çıkarır; CI'da henüz uygulanmamış bir PR diff'i artifact.files olarak pipeline'a verilir.
 *
 * Kenar durumlar (R14: durum makinesi — bkz. parseDiff gövdesindeki durum dokümantasyonu):
 * - `+++ /dev/null` (silinen dosya — b/ yolu yok): no-path skip — onay çifti kurulamaz, mevcut
 *   kapsam korunur; silinen dosyada `+` satırı bulunmadığından önceki dosyaya yanlış atama oluşmaz.
 * - `--- /dev/null` (yeni dosya): yol kaynağı DEĞİLDİR — yol daima onay satırı `+++ b/<path>`den alınır.
 * - ESKİ DAVRANIŞ KALDIRILDI: artık `--- ` satırları kapsam KAPATMAZ — kapsam yalnız
 *   `--- a/` + `+++ b/` onay çiftiyle DEĞİŞİR; hunk içi tırnaklanmış diff gövdesi içeriktir.
 */
export function parseDiff(diff: string): Array<{ path: string; addedContent: string }> {
  const out = new Map<string, string[]>();
  let current: string | null = null;
  // R14 (faz 3 T8): durum makinesi — eski satır-döngüsü trim() kullandığı için hunk içindeki
  // TIRNAKLANMIŞ diff satırlarını başlık sanıyordu: context ` --- a/x.ts` kapsamı KAPATIYOR,
  // context ` +++ b/x.ts` kapsam ÇALIYOR, eklenen .patch gövdesindeki `++++ b/x.ts` satırı
  // DÜŞÜYORDU (diff-quoting, ör. PR'ın eklediği .patch dosyası). Kural: dosya başlığı DAİMA
  // `--- a/<path>` + hemen ardından `+++ b/<path>` ONAY ÇİFTİDİR; çift onaylanmadan kapsam
  // değişmez. Durumlar:
  // - EXPECT_FILE_HEADER: başlık bölgesi — `diff --git`/`index`/mode satırları yoksayılır.
  // - PENDING: `--- a/<path>` (veya `--- /dev/null`) görüldü — `+++ b/<path>` onayı beklenir;
  //   onay gelmezse satır tırnaklanmış içerik/gürültüdür, kaynak duruma dönülür ve kapsam
  //   DEĞİŞMEZ (hunk içi `--- a/fake.ts` sonraki `+` satırlarını ilk dosyaya akıtır). Hunk
  //   içindeki gerçek başlık çifti de yeni dosya açar (gerçek diff'ler hunk sonrası daima
  //   yeni dosya başlığıyla başlar — sözleşme maddesi bu yolla karşılanır).
  // - IN_HUNK: `+`-önekli HER satır içeriktir — içeriği `+`, `---`, `+++` ile başlayanlar dahil
  //   (kodlanmış biçimleri `+…`, `+---…`, `++++…`). `/dev/null` başlıkları (`--- /dev/null`,
  //   `+++ /dev/null`) yolsuz olduğundan skip edilir (belgeli).
  type State = 'EXPECT_FILE_HEADER' | 'PENDING' | 'IN_HUNK';
  let state: State = 'EXPECT_FILE_HEADER';
  let pendingFrom: State = 'EXPECT_FILE_HEADER'; // onaysız başlıkta dönülecek kaynak durum
  // Regex'ler trim'siz, satır başına çapalı — trim tabanlı eşleşme yukarıdaki tuzağın ta kendisiydi.
  // R22 (faz 4 T3): header regex'leri trailing whitespace toleranslı (`[ \t]*$`) — malformed
  // diff'lerdeki `--- a/x.ts ` / `+++ b/x.ts ` satırları başlık sayılır; yol duyarlılığı korunur
  // (trailing boşluk yola sızmaz). CRLF zaten satır bazında `\r` strip'iyle işlenir.
  const reDel = /^--- (?:a\/(.+?)[ \t]*|\/dev\/null[ \t]*)$/; // başlık adayı (yalnız onay çiftiyle kapsam açar)
  // R31 (faz 6 T1): `/dev/null` dalı da trailing-ws toleranslı — reDevNull (R26e, faz 5 T6) ile
  // simetri. Önceki regex ws'li `--- /dev/null ` satırını header adayı SAYMIYOR, hunk içinde
  // ardından gelen `+++ b/new.ts` İÇERİK sanılıp `++ b/new.ts` olarak önceki dosyaya akıyordu.
  const reAdd = /^\+\+\+ b\/(.+?)[ \t]*$/;              // onay satırı
  // R26e (faz 5 T6): reDevNull da R22 ailesine katıldı — `+++ /dev/null ` (trailing ws) başlık
  // sayılmıyordu; hunk içindeki ws'li satır İÇERİK sanılıp `++ /dev/null` olarak önceki dosyaya akıyordu.
  const reDevNull = /^\+\+\+ \/dev\/null[ \t]*$/; // silinen dosya: yol yok (trailing ws toleranslı)
  const open = (path: string): void => { current = path; out.set(path, out.get(path) ?? []); };
  for (const raw of diff.split('\n')) {
    const line = raw.replace(/\r$/, ''); // CRLF toleransı (eski kod trim ile klasifiye ediyordu)
    if (state === 'PENDING') {
      const a = reAdd.exec(line);
      if (a) { open(a[1]); state = 'IN_HUNK'; continue; }        // onay → yeni kapsam
      if (reDevNull.test(line)) { state = 'IN_HUNK'; continue; } // `+++ /dev/null` — skip (belgeli)
      if (reDel.test(line)) { state = 'PENDING'; continue; }     // üst üste başlık adayı → yeni onay penceresi
      // Onay gelmedi → `--- a/` başlık DEĞİL: kaynak durumun kuralıyla BU satırı değerlendir.
      if (pendingFrom === 'IN_HUNK') {
        state = 'IN_HUNK';
        if (current !== null && line.startsWith('+')) out.get(current)?.push(line.slice(1)); // içerik ilk dosyaya akar
      } else {
        state = 'EXPECT_FILE_HEADER';
        const a2 = reAdd.exec(line); // reDel yeniden denenmez — bu satır için onay zaten reddedildi
        if (a2) { open(a2[1]); state = 'IN_HUNK'; }
        else if (line.startsWith('@@')) state = 'IN_HUNK'; // tolerans: başlıksız @@ → hunk
      }
      continue;
    }
    if (state === 'EXPECT_FILE_HEADER') {
      if (reDel.test(line)) { pendingFrom = 'EXPECT_FILE_HEADER'; state = 'PENDING'; continue; }
      const a = reAdd.exec(line);
      if (a) { open(a[1]); state = 'IN_HUNK'; continue; } // tolerans: çiftsiz `+++ b/` açılışı
      if (reDevNull.test(line)) continue;                 // `+++ /dev/null` — skip (belgeli)
      if (line.startsWith('@@')) state = 'IN_HUNK';       // tolerans: başlıksız @@ → hunk
      continue;                                           // `diff --git`, `index`, mode … yoksayılır
    }
    // IN_HUNK: `+`-önekli her satır içerik; yalnız başlık adayı çifti ve `/dev/null` başlıkları hariç.
    if (reDel.test(line)) { pendingFrom = 'IN_HUNK'; state = 'PENDING'; continue; } // yeni dosya adayı
    if (reDevNull.test(line)) continue; // `+++ /dev/null` — içerik DEĞİL (belgeli skip)
    if (current !== null && line.startsWith('+')) out.get(current)?.push(line.slice(1)); // `+`, `+---`, `++++` … hepsi içerik
    // ` `, `-`, `@@`, `diff --git` … yoksayılır (eski kodun trim tuzağı burada imkansız)
  }
  return [...out.entries()].map(([path, lines]) => ({ path, addedContent: lines.join('\n') }));
}

/**
 * R11 (faz 3 T5): risk-tiered CI derinliği — ÇİFT pipeline. RiskTriageStage ÖNCE tek başına koşar
 * (risk skorunu hesaplar); skor < policy.ciEnsembleRiskThreshold → gatePipeline (ensemble'sız —
 * low-risk CI koşumu LLM harcamaz), değilse → fullPipeline (gates + llm-ensemble). Çıkış sözleşmesi
 * ve event zinciri (TaskPicked→ArtifactProduced→StageVerdicts→RiskScored→FindingEmitted) aynen korunur.
 * R15 (faz 3 T9): RunStarted.configSnapshot.gates = SEÇİLEN pipeline'ın etkin stage kümesi
 * (stageNames) — ham policy gates'i DEĞİL; snapshot koşulan kümeyle birebir uyumlu (T5 ertelenen
 * minor'un kapanışı). Hüküm: RunStarted artık triaj+seçim SONRASI yazılır (koşumun ilk store event'i
 * olma özelliği korunur) — config'i bozuk pipeline artık hiçbir event yazmadan daha ERKEN throw eder.
 */
export async function runReviewDiff(args: {
  diffText: string; taskSpecId: string; gatePipeline: ReviewPipeline; fullPipeline: ReviewPipeline; store: VerdictStore;
  policy: Policy; repoPath: string;
}): Promise<{ exitCode: 0 | 1 | 2; gateFailed: string | null; findings: Finding[] }> {
  const files = parseDiff(args.diffText).map((f) => ({ path: f.path, content: f.addedContent }));
  const artifact = { diff: args.diffText, intent: 'ci-review', rejectedAlternatives: [], testEvidence: 'ci', files };
  const runId = `ci-${args.taskSpecId}`;
  const taskSpec = { id: args.taskSpecId, description: 'CI review-diff', acceptanceCriteria: ['gates pass'], filesScope: [] };
  // ReviewContext tipi: RiskTriageStage riskScore/riskSignals'ı BU nesneye yazar — RiskScored
  // event'i gerçek skorla yazılır (brief'in tip'siz literal'i riskSignals alanını göremiyordu).
  const ctx: ReviewContext = { taskSpec, artifact, repoPath: args.repoPath, riskScore: 0 };
  // R11 (faz 3 T5): 1. Risk triajı ÖNCE tek başına koşar — risk skorunu hesaplar.
  const triage = new RiskTriageStage(args.policy);
  const triageResult = await triage.evaluate(ctx);
  // 2. risk < ciEnsembleRiskThreshold → gatePipeline; değilse fullPipeline.
  const chosen = ctx.riskScore < args.policy.ciEnsembleRiskThreshold ? args.gatePipeline : args.fullPipeline;
  // I3 (final fix wave, A6/R4a): CI koşumları da RunStarted kanıtıyla açılır — policyHash (resume
  // karşılaştırması) ve gateConfigHash (kanıt; orchestrator'daki ifadelerin birebir aynısı) kanıta
  // yazılır. Idempotent: aynı runId için RunStarted zaten varsa (tekrarlı CI koşumu) ikinci kez yazılmaz.
  // R15 hüküm (faz 3 T9): kanıt SEÇİM sonrası yazılır — configSnapshot.gates = SEÇİLEN pipeline'ın
  // etkin stage kümesi (chosen.stageNames()); low-risk koşumda llm-ensemble YOK, high-risk'te VAR.
  // Koşumun ilk store event'i olma özelliği korunur (RunStarted → TaskPicked → …).
  if (args.store.query({ runId, type: 'RunStarted' }).length === 0) {
    // hüküm: R31 policyHash canonicalJson seed — hash DEĞERLERİ değişimi bilinçli (policy
    // çok-anahtarlı); key-order determinizmi kazanılır.
    const policyHash = createHash('sha256').update(canonicalJson(args.policy)).digest('hex').slice(0, 16);
    await args.store.append('RunStarted', runId, args.taskSpecId, 'ci', {
      configSnapshot: {
        policyHash,
        gateConfigHash: computeGateConfigHash(args.repoPath),
        model: args.policy.llm.model,
        budgetUsd: args.policy.budgetUsd,
        gates: chosen.stageNames(),
      },
    });
  }
  const picked = await args.store.append('TaskPicked', runId, args.taskSpecId, 'ci', { taskSpec });
  // Hüküm: brief `parentTaskEventId: 'ci'` literal'i yazıyordu — A3 nedensel bütünlük
  // (validateChain) tüm parent*EventId referanslarının GERÇEK event'lere işaret etmesini zorunlu
  // kılar; orchestrator'daki gibi gerçek TaskPicked event_id'si kullanılır.
  const art = await args.store.append('ArtifactProduced', runId, args.taskSpecId, 'ci', { artifact, parentTaskEventId: picked.event_id });
  const result = await chosen.run(ctx);
  // Bağımsız triaj koşumunun KENDİ StageVerdict'i (koşum sırasına göre ilk — risk-triage her koşumda
  // 'pass' döner; skor hesaplama gate'i değil, bulguları advisory niteliğindedir).
  await args.store.append('StageVerdict', runId, args.taskSpecId, 'risk-triage', { stage: 'risk-triage', status: triageResult.status, durationMs: triageResult.durationMs, parentArtifactEventId: art.event_id });
  // T-final D3: StageVerdict payload'u parentArtifactEventId ZORUNLU — spread ile sağlanır.
  for (const v of result.verdicts) await args.store.append('StageVerdict', runId, args.taskSpecId, 'pipeline', { ...v, parentArtifactEventId: art.event_id });
  await args.store.append('RiskScored', runId, args.taskSpecId, 'risk-triage', { score: ctx.riskScore, signals: ctx.riskSignals ?? {}, policyVersion: String(args.policy.version), parentArtifactEventId: art.event_id });
  // R11 hüküm: triaj bulguları seçilen pipeline'ın DIŞINDA koştuğu için buradan kanıta akar (test-diff
  // bulguları yok olmasın). fullPipeline'da RiskTriageStage pipeline içinde de koşar → aynı test-diff
  // bulgusu iki kaynaktan gelir; §5.2.4 anahtar kuralı (file+line+category, en şiddetli birebir korunur)
  // kopyayı düşürür — FindingEmitted tek, stage 'risk-triage'.
  const byKey = new Map<string, Finding>();
  for (const f of [...triageResult.findings, ...result.findings]) {
    const cur = byKey.get(findingKey(f));
    if (!cur || severityRank(f) < severityRank(cur)) byKey.set(findingKey(f), f);
  }
  const findings = [...byKey.values()].sort((a, b) => severityRank(a) - severityRank(b));
  for (const f of findings) await args.store.append('FindingEmitted', runId, args.taskSpecId, f.stage, { finding: f, parentArtifactEventId: art.event_id });
  const exitCode: 0 | 1 | 2 = result.gateFailed !== null ? 1
    : findings.some((f) => f.severity === 'critical') ? 1
    : findings.length > 0 ? 2 : 0;
  return { exitCode, gateFailed: result.gateFailed, findings };
}
