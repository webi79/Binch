/**
 * MapLibre Style JSON für unsere Dark-Theme-Karte.
 *
 * Tile-Quelle: OpenFreeMap (https://openfreemap.org) — komplett kostenlos,
 * kein API-Key, OpenStreetMap-basiert. Bei größerem Volumen kann die
 * `tiles.openfreemap.org`-URL durch einen eigenen Tile-Server (z.B.
 * Protomaps + nginx) ersetzt werden — der Style bleibt gleich.
 *
 * Schema-Referenz: OpenMapTiles vector tile schema.
 * https://openmaptiles.org/schema/
 */

import type {
  FilterSpecification,
  LayerSpecification,
  LineLayerSpecification,
  StyleSpecification,
  SymbolLayerSpecification,
} from "@maplibre/maplibre-react-native";
import { API_BASE_URL } from "@/lib/api/client";
import type { Locale } from "@/lib/i18n/dict";
import type { ResolvedMapStyle } from "@/lib/theme/mapStyleChoice";

/**
 * Die Farben des Stils — als PALETTE, nicht als feste Werte in den Ebenen.
 *
 * WARUM: Es gibt mehrere Karten-Stile, und der dunkle und das Luftbild
 * unterscheiden sich nur in den Farben. Zwei Kopien des Ebenen-Blocks
 * nebeneinander wären zwei Stellen, an denen künftig eine Zoomstufe nachgezogen
 * werden müsste, und genau so laufen sie auseinander.
 *
 * Die HELLE Karte geht inzwischen weiter: Sie soll aussehen wie Google Maps
 * (Wunsch des Nutzers), und das braucht Ebenen, die die dunkle bewusst nicht
 * hat — Straßen mit Kontur, Flüsse als Linie, Ortsmarken. Die stehen in
 * `MapDetail`/`detailLayers`; was beide gleich zeigen, übernimmt die helle
 * Karte weiter aus dem gemeinsamen Block.
 *
 * Jedes Feld trägt eine ROLLE, keine Farbe: `roadTrunk` ist „die wichtigste
 * Straße", nicht „grau". Damit ist eine neue Palette eine Liste von
 * Entscheidungen und keine Suche im Ebenen-Block.
 */
export interface MapPalette {
  /** Der Grund, auf dem alles liegt. */
  bg: string;
  water: string;
  wood: string;
  park: string;
  /** Bebaute Fläche — hebt die Stadt leicht vom Grund ab. */
  residential: string;
  building: string;
  rail: string;
  /** Die Straßen-Leiter, von unwichtig nach wichtig. */
  roadMinor: string;
  roadSecondary: string;
  roadPrimary: string;
  roadTrunk: string;
  boundary: string;
  /** Beschriftungen. `halo` ist die Farbe des Rands um jede Schrift — sie muss
   *  dem GRUND entsprechen, sonst franst der Text aus. */
  cityText: string;
  suburbText: string;
  waterText: string;
  roadText: string;
  /** Ländernamen auf der Kugel (`place-country`) — nur die Vektor-Karten haben sie. */
  countryText: string;
  halo: string;
  /**
   * Die Feinheiten der hellen Karte (Google-Maps-Bild) — fehlen sie, baut
   * `buildMapStyle` Ebene für Ebene genau den bisherigen Stil. Dunkel und
   * Satellit führen sie deshalb nicht; siehe `MapDetail`.
   */
  detail?: MapDetail;
}

/**
 * Was die helle Karte ZUSÄTZLICH zeichnet — die Stufen, mit denen Google Maps
 * arbeitet: Gras heller als Wald, Flüsse als Linie, Straßen mit Kontur,
 * Flughäfen, Gletscher, Ortsmarken.
 *
 * WARUM NICHT EINFACH WEITERE FARBEN IM BISHERIGEN EBENEN-BLOCK: Die dunkle
 * Karte soll bleiben, wie sie ist — ruhig, mit dünnen Linien ohne Kontur. Was
 * hier steht, bekommt deshalb eigene Ebenen (`detailLayers`), und nur ein Stil
 * mit `detail` bekommt sie.
 */
export interface MapDetail {
  /** Wiese, Weide, Gebüsch, Parks, Friedhöfe — eine Stufe heller als Wald. */
  grass: string;
  ice: string;
  sand: string;
  /** Flughafengelände und, eine Stufe kräftiger, Start- und Rollbahnen. */
  airport: string;
  runway: string;
  /** Flüsse, Kanäle, Bäche — auf Landesebene sonst unsichtbar (nur die breitesten sind Fläche). */
  waterway: string;
  /**
   * Land- und Kreisstraßen WEIT DRAUSSEN: dort graublaue Haarlinien ohne
   * Kontur, wie bei Google; erst in der Stadt werden sie weiß mit Kontur.
   */
  roadFar: string;
  /** Die Konturen der Straßen-Leiter. */
  roadMinorCasing: string;
  roadSecondaryCasing: string;
  roadPrimaryCasing: string;
  roadTrunkCasing: string;
  /** Fuß-, Rad- und Feldwege — eine feine Linie ohne Kontur. */
  path: string;
  buildingOutline: string;
  /** Grenzen der Länder INNERHALB eines Staats — gestrichelt, schwächer als Staatsgrenzen. */
  stateBoundary: string;
  /** Der Ring der Ortsmarke vor dem Stadtnamen (weit draußen). */
  placeDot: string;
}

/** Die bisherige Karte, Wert für Wert unverändert übernommen. */
export const DARK_PALETTE: MapPalette = {
  bg: "#14181A",
  water: "#1B2E3A",
  wood: "#1A2420",
  park: "#1F2A22",
  residential: "#181B1E",
  building: "#1E2226",
  rail: "#3A3D40",
  roadMinor: "#22262A",
  roadSecondary: "#33373B",
  roadPrimary: "#42474D",
  roadTrunk: "#525860",
  boundary: "#3A3D40",
  cityText: "#B0B4B8",
  suburbText: "#7A7E84",
  waterText: "#6B95B5",
  roadText: "#6C7079",
  countryText: "#868B92",
  halo: "#14181A",
};

/**
 * Die helle Karte — so, wie Google Maps aussieht (Wunsch des Nutzers: „den
 * gleichen Mapstyle, den auch Google Maps nutzt").
 *
 * Die Farben sind GEMESSEN, nicht geschätzt: aus einem Bildschirmfoto von
 * Google Maps über dem Ruhrgebiet, Bildpunkt für Bildpunkt ausgezählt. Land
 * #D1F7E0 (ein Drittel des Bildes), Grün in zwei Stufen (#C8F4DB Wiese und
 * Gebüsch, #B9F2D2 Wald), Siedlung #F7F7F7, Wasser #87D9EE, Autobahn #A9BCDA
 * mit dunklerer Kontur, Landstraßen als graublaue Haarlinie, Grenze fast
 * schwarz, Schrift #2F3034 mit weißem Rand, die Ortsmarke ein schwarzer Ring.
 * Die Straßenebene zeigt das Foto nicht; dort ist Googles Logik fortgesetzt:
 * Straßen weiß mit feiner grauer Kontur, je wichtiger desto kräftiger, Gebäude
 * hellgrau.
 *
 * Der Schrift-Rand ist hier WEISS und nicht die Grundfarbe — bei Google steht
 * jeder Name auf einem hellen Hof, über Grün wie über Siedlung.
 */
export const LIGHT_PALETTE: MapPalette = {
  bg: "#D1F7E0",
  water: "#87D9EE",
  /** Die Wald-Ebene deckt zu 0,9 — gezeichnet über dem Land ergibt das genau Googles #B9F2D2. */
  wood: "#B6F1D0",
  park: "#C8F4DB",
  residential: "#F7F7F7",
  building: "#E8E9ED",
  rail: "#B4BAC4",
  roadMinor: "#FFFFFF",
  roadSecondary: "#FFFFFF",
  roadPrimary: "#FFFFFF",
  roadTrunk: "#A9BCDA",
  boundary: "#2A3B35",
  cityText: "#2F3034",
  suburbText: "#5B5F66",
  waterText: "#2E7D9C",
  roadText: "#5F6368",
  countryText: "#5B5F66",
  halo: "#FFFFFF",
  detail: {
    grass: "#C8F4DB",
    ice: "#FFFFFF",
    sand: "#F4EFD9",
    airport: "#D0DFF6",
    runway: "#BCCBE6",
    waterway: "#87D9EE",
    roadFar: "#9DB8C8",
    roadMinorCasing: "#DCDFE5",
    roadSecondaryCasing: "#CDD3DD",
    roadPrimaryCasing: "#BFC8D6",
    roadTrunkCasing: "#7A8DAA",
    path: "#FFFFFF",
    buildingOutline: "#D7D9DE",
    stateBoundary: "#9AA0A6",
    placeDot: "#000000",
  },
};

/**
 * Die weltweite Satelliten-Ebene — EOX „Sentinel-2 cloudless", Jahrgang 2016.
 *
 * WARUM AUSGERECHNET DIESE QUELLE: Geprüft wurden Esri World Imagery, Mapbox,
 * MapTiler, Bing, NASA GIBS und EOX. Übrig bleibt genau eine, die zugleich ohne
 * Schlüssel auskommt, weltweit deckt UND in einer veröffentlichten App erlaubt
 * ist. Esri liefert zwar bis Zoom 21 ohne Schlüssel, steht aber unter dem „Esri
 * Master License Agreement", das die Nutzung auf das Nachzeichnen von Geodaten
 * beschränkt; Bing untersagt jede Nutzung ohne schriftliche Erlaubnis;
 * MapTilers Gratis-Stufe ist ausdrücklich nicht-kommerziell; GIBS ist
 * gemeinfrei, endet aber bei 250 m je Bildpunkt und damit weit vor einer
 * Stadtansicht. Eine offen erreichbare URL ist kein Freibrief — das ist hier
 * ein Rechts-, kein Technikproblem.
 *
 * WARUM WIEDER 2016, obwohl 2017 mehr Kontrast hat: Weil der Jahrgang 2017
 * KEIN Weltmosaik ist. Das ist nachgemessen worden, nachdem die Weltkarte
 * gemeldet wurde, auf der alle Kontinente weiß waren und nur über Europa ein
 * Bild lag. Anteil reinweißer Bildpunkte je Kachel:
 *
 *                       2016      2017
 *   Europa, Zoom 4–6     0,0 %     0,0 %
 *   Nordamerika, Zoom 5  0,0 %   100,0 %
 *   Asien, Zoom 5        0,0 %   100,0 %
 *   Südamerika, Zoom 5   0,0 %   100,0 %
 *   Afrika, Zoom 6       0,0 %   100,0 %
 *
 * Der Jahrgang 2017 deckt nur Europa ab und füllt den Rest der Welt mit Weiß.
 * Für eine Ebene, die genau dann sichtbar ist, wenn man weit herauszoomt, ist
 * das der denkbar schlechteste Fehler. Der Kontrastgewinn galt ohnehin nur für
 * die Zoomstufen 13 und 14 — und dort liegt inzwischen längst Copernicus mit
 * 2 Metern darüber, oft ein amtliches Orthofoto mit 20 Zentimetern. Diese
 * Ebene ist heute nur noch die Grundlage unterhalb von Zoom 9.
 *
 * DER JAHRGANG IST AUCH TEIL DER LIZENZ. Wörtlich aus dem
 * Fähigkeiten-Dokument, Ebene für Ebene:
 *
 *   s2cloudless_3857        (Daten 2016)  CC BY 4.0        ← nutzbar, GENOMMEN
 *   s2cloudless-2017_3857   (Daten 2017)  CC BY 4.0        ← nutzbar, aber nur Europa
 *   s2cloudless-2018_3857 … -2025_3857    CC BY-NC-SA 4.0  ← nicht-kommerziell
 *
 * Wer den Jahrgang wieder anfassen will, prüft ZWEI Dinge: das Abstract der
 * Ebene (der Lizenztext steht dort wörtlich drin) UND die Abdeckung außerhalb
 * Europas. Der einzige Unterschied zwischen erlaubt und verboten ist der
 * Ebenenname, und der einzige zwischen Weltkarte und Flickenteppich auch.
 *
 * REIHENFOLGE `{z}/{y}/{x}`: Der Dienst spricht WMTS, dort heißen die beiden
 * Achsen TileRow und TileCol — Zeile vor Spalte. Wer hier aus Gewohnheit
 * `{z}/{x}/{y}` schreibt, bekommt Kacheln vom anderen Ende der Welt.
 */
