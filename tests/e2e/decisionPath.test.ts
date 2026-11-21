import { describe, it, expect } from 'vitest';
import { buildCli } from '../../src/shell/cli.js';
import { VerdictStore, validateChain } from '../../src/store/store.js';
import { loadGoldenTasks } from '../../src/eval/golden.js';
import { cpSync, mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { DevloopEvent } from '../../src/contracts/events.js';
type HumanDecisionEvent = Extract<DevloopEvent, { type: 'HumanDecision' }>;

// R25 (faz 5 T1): decide → gerçek run bağlantısı — L3 veri yolu zincirinin UÇTAN UCA kanıtı.
// goldenDraft.test.ts (R23) kabul koşumu kanıtını EL ile seed ediyordu; burada HumanDecision
// GERÇEK CLI decide komutundan gelir (auto-resolve ile gerçek koşum runId'si taşır) ve
// acceptedRuns (accept ∩ PRCreated) İLK KEZ gerçek decide kararlarıyla eşleşir.
// Zincir: seed gerçek koşum (TaskPicked/ArtifactProduced/PRCreated — orchestrator deseni) →
// decide (auto-resolve) → golden draft (staging) → golden accept (golden/) → eval (gates-only,
// gerçek pipeline) → validateChain ok + HumanDecision run_id gerçek koşum runId'si.
const fixture = join(process.cwd(), 'tests', 'fixtures', 'ts-repo');

// Temiz fixture diff: tek dosyaya tek satır ek, secret yok — secret-scan temiz, static-gates/tests
// gate'leri hedef repo üzerinde koşar, mutation skip (authorizedSkips). Eval score 100 için
// bulgusuz accept (requiredFindings boş) + temiz gates-only koşum gereklidir.
const DIFF = '--- a/src/math.ts\n+++ b/src/math.ts\n@@ -1 +1,2 @@\n const x=1;\n+export const sum=(a:number,b:number)=>a+b;';

// Konsol yakalama: CLI komut çıktıları stdout'a JSON yazdırır (goldenDraft.test.ts deseni).
async function runCli(repo: string, args: string[]): Promise<string> {
  const out: string[] = [];
  const orig = console.log;
  console.log = (m: string) => out.push(m);
  try { await buildCli(repo).parseAsync(['node', 'devloop', ...args]); }
  finally { console.log = orig; }
  return out.join('\n');
}

// Gerçek koşum kanıtı — orchestrator deseni: RunStarted → TaskPicked → ArtifactProduced (parent
// TaskPicked event_id) → PRCreated (gates-pass sonrası — A2). El ile seed edilir; LLM yok.
async function seedRealRun(repo: string): Promise<VerdictStore> {
  const store = new VerdictStore(join(repo, '.devloop', 'events.jsonl'));
  const taskSpec = { id: 't1', description: 'sum ekle', acceptanceCriteria: ['sum(2,3)===5'], filesScope: ['src/math.ts'] };
  await store.append('RunStarted', 'run-r25', '-', 'o', { configSnapshot: {} });
  const picked = await store.append('TaskPicked', 'run-r25', 't1', 'orchestrator', { taskSpec });
  const artifact = { diff: DIFF, intent: 'sum eklendi', rejectedAlternatives: ['loop'], testEvidence: 'vitest 3 passed', files: [{ path: 'src/math.ts', content: 'export const sum=(a:number,b:number)=>a+b;\n' }] };
  await store.append('ArtifactProduced', 'run-r25', 't1', 'b', { artifact, parentTaskEventId: picked.event_id });
  await store.append('PRCreated', 'run-r25', 't1', 'o', { url: 'https://pr.example/r25', title: 't1: sum eklendi', commitSha: null, diffDigest: 'd-r25' });
  return store;
}

describe('E2E decide → gerçek run veri yolu (R25)', () => {
  it('decide auto-resolve → golden draft (İLK KEZ gerçek decide kararıyla) → accept → eval score 100 + zincir ok', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'dp-e2e-'));
    cpSync(fixture, repo, { recursive: true });
    // tests gate'i gerçekten koşar: fixture'a geçen bir vitest smoke testi eklenir (goldenDraft
    // testiyle aynı düzenek — tsconfig include yalnız src/**, eslint default setine tests girmez).
    mkdirSync(join(repo, 'tests'), { recursive: true });
    writeFileSync(join(repo, 'tests', 'smoke.test.ts'), "import { test, expect } from 'vitest';\ntest('smoke', () => { expect(1 + 1).toBe(2); });\n", 'utf8');
    const store = await seedRealRun(repo);
    expect(validateChain(store.readAll()).ok).toBe(true); // seed zinciri bütünlüğü

    // 1. decide CLI — auto-resolve (--run YOK): HumanDecision run_id GERÇEK koşum runId'sidir
    // (faz 4'e kadar her zaman 'manual' yazılıyordu — R25 ile gerçek zincir bağlanır).
    await runCli(repo, ['decide', '--task', 't1', '--accept', '--reason', 'real-issue-accepted']);
    const decisions = store.query({ type: 'HumanDecision' })
      .filter((e): e is HumanDecisionEvent => e.type === 'HumanDecision');
    expect(decisions).toHaveLength(1);
    expect(decisions[0].run_id).toBe('run-r25'); // son TaskPicked'in run_id'si
    expect(decisions[0].task_id).toBe('t1');
    expect(decisions[0].payload).toMatchObject({ decision: 'accept', reason: 'real-issue-accepted' });

    // 2. golden draft — acceptedRuns: accept-decision run_id ∩ PRCreated run_id. İLK KEZ gerçek
    // decide kararlarıyla eşleşir (R23'te kararlar el ile seed'di).
    const goldenDir = join(repo, '.devloop', 'golden');
    expect(existsSync(goldenDir)).toBe(false); // A5: golden/ başlangıçta yok
    const draftOut = await runCli(repo, ['golden', 'draft']);
    const draftRes = JSON.parse(draftOut) as {
      drafts: Array<{ goldenId: string; taskSpec: { id: string }; fixtureDiff: string; expected: { gatesPass: boolean; requiredFindings: Array<{ category: string }>; forbiddenCategories: string[] } }>;
      written: number; skipped: number;
    };
    expect(draftRes.written).toBe(1);
    expect(draftRes.drafts).toHaveLength(1);
    const draft = draftRes.drafts[0];
    // Taslak içeriği gerçek koşum + gerçek karar kanıtından türetilir:
    expect(draft.taskSpec.id).toBe('t1');
    expect(draft.fixtureDiff).toBe(DIFF);
    expect(draft.expected.gatesPass).toBe(true); // PRCreated yalnız gates-pass sonrası (A2)
    expect(draft.expected.requiredFindings).toEqual([]); // bulgusuz accept
    expect(draft.expected.forbiddenCategories).toEqual([]);
    // A5 (staging-only): draft golden/ DIZININE DOKUNMAZ — yalnız golden-drafts/ staging
    expect(existsSync(goldenDir)).toBe(false);
    expect(readdirSync(join(repo, '.devloop', 'golden-drafts'))).toEqual([`${draft.goldenId}.task.json`]);

    // 3. golden accept CLI — staging → golden/ rename
    await runCli(repo, ['golden', 'accept', draft.goldenId]);
    expect(existsSync(join(goldenDir, `${draft.goldenId}.task.json`))).toBe(true);
    expect(existsSync(join(repo, '.devloop', 'golden-drafts', `${draft.goldenId}.task.json`))).toBe(false);
    expect(loadGoldenTasks(repo).tasks).toHaveLength(1);
    expect(loadGoldenTasks(repo).invalid).toEqual([]);

    // 4. eval CLI (gates-only — LLM çağrısı yok): tek golden görev, beklenen gatesPass true ve
    // gerçek pipeline GERÇEKTEN pass (temiz fixture diff + temiz repo) → score 100.
    const evalOut = await runCli(repo, ['eval']);
    const summary = JSON.parse(evalOut) as {
      evalId: string; goldenCount: number; passed: number; failed: number; score: number; invalid: string[];
      perTask: Array<{ goldenId: string; pass: boolean; reasons: string[] }>;
      configSnapshot: Record<string, unknown>;
    };
    expect(summary.goldenCount).toBe(1);
    expect(summary.passed).toBe(1);
    expect(summary.failed).toBe(0);
    expect(summary.score).toBe(100);
    expect(summary.invalid).toEqual([]);
    expect(summary.perTask).toEqual([{ goldenId: draft.goldenId, pass: true, reasons: [] }]);
    expect(summary.configSnapshot).toMatchObject({ mode: 'production' });

    // 5. Zincir bütünlüğü: BÜTÜN store (seed + decide + eval kanıtı) validateChain ok; HumanDecision
    // run_id hâlâ gerçek koşum runId'si (eval koşumu store'a ek event yazsa da karar bağlantısı bozulmaz).
    expect(validateChain(store.readAll()).ok).toBe(true);
    expect(store.query({ type: 'HumanDecision' })
      .filter((e): e is HumanDecisionEvent => e.type === 'HumanDecision')[0]?.run_id).toBe('run-r25');
  }, 180_000);
});
