import { appendFileSync, existsSync, readFileSync, mkdirSync, openSync, readSync, fstatSync, closeSync } from 'node:fs';
import { dirname } from 'node:path';
import { DevloopEventSchema, makeEnvelope, type DevloopEvent, type EventPayloadMap, type EventType } from '../contracts/events.js';

export class VerdictStore {
  constructor(private readonly logPath: string) {}

  /** Kuyruk güvenli mi? Dosya yoksa/boşsa true; son bayt '\n' değilse (yırtık yazım) false. Tail okunamıyorsa false — guard'ı tetikle (kayıpsız yazım). */
  private tailIsClean(): boolean {
    if (!existsSync(this.logPath)) return true;
    let fd: number | undefined;
    try {
      fd = openSync(this.logPath, 'r');
      const size = fstatSync(fd).size;
      if (size === 0) return true;
      const buf = Buffer.alloc(1);
      readSync(fd, buf, 0, 1, size - 1); // yalnız son 1 bayt — tüm dosyayı okumadan
      return buf[0] === 0x0a;
    } catch {
      return false;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }

  async append<K extends EventType>(
    type: K, runId: string, taskId: string, actor: string,
    payload: EventPayloadMap[K], idempotencyKey?: string,
  ): Promise<DevloopEvent> {
    if (idempotencyKey) {
      const dup = this.readAll().find((e) => e.idempotencyKey === idempotencyKey);
      if (dup) return dup;
    }
    const candidate = { ...makeEnvelope(runId, taskId, actor, idempotencyKey), type, payload };
    const ev = DevloopEventSchema.parse(candidate); // yazmada katı
    mkdirSync(dirname(this.logPath), { recursive: true });
    // Yırtık kuyruk guard'ı: önceki yazım yarıda kaldiysa (newline'sız fragman),
    // yeni event fragmana yapışıp İKİSİNİN de okunamaz olmasını engelle (A3 — kayıpsız resume).
    const data = (this.tailIsClean() ? '' : '\n') + JSON.stringify(ev) + '\n';
    appendFileSync(this.logPath, data, 'utf8');
    return ev;
  }

  readAll(): DevloopEvent[] {
    if (!existsSync(this.logPath)) return [];
    const out: DevloopEvent[] = [];
    for (const line of readFileSync(this.logPath, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let raw: unknown;
      try { raw = JSON.parse(line); } catch { continue; } // bozuk satır atılır — throw yok (A3)
      const parsed = DevloopEventSchema.safeParse(raw);
      if (parsed.success) out.push(parsed.data);
    }
    return out;
  }

  events(f: { runId?: string; taskId?: string; type?: EventType }): DevloopEvent[] {
    return this.readAll().filter((e) =>
      (f.runId === undefined || e.run_id === f.runId) &&
      (f.taskId === undefined || e.task_id === f.taskId) &&
      (f.type === undefined || e.type === f.type));
  }
}

/** Nedensel bütünlük (A3): tüm parent*EventId referansları gerçek event'lere mi işaret ediyor? */
export function validateChain(events: DevloopEvent[]): { ok: boolean; errors: string[] } {
  const ids = new Set(events.map((e) => e.event_id));
  const errors: string[] = [];
  const add = (child: string, parent: unknown) => {
    if (typeof parent === 'string' && parent.length > 0 && !ids.has(parent)) {
      // parent ID'si tam halde raporlanır (test sözleşmesi: errors[0] 'yok-boyle-event' içerir)
      errors.push(`${child.slice(0, 8)} → eksik parent ${parent}`);
    }
  };
  const arrayFields = ['parentFindingEventIds', 'parentDecisionEventIds'];
  const scalarFields = ['parentTaskEventId', 'parentArtifactEventId', 'parentRiskEventId', 'parentLessonEventId'];
  for (const e of events) {
    const p = e.payload as Record<string, unknown>;
    for (const k of scalarFields) add(e.event_id, p[k]);
    for (const k of arrayFields) {
      if (Array.isArray(p[k])) for (const x of p[k] as unknown[]) add(e.event_id, x);
    }
  }
  return { ok: errors.length === 0, errors };
}
