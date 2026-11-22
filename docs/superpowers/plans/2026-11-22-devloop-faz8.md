# Faz 8 Implementation Plan — Kapanış: Hijyen Batch ve Sistem Durumu Dokümantasyonu

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Taşınan hijyen minor'larını kapatmak (resolveL3 multiEvalTotal + evolve tek-scan, NaN savunmacı restore, `--repos` duplicate fail-closed, konvansiyon notları — R40) + README "Sistem durumu" bölümü + kabul (R41/R42).

**Architecture:** resolveL3'ün dönüşüne optional `multiEvalTotal` eklenir (own-path scan'siz erken dönüş korunur; kapalı yolda evolve mesajı `l3.multiEvalTotal`'ı kullanır — tek store scan). NaN guard savunmacı restore (ulaşılamaz yol — test yazılmaz). Duplicate repo yolu resolve-sonrası canonical Set ile fail-closed.

**Tech Stack:** TypeScript 5 (ESM, NodeNext), Node ≥20, vitest, zod, commander.

**Spec:** `docs/superpowers/specs/2026-11-18-ai-dev-loop-design.md` — Revizyon 8 (R40–R43). Hükümler: duplicate **fail-closed** (sessiz dedupe değil); NaN restore **savunmacı+ulaşılamaz — yeni test yazılmaz**; büyük kalemler R43'te kullanım-verisi şartıyla erteli.

## Global Constraints

