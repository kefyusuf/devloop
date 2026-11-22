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

## Faz 5

### decide → run bağlantısı (R25)

- `devloop decide` kararı GERÇEK koşum kanıtına bağlar: `--run` verilmezse store'daki son eşleşen
  `TaskPicked` koşumunun runId'si **auto-resolve** ile kullanılır; `--run <runId>` override; eşleşen
  koşum yoksa ve `--run` verilmediyse **fail-closed hata** — sessiz `manual` yazımı yoktur, açık
  `--run manual` tek manuel yoldur. Golden draft'lar böylece gerçek decide kararlarından beslenir
  (uçtan uca zincir kanıtı: `tests/e2e/decisionPath.test.ts`).

### SHIP batch (R26)

- Sentineller tek kaynakta (`src/shell/sentinels.ts`): değer pin + tüketici drift koruması
  (composeLessons/generator davranışları sabitlerle senkron — test kırılması bilinçli değişiklik demek).
- `createGatewayOrChain`: tek ayak → düz gateway, çok ayak → `ChainedGateway`, hiç ayak →
  GatewayError; CLI'ın 5 gateway kurulum sitesi tek helper'ı kullanır.
- Tek tool-run seam: `runToolDockerAware` — mutationStage host dalı ona delegeler (host/docker
  dalları tek kapıda).
- **Canonical JSON** (`src/util/canonicalJson.ts`): evoId/goldenId hash seed'leri key-order
  duyarlı DEĞİL — aynı içerik farklı anahtar sırasıyla aynı kimliği alır.
- `parseDiff` satır-sonu whitespace toleransı + cross-fallback test tamamlaması (HTTP-error→fallback,
  openai-primary symmetry — faz 3 T6 kalıntısı).
- **Cross-fallback üretim hatası düzeltmesi (R26f):** `AnthropicGateway` kurucusu anahtarı
  provider-koşullu okuyordu (`anthropic ? ANTHROPIC_API_KEY : LLM_API_KEY`) ama `createGateways`
  ayak kapısı ANTHROPIC_API_KEY varlığına bakıyordu → openai-birincil policy'de anthropic yedek
  ayağı daima anahtarsız kalıyor ve **openai→anthropic cross-fallback üretimde hiç çalışmıyordu**.
  Kurucu artık daima `ANTHROPIC_API_KEY` okur (kalan `LLM_API_KEY` ölü koddu); fail-closed aynen.
- Hijyen düzeltmesi (R26g — faz 3 T6 kalıntısı): `eval-` prefix'li koşumların (production eval
  dâhil) evrim sinyal sayımına girmesi kapatıldı — eval kanıtı artık aday üretimini kirletmiyor.

### Aktivasyon görünürlüğü (R27)

`devloop status` çıktısına L3 aktivasyon alanları eklendi:

| Alan | Anlamı |
| --- | --- |
| `goldenCount` | kabul edilmiş golden görev sayısı (`.devloop/golden/`) |
| `goldenDrafts` | staging taslak sayısı (`.devloop/golden-drafts/`) |
| `l3Active` | L3 kapısı (faz 7 R37 `resolveL3`): kendi goldenCount ≥ eşik YA DA en son multi-eval batch toplamı ≥ eşik — evolve açık mı |
| `l3Source` | kapı kaynağı: `own` / `multi-eval` / `none` — daima yazılır (faz 7 R37) |
| `lastEvalScore` | son production eval skoru (shadow/eval koşumları sayılmaz) |

**L3 aktivasyon yolu:** golden kabul (`devloop golden accept`) ile görev setini `l3MinGoldenTasks`
(varsayılan **50**) eşiğine ulaştırın → `l3Active=true` → `devloop evolve` otomatik aktifleşir.

### Test tip kapsamı (R26h)

`npm run typecheck:tests` (`npx tsc -p tsconfig.test.json`): tüm test dosyaları strict tip
kapsamındadır — mevcut test tip hataları faz 5'te düzeltildi.

