/**
 * ABFAHRTS- und AUSSTIEGS-ERINNERUNGEN für gespeicherte Reisen und Tickets.
 *
 * Profil → Einstellungen → Mitteilungen: „Vor der Abfahrt erinnern" (aus, 10,
 * 30, 60 Min.) und „Vor dem Aussteigen erinnern" (aus, 5, 10 Min.).
 *
 * VERSCHICKT VOM SERVER, nicht lokal geplant. Die erste Fassung (28.10.2026
 * mittags) stellte lokale Wecker — ohne Recht auf exakte Wecker plant Android
 * die aber nur ungefähr, und Xiaomi hält sie bei geschlossener App ganz
 * zurück: Beim Test kam keine an. Ein Push vom Server nimmt denselben Weg wie
 * die Preisalarme, und der kommt an. Der Server bekommt dafür bis zum Versand
 * nur, was in der Meldung steht (server/src/services/tripReminders.ts).
 *
 * ABGLEICH STATT BUCHFÜHRUNG: Bei jeder Änderung (Reise gespeichert oder
 * entfernt, Ticket, Vorlauf, Sprache, Meldungen an/aus) schickt die App die
 * GANZE Liste, und der Server ersetzt damit die alte. Kein gemerkter Zustand,
 * der aus dem Tritt geraten könnte. Titel und Text schreibt die App — in ihrer
 * Sprache, mit der Ortszeit des Halts.
 *
 * Verspätungen und Gleiswechsel kennt die Erinnerung nicht; es gilt die
 * Fahrplanzeit.
 */
import { useEffect } from "react";
import { Platform } from "react-native";
import * as Notifications from "expo-notifications";
import { useSearchStore } from "@/stores/searchStore";
import { dictionaries } from "@/lib/i18n/dict";
import { formatTimeInZone } from "@/lib/time-format";
import { API_BASE_URL } from "@/lib/api/client";
import { registeredPushToken } from "@/lib/notifications/push";
import type { TravelMode } from "@/types/search";

export const REMINDER_LEADS = [0, 10, 30, 60] as const;
export type ReminderLead = (typeof REMINDER_LEADS)[number];
export const ARRIVAL_LEADS = [0, 5, 10] as const;
export type ArrivalLead = (typeof ARRIVAL_LEADS)[number];

const LOCAL_TYPE = "tripReminder";
const CHANNEL = "trip-reminders";
/** Weiter voraus wird nicht hinterlegt — so weit plant niemand, und der Server nimmt es nicht. */
const HORIZON_MS = 59 * 86_400_000;

interface Leg {
  key: string;
  departAt: number;
  arriveAt: number | null;
  what: string | null;
  mode: TravelMode;
  origin: string;
  dest: string;
  originTz?: string;
  destTz?: string;
}

interface Item {
  key: string;
  kind: "departure" | "arrival";
  fireAt: string;
  expiresAt: string;
  title: string;
  body: string;
}

type St = ReturnType<typeof useSearchStore.getState>;

function legs(st: St): Leg[] {
  const out: Leg[] = [];
  const time = (iso?: string) => {
    const v = iso ? Date.parse(iso) : NaN;
    return Number.isFinite(v) ? v : null;
  };
  for (const trip of st.savedTrips) {
    // Nur mit echter Uhrzeit — „irgendwann an diesem Tag" ist kein Zeitpunkt.
    const at = trip.dateOnly ? null : time(trip.departTime);
    if (at == null) continue;
    out.push({
      key: `trip:${trip.id}`,
      departAt: at,
      arriveAt: trip.dateOnly ? null : time(trip.arriveTime),
      what: trip.flightNumber ?? null,
      mode: trip.mode,
      origin: trip.originLabel,
      dest: trip.destLabel,
      originTz: trip.originTz,
      destTz: trip.destinationTz,
    });
  }
  for (const tk of st.tickets) {
    const at = time(tk.departTime);
    if (at == null) continue;
    out.push({
      key: `ticket:${tk.id}`,
      departAt: at,
      arriveAt: time(tk.arriveTime),
      what: tk.flightNumber ?? null,
      mode: tk.mode,
      origin: tk.fromStation ?? tk.fromCity ?? tk.fromCode ?? "",
      dest: tk.toCity ?? tk.toCode ?? "",
      originTz: tk.originTz,
      destTz: tk.destinationTz,
    });
  }
  return out;
}

