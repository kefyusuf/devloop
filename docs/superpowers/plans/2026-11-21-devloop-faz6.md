# Faz 6 Implementation Plan — Multi-repo Eval, Hijyen Batch, Canlı Doğrulama

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `devloop eval --repos` ile birden fazla repo'nun golden setini tek koşumda agregasyonla koşmak (R30) + faz 5 review kalıntısı hijyen batch (R31) + canlı doğrulama ortam denetimi (R32) + kabul (R33).

**Architecture:** Multi-repo eval CLI döngüsüyle per-repo stage/adapter kurulumu yapar, kanıtı orchestrator store'una yazar (hedef repo'lar salt-okunur), EvalRun payload'una additive optional `repo` alanı ekler. Hijyen batch 4 bağımsız küçük düzeltmeyi tek task'ta toplar. Donmuş yargıcı tutarlılığı (I2 hükmü) korunur.

**Tech Stack:** TypeScript 5 (ESM, NodeNext), Node ≥20, vitest, zod, commander.

**Spec:** `docs/superpowers/specs/2026-11-18-ai-dev-loop-design.md` — Revizyon 6 (R30–R34). Hükümler: Yaklaşım 1 golden set agregasyonu; L3 kapısı bu fazda değişmez; YAGNI/contre kalemleri R29'da kalır.

## Global Constraints

