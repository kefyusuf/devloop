import { z } from 'zod';

export const SEVERITY_ORDER = ['critical', 'required', 'optional', 'nit', 'fyi'] as const;
export const FindingSeverity = z.enum(SEVERITY_ORDER);

export const FindingSchema = z.object({
  id: z.string(), stage: z.string(), category: z.string(), severity: FindingSeverity,
  confidence: z.number().min(0).max(1),
  evidence: z.object({ file: z.string(), line: z.number().int().optional() }),
  suggestion: z.string().optional(),
  corroborated: z.boolean().default(false),
});
export type Finding = z.infer<typeof FindingSchema>;

export const TaskSpecSchema = z.object({
  id: z.string(), description: z.string(),
  acceptanceCriteria: z.array(z.string()).min(1),
  filesScope: z.array(z.string()).default([]),
});
export type TaskSpec = z.infer<typeof TaskSpecSchema>;

export const ArtifactSchema = z.object({
  diff: z.string(), intent: z.string(),
  rejectedAlternatives: z.array(z.string()), testEvidence: z.string(),
  files: z.array(z.object({ path: z.string(), content: z.string() })),
});
export type Artifact = z.infer<typeof ArtifactSchema>;

export const DecisionReason = z.enum(['false-positive', 'fixed-later', 'wrong-severity', 'real-issue-accepted', 'stale-lesson']);
export type DecisionReason = z.infer<typeof DecisionReason>;
