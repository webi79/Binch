import { and, eq, inArray, lt } from "drizzle-orm";
import admin from "firebase-admin";
import { db } from "../db/client.js";
import { priceAlerts, pushTokens, users } from "../db/schema.js";
import type { TravelMode } from "../db/schema.js";

/**
 * Preis-Alarme — geprüft im Windschatten fremder Suchen.
 *
 * DIE ENTWURFSENTSCHEIDUNG, und sie ist keine Bequemlichkeit: Es gibt keinen
 * eigenen Lauf, der Alarme abarbeitet und dafür die Anbieter befragt. Das wäre
 * der naheliegende Weg und der falsche — das Kontingent bei db-vendo liegt bei
 * rund 60 Anfragen pro Minute und IP und gehört der Suche; ein nächtlicher
 * Durchlauf über alle Alarme führe es leer, und zwar genau dann, wenn niemand
 * davon etwas hat.
 *
 * Stattdessen wird geprüft, wenn IRGENDJEMAND diese Strecke sucht. Die Antwort
 * liegt in dem Moment ohnehin vor, gerechnet wird nur noch ein indizierter
 * Nachschlag. Kosten für die Anbieter: null. Das gilt auch für Suchen, die aus
 * dem Cache beantwortet werden — auch die tragen einen gültigen Preis.
 *
 * DIE EHRLICHE LÜCKE: Eine Strecke, die sonst niemand sucht, meldet sich nie.
 * Bei kleiner Nutzerzahl trifft das die meisten Strecken. Das ist der Preis
 * dieses Entwurfs, und er ist bewusst bezahlt — die Alternative kostet
 * Anbieter-Kontingent, das wir nicht haben.
 */

/**
 * Mindestabstand zwischen zwei Meldungen desselben Alarms.
 *
 * Ohne ihn feuerte ein Alarm bei JEDER fremden Suche auf seiner Strecke
 * erneut — auf einer beliebten Verbindung also im Minutentakt, und das für
 * dieselbe Nachricht. Zwölf Stunden heißt: höchstens zweimal am Tag, und wer
 * abends bucht, hat die Meldung vom Morgen noch nicht vergessen.
 */
const NOTIFY_COOLDOWN_MS = 12 * 60 * 60 * 1000;

/**
 * Firebase nimmt bis zu 500 Nachrichten pro Sammelaufruf entgegen.
 *
 * Verschickt wird DIREKT über Firebase, nicht über Expos Push-Dienst. Der wäre
 * der kürzere Weg gewesen, hätte aber einen Dritten in die Kette gesetzt — und
 * ihm unseren Firebase-Dienstkontoschlüssel geben müssen, damit er in unserem
 * Namen zustellen kann. Wir betreiben den Server ohnehin; so bleibt die
 * Zustellung vollständig bei uns.
 */
const FCM_BATCH = 500;

/**
 * Was eine Suche über sich verrät, damit Alarme dazu passen.
 *
 * Diese Felder sind KEINE Auswahl aus Bequemlichkeit — sie sind genau der
 * Schlüssel, unter dem ein Alarm gespeichert ist. Fehlt hier eines, das dort
 * steht, feuert ein Alarm auf eine Suche, die ihm nicht entspricht: eine andere
 * Währung, eine andere Gruppengröße, eine andere Klasse. Wer ein Feld ergänzt,
 * ergänzt es an beiden Stellen.
 */
export interface AlertCheckInput {
  mode: TravelMode;
  origin: string;
  destination: string;
  /** ISO „yyyy-MM-dd". */
  departDate: string;
  /** ISO „yyyy-MM-dd" oder leer — siehe `returnDate` im Schema. */
  returnDate?: string;
  /**
   * Die Währung DIESER Suche — und sie ist kein Beiwerk.
   *
   * Der günstigste Preis einer Antwort ist eine Zahl in der Währung, in der
   * gesucht wurde. Ein Alarm trägt seine eigene. Ohne Abgleich verglich der
   * Server 5000 mit 40 und meldete einen sensationellen Preissturz — die App
   * bietet unter anderem Yen an, und dort liegen die Beträge rund hundertmal
   * höher als in Euro. Umgekehrt bliebe ein Yen-Alarm für immer still.
   *
   * Umrechnen wäre die andere Möglichkeit und die schlechtere: Dafür bräuchte
   * es Wechselkurse, also eine weitere Quelle, die falsch sein kann — und ein
   * Alarm, der wegen eines veralteten Kurses feuert, ist schlimmer als einer,
   * der schweigt.
   */
  currency: string;
  /**
   * Reisende und Klasse — siehe die Begründung am Schema.
   *
   * Der Preis einer Antwort ist der GESAMTPREIS der Gruppe. Eine Schwelle für
   * vier Personen gegen den Preis für eine gehalten meldet einen Sturz, den es
   * nicht gibt; andersherum bleibt ein echter Sturz still.
   */
  passengers: number;
  travelClass: string;
}

