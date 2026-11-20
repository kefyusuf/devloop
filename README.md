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

- Gateway geçici hatalarda doğrusal backoff (`backoffMs × deneme`; `llm.backoffMs`, varsayılan 500;
  4 sn tavan) ile retry + fallback model; tükeniş `GatewayError` → run-level suspend (panic), resume
  ile sürer.
- Gate config parmak izi (`gateConfigHash`: tsconfig/eslint config içerik sha256'sı) RunStarted
  kanıtına yazılır — YALNIZ kanıt/izlenebilirlik amaçlıdır; resume'daki panic kararı YALNIZ policyHash
  karşılaştırmasıdır (gateConfigHash değişimi koşumu durdurmaz — sessiz politika karışımı yok).

### Faz 2 policy alanları

| Alan | Varsayılan | Anlamı |
| --- | --- | --- |
| `ensembleRiskThreshold` | `40` | Risk skoru bunun üzerindeyse alt reviewer bulgusuz da koşar |
| `mutationScoreThreshold` | `60` | Stryker mutation skorunun altı → critical bulgu + gate fail |
| `mutationTimeoutMinutes` | `15` | Stryker koşum zaman aşımı (aşım fail-closed) |
| `llm.backoffMs` | `500` | Gateway retry backoff tabanı (doğrusal: `backoffMs × deneme`) |
| `l2MinDecisions` | `100` | L2 öneri üretimi için gereken minimum insan karar sayısı |

Tümü `.default()` ile geldiğinden mevcut `policy.yaml` dosyaları geriye dönük uyumludur; policy
değişiklikleri insan-onaylı review'e tabidir (§5.2.2).

## Faz 3

### Eval harness + golden dataset (R9)

```bash
devloop eval                    # production pipeline ile golden set koşumu
devloop eval --full             # ensemble dahil (LLM çağrısı yapar — API anahtarı gerekir)
devloop eval --candidate <dir>  # shadow: aday policy ile aynı golden seti (salt-okunur karşılaştırma)
```

- Golden görevler hedef repoda **`.devloop/golden/*.task.json`** olarak versiyonlanır. Format:

  ```json
  {
    "goldenId": "g1",
    "taskSpec": { "id": "gt1", "description": "…", "acceptanceCriteria": ["…"], "filesScope": [] },
    "fixtureDiff": "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1,2 @@\n const x=1;\n+const y=2;",
    "expected": {
      "gatesPass": true,
      "requiredFindings": [{ "category": "test-diff" }],
      "forbiddenCategories": ["secret"]
    }
  }
  ```

- Skor: her görev `expected` ile karşılaştırılır (R9 **donmuş yargıç** — karşılaştırma yalnız golden
  `expected` + gate çıktıları üzerinden; öğrenen bileşenler jüri olmaz). `score = geçen / toplam × 100`
  (10'da 1 yuvarlanır: 2/3 → 66.7). Sonuç `EvalRun` event'i olarak kanıt zincirine yazılır;
  `configSnapshot.mode='production'` (candidate'sız) veya `configSnapshot.candidate=<etiket>` +
  `comparedTo=<önceki production evalId>` (shadow) taşır.
- **Shadow salt-okunurdur:** `--candidate` koşumu üretim `policy.yaml`/lessons/proposals'a SIFIR yazım
  yapar; yalnız kanıt event'leri düşer. Aday policy dizini `policy.yaml` içermiyorsa komut fail-closed
  hata verir (sessiz varsayılan-policy düşüşü yok).
- Şemaya uymayan görev dosyaları koşum dışında bırakılır ama sessiz değildir: dosya adları eval
  özetindeki **`invalid`** listesinde (ve `EvalRun` kanıt event'inde) raporlanır.
- Koşum `--full` olmadan LLM çağrısı yapmaz — pipeline gate stage'leriyle (risk-triage, static-gates,
  tests, secret-scan, mutation-testing) deterministik koşar; kanıttaki bulgular yalnız bu stage'lerden
  gelir.

### L3 evrim — evolve (R10)

```bash
devloop evolve --shadow         # playbook aday üretimi + adayların shadow eval'i
devloop evolve apply <evoId>    # adayı golden-gerileme kapısıyla playbook staging'e yazar
```

- Aday üretimi **yalnız L3 aktifken** çalışır: golden görev sayısı `l3MinGoldenTasks` (varsayılan **50**)
  altındaysa aday üretilmez. Sinyaller deterministiktir: tekrarlayan false-positive ret kararları →
  `playbook-reviewer` adayı; tekrarlayan test-diff bulguları → `playbook-generator` adayı. Shadow/eval
  koşumlarının kendi kanıtları sinyal sayılmaz (kendi kendini besleyen gürültü yok).
- **Golden-gerileme red kapısı:** adayın shadow eval'i baseline'dan **daha çok golden görevi
  kırmışsa** (`shadowEval.failed > baseline.failed`) `apply` reddedilir — staging dosyası da kanıt
  event'i de yazılmaz.
- Apply **A5 staging kuralı**: yalnız `<repo>/.devloop/playbooks/<evoId>.json` yazılır +
  `ProposalCreated` kanıtı düşer. Policy/lint kuralı/lessons'a otomatik yazım yok — değişikliği insan
  devreye alır.

### Risk-tiered davranış (R11)

- **CI derinliği (`review-diff`):** RiskTriageStage önce tek başına koşar; skor
  `ciEnsembleRiskThreshold` (varsayılan **20**) altındaysa gate-only pipeline koşar (ensemble'sız —
  low-risk CI koşumu LLM harcamaz); eşikte/üstünde full pipeline (gates + llm-ensemble) koşar.
  `RunStarted` kanıtındaki `configSnapshot.gates` **seçilen** pipeline'ın etkin stage kümesini birebir
  taşır (low-risk koşumda `llm-ensemble` yoktur, derin koşumda vardır).
- **Mutation kapsam ölçekleme:** mutation gate'inin `--mutate` seçimi risk skoruna göre ölçeklenir:
  `risk < 30` → `mutationScopeLow` (varsayılan 5) dosya, değilse `mutationScopeHigh` (varsayılan 10)
  dosya (içerik-uzunluğu DESC — deterministik).

### OpenAI provider (R12)

- `llm.provider: openai` seçilirse gateway **OpenAIGateway** olur (`POST
  https://api.openai.com/v1/chat/completions`, `response_format: json_object`): anahtar yalnız
  `OPENAI_API_KEY` ortam değişkeninden. Model/limit/maliyet alanları `llm.openai.*` bloğundadır
  (`model: gpt-4.1`, `fallbackModel: gpt-4.1-mini`); usage `prompt_tokens/completion_tokens` OpenAI
  oranlarıyla maliyetleşir.
- **Fail-closed:** anahtar yoksa seçilen provider GatewayError verir — sessiz düşüş yok. Retry/backoff
  + `openai.fallbackModel` fallback davranışı Anthropic adapter ile birebir aynıdır
  (`llm.backoffMs`).

### Container sandbox (R13)

- `sandbox.mode: docker` seçilirse lint/tip/test koşumları `dockerizeSpawn` ile konteynere sarılır:
  `docker run --rm -v <worktree>:/workspace -w /workspace --network none <sandbox.image> npx …`
  (`sandbox.image`, varsayılan `node:20-bookworm-slim`). Araç çözümleme konteyner içi npx ile yapılır —
  **hedef repoun kendi toolchain'i** mount edilen node_modules'tan gelir.
- Gereksinimler: Docker daemon erişimi + hedef repoda toolchain (node_modules). Docker yoksa koşum
  **run-level abort** ile açık mesajla durur (sessiz host-run yok). Mutation gate'in konteyner koşumu
  faz 4'te genişletildi (R20 — bkz. Faz 4): docker modda mutation gate artık konteynerde koşar,
  node_modules `:ro` bind edilir.
- `sandbox.mode: host` (varsayılan) mevcut davranıştır.

### Faz 3 policy alanları

| Alan | Varsayılan | Anlamı |
| --- | --- | --- |
| `l3MinGoldenTasks` | `50` | L3 evrim aday üretimi için gereken minimum golden görev sayısı |
| `ciEnsembleRiskThreshold` | `20` | review-diff risk skoru bunun altındaysa gate-only pipeline koşar (LLM yok) |
| `mutationScopeLow` | `5` | LOW-risk (< 30) koşumda mutate edilecek maksimum dosya sayısı |
| `mutationScopeHigh` | `10` | HIGH-risk (≥ 30) koşumda mutate edilecek maksimum dosya sayısı |
| `sandbox.mode` | `host` | `docker` → araç koşumları konteynere sarılır (Docker daemon + repo toolchain gerekir) |
| `sandbox.image` | `node:20-bookworm-slim` | docker modunda kullanılan konteyner imajı |
| `llm.provider` | `anthropic` | `openai` → OpenAIGateway (`OPENAI_API_KEY`, `llm.openai.*`) |
| `llm.openai.model` | `gpt-4.1` | OpenAI ana model |
| `llm.openai.fallbackModel` | `gpt-4.1-mini` | OpenAI fallback model |
| `llm.openai.costPer1kInput` / `costPer1kOutput` | `0.0025` / `0.01` | OpenAI maliyet oranları (USD / 1K token) |

Tümü `.default()` ile geldiğinden mevcut `policy.yaml` dosyaları geriye dönük uyumludur; policy
değişiklikleri insan-onaylı review'e tabidir (§5.2.2).

## Faz 4

### Golden veri yolu — draft/list/accept/discard (R17)

```bash
devloop golden draft [--from-run <runId>]   # kabul edilmiş koşum kanıtından taslak üretimi
devloop golden list                         # staging taslaklarını listeler
devloop golden accept <draftId>             # İNSAN ONAYI → staging → golden/ rename
devloop golden discard <draftId>            # taslağı at
```

- **İnsan küratörlüğü ilkesi (A5):** `draft` YALNIZ `.devloop/golden-drafts/` staging dizinine yazar;
  `.devloop/golden/` dizinine yalnız `accept` (rename) dokunur — otomatik golden büyümesi kapalıdır.
  `discard` yalnız staging dosyasını siler; golden/'daki kabul edilmiş görevler etkilenmez.
- Taslak içeriği koşum kanıtından türetilir (LLM'siz): `gatesPass: true` sabittir (PRCreated yalnız
  gates pass sonrası açılır); `real-issue-accepted` kararlarının bulgu kategorileri
  `requiredFindings`'e, `false-positive` retlerin bulgu kategorileri `forbiddenCategories`'e düşer;
  `fixtureDiff`, kabul edilen artifact diff'inin birebir kopyasıdır. `goldenId` deterministiktir
  (sha256(taskSpec + diff)) — aynı koşum yeniden draft edilirse aynı ID staging'e döner.
- Zaten kabul edilmiş bir `draftId`'nin ikinci accept'i hata verir (duplicate red).
- Bu veri yolu eval/L3'ü besler: golden set `l3MinGoldenTasks` eşiğine buradan büyür (L3 veri yolu).

### Generator playbook bağlamı (R18)

- `evolve apply` ile staging'e yazılan playbook'lar ÇİFT bağlama girer: `playbook-reviewer` adayları
  reviewer prompt'una (ana + alt reviewer), `playbook-generator` adayları generator bağlamına
  (`generatorContext()`; `- <başlık> — <not>` satırları). Apply edilmemiş adaylar (candidates/)
  prompt'lara girmez; staging (`.devloop/playbooks`) tek kaynaktır.
- Kompozisyon satır bazlıdır (`composeReviewerLessons`, R22): 'yok.' bildirimi içeren satırlar
  atılır, gerçek ders satırları korunur — tek kaynaktaki boş bildirim diğer kaynağın derslerini
  blok-düşürmez (per-line filtre). Bozuk playbook dosyaları fail-soft atılır.

### Evolve --llm: eval + insan kapılı LLM mutasyonları (R19)

```bash
devloop evolve --shadow            # deterministik aday üretimi + shadow eval (varsayılan mod)
devloop evolve --shadow --llm      # shadow sonrası LLM üretimli playbook mutasyon TASLAKLARI
devloop evolve apply <evoId>       # insan onayıyla golden-gerileme kapısından staging'e yaz
```

- `--llm` verilmezse davranış aynen deterministiktir — mutasyon gateway çağrısı hiç yapılmaz
  (deterministik mod default).
- `--llm` iki kapıdan geçer: (1) l3Active — golden set `l3MinGoldenTasks` eşiği altındaysa LLM
  üretimi yapılmaz; (2) golden-gerileme — shadow eval baseline'dan daha çok golden görev kırmışsa
  taslak üretimi reddedilir. Taslaklar deterministik adaylarla AYNI yerde staging edilir
  (candidates/) ve insan onayı olmadan uygulanmaz; her taslak tek gateway çağrısı harcar.
- Anahtarsız ortamda `--llm` fail-closed: GatewayError yakalanır, anlamlı mesaj stderr'e yazılır ve
  exit kodu 1 olur — deterministik sonuç JSON'u stdout'ta aynen kalır (parse edilebilir).
- Prompt sinyalleri kendini beslemez: shadow/eval koşum kanıtları verdict pattern'lerine girmez
  (self-noise koruması); taslak evoId deterministiktir (kind:title:content + baseline evalId seed'i).

### Sandbox mutation genişletmesi (R20)

- `sandbox.mode: docker` seçilirse mutation gate de artık konteynerde koşar: Stryker
  `runToolDockerAware` ile `docker run --rm -v <worktree>:/workspace … --network none <image>
  npx stryker …` olarak hedef reponun KENDİ toolchain'iyle koşar (faz 3.1 fail-closed guard'ı
  kaldırıldı; Docker-yok abortu aktivasyon kapısında aynen sürer — sessiz host-run yok).
- Orijinal reponun `node_modules`'u konteynere **read-only (`:ro`)** bind edilir — bağımlılık ağacı
  konteynerden yazılamaz; node_modules yalnız çözümleme kaynağıdır. Mutation raporu (mutation.json)
  worktree mount'undan host yolunda okunur.

### Cross-provider fallback (R21)

- `llm.crossProviderFallback: true` seçilirse gateway ayak listesi kurulur: birincil provider önce,
  DİĞER sağlayıcı ikinci ayak. Her ayak anahtar-durum filtresinden geçer (anthropic →
  `ANTHROPIC_API_KEY`, openai → `OPENAI_API_KEY`); anahtarsız ayak atlanır, hiç ayak kurulamazsa
  GatewayError fırlatır (fail-closed).
- Ayaklar sırayla denenir; ilk başarılı yanıt döner; tüm ayaklar başarısızsa tek GatewayError çıkar
  (son-neden mesajı tüm ayakların hatalarını içerir).
- Zincir YALNIZ config açıkken kurulur (`false` varsayılan — davranış değişmez) ve yine
  `BudgetedGateway` ile sarmalanır: bütçe tek kapıdır, cross-fallback yalnız config açıkken maliyet
  doğurur.

### Faz 4 policy alanları

| Alan | Varsayılan | Anlamı |
| --- | --- | --- |
| `llm.crossProviderFallback` | `false` | `true` → diğer sağlayıcı ayağı gateway zincirine eklenir (anahtarı env'de mevcutsa); `false` → yalnız birincil ayak |

Tek policy eklemesi budur; diğer faz 4 kalemleri mevcut alanları kullanır. Tümü `.default()` ile
geldiğinden mevcut `policy.yaml` dosyaları geriye dönük uyumludur; policy değişiklikleri
insan-onaylı review'e tabidir (§5.2.2).

Detaylı tasarım: `docs/superpowers/specs/2026-11-18-ai-dev-loop-design.md`
