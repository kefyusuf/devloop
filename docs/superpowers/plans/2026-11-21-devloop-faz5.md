# devloop Faz 5 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Spec Revizyon 5 (R25–R29): decide→gerçek run bağlantısı (L3 veri yolu uçtan uca kapanır), SHIP kalıntıları batch (shared sentinels, createGatewayOrChain, tek tool-run seam, canonical JSON, parseDiff ws, cross-fallback/symmetry testleri, eval- sinyal filtresi, tsconfig.test.json), aktivasyon görünürlüğü (status alanları + README).

**Architecture:** Yaklaşım 1 kontrat ekleme devamı — her kalem mevcut modüllere küçük kontratlar olarak girer; yeni modül yalnız `src/util/canonicalJson.ts` + `src/shell/sentinels.ts` + `src/shell/composeLessons.ts` (faz 4'ten taşınan).

**Tech Stack:** değişiklik yok.

**Spec:** `docs/superpowers/specs/2026-11-18-ai-dev-loop-design.md` — Revizyon 5 (R25–R29). Executor spec + planı birlikte okur.

## Global Constraints

- **A1–A6 + R1–R6 + R9–R16 + R17–R24 aynen** — mevcut 267+1skip bozulmaz (davranış değişen assertion'lar `// hüküm:` notlu).
- **R25 fail-closed:** eşleşen TaskPicked yok ve `--run` yok → hata (sessiz 'manual' yazımı yok); `runId: 'manual'` yalnız `--run manual` ile.
- **R26 donmuş yargıç aynen:** tüm değişiklikler eval karşılaştırma mantığına dokunmaz.
- **R28 kabul:** mevcut testler + yeni batch testleri; tsconfig.test.json dahilinde tüm test dosyaları strict geçer; L3 veri-yolu E2E zinciri kanıtlı.
- 5d/5e: DEVLOOP_DOCKER=1 + cross-provider canlı koşum bu fazın kod kapsamında DEĞİL (flag'li testler mevcut; faz kapanış notu).

---

### Task 1: decide → gerçek run bağlantısı + E2E veri-yolu zinciri (R25)

**Files:**
- Modify: `src/shell/cli.ts` (decide auto-resolve)
- Test: `tests/cli/cli.test.ts` (ekleme + mevcut decide testi güncelleme hükümlü), `tests/e2e/decisionPath.test.ts` (yeni)

**Interfaces:**
- Produces: `resolveRunIdForTask(store, taskId): string | null` (son TaskPicked'in run_id'si; yoksa null) — `src/golden/draft.ts`'ten taşınmaz, cli.ts içinde lokal fonksiyon; decide davranışı: `--run` var → aynen kullan; yoksa auto-resolve; çözülemedi ve `--run` yok → throw 'Görev için koşum bulunamadı: <id> — önce run, sonra decide veya --run ile belirtin'; `--run manual` → 'manual' yazılır (explicit).

- [ ] **Step 1: Başarısız testler**
```ts
// tests/cli/cli.test.ts ekleme
it('decide: runId otomatik çözülür (son TaskPicked)', async () => {
  // seed: RunStarted r1 + TaskPicked(task t1) — decide --task t1 ( --run yok)
  // assert: HumanDecision run_id === 'r1'
});
it('decide: --run override', async () => { /* seed + --run r9 → run_id 'r9' */ });
it('decide: eşleşen TaskPicked yok + --run yok → fail-closed hata', async () => {
  // boş store + decide --task t1 → rejects 'koşum bulunamadı'
});
it('decide: --run manual → run_id manual (explicit)', async () => { /* assert run_id 'manual' */ });
```
`tests/e2e/decisionPath.test.ts` (yeni — L3 veri yolu zinciri):
```ts
// 1. seed gerçek koşum (TaskPicked/ArtifactProduced/PRCreated — orchestrator deseni, real store)
// 2. decide --task t1 --accept --reason real-issue-accepted (auto-resolve)
// 3. golden draft CLI → staging taslak (acceptedRuns accept ∩ PRCreated eşleşir — İLK KEZ gerçek zincir)
// 4. golden accept CLI → golden/ taşınır
// 5. eval CLI (gates-only) → EvalRun score 100
// 6. validateChain ok + HumanDecision run_id gerçek koşum runId'si
```
- [ ] **Step 2: FAIL** → **Step 3: Implementasyon** — cli.ts decide action: auto-resolve mantığı (yukarıda); mevcut decide testi run_id 'manual' bekliyorsa `// hüküm:` notlu güncellenir (auto-resolve artık r1 verir).
- [ ] **Step 4: PASS** (paket ~172) — **Step 5: Commit** `feat: decide gerçek run bağlantısı — L3 veri yolu kapanışı (R25)`

---

### Task 2: Shared sentinels (R26a)

**Files:**
- Create: `src/shell/sentinels.ts`
- Modify: `src/shell/composeLessons.ts`, `src/evolution/evolve.ts` (generatorContext), `src/generator/generator.ts` (exact-sentinel gating)
- Test: ilgili dosyalara ekleme (drift pin'leri)

**Interfaces:**
- Produces: `REVIEWER_DERSI_YOK = 'Reviewer dersi yok.'`, `GENERATOR_PLAYBOOK_YOK = 'Generator playbook önerisi yok.'` — composeLessons fallback, evolve generatorContext sentinel, generator exact-sentinel karşılaştırması aynı sabitleri kullanır.

- [ ] **Step 1: Başarısız test** — sentinels.test.ts: sabitlerin değerleri pin; generator exact-sentinel testi sabiti import ederek karşılaştırır (drift → test kırılır).
- [ ] **Step 2: FAIL** → **Step 3: Implementasyon** — sentinels.ts + üç tüketici refactor (davranış değişmez, literal → sabit). **Step 4: PASS** (paket ~173) — **Step 5: Commit** `refactor: shared sentinels (R26a)`

---

### Task 3: createGatewayOrChain (R26b)

**Files:**
- Modify: `src/gateway/factory.ts`, `src/shell/cli.ts` (5 site)
- Test: `tests/gateway/factory.test.ts` (ekleme)

**Interfaces:**
- Produces: `createGatewayOrChain(policy): LlmGateway` — `createGateways(policy)` çağırır: 0 ayak → GatewayError 'Kullanılabilir gateway ayak yok (anahtarlar env\u0027de eksik)'; 1 ayak → düz; çok → `ChainedGateway`. CLI 5 gateway construction sitesi tek helper'ı kullanır (BudgetedGateway sarmalaması aynen).

- [ ] **Step 1: Başarısız test** — 0-ayak → GatewayError; 1-ayak → düz instance; 2-ayak → ChainedGateway instance. **Step 2: FAIL** → **Step 3: Implementasyon** → **Step 4: PASS** (paket ~175) — **Step 5: Commit** `refactor: createGatewayOrChain — CLI ternary konsolidasyonu (R26b)`

---

### Task 4: Tek tool-run seam (R26c)

**Files:**
- Modify: `src/pipeline/stages/mutationStage.ts` (defaultRunner host dalı delegasyonu), `src/adapters/typescript/index.ts` (runToolDockerAware imza genişletme: originalRepoPath + pkg parametreli tek kapı)
- Test: `tests/pipeline/mutationStage.test.ts` (mevcut testler aynen; konsolidasyon sonrası green)

**Interfaces:**
- Produces: `runToolDockerAware(args: { repoPath; originalRepoPath?; policy; pkg; args; timeoutMs? }): Promise<ToolResult>` — tek kapı (host: resolveBin+runTool; docker: dockerizeSpawn). mutationStage defaultRunner host dalı bu kapıya delegeler (duplike konsolide — faz 3 T5 deferred minor kapanır).

- [ ] **Step 1: Konsolidasyon** — runToolDockerAware imzası genişletilir (pkg param + originalRepoPath); mutationStage defaultRunner: docker dalı aynen, host dalı `runToolDockerAware({...})` delegasyonuna dönüşür. **Step 2: mevcut testler aynen green** (davranış değişmez) — **Step 3: Commit** `refactor: tek tool-run seam — mutationStage host dalı konsolidasyonu (R26c)`

---

### Task 5: Canonical JSON (R26d)

**Files:**
- Create: `src/util/canonicalJson.ts`
- Modify: `src/evolution/evolve.ts` (LLM mutasyon evoId seed), `src/golden/draft.ts` (goldenId seed)
- Test: `tests/util/canonicalJson.test.ts` (yeni), evolve/draft test ekleme

**Interfaces:**
- Produces: `canonicalJson(value: unknown): string` — null/primitive → JSON.stringify; array → siralı elemanlar; object → sorted keys recursive. evoId/goldenId seed'leri canonicalJson üzerinden.

- [ ] **Step 1: Başarısız test** — `canonicalJson({b:2,a:1}) === canonicalJson({a:1,b:2})`; nested object key-order; array sıra KORUNUR. evolve/draft: aynı içerik farklı key-sıralı mock → aynı id.
- [ ] **Step 2: FAIL** → **Step 3: Implementasyon** → **Step 4: PASS** (paket ~178) — **Step 5: Commit** `feat: canonical JSON — evoId/goldenId key-order duyarlılığı kapanır (R26d)`

---

### Task 6: parseDiff ws + cross-fallback/symmetry testleri + eval- filtresi (R26e-g)

**Files:**
- Modify: `src/shell/reviewDiff.ts` (reDevNull ws), `src/evolution/evolve.ts` (eval- filtresi)
- Test: `tests/shell/reviewDiff.test.ts`, `tests/gateway/factory.test.ts` (ekleme)

**Interfaces:**
- Produces: reDevNull `/^\+\+\+ \/dev\/null[ \t]*$/`; evrim adayları `eval-` prefix'li run_id'leri hariç tutar (shadowRunIds kuralına ek — production eval koşumları sinyali kirletmez).

- [ ] **Step 1: Başarısız test** — (a) `+++ /dev/null ` trailing-ws tanınır; (b) eval- prefix'li koşumdaki test-diff bulgusu sinyale girmez (shadow kuralı genişletilir — tek test); (c) OpenAI HTTP-error→fallback (500 → fallback başarılı); (d) openai-primary symmetry (openai birincil + anthropic ikinci ayak mock).
- [ ] **Step 2: FAIL** → **Step 3: Implementasyon** → **Step 4: PASS** (paket ~183) — **Step 5: Commit** `feat: parseDiff ws + cross-fallback/symmetry testleri + eval- sinyal filtresi (R26e-g)`

---

### Task 7: tsconfig.test.json + status alanları (R26h + R27)

**Files:**
- Create: `tsconfig.test.json`
- Modify: `package.json` (typecheck:tests script), `src/shell/cli.ts` (status alanları), `README.md` (faz 5 bölümü)
- Test: `tests/cli/cli.test.ts` (status alanları ekleme)

**Interfaces:**
- Produces: `tsconfig.test.json` (extends tsconfig.json, include tests, noEmit, strict) + `npm run typecheck:tests` — tüm test dosyaları strict geçer (mevcut tip hataları düzeltilir: unused imports, as never kalıntıları); `devloop status` alanları: `goldenCount`, `goldenDrafts`, `l3Active`, `lastEvalScore`, mevcutlarla birlikte.

- [ ] **Step 1: Başarısız test** — status testi: goldenCount/l3Active/lastEvalScore alanları çıktıda. **Step 2: FAIL** → **Step 3: Implementasyon** — tsconfig.test.json + script; test tip hataları düzeltilir (her düzeltme `// hüküm:` notlu); status alanları. **Step 4: PASS** + `npx tsc -p tsconfig.test.json` temiz + full suite green — **Step 5: Commit** `feat: tsconfig.test.json + status aktivasyon alanları (R26h/R27)`

---

### Task 8: README faz 5 + invariants + kabul checklist (R28)

**Files:**
- Modify: `README.md` (faz 5 bölümü), `tests/e2e/invariants.test.ts` (ekleme)
- Test: invariants ekleme

**Interfaces:**
- Produces: R28 kabul kriterlerinin kanıtı — (a) decide fail-closed (T1'den); (b) E2E zinciri (T1 decisionPath — burada referans/pin); (c) canonical JSON key-order (T5'ten); (d) tsconfig strict (T6'dan); (e) sentinels drift pin'leri (T2'den) — mevcutsa referans, eksikse eklenir.

- [ ] **Step 1: invariants ekleri** — eksik olanlar eklenir (mevcut faz 3/4 invariants green kalmalı). **Step 2: README faz 5** — decide bağlantısı, SHIP batch özeti, aktivasyon görünürlüğü (`devloop status` alanları). **Step 3: Tüm paket** — `npx vitest run` (~215) + `npx tsc --noEmit` + `npx tsc -p tsconfig.test.json` temiz. **Step 4: Commit** `feat: faz5 invariants + README (R28)`

---

## Self-Review Notları (plan yazarı)

1. **Spec kapsam:** R25→T1; R26a→T2; R26b→T3; R26c→T4; R26d→T5; R26e-g→T6; R26h+R27→T7; R28→T8 (invariants + kabul checklist); R29 ertelemeler plana girmez.
2. **Bilinen riskler:** T1 auto-resolve son TaskPicked seçimi — multi-run store'da taskId tekil olduğundan güvenli (her koşum farklı task id kullanır; orchestrator task id'leri görev dosyasından); tsconfig.test.json dahil etme mevcut test tip hatalarını ortaya çıkarabilir — T7'de düzeltilir (hüküm notlu).
3. **Tip tutarlılığı:** `resolveRunIdForTask` T1 lokal; sentinels T2'den; `createGatewayOrChain` T3'ten; `runToolDockerAware` genişletilmiş imza T4'ten; `canonicalJson` T5'ten — tüketen dosyalar imzaları birebir kullanır.
