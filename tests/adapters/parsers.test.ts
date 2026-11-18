import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { parseEslintJson, parseTscOutput, parseVitestOutput } from '../../src/adapters/typescript/parsers.js';

describe('TS adapter parser\'ları', () => {
  it('eslint JSON → Finding[]', () => {
    // Brief'in '/r/src/a.ts' fixture'ı Windows'ta cwd'ye göre rel() ile 'src/a.ts' üretemez;
    // davranış sözleşmesi aynı: mutlak yol → cwd'ye göre göreceli yol.
    const raw = JSON.stringify([{ filePath: join(process.cwd(), 'src/a.ts'), messages: [{ ruleId: 'no-unused-vars', line: 4, message: "'x' is defined but never used", severity: 2 }] }]);
    const fs = parseEslintJson(raw);
    expect(fs[0]).toMatchObject({ category: 'lint', severity: 'required', evidence: { file: 'src/a.ts', line: 4 } });
  });
  it('tsc çıktısı → Finding[]', () => {
    const raw = 'src/b.ts(7,3): error TS2345: Argument of type "number" is not assignable to parameter of type "string".';
    const fs = parseTscOutput(raw);
    expect(fs[0].evidence).toEqual({ file: 'src/b.ts', line: 7 });
    expect(fs[0].severity).toBe('critical');
  });
  it('vitest özeti → passed + bulgular', () => {
    const r = parseVitestOutput('Tests  2 failed | 5 passed (7)', 'full');
    expect(r.passed).toBe(false);
    expect(r.findings[0].category).toBe('tests');
    expect(parseVitestOutput('Tests  3 passed (3)', '').passed).toBe(true);
  });
  it('temiz/bozuk çıktı → güvenli davranış', () => {
    expect(parseEslintJson('[]')).toEqual([]);
    expect(parseEslintJson('bozuk-json')).toEqual([]); // JSON.parse throw etmez
    expect(parseTscOutput('').length).toBe(0);
  });
  it('geçersiz eleman şekilli eslint JSON → güvenli davranış', () => {
    expect(parseEslintJson('[null]')).toEqual([]);
    expect(parseEslintJson('[{"filePath":"/x"}]')).toEqual([]);
  });
});