### Kabul checklist (R28)

| Kriter | Kanıt |
| --- | --- |
| ✅ (a) mevcut 267+1skip bozulmaz | `npx vitest run` — faz 5 kapanışında **296+1skip / 34 dosya** |
| ✅ (b) decide fail-closed | `tests/cli/cli.test.ts` — "decide: eşleşen TaskPicked yok + --run yok → fail-closed hata" |
| ✅ (c) E2E zinciri | `tests/e2e/decisionPath.test.ts` — decide auto-resolve → golden draft → accept → eval score 100 + validateChain ok |
| ✅ (d) canonical JSON key-order | `tests/util/canonicalJson.test.ts` + invariants "canonical JSON değişmezi: aynı LLM mutasyon içeriği farklı key-sırasıyla → aynı evoId" |
| ✅ (e) tsconfig strict | `npm run typecheck:tests` (`npx tsc -p tsconfig.test.json`) — vitest içinden spawn pahalı/fragman olduğundan build-level komut olarak kanılanır |
| ✅ (f) sentinels drift pin'leri | `tests/shell/sentinels.test.ts` — üç sentinelin değer pin'i + sabit-üzerinden tüketici drift testleri |

## Faz 6

### Multi-repo eval (R30)

`devloop eval --repos <p1,p2,...>`: virgülle ayrık hedef repo yolları üzerinde golden set
agregasyonu. `--repos` verilmemişse tek-repo davranış **sıfır değişiklik** (ayrık kod yolu —
mevcut akış byte-identical korunur).

```bash
devloop eval --repos ../repoA,../repoB
```

Çıktı: `perRepo[]` (her repo için tam EvalSummary + `repo`) + `aggregate` — toplamlar ve
**weightedScore** = Σ(scoreᵢ·nᵢ)/Σnᵢ (n=goldenCount; 0 task'lı repo ağırlığa katılmaz ama
perRepo'da açıkça raporlanır — sessiz hariç tutum yok; 1 ondalık yuvarlama):

```json
{
  "perRepo": [
    { "repo": "../repoA", "evalId": "…", "goldenCount": 2, "passed": 2, "failed": 0, "score": 100, "invalid": [], "l3Active": false, "…": "…" },
    { "repo": "../repoB", "goldenCount": 1, "passed": 1, "failed": 0, "score": 100, "…": "…" }
  ],
  "aggregate": { "totalTasks": 3, "totalPassed": 3, "totalFailed": 0, "weightedScore": 100, "mergedInvalid": [] }
}
```

- **Salt-okunur hedef ilkesi:** hedef repo'ların `.devloop/events.jsonl`'ine **hiçbir yazım
  yoktur**; kanıt orchestrator (çalışma dizini) store'unda toplanır — hedef repo başına bir
  `EvalRun` event'i, payload köküne additive optional **`repo`** alanıyla (tek-repo koşumda
  tanımsız; geriye-uyumlu). `runId` kuralı aynı (`eval-<evalId>`) — eval- sinyal filtresiyle
  otomatik uyumlu.
- **Fail-closed girişler:** var olmayan hedef yol → hata; hiçbir hedef repoda golden task yok →
  hata (boş koşum anlamsız — sessiz skor-0 raporu değil). Preflight TÜM yolları doğruladıktan
  sonra koşum başlar; hata yolu üzerinde kanıt yazımı olmaz.
- **Donmuş yargıcı (I2 hükmü aynen):** reviewerLessons orchestrator kompozisyonundan gelir —
  her repo aynı yargıçla ölçülür; hedef repo'nun kendi lessons/playbook'ları karışmaz.
- **L3 kapısı değişmedi:** `l3Active` per-repo kendi golden seti eşiğiyle (`l3MinGoldenTasks`)
  hesaplanır; aggregate'te `l3Active` alanı **yok** — birleşik goldenCount evolve eşiğini açmaz
  (ayrı, ölçülmüş karar: R34, faz 7+).

