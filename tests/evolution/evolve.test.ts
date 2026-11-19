import { describe, it, expect, vi } from 'vitest';
import {
  generateEvolutionCandidates, writeShadowCandidates, applyEvolution,
  loadCandidate, candidatePlaybookProvider, loadAppliedPlaybooks, type EvolutionCandidate, type EvolveContext,
} from '../../src/evolution/evolve.js';
import { DevloopEventSchema } from '../../src/contracts/events.js';
import { VerdictStore } from '../../src/store/store.js';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { EvalSummary } from '../../src/eval/evalRunner.js';
import { LlmReviewerStage } from '../../src/pipeline/stages/llmReviewer.js';
import type { LlmGateway } from '../../src/gateway/gateway.js';
import type { ReviewContext } from '../../src/contracts/review.js';
import { z } from 'zod';

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
    // provenance (faz 2 review Minor #2 kalıntısı): karar event ID'leri content'te taşınır
    const decisionIds = ctx.store.query({ type: 'HumanDecision' }).map((e) => e.event_id).sort();
    expect(out1[0].content.sourceDecisionIds).toEqual(decisionIds);
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

  // Fix round 1 (sinyal kirliliği): shadow/eval koşum bulguları sinyal SAYILMAZ — aksi halde
  // feature'ın KENDİ shadow koşumları (risk-triage test-diff bulguları runEval ile FindingEmitted
  // olarak yazılır) 2. evolve --shadow'dan sonra kendi kendine playbook-generator adayı üretir.
  it('shadow koşum test-diff bulguları aday sayımına girmez; yalnız üretim koşumları sayılır', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'evo3b-'));
    const ctx = makeCtx(dir);
    const emitTestDiff = async (run: string, taskId: string) => {
      const art = await ctx.store.append('ArtifactProduced', run, taskId, 'backend', { artifact: { diff: 'x', intent: 'i', rejectedAlternatives: [], testEvidence: '', files: [] }, parentTaskEventId: 'p' });
      await ctx.store.append('FindingEmitted', run, taskId, 'risk-triage', { finding: { id: `f-${taskId}`, stage: 'risk-triage', category: 'test-diff', severity: 'optional', confidence: 1, evidence: { file: 'a.ts', line: 1 } }, parentArtifactEventId: art.event_id });
    };
    // 1 üretim koşumu + 1 shadow koşumu (EvalRun configSnapshot'ta 'candidate') — her biri 1 test-diff
    await emitTestDiff('r-prod-1', 't1');
    await ctx.store.append('EvalRun', 'eval-shadow-1', '-', 'eval', { evalId: 's1', goldenCount: 1, passed: 1, failed: 0, score: 100, invalid: [], perTask: [], configSnapshot: { candidate: { label: 'x' } } });
    await emitTestDiff('eval-shadow-1', 'ts1');
    // shadow hariç yalnız 1 üretim koşumu var → eşik (≥2) altı, aday YOK
    expect(generateEvolutionCandidates(ctx, baseSummary())).toHaveLength(0);
    // 2. üretim koşumu → aday üretilir
    await emitTestDiff('r-prod-2', 't2');
    const out = generateEvolutionCandidates(ctx, baseSummary());
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('playbook-generator');
    // Ek shadow koşumu (yenisi + yeni bulgu) evoId'yi DEĞİŞTİRMEZ — sayım yalnız üretim koşumları
    await ctx.store.append('EvalRun', 'eval-shadow-2', '-', 'eval', { evalId: 's2', goldenCount: 1, passed: 0, failed: 1, score: 0, invalid: [], perTask: [], configSnapshot: { candidate: { label: 'x' } } });
    await emitTestDiff('eval-shadow-2', 'ts2');
    expect(generateEvolutionCandidates(ctx, baseSummary())[0].evoId).toBe(out[0].evoId);
  });
});

