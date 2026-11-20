# devloop Faz 4 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Spec Revizyon 4 (R17–R22): golden dataset büyütme araçları (draft/accept/discard), generator playbook wiring, LLM üretimli playbook mutasyonları (eval + insan kapılı), container sandbox mutation genişletmesi + `:ro` hardening, cross-provider fallback + gateway/küçükler paketi.

**Architecture:** Yaklaşım 1 — kontrat ekleme devamı. Golden draft = yeni `src/golden/` modülü + CLI alt-komutları; generator playbook = backend prompt bağlantısı (reviewer deseni); LLM mutasyonlar = evolve uzantısı (`--llm` flag, eval + insan kapılı); sandbox = mevcut dockerizeSpawn'ın mutation'a genişletmesi + faz 3 T7 guard'ının kaldırılması; cross-fallback = gateway zinciri factory'de.

**Tech Stack:** değişiklik yok.

**Spec:** `docs/superpowers/specs/2026-11-18-ai-dev-loop-design.md` — Revizyon 4 (R17–R24). Executor spec + planı birlikte okur.

## Global Constraints

- **A1–A6 + R1–R6 + R9–R16 aynen** — mevcut 219+1skip test bozulmaz; davranış değişen yerler `// hüküm:` notlu.
- **R17 A5:** golden draft yalnız `.devloop/golden-drafts/` staging'ine yazar — golden/ dizinine direkt yazım yok (insan `accept` ile taşır).
- **R19 kapılar:** `--llm` yalnız `l3Active` (golden ≥ eşik) + gateway anahtarı varken çalışır; anahtarsız fail-closed; deterministik mod default değişmez. Donmuş yargıç aynen.
- **R20:** faz 3 T7 fix 3'teki docker-mutation fail-closed guard KALDIRILIR (yerine gerçek koşum gelir); node_modules bind `:ro`; worktree bind rw; triaj ölçekleme aynen.
- **R21 koşullu:** cross-fallback yalnız `llm.crossProviderFallback: true` + ilgili anahtarlar mevcutken; eksik anahtarlı ayak atlanır; hiçbiri yoksa GatewayError.
- Gerçek Stryker/docker testleri mevcut flag'lerinde (Stryker host-mode testi aynen; docker koşum `DEVLOOP_DOCKER=1`).

---

### Task 1: Golden draft üretimi + küratörlük (R17)

**Files:**
- Create: `src/golden/draft.ts`
- Modify: `src/shell/cli.ts` (`golden draft/list/accept/discard` alt-komutları)
- Modify: `src/eval/golden.ts` (duplicate goldenId → invalid)
- Test: `tests/golden/draft.test.ts` (yeni), `tests/eval/golden.test.ts` (ekleme), `tests/cli/cli.test.ts` (ekleme)

**Interfaces:**
- Produces: `acceptedRuns(store, fromRun?): string[]` (HumanDecision accept + PRCreated kesişimi); `generateGoldenDrafts(args: { store; repoPath: string; draftsDir: string; fromRun?: string }): Promise<GoldenDraftResult>` — kabul koşum kanıtından `GoldenTask` taslağı üretip `.devloop/golden-drafts/<goldenId>.task.json` staging'ine yazar (golden/ dizinine DOKUNMAZ); `acceptDraft(draftsDir, goldenDir, draftId): void` (duplicate goldenId → throw; GoldenTaskSchema doğrulama); `discardDraft(draftsDir, draftId): void`; CLI `golden draft/list/accept/discard`.

