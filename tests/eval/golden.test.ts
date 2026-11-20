import { describe, it, expect } from 'vitest';
import { loadGoldenTasks } from '../../src/eval/golden.js';
import { writeFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const GOLDEN = {
  goldenId: 'g1',
  taskSpec: { id: 'gt1', description: 'd', acceptanceCriteria: ['a'], filesScope: [] },
  fixtureDiff: '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1,2 @@\n const x=1;\n+const y=2;',
  expected: { gatesPass: true, requiredFindings: [{ category: 'lint' }], forbiddenCategories: ['secret'] },
};

describe('loadGoldenTasks', () => {
  it('golden dizinini okur ve şemaya doğrular', () => {
    const dir = mkdtempSync(join(tmpdir(), 'golden-'));
    mkdirSync(join(dir, '.devloop', 'golden'), { recursive: true });
    writeFileSync(join(dir, '.devloop', 'golden', 'g1.task.json'), JSON.stringify(GOLDEN));
    const { tasks, invalid } = loadGoldenTasks(dir);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].goldenId).toBe('g1');
    expect(tasks[0].taskSpec.acceptanceCriteria).toEqual(['a']);
    expect(invalid).toEqual([]);
  });
  it('geçersiz görev dosyası invalid listesine düşer, atlanmaz-yazılmaz', () => {
    const dir = mkdtempSync(join(tmpdir(), 'golden2-'));
    mkdirSync(join(dir, '.devloop', 'golden'), { recursive: true });
    writeFileSync(join(dir, '.devloop', 'golden', 'bad.task.json'), '{"goldenId": "x"}');
    const { tasks, invalid } = loadGoldenTasks(dir);
    expect(tasks).toHaveLength(0);
    expect(invalid).toHaveLength(1);
  });

  // R17 (faz 4 T1): duplicate goldenId tespiti — aynı goldenId'li iki dosyadan yalnız ilki
  // tasks'a girer; ikincisi invalid listesine `duplicate:<id>` olarak yazılır.
  it('duplicate goldenId: ikinci kopya invalid listesine duplicate:<id> olarak düşer', () => {
    const dir = mkdtempSync(join(tmpdir(), 'golden3-'));
    mkdirSync(join(dir, '.devloop', 'golden'), { recursive: true });
    writeFileSync(join(dir, '.devloop', 'golden', 'g1.task.json'), JSON.stringify(GOLDEN));
    writeFileSync(join(dir, '.devloop', 'golden', 'g1-copy.task.json'), JSON.stringify({ ...GOLDEN }));
    const { tasks, invalid } = loadGoldenTasks(dir);
    expect(tasks).toHaveLength(1);
    expect(invalid).toEqual(['duplicate:g1']);
  });
});
