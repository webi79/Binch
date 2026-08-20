import { subscribeDetailsPreload } from "@/lib/nav/detailsPreload";
import { memo, useCallback, useEffect, useRef, useState, useMemo } from "react";
import {
  View,
  Text,
  Pressable,
  ScrollView,
  StyleSheet,
  Image,
  Linking,
  Share,
  BackHandler,
  Platform,
  useWindowDimensions,
} from "react-native";
import { markTransitionBusy } from "@/lib/nav/transitionBusy";
import { usePalette } from "@/lib/theme/appBg";
import Animated, {
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSpring,
  withTiming,
  useAnimatedReaction,
  runOnJS,
} from "react-native-reanimated";
import { SafeAreaView } from "react-native-safe-area-context";
import {
  ArrowLeft,
  ArrowRight,
  Heart,
  Share2,
  ChevronRight,
  Plane,
  Train,
  Bus,
  Ship,
  AlertTriangle,
  Award,
  Check,
  X as XIcon,
  Briefcase,
  Luggage,
  Info,
  type LucideIcon,
} from "lucide-react-native";
import { format, parseISO } from "date-fns";
import { de, enGB, es, fr } from "date-fns/locale";
import { formatTimeInZone, shiftIsoByMinutes } from "@/lib/time-format";
import { DelayedTime } from "@/components/results/DelayedTime";
import { useT } from "@/lib/i18n/useT";
import { holdLayer, layerGeneration, rearmLayer, releaseLayer } from "@/lib/nav/transitionLayer";
import { useSearchStore } from "@/stores/searchStore";
import { haptic } from "@/lib/haptics";
import {
  overlayCover,
  detailsPush,
  isDetailsPushStarted,
  setDetailsPushStopped,
  startDetailsPush,
  POP_SPRING,
  COVER_IN_SPRING,
  COVER_OUT_SPRING,
  SCREEN_CORNER_RADIUS,
} from "@/lib/nav/overlayCover";
import { usePathname } from "expo-router";
import {
  redirectUrl,
  fetchFlightBookingOptions,
  type FlightBookingOption,
} from "@/lib/api/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { RippleTouch } from "@/components/ui/RippleTouch";
import { GradientFill } from "@/components/ui/GradientFill";
import { displayCode, displayProvider, logoUrls } from "@/lib/results/logos";
import { tripSignature } from "@/lib/results/signature";
import { TravelMode, type SearchResult } from "@/types/search";
import { useAccent } from "@/lib/theme/accent";
import { scaledStyles } from "@/lib/ui/compact";

/**
 * Details-Slide als globales Overlay (Pattern wie SearchHeroOverlay).
 * Statt eine Route via router.push("/details") zu pushen — was eine native
 * Stack-Operation triggert mit React-Navigation-State-Reducer, Bridge-Roundtrip
 * und Screen-Container-Mount — wird hier nur ein Zustand-Store-Flag gesetzt.
 * Das macht den Slide-In spürbar smoother, weil der UI-Thread beim Animations-
 * Start nicht mit Navigation-Mount-Arbeit beschäftigt ist.
 */

// Brand-Palette (App-Colors statt der neonigen Mockup-Lime).
const C = {
  bg: "#1A1A1A",
  card: "#242425",
  surface: "#1F1F20",
  surface3: "#2A2A2C",
  border: "#2E2E30",
  borderSoft: "rgba(255,255,255,0.06)",
  text: "#FFFFFF",
  sub: "#8A8A90",
  subDim: "#56565C",
  lime: "#7FEA4D",
  limePressed: "#6DCC3F",
  limeSoft: "rgba(127,234,77,0.14)",
  black: "#0A0A0A",
  red: "#FF3B5C",
  alert: "#FF7A59",
  alertSoft: "rgba(255,122,89,0.14)",
};

const MODE_ICON: Record<TravelMode, LucideIcon> = {
  FLIGHT: Plane,
  TRAIN: Train,
  BUS: Bus,
  CRUISE: Ship,
};

const DATE_LOCALES = { en: enGB, de, fr, es } as const;

