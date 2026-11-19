// R10 (faz 3 T4): L3 evrim — golden eval eşikli aday üretimi, shadow aday yazımı ve
// golden-gerileme kapılı apply. A5 hükmü: apply YALNIZ playbook staging dosyası (+ ProposalCreated
// kanıt event'i) yazar — policy, lint kuralı, lessons.md gibi üretim config'ine otomatik yazım YOK;
// staging dosyası insan devreye alma noktasıdır.
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { VerdictStore } from '../store/store.js';
import type { EvalSummary } from '../eval/evalRunner.js';
import type { DevloopEvent } from '../contracts/events.js';

export interface EvolutionCandidate {
  evoId: string;
  kind: 'playbook-reviewer' | 'playbook-generator' | 'policy-tweak';
  title: string;
  content: Record<string, unknown>;
  sourceEvalId: string;
}

export interface EvolveContext {
  store: VerdictStore;
  playbookDir: string;   // <repo>/.devloop/playbooks — apply yazım hedefi (A5 staging)
  candidateDir: string;  // <repo>/.devloop/candidates — shadow aday yazımı
  goldenCount: number;   // loadGoldenTasks(repoPath).tasks.length
  l3MinGoldenTasks: number;
}

export function generateEvolutionCandidates(ctx: EvolveContext, baseline: EvalSummary): EvolutionCandidate[] {
  if (ctx.goldenCount < ctx.l3MinGoldenTasks) return []; // R10 eşik
  // Fix round 1 (sinyal kirliliği): candidate-labeled (shadow/eval) koşumların kanıtları sinyal
  // SAYILMAZ — lastEvalRun'ın production filtresiyle aynı kural ('candidate' configSnapshot'ta
  // var). Aksi halde feature'ın KENDİ shadow koşumları (risk-triage test-diff bulguları runEval
  // ile FindingEmitted olarak yazılır) 2. evolve --shadow'dan sonra kendi kendine playbook-
  // generator adayı üretir (self-noise). Karar bucket'larına da aynı filtre uygulanır — bugün
  // shadow koşumda HumanDecision oluşmaz ama invariant açık ve geleceğe hazır olsun.
  const shadowRunIds = new Set(ctx.store.query({ type: 'EvalRun' })
    .filter((e): e is Extract<DevloopEvent, { type: 'EvalRun' }> => e.type === 'EvalRun' && 'candidate' in e.payload.configSnapshot)
    .map((e) => e.run_id));
  const decisions = ctx.store.query({ type: 'HumanDecision' }).filter((e) => !shadowRunIds.has(e.run_id));
  const findings = ctx.store.query({ type: 'FindingEmitted' })
    .filter((e): e is Extract<DevloopEvent, { type: 'FindingEmitted' }> => e.type === 'FindingEmitted') // union daraltma (strict tsc — learn.ts ile aynı desen)
    .filter((e) => !shadowRunIds.has(e.run_id));
  const byFinding = new Map<string, string>(findings.map((e): [string, string] => [e.event_id, e.payload.finding.category]));
  const buckets = new Map<string, { rejects: string[]; runs: Set<string>; decisionIds: string[] }>();
  for (const d of decisions) {
    if (d.type !== 'HumanDecision') continue;
    if (d.payload.decision !== 'reject') continue;
    const category = d.payload.parentFindingEventIds.map((id) => byFinding.get(id)).find(Boolean) ?? 'unknown';
    const b = buckets.get(category) ?? { rejects: [], runs: new Set<string>(), decisionIds: [] };
    b.rejects.push(d.payload.reason);
    b.runs.add(d.run_id);
    b.decisionIds.push(d.event_id);
    buckets.set(category, b);
  }
  const out: EvolutionCandidate[] = [];
  const id = (seed: string) => createHash('sha256').update(seed).digest('hex').slice(0, 16);
  for (const [category, b] of buckets) {
    if (b.rejects.length < 2 || b.runs.size < 3) continue;
    out.push({
      evoId: id(`playbook-reviewer:${category}:${b.decisionIds.sort().join('|')}`),
      kind: 'playbook-reviewer',
      title: `"${category}" false-positive tekrarı — reviewer playbook yumuşatma önerisi`,
      content: { category, note: 'reviewer rubriğinde bu kategori için kanıt eşiği yükseltilmeli (shadow doğrulandı)', sourceDecisionIds: [...b.decisionIds].sort() },
      sourceEvalId: baseline.evalId,
    });
  }
  // test-diff pattern: FindingEmitted category 'test-diff' ≥ 2 farklı koşumda → generator playbook notu
  const testDiffRuns = new Set(findings.filter((e) => e.payload.finding.category === 'test-diff').map((e) => e.run_id));
  if (testDiffRuns.size >= 2) {
    out.push({
      evoId: id(`playbook-generator:test-diff:${testDiffRuns.size}`),
      kind: 'playbook-generator',
      title: 'test-diff blokları tekrarlıyor — generator playbook notu',
      content: { note: 'generator kabul kriterlerine test uyumu maddesi eklenebilir' },
      sourceEvalId: baseline.evalId,
    });
  }
  return out;
}

export function writeShadowCandidates(ctx: EvolveContext, candidates: EvolutionCandidate[]): void {
  mkdirSync(ctx.candidateDir, { recursive: true });
  for (const c of candidates) writeFileSync(join(ctx.candidateDir, `${c.evoId}.json`), JSON.stringify(c, null, 2), 'utf8');
}

export async function applyEvolution(ctx: EvolveContext, candidate: EvolutionCandidate, shadowEval: EvalSummary, baseline: EvalSummary): Promise<DevloopEvent> {
  // Golden-gerileme kapısı: shadow eval baseline'dan ÇOK golden kırıyorsa apply reddedilir —
  // kapı throw'u TÜM yazımlardan ÖNCEdir (staging dosyası da ProposalCreated event'i de yazılmaz).
  if (shadowEval.failed > baseline.failed) {
    throw new Error(`Evolve reddedildi: golden gerileme (baseline failed=${baseline.failed}, shadow failed=${shadowEval.failed})`);
  }
  const ev = await ctx.store.append('ProposalCreated', 'learning', '-', 'learning', {
    proposalId: candidate.evoId, kind: candidate.kind, category: candidate.kind,
    title: candidate.title, content: candidate.content, parentDecisionEventIds: [],
  });
  mkdirSync(ctx.playbookDir, { recursive: true });
  writeFileSync(join(ctx.playbookDir, `${candidate.evoId}.json`), JSON.stringify(candidate, null, 2), 'utf8'); // A5 staging — insan devreye alır
  return ev;
}

export function loadCandidate(ctx: EvolveContext, evoId: string): EvolutionCandidate | null {
  const p = join(ctx.candidateDir, `${evoId}.json`);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, 'utf8')) as EvolutionCandidate;
}

export interface PlaybookProvider { reviewerContext(): string }

export function candidatePlaybookProvider(ctx: EvolveContext): PlaybookProvider {
  // candidate/ dizinindeki playbook-reviewer adaylarının content.note'larını birleştirir
  const notes: string[] = [];
  if (existsSync(ctx.candidateDir)) {
    for (const f of readdirSync(ctx.candidateDir)) {
      if (!f.endsWith('.json')) continue;
      try { const c = JSON.parse(readFileSync(join(ctx.candidateDir, f), 'utf8')); if (c.kind === 'playbook-reviewer') notes.push(`- ${c.title}`); } catch { /* bozuk aday atılır */ }
    }
  }
  return { reviewerContext: () => notes.length === 0 ? 'Reviewer playbook önerisi yok.' : notes.map((n) => `- ${n}`).join('\n') };
}
