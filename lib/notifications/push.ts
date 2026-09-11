import * as Notifications from "expo-notifications";
import { Platform } from "react-native";
import { API_BASE_URL } from "@/lib/api/client";
import { useSearchStore } from "@/stores/searchStore";

/**
 * Der Weg vom Gerät zur Meldung — und wann er beschritten wird.
 *
 * ERST BEIM ERSTEN ALARM, nicht beim App-Start. Eine Berechtigungsfrage ohne
 * Anlass ist der zuverlässigste Weg zu einem „Nie erlauben": Wer beim ersten
 * Öffnen gefragt wird, weiß noch gar nicht, wofür — und diese Entscheidung ist
 * unter Android endgültig, sie lässt sich später nur noch in den
 * Systemeinstellungen zurücknehmen. Gefragt wird deshalb genau in dem Moment, in
 * dem jemand einen Preis-Alarm anlegt: Da ist der Zweck offensichtlich.
 *
 * Die Kennung ist GERÄTEGEBUNDEN, nicht kontogebunden. Ein Alarm soll ohne
 * Anmeldung funktionieren. Die Kehrseite steht auch im Server: Wer die App neu
 * installiert, bekommt eine neue Kennung und findet seine Alarme ohne Konto
 * nicht wieder.
 */

/**
 * Wie eine hereinkommende Meldung behandelt wird, solange die App im
 * VORDERGRUND ist.
 *
 * Ohne diese Angabe zeigt Android im Vordergrund gar nichts an — die Meldung
 * käme an und niemand sähe sie. Für einen Preis-Alarm ist das falsch: Er meldet
 * etwas, das sich gerade geändert hat, und das ist auch dann eine Nachricht
 * wert, wenn man die App offen hat.
 */
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: false,
    shouldSetBadge: false,
  }),
});


/**
 * Die Zeitzone dieses Geräts als IANA-Name („Europe/Berlin").
 *
 * Über `Intl`, nicht über den Zeitversatz: Der verschiebt sich mit der
 * Sommerzeit zweimal im Jahr, ein gespeicherter Versatz wäre die Hälfte des
 * Jahres falsch. Liefert die Laufzeit nichts, bleibt der Server bei seiner
 * Vorgabe.
 */
/**
 * Marke und Modell dieses Geräts — „Xiaomi 23127PN0CG".
 *
 * WOZU: Damit man in der Datenbank sieht, WELCHES Handy eine Kennung ist. Bei
 * mehreren Neuinstallationen und einem zweiten Testgerät stehen dort sonst nur
 * Zeichenketten, und die Frage „auf welchem Gerät kam die Meldung an?" lässt
 * sich nicht beantworten — an genau dieser Frage ist eine Fehlersuche schon
 * einmal steckengeblieben.
 *
 * Aus `Platform.constants`, das React Native ohnehin mitbringt. Eine eigene
 * Abhängigkeit dafür wäre ein natives Modul und damit ein Prebuild — für eine
 * Zeichenkette, die daneben liegt.
 */
function deviceModel(): string | undefined {
  try {
    const c = Platform.constants as { Brand?: string; Model?: string } | undefined;
    const parts = [c?.Brand, c?.Model].filter((v): v is string => typeof v === "string" && v.length > 0);
    if (parts.length === 0) return undefined;
    return parts.join(" ").slice(0, 64);
  } catch {
    return undefined;
  }
}

function deviceTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "Europe/Berlin";
  } catch {
    return "Europe/Berlin";
  }
}

/** Einmal geholt und gemerkt — die Kennung ändert sich innerhalb eines Laufs nicht. */
let cachedToken: string | null = null;

/**
 * Warum es NICHT geklappt hat — und warum das ein eigener Typ ist.
 *
 * Hier stand `Promise<string | null>`, und `null` hieß alles auf einmal:
 * Erlaubnis verweigert, kein Zustellweg eingerichtet, Netz weg. Der Aufrufer
 * konnte daraus nur eine Meldung bauen, und die war dann für zwei von drei
 * Fällen falsch — gemeldet wurde „Meldungen sind aus", obwohl der Nutzer alles
 * erlaubt hatte. Eine Fehlermeldung, die auf die falsche Ursache zeigt, ist
 * schlimmer als gar keine: Sie schickt den Nutzer in die Systemeinstellungen,
 * wo er nichts finden kann.
 */
