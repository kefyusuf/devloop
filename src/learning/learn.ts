import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { VerdictStore } from '../store/store.js';
import type { LessonMemory } from '../memory/memory.js';
import type { DevloopEvent, EventPayloadMap } from '../contracts/events.js';

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
  // I4 (final review): retire edilmiş ders ID'leri aday listesine dönmez — lessonId deterministik
  // olduğundan aynı karar seti tombstone yazıldıktan sonra da AYNI ID'yi üretir; LessonMemory ile
  // aynı projeksiyon (lessonId başına SON status kazanır) üzerinden retired kümesi filtreler.
  const latestLesson = new Map<string, EventPayloadMap['LessonLearned']>();
  for (const ev of store.query({ type: 'LessonLearned' })) {
    if (ev.type !== 'LessonLearned') continue; // union daraltma (strict tsc)
    latestLesson.set(ev.payload.lessonId, ev.payload);
  }
  const retiredIds = new Set([...latestLesson.values()].filter((l) => l.status === 'retired').map((l) => l.lessonId));
  return out.filter((c) => !retiredIds.has(c.lessonId));
}

export async function confirmCandidate(store: VerdictStore, memory: LessonMemory, c: CandidateLesson) {
  const ev = await memory.appendLesson({
    lessonId: c.lessonId, rule: c.rule, scope: c.scope, confidence: c.confidence,
    status: 'active', targetComponent: c.targetComponent, parentDecisionEventIds: c.parentDecisionEventIds,
  });
  memory.render();
  return ev;
}

// R5 (faz 2 T7): L2 kural indüksiyonu — reject-only kararlar kategoriye göre gruplanır; ≥2 ret +
// ≥3 ayrı koşum + global karar eşiği (l2MinDecisions) geçilince deterministik lint-rule önerisi.
export interface Proposal {
  proposalId: string; kind: 'lint-rule' | 'regression-test' | 'policy-tweak';
  category: string; title: string; content: Record<string, unknown>; parentDecisionEventIds: string[];
}

export function generateProposals(store: VerdictStore, l2MinDecisions: number): Proposal[] {
  const decisions = store.query({ type: 'HumanDecision' });
  if (decisions.length < l2MinDecisions) return [];
  const applied = new Set<string>();
  for (const e of store.query({ type: 'ProposalCreated' })) {
    if (e.type !== 'ProposalCreated') continue; // union daraltma (strict tsc — memory.ts ile aynı desen)
    applied.add(e.payload.proposalId);
  }
  const byFinding = new Map<string, string>();
  for (const e of store.query({ type: 'FindingEmitted' })) {
    if (e.type !== 'FindingEmitted') continue; // union daraltma (strict tsc)
    byFinding.set(e.event_id, e.payload.finding.category);
  }
  const buckets = new Map<string, { rejects: string[]; runs: Set<string>; decisionIds: string[] }>();
  for (const d of decisions) {
    if (d.type !== 'HumanDecision') continue; // union daraltma (strict tsc)
    if (d.payload.decision !== 'reject') continue;
    const category = d.payload.parentFindingEventIds.map((id) => byFinding.get(id)).find(Boolean) ?? 'unknown';
    const b = buckets.get(category) ?? { rejects: [], runs: new Set<string>(), decisionIds: [] };
    b.rejects.push(d.payload.reason);
    b.runs.add(d.run_id);
    b.decisionIds.push(d.event_id);
    buckets.set(category, b);
  }
  const out: Proposal[] = [];
  const id = (kind: string, cat: string, ids: string[]) =>
    createHash('sha256').update(`${kind}:${cat}:${[...ids].sort().join('|')}`).digest('hex').slice(0, 16);
  for (const [category, b] of buckets) {
    if (b.rejects.length < 2 || b.runs.size < 3 || applied.has(id('lint-rule', category, b.decisionIds))) continue;
    out.push({ proposalId: id('lint-rule', category, b.decisionIds), kind: 'lint-rule', category,
      title: `"${category}" bulguları tekrarlıyor — erken yakalayan lint kuralı önerisi`,
      content: { note: 'İnsan onayıyla eslint.config.js kurallarına eklenir; deterministik şablon (faz 2).', category },
      parentDecisionEventIds: b.decisionIds });
  }
  return out;
}

export async function applyProposal(store: VerdictStore, proposalsDir: string, p: Proposal): Promise<DevloopEvent> {
  const ev = await store.append('ProposalCreated', 'learning', p.proposalId, 'learning', {
    proposalId: p.proposalId, kind: p.kind, category: p.category, title: p.title,
    content: p.content, parentDecisionEventIds: p.parentDecisionEventIds,
  });
  const dir = join(proposalsDir, p.proposalId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'PROPOSAL.md'),
    `# ${p.title}\n\nkind: ${p.kind}\ncategory: ${p.category}\n\nİnsan onayı sonrası elle uygulanır — devloop otomatik yazmaz.\n\nDetay: ${JSON.stringify(p.content, null, 2)}\n`, 'utf8');
  return ev;
}
