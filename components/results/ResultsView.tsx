import { useCallback, useEffect, useMemo, useRef, useState, memo, type ReactNode } from "react";
import { localTimeHint } from "@/lib/time-format";
import {
  AppState,
  Platform,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { useAppBg, usePalette } from "@/lib/theme/appBg";
import { useQueryClient } from "@tanstack/react-query";
import {
  View,
  Text,
  Pressable,
  ActivityIndicator,
  RefreshControl,
  StyleSheet,
  useWindowDimensions,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { usePathname, useRouter } from "expo-router";

import { RotateCcw, WifiOff, Compass } from "lucide-react-native";
import { useQuery } from "@tanstack/react-query";
import Animated, {
  FadeIn,
  FadeOut,
  LinearTransition,
  useAnimatedStyle,
  withTiming,
  runOnJS,
  useAnimatedReaction,
} from "react-native-reanimated";
import { TravelMode, SearchResult, SearchResponse } from "@/types/search";
import { searchByMode } from "@/lib/api/client";
import { createSearchAlert } from "@/lib/notifications/createSearchAlert";
import { FilterChips } from "@/components/ui/FilterChips";
import { ResultCard } from "@/components/results/ResultCard";
import { SearchSummaryBar } from "@/components/results/SearchSummaryBar";
import { SearchProgressBar } from "@/components/results/SearchProgressBar";
import { SearchEditPanel } from "@/components/results/SearchEditPanel";
import { PriceAlertSheet } from "@/components/results/PriceAlertSheet";
import type { SearchHeroInitial, TripType } from "@/components/search/SearchHero";
import { RandomSearchLoader } from "@/components/results/search-loaders/RandomSearchLoader";
import { Bo } from "@/components/assistant/Bo";
import { useT } from "@/lib/i18n/useT";
import { overlayCover, resultsPush, pushProgress, UNDERLAY_TRAVEL_FRAC, PUSH_SPRING, POP_SPRING, SCREEN_CORNER_RADIUS, startResultsPush, msSinceResultsPush, pushGeneration } from "@/lib/nav/overlayCover";
import { useSearchStore } from "@/stores/searchStore";
import { haptic } from "@/lib/haptics";
import { RippleTouch } from "@/components/ui/RippleTouch";
import { GradientFill } from "@/components/ui/GradientFill";
import { SegmentedToggle } from "@/components/ui/SegmentedToggle";
import { SlidingPanels } from "@/components/ui/SlidingPanels";
import { tripSignature } from "@/lib/results/signature";
import { useAccent } from "@/lib/theme/accent";
import { MOTION, revealEntering } from "@/lib/motion";
import { endSearchHandoff, isSearchHandoff } from "@/lib/nav/searchHandoff";
import { GUTTER, SPACE } from "@/lib/theme/spacing";
import { prepareLayer, releaseLayer, subscribeLayer } from "@/lib/nav/transitionLayer";
import { scaledStyles } from "@/lib/ui/compact";
import { isTransitionBusy } from "@/lib/nav/transitionBusy";

type SortKey = "cheapest" | "fastest" | "direct";

/**
 * Die Sortier-Reiter als MODUL-Konstante.
 *
 * Sie standen im Rumpf des Bildschirms und entstanden damit bei jedem
 * Durchgang neu — und dieser Bildschirm rendert mehrfach pro Übergang. Seit die
 * Reiter im Kopf der LISTE sitzen, ginge eine frische Kennung zusätzlich durch
 * die Memo-Schranke des Kopfes hindurch. Ihr Inhalt hängt von nichts ab.
 */
const SORT_TABS: { key: SortKey; labelKey: string }[] = [
  { key: "cheapest", labelKey: "results.sort.cheapest" },
  { key: "fastest", labelKey: "results.sort.fastest" },
  { key: "direct", labelKey: "results.sort.direct" },
];

const C = {
  bg: "#0D0D0D",
  card: "#171719",
  border: "#212123",
  surface3: "#212123",
  text: "#F4F4F5",
  gray200: "#C8C8CC",
  sub: "#8E8E93",
  subDim: "#56565C",
  lime: "#7FEA4D",
  black: "#000000",
};

// Max. gleichzeitig gerenderte Treffer. Die Suche liefert oft 100+ Flüge —
// alle zu rendern laggt den Client. Wir zeigen PAGE_SIZE, halten den Rest im
// Speicher und enthüllen pro „Mehr"-Tap die nächsten PAGE_SIZE (instant, KEIN
// Re-Request). Erst wenn alle geladenen Treffer sichtbar sind, wird frisch
// nachgeladen.
const PAGE_SIZE = 20;

/**
 * Preislose Treffer (Zug ohne bahn.de-Anreicherung → price 0) hinten einsortieren.
 *
 * WICHTIG: kein `Infinity`. Zwei preislose Treffer ergäben `Infinity - Infinity`
 * = NaN, und ein Comparator, der NaN liefert, ist undefiniertes Verhalten — die
 * Reihenfolge kann beliebig verwürfelt werden. Genau das träfe die Zug-Liste, in
 * der aktuell ALLE Preise 0 sind: das serverseitige Ranking nach
 * Verbindungsqualität wäre dahin. Mit einem endlichen Wert vergleichen sie
 * gleich (0) → der stabile Array.sort erhält die Server-Reihenfolge.
 */
const priceForSort = (p: number) => (p > 0 ? p : Number.MAX_SAFE_INTEGER);

/**
 * Wann die Vorbelegung der Such-Slide frühestens veröffentlicht wird.
 *
 * Nicht so früh wie möglich, und das ist der ganze Witz dieser Zahl. Die
 * Einfahrt meldet sich für 430ms als „fährt" an (`PUSH_SPRING.duration`) —
 * danach ist aber noch nichts ruhig: `afterSlide` hängt drei Schritte in je ein
 * eigenes Bild, und der letzte davon ist ein NAVIGATIONS-Commit samt nativem
 * Container von react-native-screens. Wer 120ms nach dem Ende der Bewegung
 * veröffentlicht, legt den Neuaufbau des Formularbaums also ausgerechnet
 * daneben.
 *
 * 600ms liegen hinter dieser Kette und deutlich vor dem Vorbau des Formulars
 * (der wartet nach dem Slide-Ende nochmal 700ms). Dazwischen ist die einzige
 * wirklich ruhige Lücke.
 *
 * Verloren geht durch das Warten nichts: Gelesen wird die Vorbelegung erst,
 * wenn jemand die Kopfzeile antippt, und dahin ist es von hier aus weit.
 */
const PREFILL_SETTLE_MS = 600;

/** Nachfassen, falls in diesem Moment doch etwas fährt (Rückfahrt, Blatt). */
const PREFILL_RETRY_MS = 200;

/**
 * Schließt den Such-Screen, sobald die Ergebnis-Liste ihn wirklich verdeckt.
 * Tut nichts, wenn gar keine Übergabe lief (z.B. Aufruf aus dem Verlauf).
 */
/**
 * Als MODUL-Funktion, nicht als frische Schließung im JSX.
 *
 * Der Handler sitzt auf einem animierten Knoten. Eine neue Funktions-Kennung
 * pro Durchgang ist dort dasselbe wie ein neues Stil-Objekt: ein Fabric-Commit
 * auf genau der Ansicht, die Reanimated Bild für Bild beschreibt. `releaseLayer`
 * braucht nur einen festen Schlüssel — die Funktion kann also einmal existieren.
 */
function releaseResultsLayer(): void {
  releaseLayer("results");
}

/**
 * Das Gegenstück — die Ebene der Liste ANFORDERN, beim Aufsetzen des Fingers
 * auf den Zurück-Pfeil.
 *
 * Ebenfalls als Modul-Funktion und aus demselben Grund wie oben: Der Handler
 * sitzt auf der Kopfzeile, die dauerhaft im bewegten Baum liegt. Eine neue
 * Funktions-Kennung pro Durchgang wäre dort ein Fabric-Commit auf genau der
 * Ansicht, die Reanimated Bild für Bild beschreibt.
 */
function prepareResultsLayer(): void {
  prepareLayer("results");
}

function finishSearchHandoff(): void {
  if (!isSearchHandoff()) return;
  endSearchHandoff();
  // silent=true: ersatzlos weg. Diese Liste deckt den Bildschirm bereits.
  useSearchStore.getState().closeSearchOverlay(true, true);
}

/** Funktionierend < Anschluss gefährdet < fällt aus. */
function warningRank(r: SearchResult): number {
  return r.warning === "cancelled" ? 2 : r.warning === "connectionAtRisk" ? 1 : 0;
}

function sortResults(list: SearchResult[], sort: SortKey): SearchResult[] {
  const copy = [...list];
  // Gleichstand → frühere Abfahrt zuerst. Ohne Tiebreak entschiede allein die
  // (zufällige) Eingangsreihenfolge.
  const byDeparture = (a: SearchResult, b: SearchResult) =>
    Date.parse(a.departTime) - Date.parse(b.departTime);
  // Von der Bahn als gefährdet gemeldete Verbindungen in JEDEM Tab hinter die
  // funktionierenden (wie der Server sortiert): Ein Anschluss, der laut DB
  // platzt, darf nicht als „schnellste" oben stehen.
  const byWarning = (a: SearchResult, b: SearchResult) => warningRank(a) - warningRank(b);
  const byPrice = (a: SearchResult, b: SearchResult) =>
    byWarning(a, b) || priceForSort(a.price) - priceForSort(b.price);

  switch (sort) {
    case "fastest":
      return copy.sort(
        (a, b) => byWarning(a, b) || a.durationMinutes - b.durationMinutes || byDeparture(a, b),
      );
    // Preis-Sortierungen bewusst OHNE weiteren Tiebreak: bei Gleichstand (alle
    // Zug-Preise 0) bleibt so die Server-Reihenfolge nach Verbindungsqualität
    // erhalten — das ist die sinnvollste Anzeige, solange es keine Preise gibt.
    case "direct":
      return copy.filter((r) => r.stops === 0).sort(byPrice);
    default:
      return copy.sort(byPrice);
  }
}

/**
 * Vorher: `label.split(",")[0]` — alles nach dem ersten Komma weg.
 *
 * Das zerstört genau die Information, um die es geht. Deutsche ÖPNV-Halte heißen
 * „Stadt, Halt": Aus „Werl, Krankenhaus" → „Werl, Rathaus" wurde in der Kopfzeile
 * „Werl → Werl". Die Suche lief korrekt (13 Treffer, 9 Min), aber der User sah
 * eine Suche von einem Ort zu sich selbst und musste annehmen, wir hätten seine
 * Auswahl verworfen.
 *
 * Ein Land steht in unseren Labels nie hinter dem Komma (`country` ist eine
 * eigene Spalte) — es gab also nichts abzuschneiden. Der Header klemmt lange
 * Namen bereits selbst (numberOfLines=2 + adjustsFontSizeToFit).
 */
function stationLabel(label: string): string {
  return label.trim();
}

/**
 * Der Ergebnis-Bildschirm — dauerhaft am Root gemountet statt pro Aufruf gebaut.
 *
 * Bis hierher war das eine Route. Beim Antippen entstand also jedes Mal ein
 * kompletter Bildschirm, und auf Fabric läuft diese Montage auf dem UI-THREAD —
 * demselben, auf dem Reanimated die Bewegung rechnet. Beide konkurrierten um
 * dieselbe Ressource, und daraus folgte alles, was gemeldet wurde: Die Bewegung
 * hängt in den ersten Bildern, und das ERSTE Öffnen fühlt sich anders an als
 * jedes weitere (dort entstehen zusätzlich alle nativen Ansichtstypen zum ersten
 * Mal).
 *
 * Der Beleg kam aus der App selbst: Der Übergang im Saved-Tab läuft mit derselben
 * Kurve, denselben Texturen und demselben Parallax — nur ohne Aufbau, weil sein
 * Blatt dauerhaft gemountet ist. Und genau der fühlt sich richtig an.
 *
 * Die ROUTE bleibt bestehen (app/search/results.tsx, jetzt nur noch eine dünne
 * Hülle): Sie trägt weiterhin Zurück-Geste, Verlinkungen und die Karten-Route,
 * die über den Ergebnissen aufgeht. Hierher wandert nur das Rendern.
 */
/**
 * Meldet, ob gerade eine ANDERE Route oben liegt (typisch: die Karte).
 *
 * Eigene Komponente, weil `usePathname()` bei jedem Routenwechsel neu rendert.
 * Hier ist das ein Knoten, im Ergebnis-Baum wären es hunderte.
 */
function RouteWatch({ onChange }: { onChange: (hidden: boolean) => void }) {
  const pathname = usePathname();
  // NUR die Karten-Route versteckt uns — nicht „irgendeine andere Route".
  //
  // Die Bedingung lautete `pathname !== "/search/results"`. Seit die Route erst
  // NACH der Bewegung nachgezogen wird, steht dort während der ganzen Slide aber
  // noch der Tab — der Baum war damit die komplette Bewegung über auf
  // `opacity: 0`. Genau deshalb war die Slide „nicht mehr vorhanden": Sie lief,
  // war nur unsichtbar.
  const hidden = pathname === "/search/route-map";
  useEffect(() => {
    onChange(hidden);
  }, [hidden, onChange]);
  return null;
}

function clearResultsParams() {
  useSearchStore.getState().setResultsParams(null);
}

/**
 * Ruhestellung: ganz rechts außerhalb. Als Konstante, damit das Worklet im
 * geschlossenen Zustand kein neues Objekt pro Auswertung baut.
 */
const PARKED = { transform: [{ translateX: 100000 }] } as const;
/** Nur für „andere Route liegt oben" — siehe `shellStyle`. */
const HIDDEN_FOR_ROUTE = { opacity: 0 } as const;

/**
 * Die Fläche der Lade-Szene — als MODUL-Konstante.
 *
 * Sie stand als Objektliteral im JSX (`style={{ flex: 1 }}`), und zwar auf genau
 * dem Knoten, der die Ein- und Ausblend-Animation der Szene trägt. Ein frisches
 * Objekt pro Durchgang ist dort auf Fabric ein Commit auf eine Ansicht, die
 * Reanimated gerade Bild für Bild beschreibt — dieselbe Falle, die in dieser
 * Datei am Wurzel-Stil (`shellStyle`) und am Rückgabewert des Slide-Worklets
 * (`PARKED`) ausführlich begründet ist. Der Inhalt hängt von nichts ab, die
 * Konstante kann also einmal existieren.
 */
const LOADER_FILL = { flex: 1 } as const;

/** Schlüssel einer Ergebnis-Zeile — als Modul-Funktion, nicht pro Durchgang neu. */
function resultKey(r: SearchResult): string {
  return `${r.direction ?? "OUTBOUND"}-${r.id}`;
}

export function ResultsView() {
  // Parameter aus dem Store. Die Route schreibt sie hinein (siehe die Hülle in
  // app/search/results.tsx) — hier gelesen, damit dieser Baum nicht an der Route
  // hängt und dauerhaft stehen bleiben kann.
  const storeParams = useSearchStore((st) => st.resultsParams);
  const visible = storeParams != null;
  const isClosingRef = useRef(false);
  useEffect(() => {
    isClosingRef.current = !visible;
  }, [visible]);

  // Textur des Landingscreens halten, solange dieser Bildschirm darüber liegt —
  // er ist dort weder sichtbar noch scrollbar, sie kostet also nichts, und beim
  // Zurückfahren ist sie sofort da.

  const appBg = useAppBg();
  const palette = usePalette();
  const accent = useAccent();
  const router = useRouter();
  // Wie bei den Detail-Überlagerungen: Liegt eine andere Route oben (Karte),
  // verstecken wir uns visuell, statt darüber zu liegen.
  // Über einen Fühler statt direkt: `usePathname()` rendert seine Komponente bei
  // JEDEM Routenwechsel neu — und das ist hier der komplette Ergebnis-Baum, seit
  // er dauerhaft steht. Der Fühler unten rendert nur sich selbst und meldet den
  // Wechsel erst, wenn sich das Ergebnis wirklich ändert. Genau dieselbe
  // Begründung steht beim Detail-Overlay über seinem `memo`.
  const [hiddenForRoute, setHiddenForRoute] = useState(false);
  const t = useT();
  const [sort, setSort] = useState<SortKey>("cheapest");

  // Slide-In identisch zu DetailsOverlay „Buchung wählen": Reanimated-
  // Worklet auf UI-Thread, Animation startet erst NACH dem ersten Paint
  // (rAF), sodass JS-Thread die Zeit hat den schweren Subtree (useQuery,
  // RandomSearchLoader-Worklets, Reset-Effect, etc.) zu mounten BEVOR die
  // Animation läuft. Sonst stutter't der Slide weil JS noch beschäftigt ist
  // während UI-Thread-Worklets rendern wollen.
  const screenWidth = useWindowDimensions().width;
  // resultsPush = eigener Slide-In der Results; overlayCover = Parallax, wenn ein
  // Detail-Overlay DARÜBER reinslidet (verschiebt nur diesen Screen, nicht den
  // ganzen Stack → leichter Baum, kein teures Re-Record des MainActivity-Trees).
  /**
   * Solange diese Ansicht zu ist, liest das Worklet GAR NICHTS.
   *
   * `overlayCover` ist ein geteilter Wert, den auch FREMDE Übergänge treiben —
   * das Ticket-Blatt und die Reise-Karte im Saved-Reiter. Dieser Baum hängt
   * dauerhaft an der Wurzel und wird immer gerendert (versteckt ist er nur durch
   * seine Position). Öffnete man also im Saved-Reiter ein Ticket, lief hier ein
   * vollflächiger Auswerter pro Bild und schrieb einen Transform auf einen Baum,
   * den niemand sieht.
   *
   * Die Abfrage steht IM Aufbau des Worklets, nicht darin: Ist die Ansicht zu,
   * werden beide Werte nicht gelesen — und was nicht gelesen wird, wird auch
   * nicht abonniert. Genau so löst es der Saved-Reiter für seinen Parallax.
   */
  const slideStyle = useAnimatedStyle(
    () =>
      (() => {
        /**
         * Die „liegt hier überhaupt etwas?"-Frage kommt aus GETEILTEN WERTEN,
         * nicht aus React.
         *
         * Als Abhängigkeit (`visible`) kippte sie in genau dem Durchgang, in
         * dem dieser Bildschirm auf- oder zugeht — und eine geänderte
         * Abhängigkeit beantwortet Reanimated mit Abriss und Neuanlage der
         * Zuordnung. Der nächste Lauf baut daraufhin die topologische
         * Reihenfolge über ALLE Zuordnungen der App neu auf, ausgerechnet im
         * ersten Bild der Fahrt.
         *
         * Der Rückgabewert bleibt eine Modul-Konstante, solange nichts zu tun
         * ist — nur so erkennt der flache Vergleich in Reanimated, dass sich
         * nichts geändert hat, und lässt den nativen Schreibvorgang aus.
         */
        const p = pushProgress(resultsPush.value);
        const cover = overlayCover.value;
        if (p === 0 && cover === 0) return PARKED;
        return {
          transform: [
            {
              // Eigene Position aus dem gemeinsamen Fortschritt; dazu der
              // Parallax, falls ein Detail-Blatt über DIESEM Screen liegt.
              translateX:
                (1 - p) * screenWidth + cover * screenWidth * UNDERLAY_TRAVEL_FRAC,
            },
          ],
        };
      })(),
    [screenWidth],
  );

  // contentReady wird unten exakt am Slide-Ende via Animations-Callback
  // gesetzt — damit start die Loader-Animation millisekundengenau dann,
  // wenn der Slide fertig ist. Kein hartcodiertes setTimeout(320) das je
  // nach Mount-Speed zu früh oder zu spät feuern könnte.
  const [contentReady, setContentReady] = useState(false);
  /**
   * HIER STAND `listAlive` — „leben die Karten der Liste gerade?". Der Zustand
   * ist weg, die AUFGABE bleibt und wird weiter unten erledigt. Beides gehört
   * aufgeschrieben, sonst baut jemand den Umweg in einem halben Jahr wieder ein.
   *
   * DIE AUFGABE, und warum sie eine ist:
   *
   * Dieser Bildschirm bleibt bewusst dauerhaft gemountet. Ihn pro Aufruf zu
   * bauen war teuer, und das Ab- und Wiederaufbauen des Detail-Blattes hat
   * nachweislich native Ansichten liegengelassen. An dieser Entscheidung ändert
   * sich nichts — die Hülle, die Kopfzeile und die Liste selbst bleiben stehen.
   *
   * Was nicht stehenbleiben DARF, sind die KARTEN. Ohne Freigabe hielte die
   * Liste nach einer Suche fünf Bildschirmhöhen davon gemountet, für den Rest
   * des App-Laufs: jede mit Logo, Verlauf und einer Reanimated-Zuordnung. Und
   * jede neu gemountete Zuordnung — auch die von Bos Zeilen beim Öffnen —
   * verwirft die sortierte Reihenfolge ALLER Zuordnungen der App, die im
   * nächsten Bild neu aufgebaut wird. Genau deshalb wurde jede spätere Bewegung
   * schlechter, sobald man einmal gesucht hatte. Die DATEN bleiben dabei im
   * Abfrage-Speicher liegen; freigegeben werden nur die Ansichten.
   *
   * WER SIE HEUTE ERLEDIGT: der `!showResults`-Arm der Verzweigung unten.
   * `showResults` wird beim Schließen WÄHREND DES RENDERS auf falsch gesetzt
   * (der Reset-Block am Wechsel von `searchKey` — beim Schließen fallen die
   * Parameter weg, der Schlüssel wechselt also immer). Dieser Arm gewinnt vor
   * dem Listen-Arm und rendert `null`, sobald zusätzlich `searching` falsch ist.
   * Die Karten sind damit im ERSTEN Commit nach dem Schließen abgebaut.
   *
   * WARUM DER ZWEITE ZUSTAND NIE ZUM ZUG KAM — die Erreichbarkeit, in beide
   * Richtungen:
   *
   *  - Sein `null`-Arm lag HINTER `!showResults` und `isError`, war also nur
   *    erreichbar, während Ergebnisse angezeigt werden. Wahr wird `showResults`
   *    aber ausschließlich im Zyklus-Puls der Lade-Szene, und der setzt
   *    `contentReady` voraus — nach dem der Zustand längst auf wahr stand, mit
   *    Sekunden Vorlauf (ein voller Szenen-Zyklus dauert 3,4 bis 5,5s). Der Arm
   *    war damit tot.
   *  - In der Gegenrichtung fiel er nur, wenn `contentReady` falsch war — und da
   *    hatte der Reset-Block oben schon `showResults` gekippt. Sein Wecker (1,5s
   *    plus Wiederversuche) lief also über eine Liste, die es nicht mehr gab.
   *
   * Übrig blieben zwei zusätzliche Durchgänge dieses Bildschirms je Öffnen und
   * Schließen und eine Wecker-Kette. Das ist der Grund für den Ausbau.
   *
   * WAS DAMIT NICHT GELÖST IST, und bewusst offen bleibt: Der Abbau liegt jetzt
   * im Schließ-Commit, also ein bis zwei Bilder hinter der Rückfahrt — genau
   * dort, wo der ausgebaute Zustand ihn wegholen wollte. Die Absicht war
   * richtig, nur hat der Mechanismus sie nie erfüllt. Wer das angeht, braucht
   * KEINEN zweiten Zustand: Es genügt, den Abbau des Inhalts vom Schließen zu
   * entkoppeln, und er muss die drei Fälle treffen (normales Zurück, sofortiges
   * Wiederöffnen DERSELBEN Suche, Wiederöffnen einer ANDEREN — dort müssen die
   * alten Karten weg, sonst hängen sie unter den neuen).
   *
   * Und eine Falle, die der ausgebaute Arm bereits kannte: Die Liste mit leerem
   * Datensatz stehenzulassen ist NICHT die billige Variante. Sie rendert dann
   * ihren Leer-Zustand, und darin steckt ein Bo mit 138 Punkt Kantenlänge — ein
   * schwerer SVG-Baum statt der Karten ist kein Gewinn. Freigeben heißt hier
   * immer: gar nichts rendern.
   */
  /** Textur für die Zeit, in der ein Detail-Blatt über dieser Liste fährt. */


  /**
   * Sobald das Zurück beginnt, nimmt dieser Bildschirm keine Berührungen mehr an.
   *
   * Er fährt danach noch rund 380ms nach rechts hinaus — und war die ganze Zeit
   * berührungsempfindlich. Wer in diesem Fenster auf den Landingscreen darunter
   * tippt (typisch: zurück und sofort die nächste Reise aus dem Verlauf), traf
   * den wegfahrenden Bildschirm, und es passierte schlicht nichts. Dasselbe gilt
   * für die Leiste unten, die er dabei überdeckt.
   *
   * Ein Zustand statt eines Animationswerts, weil `pointerEvents` ein Prop ist:
   * Es wird genau einmal umgeschaltet, im selben Commit, in dem das Zurück
   * ohnehin abgefangen wird.
   */


  /**
   * Alles, was NACH der Slide passiert — bewusst gestaffelt, jeweils ein Bild
   * auseinander.
   *
   * Beides sind schwere Operationen: das Abräumen des Such-Screens (Store-
   * Schreibvorgang, React-Commit, Fabric-Mount) und der Aufbau der Ladeszene mit
   * ihrem SVG-Baum. Lagen sie zusammen im Endbild, stotterten die letzten Bilder
   * sichtbar. Und selbst der Abbau allein lag noch im Bild, in dem die Feder
   * ausläuft — der Callback feuert zwar am Ende, die letzte Komposition kann aber
   * noch offen sein. Ein Bild Abstand schafft hier Ruhe.
   */
  const afterRafRef = useRef<number[]>([]);
  useEffect(
    () => () => {
      for (const id of afterRafRef.current) cancelAnimationFrame(id);
    },
    [],
  );
  const afterSlide = useCallback(() => {
    /**
     * Die Kennungen der VORIGEN Öffnung abräumen, bevor neue dazukommen.
     *
     * Die Liste wuchs bei jedem Öffnen um drei Einträge und wurde nur beim Abbau
     * geleert — den dieser Baum nie erlebt, er hängt dauerhaft an der Wurzel.
     * Nach fünfzig Suchen lägen darin hundertfünfzig längst abgelaufene
     * Kennungen. Sie kosten pro Bild nichts, aber sie sind ein Leck, und der
     * Aufräum-Pfad beim Abbau lief über eine Liste, die zu 98% aus Müll bestand.
     *
     * Abbrechen ist dabei kein Selbstzweck: Wird eine neue Öffnung gestartet,
     * während die drei Schritte der vorigen noch anstehen, gehören die alten
     * ohnehin nicht mehr ausgeführt.
     */
    for (const id of afterRafRef.current) cancelAnimationFrame(id);
    afterRafRef.current.length = 0;
    // Jeder Schritt bricht ab, wenn inzwischen zurückgegangen wird — sonst
    // nimmt Schritt 2 der Rückfahrt die Textur wieder weg, die sie sich gerade
    // besorgt hat, und Schritt 3 baut die Ladeszene auf einem Bildschirm auf,
    // der schon hinausfährt.
    const step = (fn: () => void) => {
      const id = requestAnimationFrame(() => {
        if (isClosingRef.current) return;
        fn();
      });
      afterRafRef.current.push(id);
    };
    // INHALT ZUERST, Aufräumen danach.
    //
    // Die Reihenfolge war umgekehrt: erst den Such-Screen abräumen, dann die
    // Route nachziehen, und im dritten Bild erst die Ladeszene. Beide ersten
    // Schritte sind aber unsichtbar — sie betreffen einen Bildschirm, der schon
    // vollständig verdeckt ist, und eine Route, die niemand sieht. Der Nutzer
    // schaut in dieser Zeit auf eine leere Ergebnisfläche und wartet. Genau das
    // ist das „beim Öffnen fühlt es sich träge an": Nicht die Bewegung war zu
    // langsam, sondern das, was der Nutzer wollte, stand als Letztes in der
    // Schlange.
    //
    // Abhängigkeiten gibt es in keine Richtung: Der Ergebnis-Bildschirm liest
    // seine Werte aus dem Speicher, nicht aus der Route, und der Such-Screen
    // liegt darunter. Umgedreht steht der Inhalt jetzt zwei Bilder früher.
    step(() => {
      // 1. Die Ladeszene mit ihrem SVG-Baum — darauf wartet der Nutzer.
      setContentReady(true);
      step(() => {
        // 2. Den Such-Screen abräumen (Store-Schreibvorgang + Abbau seines Baums).
        finishSearchHandoff();
        step(() => {
          // 3. Route nachziehen.
          //
          // Geöffnet wurde über den Store, also ohne Router. Die Route braucht es
          // trotzdem: für die Zurück-Geste, für Verlinkungen und für die
          // Karten-Route, die über den Ergebnissen aufgeht. Sie kostet einen
          // Navigations-Commit plus einen nativen Container von
          // react-native-screens.
          //
          // Je EIN Bild Abstand zwischen den drei Schritten. Vorher waren zwei
          // davon im selben Bild registriert — dann lagen Navigations-Commit,
          // nativer Container UND der Aufbau des SVG-Baums zusammen.
          const pending = useSearchStore.getState().pendingResultsRoute;
          if (pending) {
            useSearchStore.getState().setPendingResultsRoute(null);
            router.push({ pathname: "/search/results", params: pending });
          }
        });
      });
    });
  }, []);

  /**
   * Ende der Bewegung abpassen.
   */
  useAnimatedReaction(
    () => resultsPush.value,
    (v, prev) => {
      // Mit DEMSELBEN Maß rechnen wie die Optik: `pushProgress` klemmt bei 98%,
      // ab da steht sichtbar alles still. Die alte Schwelle von 99,9% lag bei
      // einer kritisch gedämpften Feder rund 1,7-mal so weit hinten — gut 300ms
      // nach dem Stillstand. In diesem Loch passierte nichts: Der Such-Screen
      // blieb gemountet, der Inhalt kam nicht, und die Suchanfrage startete
      // (weil an `contentReady` gebunden) genauso viel später.
      if (pushProgress(v) >= 1 && pushProgress(prev ?? 0) < 1) runOnJS(afterSlide)();
    },
  );
  /**
   * Die Bewegung startet HIER — nach dem Aufbau, ein Bild später.
   *
   * Sie lief zwischenzeitlich schon im Tipp-Handler los, um die Verzögerung
   * loszuwerden. Der Preis dafür war unsichtbar, aber teuer: Auf Fabric laufen
   * Reacts Montage-Operationen auf dem UI-THREAD — demselben, auf dem die Feder
   * gerechnet wird. Startet die Bewegung beim Tippen, fällt der komplette Aufbau
   * des Zielbildschirms in ihre ersten Bilder. Genau dort, wo die Unterlage
   * anläuft und ein verlorenes Bild am meisten auffällt.
   *
   * Beides gleichzeitig geht nicht: Entweder wartet die Bewegung auf den Aufbau,
   * oder sie läuft dagegen an. Die Wartezeit ist inzwischen klein — der Baum wird
   * beim App-Start vorgeladen, der Kopfbereich ist memoisiert, der Verlaufs-
   * Eintrag ist raus. Bleiben rund 40-60ms; die bemerkt man als Reaktionszeit
   * kaum, ein Ruckler in der Bewegung fällt dagegen sofort auf.
   */
  /**
   * Die Bewegung startet NUR, wenn wirklich eine Suche anliegt.
   *
   * Seit dieser Baum am Root hängt, wird er beim App-Start gemountet — nicht
   * mehr beim Navigieren. Ohne diese Prüfung lief der Auslöser also sofort nach
   * dem Start los: Der Parallax schob den Landingscreen dauerhaft um 30% zur
   * Seite, und Berührungen landeten entsprechend daneben.
   */
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const startedRef = useRef(false);
  const beginSlide = useCallback(() => {
    if (!visibleRef.current || startedRef.current) return;
    startedRef.current = true;
    /**
     * Nur noch NOTFALLS von hier.
     *
     * Die Aufrufer starten die Bewegung inzwischen selbst, im Berührungs-Frame
     * (`startResultsPush` in der Verlaufskarte und im Such-Screen). Von hier aus
     * wäre sie zu spät: Diese Stelle läuft erst nach dem Commit, der diesen
     * ganzen Baum sichtbar macht — und genau das war die Verzögerung zwischen
     * Finger und erster Regung.
     *
     * Ein zweiter Start würde den Wert auf 0 zurücksetzen: Die schon halb
     * hereingefahrene Liste spränge hart nach rechts aus dem Bild. Deshalb die
     * Abfrage — sie unterscheidet „läuft schon" von „hat noch keiner
     * angestoßen". Der zweite Fall bleibt möglich: Bo öffnet die Liste, und
     * Verknüpfungen von außen tun es auch.
     */
    /**
     * Geprüft über die Uhr, NICHT über den geteilten Wert.
     *
     * Hier stand `resultsPush.value === 0` — ein Zugriff aus JS auf einen
     * geteilten Wert, und der ist ein SYNCHRONER Sprung in die UI-Laufzeit, bei
     * dem beide Stränge kurz gegeneinander gesperrt werden. Ausgerechnet in dem
     * Bild, in dem die Bewegung anlaufen soll. Genau davor warnt die Datei
     * `overlayCover.ts` an anderer Stelle selbst, und genau dafür gibt es dort
     * `msSinceResultsPush()`.
     *
     * Zweiter Grund, warum der alte Vergleich nicht taugte: Beim App-Start läuft
     * ein Aufwärm-Durchgang über denselben Wert (siehe SearchHeroOverlay). In
     * dessen Fenster steht dort 0.002 statt 0 — die Abfrage hätte also aus dem
     * falschen Grund das Richtige getan, und beim nächsten Umbau des Aufwärmens
     * lautlos das Falsche.
     *
     * Eine halbe Sekunde deckt jeden Weg ab, auf dem ein Aufrufer die Bewegung
     * selbst angestoßen hat: Zwischen seinem Tipp und diesem Effekt liegen
     * wenige Bilder. Wer die Liste OHNE Tipp öffnet (Bo, eine Verknüpfung),
     * liegt weit darüber und bekommt sie hier gestartet.
     */
    if (msSinceResultsPush() > 500) startResultsPush();
  }, []);
  useEffect(() => {
    if (!visible) {
      // Zurückgesetzt, damit die nächste Suche wieder von rechts hereinkommt —
      // und damit die Unterlage nicht verschoben stehenbleibt.
      startedRef.current = false;
      resultsPush.value = 0;
      // Und alles, was pro Suche gilt, ebenfalls zurücksetzen. Als Route erledigte
      // das der Abbau; seit der Baum stehen bleibt, muss es hier passieren —
      // sonst gölte der Stand der ERSTEN Suche für alle weiteren: die Textur wäre
      // nur beim ersten Mal da, und die gestaffelte Freigabe des Inhalts liefe
      // ab dem zweiten Mal gar nicht mehr.
      setContentReady(false);
      return;
    }
    // Notbremse fürs Nachziehen der Route: Wird die Bewegung unterbrochen, läuft
    // `afterSlide` nie — die Route entstünde dann nie, und die Zurück-Geste
    // hätte nichts zu poppen.
    const routeGuard = setTimeout(() => {
      const pending = useSearchStore.getState().pendingResultsRoute;
      if (!pending) return;
      useSearchStore.getState().setPendingResultsRoute(null);
      router.push({ pathname: "/search/results", params: pending });
    }, 1500);
    // DIREKT starten, ein Bild später.
    //
    // Vorher hing der Start an `onLayout` des Slide-Roots — und der feuert beim
    // Öffnen NIE: Der Root ist absolut positioniert und dauerhaft gemountet, sein
    // Layout-Rahmen ändert sich also gar nicht, nur seine Kinder. Fabric meldet
    // aber nur Änderungen an DIESEM Knoten. Jedes Öffnen lief damit über die
    // 120ms-Notbremse — rund fünfzehn Bilder Stillstand bei 120Hz, in denen die
    // Unterlage das Einzige ist, was man sieht. Genau das ist „der Parallax kommt
    // zu spät": Der reinslidende Bildschirm parkt in dieser Zeit unsichtbar
    // außerhalb, seine Verzögerung sieht niemand.
    const id = requestAnimationFrame(beginSlide);
    return () => {
      cancelAnimationFrame(id);
      clearTimeout(routeGuard);
    };
  }, [visible, beginSlide, router]);

  // Slide-Out: wenn der User wegnavigiert (Back-Gesture, Hardware-Back,
  // router.back), intercepten wir via beforeRemove, blocken den Default-Pop,
  // fahren die Slide zurück und dispatchen dann die
  // Original-Aktion. Gleiches Pattern wie DetailsOverlay.
  // Zurück-Geste, Stapel-Reset und das Abräumen liegen in der Route-Hülle
  // (app/search/results.tsx). Sie treibt beim Zurückgehen denselben geteilten
  // Wert, den dieser Baum liest — die Bewegung gehört also weiterhin hierher,
  // die Navigations-Hoheit dorthin.
  const p = (storeParams ?? {}) as Record<string, string>;

  const mode = (p.mode ?? "FLIGHT") as TravelMode;
  const origin = p.origin ?? "";
  const destination = p.destination ?? "";
  const originLabel = p.originLabel ?? origin;
  const destLabel = p.destLabel ?? destination;

  // Richtung tauschen. Wir schreiben die Route-Params um (origin↔destination,
  // Labels mit), sonst nichts. Die useQuery unten ist auf origin/destination
  // gekeyed → der Params-Wechsel löst automatisch eine neue Suche mit
  // vertauschter Strecke aus, kein manuelles refetch nötig.
  /**
   * Schließen — funktioniert AUCH, bevor die Route nachgezogen wurde.
   *
   * Geöffnet wird über den Store, die Route kommt erst nach der Bewegung. In dem
   * Fenster dazwischen (und falls das Nachziehen nie passiert, weil die Bewegung
   * unterbrochen wurde) gäbe es die Route noch gar nicht — `router.back()` hätte
   * dann den Tab-Stapel gepoppt statt die Ergebnisse zu schließen.
   */
  const closeResults = useCallback(() => {
    haptic("button");
    if (useSearchStore.getState().pendingResultsRoute) {
      // Route steht noch aus: selbst zurückfahren und danach ausblenden.
      useSearchStore.getState().setPendingResultsRoute(null);
      resultsPush.value = withTiming(0, POP_SPRING, (finished?: boolean) => {
        "worklet";
        if (finished) runOnJS(clearResultsParams)();
      });
      return;
    }
    router.back();
  }, [router]);
  const goBack = closeResults;

  /**
   * Eine GEÄNDERTE Suche übernehmen — der Ausgang der Such-Slide.
   *
   * Hier stand `handleSwap`, das genau eine Änderung konnte: Start und Ziel
   * vertauschen. Das Formular in der Slide kann jede — andere Orte, anderes
   * Datum, andere Reisende, andere Klasse — und liefert dafür denselben
   * vollständigen Parametersatz, den auch der Such-Screen abschickt. Der Weg
   * hinein ist deshalb derselbe geblieben, nur die Quelle ist eine andere.
   *
   * Der Sonderfall ebenfalls: Solange die Route noch AUSSTEHT (geöffnet wird
   * über den Store, die Route wird erst nach der Bewegung nachgezogen), gibt es
   * gar keine, deren Parameter man umschreiben könnte — `setParams` träfe die
   * einer FREMDEN Route. Dann wird direkt im Store getauscht.
   *
   * `router.setParams` ist ein Zusammenführen, kein Ersetzen. Das ist hier
   * unkritisch, weil der Satz aus dem Formular VOLLSTÄNDIG ist: Auch eine
   * Rückreise, die es nicht mehr gibt, steht darin als leerer Wert und
   * überschreibt damit die alte.
   */
  const applySearchEdit = useCallback(
    (next: Record<string, string>) => {
      const st = useSearchStore.getState();
      if (st.pendingResultsRoute) {
        st.setPendingResultsRoute({ ...st.pendingResultsRoute, ...next });
        st.setResultsParams({ ...(st.resultsParams ?? {}), ...next });
        return;
      }
      router.setParams(next);
    },
    [router],
  );

  /**
   * Die Such-Slide — offen oder zu.
   *
   * Sie fährt von OBEN herein und trägt dasselbe Formular wie der Such-Screen.
   * Ausgelöst wird sie durch einen Tipp auf die Kopfzeile: Was dort steht, ist
   * genau das, was man ändern will, und deshalb ist die Anzeige zugleich der
   * Knopf. Der frühere Weg dorthin war „Ändern" — der schloss diesen Bildschirm
   * und baute den Such-Screen darunter wieder auf, mit voller Rückfahrt und
   * neuer Einfahrt. Jetzt bleibt die Liste stehen.
   */
  const [searchEditOpen, setSearchEditOpen] = useState(false);
  const openSearchEdit = useCallback(() => {
    haptic("button");
    setSearchEditOpen(true);
  }, []);
  const closeSearchEdit = useCallback(() => setSearchEditOpen(false), []);

  /**
   * Die Glocke öffnet den PREIS-ALARM, nicht die Benachrichtigungen.
   *
   * Hier stand das Benachrichtigungs-Blatt des Landingscreens, an dessen
   * Unterkante angedockt. Das war die naheliegende Bedeutung einer Glocke, aber
   * die falsche für diesen Bildschirm: Eine Liste vergangener Meldungen hat mit
   * der Suche, die man gerade vor sich hat, nichts zu tun. Beobachten will man
   * an dieser Stelle den PREIS dieser Strecke — und genau dafür steht die
   * Glocke hier.
   *
   * Erreichbar bleibt die Meldungsliste über die Glocke im Landingscreen; sie
   * ist dort dieselbe und unverändert.
   */
  const [alertOpen, setAlertOpen] = useState(false);
  const openPriceAlert = useCallback(() => {
    haptic("button");
    setAlertOpen(true);
  }, []);
  const closePriceAlert = useCallback(() => setAlertOpen(false), []);
  const departDate = p.departDate ?? "";
  // Uhrzeit aus dem Datums-/Zeit-Picker (UTC-ISO). Muss in JEDEN Query-Key und
  // jeden Suchaufruf — sonst sucht der Server ab einer Default-Zeit statt ab
  // dem gewünschten Zeitpunkt, und zwei Suchen derselben Strecke zu
  // verschiedenen Uhrzeiten würden sich gegenseitig aus dem Cache bedienen.
  const departTime = p.departTime ?? "";
  const returnDate = p.returnDate ?? "";
  const passengers = Number(p.passengers ?? "1");
  const currency = p.currency ?? "EUR";
  const travelClass = p.travelClass ?? "";
  /**
   * Kennung der angezeigten SUCHE. Wechselt bei einer anderen Strecke, einem
   * anderen Datum, Modus oder Klasse — aber NICHT, wenn dieselbe Suche im
   * Hintergrund aufgefrischt wird. Siehe key an der Liste.
   */
  const listIdentity = `${mode}|${origin}|${destination}|${departDate}|${returnDate}|${passengers}|${travelClass}`;

  // Flag dass die NÄCHSTE queryFn-Ausführung den Server-Cache umgeht.
  // Initial-Load nutzt Cache (schnell + spart Provider-Anfrage), Refresh per
  // Pull-Down / Refresh-Button nutzt nocache=1 (frische Preise).
  const forceFreshRef = useRef(false);

  // Ausweichen auf nahegelegene Flughäfen — NUR wenn der Nutzer es im
  // Leerzustand ausdrücklich anfordert. Teil des Query-Keys, damit die
  // Nachfrage eine eigene, frische Suche ist und nicht den Treffer-losen
  // Eintrag von vorhin aus dem Cache zieht.
  const [nearbyRequested, setNearbyRequested] = useState(false);
  // Vor dem Zurücksetzen pro Suche deklariert (siehe unten).
  const [direction, setDirection] = useState<"OUTBOUND" | "RETURN">("OUTBOUND");
  // Bei jedem echten Streckenwechsel zurücksetzen: Sonst würde die nächste
  // Suche stillschweigend wieder ausweichen.
  useEffect(() => setNearbyRequested(false), [origin, destination, departDate]);


  const { data, isLoading, isFetching, isError, error, refetch, isRefetching } = useQuery<SearchResponse>({
    queryKey: ["search", mode, origin, destination, departDate, departTime, returnDate, passengers, currency, travelClass, nearbyRequested],
    queryFn: () => {
      const opt = {
        ...(forceFreshRef.current ? { nocache: true } : {}),
        ...(nearbyRequested ? { nearby: true } : {}),
      };
      forceFreshRef.current = false;
      return searchByMode(
        {
          mode,
          origin,
          destination,
          originLabel,
          destLabel,
          departDate,
          ...(departTime ? { departTime } : {}),
          returnDate: returnDate || undefined,
          passengers,
          currency,
          travelClass: travelClass || undefined,
        },
        opt,
      );
    },
    // Query erst feuern wenn Slide-In durch ist (contentReady=true). Sonst
    // startet die queryFn + Promise + spätere setState-Cascade mitten im
    // Slide — und auch wenn das nur ein paar ms ist, jeder kleine JS-Tick
    // während der Animation kann die Slide-Worklet-Schedules stören.
    // NICHT mehr an `contentReady` gekoppelt.
    //
    // Der Gedanke war, den Aufbau aus der Bewegung zu halten. Für das RENDERN der
    // Ladeszene stimmt das — für die Netzwerk-Anfrage nicht: Die kostet keinen
    // Frame, sie wartet nur. Angekoppelt startete sie erst nach dem Ende der
    // Slide, also rund 200ms später als nötig, und zwar bei jeder Suche.
    // Wieder an `contentReady` gekoppelt, also erst NACH der Bewegung.
    //
    // Ich hatte das gelöst, um Ergebnisse rund 200ms früher zu zeigen. Der Preis
    // war unsichtbar, aber genau das, was als „da laufen große Sachen im
    // Hintergrund" ankommt: Antwortet der Server schnell (Server-Cache), landet
    // die Antwort MITTEN in die Bewegung — dann wird eine große
    // JSON-Antwort auf dem JS-Thread zerlegt, React Query schreibt seinen Cache,
    // und dieser Baum rendert neu. Alles im selben Moment, in dem die Bewegung
    // laufen soll.
    //
    // 200ms später fertig zu sein bemerkt niemand. Eine hakende Bewegung schon.
    enabled: Boolean(origin && destination && departDate) && contentReady,
    retry: 1,
    staleTime: 10 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
    // 'always' statt false — auch bei vorhandenem Cache wird im Hintergrund
    // refetched. Das verhindert den Bug wo der User Cache mit leerem Result
    // sieht (z.B. von früherem Provider-Fail) und sofort die Empty-State-UI
    // angezeigt bekommt statt erst den Loader. Mit 'always' bleibt
    // isFetching=true während des Refetch und der Loader bleibt sichtbar.
    refetchOnMount: "always",
    refetchOnWindowFocus: false,
  });

  // Loader spielt seine Animation in Loops; bei jedem vollen Cycle-Ende
  // feuert er einen Puls. Wir transitionen nur dann auf die Tickets wenn
  // die Query KOMPLETT settled ist — kein laufender Initial-Load, kein
  // laufender Retry (React-Query macht bei retry:1 automatisch einen
  // zweiten Versuch, während dem isFetching=true ist) und kein Background-
  // Refresh. Damit sieht der User nicht die Error-UI während ein Retry
  // läuft, und die Tickets erscheinen sauber wenn die Daten wirklich da
  // sind.
  const [showResults, setShowResults] = useState(false);

  // Verlauf am ENDE jeder erfolgreichen Suche auffrischen — egal, wie sie
  // gestartet wurde. Bisher schrieb nur der Such-Screen einen Eintrag; wer im
  // Landingscreen auf eine gespeicherte Reise tippte oder in der Umgebung
  // suchte, ließ den Verlauf unverändert. Der Eintrag rutschte also nicht nach
  // oben und das Datum blieb alt. `addRecentSearch` dedupliziert selbst
  // (Modus + Start + Ziel) und aktualisiert nur den Zeitstempel.
  /**
   * DER GRUND, WARUM EINE WIEDERHOLTE SUCHE KEINEN EINTRAG HINTERLIESS.
   *
   * Hier stand ein Riegel: Eine Ablage merkte sich die zuletzt geschriebene
   * Strecke und ließ dieselbe nie ein zweites Mal durch. Zusammen mit dem
   * Abhängigkeits-Paar unten — es enthielt NUR `data` — ergab das eine Lücke,
   * durch die eine ganze Suche fallen konnte:
   *
   * React Query gibt für einen bereits bekannten Abfrage-Schlüssel dasselbe
   * Objekt zurück, das es beim ersten Mal geliefert hat (Verfallszeit hier 30
   * Minuten). Sucht man dieselbe Strecke innerhalb dieser Zeit erneut, ändert
   * sich `data` also NICHT — nach `Object.is` ist es dasselbe. Der Effekt lief
   * damit gar nicht erst an, und selbst wenn, hätte der Riegel ihn gestoppt.
   *
   * Sichtbar wird das nicht als „kein Eintrag", sondern als „falsche
   * Reihenfolge": Der Eintrag von damals steht noch da, rutscht aber nicht nach
   * oben — und der Landingscreen zeigt nur die obersten drei. Wer zwischendurch
   * anderes gesucht hat, findet seine gerade eben gemachte Suche schlicht nicht
   * mehr.
   *
   * Beides ist jetzt weg. `addRecentSearch` entdoppelt selbst und frischt dabei
   * den Zeitstempel auf — genau das, was hier gebraucht wird. Ein Riegel davor
   * war nie nötig, er hat nur die Auffrischung verhindert.
   *
   * Die Abhängigkeiten sind entsprechend beides: `data` (eine Antwort ist da)
   * UND `storeParams` (der Bildschirm wurde neu geöffnet — die Hülle in
   * `app/search/results.tsx` legt dafür jedes Mal ein frisches Objekt an).
   */
  useEffect(() => {
    // Nur solange der Bildschirm offen ist. Beim Schließen fällt `storeParams`
    // auf null — der Effekt liefe dann ein weiteres Mal, mit noch stehenden
    // Daten, und schriebe mitten in die Schließbewegung hinein. Der Eintrag wäre
    // derselbe; der Schreibvorgang weckt trotzdem alle Abonnenten.
    if (!storeParams) return;
    if (!data || data.results.length === 0) return;
    useSearchStore.getState().addRecentSearch({
      mode,
      origin: { code: origin, label: originLabel },
      destination: { code: destination, label: destLabel },
      departDate,
      returnDate: returnDate || undefined,
      tripType: p.tripType === "roundtrip" ? "roundtrip" : "oneway",
      passengers,
      currency,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, storeParams]);

  /**
   * Angebot „in der Umgebung suchen" für den Leerzustand.
   *
   * Nur bei Flügen und nur, solange nicht bereits ausgewichen wurde. Der Server
   * weicht NIE von sich aus aus (siehe allowNearby dort) — er tut es erst, wenn
   * dieser Knopf gedrückt wurde. Damit sieht niemand Basler Flüge, weil er Bern
   * gesucht hat, ohne es zu wissen.
   */
  // WÄHREND die Umgebungssuche läuft. Ohne diese Unterscheidung kippte der
  // Leerzustand schon im Moment des Antippens auf „auch in der Umgebung nichts
  // gefunden" — die Suche hatte da noch nicht einmal begonnen.
  const nearbyBusy = mode === "FLIGHT" && nearbyRequested && isFetching;
  const nearbyOffer =
    mode === "FLIGHT" && (!nearbyRequested || nearbyBusy)
      ? { onSearch: () => setNearbyRequested(true), busy: nearbyBusy }
      : null;
  /** Umgebungssuche ABGESCHLOSSEN und trotzdem leer → kein Knopf mehr, nur die
   *  Info. Erst wenn nichts mehr läuft, sonst siehe oben. */
  const nearbyExhausted = mode === "FLIGHT" && nearbyRequested && !isFetching;

  // Zurück aus den Ergebnissen heißt: Der Landingscreen steht einfach wieder
  // da. Keine Einblend-Welle — man kommt von einem Screen zurück, den man
  // gerade selbst verlassen hat, und sieht dort nichts Neues.
  // Der frühere Abbau-Effekt ist entfallen: Dieser Baum wird nicht mehr
  // abgebaut. Was pro Suche zurückzusetzen ist, steht oben im
  // Sichtbarkeits-Effekt; was zur Navigation gehört, in der Route-Hülle.

  const isLoadingRef = useRef(isLoading);
  isLoadingRef.current = isLoading;
  const isFetchingRef = useRef(isFetching);
  isFetchingRef.current = isFetching;
  const onLoaderCyclePulse = useCallback(() => {
    if (!isLoadingRef.current && !isFetchingRef.current) {
      setShowResults(true);
    }
  }, []);

  const autoRetriedRef = useRef(false);

  // Derived-State-During-Render Pattern (React-empfohlen). Wenn sich Origin/
  // Destination/Date/Mode ändern (= neue Suche), setzen wir showResults
  // direkt DURING dem Render zurück — bevor irgendwas gepainted wird. Das
  // ist strikt besser als useEffect oder useLayoutEffect: bei beiden gibt es
  // einen Frame wo der alte Zustand gerendert wird, was den Retry-Button-
  // Flash und das „Animation A → Animation B"-Stottern verursachte.
  // React schmeißt diesen Render weg und macht sofort einen neuen mit dem
  // korrekten State — kein wasted paint, kein Flicker.
  /**
   * Was eine ANDERE Suche ausmacht — und hier standen bis zum Umbau vier von
   * sieben Bestandteilen.
   *
   * Solange der einzige Weg, eine laufende Suche zu ändern, der Tausch-Knopf
   * war, reichten Verkehrsmittel, Start, Ziel und Hinreise-Datum: Mehr konnte
   * man von hier aus gar nicht ändern. Seit die Such-Slide das ganze Formular
   * anbietet, kann man es — und wer nur die Reisenden oder die Klasse ändert,
   * sah bisher NICHTS passieren: Die Abfrage lief neu (ihr Schlüssel enthält
   * beides längst), aber `showResults` blieb stehen, also weder Lade-Szene noch
   * Balken. Der Bildschirm zeigte minutenlang die Preise für die alte
   * Personenzahl, ohne einen Hinweis darauf, dass etwas unterwegs ist.
   *
   * Jetzt dieselben Bestandteile wie im Abfrage-Schlüssel, plus die Uhrzeit —
   * die wählt man im Kalender, sie geht in die Suche ein und war hier ebenfalls
   * unsichtbar.
   *
   * Was daran hängt, ist damit ebenfalls richtig: Eine wirklich andere Suche
   * beginnt wieder bei der Hinreise, ohne Umgebungs-Ausweichung und mit der
   * Standard-Sortierung.
   */
  const searchKey = `${mode}|${origin}|${destination}|${departDate}|${departTime}|${returnDate}|${passengers}|${travelClass}`;
  /**
   * Der aktuelle Stand, auch für Rückrufe aus einem älteren Render.
   *
   * Ein Ref und nicht die Variable selbst: `loadMore` unten ist eine ganz normale
   * Funktion im Rumpf, ihre `mode`/`origin`/… stammen also aus dem Render, in dem
   * sie entstand. Ein Vergleich dieser Werte gegen sich selbst kann nie
   * fehlschlagen — der Wächter wäre eine Attrappe. Der Ref ist über alle Render
   * hinweg dasselbe Objekt und trägt darum wirklich den neuesten Wert.
   */
  const searchKeyRef = useRef(searchKey);
  searchKeyRef.current = searchKey;
  const lastSearchKeyRef = useRef(searchKey);
  if (lastSearchKeyRef.current !== searchKey) {
    lastSearchKeyRef.current = searchKey;
    autoRetriedRef.current = false;
    // setState während Render: React verwirft diesen Render-Pass und
    // re-rendert sofort mit dem aktualisierten Wert. Hier IMMER false —
    // der Loader muss IMMER mindestens einen vollen Cycle laufen.
    setShowResults(false);
    // Und alles Weitere, was zur ALTEN Suche gehört.
    //
    // Als Route war das gratis: Jede Suche bekam einen frischen Baum. Seit er
    // stehen bleibt, schleppt jede Suche den Zustand der vorherigen mit — und
    // zwei davon sind echte Fehler:
    //   • `direction` blieb auf RETURN stehen. Die nächste Suche ohne Rückreise
    //     zeigte dann eine leere Liste, obwohl es Treffer gab.
    //   • `nearbyRequested` blieb auf true. Die nächste Suche fragte damit sofort
    //     die Umgebung mit ab — und das Angebot „Flughäfen in der Nähe suchen"
    //     erschien nie, obwohl es der Nutzer nie bestätigt hatte.
    // `sort` wird ebenfalls zurückgesetzt, damit eine neue Suche wie früher mit
    // der Standard-Sortierung beginnt.
    setDirection("OUTBOUND");
    setNearbyRequested(false);
    setSort("cheapest");
  }
  // Auto-Retry bei intermittierenden Provider-Fails: wenn die Suche fertig
  // ist und LEER zurückkommt (HAFAS-/dbVendo-Schluckauf bei Cross-Border-
  // Routen wie München→Prag), versuchen wir EINMAL automatisch frisch zu
  // fetchen statt sofort die „Keine Treffer"-UI anzuzeigen. Bei echtem
  // Leerstand (Strecke wirklich ohne Verbindung) bleibt's beim zweiten Mal
  // auch leer und wir zeigen die Empty-State.
  useEffect(() => {
    if (
      data &&
      data.results.length === 0 &&
      !isFetching &&
      !isLoading &&
      !autoRetriedRef.current
    ) {
      autoRetriedRef.current = true;
      forceFreshRef.current = true; // Server-Cache überspringen
      refetch();
    }
  }, [data, isFetching, isLoading, refetch]);

  const refreshFresh = () => {
    forceFreshRef.current = true;
    return refetch();
  };

  // Silent Background-Refresh: alle 5 Min frische Preise vom SERVER-Cache
  // holen — ohne `nocache`. Das ist clever weil:
  //   1. Server hat eh schon SWR-Logik: bei >50% TTL läuft ein Refresh im
  //      Hintergrund → Cache wird automatisch frisch gehalten
  //   2. Client-Poll triggert eigene Provider-Calls NICHT → ein User der den
  //      Screen lange offen lässt verbraucht KEINE Provider-Quota
  //   3. Mehrere User auf derselben Route teilen sich den Server-Cache → eine
  //      Provider-Anfrage pro Route pro TTL-Window, völlig unabhängig von Usern
  //
  // Effekt: Preise sind nie älter als TTL/2 (≈ Flight 5min, Bus 15min, Train 2h)
  // OHNE dass die User-Anzahl die Kosten skaliert.
  const queryClient = useQueryClient();
  const queryKey = useMemo(
    // `nearbyRequested` MIT drin — es fehlte, und damit war dieser Schlüssel IMMER
    // ein anderer als der der Abfrage. Der stille Auffrisch-Lauf holte also alle
    // fünf Minuten die kompletten Daten, legte sie unter einem verwaisten
    // Schlüssel ab und aktualisierte die Anzeige nie. Preise blieben beliebig alt,
    // dazu eine überflüssige Server-Anfrage und eine zweite Kopie im Speicher.
    () => ["search", mode, origin, destination, departDate, departTime, returnDate, passengers, currency, travelClass, nearbyRequested],
    [mode, origin, destination, departDate, departTime, returnDate, passengers, currency, travelClass, nearbyRequested],
  );

  /** Aufgeschobener Eintrag der stillen Auffrischung — muss beim Abbau sterben. */
  const commitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (commitTimerRef.current) clearTimeout(commitTimerRef.current);
  }, []);

  useEffect(() => {
    if (!origin || !destination || !departDate) return;
    const intervalMs = 5 * 60 * 1000; // 5 Min

    const doSilentRefresh = async () => {
      if (AppState.currentState !== "active") return;
      /**
       * NICHT während einer laufenden Bewegung.
       *
       * Diese Auffrischung holt eine vollständige Antwort, zerlegt sie und
       * schreibt sie in den Abfrage-Speicher — der gesamte Ergebnis-Baum
       * rendert danach neu. Sie läuft alle fünf Minuten UND bei jedem Wechsel
       * in den Vordergrund, ohne Rücksicht darauf, ob gerade ein Blatt fährt.
       * Das ist das perfekte „manchmal ruckelt es, ohne dass ich etwas anders
       * gemacht hätte".
       *
       * Verschoben statt verworfen: Beim nächsten Takt ist sie wieder dran.
       */
      if (isTransitionBusy()) return;
      try {
        // OHNE nocache — wir holen vom Server-Cache, der via SWR
        // automatisch frisch gehalten wird.
        const fresh = await searchByMode(
          {
            mode,
            origin,
            destination,
            originLabel,
            destLabel,
            departDate,
            ...(departTime ? { departTime } : {}),
            returnDate: returnDate || undefined,
            passengers,
            currency,
            travelClass: travelClass || undefined,
          },
          /**
           * Die Umgebungs-Option MUSS mit.
           *
           * Der Schlüssel eine Ebene höher enthält `nearbyRequested` — das wurde
           * dort ausdrücklich ergänzt und begründet. Die Anfrage hier lief aber
           * weiter ohne, und ihr Ergebnis landete unter genau diesem Schlüssel.
           * Wer nach einer erfolglosen Flugsuche „Flughäfen in der Nähe" antippte
           * und Treffer bekam, sah sie fünf Minuten später — oder beim nächsten
           * Wechsel in den Vordergrund — durch die Antwort OHNE Ausweitung
           * ersetzt. Also in aller Regel durch eine leere: Die Liste leerte sich
           * von selbst, zurück in den Leerzustand.
           */
          nearbyRequested ? { nearby: true } : undefined,
        );
        /**
         * NOCH EINMAL prüfen — die Prüfung oben ist zu diesem Zeitpunkt alt.
         *
         * Zwischen ihr und dieser Zeile liegt eine vollständige Netz-Anfrage,
         * also leicht eine halbe Sekunde. Ob beim START der Auffrischung
         * gerade etwas fuhr, sagt nichts darüber aus, ob es das JETZT tut —
         * und geschrieben wird erst hier: `setQueryData` lässt den gesamten
         * Ergebnis-Baum neu rendern.
         *
         * Weil der Zeitpunkt am Netz hängt, trifft es mal eine Fahrt und mal
         * nicht. Das ist das übriggebliebene „vereinzelt ruckelt es noch".
         *
         * Verschoben, nicht verworfen: Die Antwort ist da und wird
         * eingetragen, sobald nichts mehr fährt. Ein Wiederversuch alle 150ms
         * ist ein Zeitstempel-Vergleich und stört keine Bewegung.
         */
        const commit = () => {
          if (isTransitionBusy()) {
            commitTimerRef.current = setTimeout(commit, 150);
            return;
          }
          commitTimerRef.current = null;
          queryClient.setQueryData(queryKey, fresh);
        };
        commit();
      } catch {
        // Refresh fehlgeschlagen → bestehende Daten bleiben.
      }
    };

    const id = setInterval(doSilentRefresh, intervalMs);
    // Auch beim Foreground-Switch refreshen (User hatte App im Hintergrund).
    const sub = AppState.addEventListener("change", (s) => {
      if (s === "active") void doSilentRefresh();
    });
    return () => {
      clearInterval(id);
      sub.remove();
    };
  }, [mode, origin, destination, originLabel, destLabel, departDate, departTime, returnDate, passengers, currency, travelClass, nearbyRequested, queryKey, queryClient]);

  // Hin- oder Rückreise-Ansicht. Nur für Train/Bus relevant — Flüge bekommen
  // keine separaten Rück-Treffer (SerpAPI/Google Flights pre-bundled die schon
  // serverseitig). Default: Hinreise.

  // „Später"-Pagination (nur TRAIN): zusätzliche Verbindungen die per HAFAS-
  // laterRef nachgeladen wurden, plus der aktuelle Token für den nächsten
  // Klick. Zurückgesetzt bei einer ANDEREN Suche — nicht bei jeder neuen
  // Antwort; siehe die Begründung am Effekt weiter unten.
  const [extraResults, setExtraResults] = useState<SearchResult[]>([]);
  const [paginationToken, setPaginationToken] = useState<string | undefined>(undefined);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  // Wie viele Treffer aktuell sichtbar sind (Rest bleibt im Speicher). Bei jeder
  // neuen Suche zurück auf PAGE_SIZE.
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  /**
   * Zurückgesetzt wird bei einer ANDEREN Suche, nicht bei neuen Daten.
   *
   * Die Abhängigkeit war `dataFetchedAt` — und die wechselt bei JEDEM stillen
   * Auffrisch-Lauf, also alle fünf Minuten und bei jedem Wechsel in den
   * Vordergrund. Wer über „Mehr" 60 Treffer aufgedeckt hatte, stand danach
   * wieder bei 20, und die nachgeladenen Verbindungen waren weg — obwohl sie
   * echte Anbieter-Anfragen gekostet hatten. Der Kommentar an der Liste weiter
   * unten begründet für den `key` genau dasselbe („für ‚still' das Gegenteil");
   * hier stand es noch andersherum.
   *
   * `listIdentity` wechselt nur, wenn wirklich eine andere Suche angezeigt wird.
   * Der Blätter-Marker wird trotzdem bei jeder neuen Antwort nachgezogen — er
   * gehört zu den Daten, nicht zur Ansicht.
   */
  useEffect(() => {
    setExtraResults([]);
    setVisibleCount(PAGE_SIZE);
  }, [listIdentity]);
  useEffect(() => {
    setPaginationToken(data?.paginationToken);
  }, [data?.paginationToken]);

  /**
   * Memoisiert — und das ist kein Feinschliff, sondern hat unten alles entwertet.
   *
   * Die Zeile baute bei JEDEM Render ein neues Feld. Damit war die Kennung neu,
   * und die Memoisierung darunter (`outboundSorted`/`returnSorted`) traf nie:
   * Bei jedem Durchlauf liefen zwei `filter`, zwei Entdopplungen — bei Flügen
   * mit einer siebenteiligen Signatur pro Eintrag — und zwei Sortierungen über
   * die volle Liste, in der Praxis rund 70 Treffer.
   *
   * Besonders unangenehm war der Zeitpunkt: Dieser Baum rendert unter anderem
   * dann neu, wenn beim AUFSETZEN des Fingers die Textur der Unterlage
   * angefordert wird. Die ganze Rechnerei lag damit genau in dem Moment auf dem
   * JS-Strang, in dem als Nächstes das Loslassen verarbeitet werden soll.
   */
  const allResults = useMemo(
    () => [...(data?.results ?? []), ...extraResults],
    [data?.results, extraResults],
  );

  const loadMore = async () => {
    if (isLoadingMore) return;
    // Strecke festhalten — die Antwort kommt später, und bis dahin kann der
    // Nutzer getauscht, das Datum geändert oder die Umgebungssuche gestartet
    // haben. Ohne diesen Vergleich hingen die alten Treffer unten an der NEUEN
    // Liste, und der Blätter-Token gehörte zur falschen Strecke.
    /**
     * DIESELBEN Bestandteile wie `searchKey` — sonst schlägt der Vergleich
     * unten IMMER fehl.
     *
     * Hier standen vier Teile, während `searchKey` seit der Erweiterung acht
     * trägt (Uhrzeit, Rückreise, Reisende, Klasse kamen dazu, damit auch eine
     * Änderung an ihnen die Suchanimation auslöst). Zwei Zeichenketten mit
     * verschieden vielen Teilen sind nie gleich — der Wächter unten stieg also
     * bei JEDEM Nachladen aus, noch VOR dem Eintragen.
     *
     * Sichtbar war das als Knopf, der nichts tut: Ein Tipp auf „Mehr" schickte
     * eine vollständige Anbieter-Anfrage los (bei Flügen mit `nocache`, also
     * eine frische und kostenpflichtige), wartete sie ab, zerlegte die Antwort
     * — und verwarf sie. Deshalb aus derselben Vorlage gebaut wie `searchKey`
     * und nicht noch einmal von Hand: Zwei Listen an zwei Orten laufen beim
     * nächsten Feld wieder auseinander.
     */
    const loadKey = searchKeyRef.current;
    // Verglichen wird gegen den Ref, nicht gegen dieselben Closure-Werte — siehe
    // die Begründung an `searchKeyRef`.
    setIsLoadingMore(true);
    haptic("button");
    try {
      // Bevorzugt mit HAFAS-paginationToken arbeiten (echtes „laterThan").
      // Fallback wenn der Server keinen Token geliefert hat: nimm den letzten
      // sichtbaren Outbound-Treffer und such ab dessen Abfahrtszeit + 1 min.
      // So funktioniert „Später" auch dann wenn HAFAS keinen laterRef im
      // Response hatte (kommt bei manchen Routes intermittent vor).
      let opt: { paginationToken?: string; nocache?: boolean } | undefined;
      let extraDepartTime: string | undefined;
      if (mode === "FLIGHT") {
        // Flüge haben kein Pagination-Token. Die API ist nicht-deterministisch
        // (mal 8, mal 99 Treffer). „Mehr Ergebnisse" = eine FRISCHE Suche
        // (nocache) — die neuen, eindeutigen Treffer werden unten gemerged +
        // per Signatur dedupliziert. So wächst die Liste on-demand Richtung
        // Vollbild, ohne bei jeder Erstsuche Requests zu verschwenden.
        opt = { nocache: true };
      } else if (paginationToken) {
        opt = { paginationToken };
      } else {
        const lastOutbound = [...allResults]
          .reverse()
          .find((r) => r.direction !== "RETURN");
        if (lastOutbound?.departTime) {
          const t = new Date(lastOutbound.departTime);
          if (Number.isFinite(t.getTime())) {
            extraDepartTime = new Date(t.getTime() + 60_000).toISOString();
          }
        }
      }
      const next = await searchByMode(
        {
          mode,
          origin,
          destination,
          originLabel,
          destLabel,
          departDate,
          ...(departTime ? { departTime } : {}),
          returnDate: returnDate || undefined,
          passengers,
          currency,
          travelClass: travelClass || undefined,
          ...(extraDepartTime ? { departTime: extraDepartTime } : {}),
        },
        opt,
      );
      if (loadKey !== searchKeyRef.current) return;
      setExtraResults((prev) => [...prev, ...next.results]);
      setPaginationToken(next.paginationToken);
      // Frisch nachgeladene Treffer auch sichtbar machen.
      setVisibleCount((v) => v + PAGE_SIZE);
    } catch {
      // Bei Fehler den Token behalten — User kann erneut auf „Später" tippen.
    } finally {
      setIsLoadingMore(false);
    }
  };
  const hasReturnLeg = allResults.some((r) => r.direction === "RETURN");
  const showDirectionToggle =
    Boolean(returnDate) && hasReturnLeg && (mode === "TRAIN" || mode === "BUS");

  // Outbound + Return separat sortieren — beide Listen werden side-by-side
  // im SlidingPanels gemountet (analog zum Saved-Tab Reisen/Tickets-Swipe).
  // Direction-Toggle triggert nur einen translateX am SlidingPanels-Wrapper,
  // keinen FlatList-Remount.
  const { outboundSorted, returnSorted } = useMemo(() => {
    const dedupe = (list: SearchResult[]): SearchResult[] => {
      const seen = new Set<string>();
      const out: SearchResult[] = [];
      for (const r of list) {
        // Flüge: per „Mehr Ergebnisse" frisch nachgeladene Treffer haben NEUE
        // DB-IDs für denselben Flug → nach ID würde nicht dedupliziert. Daher
        // für Flüge die stabile Trip-Signatur als Schlüssel; sonst die ID.
        const key =
          mode === "FLIGHT"
            ? `${r.direction ?? "OUTBOUND"}-${tripSignature(r)}`
            : `${r.direction ?? "OUTBOUND"}-${r.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(r);
      }
      return out;
    };
    const outbound = allResults.filter((r) => r.direction !== "RETURN");
    const returnLeg = allResults.filter((r) => r.direction === "RETURN");
    return {
      outboundSorted: sortResults(dedupe(outbound), sort),
      returnSorted: sortResults(dedupe(returnLeg), sort),
    };
  }, [allResults, sort, mode]);

  // Aktive Liste für Header-Count + Empty-Detection (volle, ungeschnittene Liste).
  const sorted = showDirectionToggle
    ? direction === "RETURN"
      ? returnSorted
      : outboundSorted
    : outboundSorted;

  // "Mehr": zuerst die nächsten PAGE_SIZE aus dem bereits geladenen Set zeigen
  // (instant, kein Request). Erst wenn ALLE geladenen Treffer sichtbar sind,
  // frisch nachladen (loadMore — langsamer Pfad).
  const fullCount = Math.max(outboundSorted.length, returnSorted.length);
  const canRevealMore = visibleCount < fullCount;
  const handleShowMore = () => {
    if (canRevealMore) {
      haptic("button");
      setVisibleCount((v) => v + PAGE_SIZE);
    } else {
      loadMore();
    }
  };

  /**
   * Der Stil der Wurzel EINMAL, nicht bei jedem Durchgang neu.
   *
   * `ResultsShell` ist ausdrücklich `memo` — mit der Begründung, dass ein
   * Textur-Wechsel nicht den ganzen Baum neu rendern soll. Ein frisches Array
   * als `style` hebt genau das in der Gegenrichtung wieder auf: Jeder
   * Durchgang dieses Bildschirms ging durch die Schranke hindurch.
   *
   * Und die Wurzel ist zugleich der animierte Knoten. Ein frisches Objekt dort
   * ist auf Fabric ein Commit auf genau dem Knoten, den Reanimated Bild für
   * Bild beschreibt.
   *
   * Der Sonderfall bleibt: Nur wenn eine andere Route oben liegt (Karte), steht
   * dieser Baum an seiner Endposition und muss ausgeblendet werden. Sonst
   * versteckt ihn seine Position — der Bewegungswert ist dann 0 und legt ihn
   * vollständig rechts außerhalb des Bildes ab, und was außerhalb liegt,
   * zeichnet Android nicht.
   */
  const shellBase = useMemo(() => ({ backgroundColor: appBg }), [appBg]);
  const shellStyle = useMemo(
    () =>
      hiddenForRoute
        ? [styles.slideRoot, shellBase, slideStyle, HIDDEN_FOR_ROUTE]
        : [styles.slideRoot, shellBase, slideStyle],
    [hiddenForRoute, shellBase, slideStyle],
  );

  /**
   * „Die Suche läuft gerade" — EINMAL abgeleitet, zweimal gebraucht.
   *
   * Der Ladebalken hängt daran und die Umschaltung auf die Lade-Szene ebenfalls.
   * Zwei getrennt hingeschriebene Bedingungen laufen beim nächsten Feinschliff
   * auseinander, und dann liefe der Balken über der fertigen Liste weiter.
   *
   * GENAU DAS WAR PASSIERT, und es hat den teuersten Commit dieses Bildschirms
   * ins Bewegungsfenster gelegt.
   *
   * Der Balken benutzte diesen Wert, die Lade-Szene schrieb ihre Bedingung
   * daneben noch einmal von Hand hin — und ließ dabei `visible` weg. Was daraus
   * folgt, sieht man erst, wenn man die Reihenfolge beim SCHLIESSEN aufschreibt:
   *
   *   1. Die Route-Hülle wird gepoppt und setzt die Parameter auf `null`.
   *   2. Dieser Baum rendert. `storeParams` ist weg, also fällt alles auf seine
   *      Vorgabe zurück, `searchKey` wechselt, und der Reset-Block WÄHREND DES
   *      RENDERS setzt `showResults` auf falsch.
   *   3. `contentReady` steht in genau diesem Commit noch auf WAHR — es wird
   *      erst im Sichtbarkeits-Effekt zurückgenommen, und Effekte laufen nach
   *      dem Commit.
   *
   * Damit galt für ein bis zwei Bilder `!showResults && contentReady`, und der
   * Zweig unten baute eine vollständige Lade-Szene auf: Bo mit fünfzehn
   * geteilten Werten, sechs Zuordnungen und bis zu vierzehn Endlos-Kurven, dazu
   * der Szenen-SVG und ein Takt-Geber. Im nächsten Bild war alles wieder weg.
   *
   * Bezahlt wurde das an der schlechtesten Stelle: unmittelbar hinter der
   * Rückfahrt — und wer dort gleich die nächste Verlaufskarte antippt (der
   * Normalfall, an drei Stellen dieser Datei so beschrieben), bekommt das
   * Aufblenden, das Ausblenden und das An- und Abschalten von Bos Schleifen in
   * die ERSTEN Bilder der nächsten Einfahrt. Jede neu gemountete Zuordnung
   * verwirft dabei die sortierte Reihenfolge aller Zuordnungen der App.
   *
   * Im selben Commit wird auch die LISTE abgebaut: Der `!showResults`-Zweig
   * gewinnt vor dem Listen-Zweig, und `showResults` fällt beim Schließen schon
   * während des Renders. Das ist seither der einzige Weg, auf dem die Karten
   * freigegeben werden — der frühere Umweg über einen zweiten Zustand kam nie
   * zum Zug und ist ausgebaut; der Grabstein dazu steht oben bei `contentReady`.
   */
  const searching = visible && contentReady && !showResults;

  /**
   * Der günstigste Preis dieser Suche — die Bezugsgröße des Preis-Alarms.
   *
   * Aus ALLEN Treffern, nicht aus der angezeigten Richtung. Hier stand die
   * gefilterte Liste, mit der Begründung, bei Rückreise sei deren Preis
   * gemeint — und das war falsch, weil es die eine Seite ist, die der SERVER
   * nicht sieht: Er prüft später über die vollständige Antwort einer Suche.
   * Eine Schwelle, die aus einem Rückreise-Preis gesetzt wurde, läge damit über
   * dem, was der Server als günstigsten Preis findet, und der Alarm feuerte
   * sofort bei der nächsten Suche. Beide Seiten müssen dieselbe Zahl meinen.
   *
   * Nur echte Preise zählen — Zug-Treffer ohne Anreicherung tragen eine 0, und
   * die wäre als „günstigster Preis" eine glatte Falschaussage. Bleibt nichts
   * übrig, gibt es keinen Bezugspunkt; das Blatt sagt das dann selbst, statt
   * eine Zahl zu erfinden.
   */
  const cheapestPrice = useMemo(() => {
    let min = 0;
    for (const r of allResults) {
      if (r.price > 0 && (min === 0 || r.price < min)) min = r.price;
    }
    return min;
  }, [allResults]);

  /**
   * Alarm anlegen.
   *
   * Die Strecke wird MIT Beschriftung gespeichert, nicht nur mit Codes: Ein
   * Alarm wird später irgendwo aufgelistet, und „FRA → ZRH" sagt dort weniger
   * als „Frankfurt (Main) Hbf". Die Codes bleiben trotzdem dabei — sie sind
   * das, womit eine Prüfung später wirklich suchen kann.
   */
  const submitPriceAlert = useCallback(
    (desiredPrice: number, notifyOnRise: boolean) => {
      // Der Ablauf (Zustellweg, Rundung, lokaler Spiegel) steht an EINER
      // Stelle — die Glocke über dem Stadt-Blatt der Karte nutzt ihn auch.
      createSearchAlert(
        {
          mode,
          origin,
          destination,
          originLabel,
          destLabel,
          departDate,
          returnDate,
          passengers,
          travelClass,
          currency,
          cheapestPrice,
          desiredPrice,
          notifyOnRise,
        },
        t,
      );
    },
    /**
     * `returnDate` gehört in die Liste — es wird im Rumpf zweimal benutzt.
     *
     * Es fehlte, und das ist keine Förmlichkeit: Über die Such-Slide lässt sich
     * ein Rückdatum ergänzen, ohne den Bildschirm zu verlassen
     * (`applySearchEdit` schreibt nur die Parameter um). Blieb der günstigste
     * Preis dabei gleich — oder stand noch der alte, während die neue Suche
     * lief —, wurde der Rückruf nicht neu gebaut, und der Alarm entstand mit
     * dem ALTEN Rückdatum bei neuer Schwelle.
     */
    [
      mode,
      origin,
      destination,
      originLabel,
      destLabel,
      departDate,
      returnDate,
      passengers,
      travelClass,
      currency,
      cheapestPrice,
      t,
    ],
  );

  /**
   * Die Vorbelegung der Such-Slide — als Zustand, der NICHT in eine laufende
   * Bewegung hinein wechselt.
   *
   * Hier stand ein `useMemo` über die Such-Parameter, und das war die zweite
   * Hälfte eines gemeldeten Rucklers: „wenn ich aus dem Such-Screen heraus
   * suche, ruckelt die Einfahrt der Liste, aus dem Verlauf genauso, auch der
   * Parallax."
   *
   * Die Kette ist kurz und in beiden Einstiegen dieselbe. `startResultsPush()`
   * lässt die Bewegung losfahren; die Parameter werden erst EIN BILD SPÄTER
   * gesetzt (`requestAnimationFrame` in `SearchHero.handleSubmit` und in
   * `RecentCard`). Dieser Bildschirm rendert daraufhin neu — mitten in Bild 2
   * der Fahrt. Ein `useMemo` über die Parameter liefert dabei zwangsläufig eine
   * neue Kennung, die Slide bekommt sie als Eigenschaft, und weil sich damit
   * eine Eigenschaft geändert hat, läuft der eingebettete Formularbaum
   * vollständig durch: ScrollView, fünf Einblend-Hüllen, vier Felder, Pillen,
   * Knopf. Danach schlägt zusätzlich seine Vorbelegung zu.
   *
   * Beides ist überflüssig genau dann, wenn es am teuersten ist: Die Slide ist
   * zu, niemand sieht das Formular, und die 430ms der Fahrt gehören der
   * Bewegung. Deshalb wird der Wert HINTER die Bewegung veröffentlicht.
   *
   * Als Zustand und nicht als abgeleiteter Wert, weil genau das der Punkt ist:
   * Der Zeitpunkt der Veröffentlichung soll frei wählbar sein. Die Kennung
   * bleibt zwischen zwei Veröffentlichungen stabil — daran hängt drüben der
   * Auslöser, der das Formular füllt.
   *
   * Der Wiederversuch ist dieselbe Bauart wie die Freigabe der Ergebniskarten
   * weiter oben: kurzer Abstand, Prüfung, notfalls nochmal. Eine feste
   * Wartezeit ginge auch, träfe aber die Rückfahrt nicht, die eine andere
   * Dauer hat.
   */
  /**
   * Verkehrsmittel UND Vorbelegung zusammen — als EIN Zustand.
   *
   * Das Verkehrsmittel gehört mit hierher, und das war der zweite Auslöser
   * desselben Rucklers. Solange die Ergebnisse zu sind, liegen keine Parameter
   * im Speicher, und `mode` fällt auf seinen Vorgabewert `FLIGHT` zurück. Beim
   * Öffnen einer Zug-, Bus- oder Kreuzfahrt-Suche wechselt die Eigenschaft also
   * von `FLIGHT` auf den echten Wert — in genau dem Commit, der die Bewegung
   * blockiert. Und weil das Verkehrsmittel drüben die Reisearten und die
   * Klassen-Liste bestimmt, rendert der komplette Formularbaum daraufhin neu.
   *
   * Zusammen in EINEM Zustand und nicht als zwei: Sie müssen im selben Durchgang
   * wechseln. Getrennt käme unvermeidlich ein Bild vor, in dem eine Vorbelegung
   * für Züge an einem Formular für Flüge hängt — und dessen Klassen-Liste ist
   * eine andere, der Index zeigte ins Leere.
   */
  const [editPrefill, setEditPrefill] = useState<{
    mode: TravelMode;
    initial: SearchHeroInitial;
  } | null>(null);
  useEffect(() => {
    const next: SearchHeroInitial = {
      origin: origin ? { code: origin, label: originLabel } : null,
      destination: destination ? { code: destination, label: destLabel } : null,
      /**
       * Die UHRZEIT gehört mit — deshalb `departTime` zuerst.
       *
       * `departDate` ist ein reines Tagesdatum, `departTime` derselbe Zeitpunkt
       * samt Uhrzeit (die man im Kalender wählt und die wirklich in die Suche
       * eingeht). Mit dem Tagesdatum allein fiele die Vorbelegung auf
       * Mitternacht zurück: Wer um 10 Uhr sucht, die Slide öffnet und ohne
       * Änderung erneut sucht, hätte plötzlich eine andere Abfahrtszeit als
       * eben — ohne sie angefasst zu haben.
       */
      departDate: departTime || departDate || null,
      returnDate: returnDate || null,
      passengers,
      travelClassKey: travelClass || null,
      /**
       * `tripType` kommt aus den Parametern, WENN es welche gibt — und
       * hergeleitet, wenn nicht.
       *
       * Vorrang hat der Parameter: Wer eine Hin- und Rückreise gesucht hat, bei
       * der die Rückreise leer blieb, soll die Slide trotzdem auf Hin und
       * zurück stehend vorfinden.
       *
       * Nur setzt ihn nicht jeder Einstieg. Die Spracheingabe schickt ihn gar
       * nicht (`VoiceContent.tsx`), und im Verlauf steht er nur, wenn er beim
       * Suchen dabei war (`RecentCard.tsx` fügt ihn bedingt an). Ohne
       * Herleitung bliebe das Formular in diesen Fällen auf seiner Vorgabe „Hin
       * und zurück": Wer aus einer per Sprache gesuchten einfachen Fahrt die
       * Slide öffnet, sähe ein leeres Rückreise-Feld — und bekäme beim ersten
       * Tipp auf „Preise vergleichen" einen roten Rand für ein Feld, das er nie
       * angefasst hat. Das Rückreise-Datum ist die verlässliche Auskunft
       * darüber.
       */
      tripType:
        (p.tripType as TripType | undefined) ?? (returnDate ? "roundtrip" : "oneway"),
    };
    const publish = () => setEditPrefill({ mode, initial: next });
    if (!isTransitionBusy()) {
      publish();
      return;
    }
    let id: ReturnType<typeof setTimeout>;
    const attempt = () => {
      if (isTransitionBusy()) {
        id = setTimeout(attempt, PREFILL_RETRY_MS);
        return;
      }
      publish();
    };
    id = setTimeout(attempt, PREFILL_SETTLE_MS);
    return () => clearTimeout(id);
  }, [
    mode,
    origin,
    originLabel,
    destination,
    destLabel,
    departDate,
    departTime,
    returnDate,
    passengers,
    travelClass,
    p.tripType,
  ]);

  return (
    <>
    <RouteWatch onChange={setHiddenForRoute} />
    <ResultsShell
      pointerEvents={hiddenForRoute || !visible ? "none" : "auto"}
      style={shellStyle}
    >
      {/* Keine eigene Hintergrundfarbe: Der Rahmen darüber ist bereits
          bildschirmfüllend und deckend eingefärbt. Zwei deckende Flächen
          übereinander heißt, die GPU füllt den ganzen Bildschirm zweimal —
          jedes Bild, auch während der Bewegung. */}
      <SafeAreaView style={styles.root} edges={["top"]}>
        <SearchSummaryBar
          mode={mode}
          fromLabel={stationLabel(originLabel)}
          toLabel={stationLabel(destLabel)}
          departDate={departDate}
          returnDate={returnDate}
          passengers={passengers}
          travelClassKey={travelClass}
          onBack={goBack}
          onBackTouchStart={prepareResultsLayer}
          onPress={openSearchEdit}
          onBellPress={openPriceAlert}
        />

        {/**
          * Der Ladebalken — und die Bedingung dafür ist unverändert die des
          * alten Kopfbereichs. Sie ist teuer erarbeitet, deshalb steht ihre
          * Begründung hier weiter:
          *
          * An `!showResults`, NICHT an `isLoading`: `showResults` wird bei JEDEM
          * Routenwechsel auf falsch gesetzt und der Loader läuft mindestens
          * einen Zyklus. `isLoading` ist beim Wechsel zu einer gecachten
          * Gegenrichtung dagegen falsch — dann liefe der Balken gar nicht,
          * während unten die Lade-Szene spielt.
          *
          * `visible` MIT prüfen: Ohne das gilt beim App-Start `!showResults` →
          * wahr, und der Balken liefe ab Sekunde eins dauerhaft auf dem
          * UI-Strang, obwohl nichts zu sehen ist. Seit dieser Baum nicht mehr
          * pro Suche entsteht, wäre das ein Dauerzustand.
          *
          * `contentReady` MIT prüfen: Der Ladezustand ist schon im ersten Render
          * wahr — also bevor die Einfahrt überhaupt startet. Sonst liefe die
          * Schleife über die volle Bewegung mit, und der fahrende Baum wäre
          * nicht statisch.
          *
          * Er reserviert seinen Platz NICHT, wenn er ruht: Was darunter steht,
          * ist im Ladezustand die Szene und danach die Liste — zwei
          * verschiedene Inhalte, die ohnehin überblenden. Ein leerer Streifen
          * über der fertigen Liste wäre der schlechtere Tausch.
          */}
        {searching ? (
          <View style={styles.progressWrap}>
            <SearchProgressBar active />
          </View>
        ) : null}

      {showDirectionToggle ? (
        <View style={styles.dirToggleWrap}>
          <SegmentedToggle
            items={[
              { id: "OUTBOUND", label: t("results.direction.outbound") },
              { id: "RETURN", label: t("results.direction.return") },
            ]}
            selectedId={direction}
            onChange={(id) => setDirection(id as "OUTBOUND" | "RETURN")}
          />
        </View>
      ) : null}

      {!showResults ? (
        // contentReady-Gate: Scene wird ERST nach Slide-End gemountet — kein
        // Mount-Cost konkurriert mit dem Slide-Worklet → buttersmoothes
        // Slide. FadeIn-Entering blendet die Scene danach sanft rein, kein
        // hartes Pop. Identisches Pattern wie DetailsOverlay's
        // contentReady-gated ScrollView.
        //
        // `searching` statt `contentReady` — also DERSELBE abgeleitete Wert, an
        // dem auch der Ladebalken darüber hängt. Er ist `visible && contentReady
        // && !showResults`; hier drin ist `!showResults` bereits wahr, es kommt
        // also allein `visible` hinzu. Ohne das mountete die Szene beim
        // SCHLIESSEN noch einmal für ein Bild — die ausführliche Begründung
        // steht an der Ableitung selbst.
        //
        // Am ÖFFNEN ändert sich nichts: `visible` ist wahr, sobald die
        // Parameter anliegen, also lange bevor `contentReady` am Ende der
        // Einfahrt kippt. Das Tor bleibt damit `contentReady`, genau wie bisher.
        !searching ? null : (
        // exiting: Der Loader verschwand bisher HART — Boo war da, im nächsten
        // Frame stand die Liste. Genau dieser Schnitt liest sich als „Aufploppen",
        // egal wie sauber die Liste danach einblendet. Jetzt blendet er aus,
        // während die Karten von unten hochwandern: eine Bewegung, keine zwei.
        <Animated.View
          entering={FadeIn.duration(220)}
          exiting={FadeOut.duration(MOTION.duration / 2)}
          style={LOADER_FILL}
        >
        <RandomSearchLoader
          originLabel={originLabel}
          destLabel={destLabel}
          onCyclePulse={onLoaderCyclePulse}
        />
        </Animated.View>
        )
      ) : isError ? (
        <View style={styles.errorWrap}>
          <View style={styles.errorIcon}>
            <WifiOff size={32} color={accent.solid} strokeWidth={2} />
          </View>
          <Text style={styles.errorTitle}>{t("results.error")}</Text>
          <Text style={styles.errorBody}>{t("results.error.body")}</Text>
          {/* Die rohe Fehlermeldung ist Entwickler-Text: unübersetzt (kommt aus
              lib/api/client.ts), enthält die interne Server-URL und braucht drei
              Zeilen, die das Layout auseinanderziehen. Dem User sagen Titel und
              Text oben bereits alles. Im Dev-Build bleibt sie zum Debuggen. */}
          {__DEV__ && error instanceof Error ? (
            <Text style={styles.errorDetail} numberOfLines={3}>
              {error.message}
            </Text>
          ) : null}
          <RippleTouch
            onPress={() => {
              haptic("button");
              refreshFresh();
            }}
            style={styles.retryBtn}
          >
            <GradientFill />
            <RotateCcw size={16} color={C.black} strokeWidth={2.4} />
            <Text style={styles.retryBtnText}>{t("results.retry")}</Text>
          </RippleTouch>
        </View>
      ) : showDirectionToggle ? (
        // Outbound + Return side-by-side im Pager — Hin/Rück-Toggle triggert
        // nur einen translateX, FlatLists bleiben gemountet → smoother
        // Swipe-Übergang analog zum Saved-Tab Reisen/Tickets-Wechsel.
        <SlidingPanels activeIndex={direction === "OUTBOUND" ? 0 : 1}>
          <ResultsListView
            data={outboundSorted.slice(0, visibleCount)}
            totalCount={outboundSorted.length}
            direction="OUTBOUND"
            fetchedAt={data?.fetchedAt ?? ""}
            listIdentity={listIdentity}
            sort={sort}
            onSort={setSort}
            passengers={passengers}
            mode={mode}
            isRefetching={isRefetching}
            refreshFresh={refreshFresh}
            isLoadingMore={isLoadingMore}
            loadMore={handleShowMore}
            accentSolid={accent.solid}
            nearbyOffer={null}
            nearbyExhausted={false}
            tEmpty={t("results.empty")}
            tRetry={t("results.retry")}
            tLater={t("results.later")} tMore={t("results.more")}
            tLoading={t("results.loading")}
          />
          <ResultsListView
            data={returnSorted.slice(0, visibleCount)}
            totalCount={returnSorted.length}
            direction="RETURN"
            fetchedAt={data?.fetchedAt ?? ""}
            listIdentity={listIdentity}
            sort={sort}
            onSort={setSort}
            passengers={passengers}
            mode={mode}
            isRefetching={isRefetching}
            refreshFresh={refreshFresh}
            isLoadingMore={isLoadingMore}
            loadMore={handleShowMore}
            accentSolid={accent.solid}
            nearbyOffer={null}
            nearbyExhausted={false}
            tEmpty={t("results.empty")}
            tRetry={t("results.retry")}
            tLater={t("results.later")} tMore={t("results.more")}
            tLoading={t("results.loading")}
          />
        </SlidingPanels>
      ) : (
        <ResultsListView
          data={outboundSorted.slice(0, visibleCount)}
          totalCount={outboundSorted.length}
          direction="OUTBOUND"
          fetchedAt={data?.fetchedAt ?? ""}
          listIdentity={listIdentity}
          sort={sort}
          onSort={setSort}
          passengers={passengers}
          mode={mode}
          isRefetching={isRefetching}
          refreshFresh={refreshFresh}
          isLoadingMore={isLoadingMore}
          loadMore={handleShowMore}
          accentSolid={accent.solid}
          nearbyOffer={nearbyOffer}
          nearbyExhausted={nearbyExhausted}
          tEmpty={t("results.empty")}
          tRetry={t("results.retry")}
          tLater={t("results.later")} tMore={t("results.more")}
          tLoading={t("results.loading")}
        />
      )}
      </SafeAreaView>

      {/**
        * Die Such-Slide — INNERHALB der bewegten Hülle, nicht daneben.
        *
        * Sie gehört zu diesem Bildschirm: Sie fährt mit ihm herein und hinaus,
        * und sie darf nur so weit reichen wie er. Am Wurzel-Layout gemountet
        * (wie die Blätter, die von unten kommen) läge sie über allem, auch über
        * dem Landingscreen, sobald man zurückgeht.
        *
        * NACH der sicheren Fläche, damit sie deren Inhalt verdeckt — ihre eigene
        * Kopfzeile bringt den Abstand zur Statusleiste selbst mit.
        *
        * `armed` an `contentReady`: Das Formular ist der teuerste Baum, den
        * dieser Bildschirm kennt, und es soll fertig stehen, bevor jemand die
        * Kopfzeile antippt. `contentReady` kippt am ENDE der Einfahrt — also
        * genau dann, wenn nichts mehr fährt und der Aufbau niemandem im Weg ist.
        * Die Slide selbst wartet zusätzlich, bis wirklich Ruhe ist.
        */}
      <SearchEditPanel
        visible={searchEditOpen}
        armed={contentReady}
        onClose={closeSearchEdit}
        onApply={applySearchEdit}
        /**
         * Verkehrsmittel und Vorbelegung kommen BEIDE aus dem aufgeschobenen
         * Zustand — siehe dort. Der Rückfall greift nur, bevor überhaupt einmal
         * veröffentlicht wurde, und das ist der erste Durchgang beim App-Start:
         * Dort liegt keine Bewegung an, der Effekt veröffentlicht sofort.
         */
        mode={editPrefill?.mode ?? mode}
        initial={editPrefill?.initial ?? null}
      />

      {/**
        * Das Preis-Alarm-Blatt — von unten, über die gemeinsame Hülle aller
        * Blätter (`SheetModal`), und deshalb hier ohne eigene Bewegung.
        *
        * Dass es INNERHALB der bewegten Hülle steht, ist für die Darstellung
        * ohne Bedeutung: `SheetModal` rendert in ein natives `Modal`, und das
        * hängt in einem EIGENEN Fenster, nicht in diesem Baum. Es fährt also
        * nicht mit, es wird nicht mit verschoben, und es liegt über allem.
        *
        * Hier steht es trotzdem, und zwar wegen der Zugehörigkeit: Es gehört zu
        * dieser Suche, liest ihren günstigsten Preis und ihre Strecke. Am
        * Wurzel-Layout müsste beides erst dorthin gereicht werden, und es wäre
        * offen, wem es gehört, sobald ein zweiter Bildschirm einen Alarm
        * anbietet. Solange es nur hier einen gibt, ist das die ehrlichere
        * Stelle. `visible` sorgt dafür, dass das Fenster nur entsteht, wenn es
        * gebraucht wird.
        */}
      <PriceAlertSheet
        visible={alertOpen}
        onClose={closePriceAlert}
        currentPrice={cheapestPrice}
        currency={currency}
        fromLabel={stationLabel(originLabel)}
        toLabel={stationLabel(destLabel)}
        onCreate={submitPriceAlert}
      />
    </ResultsShell>
    </>
  );
}

/**
 * Die bewegte Wurzel als EIGENE Komponente — wegen eines einzigen Zustands.
 *
 * Der Textur-Schalter (`subscribeLayer("results", …)`) lag in `ResultsView`
 * selbst. Angefordert wird die Textur beim AUFSETZEN des Fingers auf eine
 * Ticket-Karte — der Schalter rendete damit den kompletten Ergebnis-Baum neu:
 * Abfrage, Sortier-Ableitungen, Kopfzeile, Liste. Und zwar in genau dem Bild, in
 * dem als Nächstes das Loslassen verarbeitet werden soll.
 *
 * Wie teuer das war, hat sich schon einmal gezeigt: Dieser Re-Render war die
 * Ursache dafür, dass der erste Druck auf „Auswählen" ins Leere ging. Damals
 * wurde nur das Symptom behoben (konstante Baumform) — der Re-Render blieb.
 *
 * Hier liegt der Zustand jetzt allein. Der schwere Baum kommt als `children`
 * herein; beim Umschalten der Textur ist das dieselbe Referenz wie vorher, und
 * React lässt ihn dann unangetastet. Dieses Muster steht schon dreimal in der
 * Codebasis — `ParallaxScroll` im Landingscreen, `ParallaxLayer` im Saved-Reiter,
 * `ClipContent` im Such-Blatt, jeweils mit derselben Begründung. Die
 * Ergebnisliste war die einzige Ausnahme.
 */
const ResultsShell = memo(function ResultsShell({
  style,
  pointerEvents,
  children,
}: {
  style: StyleProp<ViewStyle>;
  pointerEvents: "auto" | "none";
  children: ReactNode;
}) {
  const [layered, setLayered] = useState(false);
  useEffect(() => subscribeLayer("results", setLayered), []);
  return (
    <Animated.View
      style={style}
      /**
       * KEINE Textur für die EIGENE Bewegung — der Aufbau ist mit 66ms vermessen,
       * also acht Bilder bei 120Hz, in ein Fenster von zwei bis drei. Der Klotz
       * läge im Start. Und es gäbe kaum etwas zu sparen: Während der Bewegung
       * rendert dieser Bildschirm nur Kopfzeile und Fläche, Ladeszene und Liste
       * hängen an Toren, die erst danach aufgehen.
       *
       * Wohl aber eine, solange ein Detail-Blatt DARÜBER fährt: Dann steht hier
       * die fertige Liste und wandert als Kopiervorgang mit, statt jedes Bild neu
       * gezeichnet zu werden. Angefordert wird sie beim Aufsetzen des Fingers auf
       * die Karte, gehalten vom Blatt.
       */
      collapsable={false}
      renderToHardwareTextureAndroid={Platform.OS === "android" && layered}
      pointerEvents={pointerEvents}
    >
      {children}
    </Animated.View>
  );
});

/**
 * HIER STAND DER GROSSE VERBINDUNGS-KOPF — und warum er weg ist.
 *
 * Er zeigte die Strecke in zwei Eingabefeld-Attrappen übereinander, mit einem
 * Tausch-Knopf dazwischen und darunter einer Zeile aus Trefferzahl und
 * „Ändern". Das kostete fast ein Drittel des ersten Bildschirms für Angaben,
 * die man beim Suchen selbst gemacht hat.
 *
 * An seine Stelle treten drei Dinge, die vorher in ihm steckten:
 *
 *  - `SearchSummaryBar` zeigt dieselbe Strecke auf einer Zeile, dazu Datum,
 *    Reisende und Klasse, die vorher gar nicht sichtbar waren.
 *  - Die Trefferzahl wanderte in den Kopf der LISTE (`ResultsListHeader`) und
 *    fährt beim Scrollen mit hinaus, statt fest oben zu kleben.
 *  - Der Lade-Zustand — vorher drei pulsierende Punkte in der Zähler-Pille —
 *    ist jetzt der Balken unter der Kopfzeile (`SearchProgressBar`).
 *
 * Mit ihm gingen `LoadingDots` und `pulse`, die nur er benutzt hat, sowie der
 * Tausch-Knopf samt seiner Kette aus Sperre, Zeitgeber und Freigabe. Das
 * Drehen der Strecke lebt in der Such-Slide, die beim Antippen der Zeile
 * herunterfährt — dort ohne diese Kette, weil dort erst der Such-Knopf eine
 * Anbieter-Anfrage auslöst und nicht schon der Tausch selbst.
 */

/**
 * Ergebniszahl und Sortier-Reiter — beides sitzt jetzt IM Kopf der Liste.
 *
 * Vorher standen sie an zwei verschiedenen Orten und beide fest: die Zahl als
 * Pille oben in der Kriterien-Box, die Reiter als eigene Leiste darunter. Beim
 * Scrollen blieb die Leiste stehen und belegte dauerhaft Platz, während die
 * Zahl in einer Box klebte, die den halben Bildschirmkopf einnahm.
 *
 * Sie gehören zusammen — die Zahl sagt, wie viele Treffer die gewählte
 * Sortierung gerade zeigt — und sie gehören zur Liste, nicht über sie. Als
 * Kopf der Liste fahren sie mit hinaus, sobald man die Karten hochschiebt.
 *
 * MODULEBENE und `memo`, nicht als Inline-Baum im Render der Liste: Ein
 * `ListHeaderComponent` bekommt bei jedem Durchgang ein frisches Element.
 * Solange der TYP derselbe bleibt, gleicht React ab; ein im Rumpf definierter
 * Baum wäre bei jedem Durchgang ein neuer Typ, und dann baut React den Kopf
 * nativ neu auf. Exakt die Begründung, die unten schon am Trenner steht.
 *
 * `onSort` ist der Setzer aus `useState` — dessen Kennung ist stabil, die
 * Memo-Schranke greift also wirklich.
 */
const ResultsListHeader = memo(function ResultsListHeader({
  count,
  sort,
  onSort,
  zoneHint,
}: {
  /** Die VOLLE Trefferzahl der Richtung, nicht die gerade sichtbare Seite. */
  count: number;
  sort: SortKey;
  onSort: (key: SortKey) => void;
  /** „Ortszeit (UTC+1)" — nur, wenn die Zeiten nicht der Uhr des Geräts folgen. */
  zoneHint?: string | null;
}) {
  const t = useT();
  const palette = usePalette();
  /**
   * Die Beschriftungen einmal je Sprache bauen, nicht bei jedem Bild.
   *
   * Der Kopf der Liste hängt hinter einer Memo-Schranke, aber innerhalb eines
   * Durchgangs entstünde sonst bei jedem Render eine neue Liste — und die
   * ginge als frische Kennung an ein `memo`-Bauteil, das dann jedes Mal neu
   * zeichnet.
   */
  const sortItems = useMemo(
    () => SORT_TABS.map((tab) => ({ id: tab.key, label: t(tab.labelKey) })),
    [t],
  );
  const onSortChip = useCallback((id: string) => onSort(id as SortKey), [onSort]);
  return (
    <View style={styles.listHeader}>
      {/**
        * Filter und Sortierung als zwei gleich breite Knöpfe.
        *
        * Sie stehen ÜBER der Trefferzahl und nicht neben den Reitern, und das
        * ist der Unterschied zwischen einem Knopf und einer Fußnote: Beide
        * öffnen einen eigenen Auswahlbereich, während die Reiter darunter
        * sofort umsortieren. Vorher steckte die Filter-Funktion in einem
        * 36-Punkte-Symbolknopf am rechten Ende der Reiter-Zeile — als Symbol
        * ohne Beschriftung, gedrängt neben drei Textreitern, und damit weder
        * als Knopf erkennbar noch bequem zu treffen.
        *
        * Gleich breit über `flex: 1`: Zwei Knöpfe, die dasselbe Gewicht haben,
        * sollen auch gleich aussehen — eine Breite nach Textlänge machte aus
        * „Sort" den kleineren von beiden, ohne dass er weniger wichtig wäre.
        */}
      <View style={styles.actionRow}>
        <RippleTouch style={[styles.actionBtn, { backgroundColor: palette.s2 }]}>
          <Text style={styles.actionText}>{t("results.filter")}</Text>
        </RippleTouch>
        <RippleTouch style={[styles.actionBtn, { backgroundColor: palette.s2 }]}>
          <Text style={styles.actionText}>{t("results.sort")}</Text>
        </RippleTouch>
      </View>

      {/* Die Trefferzahl als reine Zeile — sie ist eine Auskunft, kein
          Bedienelement. In einer Pille sah sie aus wie einer der Knöpfe
          daneben, und man greift danach. */}
      <Text style={styles.countText} numberOfLines={1}>
        {`${count} ${t("results.count")}${zoneHint ? ` · ${zoneHint}` : ""}`}
      </Text>

      {/**
        * Die Sortierung trägt jetzt DIESELBE Form wie die Kategorien unter
        * „Gespeichert" — Konturen statt nacktem Text mit Unterstrich.
        *
        * Beides ist dieselbe Aufgabe: „wähle eines aus dieser kurzen Liste".
        * Zwei Gestalten dafür hießen, dass der Nutzer zweimal lernen muss, was
        * er anfassen kann — und der Unterstrich sah zudem eher nach einem
        * Reiter aus, hinter dem sich eine ganze Ansicht wechselt.
        *
        * Linksbündig und mit demselben Rand wie die Karten darunter, damit die
        * erste Kontur auf deren Kante steht.
        */}
      <FilterChips
        items={sortItems}
        value={sort}
        onChange={onSortChip}
        contentPadding={0}
        style={styles.chipRow}
      />
    </View>
  );
});

interface ResultsListViewProps {
  data: SearchResult[];
  direction: "OUTBOUND" | "RETURN";
  fetchedAt: string;
  /** Wechselt nur bei einer ANDEREN Suche, nicht beim Auffrischen derselben. */
  listIdentity: string;
  /** Aktuelle Sortierung — steuert, WANN die Umsortier-Animation aktiv ist,
   *  und welcher Reiter im Kopf der Liste hervorgehoben ist. */
  sort: SortKey;
  /** Der Setzer aus `useState` — bewusst durchgereicht statt eines eigenen
   *  Rückrufs: Seine Kennung ist stabil, der Kopf der Liste bleibt damit hinter
   *  seiner Memo-Schranke. */
  onSort: (key: SortKey) => void;
  passengers: number;
  mode: TravelMode;
  isRefetching: boolean;
  refreshFresh: () => void;
  isLoadingMore: boolean;
  loadMore: () => Promise<void> | void;
  /** Wie viele Treffer INSGESAMT vorliegen (`data` ist auf visibleCount beschnitten).
   *  Liegt mehr vor als sichtbar ist, gibt es etwas aufzudecken — auch in Modi
   *  ohne Server-Pagination. */
  totalCount: number;
  accentSolid: string;
  /** Gesetzt, wenn wir für diese Suche Alternativen in der Umgebung anbieten
   *  können — dann zeigt der Leerzustand Bo und den Knopf statt nur „keine
   *  Treffer". null = normaler Leerzustand. */
  nearbyOffer: { onSearch: () => void; busy: boolean } | null;
  /** true = die Umgebungssuche lief bereits und fand ebenfalls nichts. */
  nearbyExhausted: boolean;
  tEmpty: string;
  tRetry: string;
  tLater: string;
  tMore: string;
  tLoading: string;
}

/**
 * Eine FlatList-Spalte für entweder Outbound oder Return. Wird vom Pager
 * (SlidingPanels) zweimal side-by-side gerendert. Key bindet fetchedAt
 * + direction — pro Server-Response remountet die Liste, innerhalb derselben
 * Daten läuft Sort-Reorder via itemLayoutAnimation smooth.
 */
/**
 * Trenner als STABILE Komponente, nicht als Inline-Pfeil.
 *
 * Als Inline-Funktion entstand bei jedem Render von `ResultsListView` ein neuer
 * Komponenten-TYP. React kann dann nicht abgleichen und baut jede Trenner-Ansicht
 * nativ neu auf. Das trifft öfter als gedacht, weil die Liste bei jedem
 * Eltern-Render ein frisch geschnittenes Array bekommt — die Karten fängt `memo`
 * ab, die Trenner nicht.
 */
const ListSeparator = () => <View style={{ height: 12 }} />;

function ResultsListView({
  data,
  direction,
  fetchedAt,
  listIdentity,
  sort,
  onSort,
  passengers,
  mode,
  isRefetching,
  refreshFresh,
  isLoadingMore,
  loadMore,
  totalCount,
  accentSolid,
  nearbyOffer,
  nearbyExhausted,
  tEmpty,
  tRetry,
  tLater,
  tMore,
  tLoading,
}: ResultsListViewProps) {
  const tt = useT();
  /**
   * „Ortszeit (UTC+1)" in der Zeile mit der Trefferzahl — einmal für die Liste,
   * nicht auf jeder Karte. Nur, wenn Ab- oder Ankunft nicht in der Zeit des
   * Geräts stehen (London → Paris auf einem deutschen Gerät). Liegen die Halte
   * in verschiedenen Zonen: „Ortszeit des jeweiligen Halts".
   */
  const zoneHint = useMemo(
    () =>
      localTimeHint(
        data.slice(0, 20).flatMap((r) => [r.originTz, r.destinationTz]),
        tt,
        Date.parse(data[0]?.departTime ?? "") || Date.now(),
      ),
    [data, tt],
  );
  // Mehr Treffer geladen als sichtbar? Dann kann der Footer sie lokal aufdecken.
  const hasHidden = totalCount > data.length;
  const showFooter =
    data.length > 0 && (hasHidden || mode === "TRAIN" || mode === "FLIGHT");

  // Entrance-Animation NUR für den initial sichtbaren Batch. Items die später
  // beim Scrollen in den virtualisierten Viewport mounten, sollen NICHT erneut
  // einfaden — das per-Item-FadeInDown bei jedem Scroll-Mount war eine Haupt-
  // Ursache fürs ruckelige Scrollen bei vielen Treffern. Nach einem kurzen
  // Fenster (500ms ab Mount/neuem Datensatz) rendern alle Items plain.
  // Umsortier-Animation nur rund um einen Sortier-Wechsel aktiv halten.
  //
  // itemLayoutAnimation registriert eine Layout-Animation an JEDER Zelle — also
  // auch an jeder, die beim Scrollen neu in den virtualisierten Bereich mountet,
  // obwohl es dort gar nichts umzusortieren gibt. Gebraucht wird sie nur, wenn
  // sich die Reihenfolge wirklich ändert. Sichtbar ändert sich dadurch nichts:
  // Das Umsortieren läuft weiterhin animiert, es kostet nur nicht mehr bei
  // jedem Nachladen einer Zeile.
  const [animateReorder, setAnimateReorder] = useState(false);
  const firstSortRef = useRef(true);
  useEffect(() => {
    if (firstSortRef.current) {
      firstSortRef.current = false;
      return;
    }
    setAnimateReorder(true);
    const id = setTimeout(() => setAnimateReorder(false), 450);
    return () => clearTimeout(id);
  }, [sort]);

  const enteringEnabledRef = useRef(true);
  useEffect(() => {
    enteringEnabledRef.current = true;
    const id = setTimeout(() => {
      enteringEnabledRef.current = false;
    }, 500);
    return () => clearTimeout(id);
  }, [fetchedAt, direction]);

  /**
   * DER GRUND, WARUM DER ERSTE DRUCK AUF „AUSWÄHLEN" INS LEERE GING.
   *
   * Hier standen ZWEI verschiedene Baumformen: mit Hülle, solange die
   * Einblend-Welle läuft, und ohne, sobald sie durch ist. Umgeschaltet wurde
   * über eine Ablage — die löst absichtlich kein Neu-Rendern aus, die neue Form
   * greift also erst beim nächsten Durchlauf der Liste.
   *
   * Und dieser Durchlauf kam ausgerechnet im AUFSETZEN des Fingers: Dort wird
   * die Textur der Unterlage angefordert, das setzt einen Zustand, und die Liste
   * rendert neu. Ändert sich dabei die Form des Baumes, baut React den alten ab
   * und einen neuen auf — die Karte unter dem Finger wird also mitten in der
   * Berührung ausgetauscht. Der Druck war damit verloren, `onPress` kam nie.
   *
   * Beim zweiten Mal lief es, weil die Textur schon angefordert war: kein
   * Zustandswechsel, kein Neu-Rendern, kein Austausch. Genau das Muster „der
   * erste Druck nie, der zweite immer".
   *
   * Die Hülle steht jetzt IMMER da, nur ihre Einsprung-Animation entfällt später.
   * Damit bleibt die Form über jeden Durchlauf gleich, und React tauscht nichts
   * mehr aus. Reanimated liest `entering` ohnehin nur beim Einhängen — eine
   * Zeile, die später gar nicht mehr entsteht, verliert dadurch nichts.
   */
  const renderItem = useCallback(
    ({ item, index }: { item: SearchResult; index: number }) => (
      // Dieselbe Welle wie in den Tabs (lib/motion.tsx) — vorher hatte der
      // Ergebnis-Screen ein eigenes Timing (50ms Versatz, 320ms, großer
      // FadeInDown-Weg) und fühlte sich dadurch an wie eine andere App.
      <Animated.View entering={enteringEnabledRef.current ? revealEntering(index) : undefined}>
        <ResultCard result={item} passengers={passengers} underlay="results" />
      </Animated.View>
    ),
    [passengers],
  );

  return (
    /**
     * Die Hülle hält den Abstand zum Suchkasten — und zwar FEST.
     *
     * Vorher lag er im scrollenden Inhalt (`listContent.paddingTop` plus
     * `listHeader.paddingTop`). Damit wanderte er beim Hochziehen mit nach
     * oben, und die Sortier-Knöpfe schoben sich bis auf null an die Unterkante
     * des Kastens heran — mitten durchgeschnitten, ohne einen Hauch Luft
     * dazwischen. Genau das war die Beanstandung.
     *
     * Hier liegt er am RAHMEN der Liste. Die Liste beginnt damit zwölf Punkte
     * tiefer und schneidet ihren Inhalt an ihrer eigenen Oberkante ab: Im
     * Ruhezustand sieht alles aus wie vorher, beim Scrollen bleibt der Streifen
     * frei. Die Knöpfe verschwinden weiterhin mit nach oben — das war
     * ausdrücklich gewollt —, nur eben eine Handbreit unter dem Kasten statt an
     * ihm.
     *
     * `flex: 1` MUSS hier stehen: Die Liste bekommt ihre Höhe sonst von ihrem
     * Inhalt (`flexGrow` einer ScrollView greift erst in einem Behälter, der
     * selbst eine Höhe hat), und eine Liste ohne Höhe scrollt nicht.
     */
    <View style={styles.listViewport}>
    <Animated.FlatList
      /**
       * Wer scrollt, bekommt keine Textur — sie sofort wieder abgeben.
       *
       * Die Karten dieser Liste fordern die bildschirmfüllende Ebene beim
       * AUFSETZEN des Fingers an, weil ihr Aufbau 66ms dauert und deshalb nicht
       * in den Start einer Bewegung fallen darf. Wird aus dem Aufsetzen aber ein
       * SCROLLEN, lag sie bis zu 1,4 Sekunden über einer bewegten Fläche — und
       * dort ist eine Ebene teurer als gar keine: Sie wird in jedem Bild
       * ungültig und muss neu hochgeladen werden. Ein Tipp erreicht diese Zeile
       * nie. Dieselbe Behandlung wie im Landingscreen.
       */
      onScrollBeginDrag={releaseResultsLayer}
      // Hier BEWUSST kein eigener Wert: Anders als bei den reinen Scroll-Flächen
      // hängt eine FlatList immer ihren eigenen onScroll an (Virtualisierung,
      // onEndReached, Sichtbarkeits-Buchhaltung). Die Ereignisse gehen hier also
      // nicht ins Leere, und sie zu halbieren spart nichts.
      // key an die SUCHE, nicht an den Zeitstempel der Antwort.
      //
      // Vorher stand hier fetchedAt. Der Gedanke dahinter war richtig — bei
      // einer NEUEN Suche soll die Liste frisch aufgebaut werden. Nur ändert
      // sich der Zeitstempel auch beim stillen Auffrischen alle fünf Minuten,
      // und dann baute sich die komplette Liste samt aller Karten neu auf und
      // der Scroll-Stand sprang an den Anfang. Für „still" das Gegenteil.
      // Die Suchkennung wechselt genau dann, wenn wirklich eine andere Suche
      // angezeigt wird — die ursprüngliche Absicht bleibt also erhalten.
      key={`${direction}-${listIdentity}`}
      data={data}
      keyExtractor={resultKey}
      renderItem={renderItem}
      // Virtualisierung: ohne diese Limits rendert FlatList (default windowSize
      // 21) bei ~74 Treffern praktisch ALLE Karten gleichzeitig — jede mit
      // eigenen Reanimated-SharedValues + Logo-Images. Das war die Haupt-Ursache
      // fürs Scroll-Lag. Jetzt sind nur ~2-3 Viewports an Karten gemountet.
      initialNumToRender={5}
      // Kleinere Stapel, mehr Luft dazwischen — gemessen, nicht geraten.
      //
      // Die Bild-Sonde zeigte für die Phase NACH der Slide neun lange Bilder auf
      // dem JS-Thread mit bis zu 123ms. Neun einzelne Ausreißer statt eines
      // Blocks heißt: Es ist kein einmaliges Hängen, sondern Stapel für Stapel
      // nachgeladene Karten, von denen jeder den JS-Thread am Stück belegt.
      // Sechs Karten pro Stapel sind dafür zu viel — jede bringt eigene
      // SVG-Symbole, Verläufe und Zeitformatierung mit.
      //
      // Drei pro Stapel halbiert die Länge jeder einzelnen Blockade, und die
      // längere Pause dazwischen lässt je ein Bild sauber durch. Insgesamt
      // dauert das Auffüllen minimal länger — sichtbar ist aber nicht die
      // Gesamtdauer, sondern das Stocken.
      maxToRenderPerBatch={3}
      windowSize={5}
      updateCellsBatchingPeriod={80}
      ItemSeparatorComponent={ListSeparator}
      /**
       * Trefferzahl und Sortier-Reiter fahren MIT.
       *
       * Als feste Leiste über der Liste belegten sie dauerhaft Platz, obwohl
       * man beim Scrollen die Karten sehen will. Als Kopf der Liste schieben
       * sie sich mit hinaus — und kommen beim Zurückscrollen von selbst
       * wieder.
       *
       * Ein frisches Element pro Durchgang ist hier unkritisch: `SORT_TABS` ist
       * eine Modul-Konstante, `onSort` der stabile Setzer aus `useState`, und
       * `ResultsListHeader` steht auf Modulebene unter `memo`. React gleicht
       * über den Typ ab, die Schranke fängt den Rest.
       */
      ListHeaderComponent={
        <ResultsListHeader count={totalCount} sort={sort} onSort={onSort} zoneHint={zoneHint} />
      }
      contentContainerStyle={styles.listContent}
      itemLayoutAnimation={animateReorder ? LinearTransition.duration(320) : undefined}
      refreshControl={
        <RefreshControl
          refreshing={isRefetching}
          onRefresh={() => {
            haptic("button");
            refreshFresh();
          }}
          tintColor={accentSolid}
          colors={[accentSolid]}
        />
      }
      ListEmptyComponent={
        nearbyOffer || nearbyExhausted ? (
          // Klare Ansage statt untergeschobener Alternativen: Erst sagen, dass
          // es für DIESE Strecke nichts gibt — die Umgebung nur auf Wunsch.
          <View style={styles.emptyWrap}>
            <Bo state="sad" size={138} paused />
            <Text style={styles.nearbyTitle}>{tt("results.nearby.title")}</Text>
            <Text style={styles.nearbyBody}>
              {nearbyExhausted ? tt("results.nearby.none") : tt("results.nearby.body")}
            </Text>
            {nearbyOffer ? (
              <RippleTouch
                onPress={() => {
                  haptic("button");
                  nearbyOffer.onSearch();
                }}
                disabled={nearbyOffer.busy}
                style={[styles.retryBtn, nearbyOffer.busy && { opacity: 0.6 }]}
              >
                <GradientFill />
                <Compass size={16} color={C.black} strokeWidth={2.4} />
                <Text style={styles.retryBtnText}>
                  {nearbyOffer.busy ? tt("results.nearby.searching") : tt("results.nearby.cta")}
                </Text>
              </RippleTouch>
            ) : null}
          </View>
        ) : (
          <View style={styles.emptyWrap}>
            <Text style={styles.emptyText}>{tEmpty}</Text>
            <RippleTouch
              onPress={() => {
                haptic("button");
                refreshFresh();
              }}
              style={styles.retryBtn}
            >
              <GradientFill />
              <RotateCcw size={16} color={C.black} strokeWidth={2.4} />
              <Text style={styles.retryBtnText}>{tRetry}</Text>
            </RippleTouch>
          </View>
        )
      }
      ListFooterComponent={
        // Zwei Gründe für den Footer, vorher nur einer:
        //
        // 1. Es liegen mehr Treffer vor als sichtbar sind (die Liste wird auf
        //    PAGE_SIZE=20 beschnitten). Der Button deckt sie lokal auf, ohne Netz.
        //    Das galt bisher NUR für TRAIN/FLIGHT — bei einer Bus-Suche mit 23
        //    Treffern waren die letzten drei schlicht unerreichbar, weil der
        //    Footer nie gerendert wurde. (Das Aufdecken selbst konnte
        //    handleShowMore längst — es fehlte nur der Knopf dafür.)
        // 2. Der Modus kann serverseitig nachladen (Zug: HAFAS-„später",
        //    Flug: frische Suche).
        showFooter ? (
          <View style={styles.laterWrap}>
            <RippleTouch
              onPress={loadMore}
              disabled={isLoadingMore}
              style={({ pressed }) => [styles.laterBtn, pressed && { opacity: 0.85 }]}
            >
              <GradientFill />
              <Text style={styles.laterBtnText}>
                {isLoadingMore ? tLoading : hasHidden || mode === "FLIGHT" ? tMore : tLater}
              </Text>
            </RippleTouch>
          </View>
        ) : null
      }
    />
    </View>
  );
}

const styles = scaledStyles({
  // slideRoot ist der Slide-Container — muss flex:1 + bg haben damit er den
  // ganzen Screen abdeckt während er von rechts reinslidet (sonst sieht der
  // User durch transparente Lücken den vorigen Tab).
  slideRoot: {
    // Am Root absolut statt flex:1 — als Route füllte dieser Baum den
    // Stack-Bildschirm, jetzt muss er sich seine Fläche selbst nehmen. zIndex
    // unter den Detail-Überlagerungen (200), über dem Such-Screen.
    ...StyleSheet.absoluteFillObject,
    // zIndex ordnet innerhalb der Geschwister — mehr braucht es nicht.
    //
    // Hier stand zusätzlich `elevation: 20`. Auf Android ist das mehr als eine
    // Reihenfolge: Es hebt die Ansicht auf eine eigene Ebene und lässt Android
    // einen Schatten dafür berechnen — für eine bildschirmfüllende Fläche, die
    // dauerhaft im Baum liegt. Das war ein guter Teil der Zähigkeit, die überall
    // zu spüren war.
    zIndex: 150,
    backgroundColor: C.bg,
    // Gerundete Ecken beim Reinsliden (siehe SCREEN_CORNER_RADIUS). overflow
    // clippt den Inhalt (inkl. FlatList) auf die runde Form; clipToOutline macht
    // das GPU-seitig, der Slide bleibt flüssig.
    borderRadius: SCREEN_CORNER_RADIUS,
    overflow: "hidden",
  },
  root: { flex: 1 },

  /**
   * HIER LAGEN DIE STILE DES ALTEN VERBINDUNGS-KOPFES.
   *
   * Die Kriterien-Box mit ihren zwei Feld-Attrappen, dem Tausch-Knopf und der
   * Meta-Zeile ist entfallen; ihre Maße leben in `SearchSummaryBar` weiter, wo
   * die Höhe und der Radius der EINGABEFELDER bewusst übernommen wurden — es
   * ist dieselbe Strecke, einmal zum Eingeben und einmal zum Anzeigen.
   *
   * Geblieben ist allein `rhCountText`: Die Trefferzahl steht jetzt im Kopf der
   * Liste, soll dort aber nicht plötzlich anders aussehen als vorher in der Box.
   */
  countText: {
    fontSize: 13,
    fontWeight: "600",
    color: C.gray200,
    // Abstand zu den Knöpfen darüber — derselbe Takt wie überall in diesem Kopf.
    marginTop: SPACE.md,
  },
  rhChangeBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 7,
    backgroundColor: C.surface3,
    borderRadius: 9999,
    paddingVertical: 9,
    paddingHorizontal: 15,
  },
  rhChangeText: { fontSize: 12, fontWeight: "700", color: C.text },


  // Hin/Rück-Toggle — visuell wie im Saved-Tab (Reise/Tickets-Segment):
  // dunkler Pill-Container, aktive Pille mit Lime-Background.
  dirToggleWrap: { paddingHorizontal: GUTTER, paddingTop: 12 },
  dirToggle: {
    flexDirection: "row",
    backgroundColor: "#171719",
    borderRadius: 16,
    padding: 4,
  },
  dirSeg: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  dirSegActive: {},
  dirSegText: { color: "#8E8E93", fontSize: 13, fontWeight: "500" },
  dirSegTextActive: { color: "#000000", fontSize: 13, fontWeight: "700" },

  /**
   * Der Kopf der Liste — Zahl oben, Reiter darunter.
   *
   * KEIN seitlicher Abstand: Er liegt im `contentContainerStyle` der Liste, und
   * das bringt den GUTTER bereits mit. Ein eigener käme obendrauf, und der Kopf
   * stünde um 20 Punkte eingerückt gegenüber den Karten.
   *
   * Die 12 unten sind derselbe Abstand, den auch zwei Karten untereinander
   * haben (`ListSeparator`) — der Kopf ist damit ein Element der Liste wie jedes
   * andere und nicht etwas, das darüber schwebt.
   */
  /**
   * Der Abstand zwischen Kopfzeile und Ladebalken.
   *
   * Er sitzt an einer HÜLLE und nicht am Balken selbst, weil der Balken im
   * Ruhezustand `null` liefert. Ein `marginTop` an ihm wäre dann zwar auch weg —
   * aber die Hülle macht sichtbar, dass der Platz nur existiert, solange etwas
   * darin steht. Derselbe Takt wie überall in diesem Kopf.
   */
  progressWrap: { marginTop: 12 },
  /**
   * Oben KEIN Abstand mehr — die zwölf Punkte stehen jetzt an `listViewport`.
   *
   * Hier lagen 8, und `listContent` brachte 4 mit; zusammen der Takt, in dem
   * der ganze Kopf steht. Beide scrollten mit, und genau das war falsch (siehe
   * `listViewport`). Die Summe ist unverändert 12, sie sitzt nur nicht mehr im
   * Inhalt, sondern am Rahmen.
   */
  listHeader: { paddingBottom: SPACE.md },
  /**
   * Der feste Abstand zwischen Suchkasten und Liste. Die Zahl ist die Summe der
   * beiden alten Inhalts-Polster (4 + 8) — im Ruhezustand ändert sich dadurch
   * nichts, beim Scrollen alles.
   */
  listViewport: { flex: 1, paddingTop: 12 },
  /**
   * Filter und Sortierung — zwei gleich breite Knöpfe.
   *
   * Der Radius ist der der Eingabefelder und der Kopfzeile darüber (16), nicht
   * die Pillenform der alten Zähler-Box: In dieser Zeile stehen zwei breite
   * Flächen nebeneinander, und eine volle Rundung ließe sie wie zwei Tabletten
   * wirken statt wie Knöpfe. Die Höhe ergibt sich aus Innenabstand und
   * Zeilenhöhe zu rund 42 Punkten — knapp unter der Kopfzeile darüber und
   * deutlich über der empfohlenen Mindestgröße für eine Tippfläche.
   */
  actionRow: { flexDirection: "row", gap: SPACE.md },
  actionBtn: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 16,
    paddingVertical: SPACE.md,
  },
  actionText: { fontSize: 14, fontWeight: "700", color: C.text },

  /**
   * Die Trefferzahl. Schriftgröße, Gewicht und Farbe unverändert aus der alten
   * Zähler-Pille (`rhCountText`) — es ist dieselbe Angabe, sie darf nicht
   * plötzlich anders aussehen. Weggefallen sind allein Fläche und Rundung: Als
   * Pille sah sie aus wie ein Knopf, und in einer Zeile mit zwei echten Knöpfen
   * darüber ist das eine falsche Einladung.
   */
  /**
   * Der Abstand zur Trefferzahl darüber. Derselbe Takt wie zwischen den Karten;
   * der frühere Wert (18) rechnete gegen die Kriterien-Box, die es an dieser
   * Stelle nicht mehr gibt.
   *
   * Seitlich KEIN Polster: Der Kopf der Liste trägt es schon (`listHeader`),
   * und die Knöpfe stehen damit auf derselben Kante wie die Karten darunter.
   */
  chipRow: { marginTop: 12 },

  // Oben ohne Polster: siehe `listViewport` — der Abstand gehört an den Rahmen,
  // nicht in den Inhalt, sonst scrollt er mit.
  listContent: { paddingHorizontal: GUTTER, paddingBottom: 110 },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  errorWrap: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 32,
    gap: 12,
  },
  errorIcon: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: "rgba(127,234,77,0.10)",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 4,
  },
  errorTitle: { color: C.text, fontWeight: "700", fontSize: 18, letterSpacing: -0.3 },
  errorBody: {
    color: C.sub,
    fontSize: 14,
    lineHeight: 20,
    textAlign: "center",
    marginHorizontal: 8,
  },
  errorDetail: { color: C.subDim, fontSize: 11, textAlign: "center", marginTop: -4 },
  retryBtn: {
    marginTop: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: GUTTER,
    paddingVertical: 12,
    borderRadius: 9999,
    overflow: "hidden",
  },
  retryBtnText: { color: C.black, fontWeight: "700", fontSize: 14 },
  emptyWrap: { paddingVertical: 60, alignItems: "center", gap: 14 },
  nearbyTitle: {
    fontSize: 17,
    fontWeight: "700",
    color: C.text,
    textAlign: "center",
    marginTop: 4,
  },
  nearbyBody: {
    fontSize: 13.5,
    lineHeight: 19,
    color: C.sub,
    textAlign: "center",
    paddingHorizontal: 36,
    marginTop: -6,
  },
  emptyText: { color: C.sub },

  /* „Später"-Pagination-Button am Listenende */
  laterWrap: { paddingTop: 16, paddingBottom: 8, alignItems: "center" },
  laterBtn: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 28,
    paddingVertical: 12,
    borderRadius: 9999,
    overflow: "hidden",
  },
  laterBtnText: { color: C.black, fontWeight: "800", fontSize: 14, letterSpacing: -0.1 },
});
