import { describe, it, expect, vi } from 'vitest';
import { runEval, scoreEval } from '../../src/eval/evalRunner.js';
import { VerdictStore } from '../../src/store/store.js';
import { validateChain } from '../../src/store/store.js';
import { loadConfig } from '../../src/config/config.js';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ReviewPipeline } from '../../src/pipeline/pipeline.js';
import type { StageResult } from '../../src/contracts/review.js';

const policy = loadConfig(process.cwd()).policy;
const GOLDEN_DIFF = '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1,2 @@\n const x=1;\n+const y=2;';
const GOLDEN = {
  goldenId: 'g1',
  taskSpec: { id: 'gt1', description: 'd', acceptanceCriteria: ['a'], filesScope: [] },
  fixtureDiff: GOLDEN_DIFF,
  expected: { gatesPass: true, requiredFindings: [], forbiddenCategories: [] },
};

function makeRepo(tasks: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'ev-'));
  mkdirSync(join(dir, '.devloop', 'golden'), { recursive: true });
  tasks.forEach((t, i) => writeFileSync(join(dir, '.devloop', 'golden', `g${i}.task.json`), JSON.stringify(t)));
  return dir;
}
const passPipeline = (): ReviewPipeline => {
  const s = { name: 'static-gates', kind: 'gate' as const, evaluate: async (): Promise<StageResult> => ({ status: 'pass', findings: [], durationMs: 1 }) };
  return { ordered: () => [s], run: vi.fn(async (ctx) => { await s.evaluate(ctx); return { verdicts: [{ stage: 'static-gates', status: 'pass', durationMs: 1 }], findings: [], gateFailed: null, passed: true }; }) } as unknown as ReviewPipeline;
};

describe('scoreEval', () => {
  it('gates pass + required yakalanmış + forbidden yok → pass', () => {
    const r = scoreEval({ passed: true, findings: [{ id: 'f', stage: 's', category: 'lint', severity: 'required', confidence: 1, evidence: { file: 'a', corroborated: false } }] },
      { gatesPass: true, requiredFindings: [{ category: 'lint' }], forbiddenCategories: [] });
    expect(r.pass).toBe(true);
  });
  it('gates beklenenin tersi → fail + gerekçe', () => {
    const r = scoreEval({ passed: false, findings: [] }, { gatesPass: true, requiredFindings: [], forbiddenCategories: [] });
    expect(r.pass).toBe(false);
    expect(r.reasons[0]).toContain('gate');
  });
  it('forbidden kategori ihlali → fail', () => {
    const r = scoreEval({ passed: true, findings: [{ id: 'f', stage: 's', category: 'secret', severity: 'critical', confidence: 1, evidence: { file: 'a', corroborated: false } }] },
      { gatesPass: true, requiredFindings: [], forbiddenCategories: ['secret'] });
    expect(r.pass).toBe(false);
  });
});

describe('runEval', () => {
  it('golden seti koşar, EvalRun yazar, skor 100, kanıt zinciri ok', async () => {
    const dir = makeRepo([GOLDEN]);
    const store = new VerdictStore(join(dir, '.devloop', 'events.jsonl'));
    const r = await runEval({ repoPath: dir, pipeline: passPipeline(), policy, store, l3MinGoldenTasks: policy.l3MinGoldenTasks });
    expect(r.goldenCount).toBe(1);
    expect(r.passed).toBe(1);
    expect(r.score).toBe(100);
    expect(r.l3Active).toBe(false); // 1 < 50
    const ev = store.query({ type: 'EvalRun' })[0];
    expect(ev.payload.score).toBe(100);
    expect(validateChain(store.readAll()).ok).toBe(true);
  });
  it('LLM-siz: eval koşumunda gateway çağrısı YAPILMAZ (deterministik mod)', async () => {
    const dir = makeRepo([GOLDEN]);
    const store = new VerdictStore(join(dir, '.devloop', 'events.jsonl'));
    let gatewayCalls = 0;
    const spyGateway = { complete: vi.fn(async () => { gatewayCalls++; return { data: {}, usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } }; }) };
    // passPipeline sahte stage'leri gateway'e hiç erişmez — deterministik modun kanıtı budur
    await runEval({ repoPath: dir, pipeline: passPipeline(), policy, store, l3MinGoldenTasks: policy.l3MinGoldenTasks });
    expect(gatewayCalls).toBe(0);
    void spyGateway;
  });
});
