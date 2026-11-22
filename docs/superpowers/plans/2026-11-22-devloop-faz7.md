# Faz 7 Implementation Plan — Ölçüm Doğruluğu, Canlı Test Altyapısı, L3 Kapı Genişletmesi

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** comparedTo cross-repo ölçüm hatasını kapatmak + cross-provider canlı gate'li test eklemek (R32 gap) + multi-eval verisiyle L3 kapısını genişletmek (R35–R39).

**Architecture:** comparedTo `payload.repo` ile scope'lanır; canlı test `CROSS_PROVIDER_LIVE=1` + iki gerçek anahtarla koşar (yoksa skip); L3 kapısı `multiEvalId` batch marker'ı + store recompute ile genişler (`resolveL3` helper'ı status + evolve paylaşımlı; status'a additive `l3Source` alanı).

**Tech Stack:** TypeScript 5 (ESM, NodeNext), Node ≥20, vitest, zod, commander.

**Spec:** `docs/superpowers/specs/2026-11-18-ai-dev-loop-design.md` — Revizyon 7 (R35–R39). Hükümler: Yaklaşım 1 batch marker + store recompute (yeni event tipi/dosya kanıtı red); yalnız mode:production sayılır; evrim kendi sette çalışır; cross-repo genelleme R39'a.

## Global Constraints

- **TDD:** her davranış değişikliği önce başarısız testle kanıtlanır; FAIL/PASS kanıtları raporlanır.
- **Fail-closed:** kullanıcı girişi doğrulamada sessiz fallback yok (`--repos` boş segment → hata).
- **Anahtarlar yalnız env; testler offline-safe** — canlı test yalnız `CROSS_PROVIDER_LIVE=1` + iki gerçek anahtar varken koşar, aksi halde skip.
- **Geriye-uyumluluk:** `--repos`'suz eval/evolve/status davranışları değişmez (yalnız `l3Active` değeri genişleyebilir, `l3Source` additive); `multiEvalId`'siz store'lar yalnız 'own' kaynağıyla değerlenir.
- **Hüküm yorumları:** plandan her sapma `// hüküm: ...` notuyla belgelenir.
- **Commit disiplini:** task başına tek commit; mesaj formatı `feat|fix|docs: ... (R3x)`.
- **Baseline:** mevcut 307 passed / 34 dosya bozulmaz; skip sayısı R36'nın flag'li canlı testiyle +1'e çıkabilir (final: passed≥307, skipped=2) — hüküm notlu güncellemeler hariç mevcut testler aynen kalır; `npx tsc --noEmit` + `npx tsc -p tsconfig.test.json` temiz kalır.

---

### Task 1: Hijyen batch — comparedTo scope + fail-closed segment + kozmetik (R35)

**Files:**
- Modify: `src/eval/evalRunner.ts` (comparedTo filtresi), `src/shell/cli.ts` (boş segment fail-closed + weightedScore dead-guard), `README.md` (R32 ifade düzeltmesi)
- Test: `tests/eval/evalRunner.test.ts` (comparedTo ×2), `tests/cli/cli.test.ts` (boş segment ×1; dead-guard davranış aynen)

**Interfaces:**
- Consumes: `runEval({ repoPath, pipeline, policy, store, l3MinGoldenTasks, candidate?, repo?, multiEvalId? })` — T3 `multiEvalId` ekleyene kadar imza repo ile aynı.
- Produces: comparedTo yalnız aynı-repo production koşumuyla eşleşir; `--repos` boş segment → `throw new Error('boş repo yolu: ...')`.

- [ ] **Step 1: Başarısız testler**

(a) comparedTo same-repo eşleşme + cross-repo izolasyon — `tests/eval/evalRunner.test.ts`:
```typescript
it('R35: comparedTo yalnız AYNI reponun en son production koşumuna referans verir', async () => {
  // store'a repo 'A' production EvalRun + repo 'B' production EvalRun ekle (A SONRA B)
  // runEval({ repo: 'A', candidate }) → summary.comparedTo === A'nın evalId'si (B'nin DEĞİL)
});
it('R35: repo tanımsız koşumlar yalnız repo tanımsız production koşumlarla eşleşir', async () => {
  // store'a repo tanımsız + repo 'X' production koşumları; runEval({ candidate, repo yok })
  // → comparedTo tanımsız koşumun evalId'si; X'in değil
});
```
(b) boş segment fail-closed — `tests/cli/cli.test.ts`:
```typescript
it('R35: --repos boş segment → fail-closed hata (sessiz düşürme yok)', async () => {
  // eval --repos "repoA,,repoB" → exit !== 0, stderr 'boş repo yolu'
});
```