export type PushTokenResult =
  | { ok: true; token: string }
  /** Der Nutzer hat die Erlaubnis nicht erteilt. */
  | { ok: false; reason: "denied" }
  /**
   * Erlaubnis liegt vor, ein Zustellweg kommt trotzdem nicht zustande.
   *
   * Der häufigste Grund ist keine Störung, sondern eine fehlende Einrichtung:
   * Auf Android laufen Meldungen über Firebase, und dafür braucht der Build
   * eine `google-services.json`. Fehlt sie, kann sich das Gerät nicht
   * registrieren, und die Anfrage nach einer Kennung scheitert.
   */
  | { ok: false; reason: "unavailable"; detail: string };

/**
 * Die Push-Kennung des Geräts besorgen und beim Server hinterlegen.
 *
 * Der Aufrufer MUSS den Fehlerfall behandeln — ein Alarm ohne Zustellweg wäre
 * ein Versprechen, das niemand hält.
 */
/**
 * Den Meldungs-Kanal anlegen — und zwar auf JEDEM Weg, der zu einer Kennung führt.
 *
 * DAS WAR EIN FEHLER MIT FOLGEN. Das Anlegen stand in `ensurePushToken`, aber
 * ERST NACH dessen früher Rückkehr auf den Zwischenspeicher. Und den füllt
 * `restorePushToken` beim App-Start, ohne den Kanal anzulegen. Die Reihenfolge
 * war damit: Start meldet die Kennung an → Zwischenspeicher voll → der Nutzer
 * setzt einen Alarm → `ensurePushToken` kehrt sofort zurück → der Kanal
 * entsteht NIE. Der Server verschickt, Firebase nimmt an und meldet eine
 * Nachrichten-Kennung — und Android verwirft die Meldung lautlos, weil der
 * angegebene Kanal auf dem Gerät nicht existiert. Von außen sieht das aus wie
 * ein kaputter Server.
 *
 * Angelegt wurde er überhaupt nur in einem engen Fenster: bei der allerersten
 * Erlaubnis, wenn `restorePushToken` mangels Erlaubnis noch nichts
 * zwischengespeichert hatte. Auf jedem Gerät, das die Erlaubnis schon hatte,
 * fehlte er.
 *
 * Der Aufruf ist billig und beliebig oft wiederholbar: Existiert der Kanal,
 * lässt Android ihn unverändert. Er darf deshalb an jedem Einstieg stehen.
 */
async function ensureChannel(): Promise<void> {
  if (Platform.OS !== "android") return;
  try {
    await Notifications.setNotificationChannelAsync("price-alerts", {
      name: "Preis-Alarme",
      /**
       * HOCH, nicht Vorgabe.
       *
       * Ein Preis-Alarm ist nichts, was die App sich ausgedacht hat — der
       * Nutzer hat eine Schwelle gesetzt und wartet darauf. Bei Vorgabe-Stufe
       * zeigt Android kein Banner; die Meldung liegt nur in der Leiste und wird
       * übersehen. Genau das versprach der Alarm nicht.
       *
       * ACHTUNG für später: Android friert die Stufe beim ANLEGEN ein. Eine
       * Änderung hier erreicht nur Geräte, auf denen der Kanal noch nicht
       * existiert; auf allen anderen bleibt die alte Stufe stehen, bis der
       * Nutzer sie selbst ändert.
       */
      importance: Notifications.AndroidImportance.HIGH,
    });
  } catch {
    // Scheitert das Anlegen, ist das kein Grund abzubrechen — die Meldung käme
    // dann eben im Vorgabe-Kanal an. Ein fehlender Kanal ist besser als eine
    // Kennung, die es deswegen gar nicht erst gibt.
  }
}

