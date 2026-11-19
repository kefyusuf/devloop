import { describe, it, expect, vi } from 'vitest';
import { Orchestrator, type OrchestratorDeps } from '../../src/orchestrator/orchestrator.js';
import { VerdictStore, validateChain } from '../../src/store/store.js';
import { ReviewPipeline } from '../../src/pipeline/pipeline.js';
import { RiskTriageStage } from '../../src/pipeline/stages/riskTriage.js';
import { StaticGatesStage } from '../../src/pipeline/stages/staticGates.js';
import { TypeScriptAdapter } from '../../src/adapters/typescript/index.js';
import { loadConfig } from '../../src/config/config.js';
import { cpSync, mkdtempSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';
import type { GenerationContext } from '../../src/generator/generator.js';
import type { Artifact } from '../../src/contracts/schemas.js';

// Final review entegrasyon testi (C1 + C2): gerçek TypeScriptAdapter + gerçek ReviewPipeline
// (risk-triage + static-gates) orchestrator'un KENDİNİN açtığı repo-içi worktree üzerinden uçtan
// uca koşar — planın hiç olmadığı tek test, kurulu bütünün kanıtı.
const base = loadConfig(process.cwd()).policy;
const policy = { ...base, gates: ['risk-triage', 'static-gates'], advisory: [] };
const fixture = join(process.cwd(), 'tests', 'fixtures', 'ts-repo');

const ART: Artifact = {
  diff: '', intent: 'extra eklendi', rejectedAlternatives: [], testEvidence: 'unit',
  files: [{ path: 'src/extra.ts', content: 'export const extra = (n: number): number => n + 1;\n' }],
};

describe('orchestrator uçtan uca kablolama (C1 repo bağlamı + C2 repo-içi worktree)', () => {
  it('gerçek gate zinciriyle koşum PR\'a ulaşır; generator repo içeriğini görür; .gitignore dokunulmaz', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'wire-'));
    cpSync(fixture, repo, { recursive: true });
    execSync('git init -b main && git config user.email t@t && git config user.name t && git add . && git commit -m init', { cwd: repo });
    const store = new VerdictStore(join(repo, '.devloop', 'events.jsonl'));
    let captured: GenerationContext | null = null;
    const backend = {
      id: 'fake',
      generate: vi.fn(async (_t: unknown, ctx: GenerationContext) => { captured = ctx; return ART; }),
    };
    const deps: OrchestratorDeps = {
      store,
      backend: backend as never,
      pipeline: new ReviewPipeline([new RiskTriageStage(policy), new StaticGatesStage(new TypeScriptAdapter())], policy),
      gateway: { complete: vi.fn(async () => ({ data: {}, usage: { inputTokens: 10, outputTokens: 10, costUsd: 0.0001 } })) } as never,
      policy, repoPath: repo, pr: { openPr: vi.fn(async () => ({ url: 'https://pr.example/wire' })) } as never,
    };

    const summary = await new Orchestrator(deps).run(join(repo, 'tasks.json'));

    expect(summary.prs).toHaveLength(1);
    expect(summary.blocked).toEqual([]);

    // C1: generator bağlamı GERÇEK repo içeriği taşır (önceden hep boştu — C1 wiring)
    expect(captured).not.toBeNull();
    const ctx = captured as unknown as GenerationContext;
    expect(ctx.repoFiles.some((f) => f.path === 'src/util.ts' && f.content.includes('slug'))).toBe(true);
    expect(ctx.repoTree).toContain('src/util.ts');

    // C2: worktree repo İÇİNDE açıldı (generate'e geçen repoPath repo/.devloop/worktrees altında)
    expect(ctx.repoPath.startsWith(join(repo, '.devloop', 'worktrees'))).toBe(true);
    // kullanıcı .gitignore'una dokunulmadı; exclude idempotent yazıldı; ana repo status temiz
    expect(existsSync(join(repo, '.gitignore'))).toBe(false);
    expect(readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8')).toContain('.devloop/');
    expect(execSync('git status --porcelain', { cwd: repo }).toString().trim()).toBe('');

    // gerçek gate'ler koştu ve geçti (eslint devloop node_modules fallback'i + gerçek tsc)
    const verdicts = store.query({ type: 'StageVerdict' }).map((e) => e.payload);
    expect(verdicts.map((v) => v.stage)).toEqual(['risk-triage', 'static-gates']);
    expect(verdicts.every((v) => v.status === 'pass')).toBe(true);
    // I6: StageVerdict artifact'e bağlanır (validateChain scalar binding'i artık verdict'leri de kapsar)
    const artEvent = store.query({ type: 'ArtifactProduced' })[0];
    expect(verdicts.every((v) => v.parentArtifactEventId === artEvent.event_id)).toBe(true);

    // worktree temizliği: görev sonrası altında dosya kalmaz
    expect(readdirSync(join(repo, '.devloop', 'worktrees'))).toEqual([]);
    expect(validateChain(store.readAll()).ok).toBe(true);
  });
});