interface PushMessage {
  /** Die FCM-Kennung des Geräts. */
  to: string;
  title: string;
  body: string;
  /**
   * Das Kennzeichen, unter dem Android die Meldung führt.
   *
   * Es ist der Unterschied zwischen „eine Meldung, die sich aktualisiert" und
   * „ein Stapel, der immer länger wird". Ohne Kennzeichen legt Android für JEDE
   * eintreffende Nachricht einen eigenen Eintrag an — nach drei Preisänderungen
   * auf derselben Strecke liegen drei Meldungen in der Leiste, von denen zwei
   * überholt sind. Mit einem stabilen Kennzeichen ersetzt die neue die alte.
   *
   * Abgeleitet aus der STRECKE, nicht aus dem Alarm: Liegen für dasselbe Gerät
   * zwei Kennungen vor, gäbe es sonst zwei sichtbare Meldungen für dieselbe
   * Sache.
   */
  tag: string;
  data: Record<string, string>;
  channelId: string;
}

/**
 * Der günstigste ECHTE Preis einer Trefferliste.
 *
 * Nullen zählen nicht: Zug-Treffer ohne Anreicherung tragen eine 0, und die als
 * „günstigster Preis" zu lesen wäre eine glatte Falschaussage — sie würde jeden
 * Alarm sofort auslösen. Kommt nichts heraus, gibt es für diese Suche keinen
 * Bezugspunkt, und dann wird gar nichts geprüft.
 */
export function cheapestPrice(results: { price: number }[]): number {
  let min = 0;
  for (const r of results) {
    if (r.price > 0 && (min === 0 || r.price < min)) min = r.price;
  }
  return min;
}

/**
 * Liegt es beim Gerät gerade zwischen 22 und 8 Uhr?
 *
 * Gerechnet über `Intl` statt über einen Zeitversatz: Sommerzeit verschiebt ihn
 * zweimal im Jahr, und ein fest gespeicherter Versatz wäre die Hälfte der Zeit
 * falsch. Eine unbekannte Zone fällt auf „nicht ruhig" zurück — im Zweifel
 * lieber zustellen als eine Meldung für immer zurückhalten.
 */
const QUIET_FROM = 22;
const QUIET_TO = 8;

function isQuietHour(timezone: string | null | undefined): boolean {
  try {
    const hour = Number(
      new Intl.DateTimeFormat("en-GB", {
        hour: "2-digit",
        hour12: false,
        timeZone: timezone || "Europe/Berlin",
      }).format(new Date()),
    );
    if (Number.isNaN(hour)) return false;
    return hour >= QUIET_FROM || hour < QUIET_TO;
  } catch {
    return false;
  }
}

/**
 * Die Grenzen, ab denen Android abschneidet.
 *
 * Die Vorlage nennt 30 und 40, und beide werden eingehalten. Möglich ist das
 * erst, seit der Titel die Sache nur BENENNT statt sie zu erzählen: Ein Satz mit
 * Anrede kam auf 40 Zeichen, „Preis-Alarm" braucht elf — und der ganze Platz
 * des Rumpfes gehört damit dem Inhalt.
 */
const TITLE_MAX = 30;
const BODY_MAX = 40;

/**
 * Währungszeichen statt Kürzel, wo es eines gibt.
 *
 * „31 €" liest sich im Vorbeigehen schneller als „31 EUR" und spart zwei
 * Zeichen. Wo kein gebräuchliches Zeichen existiert, bleibt das Kürzel stehen —
 * ein erfundenes Zeichen wäre schlechter als ein bekanntes Kürzel.
 */
const CURRENCY_SYMBOL: Record<string, string> = {
  EUR: "€",
  USD: "$",
  GBP: "£",
  JPY: "¥",
};

function money(amount: number, currency: string): string {
  const sym = CURRENCY_SYMBOL[currency.toUpperCase()];
  return sym ? `${amount} ${sym}` : `${amount} ${currency}`;
}

/**
 * Die Texte der Meldung.
 *
 * AUFBAU: Der Titel BENENNT die Sache — „Preis-Alarm". Der Rumpf trägt den
 * Inhalt: Anrede, Strecke, Preis. Genau dieses Muster empfiehlt die Vorlage
 * ausdrücklich für den Fall, dass Vorschauen ausgeblendet sind — ein
 * beschreibender Titel statt eines generischen, damit man schon auf dem
 * Sperrbildschirm weiß, worum es geht.
 *
 * Der Titel unterscheidet auch die beiden Fälle, weil der Rumpf das nicht kann,
 * ohne lang zu werden: „Preis-Alarm" gegen „Preis gestiegen". Ein Sturz braucht
 * keinen Zusatz — dafür ist die Funktion da; ein Anstieg ist die Ausnahme und
 * muss benannt werden.
 */
