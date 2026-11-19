# devloop Faz 3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Spec Revizyon 3 (R9–R16): Eval Harness + golden dataset (deterministik LLM'siz mod + shadow), L3 prompt/policy evrimi (deterministik mutasyonlar + insan-onaylı apply + golden-gerileme red kapısı), risk-tiered tetikleme (mutation kapsamı + CI derinliği), OpenAI adapter + gateway factory, container sandbox (koşullu Docker), sertleştirme paketi.

**Architecture:** Yaklaşım 1 — kontrat ekleme devamı. Eval = yeni çekirdek modül (`src/eval/`), golden = hedef repo'da `.devloop/golden/` versiyonlu dosyalar, L3 = `src/evolution/evolve.ts` + playbook dosyaları, OpenAI = yeni `LlmGateway` adapter + factory, sandbox = spawn katmanında koşullu docker sarmalayıcı. Tüm ortam bağımlılıkları (OPENAI_API_KEY, Docker) **koşullu-fail-closed**: yoksa ilgili özellik açık mesajla devre dışı/abort, sessiz düşüş yok.

**Tech Stack:** değişiklik yok (Docker yalnız `mode:'docker'` + `DEVLOOP_DOCKER=1` testte).

**Spec:** `docs/superpowers/specs/2026-11-18-ai-dev-loop-design.md` — Revizyon 3 (R9–R16). Executor spec + planı birlikte okur.

## Global Constraints

- **A1–A6 + R1–R6 aynen** — mevcut 149 test bozulmaz; davranış değişen yerler `// hüküm:` notlu.
- **R9 donmuş yargıç:** eval karşılaştırması yalnız golden `expected` + gate çıktıları üzerinden; öğrenen bileşenler jüri olmaz.
- **R10 A5:** evolve apply yalnız playbook staging + policy-review yolu; repo/policy'a otomatik yazım yok; golden gerileme = apply red.
- **R12 koşullu:** OPENAI_API_KEY yoksa openai provider seçilemez (fail-closed); testler tamamen mock; gerçek API çağrısı yok.
- **R13 koşullu:** docker modu Docker-yoksa run-level abort + açık mesaj; gerçek docker testi `DEVLOOP_DOCKER=1` arkasında.
- Tüm yeni policy alanları default'lu; policy.yaml + DEFAULT_POLICY senkron.
- Gerçek Stryker testi (v1 T5) ve golden testleri bozulmaz; davranış değişen assertion'lar hüküm notlu güncellenir.

---

### Task 1: Kontrat ekleri — faz 3 policy alanları, EvalRun gerçek payload, GoldenTask + mutantId

**Files:**
- Modify: `src/config/config.ts`, `policy.yaml`
- Modify: `src/contracts/schemas.ts` (evidence.mutantId), `src/contracts/events.ts` (EvalRun gerçek payload)
- Create: `src/eval/golden.ts` (GoldenTask şeması + loader)
- Test: `tests/config/config.test.ts` (ekleme), `tests/contracts/contracts.test.ts` (ekleme), `tests/eval/golden.test.ts` (yeni)

**Interfaces:**
- Produces: Policy yeni alanlar `l3MinGoldenTasks=50`, `ciEnsembleRiskThreshold=20`, `mutationScopeLow=5`, `mutationScopeHigh=10`, `sandbox { mode:'host', image:'node:20-bookworm-slim' }`, `llm.provider: 'anthropic'|'openai'`, `llm.openai { model:'gpt-4.1', fallbackModel:'gpt-4.1-mini', maxTokens:8192, costPer1kInput:0.0025, costPer1kOutput:0.01 }`; `Finding.evidence.mutantId?: string`; `EvalRun` gerçek payload `{ evalId, goldenCount, passed, failed, score, perTask[], configSnapshot, comparedTo? }`; `GoldenTaskSchema/GoldenTask`, `loadGoldenTasks(repoPath): { tasks, invalid: string[] }`.

- [ ] **Step 1: Başarısız testler (ekleme)**