function formatDuration(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

/** Splittet "Berlin Hbf" → ["Berlin", "Hbf"] für visuelle Akzentuierung des
 *  Haupt-Stadt-Namens. Nur das letzte Token wird gedämpft, wenn es ein klar
 *  station-typisches Suffix ist — sonst bleibt der gesamte Name in weiß
 *  (vermeidet falsches Dämpfen bei z.B. "Paris Nord" wo "Nord" Teil des
 *  Hauptnamens ist). */
const STATION_SUFFIXES = new Set([
  "Hbf",
  "Hauptbahnhof",
  "Bahnhof",
  "Bf",
  "Bf.",
  "Centraal",
  "Centre",
  "Central",
  "Centrale",
  "Airport",
  "Flughafen",
  "Stazione",
  "Estación",
  "Gare",
]);

function splitCity(name: string): { head: string; tail: string | null } {
  const trimmed = name.trim();
  const lastSpace = trimmed.lastIndexOf(" ");
  if (lastSpace < 0) return { head: trimmed, tail: null };
  const tail = trimmed.slice(lastSpace + 1);
  const head = trimmed.slice(0, lastSpace);
  if (STATION_SUFFIXES.has(tail)) return { head, tail };
  return { head: trimmed, tail: null };
}

export function DetailsOverlay() {
  const result = useSearchStore((s) => s.selectedResult);
  const passengers = useSearchStore((s) => s.selectedPassengers);
  const clearSelectedResult = useSearchStore((s) => s.clearSelectedResult);
  const pending = useSearchStore((s) => s.selectedResultPending);
  const locale = useSearchStore((s) => s.locale);
  // Actions als stable refs aus getState() — keine Subscription-Slots
  // belegen (siehe ResultCard-Kommentar).
  const toggleSavedTrip = useSearchStore.getState().toggleSavedTrip;
  const showSavedToast = useSearchStore.getState().showSavedToast;
  const openLegTimelineOverlay = useSearchStore.getState().openLegTimelineOverlay;
  // Direct-Trip-Flow vom Stop-Sheet (Bus-Tap): umgeht den Booking-Overlay
  // komplett — LegTimelineOverlay übernimmt direkt, wir bleiben zu.
  const directTripResult = useSearchStore((s) => s.directTripResult);
  // Wo wurde das Overlay geöffnet? Wir behalten den State über Tab-Wechsel
  // hinweg — wenn der User aber auf einer anderen Route ist (z.B. „Show on
  // Map" hat ihn nach Surroundings geschickt), sollen wir uns visuell
  // verstecken statt auf der Map zu liegen. Kommt er zurück, sind Pathname
  // und Context wieder gleich → wir zeigen uns automatisch wieder an.
  const pathname = usePathname();
  const context = useSearchStore((s) => s.selectedResultContext);

  // KEEP-MOUNTED: Sobald einmal ein Result gezeigt wurde, bleibt der schwere
  // DetailsContent-Tree gemountet und wird beim nächsten Öffnen WIEDERVERWENDET
  // (nur reconciled) statt neu gemountet. Grund: jede Lucide-Icon rendert als
  // react-native-svg-View, die auf Fabric beim Unmount nicht sauber freigegeben
  // wird (~23 Views pro Öffnen/Schließen geleakt → View-Baum wächst → progressive
  // Ruckler). Ohne Re-Mount leaken wir nichts mehr und Re-Opens sind schneller.
  //
  // Die refs latchen das zuletzt gezeigte Result SYNCHRON im Render (kein Effekt-
  // Delay → kein 1-Frame-Flash des alten Results beim Re-Open).
  const lastResultRef = useRef(result);
  const lastPassengersRef = useRef(passengers);
  if (result) {
    lastResultRef.current = result;
    lastPassengersRef.current = passengers;
  }
  /**
   * Vorgebautes Ergebnis aus dem Berührungsfenster — siehe `detailsPreload`.
   *
   * Es zählt ausdrücklich NICHT als „offen": `open` unten hängt weiter allein
   * an `result` aus dem Speicher. Vorgebaut heißt gebaut und geparkt, nicht
   * sichtbar.
   */
  const [preloadResult, setPreloadResult] = useState<SearchResult | null>(null);
  useEffect(() => subscribeDetailsPreload(setPreloadResult), []);

  const displayResult = lastResultRef.current ?? preloadResult;

  // favored bezieht sich aufs ANGEZEIGTE Result — bleibt live (auch beim Slide-
  // Out), O(1) Set-Lookup statt ganzem savedTrips-Array (sonst full re-render
  // des großen Trees bei jedem Save).
  const favored = useSearchStore((s) => {
    if (!displayResult) return false;
    return s.savedTripSignatures.has(tripSignature(displayResult));
  });

  // Offen = ein Result ist selektiert und kein Direct-Trip-Flow läuft. Der
  // Route-Detour („auf Karte zeigen") versteckt nur visuell (siehe unten).
  const open = !!result && !directTripResult;
  const hiddenForRoute = context != null && pathname !== context.pathname;

  // Vor dem allerersten Öffnen: nichts rendern (null Overhead).
  if (!displayResult) return null;

  return (
    <DetailsContent
      result={displayResult}
      passengers={lastResultRef.current ? lastPassengersRef.current : passengers}
      pending={open ? pending : false}
      clearSelectedResult={clearSelectedResult}
      locale={locale}
      favored={favored}
      toggleSavedTrip={toggleSavedTrip}
      showSavedToast={showSavedToast}
      openLegTimelineOverlay={openLegTimelineOverlay}
      open={open}
      hiddenForRoute={hiddenForRoute}
    />
  );
}

interface ContentProps {
  result: NonNullable<ReturnType<typeof useSearchStore.getState>["selectedResult"]>;
  passengers: number;
  /** True solange das Result noch ein Stub aus einer Surroundings-Departure
   *  ist und die echte Search-API noch läuft. In dem Zustand zeigen wir
   *  Skeletons in der Provider-Sektion. */
  pending: boolean;
  clearSelectedResult: () => void;
  locale: "en" | "de" | "fr" | "es";
  favored: boolean;
  toggleSavedTrip: ReturnType<typeof useSearchStore.getState>["toggleSavedTrip"];
  showSavedToast: ReturnType<typeof useSearchStore.getState>["showSavedToast"];
  openLegTimelineOverlay: () => void;
  /** Store-getriebene Sichtbarkeit: true = reinsliden, false = raussliden
   *  (Tree bleibt gemountet). */
  open: boolean;
  /** Route-Detour („auf Karte zeigen" → andere Route): nur visuell verstecken
   *  OHNE die Slide neu zu triggern, damit das Zurückkommen instant ist. */
  hiddenForRoute: boolean;
}

/**
 * memo ist hier PFLICHT, kein Nice-to-have: Der Outer-Component subscribt
 * u.a. usePathname() und re-rendert bei jedem Routen-/Tab-Wechsel. Seit
 * keep-mounted hängt daran der komplette geparkte Details-Baum (hunderte
 * Elemente inkl. SVG-Icons) — ohne memo würde JEDER Tab-Wechsel den
 * unsichtbaren Baum voll re-rendern (= globale Ruckler). Alle Props sind
 * primitiv oder stabile Refs, memo greift also zuverlässig.
 */
/** Stabile leere Liste — `?? []` erzeugt sonst pro Render ein neues Array und
 *  entwertet damit jede Memoisierung, die es als Abhängigkeit hat. */
const NO_OPTIONS: never[] = [];

const DetailsContent = memo(function DetailsContent({
  result,
  passengers,
  pending,
  clearSelectedResult,
  locale,
  favored,
  toggleSavedTrip,
  showSavedToast,
  openLegTimelineOverlay,
  open,
  hiddenForRoute,
}: ContentProps) {
  const palette = usePalette();
  const t = useT();
  const accent = useAccent();
  const screenWidth = useWindowDimensions().width;

  // Geschlossen-Park-Position: +48px über den rechten Rand hinaus, damit der
  // Elevation-Schatten des off-screen gemounteten Sheets (Keep-mounted) nicht
  // am Bildschirmrand durchscheint.
  /**
   * Die Position wird nur noch ABGELESEN — geschrieben wird sie im Tipp-Handler
   * der Karte (`startDetailsPush`). Warum, steht dort.
   *
   * Der Wert läuft von 0 (draußen) bis 1 (angekommen); die Park-Position liegt
   * 48 Punkt ÜBER dem rechten Rand hinaus, damit der Schatten des dauerhaft
   * gemounteten Blattes im geschlossenen Zustand nicht am Bildschirmrand
   * durchscheint.
   */
  const parkX = screenWidth + 48;
  const slideStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: (1 - detailsPush.value) * parkX }],
    // Unsichtbar, solange es außerhalb steht oder ein Umweg über eine andere
    // Route läuft — kein Schatten-Durchscheinen im geparkten Zustand, kein
    // Aufblitzen beim Hereinfahren.
    opacity: hiddenForRoute || (1 - detailsPush.value) * parkX >= screenWidth ? 0 : 1,
  }));

  // Sichtbarkeit store-getrieben (KEEP-MOUNTED): `open` true → reinsliden,
  // false → raussliden. Der Tree bleibt gemountet, wir unmounten NICHT mehr —
  // das ist der eigentliche Leak-Fix (react-native-svg gibt SVG-Views beim
  // Unmount nicht frei). Die Bewegung startet inzwischen im Tipp-Handler der
  // Karte, nicht mehr hier über ein `requestAnimationFrame` — siehe
  // `startDetailsPush`. Der Parallax läuft im selben Aufruf mit.
  /**
   * Texturen der Flächen, die unter diesem Blatt liegen.
   *
   * Angefordert werden sie beim AUFSETZEN des Fingers auf die Karte (ResultCard,
   * `onSelectTouchStart`) — hier
   * werden sie nur GEHALTEN, solange das Blatt oben liegt, und danach wieder
   * freigegeben. `holdLayer` legt bewusst keine an: Eine Fläche, für die niemand
   * vorbereitet hat, ist auch keine, die sich gerade bewegt.
   *
   * Beide Schlüssel, weil dieselbe Karte aus zwei Flächen heraus geöffnet wird —
   * aus der Ergebnisliste und aus dem Saved-Tab. Der jeweils andere Aufruf tut
   * nichts.
   */
  const releaseUnderlayLayers = useCallback(() => {
    const gen = closingGenRef.current;
    if (!gen) return;
    closingGenRef.current = null;
    releaseLayer("results", gen.results);
    releaseLayer("saved", gen.saved);
  }, []);

  /**
   * War das Blatt zuletzt überhaupt ZU SEHEN, als es noch offen war?
   *
   * Nachgeführt nur, solange `open` gilt — im Schließ-Render bleibt damit der
   * Stand von davor stehen. Genau den braucht der Zweig unten, und zwar aus
   * einem konkreten Fehlerbild:
   *
   * Tippt man im Toast auf „Ansehen", wechselt die App in den Saved-Reiter und
   * räumt das Blatt zwei Sekunden später auf. `clearSelectedResult` löscht dabei
   * in EINEM Zug `selectedResult` UND `selectedResultContext`. Ersteres löst die
   * Rückfahrt aus — Letzteres nimmt aber genau die Bedingung weg, die das Blatt
   * bis dahin unsichtbar gehalten hat (`hiddenForRoute` braucht den Kontext).
   * Das Blatt wurde also im selben Bild wieder sichtbar und wischte danach über
   * den Saved-Reiter. Zwei Sekunden nachdem der Nutzer dort angekommen war, und
   * ohne jeden Bezug zu dem, was er gerade tat.
   *
   * War es beim Schließen ohnehin verdeckt, gibt es nichts zu zeigen: Dann wird
   * ohne Bewegung zurückgesetzt.
   */
  const wasVisibleRef = useRef(false);
  if (open) wasVisibleRef.current = !hiddenForRoute;

  const wasOpenRef = useRef(false);
  const closingGenRef = useRef<{ results: number; saved: number } | null>(null);
  useEffect(() => {
    if (open) {
      wasOpenRef.current = true;
      holdLayer("results");
      holdLayer("saved");
      return;
    }
    if (!wasOpenRef.current) return;
    wasOpenRef.current = false;
    // Fürs Zurückfahren gibt es keinen Fingerdruck. `rearmLayer` statt
    // `prepareLayer`: Es verlängert nur, was schon da ist, und legt auf der
    // Fläche, die gar nicht darunter lag, nichts Neues an.
    rearmLayer("results");
    rearmLayer("saved");
    // Stand festhalten, den die Freigabe unten meint. Tippt jemand am Ende der
    // Rückfahrt schon die nächste Karte an, fordert das eine FRISCHE Textur an —
    // und ohne diesen Vergleich räumte der Rückruf dieser Bewegung sie eine
    // Zehntelsekunde später wieder ab. Der nächste Übergang liefe dann
    // ungeschützt UND zahlte den Abbau im Berührungs-Frame.
    closingGenRef.current = {
      results: layerGeneration("results"),
      saved: layerGeneration("saved"),
    };
  }, [open]);

  const everOpenedRef = useRef(false);

  useEffect(() => {
    if (open) {
      everOpenedRef.current = true;
      // Nicht nach einem festen Bild starten, sondern sobald der JS-Thread frei
      // ist (gedeckelt). Gemessen am Ergebnis-Bildschirm: Der Commit, der den
      // Inhalt anlegt, belegt den Thread rund 80ms; ein Bild Vorlauf lag mitten
      // drin, und die Feder lief dagegen an. Nach der Umstellung fiel dort das
      // schlechteste Bild WÄHREND der Bewegung von 25ms auf 8ms — also auf den
      // Takt, ohne ein einziges verpasstes Bild. Hier gilt derselbe Aufbau.
      // Kein Warten mehr auf einen freien Thread.
      //
      // Die Begründung dafür („der Commit, der den Inhalt anlegt, belegt den
      // Thread rund 80ms") galt für Overlays, die beim Öffnen aufgebaut wurden.
      // Dieses hier bleibt dauerhaft gemountet — es gibt beim Öffnen gar keinen
      // Aufbau-Commit, auf den zu warten wäre. Die Wartezeit war damit reine
      // Latenz zwischen Finger und Bewegung, und sie hatte einen garantierten
      // Boden von zwei Bildern (die Schleife kann frühestens im zweiten rAF
      // feuern). Ein Bild Vorlauf reicht, damit die nativen Ansichten stehen.
      /**
       * Hier wurde die Bewegung GESTARTET — jetzt läuft sie längst.
       *
       * `startDetailsPush` schickt sie im Berührungs-Frame los; wenn dieser
       * Effekt dran ist, sind Speicher-Schreibvorgang, Neu-Rendern und Commit
       * schon vorbei. Es bleibt nur noch zu vermerken, dass dieses Blatt den
       * geteilten Parallax-Wert gesetzt hat — daran hängt unten die Frage, wer
       * ihn zurücknehmen darf.
       *
       * Der Notausgang darunter ist für den Fall, dass jemand das Blatt öffnet,
       * ohne über eine Karte zu gehen (Bo, eine Verknüpfung, das Wiederaufnehmen
       * nach einem Umweg). Dann hat niemand die Bewegung angestoßen, und ohne
       * ihn bliebe das Blatt für immer neben dem Sichtfeld stehen.
       */
      ownsCoverRef.current = true;
      /**
       * Beim Öffnen IMMER zurücksetzen, nicht nur am Ende der Rückfahrt.
       *
       * Gelöscht wurde die Marke bisher ausschließlich im Abschlussrückruf des
       * Schließens — und der steigt bei `finished === false` früh aus. Tippt
       * jemand mitten in der Rückfahrt schon die nächste Karte an, bricht die
       * neue Bewegung die alte ab, der Rückruf meldet „nicht fertig", und
       * `atRest` blieb auf wahr stehen. Damit hing der schwere Teilbaum wieder
       * im Berührungs-Frame im Baum und der Netz-Beobachter wurde genau dann
       * scharf, was beides ausdrücklich vermieden werden soll.
       */
      setAtRest(false);
      if (!isDetailsPushStarted()) {
        startDetailsPush();
      }
      return undefined;
    }
    /**
     * Schließen: hinausfahren + Parallax zurück — bleibt gemountet.
     *
     * Der Merker VOR der Zuweisung: Seit die Bewegung im Tipp-Handler der Karte
     * startet, kann sie laufen, ohne dass dieser Zweig sie je als „meine"
     * verbucht hat — nämlich dann, wenn das Blatt danach doch nicht aufgeht
     * (ein Direktfahrt-Ablauf schiebt sich dazwischen). Ohne diese Zeile bliebe
     * der geteilte Parallax-Wert dann auf 1 stehen, und die Ergebnisliste
     * darunter klebte dauerhaft um ihre Ausweich-Strecke verschoben.
     */
    /**
     * Nie offen gewesen — es gibt nichts zu schließen.
     *
     * Diese Wirkung läuft auch beim EINHÄNGEN, und seit das Blatt im
     * Berührungsfenster vorgebaut wird (`detailsPreload`), ist das Einhängen
     * nicht mehr identisch mit dem Öffnen. Ohne diese Sperre lief der
     * Schließ-Zweig beim Aufsetzen des Fingers los und rief `releaseUnderlayLayers()`
     * — also ausgerechnet das Abräumen der Textur, die `prepareLayer` im selben
     * Handler ein paar Anweisungen vorher angefordert hat. Der Vorbau hätte
     * gegen sich selbst gearbeitet.
     *
     * Geparkt ist der richtige Zustand ohnehin schon: `detailsPush` steht auf 0,
     * `atRest` auf falsch, kein Ausweich-Wert gehört uns.
     */
    if (!everOpenedRef.current) return undefined;

    const wasMoving = isDetailsPushStarted();
    setDetailsPushStopped();
    if (!wasVisibleRef.current) {
      // Verdeckt geschlossen — siehe wasVisibleRef. Ohne Bewegung, sonst wischt
      // es über einen Bildschirm, mit dem es nichts zu tun hat.
      detailsPush.value = 0;
      releaseUnderlayLayers();
      setAtRest(false);
      if (ownsCoverRef.current || wasMoving) {
        ownsCoverRef.current = false;
        overlayCover.value = 0;
      }
      return undefined;
    }
    /**
     * Anmelden — dieselbe Lücke wie bei der Ergebnisliste.
     *
     * Ohne sie gilt der Bildschirm während der Rückfahrt als ruhig, und die
     * aufgeschobene Arbeit (Persistenz, Sekunden-Takt, die drei
     * Leerlauf-Aufbauten) läuft hinein.
     */
    markTransitionBusy(POP_SPRING.duration);
    /**
     * EIN Bild Vorlauf, wie ihn `sheetSlide.ts` für beide Richtungen
     * vorschreibt.
     *
     * Der Ablauf bis hierher: Loslassen → Speicher schreiben → über 140
     * Selektoren wecken → Commit (darin kippt `pointerEvents` und der
     * Wurzel-Stil) → Effekt → Kurve. Ohne das Bild dazwischen lief die
     * Bewegung gegen genau diesen Commit an. Detail- und Ticket-Blatt waren
     * die einzigen beiden, denen der Vorlauf auf der Rückfahrt fehlte.
     */
    const raf = requestAnimationFrame(() => {
    detailsPush.value = withTiming(0, POP_SPRING, (finished?: boolean) => {
      "worklet";
      // Die Textur der Unterlage lebt jetzt genau so lange wie die Bewegung.
      //
      // Vorher hing ihr Abbau an der allgemeinen Obergrenze von 1,4s. Die
      // Rückfahrt dauert aber nur die Dauer von POP_SPRING — die Textur stand danach noch fast
      // eine Sekunde über einer Fläche, die längst wieder scrollbar ist, und
      // wurde mitten im Scrollen abgebaut. Das ist ein Ruckler, der zeitlich
      // nichts mehr mit dem Blatt zu tun hat und deshalb wie zufällige Trägheit
      // wirkt.
      if (!finished) return;
      runOnJS(releaseUnderlayLayers)();
      // Erst JETZT — siehe armAtRest. Der schwere Teil des Baumes verschwindet
      // damit, wenn nichts mehr in Bewegung ist.
      runOnJS(setAtRest)(false);
    });
    // Nur zurücknehmen, wenn DIESES Overlay den geteilten Wert auch gesetzt hat.
    // `screenWidth` steht in den Abhängigkeiten, also läuft dieser Zweig auch bei
    // jeder Größenänderung (Drehen, Foldable, geteilter Bildschirm) — und zöge
    // den Parallax dann auf 0, während ein ANDERES Overlay ihn gerade benutzt.
    //
    // Im SELBEN Bild wie die Kurve darüber: Beide gehören zusammen, ein
    // Versatz wäre an der Kante zu sehen.
    if (ownsCoverRef.current || wasMoving) {
      ownsCoverRef.current = false;
      overlayCover.value = withTiming(0, COVER_OUT_SPRING);
    }
    });
    return () => cancelAnimationFrame(raf);
  }, [open, screenWidth]);

  // Route-Detour („auf Karte zeigen" → andere Route): NUR den Parallax
  // zurücknehmen/wiederherstellen, OHNE die Slide neu zu triggern (translateX
  // bleibt bei 0 → Zurückkommen ist instant, kein Re-Slide-Lag). Das visuelle
  // Verstecken macht die Render-Wurzel via opacity. Erst-Mount übersprungen.
  const ownsCoverRef = useRef(false);
  const coverMounted = useRef(false);
  useEffect(() => {
    if (!coverMounted.current) { coverMounted.current = true; return; }
    if (!open) return; // Schließen erledigt der Slide-Effekt oben
    /**
     * `withTiming`, nicht `withSpring` — die Namen täuschen.
     *
     * `COVER_IN_SPRING`/`COVER_OUT_SPRING` sind längst Zeit-Konfigurationen
     * (`{ duration, easing }`); nur die Bezeichner sind von früher geblieben.
     * Eine Feder kennt kein `easing`: Der Wert wurde verworfen und stattdessen
     * mit der Vorgabe-Dämpfung gefedert — die schwingt um rund 16% über. Auf
     * dem Umweg über die Karte lief der Parallax der Unterlage also als
     * einziger nachfedernd, während alle anderen Stellen mit demselben Objekt
     * exakt landen.
     */
    overlayCover.value = withTiming(
      hiddenForRoute ? 0 : 1,
      hiddenForRoute ? COVER_OUT_SPRING : COVER_IN_SPRING,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hiddenForRoute]);

  // Beim echten Unmount (App-Teardown / Fast-Refresh) Parallax neutralisieren.
  useEffect(() => () => { overlayCover.value = 0; }, []);

  // Schließen = Store-Flag löschen → `open` wird false → Slide-Out (oben).
  const close = () => clearSelectedResult();

  useEffect(() => {
    if (Platform.OS !== "android") return;
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      // `hiddenForRoute` MIT prüfen: Beim Sprung auf die Karte bleibt dieses
      // Overlay absichtlich offen, nur unsichtbar. Ohne die Prüfung schluckte es
      // dort den Zurück-Druck — der Nutzer drückte zweimal, ohne dass etwas
      // geschah, und kam anschließend ohne seinen Overlay-Stapel zurück.
      if (!open || hiddenForRoute) return false;
      close();
      return true;
    });
    return () => sub.remove();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, hiddenForRoute]);

  // Zwei-Phasen-Render gegen Mount-Lag während des Slide-In.
  //
  // Hier stand `setTimeout(320)`. Das war doppelt daneben:
  //
  //   • Die Slide dauert PUSH_SPRING lang. Nach 320ms ist sie noch
  //     unterwegs — der Commit fiel also genau in die Bewegung, die er
  //     entlasten sollte. Ausgerechnet app/search/results.tsx verwirft diesen
  //     Ansatz namentlich („kein hartcodiertes setTimeout(320), das je nach
  //     Mount-Speed zu früh oder zu spät feuern könnte").
  //   • Der Zeitgeber hängt am MOUNT. Dieser Baum bleibt aber gemountet, also
  //     lief er genau einmal im Leben der App; ab dem zweiten Öffnen gab es gar
  //     kein Gate mehr.
  //
  // Jetzt hängt es am Ende der Bewegung — einmal freigegeben, bleibt es frei
  // (der Baum steht ja weiter).
  /**
   * Steht das Blatt STILL?
   *
   * Hier hing beides an `contentReady`: Der Wert fiel bei halbem Weg und blieb
   * danach für immer wahr, weil der Baum dauerhaft steht. Für einen Netzabruf
   * und für einen schweren Teilbaum taugt das nicht — beim zweiten und jedem
   * weiteren Öffnen war er längst wahr, beides lief also schon im
   * Berührungs-Frame los: die Anfrage, das Einhängen der Anbieter-Karten und
   * deren Dauerschleifen auf dem UI-Strang.
   *
   * Dieser Wert folgt stattdessen der Bewegung. Er ist nur im Stillstand wahr,
   * beim ersten wie beim hundertsten Mal.
   */
  const [atRest, setAtRest] = useState(false);
  /**
   * NUR die steigende Flanke, und die zwei Bilder verzögert.
   *
   * Vorher meldete diese Stelle auch das Losfahren — `atRest` fiel damit im
   * ERSTEN Bild der Rückfahrt auf falsch und riss den schweren Teil des Baumes
   * mitten in der Bewegung wieder heraus. Das erklärt, warum das Zurückfahren
   * schlechter lief als das Hereinfahren. Zurückgesetzt wird jetzt am ENDE der
   * Rückfahrt, im Abschluss-Rückruf weiter unten — dann bewegt sich nichts mehr.
   *
   * Die zwei Bilder Abstand sind der zweite Teil: Der Rückruf kommt zwar mit dem
   * letzten Wert, die Komposition dieses Bildes kann aber noch offen sein. Der
   * Commit, der die Anbieter-Karten einhängt, fiele sonst genau hinein.
   */
  const armAtRest = useCallback(() => {
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        // In den zwei Bildern kann schon wieder geschlossen worden sein — dann
        // hinge der schwere Teilbaum ausgerechnet in die Rückfahrt hinein.
        if (isDetailsPushStarted()) setAtRest(true);
      }),
    );
  }, []);
  useAnimatedReaction(
    () => detailsPush.value >= 0.999,
    (v, prev) => {
      if (v && prev === false) runOnJS(armAtRest)();
    },
  );
  // Der zweite Mapper hier ist ersatzlos entfallen. Er las den Fortschritt in
  // JEDEM Bild, um bei halbem Weg einmal `contentReady` zu setzen — ein
  // vollflächiger Auswerter pro Bild für ein einziges Ereignis. `atRest` oben
  // beantwortet dieselbe Frage besser und braucht nur die eine Flanke.

  const dateLocale = DATE_LOCALES[locale] ?? enGB;
  const carrier = displayProvider(result);
  // Memoisiert, sonst ist es bei jedem Render ein NEUES Array — und damit eine
  // Abhängigkeit, die jedes Memo darunter wertlos macht.
  const urls = useMemo(() => logoUrls(result, carrier), [result, carrier]);
  const [logoIdx, setLogoIdx] = useState(0);
  const ModeIcon = MODE_ICON[result.mode] ?? Plane;
  // `favored` kommt jetzt als primitive Prop vom Outer-Component — der
  // benutzt einen boolean-Selector damit der DetailsOverlay nur re-rendert
  // wenn sich der favored-Status DES AKTUELLEN Result ändert, nicht bei
  // jeder savedTrips-Mutation.
  const isDirect = result.stops === 0;
  const stopVia = !isDirect && result.stopLabels?.length ? result.stopLabels[0] : null;
  const stopLabel =
    result.stops === 0
      ? t("details.stop.zero")
      : result.stops === 1
      ? t("details.stop.one")
      : t("details.stop.many").replace("{count}", String(result.stops));
  const dateStr = (() => {
    try {
      return format(parseISO(result.departTime), "d. MMM", { locale: dateLocale });
    } catch {
      return "";
    }
  })();
  // TZ-bewusst: Flüge speichern "floating local time" mit originTz/destinationTz
  // = "UTC" → formatTimeInZone zeigt die Wall-Clock verbatim (kein +2h-Bug).
  // Züge/Busse mit echter IANA-Zone werden korrekt in ihrer Zone angezeigt;
  // ohne Zone fällt formatTimeInZone auf Geräte-Lokalzeit zurück (= alt).
  const departTime = (() => {
    try {
      return formatTimeInZone(result.departTime, result.originTz);
    } catch {
      return "";
    }
  })();
  const arriveTime = (() => {
    try {
      return formatTimeInZone(result.arriveTime, result.destinationTz);
    } catch {
      return "";
    }
  })();
  // Verspätung: neue Ist-Zeit klein über der durchgestrichenen Fahrplanzeit.
  const departDelayedStr =
    (result.departDelayMinutes ?? 0) > 0
      ? formatTimeInZone(shiftIsoByMinutes(result.departTime, result.departDelayMinutes!), result.originTz)
      : undefined;
  const arriveDelayedStr =
    (result.arriveDelayMinutes ?? 0) > 0
      ? formatTimeInZone(shiftIsoByMinutes(result.arriveTime, result.arriveDelayMinutes!), result.destinationTz)
      : undefined;

  const originName = result.originLabel?.split(",")[0]?.trim() || displayCode(result.origin) || result.origin;
  const destName = result.destLabel?.split(",")[0]?.trim() || displayCode(result.destination) || result.destination;

  const paxKey = passengers === 1 ? "details.passenger.one" : "details.passenger.many";
  const paxLabel = t(paxKey).replace("{count}", String(passengers));
  const classLabel = result.mode === "FLIGHT" ? t("search.class.economy") : t("search.class.second");

  const isFlight = result.mode === "FLIGHT";
  const bookingToken = result.bookingToken;
  const queryClient = useQueryClient();
  const optionsQuery = useQuery({
    queryKey: ["flightBookingOptions", bookingToken, result.currency, passengers, locale],
    queryFn: () =>
      fetchFlightBookingOptions({
        token: bookingToken!,
        origin: result.origin,
        destination: result.destination,
        departDate: result.departTime.slice(0, 10),
        passengers,
        currency: result.currency.toUpperCase(),
        lang: locale,
        searchPrice: result.price,
      }),
    /**
     * Zwei Riegel, und der zweite ist neu.
     *
     * `open`: Geparkt (dauerhaft gemountet, aber zu) soll kein Beobachter aktiv
     * sein und nichts nachladen.
     *
     * `atRest`: erst NACH der Bewegung. Ohne das wurde der Beobachter in
     * dem Moment scharf, in dem das Blatt losfährt — und wenn der Server schnell
     * antwortet (oder das Vorabholen aus der Karte gerade eintrifft), landet die
     * Antwort mitten in der Fahrt: eine Antwort auf dem JS-Thread zerlegen,
     * Zwischenspeicher schreiben, diesen Baum neu rendern, alles in denselben
     * Bildern, in denen die Bewegung laufen soll. Dieselbe Begründung steht
     * ausführlich am Suchlauf des Ergebnis-Bildschirms; dort war es derselbe
     * Fehler. Das Vorabholen im Tipp-Handler der Karte bleibt — die Daten sind
     * also meist schon da und werden hier nur noch abgeholt.
     */
    enabled: open && atRest && isFlight && !!bookingToken,
    staleTime: 5 * 60_000,
    retry: 1,
  });
  const remoteOptions = optionsQuery.data?.options ?? NO_OPTIONS;

  useEffect(() => {
    return () => {
      if (bookingToken) {
        queryClient.removeQueries({
          queryKey: ["flightBookingOptions", bookingToken, result.currency, passengers, locale],
          exact: true,
        });
      }
    };
  }, [queryClient, bookingToken, result.currency, passengers, locale]);

  const bookUrl = result.redirectToken
    ? redirectUrl(result.redirectToken, locale)
    : result.deepLink || "";

  const flightOptionsLoading = isFlight && !!bookingToken && optionsQuery.isLoading;

  // Memoisiert: map + sort + Mutation liefen bei JEDEM Render — und dieser Baum
  // bleibt seit keep-mounted dauerhaft stehen, rendert also bei jedem
  // Query-Zustand, jedem Logo-Fehlschlag und jedem Theme-/Sprachwechsel neu.
  const providerList: ProviderRow[] = useMemo(() => {
    if (isFlight && remoteOptions.length > 0) {
      const rows = remoteOptions.map((o) => toProviderRow(o, bookUrl));
      // Kein Infinity: zwei preislose Anbieter ergäben `Infinity - Infinity` = NaN,
      // und ein NaN-Comparator sortiert undefiniert (Reihenfolge beliebig).
      // Endlicher Wert → preislose vergleichen gleich, der stabile Sort erhält
      // die Anbieter-Reihenfolge.
      const price = (p?: number) => (p != null ? p : Number.MAX_SAFE_INTEGER);
      rows.sort((a, b) => price(a.price) - price(b.price));
      if (rows.length > 1 && rows[0]!.price !== undefined) rows[0]!.recommended = true;
      return rows;
    }
    if (flightOptionsLoading) return [];
    return [
      {
        name: carrier,
        url: bookUrl,
        price: result.price,
        currency: result.currency,
        logo: urls[0],
        isAirline: result.mode === "FLIGHT",
        support: true,
        carryOn: true,
        checked: result.mode !== "FLIGHT",
      },
    ];
  }, [
    isFlight,
    remoteOptions,
    bookUrl,
    flightOptionsLoading,
    carrier,
    result.price,
    result.currency,
    result.mode,
    urls,
  ]);

  const providerCount = providerList.length;
  const providerCountLabel =
    providerCount === 1
      ? t("details.providers.count.one")
      : t("details.providers.count.many").replace("{count}", String(providerCount));
  const pricesLabel = t("details.providers.prices").replace("{currency}", result.currency.toUpperCase());

  async function onShare() {
    haptic("button");
    try {
      await Share.share({
        title: `${result.originLabel} → ${result.destLabel}`,
        message: `${carrier} · ${result.currency} ${result.price.toFixed(0)} — ${bookUrl}`,
        url: bookUrl,
      });
    } catch {
      /* ignore */
    }
  }

  function onClose() {
    haptic("button");
    close();
  }

  function onToggleFav() {
    haptic("button");
    // toggleSavedTrip löst den Save-Toast intern aus (batched in einem
    // set() — sonst zwei Render-Wellen pro Save).
    toggleSavedTrip(result, passengers);
  }

  const currentLogoUrl = urls[logoIdx];

  /**
   * Der Stil der Wurzel EINMAL, nicht bei jedem Durchgang neu.
   *
   * Hier standen drei Objekt-Literale und ein Array-Literal auf genau dem
   * Knoten, den Reanimated Bild für Bild beschreibt — und dieser Bildschirm
   * rendert während der Fahrt mehrfach (Logo-Wechsel, `atRest`, Speicher).
   * Auf Fabric ist jedes davon ein Commit gegen die laufende Bewegung.
   *
   * `elevation` bleibt an `atRest` geknüpft: Dauerhaft gesetzt verlangt es von
   * Android auf einer bildschirmfüllenden Ansicht mit Rundung und Beschnitt in
   * JEDEM Bild einen Schattenpass — auch im Ruhezustand, in dem gescrollt wird.
   * Gebraucht wird er nur, während die Kante über die Unterlage läuft.
   *
   * `backgroundColor` ist dabei PFLICHT, nicht Deko: Ohne ihn berechnet Android
   * die Schatten-Kontur aus den eckigen Grenzen, und ein eckiger Schatten füllt
   * die runde Aussparung mit einem dunklen Quadrat — die Ecke WIRKT dann beim
   * Herausgleiten wieder eckig.
   */
  const sheetChrome = useMemo(
    () => ({
      backgroundColor: palette.bg,
      borderRadius: SCREEN_CORNER_RADIUS,
      overflow: "hidden" as const,
    }),
    [palette.bg],
  );
  const sheetRank = useMemo(
    // Höher als das Halt-Blatt (zIndex 100, elevation 16), damit dieses Blatt
    // ganz vorne liegt, wenn es aus dem Umgebungs-Blatt heraus geöffnet wird.
    () => ({ zIndex: 200, elevation: atRest ? 0 : 24 }),
    [atRest],
  );
  const sheetStyle = useMemo(
    () => [StyleSheet.absoluteFill, sheetRank, sheetChrome, slideStyle],
    [sheetRank, sheetChrome, slideStyle],
  );

  const origin = splitCity(originName);
  const destination = splitCity(destName);

  return (
    <Animated.View
      pointerEvents={open && !hiddenForRoute ? "auto" : "none"}
      style={sheetStyle}
    >
      <SafeAreaView style={[styles.root, { backgroundColor: palette.bg }]} edges={["top"]}>
        {/* Header: runde 40×40-Icon-Buttons, Heart wird beim Save komplett
            lime mit schwarzem Icon (kräftigeres Visual als nur Heart-Fill). */}
        <View style={styles.header}>
          <View style={styles.headerLeft}>
            <RippleTouch onPress={onClose} hitSlop={6} style={[styles.roundBtn, { backgroundColor: palette.s2 }]}>
              <ArrowLeft color={C.text} size={20} strokeWidth={2} />
            </RippleTouch>
            <Text style={styles.title} numberOfLines={1}>
              {t("details.title")}
            </Text>
          </View>
          <View style={styles.headerRight}>
            <RippleTouch onPress={onShare} hitSlop={6} style={[styles.roundBtn, { backgroundColor: palette.s2 }]}>
              <Share2 color={C.text} size={18} strokeWidth={2} />
            </RippleTouch>
            <RippleTouch
              onPress={onToggleFav}
              hitSlop={6}
              style={[styles.roundBtn, { backgroundColor: palette.s2 }]}
            >
              <Heart
                color={favored ? C.red : C.text}
                fill={favored ? C.red : "transparent"}
                size={18}
                strokeWidth={2}
              />
            </RippleTouch>
          </View>
        </View>

        <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
          {/* Route-Card */}
          <View style={[styles.routeCard, { backgroundColor: palette.s2 }]}>
            <View style={{ gap: 10 }}>
              <CityRow head={origin.head} tail={origin.tail} />
              <View style={styles.dividerSoft} />
              <CityRow head={destination.head} tail={destination.tail} />
            </View>

            <View style={styles.metaRow}>
              <Text style={[styles.metaText, styles.metaTextStrong]}>{dateStr}</Text>
              <MetaDot />
              <Text style={styles.metaText}>{paxLabel}</Text>
              <MetaDot />
              <Text style={styles.metaText}>{t("details.oneway")}</Text>
              <MetaDot />
              <Text style={styles.metaText}>{classLabel}</Text>
            </View>

            <View style={styles.dividerSoft} />

            {/* Transport-Row: Lime-Badge mit Mode-Icon (oder Provider-Logo) +
                Abfahrt → Ankunft + via + Stops/Duration rechts. */}
            <View style={styles.trainRow}>
              <View style={styles.trainBadge}>
                {currentLogoUrl ? (
                  <Image
                    key={currentLogoUrl}
                    source={{ uri: currentLogoUrl }}
                    style={styles.trainBadgeLogo}
                    resizeMode="contain"
                    onError={() => setLogoIdx((i) => i + 1)}
                  />
                ) : (
                  <ModeIcon color={C.text} size={28} strokeWidth={1.8} />
                )}
              </View>
              <View style={{ flex: 1, minWidth: 0 }}>
                {/* Pending = Stub-Result von Surroundings-Departure-Tap: depart
                    und arrive sind beide dieselbe Planzeit, würde sonst
                    "16:15 → 16:15" anzeigen. Stattdessen Em-Dash bis das echte
                    Result da ist. */}
                <View style={styles.trainTimeRow}>
                  <DelayedTime scheduled={departTime} delayed={departDelayedStr} style={styles.trainTime} />
                  <Text style={styles.trainTimeDash}> → </Text>
                  <DelayedTime
                    scheduled={pending ? "—" : arriveTime}
                    delayed={pending ? undefined : arriveDelayedStr}
                    style={styles.trainTime}
                  />
                </View>
                {stopVia ? (
                  <Text style={styles.trainVia} numberOfLines={1}>
                    via {stopVia}
                  </Text>
                ) : (
                  <Text style={styles.trainVia} numberOfLines={1}>
                    {carrier}
                  </Text>
                )}
              </View>
              <View style={{ alignItems: "flex-end" }}>
                {/* Stops + Duration sind im Pending-Stub beide 0 / "Direkt" —
                    auch hier Em-Dash bis die echten Daten da sind. */}
                <Text style={[isDirect ? styles.stopsTextDirect : styles.stopsText, isDirect && { color: accent.solid }]}>
                  {pending ? "—" : stopLabel}
                </Text>
                <Text style={styles.durationText}>
                  {pending ? "—" : formatDuration(result.durationMinutes)}
                </Text>
              </View>
            </View>

            {/* Details-anzeigen Ghost-Button — im Pending-State versteckt
                weil noch keine Legs/Stopovers da sind, der LegTimelineOverlay
                hätte nichts zum Anzeigen. */}
            {!pending ? (
              <RippleTouch
                onPress={() => {
                  haptic("button");
                  openLegTimelineOverlay();
                }}
                style={[styles.detailsBtn, { borderColor: accent.solid }]}
              >
                <Text style={[styles.detailsBtnLabel, { color: accent.solid }]}>{t("details.viewdetails")}</Text>
                <ArrowRight size={15} color={accent.solid} strokeWidth={2.5} />
              </RippleTouch>
            ) : null}
          </View>

          {/*
            An `atRest`, nicht mehr an einem Wert, der bei halbem Weg fällt.
            
            Der alte Riegel wurde bei 50% freigegeben und blieb danach für immer
            offen. Das hatte zwei Folgen, und beide waren schlecht: Beim ersten Öffnen
            entstand dieser ganze Teilbaum MITTEN in der Bewegung — die einzige
            Stelle, an der während der Fahrt überhaupt neues Layout gerechnet
            wird. Und ab dem zweiten Öffnen war er dauerhaft da, das bewegte
            Blatt also bei jeder weiteren Fahrt entsprechend größer und teurer
            pro Bild.
            
            `atRest` gilt nur im Stillstand: Während der Fahrt fährt nur der Kopf
            samt Routenkarte mit, der Rest kommt danach. Beim Schließen bleibt er
            bis zum Ende stehen (siehe oben) — herausgerissen wird nichts,
            während man zusieht.
          */}
          {atRest ? (
            <>
              {!isDirect && !pending ? (
                <>
                  <SectionHeader title={t("details.goodtoknow")} />
                  <View style={styles.sectionContent}>
                    <View style={[styles.infoRow, { backgroundColor: palette.s2 }]}>
                      <View style={styles.infoBadge}>
                        <AlertTriangle color={C.alert} size={16} strokeWidth={2.4} />
                      </View>
                      <View style={{ flex: 1, minWidth: 0 }}>
                        <Text style={styles.infoTitle}>{t("details.selftransfer.title")}</Text>
                        <Text style={styles.infoSubtitle} numberOfLines={2}>
                          {t("details.selftransfer.sub")}
                        </Text>
                      </View>
                      <ChevronRight size={18} color={C.sub} strokeWidth={2} />
                    </View>
                  </View>
                </>
              ) : null}

              <SectionHeader
                title={t("details.bookticket")}
                caption={
                  flightOptionsLoading ? pricesLabel : `${providerCountLabel} · ${pricesLabel}`
                }
              />
              <View style={styles.sectionContent}>
                {/* Skeletons solange entweder der Surroundings-Stub noch die
                    echte Search-API abwartet (`pending`) ODER die Flug-Buchungs-
                    Optionen noch laden (`flightOptionsLoading`). In beiden Fällen
                    kennen wir noch keine echten Preise — wir zeigen bewusst
                    KEINEN Schätzpreis, sonst springt er beim Reinkommen der
                    realen Optionen. Sobald die echten Provider da sind (oder ein
                    ehrlicher Single-Provider-Fallback), switcht's auf die Cards. */}
                {pending || flightOptionsLoading ? (
                  <>
                    <ProviderCardSkeleton />
                    <ProviderCardSkeleton />
                    <ProviderCardSkeleton />
                  </>
                ) : (
                  <>
                    {providerList.map((p, i) => (
                      <ProviderCard key={`${p.name}-${i}`} provider={p} t={t} />
                    ))}
                  </>
                )}
              </View>
            </>
          ) : null}
        </ScrollView>
      </SafeAreaView>
    </Animated.View>
  );
});

