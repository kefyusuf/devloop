import { createHash, randomUUID } from 'node:crypto';
import type { ReviewPipeline } from '../pipeline/pipeline.js';
import type { Policy } from '../config/config.js';
import type { VerdictStore } from '../store/store.js';
import type { DevloopEvent } from '../contracts/events.js';
import type { Finding } from '../contracts/schemas.js';
import type { GoldenTask } from './golden.js';
import { loadGoldenTasks } from './golden.js';
import { parseDiff } from '../shell/reviewDiff.js';

export interface EvalSummary {
  evalId: string; goldenCount: number; passed: number; failed: number; score: number;
  // R15 fix round 1: şemaya uymayan golden dosya adları — koşum dışı bırakılma sessiz DEĞİL,
  // summary + EvalRun kanıtıyla raporlanır.
  invalid: string[];
  perTask: Array<{ goldenId: string; pass: boolean; reasons: string[] }>;
  configSnapshot: Record<string, unknown>; l3Active: boolean; comparedTo?: string;
}

export function scoreEval(
  result: { passed: boolean; findings: Finding[] },
  expected: GoldenTask['expected'],
): { pass: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (result.passed !== expected.gatesPass) reasons.push(`gate beklenenin tersi: pipeline ${result.passed ? 'pass' : 'fail'}, expected ${expected.gatesPass ? 'pass' : 'fail'}`);
  for (const req of expected.requiredFindings) {
    if (!result.findings.some((f) => f.category === req.category && (!req.severity || f.severity === req.severity))) {
      reasons.push(`required bulgu eksik: ${req.category}`);
    }
  }
  for (const cat of expected.forbiddenCategories) {
    if (result.findings.some((f) => f.category === cat)) reasons.push(`forbidden kategori ihlali: ${cat}`);
  }
  return { pass: reasons.length === 0, reasons };
}

export async function runEval(args: {
  repoPath: string; pipeline: ReviewPipeline; policy: Policy; store: VerdictStore;
  candidate?: { label: string }; l3MinGoldenTasks: number;
}): Promise<EvalSummary> {
  const { tasks, invalid } = loadGoldenTasks(args.repoPath);
  // R22 (faz 4 T3): seed'e randomUUID — aynı repo + aynı golden setten arka arkaya iki koşum
  // Date.now() aynı milisaniyeye düşerse evalId ÇAKIŞIRDI (hash girdisi aynıydı); UUID girdiye
  // karışır, evalId (ve runId) her koşumda benzersiz.
  const evalId = createHash('sha256').update(args.repoPath + tasks.length + invalid.join() + randomUUID()).digest('hex').slice(0, 12) + '-' + Date.now();
  const runId = `eval-${evalId}`;
  const configSnapshot = { ...(args.candidate ? { candidate: args.candidate.label } : { mode: 'production' }), policyHash: createHash('sha256').update(JSON.stringify(args.policy)).digest('hex').slice(0, 16) };

  const perTask: EvalSummary['perTask'] = [];
  for (const t of tasks) {
    const files = parseDiff(t.fixtureDiff).map((f) => ({ path: f.path, content: f.addedContent }));
    const artifact = { diff: t.fixtureDiff, intent: `eval:${t.goldenId}`, rejectedAlternatives: [], testEvidence: 'golden', files };
    const ctx = { taskSpec: t.taskSpec, artifact, repoPath: args.repoPath, riskScore: 0 };
    const result = await args.pipeline.run(ctx);
    const verdict = scoreEval({ passed: result.passed, findings: result.findings }, t.expected);
    // Hüküm (faz 2 T8 ile aynı): brief `parentTaskEventId: 'eval'` literal'i yazıyordu — A3 nedensel
    // bütünlük (validateChain) tüm parent*EventId referanslarının GERÇEK event'lere işaret etmesini
    // zorunlu kılar; reviewDiff.ts'teki CI koşumu gibi gerçek TaskPicked event_id'si kullanılır.
    const picked = await args.store.append('TaskPicked', runId, t.taskSpec.id, 'eval', { taskSpec: t.taskSpec });
    const art = await args.store.append('ArtifactProduced', runId, t.taskSpec.id, 'eval', { artifact, parentTaskEventId: picked.event_id });
    await args.store.append('StageVerdict', runId, t.taskSpec.id, 'eval', { stage: 'eval', status: result.passed ? 'pass' : 'fail', durationMs: 0, parentArtifactEventId: art.event_id });
    for (const f of result.findings) await args.store.append('FindingEmitted', runId, t.taskSpec.id, f.stage, { finding: f, parentArtifactEventId: art.event_id });
    perTask.push({ goldenId: t.goldenId, pass: verdict.pass, reasons: verdict.reasons });
  }

  const passed = perTask.filter((p) => p.pass).length;
  const failed = perTask.length - passed;
  const score = perTask.length === 0 ? 0 : Math.round((passed / perTask.length) * 1000) / 10;
  const l3Active = tasks.length >= args.l3MinGoldenTasks;
  // query tip daraltmaz (farklı payload union'ı) — EvalRun payload'una tip guard ile daraltılır
  const prevRuns = args.store.query({ type: 'EvalRun' }).filter((e): e is Extract<DevloopEvent, { type: 'EvalRun' }> => e.type === 'EvalRun')
    .filter((e) => !('candidate' in e.payload.configSnapshot));
  const comparedTo = args.candidate && prevRuns.length > 0 ? prevRuns[prevRuns.length - 1].payload.evalId : undefined;
  const summary: EvalSummary = { evalId, goldenCount: perTask.length, passed, failed, score, invalid, perTask, configSnapshot, l3Active, ...(comparedTo ? { comparedTo } : {}) };
  await args.store.append('EvalRun', runId, '-', 'eval', {
    evalId: summary.evalId, goldenCount: summary.goldenCount, passed, failed, score, invalid,
    perTask: summary.perTask, configSnapshot, ...(comparedTo ? { comparedTo } : {}),
  });
  return summary;
}
