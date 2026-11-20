import { describe, it, expect } from 'vitest';
import { buildCli } from '../../src/shell/cli.js';
import { VerdictStore, validateChain } from '../../src/store/store.js';
import { loadGoldenTasks } from '../../src/eval/golden.js';
import { cpSync, mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { DevloopEvent } from '../../src/contracts/events.js';
type EvalRunEvent = Extract<DevloopEvent, { type: 'EvalRun' }>;
type StageVerdictEvent = Extract<DevloopEvent, { type: 'StageVerdict' }>;

// R23 (faz 4 T7): golden veri yolu uçtan uca — kabul koşum kanıtından taslak (staging), insan
// onaylı accept (staging → golden/ rename), production eval (gates-only pipeline gerçekten pass)
// ve duplicate/discard red kapıları. Fixture: ts-repo (gerçek eslint/tsc geçen repo) + gerçek
// vitest smoke testi — eval pipeline'ı CLI'ın üretim montajıyla (gerçek stage'ler) koşar.
const fixture = join(process.cwd(), 'tests', 'fixtures', 'ts-repo');

// Temiz fixture diff: tek dosyaya tek satır ek, secret yok — secret-scan temiz, static-gates/tests
// gate'leri hedef repo üzerinde koşar (eval artifact dosyaları repoya yazılmaz), mutation skip.
const DIFF = '--- a/src/math.ts\n+++ b/src/math.ts\n@@ -1 +1,2 @@\n const x=1;\n+export const sum=(a:number,b:number)=>a+b;';

// Konsol yakalama: CLI komut çıktıları stdout'a JSON yazdırır (cli.test.ts deseni).
async function runCli(repo: string, args: string[]): Promise<string> {
  const out: string[] = [];
  const orig = console.log;
  console.log = (m: string) => out.push(m);
  try { await buildCli(repo).parseAsync(['node', 'devloop', ...args]); }
  finally { console.log = orig; }
  return out.join('\n');
}

// Kabul koşum kanıtı — tam event zinciri: RunStarted → TaskPicked → ArtifactProduced → PRCreated →
// FindingEmitted (false-positive bulgusu) → accept (real-issue-accepted; PR bulgusuz kabul — parent
// yok, böylece draft requiredFindings boş kalır ve temiz gates-only eval gerçekten pass olur) +
// reject (false-positive, KENDİ bulgusuna bağlı → kategori forbidden). validateChain ok seed'de.
async function seedAcceptedRun(repo: string): Promise<VerdictStore> {
  const store = new VerdictStore(join(repo, '.devloop', 'events.jsonl'));
  const taskSpec = { id: 'task-1', description: 'sum ekle', acceptanceCriteria: ['sum(2,3)===5'], filesScope: ['src/math.ts'] };
  await store.append('RunStarted', 'run-1', '-', 'o', { configSnapshot: {} });
  const picked = await store.append('TaskPicked', 'run-1', 'task-1', 'o', { taskSpec });
  const artifact = { diff: DIFF, intent: 'sum eklendi', rejectedAlternatives: ['loop'], testEvidence: 'vitest 3 passed', files: [{ path: 'src/math.ts', content: 'export const sum=(a:number,b:number)=>a+b;\n' }] };
  const art = await store.append('ArtifactProduced', 'run-1', 'task-1', 'b', { artifact, parentTaskEventId: picked.event_id });
  await store.append('PRCreated', 'run-1', 'task-1', 'o', { url: 'https://pr.example/gd', title: 'sum ekle', commitSha: null, diffDigest: 'd1' });
  const fFp = await store.append('FindingEmitted', 'run-1', 'task-1', 'llm-reviewer', {
    finding: { id: 'f-fp', stage: 'llm-reviewer', category: 'style', severity: 'nit', confidence: 0.8, evidence: { file: 'src/math.ts', line: 1 }, corroborated: false },
    parentArtifactEventId: art.event_id,
  });
  await store.append('HumanDecision', 'run-1', 'task-1', 'h', { decision: 'accept', reason: 'real-issue-accepted', parentFindingEventIds: [] });
  await store.append('HumanDecision', 'run-1', 'task-1', 'h', { decision: 'reject', reason: 'false-positive', parentFindingEventIds: [fFp.event_id] });
  return store;
}

describe('E2E golden veri yolu (R23)', () => {
  it('draft → accept → eval production: staging-only kanıt + score 100 + EvalRun + zincir ok', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'gd-e2e-'));
    cpSync(fixture, repo, { recursive: true });
    // tests gate'i gerçekten koşar: fixture'a geçen bir vitest smoke testi eklenir (tsconfig include
    // yalnız src/** — smoke test typecheck'e girmez; eslint default file setine .ts girmez).
    mkdirSync(join(repo, 'tests'), { recursive: true });
    writeFileSync(join(repo, 'tests', 'smoke.test.ts'), "import { test, expect } from 'vitest';\ntest('smoke', () => { expect(1 + 1).toBe(2); });\n", 'utf8');
    const store = await seedAcceptedRun(repo);
    expect(validateChain(store.readAll()).ok).toBe(true); // seed zinciri bütünlüğü

    const draftsDir = join(repo, '.devloop', 'golden-drafts');
    const goldenDir = join(repo, '.devloop', 'golden');

    // A5 kanıtı: golden/ BAŞLANGIÇTA YOK — draft öncesi ve sonrası absent kalır (staging-only yazım).
    expect(existsSync(goldenDir)).toBe(false);
    const draftOut = await runCli(repo, ['golden', 'draft']);
    const draftRes = JSON.parse(draftOut) as { drafts: Array<{ goldenId: string; taskSpec: { id: string }; fixtureDiff: string; expected: { gatesPass: boolean; requiredFindings: Array<{ category: string }>; forbiddenCategories: string[] } }>; written: number; skipped: number };
    expect(draftRes.written).toBe(1);
    expect(existsSync(goldenDir)).toBe(false); // draft golden/'a DOKUNMAZ
    expect(draftRes.drafts).toHaveLength(1);
    const draft = draftRes.drafts[0];
    // Taslak içeriği kanıttan türetilir: gatesPass true sabit (A2 — PRCreated yalnız gates-pass sonrası),
    // bulgusuz accept → requiredFindings boş; false-positive ret kategorisi forbidden; fixtureDiff
    // artifact diff'inin birebir kopyası.
    expect(draft.expected.gatesPass).toBe(true);
    expect(draft.expected.requiredFindings).toEqual([]);
    expect(draft.expected.forbiddenCategories).toEqual(['style']);
    expect(draft.taskSpec.id).toBe('task-1');
    expect(draft.fixtureDiff).toBe(DIFF);
    expect(readdirSync(draftsDir)).toEqual([`${draft.goldenId}.task.json`]); // staging dışına tek yazım yok

    // accept: staging → golden/ rename — staging dosyası taşınır, golden/ görevi içerir.
    await runCli(repo, ['golden', 'accept', draft.goldenId]);
    expect(existsSync(join(goldenDir, `${draft.goldenId}.task.json`))).toBe(true);
    expect(existsSync(join(draftsDir, `${draft.goldenId}.task.json`))).toBe(false);
    const golden = loadGoldenTasks(repo);
    expect(golden.tasks).toHaveLength(1);
    expect(golden.invalid).toEqual([]);
    expect(golden.tasks[0].goldenId).toBe(draft.goldenId);

    // eval production (gates-only, --full'suz — LLM çağrısı yok): gerçek CLI montajıyla tek golden
    // görev, beklenen gatesPass true ve pipeline GERÇEKTEN pass (temiz fixture diff + temiz repo) →
    // score 100 + EvalRun kanıtı.
    const evalOut = await runCli(repo, ['eval']);
    const summary = JSON.parse(evalOut) as {
      evalId: string; goldenCount: number; passed: number; failed: number; score: number; invalid: string[];
      perTask: Array<{ goldenId: string; pass: boolean; reasons: string[] }>;
      configSnapshot: Record<string, unknown>; l3Active: boolean;
    };
    expect(summary.goldenCount).toBe(1);
    expect(summary.passed).toBe(1);
    expect(summary.failed).toBe(0);
    expect(summary.score).toBe(100);
    expect(summary.invalid).toEqual([]);
    expect(summary.perTask).toEqual([{ goldenId: draft.goldenId, pass: true, reasons: [] }]);
    expect(summary.configSnapshot).toMatchObject({ mode: 'production' });
    expect(summary.l3Active).toBe(false); // 1 görev < l3MinGoldenTasks (50) — L3 veri yolu eşiği

    const evalRuns = store.query({ type: 'EvalRun' }).filter((e): e is EvalRunEvent => e.type === 'EvalRun');
    expect(evalRuns).toHaveLength(1);
    expect(evalRuns[0]?.payload.score).toBe(100);
    expect(evalRuns[0]?.payload.configSnapshot).toMatchObject({ mode: 'production' });
    expect(evalRuns[0]?.payload.evalId).toBe(summary.evalId);

    // eval kanıt zinciri: golden koşum runEval ile TaskPicked/ArtifactProduced/StageVerdict('eval')
    // yazar — gates-only gerçek koşumda görev verdict'i 'pass' (skip yalnız mutation-testing).
    const verdicts = store.query({ type: 'StageVerdict' })
      .filter((e): e is StageVerdictEvent => e.type === 'StageVerdict')
      .filter((e) => e.run_id === `eval-${summary.evalId}`);
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]?.payload).toMatchObject({ stage: 'eval', status: 'pass' });
    expect(validateChain(store.readAll()).ok).toBe(true); // BÜTÜN store: seed + eval kanıtı
  }, 180_000);

  it('duplicate accept throw + discard: staging silinir, golden/kalan etkilenmez', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'gd-e2e2-'));
    await seedAcceptedRun(repo);
    const draftsDir = join(repo, '.devloop', 'golden-drafts');
    const goldenDir = join(repo, '.devloop', 'golden');

    await runCli(repo, ['golden', 'draft']);
    expect(readdirSync(draftsDir)).toHaveLength(1);
    const draftId = readdirSync(draftsDir)[0]!.replace(/\.task\.json$/, '');
    await runCli(repo, ['golden', 'accept', draftId]);
    expect(existsSync(join(goldenDir, `${draftId}.task.json`))).toBe(true);

    // Duplicate accept → throw (golden/'da mevcut goldenId; staging dosyası rename'le gittiği
    // için bu kontrol bulunamadı kontrolünden ÖNCEYE alınmıştır — brief test kontratı).
    await expect(runCli(repo, ['golden', 'accept', draftId])).rejects.toThrow(/Duplicate goldenId/);

    // discard: re-draft aynı koşumdan aynı goldenId'yi yeniden stage'ler (deterministik id);
    // discard yalnız staging dosyasını siler — golden/'daki kabul edilmiş görev ETKİLENMEZ.
    await runCli(repo, ['golden', 'draft']);
    expect(existsSync(join(draftsDir, `${draftId}.task.json`))).toBe(true);
    await runCli(repo, ['golden', 'discard', draftId]);
    expect(existsSync(join(draftsDir, `${draftId}.task.json`))).toBe(false);
    expect(existsSync(join(goldenDir, `${draftId}.task.json`))).toBe(true); // golden kalanı bozulmadı
    expect(loadGoldenTasks(repo).tasks).toHaveLength(1);
    expect(validateChain(new VerdictStore(join(repo, '.devloop', 'events.jsonl')).readAll()).ok).toBe(true);
  });
});
