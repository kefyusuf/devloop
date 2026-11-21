import type { DevloopEvent } from '../../src/contracts/events.js';
import type { VerdictStore } from '../../src/store/store.js';

// hüküm: tsconfig.test kapsamı (R26h, faz 5 T7) — store.query() payload union döndürür
// (src/golden/draft.ts kontratı: 'query dönüş tipi daraltılmaz'); testlerde payload alan erişimi
// için cli.ts evalRunToSummary / draft.ts'teki Extract + type-predicate deseni parametreleştirilir.
export type Envelope<K extends DevloopEvent['type']> = Extract<DevloopEvent, { type: K }>;

export function queryTyped<K extends DevloopEvent['type']>(
  s: VerdictStore, f: { type: K; runId?: string; taskId?: string },
): Envelope<K>[] {
  return s.query(f).filter((e): e is Envelope<K> => e.type === f.type);
}
