import { describe, it, expect } from 'vitest';
import { buildCli } from '../../src/shell/cli.js';
import { VerdictStore } from '../../src/store/store.js';
import { generateProposals } from '../../src/learning/learn.js';
import { loadGoldenTasks } from '../../src/eval/golden.js';
// hüküm: tsconfig.test kapsamı (R26h) — Extract daraltması için DevloopEvent tip importu
import type { DevloopEvent } from '../../src/contracts/events.js';
// hüküm: tsconfig.test kapsamı (R26h) — payload union daraltma yardımcıları
import { queryTyped } from '../helpers/events.js';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, cpSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('CLI', () => {
  // hüküm (faz 5 T1, R25): decide artık gerçek run bağlantısı kurar — auto-resolve (son eşleşen
  // TaskPicked'in run_id'si) çözülemezse fail-closed hata (sessiz 'manual' yazımı YOK). Bu testin
  // seed'inde TaskPicked YOKTUR (kontratı HumanDecision payload alanlarıdır, run çözümü değil);
  // explicit '--run r1' ile karar kanıtı aynen yazılır — payload sözleşmesi değişmedi.
  it('decide → HumanDecision (parent bulgu ile)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-'));
    const store = new VerdictStore(join(dir, '.devloop', 'events.jsonl'));
    await store.append('RunStarted', 'r1', 't1', 'o', { configSnapshot: {} });
    // hüküm: tsconfig.test kapsamı — corroborated Finding şemasında zorunlu alan
    await store.append('FindingEmitted', 'r1', 't1', 'llm-reviewer', { finding: { id: 'f1', stage: 'llm-reviewer', category: 'security', severity: 'required', confidence: 0.9, corroborated: false, evidence: { file: 'a.ts' } }, parentArtifactEventId: 'x' });
    // Düzeltme (plan hatası): commander 12'de { from: 'user' } TÜM argv'yı kullanıcı argümanı sayar;
    // ['node', 'devloop', ...] + from:'user' → "unknown command 'node'" (kanıt: task-13-report.md).
    // from:'node' (varsayılan) argv[0..1]'i kırpar — üretimdeki parseAsync(process.argv) ile aynı kural.
    await buildCli(dir).parseAsync(['node', 'devloop', 'decide', '--task', 't1', '--run', 'r1', '--reject', '--reason', 'false-positive', '--findings', 'f1', '--note', 'yanlış alarm']);
    const d = store.query({ type: 'HumanDecision' });
    expect(d[0].payload).toMatchObject({ decision: 'reject', reason: 'false-positive' });
    expect(d[0].run_id).toBe('r1'); // --run override: aynen kullanılır (auto-resolve atlanır)
  });

  // R25 (faz 5 T1): decide → GERÇEK run bağlantısı. Auto-resolve: --run yoksa store'daki SON
  // eşleşen TaskPicked'in run_id'si; fail-closed: çözülemezse hata ('manual' sessiz yazımı YOK);
  // '--run manual' tek explicit 'manual' yolu. L3 veri yolu (golden draft) böylece gerçek decide
  // kararlarıyla kapanır — E2E kanıtı: tests/e2e/decisionPath.test.ts.
  it('decide: runId otomatik çözülür (son TaskPicked)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-r25-'));
    const store = new VerdictStore(join(dir, '.devloop', 'events.jsonl'));
    const taskSpec = { id: 't1', description: 'sum ekle', acceptanceCriteria: ['sum(2,3)===5'], filesScope: [] };
    await store.append('RunStarted', 'r1', '-', 'o', { configSnapshot: {} });
    await store.append('TaskPicked', 'r1', 't1', 'orchestrator', { taskSpec });
    await buildCli(dir).parseAsync(['node', 'devloop', 'decide', '--task', 't1', '--accept', '--reason', 'real-issue-accepted']);
    const d = store.query({ type: 'HumanDecision' });
    expect(d[0].run_id).toBe('r1');
    // son TaskPicked: aynı taskSpec id'li YENİ bir koşum (r2) sonradan yazıldı → auto-resolve EN
    // YENİ eşleşmeyi seçer (iki koşum r1 ve r2 — '.pop()' dosya sırasındaki son kayıt)
    await store.append('RunStarted', 'r2', '-', 'o', { configSnapshot: {} });
    await store.append('TaskPicked', 'r2', 't1', 'orchestrator', { taskSpec });
    await buildCli(dir).parseAsync(['node', 'devloop', 'decide', '--task', 't1', '--accept', '--reason', 'real-issue-accepted']);
    const d2 = store.query({ type: 'HumanDecision' });
    expect(d2).toHaveLength(2);
    expect(d2[1].run_id).toBe('r2');
    expect(d2[1].payload).toMatchObject({ decision: 'accept', reason: 'real-issue-accepted' });
  });
  it('decide: --run override', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-r25o-'));
    const store = new VerdictStore(join(dir, '.devloop', 'events.jsonl'));
    await store.append('RunStarted', 'r1', '-', 'o', { configSnapshot: {} });
    await store.append('TaskPicked', 'r1', 't1', 'orchestrator', { taskSpec: { id: 't1', description: 'd', acceptanceCriteria: ['a'], filesScope: [] } });
    // eşleşen TaskPicked VAR (auto-resolve 'r1' verirdi) — --run r9 AYNEN kullanılır
    await buildCli(dir).parseAsync(['node', 'devloop', 'decide', '--task', 't1', '--run', 'r9', '--reject', '--reason', 'fixed-later']);
    const d = store.query({ type: 'HumanDecision' });
    expect(d[0].run_id).toBe('r9');
    expect(d[0].task_id).toBe('t1');
  });
  it('decide: eşleşen TaskPicked yok + --run yok → fail-closed hata', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-r25f-'));
    const store = new VerdictStore(join(dir, '.devloop', 'events.jsonl')); // boş store
    await expect(buildCli(dir).parseAsync(['node', 'devloop', 'decide', '--task', 't1', '--accept', '--reason', 'real-issue-accepted']))
      .rejects.toThrow('koşum bulunamadı');
    // fail-closed: sessiz 'manual' yazımı YOK — store'a HumanDecision YAZILMAZ
    expect(store.query({ type: 'HumanDecision' })).toHaveLength(0);
  });
  it('decide: --run manual → run_id manual (explicit)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-r25m-'));
    const store = new VerdictStore(join(dir, '.devloop', 'events.jsonl'));
    await buildCli(dir).parseAsync(['node', 'devloop', 'decide', '--task', 't1', '--run', 'manual', '--reject', '--reason', 'stale-lesson']);
    const d = store.query({ type: 'HumanDecision' });
    expect(d[0].run_id).toBe('manual');
    expect(d[0].payload).toMatchObject({ decision: 'reject', reason: 'stale-lesson' });
  });
  it('status: validateChain sonucunu içerir', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli2-'));
    const out: string[] = [];
    const origLog = console.log; console.log = (m: string) => out.push(m);
    await buildCli(dir).parseAsync(['node', 'devloop', 'status']); // from:'user' yerine varsayılan node kuralı (bkz. yukarıdaki not)
    console.log = origLog;
    expect(out.join('\n')).toContain('chain=ok');
  });

  // R27 (faz 5 T7): status aktivasyon alanları — goldenCount (golden/ kabul edilmiş görev sayısı,
  // loadGoldenTasks ile aynı kaynak), goldenDrafts (golden-drafts/ staging taslak sayısı),
  // l3Active (goldenCount >= l3MinGoldenTasks — evalRunner summary + evolve kapısıyla AYNI tanım),
  // lastEvalScore (son PRODUCTION EvalRun score — shadow eval sayılmaz). Konsol kuralı: alanlar
  // DAİMA yazılır; eval koşumu hiç yoksa lastEvalScore literal 'null' ile görünür (alan yok-bırakma
  // yok — tüketiciler tek biçim okur). Mevcut alanlar (runs/prs/blocked/decisions/lessons/chain)
  // aynen korunur — additive only.
  it('status: goldenCount/goldenDrafts/l3Active/lastEvalScore alanları (gerçekçi store)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-r27-'));
    // gerçekçi fixture: golden/ içinde 1 kabul edilmiş görev, golden-drafts/ içinde 2 bekleyen taslak
    const GOLDEN = {
      goldenId: 'g1',
      taskSpec: { id: 'gt1', description: 'd', acceptanceCriteria: ['a'], filesScope: [] },
      fixtureDiff: '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1,2 @@\n const x=1;\n+const y=2;',
      expected: { gatesPass: true, requiredFindings: [{ category: 'lint' }], forbiddenCategories: ['secret'] },
    };
    mkdirSync(join(dir, '.devloop', 'golden'), { recursive: true });
    writeFileSync(join(dir, '.devloop', 'golden', 'g1.task.json'), JSON.stringify(GOLDEN));
    mkdirSync(join(dir, '.devloop', 'golden-drafts'), { recursive: true });
    writeFileSync(join(dir, '.devloop', 'golden-drafts', 'd1.task.json'), JSON.stringify({ ...GOLDEN, goldenId: 'd1' }));
    writeFileSync(join(dir, '.devloop', 'golden-drafts', 'd2.task.json'), JSON.stringify({ ...GOLDEN, goldenId: 'd2' }));
    const store = new VerdictStore(join(dir, '.devloop', 'events.jsonl'));
    // son production eval score=100; arkasından shadow eval score=50 — lastEvalScore shadow'u SAYMAZ
    await store.append('EvalRun', 'eval-b', '-', 'eval', { evalId: 'b1', goldenCount: 1, passed: 1, failed: 0, score: 100, invalid: [], perTask: [], configSnapshot: { mode: 'production' } });
    await store.append('EvalRun', 'eval-s', '-', 'eval', { evalId: 's1', goldenCount: 1, passed: 0, failed: 1, score: 50, invalid: [], perTask: [], configSnapshot: { candidate: 'evolve-shadow' } });
    const out: string[] = [];
    const origLog = console.log; console.log = (m: string) => out.push(m);
    await buildCli(dir).parseAsync(['node', 'devloop', 'status']);
    console.log = origLog;
    const line = out.join('\n');
    expect(line).toContain('goldenCount=1');
    expect(line).toContain('goldenDrafts=2');
    expect(line).toContain('l3Active=false'); // 1 < varsayılan l3MinGoldenTasks=50
    expect(line).toContain('lastEvalScore=100'); // shadow (50) değil — son production run
    expect(line).toContain('chain=ok'); // mevcut alanlar aynen (additive only)
  });
  it('status: 50 golden → l3Active=true, eval yokken lastEvalScore=null', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-r27n-'));
    const GOLDEN = {
      goldenId: 'g',
      taskSpec: { id: 'gt', description: 'd', acceptanceCriteria: ['a'], filesScope: [] },
      fixtureDiff: '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1,2 @@\n const x=1;\n+const y=2;',
      expected: { gatesPass: true, requiredFindings: [], forbiddenCategories: [] },
    };
    mkdirSync(join(dir, '.devloop', 'golden'), { recursive: true });
    for (let i = 0; i < 50; i++) { // gerçek eşik: varsayılan l3MinGoldenTasks=50 (policy.yaml yok)
      writeFileSync(join(dir, '.devloop', 'golden', `g${i}.task.json`), JSON.stringify({ ...GOLDEN, goldenId: `g${i}` }));
    }
    const out: string[] = [];
    const origLog = console.log; console.log = (m: string) => out.push(m);
    await buildCli(dir).parseAsync(['node', 'devloop', 'status']);
    console.log = origLog;
    const line = out.join('\n');
    expect(line).toContain('goldenCount=50');
    expect(line).toContain('l3Active=true'); // 50 >= 50 → L3 aktivasyon görünür
    expect(line).toContain('goldenDrafts=0');
    expect(line).toContain('lastEvalScore=null'); // kural: eval koşumu yoksa literal 'null'
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
      // hüküm: tsconfig.test kapsamı — corroborated Finding şemasında zorunlu alan
      const f = await store.append('FindingEmitted', run, `t${i}`, 'llm-ensemble', { finding: { id: `f${i}`, stage: 'llm-ensemble', category: 'off-by-one', severity: 'required', confidence: 0.9, corroborated: false, evidence: { file: 'a.ts', line: i + 1 } }, parentArtifactEventId: art.event_id });
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
    // hüküm: tsconfig.test kapsamı — query payload union döndürür; queryTyped ile daraltılır
    const created = queryTyped(store, { type: 'ProposalCreated' });
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
    // hüküm: tsconfig.test kapsamı — query payload union döndürür; queryTyped ile daraltılır
    const ev = queryTyped(store, { type: 'EvalRun' })[0];
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
      // hüküm: tsconfig.test kapsamı — corroborated Finding şemasında zorunlu alan
      const f = await store.append('FindingEmitted', run, `t${i}`, 'llm-reviewer', { finding: { id: `f${i}`, stage: 'llm-reviewer', category: 'off-by-one', severity: 'required', confidence: 0.9, corroborated: false, evidence: { file: 'a.ts', line: i + 1 } }, parentArtifactEventId: art.event_id });
      await store.append('HumanDecision', run, `t${i}`, 'h', { decision: 'reject', reason: 'false-positive', parentFindingEventIds: [f.event_id] });
    }
    // Shadow pipeline ensemble içerir (run komutu assembly'si) — reviewer stage'leri fail-fast
    // GatewayError verir; advisory olduğundan eval yine pass olur.
    // R26b hüküm: createGatewayOrChain 0-ayakta KURULUM anında GatewayError fırlatır (fail-closed)
    // — eski 'anahtar sil → boş zincir complete'te düşer' donanımı artık shadow kurulumunu
    // başlatamazdı. Senaryo KORUNUR: sahte anahtar → 1 ayak kurulur; fetch stub HTTP 401 →
    // reviewer yine fail-fast GatewayError (gerçek ağ/backoff YOK — HTTP hatası retry'sız
    // bir sonraki modele geçer ve bekleme yapmaz). Assertion hedefleri AYNEN.
    const prevKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'k-dummy';
    const prevFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response('unauthorized', { status: 401 });
    const out: string[] = [];
    const origLog = console.log; console.log = (m: string) => out.push(m);
    try {
      await buildCli(dir).parseAsync(['node', 'devloop', 'evolve', '--shadow']);
    } finally {
      console.log = origLog;
      globalThis.fetch = prevFetch;
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

  // R17 (faz 4 T1): golden küratörlük CLI — draft → list → accept → discard akışı.
  // A5 değişmezi: üretim yalnız .devloop/golden-drafts/ staging'ine yazar; golden/ dizinine
  // yalnız accept (rename) dokunur.
  it('golden draft/list/accept/discard: kabul koşumdan taslak üretir, staging→golden taşınır', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-golden-'));
    const store = new VerdictStore(join(dir, '.devloop', 'events.jsonl'));
    await store.append('RunStarted', 'r1', '-', 'o', { configSnapshot: {} });
    const picked = await store.append('TaskPicked', 'r1', 't1', 'o', { taskSpec: { id: 't1', description: 'toplama ekle', acceptanceCriteria: ['sum(2,3)===5'], filesScope: [] } });
    const art = await store.append('ArtifactProduced', 'r1', 't1', 'b', { artifact: { diff: '--- a/src/math.ts\n+++ b/src/math.ts\n@@ -1 +1,2 @@\n const x=1;\n+export const sum=(a:number,b:number)=>a+b;', intent: 'sum eklendi', rejectedAlternatives: [], testEvidence: 'vitest 3 passed', files: [] }, parentTaskEventId: picked.event_id });
    await store.append('PRCreated', 'r1', 't1', 'o', { url: 'https://pr/x', title: 't1', commitSha: null, diffDigest: 'd' });
    const f = await store.append('FindingEmitted', 'r1', 't1', 'llm-ensemble', { finding: { id: 'f1', stage: 'llm-ensemble', category: 'lint', severity: 'required', confidence: 0.9, evidence: { file: 'src/math.ts', line: 2 }, corroborated: false }, parentArtifactEventId: art.event_id });
    await store.append('HumanDecision', 'r1', 't1', 'h', { decision: 'accept', reason: 'real-issue-accepted', parentFindingEventIds: [f.event_id] });

    const out: string[] = [];
    const origLog = console.log; console.log = (m: string) => out.push(m);
    try {
      // draft: taslak staging'e yazılır, golden/ YOK
      await buildCli(dir).parseAsync(['node', 'devloop', 'golden', 'draft']);
      const r = JSON.parse(out.join('\n'));
      expect(r.drafts).toHaveLength(1);
      expect(r.written).toBe(1);
      const id = r.drafts[0].goldenId;
      expect(existsSync(join(dir, '.devloop', 'golden-drafts', `${id}.task.json`))).toBe(true);
      expect(existsSync(join(dir, '.devloop', 'golden'))).toBe(false);
      // list: taslak listelenir
      out.length = 0;
      await buildCli(dir).parseAsync(['node', 'devloop', 'golden', 'list']);
      expect(out.join('\n')).toContain(`${id}.task.json`);
      // accept: staging → golden/ rename; loadGoldenTasks görür
      out.length = 0;
      await buildCli(dir).parseAsync(['node', 'devloop', 'golden', 'accept', id]);
      expect(existsSync(join(dir, '.devloop', 'golden', `${id}.task.json`))).toBe(true);
      expect(existsSync(join(dir, '.devloop', 'golden-drafts', `${id}.task.json`))).toBe(false);
      expect(loadGoldenTasks(dir).tasks).toHaveLength(1);
      // discard: yeniden üretilen taslak atılır; kabul edilen golden'a dokunulmaz
      out.length = 0;
      await buildCli(dir).parseAsync(['node', 'devloop', 'golden', 'draft']);
      expect(JSON.parse(out.join('\n')).written).toBe(1); // staging boşaldı → yeniden yazıldı
      out.length = 0;
      await buildCli(dir).parseAsync(['node', 'devloop', 'golden', 'discard', id]);
      expect(existsSync(join(dir, '.devloop', 'golden-drafts', `${id}.task.json`))).toBe(false);
      expect(existsSync(join(dir, '.devloop', 'golden', `${id}.task.json`))).toBe(true);
    } finally { console.log = origLog; }
  });

  // R30 (faz 6 T2): multi-repo eval — golden set agregasyonu (Yaklaşım 1). İki fixture repo
  // (A: 2 golden, B: 1 golden) ORCHESTRATOR cwd'sinden koşulur; hedef store'lar SALT-OKUNUR
  // (kanıt orchestrator store'una yazılır — EvalRun payload.repo kök alanı). Fixture kalıbı
  // tests/e2e/goldenDraft.test.ts ile aynı: ts-repo fixture + smoke vitest testi (tests gate
  // gerçekten koşar) + temiz golden görevleri (gatesPass true, bulgusuz) → per-repo score 100.
  it('R30: eval --repos iki repo golden setini agregasyonla koşar; hedef store\'lar salt-okunur', async () => {
    const fixture = join(process.cwd(), 'tests', 'fixtures', 'ts-repo');
    const GOLDEN = {
      goldenId: 'g0',
      taskSpec: { id: 'gt0', description: 'd', acceptanceCriteria: ['a'], filesScope: [] },
      fixtureDiff: '--- a/src/math.ts\n+++ b/src/math.ts\n@@ -1 +1,2 @@\n const x=1;\n+export const sum=(a:number,b:number)=>a+b;',
      expected: { gatesPass: true, requiredFindings: [], forbiddenCategories: [] },
    };
    const makeFixtureRepo = (prefix: string, taskCount: number): string => {
      const repo = mkdtempSync(join(tmpdir(), prefix));
      cpSync(fixture, repo, { recursive: true });
      mkdirSync(join(repo, 'tests'), { recursive: true });
      writeFileSync(join(repo, 'tests', 'smoke.test.ts'), "import { test, expect } from 'vitest';\ntest('smoke', () => { expect(1 + 1).toBe(2); });\n", 'utf8');
      mkdirSync(join(repo, '.devloop', 'golden'), { recursive: true });
      for (let i = 0; i < taskCount; i++) {
        writeFileSync(join(repo, '.devloop', 'golden', `g${i}.task.json`), JSON.stringify({ ...GOLDEN, goldenId: `g${i}`, taskSpec: { ...GOLDEN.taskSpec, id: `gt${i}` } }));
      }
      return repo;
    };
    const repoA = makeFixtureRepo('cli-r30a-', 2);
    const repoB = makeFixtureRepo('cli-r30b-', 1);
    const orch = mkdtempSync(join(tmpdir(), 'cli-r30o-')); // orchestrator cwd — kendi golden'ı YOK
    const out: string[] = [];
    const origLog = console.log; console.log = (m: string) => out.push(m);
    try {
      await buildCli(orch).parseAsync(['node', 'devloop', 'eval', '--repos', `${repoA},${repoB}`]);
    } finally {
      console.log = origLog;
    }
    const parsed = JSON.parse(out.join('\n')) as {
      perRepo: Array<{ repo: string; evalId: string; goldenCount: number; passed: number; failed: number; score: number; invalid: string[]; perTask: Array<{ goldenId: string; pass: boolean; reasons: string[] }>; configSnapshot: Record<string, unknown>; l3Active: boolean }>;
      aggregate: { totalTasks: number; totalPassed: number; totalFailed: number; weightedScore: number; mergedInvalid: string[] };
    };
    expect(parsed.perRepo).toHaveLength(2);
    expect(parsed.perRepo[0].repo).toBe(repoA);
    expect(parsed.perRepo[1].repo).toBe(repoB);
    expect(parsed.perRepo[0].goldenCount).toBe(2);
    expect(parsed.perRepo[1].goldenCount).toBe(1);
    expect(parsed.perRepo[0].passed).toBe(2);
    expect(parsed.perRepo[1].passed).toBe(1);
    expect(parsed.perRepo[0].score).toBe(100);
    expect(parsed.perRepo[1].score).toBe(100);
    expect(parsed.perRepo[0].l3Active).toBe(false); // 2 < varsayılan l3MinGoldenTasks=50 — PER-REPO kapı
    // aggregate aritmetiği + şekli: l3Active aggregate'te YOK (L3 kapı hükmü — birleşik set
    // eşik kapıyı açmaz; toEqual birebir şekil eşleşmesi fazladan alanı da reddeder)
    expect(parsed.aggregate).toEqual({ totalTasks: 3, totalPassed: 3, totalFailed: 0, weightedScore: 100, mergedInvalid: [] });
    expect('l3Active' in parsed.aggregate).toBe(false);
    // kanıt orchestrator store'unda — 2 EvalRun, payload.repo kök alanı A/B sırasıyla
    const orchStore = new VerdictStore(join(orch, '.devloop', 'events.jsonl'));
    // hüküm: tsconfig.test kapsamı — query payload union döndürür; queryTyped ile daraltılır
    const runs = queryTyped(orchStore, { type: 'EvalRun' });
    expect(runs).toHaveLength(2);
    expect(runs[0].payload.repo).toBe(repoA);
    expect(runs[1].payload.repo).toBe(repoB);
    // hedef repo store'ları salt-okunur: eval hedef .devloop/events.jsonl'e YAZMAZ
    expect(existsSync(join(repoA, '.devloop', 'events.jsonl'))).toBe(false);
    expect(existsSync(join(repoB, '.devloop', 'events.jsonl'))).toBe(false);
  }, 120_000); // gerçek subprocess koşumları (3 görev × eslint/tsc/vitest) — genel testTimeout 15s yeterli değil

  // R30 fail-closed girişler — kısmi koşum YOK: preflight TÜM yolları ve golden sayılarını
  // doğrular, tek hatalı giriş bile hiçbir repoda koşum başlatmaz (kanıt yazılmaz).
  it('R30: --repos var olmayan yol → fail-closed hata', async () => {
    const orch = mkdtempSync(join(tmpdir(), 'cli-r30x-'));
    const missing = join(orch, 'olmayan-repo');
    await expect(buildCli(orch).parseAsync(['node', 'devloop', 'eval', '--repos', missing]))
      .rejects.toThrow('yolu yok');
    // fail-closed: hata yolunda kanıt YAZILMAZ
    expect(existsSync(join(orch, '.devloop', 'events.jsonl'))).toBe(false);
  });
  it('R30: golden\'ı hiçbir hedef repoda yok → fail-closed hata (boş koşum yok)', async () => {
    const orch = mkdtempSync(join(tmpdir(), 'cli-r30e-'));
    const a = mkdtempSync(join(tmpdir(), 'cli-r30e1-'));
    const b = mkdtempSync(join(tmpdir(), 'cli-r30e2-'));
    mkdirSync(join(a, '.devloop', 'golden'), { recursive: true }); // boş golden dizinleri
    mkdirSync(join(b, '.devloop', 'golden'), { recursive: true });
    await expect(buildCli(orch).parseAsync(['node', 'devloop', 'eval', '--repos', `${a},${b}`]))
      .rejects.toThrow('hiçbir hedef repoda golden task yok');
    expect(existsSync(join(orch, '.devloop', 'events.jsonl'))).toBe(false);
  });

  // R35 (faz 7 T1): --repos boş segment fail-closed — "a,,b" girişte boş segment sessizce
  // düşürülMEZ (filtre yok); fail-closed hata ('boş repo yolu'). Trailing-virgül gibi masum
  // desenler de artık açıkça hata verir. Geçerli segmentler gerçek dizin — hata split/trim
  // doğrulamasında, resolve/existsSync/golden yüklemesinden ÖNCE düşer (kısmi koşum yok).
  it('R35: --repos boş segment → fail-closed hata (sessiz düşürme yok)', async () => {
    const orch = mkdtempSync(join(tmpdir(), 'cli-r35-'));
    const a = mkdtempSync(join(tmpdir(), 'cli-r35a-'));
    const b = mkdtempSync(join(tmpdir(), 'cli-r35b-'));
    await expect(buildCli(orch).parseAsync(['node', 'devloop', 'eval', '--repos', `${a},,${b}`]))
      .rejects.toThrow('boş repo yolu');
    // fail-closed: hata yolunda kanıt YAZILMAZ
    expect(existsSync(join(orch, '.devloop', 'events.jsonl'))).toBe(false);
  });
});
