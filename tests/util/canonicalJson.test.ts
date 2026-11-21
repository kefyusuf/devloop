import { describe, it, expect } from 'vitest';
import { canonicalJson } from '../../src/util/canonicalJson.js';

// R26d (faz 5 T5): canonical JSON — evoId/goldenId hash seed'lerinin key-order duyarlılığı kapanır.
// Sözleşme: null/primitive → JSON.stringify; dizi → eleman sırası KORUNUR (dizi sırası semantik
// olarak anlamlıdır — sıralanmaz); nesne → anahtarlar sıralanır, değerler özyinelemeli serialize.
describe('canonicalJson (R26d)', () => {
  it('üst düzey key-order invariance: {b:2,a:1} === {a:1,b:2}', () => {
    expect(canonicalJson({ b: 2, a: 1 })).toBe(canonicalJson({ a: 1, b: 2 }));
  });

  it('iç içe nesnelerde key-order invariance (özyinelemeli sorted keys)', () => {
    const a = { outer: { z: { deep: 1 }, a: [1, { m: '1', k: 2 }] }, other: null };
    const b = { other: null, outer: { a: [1, { k: 2, m: '1' }], z: { deep: 1 } } };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
  });

  it('dizi sırası KORUNUR — sıralanmaz (dizi sırası semantik olarak anlamlı)', () => {
    expect(canonicalJson([3, 1, 2])).toBe(canonicalJson([3, 1, 2]));
    expect(canonicalJson([3, 1, 2])).not.toBe(canonicalJson([1, 2, 3]));
  });

  it('dizi elemanları özyinelemeli canonical: eleman nesnelerinin key sırası farkı görünmez, konum farkı görünür', () => {
    expect(canonicalJson([{ b: 1, a: 2 }, { y: 9, x: 8 }])).toBe(canonicalJson([{ a: 2, b: 1 }, { x: 8, y: 9 }]));
    expect(canonicalJson([{ a: 2 }, { b: 1 }])).not.toBe(canonicalJson([{ b: 1 }, { a: 2 }]));
  });

  it('null / primitive passthrough — JSON.stringify ile aynı çıktı', () => {
    expect(canonicalJson(null)).toBe('null');
    expect(canonicalJson(42)).toBe('42');
    expect(canonicalJson('metin')).toBe('"metin"');
    expect(canonicalJson(true)).toBe('true');
    expect(canonicalJson(false)).toBe('false');
  });

  // JSON.stringify(undefined) runtime'da string dönmez ('undefined' değil undefined değeri);
  // hash seed determinizmi için canonicalJson(undefined) 'null' döner (JSON.stringify(null) ile aynı).
  it('undefined → "null" (seed determinizmi — string olmayan stringify çıktısı sabitlenir)', () => {
    expect(canonicalJson(undefined)).toBe('null');
  });

  // Çıkış formatı JSON.stringify ile uyumlu: tek-anahtar nesne birebir aynı seed'i üretir —
  // mevcut pinned evoId/goldenId testleri (JSON.stringify tabanlı hesap) bozulmaz.
  it('tek-anahtar nesne JSON.stringify ile birebir aynı çıktı (pinned id testleriyle format uyumu)', () => {
    expect(canonicalJson({ category: 'perf' })).toBe(JSON.stringify({ category: 'perf' }));
  });
});
