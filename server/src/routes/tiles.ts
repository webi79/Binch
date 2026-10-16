import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { BoundedTtlCache } from "../util/boundedCache.js";
import { config } from "../config.js";
import { ipLimiter } from "../util/rateLimit.js";
import sharp from "sharp";

/**
 * Kachel-Weiterleitung für hochauflösende LUFTBILDER.
 *
 * WOZU DAS ÜBERHAUPT NÖTIG IST — es geht nicht um einen versteckten Schlüssel,
 * die Quellen hier sind offen. Es geht um Rechnen: Die amtlichen
 * Orthofoto-Dienste liefern zwar das übliche Mercator-Raster, zählen die
 * Zoomstufen aber anders. NRW etwa beginnt seine Pyramide bei Zoom 5 und nennt
 * das „TileMatrix 00" — aus Zoom 14 wird dort also 09. MapLibre kann in einer
 * URL-Vorlage nicht rechnen (im Stil-Schema gibt es keinen Zoom-Versatz), und
 * damit ist ein Umrechner der einzige Weg, diese Bilder überhaupt zu benutzen.
 *
 * Dass daraus zugleich ein Zwischenspeicher und EINE stabile URL-Form für alle
 * Gebiete wird, ist der Nebengewinn: Jede weitere Region ist unten eine
 * Tabellenzeile, und die App muss von den Eigenheiten der Anbieter nichts
 * wissen.
 *
 * WARUM LUFTBILDER ÜBERHAUPT: Die weltweite Satelliten-Ebene (Sentinel-2, siehe
 * `mapStyle.ts`) löst 10 Meter je Bildpunkt auf — nachgemessen ist ab Zoom 14
 * keine neue Information mehr drin. Die amtlichen Orthofotos liegen bei 10 bis
 * 40 Zentimetern, also bis zu hundertmal feiner, und sind Open Data.
 */

/**
 * Die Kachel in ihr Rechteck in Web-Mercator umrechnen.
 *
 * Nötig für alle Dienste, die KEIN Kachelraster anbieten, sondern einen
 * Bildausschnitt auf Zuruf (klassische Kartendienste und Bildserver). Die
 * Rechnung ist die Umkehrung der Kachelnummerierung: Die Welt ist bei Zoom 0
 * ein Quadrat von zweimal 20 037 508 Metern, und jede Stufe viertelt es.
 */
function tileBBox3857(z: number, x: number, y: number): string {
  const R = 20037508.342789244;
  const span = (2 * R) / 2 ** z;
  const minX = -R + x * span;
  const maxY = R - y * span;
  return `${minX},${maxY - span},${minX + span},${maxY}`;
}

/** Eine Bildquelle für ein Gebiet. */
interface AerialSource {
  /**
   * Die fertige Kachel-URL beim Anbieter — hier wird umgerechnet, was
   * umgerechnet werden muss (Zoom-Versatz, Achsenreihenfolge, Rechteck).
   */
  url: (z: number, x: number, y: number) => string;
  /**
   * Zusätzliche Kopfzeilen beim Abruf — für Dienste mit Zugangsschlüssel, die
   * ihn lieber im Kopf als in der Adresse sehen (Finnland: Basic-Auth). So
   * steht der Schlüssel in keiner Adresse und in keinem Protokoll.
   */
  headers?: Record<string, string>;
  /** Ab welcher Zoomstufe es diese Bilder gibt. */
  minzoom: number;
  /** Bis wohin ECHTE Bildinformation vorliegt — darüber wird hier gestreckt. */
  maxzoom: number;
  /** Gültigkeitsdauer im Zwischenspeicher. Luftbilder ändern sich alle paar Jahre. */
  ttlMs: number;
  /**
   * Umschließendes Rechteck [West, Süd, Ost, Nord].
   *
   * PFLICHT für jede örtliche Quelle, denn daran wählt der Server aus (siehe
   * `kandidaten`). Nur die europaweite Rückfallebene hat keins.
   */
  bounds?: [number, number, number, number];
  /**
   * Rechtecke INNERHALB von `bounds`, in denen die Quelle nur ein Füllbild hat
   * — dort wird sie gar nicht erst gefragt.
   *
   * Für bekannte Orte, an denen ein Dienst über seine Grenze hinaus etwas
   * liefert, das kein Luftbild ist. Das allgemeine Mittel dagegen ist der
   * Detailvergleich (`DEUTLICH_BESSER`), aber der misst Kontrast und liegt an
   * einem solchen Ort womöglich knapp an der Schwelle. Wo man den Fall kennt,
   * soll keine Schwelle entscheiden.
   */
  ohne?: [number, number, number, number][];
  /**
   * Gewicht bei der Auswahl — nur nötig, wo ein Gebiet IN einem anderen liegt.
   *
   * Berlin liegt vollständig im Rechteck von Brandenburg, Bremen in dem von
   * Niedersachsen. Beide großen Dienste liefern dort auch etwas, nur
   * schlechter: Brandenburg zeigt Berlin als gewöhnliches Orthofoto statt als
   * echtes (gekippte Hochhäuser), Niedersachsen löst Bremen mit 20 statt 10
   * Zentimetern auf. Ohne dieses Gewicht gewänne das größere Gebiet, weil ein
   * Punkt darin naturgemäß weiter von den Kanten entfernt liegt.
   */
  vorrang?: number;
  /**
   * Ein AUFDRUCK in der Kachel — und wie er wieder herausgeschnitten wird.
   *
   * Mecklenburg-Vorpommern brennt „© GeoBasis-DE/M-V" in JEDE gelieferte
   * Kachel. Auf einer Karte ergäbe das ein Raster aus Schriftzügen, alle 256
   * Bildpunkte einer. Deshalb war das Land bisher gar nicht dabei, und genau
   * dort — in Schwerin — ist gemeldet worden, dass es beim Hineinzoomen immer
   * unschärfer wird.
   *
   * Der Ausweg steckt in einer Eigenschaft des Aufdrucks: Er sitzt IMMER an
   * derselben Stelle des gelieferten Bildes und ist IMMER gleich groß, egal
   * wie groß das Bild ist. Nachgemessen, indem drei Kacheln aus drei
   * verschiedenen Gegenden verglichen wurden — 481 Bildpunkte sind in allen
   * dreien identisch, und sie liegen im Rechteck x 9 bis 94, y 9 bis 17. Bei
   * 256, 512 und 1024 Bildpunkten Kantenlänge dieselbe Stelle.
   *
   * Also wird ein GRÖSSERES Bild angefragt, dessen Rechteck nach Westen und
   * Norden über die Kachel hinausragt, und hinterher die Kachel selbst
   * herausgeschnitten. Der Aufdruck liegt dann im weggeschnittenen Rand.
   * Angegeben ist [links, oben] in Bildpunkten.
   */
  zuschnitt?: [number, number];
  /**
   * Wie viele Kacheln gleichzeitig bei DIESEM Dienst — falls die allgemeine
   * Zahl zu grob ist.
   *
   * Nur nötig, wo ein Dienst seinen Durchsatz selbst deckelt. Italien ist der
   * Fall: gemessen mit 55 Kacheln aus verschiedenen Stadtvierteln Roms —
   *
   *    6 gleichzeitig → 7,7 s   (Median je Kachel 0,25 s)
   *   12 gleichzeitig → 8,6 s   (Median 1,95 s)
   *   24 gleichzeitig → 8,7 s   (Median 3,43 s)
   *   36 gleichzeitig → 7,5 s   (Median 5,23 s)
   *
   * Der Gesamtdurchsatz ist überall derselbe, nur die Warteschlange wandert in
   * deren Server. Mehr Spuren bringen also NICHTS und belasten einen
   * kostenlosen öffentlichen Dienst ohne Gegenwert. Sechs ist hier das
   * Höfliche und das Schnelle zugleich.
   */
  spurzahl?: number;
  /**
   * `false`: KEIN Nachzügler bei langsamer Antwort (siehe `holeRoh`).
   *
   * Der Nachzügler hilft gegen einzelne hängende Verbindungen bei einem
   * schnellen Dienst. Bei einem Dienst, der von sich aus Sekunden braucht,
   * feuert er fast immer — er verdoppelt dann die Last auf genau den Dienst,
   * der ohnehin an seiner Grenze arbeitet.
   */
  nachzuegler?: boolean;
  /**
   * Wie lange auf DIESEN Dienst gewartet wird, bevor abgebrochen wird.
   *
   * Zwölf Sekunden reichen für alle bis auf einen. Portugal rendert jede
   * Kachel neu statt sie vorzuhalten und braucht gemessen 2 bis 30 Sekunden —
   * zehnmal hintereinander dieselbe Kachel: 12,1 / 8,6 / 30,0 / 15,2 / 2,1 /
   * 24,2 / 30,0 / 6,3 / 5,1 / 6,1. Mit der allgemeinen Grenze brach über
   * Lissabon jede zweite Kachel ab, die Suche ging weiter zu Spanien, und
   * dessen Dienst füllt außerhalb seines Gebiets braun. Auf dem Bildschirm
   * stand dann ein brauner Fleck über Lissabon.
   *
   * Geduldiger zu sein ist hier das Richtige: Die Kachel wird EINMAL geholt
   * und danach eine Woche aus dem Speicher bedient.
   */
  zeitgrenze?: number;
  /**
   * Gemeinsame Warteschlange, wo mehrere Zeilen denselben Anbieter meinen.
   * Ohne das bekäme Spanien für Festland und Kanaren getrennte Spuren beim
   * SELBEN Server.
   */
  dienst?: string;
  /**
   * Der Dienst markiert seine Gebietsgrenze SELBST durchsichtig — PNG,
   * Hybridformat oder `jpgpng`. Weiß in seinem Bild ist damit nie Füllfläche,
   * sondern echtes Bild, und wird NICHT gestanzt (siehe `WEISS_LOCH`).
   *
   * DAS WAR DIE UNSCHARFE KACHEL AM BAHNHOF COBURG. Bayern lieferte dort auf
   * Stufe 18 zwei einwandfreie Kacheln (Detail 10,3 und 11,7), aber die
   * Bahnsteigdächer sind hell: 9,3 und 8,9 Prozent der Bildpunkte über 250,
   * also über der Stanzgrenze von 8. Die Dächer wurden zu Löchern, die
   * Kacheln galten als lückenhaft, und die lückenlose Copernicus-Kachel mit
   * zwei Metern gewann — eine Woche lang, mit „immutable" auf dem Gerät.
   * Dieselbe Falle steht über jedem großen hellen Dach ab Stufe 18.
   *
   * Nur setzen, wo es belegt ist: Ohne die Angabe wird gestanzt wie bisher,
   * und das ist bei einem Dienst, der doch weiß füllt, der kleinere Schaden.
   */
  grenzeDurchsichtig?: boolean;
}

/** Eine Woche — Luftbilder stammen aus mehrjährigen Bildflügen. */
const WEEK = 7 * 24 * 60 * 60_000;

/**
 * Das Bildformat für Kartendienste — und das ist der Unterschied zwischen einer
 * Karte und einer weißen Fläche.
 *
 * DER FEHLER, DEN ES BEHEBT: Ein Kartendienst liefert außerhalb seines Gebiets
 * nicht etwa nichts, sondern ein Bild in der Hintergrundfarbe — und die ist
 * nach der WMS-Spezifikation WEISS, wenn man keine Transparenz verlangt. Als
 * JPEG kann er auch gar nichts anderes, dem Format fehlt der Alphakanal. Ein
 * Land wird aber über ein RECHTECK abgefragt, und in dessen Ecken liegt
 * Nachbarland: Dort deckte eine weiße Kachel alles darunter zu. Gemeldet wurde
 * das als „auf einmal ist die ganze Karte weiß".
 *
 * `image/vnd.jpeg-png` ist die Lösung ohne Preis: Der Dienst schickt ein JPEG,
 * solange das Bild deckend ist, und ein PNG, sobald Transparenz nötig wird.
 * Nachgemessen an derselben Stelle — echte Kachel 13 233 B JPEG, Leerfläche
 * 334 B PNG mit Alpha 0, Wasserfläche 927 B JPEG.
 *
 * Warum nicht einfach `image/png` mit Transparenz: Dieselbe echte Kachel wiegt
 * als PNG 168 541 B, also das Zwölffache. Ein Bildschirm voll wären zehn
 * Megabyte — auf Mobilfunk unzumutbar.
 */
const WMS_FORMAT = "image/vnd.jpeg-png";

/**
 * Ein Kartendienst-Aufruf — einmal geschrieben statt vierzehnmal.
 *
 * Alle Landesdienste sprechen dieselbe Sprache und unterscheiden sich nur in
 * Adresse, Ebenenname und Bildformat. Die Parameterkette hier einmal zu führen
 * heißt: Wer morgen etwas daran ändert (eine neue Fassung, ein zusätzlicher
 * Parameter), ändert es für alle — und kann es nicht bei zwei Ländern
 * vergessen.
 *
 * `TRANSPARENT=TRUE` steht IMMER dabei. Bei den Diensten mit Hybridformat
 * entscheidet es mit, ob JPEG oder PNG zurückkommt; bei den reinen
 * PNG-Diensten ist es der Unterschied zwischen einer durchsichtigen und einer
 * weißen Kachel außerhalb des Gebiets.
 */
function wms(baseUrl: string, layer: string, format: string = WMS_FORMAT) {
  return (z: number, x: number, y: number) =>
    `${baseUrl}SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap` +
    `&LAYERS=${encodeURIComponent(layer)}&STYLES=&CRS=EPSG:3857` +
    `&BBOX=${tileBBox3857(z, x, y)}&WIDTH=256&HEIGHT=256` +
    `&FORMAT=${encodeURIComponent(format)}&TRANSPARENT=TRUE`;
}

/**
 * Ein ArcGIS-Bildausschnitt — dieselbe Rolle wie `wms`, andere Sprache.
 *
 * `format=jpgpng` ist Esris Fassung des Hybridformats: JPEG, solange das Bild
 * deckend ist, PNG mit Alphakanal, sobald Transparenz nötig wird. Damit
 * markieren diese Dienste ihre Gebietsgrenze von selbst richtig, und
 * `locherStanzen` muss gar nicht erst ran.
 */
function arcgis(baseUrl: string) {
  return (z: number, x: number, y: number) =>
    `${baseUrl}?bbox=${tileBBox3857(z, x, y)}&bboxSR=3857&imageSR=3857` +
    `&size=256,256&format=jpgpng&f=image`;
}

/** Spaniens PNOA — von zwei Zeilen benutzt (Festland und Kanaren). */
function pnoa(z: number, x: number, y: number): string {
  return (
    `https://www.ign.es/wmts/pnoa-ma?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0` +
    `&LAYER=OI.OrthoimageCoverage&STYLE=default&TILEMATRIXSET=GoogleMapsCompatible` +
    `&TILEMATRIX=${z}&TILEROW=${y}&TILECOL=${x}&FORMAT=image/jpeg`
  );
}

/**
 * Ein Kartendienst-Aufruf mit RAND — für Dienste, die einen Aufdruck
 * hinterlassen.
 *
 * Das Rechteck wird nach Westen und Norden um genau so viele Bildpunkte
 * erweitert, wie der Rand breit ist, und das Bild entsprechend größer
 * angefragt. Der Bildpunkt (links, oben) des gelieferten Bildes ist damit die
 * linke obere Ecke der eigentlichen Kachel — `zuschneiden` holt sie sich von
 * dort.
 */
function wmsMitRand(
  baseUrl: string,
  layer: string,
  rand: [number, number],
  format: string,
) {
  const [links, oben] = rand;
  return (z: number, x: number, y: number) => {
    const R = 20037508.342789244;
    const span = (2 * R) / 2 ** z;
    const minX = -R + x * span - (span * links) / 256;
    const maxY = R - y * span + (span * oben) / 256;
    const bbox = `${minX},${R - (y + 1) * span},${-R + (x + 1) * span},${maxY}`;
    return (
      `${baseUrl}SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap` +
      `&LAYERS=${encodeURIComponent(layer)}&STYLES=&CRS=EPSG:3857` +
      `&BBOX=${bbox}&WIDTH=${256 + links}&HEIGHT=${256 + oben}` +
      `&FORMAT=${encodeURIComponent(format)}&TRANSPARENT=TRUE`
    );
  };
}

/** Den Rand wieder abschneiden — übrig bleibt genau die Kachel. */
async function zuschneiden(
  buf: Buffer,
  rand: [number, number],
): Promise<Buffer> {
  try {
    return await sharp(buf)
      .extract({ left: rand[0], top: rand[1], width: 256, height: 256 })
      .jpeg({ quality: 82 })
      .toBuffer();
  } catch {
    return buf;
  }
}

