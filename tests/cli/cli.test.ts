import { describe, it, expect } from 'vitest';
import { buildCli } from '../../src/shell/cli.js';
import { VerdictStore } from '../../src/store/store.js';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('CLI', () => {
  it('decide → HumanDecision (parent bulgu ile)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-'));
    const store = new VerdictStore(join(dir, '.devloop', 'events.jsonl'));
    await store.append('RunStarted', 'r1', 't1', 'o', { configSnapshot: {} });
    await store.append('FindingEmitted', 'r1', 't1', 'llm-reviewer', { finding: { id: 'f1', stage: 'llm-reviewer', category: 'security', severity: 'required', confidence: 0.9, evidence: { file: 'a.ts' } }, parentArtifactEventId: 'x' });
    // Düzeltme (plan hatası): commander 12'de { from: 'user' } TÜM argv'yı kullanıcı argümanı sayar;
    // ['node', 'devloop', ...] + from:'user' → "unknown command 'node'" (kanıt: task-13-report.md).
    // from:'node' (varsayılan) argv[0..1]'i kırpar — üretimdeki parseAsync(process.argv) ile aynı kural.
    await buildCli(dir).parseAsync(['node', 'devloop', 'decide', '--task', 't1', '--reject', '--reason', 'false-positive', '--findings', 'f1', '--note', 'yanlış alarm']);
    const d = store.query({ type: 'HumanDecision' });
    expect(d[0].payload).toMatchObject({ decision: 'reject', reason: 'false-positive' });
  });
  it('status: validateChain sonucunu içerir', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli2-'));
    const out: string[] = [];
    const origLog = console.log; console.log = (m: string) => out.push(m);
    await buildCli(dir).parseAsync(['node', 'devloop', 'status']); // from:'user' yerine varsayılan node kuralı (bkz. yukarıdaki not)
    console.log = origLog;
    expect(out.join('\n')).toContain('chain=ok');
  });
});