export async function ensurePushToken(): Promise<PushTokenResult> {
  // VOR der frühen Rückkehr — siehe `ensureChannel`.
  await ensureChannel();
  if (cachedToken) return { ok: true, token: cachedToken };

  // Die Erlaubnis GETRENNT prüfen, damit „verweigert" nicht im selben Topf
  // landet wie „geht technisch nicht".
  try {
    const existing = await Notifications.getPermissionsAsync();
    let status = existing.status;
    if (status !== "granted") {
      const asked = await Notifications.requestPermissionsAsync();
      status = asked.status;
    }
    if (status !== "granted") return { ok: false, reason: "denied" };
  } catch (e) {
    return { ok: false, reason: "unavailable", detail: describe(e) };
  }

  try {
    /**
     * Die NATIVE Kennung des Geräts, nicht die von Expo.
     *
     * Hier stand `getExpoPushTokenAsync`. Die liefert eine Kennung, mit der nur
     * Expos Push-Dienst etwas anfangen kann — verschickt hätte dann ein Dritter
     * für uns, und der bräuchte dafür unseren Firebase-Dienstkontoschlüssel.
     *
     * Wir betreiben den Server ohnehin. `getDevicePushTokenAsync` gibt auf
     * Android die FCM-Kennung des Geräts zurück, und damit spricht unser Server
     * Firebase direkt an. Ein Dritter weniger in der Kette, und die Zustellung
     * bleibt vollständig bei uns.
     *
     * Der Rückgabewert ist plattformabhängig getypt (`data` ist auf Android eine
     * Zeichenkette, auf iOS ebenfalls) — die Prüfung darunter ist deshalb keine
     * Förmlichkeit, sondern der Grund, warum hier nichts Unerwartetes
     * durchrutscht.
     */
    const res = await Notifications.getDevicePushTokenAsync();
    if (typeof res.data !== "string" || res.data.length === 0) {
      return { ok: false, reason: "unavailable", detail: "Leere Geräte-Kennung" };
    }
    cachedToken = res.data;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn("[push] getDevicePushTokenAsync failed:", e);
    return { ok: false, reason: "unavailable", detail: describe(e) };
  }

  try {
    // Beim Server hinterlegen — ohne das kennt niemand den Empfänger.
    const res = await fetch(`${API_BASE_URL}/api/alerts/device`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: cachedToken,
        platform: Platform.OS,
        /**
         * Sprache und Zeitzone MIT anmelden.
         *
         * Den Text der Meldung schreibt der Server, und zwar zu einem
         * Zeitpunkt, an dem die App gar nicht beteiligt ist — er hat sonst
         * keine Möglichkeit, beides zu erfahren. Ohne die Sprache wären alle
         * Meldungen englisch, egal was in den Einstellungen steht; ohne die
         * Zeitzone könnte er die Ruhezeit nicht einhalten und schickte
         * Preis-Alarme nachts um drei, weil am anderen Ende der Welt jemand
         * dieselbe Strecke gesucht hat.
         */
        locale: useSearchStore.getState().locale,
        timezone: deviceTimezone(),
        deviceModel: deviceModel(),
      }),
    });
    if (!res.ok) {
      // Die Kennung ist gültig, nur der Server kennt sie nicht. Beim nächsten
      // Versuch wird sie erneut gemeldet — deshalb den Zwischenspeicher leeren.
      cachedToken = null;
      return { ok: false, reason: "unavailable", detail: `Server ${res.status}` };
    }
  } catch (e) {
    cachedToken = null;
    return { ok: false, reason: "unavailable", detail: describe(e) };
  }

  return { ok: true, token: cachedToken };
}