`tests/config/config.test.ts` sonuna:
```ts
describe('faz 3 policy alanları', () => {
  it('varsayılanlar: l3MinGoldenTasks=50, ciEnsembleRiskThreshold=20, mutationScope 5/10, sandbox host, openai blok', () => {
    const { policy } = loadConfig(join(tmpdir(), `devloop-p3-${Date.now()}`));
    expect(policy.l3MinGoldenTasks).toBe(50);
    expect(policy.ciEnsembleRiskThreshold).toBe(20);
    expect(policy.mutationScopeLow).toBe(5);
    expect(policy.mutationScopeHigh).toBe(10);
    expect(policy.sandbox.mode).toBe('host');
    expect(policy.sandbox.image).toBe('node:20-bookworm-slim');
    expect(policy.llm.provider).toBe('anthropic');
    expect(policy.llm.openai.model).toBe('gpt-4.1');
    expect(policy.llm.openai.costPer1kOutput).toBe(0.01);
  });
  it('provider openai kabul edilir; sandbox.mode docker kabul edilir', () => {
    const dir = tmpDir3();
    writeFileSync(join(dir, 'policy.yaml'), [
      'version: 1', 'gates: [static-gates]', 'advisory: []', 'authorizedSkips: []',
      'maxFixTours: 2', 'maxIterations: 5', 'budgetUsd: 1.0', 'wallClockMinutes: 10',
      'risk: { weights: { diffSize: 0.3, testDiff: 0.5, scopePaths: 0.2 } }',
      'llm: { provider: openai, model: m, fallbackModel: m2, maxTokens: 100, costPer1kInput: 0, costPer1kOutput: 0,',
      '      openai: { model: gpt-x, fallbackModel: gpt-mini, maxTokens: 100, costPer1kInput: 0, costPer1kOutput: 0 } }',
      'sandbox: { mode: docker, image: node:20 }',
    ].join('\n'));
    const { policy } = loadConfig(dir);
    expect(policy.llm.provider).toBe('openai');
    expect(policy.sandbox.mode).toBe('docker');
  });
});
```
(`tmpDir3` helper — dosyadaki mevcut tmpDir pattern'inin kopyası, policy sabiti farklı.)

`tests/contracts/contracts.test.ts` sonuna:
```ts
describe('faz 3 kontratları', () => {
  it('evidence.mutantId opsiyonel taşınır', () => {
    const f = FindingSchema.parse({ id: 'f', stage: 'mutation-testing', category: 'mutation', severity: 'critical', confidence: 1, evidence: { file: 'a.ts', line: 3, mutantId: 'm5' } });
    expect(f.evidence.mutantId).toBe('m5');
  });
  it('EvalRun gerçek payload doğrulanır', () => {
    const env = makeEnvelope('r', '-', 'eval');
    const ev = DevloopEventSchema.parse({ ...env, type: 'EvalRun', payload: {
      evalId: 'e1', goldenCount: 3, passed: 2, failed: 1, score: 66.7,
      perTask: [{ goldenId: 'g1', pass: true, reasons: [] }],
      configSnapshot: { mode: 'production' },
    } });
    expect(ev.payload.comparedTo).toBeUndefined();
  });
});
```

`tests/eval/golden.test.ts` (yeni):
```ts
import { describe, it, expect } from 'vitest';
import { loadGoldenTasks } from '../../src/eval/golden.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const GOLDEN = {
  goldenId: 'g1',
  taskSpec: { id: 'gt1', description: 'd', acceptanceCriteria: ['a'], filesScope: [] },
  fixtureDiff: '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1,2 @@\n const x=1;\n+const y=2;',
  expected: { gatesPass: true, requiredFindings: [{ category: 'lint' }], forbiddenCategories: ['secret'] },
};

describe('loadGoldenTasks', () => {
  it('golden dizinini okur ve şemaya doğrular', () => {
    const dir = mkdtempSync(join(tmpdir(), 'golden-'));
    mkdirSync(join(dir, '.devloop', 'golden'), { recursive: true });
    writeFileSync(join(dir, '.devloop', 'golden', 'g1.task.json'), JSON.stringify(GOLDEN));
    const { tasks, invalid } = loadGoldenTasks(dir);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].goldenId).toBe('g1');
    expect(tasks[0].taskSpec.acceptanceCriteria).toEqual(['a']);
    expect(invalid).toEqual([]);
  });
  it('geçersiz görev dosyası invalid listesine düşer, atlanmaz-yazılmaz', () => {
    const dir = mkdtempSync(join(tmpdir(), 'golden2-'));
    mkdirSync(join(dir, '.devloop', 'golden'), { recursive: true });
    writeFileSync(join(dir, '.devloop', 'golden', 'bad.task.json'), '{"goldenId": "x"}');
    const { tasks, invalid } = loadGoldenTasks(dir);
    expect(tasks).toHaveLength(0);
    expect(invalid).toHaveLength(1);
  });
});
```
(`mkdtempSync` importu test başına eklenir.)

- [ ] **Step 2: FAIL doğrula** — `npx vitest run tests/config tests/contracts tests/eval` → yeni testler FAIL.
- [ ] **Step 3: Implementasyon**

`src/config/config.ts`: Policy ekleri
```ts
l3MinGoldenTasks: z.number().int().positive().default(50),
ciEnsembleRiskThreshold: z.number().min(0).max(100).default(20),
mutationScopeLow: z.number().int().positive().default(5),
mutationScopeHigh: z.number().int().positive().default(10),
sandbox: z.object({
  mode: z.enum(['host', 'docker']).default('host'),
  image: z.string().default('node:20-bookworm-slim'),
}).default({ mode: 'host', image: 'node:20-bookworm-slim' }),
```
`llm` şeması: `provider: z.enum(['anthropic', 'openai']).default('anthropic')` + `openai: z.object({ model: z.string().default('gpt-4.1'), fallbackModel: z.string().default('gpt-4.1-mini'), maxTokens: z.number().int().positive().default(8192), costPer1kInput: z.number().min(0).default(0.0025), costPer1kOutput: z.number().min(0).default(0.01) }).default({ model: 'gpt-4.1', fallbackModel: 'gpt-4.1-mini', maxTokens: 8192, costPer1kInput: 0.0025, costPer1kOutput: 0.01 })` — `DEFAULT_POLICY` ve `policy.yaml` senkron.

`src/contracts/schemas.ts` — evidence objesine: `mutantId: z.string().optional(),`

`src/contracts/events.ts` — EvalRun payload'ı değiştir (stub'ın yerine; hiçbir yerde eski shape kullanılmıyor — grep ile doğrula):
```ts
EvalRun: z.object({
  evalId: z.string(), goldenCount: z.number().int(), passed: z.number().int(), failed: z.number().int(),
  score: z.number(),
  perTask: z.array(z.object({ goldenId: z.string(), pass: z.boolean(), reasons: z.array(z.string()) })),
  configSnapshot: z.record(z.unknown()), comparedTo: z.string().optional(),
}),
```

