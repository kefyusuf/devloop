import { describe, it, expect } from 'vitest';
import { VerdictStore, validateChain } from '../../src/store/store.js';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const taskSpec = { id: 't1', description: 'd', acceptanceCriteria: ['ok'], filesScope: [] };

describe('VerdictStore', () => {
  it('append → readAll round-trip', async () => {
    const s = new VerdictStore(join(mkdtempSync(join(tmpdir(), 'ds-')), 'events.jsonl'));
    await s.append('RunStarted', 'r1', 't1', 'o', { configSnapshot: { model: 'm1' } });
    const picked = await s.append('TaskPicked', 'r1', 't1', 'o', { taskSpec });
    expect(picked.payload.taskSpec.id).toBe('t1');
    expect(s.readAll()).toHaveLength(2);
  });

  it('idempotencyKey: ikinci append dup oluşturmaz, mevcutu döndürür', async () => {
    const s = new VerdictStore(join(mkdtempSync(join(tmpdir(), 'ds-')), 'events.jsonl'));
    const a = await s.append('TaskPicked', 'r1', 't1', 'o', { taskSpec }, 'idem-1');
    const b = await s.append('TaskPicked', 'r1', 't1', 'o', { taskSpec }, 'idem-1');
    expect(b.event_id).toBe(a.event_id);
    expect(s.readAll()).toHaveLength(1);
  });

  it('bozuk satır: throw YOK, satır atılır (kayıpsız resume)', async () => {
    const p = join(mkdtempSync(join(tmpdir(), 'ds-')), 'events.jsonl');
    const s = new VerdictStore(p);
    await s.append('RunStarted', 'r1', 't1', 'o', { configSnapshot: {} });
    const raw = readFileSync(p, 'utf8');
    writeFileSync(p, raw + '{ BOZUK\nVE KISMİ }' + '\n');
    expect(() => s.readAll()).not.toThrow();
    expect(s.readAll()).toHaveLength(1);
  });

  it('validateChain: eksik parent yakalanır; sağlam zincir ok der', async () => {
    const s = new VerdictStore(join(mkdtempSync(join(tmpdir(), 'ds-')), 'events.jsonl'));
    const run = await s.append('RunStarted', 'r1', 't1', 'o', { configSnapshot: {} });
    const good = validateChain(s.readAll());
    expect(good.ok).toBe(true);
    const bad = validateChain([
      { ...run, event_id: 'e1', type: 'ArtifactProduced', payload: { artifact: { diff: '', intent: 'i', rejectedAlternatives: [], testEvidence: '', files: [] }, parentTaskEventId: 'yok-boyle-event' } },
    ] as never);
    expect(bad.ok).toBe(false);
    expect(bad.errors[0]).toContain('yok-boyle-event');
  });
});