- [ ] **Step 1: Başarısız test**
```ts
import { describe, it, expect } from 'vitest';
import { acceptedRuns, generateGoldenDrafts, acceptDraft, discardDraft } from '../../src/golden/draft.js';
import { VerdictStore, validateChain } from '../../src/store/store.js';
import { loadGoldenTasks } from '../../src/eval/golden.js';
import { mkdtempSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

function seedAcceptedRun(store: VerdictStore, runId: string) {
  store.append('RunStarted', runId, '-', 'o', { configSnapshot: {} });
  const picked = store.append('TaskPicked', runId, 't1', 'o', { taskSpec: { id: 't1', description: 'toplama ekle', acceptanceCriteria: ['sum(2,3)===5'], filesScope: [] } });
  const art = store.append('ArtifactProduced', runId, 't1', 'b', { artifact: { diff: '--- a/src/math.ts\n+++ b/src/math.ts\n@@ -1 +1,2 @@\n const x=1;\n+export const sum=(a:number,b:number)=>a+b;', intent: 'sum eklendi', rejectedAlternatives: [], testEvidence: 'vitest 3 passed', files: [] }, parentTaskEventId: picked.event_id });
  store.append('PRCreated', runId, 't1', 'o', { url: 'https://pr/x', title: 't1', commitSha: null, diffDigest: 'd' });
  const f = store.append('FindingEmitted', runId, 't1', 'llm-ensemble', { finding: { id: 'f1', stage: 'llm-ensemble', category: 'lint', severity: 'required', confidence: 0.9, evidence: { file: 'src/math.ts', line: 2 }, corroborated: false }, parentArtifactEventId: art.event_id });
  store.append('HumanDecision', runId, 't1', 'h', { decision: 'accept', reason: 'real-issue-accepted', parentFindingEventIds: [f.event_id] });
  return { picked, art, f };
}

describe('golden draft', () => {
  it('kabul edilmiş koşumdan taslak üretir; reject kategorisi forbidden olur', async () => {
    const store = new VerdictStore(join(mkdtempSync(join(tmpdir(), 'gd-')), 'e.jsonl'));
    await seedAcceptedRun(store, 'r1');
    const repo = mkdtempSync(join(tmpdir(), 'gdr-'));
    const r = await generateGoldenDrafts({ store, repoPath: repo, draftsDir: join(repo, '.devloop', 'golden-drafts') });
    expect(r.drafts).toHaveLength(1);
    expect(r.drafts[0].expected.gatesPass).toBe(true);
    expect(r.drafts[0].expected.requiredFindings).toEqual([{ category: 'lint' }]);
    expect(existsSync(join(repo, '.devloop', 'golden-drafts', r.drafts[0].goldenId + '.task.json'))).toBe(true);
    expect(existsSync(join(repo, '.devloop', 'golden'))).toBe(false); // golden/ dokunulmaz
  });
  it('accept: staging → golden/ taşınır ve loadGoldenTasks görür; duplicate throw', async () => {
    const store = new VerdictStore(join(mkdtempSync(join(tmpdir(), 'gd2-')), 'e.jsonl'));
    await seedAcceptedRun(store, 'r1');
    const repo = mkdtempSync(join(tmpdir(), 'gda-'));
    const draftsDir = join(repo, '.devloop', 'golden-drafts');
    const goldenDir = join(repo, '.devloop', 'golden');
    const r = await generateGoldenDrafts({ store, repoPath: repo, draftsDir });
    acceptDraft(draftsDir, goldenDir, r.drafts[0].goldenId);
    expect(loadGoldenTasks(repo).tasks).toHaveLength(1);
    expect(() => acceptDraft(draftsDir, goldenDir, r.drafts[0].goldenId)).toThrow(/duplicate/i);
  });
  it('discard: staging silinir', async () => { /* üret → discard → existsSync false */ });
  it('PR olmayan kabul koşumu atlanır', async () => { /* sadece accept, PRCreated yok → 0 taslak */ });
});
```
(Test gövdeleri brief-verbatim tamamlanır — ilk iki test tamam, son ikisi aynı desenle.)

- [ ] **Step 2: FAIL** → **Step 3: Implementasyon**