### Hijyen batch (R31)

- **reDel ws simetrisi:** `--- /dev/null ` (trailing-ws'li silme başlığı) artık header adayı —
  reDevNull (faz 5 T6) ile aynı `[ \t]*$` toleransı.
- **Prompt-bağlam filtresi:** LLM mutasyon prompt bağlamı da `signalExcludedFor` tek predicate'inden
  geçer — `eval-` prefix'li koşum bulguları ve kararları artık candidate sayımına da prompt
  satırlarına da sızmaz (R26g'nin kapsam dışı bıraktığı nokta).
- **policyHash → canonicalJson:** orchestrator/evalRunner/reviewDiff'teki üç policyHash seed'i
  `canonicalJson(policy)` üzerinden — hash key-order'dan bağımsız. **Bilinçli kabul (değer
  değişimi ifşalı):** policy çok-anahtarlı olduğundan hash DEĞERLERİ değişti; R31 öncesi persist
  edilmiş orchestrator store'ları ilk yeni orchestrator koşumunda resume-panic yapar (hash-pinli
  koruma beklediği gibi çalışır) — mevcut koşumlar tamamlanmadan güncelleme yapmayın.
- **goldenDrafts tek kapı:** `readGoldenDraftFiles` shared helper — `status` sayacı ile
  `golden list` filtresi aynı okuma kapısını kullanır.

### Canlı doğrulama ortam denetimi (R32) — SONUÇ

Yeni kod yok; ortam denetimi faz kapanışında raporlandı:

- **5d Docker:** daemon VAR (server 29.9.3) → `DEVLOOP_DOCKER=1 npx vitest run
  tests/shell/sandbox.test.ts` → **11/11 PASS** — gerçek tsc-in-container koşumu
  (dockerizeSpawn ile konteynerde `npx tsc --version`, ~25s) doğrulandı.
