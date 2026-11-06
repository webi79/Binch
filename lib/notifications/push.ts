import * as Notifications from "expo-notifications";
import { requestWithPrimer } from "@/lib/permissions/primer";
import { Platform } from "react-native";
import { API_BASE_URL } from "@/lib/api/client";
import { useSearchStore } from "@/stores/searchStore";
import { dictionaries } from "@/lib/i18n/dict";

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
  handleNotification: async (n) => {
    /**
     * Die Schalter aus den Einstellungen gelten auch HIER.
     *
     * Der Server schickt nichts mehr, sobald er sie kennt. Bis die Meldung
     * dort angekommen ist (kein Netz, ältere Server-Fassung), kann noch etwas
     * unterwegs sein — und im Vordergrund entscheidet allein diese Stelle, ob
     * es zu sehen ist.
     */
    const st = useSearchStore.getState();
    const type = (n.request.content.data as { type?: unknown } | null)?.type;
    const show =
      st.notificationsEnabled &&
      (type !== "priceAlert" || st.priceAlertsEnabled) &&
      (type !== "boTask" || st.boUpdatesEnabled);
    return {
      shouldShowBanner: show,
      shouldShowList: show,
      shouldPlaySound: false,
      shouldSetBadge: false,
    };
  },
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

/**
 * Was das Gerät dem Server meldet — an JEDER Stelle derselbe Rumpf.
 *
 * Sprache und Zeitzone braucht der Server für den Text und die Ruhezeit, die
 * beiden Schalter dafür, ob er überhaupt schickt. Stand vorher dreimal einzeln
 * da; eine vierte Angabe hätte an drei Stellen nachgetragen werden müssen.
 */
function deviceBody(token: string): string {
  const st = useSearchStore.getState();
  return JSON.stringify({
    token,
    platform: Platform.OS,
    locale: st.locale,
    timezone: deviceTimezone(),
    deviceModel: deviceModel(),
    notificationsEnabled: st.notificationsEnabled,
    priceAlertsEnabled: st.priceAlertsEnabled,
    boUpdatesEnabled: st.boUpdatesEnabled,
  });
}

/**
 * Das Gerät beim Server melden — MIT Anmelde-Zeichen, sobald es eines gibt.
 *
 * Daran hängt die Verknüpfung Gerät ↔ Konto. Alles, was der Server einem KONTO
 * schickt (Bos geplante Aufgaben), findet das Gerät nur darüber; ohne Kopfzeile
 * bleibt die Zeile anonym und die Meldung geht ins Leere, ohne dass irgendwo ein
 * Fehler steht.
 *
 * Bewusst NUR aus dem Speicher. Kommt das Zeichen beim Start erst später aus dem
 * Schlüsselbund, meldet `PriceAlertRouter` das Gerät in dem Moment neu an. Ein
 * Griff in den Schlüsselbund von hier aus liefe beim Abmelden dem Löschen davon
 * und holte das alte Zeichen zurück in den Speicher.
 */
function postDevice(token: string): Promise<Response> {
  const auth = useSearchStore.getState().authToken;
  return fetch(`${API_BASE_URL}/api/alerts/device`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(auth ? { Authorization: `Bearer ${auth}` } : {}) },
    body: deviceBody(token),
  });
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
  /** Im Blatt vor der Abfrage „Nicht jetzt" gewählt — kein Hinweis, keine Einstellungen. */
  | { ok: false; reason: "later" }
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
    // Bos geplante Aufgaben (Server-Kanal „bo-updates", services/boTasks.ts).
    const dict = dictionaries[useSearchStore.getState().locale] ?? dictionaries.en;
    await Notifications.setNotificationChannelAsync("bo-updates", {
      name: dict["bo.channel"] ?? dictionaries.en["bo.channel"] ?? "Bo",
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
    const perm = await requestWithPrimer(
      "notifications",
      Notifications.getPermissionsAsync,
      Notifications.requestPermissionsAsync,
    );
    if (!perm) return { ok: false, reason: "later" };
    if (perm.status !== "granted") return { ok: false, reason: "denied" };
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
    /**
     * Beim Server hinterlegen — ohne das kennt niemand den Empfänger.
     *
     * Sprache und Zeitzone gehen MIT (`deviceBody`). Den Text der Meldung
     * schreibt der Server, und zwar zu einem Zeitpunkt, an dem die App gar
     * nicht beteiligt ist — er hat sonst keine Möglichkeit, beides zu erfahren.
     * Ohne die Sprache wären alle Meldungen englisch, egal was in den
     * Einstellungen steht; ohne die Zeitzone könnte er die Ruhezeit nicht
     * einhalten und schickte Preis-Alarme nachts um drei, weil am anderen Ende
     * der Welt jemand dieselbe Strecke gesucht hat.
     */
    const res = await postDevice(cachedToken);
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
    // Sprache, Zeitzone und Schalter MIT anmelden — siehe `ensurePushToken`.
    void postDevice(cachedToken).catch(() => {
      // Der Server erfährt es beim nächsten Mal. Die Kennung steht trotzdem,
      // und darauf kommt es hier an.
    });
    return cachedToken;
  } catch {
    return null;
  }
}

