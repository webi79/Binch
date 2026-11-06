import { SearchResult, TravelMode } from "./search";

export interface SavedTrip extends SearchResult {
  savedAt: number;
  passengers: number;
  priceAlert: boolean;
}

/**
 * Ein Preis-Alarm auf einer STRECKE — nicht auf einem einzelnen Treffer.
 *
 * Das ist der Unterschied zu `SavedTrip.priceAlert`, das es hier schon gibt:
 * Jenes hängt an einer konkreten Verbindung mit ihrer Abfahrtszeit und ihrem
 * Anbieter. Beobachten will man aber die Strecke — „sag mir Bescheid, wenn
 * Frankfurt nach Zürich am 25. unter 60 Euro fällt" —, und der billigste Treffer
 * dafür ist morgen ein anderer als heute.
 *
 * `basePrice` ist der Preis, der beim Anlegen auf dem Bildschirm stand. Er wird
 * gespeichert, weil ohne ihn später nicht mehr zu sagen wäre, worauf sich die
 * gewählte Prozentzahl bezog.
 */
export interface PriceAlert {
  id: string;
  /**
   * Die Kennung, unter der der Alarm auf dem SERVER liegt.
   *
   * Ohne sie ließe er sich nicht mehr löschen: Die Kennung oben ist lokal
   * erzeugt und dem Server unbekannt. Der Server ist die Wahrheit — dort wird
   * geprüft und zugestellt —, dieser Eintrag ist nur die Anzeige.
   *
   * Optional, weil ältere Einträge sie nicht haben. Fehlt sie, kann der Alarm
   * nur aus der Anzeige verschwinden, nicht vom Server; der Aufrufer muss das
   * unterscheiden.
   */
  serverId?: string;
  mode: TravelMode;
  /** Codes, wie sie auch in die Suche gehen. */
  origin: string;
  destination: string;
  /** Beschriftungen für die Anzeige — Codes allein sagen dem Nutzer nichts. */
  originLabel: string;
  destLabel: string;
  /** ISO „yyyy-MM-dd". */
  departDate: string;
  /**
   * ISO „yyyy-MM-dd" oder leer — die Rückreise gehört zur Identität des Alarms.
   *
   * Eine Suche mit Rückreise liefert eine andere Trefferliste als dieselbe
   * Strecke ohne, also einen anderen günstigsten Preis. Ohne dieses Feld könnte
   * der Abgleich nach einem Kennungs-Wechsel den Alarm nur als einfache Fahrt
   * wiederherstellen — mit einer Schwelle, die für eine Rückreise gesetzt war.
   */
  returnDate?: string;
  /**
   * Reisende und Klasse gehören zum Preis.
   *
   * Der Preis einer Suche ist der GESAMTPREIS der Reisegruppe. Ohne diese
   * beiden Angaben verglich der Server eine Schwelle für vier Personen in der
   * Business mit dem Preis einer fremden Suche für eine Person in der Economy.
   */
  passengers: number;
  /** i18n-Schlüssel der Klasse, oder leer. */
  travelClass: string;
  /** Tarifprofil (BahnCard, Deutschlandticket), unter dem er angelegt wurde. Fehlt = ohne. */
  fareProfile?: string;
  currency: string;
  basePrice: number;
  desiredPrice: number;
  /** Auch melden, wenn der Preis STEIGT. */
  notifyOnRise: boolean;
  /**
   * Läuft der Alarm gerade? Fehlt das Feld, gilt er als aktiv.
   *
   * Der Schalter auf der Karte PAUSIERT ihn: Auf dem Server wird nur ein Merker
   * umgelegt (`PATCH /api/alerts/:id`), die Zeile bleibt mit Kennung, Schwelle
   * und zuletzt gesehenem Preis stehen, und die Prüfung überspringt sie. In der
   * App bleibt die Karte stehen und lässt sich wieder einschalten.
   *
   * Vorher wurde er dabei auf dem Server GELÖSCHT. Ein Schalter, der beim
   * Ausschalten kündigt, ist kein Schalter, sondern ein Löschknopf mit falscher
   * Beschriftung — gelöscht wird ausschließlich über das Herz, mit Rückfrage.
   *
   * Optional, weil ältere Einträge es nicht haben — und die liefen, also
   * bedeutet „fehlt" hier „an".
   */
  active?: boolean;
  createdAt: string;
}

