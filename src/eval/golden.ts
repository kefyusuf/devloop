import { z } from 'zod';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TaskSpecSchema } from '../contracts/schemas.js';

export const GoldenTaskSchema = z.object({
  goldenId: z.string(),
  taskSpec: TaskSpecSchema,
  fixtureDiff: z.string(),
  expected: z.object({
    gatesPass: z.boolean(),
    requiredFindings: z.array(z.object({ category: z.string(), severity: z.string().optional() })),
    forbiddenCategories: z.array(z.string()).default([]),
  }),
});
export type GoldenTask = z.infer<typeof GoldenTaskSchema>;

export function loadGoldenTasks(repoPath: string): { tasks: GoldenTask[]; invalid: string[] } {
  const dir = join(repoPath, '.devloop', 'golden');
  const tasks: GoldenTask[] = [];
  const invalid: string[] = [];
  let names: string[] = [];
  try { names = readdirSync(dir).filter((n) => n.endsWith('.task.json')); } catch { return { tasks, invalid }; }
  for (const name of names) {
    try { tasks.push(GoldenTaskSchema.parse(JSON.parse(readFileSync(join(dir, name), 'utf8')))); }
    catch { invalid.push(name); }
  }
  // R17 (faz 4 T1): duplicate goldenId tespiti — aynı goldenId'li ikinci (ve sonraki) dosyalar
  // tasks'a GİRMEZ; invalid listesine `duplicate:<id>` olarak yazılır (sessiz hariç tutum yok:
  // eval harness zayıf sinyali rapor etsin). Kopya üzerinde yinelenir, orijinalden splice edilir.
  const seen = new Set<string>();
  for (const t of [...tasks]) {
    if (seen.has(t.goldenId)) { invalid.push(`duplicate:${t.goldenId}`); tasks.splice(tasks.indexOf(t), 1); }
    else seen.add(t.goldenId);
  }
  return { tasks, invalid };
}