interface ProviderRow {
  name: string;
  /** URL die direkt mit Linking.openURL geöffnet wird. Bei Flight-Optionen
   *  zeigt sie auf unseren Redirect-Endpoint der den Provider-Token
   *  auflöst und zum Anbieter weiterleitet. */
  url: string;
  price?: number;
  currency?: string;
  /** Logo-URL. Bei Flight-Optionen ableiten wir's aus der Anbieter-Domain
   *  via Google's S2-Favicon-Service — kein RapidAPI-Call nötig. */
  logo?: string;
  /** True bei direkter Airline-Buchung (Eurowings, Lufthansa, …), False
   *  bei OTA (Expedia, Kiwi, Booking, …). Steuert Heuristiken für
   *  Service/Gepäck wenn keine echten Daten vorliegen. */
  isAirline?: boolean;
  /** Wird auf den günstigsten Provider automatisch gesetzt. */
  recommended?: boolean;
  /** 24/7 Kundenservice? Per Heuristik wenn keine echten Daten da. */
  support?: boolean;
  /** Handgepäck im Tarif inkludiert. */
  carryOn?: boolean;
  /** Aufgegebenes Gepäck im Tarif inkludiert. */
  checked?: boolean;
}

/** Bekannte OTAs mit 24/7 Kundenservice — Heuristik solange wir keine
 *  echten Service-Daten vom Provider haben. */
