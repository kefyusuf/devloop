# devloop

AI agent ile yazılım geliştiren, üretimi katmanlı otomatik review'den geçiren, sonuçları kanıt zincirli event günlüğüne yazan ve insan-onaylı derslerle (L1) öğrenen CLI.

## Ön koşullar

- **Hedef repo bir TypeScript projesi olmalı.** Gate'ler (`static-gates`, `tests`) hedef repoda
  `tsconfig.json` ve **eslint flat config** (`eslint.config.js` / `.mjs`) bekler; vitest test koşumu için
  test komut dosyası bekler.
- **Yoksa ilgili gate fail-closed error verir** — sessiz pass yok (A6). eslint 9/10 hedef repoda config
  olmadan koşmaz; config'i olmayan reponun `static-gates` gate'i error statüsüyle görevi bloklar.
- devloop kendi `node_modules`'undaki `eslint` / `typescript` / `vitest` ile **fallback toolchain** sağlar:
  hedef repoda araç yoksa çözümleme sırası *hedef repo walk → devloop node_modules*'dur. Araç çalışır ama
  config hâlâ hedef repoya aittir.
- Sırlar (API anahtarları) spawn edilen süreçlere sızmaz: tüm çocuk süreçler (git, gh, eslint, tsc, vitest)
  seçilmiş env ayak iziyle (`safeEnv`) koşar.

## Kurulum

```bash
cd <devloop-yolu>
npm install && npm run build
# global kullanım için (ikisinden biri):
npm link                                  # → `devloop` komutu
npx tsx <devloop-yolu>/src/index.ts ...   # kurulumsz koşum
```

- `DEVLOOP_REPO` env değişkeni: komutun çalıştığı dizinden bağımsız hedef repo. Ayarlanmazsa çalışma
  dizini hedef repo kabul edilir. Örn: `DEVLOOP_REPO=C:\src\myapp devloop status`.
- API anahtarı yalnız ortam değişkeninden: `export ANTHROPIC_API_KEY=...`

## Hızlı başlangıç

```bash
# hedef repoda:
tasks.json hazırla: [{ id, description, acceptanceCriteria, filesScope }]
devloop run tasks.json   # → feature branch + PR/report + bulgular  (veya absolute yol da geçerli)
devloop decide --task task-1 --reject --reason false-positive --findings f1,f2
devloop learn          # aday dersleri listeler
devloop learn confirm <lessonId>   # insan onayı → aktif ders
devloop learn reject <lessonId>    # aday ret → tombstone (yeniden listelenmez) / aktif ders → retired
devloop status
```

## Çalışma şekli

- Her koşum git worktree + feature branch'te; main'e asla yazmaz. Worktree **hedef repo içinde**
  `<repo>/.devloop/worktrees/<runId>-<taskId>` altında açılır ve görev sonunda temizlenir.
  `.devloop/` hedef reponun `.git/info/exclude`'una yazılır — kullanıcının `.gitignore`'una dokunulmaz.
- Bütçe `budgetUsd` koşum (run) başınadır; resume yeni bütçe alır (per-run hüküm). Bütçe tek kapıdır:
  generator + reviewer'ın TÜM LLM çağrıları `BudgetedGateway` üzerinden sayılır, aşım anında koşum
  abort eder.
- Agent yazma yüzeyi kısıtlıdır: artifact `policy.yaml`, `.gitignore`, `package.json` ve `.devloop/`
  yollarına yazamaz (fail-closed).
- Deterministik gate'ler (lint/tip/test/sırrı) tartışmasız; LLM bulguları advisory — merge kararı her
  zaman insanda. Gateway/altyapı hatası görev bloklamaz: koşum run-level suspend (panic) olur ve resume
  ile kaldığı yerden sürer.
- Tüm koşumlar `<repo>/.devloop/events.jsonl` dosyasına append-only kanıt zinciriyle iner; StageVerdict'ler
  artifact event'lerine parent referansıyla bağlıdır.

## Güvenlik sınırı (v1)

- **Trusted repositories only.** Worktree kaynak izolasyonudur, sandbox değildir; güvenilmeyen repo koşullandırılmaz (container izolasyonu faz 3).
- Komutlar sabit executable (eslint/tsc/vitest), shell yok, timeout'lu.
- PR yetkisi: oluştur var, merge yok. Hedef repoda branch protection + zorunlu status check kullanın.

## Faz 2

### LLM ensemble (iki heterojen reviewer)