- **TDD:** her davranış değişikliği önce başarısız testle kanıtlanır; FAIL/PASS kanıtları raporlanır.
- **Fail-closed:** eksik/bozuk girişte sessiz fallback yok; hata fırlatılır.
- **Salt-okunur hedef repo'lar:** multi-repo koşum hedef repo'nun `.devloop/` altına HİÇ yazım yapmaz.
- **Anahtarlar yalnız env** (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`); koda credential yazılmaz; testler offline-safe (fetch stub), canlı testler flag'li.
- **Hüküm yorumları:** plandan her sapma ve her bilinçli davranış değişikliği `// hüküm: ...` notuyla belgelenir.
- **Commit disiplini:** task başına tek commit; mesaj formatı `feat|fix|refactor|docs: ... (R3x)`.
- **Baseline:** mevcut 296 passed + 1 skipped / 34 dosya bozulmaz (hüküm notlu güncellemeler hariç); `npx tsc --noEmit` + `npx tsc -p tsconfig.test.json` temiz kalır.
- **Geriye-uyumluluk:** `--repos` verilmediğinde eval davranışı birebir aynı kalır.

---

### Task 1: Hijyen batch (R31)

**Files:**
- Modify: `src/shell/reviewDiff.ts` (reDel regex + policyHash), `src/evolution/evolve.ts` (prompt-ctx filtresi), `src/eval/evalRunner.ts` (policyHash), `src/orchestrator/orchestrator.ts` (policyHash), `src/golden/draft.ts` (yeni helper), `src/shell/cli.ts` (2 goldenDrafts sitesi)
- Test: `tests/shell/reviewDiff.test.ts`, `tests/evolution/evolve.test.ts`, `tests/orchestrator/orchestrator.test.ts` / `tests/eval/evalRunner.test.ts` (pin güncellemeleri — hüküm notlu), `tests/golden/draft.test.ts` (helper), `tests/cli/cli.test.ts` (davranış aynen)

**Interfaces:**
- Consumes: `signalExcluded(runId)` (evolve.ts:44-51, faz 5 T6), `canonicalJson` (src/util/canonicalJson.ts, faz 5 T5), `loadGoldenTasks`.
- Produces: `readGoldenDraftFiles(repoPath): string[]` (src/golden/draft.ts) — `.devloop/golden-drafts/` altındaki `*.task.json` adlarını döndürür (dizin yoksa `[]`); cli.ts status sayacı ve `golden list` bu helper'ı kullanır. policyHash seed'i üç sitede `canonicalJson(policy)` olur — **hash DEĞERLERİ değişir (bilinen davranış değişikliği)**, key-order determinizmi kazanılır.

- [ ] **Step 1: Başarısız testler (4 madde)**

(a) reDel ws — `tests/shell/reviewDiff.test.ts`:
```typescript
it('R31: trailing-ws `--- /dev/null ` silme header adayıdır (reDevNull ile simetrik)', () => {
  const r = parseDiff('--- /dev/null \n+++ b/new.ts\n+const a=1;\n');
  expect(r).toEqual([{ path: 'new.ts', addedContent: 'const a=1;' }]);
});
```
(b) prompt-ctx eval- dışlaması — `tests/evolution/evolve.test.ts` (faz 5 T6 eval- testinin kardeşi; mock gateway `complete`'e gelen `prompt`'u yakalar):
```typescript
it('R31: eval- prefix\'li koşum bulgusu LLM mutasyon prompt bağlamına girmez', async () => {
  // store: eval-... runId'li FindingEmitted (category 'eval-only') + ci-... runId'li (category 'ci-only')
  // mock gateway prompt'u yakalar; generateLlmMutations çağrılır
  // assert: prompt içinde 'eval-only' YOK, 'ci-only' VAR
});
```
(c) policyHash key-order determinizmi — `tests/eval/evalRunner.test.ts`:
```typescript
it('R31: policyHash key-order duyarlı DEĞİL (canonicalJson seed)', () => {
  // aynı alanları farklı sırayla kurulan iki policy nesnesi → aynı hash
  // iki runEval koşumunun configSnapshot.policyHash'ı eşit
});
```
(d) goldenDrafts helper — `tests/golden/draft.test.ts`:
```typescript
it('R31: readGoldenDraftFiles — *.task.json adları, dizin yoksa []', () => {
  expect(readGoldenDraftFiles(tmpRepo)).toEqual(['a.task.json', 'b.task.json']);
  expect(readGoldenDraftFiles(nonexistent)).toEqual([]);
});
```

- [ ] **Step 2: FAIL kanıtı** — her madde için tek satır (a: parseDiff boş döner/x.ts yok; b: prompt'ta eval-only VAR; c: hash'ler farklı; d: helper modül-yok).

- [ ] **Step 3: Implementasyon**
(a) `reviewDiff.ts`: `const reDel = /^--- (?:a\/(.+?)[ \t]*|\/dev\/null[ \t]*)$/;` + hüküm yorumu (reDevNull ile simetri).
(b) `evolve.ts` generateLlmMutations: shadowRunIds filtresine `signalExcluded` eklenir — `.filter((e) => !signalExcluded(e.run_id))` (findings + decisions; aynı dosyadaki predicate yeniden kullanılır, duplike yok) + hüküm yorumu (R26g kapsam-dışı kalan prompt yüzeyi).
(c) Üç policyHash site: `JSON.stringify(args.policy)` → `canonicalJson(args.policy)` (import eklenir). Testlerde literal hash pin'i varsa hüküm-notlu güncelle (`// hüküm: R31 policyHash canonicalJson seed — değer değişimi bilinçli`). orchestrator resume-mismatch karşılaştırması iki taraf da aynı algoritmayla hesapladığından tutarlı kalır.
(d) `src/golden/draft.ts`:
```typescript
export function readGoldenDraftFiles(repoPath: string): string[] {
  const dir = join(repoPath, '.devloop', 'golden-drafts');
  try { return readdirSync(dir).filter((n) => n.endsWith('.task.json')); }
  catch { return []; }
}
```
`cli.ts:158` → `readGoldenDraftFiles(repoDir()).length`; `cli.ts:451` → `readGoldenDraftFiles(repoDir())` (davranış aynen).

- [ ] **Step 4: PASS** — `npx vitest run` (296+1skip + ~6 yeni ≈ 302+1skip); `npx tsc --noEmit`; `npx tsc -p tsconfig.test.json` — üçü temiz.

- [ ] **Step 5: Commit** `feat: hijyen batch — reDel ws + prompt-ctx eval- dışlaması + policyHash canonicalJson + goldenDrafts helper (R31)`

---

### Task 2: Multi-repo eval çekirdeği (R30)

**Files:**
- Modify: `src/contracts/events.ts` (EvalRun payload `repo?: string`), `src/eval/evalRunner.ts` (runEval args `repo?: string`), `src/shell/cli.ts` (eval action: `--repos` döngüsü)
- Test: `tests/eval/evalRunner.test.ts` (payload alanı), `tests/cli/cli.test.ts` (e2e multi-repo + fail-closed + geriye-uyumluluk)

**Interfaces:**
- Consumes: `runEval({ repoPath, pipeline, policy, store, l3MinGoldenTasks, candidate?, repo? })` — repo parametresi opsiyonel; per-repo `TypeScriptAdapter(policy, repo)` + `MutationStage(policy, undefined, repo)`; `createGatewayOrChain` (faz 5 T3); `loadGoldenTasks`.
- Produces: `--repos <p1,p2,...>` seçeneği — aggregate JSON çıktısı: `{ perRepo: Array<EvalSummary & { repo: string }>, aggregate: { totalTasks, totalPassed, totalFailed, weightedScore, mergedInvalid: string[] } }`. EvalRun payload'una `repo?: string` eklenir (tek-repo koşumda tanımsız).

- [ ] **Step 1: Başarısız testler**

(a) payload alanı — `tests/eval/evalRunner.test.ts`:
```typescript
it('R30: runEval repo parametresi EvalRun payload\'ına yazılır', async () => {
  // runEval({ ..., repo: 'fixture-a' }) → store'daki EvalRun payload.repo === 'fixture-a'
  // repo verilmeyen koşumda payload.repo undefined (geriye-uyumlu)
});
```
(b) e2e aggregate — `tests/cli/cli.test.ts` (mevcut e2e fixture kalıplarını izler; tmpdir'de iki fixture repo):
```typescript
it('R30: eval --repos iki repo golden setini agregasyonla koşar; hedef store\'lar salt-okunur', async () => {
  // fixture repo A: 2 golden task (basit diff, gatesPass true), repo B: 1 task
  // orchestrator (cwd) repo'sunda koş: eval --repos <A>,<B> (heuristic — --full'suz)
  // assert exit 0; JSON: perRepo.length===2, perRepo[0].repo===A, aggregate.totalTasks===3,
  //   aggregate.totalPassed===3, weightedScore===100
  // assert orchestrator store'unda 2 EvalRun, payload.repo alanları A/B
  // assert existsSync(join(A, '.devloop', 'events.jsonl')) === false VE B için de false (salt-okunur)
});
```
(c) fail-closed — `tests/cli/cli.test.ts`:
```typescript
it('R30: --repos var olmayan yol → hata; golden\'ı hiçbir repoda yok → hata', async () => {
  // nonexistent path → exit !== 0, stderr 'yol yok' benzeri
  // iki boş golden repo → exit !== 0 (boş koşum yok)
});
```

- [ ] **Step 2: FAIL kanıtı** — (a) repo alanı yok; (b) `--repos` bilinmeyen seçenek / aggregate yok; (c) hata yok.

- [ ] **Step 3: Implementasyon**
`events.ts` EvalRunSchema: `repo: z.string().optional()` (additive; hüküm yorumu R30).
`evalRunner.ts`: `args`'a `repo?: string`; payload'a `...(args.repo ? { repo: args.repo } : {})` (configSnapshot'a DEĞİL, payload köküne — aggregate perRepo alanı payload.repo'dan okunur).
`cli.ts` eval action:
```typescript
.option('--repos <paths>', 'multi-repo eval (R30): virgülle ayrık hedef repo yolları — golden set agregasyonu')
```
Akış: `--repos` varsa → yolları ayrıştır (split(',') + trim + boş filtre); her yol `existsSync` fail-closed; her repodan `loadGoldenTasks(repo)` sayımı; toplam task 0 → `throw new Error('hiçbir hedef repoda golden task yok')`; gateway (--full'da) TEK kurulum; her repo için per-repo adapter/stages kur (repo parametresiyle) — reviewerLessons orchestrator kompozisyonundan (I2 donmuş yargıcı; hedef repo dersleri karışmaz); `runEval({ repoPath: repo, ..., repo, store: store() /* orchestrator */ })`; sonuçlar toplanır → aggregate hesapla (weightedScore = Σ(scoreᵢ·nᵢ)/Σnᵢ, n=goldenCount; 0 task'lı repo katılmaz, perRepo'da raporlanır) → JSON yazdır. `--repos` yoksa bugünkü akış AYNEN (döngü tek-repo kısayoluyla değil, mevcut kod yolu korunur).

- [ ] **Step 4: PASS** — `npx vitest run` (≈ 302+1skip + ~5 ≈ 307+1skip); iki tsc temiz.

- [ ] **Step 5: Commit** `feat: multi-repo eval — golden set agregasyonu (R30)`

---

### Task 3: Canlı doğrulama ortam denetimi (R32)

**Files:** Yeni kod yok. SDD içinde koşulan denetim; çıktı ledger raporu.

- [ ] **Step 1: Ortam denetimi** — `echo $OPENAI_API_KEY | head -c 8` (var/yok), `docker info --format '{{.ServerVersion}}'` (daemon var/yok).
- [ ] **Step 2: Koşabildiği kadar koşum** — OPENAI_API_KEY varsa: `CROSS_PROVIDER_LIVE=1 npx vitest run tests/gateway/` (flag'li canlı cross-provider testi; faz 3/4'ten mevcut). Docker varsa: `DEVLOOP_DOCKER=1 npx vitest run tests/pipeline/mutationStage.test.ts` (gerçek Stryker-in-container).
- [ ] **Step 3: Rapor** — ledger'a yaz: her denetim için ortam durumu + koşulan test + sonuç. Yoksa: "ortam hazır değil — bilinçli atlanan doğrulama, raporlandı" (fail-open değil; R32 sözleşmesi).

---

### Task 4: Kabul + README (R33)

**Files:**
- Modify: `tests/e2e/invariants.test.ts` (multi-repo değişmezleri — T2 testleri kapsıyorsa referans, eksikse ekle), `README.md` (faz 6 bölümü + kabul checklist)

**Interfaces:**
- Produces: README `## Faz 6` bölümü (multi-repo eval kullanımı + hijyen özeti + kabul checklist tablosu — R28 formatında 4-6 satır, her kriter ✅ + kanıt işaretçisi).

- [ ] **Step 1: Değişmez denetimi** — T2 e2e testleri (a) aggregate aritmetiği (b) hedef-store dokunulmazlığı (c) fail-closed (d) geriye-uyumluluk kapsıyor mu? Eksik değişmez varsa invariants.test.ts'e ekle (anlamlı, regrese-edilebilir assertion); kapsıyorsa README checklist'te referans ver (duplike etme).
- [ ] **Step 2: README faz 6 bölümü** — `## Faz 6`: multi-repo eval kullanım örneği (`devloop eval --repos ../repoA,../repoB`), aggregate JSON şekli, salt-okunur hedef ilkesi, hijyen batch özeti (reDel ws simetrisi, prompt-ctx eval- dışlaması, policyHash key-order determinizmi — değer değişimi ifşalı, goldenDrafts helper), L3 kapısı notu (değişmedi). Faz 5 bölümünün formatını izler.
- [ ] **Step 3: Tüm doğrulama** — `npx vitest run` (final sayı), `npx tsc --noEmit`, `npx tsc -p tsconfig.test.json`, `npm run build` — dördü temiz.
- [ ] **Step 4: Commit** `feat: faz6 invariants + README + kabul checklist (R33)`

---

## Self-Review Notları (plan yazarı)

1. **Spec kapsam:** R31→T1 (4 madde birebir); R30→T2; R32→T3; R33→T4; R34 ertelemeler plana girmez. L3 kapı değişikliği bilinçli yok (hüküm).
2. **Tip tutarlılığı:** `readGoldenDraftFiles(repoPath): string[]` T1'den; EvalRun payload `repo?: string` T2'de events.ts + evalRunner + cli üçüyle tutarlı; `signalExcluded` evolve.ts içi (T1b aynı dosyada).
3. **Bilinen riskler:** policyHash değer değişimi orchestrator resume-mismatch testini etkileyebilir (iki taraf da aynı algoritma → tutarlı; literal pin'ler hüküm-notlu güncellenir); multi-repo per-repo stage kurulumunda MutationStage'in repo parametresi hedef repo'yu göstermeli (orchestrator değil); e2e fixture repo'lar mevcut cli.test fixture kalıbını izler.
4. **Task 3 commit'sizdir** (ortam denetimi — ledger raporu); diğer task'lar tek commit.