const SOURCES: Record<string, AerialSource> = {
  /**
   * Nordrhein-Westfalen — 10 cm je Bildpunkt, zweijähriger Bildflug.
   *
   * Lizenz laut Fähigkeiten-Dokument: „Datenlizenz Deutschland – Zero"
   * (dl-de/zero-2-0), `AccessConstraints: NONE`, wörtlich „Jede Nutzung ist
   * ohne Einschränkungen oder Bedingungen zulässig". Also nicht einmal eine
   * Namensnennung nötig — die einfachste Lizenz, die dieses Projekt je hatte.
   *
   * Der Versatz von fünf Stufen ist nachgemessen, nicht aus der Beschreibung
   * abgelesen: TileMatrix 00 hat 32×32 Kacheln, das ist das Standard-Raster von
   * Zoom 5. Spalte vor Zeile — andersherum als bei der Satelliten-Quelle.
   */
  nw: {
    url: (z, x, y) =>
      `https://www.wmts.nrw.de/geobasis/wmts_nw_dop/tiles/nw_dop/EPSG_3857_16/` +
      `${String(z - 5).padStart(2, "0")}/${x}/${y}`,
    minzoom: 13,
    maxzoom: 20,
    ttlMs: WEEK,
    // Außerhalb NRW kommt ein durchsichtiges PNG (nachgemessen, 854 B, Alpha 0).
    grenzeDurchsichtig: true,
    bounds: [5.6989, 50.2651, 9.6835, 52.5704],
  },

  /**
   * Bayern — 40 cm, klassischer Kartendienst ohne Kachelraster.
   *
   * Hier zeigt sich, warum der Umweg über den Server auch ohne Zoom-Versatz
   * lohnt: Der Dienst kennt keine Kacheln, er liefert einen Bildausschnitt zu
   * einem Rechteck. Die Umrechnung steht in `tileBBox3857`, und dieselbe Form
   * gilt für die meisten übrigen Gebiete — die unterscheiden sich nur in
   * Adresse und Ebenenname, sind also je eine weitere Zeile hier.
   */
  by: {
    /**
     * DOP20 und nicht DOP40 — 20 statt 40 Zentimeter.
     *
     * Hier stand lange der DOP40-Dienst, und das war schlicht die schlechtere
     * Hälfte des Angebots. Gemeldet wurde es als „in München ist es nicht so
     * detailreich wie in Nordrhein-Westfalen", und das stimmte: NRW liefert 10
     * cm, Bayern lieferte 40.
     *
     * Bis Zoom 18 ist der Unterschied nicht zu messen — beide Dienste
     * antworten dort byteweise gleich, weil dieselbe Pyramidenstufe
     * herausgerechnet wird. Ab Zoom 19 trennt es sich: gemessener mittlerer
     * Bildgradient an derselben Stelle in München 8,66 gegen 6,01, und die
     * Kachel wiegt 12 991 statt 10 770 Byte. Also echte zusätzliche
     * Information, kein schärfer gerechnetes Nichts.
     *
     * Lizenz laut Fähigkeiten-Dokument: `Fees: kostenfrei`,
     * `AccessConstraints: CC BY 4.0`.
     */
    url: wms("https://geoservices.bayern.de/od/wms/dop/v1/dop20?", "by_dop20c"),
    minzoom: 13,
    maxzoom: 20,
    ttlMs: WEEK,
    grenzeDurchsichtig: true,
    bounds: [8.97, 47.26, 13.85, 50.57],
  },

  /* ── Länder mit Hybridformat: verhalten sich wie Bayern ───────────────── */

  /** Niedersachsen, 20 cm. */
  ni: {
    url: wms(
      "https://opendata.lgln.niedersachsen.de/doorman/noauth/dop_wms?",
      "ni_dop20",
    ),
    minzoom: 13,
    maxzoom: 19,
    ttlMs: WEEK,
    grenzeDurchsichtig: true,
    bounds: [6.5058, 51.1531, 11.754, 54.1481],
  },
  /**
   * Hessen, 20 cm. Bewusst die maßstabsschaltende Gruppe `he_dop_rgb` und
   * nicht `he_dop20_rgb`: Letztere zeichnet erst ab etwa Zoom 16 und ließe die
   * Stufen 13 bis 15 leer.
   */
  he: {
    url: wms(
      "https://www.gds-srv.hessen.de/cgi-bin/lika-services/ogc-free-images.ows?",
      "he_dop_rgb",
    ),
    minzoom: 13,
    maxzoom: 19,
    ttlMs: WEEK,
    grenzeDurchsichtig: true,
    bounds: [7.4187, 49.25, 10.5, 51.7596],
  },
  /** Rheinland-Pfalz, 20 cm. */
  rp: {
    url: wms("https://geo4.service24.rlp.de/wms/rp_dop20.fcgi?", "rp_dop20"),
    minzoom: 13,
    maxzoom: 19,
    ttlMs: WEEK,
    grenzeDurchsichtig: true,
    bounds: [6.0378, 48.898, 8.6177, 51.0009],
  },
  /** Saarland, 20 cm — Lizenz `noLimitations`, keine Namensnennung nötig. */
  sl: {
    url: wms("https://geoportal.saarland.de/freewms/dop?", "sl_dop"),
    minzoom: 13,
    maxzoom: 19,
    ttlMs: WEEK,
    grenzeDurchsichtig: true,
    bounds: [6.3406, 49.0829, 7.4382, 49.6598],
  },
  /**
   * Bremen, 10 cm — ZWEI Ebenen in einem Aufruf.
   *
   * Bremen und Bremerhaven sind getrennte Flächen. Mit nur `_HB` kam über
   * Bremerhaven eine leere Kachel zurück; erst beide zusammen liefern beide
   * Städte. Auch das umschließende Rechteck der Dienstbeschreibung ist zu
   * klein — es endet südlich von Bremerhaven, deshalb hier die Vereinigung
   * beider Flächen.
   *
   * `vorrang`, weil Bremen vollständig im Rechteck von Niedersachsen liegt und
   * jenes dort ebenfalls liefert — nur mit 20 statt 10 Zentimetern.
   */
  hb: {
    url: wms(
      "https://geodienste.bremen.de/wms_dop10_2023?",
      "DOP10_2023_HB,DOP10_2023_BHV",
    ),
    minzoom: 13,
    maxzoom: 20,
    ttlMs: WEEK,
    grenzeDurchsichtig: true,
    bounds: [8.4598, 53.0062, 9.0139, 53.6128],
    vorrang: 3,
  },

  /* ── Länder OHNE Hybridformat ─────────────────────────────────────────────
   *
   * Diese Dienste kennen nur JPEG oder PNG. JPEG scheidet aus: Außerhalb des
   * Landes liefern sie dann eine deckende Fläche — gemessen weiß bei BW, BB,
   * SN und TH, schwarz bei SH — und die legt sich über alles darunter. Bleibt
   * PNG mit Transparenz, und das kostet: dieselbe Kachel wiegt je nach Land das
   * Drei- bis Elffache eines JPEG. Der Preis ist bewusst bezahlt, damit diese
   * Länder überhaupt scharfe Bilder bekommen — `pngZuJpeg` holt ihn hinterher
   * zum größten Teil zurück.
   * ────────────────────────────────────────────────────────────────────────── */

  /** Baden-Württemberg, 20 cm. Liefert ein Paletten-PNG, daher nur 3,7-fach. */
  bw: {
    url: wms(
      "https://owsproxy.lgl-bw.de/owsproxy/ows/WMS_LGL-BW_ATKIS_DOP_20_C?",
      "IMAGES_DOP_20_RGB",
      "image/png",
    ),
    minzoom: 13,
    maxzoom: 19,
    ttlMs: WEEK,
    grenzeDurchsichtig: true,
    bounds: [7.2, 47.4, 10.7, 50.0],
  },
  /** Brandenburg, 20 cm — der Dienst deckt Brandenburg UND Berlin ab. */
  bb: {
    url: wms(
      "https://isk.geobasis-bb.de/mapproxy/dop20c/service/wms?",
      "bebb_dop20c",
      "image/png",
    ),
    minzoom: 13,
    maxzoom: 19,
    ttlMs: WEEK,
    grenzeDurchsichtig: true,
    bounds: [11.2291, 51.3063, 14.7702, 53.5726],
  },
  /**
   * Berlin, 20 cm — als ECHTES Orthofoto, also ohne gekippte Gebäude.
   *
   * Liegt vollständig im Rechteck von Brandenburg, das Berlin zwar mitliefert,
   * aber als gewöhnliches Orthofoto. In dichter Bebauung ist der Unterschied
   * deutlich sichtbar — daher `vorrang`.
   */
  be: {
    url: wms(
      "https://gdi.berlin.de/services/wms/truedop_2024?",
      "truedop_2024",
      "image/png",
    ),
    minzoom: 13,
    maxzoom: 19,
    ttlMs: WEEK,
    grenzeDurchsichtig: true,
    bounds: [13.0476, 52.3164, 13.7674, 52.6854],
    vorrang: 3,
  },
  /**
   * Sachsen, 20 cm. ACHTUNG: Der Dienst antwortet auf das Hybridformat mit dem
   * Kopf `image/jpeg`, schickt aber PNG-Bytes — deshalb hier ausdrücklich PNG
   * anfragen. Ausgeliefert wird ohnehin, was in den Bytes steht (`sniffType`).
   */
  sn: {
    url: wms(
      "https://geodienste.sachsen.de/wms_geosn_dop-rgb/guest?",
      "sn_dop_020",
      "image/png",
    ),
    minzoom: 13,
    maxzoom: 19,
    ttlMs: WEEK,
    grenzeDurchsichtig: true,
    bounds: [11.7889, 50.1506, 15.0869, 51.7209],
  },
  /** Schleswig-Holstein, 20 cm. */
  sh: {
    url: wms(
      "https://dienste.gdi-sh.de/WMS_SH_DOP20col_OpenGBD?",
      "sh_dop20_rgb",
      "image/png",
    ),
    minzoom: 13,
    maxzoom: 19,
    ttlMs: WEEK,
    grenzeDurchsichtig: true,
    bounds: [7.8232, 53.2988, 11.4155, 55.1543],
  },
  /** Thüringen, 20 cm. */
  th: {
    url: wms(
      "https://www.geoproxy.geoportal-th.de/geoproxy/services/DOP?",
      "th_dop",
      "image/png",
    ),
    minzoom: 13,
    maxzoom: 19,
    ttlMs: WEEK,
    grenzeDurchsichtig: true,
    bounds: [9.8548, 50.1544, 12.7119, 51.6637],
  },

  /* ── Nachbarländer und weitere europäische Dienste ────────────────────── */

  /** Niederlande — 8 cm, das schärfste Material in dieser Liste. CC BY (Kadaster). */
  nl: {
    url: (z, x, y) =>
      `https://service.pdok.nl/hwh/luchtfotorgb/wmts/v1_0/Actueel_orthoHR/EPSG:3857/${z}/${x}/${y}.jpeg`,
    minzoom: 13,
    maxzoom: 21,
    ttlMs: WEEK,
    bounds: [3.2, 50.74, 7.23, 53.56],
  },

  /** Österreich — 30 cm. ACHTUNG: Zeile VOR Spalte, also `{z}/{y}/{x}`. */
  at: {
    url: (z, x, y) =>
      `https://maps.wien.gv.at/basemap/bmaporthofoto30cm/normal/google3857/${z}/${y}/${x}.jpeg`,
    minzoom: 13,
    maxzoom: 20,
    ttlMs: WEEK,
    bounds: [9.52, 46.36, 17.17, 49.03],
  },

  /** Schweiz — 10 bis 25 cm, swisstopo. */
  ch: {
    url: (z, x, y) =>
      `https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.swissimage/default/current/3857/${z}/${x}/${y}.jpeg`,
    minzoom: 13,
    maxzoom: 20,
    ttlMs: WEEK,
    bounds: [5.95, 45.81, 10.5, 47.81],
  },

  /**
   * FRANKREICH — IGN BD ORTHO, 20 cm. Der Anlass für diese ganze Runde.
   *
   * Gemeldet wurde „ich habe in Paris reingezoomt, das kann doch nicht die 2 m
   * sein". Konnte es auch nicht: Für Frankreich gab es gar keine eigene Ebene,
   * dort endete alles bei der europaweiten Schicht mit 2 Metern — und die wurde
   * ab Zoom 17 nur noch gestreckt. Nachgemessen am mittleren Bildgradienten
   * derselben Stelle in Paris bei Zoom 16: 8,77 bei Copernicus gegen 14,12 hier,
   * und dieser Dienst hält die Schärfe bis Zoom 19 durch (11,77 bei Zoom 18).
   * Im Bild sind damit einzelne Autos und Zebrastreifen zu erkennen.
   *
   * LIZENZ: Licence Ouverte / Open Licence 2.0 (Etalab). Das IGN hat seine
   * öffentlichen Daten zum 1. Januar 2021 darunter freigegeben; die Lizenz
   * erlaubt Vervielfältigung, Bearbeitung und ausdrücklich die kommerzielle
   * Verwertung, verlangt aber die Quellenangabe („© IGN"). Die steht im
   * `attribution`-Feld der Quelle in `mapStyle.ts` — wer sie löscht, nutzt die
   * Bilder unlizenziert. Das Fähigkeiten-Dokument nennt zudem `Fees: none`.
   *
   * Kein Schlüssel nötig: Die Géoplateforme liefert seit 2021 frei. Die
   * Rastersatz-Kennung `PM` und `PM_0_19` liefern byteweise dasselbe Bild
   * (nachgeprüft, gleiche Prüfsumme); `PM` ist die kürzere und stabilere.
   */
  fr: {
    url: (z, x, y) =>
      `https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0` +
      `&LAYER=ORTHOIMAGERY.ORTHOPHOTOS&STYLE=normal&TILEMATRIXSET=PM` +
      `&TILEMATRIX=${z}&TILEROW=${y}&TILECOL=${x}&FORMAT=image/jpeg`,
    minzoom: 13,
    maxzoom: 19,
    ttlMs: WEEK,
    bounds: [-5.15, 41.33, 9.56, 51.09],
  },

  /**
   * SPANIEN — PNOA Máxima Actualidad, 25 bis 50 cm.
   *
   * Lizenz wörtlich aus dem Fähigkeiten-Dokument: `Fees: No se aplican
   * condiciones`, `AccessConstraints: CC BY 4.0 scne.es`. Also kommerziell
   * nutzbar gegen Namensnennung.
   */
  es: {
    url: pnoa,
    minzoom: 13,
    maxzoom: 20,
    ttlMs: WEEK,
    bounds: [-9.31, 35.95, 4.33, 43.79],
    /**
     * ANDORRA liegt im Rechteck, gehört aber nicht zum PNOA. Der Dienst füllt
     * es mit einem Mosaik aus Klötzen von Dutzenden Metern (Detail 0,09 auf
     * Stufe 19) — nachgesehen am Bild, nicht nur an der Zahl. Copernicus ist
     * dort weit besser. Das Rechteck umfasst das Fürstentum mit etwas Rand.
     *
     * Und der größte Teil PORTUGALS: Spaniens Rechteck reicht über das ganze
     * Land, und weil es größer ist, stand es bei Sagres in der Vorsortierung
     * sogar VOR Portugal. Gefragt wurde dann zuerst ein Dienst, der dort nur
     * eine Farbfläche hat (Detail 0,04) oder gar nicht antwortet — jede
     * portugiesische Kachel kostete eine sinnlose Anfrage, und fiel sie aus,
     * bekam die Kachel nur fünf Minuten Haltbarkeit. Westlich von 7,6° W und
     * südlich von 41,85° N ist alles Portugal: Spaniens westlichste Punkte im
     * Süden sind Ayamonte (7,42° W) und Olivenza (7,1° W), Galicien beginnt
     * nördlich des Minho.
     */
    ohne: [
      [1.4, 42.42, 1.79, 42.66],
      [-9.6, 36.9, -7.6, 41.85],
    ],
    dienst: "es",
  },
  /**
   * Die KANAREN als eigene Zeile, nicht als größeres Rechteck.
   *
   * Ein Rechteck um Festland und Inseln zusammen reichte bis Marokko und weit
   * in den Atlantik — jede Kachel dort wäre eine Anfrage für nichts. Zwei
   * getrennte Rechtecke überlappen sich nicht und kosten nichts. Derselbe
   * Dienst, deshalb dieselbe Warteschlange über `dienst`.
   */
  es_ic: {
    url: pnoa,
    minzoom: 13,
    maxzoom: 20,
    ttlMs: WEEK,
    bounds: [-18.2, 27.6, -13.4, 29.47],
    dienst: "es",
  },

  /**
   * LUXEMBURG — Administration du cadastre et de la topographie.
   *
   * Sauberste Lizenz der Liste: `Fees: none`, `AccessConstraints: none`, der
   * Dienst heißt selbst „Open Data". Liefert bis Zoom 21.
   */
  lu: {
    url: (z, x, y) =>
      `https://wmts1.geoportail.lu/opendata/wmts/ortho_latest/GLOBAL_WEBMERCATOR_4_V3/${z}/${x}/${y}.jpeg`,
    minzoom: 13,
    maxzoom: 20,
    ttlMs: WEEK,
    bounds: [5.73, 49.44, 6.53, 50.19],
  },

  /**
   * POLEN — Ortofotomapa des Geoportals, 25 cm.
   *
   * `AccessConstraints: brak ograniczeń` — „keine Einschränkungen". Die
   * Stufenkennung trägt hier den Rastersatz im Namen (`EPSG:3857:17`), nicht
   * bloß die Zahl.
   */
  pl: {
    url: (z, x, y) =>
      `https://mapy.geoportal.gov.pl/wss/service/PZGIK/ORTO/WMTS/StandardResolution` +
      `?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=ORTOFOTOMAPA&STYLE=default` +
      `&TILEMATRIXSET=EPSG:3857&TILEMATRIX=EPSG:3857:${z}&TILEROW=${y}&TILECOL=${x}` +
      `&FORMAT=image/jpeg`,
    minzoom: 13,
    maxzoom: 19,
    ttlMs: WEEK,
    bounds: [14.12, 49.0, 24.15, 54.84],
  },

  /**
   * ITALIEN — Ortofoto a colori, 50 cm, Bildflug 2012.
   *
   * ZWEI Ebenen in einem Aufruf, wie bei Bremen: Der Dienst trennt das Land an
   * der UTM-Zonengrenze (32 für den Westen, 33 für den Osten). Mit nur einer
   * bliebe die halbe Halbinsel leer.
   *
   * Lizenz wörtlich aus dem Fähigkeiten-Dokument: `Fees: Nessuna condizione
   * applicata`, `AccessConstraints: Nessuno` — keine Bedingung, keine
   * Einschränkung.
   *
   * 50 cm sind nicht die 20 cm Frankreichs, aber viermal feiner als die
   * europaweite Schicht. Gemessen am mittleren Bildgradienten in Rom bei Zoom
   * 16: 31,68 hier gegen 22,67 bei Copernicus, in Mailand 28,52 gegen 10,00.
   */
  it: {
    url: wms(
      "https://wms.pcn.minambiente.it/ogc?map=/ms_ogc/WMS_v1.3/raster/ortofoto_colore_12.map&",
      "OI.ORTOIMMAGINI.2012.32,OI.ORTOIMMAGINI.2012.33",
      /**
       * JPEG, obwohl PNG außerhalb Italiens sauber durchsichtig wäre.
       *
       * Der Grund ist das Gewicht: Dieselbe Kachel wiegt als PNG 210 239 und
       * als JPEG 25 879 Byte — das Achtfache. Ein Bildschirm voll wären elf
       * Megabyte, die unser Server holen und dann auch noch entpacken und
       * umpacken müsste; gemessen brauchte ein Bildschirm in Rom damit 15
       * Sekunden. Ein Hybridformat kennt dieser Dienst nicht (geprüft: er
       * antwortet darauf mit 478 Byte Unsinn).
       *
       * Außerhalb Italiens kommt damit eine weiße Kachel statt einer
       * durchsichtigen — und genau dafür gibt es `pruefe` und `locherStanzen`.
       * Nachgemessen ist die Außenkachel einfarbig weiß (1651 Byte) und wird
       * als leer erkannt.
       */
      "image/jpeg",
    ),
    minzoom: 13,
    maxzoom: 19,
    ttlMs: WEEK,
    bounds: [6.6, 35.4, 18.55, 47.1],
    spurzahl: 6,
  },

  /**
   * PORTUGAL — OrtoSat 2023 der Direção-Geral do Território.
   *
   * `Fees: no conditions apply`, `AccessConstraints: None`.
   *
   * Nur das Festland: Azoren und Madeira liegen in eigenen Kacheldiensten und
   * wären je eine weitere Zeile. Dort bleibt es vorerst bei der europaweiten
   * Schicht.
   */
  pt: {
    url: wms(
      "https://ortos.dgterritorio.gov.pt/wms/ortosat2023?",
      "ortoSat2023-CorVerdadeira",
      /**
       * PNG ist hier keine Wahl, sondern eine Feststellung: Der Dienst
       * antwortet auch auf `image/jpeg` mit PNG (nachgeprüft, beide Male
       * dieselben 62 616 Byte). Immerhin markiert er damit außerhalb Portugals
       * sauber durchsichtig (116 Byte). Unser Server packt die deckenden
       * Kacheln ohnehin in JPEG um, das Gewicht trifft also nur die Strecke
       * zwischen ihm und Lissabon.
       */
      "image/png",
    ),
    minzoom: 13,
    maxzoom: 19,
    ttlMs: WEEK,
    grenzeDurchsichtig: true,
    bounds: [-9.55, 36.95, -6.18, 42.16],
    zeitgrenze: 30_000,
    /**
     * HÖCHSTENS VIER GLEICHZEITIG, und kein Nachzügler — sonst sperrt der
     * Dienst uns aus.
     *
     * Nachgemessen aus dem Server heraus, Stufe 19: Nacheinander und zu zweit
     * kommen die Kacheln in 1 bis 7 Sekunden, einzelne in 15. Zu viert steigen
     * die Zeiten zum Ende auf 10 bis 13 Sekunden, und eine läuft in die Frist
     * — das ist die Kapazität des Dienstes. Mit den 24 Spuren, die hier vorher
     * galten, und dem Nachzügler obendrauf nahm er nach rund neun Abrufen gar
     * keine Verbindung mehr an (`UND_ERR_CONNECT_TIMEOUT` nach zehn Sekunden),
     * und zwar für einige Minuten — während derselbe Dienst vom Rechner daneben
     * normal antwortete. In Porto stand dadurch auf Stufe 19 in 18 von 25
     * Kacheln Copernicus.
     */
    spurzahl: 4,
    nachzuegler: false,
  },

  /**
   * SLOWENIEN — DOF 025, also 25 cm.
   *
   * `Fees: none`, `AccessConstraints: none`. Die Ebene trägt den Zusatz
   * `_3857` und liegt damit schon in unserem Raster — kein Umprojizieren.
   */
  si: {
    url: wms(
      "https://ipi.eprostor.gov.si/wms-si-gurs-dts/wms?",
      "SI.GURS.ZPDZ:DOF025_3857",
      // Wie Italien: PNG wiegt hier 156 415 Byte, JPEG 18 177. Die Außenkachel
      // ist einfarbig weiß und wird erkannt.
      "image/jpeg",
    ),
    minzoom: 13,
    maxzoom: 19,
    ttlMs: WEEK,
    bounds: [13.37, 45.42, 16.61, 46.88],
  },

  /**
   * TSCHECHIEN — Ortofoto ČR als fertiger Kachelsatz in Web-Mercator.
   *
   * `© ČÚZK`, der Dienst ist ausdrücklich öffentlich. Achtung: Zeile vor
   * Spalte, wie bei allen ArcGIS-Kachelsätzen.
   *
   * Es gibt auch einen klassischen Kartendienst, dessen Kachelspeicher liegt
   * aber in S-JTSK (EPSG:5514) — der müsste für jede Kachel umprojiziert
   * werden. Dieser hier ist bereits in 3857 vorgerechnet.
   */
  cz: {
    url: (z, x, y) =>
      `https://ags.cuzk.gov.cz/arcgis1/rest/services/ORTOFOTO_WM/MapServer/tile/${z}/${y}/${x}`,
    minzoom: 13,
    maxzoom: 19,
    ttlMs: WEEK,
    bounds: [12.09, 48.55, 18.87, 51.06],
  },

  /**
   * ESTLAND — Maa-ameti fotokaart.
   *
   * `Fees: tasuta / none`, `AccessConstraints: none` — „tasuta" heißt
   * kostenlos.
   *
   * ACHTUNG, das Kachelschema ist TMS und nicht XYZ: Die Zeilen zählen von
   * UNTEN. Deshalb `2^z - 1 - y`. Wer das vergisst, bekommt Estland gespiegelt.
   */
  ee: {
    url: (z, x, y) =>
      `https://tiles.maaamet.ee/tm/tms/1.0.0/foto@GMC/${z}/${x}/${2 ** z - 1 - y}.jpg`,
    minzoom: 13,
    maxzoom: 19,
    ttlMs: WEEK,
    bounds: [21.76, 57.5, 28.21, 59.7],
  },

  /**
   * SACHSEN-ANHALT — 20 cm.
   *
   * Hier stand lange „keine Lizenzangabe im Dienst", und das stimmte auch: Im
   * Fähigkeiten-Dokument sind `Fees` und `AccessConstraints` beide leer. Die
   * Angabe liegt aber im Metadatensatz, auf den der Dienst selbst verweist
   * (`MetadataURL` → metaver.de). Dort steht wörtlich „Datenlizenz Deutschland
   * Namensnennung 2.0" mit dem Quellenvermerk „© GeoBasis-DE / LVermGeo ST" —
   * also kommerziell nutzbar gegen Namensnennung. Der Vermerk steht in
   * `mapStyle.ts`.
   *
   * Lehre daraus: Ein leeres `AccessConstraints` heißt nicht „keine Lizenz",
   * sondern „hier steht sie nicht". Der Verweis gehört mitgelesen.
   */
  st: {
    url: wms(
      "https://www.geodatenportal.sachsen-anhalt.de/wss/service/ST_LVermGeo_DOP_WMS_OpenData/guest?",
      "lsa_lvermgeo_dop20_2",
      "image/png",
    ),
    minzoom: 13,
    maxzoom: 19,
    ttlMs: WEEK,
    grenzeDurchsichtig: true,
    bounds: [10.56, 50.93, 13.19, 53.04],
  },

  /**
   * MECKLENBURG-VORPOMMERN — 20 cm, mit weggeschnittenem Aufdruck.
   *
   * Lizenz wörtlich aus dem Fähigkeiten-Dokument: `Fees: Es gelten keine
   * Bedingungen`. Die Auflage ist ein „deutlich sichtbarer Quellenvermerk"
   * im Wortlaut „© GeoBasis-DE/M-V <Jahr>" — der steht in `mapStyle.ts` in der
   * ⓘ-Schaltfläche der Karte. Wer ihn dort löscht, nutzt die Bilder
   * unlizenziert.
   *
   * Der Dienst brennt denselben Vermerk zusätzlich in jede Kachel. Das ist
   * der Grund, warum das Land lange fehlte und warum in Schwerin beim
   * Hineinzoomen nichts schärfer wurde. Siehe `zuschnitt`: 128 Bildpunkte
   * links und 64 oben sind reichlich für einen Aufdruck, der bis x 94 und y 17
   * reicht.
   */
  mv: {
    url: wmsMitRand(
      "https://www.geodaten-mv.de/dienste/adv_dop?",
      "mv_dop",
      [128, 64],
      "image/jpeg",
    ),
    minzoom: 13,
    maxzoom: 19,
    ttlMs: WEEK,
    bounds: [10.59, 53.1, 14.41, 54.69],
    zuschnitt: [128, 64],
  },

  /**
   * KROATIEN — DOF5, 50 cm.
   *
   * `Fees: NONE`, `AccessConstraints: NONE` laut Fähigkeiten-Dokument.
   *
   * ACHTUNG BEI DER EBENENWAHL: Der Dienst führt drei Orthofoto-Ebenen, und
   * die neueste ist die einzige unbrauchbare. `DOF05_VPI_2024` liefert für
   * Zagreb und Dubrovnik dieselben 2661 Byte — einen Platzhalter, kein Bild.
   * Daran wäre Kroatien beinahe ausgeschieden. `DOF_LIDAR_2022_2023` ist echt,
   * deckt aber nur die Befliegungsgebiete ab und ist im Mittel gröber
   * (gemessen in Split bei Zoom 18: Gradient 7,03 gegen 9,50). Übrig bleibt
   * `DOF5_2011` — älter, aber flächendeckend und durchweg das schärfste.
   */
  hr: {
    url: wms(
      "https://geoportal.dgu.hr/services/dof/wms?",
      "DOF5_2011",
      "image/jpeg",
    ),
    minzoom: 13,
    maxzoom: 19,
    ttlMs: WEEK,
    bounds: [13.49, 42.38, 19.45, 46.56],
  },

  /**
   * HAMBURG — 20 cm, und die Jahreszahl ist eine LIZENZFRAGE.
   *
   * Hamburg fehlte lange, weil ich die Adresse nicht fand und die neueren
   * Jahrgänge als zugekaufte Satellitenbilder galten. Beides stimmte nur halb.
   * Der Dienst ist eine Zeitreihe und MISCHT zwei Lizenzen — wörtlich aus dem
   * Fähigkeiten-Dokument:
   *
   *   „Datenlizenz Deutschland Namensnennung 2.0, Quellenvermerk: Freie und
   *    Hansestadt Hamburg, Landesbetrieb Geoinformation und Vermessung (LGV),
   *    Andere geschlossene Lizenz, Quellenvermerk: Pléiades 1A/B © CNES (2022),
   *    Distribution Airbus DS"
   *
   * Welcher Jahrgang welche Lizenz hat, steht im Metadatensatz: betroffen sind
   * 2022 (belaubt) und 2023 (unbelaubt) — das sind die zugekauften
   * Satellitenbilder. 2024 ist eine eigene Befliegung des LGV unter
   * dl-de/by-2.0.
   *
   * DESHALB `TIME=2024` FEST. Ohne die Angabe greift die Voreinstellung des
   * Dienstes, und die wandert mit jedem neuen Bildflug weiter — irgendwann auf
   * ein Satellitenjahr, und dann verteilen wir unlizenziertes Material, ohne
   * dass sich irgendetwas im Code geändert hätte. Wer die Jahreszahl anfasst,
   * prüft vorher den Metadatensatz.
   */
  hh: {
    url: (z, x, y) =>
      wms(
        "https://geodienste.hamburg.de/wms_dop_zeitreihe_belaubt?",
        "dop_zeitreihe_belaubt",
      )(z, x, y) + "&TIME=2024",
    minzoom: 13,
    maxzoom: 20,
    ttlMs: WEEK,
    grenzeDurchsichtig: true,
    bounds: [9.7218, 53.3856, 10.3496, 53.7504],
  },

  /**
   * BELGIEN, FLANDERN — 15 cm, und Brüssel ist mit drin.
   *
   * Die Lizenz stand nicht im Dienst, sondern im Metadatensatz des DATENSATZES
   * (nicht des Dienstes), und der ist nur über die GeoNetwork-Schnittstelle zu
   * holen, nicht über die Katalogseite. Wörtlich, Feld `otherConstraints`:
   *
   *   „Modellicentie voor gratis hergebruik" (data.vlaanderen.be, v1.0)
   *   Quellenvermerk: „Bron: Digitaal Vlaanderen"
   *
   * Die Modellizenz erlaubt ausdrücklich „elk commercieel of niet-commercieel
   * hergebruik voor onbepaalde duur"; einzige Auflage ist der Quellenvermerk,
   * und der steht in `mapStyle.ts`.
   *
   * Die Ebene `omwrgbmrvl` („meest recent") und nicht ein Jahrgang: Sie wird
   * bei jedem Teilbildflug fortgeschrieben. Das Raster `GoogleMapsVL` ist das
   * gewöhnliche Mercator-Raster, also kein Zoom-Versatz.
   *
   * BRÜSSEL BRAUCHT KEINE EIGENE ZEILE: Das flämische Mosaik schließt die
   * Region Brüssel-Hauptstadt ein — nachgemessen, Brüssel-Zentrum liefert ein
   * eigenes Bild mit Streuung 42.
   */
  be_vl: {
    url: (z, x, y) =>
      `https://geo.api.vlaanderen.be/OMWRGBMRVL/wmts?SERVICE=WMTS&REQUEST=GetTile` +
      `&VERSION=1.0.0&LAYER=omwrgbmrvl&STYLE=&TILEMATRIXSET=GoogleMapsVL` +
      `&TILEMATRIX=${z}&TILEROW=${y}&TILECOL=${x}&FORMAT=image/png`,
    minzoom: 13,
    maxzoom: 20,
    ttlMs: WEEK,
    bounds: [2.53, 50.685, 5.92, 51.52],
  },

  /**
   * BELGIEN, WALLONIEN — 25 cm.
   *
   * Auch hier lag die Lizenz nicht dort, wo der Dienst hinzeigt. Das
   * Bedingungs-PDF sagt in Artikel 1 selbst, dass die Datenlizenz „dans les
   * métadonnées des services dans Métawal" steht. Der Metadatensatz nennt
   * wörtlich:
   *
   *   „Licence CC-BY 4.0 : L'utilisateur peut utiliser et modifier les données
   *    pour en dériver une œuvre. Il peut publier les données et l'œuvre
   *    dérivée à condition de citer les sources."
   *
   * Dazu `noLimitations` und `useConstraints: licenceUnrestricted`.
   * Kommerzielle Nutzung also erlaubt, Quellenvermerk „© SPW" Pflicht.
   */
  be_wa: {
    url: arcgis(
      "https://geoservices.wallonie.be/arcgis/rest/services/IMAGERIE/ORTHO_LAST/MapServer/export",
    ),
    minzoom: 13,
    maxzoom: 20,
    ttlMs: WEEK,
    grenzeDurchsichtig: true,
    bounds: [2.75, 49.44, 6.45, 50.86],
  },

  /**
   * SLOWAKEI — Ortofotomozaika SR, 20 bis 25 cm.
   *
   * Fertiger Kachelsatz in Web-Mercator, Zeile vor Spalte wie bei allen
   * ArcGIS-Kachelsätzen. Das Fähigkeiten-Dokument des zugehörigen
   * Kartendienstes nennt weder Gebühren noch Bedingungen — die Lizenz hängt am
   * INSPIRE-Eintrag desselben Dienstes und lautet CC BY 4.0. Quellenvermerk aus
   * dem `copyrightText` des Dienstes: „GKÚ, NLC".
   */
  sk: {
    url: (z, x, y) =>
      `https://zbgis.skgeodesy.sk/zbgis/rest/services/Ortofoto/MapServer/tile/${z}/${y}/${x}`,
    minzoom: 13,
    maxzoom: 19,
    ttlMs: WEEK,
    bounds: [16.83, 47.73, 22.57, 49.62],
  },

  /**
   * RUMÄNIEN — Ortoimagini 1:5000, rund 50 cm.
   *
   * Die Adresse ist der Punkt: Nicht das Katasteramt hat die Bilder, sondern
   * das Verteidigungsministerium (Direcția Topografică Militară) unter
   * `inspire.geomil.ro`. Am Katasterportal war die Suche mehrfach gescheitert.
   *
   * Lizenz aus dem Datensatz auf data.gov.ro: `license_id: "CC-BY-4.0"`,
   * Herausgeber „Ministerul Apărării Naționale" — und genau diese Dienstadresse
   * ist dort als Ressource eingetragen, die Lizenz gilt also dem Dienst und
   * nicht bloß einem Download daneben.
   *
   * Obergrenze 18: Ab 19 fällt die gemessene Streuung von 37,8 auf 24,0, dort
   * rechnet der Dienst nur noch hoch.
   */
  ro: {
    url: arcgis(
      "https://inspire.geomil.ro/network/rest/services/INSPIRE/OI_View/MapServer/export",
    ),
    minzoom: 13,
    maxzoom: 18,
    ttlMs: WEEK,
    grenzeDurchsichtig: true,
    bounds: [20.26, 43.62, 29.71, 48.27],
  },

  /**
   * LITAUEN — ORT10LT, 20 cm.
   *
   * `Fees: no conditions apply`, `AccessConstraints: None` im
   * Fähigkeiten-Dokument, und im Datensatz auf data.gov.lt zusätzlich
   * ausdrücklich CC BY 4.0. Quellenvermerk „© NŽT".
   *
   * Die Ebene heißt schlicht `OI` und ist die Dachgruppe über allen
   * Bildflügen. Der naheliegendere Endpunkt `/mapproxy/service` verlangt eine
   * Anmeldung; `inspire_oi` ist der offene.
   */
  lt: {
    url: wms(
      "https://www.geoportal.lt/mapproxy/inspire_oi?",
      "OI",
      "image/jpeg",
    ),
    /**
     * MINDESTSTUFE 15, und das ist gemessen, nicht übernommen.
     *
     * Auf den Stufen 12 bis 14 liefert dieser Dienst kein Luftbild, sondern
     * eine fast leere Übersicht: 2524 Byte, davon 99,1 Prozent reinweiß. Das
     * ist zu Recht als „nichts" eingestuft worden — nur hat es dann über die
     * Elternkachel auch die Stufen 15 bis 19 mitgesperrt, die echte Bilder
     * haben (37 296 Byte, Streuung 54 auf Stufe 15). An drei Städten geprüft:
     * Vilnius, Kaunas, Klaipėda verhalten sich gleich.
     *
     * Also gar nicht erst unterhalb von 15 fragen. Alle übrigen 37 Quellen
     * sind gegengeprüft und liefern ab 13 ein echtes Bild.
     */
    minzoom: 15,
    maxzoom: 19,
    ttlMs: WEEK,
    bounds: [20.93, 53.89, 26.84, 56.45],
  },

  /**
   * MOLDAU — das einzige Land östlich der EU-Grenze mit einem offenen Dienst.
   *
   * `Fees: NONE`, `AccessConstraints: NONE`, im Metadatensatz bestätigt mit
   * „no limitations to public access" und „no conditions to access and use".
   *
   * Wichtig für die Abdeckung: Moldau liegt AUSSERHALB des Copernicus-Mosaiks
   * — dort gab es bisher nur das weltweite Satellitenbild mit 10 Metern. Das
   * ist der einzige der neuen Dienste, der eine echte weiße Stelle auf der
   * Karte schließt statt eine vorhandene zu verbessern.
   */
  md: {
    url: wms(
      "https://geodata.gov.md/geoserver/ows?",
      "orthophoto:Ortofoto",
      "image/jpeg",
    ),
    minzoom: 13,
    maxzoom: 18,
    ttlMs: WEEK,
    bounds: [26.62, 45.47, 30.14, 48.49],
  },

  /**
   * ZYPERN — 10 cm, Bildflug 2014.
   *
   * Lizenz belegt über den Katalogdienst des Amtes selbst, Satz „ANNEX 2 |
   * Orthoimagery (View Data Service)", dessen Adresse genau auf diesen Dienst
   * zeigt: „Δεν υπάρχουν περιορισμοί" (keine Einschränkungen) und „Ανοικτής
   * Άδειας Χρήσης" (offene Nutzungslizenz).
   *
   * Es gibt einen neueren Kachelsatz von 2019, der bis Stufe 21 reicht — aber
   * ohne jede Lizenzangabe, in keinem Metadatensatz auffindbar. Der ist
   * deshalb bewusst NICHT genommen.
   *
   * Das Rechteck deckt nur das von der Republik verwaltete Gebiet.
   */
  cy: {
    url: arcgis(
      "https://eservices.dls.moi.gov.cy/inspire/rest/services/INSPIRE/OI_Orthoimagery/MapServer/export",
    ),
    minzoom: 13,
    maxzoom: 20,
    ttlMs: WEEK,
    grenzeDurchsichtig: true,
    bounds: [32.24, 34.55, 34.1, 35.72],
  },

  /**
   * LIECHTENSTEIN — Orthophoto 2020.
   *
   * Die Bedingungen der Landesverwaltung sagen es wörtlich: „Daten dürfen
   * kommerziell und nicht-kommerziell genutzt werden. … Eine Quellenangabe
   * muss in geeigneter Weise angebracht werden." Dazu `Fees: No fees for this
   * service`.
   *
   * OBERGRENZE 18, und das ist eine harte Grenze des Dienstes: Das
   * Fähigkeiten-Dokument behauptet Stufen bis 21, aber ab 19 antwortet er mit
   * „invalid TILEMATRIX". Die Pyramide ist schlicht nicht weiter gerechnet.
   *
   * Nur diese eine Ebene ist brauchbar — die neueren Jahrgänge liegen
   * ausschließlich im Schweizer Landesraster und müssten umprojiziert werden.
   */
  li: {
    url: (z, x, y) =>
      `https://service.geo.llv.li/mapcache/wmts?SERVICE=WMTS&REQUEST=GetTile` +
      `&VERSION=1.0.0&LAYER=li.llv.op2020_g&STYLE=default` +
      `&TILEMATRIXSET=GoogleMapsCompatible&TILEMATRIX=${z}&TILEROW=${y}&TILECOL=${x}` +
      `&FORMAT=image/png`,
    minzoom: 13,
    maxzoom: 18,
    ttlMs: WEEK,
    bounds: [9.47, 47.048, 9.64, 47.27],
  },

  /* ── Nordeuropa (Stand der Lizenzprüfung: 04.10.2026) ────────────────── */

  /**
   * FINNLAND — Maanmittauslaitos (NLS), Ortokuva, 0,5 m.
   *
   * Lizenz: CC BY 4.0 (https://www.maanmittauslaitos.fi/en/opendata-licence-cc40),
   * kommerziell erlaubt. Die Nutzungsbedingungen der offenen Schnittstelle
   * (Stand 29.09.2026) erlauben „testing and production purposes in a service
   * in which performance is not critical"; die technische Beschreibung
   * EMPFIEHLT ausdrücklich, Kacheln auf dem eigenen Server bis zu eine Woche
   * zwischenzuspeichern — genau das tut dieser Server.
   *
   * Schlüssel: persönlich und kostenlos (OmaTili), als Basic-Auth-Benutzer mit
   * leerem Passwort. Ohne `NLS_FI_API_KEY` ist die Quelle aus.
   *
   * Grenze: Der offene Dienst endet bei Stufe 16 (≈ 1 m); darüber wird
   * gestreckt. Das ist trotzdem schärfer als Copernicus mit 2 m.
   */
  ...(config.NLS_FI_API_KEY
    ? {
        fi: {
          url: (z: number, x: number, y: number) =>
            `https://avoin-karttakuva.maanmittauslaitos.fi/avoin/wmts/1.0.0/ortokuva/default/WGS84_Pseudo-Mercator/${z}/${y}/${x}.jpg`,
          headers: {
            Authorization: `Basic ${Buffer.from(`${config.NLS_FI_API_KEY}:`).toString("base64")}`,
          },
          minzoom: 13,
          maxzoom: 16,
          ttlMs: WEEK,
          bounds: [19.08, 59.45, 31.59, 70.09] as [number, number, number, number],
        } satisfies AerialSource,
      }
    : {}),

  /**
   * DÄNEMARK — Klimadatastyrelsen / GeoDanmark, „Ortofoto forår", 10–12,5 cm.
   *
   * Lizenz: „Vilkår for brug af frie geografiske data" — weltweites,
   * kostenloses, nicht-exklusives und sonst unbegrenztes Nutzungsrecht,
   * kommerziell wie nicht-kommerziell, Weitergabe erlaubt; GeoDanmark-Daten
   * stehen unter CC BY 4.0 („@geodanmark"). Namensnennung in mapStyle.ts.
   *
   * Schlüssel: kostenloser Token eines Dataforsyningen-Benutzers. Ohne
   * `DATAFORSYNINGEN_TOKEN` ist die Quelle aus (ohne Token antwortet der Dienst
   * mit 403).
   */
  ...(config.DATAFORSYNINGEN_TOKEN
    ? {
        dk: {
          url: wms(
            `https://api.dataforsyningen.dk/orto_foraar_DAF?token=${encodeURIComponent(config.DATAFORSYNINGEN_TOKEN)}&`,
            "orto_foraar",
            "image/jpeg",
          ),
          minzoom: 13,
          maxzoom: 20,
          ttlMs: WEEK,
          bounds: [8.07, 54.55, 15.2, 57.76] as [number, number, number, number],
        } satisfies AerialSource,
      }
    : {}),

  /**
   * ISLAND — Náttúrufræðistofnun (NÁTT), Luftbild-Mosaik, 25 cm (Hauptstadt 10 cm).
   *
   * Lizenz: CC BY 4.0 (Lizenz für die freien Daten des isländischen
   * Vermessungsamts; der Dienst meldet `Fees: no`). Kein Schlüssel.
   *
   * ABDECKUNG LÜCKENHAFT: Das landesweite 25-cm-Programm läuft 2024–2026.
   * Gemessen am 04.10.2026: Egilsstaðir scharf bis Stufe 18, Reykjavík,
   * Akureyri und Vík noch leer (durchsichtige 1,2-KB-Kachel — die erkennt
   * `pruefe` als leer, dann greift Copernicus). Wächst mit jedem Bildflug.
   */
  is: {
    url: wms("https://gis.natt.is/mapcache/web-mercator/wms?", "grunnkort-loftmynd", "image/jpeg"),
    minzoom: 13,
    maxzoom: 19,
    ttlMs: WEEK,
    bounds: [-24.6, 63.2, -13.4, 66.6],
  },

  /* ── Außerhalb Europas ───────────────────────────────────────────────── */

  /**
   * JAPAN — Geospatial Information Authority (国土地理院), 全国最新写真
   * (seamlessphoto), landesweit ab Stufe 14 bis 18.
   *
   * Bedingungen (maps.gsi.go.jp/development/ichiran.html): In Websites und Apps
   * „出典の明示のみで申請不要" — nur Quellenangabe, kein Antrag. Angabe
   * „国土地理院" mit Verweis auf die Kachelliste, siehe mapStyle.ts.
   * Außerhalb Japans antwortet der Dienst mit 404 (= leer).
   */
  jp: {
    url: (z, x, y) => `https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/${z}/${x}/${y}.jpg`,
    minzoom: 13,
    maxzoom: 18,
    ttlMs: WEEK,
    bounds: [122.9, 24.0, 146.0, 45.6],
  },

  /**
   * TAIWAN — National Land Surveying and Mapping Center (NLSC), WMTS „PHOTO2",
   * 25–50 cm. Lizenz: 政府資料開放授權條款－第1版 (Open Government Data
   * License 1.0, mit CC BY 4.0 vereinbar), kommerziell erlaubt, kein Schlüssel.
   */
  tw: {
    url: (z, x, y) => `https://wmts.nlsc.gov.tw/wmts/PHOTO2/default/GoogleMapsCompatible/${z}/${y}/${x}`,
    minzoom: 13,
    maxzoom: 19,
    ttlMs: WEEK,
    bounds: [118.1, 21.8, 122.1, 26.4],
  },

  /**
   * AUSTRALIEN, NEW SOUTH WALES (Sydney) — NSW Spatial Services, „NSW_Imagery",
   * meist 50 cm, Städte 10 cm. Lizenz: CC BY 3.0 AU (data.nsw.gov.au,
   * Datensatz „NSW Imagery"); einzelne Teile stammen von Dritten (© AAM,
   * © Jacobs/Ausimage) — die stehen mit in der Nennung (mapStyle.ts).
   * Die übrigen Bundesstaaten sind nicht offen (VIC kostenpflichtig, WA/TAS
   * nicht-kommerziell, SA ohne offene Lizenz; Stand 04.10.2026).
   */
  aunsw: {
    url: (z, x, y) =>
      `https://maps.six.nsw.gov.au/arcgis/rest/services/public/NSW_Imagery/MapServer/tile/${z}/${y}/${x}`,
    minzoom: 13,
    maxzoom: 20,
    ttlMs: WEEK,
    bounds: [140.99, -37.51, 153.64, -28.15],
  },

  /**
   * URUGUAY — IDE Uruguay, „ORTOFOTOS_2019" (Befliegung 2017–2018), ~30 cm.
   * Lizenz: Licencia de Datos Abiertos Uruguay (Namensnennung, kommerziell
   * erlaubt); Fähigkeiten-Dokument: Fees NONE, AccessConstraints NONE.
   */
  uy: {
    url: wms("https://mapas.ide.uy/geoserver-raster/ortofotos/ows?", "ORTOFOTOS_2019", "image/jpeg"),
    minzoom: 13,
    maxzoom: 19,
    ttlMs: WEEK,
    bounds: [-58.45, -35.0, -53.07, -30.08],
  },

  /**
   * GRÖNLAND — Asiaq Greenland Survey, „Byortofotos" (Orte und Siedlungen).
   * Bedingungen (Asiaq, freie Geodaten): weltweites, kostenloses,
   * nicht-exklusives und sonst unbegrenztes Nutzungsrecht, kommerziell
   * erlaubt. Abseits der Orte nichts — dann bleibt das weltweite Satellitenbild.
   */
  gl: {
    url: wms(
      "https://kort.nunagis.gl/refserver/services/Ortofoto/Byortofotos/ImageServer/WMSServer?",
      "Byortofotos",
      "image/jpeg",
    ),
    minzoom: 13,
    maxzoom: 19,
    ttlMs: WEEK,
    bounds: [-73.3, 59.7, -11.3, 83.7],
  },

  /**
   * USA — USGS The National Map, „USGS Imagery Only" (NAIP / HRO).
   *
   * Lizenz: Werk der US-Bundesregierung, gemeinfrei (public domain) —
   * kommerziell und mit Zwischenspeicher frei nutzbar. Quellenangabe
   * „USGS The National Map" ist üblich, siehe mapStyle.ts.
   *
   * Der Kachelspeicher reicht nur bis Stufe 16 (≈ 2 m in mittleren Breiten,
   * „visible to the 1:9,028 zoom scale"); darüber 404, also wird gestreckt.
   * Die volle NAIP-Auflösung (0,3–1 m) gäbe es über den Bilddienst
   * USGSNAIPPlus, der braucht aber 9–15 s je Kachel — zu langsam für die Karte.
   */
  us: {
    url: (z, x, y) =>
      `https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/${z}/${y}/${x}`,
    minzoom: 13,
    maxzoom: 16,
    ttlMs: WEEK,
    bounds: [-124.85, 24.4, -66.9, 49.4],
  },
  /** Hawaii — derselbe Dienst. */
  ushi: {
    url: (z, x, y) =>
      `https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/${z}/${y}/${x}`,
    minzoom: 13,
    maxzoom: 16,
    ttlMs: WEEK,
    bounds: [-160.3, 18.85, -154.75, 22.3],
  },

  /**
   * NEUSEELAND — LINZ Basemaps „aerial", 7,5 cm (Städte) bis 30 cm.
   *
   * Lizenz: CC BY 4.0 (Toitū Te Whenua LINZ). Schlüssel: kostenloser
   * Entwickler-Schlüssel; ohne `LINZ_API_KEY` ist die Quelle aus. JPEG
   * angefordert, weil `sniffType` nur JPEG und PNG kennt.
   */
  ...(config.LINZ_API_KEY
    ? {
        nz: {
          url: (z: number, x: number, y: number) =>
            `https://basemaps.linz.govt.nz/v1/tiles/aerial/WebMercatorQuad/${z}/${x}/${y}.jpeg?api=${encodeURIComponent(config.LINZ_API_KEY!)}`,
          minzoom: 13,
          maxzoom: 19,
          ttlMs: WEEK,
          bounds: [166.3, -47.4, 178.6, -34.3] as [number, number, number, number],
        } satisfies AerialSource,
      }
    : {}),

  /**
   * EUROPA als Ganzes — Copernicus VHR 2021, 2 Meter je Bildpunkt.
   *
   * Das ist der Lückenfüller zwischen den beiden Extremen: fünfmal schärfer als
   * das weltweite Satellitenbild (10 m) und überall dort vorhanden, wo es
   * keinen nationalen Dienst gibt — Italien, Portugal, Griechenland, der
   * Balkan, und die drei deutschen Länder, die hier fehlen.
   *
   * Lizenz laut Fähigkeiten-Dokument wörtlich: „Fees: No Condition Apply",
   * „AccessConstraints: No Limitation".
   *
   * Die Obergrenze ist die Auflösung und sie ist nachgerechnet, nicht
   * geschätzt: 2 Meter entsprechen bei mitteleuropäischer Breite ungefähr Zoom
   * 15,4. Der Vergleich Elternkachel-gegen-Kindkachel zeigt den Abfall an neuer
   * Information sauber — Fehler 33,9 / 31,0 / 17,8 / 9,1 / 5,8
   * Helligkeitsstufen für die Stufen 13 bis 17. Ab 16 wird also im Wesentlichen
   * nur noch interpoliert, und genau das sah man in Paris.
   *
   * KEIN `bounds`: Diese Quelle wird nie über die Gebietsauswahl gefunden,
   * sondern liegt in der App als eigene, darunterliegende Ebene.
   */
  eu: {
    url: (z, x, y) =>
      `https://copernicus.discomap.eea.europa.eu/arcgis/rest/services/GioLand/VHR_2021_LAEA/ImageServer/exportImage` +
      `?bbox=${tileBBox3857(z, x, y)}&bboxSR=3857&imageSR=3857&size=256,256&format=jpgpng&f=image`,
    minzoom: 9,
    maxzoom: 16,
    ttlMs: WEEK,
    grenzeDurchsichtig: true,
  },
};

