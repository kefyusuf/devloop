import { describe, it, expect, vi } from 'vitest';
import {
  generateEvolutionCandidates, writeShadowCandidates, applyEvolution,
  loadCandidate, candidatePlaybookProvider, loadAppliedPlaybooks, generateLlmMutations,
  type EvolutionCandidate, type EvolveContext,
} from '../../src/evolution/evolve.js';
import { DevloopEventSchema } from '../../src/contracts/events.js';
import { VerdictStore } from '../../src/store/store.js';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import type { EvalSummary } from '../../src/eval/evalRunner.js';
import { LlmReviewerStage } from '../../src/pipeline/stages/llmReviewer.js';
import { composeReviewerLessons } from '../../src/shell/composeLessons.js'; // R22 (faz 4 T3): cli.ts kompozisyonu artık GERÇEK helper'la aynalanır
import { GatewayError, type LlmGateway } from '../../src/gateway/gateway.js';
import type { ReviewContext } from '../../src/contracts/review.js';
import { buildCli } from '../../src/shell/cli.js';
import { z } from 'zod';

// R19 (faz 4 T4) test donanımı: factory mock — CLI evolve koşumlarında "gateway spy zero-call"
// kanıtı için createGateway spy gateway döner. Shadow pipeline'ın ensemble'ı da bu gateway'i alır;
// sır-fixture'lı testte pipeline ensemble'a ULAŞMAZ (secret-scan gate deterministik fail) — böylece
// spy çağrı sayısı ortamdan bağımsız 0 kalır (ensemble'a ulaşım aksi halde env girdisiydi).
const { gatewayCompleteSpy } = vi.hoisted(() => ({
  gatewayCompleteSpy: vi.fn(async () => {
    throw new Error('spy gateway: beklenmeyen çağrı');
  }),
}));
vi.mock('../../src/gateway/factory.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/gateway/factory.js')>();
  // R21 (faz 4 T6) + R26b (faz 5 T3): CLI gateway kurulumunu createGatewayOrChain üzerinden
  // yapar (helper createGateways çağırır; vi.mock modül-içi çağrıyı yakalayamadığından helper
  // AYRICA override edilir) — tek ayak = spy gateway döner, CLI seçim davranışı aynen kanılanır.
  return {
    ...actual,
    createGateway: () => ({ complete: gatewayCompleteSpy }),
    createGateways: () => [{ complete: gatewayCompleteSpy }],
    createGatewayOrChain: () => ({ complete: gatewayCompleteSpy }),
  };
});

// R19: generateLlmMutations spy-wrapped (gerçek impl korunur) — deterministik modda "--llm yoksa
// generateLlmMutations ÇAĞRILMAZ" kanıtı doğrudan spy üzerinden okunur.
vi.mock('../../src/evolution/evolve.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/evolution/evolve.js')>();
  return { ...actual, generateLlmMutations: vi.fn(actual.generateLlmMutations) };
});

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
    // cli.ts kompozisyonunun birebir aynası: [mem, playbooks] — R22 (faz 4 T3) ile cli.ts
    // composeReviewerLessons helper'ını kullanır; ayna da GERÇEK helper'la kurulur (satır bazlı
    // 'yok.' filtresi — blok düşürme yok).
    const mem = { reviewerContext: () => 'Reviewer dersi yok.' }; // boş LessonMemory davranışı
    const playbooks = loadAppliedPlaybooks(dir);
    expect(playbooks.reviewerContext()).toContain('"off-by-one" false-positive tekrarı');
    expect(playbooks.reviewerContext()).toContain('kanıt eşiği yükseltilmeli');
    const reviewerLessons = composeReviewerLessons([mem, playbooks]);
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

