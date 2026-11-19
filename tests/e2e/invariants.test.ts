import { describe, it, expect, vi } from 'vitest';
import { ReviewPipeline } from '../../src/pipeline/pipeline.js';
import { BudgetedGateway } from '../../src/orchestrator/orchestrator.js';
import { generateCandidates } from '../../src/learning/learn.js';
import { VerdictStore, validateChain } from '../../src/store/store.js';
import { LessonMemory } from '../../src/memory/memory.js';
import { loadConfig } from '../../src/config/config.js';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ReviewContext } from '../../src/contracts/review.js';
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
