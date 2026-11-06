// Prüft Zeitplan, Auswertung und Texte von services/boTasks.ts — ohne Datenbank.
//   npx tsx --env-file=.env scripts/check-bo-tasks.mts
import { computeNextRun, firstRun, __test } from "../src/services/boTasks.js";
import { formatInTimeZone } from "date-fns-tz";

const tz = "Europe/Berlin";
const base = { id: "00000000-0000-4000-8000-000000000001", days: 31, time: "08:00", watchUntil: null as string | null, timezone: tz };
const local = (d: Date | null) => (d ? formatInTimeZone(d, tz, "EEE yyyy-MM-dd HH:mm:ss") : "null");
let fails = 0;
const check = (name: string, got: string, want: RegExp) => {
  const ok = want.test(got);
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}: ${got}`);
};

// Zeitplan
check("Do 7:00 → heute 8:00 (bis 2 Min früher)", local(computeNextRun(base, new Date("2026-10-29T06:00:00Z"))), /^Thu 2026-10-29 07:5[89]|^Thu 2026-10-29 08:00/);
check("Fr 9:00 → Mo 8:00", local(computeNextRun(base, new Date("2026-10-30T08:00:00Z"))), /^Mon 2026-11-02 0(7:5[89]|8:00)/);
check("Wache Do 8:30 → +10 Min", local(computeNextRun({ ...base, watchUntil: "09:00" }, new Date("2026-10-29T07:30:00Z"))), /^Thu 2026-10-29 08:40/);
check("Wache Do 8:55 → Fr 8:00", local(computeNextRun({ ...base, watchUntil: "09:00" }, new Date("2026-10-29T07:55:00Z"))), /^Fri 2026-10-30 0(7:5[89]|8:00)/);
check("Nur Sa → nächster Sa", local(computeNextRun({ ...base, days: 32 }, new Date("2026-10-29T06:00:00Z"))), /^Sat 2026-10-31 0(7:5[89]|8:00)/);
check("Sommerzeit-Beginn 29.03.2027", local(computeNextRun(base, new Date("2027-03-28T12:00:00Z"))), /^Mon 2027-03-29 0(7:5[89]|8:00)/);
// Do 7:59:50: Der Vorlauf kann schon vorbei sein, die Uhrzeit liegt aber noch vor uns.
check("Anlegen 10 s vor 8:00 → heute", local(firstRun(base, new Date("2026-10-29T06:59:50Z"))), /^Thu 2026-10-29 08:00/);
check("Anlegen Do 7:00 → heute", local(firstRun(base, new Date("2026-10-29T06:00:00Z"))), /^Thu 2026-10-29 07:5[89]|^Thu 2026-10-29 08:00/);
check("Anlegen Do 9:00 → Fr", local(firstRun(base, new Date("2026-10-29T08:00:00Z"))), /^Fri 2026-10-30 0(7:5[89]|8:00)/);
check("Anlegen Sa 7:59:50, nur werktags → Mo", local(firstRun(base, new Date("2026-10-31T06:59:50Z"))), /^Mon 2026-11-02 0(7:5[89]|8:00)/);

// Auslöser
const task = { ...base, userId: "u", conversationId: null, kind: "route_status", title: "Morgen-Update", origin: "a", destination: "b", originLabel: "A", destLabel: "B", notify: "always", locale: "de", active: true, nextRunAt: null, lastRunAt: null, lastStatus: null, lastSummary: null, lastIssueKey: null, createdAt: new Date(), updatedAt: new Date() } as any;
check("7:59 → schedule", __test.triggerFor(task, new Date("2026-10-29T06:59:30Z")), /^schedule$/);
check("8:20 ohne Wache → schedule (nachgeholt)", __test.triggerFor(task, new Date("2026-10-29T07:20:00Z")), /^schedule$/);
check("9:00 ohne Wache → skip", __test.triggerFor(task, new Date("2026-10-29T08:00:00Z")), /^skip$/);
check("8:20 mit Wache bis 9 → watch", __test.triggerFor({ ...task, watchUntil: "09:00" }, new Date("2026-10-29T07:20:00Z")), /^watch$/);

// Auswertung + Texte
const from = new Date("2026-10-29T07:00:00Z");
const until = new Date("2026-10-29T09:00:00Z");
const trip = (hm: string, extra: object = {}) => ({ line: "RE 5", depart: `2026-10-29T${hm}:00Z`, arrive: `2026-10-29T${hm}:00Z`, platform: "6", cancelled: false, atRisk: false, realtime: true, ...extra });
const say = (name: string, trips: any[], locale = "de") => {
  const ev = __test.evaluate({ source: "db", trips }, from, until);
  const { headline, text } = __test.compose(ev, locale, tz);
  console.log(`  [${ev.status}] ${name}: ${headline} — ${text}`);
  return ev;
};
check("planmäßig", say("pünktlich", [trip("07:12"), trip("07:32")]).status, /^ok$/);
check("Ausfall + Alternative", say("Ausfall", [trip("07:12", { cancelled: true }), trip("07:32")]).status, /^issue$/);
check("Verspätung", say("Verspätung", [trip("07:12", { delay: 12 })]).status, /^issue$/);
check("Gleiswechsel", say("Gleis", [trip("07:12", { platformRt: "9" })]).status, /^issue$/);
check("keine Echtzeit", say("ohne Echtzeit", [trip("07:12", { realtime: false })]).status, /^unknown$/);
const mixed = say("Bus ohne Echtzeit, Zug pünktlich", [trip("07:05", { line: "Bus R42", realtime: false }), trip("07:12")]);
check("nur Fahrten mit Echtzeit gelten als planmäßig", `${mixed.status} ${mixed.trips.map((t: { line: string }) => t.line).join()}`, /^ok RE 5$/);
check("keine Fahrten", say("leer", []).status, /^unknown$/);
say("englisch", [trip("07:12", { cancelled: true }), trip("07:32")], "en");
say("französisch", [trip("07:12", { delay: 7 })], "fr");
say("spanisch", [trip("07:12", { platformRt: "2" })], "es");
const k1 = __test.evaluate({ source: "db", trips: [trip("07:12", { delay: 12 })] }, from, until).issueKey;
const k2 = __test.evaluate({ source: "db", trips: [trip("07:12", { delay: 15 })] }, from, until).issueKey;
check("geänderte Verspätung = neue Meldung", String(k1 !== k2), /^true$/);
console.log(fails === 0 ? "\nALLE OK" : `\n${fails} FEHLER`);
process.exit(fails === 0 ? 0 : 1);