const SUPPORT_24_7_OTAS = new Set([
  "expedia",
  "booking",
  "booking.com",
  "kiwi",
  "kiwi.com",
  "trip.com",
  "edreams",
  "opodo",
  "bravofly",
  "priceline",
  "cheaptickets",
  "lastminute.com",
  "fluege.de",
  "kayak",
]);

function hasSupport24_7(providerName: string): boolean {
  const key = providerName.toLowerCase().replace(/\s+/g, "");
  for (const k of SUPPORT_24_7_OTAS) {
    if (key.includes(k.replace(/\s+/g, ""))) return true;
  }
  return false;
}

function toProviderRow(o: FlightBookingOption, fallbackUrl: string): ProviderRow {
  return {
    name: o.name,
    // Serverseitig aufgelöster Direkt-Deeplink (führt zum echten Website-Preis,
    // der auch in o.price steht). Falls die Auflösung serverseitig fehlschlug,
    // NICHT den token-basierten /booking-url-Endpoint nehmen — dessen Token ist
    // beim Tap meist abgelaufen → „token may be expired"-Error. Stattdessen der
    // allgemeine Redirect (landet auf dem Flug bei Google Flights statt Error).
    url: o.resolvedUrl ?? fallbackUrl,
    price: o.price,
    currency: o.currency,
    logo: o.website ? `https://www.google.com/s2/favicons?sz=64&domain=${o.website}` : undefined,
    isAirline: o.isAirline,
    // Airline-Direct-Buchungen haben i.d.R. Carry-On & Service inkludiert,
    // OTA-Cheap-Fares oft nur Carry-On, kein Aufgegebenes.
    support: o.isAirline ? true : hasSupport24_7(o.name),
    carryOn: true,
    checked: o.isAirline === true,
  };
}