/**
 * EIN GEBIET FÜR ALLES HOCHAUFGELÖSTE — der Server sucht die Quelle, nicht die
 * App.
 *
 * DAS WAR DER FEHLER, und er ist zweimal am Zugriffsprotokoll und einmal an den
 * Diensten selbst abgelesen:
 *
 * Erstens sind Länder keine Rechtecke. Werl liegt zugleich in den Rechtecken
 * von Nordrhein-Westfalen, Niedersachsen und Hessen; Köln liegt im Rechteck der
 * Niederlande; München in dem Österreichs. Die Karte hatte für jeden Ausschnitt
 * drei bis vier Ebenen gleichzeitig angefragt — gemessen 5592 Kachel-Anfragen
 * in einer halben Stunde, der größte Teil davon für Gebiete, die dort gar
 * nichts haben.
 *
 * Zweitens — und das war der weiße Bildschirm — antworten diese Dienste
 * außerhalb ihres Gebiets nicht mit einem Fehler, sondern mit einem DECKEND
 * WEISSEN Bild bei „200 OK". Nachgemessen: Der niederländische Dienst liefert
 * über Köln auf jeder Stufe ein 1651 Byte großes JPEG, Mittelwert 255,
 * Standardabweichung 0,00; der österreichische über München bei Zoom 18 dasselbe
 * mit 2419 Byte. Und weil deren Ebenen in der App ÜBER der deutschen lagen,
 * deckte dieses Weiß die Karte zu. Genau so kam die Meldung herein: „beim
 * Reinzoomen wurden die Tiles einfach weiß, Umgebung München".
 *
 * Jetzt kennt die Karte nur noch EIN hochaufgelöstes Gebiet. Welcher Dienst
 * gefragt wird, entscheidet hier die Mitte der Kachel, und was leer oder weiß
 * zurückkommt, wird erkannt (`pruefe`) und übersprungen statt ausgeliefert.
 */
