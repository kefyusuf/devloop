import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { FindingSchema, TaskSpecSchema, ArtifactSchema, DecisionReason } from './schemas.js';

const EnvBase = z.object({
  event_id: z.string(), schema_version: z.number(), ts: z.string(),
  run_id: z.string(), task_id: z.string(), actor: z.string(),
  idempotencyKey: z.string().optional(),
});

const P = {
  RunStarted: z.object({ configSnapshot: z.record(z.unknown()) }),
  TaskPicked: z.object({ taskSpec: TaskSpecSchema }),
  ArtifactProduced: z.object({ artifact: ArtifactSchema, parentTaskEventId: z.string() }),
  RiskScored: z.object({ score: z.number().min(0).max(100), signals: z.record(z.number()), policyVersion: z.string(), parentArtifactEventId: z.string() }),
  FindingEmitted: z.object({ finding: FindingSchema, parentArtifactEventId: z.string(), parentRiskEventId: z.string().optional() }),
  StageVerdict: z.object({ stage: z.string(), status: z.enum(['pass', 'fail', 'error', 'skipped']), durationMs: z.number(), errorMessage: z.string().optional() }),
  HumanDecision: z.object({ decision: z.enum(['accept', 'reject']), reason: DecisionReason, note: z.string().optional(), parentFindingEventIds: z.array(z.string()) }),
  PRCreated: z.object({ url: z.string().nullable(), title: z.string(), commitSha: z.string().nullable(), diffDigest: z.string() }),
  TaskBlocked: z.object({ reason: z.string(), parentArtifactEventId: z.string().optional() }),
  LessonLearned: z.object({
    lessonId: z.string(), rule: z.string(), scope: z.string(), confidence: z.number().min(0).max(1),
    status: z.enum(['candidate', 'active', 'retired']),
    targetComponent: z.enum(['generator', 'reviewer']),
    parentDecisionEventIds: z.array(z.string()), parentLessonEventId: z.string().optional(),
  }),
  EvalRun: z.object({ score: z.number(), comparison: z.record(z.unknown()) }),
  RunAborted: z.object({ reason: z.enum(['budget', 'kill', 'panic', 'wallclock']) }),
} as const;

export type EventType = keyof typeof P;
export type EventPayloadMap = { [K in EventType]: z.infer<(typeof P)[K]> };

function branch<K extends EventType>(type: K) {
  return EnvBase.extend({ type: z.literal(type), payload: P[type] });
}
export const DevloopEventSchema = z.union([
  branch('RunStarted'), branch('TaskPicked'), branch('ArtifactProduced'), branch('RiskScored'),
  branch('FindingEmitted'), branch('StageVerdict'), branch('HumanDecision'), branch('PRCreated'),
  branch('TaskBlocked'), branch('LessonLearned'), branch('EvalRun'), branch('RunAborted'),
]);
export type DevloopEvent = z.infer<typeof DevloopEventSchema>;

export function makeEnvelope(runId: string, taskId: string, actor: string, idempotencyKey?: string) {
  return {
    event_id: randomUUID(), schema_version: 1, ts: new Date().toISOString(),
    run_id: runId, task_id: taskId, actor, ...(idempotencyKey ? { idempotencyKey } : {}),
  };
}
export { P as EventPayloads };
