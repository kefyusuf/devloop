import { createHash } from 'node:crypto';
import type { VerdictStore } from '../store/store.js';
import type { LessonMemory } from '../memory/memory.js';

export interface CandidateLesson {
  lessonId: string; rule: string; scope: string; confidence: number;
  targetComponent: 'generator' | 'reviewer';
  parentDecisionEventIds: string[]; pattern: 'repeated-false-positive' | 'repeated-real-issue';
}

/** v1 deterministik aday üretimi (spec §6 faz 1). lessonId = sha256(pattern + sıralı karar IDs) — karar seti değişmedikçe sabit. */
export function generateCandidates(store: VerdictStore): CandidateLesson[] {
  const decisions = store.query({ type: 'HumanDecision' });
  const byFinding = new Map<string, string>();
  for (const e of store.query({ type: 'FindingEmitted' })) {
    if (e.type !== 'FindingEmitted') continue; // union daraltma (strict tsc — memory.ts ile aynı desen)
    byFinding.set(e.event_id, e.payload.finding.category);
  }

  const buckets = new Map<string, { reasons: Map<string, number>; decisionIds: string[] }>();
  for (const d of decisions) {
    if (d.type !== 'HumanDecision') continue; // union daraltma (strict tsc)
    const category = d.payload.parentFindingEventIds.map((id) => byFinding.get(id)).find(Boolean) ?? 'unknown';
    const b = buckets.get(category) ?? { reasons: new Map<string, number>(), decisionIds: [] as string[] };
    b.reasons.set(d.payload.reason, (b.reasons.get(d.payload.reason) ?? 0) + 1);
    b.decisionIds.push(d.event_id);
    buckets.set(category, b);
  }

  const out: CandidateLesson[] = [];
  const makeId = (pattern: string, ids: string[]) =>
    createHash('sha256').update(`${pattern}:${[...ids].sort().join('|')}`).digest('hex').slice(0, 16);

  for (const [category, b] of buckets) {
    if ((b.reasons.get('false-positive') ?? 0) >= 2) {
      out.push({ pattern: 'repeated-false-positive', targetComponent: 'reviewer',
        lessonId: makeId('repeated-false-positive', b.decisionIds),
        rule: `Reviewer "${category}" kategorisinde tekrarlayan false-positive üretiyor. Bu kategoride bulgu raporlamadan önce kanıt eşiğini yükselt; şiddeti bir kademe düşürmeyi değerlendir.`,
        scope: 'review-rubric', confidence: 0.7, parentDecisionEventIds: b.decisionIds });
    }
    if ((b.reasons.get('real-issue-accepted') ?? 0) >= 2) {
      out.push({ pattern: 'repeated-real-issue', targetComponent: 'reviewer',
        lessonId: makeId('repeated-real-issue', b.decisionIds),
        rule: `"${category}" kategorisindeki bulgular tekrarlayan şekilde gerçek çıktı ve kabul edildi. Bu kategori güçlü sinyal; rubrikte önceliğini koru.`,
        scope: 'review-rubric', confidence: 0.8, parentDecisionEventIds: b.decisionIds });
    }
  }
  return out;
}

export async function confirmCandidate(store: VerdictStore, memory: LessonMemory, c: CandidateLesson) {
  const ev = await memory.appendLesson({
    lessonId: c.lessonId, rule: c.rule, scope: c.scope, confidence: c.confidence,
    status: 'active', targetComponent: c.targetComponent, parentDecisionEventIds: c.parentDecisionEventIds,
  });
  memory.render();
  return ev;
}