const LOKALE_QUELLEN = Object.keys(SOURCES).filter(
  (k) => SOURCES[k]!.bounds !== undefined,
);

/**
 * Welche Quellen für diese Kachel in Frage kommen, beste zuerst.
 *
 * Das Maß ist die TIEFE im Rechteck (kleinster Abstand zu einer Kante), geteilt
 * durch die Wurzel aus dessen Fläche. Beide Teile sind nötig, und beide sind an
 * echten Fällen geprüft:
 *
 * Die Tiefe allein löste den Fall Osnabrück: Der Ort liegt näher an der MITTE
 * von Nordrhein-Westfalen, aber nur 0,29 Grad von dessen Kante und 1,13 Grad
 * von der niedersächsischen — wer knapp an der Kante liegt, ist wahrscheinlich
 * nur zufällig mit drin.
 *
 * Die Fläche musste dazukommen, als Frankreich und Österreich in die Liste
 * kamen. Deren Rechtecke sind so groß, dass sie halbe Nachbarländer
 * verschlucken: Karlsruhe liegt 1,16 Grad tief im französischen Rechteck, aber
 * nur 0,99 im baden-württembergischen — nach Tiefe allein hätte also Frankreich
 * gewonnen. Dahinter steckt eine einfache Wahrscheinlichkeit: Je größer das
 * Rechteck, desto kleiner der Anteil, den das Land darin wirklich ausfüllt.
 *
 * Nachgerechnet trifft die Kombination alle Prüffälle: Köln → NRW, Karlsruhe →
 * Baden-Württemberg, Straßburg → Frankreich, München → Bayern, Kassel → Hessen,
 * Osnabrück → Niedersachsen, Luxemburg → Luxemburg.
 */
function kandidaten(lat: number, lon: number): string[] {
  const drin = (b: [number, number, number, number]) =>
    lon >= b[0] && lon <= b[2] && lat >= b[1] && lat <= b[3];
  return LOKALE_QUELLEN.filter((k) => {
    const q = SOURCES[k]!;
    return drin(q.bounds!) && !(q.ohne ?? []).some(drin);
  }).sort((a, c) => guete(c) - guete(a));

  function guete(k: string): number {
    const q = SOURCES[k]!;
    const b = q.bounds!;
    const tiefe = Math.min(lon - b[0], b[2] - lon, lat - b[1], b[3] - lat);
    const flaeche = (b[2] - b[0]) * (b[3] - b[1]);
    return (tiefe / Math.sqrt(flaeche)) * (q.vorrang ?? 1);
  }
}

/**
 * Das GEDÄCHTNIS: Welche Quelle hat in dieser Gegend zuletzt geliefert?
 *
 * Auch die beste Vorsortierung rät nur — in Grenznähe kann sie danebenliegen,
 * und dann kostet die Kachel einen Fehlversuch. Sobald eine Quelle für eine
 * Gegend tatsächlich ein Bild geliefert hat, steht sie aber fest, und die
 * nächsten Kacheln daneben sparen sich die Suche.
 *
 * Der Schlüssel ist die Kachel auf Stufe 12, also ein Feld von rund zehn
 * Kilometern. Grob genug, dass ein Bildschirm hineinpasst, fein genug, dass es
 * fast nie über eine Landesgrenze reicht. Damit kostet eine falsche Vorsortierung
 * einmal je Gegend statt einmal je Kachel.
 */
const regionHinweis = new BoundedTtlCache<string>(4000, WEEK);

/**
 * Wer für die ELTERNKACHEL nichts hatte, hat hier auch nichts.
 *
 * Das ist kein Schätzwert, sondern eine Ableitung: Eine Kachel liegt
 * vollständig innerhalb ihrer Elternkachel. Hat eine Quelle für die
 * Elternkachel eine LEERE Antwort geliefert — durchsichtig, einfarbig oder
 * „nicht gefunden" —, dann hat sie für dieses Gebiet gar keine Daten, und
 * damit auch nicht für irgendeinen Teil davon. Die Quelle kann also
 * übersprungen werden, ohne sie zu fragen.
 *
 * WARUM NICHT EINFACHER, ÜBER EIN 10-KM-FELD: Weil ich das versucht habe und
 * es falsch war. Ein Feld dieser Größe über dem Rhein bei Straßburg enthält
 * französisches UND deutsches Gebiet. Zwei leere Antworten von
 * Baden-Württemberg auf französischer Seite hätten das Land für das ganze Feld
 * gesperrt — auch für die Kacheln östlich des Rheins, wo es mit 20 Zentimetern
 * liefert. Dort wäre dann Copernicus mit 2 Metern eingesprungen, mitten in
 * einem sonst scharfen Bild. Genau diese fleckige Unregelmäßigkeit ist mehrfach
 * gemeldet worden; ich baue sie nicht selbst wieder ein.
 *
 * Der Weg über die Elternkachel greift genau dort, wo es am meisten bringt:
 * beim Hineinzoomen. Wer von Stufe 13 auf 18 fährt, hat die Elternkacheln
 * unterwegs ohnehin geholt — jede tiefere Stufe ist danach umsonst.
 */
function schonLeerBekannt(
  schluessel: string,
  z: number,
  x: number,
  y: number,
): boolean {
  const quelle = SOURCES[schluessel];
  if (!quelle) return false;
  /**
   * HÖCHSTENS ZWEI STUFEN NACH OBEN — und diese Grenze ist teuer gelernt.
   *
   * Die Ableitung „Elternkachel leer, also Kind leer" stimmt nur, wenn „leer"
   * wirklich „keine Abdeckung" heißt. Das ist nicht immer so: Litauens Dienst
   * liefert auf Stufe 13 eine zu 99 Prozent weiße Übersichtsdarstellung, die
   * zu Recht als leer gilt — die Stufen 15 aufwärts haben aber echte Bilder.
   * Über sechs Stufen hinweg hat diese eine Fehlmeldung das ganze Land
   * gesperrt, und im Bild stand statt 20 Zentimetern wieder Copernicus mit
   * zwei Metern.
   *
   * Zwei Stufen sind der Kompromiss: Beim Hineinzoomen wird jede Stufe ohnehin
   * geholt, der Nutzen bleibt also fast vollständig erhalten. Und eine
   * einzelne seltsame Antwort kann höchstens zwei Stufen weit schaden statt
   * bis zum Anschlag.
   */
  const tiefste = Math.max(quelle.minzoom, z - 2);
  for (
    let zz = z - 1, xx = x >> 1, yy = y >> 1;
    zz >= tiefste;
    zz--, xx >>= 1, yy >>= 1
  ) {
    const eintrag = tileCache.get(`${schluessel}/${zz}/${xx}/${yy}`);
    if (eintrag?.leer) return true;
  }
  return false;
}

function hinweisSchluessel(z: number, x: number, y: number): string {
  const p = Math.max(0, z - 12);
  return `${x >> p}/${y >> p}`;
}

/** Die Mitte einer Kachel in Grad — für die Gebietsauswahl. */
function tileCenterWgs84(z: number, x: number, y: number): [number, number] {
  const n = 2 ** z;
  const lon = ((x + 0.5) / n) * 360 - 180;
  const latRad = Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 0.5)) / n)));
  return [(latRad * 180) / Math.PI, lon];
}

/**
 * Die Bildart aus den BYTES bestimmen, nicht aus der Kopfzeile des Anbieters.
 *
 * Zwei Gründe, beide gemessen. Erstens liefern die Hybrid-Dienste je nach
 * Inhalt JPEG ODER PNG — wer die Art beim Ablegen vergisst und später pauschal
 * „JPEG" behauptet, verteilt Randkacheln als kaputtes Bild. Zweitens lügt
 * mindestens ein Dienst: Sachsen antwortet auf das Hybridformat mit dem Kopf
 * `image/jpeg`, schickt aber PNG-Bytes.
 *
 * Die ersten Bytes sind eindeutig und kosten nichts.
 */
function sniffType(buf: Buffer): string {
  if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50) return "image/png";
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8) return "image/jpeg";
  return "application/octet-stream";
}

/**
 * Ab welchem Wert ein Bildpunkt als REINWEISS gilt.
 *
 * Nicht 255: JPEG rundet. Eine Fläche, die als reines Weiß kodiert wurde, kommt
 * mit 250 bis 255 wieder heraus.
 */
const WEISS_SCHWELLE = 250;

/**
 * Ab welchem Weißanteil eine Kachel gar nichts mehr zeigt.
 *
 * Darüber wird sie wie eine leere behandelt: übersprungen, damit die nächste
 * Quelle drankommt.
 */
const WEISS_LEER = 0.99;

