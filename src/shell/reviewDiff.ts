import { createHash } from 'node:crypto';
import type { Finding } from '../contracts/schemas.js';
import type { ReviewContext } from '../contracts/review.js';
import type { ReviewPipeline } from '../pipeline/pipeline.js';
import { RiskTriageStage } from '../pipeline/stages/riskTriage.js';
import { findingKey, severityRank } from '../pipeline/findingUtils.js';
import type { VerdictStore } from '../store/store.js';
import type { Policy } from '../config/config.js';
import { computeGateConfigHash } from '../orchestrator/orchestrator.js';

/**
 * R6 (faz 2 T8): CI trigger mode — review-diff. Unified diff'ten dosya başına EKLENEN satırları
 * çıkarır; CI'da henüz uygulanmamış bir PR diff'i artifact.files olarak pipeline'a verilir.
 *
 * Kenar durumlar:
 * - `+++ /dev/null` (silinen dosya — b/ yolu yok): no-path skip. Regex eşleşmez, mevcut kapsam
 *   korunur; silinen dosyada `+` satırı bulunmadığından önceki dosyaya yanlış atama oluşmaz.
 * - `--- /dev/null` (yeni dosya): yol kaynağı DEĞİLDİR — yol daima `+++ b/<path>` satırından alınır;
 *   a/ olmayan `--- ` satırı mevcut dosya kapsamını kapatır (hunk içeriği bir önceki dosyaya sızmaz).
 */
export function parseDiff(diff: string): Array<{ path: string; addedContent: string }> {
  const out = new Map<string, string[]>();
  let current: string | null = null;
  for (const line of diff.split('\n')) {
    const h = /^\+\+\+ b\/(.+)$/.exec(line.trim());
    if (h) { current = h[1]; out.set(current, out.get(current) ?? []); continue; }
    if (current && line.startsWith('+') && !line.startsWith('+++')) out.get(current)!.push(line.slice(1));
    if (/^--- /.test(line.trim()) && !line.startsWith('--- a/')) current = null;
  }
  return [...out.entries()].map(([path, lines]) => ({ path, addedContent: lines.join('\n') }));
}

/**
 * R11 (faz 3 T5): risk-tiered CI derinliği — ÇİFT pipeline. RiskTriageStage ÖNCE tek başına koşar
 * (risk skorunu hesaplar); skor < policy.ciEnsembleRiskThreshold → gatePipeline (ensemble'sız —
 * low-risk CI koşumu LLM harcamaz), değilse → fullPipeline (gates + llm-ensemble). Çıkış sözleşmesi
 * ve event zinciri (TaskPicked→ArtifactProduced→StageVerdicts→RiskScored→FindingEmitted) aynen korunur.
 */
export async function runReviewDiff(args: {
  diffText: string; taskSpecId: string; gatePipeline: ReviewPipeline; fullPipeline: ReviewPipeline; store: VerdictStore;
  policy: Policy; repoPath: string;
}): Promise<{ exitCode: 0 | 1 | 2; gateFailed: string | null; findings: Finding[] }> {
  const files = parseDiff(args.diffText).map((f) => ({ path: f.path, content: f.addedContent }));
  const artifact = { diff: args.diffText, intent: 'ci-review', rejectedAlternatives: [], testEvidence: 'ci', files };
  const runId = `ci-${args.taskSpecId}`;
  const taskSpec = { id: args.taskSpecId, description: 'CI review-diff', acceptanceCriteria: ['gates pass'], filesScope: [] };
  // I3 (final fix wave, A6/R4a): CI koşumları da RunStarted kanıtıyla açılır — policyHash (resume
  // karşılaştırması) ve gateConfigHash (kanıt; orchestrator'daki ifadelerin birebir aynısı) kanıta
  // yazılır. Idempotent: aynı runId için RunStarted zaten varsa (tekrarlı CI koşumu) ikinci kez yazılmaz.
  if (args.store.query({ runId, type: 'RunStarted' }).length === 0) {
    const policyHash = createHash('sha256').update(JSON.stringify(args.policy)).digest('hex').slice(0, 16);
    await args.store.append('RunStarted', runId, args.taskSpecId, 'ci', {
      configSnapshot: {
        policyHash,
        gateConfigHash: computeGateConfigHash(args.repoPath),
        model: args.policy.llm.model,
        budgetUsd: args.policy.budgetUsd,
      },
    });
  }
  const picked = await args.store.append('TaskPicked', runId, args.taskSpecId, 'ci', { taskSpec });
  // Hüküm: brief `parentTaskEventId: 'ci'` literal'i yazıyordu — A3 nedensel bütünlük
  // (validateChain) tüm parent*EventId referanslarının GERÇEK event'lere işaret etmesini zorunlu
  // kılar; orchestrator'daki gibi gerçek TaskPicked event_id'si kullanılır.
  const art = await args.store.append('ArtifactProduced', runId, args.taskSpecId, 'ci', { artifact, parentTaskEventId: picked.event_id });
  // ReviewContext tipi: RiskTriageStage riskScore/riskSignals'ı BU nesneye yazar — RiskScored
  // event'i gerçek skorla yazılır (brief'in tip'siz literal'i riskSignals alanını göremiyordu).
  const ctx: ReviewContext = { taskSpec, artifact, repoPath: args.repoPath, riskScore: 0 };
  // R11 (faz 3 T5): 1. Risk triajı ÖNCE tek başına koşar — risk skorunu hesaplar.
  const triage = new RiskTriageStage(args.policy);
  const triageResult = await triage.evaluate(ctx);
  // 2. risk < ciEnsembleRiskThreshold → gatePipeline; değilse fullPipeline.
  const chosen = ctx.riskScore < args.policy.ciEnsembleRiskThreshold ? args.gatePipeline : args.fullPipeline;
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