function buildItems(st: St): Item[] {
  const dict = dictionaries[st.locale] ?? dictionaries.en;
  const tr = (k: string) => dict[k] ?? dictionaries.en[k] ?? k;
  const now = Date.now();
  const items: Item[] = [];
  const iso = (ms: number) => new Date(ms).toISOString();
  for (const l of legs(st)) {
    const what = l.what || tr(`reminder.mode.${l.mode}`);
    const dep = st.tripReminderMinutes;
    if (dep > 0) {
      const fire = l.departAt - dep * 60_000;
      if (fire > now + 30_000 && l.departAt - now < HORIZON_MS) {
        items.push({
          key: `departure:${l.key}`,
          kind: "departure",
          fireAt: iso(fire),
          expiresAt: iso(l.departAt),
          title: tr("reminder.title").replace("{min}", String(dep)),
          body: tr("reminder.body")
            .replace("{what}", what)
            .replace("{dest}", l.dest)
            .replace("{time}", formatTimeInZone(iso(l.departAt), l.originTz))
            .replace("{origin}", l.origin),
        });
      }
    }
    const arr = st.arrivalReminderMinutes;
    if (arr > 0 && l.arriveAt != null) {
      const fire = l.arriveAt - arr * 60_000;
      if (fire > now + 30_000 && l.arriveAt - now < HORIZON_MS) {
        items.push({
          key: `arrival:${l.key}`,
          kind: "arrival",
          fireAt: iso(fire),
          expiresAt: iso(l.arriveAt),
          title: tr("reminder.arrival.title").replace("{min}", String(arr)),
          body: tr("reminder.arrival.body")
            .replace("{dest}", l.dest)
            .replace("{time}", formatTimeInZone(iso(l.arriveAt), l.destTz)),
        });
      }
    }
  }
  return items.slice(0, 80);
}

let channelReady = false;
async function ensureChannel(name: string): Promise<void> {
  if (Platform.OS !== "android" || channelReady) return;
  try {
    // OHNE diesen Kanal verwirft Android die Meldung des Servers lautlos
    // (siehe `ensureChannel` in push.ts). HOCH: Eine Erinnerung, die nur in der
    // Leiste liegt, ist keine.
    await Notifications.setNotificationChannelAsync(CHANNEL, {
      name,
      importance: Notifications.AndroidImportance.HIGH,
    });
    channelReady = true;
  } catch {
    // Dann kommt sie im Vorgabe-Kanal — besser als gar nicht.
  }
}

/** Den Erinnerungs-Kanal anlegen — auch für die Test-Mitteilung, die ihn benutzt. */
export async function prepareReminderChannel(): Promise<void> {
  const st = useSearchStore.getState();
  const dict = dictionaries[st.locale] ?? dictionaries.en;
  await ensureChannel(dict["reminder.channel"] ?? dictionaries.en["reminder.channel"] ?? "Reminders");
}

/** Lokale Wecker der ersten Fassung wegräumen — sonst kämen sie doppelt (oder verspätet) dazu. */
async function cancelLocal(): Promise<void> {
  const scheduled = await Notifications.getAllScheduledNotificationsAsync();
  await Promise.all(
    scheduled
      .filter((n) => (n.content.data as { type?: unknown } | null)?.type === LOCAL_TYPE)
      .map((n) => Notifications.cancelScheduledNotificationAsync(n.identifier)),
  );
}

async function run(): Promise<void> {
  await cancelLocal().catch(() => {});
  const st = useSearchStore.getState();
  const wanted = st.notificationsEnabled && (st.tripReminderMinutes > 0 || st.arrivalReminderMinutes > 0);
  const items = wanted ? buildItems(st) : [];
  if (wanted) await prepareReminderChannel();
  // Ohne Erlaubnis gibt es keine Kennung — und dann auch keinen Empfänger.
  // Ausgeschaltet wird trotzdem gemeldet (leere Liste), wenn es eine Kennung gibt.
  const token = await registeredPushToken();
  if (!token) return;
  await fetch(`${API_BASE_URL}/api/reminders`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", "X-Push-Token": token },
    body: JSON.stringify({ items }),
  });
}

let running: Promise<void> | null = null;
let again = false;

/** Die Liste beim Server ersetzen. Läuft schon ein Abgleich, folgt genau einer danach. */
export function syncTripReminders(): void {
  if (running) {
    again = true;
    return;
  }
  running = run()
    .catch(() => {})
    .finally(() => {
      running = null;
      if (again) {
        again = false;
        syncTripReminders();
      }
    });
}

/**
 * Hält die Erinnerungen aktuell — einmal beim Start und bei jeder Änderung,
 * die sie betrifft. Als Abonnement am Speicher, nicht als Effekt mit
 * Abhängigkeiten: So rendert dafür nichts neu.
 */
export function useTripReminderSync(): void {
  useEffect(() => {
    const pick = (st: St) =>
      [
        st.savedTrips,
        st.tickets,
        st.tripReminderMinutes,
        st.arrivalReminderMinutes,
        st.notificationsEnabled,
        st.locale,
      ] as const;
    let last = pick(useSearchStore.getState());
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = () => {
      if (timer) clearTimeout(timer);
      // Gebündelt: Speichern löst oft mehrere Schreibvorgänge kurz hintereinander aus.
      timer = setTimeout(syncTripReminders, 800);
    };
    schedule();
    const unsub = useSearchStore.subscribe((st) => {
      const next = pick(st);
      if (next.every((v, i) => v === last[i])) return;
      last = next;
      schedule();
    });
    return () => {
      unsub();
      if (timer) clearTimeout(timer);
    };
  }, []);
}
