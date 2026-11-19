import { describe, it, expect } from 'vitest';
import { parseDiff, runReviewDiff } from '../../src/shell/reviewDiff.js';
import { buildCli } from '../../src/shell/cli.js';
import { ReviewPipeline } from '../../src/pipeline/pipeline.js';
import { VerdictStore, validateChain } from '../../src/store/store.js';
import { loadConfig } from '../../src/config/config.js';
import type { ReviewStage } from '../../src/contracts/review.js';
import type { Finding } from '../../src/contracts/schemas.js';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const basePolicy = loadConfig(process.cwd()).policy;
// Pre-flight hüküm: exit kodu testleri policy-overridden pipeline ile — fake stage'ler (gerçek
// LLM/stryker çağrısı yok). Exit 0/1: gates ['risk-triage'], advisory []. Exit 2: geçen advisory fake.
const ciPolicy = { ...basePolicy, gates: ['risk-triage'], advisory: [] };
const advPolicy = { ...basePolicy, gates: ['risk-triage'], advisory: ['fake-advisory'] };

function stage(name: string, kind: 'gate' | 'advisory', status: 'pass' | 'fail' | 'error' | 'skipped', findings: Finding[] = []): ReviewStage {
  return { name, kind, evaluate: async () => ({ status, findings, durationMs: 1 }) };
}
const F = (id: string, severity: Finding['severity'], stageName = 'fake-advisory'): Finding =>
  ({ id, stage: stageName, category: 'security', severity, confidence: 1, evidence: { file: 'src/a.ts', line: 1 } });

const DIFF = ['--- a/src/a.ts', '+++ b/src/a.ts', '@@ -1,2 +1,3 @@', ' const x=1;', '+const y=2;', '+const z=3;'].join('\n');

async function runWith(stages: ReviewStage[], policy = ciPolicy) {
  const dir = mkdtempSync(join(tmpdir(), 'reviewdiff-'));
  const store = new VerdictStore(join(dir, '.devloop', 'events.jsonl'));
  const result = await runReviewDiff({
    diffText: DIFF, taskSpecId: 't1', pipeline: new ReviewPipeline(stages, policy), store, policy, repoPath: dir,
  });
  return { result, store };
}

describe('parseDiff', () => {
  it('unified diff → dosya başına eklenen satırlar', () => {
    const d = ['--- a/src/a.ts', '+++ b/src/a.ts', '@@ -1,2 +1,3 @@', ' const x=1;', '+const y=2;', '+const z=3;'].join('\n');
    expect(parseDiff(d)).toEqual([{ path: 'src/a.ts', addedContent: 'const y=2;\nconst z=3;' }]);
  });
  it('+++ /dev/null (silinen dosya) no-path skip — yol üretilmez, önceki dosyaya sızma olmaz', () => {
    const d = [
      'diff --git a/keep.ts b/keep.ts',
      '--- a/keep.ts', '+++ b/keep.ts', '@@ -1 +1,2 @@', ' const a=1;', '+const b=2;',
      'diff --git a/gone.ts b/gone.ts', 'deleted file mode 100644',
      '--- a/gone.ts', '+++ /dev/null', '@@ -1 +0,0 @@', '-gone();',
    ].join('\n');
    expect(parseDiff(d)).toEqual([{ path: 'keep.ts', addedContent: 'const b=2;' }]);
  });
  it('--- /dev/null (yeni dosya) — yol +++ b/ satırından alınır', () => {
    const d = ['--- /dev/null', '+++ b/new.ts', '@@ -0,0 +1 @@', '+hello();'].join('\n');
    expect(parseDiff(d)).toEqual([{ path: 'new.ts', addedContent: 'hello();' }]);
  });
});

