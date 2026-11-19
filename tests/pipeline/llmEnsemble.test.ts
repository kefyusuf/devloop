import { describe, it, expect, vi } from 'vitest';
import { LlmEnsembleStage } from '../../src/pipeline/stages/llmEnsemble.js';
import { loadConfig } from '../../src/config/config.js';
import type { ReviewStage, ReviewContext } from '../../src/contracts/review.js';
import type { Finding } from '../../src/contracts/schemas.js';

const policy = loadConfig(process.cwd()).policy;
const ctx = (risk: number): ReviewContext => ({
  taskSpec: { id: 't', description: 'd', acceptanceCriteria: ['a'], filesScope: [] },
  artifact: { diff: 'x', intent: 'i', rejectedAlternatives: [], testEvidence: '', files: [] },
  repoPath: '.', riskScore: risk,
});
const mkStage = (name: string, findings: Finding[], calls: string[] = []): ReviewStage =>
  ({ name, kind: 'advisory' as const, evaluate: vi.fn(async () => { calls.push(name); return { status: 'pass', findings, durationMs: 1 }; }) });
const F = (id: string, stage: string, severity: Finding['severity'], corroborated = false): Finding =>
  ({ id, stage, category: 'security', severity, confidence: 0.9, evidence: { file: 'a.ts', line: 1 }, corroborated });

describe('LlmEnsembleStage', () => {
  it('risk < eşik ve primary bulgusuz → alt koşmaz', async () => {
    const calls: string[] = [];
    const ens = new LlmEnsembleStage(mkStage('llm-reviewer', [], calls), mkStage('llm-reviewer-alt', [], calls), policy);
    const r = await ens.evaluate(ctx(20));
    expect(calls).toEqual(['llm-reviewer']);
    expect(r.status).toBe('pass');
  });
  it('primary bulgulu → alt koşar; aynı kategori+konum iki tarafta → corroborated=true', async () => {
    const calls: string[] = [];
    const ens = new LlmEnsembleStage(
      mkStage('llm-reviewer', [F('1', 'llm-reviewer', 'required')], calls),
      mkStage('llm-reviewer-alt', [F('2', 'llm-reviewer-alt', 'required')], calls),
      policy,
    );
    const r = await ens.evaluate(ctx(20));
    expect(calls).toEqual(['llm-reviewer', 'llm-reviewer-alt']);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].corroborated).toBe(true);
  });
  // I2 (final fix wave, spec R2 "iki reviewer da işaretledi"): corroborated kanıtı ÇAPRAZ-STAGE
  // uzlaşmadır — aynı stage'in kendi içindeki aynı-anahtar kopyası kanıt DEĞİLDİR; alt koşsa bile
  // bulgusuz dönerse survivor'ın bayrağı false kalır (eski davranış aynı-stage kopyayı da kanıt sayıyordu).
  it('primary AYNI anahtarda İKİ bulgu + alt koşar ama bulgusuz → corroborated FALSE kalır', async () => {
    const calls: string[] = [];
    const ens = new LlmEnsembleStage(
      mkStage('llm-reviewer', [F('1', 'llm-reviewer', 'required'), F('2', 'llm-reviewer', 'required')], calls),
      mkStage('llm-reviewer-alt', [], calls),
      policy,
    );
    const r = await ens.evaluate(ctx(20));
    expect(calls).toEqual(['llm-reviewer', 'llm-reviewer-alt']); // alt koştu
    expect(r.findings).toHaveLength(1); // ama dedupe tek kazanan bıraktı
    expect(r.findings[0].corroborated).toBe(false); // R2: tek-stage uzlaşma kanıt değil
    expect(r.findings[0].stage).toBe('llm-reviewer');
  });
  it('risk ≥ eşik → bulgusuz da alt koşar', async () => {
    const calls: string[] = [];
    const ens = new LlmEnsembleStage(mkStage('llm-reviewer', [], calls), mkStage('llm-reviewer-alt', [], calls), policy);
    await ens.evaluate(ctx(policy.ensembleRiskThreshold));
    expect(calls).toEqual(['llm-reviewer', 'llm-reviewer-alt']);
  });
  it('her ikisi error → error; tek error → pass (graceful)', async () => {
    const errStage = (name: string): ReviewStage =>
      ({ name, kind: 'advisory' as const, evaluate: vi.fn(async () => ({ status: 'error' as const, findings: [], durationMs: 1, errorMessage: 'ağ' })) });
    const both = await new LlmEnsembleStage(errStage('llm-reviewer'), errStage('llm-reviewer-alt'), policy).evaluate(ctx(50));
    expect(both.status).toBe('error');
    const one = await new LlmEnsembleStage(errStage('llm-reviewer'), mkStage('llm-reviewer-alt', []), policy).evaluate(ctx(50));
    expect(one.status).toBe('pass');
  });
});
