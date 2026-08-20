import { memo, useEffect, useMemo, useRef, useState } from "react";
import { prepareLayer } from "@/lib/nav/transitionLayer";
import { armHeroClip, startResultsPush } from "@/lib/nav/overlayCover";
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import {
  View,
  Text,
  Pressable,
  ScrollView,
  StyleSheet,
  type ViewStyle,
} from "react-native";
import { BinchHero, pickTimeOfDay, type HeroCategory } from "./BinchHero";
import { RippleTouch } from "@/components/ui/RippleTouch";
import { SegmentedToggle } from "@/components/ui/SegmentedToggle";
import { Reveal, ScreenEntrance, usePressBounce } from "@/lib/motion";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";
import {
  Plane,
  PlaneTakeoff,
  PlaneLanding,
  Train,
  Bus,
  Ship,
  MapPin,
  CalendarDays,
  ArrowUpDown,
  type LucideIcon,
} from "lucide-react-native";
import { format } from "date-fns";
import { de as deLocale, enUS, fr as frLocale, es as esLocale, type Locale as DateLocale } from "date-fns/locale";
import { Location, TravelMode } from "@/types/search";
import { useT } from "@/lib/i18n/useT";
import { useAppBg, usePalette } from "@/lib/theme/appBg";
import { FIELD_H, GUTTER } from "@/lib/theme/spacing";
import { beginSearchHandoff, endSearchHandoff, isSearchHandoff, prepareHandoffLayer, releaseHandoffLayer } from "@/lib/nav/searchHandoff";

/** Notbremse, falls die Ergebnis-Slide nie zustande kommt. */
/**
 * Notbremse, falls die Ergebnis-Slide nie zustande kommt.
 *
 * War 1600ms — zu knapp. Die Feder hat 550ms WAHRGENOMMENE Dauer, real läuft sie
 * etwa das 1,5-fache (~825ms), und davor liegen noch Routen-Push und der Aufbau
 * des Ergebnis-Screens. Auf einem langsamen Durchlauf kam die Notbremse damit
 * VOR dem Slide-Ende und riss den Such-Screen mitten in der Bewegung weg — genau
 * das „manchmal buggen die Elemente". Als reines Sicherheitsnetz darf der Wert
 * großzügig sein: Er greift nur, wenn die Slide gar nicht stattfindet.
 */
const HANDOFF_FALLBACK_MS = 4000;
import { useSearchStore } from "@/stores/searchStore";
import { haptic } from "@/lib/haptics";
import { POPULAR_LOCATIONS } from "@/lib/data/popularLocations";

/**
 * Heute um Mitternacht — als STABILES Objekt, nicht nur als stabiler Wert.
 *
 * Hier stand eine Funktion, die pro Aufruf ein frisches `Date` anlegte, mit dem
 * Kommentar: „Auf Mitternacht normalisiert bleibt er über einen ganzen Tag
 * identisch — und damit auch die Kennung." Der erste Halbsatz stimmt, der
 * zweite nicht. `useMemo` vergleicht über `Object.is`, und zwei Date-Objekte
 * mit derselben Millisekunde sind nicht dasselbe Objekt.
 *
 * Die Folge hing genau an der Stelle, die der Kommentar schützen wollte: Im
 * Datumswähler hängt `today` an `minimumDate`, daran die Zeichenfunktion der
 * Kalenderliste — und FlashList vergleicht `renderItem` über die Identität.
 * Eine neue Kennung rendert damit JEDE gemountete Wochenzeile neu, rund 13
 * Zeilen mit etwa 90 Tageszellen, und das fiel in den Commit, aus dem die
 * Bewegung startet. Pro Öffnung passierte das zweimal, weil der Auftrag
 * einmal beim Aufsetzen des Fingers und einmal beim Loslassen gestellt wird.
 *
 * Modulweit und nicht als `useMemo`: Der Wert muss über Neuaufbauten UND über
 * die beiden getrennten Aufrufe hinweg derselbe bleiben. Beim Datumswechsel um
 * Mitternacht wird er einmal ersetzt — dann ist ein Neurendern auch richtig.
 */
let midnightToday: Date | null = null;
function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  if (midnightToday !== null && midnightToday.getTime() === d.getTime()) {
    return midnightToday;
  }
  midnightToday = d;
  return d;
}
import { preloadDatePicker, preloadLocationPicker } from "@/lib/nav/pickerPreload";
import { useAccent } from "@/lib/theme/accent";
import { scaledStyles } from "@/lib/ui/compact";
import { isTransitionBusy } from "@/lib/nav/transitionBusy";
import { PICKER_OUT } from "@/lib/nav/overlayCover";

const C = {
  bg: "#1A1A1A",
  surface1: "#1F1F20",
  surface2: "#242425",
  surface3: "#2A2A2C",
  border: "#2E2E30",
  green: "#7FEA4D",
  greenSubtle: "#1A3D26",
  white: "#FFFFFF",
  gray1: "#C8C8CC",
  gray2: "#8A8A90",
  gray3: "#56565C",
  red: "#FF3B5C",
  black: "#000000",
};


type ErrorField = "origin" | "destination" | "depart" | "return";

const DATE_LOCALES: Record<string, DateLocale> = {
  en: enUS,
  de: deLocale,
  fr: frLocale,
  es: esLocale,
};

// Mapping unserer internen TravelMode-Codes auf die BinchHero-Categories.
// BinchHero benutzt deutsche Slugs als Seed-Keys (flug/zug/bus/kreuzfahrt) —
// jede Category bekommt eine eigene Dünen-Skyline-Phase.
const HERO_CATEGORY: Record<TravelMode, HeroCategory> = {
  FLIGHT: "flug",
  TRAIN: "zug",
  BUS: "bus",
  CRUISE: "kreuzfahrt",
};

const MODE_ICON: Record<TravelMode, LucideIcon> = {
  FLIGHT: Plane,
  TRAIN: Train,
  BUS: Bus,
  CRUISE: Ship,
};

type TripType = "roundtrip" | "oneway" | "multicity";

function tripTypesFor(mode: TravelMode): { id: TripType; key: string }[] {
  if (mode === "CRUISE") {
    return [
      { id: "roundtrip", key: "search.cruise.roundtrip" },
      { id: "oneway", key: "search.cruise.oneway" },
    ];
  }
  const base: { id: TripType; key: string }[] = [
    { id: "roundtrip", key: "search.tabs.roundtrip" },
    { id: "oneway", key: "search.tabs.oneway" },
  ];
  // Multi-City ist noch nicht implementiert (kein Leg-Input, kein Server-Contract)
  // → Tab vorerst ausgeblendet, damit er nicht ins Leere läuft. Wird als eigenes
  // Feature nachgezogen (Client-UI + SearchParams.legs[] + beide Provider-Adapter).
  // if (mode === "FLIGHT") base.push({ id: "multicity", key: "search.tabs.multicity" });
  return base;
}

function extraOptionsFor(mode: TravelMode): string[] {
  switch (mode) {
    case "FLIGHT":
      return ["search.class.economy", "search.class.business", "search.class.first"];
    case "TRAIN":
      return ["search.class.second", "search.class.first", "search.class.sparpreis"];
    case "BUS":
      return ["search.seat.standard", "search.seat.comfort", "search.seat.premium"];
    case "CRUISE":
      return ["search.cabin.inside", "search.cabin.outside", "search.cabin.balcony", "search.cabin.suite"];
  }
}

