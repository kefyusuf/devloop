import { z } from 'zod';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { LlmGateway } from '../gateway/gateway.js';
import type { Artifact, Finding, TaskSpec } from '../contracts/schemas.js';
import { ArtifactSchema } from '../contracts/schemas.js';

export interface LessonsProvider { contextFor(task: TaskSpec): string }

export interface GenerationContext {
  repoPath: string; repoTree: string; repoFiles: Array<{ path: string; content: string }>;
  lessons: string; feedback: Finding[];
  // R1 (bütçe doğruluğu): harcayan backend, gateway'i bağlamdan alır — orchestrator paylaşılan
  // (Budgeted)Gateway örneğini buradan iletir; yoksa ctor gateway'i, o da yoksa throw.
  gateway?: LlmGateway;
}
export interface GeneratorBackend {
  readonly id: string;
  generate(task: TaskSpec, ctx: GenerationContext): Promise<Artifact>;
}

const SKIP_DIRS = new Set(['node_modules', '.git', '.devloop', 'dist', 'build', 'coverage']);

export const REPO_LIMITS = { maxFiles: 40, maxBytesPerFile: 20_000, maxTotalBytes: 120_000 } as const;

export function readRepoContext(
  repoPath: string, filesScope: string[],
  limits: { maxFiles: number; maxBytesPerFile: number; maxTotalBytes: number } = REPO_LIMITS,
): Pick<GenerationContext, 'repoPath' | 'repoTree' | 'repoFiles'> {
  const files: Array<{ path: string; content: string }> = [];
  let total = 0;
  const walk = (dir: string) => {
    if (files.length >= limits.maxFiles || total >= limits.maxTotalBytes) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      const relPath = relative(repoPath, full).replaceAll(sep, '/');
      if (entry.isDirectory()) { if (!SKIP_DIRS.has(entry.name)) walk(full); continue; }
      if (!entry.isFile() || !/\.(ts|tsx|js|jsx|json|md|ya?ml)$/.test(entry.name)) continue;
      const inScope = filesScope.length === 0 || filesScope.some((s) => relPath === s || relPath.startsWith(s.endsWith('/') ? s : s + '/'));
      if (!inScope) continue;
      const stat = statSync(full);
      if (stat.size > limits.maxBytesPerFile || total + stat.size > limits.maxTotalBytes) continue;
      files.push({ path: relPath, content: readFileSync(full, 'utf8') });
      total += stat.size;
      if (files.length >= limits.maxFiles || total >= limits.maxTotalBytes) return;
    }
  };
  walk(repoPath);
  return { repoPath, repoTree: files.map((f) => f.path).join('\n'), repoFiles: files };
}

const GenOutput = z.object({
  intent: z.string(),
  rejectedAlternatives: z.array(z.string()),
  testEvidence: z.string(),
  files: z.array(z.object({ path: z.string(), content: z.string() })).min(1),
});

export class LlmGeneratorBackend implements GeneratorBackend {
  readonly id = 'llm';
  constructor(private readonly gateway: LlmGateway, private readonly memory?: LessonsProvider) {}

  async generate(task: TaskSpec, ctx: GenerationContext): Promise<Artifact> {
    // R1 (bütçe doğruluğu): ctx.gateway ?? ctor gateway — ikisi de yoksa generate edilemez.
    const gw = ctx.gateway ?? this.gateway;
    if (!gw) throw new Error('Generator için gateway yok (ctx.gateway veya ctor)');
    const lessons = ctx.lessons || this.memory?.contextFor(task) || 'Aktif ders yok.';
    const feedbackBlock = ctx.feedback.length === 0 ? '' :
      `ÖNCEKİ TUR BULGULARI (bunları çöz):\n${ctx.feedback.map((f) => `- [${f.severity}] ${f.category} @ ${f.evidence.file}:${f.evidence.line ?? '-'}: ${f.suggestion ?? ''}`).join('\n')}`;
    const repoBlock = [
      `REPO AĞACI:\n${ctx.repoTree || '(kapsamda dosya yok)'}`,
      `REPO DOSYA İÇERİKLERİ:\n${ctx.repoFiles.map((f) => `--- ${f.path} ---\n${f.content}`).join('\n\n') || '(boş)'}`,
    ].join('\n\n');
    const user = [
      `AKTİF DERSLER (önceki koşumlardan öğrenilenler — bunlara uy):\n${lessons}`,
      `GÖREV: ${task.description}`,
      `KABUL KRİTERLERİ:\n${task.acceptanceCriteria.map((a) => `- ${a}`).join('\n')}`,
      `DOSYA KAPSAMI: ${task.filesScope.join(', ') || 'tüm repo'}`,
      repoBlock,
      feedbackBlock,
      'YALNIZCA yukarıdaki gerçek dosya içerikleriyle tutarlı değişiklik üret; mevcut sınıf/fonksiyon imzalarını koru; testleri kırık davranışa uydurma.',
    ].filter(Boolean).join('\n\n');
    const { data } = await gw.complete({
      system: 'Sen bir yazılım geliştirme agent\'ısın. Küçük, odaklı değişiklikler yap.',
      user, schema: GenOutput, runId: task.id,
    });
    return ArtifactSchema.parse({ diff: '', intent: data.intent, rejectedAlternatives: data.rejectedAlternatives, testEvidence: data.testEvidence, files: data.files });
  }
}