describe('review-diff exit kodları', () => {
  it('gates pass + bulgu yok → exit 0', async () => {
    const { result, store } = await runWith([stage('risk-triage', 'gate', 'pass')]);
    expect(result.exitCode).toBe(0);
    expect(result.gateFailed).toBeNull();
    expect(result.findings).toEqual([]);
    // event zinciri: TaskPicked → ArtifactProduced → StageVerdict/RiskScored; runId ci-<task>
    expect(store.query({ runId: 'ci-t1', type: 'TaskPicked' }).length).toBe(1);
    const art = store.query({ runId: 'ci-t1', type: 'ArtifactProduced' })[0];
    const verdict = store.query({ runId: 'ci-t1', type: 'StageVerdict' })[0];
    const risk = store.query({ runId: 'ci-t1', type: 'RiskScored' })[0];
    expect(art).toBeDefined();
    expect(verdict.payload.parentArtifactEventId).toBe(art.event_id); // T-final D3: parentArtifactEventId zorunlu
    expect(risk.payload.parentArtifactEventId).toBe(art.event_id);
    // A3: tüm parent*EventId referansları gerçek event'lere işaret eder (brief'in 'ci' literal'i değil)
    expect(validateChain(store.readAll()).ok).toBe(true);
  });
  it('gate fail → exit 1', async () => {
    const { result, store } = await runWith([stage('risk-triage', 'gate', 'fail', [F('f1', 'required', 'risk-triage')])]);
    expect(result.exitCode).toBe(1);
    expect(result.gateFailed).toBe('risk-triage');
    // gate bulguları da kanıta yazılır
    expect(store.query({ runId: 'ci-t1', type: 'FindingEmitted' }).length).toBe(1);
  });
  it('advisory bulgu → exit 2', async () => {
    const { result, store } = await runWith(
      [stage('risk-triage', 'gate', 'pass'), stage('fake-advisory', 'advisory', 'pass', [F('f1', 'required')])], advPolicy);
    expect(result.exitCode).toBe(2);
    expect(result.gateFailed).toBeNull();
    expect(result.findings.map((f) => f.severity)).toEqual(['required']);
    expect(store.query({ runId: 'ci-t1', type: 'FindingEmitted' }).length).toBe(1);
  });
  it('critical bulgu (gate pass) → exit 1', async () => {
    const { result } = await runWith(
      [stage('risk-triage', 'gate', 'pass'), stage('fake-advisory', 'advisory', 'pass', [F('f1', 'critical')])], advPolicy);
    expect(result.exitCode).toBe(1);
    expect(result.gateFailed).toBeNull();
  });
});

describe('review-diff CLI (buildCli → process.exitCode)', () => {
  // policy.yaml tam şema ister (zod) — yük/tipler minimal geçerli politika.
  const policyYaml = (gates: string[]) => `version: 1
gates: [${gates.join(', ')}]
advisory: []
maxFixTours: 3
maxIterations: 10
budgetUsd: 2.0
wallClockMinutes: 30
risk: { weights: { diffSize: 0.3, testDiff: 0.5, scopePaths: 0.2 } }
llm: { provider: anthropic, model: m1, fallbackModel: m2, maxTokens: 1024, costPer1kInput: 0.001, costPer1kOutput: 0.002 }
`;

  function tmpRepo(gates: string[], diff: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'reviewdiff-cli-'));
    writeFileSync(join(dir, 'policy.yaml'), policyYaml(gates), 'utf8');
    writeFileSync(join(dir, 'pr.diff'), diff, 'utf8');
    return dir;
  }

  it('exit 0: gates pass + bulgu yok → process.exitCode "0"', async () => {
    const dir = tmpRepo(['risk-triage'], DIFF);
    const prev = process.exitCode;
    try {
      await buildCli(dir).parseAsync(['node', 'devloop', 'review-diff', '--diff', join(dir, 'pr.diff'), '--task', 't1']);
      expect(Number(process.exitCode)).toBe(0); // vitest worker exitCode'u number'a çevirir — üretimde String('0') kalır
    } finally { process.exitCode = prev; }
    const store = new VerdictStore(join(dir, '.devloop', 'events.jsonl'));
    expect(store.query({ runId: 'ci-t1', type: 'StageVerdict' })[0].payload.status).toBe('pass');
    expect(validateChain(store.readAll()).ok).toBe(true);
  });

  it('exit 1: sır içeren diff → secret-scan gate fail → process.exitCode "1"', async () => {
    const dir = tmpRepo(['risk-triage', 'secret-scan'], DIFF + "\n+const K = 'AKIAIOSFODNN7EXAMPLE';\n");
    const prev = process.exitCode;
    try {
      await buildCli(dir).parseAsync(['node', 'devloop', 'review-diff', '--diff', join(dir, 'pr.diff'), '--task', 't1']);
      expect(Number(process.exitCode)).toBe(1);
    } finally { process.exitCode = prev; }
    const store = new VerdictStore(join(dir, '.devloop', 'events.jsonl'));
    const secretVerdict = store.query({ runId: 'ci-t1', type: 'StageVerdict' }).find((e) => e.payload.stage === 'secret-scan');
    expect(secretVerdict?.payload.status).toBe('fail');
  });

  it('exit 2: test dosyası ekleyen diff → risk-triage required bulgu → process.exitCode "2"', async () => {
    const dir = tmpRepo(['risk-triage'], ['--- a/tests/x.test.ts', '+++ b/tests/x.test.ts', '@@ -1 +1,2 @@', ' const a=1;', '+const b=2;'].join('\n'));
    const prev = process.exitCode;
    try {
      await buildCli(dir).parseAsync(['node', 'devloop', 'review-diff', '--diff', join(dir, 'pr.diff'), '--task', 't1']);
      expect(Number(process.exitCode)).toBe(2);
    } finally { process.exitCode = prev; }
    const store = new VerdictStore(join(dir, '.devloop', 'events.jsonl'));
    const findings = store.query({ runId: 'ci-t1', type: 'FindingEmitted' });
    expect(findings.length).toBe(1);
    expect(findings[0].payload.finding.category).toBe('test-diff');
  });
});
