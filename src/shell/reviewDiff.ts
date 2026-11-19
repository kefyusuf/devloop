import type { Finding } from '../contracts/schemas.js';
import type { ReviewContext } from '../contracts/review.js';
import type { ReviewPipeline } from '../pipeline/pipeline.js';
import type { VerdictStore } from '../store/store.js';
import type { Policy } from '../config/config.js';

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

export async function runReviewDiff(args: {
  diffText: string; taskSpecId: string; pipeline: ReviewPipeline; store: VerdictStore;
  policy: Policy; repoPath: string;
}): Promise<{ exitCode: 0 | 1 | 2; gateFailed: string | null; findings: Finding[] }> {
  const files = parseDiff(args.diffText).map((f) => ({ path: f.path, content: f.addedContent }));
  const artifact = { diff: args.diffText, intent: 'ci-review', rejectedAlternatives: [], testEvidence: 'ci', files };
  const runId = `ci-${args.taskSpecId}`;
  const taskSpec = { id: args.taskSpecId, description: 'CI review-diff', acceptanceCriteria: ['gates pass'], filesScope: [] };
  const picked = await args.store.append('TaskPicked', runId, args.taskSpecId, 'ci', { taskSpec });
  // Hüküm: brief `parentTaskEventId: 'ci'` literal'i yazıyordu — A3 nedensel bütünlük
  // (validateChain) tüm parent*EventId referanslarının GERÇEK event'lere işaret etmesini zorunlu
  // kılar; orchestrator'daki gibi gerçek TaskPicked event_id'si kullanılır.
  const art = await args.store.append('ArtifactProduced', runId, args.taskSpecId, 'ci', { artifact, parentTaskEventId: picked.event_id });
  // ReviewContext tipi: RiskTriageStage riskScore/riskSignals'ı BU nesneye yazar — RiskScored
  // event'i gerçek skorla yazılır (brief'in tip'siz literal'i riskSignals alanını göremiyordu).
  const ctx: ReviewContext = { taskSpec, artifact, repoPath: args.repoPath, riskScore: 0 };
  const result = await args.pipeline.run(ctx);
  // T-final D3: StageVerdict payload'u parentArtifactEventId ZORUNLU — spread ile sağlanır.
  for (const v of result.verdicts) await args.store.append('StageVerdict', runId, args.taskSpecId, 'pipeline', { ...v, parentArtifactEventId: art.event_id });
  await args.store.append('RiskScored', runId, args.taskSpecId, 'risk-triage', { score: ctx.riskScore, signals: ctx.riskSignals ?? {}, policyVersion: String(args.policy.version), parentArtifactEventId: art.event_id });
  for (const f of result.findings) await args.store.append('FindingEmitted', runId, args.taskSpecId, f.stage, { finding: f, parentArtifactEventId: art.event_id });
  const exitCode: 0 | 1 | 2 = result.gateFailed !== null ? 1
    : result.findings.some((f) => f.severity === 'critical') ? 1
    : result.findings.length > 0 ? 2 : 0;
  return { exitCode, gateFailed: result.gateFailed, findings: result.findings };
}