const SATELLITE_TILES =
  "https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless_3857/default/g/{z}/{y}/{x}.jpg";

/**
 * Die Pflicht-Nennung — sie bleibt, sie steht nur nicht mehr im Blatt.
 *
 * CC BY 4.0 verlangt die Nennung; wo sie steht, lässt die Lizenz offen („in
 * any reasonable manner"). Bei Karten ist der übliche Ort die ⓘ-Schaltfläche,
 * und genau die sammelt MapLibre aus den `attribution`-Feldern der Quellen.
 * Eine zweite, fest eingeblendete Zeile im Auswahl-Blatt war doppelt gemoppelt
 * und wurde auf Wunsch entfernt.
 *
 * Wortlaut aus dem Fähigkeiten-Dokument des Dienstes übernommen — dieses Feld
 * ist damit die einzige Stelle, an der die Bedingung noch erfüllt wird. Wer es
 * löscht, nutzt die Bilder unlizenziert.
 */
const SATELLITE_ATTRIBUTION =
  'EOxCloudless 2016 by <a href="https://eox.at">EOX</a> ' +
  "(Contains modified Copernicus Sentinel data 2016) — " +
  '<a href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a>';

/**
 * Bis hierher gibt es ECHTE Bildinformation — darüber streckt der Anbieter nur
 * noch.
 *
 * Nachgemessen, und zwar rechnerisch statt nach Augenmaß: Rechnet man die
 * Elternkachel auf die Kindkachel hoch und vergleicht, liegt der Fehler bis
 * Zoom 13 bei 3 bis 7 Helligkeitsstufen (echte neue Daten), ab Zoom 14 unter
 * 1,3 — das ist JPEG-Rauschen, also reines Hochskalieren. Dass die glatte
 * Hochrechnung dabei deutlich besser trifft als die stufige, ist der
 * Fingerabdruck: Der Anbieter interpoliert genauso, wie MapLibre es selbst
 * täte. Dieselbe Messung in Äquatornähe ergibt dieselbe Grenze, es ist also
 * kein Breitengrad-Effekt.
 *
 * Daraus folgt der Wert 13 und nicht 14: MapLibre streckt die 13er-Kachel ab
 * da selbst, das Bild ist messbar dasselbe — und wir sparen drei Viertel aller
 * Luftbild-Anfragen. Die Quelle löst 10 m je Bildpunkt auf; schärfer wird es
 * mit ihr nicht, egal welche Zahl hier steht.
 *
 * Ab Zoom 19 antwortet der Dienst ohnehin mit 404. Dieselbe Falle wie bei den
 * Vektorkacheln, nur dass es dort „200 mit null Byte" ist.
 */
const SATELLITE_MAXZOOM = 13;

/**
 * DIE ERDE AUS DER FERNE: NASA Blue Marble mit Relief und Meerestiefe.
 *
 * Auf der Kugel wirkte das Luftbild unnatürlich — die Sahara knallgelb,
 * Australien orange. Zwei Gründe: EOxCloudless ist ein Mosaik aus
 * Hochsommer-Aufnahmen, und `AERIAL_PAINT` hebt Sättigung und Kontrast noch an
 * (für die Stadt gedacht, wo das Bild sonst flau ist). Blue Marble zeigt die
 * Erde so, wie man sie aus dem All kennt — gedeckte Landfarben, blaue Ozeane
 * mit hellen Schelfen und leichtem Relief, wie in Google Earth.
 *
 * NASA, gemeinfrei (Nennung erbeten), über den Kachel-Dienst GIBS ohne
 * Schlüssel; Stufe 8 ist die feinste (500 m je Bildpunkt). Ab Zoom 4,5 blendet
 * es ins Luftbild über, ab 6,5 ist es weg.
 */
const BLUE_MARBLE_TILES =
  "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/BlueMarble_ShadedRelief_Bathymetry/default/GoogleMapsCompatible_Level8/{z}/{y}/{x}.jpeg";
const BLUE_MARBLE_ATTRIBUTION =
  '<a href="https://earthobservatory.nasa.gov/features/BlueMarble">Blue Marble: NASA Earth Observatory</a> · <a href="https://www.earthdata.nasa.gov/eosdis/science-system-description/eosdis-components/gibs">NASA GIBS</a>';

/**
 * Was auf der ganzen Kugel nicht zu sehen sein soll: Grenzen und Namen.
 * Aus dem All wirkt die Erde ohne sie natürlich (wie Google Earth); ab Stufe 3
 * — ein Kontinent füllt den Schirm — kommen sie dazu.
 */
const SATELLITE_GLOBE_CLEAN = new Set(["boundary-country", "water-name", "place-city"]);

/**
 * Die Beschriftungs-Palette für das Luftbild.
 *
 * Weder die dunkle noch die helle Palette ist auf einem Luftbild lesbar: Über
 * Feldern, Wäldern und Dächern wechselt der Untergrund alle paar Bildpunkte
 * zwischen hell und dunkel. Deshalb weiße Schrift mit kräftigem dunklem Rand —
 * das ist die einzige Kombination, die über jedem Untergrund steht.
 *
 * Die Flächen-Felder (`water`, `wood`, `park`, `residential`, `building`) sind
 * hier ohne Wirkung: Im Luftbild-Modus werden die zugehörigen Ebenen gar nicht
 * erst gebaut — sie würden das Bild ja zudecken. Sie stehen nur, weil sie zum
 * Typ gehören.
 */
export const SATELLITE_PALETTE: MapPalette = {
  /** Was man sieht, solange eine Kachel noch lädt — nicht Weiß, das blitzt. */
  bg: "#0E1114",
  water: "transparent",
  wood: "transparent",
  park: "transparent",
  residential: "transparent",
  building: "transparent",
  rail: "transparent",
  roadMinor: "transparent",
  roadSecondary: "transparent",
  /** Nur die großen Achsen, halbdurchsichtig — sie sollen führen, nicht zudecken. */
  roadPrimary: "rgba(255,255,255,0.38)",
  roadTrunk: "rgba(255,255,255,0.55)",
  boundary: "rgba(255,255,255,0.45)",
  cityText: "#FFFFFF",
  suburbText: "#E4E6E8",
  waterText: "#BFD8EA",
  roadText: "#DCDEE1",
  /** Ohne Wirkung — das Luftbild hat keine Ländernamen (siehe `SATELLITE_LAYERS`). */
  countryText: "#E4E6E8",
  halo: "rgba(0,0,0,0.85)",
};

/**
 * HOCHAUFLÖSENDE Luftbilder für einzelne Gebiete — über dem weltweiten Bild.
 *
 * Das Satellitenbild löst 10 Meter je Bildpunkt auf; ab Zoom 14 kommt dort
 * nachweislich keine neue Information mehr. Die amtlichen Orthofotos der
 * Bundesländer liegen bei 10 Zentimetern — hundertmal feiner — und sind Open
 * Data. Wo es sie gibt, liegen sie deshalb oben drauf.
 *
 * DIE KANTE IST DER PREIS, und sie ist bekannt: An der Gebietsgrenze liefert
 * der Dienst durchsichtige Kacheln, darunter kommt wieder das Satellitenbild
 * zum Vorschein. Der Übergang ist hart, und die beiden Bilder sind zudem
 * unterschiedlich hell. Deshalb `minzoom`: Erst ab Zoom 13 wird überhaupt
 * umgeschaltet — da ist eine Landesgrenze so gut wie nie im Bild, und genau
 * dort fängt der Gewinn an. Wer weiter herauszoomt, sieht durchgehend das
 * Satellitenbild.
 *
 * `bounds` spart die Anfragen gleich ganz: MapLibre fragt außerhalb des
 * angegebenen Rechtecks keine Kachel an.
 *
 * Der Umweg über den eigenen Server ist kein Versteckspiel — die Quellen sind
 * offen. Er rechnet nur um: Die Landesdienste zählen ihre Zoomstufen anders,
 * und eine URL-Vorlage kann nicht rechnen. Siehe `server/src/routes/tiles.ts`.
 */
interface AerialRegion {
  id: string;
  /** Der Gebiets-Schlüssel, wie ihn der Server kennt. */
  region: string;
  /** [West, Süd, Ost, Nord] in WGS84. */
  bounds: [number, number, number, number];
  minzoom: number;
  maxzoom: number;
  /** Pflicht-Nennung der Quelle — MapLibre sammelt sie in der ⓘ-Schaltfläche. */
  attribution: string;
}

/**
 * Die Leiter, von grob nach fein — ERST EUROPA, DANN die Länder.
 *
 * Die Reihenfolge in dieser Liste ist die Reihenfolge der Ebenen: Was später
 * kommt, liegt oben. Deshalb steht Europa zuerst und die nationalen Bilder
 * darüber, wo es sie gibt.
 *
 * Dass die europäische Schicht erst bei Zoom 9 einsetzt und die nationalen bei
 * 13, ist die Antwort auf die Kanten-Frage. Mehr Nachbarländer machen die
 * Nähte nämlich NICHT unsichtbarer, sondern zahlreicher: Jeder Datensatz hat
 * eigenen Bildflug, Sonnenstand und Farbabgleich, und wo zwei aneinanderstoßen,
 * springt das Bild. Wirksam ist nicht mehr Abdeckung, sondern die Zoomschwelle
 * — unterhalb von 13 sieht man ausschließlich eine durchgehende Schicht, und ab
 * 13 ist der Bildausschnitt so klein, dass fast nie beide Seiten einer Grenze
 * gleichzeitig im Bild sind.
 */
/**
 * Die Pflicht-Nennungen der amtlichen Luftbilder.
 *
 * Nicht alle Quellen verlangen eine — Nordrhein-Westfalen steht unter
 * „dl-de/zero-2-0" und Luxemburg unter `AccessConstraints: none`, dort wäre
 * gar nichts nötig. Andere verlangen sie ausdrücklich: Frankreich unter der
 * Licence Ouverte 2.0, Spanien unter CC BY 4.0, die Niederlande unter CC BY.
 * Weil der Server die Quelle je Kachel selbst wählt, lässt sich nicht sagen,
 * welche gerade zu sehen ist — also stehen sie alle da. Wer diese Zeile
 * löscht, nutzt die Bilder unlizenziert.
 */
