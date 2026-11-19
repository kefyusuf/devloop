import { describe, it, expect, vi } from 'vitest';
import { execFile, execSync } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { dockerAvailable, dockerizeSpawn } from '../../src/shell/sandbox.js';
import { safeEnv } from '../../src/shell/safeEnv.js';
import { Orchestrator, type OrchestratorDeps } from '../../src/orchestrator/orchestrator.js';
import { VerdictStore } from '../../src/store/store.js';
import { ReviewPipeline } from '../../src/pipeline/pipeline.js';
import { loadConfig, type Policy } from '../../src/config/config.js';
import type { StageResult } from '../../src/contracts/review.js';
import type { Artifact } from '../../src/contracts/schemas.js';
import type { LlmGateway, TokenUsage } from '../../src/gateway/gateway.js';

const base = loadConfig(process.cwd()).policy;
// Orchestrator testlerinde fake pipeline tek stage (static-gates) sağlar — gates buna daraltılır
// (PipelineConfigError penceresi; orchestrator.test.ts ile aynı desen). sandbox alanları odur.
const runBase: Policy = { ...base, gates: ['static-gates'], advisory: [], maxFixTours: 3, budgetUsd: 2.0 };
const dockerPolicy: Policy = { ...runBase, sandbox: { mode: 'docker', image: 'node:20-bookworm-slim' } };
const hostPolicy: Policy = { ...runBase, sandbox: { mode: 'host', image: 'node:20-bookworm-slim' } };

describe('dockerizeSpawn (R13)', () => {
  const repoPath = 'C:\\Users\\repo\\proj'; // backslash — mount forward-slash'e normalize edilir
  const envFlags = Object.entries(safeEnv()).flatMap(([k, v]) => ['-e', `${k}=${v}`]);

  it('docker modu: cmd=docker; run --rm -v(forward-slash mount) -w /workspace [safeEnv -e bloğu] --network none image npx toolArgs sırası', () => {
    const r = dockerizeSpawn({ repoPath, policy: dockerPolicy, bin: 'host-yolunda-kalan.js', toolArgs: ['tsc', '--version'] });
    expect(r.cmd).toBe('docker');
    expect(r.args).toEqual([
      'run',
      '--rm',
      '-v', 'C:/Users/repo/proj:/workspace', // backslash normalize — forward-slash mount
      '-w', '/workspace',
      ...envFlags, // safeEnv alt kümesi -e KEY=VALUE — splice(6) hükmü: -w /workspace ile --network arasına
      '--network', 'none',
      'node:20-bookworm-slim',
      'npx', 'tsc', '--version', // toolArgs aynen — docker modda bin resolve ATLANIR, konteyner içi npx çözer
    ]);
  });

  it('host modu: spawn değişmez — { cmd: bin, args: toolArgs }', () => {
    const r = dockerizeSpawn({ repoPath: '/repo', policy: hostPolicy, bin: '/repo/node_modules/tsc/bin/tsc.js', toolArgs: ['--noEmit'] });
    expect(r).toEqual({ cmd: '/repo/node_modules/tsc/bin/tsc.js', args: ['--noEmit'] });
  });

  it('docker modu -e bloğu: tam olarak safeEnv anahtar kümesi taşınır (I2 — safeEnv dışı sır sızmaz)', () => {
    const r = dockerizeSpawn({ repoPath: '/repo', policy: dockerPolicy, bin: '', toolArgs: ['tsc'] });
    const pairs: Array<[string, string]> = [];
    for (let i = 0; i < r.args.length; i++) {
      if (r.args[i] === '-e') {
        const kv = r.args[i + 1] ?? '';
        pairs.push([kv.split('=')[0] ?? '', kv.split('=').slice(1).join('=')]);
      }
    }
    const env = safeEnv();
    expect(pairs.map(([k]) => k).sort()).toEqual(Object.keys(env).sort());
    expect(pairs.some(([k]) => k === 'ANTHROPIC_API_KEY')).toBe(false); // sır konteynere sızmaz
    // -e bloğu konum hükmü: -w /workspace ile --network arasında
    const firstE = r.args.indexOf('-e');
    expect(r.args[firstE - 1]).toBe('/workspace');
    expect(r.args.indexOf('--network')).toBeGreaterThan(firstE);
  });
});

describe('dockerAvailable (R13)', () => {
  it('probe başarılı → true', async () => {
    const probe = (async () => ({ stdout: 'ok', stderr: '' })) as unknown as typeof execFile;
    await expect(dockerAvailable(probe)).resolves.toBe(true);
  });
  it('probe throw (daemon yok / CLI yok / timeout) → false — hata sızmaz', async () => {
    const probe = (async () => { throw new Error('docker daemon yok'); }) as unknown as typeof execFile;
    await expect(dockerAvailable(probe)).resolves.toBe(false);
  });
});