`src/golden/draft.ts`:
```ts
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { VerdictStore } from '../store/store.js';
import type { GoldenTask } from '../eval/golden.js';
import { GoldenTaskSchema } from '../eval/golden.js';

export function acceptedRuns(store: VerdictStore, fromRun?: string): string[] {
  const accepted = new Set(store.query({ type: 'HumanDecision' }).filter((e) => e.payload.decision === 'accept').map((e) => e.run_id));
  const prd = new Set(store.query({ type: 'PRCreated' }).map((e) => e.run_id));
  return [...accepted].filter((r) => prd.has(r) && (fromRun === undefined || r === fromRun));
}

export async function generateGoldenDrafts(args: {
  store: VerdictStore; repoPath: string; draftsDir: string; fromRun?: string;
}): Promise<{ drafts: GoldenTask[]; written: number; skipped: number }> {
  const drafts: GoldenTask[] = [];
  let written = 0, skipped = 0;
  for (const runId of acceptedRuns(args.store, args.fromRun)) {
    const picked = args.store.query({ runId, type: 'TaskPicked' })[0];
    const art = args.store.query({ runId, type: 'ArtifactProduced' })[0];
    const pr = args.store.query({ runId, type: 'PRCreated' })[0];
    if (!picked || !art || !pr) { skipped++; continue; }
    const decisions = args.store.query({ runId, type: 'HumanDecision' });
    const byFinding = new Map(args.store.query({ runId, type: 'FindingEmitted' }).map((e) => [e.event_id, e.payload.finding]));
    const required = new Set<string>();
    const forbidden = new Set<string>();
    for (const d of decisions) {
      for (const fid of d.payload.parentFindingEventIds) {
        const f = byFinding.get(fid);
        if (!f) continue;
        if (d.payload.reason === 'real-issue-accepted') required.add(f.category);
        if (d.payload.reason === 'false-positive') forbidden.add(f.category);
      }
    }
    const task = {
      goldenId: createHash('sha256').update(JSON.stringify(picked.payload.taskSpec) + art.payload.artifact.diff).digest('hex').slice(0, 16),
      taskSpec: picked.payload.taskSpec,
      fixtureDiff: art.payload.artifact.diff,
      expected: {
        gatesPass: true, // PRCreated yalnız gates pass sonrası açılır (A2)
        requiredFindings: [...required].map((c) => ({ category: c })),
        forbiddenCategories: [...forbidden],
      },
    };
    drafts.push(GoldenTaskSchema.parse(task));
  }
  mkdirSync(args.draftsDir, { recursive: true });
  for (const d of drafts) {
    const p = join(args.draftsDir, `${d.goldenId}.task.json`);
    if (existsSync(p)) { skipped++; continue; }
    writeFileSync(p, JSON.stringify(d, null, 2), 'utf8');
    written++;
  }
  return { drafts, written, skipped };
}

export function acceptDraft(draftsDir: string, goldenDir: string, draftId: string): void {
  const src = join(draftsDir, `${draftId}.task.json`);
  if (!existsSync(src)) throw new Error(`Taslak bulunamadı: ${draftId}`);
  const parsed = GoldenTaskSchema.parse(JSON.parse(readFileSync(src, 'utf8')));
  mkdirSync(goldenDir, { recursive: true });
  const dst = join(goldenDir, `${parsed.goldenId}.task.json`);
  if (existsSync(dst)) throw new Error(`Duplicate goldenId: ${parsed.goldenId} — mevcut dosya: ${dst}`);
  renameSync(src, dst);
}

export function discardDraft(draftsDir: string, draftId: string): void {
  rmSync(join(draftsDir, `${draftId}.task.json`), { force: true });
}
```

CLI:
```ts
const goldenCmd = program.command('golden').description('golden dataset küratörlüğü');
goldenCmd.command('draft').option('--from-run <runId>').action(async (opts: { fromRun?: string }) => {
  const r = await generateGoldenDrafts({ store: store(), repoPath: repoDir(), draftsDir: join(repoDir(), '.devloop', 'golden-drafts'), ...(opts.fromRun ? { fromRun: opts.fromRun } : {}) });
  console.log(JSON.stringify(r, null, 2));
});
goldenCmd.command('list').action(async () => {
  const d = join(repoDir(), '.devloop', 'golden-drafts');
  const names = existsSync(d) ? readdirSync(d).filter((n) => n.endsWith('.task.json')) : [];
  console.log(names.join('\n') || '(taslak yok)');
});
goldenCmd.command('accept').argument('<draftId>').action(async (id: string) => {
  acceptDraft(join(repoDir(), '.devloop', 'golden-drafts'), join(repoDir(), '.devloop', 'golden'), id);
  console.log('Golden görev kabul edildi.');
});
goldenCmd.command('discard').argument('<draftId>').action(async (id: string) => {
  discardDraft(join(repoDir(), '.devloop', 'golden-drafts'), id);
  console.log('Taslak atıldı.');
});
```

