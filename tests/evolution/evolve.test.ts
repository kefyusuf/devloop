import { describe, it, expect } from 'vitest';
import {
  generateEvolutionCandidates, writeShadowCandidates, applyEvolution,
  loadCandidate, candidatePlaybookProvider, type EvolutionCandidate, type EvolveContext,
} from '../../src/evolution/evolve.js';
import { DevloopEventSchema } from '../../src/contracts/events.js';
import { VerdictStore } from '../../src/store/store.js';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { EvalSummary } from '../../src/eval/evalRunner.js';

const baseSummary = (over: Partial<EvalSummary> = {}): EvalSummary => ({
  evalId: 'base-eval', goldenCount: 60, passed: 60, failed: 0, score: 100,
  perTask: [], configSnapshot: { mode: 'production' }, l3Active: true, ...over,
});

const makeCtx = (dir: string, over: Partial<EvolveContext> = {}): EvolveContext => ({
  store: new VerdictStore(join(dir, 'events.jsonl')),
  playbookDir: join(dir, 'playbooks'),
  candidateDir: join(dir, 'candidates'),
  goldenCount: 60,
  l3MinGoldenTasks: 50,
  ...over,
});

// 3 ayrı koşumda aynı kategoriye reject (reason: false-positive) — L3 aday eşiği (≥2 ret + ≥3 koşum)
async function seedRejects(store: VerdictStore, category: string, runs: string[]) {
  for (const [i, run] of runs.entries()) {
    const art = await store.append('ArtifactProduced', run, `t${i}`, 'backend', { artifact: { diff: 'x', intent: 'i', rejectedAlternatives: [], testEvidence: '', files: [] }, parentTaskEventId: 'p' });
    const f = await store.append('FindingEmitted', run, `t${i}`, 'llm-reviewer', { finding: { id: `f${i}`, stage: 'llm-reviewer', category, severity: 'required', confidence: 0.9, evidence: { file: 'a.ts', line: i + 1 } }, parentArtifactEventId: art.event_id });
    await store.append('HumanDecision', run, `t${i}`, 'human', { decision: 'reject', reason: 'false-positive', parentFindingEventIds: [f.event_id] });
  }
}

describe('generateEvolutionCandidates (L3 — R10)', () => {
  it('goldenCount < l3MinGoldenTasks → boş (R10 eşik)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'evo-'));
    const ctx = makeCtx(dir, { goldenCount: 10, l3MinGoldenTasks: 50 });
    await seedRejects(ctx.store, 'off-by-one', ['r1', 'r2', 'r3']); // sinyal var ama eşik altı
    expect(generateEvolutionCandidates(ctx, baseSummary())).toEqual([]);
  });

  it('≥2 false-positive reject + ≥3 koşum + l3 aktif → 1 playbook-reviewer adayı; evoId deterministik', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'evo2-'));
    const ctx = makeCtx(dir);
    await seedRejects(ctx.store, 'off-by-one', ['r1', 'r2', 'r3']);
    const out1 = generateEvolutionCandidates(ctx, baseSummary());
    const out2 = generateEvolutionCandidates(ctx, baseSummary());
    expect(out1).toHaveLength(1);
    expect(out1[0].kind).toBe('playbook-reviewer');
    expect(out1[0].title).toContain('off-by-one');
    expect(out1[0].sourceEvalId).toBe('base-eval');
    expect(out1[0].evoId).toBe(out2[0].evoId); // deterministik: iki çağrı aynı ID
  });

  it("FindingEmitted 'test-diff' ≥2 farklı koşum → playbook-generator adayı", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'evo3-'));
    const ctx = makeCtx(dir);
    for (const [i, run] of ['r1', 'r2'].entries()) {
      const art = await ctx.store.append('ArtifactProduced', run, `td${i}`, 'backend', { artifact: { diff: 'x', intent: 'i', rejectedAlternatives: [], testEvidence: '', files: [] }, parentTaskEventId: 'p' });
      await ctx.store.append('FindingEmitted', run, `td${i}`, 'test-gate', { finding: { id: `tf${i}`, stage: 'test-gate', category: 'test-diff', severity: 'required', confidence: 1, evidence: { file: 'a.ts', line: 1 } }, parentArtifactEventId: art.event_id });
    }
    const out = generateEvolutionCandidates(ctx, baseSummary());
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('playbook-generator');
  });
});

