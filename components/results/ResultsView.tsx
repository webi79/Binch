import { useCallback, useEffect, useMemo, useRef, useState, memo, type ReactNode } from "react";
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

import {
  Train,
  Bus,
  ArrowLeftRight,
  ArrowUpDown,
  SlidersHorizontal,
  RotateCcw,
  WifiOff, Compass,
  Plane,
  PlaneTakeoff,
  PlaneLanding,
  MapPin,
  Ship,
  type LucideIcon,
} from "lucide-react-native";
import { useQuery } from "@tanstack/react-query";
import Animated, {
  FadeIn,
  FadeOut,
  LinearTransition,
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSpring,
  withTiming,
  Easing,
  runOnJS,
  useAnimatedReaction,
} from "react-native-reanimated";
import { TravelMode, SearchResult, SearchResponse } from "@/types/search";
import { searchByMode } from "@/lib/api/client";
import { ResultCard } from "@/components/results/ResultCard";
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
import { FIELD_H, GUTTER } from "@/lib/theme/spacing";
import { holdLayer, prepareLayer, releaseLayer, subscribeLayer } from "@/lib/nav/transitionLayer";
import { scaledStyles } from "@/lib/ui/compact";
import { isTransitionBusy } from "@/lib/nav/transitionBusy";

type SortKey = "cheapest" | "fastest" | "direct";

