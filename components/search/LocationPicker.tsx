import { memo, useCallback, useEffect, useMemo, useState, useRef } from "react";
import { PICKER_IN, PICKER_OUT } from "@/lib/nav/overlayCover";
import { useSheetSlide } from "@/lib/nav/sheetSlide";
import { setSheetMoving } from "@/lib/nav/searchHandoff";
import { prepareLayer, releaseLayer } from "@/lib/nav/transitionLayer";
import { subscribeLayer } from "@/lib/nav/transitionLayer";
import {
  Dimensions,
  BackHandler,
  Keyboard,
  Platform,
  View,
  Text,
  Pressable,
  FlatList,
  ActivityIndicator,
  StyleSheet,
  useWindowDimensions,
} from "react-native";
import { usePalette } from "@/lib/theme/appBg";
import { useQuery } from "@tanstack/react-query";
import { X, Navigation, Plane, Train, Bus, Ship, Flag } from "lucide-react-native";
import Animated, { withTiming } from "react-native-reanimated";
import { Location, TravelMode } from "@/types/search";
import { fetchLocations } from "@/lib/api/client";
import { useT } from "@/lib/i18n/useT";
import { SearchBar } from "@/components/SearchBar";
import { useSearchStore } from "@/stores/searchStore";
import { useAccent } from "@/lib/theme/accent";
import { SaveStarButton } from "@/components/surroundings/SaveStarButton";
import { haptic } from "@/lib/haptics";

type Field = "from" | "to";

interface Props {
  visible: boolean;
  /** Liegt der Inhalt im Baum? Siehe Host — Aufbau im Leerlauf, danach fest. */
  mounted: boolean;
  /** Zählt je Öffnung hoch, schon beim BERÜHREN — siehe Host. */
  session: number;
  onClose: () => void;
  onSelect: (loc: Location) => void;
  field?: Field;
  mode: TravelMode | "ALL";
  recent?: Location[];
  suggested?: Location[];
  /** Optional Header-Titel — überschreibt den feldbasierten Default
   *  ("Where from?" / "Where to?"). */
  title?: string;
  /** Optionales Leading-Label im Such-Input — überschreibt den feldbasierten
   *  Default ("From" / "To"). Leerstring blendet das Label komplett aus. */
  leadingLabel?: string;
  /** Override-Placeholder für die Search-Bar (i18n-Key). */
  placeholderKey?: string;
  /**
   * „Aktueller Standort" — was passiert beim Antippen.
   *
   * Ohne Angabe wird die Zeile gar nicht erst gezeigt; Begründung im JSX.
   */
  onCurrentLocation?: () => void;
}

const MODE_ICON = { FLIGHT: Plane, TRAIN: Train, BUS: Bus, CRUISE: Ship } as const;

/**
 * Der Parkplatz — EXAKT wie beim Such-Blatt.
 *
 * Dort steht `Dimensions.get("window").height`, einmal beim Laden gelesen
 * (`SearchHeroOverlay`: `const { height: SH } = Dimensions.get("window")`).
 * Ich hatte hier die GERÄTE-höhe genommen, um sicher unter den Bildrand zu
 * kommen — das sind auf einem üblichen Gerät 72 Punkte mehr. Bei gleicher Dauer
 * heißt mehr Weg schlicht mehr Geschwindigkeit: 92 statt 85 Punkte pro Bild.
 * Genau solche 9% sind der Unterschied zwischen „läuft wie das andere" und
 * „wirkt hektischer".
 *
 * Einmal beim Laden gelesen ist auch die Fenster-Höhe unbedenklich: Zu dem
 * Zeitpunkt gibt es keine Tastatur, die sie verkleinern könnte.
 */
const PARK_Y = Dimensions.get("window").height;
const EMPTY_LOCATIONS: Location[] = [];
/** Stabile Vorgaben für die Liste — siehe dort. */
type SuggestItem =
  | { kind: "header"; key: string; title: string }
  | { kind: "row"; key: string; loc: Location; suggested?: boolean };
const LIST_PAD = { paddingBottom: 32 } as const;

/**
 * GEMERKT — sonst rendert der ganze Wähler im ersten Bild der Ausfahrt neu.
 *
 * Der Wirt hört am Speicher; das Bestätigen schreibt Ergebnis und Auftrag in
 * einem Zug, also genau dann, wenn die Rückfahrt losläuft. Er rendert dabei
 * dieselben Eigenschaften noch einmal — ohne Schranke lief der komplette Baum
 * dieses Wählers trotzdem durch, samt Einbau-Schritten auf dem UI-Strang.
 *
 * Alle Eigenschaften sind stabil: Speicher-Aktionen, Werte aus dem gemerkten
 * Auftrag, und die Zahlen für Sichtbarkeit und Sitzung wechseln inzwischen
 * ausschließlich außerhalb der Bewegung.
 */