const AERIAL_ATTRIBUTION =
  "Luftbilder: © GeoBasis-DE (Länder) · © GeoBasis-DE/M-V · " +
  "© GeoBasis-DE/LVermGeo ST · " +
  "© DGU Hrvatska · " +
  '© <a href="https://www.ign.fr">IGN</a> France · ' +
  '© <a href="https://www.ign.es">IGN</a>/CC BY 4.0 scne.es · ' +
  "© Kadaster/PDOK · © basemap.at · © swisstopo · © ACT Luxembourg · " +
  "© GUGiK Polska · © Geoportale Nazionale MASE Italia · " +
  "Freie und Hansestadt Hamburg, LGV · " +
  "Bron: Digitaal Vlaanderen · © SPW Wallonie · © GKÚ, NLC Slovensko · " +
  "© Ministerul Apărării Naționale România · © NŽT Lietuva · " +
  "© Agenția Relații Funciare și Cadastru Moldova · " +
  "© Department of Lands and Surveys, Cyprus · " +
  "© Liechtensteinische Landesverwaltung · " +
  "© DGT Portugal · © GURS Slovenija · © ČÚZK Česko · © Maa-amet Eesti · " +
  // Dänemark: „Vilkår for brug af frie geografiske data" + GeoDanmark (CC BY 4.0).
  "Indeholder data fra Klimadatastyrelsen, Ortofoto forår (@geodanmark) · " +
  // Finnland: CC BY 4.0 verlangt Lizenzgeber, Datensatz und Zeitpunkt.
  "Sisältää Maanmittauslaitoksen Ortokuva-aineistoa 10/2026 (CC BY 4.0) · " +
  "Loftmyndir © Náttúrufræðistofnun Íslands (CC BY 4.0)";

/**
 * Die Nennungen der Gebiete AUSSERHALB Europas — je Gebiet eine eigene Ebene
 * (siehe `AERIAL_REGIONS`), damit dort nur die jeweils gültige steht.
 */
const AERIAL_ATTRIBUTION_US = "Orthoimagery: USGS The National Map / USDA NAIP (public domain)";
const AERIAL_ATTRIBUTION_JP =
  '出典：<a href="https://maps.gsi.go.jp/development/ichiran.html">国土地理院</a>';
const AERIAL_ATTRIBUTION_NZ = "Imagery © Toitū Te Whenua LINZ, CC BY 4.0";
const AERIAL_ATTRIBUTION_TW = "© 內政部國土測繪中心 NLSC · 政府資料開放授權條款第1版";
const AERIAL_ATTRIBUTION_NSW =
  "© Spatial Services, NSW Department of Customer Service (CC BY 3.0 AU) · incl. © AAM, © Jacobs/Ausimage";
const AERIAL_ATTRIBUTION_UY = "Fuente: IDE Uruguay – Licencia de Datos Abiertos Uruguay";
const AERIAL_ATTRIBUTION_GL = "Indeholder data fra Asiaq, Greenland Survey";

/**
 * DIE EBENEN, und zwar getrennt von den Quellen.
 *
 * WAS HIER SCHIEFGING, UND WARUM ES JETZT ANDERS AUSSIEHT: Hier standen drei
 * Rasterebenen. Die europaweite Schicht hatte zwei davon — eine für die
 * Stufen 9 bis 12 und eine zweite mit `minzoom: 17`, die oberhalb der
 * amtlichen Bilder einspringen sollte. Beide zeigten auf dieselbe Quelle, und
 * deren Obergrenze ist 16.
 *
 * Eine Rasterebene, deren Untergrenze ÜBER der Obergrenze ihrer Quelle liegt,
 * zeichnet MapLibre nicht. Damit war ab Stufe 17 in jedem Land ohne eigenen
 * Orthofoto-Dienst nur noch das weltweite Satellitenbild übrig — 10 Meter je
 * Bildpunkt, sechzehnfach gestreckt.
 *
 * Nachgewiesen wurde es an einem Bildschirmfoto aus Hamburg: Derselbe
 * Ausschnitt wurde zweimal nachgerechnet, einmal aus Copernicus mit 2 Metern
 * und einmal aus Sentinel mit 10 Metern, beide auf dieselbe Stufe gestreckt.
 * Das Bild vom Gerät war zweifelsfrei das zweite. Genau das war die Meldung
 * „ich zoome noch einmal rein und auf einmal ist alles verschwommen".
 *
 * Deshalb gibt es oberhalb von Stufe 13 jetzt nur noch EINE Rasterebene. Was
 * sie zeigt, entscheidet allein der Server — amtliches Bild, wo es eins gibt,
 * sonst Copernicus, und oberhalb von dessen Auflösungsgrenze streckt er
 * selbst. Keine Annahme mehr darüber, was die Karte nebenbei noch zeichnet.
 */
interface AerialLayer {
  id: string;
  /** Welche Quelle aus `AERIAL_REGIONS`. */
  source: string;
  minzoom?: number;
  maxzoom?: number;
}

/**
 * Etwas kräftigere Farben für alle Luftbild-Ebenen — im Shader der Karte, ohne
 * einen einzigen Bildpunkt auf dem Server anzufassen.
 *
 * Amtliche Orthofotos sind farbneutral aufgenommen und wirken auf dem Handy
 * blass. Nachgemessen an Kacheln, wie der Server sie ausliefert (mittlere
 * Sättigung, 0 = grau): Paris 0,09, Zürich 0,10, Hamburg 0,11, Köln 0,17. Ein
 * verlorenes Farbprofil ist es nicht — keine der geprüften Kacheln trägt eins,
 * und die meisten gehen unverändert durch.
 *
 * Die Werte sind an einer Vorschau gewählt, die MapLibres Shader-Rechnung
 * nachbildet (Sättigungsfaktor 1 − 1/(1,001 − s), Kontrast 1/(1 − c)), an
 * Hamburg, Paris, Wien und dem Copernicus-Bild von London: Bei +0,2/+0,08
 * lebendiger und noch natürlich, bei +0,35/+0,12 werden Dächer und Wasser
 * knallig. Dazwischen liegt „ein bisschen farbenfroher".
 */
const AERIAL_PAINT = {
  "raster-saturation": 0.25,
  "raster-contrast": 0.1,
} as const;

const AERIAL_LAYERS: AerialLayer[] = [
  { id: "aerial-eu-low", source: "aerial-eu", minzoom: 9, maxzoom: 13 },
  { id: "aerial-hi", source: "aerial-hi", minzoom: 13 },
  // Außerhalb Europas: dieselbe Server-Auswahl, nur je Gebiet eine Ebene.
  { id: "aerial-us", source: "aerial-us", minzoom: 13 },
  { id: "aerial-ushi", source: "aerial-ushi", minzoom: 13 },
  { id: "aerial-jp", source: "aerial-jp", minzoom: 13 },
  { id: "aerial-nz", source: "aerial-nz", minzoom: 13 },
  { id: "aerial-tw", source: "aerial-tw", minzoom: 13 },
  { id: "aerial-aunsw", source: "aerial-aunsw", minzoom: 13 },
  { id: "aerial-uy", source: "aerial-uy", minzoom: 13 },
  { id: "aerial-gl", source: "aerial-gl", minzoom: 13 },
];

/**
 * Stand der Kachelauswahl auf dem Server — Teil der Kachel-URL.
 *
 * Der Server liefert die Luftbildkacheln mit einer Woche Haltbarkeit und
 * „immutable" aus; das Gerät fragt so lange gar nicht mehr nach. Ändert sich
 * auf dem Server, WELCHE Quelle eine Kachel bekommt, sähe man das auf einem
 * Gerät, das dort schon war, erst nach einer Woche. Genau so ist es mit dem
 * Schachbrett am EuroAirport Basel-Mulhouse gewesen: Die falsch gewählten
 * Schweizer Kacheln lagen fest im Speicher. Eine neue Nummer ist eine neue
 * Adresse, und die alten Einträge laufen ungenutzt aus.
 *
 * Hochzählen, wenn sich die Auswahl auf dem Server ändert — nicht bei jeder
 * Serveränderung.
 *
 * 3: Die Auswahl wurde nach Stand 2 noch zweimal nachgezogen (scharfe Felder
 * in Sachsen-Anhalt verloren gegen Copernicus, Spanien stand vor Portugal).
 * Was ein Gerät in dieser Zwischenzeit geholt hat, soll nicht liegen bleiben.
 *
 * 4: Finnland, Dänemark und Island bekommen eigene Quellen — dort lagen bisher
 * leere bzw. Copernicus-Kacheln im Gerätespeicher.
 *
 * 5: Helle Dächer galten auf dem Server als Füllweiß (Bahnhof Coburg,
 * Bahnsteigdächer ab Stufe 18). Die Kachel ging dann als unscharfes
 * Copernicus-Bild für eine Woche ans Gerät, mitten im scharfen Luftbild.
 * Erst NACH dem neuen Server laden — sonst landet unter der neuen Nummer
 * wieder die alte Auswahl im Speicher.
 */
const AERIAL_STAND = 5;

