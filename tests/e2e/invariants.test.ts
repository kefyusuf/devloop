import { describe, it, expect, vi } from 'vitest';
import { ReviewPipeline } from '../../src/pipeline/pipeline.js';
import { Orchestrator, BudgetedGateway, type OrchestratorDeps } from '../../src/orchestrator/orchestrator.js';
import { generateCandidates, generateProposals, applyProposal } from '../../src/learning/learn.js';
import { VerdictStore, validateChain } from '../../src/store/store.js';
import { LessonMemory } from '../../src/memory/memory.js';
import { RiskTriageStage } from '../../src/pipeline/stages/riskTriage.js';
import { LlmEnsembleStage } from '../../src/pipeline/stages/llmEnsemble.js';
import { loadConfig } from '../../src/config/config.js';
import { mkdtempSync, readFileSync, mkdirSync, readdirSync, cpSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';
import type { ReviewContext, ReviewStage, StageResult } from '../../src/contracts/review.js';
import type { Finding } from '../../src/contracts/schemas.js';
import type { LlmGateway } from '../../src/gateway/gateway.js';

// Düzeltme 5: "type":"module" altında require geçersiz — statik ESM import.
const base = loadConfig(process.cwd()).policy;
const ctx = (): ReviewContext => ({ taskSpec: { id: 't', description: 'd', acceptanceCriteria: ['a'], filesScope: [] }, artifact: { diff: 'x', intent: 'i', rejectedAlternatives: [], testEvidence: '', files: [] }, repoPath: '.', riskScore: 0 });
const F = (id: string, category: string, severity: Finding['severity']): Finding => ({ id, stage: 's', category, severity, confidence: 1, evidence: { file: 'a.ts', line: 1 } });
const mkStage = (name: string, status: 'pass' | 'fail' | 'error' | 'skipped') => ({ name, kind: 'gate' as const, evaluate: vi.fn(async () => ({ status, findings: [], durationMs: 1 })) });

describe('A6 değişmez kural paketi', () => {
  it('PASS yalnız tüm zorunlu gate pass ile (fail/error/skipped her biri fail)', async () => {
    const policy = { ...base, gates: ['g1'], advisory: [], authorizedSkips: [] };
    for (const status of ['fail', 'error', 'skipped'] as const) {
      const r = await new ReviewPipeline([mkStage('g1', status)], policy).run(ctx());
      expect(r.passed).toBe(false);
    }
    const r = await new ReviewPipeline([mkStage('g1', 'pass')], policy).run(ctx());
    expect(r.passed).toBe(true);
  });

  it('bütçe: çok çağrılı gerçek usage toplamı ile durur', async () => {
    let n = 0;
    const inner: LlmGateway = { complete: vi.fn(async () => { n++; return { data: {}, usage: { inputTokens: 0, outputTokens: 0, costUsd: 0.5 } }; }) };
    const bg = new BudgetedGateway(inner, 1.0, () => {});
    await bg.complete({ system: 's', user: 'u', schema: { parse: (x) => x } as never, runId: 'r' });
    await bg.complete({ system: 's', user: 'u', schema: { parse: (x) => x } as never, runId: 'r' }); // toplam 1.0
    await expect(bg.complete({ system: 's', user: 'u', schema: { parse: (x) => x } as never, runId: 'r' })).rejects.toThrow('Bütçe');
    expect(n).toBe(2);
  });

  it('HumanDecision gerçek bulguya bağlı (parent validation)', async () => {
    const store = new VerdictStore(join(mkdtempSync(join(tmpdir(), 'inv-')), 'e.jsonl'));
    // Düzeltme 5 uyarlaması: değişmez başlığına birebir — olmayan bulgu event'ine bağlı
    // HumanDecision; validateChain eksik parent'ı yakalar (sessiz kanıt yok).
    await store.append('HumanDecision', 'r', 't', 'h', { decision: 'reject', reason: 'false-positive', parentFindingEventIds: ['bulgu-event-yok'] });
    const chain = validateChain(store.readAll());
    expect(chain.ok).toBe(false);
    expect(chain.errors[0]).toContain('bulgu-event-yok');
  });

  it('LessonLearned(active) insan onayı gerektirir: onaysız candidate contextFor\'a girmez', async () => {
    const store = new VerdictStore(join(mkdtempSync(join(tmpdir(), 'inv2-')), 'e.jsonl'));
    await store.append('LessonLearned', 'r', 'l', 'learning', { lessonId: 'l1', rule: 'kural', scope: 's', confidence: 0.9, status: 'candidate', targetComponent: 'generator', parentDecisionEventIds: [] });
    const mem = new LessonMemory(store, join(mkdtempSync(join(tmpdir(), 'inv3-')), 'l.md'));
    expect(mem.contextFor({ id: 't', description: 'kural', acceptanceCriteria: ['a'], filesScope: [] })).not.toContain('kural');
  });

  it('aday ders ID\'leri karar setine deterministik', async () => {
    const store = new VerdictStore(join(mkdtempSync(join(tmpdir(), 'inv4-')), 'e.jsonl'));
    const art = await store.append('ArtifactProduced', 'r', 't', 'b', { artifact: { diff: '', intent: 'i', rejectedAlternatives: [], testEvidence: '', files: [] }, parentTaskEventId: 'p' });
    const f1 = await store.append('FindingEmitted', 'r', 't', 'llm', { finding: F('f1', 'perf', 'required'), parentArtifactEventId: art.event_id });
    const f2 = await store.append('FindingEmitted', 'r', 't2', 'llm', { finding: F('f2', 'perf', 'required'), parentArtifactEventId: art.event_id });
    await store.append('HumanDecision', 'r', 't', 'h', { decision: 'reject', reason: 'false-positive', parentFindingEventIds: [f1.event_id] });
    await store.append('HumanDecision', 'r', 't2', 'h', { decision: 'reject', reason: 'false-positive', parentFindingEventIds: [f2.event_id] });
    expect(generateCandidates(store)[0].lessonId).toBe(generateCandidates(store)[0].lessonId);
  });
});

// Faz 2 değişmezleri (R7): her faz-2 kabul kriteri değişmez olarak burada pinlenir.
describe('Faz 2 değişmezleri (R7)', () => {
  const req = { system: 's', user: 'u', schema: { parse: (x: unknown) => x } as never, runId: 'r' };

  it('bütçe iki kaynak: TEK BudgetedGateway örneği generator+reviewer harcamasını birleştirir', async () => {
    // R1 değişmezi: her kaynak tek başına bütçe altında (0.6 < 1.0); yalnız PAYLAŞILAN örnek üzerindeki
    // kümülasyon (0.6+0.6=1.2) reddi tetikler — per-source sayım bu senaryoyu geçerdi, tek kapı geçmez.
    // Hüküm: BudgetedGateway post-call eşiği `>` olduğundan 0.6+0.6 aşımı İKİNCİ çağrıda (toplam bütçeyi
    // o an geçtiği için) post-call BudgetExceededError verir; üçüncü çağrı ise ön-kontrolle kapalıdır.
    let n = 0;
    const inner: LlmGateway = { complete: vi.fn(async () => { n++; return { data: {}, usage: { inputTokens: 0, outputTokens: 0, costUsd: 0.6 } }; }) };
    const bg = new BudgetedGateway(inner, 1.0, () => {});
    await bg.complete(req); // generator kaynağı: 0.6 — tek başına serbest
    await expect(bg.complete(req)).rejects.toThrow('Bütçe'); // reviewer kaynağı: kümülatif 1.2 > 1.0 → post-call reddi
    await expect(bg.complete(req)).rejects.toThrow('Bütçe'); // üçüncü çağrı: ön-kontrol reddi (kapı kapalı kalır)
    expect(n).toBe(2);
  });

  it('L2 staging izolasyonu: applyProposal yalnız proposals/<id>/ altına yazar, repoya hiçbir şey yazmaz', async () => {
    const root = mkdtempSync(join(tmpdir(), 'inv-l2-'));
    const repoDir = join(root, 'repo'); // boş fixture repo — izolasyon kanıtı için before/after karşılaştırma
    const proposalsDir = join(root, 'proposals');
    mkdirSync(repoDir); mkdirSync(proposalsDir);
    expect(readdirSync(repoDir)).toEqual([]); // önce: repo boş

    const store = new VerdictStore(join(mkdtempSync(join(tmpdir(), 'inv-l2s-')), 'e.jsonl'));
    // Seed: 3 ayrı koşumda aynı kategori bulgu + reject kararı → generateProposals koşulları (≥2 ret,
    // ≥3 koşum, l2MinDecisions=3) sağlanır ve bir öneri üretilir.
    const art = await store.append('ArtifactProduced', 'r0', 't', 'b', { artifact: { diff: '', intent: 'i', rejectedAlternatives: [], testEvidence: '', files: [] }, parentTaskEventId: 'p' });
    for (const run of ['r1', 'r2', 'r3']) {
      const f = await store.append('FindingEmitted', run, 't', 'llm', { finding: F(`f-${run}`, 'perf', 'required'), parentArtifactEventId: art.event_id });
      await store.append('HumanDecision', run, 't', 'h', { decision: 'reject', reason: 'false-positive', parentFindingEventIds: [f.event_id] });
    }
    const proposals = generateProposals(store, 3);
    expect(proposals).toHaveLength(1);
    const p = proposals[0];

    await applyProposal(store, proposalsDir, p);
    // Sonra: repo dir HÂLÂ boş — devloop otomatik yazım yapmadı (A5/R5 değişmezi).
    expect(readdirSync(repoDir)).toEqual([]);
    // Staging dışına taşma yok: proposalsDir'in tek girdisi <proposalId>/; içinde yalnız PROPOSAL.md.
    expect(readdirSync(proposalsDir)).toEqual([p.proposalId]);
    expect(readdirSync(join(proposalsDir, p.proposalId))).toEqual(['PROPOSAL.md']);
    expect(store.query({ type: 'ProposalCreated' })).toHaveLength(1);
  });

  it('koraborasyon değişmezi (tam ensemble, eşik altı): tek reviewer → false; iki reviewer aynı anahtar → true', async () => {
    // T4'ün aksine burada corroborated=FALSE hali de pinlenir; risk 0 < ensembleRiskThreshold → alt
    // reviewer yalnız primary bulgulu olduğundan koşar (çağrı sayısıyla eşik kablolaması pinlenir).
    const mkReviewer = (name: string, findings: Finding[]) => {
      const evaluate = vi.fn(async (): Promise<StageResult> => ({ status: 'pass', findings, durationMs: 1 }));
      return { stage: { name, kind: 'advisory' as const, evaluate } as ReviewStage, evaluate };
    };
    const R = (id: string, stage: string, category: string): Finding => ({ id, stage, category, severity: 'required', confidence: 0.9, evidence: { file: 'a.ts', line: 1 }, corroborated: false });

    const p1 = mkReviewer('llm-reviewer', [R('p1', 'llm-reviewer', 'perf')]);
    const a1 = mkReviewer('llm-reviewer-alt', []);
    const single = await new LlmEnsembleStage(p1.stage, a1.stage, base).evaluate(ctx());
    expect(p1.evaluate).toHaveBeenCalledTimes(1);
    expect(a1.evaluate).toHaveBeenCalledTimes(1); // primary bulgulu → alt koşar (eşik değil, bulgu tetikler)
    expect(single.findings).toHaveLength(1);
    expect(single.findings[0].corroborated).toBe(false); // alt aynı anahtarda bulgu vermedi → tek kaynak

    const p2 = mkReviewer('llm-reviewer', [R('p2', 'llm-reviewer', 'perf')]);
    const a2 = mkReviewer('llm-reviewer-alt', [R('a2', 'llm-reviewer-alt', 'perf')]); // aynı kategori+konum → çifte kaynak
    const both = await new LlmEnsembleStage(p2.stage, a2.stage, base).evaluate(ctx());
    expect(both.findings).toHaveLength(1);
    expect(both.findings[0].corroborated).toBe(true);
  });

  it('gate-config parmak izi: farklı tsconfig içerikli iki orchestrator koşumu → farklı gateConfigHash', async () => {
    const fixture = join(process.cwd(), 'tests', 'fixtures', 'sample-repo');
    // Minimal pipeline + ona uyan policy override'u (varsayılan policy tests/secret-scan/ensemble/mutation ister — A2 fail-closed).
    const gchPolicy = { ...base, gates: ['risk-triage', 'static-gates'], advisory: [] };
    const ART = { diff: '', intent: 'i', rejectedAlternatives: [], testEvidence: '', files: [{ path: 'src/new.ts', content: 'export const n=1;\n' }] };
    const orchDeps = (repo: string, store: VerdictStore): OrchestratorDeps => ({
      store,
      backend: { id: 'fake', generate: vi.fn(async () => ART) } as never,
      pipeline: new ReviewPipeline([
        new RiskTriageStage(gchPolicy),
        { name: 'static-gates', kind: 'gate' as const, evaluate: async (): Promise<StageResult> => ({ status: 'pass', findings: [], durationMs: 1 }) },
      ], gchPolicy),
      gateway: { complete: vi.fn(async () => ({ data: {}, usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } })) } as never,
      policy: gchPolicy, repoPath: repo, pr: { openPr: vi.fn(async () => ({ url: 'u' })) } as never,
    });
    const runRepo = async (tsconfig: string): Promise<string> => {
      const repo = mkdtempSync(join(tmpdir(), 'inv-gch-'));
      cpSync(fixture, repo, { recursive: true });
      writeFileSync(join(repo, 'tsconfig.json'), tsconfig, 'utf8');
      execSync('git init -b main && git config user.email t@t && git config user.name t && git add . && git commit -m init', { cwd: repo });
      const store = new VerdictStore(join(repo, '.devloop', 'events.jsonl'));
      const summary = await new Orchestrator(orchDeps(repo, store)).run(join(repo, 'tasks.json'));
      expect(summary.prs).toHaveLength(1); // koşum gerçekten tamlandı (erken abort boş kanıt bırakmaz)
      const snap = store.query({ type: 'RunStarted' })[0].payload.configSnapshot;
      return String(snap.gateConfigHash);
    };
    const h1 = await runRepo('{"compilerOptions":{"strict":true}}');
    const h2 = await runRepo('{"compilerOptions":{"strict":false}}');
    expect(h1).not.toBe(h2); // R4a duyarlılık: gate config içeriği parmak izini değiştirir
    expect(h1).toMatch(/^[0-9a-f]{16}/); // her iki dosya da mevcut → düz hex (absent marker yok)
  });
});

// Düzeltme 9 (opsiyonel — dahil edildi): README/CLI fiil hizası koruması; ucuz, gürültü değil.
describe('README hizası', () => {
  it('README, CLI fiilleriyle hizalı (run/decide/learn/status)', () => {
    const readme = readFileSync(join(process.cwd(), 'README.md'), 'utf8');
    expect(readme).toContain('run tasks.json');
    expect(readme).toContain('devloop decide');
    expect(readme).toContain('devloop learn');
    expect(readme).toContain('devloop status');
  });
});
