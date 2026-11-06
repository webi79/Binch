/**
 * Texte rund um Bos geplante Aufgaben: Wochentage, Zeitplan, Stand eines Laufs.
 */
import { format, isToday, isYesterday } from "date-fns";
import { de, enUS, es, fr } from "date-fns/locale";
import type { BoTask, TaskProposal } from "@/lib/api/chats";

type T = (key: string) => string;
const LOCALES = { de, en: enUS, fr, es } as const;

/** Mo = 1 … So = 64 — wie am Server. */
const WEEKDAYS = 31;
const WEEKEND = 96;
const DAILY = 127;

export function daysLabel(days: number, t: T): string {
  if (days === DAILY) return t("bo.task.days.daily");
  if (days === WEEKDAYS) return t("bo.task.days.weekdays");
  if (days === WEEKEND) return t("bo.task.days.weekend");
  const names: string[] = [];
  for (let i = 0; i < 7; i++) if (days & (1 << i)) names.push(t(`bo.task.day.${i + 1}`));
  return names.join(", ");
}

/** „Werktags · 8:00" oder mit Wache „Werktags · 16:30–18:30". */
export function scheduleLabel(task: Pick<TaskProposal, "days" | "time" | "watchUntil">, t: T): string {
  const time = stripZero(task.time);
  const range = task.watchUntil ? `${time}–${stripZero(task.watchUntil)}` : time;
  return `${daysLabel(task.days, t)} · ${range}`;
}

/** „08:00" → „8:00" — so stehen Uhrzeiten überall in der App. */
export function stripZero(hm: string): string {
  return hm.startsWith("0") ? hm.slice(1) : hm;
}

/** „Heute 8:00", „Gestern 8:00", „Do 8:00" — für Verlauf und Liste. */
export function whenLabel(iso: string, locale: string, t: T): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "";
  const loc = LOCALES[locale as keyof typeof LOCALES] ?? enUS;
  const time = format(d, "H:mm", { locale: loc });
  if (isToday(d)) return `${t("bo.task.today")} ${time}`;
  if (isYesterday(d)) return `${t("bo.task.yesterday")} ${time}`;
  return `${format(d, "EEEEEE", { locale: loc })} ${time}`;
}

export function notifyLabel(task: Pick<BoTask, "notify">, t: T): string {
  return t(task.notify === "always" ? "bo.task.notify.always" : "bo.task.notify.issues");
}

/** Die Zeitzone dieses Geräts — der Zeitplan einer Aufgabe gilt in ihr. */
export function deviceTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "Europe/Berlin";
  } catch {
    return "Europe/Berlin";
  }
}
