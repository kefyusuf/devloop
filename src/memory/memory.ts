import { writeFileSync } from 'node:fs';
import type { VerdictStore } from '../store/store.js';
import type { LessonsProvider } from '../generator/generator.js';
import type { EventPayloadMap } from '../contracts/events.js';
import type { DevloopEvent } from '../contracts/events.js';
import type { TaskSpec } from '../contracts/schemas.js';

type Lesson = EventPayloadMap['LessonLearned'];

/**
 * R4c (faz 3 T8 pin export): Unicode harf sınıfına göre tokenizasyon — `\P{L}+/u` ile böl,
 * uzunluk > 3 filtrele. Eski `\W+` ASCII'de kalıyordu: 'çağrılırken' gibi diakritikli kelimeler
 * ['','a','r','l','rken'] parçalanıyordu; `\p{L}` tüm dillerin harflerini tek token'da tutar.
 * Ders-metin eşleşmesi (contextFor) bu token'larla çalışır — export edilmesi pin'in kendisidir:
 * davranış değişirse test doğrudan kırılır.
 */
export function tokenize(text: string): string[] {
  return text.toLowerCase().split(/[^\p{L}]+/u).filter((w) => w.length > 3);
}

export class LessonMemory implements LessonsProvider {
  constructor(private readonly store: VerdictStore, private readonly lessonsFile: string) {}

  private latest(): Map<string, Lesson> {
    const map = new Map<string, Lesson>();
    for (const ev of this.store.query({ type: 'LessonLearned' })) {
      if (ev.type !== 'LessonLearned') continue; // union daraltma (strict tsc: payload.lessonId yoksa erişilemez)
      map.set(ev.payload.lessonId, ev.payload);
    }
    return map;
  }
  private active(target: 'generator' | 'reviewer'): Lesson[] {
    return [...this.latest().values()].filter((l) => l.status === 'active' && l.targetComponent === target);
  }

  contextFor(task: TaskSpec): string {
    // R4c: tokenize() üzerinden — \W+ ASCII'de kalmıştı; Unicode harf sınıfı diakritikli
    // kelimeleri tek token'da tutar (bkz. tokenize dokümantasyonu — R14 pin export).
    const words = tokenize(`${task.description} ${task.acceptanceCriteria.join(' ')}`);
    const lessons = this.active('generator');
    const relevant = lessons.filter((l) => words.some((w) => `${l.rule} ${l.scope}`.toLowerCase().includes(w)));
    const chosen = relevant.length > 0 ? relevant : lessons.slice(0, 5);
    return chosen.length === 0 ? 'Aktif ders yok.' : chosen.map((l) => `- [${l.scope}] ${l.rule}`).join('\n');
  }

  reviewerContext(): string {
    const lessons = this.active('reviewer');
    return lessons.length === 0 ? 'Reviewer dersi yok.' : lessons.map((l) => `- [${l.scope}] ${l.rule}`).join('\n');
  }

  render(): void {
    const g = this.active('generator');
    const r = this.active('reviewer');
    const lines = ['# devloop aktif dersler (otomatik üretilir — elle düzenlemeyin)', '', '## Generator', ...(g.length ? g.map((l) => `- [${l.scope}] ${l.rule}`) : ['(yok)']), '', '## Reviewer', ...(r.length ? r.map((l) => `- [${l.scope}] ${l.rule}`) : ['(yok)'])];
    writeFileSync(this.lessonsFile, lines.join('\n') + '\n', 'utf8');
  }

  async markRetired(lessonId: string, decisionEventIds: string[]): Promise<DevloopEvent> {
    const prev = this.latest().get(lessonId);
    if (!prev) throw new Error(`Ders bulunamadı: ${lessonId}`);
    const ev = await this.store.append('LessonLearned', 'learning', 'retire', 'learning', {
      lessonId, rule: prev.rule, scope: prev.scope, confidence: prev.confidence,
      status: 'retired', targetComponent: prev.targetComponent, parentDecisionEventIds: decisionEventIds,
    });
    this.render();
    return ev;
  }

  appendLesson(payload: EventPayloadMap['LessonLearned']): Promise<DevloopEvent> {
    return this.store.append('LessonLearned', 'learning', payload.lessonId, 'learning', payload);
  }
}