`src/eval/golden.ts` — loadGoldenTasks duplicate tespiti:
```ts
// parse edilen tasks'tan sonra:
const seen = new Set<string>();
for (const t of [...tasks]) {
  if (seen.has(t.goldenId)) { invalid.push(`duplicate:${t.goldenId}`); tasks.splice(tasks.indexOf(t), 1); }
  else seen.add(t.goldenId);
}
```
Test ekleme: aynı goldenId'li iki dosya → tasks 1, invalid `['duplicate:g1']`.

- [ ] **Step 4: PASS** (paket ~164) — **Step 5: Commit** `feat: golden draft üretimi + küratörlük komutları (R17)`

---

### Task 2: Generator playbook wiring (R18)

**Files:**
- Modify: `src/evolution/evolve.ts` (loadAppliedPlaybooks → generatorContext), `src/generator/generator.ts` (ctor + prompt), `src/shell/cli.ts` (geçiş)
- Test: `tests/generator/generator.test.ts` (ekleme), `tests/evolution/evolve.test.ts` (ekleme)

**Interfaces:**
- Produces: `loadAppliedPlaybooks(repoPath): { reviewerContext(): string; generatorContext(): string }` (generatorContext = kind `playbook-generator` satırları); `LlmGeneratorBackend` ctor `(gateway, memory?, playbookProvider?)` — prompt'a `GENERATOR PLAYBOOK (insan-onaylı kurallar): ...` bloğu (non-empty iken).

- [ ] **Step 1: Başarısız test**
```ts
it('applied playbook-generator → generator prompt\'ta görünür', async () => {
  // applyEvolution ile playbook-generator staging → loadAppliedPlaybooks
  // backend = new LlmGeneratorBackend(gw, undefined, playbooks)
  // generate → capturedUser contains playbook title/note
});
```
- [ ] **Step 2: FAIL** → **Step 3: Implementasyon** — evolve.ts: loadAppliedPlaybooks her iki context'i döndürür (kind filtresi per-context); generator.ts: ctor üçüncü param + prompt bloğu (`GENERATOR PLAYBOOK (insan-onaylı kurallar):\n${...}` non-empty iken; boşsa blok eklenmez); cli.ts: `new LlmGeneratorBackend(gateway, mem, playbooks)` — playbooks = loadAppliedPlaybooks(repoDir()).
- [ ] **Step 4: PASS** (paket ~166) — **Step 5: Commit** `feat: generator playbook wiring (R18)`

---

### Task 3: Küçükler paketi (R22)

