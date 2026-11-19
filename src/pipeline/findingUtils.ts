import type { Finding } from '../contracts/schemas.js';
import { SEVERITY_ORDER } from '../contracts/schemas.js';

/**
 * I2 (final fix wave, Minor #4): dedupe anahtarı ve şiddet sıralaması llmEnsemble ile pipeline'da
 * İKİ KERE kopyalanmıştı — sürüklenme (drift) riski. Tek kaynak: bu modül. Ensemble dedupe'ü ve
 * pipeline dedupe'ü AYNI anahtar (file:line:category) ve AYNI şiddet kuralını (SEVERITY_ORDER
 * indeksi; küçük = daha şiddetli, §5.2.4) paylaşır.
 */

/** Dedupe anahtarı: aynı file+line+category tek bulgu kabul edilir (farklı kategori çelişki sayılır). */
export const findingKey = (f: Finding): string => `${f.evidence.file}:${f.evidence.line ?? '-'}:${f.category}`;

/** Şiddet sırası indeksi — SEVERITY_ORDER'daki konum; küçük değer daha şiddetli. */
export const severityRank = (f: Finding): number => SEVERITY_ORDER.indexOf(f.severity);
