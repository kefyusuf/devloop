import { randomUUID } from 'node:crypto';
import { relative, isAbsolute } from 'node:path';
import type { Finding } from '../../contracts/schemas.js';
import type { TestRunResult } from '../types.js';

function rel(p: string): string { return isAbsolute(p) ? relative(process.cwd(), p).replaceAll('\\', '/') : p; }
function f(partial: Omit<Finding, 'id'>): Finding { return { id: randomUUID(), ...partial }; }

type EslintFile = { filePath: string; messages: Array<{ ruleId: string | null; line: number; message: string; severity: 1 | 2 }> };

export function parseEslintJson(raw: string): Finding[] {
  let files: EslintFile[];
  try { files = JSON.parse(raw) as EslintFile[]; } catch { return []; }
  if (!Array.isArray(files)) return [];
  return files.filter((x): x is EslintFile => !!x && typeof x === 'object' && Array.isArray(x.messages))
    .flatMap((file) => file.messages.map((m) => f({
    stage: 'static-gates', category: 'lint',
    severity: m.severity === 2 ? 'required' : 'optional',
    confidence: 1, evidence: { file: rel(file.filePath), line: m.line },
    suggestion: `eslint:${m.ruleId ?? 'parse'} — ${m.message}`, corroborated: false,
  })));
}

export function parseTscOutput(raw: string): Finding[] {
  return raw.split('\n').flatMap((line) => {
    const m = /^(.+?)\((\d+),\d+\):\s+error\s+(TS\d+):\s+(.+)$/.exec(line.trim());
    if (!m) return [];
    return [f({ stage: 'static-gates', category: 'typecheck', severity: 'critical', confidence: 1,
      evidence: { file: rel(m[1]), line: Number(m[2]) }, suggestion: `tsc ${m[3]}: ${m[4]}`, corroborated: false })];
  });
}

export function parseVitestOutput(summary: string, fullOutput: string): TestRunResult {
  const m = /(\d+)\s+failed/.exec(summary);
  const failed = m ? Number(m[1]) : 0;
  const findings: Finding[] = failed > 0 ? [f({
    stage: 'tests', category: 'tests', severity: 'critical', confidence: 1,
    evidence: { file: '(test-output)' }, suggestion: `${failed} test başarısız — çıktı: ${fullOutput.slice(0, 2000)}`, corroborated: false,
  })] : [];
  return { passed: failed === 0 && /passed|no tests/i.test(summary), output: fullOutput, findings };
}