`src/eval/golden.ts` (yeni):
```ts
import { z } from 'zod';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TaskSpecSchema } from '../contracts/schemas.js';

export const GoldenTaskSchema = z.object({
  goldenId: z.string(),
  taskSpec: TaskSpecSchema,
  fixtureDiff: z.string(),
  expected: z.object({
    gatesPass: z.boolean(),
    requiredFindings: z.array(z.object({ category: z.string(), severity: z.string().optional() })),
    forbiddenCategories: z.array(z.string()).default([]),
  }),
});
export type GoldenTask = z.infer<typeof GoldenTaskSchema>;

export function loadGoldenTasks(repoPath: string): { tasks: GoldenTask[]; invalid: string[] } {
  const dir = join(repoPath, '.devloop', 'golden');
  const tasks: GoldenTask[] = [];
  const invalid: string[] = [];
  let names: string[] = [];
  try { names = readdirSync(dir).filter((n) => n.endsWith('.task.json')); } catch { return { tasks, invalid }; }
  for (const name of names) {
    try { tasks.push(GoldenTaskSchema.parse(JSON.parse(readFileSync(join(dir, name), 'utf8')))); }
    catch { invalid.push(name); }
  }
  return { tasks, invalid };
}
```

- [ ] **Step 4: PASS doğrula** (paket ~155) — **Step 5: Commit** `feat: faz3 kontratları — policy ekleri, EvalRun gerçek payload, golden format + loader (R9/R11/R13/R14)`

---

### Task 2: Eval runner — deterministik koşum + skor + EvalRun (R9)

**Files:**
- Create: `src/eval/evalRunner.ts`
- Test: `tests/eval/evalRunner.test.ts`

**Interfaces:**
- Consumes: `loadGoldenTasks` (T1), `ReviewPipeline`, `parseDiff` (`src/shell/reviewDiff.js`), `VerdictStore`, `Policy`.
- Produces: `runEval(args: { repoPath: string; pipeline: ReviewPipeline; policy: Policy; store: VerdictStore; candidate?: { label: string }; l3MinGoldenTasks: number }): Promise<EvalSummary>`; `EvalSummary { evalId; goldenCount; passed; failed; score; perTask: Array<{ goldenId, pass, reasons }>; configSnapshot; l3Active: boolean; comparedTo?: string }`; `scoreEval(result, expected): { pass: boolean; reasons: string[] }`.

- [ ] **Step 1: Başarısız test**
```ts
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
```

