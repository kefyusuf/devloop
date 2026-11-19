import { describe, it, expect } from 'vitest';
import { buildCli } from '../../src/shell/cli.js';
import { VerdictStore } from '../../src/store/store.js';
import { generateProposals } from '../../src/learning/learn.js';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
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

  // R14 (faz 3 T8): L2 bildirimi — karar sayısı l2MinDecisions eşiğinin altındayken learn çıktısı
  // çıplak '(aday yok)' yerine açık neden verir: 'L2 devre dışı (l2MinDecisions=…, mevcut: …)'.
  it('learn: karar sayısı eşik altında → L2 devre dışı bildirimi (çıplak aday-yok yerine)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-l2-'));
    const store = new VerdictStore(join(dir, '.devloop', 'events.jsonl'));
    // 1 karar (< varsayılan l2MinDecisions=100) → aday da yok (pattern eşiği ≥2)
    await store.append('HumanDecision', 'r1', 't1', 'h', { decision: 'reject', reason: 'false-positive', parentFindingEventIds: [] });
    const out: string[] = [];
    const origLog = console.log; console.log = (m: string) => out.push(m);
    await buildCli(dir).parseAsync(['node', 'devloop', 'learn']);
    console.log = origLog;
    expect(out.join('\n')).toContain('L2 devre dışı');
    expect(out.join('\n')).toContain('l2MinDecisions=100');
    expect(out.join('\n')).toContain('mevcut: 1');
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

  // R9 (faz 3 T3): eval komutu — candidate olmadan production pipeline koşar; EvalRun
  // configSnapshot.mode='production' yazar. Brief testi birebir; tek uyarlama yukarıdaki
  // commander-12 notu ile aynı: { from: 'user' } + ['node','devloop',...] → "unknown command
  // 'node'" — dosyadaki diğer testler gibi varsayılan from:'node' kuralı kullanılır.
  it('eval komutu: candidate olmadan koşar ve EvalRun configSnapshot.mode=production yazar', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-ev-'));
    mkdirSync(join(dir, '.devloop', 'golden'), { recursive: true });
    writeFileSync(join(dir, '.devloop', 'golden', 'g1.task.json'), JSON.stringify({
      goldenId: 'g1',
      taskSpec: { id: 'gt1', description: 'd', acceptanceCriteria: ['a'], filesScope: [] },
      fixtureDiff: '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1,2 @@\n const x=1;\n+const y=2;',
      expected: { gatesPass: true, requiredFindings: [], forbiddenCategories: [] },
    }));
    await buildCli(dir).parseAsync(['node', 'devloop', 'eval']);
    const store = new VerdictStore(join(dir, '.devloop', 'events.jsonl'));
    const ev = store.query({ type: 'EvalRun' })[0];
    expect(ev.payload.configSnapshot).toMatchObject({ mode: 'production' });
  });

  // R10 (faz 3 T4): evolve --shadow — production baseline bulunamazsa hata; shadow eval
  // configSnapshot.candidate='evolve-shadow' yazar; çıktı JSON parse edilebilir.
  it('evolve --shadow: production eval yok → hata', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-evo0-'));
    await expect(buildCli(dir).parseAsync(['node', 'devloop', 'evolve', '--shadow']))
      .rejects.toThrow('Önce production eval koşun');
  });

  // I4 (final fix wave, spec R9/R10 "eşik altı bildirir"): golden set l3MinGoldenTasks eşiğinin
  // altındayken evolve --shadow shadow eval'i HİÇ koşmaz — açık 'eşik altı' bildirimi döner ve
  // store'da candidate etiketli YENİ EvalRun YAZILMAZ (ücretli LLM ensemble koşumu harcanmaz).
  it('evolve --shadow: goldenCount < l3MinGoldenTasks → eşik altı bildirimi + shadow EvalRun YAZILMAZ', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-evo5-'));
    // policy.yaml yok → l3MinGoldenTasks=50; tek golden görev → golden=1 < 50 (eşik altı)
    mkdirSync(join(dir, '.devloop', 'golden'), { recursive: true });
    writeFileSync(join(dir, '.devloop', 'golden', 'g1.task.json'), JSON.stringify({
      goldenId: 'g1',
      taskSpec: { id: 'gt1', description: 'd', acceptanceCriteria: ['a'], filesScope: [] },
      fixtureDiff: '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1,2 @@\n const x=1;\n+const y=2;',
      expected: { gatesPass: true, requiredFindings: [], forbiddenCategories: [] },
    }));
    const store = new VerdictStore(join(dir, '.devloop', 'events.jsonl'));
    // baseline ön koşulu karşılanır (production EvalRun seed) — eşik-altı yolu buradan ayrışır
    await store.append('EvalRun', 'eval-b', '-', 'eval', { evalId: 'b1', goldenCount: 1, passed: 1, failed: 0, score: 100, invalid: [], perTask: [], configSnapshot: { mode: 'production' } });
    const out: string[] = [];
    const origLog = console.log; console.log = (m: string) => out.push(m);
    try {
      await buildCli(dir).parseAsync(['node', 'devloop', 'evolve', '--shadow']);
    } finally { console.log = origLog; }
    const parsed = JSON.parse(out.join('\n'));
    expect(parsed.l3Active).toBe(false);
    expect(parsed.message).toContain('eşik altı');
    expect(parsed.message).toContain('l3MinGoldenTasks=50');
    expect(parsed.message).toContain('golden=1');
    expect(parsed.message).toContain('eval koşulmadı');
    // wasted eval yok: candidate etiketli EvalRun YAZILMADI — store'da yalnız seed edilen üretim koşumu var
    const candidateRuns = store.query({ type: 'EvalRun' })
      .filter((e): e is Extract<DevloopEvent, { type: 'EvalRun' }> => e.type === 'EvalRun' && 'candidate' in e.payload.configSnapshot);
    expect(candidateRuns).toHaveLength(0);
    expect(store.query({ type: 'EvalRun' })).toHaveLength(1);
  });

  it('evolve --shadow: çıktı JSON parse edilebilir; shadowEval candidate=evolve-shadow; baseline production evalId', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-evo1-'));
    // policy.yaml: l3MinGoldenTasks=1 (test küçültmesi) — loadConfig yalnız repoDir()'den okur
    const policyYaml = readFileSync(join(process.cwd(), 'policy.yaml'), 'utf8').replace('l3MinGoldenTasks: 50', 'l3MinGoldenTasks: 1');
    writeFileSync(join(dir, 'policy.yaml'), policyYaml, 'utf8');
    mkdirSync(join(dir, '.devloop', 'golden'), { recursive: true });
    writeFileSync(join(dir, '.devloop', 'golden', 'g1.task.json'), JSON.stringify({
      goldenId: 'g1',
      taskSpec: { id: 'gt1', description: 'd', acceptanceCriteria: ['a'], filesScope: [] },
      fixtureDiff: '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1,2 @@\n const x=1;\n+const y=2;',
      expected: { gatesPass: true, requiredFindings: [], forbiddenCategories: [] },
    }));
    await buildCli(dir).parseAsync(['node', 'devloop', 'eval']); // baseline: production EvalRun
    // L3 sinyali: 3 koşumda off-by-one false-positive ret (l3MinGoldenTasks=1 → eşik geçilir)
    const store = new VerdictStore(join(dir, '.devloop', 'events.jsonl'));
    for (const [i, run] of ['r1', 'r2', 'r3'].entries()) {
      const art = await store.append('ArtifactProduced', run, `t${i}`, 'b', { artifact: { diff: 'x', intent: 'i', rejectedAlternatives: [], testEvidence: '', files: [] }, parentTaskEventId: 'p' });
      const f = await store.append('FindingEmitted', run, `t${i}`, 'llm-reviewer', { finding: { id: `f${i}`, stage: 'llm-reviewer', category: 'off-by-one', severity: 'required', confidence: 0.9, evidence: { file: 'a.ts', line: i + 1 } }, parentArtifactEventId: art.event_id });
      await store.append('HumanDecision', run, `t${i}`, 'h', { decision: 'reject', reason: 'false-positive', parentFindingEventIds: [f.event_id] });
    }
    // Shadow pipeline ensemble içerir (run komutu assembly'si) — API anahtarı yokken reviewer
    // stage'leri fail-fast GatewayError verir (ağ yok); advisory olduğundan eval yine pass olur.
    const prevKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    const out: string[] = [];
    const origLog = console.log; console.log = (m: string) => out.push(m);
    try {
      await buildCli(dir).parseAsync(['node', 'devloop', 'evolve', '--shadow']);
    } finally {
      console.log = origLog;
      if (prevKey !== undefined) process.env.ANTHROPIC_API_KEY = prevKey;
    }
    const parsed = JSON.parse(out.join('\n'));
    expect(Array.isArray(parsed.candidates)).toBe(true);
    expect(parsed.candidates).toHaveLength(1);
    expect(parsed.candidates[0].kind).toBe('playbook-reviewer');
    expect(parsed.shadowEval.evalId).toBeDefined();
    expect(parsed.shadowEval.configSnapshot.candidate).toBe('evolve-shadow');
    expect(parsed.baseline.evalId).toBeDefined();
    // Golden gate'leri (lint/typecheck/tests) geçici dizinde gerçekten koşar — failed değeri
    // ortam girdisidir; sözleşme: baseline {evalId, failed, score} alanlarını taşır.
    expect(typeof parsed.baseline.failed).toBe('number');
    expect(typeof parsed.baseline.score).toBe('number');
    expect(parsed.shadowEval.goldenCount).toBe(1); // fixture'daki tek golden task
    // aday dosyası shadow aday dizinine yazıldı
    expect(existsSync(join(dir, '.devloop', 'candidates', `${parsed.candidates[0].evoId}.json`))).toBe(true);
  });

  // hüküm (I1 final fix wave): apply kapısı aggregate `failed >`'tan per-task pass→fail geçiş
  // kontrolüne çevrildi — gerileme red yolu artık perTask kanıtı ister; bu test aynı senaryoyu
  // (shadow failed artışı) perTask girdileriyle sürdürür.
  it('evolve apply: per-task golden gerileme (g2 pass→fail) → hata + playbook staging YAZILMAZ', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-evo2-'));
    const store = new VerdictStore(join(dir, '.devloop', 'events.jsonl'));
    const perTaskBase = [{ goldenId: 'g1', pass: true, reasons: [] }, { goldenId: 'g2', pass: true, reasons: [] }];
    await store.append('EvalRun', 'eval-b', '-', 'eval', { evalId: 'b1', goldenCount: 2, passed: 2, failed: 0, score: 100, invalid: [], perTask: perTaskBase, configSnapshot: { mode: 'production' } });
    await store.append('EvalRun', 'eval-s', '-', 'eval', { evalId: 's1', goldenCount: 2, passed: 1, failed: 1, score: 50, invalid: [], perTask: [{ goldenId: 'g1', pass: true, reasons: [] }, { goldenId: 'g2', pass: false, reasons: ['kırıldı'] }], configSnapshot: { candidate: 'evolve-shadow' } });
    mkdirSync(join(dir, '.devloop', 'candidates'), { recursive: true });
    writeFileSync(join(dir, '.devloop', 'candidates', 'evo-cli1.json'), JSON.stringify({ evoId: 'evo-cli1', kind: 'playbook-reviewer', title: 'T', content: { note: 'n' }, sourceEvalId: 'b1' }), 'utf8');
    await expect(buildCli(dir).parseAsync(['node', 'devloop', 'evolve', 'apply', 'evo-cli1']))
      .rejects.toThrow('golden gerileme (g2)');
    expect(existsSync(join(dir, '.devloop', 'playbooks', 'evo-cli1.json'))).toBe(false);
    expect(store.query({ type: 'ProposalCreated' })).toHaveLength(0);
  });

  it('evolve apply: gerileme yok → ProposalCreated + playbook staging dosyası', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-evo3-'));
    const store = new VerdictStore(join(dir, '.devloop', 'events.jsonl'));
    await store.append('EvalRun', 'eval-b', '-', 'eval', { evalId: 'b1', goldenCount: 2, passed: 2, failed: 0, score: 100, invalid: [], perTask: [], configSnapshot: { mode: 'production' } });
    await store.append('EvalRun', 'eval-s', '-', 'eval', { evalId: 's1', goldenCount: 2, passed: 2, failed: 0, score: 100, invalid: [], perTask: [], configSnapshot: { candidate: 'evolve-shadow' } });
    mkdirSync(join(dir, '.devloop', 'candidates'), { recursive: true });
    writeFileSync(join(dir, '.devloop', 'candidates', 'evo-cli2.json'), JSON.stringify({ evoId: 'evo-cli2', kind: 'playbook-reviewer', title: 'T', content: { note: 'n' }, sourceEvalId: 'b1' }), 'utf8');
    const out: string[] = [];
    const origLog = console.log; console.log = (m: string) => out.push(m);
    try {
      await buildCli(dir).parseAsync(['node', 'devloop', 'evolve', 'apply', 'evo-cli2']);
    } finally {
      console.log = origLog;
    }
    expect(out.join('\n')).toContain('evo-cli2');
    expect(store.query({ type: 'ProposalCreated' })).toHaveLength(1);
    expect(existsSync(join(dir, '.devloop', 'playbooks', 'evo-cli2.json'))).toBe(true);
  });
});