/**
 * Ab welchem Weißanteil die weißen Stellen DURCHSICHTIG gemacht werden.
 *
 * DAS IST DIE STELLE, AN DER DER WEISSE KEIL ENTSTAND. Die Dienste, die nur
 * JPEG können — Frankreich, die Niederlande, Österreich, die Schweiz, Spanien,
 * Polen, Luxemburg — haben keinen Alphakanal. Wo ihre Abdeckung endet, füllen
 * sie mit Weiß. An einer Staatsgrenze ist eine Kachel deshalb TEILWEISE weiß,
 * und genau das rutschte durch: Die alte Prüfung fragte „ist die Kachel GANZ
 * einfarbig", und das ist sie dann nicht.
 *
 * Gemeldet wurde es als weißer Keil über Saarbrücken, und die diagonale Kante
 * war die französische Staatsgrenze. Nachgestellt an genau dieser Stelle:
 *
 *   Zoom 14   1 Kachel   13 415 B   40,0 % weiß
 *   Zoom 15   2 Kacheln   5 498 B   78,0 % weiß
 *                         5 385 B   83,1 % weiß
 *
 * Die 13 415 Byte zeigen zugleich, warum eine Größenschwelle hier nicht
 * genügte: Diese Kachel ist so schwer wie ein echtes Luftbild.
 *
 * Der Wert ist an den schwierigsten ECHTEN Bildern kalibriert, nicht geraten —
 * gesucht wurde ausdrücklich nach allem, was von Natur aus weiß ist:
 *
 *   Zugspitze im Schnee            0,8 %
 *   Jungfraujoch im Schnee         0,9 %
 *   Sylt, Strand                   0,9 %
 *   Kreidefelsen Rügen             0,0 %
 *   Gewächshäuser Almería          0,0 %
 *   Flughafen Frankfurt            0,1 %
 *
 * Acht Prozent liegen also neunmal über dem schlimmsten echten Fall und
 * fünfmal unter dem harmlosesten Grenzfall.
 *
 * ABER NUR AUF MITTLEREN STUFEN. Ab Stufe 18 liegt ein einzelnes helles Dach
 * darüber — am Bahnhof Coburg 9,3 Prozent für zwei Bahnsteigdächer. Deshalb
 * zählt nur noch Weiß, das den Kachelrand berührt (`randWeiss`), und Dienste
 * mit eigener Transparenz werden gar nicht gestanzt (`grenzeDurchsichtig`).
 */
const WEISS_LOCH = 0.08;

/**
 * Ab welcher Helligkeit ein Bildpunkt zum hellen Saum einer Füllfläche gehört.
 *
 * Deutlich unter der Stanzschwelle von 250, weil die JPEG-Kompression der
 * Gegenstelle am Rand Übergangswerte erzeugt. Diese Schwelle gilt AUSSCHLIESSLICH
 * für Punkte, die einen bereits durchsichtigen Nachbarn haben — siehe
 * `locherStanzen`.
 */
const SAUM_SCHWELLE = 220;

/**
 * Wie viele Bildpunkte weit der Saum abgetragen wird.
 *
 * Vier, gemessen an einer Randkachel vor Scheveningen: 2 Runden lassen 20
 * Saumpunkte stehen, 3 Runden noch 4, 4 Runden keinen. Der Preis ist winzig —
 * die durchsichtige Fläche wächst dabei von 65,10 auf 65,18 Prozent, also um
 * rund fünfzig Bildpunkte, alle an der Kante.
 *
 * Gegenprobe gegen die naheliegende Sorge, dass hier Sandstrände wegradiert
 * werden: Eine Kachel mitten am Strand OHNE Loch hat 0,10 Prozent Punkte über
 * dieser Schwelle — keiner davon hat einen durchsichtigen Nachbarn, sie
 * bleiben also unberührt. Die Weitung greift ausschließlich an einer
 * bestehenden Lochkante.
 */
const SAUM_RUNDEN = 4;

/**
 * Ab welchem Detailgehalt eine Kachel gut genug ist, um die Suche zu beenden.
 *
 * DAS IST DIE ANTWORT AUF EINEN GEMESSENEN FEHLER. Die Suche nahm bisher die
 * erste Kachel, die nicht leer war — und „nicht leer" ist ein sehr niedriger
 * Anspruch. Über Andorra liefert der spanische Dienst ein Bild, das technisch
 * einwandfrei ist und praktisch nichts zeigt: mittlerer Bildgradient 1,04 bei
 * Zoom 16. Copernicus hat für dieselbe Stelle 13,29 — dreizehnmal mehr
 * Struktur — wurde aber nie gefragt, weil Spanien vorher „etwas" geliefert
 * hatte. Dasselbe traf Sagres, sobald der portugiesische Dienst zu langsam war.
 *
 * Vier ist die Grenze. Echte Luftbilder liegen in den Messungen zwischen 4 und
 * 39, die fraglichen Fälle bei 0,17 bis 2,44 — Andorra ist der knappste: Dort
 * liefert Spanien 2,44 und Copernicus 19,69 für dieselbe Stelle. Was unter der
 * Grenze liegt, wird nicht verworfen, nur nicht mehr sofort genommen; die Suche
 * läuft weiter und am Ende gewinnt die Kachel mit dem meisten Inhalt. Bei einer
 * stillen Wasserfläche kommt dabei wieder eine stille Wasserfläche heraus, nur
 * eben aus der besseren Quelle.
 *
 * DIE GRENZE MUSS DIE STRECKUNG MITRECHNEN, sonst ist sie auf hohen Zoomstufen
 * unerfüllbar: Eine Kachel, die aus der Elternkachel hochgerechnet wurde, hat
 * naturgemäß weniger Sprünge je Bildpunkt — bei jeder Verdopplung etwa die
 * Hälfte. Ohne die Umrechnung wäre über Stufe 17 jede Kachel „dürftig", und
 * die Suche liefe jedes Mal bis zum letzten Kandidaten durch. `detailGrenze`
 * teilt die Grenze deshalb durch den Streckungsfaktor der jeweiligen Quelle.
 */
const DETAIL_GUT = 4.0;

/**
 * Die Grenze für DIESE Quelle auf DIESER Zoomstufe.
 *
 * Bis zur eigenen Auflösungsgrenze gilt der volle Wert; darüber halbiert er
 * sich mit jeder Stufe, genau wie der Detailgehalt selbst.
 */
function detailGrenze(quelle: AerialSource, z: number): number {
  return DETAIL_GUT / 2 ** Math.max(0, z - quelle.maxzoom);
}

/** Was die Untersuchung einer Kachel ergeben hat. */
interface Befund {
  /** Nichts Verwertbares drin — die nächste Quelle ist dran. */
  leer: boolean;
  /** Anteil reinweißer Bildpunkte an den sichtbaren, 0 bis 1. */
  weiss: number;
  /**
   * Mittelwert des Alphakanals, 0 bis 255.
   *
   * 255 heißt vollständig deckend. Alles darunter bedeutet Löcher — und zwar
   * ECHTE, vom Dienst mitgelieferte, nicht erst von uns gestanzte. Vorher
   * wurde das gar nicht gemessen, und daraus folgte ein Fehler: Eine Kachel
   * aus einem PNG-Dienst, die zu einem Viertel durchsichtig war, galt als
   * vollwertig und beendete die Suche — während der Nachbardienst dieselbe
   * Stelle vollständig gehabt hätte.
   */
  alpha: number;
  /**
   * Wie viel Struktur im Bild steckt — der mittlere Helligkeitssprung
   * zwischen benachbarten Bildpunkten. Ein Luftbild liegt bei 3 bis 35, eine
   * strukturlose Fläche unter 1.
   */
  detail: number;
  /** Die entpackten Bilddaten, damit das Lochstanzen sie nicht erneut holen muss. */
  roh?: { data: Buffer; width: number; height: number };
}

/**
 * Eine Kachel untersuchen — EIN Entpacken für alle Fragen.
 *
 * Vorher standen hier zwei getrennte Prüfungen, eine über die Dateigröße und
 * eine über `sharp.stats()`. Beide sind ersetzt: Die Größe sagt nichts (die
 * weiße Grenzkachel oben wiegt so viel wie ein echtes Bild), und `stats()`
 * kostet gemessene 8,4 Millisekunden, während dasselbe von Hand aus den rohen
 * Bildpunkten 1,06 Millisekunden braucht — es rechnet Kennwerte aus, die hier
 * niemand braucht.
 *
 * Der schnelle Weg davor bleibt, er spart das Entpacken ganz: das winzige
 * durchsichtige PNG, mit dem die meisten Dienste ihre Gebietsgrenze markieren.
 *
 * `null` heißt: Das war gar kein Bild. Siehe unten, warum das etwas anderes
 * ist als „leer".
 */
async function pruefe(buf: Buffer): Promise<Befund | null> {
  if (sniffType(buf) === "image/png" && buf.length < 5000) return leerBefund();
  try {
    const { data, info } = await sharp(buf)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    return analysiere(data, info.width, info.height);
  } catch {
    /**
     * NICHT dekodierbar ist ein AUSFALL — weder „perfekt" noch „leer".
     *
     * „Perfekt" (ein Detailwert von unendlich) stand hier zuerst: Die Dienste
     * antworten bei Überlast gelegentlich mit einer Fehlermeldung in XML und
     * dem Status „200 OK", und die hätte jeden Vergleich gewonnen.
     *
     * „Leer" stand danach hier, und das war kaum besser. Leer ist endgültig:
     * Es wird eine Woche gespeichert, die Nachbarquelle springt ein, und die
     * Kachel darüber geht mit „immutable" ans Gerät — aus einem einzigen
     * Schluckauf wird eine Woche Loch. Am EuroAirport Basel-Mulhouse war das
     * zu sehen: Mitten im scharfen französischen Bild stand ein weiches
     * Schweizer Quadrat. Frankreich war für genau diese eine Kachel als leer
     * gespeichert, obwohl das IGN dort ein ganz normales Bild von 8 KB hat —
     * die 49 Nachbarkacheln stimmten alle.
     *
     * Ein Ausfall wird nicht gespeichert, die Kachel darüber bekommt nur fünf
     * Minuten Haltbarkeit, und beim nächsten Mal wird neu gefragt.
     */
    return null;
  }
}

function leerBefund(): Befund {
  return { leer: true, weiss: 0, alpha: 0, detail: 0 };
}

/**
 * Die eigentliche Auswertung — auf rohen RGBA-Daten.
 *
 * Getrennt von `pruefe`, weil die gestreckten Kacheln aus `ausEltern` ihre
 * Daten schon roh vorliegen haben. Sie erst zu kodieren, nur damit `pruefe`
 * sie wieder entpacken kann, wäre zweimal umsonst.
 */
function analysiere(data: Buffer, width: number, height: number): Befund {
  let weiss = 0;
  let sichtbar = 0;
  let alphaSumme = 0;
  const min = [255, 255, 255];
  const max = [0, 0, 0];
  const gesamt = width * height;
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3]!;
    alphaSumme += a;
    // Was schon durchsichtig ist, zählt beim Weißanteil nicht mit — sonst
    // verfälschte eine halb abgedeckte Kachel aus einem PNG-Dienst den Anteil.
    if (a < 8) continue;
    sichtbar += 1;
    const r = data[i]!;
    const g = data[i + 1]!;
    const b = data[i + 2]!;
    if (r >= WEISS_SCHWELLE && g >= WEISS_SCHWELLE && b >= WEISS_SCHWELLE)
      weiss += 1;
    if (r < min[0]!) min[0] = r;
    if (r > max[0]!) max[0] = r;
    if (g < min[1]!) min[1] = g;
    if (g > max[1]!) max[1] = g;
    if (b < min[2]!) min[2] = b;
    if (b > max[2]!) max[2] = b;
  }
  const alpha = gesamt > 0 ? alphaSumme / gesamt : 0;
  if (sichtbar === 0) return { leer: true, weiss: 0, alpha: 0, detail: 0 };
  const anteil = weiss / sichtbar;
  /**
   * Der Detailgehalt — im selben Durchgang, es ist nur eine Subtraktion je
   * Bildpunkt. Der Grünkanal steht stellvertretend für die Helligkeit; er
   * trägt bei Luftbildern den größten Teil davon und spart die Umrechnung.
   */
  let sprung = 0;
  let paare = 0;
  for (let y = 0; y < height; y++) {
    const zeile = y * width * 4;
    for (let x = 0; x < width - 1; x++) {
      const i = zeile + x * 4;
      sprung += Math.abs(data[i + 5]! - data[i + 1]!);
      paare += 1;
    }
  }
  const detail = paare > 0 ? sprung / paare : 0;
  /**
   * Völlig einfarbig — in JEDER Farbe, nicht nur Weiß. Schleswig-Holstein
   * füllt außerhalb seines Gebiets schwarz, Spanien über See blaugrau. Die
   * Spanne von zwei Stufen ist der Spielraum für JPEG-Rundung; eine echte
   * Wasserfläche liegt weit darüber.
   */
  if (max.every((m, i) => m - min[i]! < 2))
    return { leer: true, weiss: anteil, alpha, detail };
  if (anteil >= WEISS_LEER) return { leer: true, weiss: anteil, alpha, detail };
  return {
    leer: false,
    weiss: anteil,
    alpha,
    detail,
    roh: { data, width, height },
  };
}

/**
 * Welche weißen Bildpunkte mit dem KACHELRAND verbunden sind — nur die können
 * Füllweiß sein.
 *
 * Füllweiß ist das Gebiet AUSSERHALB der Abdeckung, und das reicht immer über
 * die Kachel hinaus, berührt also ihren Rand. Ein helles Dach mitten in der
 * Kachel kann keine Füllfläche sein. Vorher wurde jeder helle Bildpunkt
 * gestanzt, und über den 8 Prozent (`WEISS_LOCH`) lag ab Stufe 18 schon ein
 * einzelnes großes helles Dach.
 *
 * Gilt nur noch für Dienste ohne eigene Transparenz (`grenzeDurchsichtig`).
 * Dort bleibt eine Lücke: Ein helles Dach, das über den Kachelrand reicht,
 * zählt weiterhin als Füllweiß.
 *
 * `anteil` misst wie `analysiere` an den sichtbaren Bildpunkten.
 */
function randWeiss(roh: { data: Buffer; width: number; height: number }): {
  maske: Uint8Array;
  anteil: number;
} {
  const { data, width: w, height: h } = roh;
  const maske = new Uint8Array(w * h);
  const weiss = (p: number) => {
    const i = p * 4;
    return (
      data[i + 3]! >= 8 &&
      data[i]! >= WEISS_SCHWELLE &&
      data[i + 1]! >= WEISS_SCHWELLE &&
      data[i + 2]! >= WEISS_SCHWELLE
    );
  };
  const stapel = new Int32Array(w * h);
  let oben = 0;
  const saeen = (p: number) => {
    if (!maske[p] && weiss(p)) {
      maske[p] = 1;
      stapel[oben++] = p;
    }
  };
  for (let x = 0; x < w; x++) {
    saeen(x);
    saeen((h - 1) * w + x);
  }
  for (let y = 0; y < h; y++) {
    saeen(y * w);
    saeen(y * w + w - 1);
  }
  let rand = 0;
  while (oben > 0) {
    const p = stapel[--oben]!;
    rand += 1;
    const x = p % w;
    if (x > 0) saeen(p - 1);
    if (x < w - 1) saeen(p + 1);
    if (p >= w) saeen(p - w);
    if (p < (h - 1) * w) saeen(p + w);
  }
  let sichtbar = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i]! >= 8) sichtbar += 1;
  return { maske, anteil: sichtbar > 0 ? rand / sichtbar : 0 };
}

/**
 * Die weißen Stellen DURCHSTOSSEN, statt die Kachel wegzuwerfen.
 *
 * An einer Staatsgrenze ist eine Kachel zum Teil echtes Luftbild und zum Teil
 * Füllweiß. Beides ist wertvoll: Das Bild soll bleiben, das Weiß soll weg,
 * damit die darunterliegende Ebene durchscheint. Ausgeliefert wird deshalb ein
 * PNG mit Alphakanal — dieselbe Lösung, die die deutschen Dienste von sich aus
 * liefern, nur hier nachträglich hergestellt.
 *
 * `null` heißt: nichts zu stanzen (kein Füllweiß am Rand, siehe `randWeiss`)
 * oder das Kodieren schlug fehl. Beide Male geht die Kachel als vollständiges
 * Bild weiter.
 */
async function locherStanzen(befund: Befund): Promise<Buffer | null> {
  const roh = befund.roh;
  if (!roh) return null;
  const { maske, anteil } = randWeiss(roh);
  if (anteil < WEISS_LOCH) return null;
  try {
    /**
     * AUF EINER KOPIE arbeiten, nicht auf `befund.roh.data`.
     *
     * Vorher wurden die Alphawerte an Ort und Stelle genullt. Ging danach das
     * Kodieren schief, fiel der Ablauf auf `pngZuJpeg(kachelRoh, befund)`
     * zurück — mit bereits durchlöcherten Daten, aber einem `befund.alpha`,
     * das noch von VOR dem Stanzen stammte. War der über der Deckungsgrenze,
     * machte `flatten()` aus den frischen Löchern wieder Schwarz. Ein enger
     * Pfad, aber genau die Fehlerklasse, die an allen Küsten Europas schon
     * einmal schwarze Bänder erzeugt hat.
     */
    const d = Buffer.from(roh.data);
    for (let p = 0; p < maske.length; p++) {
      if (maske[p]) d[p * 4 + 3] = 0;
    }
    /**
     * DEN HELLEN SAUM MITNEHMEN — sonst bleibt eine weiße Linie stehen.
     *
     * Gemeldet wurde es als „die Ränder sind so komisch weiß" an der
     * niederländischen Küste. Die Ursache ist die JPEG-Kompression der
     * Gegenstelle: Wo die Füllfläche ans Bild stößt, entstehen Übergangswerte.
     * Der Kern der Fläche liegt bei 255 und wird gestanzt, die Werte
     * unmittelbar daneben bei 230 bis 249 — und die bleiben stehen. Auf dem
     * Bildschirm ergibt das eine dünne weiße Kontur entlang der ganzen
     * Abdeckungsgrenze. Nachgemessen an der Küste zwischen Scheveningen und
     * Texel: 0,1 bis 1,6 Prozent der Bildpunkte je Randkachel liegen in diesem
     * Bereich.
     *
     * Zwei Durchgänge weiten die Löcher um je einen Bildpunkt — aber nur dort,
     * wo der Nachbar schon durchsichtig IST und der Punkt selbst hell.
     * Vereinzelte helle Stellen mitten im Bild (Dächer, Sandbänke, Firn) haben
     * keinen durchsichtigen Nachbarn und bleiben unberührt. Genau deshalb ist
     * es eine Weitung und keine niedrigere Schwelle: Eine Schwelle von 230
     * würde landesweit Dächer wegfressen.
     */
    const w = roh.width;
    for (let runde = 0; runde < SAUM_RUNDEN; runde++) {
      const vorher = Buffer.from(d);
      for (let y = 0; y < roh.height; y++) {
        for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4;
          if (vorher[i + 3]! === 0) continue;
          if (
            vorher[i]! < SAUM_SCHWELLE ||
            vorher[i + 1]! < SAUM_SCHWELLE ||
            vorher[i + 2]! < SAUM_SCHWELLE
          )
            continue;
          const offen =
            (x > 0 && vorher[i - 4 + 3]! === 0) ||
            (x < w - 1 && vorher[i + 4 + 3]! === 0) ||
            (y > 0 && vorher[i - w * 4 + 3]! === 0) ||
            (y < roh.height - 1 && vorher[i + w * 4 + 3]! === 0);
          if (offen) d[i + 3] = 0;
        }
      }
    }
    return await sharp(d, {
      raw: { width: roh.width, height: roh.height, channels: 4 },
    })
      .png(PNG_MIT_LOECHERN)
      .toBuffer();
  } catch {
    return null;
  }
}

/**
 * Ein deckendes PNG in ein JPEG umwandeln — sonst unverändert lassen.
 *
 * WOZU: Acht der Landesdienste können kein Hybridformat und liefern alles als
 * PNG. Für ein Luftbild ist das die falsche Verpackung: Gemessen wiegt
 * dieselbe Kachel als PNG 121 bis 167 KB, als JPEG 13 bis 22. Ein Bildschirm
 * wären acht Megabyte statt einem — auf Mobilfunk untragbar. PNG anzufragen ist
 * trotzdem nötig, weil nur es einen Alphakanal hat und damit die Kachel
 * außerhalb des Landesgebiets durchsichtig statt weiß macht.
 *
 * Also beides: PNG anfragen, und dort, wo gar keine Transparenz drinsteckt,
 * hinterher in ein JPEG umpacken. Nur die Randkacheln bleiben PNG — und die
 * sind ohnehin winzig, weil sie fast nichts enthalten.
 *
 * `sharp` und nicht eine Umwandlung in reinem JavaScript: Letztere brauchte
 * gemessene 25 Millisekunden je Kachel, und die laufen auf DEMSELBEN Strang
 * wie alles andere — bei einem Bildschirm voll wäre der Server anderthalb
 * Sekunden für niemanden erreichbar gewesen. `sharp` rechnet nativ und
 * nebenläufig, der Strang bleibt frei.
 *
 * Schlägt irgendetwas fehl, geht das Original hinaus. Eine große Kachel ist
 * immer noch besser als keine.
 */