- [ ] **Step 2: FAIL kanıtı** — (a1) comparedTo B'nin evalId'si; (a2) X'in evalId'si; (b) koşum başlar / hata yok.

- [ ] **Step 3: Implementasyon**
(a) `evalRunner.ts:78-79`: prevRuns filtresine `.filter((e) => (e.payload.repo ?? undefined) === (args.repo ?? undefined))` eklenir (payload.repo optional — tanımsız↔tanımsız eşleşme; hüküm yorumu R35).
(b) `cli.ts` multi-repo branch: split/trim/filtre yerine — split → trim → boş segment VARSA `throw new Error(\`boş repo yolu: \${paths.join(',')}\`)`; sonra resolve. Hüküm yorumu (fail-closed ilkesi; trailing-virgül artık hata).
(c) weightedScore dead-guard: `totalTasks === 0 ? 0 : ...` dalı kaldırılır, `// hüküm: R35 preflight totalTasks>0 garantisi — invariant upstream` yorumu.
(d) `README.md` R32 satırı: "gerçek Stryker/tsc-in-container" → "gerçek tsc-in-container".

- [ ] **Step 4: PASS** — `npx vitest run` (307+1skip + 3 yeni ≈ 310+1skip); iki tsc temiz.

- [ ] **Step 5: Commit** `fix: comparedTo repo-scope + --repos boş segment fail-closed + kozmetik temizlik (R35)`

---

### Task 2: Cross-provider canlı gate'li test (R36)

**Files:**
- Modify: `tests/gateway/factory.test.ts` (canlı test ekleme — src değişikliği YOK)

**Interfaces:**
- Consumes: `ChainedGateway` / `createGateways` gerçek sınıflar, `Policy` openai-primary + crossProviderFallback:true.
- Produces: `CROSS_PROVIDER_LIVE=1` + `OPENAI_API_KEY` + `ANTHROPIC_API_KEY` üçü de mevcutken koşan gerçek canlı test; aksi halde skip (skipIf). Offline güvenlik korunur.

- [ ] **Step 1: Test (skip davranışı dahil)**

```typescript
describe.skipIf(!process.env.CROSS_PROVIDER_LIVE || !process.env.OPENAI_API_KEY || !process.env.ANTHROPIC_API_KEY)
  ('R36: canlı cross-provider fallback (CROSS_PROVIDER_LIVE=1 + gerçek anahtarlar)', () => {
  it('openai bacağı geçersiz model → 4xx → anthropic bacağı gerçek completion döndürür', async () => {
    // gerçekteki createGateways(policy) — policy: openai primary (model: 'devloop-live-test-geçersiz-model'),
    // anthropic ikinci ayak, crossProviderFallback: true
    // gateway.complete(...) → cevap boş değil; usage alanları dolu (gerçek API yanıtı)
    // NOT: geçersiz model openai'da 4xx üretir → zincir anthropic'e düşer (ücretsiz başarısız istek + 1 küçük completion)
  });
});
it('R36: canlı test flag/anahtar yokken offline skip', ...) // skip davranışını pin'leyen hafif test
```

- [ ] **Step 2: FAIL kanıtı** — skipIf koşulu flag/anahtar yokken bu ortamda skip eder (bu ortamda OPENAI yok → test skip: kanıt "skipped" satırı; koşum sayısı değişmez çünkü skipIf zaten skipped sayar — beklenen: suite 1 skipped artar).

- [ ] **Step 3: PASS** — `npx vitest run` (≈ 310+1skip + 1 skipped → 310+2skip; ortamda canlı bacağı skip); iki tsc temiz.