/** 2-Letter-Code für die Provider-Logo-Box wenn kein echtes Logo verfügbar ist. */
function providerCode(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9]+/g, " ").trim();
  if (!cleaned) return "?";
  const parts = cleaned.split(/\s+/);
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
}

/** Heuristische BG-Farbe pro Provider — DB-Rot für Bahn, Lime für Standard,
 *  bunt für die geläufigen OTAs. Damit hat jede Card visuell Wiedererkennung. */
function providerColor(name: string): string {
  const n = name.toLowerCase();
  if (n.includes("expedia")) return "#FFC107";
  if (n.includes("kiwi")) return "#00A991";
  if (n.includes("trip.com") || n.includes("trip ")) return "#287DFA";
  if (n.includes("booking")) return "#003580";
  if (n.includes("opodo")) return "#FF6900";
  if (n.includes("kayak")) return "#FF690F";
  if (n.includes("flix")) return "#73D700"; // FlixBus-Grün
  if (n.includes("bahn") || n.includes("db ") || n === "db") return "#E0394A"; // DB-Rot
  return "#7FEA4D";
}

function CityRow({ head, tail }: { head: string; tail: string | null }) {
  return (
    <Text style={styles.cityText} numberOfLines={1}>
      {head}
      {tail ? <Text style={styles.cityTail}> {tail}</Text> : null}
    </Text>
  );
}

