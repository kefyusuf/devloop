import { describe, it, expect, vi, afterEach } from 'vitest';
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
  // I1 hükmü: -e flag'leri YALNIZ GIT_*/SSH_* önekli değişkenleri taşır (case-insensitive) —
  // PATH/SYSTEMROOT/COMSPEC/TEMP/HOME vb. image ENV'ini EZMESİN (konteyner tmp kendi).
  const gitEnvFlags = (): string[] => Object.entries(safeEnv())
    .filter(([k]) => /^(GIT_|SSH_)/i.test(k))
    .flatMap(([k, v]) => ['-e', `${k}=${v}`]);
  const extractEnvPairs = (args: string[]): Array<[string, string]> => {
    const pairs: Array<[string, string]> = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '-e') {
        const kv = args[i + 1] ?? '';
        pairs.push([kv.split('=')[0] ?? '', kv.split('=').slice(1).join('=')]);
      }
    }
    return pairs;
  };
  afterEach(() => { vi.unstubAllEnvs(); });

  // R20 (faz 4 T5): node_modules bind read-only (:ro) — hardening; konteyner bağımlılıkları
  // yazamaz (worktree mount'u yazılabilir kalır, node_modules yalnız çözümleme kaynağıdır).
  it('docker modu: run --rm -v worktree -v original/node_modules:ro -w /workspace [-e bloğu] --network none image npx toolArgs (sıra hükmü, fix round 1 + R20 :ro)', () => {
    vi.stubEnv('GIT_DIR', 'C:\\repo\\.git');
    vi.stubEnv('GIT_CONFIG', '/dev/null');
    const r = dockerizeSpawn({
      repoPath: 'C:\\repo\\.devloop\\worktrees\\run1234-t1', // backslash + .devloop/worktrees yolu normalize edilir
      originalRepoPath: 'C:\\Users\\repo\\proj',
      policy: dockerPolicy, bin: 'host-yolunda-kalan.js', toolArgs: ['tsc', '--version'],
    });
    expect(r.cmd).toBe('docker');
    expect(r.args).toEqual([
      'run',
      '--rm',
      '-v', 'C:/repo/.devloop/worktrees/run1234-t1:/workspace',                 // worktree mount — forward-slash normalize
      '-v', 'C:/Users/repo/proj/node_modules:/workspace/node_modules:ro',       // I2 + R20: hedef reponun KENDİ toolchain'i, READ-ONLY
      '-w', '/workspace',
      ...gitEnvFlags(), // I1: yalnız GIT_*/SSH_* — blok -w /workspace ile --network arasında
      '--network', 'none',
      'node:20-bookworm-slim',
      'npx', 'tsc', '--version', // toolArgs aynen — docker modda bin resolve ATLANIR, konteyner içi npx çözer
    ]);
  });

  it('R20: node_modules bind :ro içerir — konteyner bağımlılık yazımı engelli (read-only hardening)', () => {
    const r = dockerizeSpawn({ repoPath: '/repo', originalRepoPath: '/orig', policy: dockerPolicy, bin: '', toolArgs: ['tsc'] });
    const bind = r.args.find((a) => a.includes(':/workspace/node_modules'));
    expect(bind).toBeDefined();
    expect(bind!.endsWith(':ro')).toBe(true);
  });

  it('I1: -e yalnız GIT_*/SSH_* — ANTHROPIC_API_KEY / PATH / SYSTEMROOT YOK, GIT_DIR / GIT_CONFIG VAR', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-test');
    vi.stubEnv('GIT_DIR', '.git');
    vi.stubEnv('GIT_CONFIG', 'ref:refs/heads/main');
    const r = dockerizeSpawn({ repoPath: '/repo', originalRepoPath: '/orig', policy: dockerPolicy, bin: '', toolArgs: ['tsc'] });
    const keys = extractEnvPairs(r.args).map(([k]) => k);
    expect(keys).toContain('GIT_DIR');
    expect(keys).toContain('GIT_CONFIG');
    expect(keys.some((k) => k === 'PATH')).toBe(false);
    expect(keys.some((k) => k === 'SYSTEMROOT')).toBe(false);
    expect(keys.some((k) => k === 'ANTHROPIC_API_KEY')).toBe(false); // sır konteynere sızmaz
    expect(keys.every((k) => /^(GIT_|SSH_)/i.test(k))).toBe(true);
    expect(keys.every((k) => Object.keys(safeEnv()).includes(k))).toBe(true); // safeEnv dışı hiçbir anahtar taşınmaz
  });

  it('I2: originalRepoPath verilmedi → node_modules bind YOK (npx fail-closed error — dokümante davranış)', () => {
    const r = dockerizeSpawn({ repoPath: '/repo', policy: dockerPolicy, bin: '', toolArgs: ['tsc'] });
    expect(r.args.filter((a) => a === '-v')).toHaveLength(1); // yalnız worktree bind
    expect(r.args.some((a) => a.endsWith(':/workspace/node_modules'))).toBe(false);
    expect(r.args[2]).toBe('-v');
    expect(r.args[3]).toBe('/repo:/workspace');
  });

  it('host modu: spawn değişmez — { cmd: bin, args: toolArgs }', () => {
    const r = dockerizeSpawn({ repoPath: '/repo', originalRepoPath: '/orig', policy: hostPolicy, bin: '/repo/node_modules/tsc/bin/tsc.js', toolArgs: ['--noEmit'] });
    expect(r).toEqual({ cmd: '/repo/node_modules/tsc/bin/tsc.js', args: ['--noEmit'] });
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
// Konteyner içi `npx tsc` mount edilen reponun kendi node_modules'undan çözülür (--network none;
// I2: devloop node_modules'u ayrıca /workspace/node_modules'a bind edilir).
describe('gerçek docker koşumu (DEVLOOP_DOCKER=1)', () => {
  const enabled = process.env.DEVLOOP_DOCKER === '1';
  it.skipIf(!enabled)('dockerizeSpawn çıktısıyla konteynerde npx tsc --version başarılı', async () => {
    const runReal = promisify(execFile);
    const r = dockerizeSpawn({ repoPath: process.cwd(), originalRepoPath: process.cwd(), policy: dockerPolicy, bin: '', toolArgs: ['tsc', '--version'] });
    const out = await runReal(r.cmd, r.args, { timeout: 300_000 });
    expect(out.stdout).toContain('Version');
  }, 300_000);
});
