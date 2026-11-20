import { describe, it, expect } from 'vitest';
import { composeReviewerLessons, type LessonsSource } from '../../src/shell/composeLessons.js';

// R22 (faz 4 T3): 'yok.' filtresi SATIR bazlıdır — blok düşürme yok. Eski CLI kompozisyonu
// `[mem.reviewerContext(), playbooks.reviewerContext()].filter((s) => !s.includes('yok.'))`
// substring kapısıydı: tek kaynaktaki 'yok.' bildirimi DİĞER kaynağın gerçek ders satırlarını da
// düşürüyordu (blok düşürme). composeReviewerLessons satırları düzleştirir, 'yok.' içeren satırı
// atar, diğerlerini korur; hiç satır kalmazsa 'Reviewer dersi yok.' sentineli döner.
// DERSLER header'ı stage seviyesinde eklenir (llmReviewer/llmReviewerAlt) — compose çıktısı ham
// satırlardır (header içermez).
describe('composeReviewerLessons (R22 — per-line yok. filtresi)', () => {
  it('blok düşürme yok: mem dersi + boş playbooks → ders satırı korunur, yok. satırı atılır', () => {
    const mem: LessonsSource = { reviewerContext: () => '- [reviewer] off-by-one bulgusunda kanıt eşiğini yükselt' };
    const playbooks: LessonsSource = { reviewerContext: () => 'Reviewer playbook önerisi yok.' };
    const out = composeReviewerLessons([mem, playbooks]).reviewerContext();
    expect(out).toContain('off-by-one');
    expect(out).not.toContain('yok.');
  });

  it('per-line filtre: tüm kaynaklar düzleştirilir — yok. içeren satırlar atılır, gerçek satırlar korunur', () => {
    const mem: LessonsSource = { reviewerContext: () => 'Reviewer dersi yok.\n- [reviewer] gerçek ders satırı' };
    const playbooks: LessonsSource = { reviewerContext: () => '- playbook satırı\nReviewer playbook önerisi yok.' };
    const out = composeReviewerLessons([mem, playbooks]).reviewerContext();
    expect(out.split('\n')).toEqual(['- [reviewer] gerçek ders satırı', '- playbook satırı']);
  });

  it('tüm kaynaklar boş/yok. → "Reviewer dersi yok." sentinel', () => {
    const out = composeReviewerLessons([
      { reviewerContext: () => 'Reviewer dersi yok.' },
      { reviewerContext: () => 'Reviewer playbook önerisi yok.' },
      { reviewerContext: () => '' },
    ]).reviewerContext();
    expect(out).toBe('Reviewer dersi yok.');
  });

  it('çok satırlı iki kaynak sırayla birleşir; boş satırlar atılır', () => {
    const out = composeReviewerLessons([
      { reviewerContext: () => '- ders-1\n\n- ders-2' },
      { reviewerContext: () => '- playbook-1\n- playbook-2' },
    ]).reviewerContext();
    expect(out.split('\n')).toEqual(['- ders-1', '- ders-2', '- playbook-1', '- playbook-2']);
  });
});
