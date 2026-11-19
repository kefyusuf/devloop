import { describe, it, expect, vi } from 'vitest';
import { ReviewPipeline, PipelineConfigError } from '../../src/pipeline/pipeline.js';
import { loadConfig } from '../../src/config/config.js';
import type { ReviewStage, ReviewContext } from '../../src/contracts/review.js';
import type { Finding } from '../../src/contracts/schemas.js';

const base = loadConfig(process.cwd()).policy;
const policy = { ...base, gates: ['static-gates', 'tests'], advisory: ['llm-reviewer'], authorizedSkips: [] };
const ctx: ReviewContext = {
  taskSpec: { id: 't', description: 'd', acceptanceCriteria: ['a'], filesScope: [] },
  artifact: { diff: 'x', intent: 'i', rejectedAlternatives: [], testEvidence: '', files: [] },
  repoPath: '.', riskScore: 10,
};
function stage(name: string, kind: 'gate' | 'advisory', status: 'pass' | 'fail' | 'error' | 'skipped', findings: Finding[] = [], calls: string[] = []): ReviewStage {
  return { name, kind, evaluate: vi.fn(async () => { calls.push(name); return { status, findings, durationMs: 1 }; }) };
}
const F = (id: string, stageName: string, category: string, severity: Finding['severity'], file = 'a.ts'): Finding =>
  ({ id, stage: stageName, category, severity, confidence: 1, evidence: { file, line: 1 } });

describe('ReviewPipeline fail-closed', () => {
  it('gate fail → advisory koşmaz, gateFailed set, passed=false', async () => {
    const calls: string[] = [];
    const p = new ReviewPipeline([stage('static-gates', 'gate', 'fail', [F('1', 'static-gates', 'lint', 'required')], calls), stage('tests', 'gate', 'pass', [], calls), stage('llm-reviewer', 'advisory', 'pass', [], calls)], policy);
    const r = await p.run(ctx);
    expect(r.gateFailed).toBe('static-gates');
    expect(calls).toEqual(['static-gates']);
    expect(r.passed).toBe(false);
  });
  it('gate ERROR → gateFailed (sessiz pass yok)', async () => {
    const p = new ReviewPipeline([stage('static-gates', 'gate', 'error'), stage('tests', 'gate', 'pass'), stage('llm-reviewer', 'advisory', 'pass')], policy);
    expect((await p.run(ctx)).gateFailed).toBe('static-gates');
  });
  it('stage hata mesajı verdict\'e taşınır (I5 — kanıt zinciri diagnoz edilebilir)', async () => {
    const errStage: ReviewStage = { name: 'static-gates', kind: 'gate', evaluate: vi.fn(async () => ({ status: 'error', findings: [], durationMs: 2, errorMessage: 'eslint patladı' })) };
    const r = await new ReviewPipeline([errStage], { ...policy, gates: ['static-gates'], advisory: [] }).run(ctx);
    expect(r.verdicts[0].errorMessage).toBe('eslint patladı');
    expect(r.verdicts[0].status).toBe('error');
  });
  it('hata olmayan stage verdict\'inde errorMessage yok (I5 — alan yalnız varsa yazılır)', async () => {
    const r = await new ReviewPipeline([stage('static-gates', 'gate', 'pass')], { ...policy, gates: ['static-gates'], advisory: [] }).run(ctx);
    expect(r.verdicts[0].errorMessage).toBeUndefined();
  });
  it('yetkisiz skip → fail', async () => {
    const p = new ReviewPipeline([stage('static-gates', 'gate', 'skipped'), stage('tests', 'gate', 'pass'), stage('llm-reviewer', 'advisory', 'pass')], policy);
    expect((await p.run(ctx)).gateFailed).toBe('static-gates');
  });
  it('yetkili skip (authorizedSkips) → geçer', async () => {
    const p2 = { ...policy, gates: ['static-gates'], advisory: [], authorizedSkips: ['static-gates'] }; // hüküm: brief p2'si spread ile advisory:['llm-reviewer'] devralıyordu ama stage vermiyordu — A2 gereği PipelineConfigError'ydi; yazarın niyeti (yalnızca static-gates politikası) tamamlandı
    const r = await new ReviewPipeline([stage('static-gates', 'gate', 'skipped')], p2).run(ctx);
    expect(r.passed).toBe(true);
  });
  it('politikada eksik stage → PipelineConfigError (sessiz atlama yok)', async () => {
    const pipeline = new ReviewPipeline([stage('tests', 'gate', 'pass')], policy);
    await expect(pipeline.run(ctx)).rejects.toBeInstanceOf(PipelineConfigError);
  });
  it('hepsi geçince advisory koşar; dedupe en şiddetliyi birebir korur', async () => {
    const calls: string[] = [];
    const s1 = stage('static-gates', 'gate', 'pass', [F('1', 'static-gates', 'lint', 'optional')], calls);
    const s2 = stage('llm-reviewer', 'advisory', 'pass', [F('2', 'llm-reviewer', 'lint', 'critical')], calls);
    const r = await new ReviewPipeline([s1, stage('tests', 'gate', 'pass', [], calls), s2], policy).run(ctx); // hüküm: brief listesinde politikadaki 'tests' gate'i eksikti — A2 gereği PipelineConfigError'ydi; "hepsi geçince advisory koşar" niyeti tamamlandı
    expect(r.passed).toBe(true);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].severity).toBe('critical');
    expect(r.findings[0].stage).toBe('llm-reviewer'); // kazanan bulgu birebir (v1 çelişkisi giderildi)
  });
  it('farklı kategori bulgular çelişki sayılıp korunur', async () => {
    const r = await new ReviewPipeline([stage('static-gates', 'gate', 'pass', [F('1', 'static-gates', 'lint', 'optional')]), stage('tests', 'gate', 'pass'), stage('llm-reviewer', 'advisory', 'pass', [F('2', 'llm-reviewer', 'security', 'required')])], policy).run(ctx);
    expect(r.findings).toHaveLength(2);
  });
});