- **TDD:** testi yazılabilir her davranış değişikliği önce başarısız testle kanıtlanır; ulaşılamaz savunmacı kod (R40.2) için test yazılmaz — hüküm yorumu kanıt yerine geçer.
- **Fail-closed:** duplicate/boş segment girişlerinde sessiz fallback yok.
- **Geriye-uyumluluk:** resolveL3 own-path erken dönüşü korunur (multiEvalTotal alanı own-path'te tanımsız); faz 7 T3 pin'leri toEqual ise hüküm-notlu güncellenir.
- **Hüküm yorumları:** her sapma ve savunmacı restore `// hüküm: ...` notuyla belgelenir.
- **Commit disiplini:** task başına tek commit; mesaj `feat|docs: ... (R4x)`.
- **Baseline:** mevcut 318 passed + 2 skipped / 34 dosya bozulmaz (hüküm notlu güncellemeler hariç); iki tsc + build temiz kalır.

---

### Task 1: Hijyen kod — resolveL3 multiEvalTotal + NaN restore + duplicate fail-closed (R40.1-3)

**Files:**
- Modify: `src/shell/cli.ts` (resolveL3 dönüşü + evolve mesajı + weightedScore guard + duplicate kontrol + helper-split yorum prefix'i)
- Test: `tests/cli/cli.test.ts` (duplicate fail-closed ×1; resolveL3 pin güncellemeleri hüküm-notlu; NaN — test YOK, savunmacı/ulaşılamaz)

**Interfaces:**
- Consumes: `resolveL3(s, ownGoldenCount, policy)` (faz 7 T3, cli.ts:82), `latestMultiEvalTotal` (modül-private, cli.ts:65), faz 6 T2 `--repos` parsing zinciri (cli.ts:350).
- Produces: `resolveL3` dönüşü `{ active: boolean; source: 'own' | 'multi-eval' | 'none'; multiEvalTotal?: number }` — alan multi-eval/none path'lerinde DOLU, own-path'te TANIMIYZ (scan yok); evolve eşik-altı mesajı `l3.multiEvalTotal`'ı kullanır (ayrı latestMultiEvalTotal çağrısı KALDIRILIR — kapalı yolda tek scan); `--repos` duplicate → `throw new Error('duplicate repo yolu: X')`.

- [ ] **Step 1: Başarısız testler**

(a) duplicate fail-closed — `tests/cli/cli.test.ts` (R30/R35 fail-closed test kalıbını izler):
```typescript
it('R40: --repos duplicate yol → fail-closed hata (çift maliyet/kanıt yok)', async () => {
  // buildCli(orch).parseAsync(['node','devloop','eval','--repos', `${a},${a}`])
  // → exit !== 0, stderr 'duplicate repo yolu'
  // → orchestrator events.jsonl YAZILMAMIŞ (hata yolunda kanıt yok)
});
```
(b) resolveL3 multiEvalTotal dönüş alanları — `tests/cli/cli.test.ts` (faz 7 T3 resolveL3 testlerine paralel):
```typescript
it('R40: resolveL3 multiEvalTotal döndürür — multi-eval/none path\'lerinde dolu, own-path\'te tanımsız', async () => {
  // multi-eval aktif store → resolveL3(...).multiEvalTotal === toplam (sayı)
  // boş store (multi yok) → resolveL3(...).multiEvalTotal === 0
  // own-path (ownGoldenCount ≥ eşik) → resolveL3(...).multiEvalTotal === undefined (scan yok)
});
```
(c) evolve mesajı `l3.multiEvalTotal` ile aynı değeri verir (tek-scan davranışının çıktı-bütünlüğü pin'i):
```typescript
it('R40: evolve eşik-altı mesajı multiEvalTotal değeri resolveL3 ile tutarlı', async () => {
  // mevcut (d) testinin kardeşi: multiEvalTotal>0 olan store'da mesajdaki sayı === resolveL3'ün alanı
});
```

- [ ] **Step 2: FAIL kanıtı** — (a) duplicate sessizce iki kez koşulur; (b) multiEvalTotal alanı yok; (c) alan yok.

- [ ] **Step 3: Implementasyon**
1. `resolveL3` dönüş tipi `{ active: boolean; source: 'own' | 'multi-eval' | 'none'; multiEvalTotal?: number }`: own-path erken dönüş `{ active: true, source: 'own' }` (scan YOK — alan tanımsız); multi/none path'leri `{ ..., multiEvalTotal: latestMultiEvalTotal(s) }` döndürür (tek hesap, alana taşınır). `latestMultiEvalTotal` modül-private kalır.
2. Evolve eşik-altı bloğu: ayrı `latestMultiEvalTotal(s)` çağrısı SİLİNİR; mesaj `l3.multiEvalTotal` okur — `L3 eşik altı (l3MinGoldenTasks=${policy.l3MinGoldenTasks}, golden=${ctx.goldenCount}, multiEvalTotal=${l3.multiEvalTotal ?? 0}) — eval koşulmadı` (own-path kapalı yola girmez; ?? 0 savunmacı tipte).
3. weightedScore NaN restore: `const weightedScore = totalTasks === 0 ? 0 : Math.round(perRepo.reduce(...) / totalTasks * 10) / 10;` + `// hüküm: R40 savunmacı restore — faz 7 T1 kaldırdı (preflight invariant); koşum-ortası golden silinmesi (patolojik TOCTOU) NaN üretir, NaN JSON'da null'a düşer — savunma geri geldi; ulaşılamaz yol → test yazılmaz`.
4. Duplicate kontrol: `--repos` zinciri split → trim → boş kontrol (mevcut) → `resolve()` → `const dup = resolved.find((p, i) => resolved.indexOf(p) !== i); if (dup) throw new Error(\`duplicate repo yolu: ${dup}\`)` → mevcut preflight devam. Canonical mutlak yol üzerinden; Windows case-insensitivity bilinçli kapsam dışı (hüküm yorumunda dokümante).
5. Konvansiyon: cli.ts:57-64 helper-split gerekçe yorumunun prefix'i `R37 (faz 7 T3):` → `hüküm: R37 faz 7 T3 — ...` (davranış yok).

- [ ] **Step 4: PASS** — `npx vitest run` (318+2skip + 3 yeni ≈ 321+2skip; faz 7 T3 resolveL3 toEqual pin'leri etkileniyorsa hüküm-notlu güncelle); iki tsc temiz.

- [ ] **Step 5: Commit** `feat: hijyen — resolveL3 multiEvalTotal tek-scan + NaN savunma + duplicate repo fail-closed (R40)`

---

### Task 2: README sistem durumu + konvansiyon + kabul (R40.4/R41/R42)

**Files:**
- Modify: `README.md` (yeni `## Sistem durumu (faz 8 kapanışı)` bölümü + alıntı notu + kabul checklist), `tests/e2e/invariants.test.ts` (README-hizası invariant'a Faz 8 pin'leri)

**Interfaces:**
- Consumes: T1'in teslimleri (multiEvalTotal, duplicate mesajı); mevcut README bölüm yapısı (Faz 6/7 formatı).
- Produces: `## Sistem durumu (faz 8 kapanışı)` — L1→L3 döngü özeti + 7 adımlı operasyonel yürüyüş + multi-repo/canlı kısaltmaları; `### Kabul checklist (R42)` (R28 formatında).

- [ ] **Step 1: Değişmez denetimi** — mevcut "README faz 6+7" invariant'ına Faz 8 pin'leri eklenir veya sibling describe (dosya konvansiyonuna göre — Faz 7 örneği EXTEND seçti, aynı gerekçeyle EXTEND): `## Sistem durumu`, `multiEvalTotal`, `duplicate repo yolu`, `devloop evolve apply`, `Kabul checklist (R42)`; hüküm notlu.
- [ ] **Step 2: README sistem-durumu bölümü** — R41'in tam içeriği: (1) L1→L3 döngü özeti bir paragraf; (2) operasyonel yürüyüş numaralı liste (run → learn → golden draft/list/accept → status l3Active/l3Source → eval → evolve --shadow → evolve apply <evoId>); (3) multi-repo kısaltması (`eval --repos p1,p2` — aggregate + salt-okunur hedefler + duplicate/boş-segment fail-closed notu); (4) canlı test kısaltması (`CROSS_PROVIDER_LIVE=1` + iki gerçek anahtar); (5) alıntı konvansiyon notu (R40.4). **Her komut gerçek CLI işleviyle eşleşmeli** (buildCli üzerinden teyit et — yanlış komut = Important).
- [ ] **Step 3: Kabul checklist (R42)** — 4-6 satır, her kriter ✅ + kanıt işaretçisi (T1 test adları + `npm run typecheck:tests` + final koşum sayısı).
- [ ] **Step 4: Tüm doğrulama** — `npx vitest run` (final sayı), `npx tsc --noEmit`, `npx tsc -p tsconfig.test.json`, `npm run build` — dördü temiz.
- [ ] **Step 5: Commit** `docs: faz8 sistem durumu + kabul checklist (R41/R42)`

---

## Self-Review Notları (plan yazarı)

1. **Spec kapsam:** R40.1-3+4→T1 (4.4 README alıntı notu T2'ye taşındı — README-dokümantasyon maddesi olduğu için); R41→T2; R42→T2 checklist; R43 ertelemeler plana girmez.
2. **Tip tutarlılığı:** `multiEvalTotal?: number` (optional — own-path'te tanımsız); evolve mesajı `l3.multiEvalTotal ?? 0` (tipte savunmacı); duplicate mesajı 'duplicate repo yolu: X' (X = canonical yol).
3. **Bilinen riskler:** faz 7 T3 resolveL3 toEqual pin'leri (b1/b2) multiEvalTotal alanıyla kırılabilir — hüküm-notlu güncelleme T1 kapsamında (spec R40.1 ifşalı); NaN restore test-yazımsız (ulaşılamaz — spec hükümlü); duplicate kontrol resolve-SONRASI (canonical; Windows case-insensitivity kapsam dışı — hüküm yorumu).
4. **T2 dokümantasyon doğruluğu:** operasyonel yürüyüşteki her komut gerçek CLI ile eşleşmeli; invariant pin'leri komut adlarını pin'liyor (yanlış komut = invariant + review yakalar).
