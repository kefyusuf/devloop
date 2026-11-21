// R26d (faz 5 T5): canonical JSON — deterministik hash seed serileştirmesi. Aynı içerik farklı
// key-sırasıyla geliyorsa AYNI seed üretir (evoId/goldenId key-order duyarlılığı kapanır —
// faz 3/4 deferred minors). Kullanım: src/evolution/evolve.ts (LLM mutasyon evoId) +
// src/golden/draft.ts (goldenId). Hash ALGORİTMASI değişmez — yalnız serileştirme canonical olur.
//
// Sözleşme:
// - null / primitive → JSON.stringify(value) ile AYNI çıktı (tek-anahtar nesne çıktısı da
//   JSON.stringify ile birebir uyumlu — mevcut pinned id testleri bozulmaz).
// - dizi → elemanlar özyinelemeli, sıra KORUNUR (dizi sırası semantik olarak anlamlıdır —
//   sıralanmaz; örn. acceptanceCriteria maddelerinin sırası görevi tanımlar).
// - nesne → anahtarlar leksikografik (UTF-16 code unit) sıraya dizilir, değerler özyinelemeli.
//
// Not: JSON.stringify(undefined) runtime'da string DÖNMEZ (undefined değeri döner); hash seed
// determinizmi için undefined → 'null' sabitlenir (JSON.stringify(null) çıktısıyla aynı).
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}