function MetaDot() {
  return <View style={styles.metaDot} />;
}

function ProviderCard({
  provider,
  t,
}: {
  provider: ProviderRow;
  t: (key: string) => string;
}) {
  const accent = useAccent();
  const palette = usePalette();
  // Wenn das Logo-Bild fehlerhaft lädt, fallen wir nach dem onError auf
  // den 2-Letter-Code-Fallback zurück. Verhindert dass die Provider-Card
  // mit einer leeren transparenten Logo-Box endet.
  const [logoErrored, setLogoErrored] = useState(false);
  async function onBook() {
    if (!provider.url) return;
    haptic("important");
    // KEIN canOpenURL-Gate: für http(s) liefert es auf Android (queries-
    // Restriktion) manchmal fälschlich false → Button täte dann still gar
    // nichts. openURL direkt versuchen, Fehler schlucken.
    try {
      await Linking.openURL(provider.url);
    } catch {
      /* ignore */
    }
  }
  // Wenn ein Logo vorhanden ist: transparent rendern, damit die Favicon-PNG
  // (oft mit eigenem Hintergrund) ohne farbigen Rahmen daherkommt. Nur beim
  // Fallback ohne Logo nutzen wir die brand-getönte Box mit 2-Letter-Code.
  const hasLogo = !!provider.logo && !logoErrored;
  const bgColor = hasLogo ? "transparent" : providerColor(provider.name);
  const usesDarkText = bgColor === "#FFC107" || bgColor === "#7FEA4D";
  const isRec = provider.recommended === true;
  const showSupport = provider.support === true;
  const showBaggage = provider.carryOn !== undefined || provider.checked !== undefined;
  return (
    <View
      style={[
        styles.providerCard,
        { backgroundColor: palette.s2 },
        isRec && styles.providerCardRecommended,
        isRec && { borderColor: accent.solid },
      ]}
    >
      {/* Empfohlener-Anbieter-Pille oben — nur beim günstigsten Provider. */}
      {isRec ? (
        <View style={styles.recommendedRow}>
          <View style={[styles.recommendedBadge, { backgroundColor: accent.solid }]}>
            <Award size={13} color={C.black} strokeWidth={2.4} />
            <Text style={styles.recommendedText}>{t("details.recommended")}</Text>
            <Info size={12} color="rgba(0,0,0,0.55)" strokeWidth={2} />
          </View>
        </View>
      ) : null}

      <View style={styles.providerHeader}>
        <View style={styles.providerLeft}>
          <View style={[styles.providerLogo, { backgroundColor: bgColor }]}>
            {hasLogo ? (
              <Image
                source={{ uri: provider.logo! }}
                style={styles.providerLogoImg}
                resizeMode="contain"
                onError={() => setLogoErrored(true)}
              />
            ) : (
              <Text
                style={[styles.providerLogoText, usesDarkText ? styles.providerLogoTextDark : null]}
              >
                {providerCode(provider.name)}
              </Text>
            )}
          </View>
          <View style={{ minWidth: 0, flex: 1 }}>
            <Text style={styles.providerName} numberOfLines={1}>
              {provider.name}
            </Text>
            <Text style={styles.providerNote} numberOfLines={1}>
              {provider.isAirline ? t("details.providernote.airline") : t("details.providernote")}
            </Text>
          </View>
        </View>
        <View style={{ alignItems: "flex-end" }}>
          <Text style={styles.priceLabel}>{t("details.priceprefix")}</Text>
          <Text style={[styles.priceValue, { color: accent.solid }]}>
            {provider.price !== undefined && provider.price > 0
              ? `${provider.price.toFixed(0)} ${(provider.currency ?? "EUR").toUpperCase()}`
              : "—"}
          </Text>
        </View>
      </View>

      {/* 24/7-Service Pille — nur wenn der Anbieter dafür bekannt ist. */}
      {showSupport ? (
        <View style={[styles.serviceRow, { backgroundColor: palette.s3 }]}>
          <View style={[styles.serviceCheck, { backgroundColor: accent.subtle }]}>
            <Check size={11} color={accent.solid} strokeWidth={3.2} />
          </View>
          <Text style={styles.serviceText}>{t("details.support247")}</Text>
        </View>
      ) : null}

      {/* Footer: Gepäck (links) + Tarif-Details-Link + CTA (rechts) */}
      <View style={styles.footerRow}>
        {showBaggage ? (
          <View style={styles.baggageRow}>
            <BaggageCell active={!!provider.carryOn} icon="carryOn" />
            <BaggageCell active={!!provider.checked} icon="checked" />
          </View>
        ) : (
          <View />
        )}
        <View style={styles.footerActions}>
          <Pressable
            onPress={onBook}
            hitSlop={8}
            style={({ pressed }) => [{ opacity: pressed ? 0.6 : 1 }]}
          >
            <Text style={styles.fareDetails}>{t("details.faredetails")}</Text>
          </Pressable>
          <RippleTouch
            onPress={onBook}
            rippleColor="rgba(0,0,0,0.18)"
            style={({ pressed }) => [
              styles.providerCta,
              // Pressed-State über Opacity statt Background-Swap, weil das
              // Gradient absolut darunter liegt und Background-Color am
              // RippleTouch nicht durchschlägt.
              pressed && { opacity: 0.92 },
            ]}
          >
            <GradientFill />
            <Text style={styles.providerCtaText}>{t("details.gotosite")}</Text>
            <ArrowRight size={16} color={C.black} strokeWidth={2.5} />
          </RippleTouch>
        </View>
      </View>
    </View>
  );
}