/**
 * Sprache und Schalter am Server nachziehen — nach einem Wechsel im Betrieb.
 *
 * `restorePushToken` steigt bei einer schon geholten Kennung sofort aus, meldet
 * also im laufenden Betrieb nichts mehr nach. Wer die Sprache umstellt, bekäme
 * seine Meldungen sonst bis zum nächsten App-Start in der alten — und wer
 * Meldungen abschaltet, bekäme sie bis dahin weiter.
 *
 * Ohne Kennung im Zwischenspeicher übernimmt `restorePushToken`: Es holt sie
 * nur mit erteilter Erlaubnis (kein Dialog) und meldet dabei schon den neuen
 * Stand. Ohne Erlaubnis gibt es nichts zu melden — und dafür eigens ein Gerät
 * beim Server anzulegen, das nie Meldungen bekommen hat, wäre eine Angabe mehr
 * über jemanden, ohne Nutzen für ihn.
 */
export function syncDeviceSettings(): void {
  void (async () => {
    if (!cachedToken) {
      await restorePushToken();
      return;
    }
    await postDevice(cachedToken);
  })().catch(() => {
    // Nicht schlimm — der nächste Start meldet es ohnehin erneut.
  });
}

/** Die zuletzt geholte Kennung, ohne zu fragen. `null` = noch keine. */
/**
 * Die Kennung fürs AUFRÄUMEN — ohne die Erlaubnis-Schranke.
 *
 * WOZU ES DAS BRAUCHT: `restorePushToken` steigt aus, sobald die Erlaubnis
 * NICHT erteilt ist. Für alles, was zustellen will, ist das richtig. Fürs
 * Löschen ist es eine Falle: Wer die Meldungen in den Systemeinstellungen
 * abschaltet und danach einen gespeicherten Alarm wegwerfen will, bekommt keine
 * Kennung mehr — und ohne sie weist der Server das Löschen ab. Die Karte wäre
 * sichtbar und unlöschbar, also genau der Zustand, gegen den in diesem Projekt
 * an vier Stellen geschrieben steht.
 *
 * Dass es überhaupt geht: Die Laufzeit-Erlaubnis auf Android regelt das
 * ANZEIGEN von Meldungen, nicht die Registrierung bei Firebase. Die Kennung
 * gibt es also weiterhin — sie taugt hier nur nicht mehr zum Zustellen,
 * sondern nur noch als Ausweis gegenüber dem eigenen Server.
 *
 * NICHT in den Zwischenspeicher: Sonst liefe `restorePushToken` künftig an
 * seiner eigenen Prüfung vorbei (es gibt den Zwischenspeicher zuerst heraus),
 * und der Abgleich beim Start legte Alarme für ein Gerät an, das sie gar nicht
 * anzeigen kann.
 */
export async function pushTokenForCleanup(): Promise<string | null> {
  if (cachedToken) return cachedToken;
  try {
    const res = await Notifications.getDevicePushTokenAsync();
    return typeof res.data === "string" && res.data.length > 0 ? res.data : null;
  } catch {
    return null;
  }
}

/**
 * Die Kennung holen (nur mit erteilter Erlaubnis, ohne Dialog) UND die
 * Anmeldung beim Server ABWARTEN.
 *
 * Für alles, was gleich danach eine Geräte-Zeile auf dem Server braucht (die
 * Erinnerungen): `restorePushToken` meldet nur nebenbei an, und die nächste
 * Anfrage käme womöglich vor der Anmeldung an — „Unknown device".
 */
export async function registeredPushToken(): Promise<string | null> {
  const token = cachedToken ?? (await restorePushToken());
  if (!token) return null;
  try {
    const res = await postDevice(token);
    return res.ok ? token : null;
  } catch {
    return null;
  }
}

/**
 * Das Gerät NEU anmelden — nach dem Löschen des Kontos.
 *
 * Mit dem Konto löscht der Server auch die damit verknüpften Geräte samt deren
 * Alarmen (`ON DELETE CASCADE`). Die Kennung im Zwischenspeicher zeigte danach
 * auf eine Zeile, die es nicht mehr gibt, und jeder Alarm-Abgleich scheiterte
 * mit „Unknown device" — bis zum nächsten Kaltstart. Ohne Dialog, wie
 * `restorePushToken`, und ohne Anmeldung: Das Gerät ist jetzt anonym.
 */
export async function reregisterDevice(): Promise<string | null> {
  cachedToken = null;
  return restorePushToken();
}

export function knownPushToken(): string | null {
  return cachedToken;
}

/** Wer auf das Eintreffen einer Test-Mitteilung wartet (Einstellungen → Mitteilungen). */
const testArrivedListeners = new Set<() => void>();

/** Eine Test-Mitteilung ist im Vordergrund eingetroffen. */
export function announceTestArrived(): void {
  for (const l of testArrivedListeners) l();
}

export function onTestArrived(listener: () => void): () => void {
  testArrivedListeners.add(listener);
  return () => {
    testArrivedListeners.delete(listener);
  };
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