/** Fehlertext, der auch dann etwas sagt, wenn kein `Error` geworfen wurde. */
function describe(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

/**
 * Die Kennung wiederherstellen, OHNE zu fragen.
 *
 * Der Unterschied zu `ensurePushToken` ist der Berechtigungsdialog: Diese
 * Fassung holt die Kennung nur, wenn die Erlaubnis SCHON erteilt ist, und tut
 * sonst nichts. Damit darf sie beim App-Start laufen, ohne die Regel zu
 * brechen, dass ungefragt kein Dialog erscheint.
 *
 * WOZU: `ackNotification` liest den Zwischenspeicher, und der ist nach jedem
 * App-Start leer. Ohne diese Wiederherstellung wäre die Empfangs-Bestätigung
 * fast immer still ausgestiegen — eine Meldung käme an, und niemand erführe
 * davon. Genau das, was die Bestätigung beweisen soll, wäre damit
 * unbeobachtbar geblieben.
 *
 * Sie meldet die Kennung auch gleich erneut beim Server: Sie kann sich
 * geändert haben (Neuinstallation, Wiederherstellung), und ein Gerät, dessen
 * Kennung veraltet ist, bekommt keine Meldungen mehr.
 */
export async function restorePushToken(): Promise<string | null> {
  if (cachedToken) return cachedToken;
  try {
    const perm = await Notifications.getPermissionsAsync();
    // Auch hier — dies ist der Weg, den JEDER App-Start nimmt. Siehe
    // `ensureChannel`: Fehlt der Kanal, verwirft Android jede Meldung lautlos.
    await ensureChannel();
    if (perm.status !== "granted") return null;
    const res = await Notifications.getDevicePushTokenAsync();
    if (typeof res.data !== "string" || res.data.length === 0) return null;
    cachedToken = res.data;
    void fetch(`${API_BASE_URL}/api/alerts/device`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: cachedToken,
        platform: Platform.OS,
        /**
         * Sprache und Zeitzone MIT anmelden.
         *
         * Den Text der Meldung schreibt der Server, und zwar zu einem
         * Zeitpunkt, an dem die App gar nicht beteiligt ist — er hat sonst
         * keine Möglichkeit, beides zu erfahren. Ohne die Sprache wären alle
         * Meldungen englisch, egal was in den Einstellungen steht; ohne die
         * Zeitzone könnte er die Ruhezeit nicht einhalten und schickte
         * Preis-Alarme nachts um drei, weil am anderen Ende der Welt jemand
         * dieselbe Strecke gesucht hat.
         */
        locale: useSearchStore.getState().locale,
        timezone: deviceTimezone(),
        deviceModel: deviceModel(),
      }),
    }).catch(() => {
      // Der Server erfährt es beim nächsten Mal. Die Kennung steht trotzdem,
      // und darauf kommt es hier an.
    });
    return cachedToken;
  } catch {
    return null;
  }
}

/**
 * Sprache und Zeitzone am Server nachziehen — nach einem Wechsel im Betrieb.
 *
 * `restorePushToken` steigt bei einer schon geholten Kennung sofort aus, meldet
 * also im laufenden Betrieb nichts mehr nach. Wer die Sprache umstellt, bekäme
 * seine Meldungen sonst bis zum nächsten App-Start in der alten — und der Titel
 * ist seit der Umstellung die einzige Stelle, an der die Sprache überhaupt noch
 * sichtbar wird.
 *
 * Ohne Kennung passiert nichts: Dann ist entweder die Erlaubnis nicht erteilt
 * oder der Start noch nicht durch, und beide Fälle holt der nächste Start ein.
 */
export function syncDeviceLocale(): void {
  if (!cachedToken) return;
  void fetch(`${API_BASE_URL}/api/alerts/device`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      token: cachedToken,
      platform: Platform.OS,
      locale: useSearchStore.getState().locale,
      timezone: deviceTimezone(),
      deviceModel: deviceModel(),
    }),
  }).catch(() => {
    // Nicht schlimm — der nächste Start meldet es ohnehin erneut.
  });
}

/** Die zuletzt geholte Kennung, ohne zu fragen. `null` = noch keine. */
export function knownPushToken(): string | null {
  return cachedToken;
}

/**
 * Dem Server melden, dass eine Meldung wirklich angekommen ist.
 *
 * DER GRUND, warum es das gibt: Firebase gibt beim Verschicken eine
 * Nachrichten-Kennung zurück, sobald die Nachricht in der Warteschlange liegt.
 * Das ist KEIN Nachweis, dass sie auf dem Gerät angekommen ist — Energiesparen,
 * ein abgeschalteter Kanal oder eine deinstallierte App führen alle zu „Erfolg"
 * beim Absender. Ohne diese Rückmeldung bliebe die letzte Meile eine Behauptung.
 *
 * `tapped` ist der stärkere Nachweis: Empfangen kann die App auch im
 * Hintergrund melden, angetippt heißt, ein Mensch hat die Meldung gesehen.
 *
 * Läuft ins Leere, wenn noch keine Kennung geholt wurde, und schluckt jeden
 * Fehler: Eine Bestätigung, die scheitert, darf nicht die Behandlung der
 * Meldung selbst mitreißen.
 */
export function ackNotification(kind: "received" | "tapped"): void {
  const token = cachedToken;
  if (!token) return;
  void fetch(`${API_BASE_URL}/api/alerts/ack`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token, kind }),
  }).catch(() => {
    // Siehe oben — bewusst still.
  });
}