const AERIAL_REGIONS: AerialRegion[] = [
  {
    /**
     * Ganz Europa, 2 m — nur noch für die Stufen 9 bis 12 und als gestreckte
     * Rückfallebene ab Stufe 17. Dazwischen liefert sie der Server selbst,
     * siehe unten.
     */
    id: "aerial-eu",
    region: "eu",
    bounds: [-32, 27, 42, 72],
    minzoom: 9,
    maxzoom: 16,
    attribution:
      'Copernicus VHR 2021 — <a href="https://land.copernicus.eu">Copernicus Land Monitoring Service</a>',
  },
  /**
   * ALLES HOCHAUFGELÖSTE IN EINER EBENE — und ihr Rechteck ist jetzt GANZ
   * EUROPA, nicht mehr nur der Teil mit amtlichen Bildern.
   *
   * DAS WAR DER FEHLER, und er ist gemeldet worden als „in vielen Bereichen
   * scheint es, als wären die 2 m nicht da". Genau so war es: Dieses Rechteck
   * umschloss nur die Länder mit eigenem Orthofoto-Dienst, also [-9,7 · 35,2 ·
   * 24,2 · 55,2]. Außerhalb davon gab es zwischen Stufe 13 und 16 GAR KEINE
   * Zwei-Meter-Ebene — die europaweite Schicht war dort abgeschaltet, weil sie
   * innerhalb der Länder nur doppelt geladen hätte. Betroffen war alles jenseits
   * der Kanten: Kopenhagen (55,7 Grad Nord), ganz Skandinavien, Schottland,
   * Rumänien, Bulgarien, die östliche Ägäis. Dort blieb nur das weltweite
   * Satellitenbild mit 10 Metern, gestreckt.
   *
   * Jetzt reicht das Rechteck so weit wie Copernicus selbst, und der Server
   * entscheidet je Kachel: erst die amtlichen Dienste, und wenn dort nichts
   * liegt, Copernicus (siehe `kandidaten` in `server/src/routes/tiles.ts`).
   * Damit sind die 2 Meter eine UNTERGRENZE, die überall in Europa gilt, und
   * es bleibt trotzdem bei EINER Anfrage je Kachel.
   *
   * Nachgemessen ist die Abdeckung lückenlos: Schwerin, Hamburg, Magdeburg,
   * Kopenhagen, Stockholm, Oslo, Helsinki, Reykjavík, Edinburgh, Dublin,
   * London, Bukarest, Sofia, Athen, Istanbul, Zagreb, Budapest, Bratislava,
   * Riga, Vilnius, Malta, Zypern, Madeira und die Azoren liefern alle ein
   * echtes Bild. Einzig die Ukraine fehlt — sie ist nicht Teil des
   * Copernicus-Mosaiks.
   *
   * Die Kanaren und Estland brauchen deshalb kein eigenes Rechteck mehr; sie
   * liegen in diesem hier drin.
   *
   * Nicht als amtliches Bild enthalten und damit bei 2 Metern, jeweils mit
   * Grund:
   *
   * GRIECHENLAND ist der wichtigste Fall, und er ist nicht „unklar", sondern
   * untersagt. Der Dienst liefert zwar (über EPSG:4326 — seine Mercator-Stufen
   * geben nur einfarbige Kacheln), aber die Nutzungsseite des Katasteramts
   * sagt wörtlich, dass „jede Form kommerzieller Nutzung oder Verwertung des
   * Orthofoto-Betrachtungsdienstes ausdrücklich untersagt" ist, solange keine
   * Abgabepolitik verkündet wurde. Wer das später einbauen will, prüft zuerst,
   * ob diese Seite noch dasselbe sagt.
   *
   * ZUGANGSSCHLÜSSEL nötig: Dänemark, Schweden, Finnland, Großbritannien,
   * Ungarn, Lettland. Norwegen hat seine offenen Dienste ausdrücklich
   * eingestellt („reserviert für Norge-digitalt-Teilnehmer"), Irland gibt
   * Luftbilder nur über ein Abonnement ab.
   *
   * LIZENZ NICHT BELEGBAR: Albanien (der Dienst liefert 66-cm-Satellitenbilder,
   * nennt aber keinerlei Bedingungen), Bulgarien (das Fähigkeiten-Dokument
   * sagt „NONE", der Metadatensatz widerspricht mit einer Zugangsbeschränkung
   * nach INSPIRE-Artikel 13 — bei einem Widerspruch wird nicht geraten).
   *
   * TECHNISCH UNBRAUCHBAR: Island (kennt nur sein Landesraster, keinen
   * Web-Mercator), Malta (die Zweitinsel Gozo antwortet dauerhaft mit einem
   * Dienstfehler).
   *
   * KEIN ÖFFENTLICHER DIENST gefunden: Serbien und die Türkei (beide aus
   * Deutschland nicht erreichbar), Bosnien, Montenegro, Nordmazedonien,
   * Kosovo, Andorra.
   *
   * Außerhalb des Copernicus-Mosaiks liegen Belarus, die Ukraine, Kaliningrad
   * und Spitzbergen — dort bleibt nur das weltweite Satellitenbild mit 10
   * Metern. Moldau lag ebenfalls dort und hat jetzt einen eigenen Dienst.
   */
  {
    /**
     * DAS RECHTECK IST ABGETASTET, NICHT GESCHÄTZT.
     *
     * Es stand auf [-26 · 27 · 45 · 72] und schnitt damit die westlichen
     * Azoren ab: Flores und Corvo liegen auf 31 Grad West, und Copernicus
     * liefert dort nachweislich ein Bild (159 875 Byte für Flores). Wer dorthin
     * reiste, sah nur die 10-Meter-Ebene.
     *
     * Die Dienstbeschreibung hilft dabei nicht weiter — sie nennt ihre
     * Ausdehnung in der Projektion EPSG:3035, und deren Ecken ergeben
     * zurückgerechnet ein Rechteck von 55 Grad West bis 71 Grad Ost. Das ist
     * die Hülle des projizierten Vierecks, nicht die Abdeckung; im mittleren
     * Atlantik liegt nichts. Deshalb ist der Rand Punkt für Punkt abgefragt
     * worden:
     *
     *   Flores (31,2° W)      Bild        Mitte Atlantik (40° W)   nichts
     *   El Hierro (27,8° N)   Bild        Tanger (35,8° N)         nichts
     *   Ankara (32,9° O)      Bild        Batumi (41,6° O)         nichts
     *   Nordkap (71,2° N)     Bild        Spitzbergen (78,2° N)    nichts
     *
     * Daraus dieses Rechteck. Es ist absichtlich knapp: Jede Kachel außerhalb
     * der echten Abdeckung kostet eine Anfrage, die nichts bringt.
     */
    id: "aerial-hi",
    region: "hi",
    bounds: [-32, 27, 42, 72],
    minzoom: 13,
    maxzoom: 20,
    attribution: AERIAL_ATTRIBUTION,
  },
  /**
   * AUSSERHALB EUROPAS — dieselbe Server-Auswahl (`hi`), aber je Gebiet eine
   * eigene Ebene mit eigenem Rechteck. Ein Rechteck um die ganze Welt hätte
   * jede Kachel in Afrika oder Südamerika zum Server geschickt, nur damit er
   * „hier gibt es nichts" antwortet. Die Rechtecke entsprechen den `bounds`
   * der Quellen in server/src/routes/tiles.ts.
   */
  { id: "aerial-us", region: "hi", bounds: [-124.85, 24.4, -66.9, 49.4], minzoom: 13, maxzoom: 20, attribution: AERIAL_ATTRIBUTION_US },
  { id: "aerial-ushi", region: "hi", bounds: [-160.3, 18.85, -154.75, 22.3], minzoom: 13, maxzoom: 20, attribution: AERIAL_ATTRIBUTION_US },
  { id: "aerial-jp", region: "hi", bounds: [122.9, 24.0, 146.0, 45.6], minzoom: 13, maxzoom: 20, attribution: AERIAL_ATTRIBUTION_JP },
  // Neuseeland liefert erst, wenn LINZ_API_KEY auf dem Server steht.
  { id: "aerial-nz", region: "hi", bounds: [166.3, -47.4, 178.6, -34.3], minzoom: 13, maxzoom: 20, attribution: AERIAL_ATTRIBUTION_NZ },
  { id: "aerial-tw", region: "hi", bounds: [118.1, 21.8, 122.1, 26.4], minzoom: 13, maxzoom: 20, attribution: AERIAL_ATTRIBUTION_TW },
  { id: "aerial-aunsw", region: "hi", bounds: [140.99, -37.51, 153.64, -28.15], minzoom: 13, maxzoom: 20, attribution: AERIAL_ATTRIBUTION_NSW },
  { id: "aerial-uy", region: "hi", bounds: [-58.45, -35.0, -53.07, -30.08], minzoom: 13, maxzoom: 20, attribution: AERIAL_ATTRIBUTION_UY },
  // Nur der Teil westlich von 32° W — östlich davon deckt `aerial-hi` (Europa) schon ab.
  { id: "aerial-gl", region: "hi", bounds: [-73.3, 59.7, -32, 83.7], minzoom: 13, maxzoom: 20, attribution: AERIAL_ATTRIBUTION_GL },
];

/**
 * Welche Ebenen im Luftbild-Modus ÜBERLEBEN.
 *
 * Alles Flächige fliegt raus — es läge deckend über dem Bild und machte es
 * unsichtbar. Was bleibt, ist das, was ein Luftbild NICHT zeigen kann: Namen
 * und die großen Achsen. Ein Mosaik mit 10 m je Bildpunkt ohne Ortsnamen ist
 * keine Karte, sondern eine Tapete.
 *
 * Kleine Straßen, Nebenstraßen und Schienen fehlen absichtlich: Sie liegen bei
 * dieser Auflösung unter der Bildschärfe und ergäben nur Liniensalat.
 */
const SATELLITE_LAYERS = new Set([
  "background",
  "road-trunk",
  "road-primary",
  "boundary-country",
  "place-city",
  "place-suburb",
  "water-name",
  "road-name",
]);

/**
 * DIE NAMEN IN DER APP-SPRACHE — für Orte, Länder und Gewässer.
 *
 * Die Kacheln führen je Name neben dem örtlichen `name` die Übersetzungen
 * `name:de`, `name:en`, `name:fr` und `name:es`, dazu `name_int` (den
 * internationalen, meist englischen Namen) und `name:latin` (lateinische
 * Schrift, bei fremder Schrift umgeschrieben). Nachgesehen in echten Kacheln:
 * Москва heißt dort Moskau, Moscow, Moscou und Moscú, und das Ostsee-Schild
 * stand bisher als „Morze Bałtyckie / Baltijos jūra / … / Балтийское море" auf
 * der Karte — `name` ist bei Grenzgewässern und zweisprachigen Orten eine Liste.
 *
 * Die Kette: zuerst die App-Sprache, auf Englisch danach der internationale
 * Name, dann die lateinische Schreibung, zuletzt der örtliche Name. Der ist
 * immer da — es fehlt also nie ein Name. Ein Kandidat aus nur einem Zeichen
 * zählt nicht: Die Türkei hat in den Kacheln `name:en` = „T".
 *
 * Straßennamen bleiben örtlich, wie bei Google: Ein Straßenschild wird nicht
 * übersetzt.
 */
function nameFields(locale: Locale): string[] {
  return [`name:${locale}`, ...(locale === "en" ? ["name_int"] : []), "name:latin", "name"];
}

type Expression = Extract<
  NonNullable<NonNullable<SymbolLayerSpecification["layout"]>["text-field"]>,
  unknown[]
>;

/** Der Name als Ausdruck für `text-field` — siehe `nameFields`. */
function nameExpression(locale: Locale): Expression {
  const fields = nameFields(locale);
  const last = fields[fields.length - 1]!;
  const branches: Expression[] = [];
  for (const field of fields.slice(0, -1)) {
    const value: Expression = ["to-string", ["get", field]];
    branches.push([">", ["length", value], 1], value);
  }
  return ["case", ...branches, ["to-string", ["get", last]]] as Expression;
}

/**
 * Derselbe Name aus den Eigenschaften eines Kartenobjekts — für den Tipp auf
 * einen Ortsnamen (`MapSurface`), damit das Blatt die Stadt so nennt wie die
 * Karte. `null`, wenn das Objekt gar keinen Namen trägt.
 */
export function localizedName(
  properties: Record<string, unknown> | null | undefined,
  locale: Locale,
): string | null {
  if (!properties) return null;
  const fields = nameFields(locale);
  for (const field of fields.slice(0, -1)) {
    const value = properties[field];
    if (typeof value === "string" && value.length > 1) return value;
  }
  const local = properties[fields[fields.length - 1]!];
  return typeof local === "string" && local.length > 0 ? local : null;
}

/**
 * LÄNDERNAMEN (`place-country`) — was beide Vektor-Karten gleich machen.
 *
 * Welche: Die großen und mittleren Länder (`rank` 1–2) von weit draußen an,
 * die kleinen (3–4) erst ab Zoom 4, der Rest ab 5. Auf der Kugel stünden sonst
 * Monaco, Kosovo und Vatikanstadt zwischen den Großen. Der Zoom im Filter gilt
 * je Kachel, also in ganzen Stufen.
 *
 * Wo: Steht der Name auf seinem Punkt im Weg, darf er ein Stück nach oben,
 * unten, links oder rechts ausweichen. Ohne das fehlte auf der Europa-Kugel
 * ausgerechnet Deutschland: Belgien hat in den Kacheln denselben Rang 1, liegt
 * auch noch im Randstreifen der westlichen Nachbarkachel und wurde dort zuerst
 * gesetzt — die Reihenfolge über Kachelgrenzen hinweg lässt sich mit
 * `symbol-sort-key` nicht steuern, der wirkt nur innerhalb einer Kachel.
 */