const TEXTS = {
  en: { droppedTitle: "Price alert", risenTitle: "Price went up" },
  de: { droppedTitle: "Preis-Alarm", risenTitle: "Preis gestiegen" },
  fr: { droppedTitle: "Alerte prix", risenTitle: "Prix en hausse" },
  es: { droppedTitle: "Alerta de precio", risenTitle: "El precio subió" },
} as const;

/**
 * Ein Ortsname, gekürzt auf das, was ihn erkennbar macht.
 *
 * Zwei volle Beschriftungen („Wien Erdberg", „Frankfurt (am Hbf)") sprengen
 * jeden Titel. Gekürzt wird in dieser Reihenfolge, und die ist nicht beliebig:
 *
 *  1. Klammer-Zusätze weg — „Frankfurt (am Hbf)" wird zu „Frankfurt". Das ist
 *     die einzige Kürzung, die garantiert keinen anderen Ort ergibt.
 *  2. Erst wenn es dann noch zu lang ist, hart abschneiden mit Auslassung.
 *
 * BEWUSST NICHT am Komma getrennt: Bei Haltestellen gehört der Teil dahinter
 * zum Namen — aus „Werl, Markt" würde sonst „Werl", also ein anderer Ort. Diese
 * Falle ist im Projekt schon einmal teuer gewesen und steht in `RecentCard.tsx`
 * ausdrücklich beschrieben.
 */