describe('applyEvolution (A5 — yalnız playbook staging + event)', () => {
  const candidate: EvolutionCandidate = { evoId: 'evo-abc', kind: 'playbook-reviewer', title: 'T', content: { note: 'n' }, sourceEvalId: 'base-eval' };

  it('shadowEval.failed > baseline.failed → golden gerileme hatası + staging dosyası YAZILMAZ', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'evo4-'));
    const ctx = makeCtx(dir);
    writeShadowCandidates(ctx, [candidate]); // aday dosyası candidates/'ta — staging (playbooks/) değil
    await expect(applyEvolution(ctx, candidate, baseSummary({ evalId: 'shadow-1', failed: 1, score: 98 }), baseSummary()))
      .rejects.toThrow('golden gerileme');
    expect(existsSync(join(ctx.playbookDir, 'evo-abc.json'))).toBe(false); // kapı throw'dan ÖNCE — yazım yok
    expect(ctx.store.query({ type: 'ProposalCreated' })).toHaveLength(0);
  });

  it('gerileme yok → ProposalCreated (kind playbook-reviewer) + staging dosyası var; loadCandidate okur', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'evo5-'));
    const ctx = makeCtx(dir);
    writeShadowCandidates(ctx, [candidate]); // CLI akışıyla aynı: --shadow adayı candidates/'a yazar, apply oradan yükler
    const ev = await applyEvolution(ctx, candidate, baseSummary({ evalId: 'shadow-2', failed: 0 }), baseSummary());
    expect(ev.type).toBe('ProposalCreated');
    if (ev.type !== 'ProposalCreated') return; // union daraltma
    expect(ev.payload.kind).toBe('playbook-reviewer');
    expect(ev.payload.proposalId).toBe('evo-abc');
    expect(existsSync(join(ctx.playbookDir, 'evo-abc.json'))).toBe(true);
    expect(loadCandidate(ctx, 'evo-abc')).toMatchObject({ evoId: 'evo-abc', kind: 'playbook-reviewer' });
    expect(loadCandidate(ctx, 'yok-boyle-aday')).toBeNull();
  });
});

describe('candidatePlaybookProvider (shadow eval reviewerLessons kaynağı)', () => {
  it('playbook-reviewer aday notlarını birleştirir; generator/bozuk dosya atılır; boş dizinde mesaj', () => {
    const dir = mkdtempSync(join(tmpdir(), 'evo-p-'));
    const ctx = makeCtx(dir);
    mkdirSync(ctx.candidateDir, { recursive: true });
    writeFileSync(join(ctx.candidateDir, 'a.json'), JSON.stringify({ kind: 'playbook-reviewer', title: 'Aday A' }), 'utf8');
    writeFileSync(join(ctx.candidateDir, 'b.json'), JSON.stringify({ kind: 'playbook-generator', title: 'Generator B' }), 'utf8');
    writeFileSync(join(ctx.candidateDir, 'broken.json'), '{ bozuk', 'utf8');
    const text = candidatePlaybookProvider(ctx).reviewerContext();
    expect(text).toContain('Aday A');
    expect(text).not.toContain('Generator B');
    const empty = candidatePlaybookProvider(makeCtx(mkdtempSync(join(tmpdir(), 'evo-p2-'))));
    expect(empty.reviewerContext()).toBe('Reviewer playbook önerisi yok.');
  });
});

// (e) Kontrat şema testi: ProposalCreated kind enum'u genişledi — eski kindler korunur, yeniler geçer.
describe('ProposalCreated kind şeması', () => {
  const env = { event_id: 'e1', schema_version: 1, ts: new Date().toISOString(), run_id: 'r', task_id: 't', actor: 'learning' };
  const payload = (kind: string) => ({ proposalId: 'p1', kind, category: 'c', title: 't', content: {}, parentDecisionEventIds: [] });

  it('yeni kindler (playbook-reviewer, playbook-generator) doğrulanır', () => {
    for (const kind of ['playbook-reviewer', 'playbook-generator']) {
      expect(DevloopEventSchema.safeParse({ ...env, type: 'ProposalCreated', payload: payload(kind) }).success).toBe(true);
    }
  });
  it('eski kindler korunur; enum dışı reddedilir', () => {
    expect(DevloopEventSchema.safeParse({ ...env, type: 'ProposalCreated', payload: payload('lint-rule') }).success).toBe(true);
    expect(DevloopEventSchema.safeParse({ ...env, type: 'ProposalCreated', payload: payload('regression-test') }).success).toBe(true);
    expect(DevloopEventSchema.safeParse({ ...env, type: 'ProposalCreated', payload: payload('policy-tweak') }).success).toBe(true);
    expect(DevloopEventSchema.safeParse({ ...env, type: 'ProposalCreated', payload: payload('sihirli') }).success).toBe(false);
  });
});