const COUNTRY_FILTER: FilterSpecification = [
  "all",
  ["==", ["get", "class"], "country"],
  [">=", ["zoom"], ["step", ["coalesce", ["get", "rank"], 9], 0, 3, 4, 5, 5]],
];
const COUNTRY_PLACEMENT = {
  "text-variable-anchor": ["center", "top", "bottom", "left", "right"],
  "text-radial-offset": 0.4,
  "text-max-width": 7,
  "symbol-sort-key": ["coalesce", ["get", "rank"], 9],
} satisfies NonNullable<SymbolLayerSpecification["layout"]>;

/**
 * DER DUNST DER KUGEL — bis hier voll, ab hier weg (`atmosphere-blend` unter
 * `sky`). Die helle Karte rechnet mit genau diesen Stufen, siehe `hazeProof`.
 */
const HAZE_FULL_UNTIL = 5;
const HAZE_GONE_AT = 7;

/**
 * Bis hier ist der Grund der hellen Karte Land, ab hier Siedlung — siehe die
 * Ebene `background` in `detailLayers`.
 *
 * 13 ist der Startzoom der Umgebungskarte (`DEFAULT_ZOOM` in surroundings.tsx):
 * Dort muss die Stadt schon grau sein. Früher umzuschlagen macht dagegen das
 * Land fleckig — in den gröberen Kacheln fehlen die kleinen Äcker (gezählt im
 * Münsterland: bei Zoom 12 sind 22 % der Fläche ohne Bewuchs-Fläche, bei 13
 * noch 8 %).
 */
const LAND_UNTIL = 11.5;
const LAND_GONE_AT = 13;

/**
 * Was der Dunst aus jeder Farbe macht: Kanal × 0,947 + (35, 51, 62).
 *
 * GEMESSEN, nicht geschätzt — an Testkugeln in einer einzigen Farbe (Schwarz,
 * drei Grautöne), gezeichnet mit `mbgl-render` aus der selbst gebauten
 * Bibliothek, Bildmitte wie Rand, Zoom 0,8 bis 5: überall dieselbe Gerade; bei
 * Zoom 6 genau die Hälfte. Die Sonne steht dort fest zur Kamera, nicht zur
 * Uhrzeit — deshalb gilt die Messung auf jedem Gerät.
 */
const HAZE_KEEP = 0.947;
const HAZE_ADD = [35, 51, 62] as const;

/** Die Farbe, die UNTER dem Dunst liegen muss, damit darüber `hex` herauskommt. */
function underHaze(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  return (
    "#" +
    [n >> 16, (n >> 8) & 255, n & 255]
      .map((c, i) => Math.round(Math.min(255, Math.max(0, (c - HAZE_ADD[i]!) / HAZE_KEEP))))
      .map((c) => c.toString(16).padStart(2, "0"))
      .join("")
      .toUpperCase()
  );
}

/**
 * Eine Ebene der hellen Karte so umfärben, dass sie auf der Kugel MIT Dunst so
 * aussieht wie ohne.
 *
 * WARUM: Die Atmosphäre legt sich über die ganze Kugel, Beschriftungen
 * eingeschlossen. Auf der dunklen Karte ist das der gewollte bläuliche Schleier.
 * Auf der hellen machte er aus Googles Mintgrün fast Weiß (#E9FFFF) und aus dem
 * Wasser grelles Türkis — Grün- und Blaukanal standen am Anschlag. Darum liegt
 * dort die vorab abgedunkelte Farbe (`underHaze`), und zwischen Zoom 5 und 7,
 * genau wo der Dunst linear ausblendet, geht sie linear in die echte über: Das
 * Ergebnis bleibt auf jeder Stufe dieselbe Farbe.
 *
 * Erfasst nur feste Farben (#RRGGBB) und nur Ebenen, die unter Zoom 7 zu sehen
 * sein können; ausgerechnete Farben (`match`, `interpolate`) bleiben, wie sie
 * sind. Ändert sich der Dunst in der Bibliothek, ist `HAZE_KEEP`/`HAZE_ADD`
 * neu zu messen.
 *
 * Der Schrift-RAND bleibt, wie er ist: Er ist weiß, und Weiß kommt durch den
 * Dunst ohnehin als Weiß heraus (jeder Kanal läuft über). Ein Name, der über den
 * Erdrand ins All ragt — dort liegt kein Dunst —, bekäme sonst einen beigen Rand.
 */
function hazeProof(layer: LayerSpecification): LayerSpecification {
  if (!("paint" in layer) || !layer.paint || (layer.minzoom ?? 0) >= HAZE_GONE_AT) return layer;
  const paint: Record<string, unknown> = { ...layer.paint };
  for (const [key, value] of Object.entries(paint)) {
    if (key === "text-halo-color") continue;
    if (key.endsWith("-color") && typeof value === "string" && /^#[0-9A-F]{6}$/i.test(value)) {
      paint[key] = [
        "interpolate",
        ["linear"],
        ["zoom"],
        HAZE_FULL_UNTIL,
        underHaze(value),
        HAZE_GONE_AT,
        value,
      ];
    }
  }
  return { ...layer, paint } as LayerSpecification;
}

type LinePaint = NonNullable<LineLayerSpecification["paint"]>;

/**
 * Linienbreite über den Zoom — EXPONENTIELL, nicht linear: Eine Straße hat eine
 * echte Breite, auf dem Bildschirm verdoppelt sie sich also mit jeder Stufe.
 * Linear über zwölf Stufen gestreckt wäre sie weit draußen zu dick und in der
 * Stadt zu dünn für eine Kontur.
 */
function zoomWidth(...stops: number[]): LinePaint["line-width"] {
  return ["interpolate", ["exponential", 1.5], ["zoom"], ...stops];
}

/** Von unsichtbar (`from`) bis voll da (`to`). */
function fadeIn(from: number, to: number): LinePaint["line-opacity"] {
  return ["interpolate", ["linear"], ["zoom"], from, 0, to, 1];
}

/**
 * Die Ebenen der hellen Karte — in Zeichenreihenfolge, von unten nach oben.
 *
 * Gegenüber dem Grundstil kommen dazu: bebaute Fläche in allen Arten statt nur
 * Wohngebiet, Gras eine Stufe heller als Wald, Gletscher, Sand, Flüsse als
 * Linie, Flughäfen, Straßen mit Kontur, Wege, Landesgrenzen und die Ortsmarke
 * vor dem Stadtnamen. Das Wasser liegt ÜBER dem Bewuchs (ein See im Wald ist
 * sonst zugedeckt); im Grundstil liegt es darunter, und dort bleibt es so.
 *
 * Was in beiden Stilen gleich aussieht, wird aus dem Grundstil ÜBERNOMMEN statt
 * neu geschrieben (`keep`) — Wasser, Wald und drei Beschriftungen. Eine
 * Zoomstufe an den Straßennamen ist damit weiter nur an einer Stelle zu ändern.
 *
 * Die IDs der Grundstil-Ebenen bleiben, wo die Rolle dieselbe ist: Die
 * Kartenfläche fragt Tipps auf Ortsnamen über `place-city` ab, und die Häuser
 * mit Höhe hängen sich davor ein (`Buildings3DLayer`).
 */