- **5e cross-provider canlı:** **OPENAI_API_KEY yok** + gate'li canlı koşum testi repo'da mevcut
  değil (factory cross-provider testleri offline fetch-stub'lı) → cross-provider canlı doğrulama
  **koşulamadı ve bilinçli atlanan doğrulama olarak raporlandı** (fail-open yok; R32 sözleşmesi).
  Faz 7+ adayı: OPENAI_API_KEY'li ortamda manuel canlı koşum veya gate'li test ekleme.

### Kabul checklist (R33)

| Kriter | Kanıt |
| --- | --- |
| ✅ (a) mevcut paket bozulmaz (faz 5 kapanışı: 296+1skip) | `npx vitest run` — faz 6 kapanışında **307+1skip / 34 dosya** |
| ✅ (b) multi-repo aggregate aritmetiği + salt-okunur hedef store | `tests/cli/cli.test.ts` — "R30: eval --repos iki repo golden setini agregasyonla koşar; hedef store'lar salt-okunur" (aggregate tam-şekil `toEqual` pin + payload.repo kanıtı) |
| ✅ (c) fail-closed girişler | `tests/cli/cli.test.ts` — "R30: --repos var olmayan yol → fail-closed hata" + "R30: golden'ı hiçbir hedef repoda yok → fail-closed hata (boş koşum yok)" |
| ✅ (d) tek-repo geriye-uyumluluk | `tests/eval/evalRunner.test.ts` — "R30: repo verilmeyen koşumda payload.repo undefined (geriye-uyumlu regrezyon pini)" |
| ✅ (e) hijyen pin'leri (R31) | `tests/shell/reviewDiff.test.ts` (reDel ws simetri + hunk-içi varyant), `tests/evolution/evolve.test.ts` (prompt-ctx eval- dışlaması), `tests/eval/evalRunner.test.ts` (policyHash key-order), `tests/golden/draft.test.ts` (readGoldenDraftFiles tek kapı) |
| ✅ (f) tsconfig strict | `npm run typecheck:tests` (`npx tsc -p tsconfig.test.json`) — build-level komut olarak kanılanır (R28e hükmü aynen) |

## Faz 7

### L3 kapı genişletmesi (R37)

Bir repo'nun kendi golden seti `l3MinGoldenTasks` (varsayılan **50**) eşiğinin altında kalabilir;
store'daki **en son multi-eval batch'inin** production golden toplamı eşiğe ulaşıyorsa evolve yine
de aktifleşebilir. **Evrim yine KENDİ repo'nun golden setinde çalışır** — multi-eval verisi yalnız
aktivasyonu gerekçelendirir (own set küçükse evrim kalitesi sınırlıdır; operatör kararı).

- **`multiEvalId` batch işareti:** `devloop eval --repos` koşumu TEK `multiEvalId` üretir ve AYNI
  koşumun TÜM per-repo `EvalRun` event'leri bu id'yi payload kökünde taşır (`repo` gibi;
  configSnapshot'a DEĞİL). Additive optional: tek-repo koşumda yazılmaz; eski store satırları da
  taşımaz — o store'lar yalnız `own` kaynağıyla değerlenir (geriye-uyumlu; `--repos`'suz
  eval/evolve/status davranışı değişmez).
- **`resolveL3` kapısı (tek kaynak):** `status` ve `evolve` AYNI kapıyı kullanır. Aktif EĞER kendi
  goldenCount ≥ eşik (kaynak `own`) YA DA en son multi-eval batch'inin (event sırasındaki son
  `multiEvalId` değeri — bayat veri kapıyı açamaz: önceki nitelikli batch'ler toplama katılmaz)
  **yalnız production koşumu üyelerinin** (candidate/shadow dışlanır) goldenCount toplamı ≥ eşik
  (kaynak `multi-eval`); değilse inaktif (`none`). **policyHash şartı koşulmaz** — eşik golden
  VERİ hacmi hakkındadır.
- **`devloop status`:** tek satırlı çıktıya additive **`l3Source=<own|multi-eval|none>`** alanı
  eklendi (daima yazılır) — `l3Active=true` ama kendi `goldenCount` düşükken kaynağı açıkça
  gösterir. `evolve` eşik-altı bildirimi de iki sayıyı verir: `L3 eşik altı (l3MinGoldenTasks=N,
  golden=X, multiEvalTotal=Y)` — shadow eval koşulmaz.
- **İki `l3Active` anlamı bilinçli ayrıdır:** `EvalSummary.l3Active` DEĞİŞMEDİ — o koşumun KENDİ
  setinin eşiğe göre durumudur (per-run veri); `status`'taki değer kapı durumudur (own VEYA
  multi-eval).

### comparedTo repo-scope + hijyen (R35)

- **comparedTo düzeltmesi:** `--candidate` aday koşumu artık yalnız **AYNI reponun** en son
  production koşumuyla karşılaştırılır (prevRuns `payload.repo` filtresi; tanımsız ↔ tanımsız
  eşleşir) — cross-repo çapraz referans kapandı; tek-repo davranış değişmez.
- **`--repos` boş segment fail-closed:** `"a,,b"` ve trailing-virgül gibi girişlerde boş segment
  sessizce düşürülmez — açık hata (`boş repo yolu`); fail-closed ilkesiyle hizalı kullanıcı girişi
  doğrulaması. Hata yolunda kanıt yazımı olmaz.