- [ ] **Step 4: Commit** `test: cross-provider canlı gate'li test — CROSS_PROVIDER_LIVE (R36)`

---

### Task 3: L3 kapı genişletmesi — multiEvalId + resolveL3 (R37)

**Files:**
- Modify: `src/contracts/events.ts` (EvalRunSchema `multiEvalId?: string`), `src/eval/evalRunner.ts` (args `multiEvalId?` → payload kökü), `src/shell/cli.ts` (multi-repo branch multiEvalId üretimi + geçiş; `resolveL3` lokal helper; evolve I4 kapısı + eşik-altı mesajı; status `l3Active` + `l3Source`)
- Test: `tests/eval/evalRunner.test.ts` (payload ×2), `tests/cli/cli.test.ts` (resolveL3 gruplama + status + evolve mesajı)

**Interfaces:**
- Consumes: faz 6 T2 multi-repo branch (`runEval({..., repo})`); `lastEvalRun` helper kalıbı.
- Produces: `multiEvalId?: string` (EvalRun payload kökü; aynı `--repos` koşumunun tüm EvalRun'larında AYNI); `resolveL3(store, ownGoldenCount, policy): { active: boolean; source: 'own' | 'multi-eval' | 'none' }` (cli.ts lokal); status çıktısına `l3Source=<own|multi-eval|none>` (daima yazılır); evolve eşik-altı mesajı: `L3 eşik altı (l3MinGoldenTasks=N, golden=X, multiEvalTotal=Y)`.

- [ ] **Step 1: Başarısız testler**

(a) payload — `tests/eval/evalRunner.test.ts`:
```typescript
it('R37: runEval multiEvalId payload köküne yazılır; verilmezse tanımsız', async () => {
  // runEval({..., multiEvalId: 'multi-1' }) → EvalRun payload.multiEvalId === 'multi-1'
  // multiEvalId'siz koşum → payload.multiEvalId undefined (geriye-uyumlu)
});
```
(b) resolveL3 gruplama — `tests/cli/cli.test.ts`:
```typescript
it('R37: resolveL3 — en son multiEvalId batch\'i, yalnız production üyeler toplam ≥ eşik → multi-eval', async () => {
  // store: batch-1 (repo X prod, golden=2; repo Y prod, golden=3) SONRA batch-2 (repo Z prod, golden=1)
  // ownGoldenCount=0, eşik=4 → resolveL3 = { active:true, source:'multi-eval' } (batch-2 toplam 1 < 4 DEĞİL ama
  //   batch-1 toplam 5 ≥ 4 — EN SON batch-2 olduğu için source hesabı batch-2 üzerinden: toplam 1 < 4 → inactive!)
  // → doğru senaryo: batch-2 prod golden=5 → active:true source:'multi-eval'; candidate üye toplama KATILMAZ
});
it('R37: multiEvalId\'siz store yalnız own kaynağıyla değerlenir (geriye-uyumlu)', async () => {
  // store'da multiEvalId'siz EvalRun'lar; own < eşik → { active:false, source:'none' }
});
```
(c) status + evolve — `tests/cli/cli.test.ts`:
```typescript
it('R37: status l3Active genişler + l3Source yazılır', async () => {
  // own goldenCount eşik altı + multi-eval batch toplam eşik üstü → outputta l3Active=true l3Source=multi-eval
  // kapalı durum → l3Active=false l3Source=none
});
it('R37: evolve eşik-altı mesajı iki sayıyı verir (multiEvalTotal)', async () => {
  // evolve --shadow (eşik altı, production eval mevcut) → JSON message 'multiEvalTotal=' içerir
});
```

- [ ] **Step 2: FAIL kanıtı** — (a) multiEvalId alanı yok; (b) resolveL3 yok; (c) l3Source yok / mesaj tek sayı.

- [ ] **Step 3: Implementasyon**
`events.ts`: `multiEvalId: z.string().optional()` (payload kökü, `repo` yanına; hüküm yorumu R37).
`evalRunner.ts`: args `multiEvalId?: string`; payload `...(args.multiEvalId ? { multiEvalId: args.multiEvalId } : {})`.
`cli.ts`:
- multi-repo branch: `const multiEvalId = \`multi-\${Date.now()}-\${randomUUID().slice(0,8)}\`` → her `runEval({..., multiEvalId})`.
- `resolveL3` lokal helper: store.query EvalRun → multiEvalId'li olanlar → son multiEvalId değerini bul (son event'inki) → o batch'in mode:production üyelerinin goldenCount toplamı → own ≥ eşik → {true,'own'}; multi toplam ≥ eşik → {true,'multi-eval'}; değil → {false,'none'}.
- evolve I4: `const l3 = resolveL3(...); if (!l3.active) { eşik-altı JSON + multiEvalTotal }` — kapı açıksa mevcut akış aynen.
- status: `const l3 = resolveL3(...)`; çıktıya `l3Source=\${l3.source}` eklenir (`l3Active=\${l3.active}`).