function detailLayers(
  p: MapPalette,
  d: MapDetail,
  base: LayerSpecification[],
  /** Der Name in der App-Sprache — siehe `nameExpression`. */
  name: Expression,
): LayerSpecification[] {
  const keep = (id: string): LayerSpecification => {
    const layer = base.find((l) => l.id === id);
    // Ein Programmierfehler, kein Laufzeitfall — er fällt beim ersten Start auf.
    if (!layer) throw new Error(`mapStyle: Ebene „${id}" fehlt im Grundstil`);
    return layer;
  };

  /**
   * Straßen: Filter und Layout je Stufe EINMAL, gemeinsam für Kontur und
   * Füllung. Stimmen Quelle, Filter und Layout überein, legt MapLibre beide
   * Ebenen in denselben Kachel-Puffer — die Kontur kostet dann nur einen
   * Zeichendurchgang, keine zweite Geometrie.
   */
  const ROUND: LineLayerSpecification["layout"] = { "line-cap": "round", "line-join": "round" };
  /**
   * Nur LINIEN: Die Quell-Ebene führt auch Flächen (Plätze, Brücken), und eine
   * Linien-Ebene zöge um jede davon einen Rahmen.
   */
  const LINE: FilterSpecification = ["==", ["geometry-type"], "LineString"];
  /** Fußgängerzonen sind Straßen — bei Google weiß wie die Wohnstraße daneben. */
  const MINOR: FilterSpecification = [
    "all",
    LINE,
    [
      "any",
      ["in", ["get", "class"], ["literal", ["minor", "service"]]],
      ["all", ["==", ["get", "class"], "path"], ["==", ["get", "subclass"], "pedestrian"]],
    ],
  ];
  const SECONDARY: FilterSpecification = [
    "all",
    LINE,
    ["in", ["get", "class"], ["literal", ["tertiary", "secondary"]]],
  ];
  const PRIMARY: FilterSpecification = ["all", LINE, ["==", ["get", "class"], "primary"]];
  const TRUNK: FilterSpecification = [
    "all",
    LINE,
    ["in", ["get", "class"], ["literal", ["trunk", "motorway"]]],
  ];

  /** Eine Straßenstufe als Paar: Kontur darunter, Füllung darüber. */
  const road = (id: string, filter: FilterSpecification) => ({
    casing: (paint: LinePaint): LayerSpecification => ({
      id: `${id}-casing`,
      type: "line",
      source: "openmaptiles",
      "source-layer": "transportation",
      filter,
      layout: ROUND,
      paint,
    }),
    fill: (paint: LinePaint): LayerSpecification => ({
      id,
      type: "line",
      source: "openmaptiles",
      "source-layer": "transportation",
      filter,
      layout: ROUND,
      paint,
    }),
  });
  const minor = road("road-minor", MINOR);
  const secondary = road("road-secondary", SECONDARY);
  const primary = road("road-primary", PRIMARY);
  const trunk = road("road-trunk", TRUNK);

  const layers: LayerSpecification[] = [
    /**
     * DER GRUND: weit draußen Land (Mintgrün), in der Stadtansicht Siedlung.
     *
     * Bei Google ist alles grün, was nicht bebaut ist — dort ist die Bebauung
     * lückenlos erfasst. In OpenStreetMap ist sie es NICHT: Zwischen den
     * Wohn- und Gewerbeflächen liegen Plätze, Bahnhofsvorplätze und ganze
     * Innenstadt-Blöcke ohne Fläche. Bei durchgehend grünem Grund lag die
     * Dortmunder Innenstadt auf Zoom 15 wie in einem Park (nachgezählt: in
     * Köln auf Zoom 14 ein gutes Viertel der Altstadt). Deshalb wird der Grund
     * zur Stadtansicht hin zur Siedlungsfarbe, und Äcker, Wiesen und Wald
     * tragen ihr Grün dort selbst (`landcover-farmland` unten). Was dann
     * noch grau bleibt, sind unerfasste Flecken auf dem Land — der kleinere
     * Fehler: Die Karte zeigt sich ohnehin meist in der Stadt.
     */
    {
      id: "background",
      type: "background",
      paint: {
        "background-color": [
          "interpolate",
          ["linear"],
          ["zoom"],
          HAZE_FULL_UNTIL,
          underHaze(p.bg),
          HAZE_GONE_AT,
          p.bg,
          LAND_UNTIL,
          p.bg,
          LAND_GONE_AT,
          p.residential,
        ],
      },
    },

    /**
     * Nationalparks — nur sie. Die Quell-Ebene `park` führt auch jedes
     * Landschafts- und Denkmalschutzgebiet; flächig getönt läge halb
     * Nordrhein-Westfalen grün und jede Altstadt dazu. Google tönt das nicht.
     */
    {
      id: "park",
      type: "fill",
      source: "openmaptiles",
      "source-layer": "park",
      filter: ["==", ["get", "class"], "national_park"],
      paint: { "fill-color": p.park, "fill-opacity": 0.7 },
    },

    /**
     * Alles Bebaute in EINER Farbe — bei Google ist Siedlung Siedlung, ob
     * Wohnen, Gewerbe oder Bahngelände. `suburb`/`quarter`/`neighbourhood` sind
     * die Stadtteil-Flächen: Weit draußen sind sie das, was von der Stadt übrig
     * bleibt. Was in ihnen grün ist (Wald, Wiese, Park), liegt darüber.
     *
     * Friedhöfe und Sportplätze sind bei Google grün, nicht grau.
     */
    {
      id: "landuse-residential",
      type: "fill",
      source: "openmaptiles",
      "source-layer": "landuse",
      filter: [
        "in",
        ["get", "class"],
        [
          "literal",
          [
            "residential", "suburb", "quarter", "neighbourhood", "commercial", "industrial",
            "retail", "railway", "garages", "bus_station", "hospital", "school", "university",
            "college", "kindergarten", "library", "cemetery", "pitch", "playground", "stadium",
          ],
        ],
      ],
      paint: {
        "fill-color": [
          "match",
          ["get", "class"],
          ["cemetery", "pitch", "playground", "stadium"],
          d.grass,
          p.residential,
        ],
      },
    },

    /**
     * Äcker in der Landfarbe — weit draußen unsichtbar (der Grund hat sie
     * schon), in der Stadtansicht der Grund, auf dem sie grün bleiben.
     */
    {
      id: "landcover-farmland",
      type: "fill",
      source: "openmaptiles",
      "source-layer": "landcover",
      filter: ["==", ["get", "class"], "farmland"],
      paint: { "fill-color": p.bg },
    },
    /** Wiese, Weide, Gebüsch, Heide, Parks, Moor — heller als Wald. */
    {
      id: "landcover-grass",
      type: "fill",
      source: "openmaptiles",
      "source-layer": "landcover",
      filter: ["in", ["get", "class"], ["literal", ["grass", "wetland"]]],
      paint: { "fill-color": d.grass },
    },
    keep("landcover-wood"),
    {
      id: "landcover-ice",
      type: "fill",
      source: "openmaptiles",
      "source-layer": "landcover",
      filter: ["==", ["get", "class"], "ice"],
      paint: { "fill-color": d.ice },
    },
    {
      id: "landcover-sand",
      type: "fill",
      source: "openmaptiles",
      "source-layer": "landcover",
      filter: ["==", ["get", "class"], "sand"],
      paint: { "fill-color": d.sand },
    },
    {
      id: "aeroway-area",
      type: "fill",
      source: "openmaptiles",
      "source-layer": "aeroway",
      filter: ["==", ["geometry-type"], "Polygon"],
      paint: {
        "fill-color": ["match", ["get", "class"], ["runway", "taxiway"], d.runway, d.airport],
      },
    },

    keep("water"),
    /**
     * Flüsse und Kanäle als Linie. Als Fläche kommen auf Landesebene nur die
     * breitesten an (der Rhein), Ruhr und Lippe wären unsichtbar — bei Google
     * sind sie es nicht. Unterirdisch Verrohrtes bleibt weg.
     */
    {
      id: "waterway",
      type: "line",
      source: "openmaptiles",
      "source-layer": "waterway",
      filter: ["!=", ["get", "brunnel"], "tunnel"],
      layout: ROUND,
      paint: {
        "line-color": d.waterway,
        "line-width": [
          "interpolate",
          ["exponential", 1.4],
          ["zoom"],
          4,
          ["match", ["get", "class"], ["river", "canal"], 0.4, 0.2],
          8,
          ["match", ["get", "class"], ["river", "canal"], 0.8, 0.3],
          13,
          ["match", ["get", "class"], ["river", "canal"], 2.5, 0.8],
          18,
          ["match", ["get", "class"], ["river", "canal"], 10, 3],
        ],
      },
    },
    {
      id: "aeroway-line",
      type: "line",
      source: "openmaptiles",
      "source-layer": "aeroway",
      filter: ["==", ["geometry-type"], "LineString"],
      paint: {
        "line-color": d.runway,
        "line-width": [
          "interpolate",
          ["exponential", 1.5],
          ["zoom"],
          10,
          ["match", ["get", "class"], "runway", 1, 0.5],
          16,
          ["match", ["get", "class"], "runway", 20, 8],
        ],
      },
    },

    {
      id: "building",
      type: "fill",
      source: "openmaptiles",
      "source-layer": "building",
      minzoom: 14,
      paint: {
        "fill-color": p.building,
        "fill-outline-color": d.buildingOutline,
        // Weich herein statt hart bei 14 — so tauchen sie bei Google auf.
        "fill-opacity": ["interpolate", ["linear"], ["zoom"], 14, 0, 15, 1],
      },
    },

    /**
     * Fuß-, Rad- und Feldwege: eine feine Linie ohne Kontur, erst in der Nähe.
     * Gestrichelt war die Altstadt ein Netz aus Strichen — jeder Gehweg ist
     * eigens erfasst. So zeigen sie sich, wo sie etwas sagen: im Park und
     * zwischen Feldern; neben der Straße gehen sie im Hell der Stadt auf.
     */
    {
      id: "road-path",
      type: "line",
      source: "openmaptiles",
      "source-layer": "transportation",
      minzoom: 14,
      filter: [
        "all",
        LINE,
        ["in", ["get", "class"], ["literal", ["path", "track"]]],
        ["!=", ["get", "subclass"], "pedestrian"],
      ],
      layout: ROUND,
      paint: {
        "line-color": d.path,
        "line-width": ["interpolate", ["linear"], ["zoom"], 14, 0.8, 18, 2.4],
      },
    },
    /**
     * Schiene: eine feine graue Linie, erst ab der Stadtebene — auf Landesebene
     * zeigt Google keine Gleise, dort wären sie nur ein zweites Straßennetz.
     */
    {
      id: "rail",
      type: "line",
      source: "openmaptiles",
      "source-layer": "transportation",
      filter: ["==", ["get", "class"], "rail"],
      paint: {
        "line-color": p.rail,
        "line-width": ["interpolate", ["linear"], ["zoom"], 10, 0.8, 16, 1.6],
        "line-opacity": fadeIn(9.5, 11),
      },
    },

    /**
     * DIE STRASSEN, Konturen zuerst — alle, dann alle Füllungen. Nur so laufen
     * zwei Straßen an einer Kreuzung ineinander, statt dass die Kontur der
     * einen quer über der anderen liegt.
     *
     * Weit draußen sind Land- und Kreisstraßen graublaue Haarlinien ohne
     * Kontur (`roadFar`), in der Stadt werden sie weiß mit Kontur. Autobahnen
     * bleiben auf jeder Stufe graublau mit dunklerer Kante.
     */
    minor.casing({
      "line-color": d.roadMinorCasing,
      "line-width": zoomWidth(13, 1, 14, 3, 16, 7, 18, 13.5),
      "line-opacity": fadeIn(12.5, 13.5),
    }),
    secondary.casing({
      "line-color": d.roadSecondaryCasing,
      "line-width": zoomWidth(11, 0.9, 12, 2.8, 14, 5, 16, 8.8, 18, 15.5),
      "line-opacity": fadeIn(11, 12.5),
    }),
    primary.casing({
      "line-color": d.roadPrimaryCasing,
      "line-width": zoomWidth(10, 1.1, 12, 3.8, 14, 6.2, 16, 10.5, 18, 19),
      "line-opacity": fadeIn(10, 11.5),
    }),
    trunk.casing({
      "line-color": d.roadTrunkCasing,
      "line-width": zoomWidth(5, 0.5, 7, 1.7, 8, 2.1, 10, 3, 12, 4.6, 14, 7.5, 16, 12.5, 18, 22),
      "line-opacity": fadeIn(5.5, 7),
    }),
    minor.fill({
      "line-color": p.roadMinor,
      "line-width": zoomWidth(12, 0.5, 13, 1, 14, 2, 16, 5.2, 18, 11),
    }),
    secondary.fill({
      "line-color": ["interpolate", ["linear"], ["zoom"], 10.5, d.roadFar, 12, p.roadSecondary],
      "line-width": zoomWidth(9, 0.4, 10, 0.6, 11, 0.9, 12, 1.7, 14, 3.6, 16, 7, 18, 13),
    }),
    primary.fill({
      "line-color": ["interpolate", ["linear"], ["zoom"], 10, d.roadFar, 11.5, p.roadPrimary],
      "line-width": zoomWidth(7, 0.5, 9, 0.8, 10, 1.1, 12, 2.6, 14, 4.6, 16, 8.5, 18, 16),
    }),
    trunk.fill({
      "line-color": p.roadTrunk,
      "line-width": zoomWidth(5, 0.5, 7, 0.85, 8, 1.1, 10, 1.7, 12, 3, 14, 5.5, 16, 10, 18, 19),
    }),

    /** Grenzen der Bundesländer (und ihrer Gegenstücke): grau gestrichelt. */
    {
      id: "boundary-state",
      type: "line",
      source: "openmaptiles",
      "source-layer": "boundary",
      minzoom: 4,
      filter: ["all", ["==", ["get", "admin_level"], 4], ["!=", ["get", "maritime"], 1]],
      layout: { "line-join": "round" },
      paint: {
        "line-color": d.stateBoundary,
        "line-width": ["interpolate", ["linear"], ["zoom"], 4, 0.6, 10, 1.2],
        "line-dasharray": [3, 2],
      },
    },
    /**
     * Staatsgrenzen: fast schwarz und durchgezogen, wie bei Google — aber nicht
     * auf dem Meer. Die Seegrenzen zögen dunkle Striche quer durchs Wasser.
     * Weit draußen schwächer, sonst zeichnet der Globus ein Gitter.
     */
    {
      id: "boundary-country",
      type: "line",
      source: "openmaptiles",
      "source-layer": "boundary",
      filter: ["all", ["==", ["get", "admin_level"], 2], ["!=", ["get", "maritime"], 1]],
      layout: { "line-join": "round" },
      paint: {
        "line-color": p.boundary,
        "line-width": ["interpolate", ["linear"], ["zoom"], 2, 0.6, 6, 1, 10, 1.4],
        "line-opacity": ["interpolate", ["linear"], ["zoom"], 1, 0.4, 5, 0.9],
      },
    },

    /**
     * Ortsnamen wie bei Google: in normaler Schreibung, je wichtiger die Stadt,
     * desto größer (`rank`: 1 = Weltstadt, ab 11 Kleinstadt), und weit draußen
     * mit der hohlen Ortsmarke davor. Die Größen sind am Foto abgenommen: Köln
     * bis Dortmund (Rang 6–8) bei Zoom 7,7 rund 18 Punkte, Hamm oder
     * Gelsenkirchen (11–12) knapp 13.
     *
     * Die Marke ist ein ZEICHEN der Schrift („○", fett für Googles kräftigen
     * Ring) und keine eigene Ebene: So steht sie genau dann, wenn auch der Name
     * steht. Als eigene Kreis-Ebene stünde sie auch dort, wo der Name einem
     * anderen weichen musste — lauter Punkte ohne Namen. Der weiße Schrift-Rand
     * füllt den Ring innen aus; das ergibt Googles weißen Kreis mit dunklem Rand.
     *
     * Dahinter ein SCHMALES Leerzeichen (U+2009): Es ist so breit wie Googles
     * Abstand, und MapLibre bricht an ihm nicht um — am normalen Leerzeichen
     * stünde bei langen Namen die Marke allein in der ersten Zeile. Der Versatz
     * nach links setzt die Mitte des Rings auf den Ort: Das Zeichen sitzt 0,31
     * Geviert hinter dem Zeilenanfang (Abstand 2 + halbe Breite 5,5 bei 24 px).
     *
     * Ab Zoom 11 füllt die Stadt den Schirm — dann ohne Marke, mittig.
     */
    {
      id: "place-city",
      type: "symbol",
      source: "openmaptiles",
      "source-layer": "place",
      filter: ["in", ["get", "class"], ["literal", ["city", "town"]]],
      layout: {
        "text-field": [
          "step",
          ["zoom"],
          [
            "format",
            "○",
            { "text-color": d.placeDot, "text-font": ["literal", ["Noto Sans Bold"]] },
            "\u2009",
            {},
            name,
            {},
          ],
          11,
          name,
        ],
        "text-font": ["Noto Sans Regular"],
        "text-size": [
          "interpolate",
          ["linear"],
          ["zoom"],
          4,
          ["step", ["coalesce", ["get", "rank"], 99], 12, 9, 11, 11, 10],
          6,
          ["step", ["coalesce", ["get", "rank"], 99], 15, 9, 13, 11, 11.5],
          8,
          ["step", ["coalesce", ["get", "rank"], 99], 18.5, 9, 15.5, 11, 13],
          12,
          ["step", ["coalesce", ["get", "rank"], 99], 20, 9, 17.5, 11, 15],
        ],
        "text-anchor": ["step", ["zoom"], "left", 11, "center"],
        "text-offset": ["step", ["zoom"], ["literal", [-0.31, 0]], 11, ["literal", [0, 0]]],
        // Die großen Städte zuerst — sie gewinnen, wenn zwei Namen sich stoßen.
        "symbol-sort-key": ["coalesce", ["get", "rank"], 99],
      },
      paint: {
        "text-color": p.cityText,
        "text-halo-color": p.halo,
        "text-halo-width": 1.6,
      },
    },
    /**
     * Ländernamen wie bei Google: normale Schreibung, fett und grauer als die
     * Städte — derselbe Platz in der Reihenfolge und dieselben Zoomgrenzen wie
     * im Grundstil (`place-country` dort), nur Googles Schrift statt der
     * gesperrten Großbuchstaben der dunklen Karte.
     */
    {
      id: "place-country",
      type: "symbol",
      source: "openmaptiles",
      "source-layer": "place",
      minzoom: 1,
      maxzoom: 7,
      filter: COUNTRY_FILTER,
      layout: {
        "text-field": name,
        "text-font": ["Noto Sans Bold"],
        "text-size": [
          "interpolate",
          ["linear"],
          ["zoom"],
          1,
          ["step", ["coalesce", ["get", "rank"], 9], 10.5, 2, 9.5],
          3,
          ["step", ["coalesce", ["get", "rank"], 9], 13, 2, 12, 3, 11],
          6,
          ["step", ["coalesce", ["get", "rank"], 9], 17, 2, 15, 3, 13.5],
        ],
        ...COUNTRY_PLACEMENT,
      },
      paint: {
        "text-color": p.countryText,
        "text-halo-color": p.halo,
        "text-halo-width": 1.4,
      },
    },
    keep("place-suburb"),
    keep("water-name"),
    keep("road-name"),
  ];
  return layers.map(hazeProof);
}