- **Kozmetik temizlik (davranış-değişmez):** `weightedScore`'daki `totalTasks === 0` dead-guard
  kaldırıldı (preflight "golden toplamı > 0" garantisini hüküm yorumu invariant'laştırır); R32
  satırındaki "gerçek Stryker/tsc-in-container" ifadesi "gerçek tsc-in-container" olarak düzeltildi
  (yalnız tsc bacağı koşuldu — parantez içi komut ifşası zaten vardı).

### Cross-provider canlı test kullanımı (R36)

`tests/gateway/factory.test.ts`'teki canlı test ÜÇ koşul birden sağlanınca koşar:
`CROSS_PROVIDER_LIVE=1` **VE** gerçek `OPENAI_API_KEY` **VE** gerçek `ANTHROPIC_API_KEY`.
Koşullardan biri eksikse skip (skipIf koleksiyon anında değerlenir — flag/anahtar yokken canlı
describe ağaca hiç alınmaz; test paketi offline kalır, ağ çağrısı yapısal olarak imkânsız):

```bash
CROSS_PROVIDER_LIVE=1 OPENAI_API_KEY=... ANTHROPIC_API_KEY=... \
  npx vitest run tests/gateway/factory.test.ts
```

- İçerik: openai bacağı geçersiz model adlarıyla gerçek API çağrısı yapar (4xx → zincir düşer) →
  anthropic bacağı gerçek anahtarla gerçek completion döndürür; assertion: gerçek cevap boş değil
  + usage alanları dolu. Test fetch stub'LAMAZ — gerçek ayaklar + gerçek ağ.
- **Maliyet notu:** başarısız openai 4xx istekleri ücretsizdir (token üretmez); anthropic ayağı
  tek küçük completion koşar (`maxTokens=128` üst sınır + tek satır JSON prompt) — beklenen maliyet
  **$0.001'in altında**. Skip'li haliyle günlük `npx vitest run` paketi etkilenmez.

### Kabul checklist (R38)

| Kriter | Kanıt |
| --- | --- |
| ✅ (a) mevcut paket bozulmaz (faz 6 kapanışı: 307+1skip) | `npx vitest run` — faz 7 kapanışında **318+2skip / 34 dosya** (+1 skip: R36 flag'li canlı testin bu ortamdaki skip'i) |
| ✅ (b) L3 kapı genişletmesi (resolveL3 gruplama + status l3Source + evolve mesajı) | `tests/cli/cli.test.ts` — "R37: resolveL3 — en son multiEvalId batch'i, yalnız production üyeler toplam ≥ eşik → multi-eval" (en son batch seçimi + production filtresi + eşik üstü/altı), "R37: status l3Active genişler + l3Source yazılır (multi-eval ile aktif; kapalıyken none)", "R37: evolve eşik-altı mesajı iki sayıyı verir (multiEvalTotal)", "R37: multiEvalId'siz store yalnız own kaynağıyla değerlenir (geriye-uyumlu)"; batch marker: `tests/eval/evalRunner.test.ts` — "R37: runEval multiEvalId payload köküne yazılır" + geriye-uyumlu pin ("R37: multiEvalId verilmezse payload.multiEvalId tanımsız kalır (geriye-uyumlu regrezyon pini)") |
| ✅ (c) comparedTo repo-scope | `tests/eval/evalRunner.test.ts` — "R35: comparedTo yalnız AYNI reponun en son production koşumuna referans verir" + "R35: repo tanımsız koşumlar yalnız repo tanımsız production koşumlarla eşleşir" (tek-repo davranış değişmez) |
| ✅ (d) --repos boş segment fail-closed | `tests/cli/cli.test.ts` — "R35: --repos boş segment → fail-closed hata (sessiz düşürme yok)" |
| ✅ (e) canlı test skip davranışı | `tests/gateway/factory.test.ts` — "flag/anahtar yokken skipIf koşulu true → canlı describe skip eder (gate kapalı)" + "üç koşul birden sağlanınca skipIf koşulu false → gate açılır (simülasyon; canlı describe koleksiyon anında kararlı, etkilenmez)"; canlı describe kendisi: "R36: canlı cross-provider fallback (CROSS_PROVIDER_LIVE=1 + gerçek anahtarlar)" |
| ✅ (f) tsconfig strict | `npm run typecheck:tests` (`npx tsc -p tsconfig.test.json`) — build-level komut olarak kanılanır (R28e hükmü aynen) |

## Sistem durumu (faz 8 kapanışı)

Sistem tek bir kapanmış veri yolu üzerinde çalışır: L1'de `run` gerçek koşum kanıtını
(`.devloop/events.jsonl`) biriktirir; kanıt üzerinden L2'de `learn` aday dersleri üretir ve
insan onayıyla aktifleştirir; kabul edilen koşum kanıtı `golden` küratörlüğüyle değerlendirme
setini büyütür; golden veri eşiği geçince L3 `evolve` devreye girer — aday playbook shadow
eval ile ölçülür ve insan onayıyla staging'e yazılır. Yani döngü **kanıt → ders → evrim**'dir:
her aşamanın kanıtı aynı store'da toplanır, `status`/`evolve` L3 kapısını tek kaynaktan
(`resolveL3`) okur — `eval`'in kendi `l3Active` alanı per-run verisidir (kendi seti) — ve
hiçbir aşama insan kararı olmadan üretimi otomatik kabul etmez.

Operasyonel yürüyüş (her komut `src/shell/cli.ts` buildCli ile teyitli):

1. **`devloop run tasks.json`** — kanıt biriktirir: orchestrator görevleri seçer, review
   pipeline'ı koşar; `RunStarted`/`PRCreated`/`FindingEmitted`/`HumanDecision` vb. kanıtlar
   `.devloop/events.jsonl`'e yazılır, aktif dersler `lessons.md`'e render edilir.
2. **`devloop learn`** — karar kanıtından aday dersleri üretir ve listeler;
   `devloop learn confirm <lessonId>` aktifleştirir, `devloop learn reject <lessonId>` reddeder.
3. **`devloop golden draft` → `devloop golden list` → `devloop golden accept <draftId>`**
   — kabul koşum kanıtından golden taslakları üretir; yalnız `accept` golden setini büyütür
   (`draft` yalnız `.devloop/golden-drafts/` staging'ine yazar; `discard <draftId>` taslağı atar).
4. **`devloop status`** — eşik geçilince `l3Active=true` görünür; kaynak açıkça bildirilir:
   `l3Source=<own|multi-eval|none>` (`own` = kendi golden seti eşiği geçti; `multi-eval` = en son
   `eval --repos` batch'inin production golden toplamı geçti; `none` = kapı kapalı). Aynı satırda
   `goldenCount`/`goldenDrafts`/`lastEvalScore` da raporlanır.
5. **`devloop eval`** — golden seti üzerinde production pipeline skoru (JSON `EvalSummary`;
   `--candidate <policyDir>` aday policy karşılaştırması, `--full` ensemble dahil koşum).
6. **`devloop evolve --shadow`** — playbook adaylarını üretir ve aynı golden seti üzerinde
   shadow eval koşar; kapı kapalıysa eşik-altı bildirimi verir (`l3MinGoldenTasks`, `golden`,
   `multiEvalTotal`) ve shadow eval koşulmaz. `--llm` ile LLM üretimli mutasyon taslakları da
   candidate/ dizinine yazılır (anahtarsız fail-closed).
7. **`devloop evolve apply <evoId>`** — golden-gerileme kapısıyla seçilen adayı playbook
   staging dizinine (`.devloop/playbooks`) yazar ve `ProposalCreated` kanıtı kaydeder — insan
   devreye alır; policy/lint otomatik değişmez.

**Multi-repo kısaltması:** birden fazla repo'yu tek yargıcıyla ölçmek için
`devloop eval --repos ../repoA,../repoB` — çıktı `perRepo[]` + `aggregate` (`weightedScore`
ağırlıklı toplam). Hedef repolar **salt-okunur**dur: kanıt çalışma dizininin store'unda toplanır,
hedef `.devloop/`'una yazım olmaz. Girişler fail-closed'dur: var olmayan hedef yol ve hiçbir
hedefte golden task yok → hata; boş segment (`"a,,b"`, trailing-virgül) → `boş repo yolu` hatası
(Faz 7); aynı repo'nun iki kez listelenmesi (`a,a` veya `./a` vs `a` — canonical mutlak yol
üzerinden yakalanır) → `duplicate repo yolu` hatası (Faz 8). Koşum başlamadan TÜM girişler
doğrulanır; hata yolunda kanıt yazımı olmaz.

**Canlı test kısaltması:** cross-provider fallback canlı testi üç koşul birden sağlanınca koşar —
`CROSS_PROVIDER_LIVE=1` VE gerçek `OPENAI_API_KEY` VE gerçek `ANTHROPIC_API_KEY`:

```bash
CROSS_PROVIDER_LIVE=1 OPENAI_API_KEY=... ANTHROPIC_API_KEY=... \
  npx vitest run tests/gateway/factory.test.ts
```

İçerik: openai bacağı geçersiz model adlarıyla gerçek API çağrısı yapar (4xx → zincir düşer) →
anthropic bacağı gerçek anahtarla gerçek completion döndürür. Koşullardan biri eksikse test skip
eder (skipIf koleksiyon anında değerlenir — test paketi offline kalır).

**Alıntı konvansiyonu (R40.4):** aşağıdaki kanıt sütunundaki test adları runtime formuyla yazılır
(kaynak dosyada escape karakterleri farklı olabilir).

### Kabul checklist (R42)

| Kriter | Kanıt |
| --- | --- |
| ✅ (a) mevcut paket bozulmaz (faz 7 kapanışı: 318+2skip) | `npx vitest run` — faz 8 kapanışında **321+2skip / 34 dosya** (README hizası invariant'ı EXTEND'lenir, test sayısı büyümez — Faz 7 kalıbı; skip sayısı 2 kalır: R36 flag'li canlı test + Docker taban) |
| ✅ (b) duplicate repo yolu fail-closed | `tests/cli/cli.test.ts` — "R40: --repos duplicate yol → fail-closed hata (çift maliyet/kanıt yok)" (canonical mutlak yol karşılaştırması; boş segment fail-closed Faz 7'den aynen: "R35: --repos boş segment → fail-closed hata (sessiz düşürme yok)") |
| ✅ (c) resolveL3 multiEvalTotal dönüş alanları | `tests/cli/cli.test.ts` — "R40: resolveL3 multiEvalTotal döndürür — multi-eval/none path'lerinde dolu, own-path'te tanımsız"; mevcut R37 pin'leri hüküm-notlu güncellendi ("R37: resolveL3 — en son multiEvalId batch'i, yalnız production üyeler toplam ≥ eşik → multi-eval") |
| ✅ (d) evolve kapalı-yol mesajı tek hesapla tutarlı | `tests/cli/cli.test.ts` — "R40: evolve eşik-altı mesajı multiEvalTotal değeri resolveL3 ile tutarlı" (mesaj `l3.multiEvalTotal` alanını okur — iki tüketici iki farklı toplam bulamaz; kapalı yolda tek store scan; scan sayısı gözlemlenebilir değildir, çıktı doğruluğu pin'lenir) |
| ✅ (e) README sistem-durumu yürüyüşü komutları gerçek işlevlerle eşleşir | `tests/e2e/invariants.test.ts` — "README faz 6+7+8: ..." invariant'ına Faz 8 pin'leri (EXTEND; bölüm silinir veya isim değişirse test kırılır); komut adları yazım öncesi `src/shell/cli.ts` buildCli ile satır-satır teyit edildi |
| ✅ (f) iki tsc + build temiz | `npx tsc --noEmit` + `npm run typecheck:tests` (`npx tsc -p tsconfig.test.json`) + `npm run build` — faz 8 kapanışında temiz |

Detaylı tasarım: `docs/superpowers/specs/2026-11-18-ai-dev-loop-design.md`