const LocationPickerInner = function LocationPicker({
  visible,
  mounted,
  session,
  onClose,
  onSelect,
  field = "from",
  mode,
  // Beide Vorgaben als KONSTANTEN, nicht als Literale.
  // `recent` wird vom Host gar nicht übergeben; als `[]` im Kopf war es bei
  // jedem Durchgang ein neues Array — damit änderte sich `visibleRecent`, damit
  // `sections`, und die Klammer darüber („EINMAL bauen") lief ins Leere.
  recent = EMPTY_LOCATIONS,
  suggested = EMPTY_LOCATIONS,
  title,
  leadingLabel,
  placeholderKey = "search.location.placeholder",
  onCurrentLocation,
}: Props) {
  const palette = usePalette();
  const t = useT();
  const accent = useAccent();
  const [query, setQuery] = useState("");
  const debounced = useDebounce(query, 200);
  const savedStations = useSearchStore((s) => s.savedStations);
  // Im ALL-Mode zeigen wir alle gespeicherten Stationen, sonst nur die zum
  // aktuellen Mode passenden. ALL-Type-Stationen (z.B. Cities) sind mode-
  // agnostisch und werden überall mit angezeigt.
  const filteredSaved = useMemo(() => {
    if (mode === "ALL") return savedStations;
    return savedStations.filter((s) => s.type === mode || s.type === "ALL");
  }, [savedStations, mode]);

  // Gespeicherte Stationen erscheinen NUR unter „Gespeichert" — aus den
  // Vorschlägen und Recents ausblenden, sonst steht dieselbe Station doppelt
  // in der Liste (z.B. direkt nach dem Speichern aus den Vorschlägen heraus).
  const savedCodes = useMemo(() => new Set(savedStations.map((s) => s.code)), [savedStations]);
  const visibleRecent = useMemo(
    () => recent.filter((l) => !savedCodes.has(l.code)),
    [recent, savedCodes],
  );
  // Vorschläge, deren Code beim Start-Check nicht zu ihrem Label passte, fliegen
  // raus. Die Liste ist hartkodiert (POPULAR_LOCATIONS) und kann von der DB
  // abdriften — real passiert: „Wien Hbf" trug den Code von „Inzersdorf Wien
  // Blumental Bahnhof". Das Label sah richtig aus, die Suche fuhr aber stumm in
  // den falschen Ort. Lieber gar nicht anbieten als falsch hinschicken.
  const invalidSuggestionCodes = useSearchStore((s) => s.invalidSuggestionCodes);
  const visibleSuggested = useMemo(
    () =>
      suggested.filter(
        (l) => !savedCodes.has(l.code) && !invalidSuggestionCodes.includes(l.code),
      ),
    [suggested, savedCodes, invalidSuggestionCodes],
  );

  /**
   * Geleert wird bei einer NEUEN Öffnung, nicht über einen Zeitgeber nach dem
   * Schließen.
   *
   * Der Zeitgeber hatte ein Loch: Öffnet man innerhalb der Ausfahrt erneut,
   * räumt das Aufräumen ihn weg und die Sichtbarkeit kippt nie — der Wähler
   * stand dann mit der alten Eingabe und der alten Trefferliste da, obwohl
   * inzwischen das andere Feld gemeint war.
   *
   * Die Sitzungs-Kennung kennt diesen Fall nicht: Sie zählt bei jedem Berühren
   * hoch, also auch beim schnellen Zweiten. Und sie tut es im Berührungsfenster,
   * lange vor der Fahrt.
   */
  const lastSessionRef = useRef(session);
  useEffect(() => {
    if (session === lastSessionRef.current) return;
    lastSessionRef.current = session;
    setQuery("");
  }, [session]);

  const { data: results, isLoading, isError, error } = useQuery({
    queryKey: ["locations", mode, debounced],
    queryFn: () => fetchLocations(debounced, mode),
    enabled: visible && debounced.trim().length >= 2,
    staleTime: 5 * 60 * 1000,
    // Mehrfacher Retry mit kurzem Backoff — verhindert dass ein einzelner
    // Cold-Start-Timeout den Search-Flow blockiert (User musste sonst über
    // Tab-Switch das Component-Remount erzwingen damit's wieder klappt).
    retry: 3,
    retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 4000),
    // Wenn der Picker geschlossen + wieder geöffnet wird, frischen Versuch
    // starten (auch wenn das vorherige Ergebnis ein Error war).
    refetchOnMount: "always",
  });

  /**
   * Auch an der ROHEN Eingabe hängen, nicht nur an der entprellten.
   *
   * Beim Schließen wird die Eingabe geleert; die Entprellung zieht 200ms später
   * nach. In diesem Fenster stand die alte Trefferliste noch, obwohl das Feld
   * längst leer war — bei schnellem Wiederöffnen also sichtbar, und der Wechsel
   * fiel mitten in die Einfahrt.
   */
  const showSearchResults =
    query.trim().length >= 2 && debounced.trim().length >= 2;

  // Slide-Animation via Reanimated.View statt RN Modal. Vorher hat der
  // Modal-Native-Layer auf Android beim ERSTEN Open eine Dialog-Init
  // gestartet → spürbares Input-Lag. Jetzt ist der Overlay IMMER mounted
  // (nur translateY/opacity-getrieben), erster Tap → null Cold-Start.
  const { height: screenH } = useWindowDimensions();
  const {
    y: offset,
    style: overlayStyle,
    run: runSheet,
    parkNow,
    warm: warmSlide,
  } = useSheetSlide("pickerLocation", PARK_Y);

  // Pre-warm: einmaliger no-op withTiming am Mount damit Reanimated v4
  // die Worklets JIT-kompiliert BEVOR der User zum ersten Mal tippt.
  useEffect(() => {
    /**
     * Kalt-Anlauf mit der ECHTEN Vorgabe, nicht mit `{ duration: 1 }`.
     *
     * Hier stand eine 1ms-Bewegung mit Standardkurve. Die parkt das Blatt zwar
     * korrekt, läuft aber durch einen ANDEREN Code-Pfad als die spätere echte
     * Fahrt: `PICKER_IN` trägt eine Bézier-Kurve, und deren Aufbau passiert dann
     * beim ersten echten Öffnen. Genau deshalb ruckelt es beim ersten Mal am
     * stärksten.
     *
     * Das Such-Blatt macht das seit Längerem richtig und begründet es wörtlich:
     * „Beide laufen mit den ECHTEN Konfigurationen, damit wirklich derselbe Pfad
     * durchlaufen wird und nicht bloß ein ähnlicher."
     *
     * Der Weg ist verschwindend klein und liegt außerhalb des Bildes — sichtbar
     * ist davon nichts, gewärmt wird trotzdem der richtige Pfad.
     */
    /**
     * EIN BILD später — sonst löscht das Parken den Anlauf sofort wieder.
     *
     * Der Parkplatz-Effekt weiter unten läuft beim Aufsetzen ebenfalls und
     * schreibt `offset.value` direkt. Eine direkte Zuweisung bricht eine
     * laufende Kurve ab; der Anlauf war damit tot, und das erste echte Öffnen
     * zahlte genau die Kosten, gegen die er gedacht ist.
     */
    /**
     * Der Anlauf kommt aus der gemeinsamen Fahrt (`warmSlide`) — sonst wärmt er
     * eine andere Funktion als die, die später wirklich fährt.
     */
    const id = requestAnimationFrame(() => warmSlide());
    return () => cancelAnimationFrame(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Die Ebene gilt für die DAUER DER BEWEGUNG — in beide Richtungen.
   *
   * Vorher hing sie allein an `prepareLayer` (Berührung des Feldes). Das deckt
   * das Hereinfahren ab, aber nicht das Hinausfahren: Die Vorbereitung verfällt
   * nach 1,4 Sekunden von selbst, und in einem Picker ist man länger. Jedes
   * Schließen lief damit ganz ohne Ebene — und über der Ansicht steht
   * ausdrücklich, dass genau das schon einmal messbare Bildverluste erzeugt hat.
   *
   * Beides zusammen ist richtig: `prepareLayer` legt sie im Berührungsfenster an
   * (dort sind die 66ms Aufbau umsonst), und dieser Zustand hält sie über beide
   * Fahrten. Was die Vorbereitung schon angelegt hat, wird dadurch nicht neu
   * gebaut — es bleibt einfach bestehen.
   *
   * DAUERHAFT darf sie nicht sein, und das ist der Grund, warum hier vorher
   * `elevation: 32` stand und wieder wegmusste: Unter ihr scrollt eine Liste.
   * Eine Ebene über einer scrollenden Fläche muss bei jedem Scroll-Bild neu
   * entstehen — schlimmer als gar keine.
   */
  // KEIN eigenes Bild-Handle mehr: Das Warten auf das nächste Bild steckt
  // in `useSheetSlide` — beide Wähler nutzen dasselbe.
  const [moving, setMoving] = useState(false);
  const moveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const holdLayerFor = (ms: number) => {
    setMoving(true);
    if (moveTimer.current) clearTimeout(moveTimer.current);
    moveTimer.current = setTimeout(() => setMoving(false), ms + 80);
  };
  /**
   * Sicherheitsnetz für die Fahrt-Meldung.
   *
   * Der Rückruf am Ende der Kurve läuft NICHT, wenn die Bewegung abgebrochen
   * wird (zweiter Tipp, Schließen mittendrin). Ohne dieses Netz bliebe die
   * Meldung dauerhaft auf „fährt", und die Übergabe-Textur würde nie wieder
   * freigegeben — der Such-Bildschirm bliebe eine bildschirmfüllende GPU-Fläche,
   * die bei jeder Eingabe neu rastert. Genau dieser Fehler ist in
   * `searchHandoff` für den anderen Weg schon ausformuliert.
   */
  const movingGuard = useRef<ReturnType<typeof setTimeout> | null>(null);
  const armMovingGuard = (ms: number) => {
    if (movingGuard.current) clearTimeout(movingGuard.current);
    movingGuard.current = setTimeout(() => setSheetMoving(false, "pickerLocation"), ms + 200);
  };
  useEffect(
    () => () => {
      if (moveTimer.current) clearTimeout(moveTimer.current);
      if (movingGuard.current) clearTimeout(movingGuard.current);
    },
    [],
  );

  /**
   * Nur auf einen echten WECHSEL reagieren — nicht auf jedes Auslösen.
   *
   * Zwei Fälle liefen hier bisher falsch mit:
   *
   *  1. Der allererste Durchgang. Beide Wähler hängen dauerhaft am Baum, und
   *     beide fielen beim Start in den Schließen-Zweig: Sie meldeten „fährt",
   *     forderten eine Ebene an und gaben sie 420ms später wieder frei —
   *     mitten in den Start der App hinein, ohne dass sich etwas bewegt hätte.
   *  2. `screenH` steht in den Abhängigkeiten. Ändert sich das Fenstermaß,
   *     während der Wähler OFFEN ist (Tastatur mit `adjustResize`,
   *     geteilter Bildschirm), lief der Zweig erneut — und schob das Blatt
   *     einmal komplett aus dem Bild und wieder herein.
   */
  const wasVisible = useRef<boolean | null>(null);
  /**
   * Die Bewegung startet DIREKT aus dem Speicher — ohne auf ein Rendern zu
   * warten. Das ist der Weg des Such-Blattes.
   *
   * Sie hing bisher am `visible`-Prop, also am Ergebnis eines Durchgangs durch
   * React: Speicher schreiben → Host rendert → Wähler rendert (kompletter Baum)
   * → Effekt → ein Bild → Kurve. Der teure Teil lag damit unmittelbar vor dem
   * Start, und auf Fabric fallen die Einbau-Schritte dazu auf denselben Strang
   * wie die Bewegung.
   *
   * Jetzt hört das Blatt selbst zu. Der Rückruf läuft in DEMSELBEN Aufruf, der
   * den Speicher beschreibt — noch vor jedem Rendern. Das Prop kommt ein Bild
   * später nach und trägt nur noch, was React braucht (siehe Host).
   */
  const runSlide = useRef<(v: boolean) => void>(() => {});
  useEffect(
    () =>
      useSearchStore.subscribe((st, prev) => {
        const now = st.locationPickerRequest !== null;
        const was = prev.locationPickerRequest !== null;
        if (now !== was) runSlide.current(now);
      }),
    [],
  );

  /**
   * Die eigentliche Fahrt — aufgerufen vom Speicher-Abonnement oben, nicht von
   * einem Rendern. Beide Richtungen laufen identisch aufgebaut: Ebene halten,
   * anmelden, EIN Bild zeichnen lassen, dann die Kurve. Genau die Reihenfolge
   * des Such-Blattes.
   */
  /**
   * Die Fahrt selbst kommt aus `useSheetSlide` — EINE Quelle für alle Blätter.
   *
   * Hier bleibt nur, was diesem Wähler eigen ist: die Ebene halten, den
   * Wächter scharf stellen und die Unterlage mitnehmen. Strecke, Kurve, Dauer,
   * Reihenfolge und Anmeldung stecken in der gemeinsamen Fahrt und können
   * dadurch nicht mehr abweichen.
   */
  const slide = useCallback(
    (show: boolean) => {
      const cfg = show ? PICKER_IN : PICKER_OUT;
      /**
       * Beim Schließen ZUERST die Tastatur — vor allem anderen.
       *
       * Unter `adjustResize` verkleinert das Fenster sich dabei, und der
       * gesamte Wurzelbaum wird neu vermessen. Diese Arbeit gehört vor die
       * Bewegung, nicht mitten hinein. Die häufigsten Wege dorthin (Zeile
       * antippen, X-Knopf) verlegen sie schon aufs Aufsetzen des Fingers; hier
       * werden die übrigen mitgenommen — Zurück-Geste, Verdunkelungs-Tipp,
       * Auswahl über die Umgebungs-Karte.
       */
      if (!show) Keyboard.dismiss();
      if (!layeredRef.current) holdLayerFor(cfg.duration + (show ? 16 : 0));
      armMovingGuard(cfg.duration);
      runSheet(show);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [runSheet],
  );
  runSlide.current = slide;

  /**
   * Beim allerersten Durchgang nur PARKEN.
   *
   * Es bewegt sich nichts, es wird also auch nichts gemeldet — sonst gälte der
   * Bildschirm beim Start der App als „fährt".
   */
  useEffect(() => {
    if (wasVisible.current !== null) {
      wasVisible.current = visible;
      return;
    }
    wasVisible.current = visible;
    if (!visible) parkNow();
  }, [visible, offset, screenH]);

  /**
   * Bei geändertem Fenstermaß neu parken, solange geschlossen.
   *
   * Der Parkplatz ist die Fensterhöhe. Ändert die sich, während der Wähler
   * unten steht (Tastatur unter `adjustResize`, geteilter Bildschirm), bliebe
   * der alte Wert stehen — und ein deckendes Blatt lugte unten ins Bild und
   * schluckte Berührungen.
   */
  /**
   * KEIN Neu-Parken bei geändertem Fenstermaß mehr.
   *
   * Hier stand ein Effekt, der bei einer Änderung `parkNow()` rief — und der
   * schreibt die beim Laden gemerkte Höhe zurück, also genau den Wert, den er
   * korrigieren sollte. Er konnte nichts bewirken.
   *
   * Die Ausrichtung ist auf Hochkant festgelegt; die Fensterhöhe ändert sich zur
   * Laufzeit nur durch die Tastatur, und die verkleinert sie — der Parkplatz
   * liegt dann also weiter unten als nötig, nie zu hoch. Sichtbar werden kann
   * dabei nichts.
   */

  // Picker selbst NUR translateY, KEINE Opacity — sonst fadet er beim
  // Slide-Out (160ms) schneller weg als er translatet (280ms) und der
  // User sieht nur einen Disappear-Effekt statt einem Slide. Mit reinem
  // translateY ist der Picker während der gesamten 280ms voll sichtbar
  // bis er off-screen ist.


  // Inner content (FlatList, SearchBar) wird IMMER gemountet — analog zum
  // DatePicker. Mit always-mount ist das Inner-Tree bereits zu App-Start
  // gerendert → Slide-In startet sauber ohne Mount-Konkurrenz.

  /**
   * Hardware-Ebene und Schatten NUR während der Slide.
   *
   * Dieser Picker hängt für die ganze Sitzung am Wurzel-Layout (siehe
   * LocationPickerHost) — bildschirmfüllend, mit `elevation: 32` und explizit
   * angeforderter Hardware-Textur. Beides galt dauerhaft, obwohl er fast immer
   * geschlossen ist: Android hielt also durchgehend eine bildschirmgroße Textur
   * samt Schatten-Durchlauf für etwas vor, das man nicht sieht.
   *
   * Beim Date-Picker wurde genau das bereits erkannt und behoben (siehe der
   * Kommentar an dessen Wurzel-Style) — beim Location-Picker nie angewendet.
   *
   * DIE EBENE IST GANZ ENTFALLEN — und das ist die Korrektur.
   *
   * Sie nur noch während der Bewegung zu halten, war die halbe Lösung: Sie wurde
   * dann im SELBEN Durchlauf eingeschaltet, in dem die Bewegung startet. Der
   * Aufbau einer bildschirmfüllenden Ebene ist in diesem Projekt mit 66ms
   * vermessen — bei 120Hz acht Bilder, in ein Fenster von einem. Der Schatten
   * (`elevation: 32`) kam im selben Bild dazu. Damit lag der teuerste
   * Einzelvorgang der ganzen Datei exakt im Start der Slide.
   *
   * Der Datumswähler hat diese Ebene aus genau diesem Grund schon gestrichen,
   * mit ausgeschriebener Begründung an seinem Wurzel-Stil: Das Blatt ist
   * vollflächig und deckend, sein Schatten liegt außerhalb des Bildes, und ohne
   * Ebene kostet das Verschieben zwar jedes Bild etwas — aber GLEICHMÄSSIG. Ein
   * einzelner Klotz am Anfang liest sich als Hängen, gleichmäßige Kosten als
   * flüssig. Dieselbe Abwägung steht beim Such-Blatt und bei der Ergebnisliste.
   *
   * NACHTRAG — und das ist die eigentliche Lehre: Sie ganz zu streichen war
   * ebenfalls falsch. Ohne Ebene wird dieses bildschirmfüllende Blatt in JEDEM
   * Bild der Fahrt neu gezeichnet (im Projekt mit 14,7ms gegen 8,3ms Budget
   * vermessen) — das ist als Ruckeln deutlich sichtbar, während die 66ms Aufbau
   * sich vorher nur als einzelner Aussetzer zeigten. Beide Fassungen waren
   * schlecht, weil beide am ZEITPUNKT vorbeigingen.
   *
   * Richtig ist der Weg, den das Textur-Modul vorgibt: anlegen, wenn der Finger
   * das Feld BERÜHRT, das den Picker öffnet. Zwischen Aufsetzen und Loslassen
   * liegen 80 bis 150ms, die ohnehin verstreichen — dort ist Platz für die
   * 66ms. Wenn die Bewegung dann startet, steht die Ebene bereits, und jedes
   * Bild ist nur noch ein Kopiervorgang.
   */
  const [layered, setLayered] = useState(false);
  // Spiegel für den Fahrt-Rückruf: Der läuft aus einem Abonnement heraus und
  // säße sonst auf dem Stand des Durchgangs, in dem er angelegt wurde.
  const layeredRef = useRef(false);
  layeredRef.current = layered;
  useEffect(() => subscribeLayer("pickerLocation", setLayered), []);

  // BackHandler: hardware-back/Geste schließt den Picker statt den ganzen
  // SearchHero zu verlassen. Vorher hat das Modal das automatisch gemacht
  // via onRequestClose — jetzt müssen wir's manuell intercepten.
  /**
   * Die Zurück-Taste hängt am SPEICHER, nicht an der verzögerten Sichtbarkeit.
   *
   * `visible` kippt inzwischen erst nach dem Ende der Fahrt — in den 300ms
   * davor deckte das Blatt schon den ganzen Bildschirm, hatte aber keinen
   * Abfangring. Zuständig war dann der des Such-Blattes: Eine Zurück-Geste
   * während der Einfahrt schloss also die SUCHE, während der Wähler deckend
   * liegen blieb. Aus der Umgebungs-Karte gab es gar keinen — dort wurde der
   * Reiter verlassen.
   *
   * Angemeldet wird, solange der Inhalt im Baum liegt; ob wirklich offen ist,
   * entscheidet der Speicher im Moment des Drucks. Kein Rendern, keine
   * Verzögerung.
   */
  useEffect(() => {
    if (Platform.OS !== "android" || !mounted) return;
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      if (useSearchStore.getState().locationPickerRequest === null) return false;
      onClose();
      return true;
    });
    return () => sub.remove();
  }, [mounted, onClose]);

  const handleSelect = useCallback(
    (loc: Location) => {
      // VOR dem Speicher-Schreibvorgang: Das Schließen der Tastatur verkleinert
      // unter `adjustResize` das Fenster und erzwingt eine Neuvermessung des
      // gesamten Baums — und der ist hier groß, weil rund fünfzehn
      // bildschirmfüllende Überlagerungen dauerhaft gemountet sind. Lag das im
      // selben Commit wie das Schließen, fiel diese Vermessung vollständig in
      // die Ausfahrt. Ein paar Millisekunden früher heißt: Sie beginnt, bevor
      // sich das Blatt bewegt.
      Keyboard.dismiss();
      /**
       * NUR bestätigen — das Schließen ist darin schon enthalten.
       *
       * Hier stand zusätzlich `onClose()`. `confirmLocationPicker` setzt den
       * Auftrag aber bereits auf `null` (beide Zweige, auch der mit eigenem
       * Rückruf), das zweite Schreiben änderte also nichts — kostete aber einen
       * vollständigen zweiten Durchlauf durch alle Speicher-Abonnenten, im
       * selben Bild wie der Start der Ausfahrt.
       */
      onSelect(loc);
    },
    [onSelect],
  );

  // Stabile renderItem-Referenz für die FlatList — zusammen mit dem memo auf
  // PickerRow bailen alle Zeilen beim visible-Flip des Pickers aus statt im
  // Animations-Start-Commit neu zu rendern.
  const renderResultRow = useCallback(
    ({ item }: { item: Location }) => (
      <PickerRow loc={item} onSelect={handleSelect} />
    ),
    [handleSelect],
  );
  const keyExtractor = useCallback((i: Location) => i.code, []);

  /**
   * Die Vorschläge als DATEN statt als fertiger Baum — damit sie virtualisiert
   * werden.
   *
   * Sie hingen komplett im Listenkopf, und was dort steht, ist von der
   * Virtualisierung ausgenommen: Alle drei Abschnitte waren dauerhaft gebaut,
   * bei voller Liste rund 25 Zeilen — jede mit einem SVG-Symbol und einem
   * Stern-Knopf, der seinerseits zwei Reanimated-Werte, zwei animierte Stile
   * und eigene SVG-Wurzeln mitbringt. Das sind grob fünfzig SVG-Flächen INNEN
   * im fahrenden Blatt.
   *
   * Als Daten gereicht hält die Liste nur, was ins Bild passt, plus einen
   * kleinen Puffer. Sichtbar ändert sich nichts — die Zeilen sehen aus wie
   * vorher, es sind nur weniger davon gleichzeitig da.
   */
  const suggestData = useMemo<SuggestItem[]>(() => {
    const out: SuggestItem[] = [];
    const add = (title: string, list: Location[], key: string, suggested?: boolean) => {
      if (list.length === 0) return;
      out.push({ kind: "header", key: `h-${key}`, title });
      for (const loc of list) out.push({ kind: "row", key: `${key}-${loc.code}`, loc, suggested });
    };
    add(t("search.location.saved"), filteredSaved, "saved");
    add(t("search.location.recent"), visibleRecent, "recent");
    add(t("search.location.suggested"), visibleSuggested, "sugg", true);
    return out;
  }, [filteredSaved, visibleRecent, visibleSuggested, t]);

  const renderSuggest = useCallback(
    ({ item }: { item: SuggestItem }) =>
      item.kind === "header" ? (
        <Text className="text-base font-bold text-white mt-4 mb-2 px-5">{item.title}</Text>
      ) : (
        <PickerRow loc={item.loc} onSelect={handleSelect} suggested={item.suggested} />
      ),
    [handleSelect],
  );
  const keySuggest = useCallback((i: SuggestItem) => i.key, []);

  return (
    <>
            {/*
        KEINE Verdunkelungs-Ebene mehr — und das ist der zweite strukturelle
        Unterschied zum Such-Blatt, das als Vorbild dient.

        Hier lag eine bildschirmfüllende Fläche mit `rgba(0,0,0,0.75)`, deren
        Deckkraft über die volle Fahrt von 0 auf 1 lief. Das kostet dreifach:

          • ein zweiter vollflächiger Auswerter pro Bild, zusätzlich zum Blatt
          • ein vollflächiger Alpha-Durchgang in JEDEM Bild
          • und das Schwerste: Solange oben etwas Halbdurchsichtiges liegt, kann
            Android die Fläche darunter nicht als verdeckt überspringen. Der
            Himmel-und-Dünen-SVG des Such-Bildschirms musste also die ganzen
            300ms mitgezeichnet werden, statt nach den ersten Bildern
            wegzufallen.

        Das Such-Blatt im Landingscreen hat nichts dergleichen: Es ist deckend
        und verdeckt schlicht, was darunter liegt. Genau dieses Verhalten war
        gewünscht.

        Sichtbar war die Verdunkelung ohnehin nur während der Fahrt — sobald das
        Blatt oben steht, deckt es alles ab.
      */}

      {/* Der bewegte Knoten: NUR Verschiebung, deckende Fläche, Sortierung.
          Alles Schwere (Suchleiste, Listen, Zeilen) liegt in der Hülle
          darunter, und die trägt auch die Textur — sonst müsste der
          Compositor in jedem Bild den ganzen Unterbaum neu rastern. */}
      <Animated.View
      collapsable={false}
      style={[
        StyleSheet.absoluteFillObject,
        {
          backgroundColor: palette.s1,
          zIndex: 9999,
          /**
           * `elevation` MUSS hier stehen — `zIndex` allein reicht auf Android
           * nicht.
           *
           * Android sortiert Geschwister nach Höhe, und mehrere dauerhaft
           * gemountete Blätter am Wurzel-Layout tragen eine: Halt-Blatt 16,
           * Strecken-Blatt 32, die Hinweis-Streifen 32. Ohne eigene Höhe
           * zeichnet sich der Wähler unter sie — nachstellbar über Umgebung →
           * Halt öffnen → Suchleiste antippen.
           *
           * Der Schatten dazu ist unsichtbar: Das Blatt ist bildschirmfüllend
           * und deckend, seine Ränder liegen außerhalb. Genau deshalb wurde die
           * Höhe damals entfernt — nur ist dabei die Sortierung mitgegangen.
           */
          elevation: 40,
          /**
           * Höhe ja, Schatten nein.
           *
           * Gebraucht wird von `elevation` hier nur die SORTIERUNG gegen die
           * Geschwister am Wurzel-Layout. Der Schatten selbst ist unsichtbar —
           * das Blatt ist bildschirmfüllend und deckend, seine Ränder liegen
           * außerhalb. Gezeichnet wurde er trotzdem: Android rechnet für eine
           * 40er Höhe einen Umgebungs- und einen Spot-Schatten über die
           * gesamte Kontur, in jedem Bild der Fahrt. Durchsichtig gesetzt
           * entfällt der Durchgang, die Reihenfolge bleibt.
           */
          shadowColor: "transparent",
        },
        overlayStyle,
      ]}
    >
      {/**
        * `pointerEvents` sitzt bewusst HIER und nicht auf der animierten View.
        *
        * Es wechselt in genau dem Durchgang, in dem die Fahrt beginnt — und ein
        * Eigenschafts-Wechsel ist auf Fabric ein Commit auf eben dem Knoten, den
        * Reanimated gerade Bild für Bild beschreibt. Der Commit trägt die
        * Eigenschaften des Schattenbaums neu auf, die synchronen Schreibvorgänge
        * der Bewegung laufen also dagegen an.
        *
        * Auf einer vollflächigen Hülle darunter hat es dieselbe Wirkung für die
        * Berührungen — nur abseits des animierten Knotens.
        */}
      {/**
          * KEIN `pointerEvents` mehr — geparkt liegt das Blatt außerhalb des
          * Bildes und kann ohnehin nichts abfangen.
          *
          * Gegatet hing es an der verzögerten Sichtbarkeit: Nach dem Ende der
          * Einfahrt stand das Blatt dadurch mehrere Bilder lang sichtbar, aber
          * tot — kein Tippen in die Leiste, keine Zeile, kein X. Und jeder
          * Wechsel wäre ein Commit gewesen, den wir aus der Fahrt heraushalten
          * wollen.
          */}
        {/**
          * Die Textur sitzt auf DIESER Hülle, nicht auf dem animierten Knoten.
          *
          * Der Schalter kippt genau dann, wenn die Fahrt anfängt — und ein
          * Eigenschafts-Wechsel auf dem animierten Knoten ist auf Fabric ein
          * Commit gegen ebendie Bewegung, die Reanimated dort Bild für Bild
          * schreibt (dieselbe Begründung wie bei `pointerEvents` darüber). Auf
          * der Hülle wirkt er unverändert: Sie trägt den gesamten schweren
          * Inhalt, der animierte Knoten darüber zeichnet nur noch eine
          * deckende Fläche und verschiebt die fertige Textur.
          */}
        <View
          style={StyleSheet.absoluteFill}
          collapsable={false}
          renderToHardwareTextureAndroid={Platform.OS === "android" && (layered || moving)}
        >
        {mounted && (
        <>
        <View className="flex-row items-center gap-3 px-5 pt-14 pb-4">
          {/**
            * `Pressable` statt `RippleTouch` — dieselbe Begründung wie bei den
            * Zeilen weiter unten, nur schärfer: Dieser Knopf STARTET die
            * Ausfahrt. Der native Wellen-Effekt ist eine 300 bis 400ms lange
            * Zeichen-Animation mitten auf dem Blatt, das für genau diese
            * Ausfahrt als GPU-Textur gehalten wird — und eine Ebene, deren
            * Inhalt sich ändert, muss in jedem Bild neu gerastert werden. Die
            * Welle lief also über die volle Dauer der Rückfahrt gegen sie an.
            */}
          <Pressable
            hitSlop={12}
            /**
             * Die Ebene schon beim AUFSETZEN des Fingers anlegen.
             *
             * Für die Einfahrt passiert das seit Längerem (`prepareLayer` beim
             * Berühren des Feldes), und die Begründung steht in
             * `pickerPreload`: Der Aufbau der Textur kostet im Projekt
             * gemessene 66ms bei einem Bildbudget von 8,3ms. Für die AUSFAHRT
             * gab es diesen Vorlauf nicht — dort wurde sie erst angefordert,
             * als die Bewegung schon lief, und lag damit als voller Aufbau im
             * ersten Bild der Rückfahrt.
             *
             * Zwischen Aufsetzen und Loslassen liegt genug Zeit, und dort
             * kostet es nichts.
             */
            // Textur beim Aufsetzen (kostenlos, jederzeit zurücknehmbar),
            // die Tastatur aber erst beim gedrückten Zustand: Ein abgebrochener
            // Tipp soll sie nicht schließen, während der Wähler offen bleibt.
            onTouchStart={() => prepareLayer("pickerLocation")}
            onPressIn={() => {
              // Und dieselbe Vorverlegung wie bei der Auswahl einer Zeile, wo
              // sie wörtlich begründet steht: Unter `adjustResize` verkleinert
              // das Schließen der Tastatur das Fenster und erzwingt eine
              // Neuvermessung des GESAMTEN Baums — und der ist hier groß, weil
              // rund fünfzehn bildschirmfüllende Überlagerungen dauerhaft
              // gemountet sind. Über den X-Knopf lag genau diese Vermessung
              // bisher vollständig in der Ausfahrt.
              Keyboard.dismiss();
            }}
            onPress={onClose}
            accessibilityLabel={t("search.close")}
            style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
          >
            <X color="#E5E7EB" size={26} />
          </Pressable>
          <Text className="text-2xl font-semibold text-white">
            {title ?? t(field === "from" ? "search.location.title.from" : "search.location.title.to")}
          </Text>
        </View>

        <View className="px-5 pb-3">
          <SearchBar
            value={query}
            onChangeText={setQuery}
            placeholderKey={placeholderKey}
            leadingLabel={
              leadingLabel === undefined
                ? t(field === "from" ? "search.from" : "search.to")
                : leadingLabel || undefined
            }
            showMic={false}
            /**
             * Die Tastatur öffnet erst NACH der Bewegung — und die Zahl dafür
             * wird jetzt ausgerechnet, nicht hingeschrieben.
             *
             * Hier standen feste 380ms mit dem Vermerk „direkt nach der
             * Slide-In-Animation". Das stimmte, als die Bewegung 280ms dauerte.
             * Inzwischen sind es 300ms — der Abstand war
             * also stillschweigend geschrumpft, und beim
             * nächsten Wechsel der Zeitvorgabe wäre er negativ geworden. Dann
             * käme der Kaltstart der Tastatur mitten in die Fahrt, und das ist
             * einer der teuersten Vorgänge überhaupt.
             *
             * Abgeleitet bleibt der Abstand erhalten, egal was mit PICKER_IN
             * passiert.
             */
            /**
             * `visible` kippt jetzt ERST NACH der Fahrt (siehe Wirt) — der
             * eigene Nachlauf hier wäre also doppelt gezählt und die Tastatur
             * käme über eine halbe Sekunde zu spät.
             */
            autoFocus={visible}
            autoFocusDelay={0}
          />
        </View>

        {showSearchResults ? (
          isLoading ? (
            <View className="py-8 items-center">
              {/**
                * Während der Fahrt steht der Kreisel STILL statt zu
                * verschwinden.
                *
                * Er dreht sich nativ, also ändert er in jedem Bild den Inhalt
                * der Hülle — und die wird für die Fahrt als Textur gehalten,
                * die damit in jedem Bild neu gerastert werden müsste. Ihn
                * auszubauen wäre die schlechtere Lösung: Das ist ein Commit
                * plus Neuvermessung mitten in der Bewegung, und die Liste
                * darunter springt.
                */}
              <ActivityIndicator color={accent.solid} animating={!moving} />
            </View>
          ) : isError ? (
            <View className="px-5 py-6">
              <Text className="text-sm font-semibold text-pink-400 mb-1">
                Connection error
              </Text>
              <Text className="text-xs text-gray-500" numberOfLines={3}>
                {error instanceof Error ? error.message : "Could not reach the server."}
              </Text>
            </View>
          ) : (
            <FlatList
              data={results ?? []}
              keyExtractor={keyExtractor}
              keyboardShouldPersistTaps="handled"
              // Wie bei der Vorschlagsliste: Beim Wischen die Ebene freigeben.
              // Aufsetzen, kurz liegen bleiben, dann ziehen hätte sonst eine
              // bildschirmfüllende Textur über eine scrollende Fläche gelegt.
              onScrollBeginDrag={() => releaseLayer("pickerLocation")}
              // Kein seitlicher Abstand mehr hier — er sitzt in den Zeilen,
              // damit ihr Wellen-Effekt bis an beide Ränder läuft (siehe dort).
              contentContainerStyle={LIST_PAD}
              renderItem={renderResultRow}
              // Virtualisierung — bei langen Autocomplete-Listen (z.B. die 25
              // Treffer für „Berlin") spart das CPU/Memory und macht's smooth.
              windowSize={5}
              initialNumToRender={10}
              maxToRenderPerBatch={8}
              removeClippedSubviews
              ListEmptyComponent={
                <Text className="text-sm text-gray-500 mt-6 px-5">
                  No matches.
                </Text>
              }
            />
          )
        ) : (
          <FlatList
            /**
             * Stabile Referenzen — sonst läuft die Liste bei JEDEM Durchgang
             * durch ihre komplette Aktualisierungslogik.
             *
             * Ein leeres Literal, eine Pfeilfunktion und ein Stil-Objekt am Ort
             * sind bei jedem Rendern neu. `VirtualizedList` vergleicht seine
             * Eigenschaften und arbeitet bei Unterschieden alles durch — und
             * einer dieser Durchgänge liegt beim Öffnen und Schließen direkt
             * neben der Fahrt.
             */
            data={suggestData}
            keyExtractor={keySuggest}
            renderItem={renderSuggest}
            // Nur, was gebraucht wird: ohne diese Grenzen hält die Liste rund
            // 21 Bildschirmhöhen vor — bei dieser Zeilenhöhe wieder alles.
            windowSize={5}
            initialNumToRender={12}
            maxToRenderPerBatch={8}
            // Wie in der Trefferliste: Zeilen außerhalb des Bildes werden vom
            // nativen Baum abgehängt. Ohne das hielt diese Liste ihre Ansichten
            // durchgehend gemountet — die Grenzen oben wirken dann nur auf das
            // Nachladen, nicht auf das, was tatsächlich gezeichnet wird.
            removeClippedSubviews
            /**
             * Beim Wischen die Ebene sofort freigeben.
             *
             * Die 50ms Verzögerung filtert nur den sofortigen Wisch. Wer
             * aufsetzt, kurz liegen bleibt und DANN zieht, hat die Textur schon
             * angefordert — und sie bliebe 1,4 Sekunden über einer scrollenden
             * Fläche stehen. Genau das verbieten die Kommentare dieser Datei.
             */
            onScrollBeginDrag={() => releaseLayer("pickerLocation")}
            contentContainerStyle={LIST_PAD}
            /**
             * Sonst schluckt der erste Tipp nur die Tastatur.
             *
             * Die Trefferliste darüber hat das längst; diese hier nicht. Bei
             * offener Tastatur — also ab dem Moment, in dem das Feld den Fokus
             * bekommt — wählte ein Tipp auf „Gespeichert", „Zuletzt" oder einen
             * Vorschlag deshalb nichts aus: Er schloss die Tastatur, löste dabei
             * eine komplette Neuvermessung des Baums aus, und man musste ein
             * zweites Mal tippen. Das liest sich unmittelbar als Trägheit.
             */
            keyboardShouldPersistTaps="handled"
            ListHeaderComponent={
              <>
                {/*
                  Nur, wenn der Aufrufer damit auch etwas anfangen kann.
                  Die Zeile hatte gar keine Wirkung — sie war ein Knopf, der
                  nichts tut. In der Umgebung ist jetzt klar, was gemeint ist
                  („zeig mir, wo ich bin"), und dort wird sie mit einer Aufgabe
                  übergeben. In der Reisesuche wäre die Bedeutung eine andere:
                  Dort müsste aus der Position erst eine Station werden, und
                  solange das nicht gebaut ist, ist keine Zeile besser als eine
                  tote.
                */}
                {onCurrentLocation && (
                  /* Schließt ebenfalls → kein nativer Wellen-Effekt, siehe X-Knopf. */
                  <Pressable
                    unstable_pressDelay={50}
                    onPress={() => {
                      haptic("button");
                      onClose();
                      onCurrentLocation();
                    }}
                    className="flex-row items-center gap-4 py-4 px-5"
                    style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
                  >
                    <Navigation color="#E5E7EB" size={22} />
                    <View>
                      <Text className="text-base font-semibold text-white">
                        {t("search.location.current")}
                      </Text>
                      <Text className="text-sm text-gray-500 mt-0.5">
                        {t("search.location.usecurrent")}
                      </Text>
                    </View>
                  </Pressable>
                )}

              </>
            }
          />
        )}
        </>
        )}
      </View>
      </Animated.View>
    </>
  );
};

export const LocationPicker = memo(LocationPickerInner);

// Icon pro Result aus seinem Typ ableiten — HAFAS liefert für „Train" auch
// Bushaltestellen (type=BUS), Cities sind type=ALL → Flag.
function iconFor(loc: Location) {
  if (loc.type === "ALL") return Flag;
  return MODE_ICON[loc.type];
}

/** Toggle-Button für „Station speichern" — dieselbe SaveStarButton-Komponente
 *  wie im StopDetailSheet (Gold-Verlaufs-Stern + Pop + Funken), damit gespeicherte
 *  Stationen überall identisch aussehen. Der innere Pressable konsumiert den
 *  Tap, sodass der äußere Row-onPress (= Selection) NICHT mehr feuert. */
function SaveStar({ loc }: { loc: Location }) {
  const saved = useSearchStore((s) => s.savedStationCodes.has(loc.code));
  const toggle = useSearchStore((s) => s.toggleSavedStation);
  return <SaveStarButton size={32} starSize={20} saved={saved} onChange={() => toggle(loc)} />;
}

/** Eine Zeile im Picker (Ergebnis / Gespeichert / Zuletzt / Vorschlag).
 *
 *  memo + stabile Props (loc-Referenz aus useMemo/Query, onSelect via
 *  useCallback): Der Picker ist always-mounted und re-rendert bei jedem
 *  visible-Flip — OHNE memo würden dabei alle ~20 Zeilen (je mit SVG-Icon +
 *  SaveStarButton) im selben Fabric-Commit neu gerendert, exakt am Start
 *  der Slide-Animation → sichtbares Ruckeln beim Öffnen/Schließen. */
const PickerRow = memo(function PickerRow({
  loc,
  onSelect,
  suggested = false,
}: {
  loc: Location;
  onSelect: (loc: Location) => void;
  /** Vorschlags-Variante: Länder (type ALL) zeigen „Country" als Subtitle. */
  suggested?: boolean;
}) {
  const Icon = iconFor(loc);
  const subtitle =
    suggested && loc.type === "ALL" ? "Country" : loc.country || loc.city;
  return (
    /**
     * `Pressable` statt `RippleTouch` — der native Ripple lief IN die Fahrt.
     *
     * Er ist eine native Zeichen-Animation von 300 bis 400ms auf einer Fläche
     * INNERHALB des Blattes. Das Blatt wird für seine Ausfahrt als GPU-Textur
     * gehalten — und eine Ebene, deren Inhalt sich ändert, muss in JEDEM Bild
     * neu gerastert werden. Der Ripple hat die Textur also nicht nur wertlos
     * gemacht, sondern zusätzlich gekostet, und zwar über die volle Dauer der
     * Rückfahrt. Angetippt wird hier immer kurz vor dem Schließen.
     *
     * Die Rückmeldung bleibt: Der Hintergrund färbt sich beim Drücken, ohne
     * Nachlauf und ohne Animation.
     */
    <Pressable
      /**
       * Die Ebene für die AUSFAHRT schon beim Aufsetzen anlegen.
       *
       * Am X-Knopf steht das seit Kurzem, hier fehlte es — dabei ist das
       * Antippen einer Zeile der HÄUFIGSTE Weg, diesen Wähler zu verlassen.
       * Die beim Öffnen angeforderte Textur verfällt nach 1,4 Sekunden von
       * selbst, und länger ist man hier fast immer. Ohne Vorlauf fiel ihr
       * Aufbau damit in das erste Bild der Rückfahrt.
       */
      /**
       * 50ms Verzögerung — sonst zündet JEDER Scroll-Start die Textur.
       *
       * `onPressIn` feuert schon beim Zuteilen der Berührung, also auch, wenn
       * der Finger nur zum Wischen aufsetzt. Ohne Verzögerung schaltet damit
       * jede Scrollbewegung die bildschirmfüllende Ebene ein — genau der Fall
       * „Ebene über einer scrollenden Fläche", den die Kommentare in dieser
       * Datei ausdrücklich verbieten. `RippleTouch` hatte dafür `delayPressIn`;
       * beim Wechsel auf `Pressable` ist das mitgegangen.
       */
      unstable_pressDelay={50}
      onPressIn={() => prepareLayer("pickerLocation")}
      onPress={() => onSelect(loc)}
      /**
       * Der seitliche Abstand steckt in der ZEILE, nicht mehr im Container.
       *
       * Vorher trug die Liste `paddingHorizontal: 20`, die Zeile war damit
       * schmaler als der Bildschirm — und weil der Wellen-Effekt an der Fläche
       * des Knopfes hängt, endete er 20 Punkt vor jedem Rand. Er sah dadurch aus
       * wie ein Kasten mitten auf der Seite statt wie eine angetippte Zeile.
       *
       * Jetzt reicht die Zeile von Rand zu Rand und schiebt ihren Inhalt selbst
       * ein. Optisch ändert sich nichts, angefasst wird die ganze Breite.
       */
      className="flex-row items-center gap-4 py-3 px-5"
      style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
    >
      <Icon color="#E5E7EB" size={20} />
      <View className="flex-1">
        <Text className="text-base font-semibold text-white">{loc.label}</Text>
        <Text className="text-sm text-gray-500 mt-0.5">{subtitle}</Text>
      </View>
      <SaveStar loc={loc} />
    </Pressable>
  );
});

function useDebounce<T>(value: T, delay: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const h = setTimeout(() => setV(value), delay);
    return () => clearTimeout(h);
  }, [value, delay]);
  return useMemo(() => v, [v]);
}