interface Props {
  mode: TravelMode;
  /**
   * Wellen-Auslöser für die Micro-Animationen (Felder, CTA sliden gestaffelt
   * rein — wie auf dem Landingscreen). Wird vom Launch-Overlay gebumpt, sobald
   * das Splash-Fenster den Screen freigibt. Ohne Trigger (eigenständige Route)
   * läuft die Welle wie gewohnt beim Fokus.
   */
  entranceTrigger?: number;
  /**
   * Auslöser für das Einfaden des HINTERGRUNDS (Himmel/Dünen). Getrennt vom
   * Formular, weil der Hintergrund sonst hart auf-poppt, sobald der Screen
   * sichtbar wird. Fadet beim Reveal ein; das Formular kommt entspannt später.
   */
  bgTrigger?: number;
  /**
   * ZURÜCKSETZEN beim Launch-START (Screen noch unsichtbar): Himmel-Scrim wieder
   * deckend, Formular-Reveals entwaffnet. Nötig, seit der Screen dauerhaft
   * gemountet bleibt — sonst stünde beim Öffnen noch der fertige Stand von
   * letztem Mal und würde beim Reveal sichtbar zurückspringen (Flackern).
   */
  resetTrigger?: number;
}

// MEMOISIERT (wichtig!): Seit der Screen dauerhaft gemountet bleibt, würde er
// sonst bei JEDER Zustandsänderung des Overlays neu rendern — und davon passieren
// beim Launch-Start mehrere direkt hintereinander (launchActive, resetTick,
// setActive). Dieser schwere Baum pro Commit neu = fehlende Frames genau in der
// Expand-Animation. Mit memo rendert er nur noch, wenn sich wirklich einer seiner
// Props ändert (mode / entrance / bg / reset).
/** Leeres Fehler-Set als Konstante — ein neues wäre bei jedem Räumen eine
 *  neue Kennung und damit ein Render, den es nicht braucht. */
const NO_ERRORS: Set<ErrorField> = new Set();