- [ ] **Step 2: FAIL** → **Step 3: Implementasyon**

`src/eval/evalRunner.ts`:
```ts
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { ReviewPipeline } from '../pipeline/pipeline.js';
import type { Policy } from '../config/config.js';
import type { VerdictStore } from '../store/store.js';
import type { Finding, GoldenTask } from '../contracts/schemas.js';
import { loadGoldenTasks } from './golden.js';
import { parseDiff } from '../shell/reviewDiff.js';

export interface EvalSummary {
  evalId: string; goldenCount: number; passed: number; failed: number; score: number;
  perTask: Array<{ goldenId: string; pass: boolean; reasons: string[] }>;
  configSnapshot: Record<string, unknown>; l3Active: boolean; comparedTo?: string;
}

export function scoreEval(
  result: { passed: boolean; findings: Finding[] },
  expected: GoldenTask['expected'],
): { pass: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (result.passed !== expected.gatesPass) reasons.push(`gate beklenenin tersi: pipeline ${result.passed ? 'pass' : 'fail'}, expected ${expected.gatesPass ? 'pass' : 'fail'}`);
  for (const req of expected.requiredFindings) {
    if (!result.findings.some((f) => f.category === req.category && (!req.severity || f.severity === req.severity))) {
      reasons.push(`required bulgu eksik: ${req.category}`);
    }
  }
  for (const cat of expected.forbiddenCategories) {
    if (result.findings.some((f) => f.category === cat)) reasons.push(`forbidden kategori ihlali: ${cat}`);
  }
  return { pass: reasons.length === 0, reasons };
}

export async function runEval(args: {
  repoPath: string; pipeline: ReviewPipeline; policy: Policy; store: VerdictStore;
  candidate?: { label: string }; l3MinGoldenTasks: number;
}): Promise<EvalSummary> {
  const { tasks, invalid } = loadGoldenTasks(args.repoPath);
  const evalId = createHash('sha256').update(args.repoPath + tasks.length + invalid.join()).digest('hex').slice(0, 12) + '-' + Date.now();
  const runId = `eval-${evalId}`;
  const configSnapshot = { ...(args.candidate ? { candidate: args.candidate.label } : { mode: 'production' }), policyHash: createHash('sha256').update(JSON.stringify(args.policy)).digest('hex').slice(0, 16) };

  const perTask: EvalSummary['perTask'] = [];
  for (const t of tasks) {
    const files = parseDiff(t.fixtureDiff).map((f) => ({ path: f.path, content: f.addedContent }));
    const artifact = { diff: t.fixtureDiff, intent: `eval:${t.goldenId}`, rejectedAlternatives: [], testEvidence: 'golden', files };
    const ctx = { taskSpec: t.taskSpec, artifact, repoPath: args.repoPath, riskScore: 0 };
    const result = await args.pipeline.run(ctx);
    const verdict = scoreEval({ passed: result.passed, findings: result.findings }, t.expected);
    const art = await args.store.append('ArtifactProduced', runId, t.taskSpec.id, 'eval', { artifact, parentTaskEventId: 'eval' });
    await args.store.append('StageVerdict', runId, t.taskSpec.id, 'eval', { stage: 'eval', status: result.passed ? 'pass' : 'fail', durationMs: 0, parentArtifactEventId: art.event_id });
    for (const f of result.findings) await args.store.append('FindingEmitted', runId, t.taskSpec.id, f.stage, { finding: f, parentArtifactEventId: art.event_id });
    perTask.push({ goldenId: t.goldenId, pass: verdict.pass, reasons: verdict.reasons });
  }

  const passed = perTask.filter((p) => p.pass).length;
  const failed = perTask.length - passed;
  const score = perTask.length === 0 ? 0 : Math.round((passed / perTask.length) * 1000) / 10;
  const l3Active = tasks.length >= args.l3MinGoldenTasks;
  const prevRuns = args.store.query({ type: 'EvalRun' }).filter((e) => !('candidate' in e.payload.configSnapshot));
  const comparedTo = args.candidate && prevRuns.length > 0 ? prevRuns[prevRuns.length - 1].payload.evalId : undefined;
  const summary: EvalSummary = { evalId, goldenCount: perTask.length, passed, failed, score, perTask, configSnapshot, l3Active, ...(comparedTo ? { comparedTo } : {}) };
  await args.store.append('EvalRun', runId, '-', 'eval', {
    evalId: summary.evalId, goldenCount, passed, failed, score,
    perTask: summary.perTask, configSnapshot, ...(comparedTo ? { comparedTo } : {}),
  });
  void invalid; // invalid listesi CLI raporunda gösterilir
  return summary;
}
```
Not: `StageVerdict` payload `parentArtifactEventId` zorunlu (faz 2) — spread ile sağlanır. `randomUUID` kullanılmıyorsa import edilmez.