describe('applyEvolution (A5 — yalnız playbook staging + event)', () => {
  const candidate: EvolutionCandidate = { evoId: 'evo-abc', kind: 'playbook-reviewer', title: 'T', content: { note: 'n' }, sourceEvalId: 'base-eval' };

  // hüküm (I1 final fix wave): kapı aggregate `failed >` karşılaştırmasından PER-TASK geçiş
  // kontrolüne çevrildi (spec R10 binding) — gerileme artık yalnız gerçek bir pass→fail geçişi
  // varken reddedilir; bu test aynı senaryoyu (failed artışı) perTask kanıtıyla sürdürür.
  it('shadow failed artışı + per-task pass→fail → golden gerileme hatası + staging dosyası YAZILMAZ', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'evo4-'));
    const ctx = makeCtx(dir);
    writeShadowCandidates(ctx, [candidate]); // aday dosyası candidates/'ta — staging (playbooks/) değil
    const baseline = baseSummary({ perTask: [{ goldenId: 'g1', pass: true, reasons: [] }, { goldenId: 'g2', pass: true, reasons: [] }] });
    const shadow = baseSummary({ evalId: 'shadow-1', failed: 1, score: 98, perTask: [{ goldenId: 'g1', pass: true, reasons: [] }, { goldenId: 'g2', pass: false, reasons: ['kırıldı'] }] });
    await expect(applyEvolution(ctx, candidate, shadow, baseline))
      .rejects.toThrow('golden gerileme (g2)');
    expect(existsSync(join(ctx.playbookDir, 'evo-abc.json'))).toBe(false); // kapı throw'dan ÖNCE — yazım yok
    expect(ctx.store.query({ type: 'ProposalCreated' })).toHaveLength(0);
  });

  // I1 (spec R10 binding): karma değişim — aggregate failed AZALIRken (1→0) bir görev geriliyor.
  // Eski aggregate kapı bu geçişi onaylıyordu; per-task kapı g2 gerilemesini yakalar.
  it('karma shadow (g1 fail→pass iyileşme, g2 pass→fail gerileme) → golden gerileme hatası + staging YAZILMAZ', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'evo6-'));
    const ctx = makeCtx(dir);
    writeShadowCandidates(ctx, [candidate]);
    const baseline = baseSummary({ evalId: 'b1', failed: 1, score: 98.3, perTask: [{ goldenId: 'g1', pass: false, reasons: ['eski hata'] }, { goldenId: 'g2', pass: true, reasons: [] }] });
    const shadow = baseSummary({ evalId: 's1', failed: 0, score: 100, perTask: [{ goldenId: 'g1', pass: true, reasons: [] }, { goldenId: 'g2', pass: false, reasons: ['yeni gerileme'] }] });
    await expect(applyEvolution(ctx, candidate, shadow, baseline))
      .rejects.toThrow('golden gerileme (g2)'); // gerileme listesinde yalnız g2 — g1 iyileşme sayılmaz
    expect(existsSync(join(ctx.playbookDir, 'evo-abc.json'))).toBe(false);
    expect(ctx.store.query({ type: 'ProposalCreated' })).toHaveLength(0);
  });

  // I1: baseline'da GÖRÜNMEYEN (yeni) golden görev shadow'da fail → o da gerilemedir
  // (eksik baseline girdisi + shadow fail = reddiye; sessiz apply yolu yok).
  it('baseline\'da olmayan golden görev shadow\'da fail → golden gerileme hatası', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'evo6b-'));
    const ctx = makeCtx(dir);
    writeShadowCandidates(ctx, [candidate]);
    const baseline = baseSummary({ evalId: 'b1', failed: 0, score: 100, perTask: [{ goldenId: 'g1', pass: true, reasons: [] }] });
    const shadow = baseSummary({ evalId: 's1', failed: 1, score: 50, perTask: [{ goldenId: 'g1', pass: true, reasons: [] }, { goldenId: 'g-yeni', pass: false, reasons: ['yeni görev kırıldı'] }] });
    await expect(applyEvolution(ctx, candidate, shadow, baseline))
      .rejects.toThrow('golden gerileme (g-yeni)');
    expect(existsSync(join(ctx.playbookDir, 'evo-abc.json'))).toBe(false);
  });

  // I1: salt iyileşme (failed azalır, hiçbir görev pass→fail geçmez) → apply AKAR (kapı yalnız
  // gerilemeyi keser; iyileşmeyi cezalandırmaz).
  it('salt iyileşme (failed azalır, per-task gerileme yok) → apply başarılı', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'evo7-'));
    const ctx = makeCtx(dir);
    writeShadowCandidates(ctx, [candidate]);
    const baseline = baseSummary({ evalId: 'b1', failed: 2, score: 96.7, perTask: [{ goldenId: 'g1', pass: false, reasons: ['r'] }, { goldenId: 'g2', pass: false, reasons: ['r'] }, { goldenId: 'g3', pass: true, reasons: [] }] });
    const shadow = baseSummary({ evalId: 's1', failed: 0, score: 100, perTask: [{ goldenId: 'g1', pass: true, reasons: [] }, { goldenId: 'g2', pass: true, reasons: [] }, { goldenId: 'g3', pass: true, reasons: [] }] });
    const ev = await applyEvolution(ctx, candidate, shadow, baseline);
    expect(ev.type).toBe('ProposalCreated');
    expect(existsSync(join(ctx.playbookDir, 'evo-abc.json'))).toBe(true);
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