**Files:**
- Create: `src/shell/composeLessons.ts`
- Modify: `src/shell/cli.ts` (3 site), `src/generator/apply.ts` (denylist), `src/shell/reviewDiff.ts` (parseDiff ws + state-machine zaten var — ws toleransı), `src/eval/evalRunner.ts` (evalId uniq), `src/config/config.ts` (superRefine), `src/contracts/events.ts` (EvalRun refine), `src/eval/golden.ts` (duplicate — T1'de yapıldı ise skip), `tests/gateway/gateway.test.ts` (import type z)
- Test: ilgili dosyalara ekleme

**Interfaces:**
- Produces: `composeReviewerLessons(sources): { reviewerContext(): string }` — satır bazlı 'yok.' filtre; denylist 5 kardeş yüzey; parseDiff `[ \t]*$` toleranslı header; evalId uniq; şema invariants.

- [ ] **Step 1: Başarısız testler** — (a) compose: mem 'Reviewer dersi yok.' + playbooks gerçek satır → çıktıda 'yok.' satırı YOK, gerçek satır VAR; tek kaynak 'yok.' içeren gerçek satır... per-line filter 'yok.' içeren satırı atar, diğerlerini korur; (b) apply: `Eslint.config.CJS` reddi; (c) parseDiff: `+++ b/x.ts ` trailing-space header tanınır; (d) evalId: iki koşum farklı evalId (randomUUID ile); (e) EvalRun refine: passed+failed ≠ goldenCount → parse reddi; policy refine: scopeLow ≥ High → reddi.
- [ ] **Step 2: FAIL** → **Step 3: Implementasyon** — brief kodları aynen; compose helper:
```ts
import type { LessonMemory } from '../memory/memory.js';
import type { loadAppliedPlaybooks } from '../evolution/evolve.js';

export function composeReviewerLessons(sources: Array<{ reviewerContext(): string }>): { reviewerContext(): string } {
  return {
    reviewerContext: () => {
      const lines = sources.flatMap((s) => s.reviewerContext().split('\n')).filter((l) => l.trim().length > 0 && !l.includes('yok.'));
      return lines.length === 0 ? 'Reviewer dersi yok.' : lines.join('\n');
    },
  };
}
```
CLI 3 site: `const reviewerLessons = composeReviewerLessons([mem, playbooks]);` — stage'lere bu geçilir. policy superRefine: `Policy.superRefine` yerine zod `.refine` chain sonuna — config.ts Policy şemasına `.superRefine((p, ctx) => { if (p.risk && p.mutationScopeLow >= p.mutationScopeHigh) ctx.addIssue(...); })` (Policy object schema'sına). events.ts EvalRun payload `.superRefine((e, ctx) => { if (e.passed + e.failed !== e.goldenCount) ctx.addIssue(...); })`.
- [ ] **Step 4: PASS** (paket ~171) — **Step 5: Commit** `feat: küçükler paketi — per-line filter, denylist kardeşler, parseDiff ws, evalId uniq, şema invariants (R22)`

---

### Task 4: LLM üretimli playbook mutasyonları (R19)

**Files:**
- Modify: `src/evolution/evolve.ts` (`generateLlmMutations` + CLI --llm)
- Modify: `src/shell/cli.ts` (evolve --llm flag)
- Test: `tests/evolution/evolve.test.ts` (ekleme)

**Interfaces:**
- Produces: `generateLlmMutations(args: { ctx: EvolveContext; gateway: LlmGateway; baseline: EvalSummary; shadowEval: EvalSummary }): Promise<EvolutionCandidate[]>` — **l3Active guard:** `ctx.goldenCount < ctx.l3MinGoldenTasks → throw 'L3 eşik altı — deterministik mod kullanın'`; **gateway anahtarsız → GatewayError propagates** (fail-closed mesaj); prompt: verdict pattern'leri + baseline/shadow perTask farkları → LLM önerir `{ mutations: [{ kind: 'playbook-reviewer'|'playbook-generator'|'policy-tweak', title, content, rationale }] }`; evoId = sha256(kind:title:content).slice(16); çıktı candidate/ staging'e (writeShadowCandidates yeniden kullanılır).
- CLI: `evolve --shadow --llm` — shadow koşumu sonrası LLM mutasyon taslakları da candidate/'e yazılır; `--llm` yoksa davranış aynen (deterministik).

- [ ] **Step 1: Başarısız test**
```ts
it('--llm: mock gateway mutasyon taslağı üretir ve staging\'e yazılır', async () => {
  // l3Active koşulu: goldenCount ≥ eşik (fixture golden set 1 görev + l3MinGoldenTasks: 1 override policy)
  const gw = { complete: vi.fn(async (req: { user: string }) => {
    capturedUser = req.user;
    return { data: { mutations: [{ kind: 'playbook-reviewer', title: 'kanıt eşiği yükselt', content: { category: 'perf' }, rationale: 'tekrarlayan fp' }] }, usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 } };
  }) } as unknown as LlmGateway;
  const cands = await generateLlmMutations({ ctx, gateway: gw, baseline, shadowEval });
  expect(cands).toHaveLength(1);
  expect(existsSync(join(ctx.candidateDir, cands[0].evoId + '.json'))).toBe(true);
  expect(capturedUser).toContain('baseline');
});
it('anahtarsız (GatewayError) → fail-closed yukarı fırlar', async () => { /* gateway throws GatewayError('anahtar yok') → expect rejects */ });
it('deterministik mod: --llm yoksa gateway çağrısı hiç yapılmaz', async () => { /* generateEvolutionCandidates çağrısı + spy zero-call */ });
```
- [ ] **Step 2: FAIL** → **Step 3: Implementasyon** — brief kodu aynen; l3Active guard: `if (ctx.goldenCount < ctx.l3MinGoldenTasks) throw new Error('L3 eşik altı — deterministik mod kullanın');` — CLI `--llm` flag'i bu hatayı yakalayıp anlamlı mesajla raporlar (exit non-zero).
- [ ] **Step 4: PASS** (paket ~174) — **Step 5: Commit** `feat: LLM üretimli playbook mutasyonları — eval + insan kapılı (R19)`

