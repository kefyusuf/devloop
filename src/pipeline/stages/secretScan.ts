import { randomUUID } from 'node:crypto';
import type { ReviewStage, ReviewContext, StageResult } from '../../contracts/review.js';
import type { Finding } from '../../contracts/schemas.js';

// NOT: JS regex'te inline (?i) GEÇERSİZDİR — case-insensitivity 'i' flag ile verilir.
const PATTERNS: Array<[string, RegExp]> = [
  ['aws-access-key', /AKIA[0-9A-Z]{16}/],
  ['github-token', /gh[pousr]_[A-Za-z0-9]{36,}/],
  ['generic-secret-assignment', /(api[_-]?key|secret|password)\s*[:=]\s*["'][A-Za-z0-9+/]{16,}["']/i],
];

export class SecretScanStage implements ReviewStage {
  readonly name = 'secret-scan';
  readonly kind = 'gate' as const;
  async evaluate(ctx: ReviewContext): Promise<StageResult> {
    const t0 = Date.now();
    const findings: Finding[] = [];
    try {
      // Brief'in kendi testleri sırrı artifact.diff üzerinden verir — diff + dosya içerikleri birlikte taranır.
      const targets = [{ path: '(diff)', content: ctx.artifact.diff }, ...ctx.artifact.files];
      for (const [name, re] of PATTERNS) {
        for (const file of targets) {
          const m = re.exec(file.content);
          if (m) findings.push({ id: randomUUID(), stage: this.name, category: 'secret', severity: 'critical',
            confidence: 0.9, evidence: { file: file.path }, suggestion: `Olası sırr kalıbı (${name}); değeri vault/ortam değişkenine taşı.`, corroborated: false });
        }
      }
      return { status: findings.length === 0 ? 'pass' : 'fail', findings, durationMs: Date.now() - t0 };
    } catch (e) {
      return { status: 'error', findings: [], durationMs: Date.now() - t0, errorMessage: String(e) };
    }
  }
}