/**
 * Ab wann eine Kachel als „praktisch deckend" gilt.
 *
 * WARUM NICHT EINFACH `isOpaque`: Weil das ein Alles-oder-Nichts-Urteil ist und
 * daran ein einzelner Bildpunkt genügt. Gemessen an einer Kachel aus Berlin
 * Mitte — mitten in der Stadt, weit von jeder Landesgrenze: 1 von 65 536
 * Bildpunkten war durchsichtig. `isOpaque` sagte deshalb nein, die Kachel blieb
 * PNG und wog 168 162 statt 20 648 Byte. Das Achtfache, für einen Bildpunkt,
 * den niemand sehen kann. Ein Bildschirm voll wären elf Megabyte gewesen.
 *
 * Der Mittelwert des Alphakanals urteilt abgestuft statt binär. 254,9 entspricht
 * höchstens 0,04 Prozent durchsichtiger Fläche, also 26 Bildpunkten — unsichtbar.
 * Eine ECHTE Randkachel liegt weit darunter: Dort ist typischerweise ein
 * Zehntel bis neun Zehntel der Fläche offen, und die muss offen bleiben, sonst
 * ist der weiße Rand wieder da.
 */
const DECKEND_AB_ALPHA = 254.9;

/**
 * Wie eine Kachel MIT Löchern verpackt wird.
 *
 * Ein Paletten-PNG statt Vollfarbe, und ausdrücklich mit geringem Aufwand.
 * Gemessen an zwei echten Grenzkacheln aus Nordrhein-Westfalen:
 *
 *   Vollfarbe, Stufe 6     3,6 ms   137 470 B
 *   Palette, Stufe 9       91,6 ms    45 724 B
 *   Palette, Stufe 6, Aufwand 1   11,0 ms    43 225 B   ← genommen
 *
 * Die hohe Aufwandstufe kostet das Achtfache an Rechenzeit und bringt nichts.
 * Ein kalter Bildschirm entlang einer Landesgrenze zahlt diese Zeit gebündelt,
 * deshalb ist sie hier nicht egal.
 *
 * WebP wäre noch einmal viermal kleiner (12 530 B) und ähnlich schnell. Es ist
 * bewusst NICHT genommen: Ob die Karte auf beiden Plattformen WebP entpackt,
 * ließe sich nur auf dem Gerät prüfen, und schlägt es fehl, verschwinden
 * Randkacheln ohne jede Meldung. Genau diese stille Fehlerklasse hat diesem
 * Projekt schon zweimal das Bild genommen. Wer es einbauen will, prüft es
 * vorher am Gerät.
 */
const PNG_MIT_LOECHERN = {
  palette: true,
  quality: 80,
  compressionLevel: 6,
  effort: 1,
} as const;

/**
 * Ab welcher Größe eine deckende Kachel neu verpackt wird.
 *
 * Die Dienste kodieren sehr unterschiedlich. Der übliche Bereich liegt bei 15
 * bis 35 Kilobyte je Kachel — Zypern schickt 159 289. Das ist keine höhere
 * Auflösung, nur eine sehr feine JPEG-Stufe: Neu kodiert mit Stufe 80 sind es
 * 26 481 Byte (17 Prozent), und der gemessene Bildgradient STEIGT dabei
 * leicht, von 21,84 auf 22,80. Es geht also nichts verloren.
 *
 * Ein Bildschirm wog in Nikosia 6,68 Megabyte. Auf Mobilfunk ist das nicht
 * vertretbar, und es trifft ausgerechnet ein Reiseziel.
 *
 * Sechzig Kilobyte ist mit Abstand über allem, was die anderen 37 Quellen
 * liefern — normale Kacheln werden also nie angefasst.
 */
const KACHEL_MAX_BYTES = 60_000;

/**
 * Eine unnötig schwere, deckende Kachel abspecken.
 *
 * Nur bei JPEG und nur oberhalb der Grenze; das Ergebnis wird übernommen, wenn
 * es wirklich kleiner ist.
 */
async function abspecken(buf: Buffer): Promise<Buffer> {
  if (buf.length <= KACHEL_MAX_BYTES) return buf;
  if (sniffType(buf) !== "image/jpeg") return buf;
  try {
    const klein = await sharp(buf).jpeg({ quality: 80 }).toBuffer();
    return klein.length < buf.length ? klein : buf;
  } catch {
    return buf;
  }
}

async function pngZuJpeg(buf: Buffer, befund: Befund): Promise<Buffer> {
  try {
    // Der Alphakanal ist in `analysiere` bereits gemittelt worden — ein
    // zweites `metadata()` plus `stats()` kostete gemessene 8,8 Millisekunden
    // je Kachel und beantwortete dieselbe Frage.
    const roh = befund.roh;
    /**
     * MIT Löchern: nicht einfach durchreichen, sondern neu verpacken.
     *
     * Hier stand `return buf` — der Originalpuffer der Gegenstelle. Die
     * Landesdienste liefern ihre Randkacheln aber als Vollfarb-PNG, und das
     * wiegt gemessen 83 075 bis 136 050 Byte für dieselben Bildpunkte, die als
     * Paletten-PNG 43 000 wiegen. Es waren genau die Kacheln, um die es ging.
     */
    if (befund.alpha < DECKEND_AB_ALPHA) {
      if (!roh) return buf;
      const klein = await sharp(roh.data, {
        raw: { width: roh.width, height: roh.height, channels: 4 },
      })
        .png(PNG_MIT_LOECHERN)
        .toBuffer();
      return klein.length < buf.length ? klein : buf;
    }
    if (roh) {
      // Aus den schon entpackten Daten kodieren statt sie erneut zu entpacken.
      return await sharp(roh.data, {
        raw: { width: roh.width, height: roh.height, channels: 4 },
      })
        .flatten()
        .jpeg({ quality: 80 })
        .toBuffer();
    }
    return await sharp(buf).flatten().jpeg({ quality: 80 }).toBuffer();
  } catch {
    return buf;
  }
}

/**
 * Wie viele Kacheln gleichzeitig JE DIENST.
 *
 * Die Dienste sind unterschiedlich flink, und zwar erheblich: gemessener
 * Median je Kachel — Nordrhein-Westfalen 111 ms, Bayern 195 ms, Hessen 479 ms,
 * Niedersachsen 1294 ms. Bei einem Bildschirm von 56 Kacheln entscheidet die
 * Spurzahl deshalb darüber, ob eine Gegend in einer Sekunde dasteht oder in
 * neun.
 *
 * Die Zahl ist an der langsamsten Gegenstelle ausgemessen worden, nicht
 * geschätzt. Niedersachsen, zwölf bis sechsundfünfzig Kacheln gleichzeitig:
 *
 *   12 gleichzeitig → 1,4 s   ( 8,9 Kacheln/s)
 *   24 gleichzeitig → 1,4 s   (17,0 Kacheln/s)
 *   36 gleichzeitig → 1,5 s   (23,3 Kacheln/s)
 *   56 gleichzeitig → 1,9 s   (29,5 Kacheln/s)
 *
 * Der Dienst skaliert also fast linear — das Nadelöhr war ausschließlich diese
 * Zahl. Mit acht brauchte ein Bildschirm in Osnabrück neun Sekunden, und genau
 * das war die Beschwerde „beim Sprung in eine andere Stadt dauert es ewig".
 *
 * Vierundzwanzig ist die Abwägung: Es halbiert die Wartezeit gegenüber zwölf
 * und bleibt weit unter dem, was die Gegenstelle verkraftet. Höher zu gehen
 * brächte real wenig — ab da liegt die Zeit in der Fahrt, nicht in der
 * Warteschlange — und würde bei einem kostenlosen Behördendienst zunehmend
 * unhöflich. Jede Kachel wird ohnehin nur EINMAL geholt und danach eine Woche
 * lang aus dem Speicher bedient.
 */
const MAX_PARALLEL_UPSTREAM = 24;

/**
 * Die Bremse zählt JE DIENST, nicht über alle zusammen.
 *
 * Erst war es eine einzige globale Schlange, und das war zu grob: Ein
 * Fehlversuch bei Niedersachsen belegte dann eine Spur, die dem Dienst fehlte,
 * der das Bild wirklich hat. Bei drei beteiligten Ländern standen zwei Drittel
 * der Spuren für Auskünfte offen, die niemand braucht.
 *
 * Höflich ist die Zahl trotzdem: Sie gilt je Gegenstelle, und ein Dienst sieht
 * davon nichts, was nach Ansturm aussieht — er sieht nur nicht mehr die
 * Wartezeit eines anderen.
 */
const spuren = new Map<
  string,
  { laufend: number; warteschlange: (() => void)[] }
>();

/** So viele Kachel-Anfragen dürfen je Dienst höchstens warten (siehe `mitBremse`). */
const MAX_WARTESCHLANGE = 64;

class UeberlastetError extends Error {
  constructor(dienst: string) {
    super(`Luftbild-Dienst ${dienst} überlastet`);
  }
}

/** Die Karte hat die Kachel aufgegeben, bevor sie dran war (siehe `mitBremse`). */
class AbgebrochenError extends Error {
  constructor() {
    super("Kachel-Anfrage abgebrochen");
  }
}

/**
 * Hinten anstellen — und wieder austreten, sobald niemand mehr wartet.
 *
 * WARUM: Beim Hineinzoomen bricht die Karte die Kacheln der Zwischenstufen ab
 * und schickt neue (höchstens 20 gleichzeitig je Server, `HttpRequestImpl` in
 * MapLibre). Hier liefen die abgebrochenen weiter und hielten ihre Plätze.
 * Ein Zoom über mehrere Stufen sind mehrere Bildschirme à rund 55 Kacheln;
 * bei einem langsamen Dienst kann die Schlange so volllaufen, und die
 * Absage (503) trifft dann ausgerechnet die zuletzt angeforderten Kacheln,
 * die man tatsächlich ansieht. Bis die Karte sie neu anfragt (1 s, dann
 * wachsender Abstand), steht dort die gröbere Elternkachel.
 *
 * Wer schon läuft, läuft zu Ende — die Kachel landet im Speicher.
 */
function anstellen(
  spur: { warteschlange: (() => void)[] },
  signal?: AbortSignal,
): Promise<void> {
  return new Promise<void>((frei, weg) => {
    if (signal?.aborted) return weg(new AbgebrochenError());
    const aufgeben = () => {
      const i = spur.warteschlange.indexOf(wecken);
      if (i >= 0) spur.warteschlange.splice(i, 1);
      weg(new AbgebrochenError());
    };
    const wecken = () => {
      signal?.removeEventListener("abort", aufgeben);
      frei();
    };
    spur.warteschlange.push(wecken);
    signal?.addEventListener("abort", aufgeben, { once: true });
  });
}

async function mitBremse<T>(
  dienst: string,
  grenze: number,
  fn: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  let spur = spuren.get(dienst);
  if (!spur) {
    spur = { laufend: 0, warteschlange: [] };
    spuren.set(dienst, spur);
  }
  while (spur.laufend >= grenze) {
    // Nicht endlos anstellen: Ein Wisch über die Karte fordert Dutzende
    // Kacheln an, ein Angreifer beliebig viele. Ist die Schlange voll, gibt es
    // sofort eine Absage (503) — die Karte fragt die Kachel später erneut.
    if (spur.warteschlange.length >= MAX_WARTESCHLANGE) throw new UeberlastetError(dienst);
    await anstellen(spur, signal);
  }
  if (signal?.aborted) {
    // Geweckt, aber die Kachel will niemand mehr: Den Weckruf weitergeben,
    // sonst bliebe die Spur frei und die Schlange dahinter stünde still.
    spur.warteschlange.shift()?.();
    throw new AbgebrochenError();
  }
  spur.laufend += 1;
  try {
    return await fn();
  } finally {
    spur.laufend -= 1;
    spur.warteschlange.shift()?.();
  }
}

/**
 * Das Ergebnis einer Quelle für eine Kachel.
 *
 * `leer` wird MITGESPEICHERT und nicht jedes Mal neu ermittelt. Das ist der
 * eigentliche Gewinn des Zwischenspeichers in Grenznähe: Dass der
 * niederländische Dienst über Köln nichts hat, muss genau einmal je Kachel
 * festgestellt werden — danach wird er dort übersprungen, ohne dass eine
 * einzige Verbindung aufgemacht wird.
 */
interface Kachel {
  buf: Buffer;
  type: string;
  leer: boolean;
  /** Detailgehalt, siehe `DETAIL_GUT`. */
  detail: number;
  /**
   * Die Kachel trägt LÖCHER — sie war teilweise mit Füllweiß bedeckt, das
   * durchsichtig gemacht wurde. Sie ist brauchbar, aber eine vollständige
   * Kachel einer anderen Quelle ist besser; siehe die Schleife in der Route.
   */
  luecken: boolean;
}

/**
 * Der Zwischenspeicher — nach QUELLE geschlüsselt, nicht nach Gebiet.
 *
 * Das ist nötig, seit es nur noch ein Gebiet gibt: Zwei benachbarte Kacheln
 * können aus verschiedenen Quellen stammen, und das Strecken aus der
 * Elternkachel (siehe `ausEltern`) muss genau die Elternkachel DERSELBEN Quelle
 * finden.
 *
 * Eine Kachel wiegt 15 bis 35 KB; 2500 Stück sind also rund 60 MB.
 *
 * Die Zahl stand auf 900 und war zu knapp geworden: Eine Zoomfahrt von Stufe
 * 13 bis 20 sind acht Bildschirme à 55 Kacheln, also 440 — zwei Gegenden
 * hintereinander verdrängten sich damit gegenseitig, und jede Rückkehr kostete
 * die Landesdienste erneut. 2500 decken rund fünfundvierzig Bildschirme ab. Das deckt
 * mehrere Bildschirme in mehreren Zoomstufen ab, und mehr braucht es nicht:
 * Das Gerät hält die Kacheln über die Kopfzeile unten ohnehin selbst vor. Der
 * Speicher hier ist für den zweiten Nutzer derselben Gegend da — und dafür,
 * den kostenlosen Landesdienst nicht unnötig zu belasten.
 */
const tileCache = new BoundedTtlCache<Kachel>(2500, WEEK);

/**
 * „Leer", obwohl die ELTERNKACHEL derselben Quelle voll bedeckt war — das ist
 * ein Widerspruch, und Widersprüche werden nicht eine Woche geglaubt.
 *
 * Ein „hier habe ich nichts" (404, Weißbild) wird sonst eine Woche gespeichert,
 * und die Kachel darüber geht mit „immutable" ans Gerät. Das ist richtig, wenn
 * die Stelle wirklich außerhalb liegt — und ein Schaden, wenn der Dienst sich
 * nur einmal verschluckt hat. Genau das ist am EuroAirport Basel-Mulhouse
 * passiert, und zwar mehrmals: Das IGN hatte auf den Stufen 16, 17 und 19 für
 * einzelne Kacheln „nichts", obwohl es dieselben Kacheln direkt danach und bei
 * jedem späteren Versuch einwandfrei lieferte, ebenso ihre Elternkacheln. Ein
 * Lasttest mit 96 Abrufen zu je 24 gleichzeitig brachte es nicht wieder
 * hervor; flüchtig also, aber mit einer Woche Folgen: Die Schweiz sprang ein,
 * und im scharfen französischen Bild standen weiche Schweizer Quadrate.
 *
 * Ob ein „leer" glaubwürdig ist, weiß man aus dem Vorfahren: War die
 * Elternkachel derselben Quelle vollständig (kein Loch, kein Füllweiß), dann
 * deckt die Quelle die Stelle ab. Ein „leer" darunter wird dann nur kurz
 * gemerkt und zählt als AUSFALL — die Kachel darüber bekommt fünf Minuten
 * Haltbarkeit statt einer Woche, und später wird neu gefragt. Ist das „leer"
 * echt (manche Dienste zeigen auf groben Stufen mehr Fläche als auf feinen),
 * kostet das eine Anfrage je Kachel alle zehn Minuten, solange jemand
 * hinschaut. Das ist der ganze Preis.
 */
const VERDACHT_MS = 10 * 60_000;
const verdaechtigLeer = new BoundedTtlCache<true>(2000, VERDACHT_MS);

function elternVollstaendig(
  schluessel: string,
  z: number,
  x: number,
  y: number,
): boolean {
  const quelle = SOURCES[schluessel];
  if (!quelle || z - 1 < quelle.minzoom) return false;
  const eltern = tileCache.get(
    `${schluessel}/${z - 1}/${Math.floor(x / 2)}/${Math.floor(y / 2)}`,
  );
  return !!eltern && !eltern.leer && !eltern.luecken;
}

/**
 * Die durchsichtige Antwort, wenn niemand etwas hat.
 *
 * Sie ist der Gegenentwurf zur weißen Kachel: Wo kein Dienst ein Bild liefert,
 * soll die darunterliegende Ebene durchscheinen, nicht zugedeckt werden. Einmal
 * gebaut und dann wiederverwendet — es ist immer dasselbe Bild.
 */
let durchsichtig: Buffer | null = null;
async function leereKachel(): Promise<Buffer> {
  if (!durchsichtig) {
    durchsichtig = await sharp({
      create: {
        width: 256,
        height: 256,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      },
    })
      .png({ compressionLevel: 9 })
      .toBuffer();
  }
  return durchsichtig;
}

/**
 * Wie viele Stufen über die Auflösung einer Quelle hinaus gestreckt wird.
 *
 * Vier, weil die europaweite Schicht bei Stufe 16 endet und die Karte bis 20
 * geht. Mehr wäre sinnlos: Bei vier Stufen wird ein Ausschnitt von 16 mal 16
 * Bildpunkten auf 256 aufgeblasen, darunter ist nichts mehr zu erkennen.
 */
const MAX_STRECKUNG = 4;

/**
 * Die Antwort „hier gibt es nichts" als fertiger Eintrag.
 *
 * Wichtig ist der Unterschied zu `null`: `null` heißt in der Kandidatenschleife
 * „Gegenstelle kaputt" und führt zu einem 502, den die Karte sich merkt.
 * „Nichts da" ist dagegen ein endgültiges, gültiges Ergebnis — die nächste
 * Quelle ist dran, und wenn keine mehr kommt, geht eine durchsichtige Kachel
 * hinaus.
 */
const LEERE_KACHEL: Kachel = {
  buf: Buffer.alloc(0),
  type: "image/png",
  leer: true,
  luecken: false,
  detail: 0,
};

/**
 * Eine Kachel aus der ELTERNKACHEL gewinnen, statt sie anzufragen.
 *
 * WOZU: Die Quellen enden auf verschiedenen Stufen — die Niederlande bei 21,
 * Nordrhein-Westfalen bei 20, die meisten Bundesländer bei 19. In der App gibt
 * es aber nur noch EINE Ebene mit EINER Obergrenze. Ohne das hier müsste sie
 * auf die kleinste aller Obergrenzen gesetzt werden, und damit verlören
 * ausgerechnet die schärfsten Quellen ihre beste Stufe.
 *
 * Also wird oberhalb der jeweiligen Auflösung derselbe Ausschnitt aus der
 * größten echten Kachel geschnitten und hochgerechnet — genau das, was MapLibre
 * sonst selbst täte. Der Unterschied: Die Elternkachel liegt fast immer schon
 * im Speicher, weil der Nutzer durch diese Stufe hindurchgezoomt ist. Vier
 * Kacheln der nächsten Stufe kosten dann NULL Anfragen beim Anbieter statt vier.
 */