// R18 (faz 4 T2): loadAppliedPlaybooks ÇİFT bağlam döner — playbook-generator staging'i
// generatorContext()'e girer (- <title> — <note> formatı); reviewerContext davranışı aynen korunur
// (generator staging reviewer bağlamını kirletmez); boşken 'yok.' sentineli.
describe('loadAppliedPlaybooks generatorContext (R18)', () => {
  it('applyEvolution ile yazılan playbook-generator staging → generatorContext başlık+notu taşır; reviewerContext temiz kalır', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'evo-gen-'));
    const ctx = makeCtx(dir, { playbookDir: join(dir, '.devloop', 'playbooks') }); // loadAppliedPlaybooks repoPath sözleşmesi
    const applied: EvolutionCandidate = {
      evoId: 'evo-gen1', kind: 'playbook-generator', title: 'test-diff blokları tekrarlıyor',
      content: { note: 'generator kabul kriterlerine test uyumu maddesi eklenebilir' }, sourceEvalId: 'base-eval',
    };
    writeShadowCandidates(ctx, [applied]);
    await applyEvolution(ctx, applied, baseSummary({ evalId: 's', failed: 0 }), baseSummary()); // staging: .devloop/playbooks/evo-gen1.json
    const p = loadAppliedPlaybooks(dir);
    const gen = p.generatorContext();
    expect(gen).toContain('test-diff blokları tekrarlıyor');
    expect(gen).toContain('generator kabul kriterlerine test uyumu maddesi eklenebilir');
    expect(gen).toContain('- test-diff blokları tekrarlıyor — generator kabul kriterlerine'); // - <title> — <note> formatı
    expect(gen).not.toContain('yok.'); // dolu bağlam sentineli taşımaz
    // reviewer bağlamı generator staging'iyle kirletilmez (I2 davranışı korunur)
    expect(p.reviewerContext()).toBe('Reviewer playbook önerisi yok.');
  });

  it('boş dizin → generatorContext sentineli döner; bozuk json fail-soft atılır', () => {
    // playbooks/ dizini hiç yok
    expect(loadAppliedPlaybooks(mkdtempSync(join(tmpdir(), 'evo-gen2-'))).generatorContext()).toBe('Generator playbook önerisi yok.');
    // bozuk json dolu dizinde sentineli bozmaz
    const dir = mkdtempSync(join(tmpdir(), 'evo-gen3-'));
    mkdirSync(join(dir, '.devloop', 'playbooks'), { recursive: true });
    writeFileSync(join(dir, '.devloop', 'playbooks', 'broken.json'), '{ bozuk', 'utf8');
    expect(loadAppliedPlaybooks(dir).generatorContext()).toBe('Generator playbook önerisi yok.');
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

// R19 (faz 4 T4): LLM üretimli playbook mutasyonları — gateway tamamen dışarıdan inject; taslaklar
// candidate/ staging'ine yazılır (writeShadowCandidates yeniden kullanılır); evoId deterministik
// (sha256(kind:title:JSON(content)+sourceEvalId).slice(16)); LLM adayları da T4 hüküm kapısından
// (l3Active + golden-gerileme) geçer; anahtarsız ortamda GatewayError yukarı fırlar (fail-closed).
describe('generateLlmMutations (R19)', () => {
  // (a) mock gateway mutasyon taslağı üretir → candidate/'e yazılır + capturedUser baseline/shadow
  // perTask farklarını içerir. baseline g2 fail → shadow g2 pass (İYİLEŞME — gerileme yok, kapı geçilir).
  it('--llm: mock gateway mutasyon taslağı üretir ve candidate/ staging\'e yazılır; prompt perTask farklarını taşır', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'evo-llm1-'));
    const ctx = makeCtx(dir); // goldenCount 60 ≥ eşik 50 → l3Active guard geçilir
    let capturedUser = '';
    const gw = {
      complete: vi.fn(async (req: { system: string; user: string }) => {
        capturedUser = req.user;
        return {
          data: { mutations: [{ kind: 'playbook-reviewer', title: 'kanıt eşiği yükselt', content: { category: 'perf' }, rationale: 'tekrarlayan fp' }] },
          usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 },
        };
      }),
    } as unknown as LlmGateway;
    const baseline = baseSummary({ evalId: 'b-llm', failed: 1, score: 98.3, perTask: [{ goldenId: 'g1', pass: true, reasons: [] }, { goldenId: 'g2', pass: false, reasons: ['eski hata'] }] });
    const shadowEval = baseSummary({ evalId: 's-llm', failed: 0, score: 100, perTask: [{ goldenId: 'g1', pass: true, reasons: [] }, { goldenId: 'g2', pass: true, reasons: [] }] });
    const cands = await generateLlmMutations({ ctx, gateway: gw, baseline, shadowEval });
    expect(cands).toHaveLength(1);
    expect(cands[0]).toMatchObject({ kind: 'playbook-reviewer', title: 'kanıt eşiği yükselt', content: { category: 'perf' }, rationale: 'tekrarlayan fp', sourceEvalId: 'b-llm' });
    // evoId deterministik — sözleşme formülü: sha256(kind:title:JSON(content)+sourceEvalId).slice(16)
    const expectedEvoId = createHash('sha256')
      .update('playbook-reviewer:kanıt eşiği yükselt:' + JSON.stringify({ category: 'perf' }) + '+b-llm')
      .digest('hex').slice(0, 16);
    expect(cands[0].evoId).toBe(expectedEvoId);
    // ikinci çağrı AYNI evoId — deterministik (shadowEval.evalId girdiye karışmaz; sourceEvalId baseline)
    const cands2 = await generateLlmMutations({ ctx, gateway: gw, baseline, shadowEval });
    expect(cands2[0].evoId).toBe(cands[0].evoId);
    // staging: candidate/<evoId>.json — rationale dahil yazılır; loadCandidate okur
    expect(existsSync(join(ctx.candidateDir, `${cands[0].evoId}.json`))).toBe(true);
    const staged = JSON.parse(readFileSync(join(ctx.candidateDir, `${cands[0].evoId}.json`), 'utf8')) as Record<string, unknown>;
    expect(staged.rationale).toBe('tekrarlayan fp');
    expect(loadCandidate(ctx, cands[0].evoId)).toMatchObject({ evoId: cands[0].evoId, kind: 'playbook-reviewer' });
    // prompt: baseline/shadow perTask farkları taşınır (goldenId + fail/pass + baseline nedeni)
    expect(capturedUser).toContain('baseline');
    expect(capturedUser).toContain('shadow');
    expect(capturedUser).toContain('g2');
    expect(capturedUser).toContain('eski hata');
    expect(capturedUser).toContain('fail');
    expect(capturedUser).toContain('pass');
  });

  // (b) anahtarsız (GatewayError throw eden gateway) → hata yukarı fırlar (fail-closed); hata
  // yutulmaz, staging yazılmaz.
  it('anahtarsız (GatewayError) → fail-closed yukarı fırlar', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'evo-llm2-'));
    const ctx = makeCtx(dir);
    const gw: LlmGateway = {
      complete: vi.fn(async () => { throw new GatewayError('API anahtarı yok (env).'); }),
    };
    await expect(generateLlmMutations({ ctx, gateway: gw, baseline: baseSummary(), shadowEval: baseSummary({ evalId: 's-key' }) }))
      .rejects.toThrow(GatewayError);
    expect(vi.mocked(gw.complete)).toHaveBeenCalledTimes(1); // gateway çağrısı yapıldı, hata YUTULMAZ
    expect(existsSync(ctx.candidateDir)).toBe(false); // staging YOK — hata yukarı fırladı
  });

  // Kapılar (sözleşme hükümleri — test (a)/(b) bunları vurmaz): l3Active guard + aynen T4 hüküm
  // golden-gerileme throw'u; ikisi de gateway çağrısından ve staging yazımından ÖNCE vurur.
  it('kapılar: l3 eşik altı → throw; golden gerileme → throw (LLM adayları da kapıdan — gateway çağrısından ÖNCE)', async () => {
    const gw = { complete: vi.fn(async () => { throw new Error('kapılar gateway çağrısından önce vurmalı'); }) } as unknown as LlmGateway;
    // kapı 1: goldenCount < l3MinGoldenTasks → 'L3 eşik altı — deterministik mod kullanın'
    const dir1 = mkdtempSync(join(tmpdir(), 'evo-llm3-'));
    await expect(generateLlmMutations({ ctx: makeCtx(dir1, { goldenCount: 10, l3MinGoldenTasks: 50 }), gateway: gw, baseline: baseSummary(), shadowEval: baseSummary({ evalId: 's1' }) }))
      .rejects.toThrow('L3 eşik altı — deterministik mod kullanın');
    // kapı 2: per-task pass→fail gerileme → aynen T4 hüküm mesajı 'Evolve reddedildi: golden gerileme'
    const dir2 = mkdtempSync(join(tmpdir(), 'evo-llm4-'));
    const baseline = baseSummary({ perTask: [{ goldenId: 'g1', pass: true, reasons: [] }] });
    const shadowEval = baseSummary({ evalId: 's-reg', failed: 1, score: 50, perTask: [{ goldenId: 'g1', pass: false, reasons: ['kırıldı'] }] });
    await expect(generateLlmMutations({ ctx: makeCtx(dir2), gateway: gw, baseline, shadowEval }))
      .rejects.toThrow('Evolve reddedildi: golden gerileme');
    expect(vi.mocked(gw.complete)).not.toHaveBeenCalled(); // kapılar gateway'den ÖNCE
    expect(existsSync(makeCtx(dir2).candidateDir)).toBe(false); // staging YOK
  });

  // (c) deterministik mod: --llm YOKSA generateLlmMutations ÇAĞRILMAZ — CLI testinde gateway spy
  // zero-call kanıtı. Gerçek evolve --shadow koşumu yapılır (eşik policy override ile geçilir,
  // shadow eval gerçekten koşar); fixtureDiff SIR içerir → secret-scan gate DETERMİNİSTİK fail →
  // pipeline ensemble'a ulaşmaz (ensemble'a ulaşım aksi halde env girdisiydi — sır ile kesin
  // kesilir; spy çağrısı her ortamda 0 kalır).
  it('deterministik mod: --llm yoksa evolve --shadow gateway spy zero-call + generateLlmMutations çağrılmaz', async () => {
    vi.mocked(generateLlmMutations).mockClear();
    gatewayCompleteSpy.mockClear();
    const dir = mkdtempSync(join(tmpdir(), 'evo-llm5-'));
    const policyYaml = readFileSync(join(process.cwd(), 'policy.yaml'), 'utf8').replace('l3MinGoldenTasks: 50', 'l3MinGoldenTasks: 1');
    writeFileSync(join(dir, 'policy.yaml'), policyYaml, 'utf8');
    mkdirSync(join(dir, '.devloop', 'golden'), { recursive: true });
    writeFileSync(join(dir, '.devloop', 'golden', 'g1.task.json'), JSON.stringify({
      goldenId: 'g1',
      taskSpec: { id: 'gt1', description: 'd', acceptanceCriteria: ['a'], filesScope: [] },
      fixtureDiff: '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1,2 @@\n const x=1;\n+const password = "aaaaaaaaaaaaaaaaaaaaaaaa";',
      expected: { gatesPass: false, requiredFindings: [{ category: 'secret', severity: 'critical' }], forbiddenCategories: [] },
    }));
    const store = new VerdictStore(join(dir, '.devloop', 'events.jsonl'));
    await store.append('EvalRun', 'eval-b', '-', 'eval', { evalId: 'b1', goldenCount: 1, passed: 1, failed: 0, score: 100, invalid: [], perTask: [], configSnapshot: { mode: 'production' } });
    const out: string[] = [];
    const origLog = console.log; console.log = (m: string) => out.push(m);
    try {
      await buildCli(dir).parseAsync(['node', 'devloop', 'evolve', '--shadow']); // --llm YOK
    } finally { console.log = origLog; }
    expect(gatewayCompleteSpy).not.toHaveBeenCalled(); // gateway mock'u hiç çağrılmaz (zero-call)
    expect(vi.mocked(generateLlmMutations)).not.toHaveBeenCalled(); // LLM mutasyon yolu hiç açılmadı
    const parsed = JSON.parse(out.join('\n')) as Record<string, unknown>;
    expect(parsed.llmMutations).toBeUndefined(); // çıktı aynen — llm alanı yok
    expect(Array.isArray(parsed.candidates)).toBe(true);
    expect(parsed.shadowEval).toMatchObject({ configSnapshot: { candidate: 'evolve-shadow' } });
  });

  // CLI hata raporlama: --llm'de hata (anahtarsız GatewayError; env'e göre gerileme throw'u da
  // olabilir) yakalanır → anlamlı mesaj (stderr) + exit non-zero; deterministik sonuç JSON'u
  // stdout'ta aynen kalır (parse edilebilir). İki env yolu da (shadow failed 0/1) exitCode '1'
  // verir — test ortam-bağımsız sözleşmeyi doğrular.
  it('evolve --shadow --llm: gateway hatası → anlamlı mesaj + exit non-zero (deterministik çıktı korunur)', async () => {
    vi.mocked(generateLlmMutations).mockClear();
    gatewayCompleteSpy.mockClear();
    const dir = mkdtempSync(join(tmpdir(), 'evo-llm6-'));
    const policyYaml = readFileSync(join(process.cwd(), 'policy.yaml'), 'utf8').replace('l3MinGoldenTasks: 50', 'l3MinGoldenTasks: 1');
    writeFileSync(join(dir, 'policy.yaml'), policyYaml, 'utf8');
    mkdirSync(join(dir, '.devloop', 'golden'), { recursive: true });
    writeFileSync(join(dir, '.devloop', 'golden', 'g1.task.json'), JSON.stringify({
      goldenId: 'g1',
      taskSpec: { id: 'gt1', description: 'd', acceptanceCriteria: ['a'], filesScope: [] },
      fixtureDiff: '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1,2 @@\n const x=1;\n+const y=2;',
      expected: { gatesPass: true, requiredFindings: [], forbiddenCategories: [] },
    }));
    const store = new VerdictStore(join(dir, '.devloop', 'events.jsonl'));
    await store.append('EvalRun', 'eval-b', '-', 'eval', { evalId: 'b1', goldenCount: 1, passed: 1, failed: 0, score: 100, invalid: [], perTask: [], configSnapshot: { mode: 'production' } });
    const out: string[] = []; const errs: string[] = [];
    const origLog = console.log, origErr = console.error;
    const prevExit = process.exitCode;
    console.log = (m: string) => out.push(m); console.error = (m: string) => errs.push(m);
    try {
      await buildCli(dir).parseAsync(['node', 'devloop', 'evolve', '--shadow', '--llm']);
    } finally {
      console.log = origLog; console.error = origErr;
    }
    expect(errs.join('\n')).toContain('evolve --llm başarısız'); // anlamlı mesaj
    // exit non-zero — CLI string '1' set eder (review-diff ile aynı stil); Node ≥24 exitCode
    // string atamını runtime'da number'a normalleştirir (kanıt: node -e "process.exitCode='1'")
    // → tip-bağımsız sayısal karşılaştırma iki Node davranışında da geçerli.
    expect(Number(process.exitCode ?? 0)).toBe(1);
    process.exitCode = prevExit; // testler arası process state sızıntısı temizlenir
    const parsed = JSON.parse(out.join('\n')) as Record<string, unknown>; // stdout JSON parse edilebilir kalır
    expect(parsed.llmMutations).toBeUndefined();
    expect(Array.isArray(parsed.candidates)).toBe(true);
  });

  // R26d (faz 5 T5): evoId seed'i canonicalJson üzerinden — AYNI içerik farklı key-sırasıyla
  // geliyorsa AYNI evoId (key-order duyarlılığı kapanır). Mock gateway zod parse yapmaz → mock'un
  // content key sırası seed'e AYNEN ulaşır; JSON.stringify seed'inde iki çağrı farklı evoId üretirdi.
  it('R26d: aynı içerik farklı key-sıralı LLM mutasyon content\'i → aynı evoId', async () => {
    const mkGw = (content: Record<string, unknown>): LlmGateway => ({
      complete: vi.fn(async () => ({
        data: { mutations: [{ kind: 'playbook-reviewer', title: 'kanıt eşiği yükselt', content, rationale: 'tekrarlayan fp' }] },
        usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 },
      })),
    } as unknown as LlmGateway);
    const dir = mkdtempSync(join(tmpdir(), 'evo-llm7-'));
    const ctx = makeCtx(dir);
    const baseline = baseSummary({ evalId: 'b-key' });
    const shadowEval = baseSummary({ evalId: 's-key' });
    const a = await generateLlmMutations({ ctx, gateway: mkGw({ note: 'eşik yükselt', category: 'perf' }), baseline, shadowEval });
    const b = await generateLlmMutations({ ctx, gateway: mkGw({ category: 'perf', note: 'eşik yükselt' }), baseline, shadowEval });
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(a[0].evoId).toBe(b[0].evoId);
  });
});