function SearchHeroComponent({ mode, entranceTrigger, bgTrigger, resetTrigger }: Props) {
  // Screen-Hintergrund (Theme): Container, Formular, Scrim und der BinchHero-
  // „melt" müssen exakt dieselbe Farbe tragen wie die Launch-Box am Ende.
  const appBg = useAppBg();
  const palette = usePalette();
  const t = useT();
  const insets = useSafeAreaInsets();
  const accent = useAccent();
  const locale = useSearchStore((s) => s.locale);
  const currency = useSearchStore((s) => s.currency);
  // Der Unterlay-Parallax dieses Screens liegt NICHT mehr hier, sondern ist im
  // SearchHeroOverlay mit der Gegenbewegung des Beschnitts zusammengefasst
  // (clipContentStyle). Ein animierter Knoten weniger in diesem Baum.
  const dateLocale = DATE_LOCALES[locale] ?? enUS;

  const [tripType, setTripType] = useState<TripType>("roundtrip");
  const [origin, setOrigin] = useState<Location | null>(null);
  const [destination, setDestination] = useState<Location | null>(null);
  const [departDate, setDepartDate] = useState<Date | null>(null);
  const [returnDate, setReturnDate] = useState<Date | null>(null);
  const [pax, setPax] = useState(1);
  const [extraOpt, setExtraOpt] = useState(0);
  // LocationPicker läuft jetzt am Root-Level via LocationPickerHost.
  // Store-getriebene Open/Result-Flow, keine lokale pickerField-State mehr.
  // Picker läuft am Root-Level via DatePickerHost. Wir lesen das Result
  // aus dem Store; das Field kommt direkt im Result mit, kein lokaler
  // pendingDateField nötig → keine zusätzliche Re-Render-Welle in SearchHero
  // beim Tap. heroPaused wird in BinchHero direkt aus dem Store gelesen.
  // Breite des Title-Text via onLayout messen → der Strich darunter
  // Sobald User auf irgendwas TAPPT (außer dem Tripty-Toggle), wird die
  // Hero-Animation final beendet — Sonne bleibt wo sie ist, Vögel/Geister
  // verschwinden sofort. Einmal getriggert, bleibt's so bis zum nächsten
  // Open des Search-Sheets.
  const [animFinished, setAnimFinished] = useState(false);
  /**
   * Beim Zurücksetzen (jede neue Öffnung) wieder scharf stellen.
   *
   * Das fehlte: `finishAnim` setzt nur auf true, und nichts nahm es je zurück.
   * Nach dem ersten Tipp auf irgendein Feld blieb der Hero für den Rest des
   * App-Laufs pausiert — der Sonnenaufgang lief also genau EINMAL pro Start,
   * obwohl `riseKey` ausdrücklich dafür da ist, ihn pro Öffnung neu zu starten.
   */
  useEffect(() => {
    if (resetTrigger === undefined) return;
    setAnimFinished(false);
  }, [resetTrigger]);

  /**
   * Das FORMULAR bei jeder neuen Öffnung leeren — nicht nur die Animation.
   *
   * Dieser Baum trug früher ein `key` aus Sitzung und Verkehrsmittel; jede
   * Öffnung baute ihn also neu auf, und damit war er automatisch leer. Das
   * `key` ist bewusst weg (der Neuaufbau lag genau im Bild, in dem die Fahrt
   * startet) — nur ist dabei niemandem aufgefallen, dass daran der einzige
   * Rücksetz-Mechanismus hing. `resetTrigger` stellt seither nur den
   * Sonnenaufgang scharf.
   *
   * Sichtbar wäre das als falsche Suche, nicht als Anzeigefehler: Wer einen
   * Flug Berlin→München sucht, schließt und dann Züge öffnet, hätte eine
   * Zugsuche auf IATA-Codes abgeschickt. `extraOpt` ist ein Index in eine
   * Liste, die je Verkehrsmittel anders lang ist — der zeigte über die Grenze
   * hinaus.
   */
  useEffect(() => {
    if (resetTrigger === undefined) return;
    setOrigin(null);
    setDestination(null);
    setDepartDate(null);
    setReturnDate(null);
    setPax(1);
    setExtraOpt(0);
    setTripType("roundtrip");
    setErrors(new Set());
  }, [resetTrigger]);
  const finishAnim = () => {
    if (!animFinished) setAnimFinished(true);
  };

  // Welche Felder beim letzten Submit fehlerhaft waren → rote Border. Wird
  // sobald der User das jeweilige Feld ausfüllt automatisch geleert.
  const [errors, setErrors] = useState<Set<ErrorField>>(NO_ERRORS);
  /** Druck-Effekt wie an den Kategorie-Kacheln im Landingscreen. */
  const ctaBounce = usePressBounce();
  const clearError = (field: ErrorField) =>
    setErrors((prev) => {
      if (!prev.has(field)) return prev;
      const next = new Set(prev);
      next.delete(field);
      return next;
    });

  const Icon = MODE_ICON[mode];
  const tripTypes = useMemo(() => tripTypesFor(mode), [mode]);
  const extraOpts = useMemo(() => extraOptionsFor(mode), [mode]);
  // BinchHero-Props stabil halten damit memo greift. Time-of-Day einmal beim
  // Mount auswerten — würde sich während einer Session sowieso kaum ändern.
  // Style ist ein Konstantenliteral, sonst gibt's jedes Render eine neue
  // Referenz und memo muss tief comparen / passt nicht.
  const heroCategory = HERO_CATEGORY[mode];
  const heroTime = useMemo(() => pickTimeOfDay(), []);
  const heroStyle = useMemo<ViewStyle>(() => ({ flex: 1, height: undefined }), []);
  // KEINE Maße mehr von Hand: `scaledStyles` unten skaliert das ganze
  // Stilblatt, und `FIELD_H` kommt bereits skaliert aus dem Raster. Beides
  // zusammen hätte den Faktor zweimal angewandt.
  // paused=true wenn Modal offen ODER User irgendwas getappt hat (animFinished).
  // Beides verhindert dass die Hero-Animations weiter spielen.
  // heroPaused fokussiert nur auf animFinished — die Picker-States werden
  // direkt in BinchHero subscribed (kein Pass-Through nötig, spart einen
  // SearchHero-Re-Render bei jedem Picker-Open).
  // NICHT hier den Overlay-Zustand abonnieren: Das würde diesen schweren Baum
  // bei jedem Öffnen/Schließen neu rendern — genau im Launch-Moment. Ob die
  // Suche zu ist (→ Hero-Animationen pausieren, seit der Screen dauerhaft
  // gemountet bleibt), liest BinchHero selbst aus dem Store, wie schon bei
  // pickerOpen.
  const heroPaused = animFinished;
  const tripTypeIds = tripTypes.map((tt) => tt.id);
  const isRoundtrip = tripType === "roundtrip";

  const modeKey = mode.toLowerCase();
  // Symbole wie in der Vorlage: startendes und landendes Flugzeug. Für die
  // anderen Verkehrsmittel gibt es kein solches Paar — dort steht das Symbol des
  // Modus für den Start und eine Ortsmarke für das Ziel.
  const FromIcon = mode === "FLIGHT" ? PlaneTakeoff : MODE_ICON[mode];
  const ToIcon = mode === "FLIGHT" ? PlaneLanding : MapPin;
  const fromPlaceholder = t(`search.fromPlaceholder.${modeKey}`);
  const toPlaceholder = t(`search.toPlaceholder.${modeKey}`);
  const extraLabel = t(`search.extraLabel.${modeKey}`);

  // Visuelles Feedback beim Tausch: das Icon rotiert um 180° pro Klick.
  // Kumulativ (180, 360, 540...), damit jeder Tap eine sichtbare halbe Drehung
  // liefert, statt immer auf 180° zu springen.
  //
  // WICHTIG: das Target wird in einem Ref getrackt, nicht aus swapRotation.value
  // gelesen. Bei einem Doppelklick während die erste Animation noch läuft hat
  // swapRotation.value einen interpolierten Zwischenwert (z.B. 90° statt 180°),
  // und `swapRotation.value + 180 = 270` statt der erwarteten 360. Mit dem


  // Target-Ref inkrementieren wir IMMER um 180 unabhängig vom Animation-State.
  const swapRotation = useSharedValue(0);
  const swapRotationTarget = useRef(0);
  const swapIconStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${swapRotation.value}deg` }],
  }));
  function handleSwap() {
    haptic("button");
    finishAnim();
    setOrigin(destination);
    setDestination(origin);
    swapRotationTarget.current += 180;
    swapRotation.value = withTiming(swapRotationTarget.current, {
      duration: 320,
      easing: Easing.out(Easing.cubic),
    });
  }

  // Result vom Root-Level LocationPickerHost lesen.
  const locationPickerResult = useSearchStore((s) => s.locationPickerResult);
  const lastLocationSessionRef = useRef<number | null>(null);
  useEffect(() => {
    if (!locationPickerResult) return;
    if (locationPickerResult.sessionKey === lastLocationSessionRef.current) return;
    lastLocationSessionRef.current = locationPickerResult.sessionKey;
    /**
     * Das Ergebnis EINTRAGEN, aber nicht mitten in der Ausfahrt.
     *
     * Dieser Bildschirm liegt UNTER dem Blatt und wird für dessen Fahrt als
     * GPU-Textur gehalten. Wird hier geschrieben, ändert sich sichtbarer Text
     * (Ortsname), der ganze Baum rendert neu — und die Textur muss neu
     * entstehen, mitten in der Bewegung. Eine Ebene, deren Inhalt sich ändert,
     * ist teurer als gar keine.
     *
     * Sichtbar ist der Unterschied nicht: Das Feld liegt hinter dem Blatt, bis
     * die Fahrt vorbei ist.
     */
    const apply = () => {
      if (locationPickerResult.field === "from") {
        setOrigin(locationPickerResult.location);
        clearError("origin");
      } else {
        setDestination(locationPickerResult.location);
        clearError("destination");
      }
    };
    if (!isTransitionBusy()) {
      apply();
      return;
    }
    const id = setTimeout(apply, PICKER_OUT.duration + 60);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locationPickerResult]);

  const openLocationPicker = useSearchStore((s) => s.openLocationPicker);
  /**
   * Textur des Pickers anlegen, solange der Finger noch auf dem Feld liegt.
   *
   * Beide Picker sind bildschirmfüllend und fahren von unten herein. Ohne Ebene
   * wird dabei jedes Bild neu gezeichnet (14,7ms gegen 8,3ms Budget) — mit einer,
   * die erst beim Öffnen entsteht, liegt der 66ms-Aufbau im Startbild. Beides war
   * schon da und beides ruckelte. Zwischen Aufsetzen und Loslassen liegen 80 bis
   * 150ms, die ohnehin verstreichen; dort ist der Aufbau umsonst.
   *
   * Die Ebene fällt nach der Frist des Moduls von selbst wieder weg — wichtig,
   * weil unter ihr im Kalender und in der Trefferliste gescrollt wird.
   */
  /**
   * Beim Aufsetzen NEBEN der Textur auch den INHALT des Blattes bauen.
   *
   * Die Textur allein half beim ersten Öffnen nicht — sie entstand von einem
   * leeren Blatt und wurde vom Öffnungs-Commit sofort wieder ungültig. Siehe
   * `pickerPreload`. Gemeldet wird derselbe Auftrag, den `triggerLocationPicker`
   * bzw. `triggerDatePicker` beim Loslassen stellt; wiche er ab, wäre der
   * Vorbau wertlos.
   */
  const armPickerLayer = (
    which: "pickerLocation" | "pickerDate",
    field: "from" | "to" | "depart" | "return",
  ) => () => {
    /**
     * Getrennte Schlüssel für Ort und Datum.
     *
     * Beide hörten auf denselben — wer das Startfeld berührte, ließ damit auch
     * die Ebene des DATUMSWÄHLERS bauen, eines Baums mit einer Monatsliste, den
     * in dem Moment niemand öffnet. Das war glatte Verdopplung der Rasterarbeit
     * im Berührungsfenster.
     */
    /**
     * REIHENFOLGE: erst der Inhalt, dann die Textur — und dazwischen ein Bild.
     *
     * Beides lief bisher im selben Durchgang: `prepareLayer` fordert die
     * bildschirmfüllende Ebene an, und unmittelbar danach entsteht über den
     * Vorlauf der Inhalt des Blattes. Android baut die Textur damit aus einem
     * Blatt, das noch leer ist, und der Commit des Inhalts macht sie im selben
     * Moment wieder ungültig. Genau dieser Ablauf steht in `pickerPreload.ts`
     * als der ursprüngliche Fehler beschrieben — dort für den Fall ohne
     * Vorlauf: „einmal bauen, verwerfen, mitten in der Bewegung neu bauen".
     *
     * Seit der Inhalt zusätzlich erst beim Berühren gemountet wird (siehe die
     * Hosts), ist das Blatt in diesem Moment sogar garantiert leer. Ein Bild
     * Abstand kostet nichts — zwischen Aufsetzen und Loslassen liegen 80 bis
     * 150ms — und die Textur entsteht dann aus dem fertigen Baum.
     */
    if (which === "pickerLocation") {
      preloadLocationPicker({
        sessionKey: 0,
        field: field as "from" | "to",
        mode,
        suggested: POPULAR_LOCATIONS[mode],
      });
    } else {
      const f = field as "depart" | "return";
      preloadDatePicker({
        sessionKey: 0,
        field: f,
        initialDate: f === "depart" ? departDate : (returnDate ?? departDate),
        minimumDate: f === "return" && departDate ? departDate : startOfToday(),
      });
    }
    requestAnimationFrame(() => prepareLayer(which));
    /**
     * `finishAnim` läuft hier NICHT mehr — und das ist die teuerste Zeile, die
     * hier je stand.
     *
     * Sie setzt `animFinished`, also Zustand DIESES Bildschirms. Das `memo`
     * schützt also nichts: Der ganze Such-Baum läuft durch (ScrollView, fünf
     * Einblend-Hüllen, vier Felder, Personen-Feld, Pillen, Knopf), und weil
     * `heroPaused = animFinished` als Eigenschaft durch die Memo-Schranke geht,
     * zieht es `BinchHero` mit — drei SVG-Wurzeln, bis zu 39 Formknoten,
     * nachts zusätzlich 32 Sterne.
     *
     * Für den Picker-Pfad ist es zugleich WIRKUNGSLOS: `prepareLayer` eine
     * Zeile darüber setzt bereits `heroBusy`, und `effectivePaused` ist damit
     * schon wahr. Der einzige Konsument davon ist der Sonnenaufgang, der über
     * `risenForRef` ohnehin stehen bleibt.
     *
     * Schlimmer noch: `animFinished` wird bei JEDEM Öffnen der Suche
     * zurückgesetzt. Der teure Commit fiel also nicht einmal pro App-Lauf an,
     * sondern einmal pro Such-Öffnung — beim ersten angetippten Feld. Genau das
     * beschriebene Muster „ich öffne die Suche, tippe ein Feld, und es ruckelt".
     *
     * Die übrigen Tipp-Stellen (Tausch, Personen, Pillen) rufen es weiter — dort
     * gibt es kein `prepareLayer`, das den Hero stilllegt.
     *
     * Die alte Begründung, warum es überhaupt ins Berührungsfenster gehört:
     *
     * Es stand als `requestAnimationFrame(finishAnim)` in den vier Tipp-Handlern,
     * mit der Begründung, ein Bild später schade es der laufenden Bewegung nicht.
     * Der Denkfehler: In diesem Bild läuft noch gar keine Bewegung — der Picker
     * startet seine im GLEICHEN Bild-Durchgang, und weil er sich später
     * anmeldet, rendert `finishAnim` sogar davor. Es wurde also nicht aus der
     * Bewegung heraus-, sondern in ihren Anfang hineingeschoben.
     *
     * Der Re-Render ist nicht klein: `animFinished` ist Zustand dieses
     * Bildschirms, das `memo` schützt also nicht. Der ganze Baum läuft durch —
     * und weil damit auch `paused` am Hero wechselt, bricht dessen `memo`
     * ebenfalls, samt SVG-Baum.
     *
     * Beim Aufsetzen des Fingers ist dafür Platz, und der Nebeneffekt ist sogar
     * erwünscht: Der Hero steht dann still, bevor das Blatt losfährt.
     */
    // (siehe oben: hier bewusst nicht mehr aufgerufen)
  };

  const triggerLocationPicker = (field: "from" | "to") => {
    openLocationPicker({
      field,
      mode,
      suggested: POPULAR_LOCATIONS[mode],
    });
  };

  // Result vom Root-Level DatePickerHost lesen. sessionKey ändert sich pro
  // Open, sodass wir das Result genau einmal anwenden. Field kommt direkt
  // im Result mit → keine lokale pendingDateField-State nötig.
  const datePickerResult = useSearchStore((s) => s.datePickerResult);
  const lastAppliedSessionRef = useRef<number | null>(null);
  useEffect(() => {
    if (!datePickerResult) return;
    if (datePickerResult.sessionKey === lastAppliedSessionRef.current) return;
    lastAppliedSessionRef.current = datePickerResult.sessionKey;
    const picked = datePickerResult.date;
    // Gleiche Begründung wie beim Ort: nicht in die laufende Ausfahrt schreiben.
    const apply = () => {
      if (datePickerResult.field === "depart") {
        setDepartDate(picked);
        clearError("depart");
        if (returnDate && returnDate < picked) setReturnDate(null);
      } else if (datePickerResult.field === "return") {
        setReturnDate(picked);
        clearError("return");
      }
    };
    if (!isTransitionBusy()) {
      apply();
      return;
    }
    const id = setTimeout(apply, PICKER_OUT.duration + 60);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [datePickerResult]);

  const openDatePicker = useSearchStore((s) => s.openDatePicker);

  const triggerDatePicker = (field: "depart" | "return") => {
    openDatePicker({
      field,
      initialDate:
        field === "depart" ? departDate : (returnDate ?? departDate),
      // Dasselbe OBJEKT über den ganzen Tag — siehe `startOfToday`.
      minimumDate: field === "return" && departDate ? departDate : startOfToday(),
    });
  };

  /** Sperrt „Preis vergleichen" kurz nach dem Auslösen (siehe unten). */
  const submitLockRef = useRef(false);

  function handleSubmit() {
    /**
     * KEIN `finishAnim()` mehr hier.
     *
     * Es setzt `animFinished`, und daran hängt `heroPaused` — also ein
     * kompletter Neu-Render dieses Baums samt der drei SVG-Wurzeln des Hero.
     * Das landete im selben Commit wie `startResultsPush()` weiter unten, und
     * zwar INNERHALB des Knotens, der seit dem Aufsetzen des Fingers eine
     * bildschirmfüllende Textur trägt. Eine Ebene, deren Inhalt sich ändert,
     * muss neu gerastert werden — die Vorbereitung war damit nicht nur
     * wirkungslos, sondern teurer als keine.
     *
     * Gebraucht wird es hier auch nicht: Der Bildschirm verschwindet gleich
     * hinter der Ergebnisliste, und beim nächsten Öffnen setzt der Aufbau die
     * Animation ohnehin neu auf. Für den Fehler-Zweig unten steht es weiterhin
     * (dort bleibt der Bildschirm stehen) — genau wie an den Feld-Handlern.
     */
    // Fehlende/ungültige Felder einsammeln und rot umrandet markieren.
    const missing = new Set<ErrorField>();
    if (!origin) missing.add("origin");
    if (!destination) missing.add("destination");
    if (!departDate) missing.add("depart");
    if (isRoundtrip && !returnDate) missing.add("return");
    // Doppeltipp-Sperre. In den ersten ~100ms existiert der Ergebnis-Bildschirm
    // noch nicht, der Knopf ist also weiter frei. Ein zweiter Tipp riefe
    // `startResultsPush()` erneut auf — das setzt den Wert auf 0 zurück, die
    // schon reingefahrene Liste SPRINGT damit hart nach rechts aus dem Bild —
    // und legte zusätzlich eine zweite Route samt zweiter Suche an.
    if (submitLockRef.current) return;

    if (missing.size > 0 || !origin || !destination || !departDate) {
      // Textur wieder freigeben: Sie wurde beim Fingerdruck angefordert, und
      // gleich darunter rendert `setErrors` den schweren Baum neu — mit
      // liegender Textur heißt das Neurasterung der ganzen Fläche.
      releaseHandoffLayer();
      // Hier schon: Der Bildschirm bleibt stehen, die Animation soll ruhen.
      finishAnim();
      // Visuelles Feedback via roter Border auf den fehlenden Feldern reicht —
      // ein zusätzlicher Alert würde den User unnötig unterbrechen.
      setErrors(missing);
      haptic("error");
      return;
    }
    /**
     * Nur räumen, wenn wirklich etwas darin steht.
     *
     * Ein neues `Set` ist immer eine neue Kennung — der Zustandswechsel lief
     * also garantiert, auch wenn gar kein Fehler markiert war. Ein Render mehr
     * im Bild des Übergangs, für nichts.
     */
    if (errors.size > 0) setErrors(NO_ERRORS);
    submitLockRef.current = true;
    setTimeout(() => {
      submitLockRef.current = false;
    }, 400);
    // Gleiche Stufe wie die Kachel im Landingscreen (siehe ResultCard).
    haptic("button");
    const departIso = format(departDate, "yyyy-MM-dd");
    const returnIso = isRoundtrip && returnDate ? format(returnDate, "yyyy-MM-dd") : "";
    // Der Picker liefert Datum UND Uhrzeit (DatePickerHost baut
    // `new Date(y, m, d, hour, minute)`). Die Uhrzeit wurde hier bisher
    // weggeworfen — der Server suchte dann ab einer Default-Zeit statt ab dem
    // gewünschten Zeitpunkt. Als UTC-ISO mitgeben; `departDate` bleibt daneben
    // bestehen (Cache-Key, Anzeige).
    const departTimeIso = departDate.toISOString();
    // Verlaufs-Eintrag NICHT im Berührungs-Frame schreiben.
    //
    // Gemessen: Zwischen Antippen und Losbewegen liegen auf diesem Weg rund
    // 117ms auf dem JS-Thread, während der Ergebnis-Bildschirm selbst nur 18ms
    // davon braucht. Ein Teil des Rests steht hier: Der Schreibvorgang weckt
    // jeden Abonnenten von `recentSearches` — darunter der Landingscreen, der
    // direkt darunter liegt und seine Verlaufskarten neu aufbaut. Für den Nutzer
    // ist das die Zeit, in der nach dem Tippen nichts passiert.
    //
    // Eilig ist der Eintrag nicht: Sichtbar wird er erst, wenn man später zum
    // Landingscreen zurückkommt. Er wandert deshalb in die nächste Leerlauf-
    // Lücke — dasselbe Mittel, mit dem auch das Sichern des Speicherstands aus
    // dem heißen Pfad geholt wurde. Geschrieben wird er in JEDEM Fall, auch bei
    // einer Suche ohne Treffer; am Verhalten ändert sich nichts.
    // Der Verlaufs-Eintrag wird hier NICHT mehr geschrieben.
    //
    // Der Ergebnis-Bildschirm tut es inzwischen für jeden Einstieg, sobald Daten
    // da sind. Ein zweiter Schreibvorgang hier weckt nur nochmal alle
    // Abonnenten — allen voran den Landingscreen, der dabei als Textur wandert.
    const travelClass = extraOpts[extraOpt] ?? "";
    // Der Such-Screen wird NICHT vorher geschlossen: Die Ergebnis-Liste slidet
    // direkt über ihn drüber, so wie jedes andere Push-Overlay auch. Vorher lief
    // erst die Schließ-Animation und danach der Slide — dazwischen blitzte der
    // Landingscreen auf, und der Übergang zerfiel in zwei Teile.
    //
    // `searchHandoff` hält den Such-Screen so lange offen: Der Home-Screen
    // schließt ihn sonst bei seinem Fokus-Verlust (siehe OnFocusLost dort).
    beginSearchHandoff();
    // Der Beschnitt dieses Screens läuft über einen EIGENEN Wert — er soll nur
    // mitfahren, wenn die Suche wirklich von hier kommt. Bei einer Suche aus dem
    // Landingscreen laufen seine beiden Mapper damit gar nicht erst an.
    //
    // Hier wird er nur VORGEMERKT, nicht gestartet: Gestartet wird er zusammen
    // mit der Bewegung der Ergebnisliste (`startResultsPush`), die erst zwei
    // Bilder später anläuft. Vorher lief er diese zwei Bilder voraus, und der
    // Versatz war die ganze Bewegung über als Spalt an der Kante zu sehen.
    armHeroClip();
    /**
     * Und sofort losfahren — nicht erst, wenn der Ergebnis-Baum steht.
     *
     * Gestartet wurde die Bewegung bisher im Ergebnis-Bildschirm selbst, in
     * einem Effekt. Der läuft aber erst nach dem Commit, der diesen ganzen Baum
     * sichtbar macht; davor liegen zusätzlich die beiden Schreibvorgänge unten
     * und das Bild Abstand dazwischen. Auf diesem Weg vergingen zwischen Finger
     * und erster Regung mehrere Bilder, in denen nichts passierte.
     *
     * Der Aufruf steht direkt hinter `armHeroClip`, und das ist die Bedingung
     * dafür, dass beide Ebenen synchron laufen: `startResultsPush` startet den
     * Beschnitt dieses Bildschirms im SELBEN Aufruf mit — genau dafür ist die
     * Vormerkung eine Zeile darüber da.
     */
    startResultsPush();
    {
      // Sofort öffnen — ohne Router. Die Route wird nachgezogen, sobald die
      // Bewegung durch ist (siehe pendingResultsRoute im Store).
      // KEINE Textur für die Unterlage mehr.
      //
      // Ihr Aufbau ist im Projekt mit 66ms vermessen (saved.tsx) — das sind bei
      // 120Hz rund acht Bilder. Zwischen Tipp und Bewegungsstart liegen aber nur
      // zwei bis drei. Der Aufbau lief also noch, während die Bewegung schon
      // losfuhr: ein Klotz genau im Start, und damit genau das „als würde etwas
      // Großes im Hintergrund laufen".
      //
      // Ohne Textur wird die Unterlage pro Bild neu gezeichnet. Das kostet auch,
      // aber GLEICHMÄSSIG — und gleichmäßig liest sich als flüssig, während ein
      // einzelner Klotz am Anfang als Hängen gelesen wird. Der reinslidende
      // Bildschirm behält seine Textur; er ist der teurere von beiden.
      const rp = {
          mode,
          origin: origin.code,
          destination: destination.code,
          originLabel: origin.label,
          destLabel: destination.label,
          departDate: departIso,
          departTime: departTimeIso,
          returnDate: returnIso,
          tripType,
          passengers: String(pax),
          currency,
          travelClass,
        } as Record<string, string>;
      // Ein Bild Abstand zwischen Textur-Flip und Öffnen.
      //
      // React fasst sonst beides in EINEN Commit: die Unterlage wird auf eine
      // Hardware-Ebene gehoben UND der Ergebnis-Baum sichtbar gemacht. Zwei
      // bildschirmfüllende Aufbauten im selben Bild, direkt bevor die Bewegung
      // anläuft. Beim Ticket-Übergang liegen genau deshalb zwei Commits
      // dazwischen — und der gilt als der glatte.
      requestAnimationFrame(() => {
        useSearchStore.getState().setPendingResultsRoute(rp);
        useSearchStore.getState().setResultsParams(rp);
      });
    }
    // Geschlossen wird der Such-Screen NICHT hier, sondern im Ergebnis-Screen,
    // sobald dessen Slide ihn wirklich verdeckt (finishSearchHandoff dort).
    // Hier bleibt nur ein Sicherheitsnetz, falls die Slide gar nicht zustande
    // kommt — sonst hinge der Such-Screen dauerhaft offen.
    setTimeout(() => {
      if (!isSearchHandoff()) return;
      endSearchHandoff();
      useSearchStore.getState().closeSearchOverlay(true, true);
    }, HANDOFF_FALLBACK_MS);
  }

  // Uhrzeit mit anzeigen — sie wird im Picker gewählt und wirkt sich echt auf die
  // Suche aus (Zug/Bus: Suchzeitpunkt, Flug/Cruise: Filter). Ohne sichtbare Zeit
  // wirkte der Picker wirkungslos.
  // Ohne Uhrzeit: Zwei Felder nebeneinander sind halb so breit wie vorher eines,
  // „Do, 3 Sep · 14:30" bräche darin um oder würde beschnitten. Die Uhrzeit
  // wählt man weiterhin im Kalender, sie geht auch weiterhin in die Suche.
  const formatDate = (d: Date) => format(d, "EEE, d MMM", { locale: dateLocale });

  // wave={false}: Der Inhalt ist sofort vollständig da und fährt als EIN Körper
  // mit dem Blatt herein — genau wie im Anmelde-Screen. Die gestaffelte
  // Einblend-Welle gehörte zum Wachstum aus der Kachel: Dort stand der Screen am
  // Ende schlagartig im Bild und brauchte etwas, das ihn aufbaut. Bei einer
  // Slide baut die Bewegung ihn selbst auf.
  return (
    <ScreenEntrance wave={false} trigger={entranceTrigger} resetTrigger={resetTrigger}>
    <View style={[styles.container, { backgroundColor: appBg }]}>
      {/**
        * Auf kurzen Bildschirmen zusammenrücken — siehe `useCompact`.
        *
        * Der Hero ist der größte Einzelposten des Bildschirms. Mit fester Höhe
        * nimmt er auf einem 640 Punkte hohen Gerät ein Drittel ein statt einem
        * Viertel, und darunter wird es eng: Genau das ist der Eindruck „wirkt
        * zu groß". Felder und Knopf folgen demselben Faktor, damit das
        * Verhältnis erhalten bleibt und nicht bloß eine Kante wandert.
        */}
      <View style={styles.hero}>
        {/* BinchHero mountet sofort beim Slide-In — Sky + Dünen sind also
            schon da. Animationen (Sun-Rise, Bird-Spawn) sind intern
            deferred bis nach Slide-Ende → konkurriert nicht mit der
            SearchHeroOverlay-SlideInDown-Animation. */}
        <View style={StyleSheet.absoluteFill}>
          <BinchHero
            category={heroCategory}
            time={heroTime}
            melt={appBg}
            style={heroStyle}
            paused={heroPaused}
            riseKey={bgTrigger ?? 0}
          />
        </View>

        {/* Dezentes Overlay nur am Bottom für Titel-Lesbarkeit. BinchHero
            bringt eh schon einen eigenen Bottom-Fade in `melt` (= C.bg).
            Vorher war hier ein 60%-Schwarz mitten im Bild — das hat die
            Sky-Farben der Animation matschig gemacht. */}
        <LinearGradient
          colors={["transparent", "transparent", "rgba(26,26,26,0.45)"]}
          locations={[0, 0.7, 1]}
          style={StyleSheet.absoluteFill}
          pointerEvents="none"
        />


      </View>

      {/* Das Sheet — Geometrie und Farbe 1:1 vom Auth-Screen. Es liegt mit
          -20 Rand ÜBER dem Band, die gerundete Oberkante schneidet also in die
          Dünen. */}
      <ScrollView
        style={[styles.form, { backgroundColor: palette.s1 }]}
        contentContainerStyle={[styles.formContent, { paddingBottom: insets.bottom + 90 }]}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        // Wird aus der Berührung doch ein Scrollen, ist die Textur sofort wieder
        // weg. Sie wird beim Aufsetzen des Fingers auf den Knopf angefordert
        // (siehe dort) — ohne diese Gegenbuchung bliebe sie 1,4s über einer
        // Fläche stehen, die gerade scrollt, und müsste pro Bild neu entstehen.
        onScrollBeginDrag={releaseHandoffLayer}
      >
        {/* Erste Zeile im Sheet — dieselbe Stelle, an der im Auth-Screen der
            Fortschrittsbalken sitzt, und mit dessen Maßen (`navRow`: minHeight
            38, 20 Abstand nach unten). Die 20 setzen sich hier aus dem
            `gap: 10` des Inhalts und den 10 hier zusammen. */}
        {tripTypes.length > 1 ? (
          <Reveal index={0}>
            <View style={styles.navRow}>
              <SegmentedToggle
                items={tripTypes.map((tt) => ({ id: tt.id, label: t(tt.key) }))}
                selectedId={tripType}
                onChange={(id) => setTripType(id as TripType)}
              />
            </View>
          </Reveal>
        ) : null}

        <Reveal index={1}>
        {/* Von/Nach: zwei gleich große Felder untereinander, je EINE Zeile aus
            Symbol und Ort, der Tausch-Knopf rechts über der Fuge. Höhe und
            Breite sind exakt die des Such-Knopfes (FIELD_H, gleicher
            Inhaltsbereich). */}
        <View style={styles.routeWrap}>
          <View style={styles.routeFields}>
            <RippleTouch
              style={[styles.routeField, { backgroundColor: palette.s2 }, errors.has("origin") && styles.fieldBoxError]}
              onTouchStart={armPickerLayer("pickerLocation", "from")}
              onPress={() => {
                haptic("button");
                // `finishAnim` läuft bereits beim Aufsetzen des Fingers (siehe
                // armPickerLayer) — hier bleibt nur noch das Öffnen.
                triggerLocationPicker("from");
                }}
            >
              <FromIcon size={20} color={C.gray1} strokeWidth={1.9} />
              <Text
                style={[styles.routeText, !origin && styles.routeTextEmpty]}
                numberOfLines={1}
              >
                {origin ? origin.label : fromPlaceholder}
              </Text>
            </RippleTouch>

            <RippleTouch
              style={[styles.routeField, { backgroundColor: palette.s2 }, errors.has("destination") && styles.fieldBoxError]}
              onTouchStart={armPickerLayer("pickerLocation", "to")}
              onPress={() => {
                haptic("button");
                triggerLocationPicker("to");
                }}
            >
              <ToIcon size={20} color={C.gray1} strokeWidth={1.9} />
              <Text
                style={[styles.routeText, !destination && styles.routeTextEmpty]}
                numberOfLines={1}
              >
                {destination ? destination.label : toPlaceholder}
              </Text>
            </RippleTouch>
          </View>

          {/* Es dreht sich NUR das Symbol, nicht der Knopf: Den umrandeten Kreis
              pro Bild zu drehen zwingt Android zum Neurastern. Genauso im
              Ergebnis-Screen gelöst. */}
          <View style={styles.routeSwapWrap}>
            <RippleTouch
              borderless
              onPress={handleSwap}
              style={[styles.routeSwapBtn, { backgroundColor: accent.solid, borderColor: palette.s1 }]}
            >
              <Animated.View style={swapIconStyle}>
                <ArrowUpDown size={17} color={C.black} strokeWidth={2.6} />
              </Animated.View>
            </RippleTouch>
          </View>
        </View>
        </Reveal>

        <Reveal index={2}>
        {/* Datumsfelder: gleiche Höhe und Form wie die Orte, Kalendersymbol
            davor. Bei einfacher Fahrt nimmt das eine Feld die volle Breite. */}
        <View style={styles.dateRow}>
          <RippleTouch
            style={[styles.routeField, styles.dateField, { backgroundColor: palette.s2 }, errors.has("depart") && styles.fieldBoxError]}
            onTouchStart={armPickerLayer("pickerDate", "depart")}
            onPress={() => {
              haptic("button");
              // `finishAnim` läuft bereits beim Aufsetzen des Fingers (siehe
              // armPickerLayer) — hier bleibt nur noch das Öffnen.
              triggerDatePicker("depart");
            }}
          >
            <CalendarDays size={19} color={C.gray1} strokeWidth={1.9} />
            <Text style={[styles.routeText, styles.dateText, !departDate && styles.routeTextEmpty]} numberOfLines={1}>
              {departDate ? formatDate(departDate) : t("search.date.placeholder")}
            </Text>
          </RippleTouch>

          {isRoundtrip ? (
            <RippleTouch
              style={[styles.routeField, styles.dateField, { backgroundColor: palette.s2 }, errors.has("return") && styles.fieldBoxError]}
              onTouchStart={armPickerLayer("pickerDate", "return")}
              onPress={() => {
                haptic("button");
                triggerDatePicker("return");
                }}
            >
              <CalendarDays size={19} color={C.gray1} strokeWidth={1.9} />
              <Text style={[styles.routeText, styles.dateText, !returnDate && styles.routeTextEmpty]} numberOfLines={1}>
                {returnDate ? formatDate(returnDate) : t("search.date.placeholder")}
              </Text>
            </RippleTouch>
          ) : null}
        </View>
        </Reveal>

        <Reveal index={3}>
        <View style={styles.dateRow}>
          <View style={[styles.fieldBox, { backgroundColor: palette.s2 }, styles.flex1]}>
            <Text style={styles.fieldLabel}>{t("search.persons").toUpperCase()}</Text>
            <View style={styles.paxRow}>
              <RippleTouch
                onPress={() => {
                  haptic("button");
                  finishAnim();
                  setPax((p) => Math.max(1, p - 1));
                }}
                borderless
                style={[styles.paxBtn, { backgroundColor: palette.s3 }]}
              >
                <Text style={styles.paxBtnText}>−</Text>
              </RippleTouch>
              <Text style={styles.paxCount}>{pax}</Text>
              <RippleTouch
                onPress={() => {
                  haptic("button");
                  finishAnim();
                  setPax((p) => Math.min(9, p + 1));
                }}
                borderless
                style={[styles.paxBtn, styles.paxBtnPlus, { backgroundColor: accent.solid }]}
              >
                <Text style={[styles.paxBtnText, styles.paxBtnTextDark]}>+</Text>
              </RippleTouch>
            </View>
          </View>

          <View style={[styles.fieldBox, { backgroundColor: palette.s2 }, styles.flex1]}>
            <Text style={styles.fieldLabel}>{extraLabel.toUpperCase()}</Text>
            <View style={styles.pillRow}>
              {extraOpts.map((opt, i) => {
                const active = i === extraOpt;
                return (
                  <Pressable
                    key={opt}
                    onPress={() => {
                      haptic("button");
                      finishAnim();
                      setExtraOpt(i);
                    }}
                    style={[styles.pill, active && [styles.pillActive, { backgroundColor: accent.subtle, borderColor: accent.solid }]]}
                  >
                    <Text style={[styles.pillText, active && [styles.pillTextActive, { color: accent.solid }]]}>
                      {t(opt)}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </View>
        </View>
        </Reveal>

        <Reveal index={4}>
          {/* onTouchStart statt onPressIn — und das ist hier der Unterschied
              zwischen glatt und „manchmal ruckelig".

              Der Such-Screen legt beim Aufsetzen des Fingers seine GPU-Textur an,
              damit sie fertig ist, wenn gleich die Bewegung startet. Nur feuert
              `onPressIn` nicht beim Aufsetzen: RippleTouch hält es um 50ms zurück,
              damit nicht jede Berührung, die in Wirklichkeit ein Scrollen wird,
              sofort einen Ripple startet. Wer schnell tippt, löst innerhalb dieser
              50ms schon wieder aus — dann kommen Anforderung und Bewegungsstart im
              selben Moment, und das Rastern des schwersten Baums der App (die
              bildschirmfüllende Dünen-SVG) fällt genau in den Start. Wer langsam
              tippt, hat Vorlauf und sieht nichts davon. Exakt das war das
              „manchmal".

              `onTouchStart` feuert beim Aufsetzen, ohne Verzögerung. Der Grund für
              die 50ms bleibt trotzdem gewahrt: Wird aus der Berührung ein
              Scrollen, nimmt `onScrollBeginDrag` der Liste die Textur oben sofort
              wieder zurück.

              NUR dieser Screen. Ich hatte hier zusätzlich den Landingscreen
              vorbereitet — der ist unter diesem Screen aber vollständig verdeckt,
              und zwei bildschirmfüllende Rasterungen gleichzeitig im selben
              Fingerdruck kosten mehr, als die verdeckte Fläche je einbringt. */}
          {/* Der Druck-Effekt hängt an `onTouchStart`, NICHT an `onPressIn`.
              `RippleTouch` hält `onPressIn` um 50ms zurück, damit nicht jede
              Berührung, die ein Scrollen wird, einen Ripple startet. Ein
              normaler Tipp dauert aber kaum länger — der Knopf war wieder los,
              bevor die Feder überhaupt anlief, und man sah gar nichts. Die
              Kacheln im Landingscreen bouncen sichtbar, weil dort ein reines
              `Pressable` ohne diese Verzögerung sitzt. `onTouchStart` feuert
              beim Aufsetzen, also genauso früh. */}
          <View
            onTouchStart={() => {
              prepareHandoffLayer();
              ctaBounce.onPressIn();
            }}
            onTouchEnd={ctaBounce.onPressOut}
            onTouchCancel={ctaBounce.onPressOut}
          >
          <Animated.View style={ctaBounce.style}>
          <RippleTouch
            onPress={handleSubmit}
            rippleColor="rgba(0,0,0,0.32)"
            style={[styles.cta, { backgroundColor: accent.solid }]}
          >
            <Icon size={20} color="rgba(0,0,0,0.6)" style={styles.ctaIcon} />
            <Text style={styles.ctaText}>{t("search.cta.compare")}</Text>
          </RippleTouch>
          </Animated.View>
          </View>
        </Reveal>
      </ScrollView>

      {/* LocationPicker liegt am Root-Layout via LocationPickerHost.
          Trigger via openLocationPicker. */}

      {/* BinchDatePicker ist im Root-Layout via DatePickerHost gemountet —
          überdeckt damit auch die Nav-Bar. Trigger via openDatePicker. */}

      {/* preserve unused-tripTypeIds reference for future analytics hooks */}
      {tripTypeIds.length === 0 ? <View /> : null}
    </View>
    </ScreenEntrance>
  );
}

export const SearchHero = memo(SearchHeroComponent);

const styles = scaledStyles({
  container: { flex: 1, backgroundColor: C.bg },

  // Höhe 220 und der Rest der Geometrie 1:1 vom Auth-Screen (dort `band`).
  // Ohne `insets.top`: Das Band ist reine Grafik, die Statusleiste darf darüber
  // liegen — genau wie dort. Der Titel sitzt unten und kommt ihr nie nahe.
  hero: { height: 220, justifyContent: "flex-end", overflow: "hidden" },
  // Position + Typo identisch zur Header-Logo in app/(tabs)/index.tsx:
  // left=22, fontWeight=900 (Fett), letterSpacing=-0.6. Top wird via
  // insets.top + 16 inline gesetzt damit die Position auch ohne SafeAreaView
  // korrekt unter der StatusBar sitzt — identisch zur Landingpage
  // (scroll-paddingTop = insets.top + 8, plus Header-paddingTop = 8).
  // paddingBottom = 20 Überlappung des Sheets + 16 Luft. Sonst klebte der
  // grüne Strich unter der abgerundeten Oberkante.
  // paddingHorizontal 26 = das Innenmaß des Sheets, damit Titel und die
  // Auswahl darunter auf derselben Kante stehen.

  form: {
    flex: 1,
    marginTop: -20,
    borderTopLeftRadius: 26,
    borderTopRightRadius: 26,
    // Nötig, damit Android die runde Oberkante wirklich beschneidet — sonst
    // stehen die Ecken der Kinder darüber hinaus.
    overflow: "hidden",
  },
  // 20 statt 26 — GUTTER, dasselbe Maß wie im Landingscreen. Die 26 kamen aus
  // dem Anmelde-Screen; dort passen sie zu einem Blatt, das nur Formularfelder
  // trägt. Neben dem Landingscreen gelesen fiel der breitere Rand auf.
  formContent: { paddingHorizontal: GUTTER, paddingTop: 18, gap: 10 },
  /** Platz des Fortschrittsbalkens aus dem Auth-Screen (dort `navRow`). */
  navRow: { minHeight: 38, justifyContent: "center", marginBottom: 10 },

  toggleRow: {
    flexDirection: "row",
    backgroundColor: C.surface2,
    borderRadius: 14,
    padding: 4,
    gap: 4,
  },
  toggleBtn: { flex: 1, paddingVertical: 9, borderRadius: 11, alignItems: "center" },
  toggleBtnActive: {},
  toggleText: { fontSize: 13, fontWeight: "600", color: C.gray2 },
  toggleTextActive: { color: "#000" },

  // --- Von/Nach: Maße des Such-Knopfes, eine Zeile je Feld -----------------
  routeWrap: { position: "relative" },
  routeFields: { gap: 8 },
  routeField: {
    height: FIELD_H,
    borderRadius: 16,
    paddingLeft: 18,
    // Platz für den Tausch-Knopf, der rechts über der Fuge liegt.
    paddingRight: 62,
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    minWidth: 0,
    // Unsichtbar, aber reserviert — der rote Fehler-Zustand darf die Höhe nicht
    // verändern, sonst springt das Layout.
    borderWidth: 1,
    borderColor: "transparent",
  },
  routeText: { flex: 1, fontSize: 17, fontWeight: "600", color: C.white },
  /** Noch nichts gewählt → der Platzhalter tritt zurück. */
  routeTextEmpty: { color: C.gray2, fontWeight: "500" },
  routeSwapWrap: { position: "absolute", right: 10, top: "50%", marginTop: -22, zIndex: 3 },
  routeSwapBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    // Rand in der FENSTERfarbe — dadurch wirkt der Knopf aus beiden Feldern
    // ausgestanzt.
    borderWidth: 4,
    alignItems: "center",
    justifyContent: "center",
  },

  fieldBox: {
    backgroundColor: C.surface1,
    borderRadius: 16,
    padding: 14,
    // Rahmen bewusst unsichtbar: Die Breite bleibt reserviert, damit der rote
    // Fehler-Zustand keinen Layout-Sprung auslöst — die Box behält in jedem Fall
    // dieselbe Größe. Sichtbar abgegrenzt sind die Felder allein über die
    // Flächenfarbe (s2 auf dem s1-Fenster).
    borderWidth: 1,
    borderColor: "transparent",
  },
  fieldBoxError: { borderColor: C.red },
  flex1: { flex: 1 },
  fieldLabel: {
    fontSize: 11,
    fontWeight: "600",
    color: C.gray3,
    letterSpacing: 0.6,
    marginBottom: 6,
  },
  fieldInput: { fontSize: 22, fontWeight: "700", color: C.white, padding: 0 },

  dateRow: { flexDirection: "row", gap: 8 },
  /** Nebeneinander → kein Platz für den Tausch-Knopf, also weniger Rand rechts
   *  und engerer Abstand zum Symbol. */
  dateField: { flex: 1, paddingLeft: 14, paddingRight: 12, gap: 10 },
  dateText: { fontSize: 15 },

  paxRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 4 },
  paxBtn: {
    width: 30,
    height: 30,
    borderRadius: 9999,
    backgroundColor: C.surface3,
    alignItems: "center",
    justifyContent: "center",
  },
  paxBtnPlus: {},
  paxBtnText: { fontSize: 18, color: C.white, lineHeight: 22 },
  paxBtnTextDark: { color: "#000" },
  paxCount: { fontSize: 20, fontWeight: "700", color: C.white },

  pillRow: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 4 },
  pill: { paddingVertical: 5, paddingHorizontal: 10, borderRadius: 9999, backgroundColor: C.surface3 },
  // backgroundColor + borderColor inline mit accent.subtle / accent.solid.
  pillActive: { borderWidth: 1 },
  pillText: { fontSize: 11, fontWeight: "600", color: C.gray2 },
  pillTextActive: {},

  cta: {
    // EXAKT die Feldhöhe — das war der Wunsch: Felder so groß wie dieser Knopf.
    // Über dieselbe Konstante statt über zufällig passende Innenabstände.
    height: FIELD_H,
    borderRadius: 16,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    marginTop: 4,
  },
  ctaIcon: { marginRight: 8 },
  ctaText: { fontSize: 17, fontWeight: "700", color: "#000" },
});