- Advisory review iki reviewer'dan oluşur: **ana reviewer** (doğruluk/okunabilirlik/mimari/güvenlik/performans
  beş eksenli rubrik) + **alt reviewer** (güvenlik/performans odaklı ayrı rubrik; `llm.fallbackModel`
  override'ı ile farklı modelde koşabilir).
- Aynı `dosya:satır:kategori` anahtarını iki taraf da ürettiğinde bulgu **`corroborated: true`** ile
  işaretlenir (tek kaynaklı bulgu `false` kalır); kopya ensemble içinde tek kazanan'a indirilir —
  en şiddetli bulgu birebir korunur.
- Alt reviewer yalnız ana reviewer bulgulu olduğunda **veya** risk skoru `ensembleRiskThreshold`
  (varsayılan 40) üzerinde olduğunda koşur; eşik altı bulgusuz koşumda tek reviewer çağrısı yapılır.

### Gerçek mutation gate

- Hedef repoda `stryker.config.json` **varsa** `mutation-testing` gate'i gerçek Stryker koşumu yapar
  (hedef repoda araç yoksa devloop node_modules fallback'i) ve mutation skorunu ayrıştırır: skor
  `mutationScoreThreshold` (varsayılan 60) altındaysa critical bulgu + gate fail.
- Config **yoksa** gate `skipped` olur — sessiz pass yok; skip kanıta StageVerdict olarak iner ve
  varsayılan `authorizedSkips` bunu kapsar.
- `mutationTimeoutMinutes` (varsayılan 15) aşımı veya ayrıştırılamayan çıktı fail-closed error'dur.

### CI trigger mode (review-diff)

```bash
devloop review-diff --diff pr.diff --task pr-17
```

- Generator'sız çalışır: unified diff'ten dosya başına eklenen satırlar artifact'a kurılır, gate'ler +
  ensemble advisory koşar, event'ler aynı store'a append edilir. Örnek GitHub Actions iş akışı:
  `docs/ci/github-actions.yml`.
- **Exit kodları:** `0` = gates pass + critical bulgu yok; `1` = gate fail veya critical bulgu;
  `2` = yalnız advisory bulgular.
- Kararlar yine insanın (`devloop decide`) — CI insan gate'ini değiştirmez (D3).

### L2 kural indüksiyonu (staging-only, insan onaylı)

```bash
devloop learn proposals             # tekrarlayan reject kararlarından öneri listesi
devloop learn apply <proposalId>    # öneriyi yalnız <repo>/.devloop/proposals/<id>/ staging'ine yazar
```

- Öneriler deterministiktir (kategori + karar seti hash'i); global eşik `l2MinDecisions`
  (varsayılan 100) altında L2 devre dışıdır.
- `apply` repoya/policy'a **otomatik yazım yapmaz** — değişmez: staging dışına tek bayt yazım yok;
  öneriyi insan onayıyla elle uygular.

### Bütçe doğruluğu (R1)

- Bütçe tek kapısı genişletildi: generator'un **ve** ensemble reviewer'larının tüm gerçek LLM harcaması
  (`usage.costUsd`) aynı `BudgetedGateway` örneğinden sayılır; paylaşılan örnek üzerindeki kümülasyon
  bütçeyi aşınca koşum anında abort eder.

### Dayanıklılık (R4)

- Gateway geçici hatalarda üstel backoff (`llm.backoffMs`, varsayılan 500) ile retry + fallback model;
  tükeniş `GatewayError` → run-level suspend (panic), resume ile sürer.
- Gate config parmak izi (`gateConfigHash`: tsconfig/eslint config içerik sha256'sı) RunStarted kanıtına
  yazılır; resume'da config kayması panic'tir — sessiz politika karışımı yok.

### Faz 2 policy alanları

| Alan | Varsayılan | Anlamı |
| --- | --- | --- |
| `ensembleRiskThreshold` | `40` | Risk skoru bunun üzerindeyse alt reviewer bulgusuz da koşar |
| `mutationScoreThreshold` | `60` | Stryker mutation skorunun altı → critical bulgu + gate fail |
| `mutationTimeoutMinutes` | `15` | Stryker koşum zaman aşımı (aşım fail-closed) |
| `llm.backoffMs` | `500` | Gateway retry backoff tabanı (üstel) |
| `l2MinDecisions` | `100` | L2 öneri üretimi için gereken minimum insan karar sayısı |

Tümü `.default()` ile geldiğinden mevcut `policy.yaml` dosyaları geriye dönük uyumludur; policy
değişiklikleri insan-onaylı review'e tabidir (§5.2.2).

Detaylı tasarım: `docs/superpowers/specs/2026-11-18-ai-dev-loop-design.md`