describe('Orchestrator docker sandbox aktivasyonu (R13)', () => {
  const ART: Artifact = { diff: '', intent: 'i', rejectedAlternatives: [], testEvidence: '', files: [{ path: 'src/a.ts', content: 'export const a=1;' }] };
  const fakeBackend = (art: Artifact = ART) => ({ id: 'fake', generate: vi.fn(async () => art) });
  const passPipeline = (p: Policy) => new ReviewPipeline([{ name: 'static-gates', kind: 'gate' as const, evaluate: async (): Promise<StageResult> => ({ status: 'pass', findings: [], durationMs: 1 }) }], p);

  function initRepo(): string {
    const dir = mkdtempSync(join(tmpdir(), 'sbx-'));
    writeFileSync(join(dir, 'README.md'), '# fixture\n');
    execSync('git init -b main && git config user.email t@t && git config user.name t && git add . && git commit -m init', { cwd: dir });
    return dir;
  }
  const task = (id: string) => ({ id, description: 'd', acceptanceCriteria: ['a'], filesScope: [] });
  const tasksFile = (dir: string, tasks: unknown[]) => { const f = join(dir, 'tasks.json'); writeFileSync(f, JSON.stringify(tasks)); return f; };
  function deps(repo: string, store: VerdictStore, policy: Policy, opts: Partial<OrchestratorDeps> = {}): OrchestratorDeps {
    return {
      store, backend: fakeBackend(), pipeline: passPipeline(policy),
      gateway: { complete: vi.fn(async () => { const usage: TokenUsage = { inputTokens: 0, outputTokens: 0, costUsd: 0 }; return { data: {}, usage }; }) } as LlmGateway,
      policy, repoPath: repo, pr: { openPr: vi.fn(async () => ({ url: 'https://pr.example/1' })) } as never,
      ...opts,
    };
  }

  it('docker modu + Docker kullanılamıyor (probe false) → RunAborted(panic) + açık hata — sessiz host-fallback yok (A6)', async () => {
    const repo = initRepo();
    const store = new VerdictStore(join(repo, '.devloop', 'events.jsonl'));
    const orch = new Orchestrator(deps(repo, store, dockerPolicy, { dockerProbe: async () => false }));
    await expect(orch.run(tasksFile(repo, [task('t1')]))).rejects.toThrow('docker modu seçili ama Docker kullanılamıyor');
    const aborted = store.query({ type: 'RunAborted' });
    expect(aborted).toHaveLength(1);
    expect(aborted[0].payload.reason).toBe('panic');
    expect(aborted[0].task_id).toBe('-'); // run-level abort — görev-topu değil
    expect(store.query({ type: 'TaskPicked' })).toHaveLength(0); // görev işlenmeden dur
  });

  it('docker modu + Docker kullanılabilir (probe true) → koşum normal ilerler (yanlış-abort yok)', async () => {
    const repo = initRepo();
    const store = new VerdictStore(join(repo, '.devloop', 'events.jsonl'));
    const backend = fakeBackend();
    const summary = await new Orchestrator(deps(repo, store, dockerPolicy, { backend, dockerProbe: async () => true }))
      .run(tasksFile(repo, [task('t1')]));
    expect(summary.aborted).toBeUndefined();
    expect(summary.prs).toHaveLength(1);
    expect(store.query({ type: 'RunAborted' })).toHaveLength(0);
    expect(backend.generate).toHaveBeenCalledTimes(1);
  });

  it('host modu: docker probe hiç çağrılmaz (varsayılan davranış korunur)', async () => {
    const repo = initRepo();
    const store = new VerdictStore(join(repo, '.devloop', 'events.jsonl'));
    const probe = vi.fn(async () => false);
    const summary = await new Orchestrator(deps(repo, store, hostPolicy, { dockerProbe: probe })).run(tasksFile(repo, [task('t1')]));
    expect(summary.prs).toHaveLength(1);
    expect(probe).not.toHaveBeenCalled();
  });
});

// R13: gerçek konteyner koşumu — yalnız DEVLOOP_DOCKER=1 ile (Docker Desktop kurulu + daemon
// çalışıyor gerektirir; CI/geliştirici makinesinde Docker yoksa koşum skip olur).
// Konteyner içi `npx tsc` mount edilen reponun kendi node_modules'undan çözülür (--network none).
describe('gerçek docker koşumu (DEVLOOP_DOCKER=1)', () => {
  const enabled = process.env.DEVLOOP_DOCKER === '1';
  it.skipIf(!enabled)('dockerizeSpawn çıktısıyla konteynerde npx tsc --version başarılı', async () => {
    const runReal = promisify(execFile);
    const r = dockerizeSpawn({ repoPath: process.cwd(), policy: dockerPolicy, bin: '', toolArgs: ['tsc', '--version'] });
    const out = await runReal(r.cmd, r.args, { timeout: 300_000 });
    expect(out.stdout).toContain('Version');
  }, 300_000);
});