/** Gepäck-Indikator: Briefcase (Handgepäck) oder Luggage (Aufgegebenes). Aktiv
 *  = farbig + lime Check-Badge, inaktiv = ausgegraut + rotes X-Badge. */
function BaggageCell({ active, icon }: { active: boolean; icon: "carryOn" | "checked" }) {
  const Icon = icon === "carryOn" ? Briefcase : Luggage;
  const accent = useAccent();
  return (
    <View style={styles.baggageCell}>
      <Icon size={22} color={active ? C.text : C.subDim} strokeWidth={1.8} />
      <View style={[styles.baggageBadge, { backgroundColor: active ? accent.solid : C.surface3 }]}>
        {active ? (
          <Check size={8} color={C.black} strokeWidth={3.5} />
        ) : (
          <XIcon size={8} color={C.sub} strokeWidth={3.5} />
        )}
      </View>
    </View>
  );
}

/**
 * Skeleton-Variante einer ProviderCard — gleiche Box-Geometrie, leere graue
 * Platzhalter mit dezenter Pulse-Animation (0.5 ↔ 0.9 opacity, 900 ms). Während
 * die Booking-Options-Query läuft zeigen wir 3 davon unter der Single-Carrier-
 * Card, sodass User sehen „mehr Anbieter werden gerade geladen".
 */
function ProviderCardSkeleton() {
  const palette = usePalette();
  const pulse = useSharedValue(0.5);
  useEffect(() => {
    pulse.value = withRepeat(withTiming(0.9, { duration: 900 }), -1, true);
    // Cleanup: ohne cancelAnimation läuft der withRepeat-Loop für IMMER auf
    // dem UI-Thread weiter, auch nach Unmount. 3 Skeletons × jedes Mal wenn
    // DetailsOverlay öffnet = nach 10 Opens 30 Geister-Worklets die pro Frame
    // evaluiert werden → spürbarer App-weiter Slowdown über die Zeit.
    return () => cancelAnimation(pulse);
  }, [pulse]);
  const pulseStyle = useAnimatedStyle(() => ({ opacity: pulse.value }));
  return (
    <View style={[styles.providerCard, { backgroundColor: palette.s2 }]}>
      <View style={styles.providerHeader}>
        <View style={styles.providerLeft}>
          <Animated.View style={[styles.skeletonLogo, { backgroundColor: palette.s3 }, pulseStyle]} />
          <View style={{ flex: 1, gap: 6 }}>
            <Animated.View style={[styles.skeletonLineLg, { backgroundColor: palette.s3 }, pulseStyle]} />
            <Animated.View style={[styles.skeletonLineSm, { backgroundColor: palette.s3 }, pulseStyle]} />
          </View>
        </View>
        <View style={{ alignItems: "flex-end", gap: 6 }}>
          <Animated.View style={[styles.skeletonLabel, { backgroundColor: palette.s3 }, pulseStyle]} />
          <Animated.View style={[styles.skeletonPrice, pulseStyle]} />
        </View>
      </View>
      <Animated.View style={[styles.skeletonCta, pulseStyle]} />
    </View>
  );
}