/**
 * Den Stil zu einer Palette bauen. Die Ebenen sind in allen Stilen dieselben —
 * siehe `MapPalette` —, außer bei einer Palette mit `detail` (die helle Karte):
 * Sie bekommt ihre eigene Folge aus `detailLayers`.
 *
 * `basemap: "raster"` legt das Luftbild als Grund darunter und behält von den
 * Ebenen nur die Beschriftungen (siehe `SATELLITE_LAYERS`). Auch das ist
 * bewusst EIN Ebenen-Block und keine zweite Datei: Wer eine Zoomstufe an den
 * Ortsnamen ändert, soll sie nicht an zwei Stellen ändern müssen.
 */
export function buildMapStyle(
  p: MapPalette,
  locale: Locale,
  basemap: "vector" | "raster" = "vector",
): StyleSpecification {
  const name = nameExpression(locale);
  const style = {
  version: 8,
  /**
   * DIE ERDE ALS KUGEL. Weit draußen zeichnet MapLibre die Karte selbst als
   * Globus und geht beim Hineinzoomen nahtlos in die flache Karte über (wie GL
   * JS: Kugel bis Zoom 10, ab 12 flach) — EIN Renderer, keine zweite Ebene.
   * Das kann bis zur Veröffentlichung nur die selbst gebaute Bibliothek aus
   * maplibre-native#4533 (siehe `plugins/withMaplibreGlobe.js`); eine Version
   * ohne Globus übergeht die Angabe.
   */
  projection: { type: "globe" },
  /**
   * Atmosphäre, Weltraum und Tag-und-Nacht-Schatten um die Kugel — nur weit
   * draußen, ab Zoom 7 ist sie weg (die Erde füllt dann ohnehin den Schirm).
   * Gezeichnet in EINEM Vollbild-Durchgang der selbst gebauten Bibliothek
   * (maplibre-native#4534 plus Sterne, Milchstraße und Schatten, siehe
   * `vendor/maplibre-native/README.md`).
   */
  sky: {
    "atmosphere-blend": ["interpolate", ["linear"], ["zoom"], 0, 1, HAZE_FULL_UNTIL, 1, HAZE_GONE_AT, 0],
  },
  name: "Binch Dark",
  sources: {
    /**
     * Nur für die Pflicht-Nennung der Milchstraße hinter dem Globus: ein Foto
     * von ESO/S. Brunier (CC BY 4.0), eingebaut in die selbst gebaute
     * MapLibre-Bibliothek (`vendor/maplibre-native/README.md`). Die ⓘ-Schaltfläche
     * sammelt ihre Nennungen aus den Quellen ein — der Himmel ist keine, also
     * steht sie hier. Keine Ebene nutzt diese Quelle, sie lädt nie eine Kachel.
     */
    "sky-credit": {
      type: "raster",
      tiles: ["https://www.eso.org/public/images/eso0932a/"],
      attribution:
        'Milchstraße: <a href="https://www.eso.org/public/images/eso0932a/">ESO/S. Brunier</a> ' +
        '(<a href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a>, bearbeitet)',
    },
    openmaptiles: {
      type: "vector",
      url: "https://tiles.openfreemap.org/planet",
      /**
       * Die oberste Kachelstufe AUSDRÜCKLICH — auch wenn das TileJSON sie nennt.
       *
       * Der Planet endet bei Stufe 14; darüber streckt MapLibre die Kachel von
       * 14, statt neue anzufordern. Diese Zahl kommt normalerweise aus dem
       * TileJSON, das die Bibliothek vorher lädt. Fällt sie dort einmal aus,
       * gilt die Vorgabe der Stil-Spezifikation (22) — und dann fordert die
       * Karte beim Hineinzoomen Kacheln an, die es nicht gibt.
       *
       * Und das wäre besonders unangenehm, weil die Gegenstelle dafür KEINEN
       * Fehler liefert: Nachgemessen antwortet sie auf z15, z16 und z18 mit
       * „200 OK" und null Byte. MapLibre läse das als LEERE Kachel — also
       * „hier ist nichts" statt „hier gibt es nichts Feineres, nimm die
       * gröbere". Die Karte wäre beim Hineinzoomen leer, nicht gestreckt.
       *
       * Hier steht derselbe Wert, den das TileJSON nennt: Heute ändert sich
       * dadurch nichts, es kann nur nichts mehr wegfallen.
       */
      maxzoom: 14,
    },
  },
  // KEIN `sprite`.
  //
  // Er war deklariert, aber keine einzige der Ebenen unten benutzt ein
  // `icon-image` — nur Flächen, Linien und vier reine Text-Ebenen. Die Marker
  // kommen aus der Laufzeit-Registry in MapSurface, nicht von hier. Der Sprite
  // kostete damit 147 KB und zwei Roundtrips VOR der ersten Kachel, für nichts.
  glyphs: "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf",
  layers: [
    { id: "background", type: "background", paint: { "background-color": p.bg } },

    // Wasser
    {
      id: "water",
      type: "fill",
      source: "openmaptiles",
      "source-layer": "water",
      paint: { "fill-color": p.water },
    },

    // Wälder / Parks
    {
      id: "landcover-wood",
      type: "fill",
      source: "openmaptiles",
      "source-layer": "landcover",
      filter: ["==", ["get", "class"], "wood"],
      paint: { "fill-color": p.wood, "fill-opacity": 0.9 },
    },
    {
      id: "park",
      type: "fill",
      source: "openmaptiles",
      "source-layer": "park",
      paint: { "fill-color": p.park, "fill-opacity": 0.85 },
    },

    // Stadt-Hintergrund (residential, commercial leicht heller als bg)
    {
      id: "landuse-residential",
      type: "fill",
      source: "openmaptiles",
      "source-layer": "landuse",
      filter: ["==", ["get", "class"], "residential"],
      paint: { "fill-color": p.residential },
    },

    // Gebäude (nur in höheren Zooms)
    {
      id: "building",
      type: "fill",
      source: "openmaptiles",
      "source-layer": "building",
      minzoom: 14,
      paint: { "fill-color": p.building, "fill-opacity": 0.85 },
    },

    // Schiene
    {
      id: "rail",
      type: "line",
      source: "openmaptiles",
      "source-layer": "transportation",
      filter: ["all", ["==", ["get", "class"], "rail"]],
      paint: {
        "line-color": p.rail,
        "line-width": 1.2,
        "line-dasharray": [3, 2],
      },
    },

    // Straßen — Hierarchie minor → service → secondary → primary → trunk/motorway
    {
      id: "road-minor",
      type: "line",
      source: "openmaptiles",
      "source-layer": "transportation",
      filter: ["in", ["get", "class"], ["literal", ["minor", "service", "track", "path"]]],
      paint: {
        "line-color": p.roadMinor,
        "line-width": ["interpolate", ["linear"], ["zoom"], 12, 0.5, 18, 3],
      },
    },
    {
      id: "road-secondary",
      type: "line",
      source: "openmaptiles",
      "source-layer": "transportation",
      filter: ["in", ["get", "class"], ["literal", ["tertiary", "secondary"]]],
      paint: {
        "line-color": p.roadSecondary,
        "line-width": ["interpolate", ["linear"], ["zoom"], 10, 0.5, 18, 5],
      },
    },
    {
      id: "road-primary",
      type: "line",
      source: "openmaptiles",
      "source-layer": "transportation",
      filter: ["==", ["get", "class"], "primary"],
      paint: {
        "line-color": p.roadPrimary,
        "line-width": ["interpolate", ["linear"], ["zoom"], 8, 0.6, 18, 7],
      },
    },
    {
      id: "road-trunk",
      type: "line",
      source: "openmaptiles",
      "source-layer": "transportation",
      filter: ["in", ["get", "class"], ["literal", ["trunk", "motorway"]]],
      paint: {
        "line-color": p.roadTrunk,
        "line-width": ["interpolate", ["linear"], ["zoom"], 6, 0.6, 18, 8],
      },
    },

    // Verwaltungsgrenzen
    {
      id: "boundary-country",
      type: "line",
      source: "openmaptiles",
      "source-layer": "boundary",
      filter: ["==", ["get", "admin_level"], 2],
      paint: { "line-color": p.boundary, "line-width": 0.8, "line-opacity": 0.6 },
    },

    // Labels — Ortsnamen, Wasser
    {
      id: "place-city",
      type: "symbol",
      source: "openmaptiles",
      "source-layer": "place",
      filter: ["in", ["get", "class"], ["literal", ["city", "town"]]],
      layout: {
        "text-field": name,
        "text-font": ["Noto Sans Regular"],
        "text-size": ["interpolate", ["linear"], ["zoom"], 6, 11, 12, 16],
        "text-letter-spacing": 0.05,
        "text-transform": "uppercase",
      },
      paint: {
        "text-color": p.cityText,
        "text-halo-color": p.halo,
        "text-halo-width": 1.2,
      },
    },
    /**
     * Ländernamen — wie bei Google auf der Kugel, bis ein Land den Schirm füllt
     * (ab Zoom 7 übernehmen die Städte). Gesperrt und gedämpfter als die
     * Städte, damit beide Ebenen sich auseinanderhalten lassen; die großen
     * Länder (`rank` 1) etwas größer, welche wann erscheinen und wohin sie
     * ausweichen dürfen, steht an `COUNTRY_FILTER`. NACH den Städten im Stil:
     * Die spätere Ebene wird zuerst gesetzt und gewinnt, wenn sich zwei Namen
     * stoßen.
     *
     * Im Luftbild gibt es sie NICHT (`SATELLITE_LAYERS`) — dort bleibt der
     * Globus bewusst ohne Schrift.
     */
    {
      id: "place-country",
      type: "symbol",
      source: "openmaptiles",
      "source-layer": "place",
      minzoom: 1,
      maxzoom: 7,
      filter: COUNTRY_FILTER,
      layout: {
        "text-field": name,
        "text-font": ["Noto Sans Regular"],
        "text-size": [
          "interpolate",
          ["linear"],
          ["zoom"],
          1,
          ["step", ["coalesce", ["get", "rank"], 9], 10, 2, 9],
          3,
          ["step", ["coalesce", ["get", "rank"], 9], 12, 2, 11, 3, 10],
          6,
          ["step", ["coalesce", ["get", "rank"], 9], 15, 2, 13.5, 3, 12],
        ],
        "text-letter-spacing": 0.15,
        "text-transform": "uppercase",
        ...COUNTRY_PLACEMENT,
      },
      paint: {
        "text-color": p.countryText,
        "text-halo-color": p.halo,
        "text-halo-width": 1.2,
      },
    },
    {
      id: "place-suburb",
      type: "symbol",
      source: "openmaptiles",
      "source-layer": "place",
      filter: ["in", ["get", "class"], ["literal", ["suburb", "neighbourhood"]]],
      minzoom: 12,
      layout: {
        "text-field": name,
        "text-font": ["Noto Sans Regular"],
        "text-size": 11,
      },
      paint: {
        "text-color": p.suburbText,
        "text-halo-color": p.halo,
        "text-halo-width": 1,
      },
    },
    {
      id: "water-name",
      type: "symbol",
      source: "openmaptiles",
      "source-layer": "water_name",
      layout: {
        "text-field": name,
        "text-font": ["Noto Sans Regular"],
        "text-size": 11,
      },
      paint: {
        "text-color": p.waterText,
        "text-halo-color": p.halo,
        "text-halo-width": 1,
      },
    },
    // Straßennamen — erst ab Zoom 15 sichtbar (statt 14) damit der Style bei
    // normaler Stadtansicht ruhig bleibt. Nur Names schreiben, keine Refs.
    {
      id: "road-name",
      type: "symbol",
      source: "openmaptiles",
      "source-layer": "transportation_name",
      minzoom: 15,
      layout: {
        "text-field": ["get", "name"],
        "text-font": ["Noto Sans Regular"],
        "text-size": 10,
        "symbol-placement": "line",
      },
      paint: {
        "text-color": p.roadText,
        "text-halo-color": p.halo,
        "text-halo-width": 1,
      },
    },
    ],
  } as StyleSpecification;

  if (basemap !== "raster") {
    // Nur die helle Karte trägt `detail` — sie bekommt ihre eigene Ebenenfolge.
    return p.detail
      ? ({ ...style, layers: detailLayers(p, p.detail, style.layers, name) } as StyleSpecification)
      : style;
  }

  return {
    ...style,
    sources: {
      ...style.sources,
      ...Object.fromEntries(
        AERIAL_REGIONS.map((r) => [
          r.id,
          {
            type: "raster" as const,
            tiles: [
              `${API_BASE_URL}/api/tiles/aerial/${r.region}/{z}/{x}/{y}?v=${AERIAL_STAND}`,
            ],
            tileSize: 256,
            minzoom: r.minzoom,
            maxzoom: r.maxzoom,
            bounds: r.bounds,
            attribution: r.attribution,
          },
        ]),
      ),
      satellite: {
        type: "raster",
        tiles: [SATELLITE_TILES],
        // 256, gemessen an den ausgelieferten Kacheln.
        tileSize: 256,
        maxzoom: SATELLITE_MAXZOOM,
        attribution: SATELLITE_ATTRIBUTION,
      },
      bluemarble: {
        type: "raster",
        tiles: [BLUE_MARBLE_TILES],
        tileSize: 256,
        maxzoom: 8,
        attribution: BLUE_MARBLE_ATTRIBUTION,
      },
      /**
       * Dieselben Kacheln, als 128 angemeldet: MapLibre holt so eine Stufe
       * feiner. GANZ weit draußen zeigt die Kugel ganze Kontinente aus nur
       * wenigen hundert Bildpunkten, auf dichten Handy-Schirmen drei- bis
       * sechsfach vergrößert — die Erde wirkte grob und unscharf. Nur dort: Auf
       * allen Stufen kostete die feinere Stufe viermal so viele Kacheln, und das
       * Wischen über den Globus wurde spürbar zäher.
       */
      "bluemarble-far": {
        type: "raster",
        tiles: [BLUE_MARBLE_TILES],
        tileSize: 128,
        maxzoom: 8,
        attribution: BLUE_MARBLE_ATTRIBUTION,
      },
    },
    /**
     * Das Bild kommt DIREKT hinter den Grund und vor alles andere — sonst
     * läge es über den Namen.
     */
    /**
     * Über den Grund NACH ID, nicht nach Position.
     *
     * Hier stand `style.layers[0]` mit der stillen Annahme, dass der Grund
     * immer zuerst kommt. Das stimmt heute — und wäre beim nächsten Umsortieren
     * der Ebenen falsch, ohne dass irgendetwas sich beschwert: Das Luftbild
     * läge dann über den Beschriftungen und deckte sie zu.
     */
    layers: [
      ...style.layers.filter((l) => l.id === "background"),
      // Das Luftbild erst, wo Blue Marble ausblendet — darunter würde es nur
      // geladen, um zugedeckt zu werden.
      { id: "satellite", type: "raster", source: "satellite", minzoom: 4, paint: AERIAL_PAINT },
      {
        id: "bluemarble",
        type: "raster",
        source: "bluemarble",
        minzoom: 1,
        maxzoom: 6.5,
        paint: { "raster-opacity": ["interpolate", ["linear"], ["zoom"], 4.5, 1, 6.5, 0] },
      },
      // Darüber die feinere Fassung für ganz weit draußen, bis Zoom 1,6 ausgeblendet.
      {
        id: "bluemarble-far",
        type: "raster",
        source: "bluemarble-far",
        maxzoom: 1.6,
        paint: { "raster-opacity": ["interpolate", ["linear"], ["zoom"], 1, 1, 1.6, 0] },
      },
      /**
       * Die Gebiets-Luftbilder liegen ÜBER dem weltweiten Bild und UNTER den
       * Beschriftungen. In dieser Reihenfolge deckt das schärfere Bild das
       * gröbere ab, wo es vorhanden ist, und die Namen bleiben oben lesbar.
       */
      ...AERIAL_LAYERS.map((l) => ({
        id: l.id,
        type: "raster" as const,
        source: l.source,
        paint: AERIAL_PAINT,
        ...(l.minzoom !== undefined ? { minzoom: l.minzoom } : {}),
        ...(l.maxzoom !== undefined ? { maxzoom: l.maxzoom } : {}),
      })),
      ...style.layers
        .filter((l) => l.id !== "background" && SATELLITE_LAYERS.has(l.id))
        .map((l) => (SATELLITE_GLOBE_CLEAN.has(l.id) ? { ...l, minzoom: Math.max(l.minzoom ?? 0, 3) } : l)),
    ],
  } as StyleSpecification;
}