- [ ] **Step 4: PASS** (paket ~159) — **Step 5: Commit** `feat: eval runner — deterministik koşum, skor, EvalRun (R9)`

---

### Task 3: Shadow mode + CLI eval komutu (R9/R10 altyapısı)

**Files:**
- Modify: `src/shell/cli.ts` (eval komutu)
- Test: `tests/cli/cli.test.ts` (ekleme)

**Interfaces:**
- Produces: CLI `devloop eval [--candidate <policyDir>] [--full]` — production pipeline (candidate yoksa) veya candidate-policy pipeline koşar; karşılaştırma raporu JSON yazdırır; **üretim config'ine sıfır yazım**.

- [ ] **Step 1: Başarısız test**
```ts
it('eval komutu: candidate olmadan koşar ve EvalRun configSnapshot.mode=production yazar', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cli-ev-'));
  mkdirSync(join(dir, '.devloop', 'golden'), { recursive: true });
  writeFileSync(join(dir, '.devloop', 'golden', 'g1.task.json'), JSON.stringify({
    goldenId: 'g1',
    taskSpec: { id: 'gt1', description: 'd', acceptanceCriteria: ['a'], filesScope: [] },
    fixtureDiff: '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1,2 @@\n const x=1;\n+const y=2;',
    expected: { gatesPass: true, requiredFindings: [], forbiddenCategories: [] },
  }));
  await buildCli(dir).parseAsync(['node', 'devloop', 'eval'], { from: 'user' });
  const store = new VerdictStore(join(dir, '.devloop', 'events.jsonl'));
  const ev = store.query({ type: 'EvalRun' })[0];
  expect(ev.payload.configSnapshot).toMatchObject({ mode: 'production' });
});
```
- [ ] **Step 2: FAIL** → **Step 3: Implementasyon**

`src/shell/cli.ts` — eval komutu:
```ts
program.command('eval')
  .option('--candidate <policyDir>', 'aday policy dizini (policy.yaml içerir)')
  .option('--full', 'ensemble dahil koş (LLM çağrısı yapar)')
  .action(async (opts: { candidate?: string; full?: boolean }) => {
    const { loadConfig: lc } = await import('../config/config.js');
    const base = lc(repoDir());
    const effPolicy = opts.candidate ? lc(opts.candidate).policy : base.policy;
    const adapter = new TypeScriptAdapter();
    const stages = [
      new RiskTriageStage(effPolicy), new StaticGatesStage(adapter), new TestGateStage(adapter),
      new SecretScanStage(), new MutationStage(effPolicy),
    ];
    if (opts.full) stages.push(new LlmEnsembleStage(
      new LlmReviewerStage(gatewayFactory(effPolicy), mem),
      new LlmReviewerAltStage(gatewayFactory(effPolicy), { model: effPolicy.llm.fallbackModel, reviewerLessons: mem }),
      effPolicy,
    ));
    const pipeline = new ReviewPipeline(stages, { ...effPolicy, gates: effPolicy.gates, advisory: opts.full ? effPolicy.advisory : [] });
    const { runEval } = await import('../eval/evalRunner.js');
    const summary = await runEval({
      repoPath: repoDir(), pipeline, policy: effPolicy, store: store(),
      l3MinGoldenTasks: effPolicy.l3MinGoldenTasks,
      ...(opts.candidate ? { candidate: { label: opts.candidate } } : {}),
    });
    console.log(JSON.stringify(summary, null, 2));
  });
```
Not: `gatewayFactory` Task 6'da gelir — T3'te `--full` yalnız mevcut gateway assembly'siyle kurulur (factory refactor T6'da CLI'a uygulanır); T3'te `--full` yolunu derinlemesine test etmiyoruz (flag + dallanma mevcut), gerçek testler T6/T9'da.

- [ ] **Step 4: PASS** (paket ~160) — **Step 5: Commit** `feat: devloop eval komutu + shadow candidate karşılaştırma (R9)`

---

### Task 4: L3 evrim — evolve + apply (R10)

