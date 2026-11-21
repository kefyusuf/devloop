// R26a (faz 5 T2): paylaşılan sentineller — TEK kaynak. Tüketici literalleri buradan okur
// (composeLessons fallback, evolve generatorContext/reviewer sentinelleri, generator
// exact-sentinel gating, LessonMemory.reviewerContext); literal'i değiştirmek için tek yer.
// DEĞER PIN: tests/shell/sentinels.test.ts sabit değerlerini literallerle pin'ler + tüketici
// davranışlarını sabit üzerinden doğrular (drift → test kırılır, değişiklik bilinçli olur).

export const REVIEWER_DERSI_YOK = 'Reviewer dersi yok.';
export const GENERATOR_PLAYBOOK_YOK = 'Generator playbook önerisi yok.';
export const REVIEWER_PLAYBOOK_YOK = 'Reviewer playbook önerisi yok.';
