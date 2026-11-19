import { describe, it, expect } from 'vitest';
import { buildCli } from '../../src/shell/cli.js';
import { VerdictStore } from '../../src/store/store.js';
import { generateProposals } from '../../src/learning/learn.js';
import { mkdtempSync, existsSync } from 'node:fs';
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

  // R5 (faz 2 T7): learn proposals/apply — policy l2MinDecisions eşiği (policy.yaml yok → varsayılan 100).
  it('learn proposals listeler + learn apply ProposalCreated yazar ve PROPOSAL.md stage eder', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli3-'));
    const store = new VerdictStore(join(dir, '.devloop', 'events.jsonl'));
    for (const [i, run] of ['r1', 'r2', 'r3'].entries()) {
      const art = await store.append('ArtifactProduced', run, `t${i}`, 'b', { artifact: { diff: 'x', intent: 'i', rejectedAlternatives: [], testEvidence: '', files: [] }, parentTaskEventId: 'p' });
      const f = await store.append('FindingEmitted', run, `t${i}`, 'llm-ensemble', { finding: { id: `f${i}`, stage: 'llm-ensemble', category: 'off-by-one', severity: 'required', confidence: 0.9, evidence: { file: 'a.ts', line: i + 1 } }, parentArtifactEventId: art.event_id });
      await store.append('HumanDecision', run, `t${i}`, 'h', { decision: 'reject', reason: 'false-positive', parentFindingEventIds: [f.event_id] });
    }
    for (let i = 3; i < 100; i++) { // global eşik: policy.yaml yok → l2MinDecisions=100
      await store.append('HumanDecision', `r${(i % 3) + 1}`, `ta${i}`, 'h', { decision: 'accept', reason: 'real-issue-accepted', parentFindingEventIds: [] });
    }
    const [p] = generateProposals(store, 100);
    expect(p).toBeDefined();
    const out: string[] = [];
    const origLog = console.log; console.log = (m: string) => out.push(m);
    await buildCli(dir).parseAsync(['node', 'devloop', 'learn', 'proposals']);
    console.log = origLog;
    expect(out.join('\n')).toContain(p!.proposalId);
    expect(out.join('\n')).toContain('off-by-one');
    await buildCli(dir).parseAsync(['node', 'devloop', 'learn', 'apply', p!.proposalId]);
    const created = store.query({ type: 'ProposalCreated' });
    expect(created).toHaveLength(1);
    expect(created[0].payload.proposalId).toBe(p!.proposalId);
    expect(existsSync(join(dir, '.devloop', 'proposals', p!.proposalId, 'PROPOSAL.md'))).toBe(true);
    // applied → yeniden listelenmez; bilinmeyen ID hata verir
    await expect(buildCli(dir).parseAsync(['node', 'devloop', 'learn', 'apply', p!.proposalId]))
      .rejects.toThrow('Öneri bulunamadı veya eşik altında');
  });
});
