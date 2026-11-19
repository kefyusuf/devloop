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

- **Trusted repositories only.** Worktree kaynak izolasyonudur, sandbox değildir; güvenilmeyen repo koşullandırılmaz (container izolasyonu faz 2).
- Komutlar sabit executable (eslint/tsc/vitest), shell yok, timeout'lu.
- PR yetkisi: oluştur var, merge yok. Hedef repoda branch protection + zorunlu status check kullanın.

Detaylı tasarım: `docs/superpowers/specs/2026-11-18-ai-dev-loop-design.md`