---

### Task 5: Sandbox mutation genişletmesi + :ro (R20)

**Files:**
- Modify: `src/pipeline/stages/mutationStage.ts` (docker destek + guard kaldırma), `src/shell/sandbox.ts` (:ro), `src/adapters/typescript/index.ts` (runTool mutation uyumu), `tests/pipeline/mutationStage.test.ts` (guard test güncelleme hükümlü)
- Test: güncelleme + ekleme

**Interfaces:**
- Produces: MutationStage docker modda gerçek koşum (dockerizeSpawn: `npx stryker run --mutate ... --reporters clear-text,json` konteyner içi; mutation.json konteyner mount'undan okunur); faz 3 T7 fix 3 guard'ı KALDIRILIR (hüküm — yerini gerçek koşum alır); node_modules bind `:ro`; triaj ölçekleme docker modda aynen.

- [ ] **Step 1: Başarısız test**
```ts
it('docker mod + stryker config → gerçek koşum desteği (guard kaldırıldı)', async () => {
  // fixture repo (stryker.config.json'lı) + docker policy + adapter(policy, originalRepoPath)
  // mutationStage.evaluate → mock runner docker-mod spawn döner → mutation.json fixture'dan parse
  // assert: status fail (survived), evidence.mutantId, spawn cmd 'docker'
});
it('docker mod runner inject edilebilir (mock stryker çıktısı)', async () => {
  // MutationStage ctor (policy, runner?) — runner = (spawnDesc) => Promise<ToolOutput>
  // docker policy + stryker config → runner docker-mod desc alır, sahte stdout döner → skor parse → fail/pass
});
```
- [ ] **Step 2: FAIL** → **Step 3: Implementasyon**
- mutationStage ctor: `(policy, runner?)` — default runner: `(desc) => runTool(desc.repoPath, desc.bin, desc.args, desc.timeoutMs)` (host) / docker modda `dockerizeSpawn` üzerinden docker exec. `dockerizeSpawn` stryker için: `npx stryker run ...` (konteyner içi npx; hedef repo toolchain'i mount'tan).
- Guard kaldırılır: docker mod + config → normal akış; runner dockerizeSpawn desc alır.
- `dockerizeSpawn` node_modules bind'e `:ro` ekler.
- Testler: docker-mod (mock runner) skor parse → fail/pass; guard kaldırılma assertion'ı (eski test güncellenir hüküm notlu); `:ro` pin.
- [ ] **Step 4: PASS** (paket ~178) — **Step 5: Commit** `feat: sandbox mutation genişletmesi + node_modules :ro (R20)`

---

### Task 6: Cross-provider fallback (R21)

**Files:**
- Modify: `src/config/config.ts` (crossProviderFallback), `src/gateway/factory.ts` (createGateways + ChainedGateway), `src/shell/cli.ts` (chain geçişi)
- Test: `tests/gateway/factory.test.ts` (ekleme)

**Interfaces:**
- Produces: policy `llm.crossProviderFallback: false` default; `createGateways(policy): LlmGateway[]` (birincil + cross-fallback açıkken diğer sağlayıcı — anahtar varsa); `class ChainedGateway implements LlmGateway` (ctor `(gateways: LlmGateway[])` — complete sırayla dener, GatewayError'ları toplayıp sonunda fırlatır; usage birincil başarılı ayaktan).

- [ ] **Step 1: Başarısız test**
```ts
it('cross-fallback: anthropic HTTP hatalı → openai başarılı', async () => {
  const anthropic = new AnthropicGateway(policy, vi.fn().mockResolvedValue(api('x', 500)) as typeof fetch);
  const openai = new OpenAIGateway(openaiPolicy, vi.fn().mockResolvedValue(openaiApi('{"answer":"ok"}')) as typeof fetch);
  const chain = new ChainedGateway([anthropic, openai]);
  expect((await chain.complete({ system: 's', user: 'q', schema: Schema, runId: 'r' })).data.answer).toBe('ok');
});
it('cross-fallback kapalı (config false) → tek gateway', async () => { /* createGateways length 1 */ });
it('anahtar eksik ayak atlanır; hiçbiri yoksa GatewayError', async () => { /* env temiz → createGateways [] → ChainedGateway([]) → complete rejects GatewayError */ });
```
- [ ] **Step 2: FAIL** → **Step 3: Implementasyon** — config: `crossProviderFallback: z.boolean().default(false)`; factory: `createGateways(policy): LlmGateway[]` — anthropic gateway (ANAHTAR mevcutsa), openai gateway (ANAHTAR mevcutsa), sıra provider'a göre; crossProviderFallback false → yalnız birincil; `ChainedGateway` — sırayla dener, GatewayError toplayıp sonunda fırlatır (son neden mesajı). CLI: `const chain = createGateways(policy); const gateway = new BudgetedGateway(new ChainedGateway(chain), ...)`.
- [ ] **Step 4: PASS** (paket ~181) — **Step 5: Commit** `feat: cross-provider fallback + ChainedGateway (R21)`

---

### Task 7: Faz 4 golden + invariants + README (R23)

**Files:**
- Modify: `tests/e2e/invariants.test.ts`, `README.md`
- Create: `tests/e2e/goldenDraft.test.ts`
- Test: yeni + güncelleme

**Interfaces:**
- Produces: faz 4 kabul kriterlerinin kanıtı (R23).

- [ ] **Step 1: E2E golden-draft testi** — seed accepted run (store) → `devloop golden draft` CLI → staging taslak → `devloop golden accept` → `devloop eval` production (golden set 1 görev, beklenen pass) → score 100; duplicate accept → throw; `validateChain` ok; **golden/ dışına draft yazım yok** (staging-only kanıtı).
- [ ] **Step 2: Invariants ekleri** — (a) per-line filter: 'yok.' içeren satır atılır, diğerleri korunur (composeReviewerLessons unit); (b) denylist kardeşler; (c) EvalRun refine; (d) policy refine; (e) cross-fallback matris (zaten T6 unit — invariant versiyonu: config kapalı → tek ayak); (f) docker :ro pin (zaten T5 — referans).
- [ ] **Step 3: README** — "## Faz 4" bölümü: golden draft/accept/discard workflow (L3 veri yolu), generator playbook, `evolve --llm` (eval + insan kapılı; anahtarsız deterministik), sandbox mutation + `:ro`, cross-fallback config; policy tablosuna `llm.crossProviderFallback=false`.
- [ ] **Step 4: Tüm paket** — `npx vitest run` (hedef ~225) + `npx tsc --noEmit` temiz.
- [ ] **Step 5: Commit** `feat: faz4 golden + invariants + README (R23)`

---

## Self-Review Notları (plan yazarı)

1. **Spec kapsam:** R17→T1; R18→T2; R22→T3; R19→T4; R20→T5; R21→T6; R23→T7; R24 ertelemeler plana girmez.
2. **Bilinen riskler:** T1 draft'ın `expected.gatesPass: true` sabitliği — PRCreated yalnız gates-pass sonrası açılır (A2) ✓; T2 ctor üçüncü param mevcut çağrıları bozmaz (opsiyonel); T3 compose helper 'yok.' substring'i gerçek içerikte varsa satırı atar (bilinçli — per-line hüküm); T5 runner inject deseni faz 3 T5 deseninden; T6 ChainedGateway BudgetedGateway ile sarmalanır (budget tek kapı aynen).
3. **Tip tutarlılığı:** `GoldenTask` T1'den; `composeReviewerLessons` T3'ten; `generateLlmMutations` T4'ten; `createGateways`/`ChainedGateway` T6'dan — her tüketici imzaları birebir kullanır.