// I2 (final fix wave): applied playbook'lar reviewer prompt'una bağlanır — applyEvolution'un
// yazdığı .devloop/playbooks/<evoId>.json staging dosyaları loadAppliedPlaybooks ile okunur ve
// CLI kompozisyonu (mem + playbooks, 'yok.' filtreli) üzerinden reviewer system prompt'una girer.
describe('loadAppliedPlaybooks (applied playbook → reviewer prompt, I2)', () => {
  const reviewCtx: ReviewContext = {
    taskSpec: { id: 't', description: 'd', acceptanceCriteria: ['a'], filesScope: [] },
    artifact: { diff: 'x', intent: 'i', rejectedAlternatives: [], testEvidence: '', files: [] },
    repoPath: '.', riskScore: 30,
  };

  it('applyEvolution ile yazılan playbook-reviewer içeriği reviewer system prompt\'una girer; bozuk/generator dosyalar fail-soft atılır', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'evo-ap-'));
    const ctx = makeCtx(dir, { playbookDir: join(dir, '.devloop', 'playbooks') }); // loadAppliedPlaybooks repoPath sözleşmesi
    const applied: EvolutionCandidate = {
      evoId: 'evo-ap1', kind: 'playbook-reviewer', title: '"off-by-one" false-positive tekrarı',
      content: { category: 'off-by-one', note: 'reviewer rubriğinde kanıt eşiği yükseltilmeli' }, sourceEvalId: 'base-eval',
    };
    writeShadowCandidates(ctx, [applied]);
    await applyEvolution(ctx, applied, baseSummary({ evalId: 's', failed: 0 }), baseSummary()); // staging: .devloop/playbooks/evo-ap1.json
    // cli.ts kompozisyonunun birebir aynası: [mem, playbooks] — 'yok.' bildirimleri filtrelenir
    const mem = { reviewerContext: () => 'Reviewer dersi yok.' }; // boş LessonMemory davranışı
    const playbooks = loadAppliedPlaybooks(dir);
    expect(playbooks.reviewerContext()).toContain('"off-by-one" false-positive tekrarı');
    expect(playbooks.reviewerContext()).toContain('kanıt eşiği yükseltilmeli');
    const reviewerLessons = { reviewerContext: () => [mem.reviewerContext(), playbooks.reviewerContext()].filter((s) => s && !s.includes('yok.')).join('\n') };
    // capture deseni (llmReviewer.test.ts ile aynı): mock gateway user/system'i yakalar
    let capturedSystem = '';
    let capturedUser = '';
    const gateway: LlmGateway = {
      complete: vi.fn(async (req: { system: string; user: string; schema: z.Zod<unknown> }) => {
        capturedSystem = req.system; capturedUser = req.user;
        return { data: { findings: [] }, usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } };
      }),
    } as unknown as LlmGateway;
    await new LlmReviewerStage(gateway, reviewerLessons).evaluate(reviewCtx);
    expect(capturedSystem).toContain('GEÇMİŞ İNSAN KARARLARINDAN DERSLER');
    expect(capturedSystem).toContain('"off-by-one" false-positive tekrarı');
    expect(capturedSystem).toContain('kanıt eşiği yükseltilmeli');
    expect(capturedSystem).not.toContain('yok.'); // boş mem + filtre → çıplak bildirim prompt'a girmez
    expect(capturedUser).toContain('DIFF');
  });

  it('playbook-reviewer DIŞI staging (generator) ve bozuk json atılır; boş dizin → bildirim mesajı', () => {
    const dir = mkdtempSync(join(tmpdir(), 'evo-ap2-'));
    mkdirSync(join(dir, '.devloop', 'playbooks'), { recursive: true });
    writeFileSync(join(dir, '.devloop', 'playbooks', 'gen.json'), JSON.stringify({ evoId: 'g1', kind: 'playbook-generator', title: 'Generator staging' }), 'utf8');
    writeFileSync(join(dir, '.devloop', 'playbooks', 'broken.json'), '{ bozuk', 'utf8');
    const text = loadAppliedPlaybooks(dir).reviewerContext();
    expect(text).toBe('Reviewer playbook önerisi yok.');
    // playbooks/ dizini hiç yokken de fail-soft (mkdir yok — existsSync koruması)
    expect(loadAppliedPlaybooks(mkdtempSync(join(tmpdir(), 'evo-ap3-'))).reviewerContext()).toBe('Reviewer playbook önerisi yok.');
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