**Files:**
- Create: `src/evolution/evolve.ts`
- Modify: `src/contracts/events.ts` (ProposalCreated kind enum'e `'playbook-reviewer' | 'playbook-generator'` eklenir)
- Modify: `src/shell/cli.ts` (evolve komutları)
- Test: `tests/evolution/evolve.test.ts` (yeni)

**Interfaces:**
- Produces: `interface EvolutionCandidate { evoId; kind: 'playbook-reviewer' | 'playbook-generator' | 'policy-tweak'; title; content: Record<string, unknown>; sourceEvalId }`; `generateEvolutionCandidates(store, policy): EvolutionCandidate[]` (deterministik — tekrarlayan false-positive kategoriler → reviewer playbook yumuşatma; sık test-diff → generator playbook notu; **yalnız l3Active + golden ≥ l3MinGoldenTasks iken**); `runEvolveShadow(args): Promise<{ candidates; shadowEval: EvalSummary; report: string }>` (aday playbook'ları `candidate/` yaz + eval --candidate); `applyEvolution(args): Promise<DevloopEvent>` — **golden gerileme kontrolü: shadowEval.failed > baseline.failed → throw 'Evolve reddedildi: golden gerileme'**; yoksa playbook staging'e yazılır (`ProposalCreated` kind playbook-* + PROPOSAL.md).

- [ ] **Step 1: Başarısız test** — brief kodu verbatim; senaryolar: (a) l3Active=false → candidates boş; (b) tekrarlayan false-positive kategorisi + l3Active → playbook-reviewer adayı; (c) apply: shadowEval.failed > baseline → throw 'golden gerileme'; (d) apply: gerileme yok → ProposalCreated + staging dosyası; (e) enum: `playbook-reviewer` ProposalCreated doğrulanır.
- [ ] **Step 2: FAIL** → **Step 3: Implementasyon** — brief kodu aynen; kalıp motoru `learn.ts` bucket mantığını yeniden kullanır (kopya değil — `generateProposals`'ın bucket döngüsü referans alınarak yeni deterministik fonksiyon yazılır; proposalId = sha256(kind:title:sourceEvalId)).
- [ ] **Step 4: PASS** (paket ~165) — **Step 5: Commit** `feat: L3 evrim — evolve --shadow + golden-gerileme apply kapısı (R10)`

---

### Task 5: Risk-tiered tetikleme (R11)

**Files:**
- Modify: `src/pipeline/stages/mutationStage.ts` (kapsam ölçekleme), `src/shell/reviewDiff.ts` (CI derinliği), `src/shell/cli.ts` (review-diff policy alanları)
- Test: `tests/pipeline/mutationStage.test.ts` (ekleme), `tests/shell/reviewDiff.test.ts` (ekleme)

**Interfaces:**
- Produces: mutation `--mutate` seçimi `scope = risk < 30 ? mutationScopeLow : mutationScopeHigh` (dosyalar içerik-uzunluğu desc sıralı sonra slice); review-diff risk < `ciEnsembleRiskThreshold` → gates-only pipeline, ≥ → full (ensemble dahil).

- [ ] **Step 1: Başarısız test** — (a) mutation: risk 10 → 5 dosya, risk 50 → 10 dosya (12 dosyalı artifact ile çağrı-arg assertion'ı güncellenir); (b) review-diff: risk 10'da ensemble stage çağrılmaz, risk 20'de çağrılır (ensemble fake'li pipeline'lar).
- [ ] **Step 2: FAIL** → **Step 3: Implementasyon** — mutationStage: `const scope = ctx.riskScore < 30 ? policy.mutationScopeLow : policy.mutationScopeHigh; const mutate = [...ctx.artifact.files].sort((a, b) => b.content.length - a.content.length).slice(0, scope).map((f) => f.path).join(',');` reviewDiff: `runReviewDiff` pipeline seçimini triaj sonrasına taşır — önce RiskTriageStage koşar, `ctx.riskScore < policy.ciEnsembleRiskThreshold` → gatePipeline (gates-only stages), değilse fullPipeline (gates + ensemble).
- [ ] **Step 4: PASS** (paket ~169) — **Step 5: Commit** `feat: risk-tiered — mutation kapsam ölçekleme + CI derinliği (R11)`

---

### Task 6: OpenAI adapter + gateway factory (R12)

**Files:**
- Create: `src/gateway/openai.ts`, `src/gateway/factory.ts`
- Modify: `src/shell/cli.ts` (createGateway kullanımı)
- Test: `tests/gateway/openai.test.ts`, `tests/gateway/factory.test.ts` (yeni)

**Interfaces:**
- Produces: `class OpenAIGateway implements LlmGateway` (ctor `(policy, fetchImpl?, sleepImpl?)` — anahtar `OPENAI_API_KEY`; `POST https://api.openai.com/v1/chat/completions`; body `{ model, messages: [system,user], response_format: { type: 'json_object' } }`; parse `choices[0].message.content` → extractJson → schema; retry/backoff/fallback `openai.fallbackModel`; usage `prompt_tokens/completion_tokens` → openai oranları); `createGateway(policy): LlmGateway` (provider'a göre).

- [ ] **Step 1: Başarısız test** — mock matris (geçerli yanıt+maliyet, bozuk→retry→fallback, fallback başarısız→GatewayError, anahtarsız→GatewayError) + factory testleri (anthropic→AnthropicGateway, openai→OpenAIGateway).
- [ ] **Step 2: FAIL** → **Step 3: Implementasyon** — AnthropicGateway deseninin birebir OpenAI karşılığı (endpoint/body/parse farklarıyla; backoff + model override + sleepImpl aynen). Factory:
```ts
import type { Policy } from '../config/config.js';
import type { LlmGateway } from './gateway.js';
import { AnthropicGateway } from './gateway.js';
import { OpenAIGateway } from './openai.js';

export function createGateway(policy: Policy): LlmGateway {
  return policy.llm.provider === 'openai' ? new OpenAIGateway(policy) : new AnthropicGateway(policy);
}
```
CLI: `const gateway = createGateway(effPolicy)` — tüm komutlarda doğrudan AnthropicGateway yerine factory (budgeted sarmalama aynen).
- [ ] **Step 4: PASS** (paket ~175) — **Step 5: Commit** `feat: OpenAI adapter + gateway factory (R12)`

---

### Task 7: Container sandbox (R13)

**Files:**
- Create: `src/shell/sandbox.ts`
- Modify: `src/adapters/typescript/index.ts` (runTool docker sarmalama), `src/orchestrator/orchestrator.ts` (run-başı aktivasyon kontrolü)
- Test: `tests/shell/sandbox.test.ts` (yeni)

**Interfaces:**
- Produces: `dockerAvailable(): Promise<boolean>` (`docker info` spawn, catch → false); `dockerizeSpawn(args: { repoPath: string; policy: Policy; bin: string; args: string[] }): { cmd: string; args: string[] }` — docker modunda `{ cmd: 'docker', args: ['run', '--rm', '-v', `${worktree}:/workspace`, '-w', '/workspace', '--network', 'none', policy.sandbox.image, 'npx', ...toolArgs] }` (bin konteyner içi npx ile çözülür — hedef repo toolchain'i; safeEnv `-e` flag'leriyle); host modunda değişmez.

- [ ] **Step 1: Başarısız test**
```ts
it('docker modu: spawn docker run sarmalına çevrilir (network none, mount, image)', () => {
  const r = dockerizeSpawn({ repoPath: 'C:/r', policy: dockerPolicy, bin: 'C:/r/node_modules/eslint/bin/eslint.js', args: ['-f', 'json', '.'] });
  expect(r.cmd).toBe('docker');
  expect(r.args[0]).toBe('run');
  expect(r.args).toContain('--network');
  expect(r.args[r.args.indexOf('--network') + 1]).toBe('none');
  expect(r.args).toContain('node:20-bookworm-slim');
  expect(r.args[r.args.length - 2]).toBe('npx');
});
it('host modu: değişmez', () => {
  const r = dockerizeSpawn({ repoPath: 'C:/r', policy: hostPolicy, bin: 'x', args: ['a'] });
  expect(r.cmd).toBe('x');
});
it('dockerAvailable: docker info başarısızsa false', async () => { /* mock execFile catch */ });
```
- [ ] **Step 2: FAIL** → **Step 3: Implementasyon** — `dockerizeSpawn` saf fonksiyon (test edilebilir); `runTool` policy.sandbox.mode==='docker' iken `dockerizeSpawn` kullanır (resolveBin atlanır — konteyner içi npx çözümler; `-v worktree:/workspace` mount; bin arg'ı `npx` + tool args ile değiştirilir); orchestrator `run()`: `sandbox.mode==='docker' && !(await dockerAvailable())` → `RunAborted(reason:'panic')` + açık errorMessage içeren summary log (sessiz düşüş yok).
- [ ] **Step 4: PASS** (paket ~178; gerçek docker testi `DEVLOOP_DOCKER=1` flag'li ayrı `it`) — **Step 5: Commit** `feat: container sandbox — koşullu docker spawn sarmalayıcı (R13)`

---

### Task 8: Sertleştirmeler + faz 2 SHIP kalıntıları (R14)

**Files:**
- Modify: `src/pipeline/stages/mutationStage.ts` (mutantId), `src/shell/reviewDiff.ts` (parseDiff state-machine), `src/generator/apply.ts` (denylist genişletme), `src/gateway/gateway.ts` (errorMessage çocuk neden — faz 2'de yapıldıysa skip), `src/shell/cli.ts` (L2 eşik mesajı)
- Test: ilgili dosyalara ekleme + faz 2 kalıntı pin'leri

**Interfaces:**
- Produces: mutation per-mutant bulgularda `evidence.mutantId`; `parseDiff` state-machine (header tanıma yalnız hunk başında); applyArtifact denylist'e `tsconfig.json`, `eslint.config.js`, `.eslintrc.json`; L2 eşik-altı `learn` çıktısında explicit `L2 devre dışı (l2MinDecisions=100, mevcut: N)` mesajı; backoff sekans pin testi (`sleeps` deep-equal `[500, 1000, 500, 1000]`); R4c güçlendirilmiş Unicode testi (diakritikli kural kelimesi + ASCII task → eşleşme yalnız yeni split ile mümkün).

- [ ] **Step 1: Başarısız testler** (her sertleştirme için bir) → **Step 2: FAIL** → **Step 3: Implementasyon** (her madde minimal) → **Step 4: PASS** (paket ~185) — **Step 5: Commit** `feat: sertleştirme paketi — mutantId, parseDiff state-machine, denylist genişletme, SHIP kalıntıları (R14)`

---

### Task 9: Faz 3 golden + invariants + README (R15)

**Files:**
- Modify: `tests/e2e/invariants.test.ts`, `README.md`
- Create: `tests/e2e/evalShadow.test.ts`
- Test: yeni + güncelleme

**Interfaces:**
- Produces: faz 3 kabul kriterlerinin kanıtı (R15).

- [ ] **Step 1: E2E eval/shadow testi** — fixture golden set (3 görev) → `devloop eval` (deterministik: gateway spy sıfır çağrı) → `--candidate` shadow (gerileme senaryosu: candidate policy gates'i gevşetir → skor düşer → rapor `comparedTo` taşır) → üretim config dosyasının içerik özeti değişmez (no-write kanıtı).
- [ ] **Step 2: Invariants ekleri** — (a) evolve apply golden-gerileme reddi (R10 kapısı); (b) mutantId evidence akışı; (c) parseDiff edge (içerik-başlangıçlı satır korunur); (d) risk-tier sınır pin'leri (20/30); (e) docker komut inşası pin'i.
- [ ] **Step 3: README** — "Faz 3" bölümü: eval/golden kullanımı, L3 evolve + eşikler, risk-tiered davranış, OpenAI provider (OPENAI_API_KEY), sandbox modları (docker gereksinimleri); policy tablosu faz 3 alanlarıyla güncellenir.
- [ ] **Step 4: Tüm paket** — `npx vitest run` (hedef ~195) + `npx tsc --noEmit` temiz.
- [ ] **Step 5: Commit** `feat: faz3 golden + invariants + README (R15)`

---

## Self-Review Notları (plan yazarı)

1. **Spec kapsam:** R9→T1/T2/T3; R10→T4; R11→T5; R12→T1(policy)+T6; R13→T1(policy)+T7; R14→T8; R15→T9; R16 ertelemeler plana girmez.
2. **Bilinen riskler:** T2 eval pipeline'ı sahte stage'lerle test edilir — gerçek pipeline'la T9 entegrasyonu; T4'ün golden-gerileme kapısı testte gerçek eval karşılaştırması gerektirir (shadowEval sahte değil, gerçek runEval çıktısıyla); T5 policy-adı değişikliği yok (yalnız davranış); T7 dockerizeSpawn'da `-v` mount yolu Windows backslash — `resolve` + forward-slash normalize; T6 OpenAI `response_format` bazı modellerde desteklenmez — parse fallback prompt yolu korunur.
3. **Tip tutarlılığı:** `GoldenTask` T1'de; `runEval` T2'de T1'i tüketir; `EvolutionCandidate` T4'te `ProposalCreated` enum genişlemesini kullanır; `createGateway` T6'da, CLI T6'da geçirilir; `dockerizeSpawn` T7'de runTool'u sarmalar.
