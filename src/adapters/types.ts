import type { Finding } from '../contracts/schemas.js';

export interface TestRunResult { passed: boolean; output: string; findings: Finding[] }
export interface StackAdapter {
  readonly id: string;
  lint(repoPath: string): Promise<Finding[]>;
  typecheck(repoPath: string): Promise<Finding[]>;
  runTests(repoPath: string): Promise<TestRunResult>;
}