/**
 * Die fertigen Stile — je Kartentyp UND Sprache genau einmal gebaut.
 *
 * Die Kennung muss stabil bleiben: Eine Karte, die bei jedem Durchgang einen
 * neuen Stil bekommt, lädt ihn neu (siehe `mapStyle` an der Kartenfläche).
 * Früher waren es deshalb drei Konstanten; seit die Namen der App-Sprache
 * folgen, sind es bis zu zwölf, und gebaut wird nur, was jemand wirklich zeigt.
 * Derselbe Typ in derselben Sprache ist immer dasselbe Objekt.
 *
 * Ein Sprachwechsel ist für die Karte ein Stilwechsel — die Kartenfläche wird
 * dafür neu aufgebaut wie beim Wechsel des Kartentyps (`key` in
 * `surroundings.tsx` und `route-map.tsx`), nie am offenen Stil umgebaut.
 */
const builtStyles = new Map<string, StyleSpecification>();

export function mapStyleFor(style: ResolvedMapStyle, locale: Locale): StyleSpecification {
  const key = `${style}:${locale}`;
  let built = builtStyles.get(key);
  if (!built) {
    built =
      style === "satellite"
        ? buildMapStyle(SATELLITE_PALETTE, locale, "raster")
        : buildMapStyle(style === "light" ? LIGHT_PALETTE : DARK_PALETTE, locale);
    builtStyles.set(key, built);
  }
  return built;
}
