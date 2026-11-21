import { REVIEWER_DERSI_YOK } from './sentinels.js'; // R26a: sentineller tek kaynakta

// R22 (faz 4 T3): 'yok.' filtresi SATIR bazlı — kompozisyon helper. Eski CLI kompozisyonu
// `[mem.reviewerContext(), playbooks.reviewerContext()].filter((s) => !s.includes('yok.'))`
// substring kapısıydı: TEK kaynaktaki 'yok.' bildirimi ('Reviewer playbook önerisi yok.')
// DİĞER kaynağın gerçek ders satırlarını da düşürüyordu (blok düşürme). Burada kaynaklar satırlara
// düzleştirilir; boş satırlar ve 'yok.' içeren satırlar atılır, gerçek satırlar korunur. Hiç satır
// kalmazsa REVIEWER_DERSI_YOK sentineli döner (eski tek-kaynak sentineliyle aynı anlam).
// DERSLER header'ı stage seviyesinde eklenir (llmReviewer/llmReviewerAlt) — compose çıktısı ham
// satırlardır (header içermez); per-line filtre satır bazında çalışır, blok düşürme yok.
export interface LessonsSource { reviewerContext(): string }

export function composeReviewerLessons(sources: LessonsSource[]): { reviewerContext(): string } {
  return {
    reviewerContext: () => {
      const lines = sources.flatMap((s) => s.reviewerContext().split('\n'))
        .filter((l) => l.trim().length > 0 && !l.includes('yok.'));
      return lines.length === 0 ? REVIEWER_DERSI_YOK : lines.join('\n');
    },
  };
}
