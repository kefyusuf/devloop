import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { VerdictStore } from '../store/store.js';
import type { GoldenTask } from '../eval/golden.js';
import { GoldenTaskSchema } from '../eval/golden.js';
import type { DevloopEvent } from '../contracts/events.js';
import { canonicalJson } from '../util/canonicalJson.js'; // R26d: hash seed key-order duyarlılığı kapanır

// store.query() dönüş tipi daraltılmaz (payload union kalır) — cli.ts'teki EvalRunEvent deseni
// ile Extract + type-predicate filtresi kullanılır (bkz. src/shell/cli.ts evalRunToSummary).
type TaskPickedEvent = Extract<DevloopEvent, { type: 'TaskPicked' }>;
type ArtifactProducedEvent = Extract<DevloopEvent, { type: 'ArtifactProduced' }>;
type PRCreatedEvent = Extract<DevloopEvent, { type: 'PRCreated' }>;
type FindingEmittedEvent = Extract<DevloopEvent, { type: 'FindingEmitted' }>;
type HumanDecisionEvent = Extract<DevloopEvent, { type: 'HumanDecision' }>;

export function acceptedRuns(store: VerdictStore, fromRun?: string): string[] {
  const accepted = new Set(store.query({ type: 'HumanDecision' })
    .filter((e): e is HumanDecisionEvent => e.type === 'HumanDecision' && e.payload.decision === 'accept')
    .map((e) => e.run_id));
  const prd = new Set(store.query({ type: 'PRCreated' }).map((e) => e.run_id));
  return [...accepted].filter((r) => prd.has(r) && (fromRun === undefined || r === fromRun));
}

export async function generateGoldenDrafts(args: {
  store: VerdictStore; repoPath: string; draftsDir: string; fromRun?: string;
}): Promise<{ drafts: GoldenTask[]; written: number; skipped: number }> {
  const drafts: GoldenTask[] = [];
  let written = 0, skipped = 0;
  for (const runId of acceptedRuns(args.store, args.fromRun)) {
    // I1 (final fix wave, R17 binding): taslak üretimi GÖREV-BAZLIDIR — run'ın TÜM TaskPicked
    // event'leri gezilir (zarf task_id taşır; orchestrator 'TaskPicked' i task.id ile yazar).
    // Eski kod run başına yalnız İLK TaskPicked'i seçiyor, ArtifactProduced/PRCreated'i run
    // düzeyinde arıyor ve HumanDecision'ları TÜM run'dan tek taslağa yansıtıyordu: çok-görevli
    // kabul koşumunda 2..N görevler taslaksız kalıyor, task 2'nin false-positive reddi task 1'in
    // forbiddenCategories'ine düşüyordu. Her görevin expected'i YALNIZ kendi kararlarından türer.
    const picks = args.store.query({ runId, type: 'TaskPicked' }).filter((e): e is TaskPickedEvent => e.type === 'TaskPicked');
    for (const picked of picks) {
      const taskId = picked.task_id;
      const art = args.store.query({ runId, taskId, type: 'ArtifactProduced' }).find((e): e is ArtifactProducedEvent => e.type === 'ArtifactProduced');
      const pr = args.store.query({ runId, taskId, type: 'PRCreated' }).find((e): e is PRCreatedEvent => e.type === 'PRCreated');
      if (!art || !pr) { skipped++; continue; }
      const decisions = args.store.query({ runId, taskId, type: 'HumanDecision' }).filter((e): e is HumanDecisionEvent => e.type === 'HumanDecision');
      const byFinding = new Map(args.store.query({ runId, taskId, type: 'FindingEmitted' })
        .filter((e): e is FindingEmittedEvent => e.type === 'FindingEmitted')
        .map((e) => [e.event_id, e.payload.finding]));
      const required = new Set<string>();
      const forbidden = new Set<string>();
      for (const d of decisions) {
        for (const fid of d.payload.parentFindingEventIds) {
          const f = byFinding.get(fid);
          if (!f) continue;
          if (d.payload.reason === 'real-issue-accepted') required.add(f.category);
          if (d.payload.reason === 'false-positive') forbidden.add(f.category);
        }
      }
      const task = {
        // goldenId görev-bazlıdır: taskSpec + o görevin artifact diff'i — görev başına farklıdır.
        // R26d: taskSpec seed'i canonicalJson üzerinden — aynı içerik farklı key-sırasıyla gelse
        // de aynı goldenId (staging dosya adı determinizmi korunur).
        goldenId: createHash('sha256').update(canonicalJson(picked.payload.taskSpec) + art.payload.artifact.diff).digest('hex').slice(0, 16),
        taskSpec: picked.payload.taskSpec,
        fixtureDiff: art.payload.artifact.diff,
        expected: {
          gatesPass: true, // PRCreated yalnız gates pass sonrası açılır (A2)
          requiredFindings: [...required].map((c) => ({ category: c })),
          forbiddenCategories: [...forbidden],
        },
      };
      drafts.push(GoldenTaskSchema.parse(task));
    }
  }
  mkdirSync(args.draftsDir, { recursive: true });
  for (const d of drafts) {
    const p = join(args.draftsDir, `${d.goldenId}.task.json`);
    if (existsSync(p)) { skipped++; continue; }
    writeFileSync(p, JSON.stringify(d, null, 2), 'utf8');
    written++;
  }
  return { drafts, written, skipped };
}

export function acceptDraft(draftsDir: string, goldenDir: string, draftId: string): void {
  const src = join(draftsDir, `${draftId}.task.json`);
  // Brief testi sözleşmesi: zaten kabul edilmiş goldenId için ikinci accept çağrısı duplicate
  // hatası verir — staging dosyası rename ile taşındığından bu kontrol 'bulunamadı' kontrolünden
  // ÖNCE yapılmalıdır (draft dosya adı goldenId'nin kendisidir; üretim generateGoldenDrafts).
  if (existsSync(join(goldenDir, `${draftId}.task.json`))) {
    throw new Error(`Duplicate goldenId: ${draftId} — mevcut dosya: ${join(goldenDir, `${draftId}.task.json`)}`);
  }
  if (!existsSync(src)) throw new Error(`Taslak bulunamadı: ${draftId}`);
  const parsed = GoldenTaskSchema.parse(JSON.parse(readFileSync(src, 'utf8')));
  mkdirSync(goldenDir, { recursive: true });
  const dst = join(goldenDir, `${parsed.goldenId}.task.json`);
  if (existsSync(dst)) throw new Error(`Duplicate goldenId: ${parsed.goldenId} — mevcut dosya: ${dst}`);
  renameSync(src, dst);
}

export function discardDraft(draftsDir: string, draftId: string): void {
  rmSync(join(draftsDir, `${draftId}.task.json`), { force: true });
}

// R31 (faz 6 T1, T7 minor): golden-drafts staging okuma TEK KAPI — cli 'status' goldenDrafts
// sayacı ile 'golden list' ad listesi AYNI helper'ı kullanır (inline *.task.json filtresi
// duplicate'ti). Dizin yoksa [] (fail-soft — boş koşumda status/golden list davranışı aynen).
export function readGoldenDraftFiles(repoPath: string): string[] {
  const dir = join(repoPath, '.devloop', 'golden-drafts');
  try { return readdirSync(dir).filter((n) => n.endsWith('.task.json')); }
  catch { return []; }
}
