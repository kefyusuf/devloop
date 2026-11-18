# devloop

AI agent ile yazılım geliştiren, üretimi katmanlı otomatik review'den geçiren, sonuçları kanıt zincirli event günlüğüne yazan ve insan-onaylı derslerle (L1) öğrenen CLI.

## Hızlı başlangıç

```bash
npm install && npm run build
export ANTHROPIC_API_KEY=...   # yalnız ortam değişkeni
# hedef repoda:
tasks.json hazırla: [{ id, description, acceptanceCriteria, filesScope }]
npx tsx src/index.ts run tasks.json   # → feature branch + PR/report + bulgular
devloop decide --task task-1 --reject --reason false-positive --findings f1,f2
devloop learn          # aday dersleri listeler
devloop learn confirm <lessonId>   # insan onayı → aktif ders
devloop status
```

## Güvenlik modeli
- Her koşum git worktree + feature branch'te; main'e asla yazmaz.
- Bütçe `budgetUsd` koşum (run) başınadır; resume yeni bütçe alır (per-run hüküm).
- Deterministik gate'ler (lint/tip/test/sırr) tartışmasız; LLM bulguları advisory — merge kararı her zaman insanda.
- Tüm koşumlar `<repo>/.devloop/events.jsonl` dosyasına append-only kanıt zinciriyle iner.

## Güvenlik sınırı (v1)
- **Trusted repositories only.** Worktree kaynak izolasyonudur, sandbox değildir; güvenilmeyen repo koşullandırılmaz (container izolasyonu faz 2).
- Komutlar sabit executable (eslint/tsc/vitest), shell yok, timeout'lu.
- PR yetkisi: oluştur var, merge yok. Hedef repoda branch protection + zorunlu status check kullanın.

Detaylı tasarım: `docs/superpowers/specs/2026-11-18-ai-dev-loop-design.md`