- [ ] **Step 4: PASS** — `npx vitest run` (≈ 310+2skip + 6 ≈ 316+2skip); iki tsc temiz. NOT: faz 5 T7 status testleri (l3Active=false pin'li) kalabilir — resolveL3 'none' döndüğünde davranış aynı.

- [ ] **Step 5: Commit** `feat: L3 kapı genişletmesi — multiEvalId batch + resolveL3 + status l3Source (R37)`

---

### Task 4: Kabul + README (R38)

**Files:**
- Modify: `tests/e2e/invariants.test.ts` (README-hizası invariant'ı Faz 7 pin'leriyle genişletme), `README.md` (faz 7 bölümü + kabul checklist)

**Interfaces:**
- Produces: README `## Faz 7` bölümü (L3 kapı genişletmesi + l3Source + comparedTo düzeltmesi + canlı test kullanımı `CROSS_PROVIDER_LIVE=1`) + `### Kabul checklist (R38)` (R28 formatında).

- [ ] **Step 1: Değişmez denetimi** — mevcut Faz 6 README-hizası invariant'ına Faz 7 pin'leri eklenir (`## Faz 7`, `multiEvalId`, `resolveL3`, `l3Source`, `CROSS_PROVIDER_LIVE`, `Kabul checklist (R38)`); diğer alanlar mevcut testlere referans (duplike yok).
- [ ] **Step 2: README faz 7 bölümü** — L3 kapı genişletmesi kullanımı (multi-eval → evolve aktifleşebilir; evrim kendi sette), l3Source alanı anlamı, comparedTo düzeltmesi (aynı-repo karşılaştırma), canlı test koşumu örneği (`CROSS_PROVIDER_LIVE=1 npm test`), R35 kozmetik notları. Faz 6 bölümünün formatını izler.
- [ ] **Step 3: Tüm doğrulama** — `npx vitest run` (final sayı), `npx tsc --noEmit`, `npx tsc -p tsconfig.test.json`, `npm run build` — dördü temiz.
- [ ] **Step 4: Commit** `feat: faz7 invariants + README + kabul checklist (R38)`

---

## Self-Review Notları (plan yazarı)

1. **Spec kapsam:** R35→T1; R36→T2; R37→T3; R38→T4; R39 ertelemeler plana girmez. EvalSummary.l3Active değişmiyor (per-run) — yalnız status/evolve kapısı genişliyor.
2. **Tip tutarlılığı:** `multiEvalId` events.ts + evalRunner + cli üçüyle tutarlı; `resolveL3` imzası spec R37 ile birebir; comparedTo filtresi `payload.repo ?? undefined` karşılaştırması (optional alan).
3. **Bilinen riskler:** T2'nin suite'e +1 skipped getirmesi "bozulmaz" kabulünü kaydırır (307+1skip → N+2skip kabulü) — R38 kabul metni bunu kapsar; resolveL3'ün "en son batch" seçimi event sırasına dayanır (store append-only — sıra güvenli); faz 5 T7'nin l3Active=false pin'li status testleri 'none' yoluyla geçer kalır.
4. **T2 ortam notu:** bu ortamda OPENAI_API_KEY yok → canlı bacağı skip (kanıt: skipped sayısı +1); gerçek anahtarlı ortamda koşum kontrolü faz kapanış raporunda.