async function ausEltern(
  schluessel: string,
  z: number,
  x: number,
  y: number,
  signal?: AbortSignal,
): Promise<Kachel | null> {
  const quelle = SOURCES[schluessel]!;
  const stufen = z - quelle.maxzoom;
  if (stufen > MAX_STRECKUNG) return LEERE_KACHEL;

  const eltern = await kachelVonQuelle(
    schluessel,
    quelle.maxzoom,
    x >> stufen,
    y >> stufen,
    false,
    signal,
  );
  if (!eltern || eltern.leer) return eltern;

  try {
    const n = 2 ** stufen;
    const kante = 256 / n;
    const gx = x - (x >> stufen) * n;
    const gy = y - (y >> stufen) * n;
    /**
     * `ensureAlpha` UND roh herausrechnen — beides war der Fehler.
     *
     * Hier stand `.jpeg()` unmittelbar hinter dem Strecken. JPEG kennt keinen
     * Alphakanal, also füllte `sharp` jedes Loch mit SCHWARZ. Elternkacheln
     * mit Löchern sind aber der Normalfall: Überall dort, wo das
     * Copernicus-Mosaik ans Meer stößt, ist die 16er-Kachel teilweise
     * durchsichtig. Nachgestellt an der Adriaküste bei Split — die
     * Elternkachel ist zu 80,2 Prozent durchsichtig, und zwei ihrer vier
     * Kinder kamen als 650 Byte reines Schwarz heraus, mit sieben Tagen
     * Haltbarkeit. Ein schwarzes Band von rund 600 Metern Breite entlang JEDER
     * Küste Europas, ab Zoom 17.
     *
     * Jetzt bleibt der Alphakanal erhalten, der Ausschnitt wird untersucht wie
     * jede andere Kachel, und erst danach entschieden, wie er verpackt wird.
     */
    const { data, info } = await sharp(eltern.buf)
      .ensureAlpha()
      .extract({
        left: gx * kante,
        top: gy * kante,
        width: kante,
        height: kante,
      })
      .resize(256, 256, { kernel: "cubic" })
      .raw()
      .toBuffer({ resolveWithObject: true });

    const befund = analysiere(data, info.width, info.height);
    if (befund.leer) return LEERE_KACHEL;

    const deckend = befund.alpha >= DECKEND_AB_ALPHA;
    const buf = deckend
      ? await sharp(data, {
          raw: { width: info.width, height: info.height, channels: 4 },
        })
          .flatten()
          // Je stärker gestreckt, desto weniger ist zu erhalten — und desto
          // mehr Daten spart eine dünnere Kodierung.
          .jpeg({ quality: stufen >= 2 ? 72 : 82 })
          .toBuffer()
      : await sharp(data, {
          raw: { width: info.width, height: info.height, channels: 4 },
        })
          .png(PNG_MIT_LOECHERN)
          .toBuffer();

    return {
      buf,
      type: deckend ? "image/jpeg" : "image/png",
      leer: false,
      luecken: !deckend,
      /**
       * Der Detailwert wird GEMESSEN, nicht geerbt. Geerbt war er zu hoch:
       * Eine gestreckte Kachel hat je Verdopplung etwa die Hälfte der Sprünge
       * ihrer Elternkachel. Nachgemessen in Düsseldorf — Eltern 6,35, Kind
       * 3,30, Enkel 1,53, gemeldet wurde dreimal 6,35. Damit brach die Suche
       * auf einer Kachel ab, die keine war.
       */
      detail: befund.detail,
    };
  } catch {
    return null;
  }
}

/**
 * Eine Kachel von EINER Quelle holen — mit Speicher, Bremse und Streckung.
 *
 * Gibt `null` zurück, wenn die Gegenstelle nicht erreichbar war oder einen
 * Fehler lieferte. Das ist ausdrücklich etwas anderes als „leer": Ein Ausfall
 * darf sich nicht für eine Woche festsetzen, eine Gebietsgrenze schon.
 */
/** Ein einzelner Abruf — `null` heißt Ausfall, „leer" heißt: hier gibt es nichts. */
async function einAbruf(
  url: string,
  signal: AbortSignal,
  extra?: Record<string, string>,
): Promise<Buffer | "leer" | null> {
  try {
    const r = await fetch(url, {
      headers: { Accept: "image/jpeg,image/png;q=0.9,*/*;q=0.5", ...extra },
      signal,
    });
    /**
     * „NICHT GEFUNDEN" IST EINE ANTWORT, KEIN AUSFALL.
     *
     * Und der Unterschied war in Brüssel zu sehen: Dort gibt es kein
     * Bild — Belgien fehlt in dieser Liste. Gefragt wird trotzdem
     * Frankreich, weil Brüssel im französischen Rechteck liegt, und das IGN
     * antwortet für Kacheln außerhalb Frankreichs mit 404. Das wurde hier
     * als kaputte Gegenstelle gewertet, die ganze Kachel mit 502 abgewiesen
     * — und ausgeliefert wurde dann unser Fehlertext von zwanzig Byte statt
     * einer durchsichtigen Kachel. Die Karte blieb dort schwarz, obwohl die
     * europaweite Ebene darunter ein Bild gehabt hätte.
     *
     * Ein Kacheldienst sagt mit 404 dasselbe wie ein Kartendienst mit einer
     * durchsichtigen Kachel: hier habe ich nichts. Das ist endgültig und
     * darf gespeichert werden. Alles andere (Zeitüberschreitung, 500, 503)
     * bleibt ein Ausfall und wird NICHT gespeichert — das Bild gibt es ja,
     * es war nur gerade nicht zu bekommen.
     */
    if (r.status === 404 || r.status === 204) return "leer";
    if (!r.ok) return null;
    return Buffer.from(await r.arrayBuffer());
  } catch {
    return null;
  }
}

/** Das erste brauchbare Ergebnis — `null` nur, wenn ALLE ausgefallen sind. */
function erstesBrauchbares<T>(
  versuche: Promise<T | null>[],
): Promise<T | null> {
  return new Promise((fertig) => {
    let offen = versuche.length;
    for (const v of versuche) {
      void v.then((wert) => {
        if (wert !== null) fertig(wert);
        else if (--offen === 0) fertig(null);
      });
    }
  });
}

/**
 * Eine Kachel beim Dienst holen — mit einem NACHZÜGLER gegen Hänger.
 *
 * Gemessen am IGN mit 160 Abrufen zu je 24 gleichzeitig: Median 0,4 Sekunden,
 * 95 Prozent unter 1,6, 99 Prozent unter 3,5. Und ganz selten hängt eine
 * einzelne Kachel über die volle Frist von zwölf Sekunden. Genau diese Hänger
 * waren die unscharfen Quadrate: In einem Lauf über acht französische Städte
 * liefen zwei Kacheln (Paris, Lille) in die Frist, und an ihrer Stelle stand
 * das Zwei-Meter-Bild von Copernicus — zwölf Sekunden zu spät und dann fünf
 * Minuten lang.
 *
 * Deshalb: Kommt nach einem Viertel der Frist noch keine Antwort, geht
 * dieselbe Anfrage ein zweites Mal hinaus, und die schnellere gewinnt; die
 * andere wird abgebrochen. Nachgemessen über zehn französische Städte, je
 * vier Stufen, 1960 Kacheln: Der Nachzügler sprang 63-mal ein, war 42-mal
 * schneller — meist 0,1 bis 0,5 Sekunden nach seinem Start —, und es gab
 * keinen einzigen Ausfall mehr. Ein Hänger ist also fast nie der Dienst als
 * Ganzes, sondern eine einzelne Verbindung. Bezahlt wird das nur bei den
 * langsamsten rund zwei Prozent, und die Frist insgesamt bleibt dieselbe.
 *
 * Die Uhr läuft ERST, wenn wir dran sind — und sie deckt auch das Lesen.
 * Vorher startete sie vor der Warteschlange: Eine Kachel, die hinter sieben
 * anderen wartete, verbrauchte ihre zwölf Sekunden im Stehen und wurde
 * abgebrochen, obwohl die Gegenstelle kerngesund war. Und sie endete, sobald
 * die Kopfzeilen da waren — ein hängender Rumpf hatte danach überhaupt keine
 * Frist mehr und konnte ewig offen bleiben. Deshalb wird diese Funktion
 * INNERHALB der Bremse aufgerufen.
 */
async function holeRoh(
  quelle: AerialSource,
  z: number,
  x: number,
  y: number,
): Promise<Buffer | "leer" | null> {
  const url = quelle.url(z, x, y);
  const frist = quelle.zeitgrenze ?? 12_000;
  const abbruch = new AbortController();
  const uhr = setTimeout(() => abbruch.abort(), frist);
  let wecker: ReturnType<typeof setTimeout> | undefined;
  try {
    const erster = einAbruf(url, abbruch.signal, quelle.headers);
    if (quelle.nachzuegler === false) return await erster;
    const langsam = new Promise<"langsam">((weiter) => {
      wecker = setTimeout(() => weiter("langsam"), frist / 4);
    });
    const frueh = await Promise.race([erster, langsam]);
    if (frueh !== "langsam") return frueh;
    return await erstesBrauchbares([erster, einAbruf(url, abbruch.signal, quelle.headers)]);
  } finally {
    clearTimeout(uhr);
    clearTimeout(wecker);
    // Den Verlierer abbrechen — der Gewinner hat seinen Rumpf schon gelesen.
    abbruch.abort();
  }
}

/**
 * Ein „leer" im Widerspruch zur Elternkachel: EINMAL gleich nachfragen, und
 * erst wenn es dabei bleibt, für zehn Minuten sperren (`verdaechtigLeer`).
 *
 * Die Sperre allein wäre zu grob: Zehn Minuten lang stünde an der Stelle das
 * Zwei-Meter-Bild von Copernicus, obwohl die richtige Kachel womöglich schon
 * beim nächsten Versuch käme — die Fälle am EuroAirport kamen bei jeder
 * späteren Nachfrage einwandfrei. Ob der sofortige zweite Versuch sie
 * abgeräumt hätte, ist nicht gemessen; in den Messläufen danach trat der
 * Widerspruch nicht wieder auf. Er kostet aber nur in genau diesem Fall eine
 * Anfrage.
 */
async function widerspruch(
  schluessel: string,
  z: number,
  x: number,
  y: number,
  key: string,
  zweiterVersuch: boolean,
  signal?: AbortSignal,
): Promise<Kachel | null> {
  if (!zweiterVersuch) {
    await new Promise((weiter) => setTimeout(weiter, 300));
    return await kachelVonQuelle(schluessel, z, x, y, true, signal);
  }
  verdaechtigLeer.set(key, true);
  return null;
}

async function kachelVonQuelle(
  schluessel: string,
  z: number,
  x: number,
  y: number,
  zweiterVersuch = false,
  /** Die Karte hat aufgegeben — dann nicht mehr anstellen (siehe `anstellen`). */
  signal?: AbortSignal,
): Promise<Kachel | null> {
  const quelle = SOURCES[schluessel];
  if (!quelle) return null;
  /**
   * Unterhalb der Mindeststufe gibt es hier NICHTS — das ist kein Ausfall.
   *
   * `null` hieße „Gegenstelle kaputt", und die Schleife machte daraus ein 502.
   * Nachgestellt: eine Anfrage an `nw` auf Stufe 12 kam nach 1,3 Millisekunden
   * als 502 zurück, ohne dass je jemand kontaktiert wurde.
   */
  if (z < quelle.minzoom) return LEERE_KACHEL;

  const key = `${schluessel}/${z}/${x}/${y}`;
  const hit = tileCache.get(key);
  if (hit) return hit;
  // Frisch als verdächtig gemerkt — nicht gleich wieder fragen.
  if (verdaechtigLeer.get(key)) return null;

  if (z > quelle.maxzoom) {
    /**
     * GESTRECKTE KACHELN WERDEN NICHT GESPEICHERT.
     *
     * Sie standen im selben Speicher wie die echten und verdrängten dabei
     * ausgerechnet ihre eigenen Elternkacheln — und der Speicher zählt
     * Einträge, nicht Herkunft. Eine einzige europaweite 16er-Kachel bläht sich
     * über die Stufen 17 bis 20 auf 4 + 16 + 64 + 256 = 340 Ableitungen auf.
     * Nachgestellt: Nach einem Schwall solcher Ableitungen war die zugehörige
     * Elternkachel weg und musste für 233 Millisekunden neu vom Landesdienst
     * geholt werden, während die Ableitungen in 5 Millisekunden dalagen.
     *
     * Das Verhältnis entscheidet: Eine Ableitung aus vorhandener Elternkachel
     * kostet rund 5 Millisekunden Rechenzeit und NULL Anfragen nach außen. Die
     * Elternkachel nachzuholen kostet 200 bis 2500 Millisekunden UND eine
     * Anfrage an einen kostenlosen Behördendienst. Also bleibt der Platz den
     * Elternkacheln.
     */
    return await ausEltern(schluessel, z, x, y, signal);
  }

  /**
   * Die Uhr läuft ERST, wenn wir dran sind — und sie deckt auch das Lesen.
   *
   * Vorher startete sie vor der Warteschlange: Eine Kachel, die hinter sieben
   * anderen wartete, verbrauchte ihre zwölf Sekunden im Stehen und wurde
   * abgebrochen, obwohl die Gegenstelle kerngesund war. Und sie endete, sobald
   * die Kopfzeilen da waren — ein hängender Rumpf hatte danach überhaupt keine
   * Frist mehr und konnte ewig offen bleiben.
   *
   * Beides steckt jetzt INNERHALB der Bremse: Uhr an, holen, lesen, Uhr aus.
   */
  const roh = await mitBremse(
    quelle.dienst ?? schluessel,
    quelle.spurzahl ?? MAX_PARALLEL_UPSTREAM,
    () => holeRoh(quelle, z, x, y),
    signal,
  );
  if (!roh) return null;
  if (roh === "leer") {
    if (elternVollstaendig(schluessel, z, x, y))
      return await widerspruch(schluessel, z, x, y, key, zweiterVersuch, signal);
    const leer: Kachel = {
      buf: Buffer.alloc(0),
      type: "image/png",
      leer: true,
      luecken: false,
      detail: 0,
    };
    tileCache.set(key, leer, quelle.ttlMs);
    return leer;
  }

  const kachelRoh = quelle.zuschnitt
    ? await zuschneiden(roh, quelle.zuschnitt)
    : roh;
  const befund = await pruefe(kachelRoh);
  if (!befund) return null;
  if (befund.leer) {
    if (elternVollstaendig(schluessel, z, x, y))
      return await widerspruch(schluessel, z, x, y, key, zweiterVersuch, signal);
    const leer: Kachel = {
      buf: kachelRoh,
      type: sniffType(kachelRoh),
      leer: true,
      luecken: false,
      detail: befund.detail,
    };
    tileCache.set(key, leer, quelle.ttlMs);
    return leer;
  }

  /**
   * Teilweise weiß — die weißen Stellen durchstoßen und als PNG ausliefern.
   *
   * Kein `pngZuJpeg` danach: Das würde die eben gestanzten Löcher sofort
   * wieder mit Schwarz zuschütten.
   *
   * Nicht bei Diensten, die ihre Grenze selbst durchsichtig markieren — dort
   * ist Weiß echtes Bild (siehe `grenzeDurchsichtig`). `befund.weiss` ist nur
   * die schnelle Vorprüfung; ob gestanzt wird, entscheidet `randWeiss`.
   */
  if (!quelle.grenzeDurchsichtig && befund.weiss >= WEISS_LOCH) {
    const gestanzt = await locherStanzen(befund);
    if (gestanzt) {
      const k: Kachel = {
        buf: gestanzt,
        type: "image/png",
        leer: false,
        luecken: true,
        detail: befund.detail,
      };
      tileCache.set(key, k, quelle.ttlMs);
      return k;
    }
  }

  /**
   * Nur bei PNG überhaupt nachdenken — die Hybrid-Dienste liefern für echte
   * Flächen schon JPEG, da gibt es nichts zu sparen.
   */
  const fertig = await abspecken(
    sniffType(kachelRoh) === "image/png"
      ? await pngZuJpeg(kachelRoh, befund)
      : kachelRoh,
  );
  const kachel: Kachel = {
    buf: fertig,
    type: sniffType(fertig),
    leer: false,
    /**
     * LÖCHER SIND LÖCHER — egal, ob wir sie gestanzt haben oder der Dienst sie
     * mitgeliefert hat.
     *
     * Das war vorher unterschiedlich beurteilt: Bei den Diensten, die nur JPEG
     * können, erkennt `locherStanzen` das Füllweiß und markiert die Kachel; bei
     * den PNG-Diensten kommt dieselbe Lage als echter Alphakanal — und der
     * wurde gar nicht bewertet. An der niederländischen Grenze bei Vaals hieß
     * das: Nordrhein-Westfalen liefert eine zu 24 Prozent durchsichtige Kachel,
     * sie gilt als vollwertig, die Suche bricht ab, und der niederländische
     * Dienst mit 8 Zentimetern wird nie gefragt. Ein Viertel des Bildes fehlte,
     * bei 4,4-facher Datenmenge.
     */
    luecken: befund.alpha < DECKEND_AB_ALPHA,
    detail: befund.detail,
  };
  tileCache.set(key, kachel, quelle.ttlMs);
  return kachel;
}

/**
 * Die Kachelnummern müssen INS RASTER passen.
 *
 * Vorher stand dort nur „nicht negativ". Damit ließ sich der Server von außen
 * als Schleuder benutzen: `/api/tiles/aerial/nw/13/99999999/0` wurde an den
 * nordrhein-westfälischen Dienst durchgereicht, obwohl Stufe 13 nur 8192
 * Spalten hat. Wer das in Schleife schickt, belastet einen kostenlosen
 * Behördendienst und drängt nebenbei mit Unsinn die echten Kacheln aus dem
 * Zwischenspeicher.
 */
const paramsSchema = z
  .object({
    region: z.enum(["hi", ...Object.keys(SOURCES)] as [string, ...string[]]),
    z: z.coerce.number().int().min(0).max(24),
    x: z.coerce.number().int().min(0),
    y: z.coerce.number().int().min(0),
  })
  .refine((v) => v.x < 2 ** v.z && v.y < 2 ** v.z, {
    message: "Kachel liegt ausserhalb des Rasters",
  });

/**
 * Um wie viel mehr Struktur eine Kachel zeigen muss, um die zuerst gefundene
 * zu verdrängen.
 *
 * Hier stand ein schlichter Vergleich „mehr Detail gewinnt", und der hat am
 * EuroAirport Basel-Mulhouse ein Schachbrett erzeugt. Dort liefern Frankreich
 * und die Schweiz beide ein Bild — swisstopo deckt einen Streifen rund um die
 * Schweiz mit ab. Über den gleichförmigen Terminaldächern und Rollfeldern
 * erreicht keine der beiden die Grenze `DETAIL_GUT`, die Suche lief also jedes
 * Mal bis zum Ende durch, und entschieden hat der Zufall: auf der einen Kachel
 * Frankreich mit 1,8 gegen die Schweiz mit 1,7, auf der Nachbarkachel die
 * Schweiz mit 2,6 gegen Frankreich mit 1,5. Die Schweizer Kacheln sind dort
 * aber die weicheren — auf dem Bildschirm standen unscharfe Quadrate mitten im
 * scharfen Bild.
 *
 * Der Detailwert ist über Quellengrenzen hinweg kein fairer Maßstab: Ein
 * weiches Bild mit einer einzigen dunklen Kante übertrifft ein scharfes Bild
 * eines hellen Dachs. Er taugt nur, um einen GROBEN Unterschied zu erkennen —
 * und für genau den war er eingeführt worden: Über Andorra liefert Spanien
 * 1,04 bis 2,44 und Copernicus 13,29 bis 19,69, das Acht- bis Dreizehnfache;
 * über Sagres Spanien 0,17 und Portugal 26,41.
 *
 * Die Schwelle ist das ACHTFACHE, und sie ist an Fällen abgelesen, in denen
 * das Bild entschieden hat, nicht die Zahl:
 *
 *   bleiben muss die erste   EuroAirport fr/ch ≤ 1,7 · Rhein fr/ch ≤ 3,5 ·
 *                            Altmark st/eu bis 5,9
 *   wechseln muss sie        Andorra es/eu 9 bis 17 · Sagres es-Füllung 150
 *
 * Die Altmark (Sachsen-Anhalt, um 52,63° N 11,56° E) hat die Schwelle zweimal
 * nach oben getrieben. Dort liegen gleichmäßige Getreidefelder, scharf, mit
 * klar sichtbaren Fahrgassen, Detail 0,45 bis 0,94 — gegen ein verwaschenes
 * Copernicus-Bild aus einer anderen Jahreszeit, dessen abgeerntete Streifen
 * auf 2,6 bis 4,2 kommen. Mit dem Drei- und dann dem Fünffachen gewann dort
 * das schlechtere Bild. Der Grund ist grundsätzlich: Der Detailwert misst
 * KONTRAST, nicht Schärfe, und Jahreszeiten ändern den Kontrast beliebig.
 * (Ein Schärfemaß — Sprung über einen gegen über vier Bildpunkte — wurde
 * nachgemessen und trennt nicht: Andorras Klötzchen 0,39, das scharfe Feld
 * 0,38.)
 *
 * Was übrig bleibt, wofür die Regel wirklich gebraucht wird, sind FÜLLBILDER:
 * ein Dienst, der außerhalb seines Gebiets Klötze oder eine Farbfläche
 * liefert. Die liegen um eine Größenordnung daneben, nicht um den Faktor
 * fünf. Andorra ist zusätzlich fest ausgenommen (`ohne` an `es`), weil es mit
 * 8 bis 9 zu nah an der Schwelle liegt.
 *
 * Zusätzlich muss die Herausforderin SELBST ein Bild sein, das die Grenze
 * `detailGrenze` ihrer Quelle erreicht — daran scheitern Wasser und
 * Rollfeld, wo beide Werte fast null sind und das Verhältnis zufällig ist
 * (am Rhein pendelte es genau um die Schwelle und gab ein Schachbrett auf dem
 * Fluss). Gemessen wird dabei an der gestreckten Grenze, nicht an der vollen:
 * Mit `DETAIL_GUT` für alle hätte Copernicus auf Stufe 19 nie mehr gewinnen
 * können, auch nicht gegen das Klötzchen-Mosaik von Andorra.
 */
