/**
 * Mitteilung einer geplanten Aufgabe angetippt → Bo öffnen, Seitenleiste auf
 * „Geplant", diese Aufgabe aufgeschlagen.
 *
 * Ein Ereignis plus ein gemerkter Wunsch: Ist Bo noch nicht gebaut (Kaltstart
 * über die Mitteilung), holt er den Wunsch beim Aufbau selbst ab.
 */
let pending: string | null = null;
const listeners = new Set<(taskId: string) => void>();

export function requestScheduledTask(taskId: string): void {
  pending = taskId;
  for (const l of listeners) l(taskId);
}

/** Gibt den Wunsch heraus und vergisst ihn — die Seitenleiste öffnet ihn genau einmal. */
export function takeScheduledTask(): string | null {
  const id = pending;
  pending = null;
  return id;
}

export function hasScheduledTaskRequest(): boolean {
  return pending !== null;
}

export function onScheduledTaskRequest(listener: (taskId: string) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
