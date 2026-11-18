import { describe, it, expect, vi } from 'vitest';
import { Orchestrator, BudgetedGateway, type OrchestratorDeps } from '../../src/orchestrator/orchestrator.js';
import { VerdictStore, validateChain } from '../../src/store/store.js';
import { ReviewPipeline } from '../../src/pipeline/pipeline.js';
import { loadConfig } from '../../src/config/config.js';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { StageResult } from '../../src/contracts/review.js';
import type { Finding, Artifact } from '../../src/contracts/schemas.js';
import type { LlmGateway, TokenUsage } from '../../src/gateway/gateway.js';

const base = loadConfig(process.cwd()).policy;
const policy = { ...base, gates: ['static-gates'], advisory: [], maxFixTours: 3, budgetUsd: 2.0 };

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'repo-'));
  writeFileSync(join(dir, 'README.md'), '# fixture\n');
  // Fix round 3: kimlik config'i commit'ten ÖNCE — global git identity'siz CI'da fixture kurulur.
  execSync('git init -b main && git config user.email t@t && git config user.name t && git add . && git commit -m init', { cwd: dir });
  return dir;
}
const tasksFile = (dir: string, tasks: unknown[]) => { const f = join(dir, 'tasks.json'); writeFileSync(f, JSON.stringify(tasks)); return f; };

const ART: Artifact = { diff: '', intent: 'i', rejectedAlternatives: [], testEvidence: '', files: [{ path: 'src/a.ts', content: 'export const a=1;' }] };
const fakeBackend = (art: Artifact = ART) => ({ id: 'fake', generate: vi.fn(async () => art) });
const passPipeline = () => new ReviewPipeline([{ name: 'static-gates', kind: 'gate' as const, evaluate: async (): Promise<StageResult> => ({ status: 'pass', findings: [], durationMs: 1 }) }], policy);
const failPipeline = (finding: Finding) => new ReviewPipeline([{ name: 'static-gates', kind: 'gate' as const, evaluate: async (): Promise<StageResult> => ({ status: 'fail', findings: [finding], durationMs: 1 }) }], policy);

function costGateway(perCall: number): LlmGateway & { calls: number } {
  let calls = 0;
  return Object.assign({
    complete: vi.fn(async () => {
      calls++;
      const usage: TokenUsage = { inputTokens: 1000, outputTokens: 1000, costUsd: perCall };
      return { data: {}, usage };
    }),
  }, { get calls() { return calls; } }) as LlmGateway & { calls: number };
}

function deps(repo: string, store: VerdictStore, opts: Partial<OrchestratorDeps> = {}): OrchestratorDeps {
  return {
    store, backend: fakeBackend(), pipeline: passPipeline(), gateway: costGateway(0.0001),
    policy, repoPath: repo, pr: { openPr: vi.fn(async () => ({ url: 'https://pr.example/1' })) } as never,
    ...opts,
  };
}