function SectionHeader({ title, caption }: { title: string; caption?: string }) {
  return (
    <View style={styles.sectionHeader}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {caption ? <Text style={styles.sectionCaption}>{caption}</Text> : null}
    </View>
  );
}

const styles = scaledStyles({
  root: { flex: 1, backgroundColor: C.bg },

  /* Header */
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingTop: 6,
    paddingBottom: 12,
  },
  headerLeft: { flexDirection: "row", alignItems: "center", gap: 12, flex: 1, minWidth: 0 },
  headerRight: { flexDirection: "row", gap: 8 },
  roundBtn: {
    width: 40,
    height: 40,
    borderRadius: 9999,
    backgroundColor: C.card,
    alignItems: "center",
    justifyContent: "center",
  },
  title: { fontSize: 19, fontWeight: "700", color: C.text, letterSpacing: -0.4 },

  scrollContent: { paddingHorizontal: 20, paddingBottom: 32 },

  /* Route card */
  routeCard: {
    backgroundColor: C.card,
    borderRadius: 24,
    padding: 20,
    gap: 14,
  },
  dividerSoft: { height: 1, backgroundColor: C.borderSoft },
  cityText: {
    fontSize: 28,
    fontWeight: "700",
    color: C.text,
    letterSpacing: -0.7,
    lineHeight: 30,
  },
  cityTail: { color: C.sub, fontWeight: "600" },

  metaRow: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 },
  metaText: { fontSize: 13, color: C.sub, fontWeight: "500" },
  metaTextStrong: { color: C.text, fontWeight: "600" },
  metaDot: { width: 3, height: 3, borderRadius: 1.5, backgroundColor: C.subDim },

  /* Train row */
  trainRow: { flexDirection: "row", alignItems: "center", gap: 14 },
  trainBadge: {
    width: 56,
    height: 56,
    borderRadius: 18,
    // Transparent — Airline-Favicons haben i.d.R. eigene Hintergründe und
    // sehen ohne brand-getönte Box natürlicher aus. Beim Fallback ohne
    // Logo (Carrier unbekannt) zeigen wir den Lucide-Mode-Icon in
    // white, der auch ohne BG gut sichtbar bleibt.
    backgroundColor: "transparent",
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  trainBadgeLogo: { width: 48, height: 48 },
  trainTime: {
    fontSize: 22,
    fontWeight: "700",
    color: C.text,
    letterSpacing: -0.5,
    lineHeight: 24,
  },
  trainTimeRow: { flexDirection: "row", alignItems: "center" },
  trainTimeDash: { color: C.sub, fontSize: 22, fontWeight: "700" },
  trainVia: { fontSize: 13, color: C.sub, marginTop: 3, fontWeight: "500" },
  stopsText: { fontSize: 13, fontWeight: "700", color: C.alert },
  stopsTextDirect: { fontSize: 13, fontWeight: "700" },
  durationText: { fontSize: 13, color: C.sub, marginTop: 3, fontWeight: "500" },

  /* Details ghost button */
  detailsBtn: {
    marginTop: 4,
    paddingVertical: 12,
    borderRadius: 9999,
    borderWidth: 1,
    borderColor: C.border,
    backgroundColor: "transparent",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
  },
  detailsBtnLabel: { fontSize: 14, fontWeight: "700", letterSpacing: -0.15 },

  /* Section */
  sectionHeader: { paddingTop: 24, paddingBottom: 12 },
  sectionTitle: { fontSize: 22, fontWeight: "700", color: C.text, letterSpacing: -0.5 },
  sectionCaption: { fontSize: 12, color: C.sub, fontWeight: "500", marginTop: 4 },
  sectionContent: { gap: 8 },

  /* Info row */
  infoRow: {
    backgroundColor: C.card,
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 14,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  infoBadge: {
    width: 36,
    height: 36,
    borderRadius: 12,
    backgroundColor: C.alertSoft,
    alignItems: "center",
    justifyContent: "center",
  },
  infoTitle: { fontSize: 15, fontWeight: "700", color: C.text, letterSpacing: -0.15 },
  infoSubtitle: { fontSize: 12, color: C.sub, marginTop: 2, fontWeight: "500" },

  /* Provider card */
  providerCard: {
    backgroundColor: C.card,
    borderRadius: 24,
    padding: 16,
    gap: 14,
  },
  providerCardRecommended: {
    borderWidth: 1.5,
    // borderColor wird inline auf accent.solid gesetzt (dynamischer Akzent) —
    // ohne borderColor rendert RN die Border sonst schwarz.
  },

  /* „Empfohlener Anbieter" Badge oben */
  recommendedRow: { flexDirection: "row" },
  recommendedBadge: {
    flexDirection: "row",
    alignItems: "center",

    borderRadius: 9999,
    paddingVertical: 5,
    paddingHorizontal: 10,
    gap: 6,
  },
  recommendedText: {
    color: C.black,
    fontSize: 11,
    fontWeight: "800",
    letterSpacing: -0.1,
  },

  /* 24/7-Service Pille — füllt die ganze Card-Breite (kein alignSelf:
     flex-start). Padding der Card bleibt davor, sodass die Box auf beiden
     Seiten denselben Abstand zum Card-Rand hat. */
  serviceRow: {
    paddingVertical: 8,
    paddingHorizontal: 12,
    backgroundColor: C.surface3,
    borderRadius: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  serviceCheck: {
    width: 18,
    height: 18,
    borderRadius: 999,

    alignItems: "center",
    justifyContent: "center",
  },
  serviceText: { fontSize: 12.5, color: C.sub, fontWeight: "500" },

  /* Footer (Gepäck + CTA) */
  footerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
  },
  baggageRow: { flexDirection: "row", alignItems: "center", gap: 14 },
  footerActions: { flexDirection: "row", alignItems: "center", gap: 12 },
  fareDetails: {
    color: C.text,
    fontSize: 12.5,
    fontWeight: "600",
    textDecorationLine: "underline",
  },
  baggageCell: {
    width: 26,
    height: 26,
    position: "relative",
    alignItems: "flex-start",
    justifyContent: "flex-start",
  },
  baggageBadge: {
    position: "absolute",
    bottom: -3,
    right: -2,
    width: 12,
    height: 12,
    borderRadius: 999,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 2,
    borderColor: C.card,
  },
  providerHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  providerLeft: { flexDirection: "row", alignItems: "center", gap: 12, flex: 1, minWidth: 0 },
  providerLogo: {
    width: 44,
    height: 44,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  providerLogoText: {
    fontSize: 13,
    fontWeight: "900",
    color: C.text,
    letterSpacing: -0.3,
  },
  providerLogoTextDark: { color: C.black },
  providerLogoImg: { width: 36, height: 36 },

  /* Skeleton-Variante: matched die ProviderCard-Box-Geometrie damit beim
     Übergang zur echten Card kein Layout-Sprung passiert. Pulse-Animation
     wird per Animated.View + useSharedValue auf opacity gefahren. */
  skeletonLogo: { width: 44, height: 44, borderRadius: 14, backgroundColor: C.surface3 },
  skeletonLineLg: { height: 12, borderRadius: 6, backgroundColor: C.surface3, width: "60%" },
  skeletonLineSm: { height: 9, borderRadius: 5, backgroundColor: C.surface3, width: "35%" },
  skeletonLabel: { height: 8, borderRadius: 4, backgroundColor: C.surface3, width: 28 },
  skeletonPrice: { height: 18, borderRadius: 5, backgroundColor: C.surface3, width: 70 },
  skeletonCta: { height: 46, borderRadius: 9999, backgroundColor: C.surface3 },
  providerName: { fontSize: 15, fontWeight: "700", color: C.text, letterSpacing: -0.15 },
  providerNote: { fontSize: 12, color: C.sub, marginTop: 2, fontWeight: "500" },
  priceLabel: {
    fontSize: 10,
    color: C.sub,
    fontWeight: "600",
    letterSpacing: 0.8,
    textTransform: "uppercase",
  },
  priceValue: { fontSize: 22, fontWeight: "800", letterSpacing: -0.5, marginTop: 2 },
  providerCta: {
    // Kein backgroundColor — der GradientFill rendert als Absolute-Fill-Child
    // den Hintergrund. `overflow: hidden` clipped den Gradient an der
    // borderRadius-Pille.
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: 9999,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    overflow: "hidden",
  },
  providerCtaText: { color: C.black, fontSize: 13, fontWeight: "800", letterSpacing: -0.1 },
});