function shortPlace(label: string, max: number): string {
  const base = label.replace(/\s*\([^)]*\)\s*/g, " ").trim();
  if (base.length <= max) return base;
  return `${base.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Die KOMPLETTE Meldung bauen — Kennzeichen, Texte und Datenteil.
 *
 * Herausgezogen, weil zwei Stellen sie verschicken: die Auswertung und
 * `scripts/test-push.ts`. Der Test hatte seine eigene Fassung, und die ist
 * zweimal weggelaufen — erst bei den Texten (er schickte noch die verworfene
 * Satz-Form), dann beim Datenteil (`price` und `pct` fehlten, weshalb die App
 * die Meldung stillschweigend verwarf und weder etwas unter die Glocke legte
 * noch den Alarm aus „Gespeichert" nahm).
 *
 * Beides sah aus wie ein Fehler im Produkt und war einer im Test. Eine zweite
 * Kopie einer Nutzlast ist keine Bequemlichkeit, sie ist eine Zeitbombe: Sie
 * bricht genau dann, wenn jemand die erste erweitert — also immer dann, wenn
 * sowieso schon etwas Neues zu prüfen wäre.
 */
export function buildAlertPush(a: {
  locale: string | null | undefined;
  firstName: string | null;
  dropped: boolean;
  price: number;
  basePrice: number;
  currency: string;
  mode: string;
  origin: string;
  destination: string;
  originLabel: string;
  destLabel: string;
  departDate: string;
  returnDate?: string;
  passengers: number;
  travelClass: string;
}): { tag: string; title: string; body: string; channelId: string; data: Record<string, string> } {
  const texts = buildAlertTexts({
    locale: a.locale,
    dropped: a.dropped,
    price: a.price,
    basePrice: a.basePrice,
    currency: a.currency,
    originLabel: a.originLabel,
    destLabel: a.destLabel,
    firstName: a.firstName,
  });
  /**
   * Dieselbe Rechnung wie im Text, hier für den Datenteil. Sie steht bewusst
   * nicht in `buildAlertTexts`: Die Funktion baut Zeichenketten; gäbe sie
   * zusätzlich eine Zahl zurück, hätte sie zwei Aufgaben.
   */
  const diffPct = a.basePrice > 0 ? Math.round(((a.basePrice - a.price) / a.basePrice) * 100) : 0;
  return {
    // Eine Strecke, ein Eintrag in der Leiste — siehe `tag` an `sendPush`.
    tag: `${a.mode}|${a.origin}|${a.destination}|${a.departDate}|${a.returnDate ?? ""}`,
    title: texts.title,
    body: texts.body,
    channelId: "price-alerts",
    /**
     * Genug, um die Suche wieder zu ÖFFNEN — nicht nur, um sie zu benennen.
     *
     * Ein Tipp auf die Meldung soll dorthin führen, wo der Preis steht. Dafür
     * braucht die App denselben Parametersatz wie eine Verlaufskarte: Codes für
     * die Suche UND Beschriftungen für die Anzeige. Ohne die Beschriftungen
     * stünde in der Kopfzeile ein Kürzel wie „8000207".
     *
     * Rückreise, Reisendenzahl und Klasse gehören dazu, seit der Preis einer
     * Antwort als GESAMTPREIS der Gruppe erkannt wurde: Ohne sie meldete die
     * Nachricht 120 € für vier Personen und der Tipp öffnete eine Suche für
     * eine — mit 31 € in der Liste.
     *
     * Und `price`/`pct`, weil die App eine Liste der ausgelösten Alarme führt.
     * Sie könnte die Zahlen aus Titel und Rumpf zurückrechnen, aber das hieße,
     * eine für Menschen gebaute Zeichenkette wieder auseinanderzunehmen:
     * gekürzte Ortsnamen, Währungszeichen statt Kürzel, eine Anrede, die mal da
     * ist und mal nicht. Zwei Felder ersparen einen Parser, der bei jeder
     * Textänderung still bricht.
     */
    data: {
      type: "priceAlert",
      mode: a.mode,
      origin: a.origin,
      destination: a.destination,
      originLabel: a.originLabel,
      destLabel: a.destLabel,
      departDate: a.departDate,
      ...(a.returnDate ? { returnDate: a.returnDate } : {}),
      passengers: String(a.passengers),
      ...(a.travelClass ? { travelClass: a.travelClass } : {}),
      price: String(a.price),
      pct: String(diffPct),
      currency: a.currency,
    },
  };
}

/**
 * Titel und Rumpf bauen — als EIGENE Funktion, damit die Längen prüfbar sind.
 *
 * Der Rumpf hängt an drei Größen gleichzeitig: Sprache, Namenslänge und
 * Ortsnamen. Inline in der Auswertung ließe sich das nur mit echter Datenbank
 * und echtem Firebase prüfen; herausgezogen kostet die Gegenprobe nichts —
 * siehe `scripts/alerts-copy-check.ts`.
 */
export function buildAlertTexts(a: {
  locale: string | null | undefined;
  dropped: boolean;
  price: number;
  /**
   * Der Preis, gegen den sich die Änderung misst — der Grundpreis des Alarms.
   *
   * Er steht NICHT im Text; aus ihm und dem aktuellen Preis wird der Prozentsatz
   * gerechnet. Ohne ihn ließe sich „um wie viel" nicht sagen, und genau das ist
   * die Frage, die eine Meldung über einen gefallenen Preis beantworten muss:
   * „134 €" allein sagt nichts, solange man nicht weiß, ob das ein Schnäppchen
   * ist oder der Normalpreis.
   */
  basePrice: number;
  currency: string;
  originLabel: string;
  destLabel: string;
  firstName: string | null;
}): { title: string; body: string } {
  const key = (a.locale ?? "").slice(0, 2);
  const tx = TEXTS[key as keyof typeof TEXTS] ?? TEXTS.en;

  /**
   * Der Name wird gedeckelt.
   *
   * Er ist der einzige Teil des Rumpfes, dessen Länge wir nicht kennen — und
   * eine Anrede, die die Strecke abschneidet, richtet mehr Schaden an als sie
   * nützt. Zwölf Zeichen tragen jeden gebräuchlichen Vornamen; was darüber
   * liegt, ist meist ein Doppelname und wird abgekürzt.
   */
  const raw = a.firstName?.trim() || "";
  const name = raw.length === 0 ? null : raw.length > 12 ? `${raw.slice(0, 11)}.` : raw;
  const who = name ? `${name}: ` : "";

  /**
   * Der Rumpf: Anrede, Strecke, Preis — und bei guten Nachrichten ein Zeichen
   * dafür.
   *
   * Das 🎉 steht NUR beim Preissturz. Bei einem Anstieg wäre es Hohn; die
   * Vorlage sagt ausdrücklich, dass Zeichen die Bedeutung tragen sollen und
   * nicht schmücken.
   *
   * Gekürzt werden die ORTSNAMEN, nie der Preis: Der Preis ist der Grund der
   * Meldung. Und beide Namen gleichmäßig — einer vollständig und einer auf drei
   * Buchstaben liest sich schlechter als zwei gleich knappe.
   *
   * Die Grenze wird um EINS heruntergezählt, nicht in Sprüngen. Eine grobe
   * Leiter überschießt: Bei „Wien Erdberg – Frankfurt" reichte eine Stufe nicht
   * und die nächste warf sechs Zeichen zu viel weg — „Wien E… – Frankf…" statt
   * „Wien Er… – Frankfur…". Die Schleife läuft höchstens neunzehnmal über
   * Zeichenketten von unter fünfzig Zeichen; das kostet nichts.
   */
  const priceStr = money(a.price, a.currency);
  const suffix = a.dropped ? " 🎉" : "";

  /**
   * Der Prozentsatz — GERUNDET und IMMER mit Vorzeichen.
   *
   * „-11%" beim Sturz, „+28%" beim Anstieg. Eine vorzeichenlose Zahl zwischen
   * Strecke und Preis wäre für sich genommen mehrdeutig: „11%" kann ebenso ein
   * Anteil sein wie eine Änderung. Das Zeichen macht sie zur Änderung, ohne ein
   * Wort dafür auszugeben — bei vierzig Zeichen ist das der Unterschied
   * zwischen lesbar und abgeschnitten.
   *
   * Beide Zeichen sind schlichtes ASCII, auch das Minus. Das typografische
   * Minus (U+2212) wäre schöner, stünde hier aber neben dem
   * Halbgeviertstrich der Strecke — zwei Striche verschiedener Länge, die
   * dasselbe zu bedeuten scheinen. Und ein „+" aus ASCII neben einem „−" aus
   * Unicode wäre ungleich breit.
   *
   * Ist der Grundpreis 0 oder fehlt er, entfällt der Teil ersatzlos. Eine
   * Division durch null ergäbe „Infinity%", und einen ausgedachten Prozentsatz
   * gibt es hier nicht — wir schätzen keine Preise, und ein erfundener
   * Vergleichswert wäre genau das.
   */
  const diff = a.basePrice > 0 ? Math.round(((a.basePrice - a.price) / a.basePrice) * 100) : 0;
  const pctStr = diff === 0 ? "" : `${diff > 0 ? "-" : "+"}${Math.abs(diff)}% · `;

  /**
   * Was zuerst weicht, wenn der Platz nicht reicht — und die Reihenfolge ist
   * begründet.
   *
   * ERST die Ortsnamen kürzen, DANN die Anrede fallen lassen, und erst danach
   * noch schärfer kürzen. Der Name ist die Zutat, die am wenigsten trägt: Er
   * macht die Meldung persönlich, aber wer sie liest, weiß ohnehin, dass sie
   * ihm gehört. Strecke, Prozentsatz und Preis sind der INHALT; von ihnen
   * darf keiner verschwinden, und die Strecke bis zur Unkenntlichkeit zu
   * schreddern, nur damit „Valentin: " stehen bleibt, hieße die Zutat über den
   * Inhalt zu stellen.
   */
  const build = (name: string, max: number) =>
    `${name}${shortPlace(a.originLabel, max)} – ${shortPlace(a.destLabel, max)} · ${pctStr}${priceStr}${suffix}`;
  const MIN_WITH_NAME = 8;
  let body = "";
  let fitted = false;
  if (who !== "") {
    for (let max = 22; max >= MIN_WITH_NAME; max -= 1) {
      body = build(who, max);
      if (body.length <= BODY_MAX) {
        fitted = true;
        break;
      }
    }
  }
  if (!fitted) {
    for (let max = 22; max >= 4; max -= 1) {
      body = build("", max);
      if (body.length <= BODY_MAX) break;
    }
  }

  /**
   * Und ein hartes Netz darunter.
   *
   * Die Bausteine sind auf Länge gerechnet, aber wer hier morgen ein Wort
   * ergänzt, sieht die Überschreitung nicht. Diese Zeilen garantieren die
   * Grenze, statt auf sie zu hoffen.
   */
  const title = a.dropped ? tx.droppedTitle : tx.risenTitle;
  return {
    title: title.length > TITLE_MAX ? `${title.slice(0, TITLE_MAX - 1).trimEnd()}…` : title,
    body: body.length > BODY_MAX ? `${body.slice(0, BODY_MAX - 1).trimEnd()}…` : body,
  };
}

/**
 * Der Zugang zu Firebase — einmal beim ersten Verschicken aufgebaut.
 *
 * Der Dienstkontoschlüssel ist ein ECHTES Geheimnis, anders als die
 * `google-services.json` der App: Mit ihm kann man im Namen des Projekts
 * zustellen. Er gehört deshalb nicht ins Repository, sondern in die Umgebung —
 * entweder als Pfad zu einer Datei (`GOOGLE_APPLICATION_CREDENTIALS`, der
 * Standardweg) oder als JSON in `FIREBASE_SERVICE_ACCOUNT`.
 *
 * Fehlt beides, wird NICHT geworfen: Der Server soll ohne Push laufen können.
 * Er sagt es einmal deutlich und stellt dann nichts zu.
 */
let fcmApp: admin.app.App | null = null;
let fcmChecked = false;

function fcm(): admin.messaging.Messaging | null {
  if (fcmApp) return fcmApp.messaging();
  if (fcmChecked) return null;
  fcmChecked = true;
  try {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (raw) {
      fcmApp = admin.initializeApp({
        credential: admin.credential.cert(JSON.parse(raw) as admin.ServiceAccount),
      });
    } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
      // Der Standardweg: Die Bibliothek liest den Pfad selbst aus der Umgebung.
      fcmApp = admin.initializeApp({ credential: admin.credential.applicationDefault() });
    } else {
      // eslint-disable-next-line no-console
      console.warn(
        "[priceAlerts] Kein Firebase-Dienstkonto gesetzt — Alarme werden geprüft, " +
          "aber nicht zugestellt. FIREBASE_SERVICE_ACCOUNT oder " +
          "GOOGLE_APPLICATION_CREDENTIALS setzen.",
      );
      return null;
    }
    return fcmApp.messaging();
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("[priceAlerts] Firebase-Zugang fehlgeschlagen:", e);
    return null;
  }
}

/**
 * Nachrichten an Firebase geben.
 *
 * Fehler werden geschluckt und nur protokolliert: Diese Funktion läuft im
 * Nachlauf einer Suche, und eine Suche darf niemals daran scheitern, dass ein
 * Push-Dienst gerade nicht erreichbar ist.
 *
 * `UNREGISTERED` und `INVALID_ARGUMENT` sind die einzigen Fehler, auf die wir
 * reagieren: Die Kennung gehört zu einem Gerät, das die App nicht mehr hat.
 * Sie stehen zu lassen hieße, sie bei jeder künftigen Prüfung erneut
 * anzuschreiben — und die Alarme daran blieben für immer stumm.
 */
async function sendPush(messages: PushMessage[]): Promise<void> {
  const messaging = fcm();
  if (!messaging) return;
  for (let i = 0; i < messages.length; i += FCM_BATCH) {
    const batch = messages.slice(i, i + FCM_BATCH);
    try {
      const res = await messaging.sendEach(
        batch.map((m) => ({
          token: m.to,
          notification: { title: m.title, body: m.body },
          data: m.data,
          android: {
            /**
             * `collapseKey` gehört zum Kennzeichen dazu.
             *
             * Das Kennzeichen räumt die Leiste auf dem GERÄT auf; der
             * Sammel-Schlüssel tut dasselbe schon in Firebases Warteschlange.
             * Ist ein Handy längere Zeit offline, liegen dort sonst drei
             * Nachrichten zur selben Strecke und werden beim Aufwachen alle drei
             * zugestellt.
             */
            collapseKey: m.tag,
            /**
             * LEBENSDAUER — an die Entprellung gekoppelt, nicht frei gewählt.
             *
             * Firebase hebt eine unzustellbare Nachricht sonst VIER WOCHEN auf.
             * Für eine Meldung, die einen konkreten Preis nennt, ist das
             * gefährlich: Ein Handy, das der Hersteller tagelang schlafen legt,
             * bekäme beim Aufwachen „31 €" für eine Fahrt, die längst 58 €
             * kostet. Wir schätzen keine Preise — dann dürfen wir auch keine
             * veralteten nennen.
             *
             * Zwölf Stunden, weil danach ohnehin ein neuer Alarm derselben
             * Strecke möglich ist: Die Nachricht verfällt genau in dem Moment,
             * in dem sie ersetzt werden könnte. Ein längerer Wert ließe beides
             * gleichzeitig zu, ein kürzerer ließe eine Lücke.
             */
            ttl: NOTIFY_COOLDOWN_MS,
            /**
             * HOHE Priorität — ausdrücklich, nicht auf die Vorgabe vertrauend.
             *
             * Android hält Nachrichten normaler Priorität zurück, solange das
             * Gerät im Dösen ist, und die Energiespar-Aufsätze mancher
             * Hersteller gehen darüber noch hinaus. Ein Preis-Alarm, der einen
             * Tag später kommt, ist wertlos: Der Preis ist dann ein anderer.
             *
             * Das ist keine Willkür gegenüber dem Nutzer — er hat diese eine
             * Meldung selbst bestellt, mit einer selbst gesetzten Schwelle. Und
             * mehr als eine je Strecke und zwölf Stunden gibt es ohnehin nicht.
             */
            priority: "high",
            // Derselbe Kanal, den die App beim ersten Alarm anlegt — sonst
            // landet die Meldung unter „Sonstiges" und lässt sich nur zusammen
            // mit allem anderen abschalten.
            notification: { channelId: m.channelId, tag: m.tag },
          },
        })),
      );
      const dead: string[] = [];
      res.responses.forEach((r, idx) => {
        if (r.success) return;
        const code = r.error?.code ?? "";
        /**
         * NUR die beiden Kennungs-Fehler zählen als „Gerät weg".
         *
         * `invalid-argument` stand hier mit in der Liste, und das war
         * gefährlich: Firebase benutzt denselben Code auch für eine fehlerhafte
         * NUTZLAST — ein zu langer Text, ein ungültiges Feld, ein Fehler in
         * dieser Datei. Eine einzige schlechte Nachricht hätte dann die
         * Kennungen aller Empfänger im Bündel gelöscht, und weil `price_alerts`
         * per Kaskade daran hängt, mit ihnen alle Alarme dieser Geräte.
         *
         * Ein Absender-Fehler darf niemals Nutzerdaten löschen. Er wird
         * protokolliert wie jeder andere unbekannte Fehler — dort gehört er
         * hin, denn er ist einer von uns und keiner des Geräts.
         */
        if (
          code.includes("registration-token-not-registered") ||
          code.includes("invalid-registration-token")
        ) {
          const to = batch[idx]?.to;
          if (to) dead.push(to);
        } else {
          // eslint-disable-next-line no-console
          console.warn("[priceAlerts] push error:", code, r.error?.message);
        }
      });
      if (dead.length > 0) {
        await db.delete(pushTokens).where(inArray(pushTokens.token, dead));
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn("[priceAlerts] push failed:", e);
    }
  }
}

/**
 * Vermerken, dass ein Alarm GEMELDET HAT — Zeitpunkt und Preis.
 *
 * Herausgezogen, weil nicht nur die Auswertung ihn setzen darf: Auch
 * `scripts/test-push.ts` verschickt eine echte Meldung, und wer verschickt,
 * muss es auch vermerken. Fehlte das dort, war der Test nicht bloß ungenau,
 * sondern prüfte das Gegenteil: Die App holt beim Start nach, was sie verpasst
 * hat, und erkennt einen ausgelösten Alarm GENAU an diesen beiden Feldern. Ohne
 * sie fand sie nichts — und es sah aus, als sei das Nachholen kaputt.
 *
 * Der Preis gehört MIT. `lastSeenPrice` daneben wird bei jeder Prüfung
 * fortgeschrieben, auch ohne Meldung; wer später fragt „mit welcher Zahl kam
 * die Meldung?", bekäme also irgendeine spätere. Wir schätzen keine Preise.
 */
export async function markNotified(alertIds: string[], price: number): Promise<void> {
  if (alertIds.length === 0) return;
  await db
    .update(priceAlerts)
    .set({ lastNotifiedAt: new Date(), notifiedPrice: String(price) })
    .where(inArray(priceAlerts.id, alertIds));
}

/**
 * Alarme dieser Strecke gegen den gefundenen Preis halten.
 *
 * Läuft NACH der Antwort an den Suchenden und wird bewusst nicht abgewartet —
 * siehe die Aufrufstelle. Wirft nie.
 */
export async function evaluateAlerts(
  input: AlertCheckInput,
  results: { price: number }[],
): Promise<void> {
  try {
    const price = cheapestPrice(results);
    if (price <= 0) return;

    const rows = await db
      .select({
        id: priceAlerts.id,
        token: pushTokens.token,
        originLabel: priceAlerts.originLabel,
        destLabel: priceAlerts.destLabel,
        currency: priceAlerts.currency,
        basePrice: priceAlerts.basePrice,
        desiredPrice: priceAlerts.desiredPrice,
        notifyOnRise: priceAlerts.notifyOnRise,
        lastNotifiedAt: priceAlerts.lastNotifiedAt,
        departDate: priceAlerts.departDate,
        locale: pushTokens.locale,
        timezone: pushTokens.timezone,
        // Für die Anrede — steht nur da, wenn der Alarm einem Konto gehört.
        firstName: users.firstName,
      })
      .from(priceAlerts)
      .innerJoin(pushTokens, eq(pushTokens.id, priceAlerts.pushTokenId))
      /**
       * LEFT JOIN, nicht INNER: Die allermeisten Alarme gehören keinem Konto —
       * ein innerer Verbund ließe genau die verschwinden, für die die Funktion
       * gebaut ist.
       */
      .leftJoin(users, eq(users.id, priceAlerts.userId))
      .where(
        and(
          eq(priceAlerts.active, true),
          eq(priceAlerts.mode, input.mode),
          eq(priceAlerts.origin, input.origin),
          eq(priceAlerts.destination, input.destination),
          eq(priceAlerts.departDate, input.departDate),
          // Die Rückreise muss übereinstimmen — die leere Zeichenkette steht
          // für die einfache Fahrt und vergleicht sich wie jeder andere Wert.
          eq(priceAlerts.returnDate, input.returnDate ?? ""),
          // Nur gleiche Währungen vergleichen — siehe `currency` oben.
          // Beide Seiten in Großschreibung: Die App schreibt sie groß, der
          // Server prüfte das nicht nach — ein „eur" hätte sich nie mit einem
          // „EUR" getroffen und der Alarm wäre für immer still geblieben.
          eq(priceAlerts.currency, input.currency.toUpperCase()),
          eq(priceAlerts.passengers, input.passengers),
          eq(priceAlerts.travelClass, input.travelClass),
        ),
      );

    if (rows.length === 0) return;

    const now = Date.now();
    const messages: PushMessage[] = [];
    const notified: string[] = [];
    const seen: string[] = [];

    for (const a of rows) {
      seen.push(a.id);
      const desired = Number(a.desiredPrice);
      const base = Number(a.basePrice);
      const dropped = price <= desired;
      const rose = a.notifyOnRise && price > base;
      if (!dropped && !rose) continue;

      // Entprellung — siehe NOTIFY_COOLDOWN_MS.
      const last = a.lastNotifiedAt ? new Date(a.lastNotifiedAt).getTime() : 0;
      if (now - last < NOTIFY_COOLDOWN_MS) continue;

      /**
       * RUHEZEIT — zwischen 22 und 8 Uhr ORTSZEIT wird nicht zugestellt.
       *
       * Ein Preis-Alarm ist keine dringende Nachricht. Ihn nachts um drei zu
       * schicken, weil zufällig jemand am anderen Ende der Welt diese Strecke
       * gesucht hat, ist genau die Aufdringlichkeit, wegen der Meldungen ganz
       * abgeschaltet werden — und dann ist die Funktion tot statt laut.
       *
       * VERSCHOBEN, nicht verworfen: `lastNotifiedAt` bleibt unangetastet, der
       * Alarm ist also weiterhin fällig. Die nächste Suche auf dieser Strecke
       * nach acht Uhr stellt ihn zu. Der zuletzt gesehene Preis wird trotzdem
       * fortgeschrieben — die Prüfung hat ja stattgefunden.
       *
       * Der Preis kann sich bis dahin geändert haben, und das ist richtig so:
       * Zugestellt wird dann der Preis, der morgens gilt, nicht der von
       * heute Nacht.
       */
      if (isQuietHour(a.timezone)) continue;

      /**
       * Der Vorname geht MIT — aber nur, wenn jemand angemeldet ist.
       *
       * Er kommt aus dem Konto am Alarm; ohne Anmeldung steht dort nichts, und
       * dann wird der Satz ohne Anrede gebaut. Kein „Hallo Nutzer" — eine
       * Anrede, die niemanden meint, ist schlechter als keine.
       */
      messages.push({
        to: a.token,
        ...buildAlertPush({
          locale: a.locale,
          firstName: a.firstName ?? null,
          dropped,
          price,
          basePrice: base,
          currency: a.currency,
          mode: input.mode,
          origin: input.origin,
          destination: input.destination,
          originLabel: a.originLabel,
          destLabel: a.destLabel,
          departDate: input.departDate,
          returnDate: input.returnDate,
          passengers: input.passengers,
          travelClass: input.travelClass,
        }),
      });
      notified.push(a.id);
    }

    // Den zuletzt gesehenen Preis IMMER nachführen, auch ohne Meldung — er ist
    // die einzige Spur davon, dass die Prüfung überhaupt gelaufen ist.
    if (seen.length > 0) {
      await db
        .update(priceAlerts)
        .set({ lastSeenPrice: String(price) })
        .where(inArray(priceAlerts.id, seen));
    }
    if (notified.length > 0) {
      await markNotified(notified, price);
      await sendPush(messages);
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn("[priceAlerts] evaluate failed:", e);
  }
}

/**
 * Abgelaufene Alarme stilllegen — ihre Reise liegt in der Vergangenheit.
 *
 * `lt` und NICHT `lte`: Ein Alarm für HEUTE ist nicht abgelaufen. Wer morgens
 * auf einen Preis für den Abend wartet, verlöre ihn sonst genau an dem Tag, an
 * dem er zählt.
 *
 * Der Vergleich läuft über die Datums-Zeichenkette, und das ist hier richtig:
 * `departDate` ist ein reines Tagesdatum ohne Zone, und „2026-09-12" ist
 * lexikografisch genau dann kleiner als „2026-09-13", wenn es auch zeitlich
 * früher liegt.
 */
export async function deactivateExpiredAlerts(): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  const rows = await db
    .update(priceAlerts)
    .set({ active: false })
    .where(and(eq(priceAlerts.active, true), lt(priceAlerts.departDate, today)))
    .returning({ id: priceAlerts.id });
  if (rows.length > 0) {
    // eslint-disable-next-line no-console
    console.log(`[priceAlerts] ${rows.length} abgelaufene Alarme stillgelegt.`);
  }
}

/**
 * Der Takt, in dem abgelaufene Alarme stillgelegt werden.
 *
 * Sechs Stunden: Ein Alarm, dessen Reise vorbei ist, richtet in der
 * Zwischenzeit keinen Schaden an — er wird höchstens einmal zu viel geprüft,
 * und das ist ein indizierter Nachschlag. Häufiger zu laufen wäre Aufwand ohne
 * Gegenwert.
 *
 * `unref()`: Dieser Wecker darf den Prozess nicht am Leben halten. Ohne das
 * hinge ein Herunterfahren bis zu sechs Stunden.
 */
const EXPIRY_INTERVAL_MS = 6 * 60 * 60 * 1000;
let expiryTimer: ReturnType<typeof setInterval> | null = null;

export function startAlertExpiry(): void {
  if (expiryTimer) return;
  expiryTimer = setInterval(() => void deactivateExpiredAlerts(), EXPIRY_INTERVAL_MS);
  expiryTimer.unref?.();
}

export function stopAlertExpiry(): void {
  if (!expiryTimer) return;
  clearInterval(expiryTimer);
  expiryTimer = null;
}