describe('Orchestrator', () => {
  it('mutlu yol: gate geçer → commit + PRCreated(commitSha, diffDigest); kanıt zinciri sağlam', async () => {
    const repo = initRepo();
    const store = new VerdictStore(join(repo, '.devloop', 'events.jsonl'));
    const backend = fakeBackend();
    const summary = await new Orchestrator(deps(repo, store, { backend })).run(tasksFile(repo, [{ id: 't1', description: 'd', acceptanceCriteria: ['a'], filesScope: [] }]));
    expect(summary.prs).toHaveLength(1);
    const pr = store.query({ type: 'PRCreated' })[0].payload;
    expect(pr.commitSha).not.toBeNull();
    // Ruling (pre-flight): orchestrator diff'i gerçek git diff ile değiştirir; assertion sha256(KAYITLI
    // ArtifactProduced.diff) üzerinden yapılır + diff boş değil ve 'src/a.ts' içerir (progress.md).
    const recorded = store.query({ type: 'ArtifactProduced' })[0].payload.artifact;
    expect(recorded.diff.length).toBeGreaterThan(0);
    expect(recorded.diff).toContain('src/a.ts');
    expect(pr.diffDigest).toBe(createHash('sha256').update(recorded.diff).digest('hex'));
    expect(validateChain(store.readAll()).ok).toBe(true);
    expect(backend.generate).toHaveBeenCalledTimes(1);
  });

  it('gate fail: maxFixTours tur, sonra TaskBlocked + PR YOK (A2)', async () => {
    const repo = initRepo();
    const store = new VerdictStore(join(repo, '.devloop', 'events.jsonl'));
    const backend = fakeBackend();
    const summary = await new Orchestrator(deps(repo, store, {
      backend,
      pipeline: failPipeline({ id: 'f', stage: 'static-gates', category: 'lint', severity: 'required', confidence: 1, evidence: { file: 'a.ts' } }),
    })).run(tasksFile(repo, [{ id: 't1', description: 'd', acceptanceCriteria: ['a'], filesScope: [] }]));
    expect(summary.blocked).toEqual(['t1']);
    expect(summary.prs).toHaveLength(0);
    expect(backend.generate).toHaveBeenCalledTimes(policy.maxFixTours);
    expect(store.query({ type: 'TaskBlocked' })).toHaveLength(1);
    expect(store.query({ type: 'PRCreated' })).toHaveLength(0);
  });

  it('bütçe: gerçek usage toplamı aşılınca RunAborted(budget), kalan görev PR almaz', async () => {
    const repo = initRepo();
    const store = new VerdictStore(join(repo, '.devloop', 'events.jsonl'));
    const summary = await new Orchestrator(deps(repo, store, { gateway: costGateway(1.5) })).run(tasksFile(repo, [
      { id: 't1', description: 'd', acceptanceCriteria: ['a'], filesScope: [] },
      { id: 't2', description: 'd', acceptanceCriteria: ['a'], filesScope: [] },
    ]));
    expect(summary.aborted).toBe('budget');
    expect(summary.prs).toHaveLength(1);
    expect(store.query({ type: 'RunAborted' })[0].payload.reason).toBe('budget');
  });

  it('BudgetedGateway: bütçe sonrası çağrı reddedilir', async () => {
    const inner = costGateway(1.5);
    const bg = new BudgetedGateway(inner, 2.0, () => {});
    await bg.complete({ system: 's', user: 'u', schema: { parse: (x) => x } as never, runId: 'r' }); // 1.5
    await expect(bg.complete({ system: 's', user: 'u', schema: { parse: (x) => x } as never, runId: 'r' })).rejects.toThrow('Bütçe'); // 1.5+1.5=3.0 > 2.0 sonrası
  });

  it('resume: TaskPicked var PRCreated yok → tamamlar; TaskBlocked tekrar işlenmez', async () => {
    const repo = initRepo();
    execSync('git branch devloop/task-1', { cwd: repo }); // Fix round 1: çöken önceki koşumun bıraktığı stale branch
    const store = new VerdictStore(join(repo, '.devloop', 'events.jsonl'));
    await store.append('RunStarted', 'run-x', '-', 'o', { configSnapshot: { policyHash: createHash('sha256').update(JSON.stringify(policy)).digest('hex').slice(0, 16) } });
    await store.append('TaskPicked', 'run-x', 'task-1', 'o', { taskSpec: { id: 'task-1', description: 'd', acceptanceCriteria: ['a'], filesScope: [] } });
    await store.append('TaskBlocked', 'run-x', 'task-2', 'o', { reason: 'gate-fail' });
    const backend = fakeBackend();
    const summary = await new Orchestrator(deps(repo, store, { backend })).run(tasksFile(repo, [
      { id: 'task-1', description: 'd', acceptanceCriteria: ['a'], filesScope: [] },
      { id: 'task-2', description: 'd', acceptanceCriteria: ['a'], filesScope: [] },
    ]));
    expect(summary.prs).toHaveLength(1);
    expect(summary.prs[0].taskId).toBe('task-1');
    expect(backend.generate).toHaveBeenCalledTimes(1); // task-2 blocked, tekrar denenmedi
  });
});
