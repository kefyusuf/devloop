import type { Artifact, Finding, TaskSpec } from './schemas.js';

export interface ReviewContext {
  taskSpec: TaskSpec; artifact: Artifact; repoPath: string;
  riskScore: number;
  riskSignals?: Record<string, number>; // RiskTriageStage doldurur — orchestrator gerçek skorla event yazar
}

export type StageStatus = 'pass' | 'fail' | 'error' | 'skipped';
export interface StageResult { status: StageStatus; findings: Finding[]; durationMs: number; errorMessage?: string }
export interface ReviewStage {
  readonly name: string;
  readonly kind: 'gate' | 'advisory';
  evaluate(ctx: ReviewContext): Promise<StageResult>;
}
