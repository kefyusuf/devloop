import { describe, it, expect, vi } from 'vitest';
import { Orchestrator, type OrchestratorDeps } from '../../src/orchestrator/orchestrator.js';
import { VerdictStore, validateChain } from '../../src/store/store.js';
import { ReviewPipeline } from '../../src/pipeline/pipeline.js';
import { RiskTriageStage } from '../../src/pipeline/stages/riskTriage.js';
import { LlmEnsembleStage } from '../../src/pipeline/stages/llmEnsemble.js';
import { loadConfig } from '../../src/config/config.js';
import { cpSync, mkdtempSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { StageResult, ReviewStage } from '../../src/contracts/review.js';
import type { Artifact } from '../../src/contracts/schemas.js';

const base = loadConfig(process.cwd()).policy;
// Faz 2 (R2): golden koşum gerçek montaj biçimine geçti — advisory'de llm-ensemble VAR
// (gerçek LLM kısıtı korunur: ensemble reviewer'ları fake stage stand-in'leridir, gateway kullanmazlar).
const policy = { ...base, gates: ['risk-triage', 'static-gates'], advisory: ['llm-ensemble'] };
const fixture = join(process.cwd(), 'tests', 'fixtures', 'sample-repo');

// İki fake reviewer da AYNI kategori+dosya+satır bulgusunu üretir → ensemble kendi dedupe'ünde
// (pipeline dedupe'ünden ÖNCE) ikisini TEK corroborated=true kazanan'da birleştirir (llmEnsemble.ts hükmü).
const fakeReviewer = (name: string): ReviewStage => ({
  name, kind: 'advisory' as const,
  evaluate: async (): Promise<StageResult> => ({
    status: 'pass', durationMs: 1,
    findings: [{ id: `${name}-f1`, stage: name, category: 'security', severity: 'required', confidence: 0.9, evidence: { file: 'src/util.ts', line: 1 }, corroborated: false }],
  }),
});

function freshRepo() {
  const repo = mkdtempSync(join(tmpdir(), 'e2e-'));
  cpSync(fixture, repo, { recursive: true });
  // Fix round 3 paraleli (orchestrator.test.ts): kimlik config'i commit'ten ÖNCE —
  // global git identity'siz ortamda fixture kurulur.
  execSync('git init -b main && git config user.email t@t && git config user.name t && git add . && git commit -m init', { cwd: repo });
  return { repo, store: new VerdictStore(join(repo, '.devloop', 'events.jsonl')) };
}
// Düzeltme 4 + gerçek davranış: dosya içeriği '\n' ile biter (kaynak dosya geleneği). Newline'sız
// içerik git çıktısına '\ No newline at end of file' satırı ekler → diffLines 9 → diffSize payı
// skoru 21'e yuvarlar. Newline'lı içerikle diff 8 satır → skor tam 20 (scopePaths=1 × 0.2 ağırlığı).
const NEW_FILE: Artifact = { diff: '', intent: 'repeat eklendi', rejectedAlternatives: ['loop'], testEvidence: 'unit test yazıldı', files: [{ path: 'src/repeat.ts', content: 'export const repeat=(s:string,n:number)=>n>0?s.repeat(n):"";\n' }] };
const deps = (repo: string, store: VerdictStore): OrchestratorDeps => ({
  store,
  backend: { id: 'fake', generate: vi.fn(async () => NEW_FILE) } as never,
  pipeline: new ReviewPipeline([
    new RiskTriageStage(policy),
    { name: 'static-gates', kind: 'gate' as const, evaluate: async (): Promise<StageResult> => ({ status: 'pass', findings: [], durationMs: 1 }) },
    new LlmEnsembleStage(fakeReviewer('llm-reviewer'), fakeReviewer('llm-reviewer-alt'), policy),
  ], policy),
  gateway: { complete: vi.fn(async () => ({ data: {}, usage: { inputTokens: 10, outputTokens: 10, costUsd: 0.0001 } })) } as never,
  policy, repoPath: repo, pr: { openPr: vi.fn(async () => ({ url: 'https://pr.example/e2e' })) } as never,
});

describe('E2E golden koşu (A6 değişmezleri)', () => {
  it('event sırası snapshot + kanıt zinciri + gerçek risk skoru', async () => {
    const { repo, store } = freshRepo();
    const summary = await new Orchestrator(deps(repo, store)).run(join(repo, 'tasks.json'));
    expect(summary.prs).toHaveLength(1);

    const events = store.readAll();
    // Faz 2 (R2): pipeline üç stage — risk-triage + static-gates + llm-ensemble (advisory) → ÜÇ StageVerdict;
    // FindingEmitted artık VAR: ensemble dedupe iki fake reviewer bulgusunu (aynı anahtar) TEK corroborated
    // kazanan'a indirir → tam 1 FindingEmitted, RiskScored'dan sonra, PRCreated'dan önce.
    expect(events.map((e) => e.type)).toEqual(['RunStarted', 'TaskPicked', 'ArtifactProduced', 'StageVerdict', 'StageVerdict', 'StageVerdict', 'RiskScored', 'FindingEmitted', 'PRCreated']);
    expect(validateChain(events).ok).toBe(true);

    // Faz 2 (R2): corroborated bayrağı kazanan bulguyla kanıt zincirine akar — iki heterojen reviewer
    // aynı güvenlik bulgusunda anlaştı (security @ src/util.ts:1), tek kaynaklı false kalmaz.
    const findingEvents = events.filter((e) => e.type === 'FindingEmitted');
    expect(findingEvents).toHaveLength(1);
    const finding = findingEvents[0].payload.finding;
    expect(finding.corroborated).toBe(true);
    expect(finding.category).toBe('security');
    expect(finding.evidence.file).toBe('src/util.ts');

    const risk = events.find((e) => e.type === 'RiskScored')!.payload;
    expect(risk.score).toBe(20); // scopePaths=1 × 0.2 → gerçek skor, 0 DEĞİL (inceleme D)
    expect(risk.signals.scopePaths).toBe(1);

    const pr = events.find((e) => e.type === 'PRCreated')!.payload;
    expect(pr.commitSha).not.toBeNull();
    expect(pr.commitSha).toMatch(/^[0-9a-f]{40}$/);
    // Düzeltme 3: digest sha256(KAYITLI ArtifactProduced.diff) — fixture sabiti NEW_FILE.diff DEĞİL.
    const recorded = events.find((e) => e.type === 'ArtifactProduced')!.payload.artifact;
    expect(recorded.diff.length).toBeGreaterThan(0);
    expect(recorded.diff).toContain('src/repeat.ts');
    expect(pr.diffDigest).toBe(createHash('sha256').update(recorded.diff).digest('hex'));
  });

  it('untracked-file kanıtı: yeni dosya diff\'te görünür (boş diff yok)', async () => {
    const { repo, store } = freshRepo();
    await new Orchestrator(deps(repo, store)).run(join(repo, 'tasks.json'));
    const art = store.query({ type: 'ArtifactProduced' })[0].payload.artifact;
    expect(art.diff.length).toBeGreaterThan(0);
    expect(art.diff).toContain('src/repeat.ts');
  });

  it('resume: yarım koşum tamamlanır, aynı görev ikinci kez PR üretilmez', async () => {
    const { repo, store } = freshRepo();
    // Düzeltme 1: resume politika-kayma kontrolü (T12) 'h' sabitini panic'e düşürür —
    // seed, orchestrator'ın kullandığı AYNI hash ifadesiyle yazılır (policy = testin override'u).
    await store.append('RunStarted', 'run-x', '-', 'o', { configSnapshot: { policyHash: createHash('sha256').update(JSON.stringify(policy)).digest('hex').slice(0, 16) } });
    await store.append('TaskPicked', 'run-x', 'task-1', 'o', { taskSpec: { id: 'task-1', description: 'd', acceptanceCriteria: ['a'], filesScope: [] } });
    const summary = await new Orchestrator(deps(repo, store)).run(join(repo, 'tasks.json'));
    expect(summary.prs).toHaveLength(1);
    expect(store.query({ type: 'PRCreated', taskId: 'task-1' })).toHaveLength(1);
  });

  it('kill marker: .devloop/STOP → RunAborted(kill), PR yok', async () => {
    const { repo, store } = freshRepo();
    // Düzeltme 6: marker öncesi .devloop dizini yok — recursive mkdir gerekli.
    mkdirSync(join(repo, '.devloop'), { recursive: true });
    writeFileSync(join(repo, '.devloop', 'STOP'), '');
    const summary = await new Orchestrator(deps(repo, store)).run(join(repo, 'tasks.json'));
    expect(summary.aborted).toBe('kill');
    expect(summary.prs).toHaveLength(0);
    expect(existsSync(join(repo, '.devloop'))).toBe(true);
  });
});