const C = {
  bg: "#1A1A1A",
  card: "#1F1F20",
  border: "#2E2E30",
  surface3: "#2A2A2C",
  text: "#FFFFFF",
  gray200: "#C8C8CC",
  sub: "#8A8A90",
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
 * Schließt den Such-Screen, sobald die Ergebnis-Liste ihn wirklich verdeckt.
 * Tut nichts, wenn gar keine Übergabe lief (z.B. Aufruf aus dem Verlauf).
 */
function finishSearchHandoff(): void {
  if (!isSearchHandoff()) return;
  endSearchHandoff();
  // silent=true: ersatzlos weg. Diese Liste deckt den Bildschirm bereits.
  useSearchStore.getState().closeSearchOverlay(true, true);
}

function sortResults(list: SearchResult[], sort: SortKey): SearchResult[] {
  const copy = [...list];
  // Gleichstand → frühere Abfahrt zuerst. Ohne Tiebreak entschiede allein die
  // (zufällige) Eingangsreihenfolge.
  const byDeparture = (a: SearchResult, b: SearchResult) =>
    Date.parse(a.departTime) - Date.parse(b.departTime);
  const byPrice = (a: SearchResult, b: SearchResult) =>
    priceForSort(a.price) - priceForSort(b.price);

  switch (sort) {
    case "fastest":
      return copy.sort((a, b) => a.durationMinutes - b.durationMinutes || byDeparture(a, b));
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
      visible
        ? {
            transform: [
              {
                // Eigene Position aus dem gemeinsamen Fortschritt; dazu der
                // Parallax, falls ein Detail-Blatt über DIESEM Screen liegt.
                translateX:
                  (1 - pushProgress(resultsPush.value)) * screenWidth +
                  overlayCover.value * screenWidth * UNDERLAY_TRAVEL_FRAC,
              },
            ],
          }
        : PARKED,
    [visible, screenWidth],
  );

  // contentReady wird unten exakt am Slide-Ende via Animations-Callback
  // gesetzt — damit start die Loader-Animation millisekundengenau dann,
  // wenn der Slide fertig ist. Kein hartcodiertes setTimeout(320) das je
  // nach Mount-Speed zu früh oder zu spät feuern könnte.
  const [contentReady, setContentReady] = useState(false);
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
      /**
       * OHNE Generation freigeben — die hier mitzugeben ist wirkungslos.
       *
       * Der Wächter in `releaseLayer` vergleicht die übergebene Generation mit
       * der aktuellen und steigt aus, wenn inzwischen jemand neu angefordert
       * hat. Dafür muss sie beim BEGINN des Vorgangs festgehalten werden — so
       * machen es das Ticket- und das Detail-Blatt. Hier wurde sie im Moment
       * der Freigabe gelesen, war also zwangsläufig gleich: Der Vergleich
       * konnte nie greifen.
       *
       * Ehrlicher ist, sie wegzulassen: Diese Stelle läuft beim Schließen der
       * Ergebnisliste, und dort SOLL die Textur der Unterlage weg. Vor dem
       * Abriss zur Unzeit schützt inzwischen der Bewegungs-Riegel im Modul.
       */
      releaseLayer("home");
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
    // Für die Dauer dieser Suche: eigene Textur an, Textur der Unterlage halten.
    // Die Textur der Unterlage wird NICHT hier angefordert.
    //
    // Hier wäre sie zu spät: Dieser Effekt läuft unmittelbar vor der Bewegung,
    // und der Aufbau einer bildschirmfüllenden Ebene ist im Projekt mit 66ms
    // vermessen (saved.tsx). Die Unterlage stünde damit still, während die Slide
    // schon läuft — genau das „der Parallax kommt zu spät".
    //
    // Sie wird stattdessen im bestätigten Tipp angefordert (RecentCard, SearchHero).
    // Das ist früh genug für den Vorlauf und spät genug, um nicht bei jeder
    // Berührung anzuspringen, die in Wirklichkeit ein Scrollen wird.
    //
    // Hier wird sie nur GEHALTEN: Solange dieser Bildschirm darüber liegt, ist die
    // Unterlage verdeckt und nicht scrollbar — die Textur kostet nichts und steht
    // für die Rückfahrt bereit. Ohne das fiele sie nach 1,4s mitten im Stehen weg.
    holdLayer("home");
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

  const handleSwap = useCallback(() => {
    // Haptik + Rotation + Spam-Lock macht die RouteHeader (doSwap) selbst; hier
    // nur noch der eigentliche Routentausch. Läuft eine rAF später (siehe
    // doSwap), damit die Rotation vor dem Query-Remount startet.
    if (!origin || !destination) return;
    const swapped = {
      origin: destination,
      destination: origin,
      originLabel: destLabel,
      destLabel: originLabel,
    };
    // Solange die Route noch aussteht, direkt im Store tauschen — `setParams`
    // würde sonst die Parameter einer FREMDEN Route umschreiben.
    const st = useSearchStore.getState();
    if (st.pendingResultsRoute) {
      st.setPendingResultsRoute({ ...st.pendingResultsRoute, ...swapped });
      st.setResultsParams({ ...(st.resultsParams ?? {}), ...swapped });
      return;
    }
    router.setParams(swapped);
  }, [router, origin, destination, originLabel, destLabel]);
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
  const searchKey = `${mode}|${origin}|${destination}|${departDate}`;
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
        queryClient.setQueryData(queryKey, fresh);
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
    const loadKey = `${mode}|${origin}|${destination}|${departDate}`;
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

  const tabs: { key: SortKey; labelKey: string }[] = [
    { key: "cheapest", labelKey: "results.sort.cheapest" },
    { key: "fastest", labelKey: "results.sort.fastest" },
    { key: "direct", labelKey: "results.sort.direct" },
  ];

  return (
    <>
    <RouteWatch onChange={setHiddenForRoute} />
    <ResultsShell
      pointerEvents={hiddenForRoute || !visible ? "none" : "auto"}
      style={[
        styles.slideRoot,
        { backgroundColor: appBg },
        slideStyle,
        // Im Ruhezustand versteckt ihn seine POSITION, nicht ein Extra-Stil.
        //
        // Steht keine Suche an, ist der Bewegungswert 0 — der Transform oben legt
        // diesen Baum damit vollständig rechts außerhalb des Bildes ab, und was
        // außerhalb liegt, zeichnet Android nicht. Das kostet nichts und ist
        // zugleich der Startpunkt der Bewegung: Beim Öffnen wird nur noch
        // geschoben, kein Layout, kein Aufbau.
        //
        // Die beiden Versuche davor waren beide falsch:
        //   • `opacity: 0` ließ den Baum im Layout und behielt seinen erhöhten
        //     Rang — eine bildschirmfüllende Ebene über allem, dauerhaft. Das
        //     kostete überall: Scrollen, Tab-Wechsel, Leiste.
        //   • `display: "none"` sparte das zwar, erzwang beim Anzeigen aber einen
        //     vollen Layout-Durchlauf des ganzen Baums — genau die Arbeit, die der
        //     Umbau loswerden sollte, und sie verschluckte die Slide.
        //
        // Nur für den Fall „andere Route liegt oben" (Karte) braucht es einen
        // Stil: Dort steht der Baum an seiner Endposition und muss weg.
        hiddenForRoute && { opacity: 0 },
      ]}
    >
      {/* Keine eigene Hintergrundfarbe: Der Rahmen darüber ist bereits
          bildschirmfüllend und deckend eingefärbt. Zwei deckende Flächen
          übereinander heißt, die GPU füllt den ganzen Bildschirm zweimal —
          jedes Bild, auch während der Bewegung. */}
      <SafeAreaView style={styles.root} edges={["top"]}>
        <RouteHeader
          mode={mode}
          fromLabel={stationLabel(originLabel)}
          toLabel={stationLabel(destLabel)}
          // An !showResults, NICHT isLoading: showResults wird bei JEDEM
          // Routenwechsel (auch Swap) auf false gesetzt und der Loader läuft
          // mindestens einen Zyklus. isLoading dagegen ist beim Swap zu einer
          // gecachten Gegenrichtung false — dann blieb der alte Zählerstand
          // stehen statt der Lade-Welle. So läuft die Welle im Header genau,
          // während unten der Such-Loader läuft.
          // `visible` MIT prüfen: Ohne das gilt beim App-Start `!showResults`
          // → true, und der Kopfbereich zeigt seinen Lade-Zustand — samt der
          // Endlos-Animation der Punkte, die dann ab Sekunde eins dauerhaft auf
          // dem UI-Thread mitläuft, obwohl nichts zu sehen ist. Seit dieser Baum
          // nicht mehr pro Suche entsteht, wäre das ein Dauerzustand.
          // `contentReady` MIT prüfen: Der Lade-Zustand war schon im ersten Render
          // true — also bevor die Bewegung überhaupt startet. Damit pulsierten
          // die drei Punkte über die volle Bewegung mit (Endlos-Schleife plus drei
          // Mapper pro Bild), und der bewegte Baum war dadurch nicht statisch.
          loading={visible && contentReady && !showResults}
          busy={visible && contentReady && !showResults}
          resultCount={sorted.length}
          accentSolid={accent.solid}
          accentSubtle={accent.subtle}
          onSwap={handleSwap}
          onChange={goBack}
        />

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

      <View style={styles.tabsRow}>
        {tabs.map((tab) => {
          const active = sort === tab.key;
          return (
            <Pressable
              key={tab.key}
              onPress={() => {
                haptic("button");
                setSort(tab.key);
              }}
              // Hitbox vergrößern, ohne die visuellen Buttons aufzublasen.
              // top/bottom großzügig (vertikaler Platz ist da), left/right
              // moderat (sonst überlappen die Hitboxen den 22px-Gap).
              hitSlop={{ top: 14, bottom: 14, left: 10, right: 10 }}
              style={styles.tabBtn}
            >
              <Text style={[styles.tabText, active && [styles.tabTextActive, { color: accent.solid }]]}>
                {t(tab.labelKey)}
              </Text>
              {active ? <View style={[styles.tabUnderline, { backgroundColor: accent.solid }]} /> : null}
            </Pressable>
          );
        })}
        <View style={styles.tabsSpacer} />
        <RippleTouch hitSlop={6} borderless style={[styles.filterBtn, { backgroundColor: palette.s2 }]}>
          <SlidersHorizontal color={C.text} size={16} />
        </RippleTouch>
      </View>

      {!showResults ? (
        // contentReady-Gate: Scene wird ERST nach Slide-End gemountet — kein
        // Mount-Cost konkurriert mit dem Slide-Worklet → buttersmoothes
        // Slide. FadeIn-Entering blendet die Scene danach sanft rein, kein
        // hartes Pop. Identisches Pattern wie DetailsOverlay's
        // contentReady-gated ScrollView.
        !contentReady ? null : (
        // exiting: Der Loader verschwand bisher HART — Boo war da, im nächsten
        // Frame stand die Liste. Genau dieser Schnitt liest sich als „Aufploppen",
        // egal wie sauber die Liste danach einblendet. Jetzt blendet er aus,
        // während die Karten von unten hochwandern: eine Bewegung, keine zwei.
        <Animated.View
          entering={FadeIn.duration(220)}
          exiting={FadeOut.duration(MOTION.duration / 2)}
          style={{ flex: 1 }}
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
 * Verbindungs-Header (vertikales Design): Abfahrt oben, Ziel darunter, eine
 * gestrichelte Route durch beide Felder, ein Akzent-Swap-Button, der die Route
 * dreht, plus Meta-Zeile mit Ergebniszahl und „Ändern".
 *
 * Übernommen aus einer externen Design-Vorlage, aber an unsere Prinzipien
 * angepasst: Akzent-System statt Lime, fontWeight statt Inter-fontFamily, alle
 * Strings über useT, Tokens fürs Spacing — und die Swap-Rotation auf Reanimated,
 * weil klassisches RN-Animated (useNativeDriver) auf der New Architecture am
 * Startwert hängen bleibt.
 */
// Marker-Mitte: Feld-paddingLeft (18) + halbe Marker-Spalte (6).
/** Symbol je Verkehrsmittel für das Start-Feld. Flüge bekommen ein eigenes
 *  Paar (startend/landend), siehe unten. */
const RH_MODE_ICON: Record<TravelMode, LucideIcon> = {
  FLIGHT: Plane,
  TRAIN: Train,
  BUS: Bus,
  CRUISE: Ship,
};

// Dauer der Swap-Icon-Drehung. Der eigentliche Routentausch startet danach,
// damit die Drehung ungestört durchläuft (siehe doSwap).
const SWAP_ROTATE_MS = 320;

/**
 * memo: Der Kopfbereich hängt an wenigen Werten, der Bildschirm darunter ändert
 * seinen Zustand aber mehrfach pro Übergang (contentReady am Slide-Ende,
 * showResults beim Eintreffen der Daten, Sortierung, Richtung). Ohne memo lief
 * dieser Baum bei JEDEM dieser Wechsel komplett neu — einer davon fällt exakt
 * auf das Ende der Bewegung.
 */
const RouteHeader = memo(function RouteHeader({
  mode,
  fromLabel,
  toLabel,
  loading,
  busy,
  resultCount,
  accentSolid,
  accentSubtle,
  onSwap,
  onChange,
}: {
  /** Bestimmt die Symbole in den beiden Feldern. */
  mode: TravelMode;
  fromLabel: string;
  toLabel: string;
  loading: boolean;
  /** Suche läuft → Swap gesperrt (Abuse-Schutz) und Button gedimmt. */
  busy: boolean;
  resultCount: number;
  accentSolid: string;
  accentSubtle: string;
  onSwap: () => void;
  onChange: () => void;
}) {
  const t = useT();
  const palette = usePalette();
  // Dieselben Symbole wie im Such-Screen: startendes und landendes Flugzeug bei
  // Flügen, sonst das Symbol des Verkehrsmittels und eine Ortsmarke.
  const FromIcon = mode === "FLIGHT" ? PlaneTakeoff : RH_MODE_ICON[mode];
  const ToIcon = mode === "FLIGHT" ? PlaneLanding : MapPin;
  // Dreht bei jedem Tausch um 180°. Reanimated, nicht RN-Animated (siehe oben).
  //
  // Timing 1:1 vom Search-Hero (SearchHero.tsx handleSwap): 320 ms easeOutCubic.
  //
  // Target über einen Ref, NICHT spin.value + 180: Bei Doppelklick während der
  // Drehung hätte spin.value einen interpolierten Zwischenwert (z.B. 90°), und
  // +180 ergäbe 270 statt 360 — die zweite Drehung ruckelte. Der Ref
  // inkrementiert immer sauber um 180.
  const spin = useSharedValue(0);
  const spinTarget = useRef(0);
  const swapIconStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${spin.value}deg` }],
  }));

  // Spam-/Abuse-Schutz: Jeder Swap löst eine echte Suche aus (Netzwerk, DB-
  // Kontingent). Ein synchrones Lock verhindert, dass man den Button schneller
  // drückt, als die Suche fertig wird — inkl. Doppel-Tap im SELBEN Frame, den
  // ein State-/Prop-Guard nicht abfängt (der aktualisiert sich erst nach dem
  // Render). Freigegeben wird erst, wenn die laufende Suche durch ist (busy →
  // false), also frühestens nach einem vollen Loader-Zyklus.
  const swapLock = useRef(false);
  /**
   * Bei JEDEM Render prüfen, nicht nur bei einem Wechsel von `busy`.
   *
   * Als Effekt mit `[busy]` lief die Freigabe nur, wenn sich der Wert ÄNDERT.
   * Steigt `onSwap` früh aus (fehlende Strecke), wechselt `busy` nie — die
   * Sperre blieb dann für immer gesetzt, und weil dieser Baum dauerhaft
   * gemountet ist, half auch kein Bildschirmwechsel mehr: Der Tausch-Knopf war
   * für den Rest der Sitzung tot. Eine Zuweisung im Render kostet nichts und hat
   * diese Lücke nicht.
   */
  if (!busy) swapLock.current = false;

  /**
   * Der Zeitgeber der Drehung — abgeräumt beim SCHLIESSEN, nicht beim Abbau.
   *
   * Hier stand eine Aufräumfunktion für den Abbau, mit genau der richtigen
   * Begründung („sonst feuert setParams auf einer schon verlassenen Route").
   * Nur wird dieser Baum seit dem Umbau nie mehr abgebaut, er wird bloß aus dem
   * Bild geschoben — die Funktion lief also nie. Wer den Tausch antippt und
   * innerhalb der 320ms zurückgeht, löste damit `router.setParams` auf einem
   * Bildschirm aus, der gerade hinausfährt: eine überflüssige, echte
   * Anbieter-Suche, und im ungünstigen Fall landen die Parameter am Home-Reiter.
   */
  const swapTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resultsOpen = useSearchStore((st) => st.resultsParams != null);
  useEffect(() => {
    if (resultsOpen) return;
    if (swapTimer.current) {
      clearTimeout(swapTimer.current);
      swapTimer.current = null;
    }
  }, [resultsOpen]);

  const doSwap = () => {
    if (swapLock.current || busy) return;
    swapLock.current = true;
    haptic("button");
    spinTarget.current += 180;
    spin.value = withTiming(spinTarget.current, {
      duration: SWAP_ROTATE_MS,
      easing: Easing.out(Easing.cubic),
    });
    // Die schwere Kette (Params-Wechsel → Query-Refetch → Boo-Loader-Mount, 33
    // Reanimated-Hooks) startet ERST NACH der Drehung. Feuert sie währenddessen,
    // jankt der Mount mitten in die Rotation („smooth, dann stockt es") — genau
    // das war das Problem. Ein rAF reichte nicht. So läuft die Rotation komplett
    // unabhängig auf dem UI-Thread, wie im Hero (der beim Swap nur leichtes
    // lokales State-Update macht). Der Preis: die Suche startet ~300 ms später —
    // unmerklich, und die Drehung liest sich ohnehin als „löst den Tausch aus".
    swapTimer.current = setTimeout(() => onSwap(), SWAP_ROTATE_MS);
  };


  return (
    <View style={[styles.routePanel, { backgroundColor: palette.s2 }]}>
      <View style={styles.rhFieldsWrap}>
        {/* Zuschnitt 1:1 wie im Such-Screen: zwei gleich hohe Felder (FIELD_H)
            mit je einem Symbol und einer Zeile. Es ist dieselbe Strecke, einmal
            zum Eingeben und einmal zum Anzeigen — sie darf nicht zweimal
            verschieden aussehen. */}
        <View style={styles.rhFields}>
          {/* Abfahrt */}
          <View style={[styles.rhField, { backgroundColor: palette.bg }]}>
            <FromIcon size={20} color={C.sub} strokeWidth={1.9} />
            <Text
              style={styles.rhStation}
              numberOfLines={1}
              adjustsFontSizeToFit
              minimumFontScale={0.65}
            >
              {fromLabel}
            </Text>
          </View>

          {/* Ziel */}
          <View style={[styles.rhField, { backgroundColor: palette.bg }]}>
            <ToIcon size={20} color={C.sub} strokeWidth={1.9} />
            <Text
              style={styles.rhStation}
              numberOfLines={1}
              adjustsFontSizeToFit
              minimumFontScale={0.65}
            >
              {toLabel}
            </Text>
          </View>
        </View>

        {/* Swap-Button — überlappt beide Felder rechts, Rand in Kartenfarbe für
            die „ausgestanzt"-Optik. Es rotiert NUR das Icon, nicht der ganze
            Button: Den umrandeten, overflow:hidden-geclippten Button pro Frame zu
            drehen zwang Android zum Neurastern (wie beim Schatten) und ruckelte —
            der Hero dreht ebenfalls nur das Icon. */}
        <View style={[styles.rhSwapWrap, busy && styles.rhSwapWrapBusy]}>
          <RippleTouch
            borderless
            onPress={doSwap}
            style={[styles.rhSwapBtn, { backgroundColor: accentSolid }]}
            accessibilityLabel={t("results.change")}
          >
            <Animated.View style={swapIconStyle}>
              <ArrowUpDown color={C.black} size={17} strokeWidth={2.6} />
            </Animated.View>
          </RippleTouch>
        </View>
      </View>

      {/* Meta-Zeile: Ergebniszahl links in einer Box, „Ändern" rechts — beide
          dieselbe Pill-Optik. */}
      <View style={styles.rhMetaRow}>
        <View style={[styles.rhCountPill, { backgroundColor: palette.s3 }]}>
          <Text style={styles.rhCountText} numberOfLines={1}>
            {loading ? t("results.searching") : `${resultCount} ${t("results.count")}`}
          </Text>
          {loading ? <LoadingDots active={loading} /> : null}
        </View>
        <RippleTouch onPress={onChange} style={[styles.rhChangeBtn, { backgroundColor: palette.s3 }]}>
          <Text style={styles.rhChangeText}>{t("results.change")}</Text>
          <ArrowLeftRight color={C.text} size={14} />
        </RippleTouch>
      </View>
    </View>
  );
});

function LoadingDots({ active = true }: { active?: boolean }) {
  const accent = useAccent();
  const a = useSharedValue(0);
  useEffect(() => {
    // Zweiter Riegel: Auch wenn der Kopfbereich einmal ohne echten Ladezustand
    // gerendert würde, läuft hier nichts los.
    if (!active) {
      cancelAnimation(a);
      return;
    }
    a.value = withRepeat(withTiming(1, { duration: 900, easing: Easing.linear }), -1, false);
    // Cleanup — sonst läuft das withRepeat-Loop weiter wenn die Component
    // unmountet. Bei jedem Search-Reload mountet/unmountet LoadingDots,
    // ohne Cancel würden die Worklets sich auf der UI-Thread stapeln.
    return () => cancelAnimation(a);
  }, [a, active]);
  const s1 = useAnimatedStyle(() => ({ opacity: 0.3 + 0.7 * pulse(a.value, 0) }));
  const s2 = useAnimatedStyle(() => ({ opacity: 0.3 + 0.7 * pulse(a.value, 0.33) }));
  const s3 = useAnimatedStyle(() => ({ opacity: 0.3 + 0.7 * pulse(a.value, 0.66) }));
  return (
    <View style={styles.dotsRow}>
      <Animated.View style={[styles.smallDot, { backgroundColor: accent.solid }, s1]} />
      <Animated.View style={[styles.smallDot, { backgroundColor: accent.solid }, s2]} />
      <Animated.View style={[styles.smallDot, { backgroundColor: accent.solid }, s3]} />
    </View>
  );
}

function pulse(t: number, phase: number): number {
  "worklet";
  const x = (t + phase) % 1;
  return Math.max(0, Math.sin(x * Math.PI));
}

interface ResultsListViewProps {
  data: SearchResult[];
  direction: "OUTBOUND" | "RETURN";
  fetchedAt: string;
  /** Wechselt nur bei einer ANDEREN Suche, nicht beim Auffrischen derselben. */
  listIdentity: string;
  /** Aktuelle Sortierung — steuert, WANN die Umsortier-Animation aktiv ist. */
  sort: SortKey;
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
    <Animated.FlatList
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
      keyExtractor={(r) => `${r.direction ?? "OUTBOUND"}-${r.id}`}
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

  routePanel: {
    backgroundColor: C.card,
    borderRadius: 24,
    marginHorizontal: GUTTER,
    marginTop: 12,
    // KEIN gap mehr: Der Abstand zur Meta-Zeile kommt allein aus deren
    // marginTop. Vorher addierten sich gap (14) UND marginTop (12) zu 26 px
    // oben, während unten nur die 16 px paddingBottom standen — der „Ändern"-
    // Button klebte sichtbar näher am unteren Rand. Jetzt rundum 16.
    padding: 16,
  },
  // ── RouteHeader (vertikales Design) ──────────────────────────────────────
  rhFieldsWrap: { position: "relative" },
  rhFields: { gap: 8 },
  rhField: {
    height: FIELD_H,
    backgroundColor: C.bg,
    borderRadius: 16,
    paddingLeft: 18,
    // Freiraum für den Tausch-Knopf rechts.
    paddingRight: 62,
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    minWidth: 0,
  },
  rhStation: {
    flex: 1,
    fontSize: 22,
    fontWeight: "800",
    letterSpacing: -0.44,
    color: C.text,
    lineHeight: 26,
  },
  rhSwapWrap: {
    position: "absolute",
    right: 10,
    top: "50%",
    marginTop: -22,
    zIndex: 3,
  },
  // Während eine Suche läuft: Swap gesperrt → sichtbar gedimmt, damit der
  // no-op-Tap nicht wie ein toter Button wirkt.
  rhSwapWrapBusy: { opacity: 0.5 },
  // Flacher Akzent-Kreis wie im Hero: backgroundColor kommt inline (accentSolid),
  // KEIN overflow:hidden und KEIN GradientFill-Kind. Genau die zwei sorgten dafür,
  // dass Android den geclippten Container jedes Mal neu compositete, wenn das Icon
  // darin rotierte — das war das Ruckeln. Der 5px-Rand in Kartenfarbe bleibt (die
  // „ausgestanzt"-Optik) und stört die Rotation nicht, weil er nichts clippt.
  rhSwapBtn: {
    // Von 54 auf 44 — derselbe Knopf wie im Such-Screen. In der Vorlage des
    // Nutzers ist er ein zurückhaltendes Element neben den Feldern, kein
    // Blickfang darüber.
    width: 44,
    height: 44,
    borderRadius: 22,
    borderWidth: 4,
    borderColor: C.card,
    alignItems: "center",
    justifyContent: "center",
  },
  rhMetaRow: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: 16,
    gap: 10,
  },
  // Ergebniszahl und „Ändern" teilen sich die Zeile hälftig: beide flex:1, also
  // gleich breit bis zur Mitte, Inhalt zentriert. Der 10-px-gap der Zeile trennt
  // sie, links und rechts hält das routePanel-Padding (16) den Rand.
  rhCountPill: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    minWidth: 0,
    backgroundColor: C.surface3,
    borderRadius: 9999,
    paddingVertical: 9,
    paddingHorizontal: 15,
  },
  rhCountText: { flexShrink: 1, fontSize: 13, fontWeight: "600", color: C.gray200 },
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

  dotsRow: { flexDirection: "row", gap: 3, marginLeft: 4 },
  smallDot: { width: 4, height: 4, borderRadius: 2 },

  // Hin/Rück-Toggle — visuell wie im Saved-Tab (Reise/Tickets-Segment):
  // dunkler Pill-Container, aktive Pille mit Lime-Background.
  dirToggleWrap: { paddingHorizontal: GUTTER, paddingTop: 12 },
  dirToggle: {
    flexDirection: "row",
    backgroundColor: "#242425",
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
  dirSegText: { color: "#8A8A90", fontSize: 13, fontWeight: "500" },
  dirSegTextActive: { color: "#000000", fontSize: 13, fontWeight: "700" },

  tabsRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: GUTTER,
    paddingTop: 18,
    paddingBottom: 12,
    gap: 22,
  },
  tabBtn: { paddingVertical: 4 },
  tabText: { color: C.sub, fontSize: 14, fontWeight: "600" },
  tabTextActive: { fontWeight: "700" },
  tabUnderline: {
    height: 2,
    borderRadius: 2,

    marginTop: 6,
  },
  tabsSpacer: { flex: 1 },
  filterBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: C.card,
    alignItems: "center",
    justifyContent: "center",
  },

  listContent: { paddingHorizontal: GUTTER, paddingTop: 4, paddingBottom: 110 },
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