const DEUTLICH_BESSER = 8;

/**
 * Welche von zwei Kacheln die bessere ist.
 *
 * Erst die Vollständigkeit: Eine Kachel ohne Löcher ist immer besser als eine
 * mit, auch wenn in den Löchern nichts Wichtiges fehlte — die darunterliegende
 * Ebene hat eine andere Farbstimmung, und der Übergang fällt auf.
 *
 * Danach zählt der Detailgehalt — aber nur ein DEUTLICHER Unterschied. Die
 * zuerst gefundene Kachel behält ihren Platz, bis eine andere selbst gut ist
 * UND mehr als das Achtfache an Struktur zeigt. Warum, steht an
 * `DEUTLICH_BESSER`.
 */
function besserAls(a: Kachel, grenzeA: number, b: Kachel): boolean {
  if (a.luecken !== b.luecken) return !a.luecken;
  return a.detail >= grenzeA && a.detail > DEUTLICH_BESSER * b.detail;
}

/** Was die Suche für eine Kachel ergeben hat. */
interface Auswahl {
  bester: Kachel | null;
  besterName: string;
  ausfall: boolean;
  geoErster: string;
  zelle: string;
}

/**
 * Die Quelle für eine Kachel suchen — getrennt von der Route, weil sie zwei
 * Aufrufer hat: die Kachelauslieferung selbst und die Frage, ob an einer
 * Stelle ein amtliches Luftbild liegt (`/api/tiles/aerial/abdeckung`). Beide
 * müssen zu DERSELBEN Antwort kommen, sonst erlaubt die Karte tiefes
 * Hineinzoomen über einem Bild, das gar nicht angezeigt wird.
 */
/**
 * Gibt es an dieser Kachel ein AMTLICHES Luftbild? Für die Esri-Route
 * (routes/imagery.ts): Esri wird dort nie geholt — nicht abgerechnet und nicht
 * über das bessere Bild gelegt —, auch wenn die App beim Wechsel in ein
 * amtliches Gebiet noch einen Moment lang Esri anfragt.
 *
 * Schneller Weg: Liegt keine örtliche Quelle in der Nähe, ist die Antwort
 * sofort „nein". `null` = unklar (eine Landesquelle war nicht erreichbar oder
 * der Server ist überlastet) — dann lieber kein Esri.
 */
export async function amtlichesLuftbild(z: number, x: number, y: number): Promise<boolean | null> {
  const [lat, lon] = tileCenterWgs84(z, x, y);
  if (kandidaten(lat, lon).length === 0) return false;
  try {
    const { bester, besterName, ausfall } = await waehle("hi", z, x, y);
    if (bester && besterName !== "eu") return true;
    return ausfall ? null : false;
  } catch {
    return null;
  }
}

/** Die Abdeckung von Copernicus VHR 2021 — Punkt für Punkt abgefragt, siehe `aerial-hi` in mapStyle.ts. */
function inEuDeckung(lat: number, lon: number): boolean {
  return lon >= -32 && lon <= 42 && lat >= 27 && lat <= 72;
}

async function waehle(
  region: string,
  z: number,
  x: number,
  y: number,
  signal?: AbortSignal,
): Promise<Auswahl> {
  /**
   * Welche Quellen kommen in Frage?
   *
   * Für ein einzelnes Gebiet genau eine. Für „hi" alle, deren Rechteck die
   * Kachelmitte enthält — meist eine, in Grenznähe zwei oder drei, und die
   * zuletzt erfolgreiche zuerst.
   */
  let kand: string[];
  /**
   * Welche Quelle die GEOMETRIE vorn sieht — unabhängig vom Gedächtnis.
   * Siehe die Hinweis-Regel weiter unten.
   */
  let geoErster = "";
  if (region === "hi") {
    const [lat, lon] = tileCenterWgs84(z, x, y);
    kand = kandidaten(lat, lon);
    geoErster = kand[0] ?? "";
    const gemerkt = regionHinweis.get(hinweisSchluessel(z, x, y));
    if (gemerkt && kand.includes(gemerkt)) {
      kand = [gemerkt, ...kand.filter((k) => k !== gemerkt)];
    }
    /**
     * EUROPA ganz zuletzt — auf JEDER Zoomstufe, auch über seiner eigenen
     * Auflösungsgrenze.
     *
     * HIER STECKTE DER FEHLER, UND ER WAR MEINER. Vorher stand hier
     * `z <= eu.maxzoom`, also nur bis Stufe 16. Darüber sollte die Karte
     * selbst strecken, dafür lag in `mapStyle.ts` eine zweite Ebene
     * `aerial-eu-high` mit `minzoom: 17` auf derselben Quelle — und die hat
     * eine Obergrenze von 16.
     *
     * Eine Rasterebene, deren Untergrenze ÜBER der Obergrenze ihrer Quelle
     * liegt, zeichnet MapLibre nicht. Das ist nachgewiesen, nicht vermutet:
     * Ein Nutzerbildschirm aus Hamburg auf Stufe 17 wurde Bildpunkt für
     * Bildpunkt gegen zwei nachgerechnete Fassungen gehalten — einmal
     * Copernicus 2 m gestreckt, einmal Sentinel 10 m gestreckt. Das Bild vom
     * Gerät war zweifelsfrei das zweite. Über Stufe 16 blieb also in jedem
     * Land ohne eigenen Dienst nur noch das weltweite 10-Meter-Bild,
     * sechzehnfach gestreckt. Genau das war „auf einmal ist alles
     * verschwommen".
     *
     * Jetzt liefert der Server auch diese Stufen selbst (siehe `ausEltern`,
     * das aus der gespeicherten 16er-Kachel schneidet). Damit gibt es über
     * Stufe 13 nur noch EINE Rasterebene, und sie ist immer gefüllt — keine
     * Annahme mehr darüber, was die Karte nebenbei noch zeichnet.
     *
     * Der Preis ist gezählt: Ein Bildschirm auf Stufe 17 kostet 55 Anfragen
     * statt der vierzehn, mit denen die Karte dieselbe Streckung gemacht
     * hätte. Die Kacheln kommen aber aus dem Speicher und ohne eine einzige
     * Anfrage nach außen, und richtig ist es allemal: Lieber etwas mehr
     * Verkehr als ein leerer Bildschirm.
     */
    /**
     * Copernicus nur dort fragen, wo es Copernicus GIBT. Seit es auch Quellen
     * außerhalb Europas gibt (USA, Japan, …), lief sonst jede Kachel dort
     * zusätzlich in eine Anfrage, die nie etwas liefern kann.
     */
    const eu = SOURCES.eu!;
    if (z >= eu.minzoom && inEuDeckung(lat, lon)) kand = [...kand, "eu"];
  } else {
    kand = [region];
  }

  /**
   * KEIN Anfragebudget für Kacheln — die Bremse ist die Grenze.
   *
   * Hier stand ein Zähler, der abgewiesene Anfragen mit 429 beantwortete. Das
   * war doppelt schädlich: Eine Karte, die eine Kachel nicht bekommt, merkt
   * sich den Fehlschlag und versucht es erst nach einer Wartezeit erneut —
   * aus einer kurzen Spitze wurde so ein minutenlang leeres Bild. Und nötig
   * war der Zähler nie: Die Spuren je Dienst begrenzen den Durchsatz schon
   * von selbst, und zwar ohne einen einzigen Fehler. Wer zu viel will, wartet
   * — statt eine Absage zu bekommen, die haften bleibt.
   */
  let ausfall = false;
  /**
   * DIE BESTE KACHEL GEWINNT, NICHT DIE ERSTE.
   *
   * Vorher hieß die Regel „nimm die erste, die nicht leer ist", und daran
   * sind zwei Fälle gescheitert, beide nachgemessen. Über Andorra liefert
   * Spanien ein Bild mit einem Detailgehalt von 1,04 — Copernicus hätte für
   * dieselbe Stelle 13,29 gehabt, wurde aber nie gefragt. Über Sagres
   * dasselbe, sobald Portugal zu langsam antwortete: Spanien sprang mit 0,17
   * ein, während Portugal 26,41 hat.
   *
   * Jetzt wird bewertet. Eine vollständige Kachel schlägt eine durchlöcherte,
   * und darunter entscheidet der Detailgehalt. Sobald eine Kachel gut genug
   * ist (`DETAIL_GUT`), hört die Suche auf — das ist der Regelfall und kostet
   * keine zusätzliche Anfrage. Nur wenn das Erste dürftig aussieht, wird
   * weitergesucht, und das ist genau dann richtig.
   */
  let bester: Kachel | null = null;
  let besterName = "";
  const zelle = hinweisSchluessel(z, x, y);
  for (const k of kand) {
    /**
     * Wer für die Elternkachel nichts hatte, wird gar nicht gefragt —
     * siehe `schonLeerBekannt`. Spart beim Hineinzoomen alle Fehlversuche
     * der tieferen Stufen, und zwar beweisbar, nicht geschätzt.
     */
    if (schonLeerBekannt(k, z, x, y)) continue;
    const kachel = await kachelVonQuelle(k, z, x, y, false, signal);
    if (!kachel) {
      ausfall = true;
      continue;
    }
    if (kachel.leer) continue;
    const grenze = detailGrenze(SOURCES[k]!, z);
    if (bester === null || besserAls(kachel, grenze, bester)) {
      bester = kachel;
      besterName = k;
    }
    // Gut genug — weitersuchen brächte nichts und kostete eine Anfrage.
    if (!kachel.luecken && kachel.detail >= grenze) break;
  }

  return { bester, besterName, ausfall, geoErster, zelle };
}

/**
 * Auf welcher Stufe die Abdeckungsfrage geprüft wird.
 *
 * 17 ist die Stufe, die die Karte bei Kartenzoom 16 ohnehin holt — wer bis zur
 * Grenze hineinzoomt, ist dort vorbeigekommen, die Kachel liegt also fast
 * immer schon im Speicher, und die Frage kostet keine Anfrage nach außen.
 * Gleichzeitig ist sie fein genug: rund 300 Meter Kantenlänge in Mitteleuropa.
 */
const ABDECKUNG_STUFE = 17;

/**
 * Wie tief die Karte über einem Luftbild dieser Quelle zoomen darf.
 *
 * Kartenstufe Z zeigt Kacheln der Stufe Z + 1 (256er-Kacheln, siehe
 * `MapSurface.tsx`). Eine Quelle mit nativer Obergrenze M ist also bei
 * Kartenstufe M − 1 bildpunktgenau; zwei Stufen darüber (M + 1) ist jeder
 * Quellpunkt viermal so groß wie ein Bildschirmpunkt — genau die zwei Stufen,
 * die über einem Orthofoto noch etwas zeigen. Nie unter 18 (so weit darf man
 * überall, das war die bisherige Grenze), nie über 20.
 */
function erlaubteKartenstufe(quelle: AerialSource | undefined): number {
  if (!quelle) return 18;
  return Math.min(20, Math.max(18, quelle.maxzoom + 1));
}

const abdeckungSchema = z.object({
  lat: z.coerce.number().min(-85).max(85),
  lon: z.coerce.number().min(-180).max(180),
});

export async function tilesRoutes(app: FastifyInstance) {
  /**
   * Liegt hier ein amtliches Orthofoto — und wie tief darf die Karte deshalb?
   *
   * Beantwortet mit DERSELBEN Auswahl wie die Kacheln (`waehle`), und das ist
   * der Grund, warum das hier steht und nicht im Gerät nachgerechnet wird: Die
   * Rechtecke der Quellen überlappen an jeder Grenze, und ob ein Dienst an
   * einer Stelle wirklich ein Bild hat, weiß nur, wer ihn gefragt hat. Würde
   * das Gerät raten, erlaubte es womöglich Stufe 20 über dem Zwei-Meter-Bild
   * von Copernicus — genau das, wovor die Grenze 18 schützen soll.
   */
  /**
   * Rate-Limit — der Proxy war offen: jede Kachel eine Anfrage bei einem
   * Landesdienst plus Bildbearbeitung (sharp). Großzügig, weil die Karte die
   * Kacheln selbst (ohne Client-Kennung) lädt und ein Wisch Dutzende fordert.
   */
  const tilesLimiter = ipLimiter("aerial-tiles", [
    { limit: 1500, windowMs: 60 * 1000 },
    { limit: 20000, windowMs: 60 * 60 * 1000 },
  ]);
  const coverageLimiter = ipLimiter("aerial-coverage", [{ limit: 120, windowMs: 60 * 1000 }]);

  app.get("/api/tiles/aerial/abdeckung", { preHandler: coverageLimiter }, async (req, reply) => {
    const parsed = abdeckungSchema.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: "Bad request" });
    const { lat, lon } = parsed.data;
    const n = 2 ** ABDECKUNG_STUFE;
    const x = Math.min(n - 1, Math.floor(((lon + 180) / 360) * n));
    const rad = (lat * Math.PI) / 180;
    const y = Math.min(
      n - 1,
      Math.floor(
        ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n,
      ),
    );
    let gewaehlt: Awaited<ReturnType<typeof waehle>>;
    try {
      gewaehlt = await waehle("hi", ABDECKUNG_STUFE, x, y);
    } catch (err) {
      // Wie bei den Kacheln: Überlast ist vorübergehend (503, nicht merken),
      // kein Serverfehler.
      if (err instanceof UeberlastetError) {
        reply.header("Cache-Control", "no-store");
        return reply.code(503).send({ error: "Busy" });
      }
      throw err;
    }
    const { bester, besterName, ausfall } = gewaehlt;
    const amtlich = !!bester && besterName !== "eu";
    // Ein Ausfall kann die Antwort verfälschen (die Landesquelle war nur
    // gerade nicht erreichbar) — dann nicht lange merken lassen.
    reply.header(
      "Cache-Control",
      ausfall ? "no-store" : "public, max-age=86400",
    );
    return {
      amtlich,
      quelle: amtlich ? besterName : null,
      maxZoom: erlaubteKartenstufe(amtlich ? SOURCES[besterName] : undefined),
      // Eine Landesquelle war gerade nicht erreichbar — die Antwort kann falsch
      // sein. Die App merkt sie sich dann nicht (und blendet Esri nicht ein).
      vorlaeufig: ausfall,
    };
  });

  app.get("/api/tiles/aerial/:region/:z/:x/:y", { preHandler: tilesLimiter }, async (req, reply) => {
    const parsed = paramsSchema.safeParse(req.params);
    if (!parsed.success) return reply.code(400).send({ error: "Bad request" });
    const { region, z, x, y } = parsed.data;

    // Bricht die Karte die Kachel ab (Verbindung zu, bevor die Antwort raus
    // ist), soll sie hier keinen Platz in der Schlange mehr belegen.
    const aufgegeben = new AbortController();
    reply.raw.once("close", () => {
      if (!reply.raw.writableFinished) aufgegeben.abort();
    });

    let gewaehlt: Awaited<ReturnType<typeof waehle>>;
    try {
      gewaehlt = await waehle(region, z, x, y, aufgegeben.signal);
    } catch (err) {
      if (err instanceof UeberlastetError || err instanceof AbgebrochenError) {
        // Abgebrochen: Die Antwort geht ins Leere, die Verbindung ist zu.
        reply.header("Cache-Control", "no-store");
        return reply.code(503).send({ error: "Busy" });
      }
      throw err;
    }
    const { bester, besterName, ausfall, geoErster, zelle } = gewaehlt;

    if (bester) {
      /**
       * Nur ausliefern, was auch ein Bild IST.
       *
       * `sniffType` kennt genau zwei Bildarten; alles andere wäre eine
       * Fehlermeldung, die als Kachel durchgerutscht ist. So etwas darf das
       * Gerät nicht mit sieben Tagen Haltbarkeit bekommen.
       */
      if (bester.type !== "image/jpeg" && bester.type !== "image/png") {
        reply.header("Cache-Control", "no-store");
        return reply.code(502).send({ error: "Upstream" });
      }
      /**
       * Treffer merken — die Nachbarkacheln sparen sich damit die Suche.
       *
       * Nur bei einer vollwertigen Kachel: Die europaweite Rückfallebene
       * liefert überall etwas und würde sich sonst sofort festsetzen, und eine
       * durchlöcherte oder dürftige Kachel ist kein Beweis für Zuständigkeit.
       */
      /**
       * … und NUR, wenn die Siegerquelle auch geometrisch vorn stand.
       *
       * Sonst setzt sich ein Zufall fest. Nachgemessen bei Vaals: An einer
       * Kachel gewann der niederländische Dienst, weil die
       * nordrhein-westfälische dort Löcher hat. Der Hinweis galt danach für
       * das ganze Zehn-Kilometer-Feld — auch für die Kacheln, auf denen NRW
       * vollständig liefert. Zehn aufeinanderfolgende Kacheln kamen aus den
       * Niederlanden, obwohl NRW überall deckend war. Dort war es harmlos (8
       * gegen 10 Zentimeter), an der bayerisch-österreichischen Grenze wären es
       * Österreichs 30 statt Bayerns 20 Zentimeter.
       *
       * Ein Hinweis soll eine wiederkehrende Zuständigkeit festhalten, nicht
       * einen Ausrutscher an der Kante.
       */
      if (
        region === "hi" &&
        besterName === geoErster &&
        besterName !== "eu" &&
        !bester.luecken &&
        bester.detail >= detailGrenze(SOURCES[besterName]!, z)
      ) {
        regionHinweis.set(zelle, besterName);
      }
      /**
       * Sieben Tage auf dem Gerät — aber nur, wenn wirklich alle gefragt
       * werden konnten.
       *
       * Hat unterwegs eine Gegenstelle gestreikt und ein anderer ist
       * eingesprungen, ist dieses Bild nur die zweitbeste Antwort. Die für eine
       * Woche festzuschreiben hieße, eine vorübergehende Störung auf dem Gerät
       * einzufrieren. Fünf Minuten reichen, um den Bildschirm flüssig zu
       * halten, und sind schnell genug wieder vergessen.
       */
      reply.header(
        "Cache-Control",
        ausfall ? "public, max-age=300" : "public, max-age=604800, immutable",
      );
      /**
       * Eine Kennung für die Kachel, damit das Gerät nach Ablauf nur
       * nachfragen statt alles neu laden muss. Die Länge und die Quelle
       * zusammen sind eindeutig genug — dieselbe Kachel aus derselben Quelle
       * ist dieselbe Datei.
       */
      /**
       * Eine Kennung für die Kachel — und sie wird auch AUSGEWERTET.
       *
       * Ohne die Auswertung wäre sie Zierde: Nach Ablauf der sieben Tage fragt
       * das Gerät mit `If-None-Match` nach, und ohne Vergleich bekäme es jedes
       * Mal die vollen zwanzig Kilobyte statt einer leeren Bestätigung. Die
       * Länge und die Quelle zusammen sind eindeutig genug — dieselbe Kachel
       * aus derselben Quelle ist dieselbe Datei.
       */
      const etag = `"${besterName}-${z}-${x}-${y}-${bester.buf.length}"`;
      reply.header("ETag", etag);
      const mitgeschickt = req.headers["if-none-match"];
      if (typeof mitgeschickt === "string" && mitgeschickt.includes(etag)) {
        return reply.code(304).send();
      }
      reply.header("Content-Type", bester.type);
      return reply.send(bester.buf);
    }

    if (ausfall) {
      reply.header("Cache-Control", "no-store");
      return reply.code(502).send({ error: "Upstream" });
    }
    reply.header("Cache-Control", "public, max-age=604800, immutable");
    reply.header("Content-Type", "image/png");
    return reply.send(await leereKachel());
  });
}