/**
 * Ein Alarm, der AUSGELÖST hat — also eine Meldung, die wirklich kam.
 *
 * Getrennt von `PriceAlert`, weil beide verschiedene Dinge sind: Ein Alarm ist
 * eine stehende Beobachtung und gehört zu den gespeicherten Reisen. Das hier
 * ist ein EREIGNIS mit Zeitpunkt und Preis, und Ereignisse gehören unter die
 * Glocke. Vorher standen die Alarme selbst dort, und das war falsch herum: Die
 * Glocke zeigte, was noch NICHT passiert war.
 *
 * Die Felder kommen aus dem Datenteil der Meldung, nicht aus ihrem Text — siehe
 * `price`/`pct` in `priceAlerts.ts` auf dem Server.
 */
export interface AlertHit {
  id: string;
  mode: TravelMode;
  origin: string;
  destination: string;
  originLabel: string;
  destLabel: string;
  departDate: string;
  returnDate?: string;
  passengers: number;
  travelClass: string;
  currency: string;
  /** Der gefundene Preis, wegen dem die Meldung kam. */
  price: number;
  /**
   * Die Änderung in Prozent, positiv bei einem STURZ.
   *
   * Dasselbe Vorzeichen wie in der Rechnung des Servers: `(base - price) /
   * base`. Angezeigt wird daraus „-11 %" — das Minus steht für die Richtung des
   * PREISES, die Zahl hier für die Größe der Ersparnis.
   */
  pct: number;
  /** Wann die Meldung ankam — ISO. */
  receivedAt: string;
}

export interface Ticket {
  id: string;
  mode: TravelMode;
  carrier?: string;
  flightNumber?: string;
  fromCode?: string;
  fromCity?: string;
  toCode?: string;
  toCity?: string;
  departTime?: string;
  arriveTime?: string;
  originTz?: string;
  destinationTz?: string;
  durationMinutes?: number;
  stops: number;
  passenger?: string;
  seat?: string;
  wagon?: string;
  travelClass?: string;
  pageImage: string;
  pageImageRatio?: number;
  originalName?: string;
  /** Original-Code-Bild (QR/Aztec/Barcode) gecroppt aus dem PDF. Pixel-genau
   *  übertragen aus dem Server-Render, also bei Bedarf scanbar.
   *  undefined wenn der Vision-Parser den Code nicht lokalisieren konnte
   *  (Detail-Screen zeigt dann eine Fallback-Message statt was Fake-
   *  Generiertes). */
  codeImage?: string;
  codeType?: "qr" | "barcode";
  // Persistierter Pfad zur Original-PDF (im Document-Storage, NICHT im Cache).
  // Wird vom AddTicketModal beim Import gesetzt — `copyAsync` vom Cache-URI
  // (vom DocumentPicker) ins App-Document-Directory, damit das File auch nach
  // OS-Cache-Cleanup noch existiert.
  pdfUri?: string;
  // Buchungsnummer aus dem Parser (z.B. "TRN-2024-789456"). Wenn nicht
  // verfügbar, fallback auf flightNumber im UI.
  bookingRef?: string;
  // Bahnhof/Station-Name (z.B. "Wrocław Główny"). fromCity ist nur die Stadt,
  // hier kommt der konkrete Station-/Terminal-Name rein wenn der Parser ihn
  // ausgelesen hat. Fallback im UI = fromCity.
  fromStation?: string;
  toStation?: string;
  createdAt: number;
}
