/**
 * Das Blatt der geplanten Aufgaben und was es der Seite darunter zu sagen hat.
 *
 * Das Blatt hängt am Wurzel-Layout (`TaskSheetHost`), damit Ortswähler und Dialoge
 * darüber aufgehen können; geöffnet wird es aus Bos Bildschirm heraus. Ein
 * Verteiler verbindet beide, ohne dass der Bildschirm mitrendert.
 */
import { useEffect, useState } from "react";
import type { BoTask, BoTaskNotify } from "@/lib/api/chats";

export interface TaskPlace {
  code: string;
  label: string;
}

/** Vorbelegung des Formulars — alles Fehlende kommt aus den Vorgaben. */
export interface TaskDraft {
  title?: string;
  origin?: TaskPlace | null;
  destination?: TaskPlace | null;
  days?: number;
  time?: string;
  watchUntil?: string | null;
  notify?: BoTaskNotify;
}

export type TaskSheetRequest =
  | { kind: "new"; draft?: TaskDraft }
  | { kind: "edit"; task: BoTask }
  | { kind: "detail"; taskId: string };

interface SheetState {
  request: TaskSheetRequest | null;
  /** Zählt je Auftrag hoch: Ein neuer Auftrag ist ein frisches Formular. */
  session: number;
}

/**
 * Zwei Blätter: das Haupt-Blatt (neue Aufgabe, Verlauf) und darüber das zum
 * Ändern — „Ändern" im Verlauf fährt ein EIGENES Blatt von unten herein, statt
 * den Inhalt darunter auszutauschen.
 */
export type TaskSheetSlot = "main" | "edit";

let state: Record<TaskSheetSlot, SheetState> = {
  main: { request: null, session: 0 },
  edit: { request: null, session: 0 },
};
const sheetListeners = new Set<() => void>();

function publish(slot: TaskSheetSlot, next: SheetState): void {
  state = { ...state, [slot]: next };
  for (const fn of sheetListeners) fn();
}

export function openTaskSheet(request: TaskSheetRequest): void {
  const slot: TaskSheetSlot = request.kind === "edit" ? "edit" : "main";
  publish(slot, { request, session: state[slot].session + 1 });
}

/** Ohne Angabe beide — etwa wenn Bo geschlossen wird. */
export function closeTaskSheet(slot?: TaskSheetSlot): void {
  for (const s of slot ? [slot] : (["edit", "main"] as const)) {
    if (state[s].request) publish(s, { ...state[s], request: null });
  }
}

export function useTaskSheet(slot: TaskSheetSlot = "main"): SheetState {
  const [current, set] = useState(state[slot]);
  useEffect(() => {
    const fn = () => set(state[slot]);
    fn();
    sheetListeners.add(fn);
    return () => {
      sheetListeners.delete(fn);
    };
  }, [slot]);
  return current;
}

/** Ein Ereignis — für die beiden Meldungen unten. */
function makeSignal<T>() {
  const listeners = new Set<(value: T) => void>();
  return {
    /** @returns Hört überhaupt jemand zu? */
    emit(value: T): boolean {
      for (const fn of listeners) fn(value);
      return listeners.size > 0;
    },
    on(fn: (value: T) => void): () => void {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
}

const taskRemoved = makeSignal<string>();
const askBo = makeSignal<void>();

/** Das Blatt ist unten — jetzt darf die Karte gehen, danach der Platz frei werden. */
export const announceTaskRemoved = (id: string) => taskRemoved.emit(id);
export const onTaskRemoved = taskRemoved.on;

/** „Lieber sagen": neuer Chat, das Feld ist schon angefangen. */
export const requestAskBo = () => askBo.emit();
export const onAskBo = askBo.on;
