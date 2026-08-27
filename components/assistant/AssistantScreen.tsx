/**
 * Bo — Travel-Assistant-Tab.
 *
 * Architektur:
 *   - Lokaler useState für die laufende Conversation (keine Persistierung in
 *     Zustand — eine neue App-Session = neuer Chat, das passt zu „Geist"-UX)
 *   - Streaming via lib/api/chat.streamChat: SSE-Events kommen rein, wir
 *     mappen sie auf den lokalen Chat-Verlauf
 *   - Mood kommt VOM Server (per Event), nicht lokal berechnet — der Agent
 *     weiß am besten ob er gerade thinking/talking/happy/error ist
 *   - Voice via expo-speech-recognition: Tap-to-Talk, Transkript landet im
 *     Input-Feld, User bestätigt mit Send (kein Auto-Send → keine Versehen)
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  View,
  Text,
  FlatList,
  type ListRenderItemInfo,
  type FlatListProps,
  type LayoutChangeEvent,
  type StyleProp,
  type ViewStyle,
  Pressable,
  StyleSheet,
  TextInput,
  Platform,
  Keyboard,
  ActivityIndicator,
  BackHandler,
  Dimensions,
} from "react-native";
import { useAppBg, usePalette } from "@/lib/theme/appBg";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { keyboardHeight } from "@/lib/nav/keyboardHeight";
import { isTransitionBusy } from "@/lib/nav/transitionBusy";
import {
  appendStreamText,
  peekStreamText,
  subscribeStreamText,
  takeStreamText,
} from "@/lib/assistant/streamText";
import Animated, {
  measure,
  useAnimatedRef,
  Extrapolation,
  interpolate,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withTiming,
  Easing,
  cancelAnimation,
  useAnimatedScrollHandler,
  useDerivedValue,
  runOnUI,
  type SharedValue,
  type AnimatedRef,
} from "react-native-reanimated";
import { Send, Mic, AlertTriangle, RotateCw, X } from "lucide-react-native";
import {
  assistantPush,
  setAssistantArrivedHandler,
  isAssistantPushStarted,
  pushProgress,
  startAssistantPush,
  endAssistantPush,
  ASSISTANT_IN,
  ASSISTANT_OUT,
  SCREEN_CORNER_RADIUS,
  resetAssistantPush,
} from "@/lib/nav/overlayCover";
import { loadAuthToken } from "@/lib/auth/tokenStorage";
import { Bo, boBodyHeight, type BoMood } from "@/components/assistant/Bo";
import { VoiceRecordBar } from "@/components/assistant/VoiceRecordBar";
import { ResultCard } from "@/components/results/ResultCard";
import { RippleTouch } from "@/components/ui/RippleTouch";
import { GradientFill } from "@/components/ui/GradientFill";
import { useT } from "@/lib/i18n/useT";
import { useAccent } from "@/lib/theme/accent";
import { haptic } from "@/lib/haptics";
import { ScreenHeading, HEADING_LINE_HEIGHT } from "@/components/ui/ScreenHeading";
import { GUTTER, HEADING_TOP } from "@/lib/theme/spacing";
import { useSearchStore } from "@/stores/searchStore";
import { type StopBoardResponse } from "@/lib/api/client";
import { streamChat, todayLocal, ChatApiError, type ChatStreamEvent, type LastSearchParams } from "@/lib/api/chat";
import { pickWelcome } from "@/lib/assistant/welcomes";
import { StopBoardCard } from "@/components/assistant/StopBoardCard";
import type { SearchResult } from "@/types/search";
import { ms, scaledStyles } from "@/lib/ui/compact";

// expo-speech-recognition optional laden — fehlt in Expo Go ohne Dev-Client.
let ExpoSpeechRecognitionModule: any = null;
let useSpeechRecognitionEvent: (name: string, cb: (e: any) => void) => void = () => {};
try {
  const mod = require("expo-speech-recognition");
  ExpoSpeechRecognitionModule = mod.ExpoSpeechRecognitionModule;
  useSpeechRecognitionEvent = mod.useSpeechRecognitionEvent;
} catch {
  /* Native-Modul nicht verfügbar — Mic-Button wird in dem Fall disabled. */
}

const C = {
  bg: "#1A1A1A",
  surface2: "#242425",
  surface3: "#2A2A2C",
  surface4: "#323234",
  border: "#2E2E30",
  white: "#FFFFFF",
  textTertiary: "#8A8A90",
  textDim: "#56565C",
  error: "#FF7A6B",
};

type Msg =
  | {
      id: string;
      kind: "bot";
      text: string;
    }
  /**
   * Abfahrtstafel und „Alle Treffer"-Knopf sind EIGENE Nachrichten.
   *
   * Sie hingen an der Text-Blase. Seit die Treffer eigene Nachrichten sind und
   * die Blase vor sie einsortiert wird, landeten beide damit ÜBER den Karten —
   * ein Knopf „Alle Treffer anzeigen", der vor den Treffern steht. Als eigene
   * Nachrichten hinten angehängt stimmt die Reihenfolge von selbst.
   */
  | {
      id: string;
      kind: "board";
      stop: { code: string; label: string };
      board: "departures" | "arrivals";
      /** Vom Server schon geladen — die Karte holt dann nicht selbst. */
      data?: StopBoardResponse;
      botId: string;
    }
  | { id: string; kind: "action"; params: LastSearchParams; botId: string }
  /**
   * Ein Treffer — eine EIGENE Nachricht, nicht ein Anhang der Antwort.
   *
   * Vorher hingen die Karten als `flights[]` an der Bot-Bubble: Text und zwei
   * Tickets waren damit EIN Eintrag der Liste. Sichtbar wurde das überall dort,
   * wo die Liste einzelne Einträge behandelt — der Tiefeneffekt kippte alle
   * drei als Block, und ein Vergleich („Zug oder Bus") ließ sich nicht
   * einzeln ansprechen. Es sind drei Nachrichten; dass sie in einem Zug
   * eintreffen, ändert daran nichts.
   *
   * `botId` hält die Zugehörigkeit zur Antwort fest — für die Reihenfolge beim
   * Nachliefern des Textes und zum Aussortieren doppelter Treffer.
   */
  | { id: string; kind: "result"; result: SearchResult; botId: string }
  | { id: string; kind: "user"; text: string }
  | { id: string; kind: "error"; message: string }
  | { id: string; kind: "typing" };

/**
 * Module-Level-State für die Bo-Konversation. Überlebt Mount/Unmount-Cycle
 * der AssistantScreen-Component (die route wird beim Tab-Switch gepoppt
 * → Component-State weg). Modul bleibt aber im Memory → diese Refs auch.
 *
 * Wir nutzen bewusst kein Zustand-Store / kein AsyncStorage:
 *  - Cross-Session-Persistierung ist NICHT gewollt (Chat soll bei App-Restart
 *    frisch sein — sonst belastet alter Kontext den nächsten Cold-Start).
 *  - Reine In-Memory-Persistenz reicht für den Tab-Wechsel-Use-Case.
 */
/**
 * Die Fahrstrecke EINMAL beim Laden, aus der Fenster-BREITE.
 *
 * Vorher `useWindowDimensions()`. Beide Hälften davon waren falsch, und
 * `lib/nav/sheetSlide.ts` schreibt beide ausdrücklich anders vor:
 *
 *  - LAUFEND gelesen ist es ein Maß-Ereignis, das den GANZEN Bildschirm neu
 *    rendert, samt aller gemounteten Zeilen — bei vollem Verlauf Dutzende.
 *  - Und unter `adjustResize` wandert die Fenstergröße mit der Tastatur.
 *
 * Die Ausrichtung ist auf Hochkant festgelegt (`app.config.js`), der Wert
 * ändert sich also auch sonst nicht.
 */
/**
 * DIE FÜHRENDE KANTE — Schatten und Rundung gehören ZUSAMMEN.
 *
 * `0` = beides aus (aktueller Versuchsstand), `24` = der ursprüngliche Look.
 *
 * Warum eine Zahl für zwei Dinge: Die Rundung ist ohne Schatten UNSICHTBAR. Bos
 * Hintergrund ist derselbe Farbwert wie der des Landingscreens darunter — eine
 * Aussparung in der Ecke gibt also dieselbe Farbe frei, die dort ohnehin liegt.
 * Getrennt geschaltet zahlt man die eine für nichts.
 *
 * Und sie kostet mehr als gedacht. Der Kommentar in `overlayCover.ts` behauptet,
 * Android löse `borderRadius` + `overflow: hidden` über `clipToOutline`, also
 * GPU-seitig und ohne Neurastern pro Bild. Für RN 0.81 stimmt das nicht:
 * `BackgroundStyleApplicator.kt` ruft bei runden Ecken `canvas.clipPath(...)`
 * (Zeile 380/398) und legt in `createPaddingBoxPath` bei JEDEM Aufruf einen
 * frischen `Path` an. Über Bos EINfahrt liegt keine GPU-Ebene (die gibt es nur
 * beim Schließen) — die bildschirmfüllende Fläche wird also in jedem der rund
 * fünfzig Bilder durch einen nicht-rechteckigen Clip gerastert.
 *
 * Das ist der Teil, der NICHT mit der Zahl der Nachrichten wächst: Er fällt bei
 * leerem Verlauf genauso an.
 *
 * Zurückdrehen ist eine Zahl. Wer den Schatten zurückholt, bekommt die Rundung
 * automatisch mit — und umgekehrt.
 */
const SLIDE_LIFT = 0;
/** Abgeleitet, damit der Typ eng bleibt — `as const` geht an einem
 *  Bedingungs-Ausdruck nicht. */
const SHELL_OVERFLOW: "hidden" | "visible" = SLIDE_LIFT > 0 ? "hidden" : "visible";

const PARK_X = Dimensions.get("window").width;

/**
 * Takt des Text-Puffers — 100ms statt 50.
 *
 * Jeder Durchgang ist nicht bloß ein `setState`: Der Text der laufenden Blase
 * ändert sich, Yoga zieht den Inhalts-Behälter der Liste durch, und dabei
 * bekommt JEDES Kind `hasNewLayout` gesetzt — auch bei unverändertem Maß, der
 * Fall wird bewusst nicht verglichen. Daraus wird ein `onLayout` pro
 * gemounteter Zeile, und in jedem davon steckten zwei Schreibzugriffe über die
 * Laufzeit-Grenze. Die Kosten eines Durchgangs wachsen also mit dem Verlauf,
 * und sie fielen zwanzigmal pro Sekunde an — das ist der Grund, warum sich
 * schon der Sprung von zwei auf drei Nachrichten anfühlt.
 *
 * Zehn Aktualisierungen pro Sekunde sind für den Lesefluss weiterhin nicht von
 * einem Zeichenstrom zu unterscheiden; jede Chat-Oberfläche liegt in dieser
 * Gegend. Die Hälfte der Arbeit fällt damit ersatzlos weg.
 */
const TEXT_FLUSH_MS = 100;

/** Hebt die „wenige Nachrichten oben"-Verankerung auf — siehe `threadContentStyle`. */
const NO_END_ANCHOR = { flexGrow: 0, justifyContent: "flex-start" } as const;

let persistedMessages: Msg[] = [];
let persistedMood: BoMood = "waving";
/**
 * Zuletzt gemessene Tastaturhöhe — MODULWEIT, nicht pro Aufbau.
 *
 * Sie lag als `useRef` im Bildschirm und startete deshalb bei jedem
 * Neuaufbau wieder auf dem Schätzwert 320. Der Ablauf danach: Tab schließen,
 * wieder öffnen, ins Feld tippen — der Fokus stellt die Höhe sofort auf 320,
 * die Liste springt, und wenn die echte Tastatur kommt, springt sie ein
 * zweites Mal auf den richtigen Wert. Genau das „springt so weird".
 *
 * Der Bildschirm wird beim Verlassen abgebaut, die Tastatur des Geräts ändert
 * ihre Höhe dadurch aber nicht. Der Wert gehört also nicht an die Lebensdauer
 * des Bildschirms.
 */
let persistedKeyboardHeight = 0;

/**
 * Deckel für den In-Memory-Chatverlauf.
 *
 * Ohne Deckel wächst `messages` (und sein Modul-Mirror `persistedMessages`)
 * über eine lange Session UNBEGRENZT — und schwer, denn jede Flug-Antwort hängt
 * ein komplettes SearchResult (Legs, Stopovers, …) an ihre Nachricht. Der ganze
 * Verlauf lebt zudem im React-State, solange der Tab gemountet ist (und das ist
 * er dauerhaft, native Bottom-Tabs). 80 Nachrichten = ~40 Turns, mehr scrollt in
 * der Praxis niemand zurück; die ältesten fallen still hinten raus.
 */
const MAX_CHAT_MESSAGES = 80;

/**
 * Hier stand eine Verzögerungsstufe: Solange der Bildschirm nie sichtbar war,
 * wurde nur eine leere Fläche gezeichnet. Sie stammt aus der Zeit, als Bo ein
 * Tab war und der Tab-Navigator ihn beim Start mit aufbaute, obwohl ihn niemand
 * sehen wollte — dort hat sie echte Zeit gespart.
 *
 * Bo ist inzwischen ein eigener Bildschirm und wird erst beim Antippen
 * aufgebaut. Die Stufe sparte damit nichts mehr und kostete: Sie schob den
 * Inhalt um einen Renderdurchlauf nach hinten, und weil die Slide schon beim
 * Antippen losfährt, war das erste Bild der Bewegung eine leere Fläche.
 */
/**
 * Bo — jetzt eine Überlagerung am Wurzel-Layout, keine Route mehr.
 *
 * Der Grund ist die Zeichen-Reihenfolge: Als Route lag dieser Bildschirm im
 * `<Stack>`, und der steht im Wurzel-Layout VOR der Tab-Leiste. Damit konnte Bo
 * sie baulich nicht überdecken — er fuhr darunter durch, und die Leiste musste
 * ausgeblendet werden, was beim Push von rechts als „sie verschwindet einfach"
 * auffiel. Ergebnisliste und Detail-Blatt haben dieses Problem nie gehabt: Sie
 * stehen nach der Leiste.
 *
 * Geöffnet wird jetzt über den Speicher (`assistantOpen`) statt über den Router.
 * Alles andere an diesem Bildschirm bleibt, wie es war.
 */
export function AssistantScreen() {
  const palette = usePalette();
  const appBg = useAppBg();
  const t = useT();
  const accent = useAccent();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  /**
   * „Ist Bo IM VORDERGRUND?" — offen reicht nicht.
   *
   * `useIsFocused` gab es nur, weil dieser Bildschirm eine Route war, und es
   * bedeutete: sichtbar und bedienbar. Der bloße Offen-Schalter bedeutet das
   * NICHT — Bo bleibt offen, wenn er selbst die Ergebnisliste aufmacht, und die
   * liegt dann deckend über ihm.
   *
   * Der Unterschied ist nicht kosmetisch, daran hängen vier Dinge:
   *   • die Zurück-Taste. Früher gab Bo seinen Griff ab, sobald die Liste kam;
   *     jetzt hielte er ihn und würde SICH schließen statt der Liste.
   *   • die Spracheingabe. Sie startet nach jeder Sprechpause neu, solange Bo
   *     „im Vordergrund" ist — hinter der Liste liefe das Mikrofon weiter.
   *   • die Tastatur, die beim Übergang eingeklappt werden muss.
   *   • Bos animierte SVG-Eigenschaften und der 60-Sekunden-Leerlaufwinker,
   *     die sonst hinter einer deckenden Fläche weiterlaufen.
   *
   * `resultsParams != null` ist exakt die Sichtbarkeit der Ergebnisliste (siehe
   * `ResultsView`), also genau der Zustand, den `useIsFocused` hier abgebildet
   * hat.
   */
  const isFocused = useSearchStore((st) => st.assistantOpen && st.resultsParams == null);
  /**
   * Jedes Öffnen einzeln — auch das, das ein laufendes Schließen unterbricht.
   *
   * `isFocused` taugt dafür nicht: Der Merker steht während der ganzen Ausfahrt
   * noch, ein erneutes Öffnen ändert ihn also nicht, und alles, was daran
   * hängt, liefe nicht wieder an. Begründung im Speicher bei
   * `assistantOpenSeq`.
   */
  const openSeq = useSearchStore((st) => st.assistantOpenSeq);

  /**
   * Erst zurückfahren, dann zurücknavigieren.
   *
   * Die Reihenfolge ist der ganze Punkt: Navigiert man sofort, ist dieser
   * Bildschirm weg, bevor irgendetwas davon zu sehen war — der Stack fährt
   * bewusst ohne eigene Animation (`animation: "none"` im Wurzel-Layout), damit
   * er unseren Bewegungen nicht dazwischenfunkt.
   *
   * `closingRef` fängt den zweiten Druck ab: Ohne ihn setzt jeder weitere Tipper
   * eine neue Gegenbewegung an und schiebt die Rückkehr weiter nach hinten.
   */
  /**
   * Stil-Objekte EINMAL, nicht bei jedem Durchgang neu.
   *
   * Die beiden ersten sitzen auf ANIMIERTEN Knoten, und dort ist ein frisches
   * Objekt nicht bloß Arbeit für den Vergleicher: Es ist ein Fabric-Commit auf
   * genau dem Knoten, den Reanimated gerade Bild für Bild beschreibt. Der
   * Bildschirm rendert währenddessen aus mehreren Gründen neu — Scrollbeginn
   * und -ende, gemessene Leistenhöhe, jede Nachricht —, und jedes Mal liefen
   * diese Literale gegen die laufende Bewegung.
   */
  const screenShellStyle = useMemo(
    () => ({
      backgroundColor: palette.bg,
      // Gerundete führende Kante — gemeinsam mit dem Schatten geschaltet.
      // Ohne ihn ist sie unsichtbar, und sie ist pro Bild ein `clipPath` über
      // die volle Fläche. Begründung samt Beleg bei `SLIDE_LIFT`.
      borderRadius: SLIDE_LIFT > 0 ? SCREEN_CORNER_RADIUS : 0,
      overflow: SHELL_OVERFLOW,
    }),
    [palette.bg],
  );
  const inputbarWrapStyle = useMemo(() => ({ backgroundColor: appBg }), [appBg]);
  const closeBtnStyle = useMemo(
    () => [styles.closeBtn, { backgroundColor: palette.s2 }],
    [palette.s2],
  );

  const closingRef = useRef(false);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Das Bild Vorlauf der Ausfahrt — muss beim Abbau mit weg, sonst stellt es
   *  danach noch einen Wecker, der irgendwohin zurücknavigiert. */
  const closeRafRef = useRef<number | null>(null);
  /**
   * Was das Schließen kostet, passiert schon beim BERÜHREN des Knopfes.
   *
   * Derselbe Weg wie im Ortswähler, wo er ausführlich begründet steht: Zwischen
   * Aufsetzen und Loslassen liegen 80 bis 150ms, die ohnehin verstreichen. Zwei
   * Dinge gehören dorthin und nicht in den Start der Ausfahrt:
   *
   *  - Die GPU-Textur. Ihr Aufbau ist im Projekt mit 66ms vermessen, bei einem
   *    Bildbudget von 8,3ms. Bisher kippte sie im selben Commit wie die Kurve
   *    und fiel damit in deren erste Bilder.
   *  - Das Schließen der Tastatur. Unter `adjustResize` verkleinert das das
   *    Fenster und erzwingt eine Neuvermessung des GESAMTEN Baums — und der
   *    enthält jede gemountete Nachrichten-Zeile. Genau deshalb wird das
   *    Schließen mit dem Verlauf immer schlechter.
   *
   * Die Textur beim Aufsetzen (kostenlos, jederzeit zurücknehmbar), die
   * Tastatur erst im gedrückten Zustand — ein abgebrochener Tipp soll sie nicht
   * schließen.
   */
  const disarmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const armClose = useCallback(() => {
    if (disarmTimerRef.current) {
      clearTimeout(disarmTimerRef.current);
      disarmTimerRef.current = null;
    }
    // Bo hält auch schon an. Sonst fällt sein Anhalten — Abbruch von 15 Werten,
    // Neustart von nichts, aber ein Render des ganzen Bildschirms — in genau
    // den Durchgang, in dem die Ausfahrt losläuft.
    setSliding(true);
  }, []);
  const disarmClose = useCallback(() => {
    if (disarmTimerRef.current) clearTimeout(disarmTimerRef.current);
    // Mit Abstand: Beim echten Tipp läuft `onPressOut` VOR `onPress`, ein
    // sofortiges Zurücknehmen würde Bo also genau dem Fall wieder anlaufen
    // lassen, für den er angehalten wurde.
    disarmTimerRef.current = setTimeout(() => {
      disarmTimerRef.current = null;
      if (closingRef.current) return;
      setSliding(false);
    }, 400);
  }, []);
  useEffect(() => () => {
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    if (disarmTimerRef.current) clearTimeout(disarmTimerRef.current);
    if (closeRafRef.current !== null) cancelAnimationFrame(closeRafRef.current);
  }, []);
  const closeScreen = useCallback(() => {
    if (closingRef.current) return;
    closingRef.current = true;
    haptic("button");
    /**
     * Tastatur GEMEINSAM mit dem Blatt schließen, nicht danach.
     *
     * Bisher schloss sie erst die Wirkung, die auf den Fokus-Verlust reagiert —
     * also nachdem der Bildschirm schon weggefahren war. Man sah zwei
     * Bewegungen nacheinander: erst fährt Bo hinunter, dann klappt die Tastatur
     * weg. Beides im selben Moment angestoßen läuft es als eine Bewegung.
     */
    /**
     * Tastatur GEMEINSAM mit dem Blatt einklappen — wie beim Ortspicker.
     *
     * Der schließt sie in dem Moment, in dem seine Sichtbarkeit fällt, also im
     * selben Commit wie der Start seiner Ausfahrt. Genau dieselbe Stelle ist
     * hier der Start der Schließ-Bewegung.
     *
     * Das Abmelden des Feldes gehört dazu: Ohne es behält es den Fokus, der
     * reservierte Platz für die Tastatur bliebe im selben Commit stehen und
     * fiele erst hinterher zusammen — man sähe wieder zwei Bewegungen.
     */
    chatInputRef.current?.blur();
    Keyboard.dismiss();
    /**
     * Eine laufende Antwort HIER beenden, nicht erst beim Abbau.
     *
     * Bisher hing das am Abbau des Bildschirms: Strom abbrechen, angefangenen
     * Text retten, Punkte-Blase entfernen. Seit Bo dauerhaft gemountet bleibt
     * (siehe `AssistantHost`), läuft der Abbau im Regelfall gar nicht mehr —
     * und ohne diese Zeilen liefe die Anfrage nach dem Schließen weiter, für
     * eine Antwort, die niemand mehr sieht.
     *
     * Der Unterschied zur Abbau-Fassung ist wesentlich: Dort war `setMessages`
     * wirkungslos, also musste in den Modul-Speicher geschrieben werden. Hier
     * lebt der Bildschirm weiter — der Spiegel-Effekt an `messages` würde einen
     * direkten Schreibvorgang im nächsten Durchgang überschreiben, und der
     * gerettete Text wäre still weg. Deshalb ausschließlich über die Setzer.
     */
    if (streamingBotIdRef.current) {
      const botId = streamingBotIdRef.current;
      abortRef.current?.abort();
      abortRef.current = null;
      // Zuerst den Puffer leeren, sonst fehlt der letzte Satzteil — dieselbe
      // Begründung wie in der Abbau-Fassung.
      flushTextRef.current?.(true);
      const streamed = takeStreamText(botId);
      setMessages((prev) => {
        const withText =
          streamed !== null && streamed.length > 0
            ? commitBotText(prev, botId, streamed)
            : prev;
        return withText.filter((m) => m.kind !== "typing");
      });
      setMood("idle");
      bubbleReadyRef.current = null;
      streamingBotIdRef.current = null;
    }
    /**
     * `setKbOffset(0)` steht hier bewusst NICHT mehr.
     *
     * Es hätte einen Layout-Durchgang mitten in die Ausfahrt gelegt, und der
     * läuft auf demselben Strang wie sie. Nötig ist er nicht: Der Bildschirm
     * verschwindet, und beim nächsten Aufbau wird die Tastaturhöhe ohnehin neu
     * bestimmt.
     */
    /**
     * Das Tor bleibt OFFEN — sonst schnappt beim Schließen alles herunter.
     *
     * Es auf null zu setzen bringt `kbShift` schlagartig auf null, und daran
     * hängen jetzt Leiste UND Nachrichten. Statt mit der Tastatur nach unten zu
     * gleiten, sprängen sie im ersten Bild der Ausfahrt. `Keyboard.dismiss()`
     * fährt sie ohnehin herunter, `kb.height` folgt, und beide gleiten mit.
     * Der Bildschirm verschwindet danach — ein hängengebliebener Wert kann hier
     * niemanden mehr erreichen.
     */
    if (enterTimerRef.current) {
      clearTimeout(enterTimerRef.current);
      enterTimerRef.current = null;
    }
    if (windowTimerRef.current) {
      clearTimeout(windowTimerRef.current);
      windowTimerRef.current = null;
    }
    /**
     * Siehe `kbFreeze`: ab hier steht die Tastatur-Zahl still — aber das
     * Ablesen gehört auf den UI-Strang.
     *
     * `kbShift.value` aus React zu lesen ist in Reanimated 4 ein SYNCHRONER
     * Sprung in die UI-Laufzeit, der beide Stränge gegeneinander sperrt. Genau
     * das verbieten die Notizen in `overlayCover.ts` an zwei Stellen wörtlich,
     * und hier lag es im Berührungs-Bild des Schließens — direkt vor dem Start
     * der Ausfahrt. Als Worklet gelesen und geschrieben passiert beides dort,
     * wo die Werte ohnehin leben.
     */
    runOnUI(() => {
      "worklet";
      kbFreeze.value = kbShift.value;
    })();
    // Falls über die Zurück-Geste gekommen: die Vorarbeit nachholen, sie hat
    // dort keinen Berührungs-Moment. Beim X-Knopf ist das ein No-Op.
    armClose();
    /**
     * EIN Bild dazwischen, dann fahren — wie bei jeder anderen Fahrt der App.
     *
     * `useSheetSlide` schiebt zwischen Anmelden und Losfahren bewusst ein Bild
     * ein, und der Kommentar dort sagt auch, warum die AUSFAHRT das besonders
     * nötig hat: Sie hatte diesen Vorlauf lange nicht, und genau deshalb war sie
     * die schlechtere der beiden Richtungen. Hier liegen im Tipp-Durchgang das
     * Schließen der Tastatur, zwei Zustandswechsel und die Textur — alles das
     * bekommt jetzt sein eigenes Bild, bevor die Kurve anläuft.
     */
    closeRafRef.current = requestAnimationFrame(() => {
      closeRafRef.current = null;
      endAssistantPush();
      const finish = () => {
        /**
         * Auch dieser Schritt wartet auf eine Lücke.
         *
         * Er liegt 120ms hinter dem Kurvenende — und die Bewegungs-Meldung
         * deckt nur 380ms plus 80ms Reserve ab. Er fiel also knapp DANEBEN, in
         * den Nachklang der Ausfahrt, in dem das Auge noch an der Bewegung
         * hängt und der Parallax gerade ausläuft.
         *
         * Und billig ist er nicht: `closeAssistant()` weckt jeden Selektor der
         * App, lässt diesen Bildschirm mit seinen viertausend Zeilen komplett
         * neu durchlaufen und stößt acht Effekte an, die am Vordergrund hängen.
         * Genau das ist der verbliebene „gelegentliche Ruckler beim
         * Einfahren" — gelegentlich, weil er nur trifft, wenn die Reserve
         * gerade nicht mehr greift.
         *
         * Sichtbar ändert sich durch das Warten nichts: Bo steht zu diesem
         * Zeitpunkt längst außerhalb des Bildes.
         */
        if (isTransitionBusy()) {
          closeTimerRef.current = setTimeout(finish, 120);
          return;
        }
        closeTimerRef.current = null;
        // Kein `canGoBack`-Zweig mehr nötig? Doch: Wer über eine Verknüpfung
        // direkt hier landet, hat keine Vorgeschichte zum Zurückgehen.
        useSearchStore.getState().closeAssistant();
        /**
         * Mit Abstand, nicht bildgenau auf das Kurvenende.
         *
         * Der Wecker steht im selben Bild-Vorlauf wie der Start der Kurve, läuft
         * also rund ein Bild VOR ihr aus. `router.back()` baut dann den
         * kompletten Bo-Baum ab, während der Parallax des Landingscreens noch an
         * derselben Kurve hängt — im letzten Bild springt beides. Und
         * `setTimeout` ist ohnehin nicht bildgenau.
         */
      };
      closeTimerRef.current = setTimeout(finish, ASSISTANT_OUT.duration + 120);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router, armClose]);

  /**
   * Die Systemtaste „zurück" nimmt denselben Weg.
   *
   * Ohne das verschwindet der Bildschirm schlagartig — und schlimmer: Der Wert
   * bliebe auf 1 stehen, sodass der Landingscreen darunter für immer um seine
   * Parallax-Strecke verschoben klebte.
   *
   * NUR im Vordergrund. Bo bleibt gemountet, wenn er selbst die Ergebnisliste
   * öffnet („Alle Treffer anzeigen") — ohne diese Bedingung hinge sein Griff
   * auch dort noch an der Zurück-Taste und schlösse BO statt der Liste.
   */
  useEffect(() => {
    if (!isFocused) return;
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      /**
       * Erst die Vorarbeit, dann ein Bild später die Fahrt.
       *
       * Der X-Knopf bekommt diese Staffelung geschenkt: Textur und Anhalten
       * liegen an seinem `onTouchStart`, die Kurve an `onPress` — dazwischen
       * die 80 bis 150ms des Fingers. Die Zurück-Geste hat keinen solchen
       * Moment; ohne das Aufteilen fiele der Ebenen-Aufbau (im Projekt mit 66ms
       * vermessen) in die ersten Bilder der Ausfahrt.
       */
      armClose();
      /**
       * Die Tastatur gehört in DIESES Bild, nicht ins nächste.
       *
       * `armClose` nimmt sie bewusst nicht mit: Es hängt am Aufsetzen des
       * Fingers, und ein abgebrochener Tipp soll die Tastatur nicht schließen.
       * Beim X-Knopf erledigt das deshalb `onPressIn`. Die Zurück-Geste hat
       * keinen dieser beiden Momente — dort lief das Schließen erst in
       * `closeScreen`, also ein einziges Bild vor dem Start der Ausfahrt.
       *
       * Unter `adjustResize` ist das kein billiger Aufruf: Das Fenster wird
       * kleiner, und daraus folgt eine Neuvermessung des GESAMTEN Baums — samt
       * jeder gemounteten Nachrichten-Zeile. Sie wird also mit dem Verlauf
       * teurer und fiel genau in die Ausfahrt. Das ist der Teil von „das
       * Schließen wird mit jeder Nachricht schlechter", der nur die Geste
       * betrifft — und deshalb nur manchmal auftrat.
       */
      chatInputRef.current?.blur();
      Keyboard.dismiss();
      requestAnimationFrame(() => closeScreen());
      return true;
    });
    return () => sub.remove();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [closeScreen, isFocused, armClose]);
  /** Neustart-Zeitgeber der Spracheingabe — muss beim Verlassen sterben. */
  const restartRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isFocusedRef = useRef(isFocused);
  isFocusedRef.current = isFocused;
  const locale = useSearchStore((s) => s.locale);
  const currency = useSearchStore((s) => s.currency);
  const openAuthOverlay = useSearchStore((s) => s.openAuthOverlay);

  // ?autoVoice=1 wird vom Home-Mic-Tap mitgeschickt → wir starten Voice direkt.
  // Kam der Aufruf über das Mikrofon? Früher ein Routen-Parameter.
  const params = { autoVoice: useSearchStore.getState().assistantAutoVoice ? "1" : undefined };

  // Initial-Werte aus dem Module-Level-State: erste Mount = leere Liste,
  // jedes spätere Re-Mount kriegt die vorhin geführte Konversation zurück.
  const [messages, setMessages] = useState<Msg[]>(() => persistedMessages);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  /**
   * Dieselbe Sperre als Ref — und die ist die maßgebliche.
   *
   * `busy` ist Zustand: Zwei Aufrufe im selben Durchgang (Knopf und
   * Spracheingabe, oder ein doppelter Tipper) sehen BEIDE noch `false` und
   * laufen los. Der zweite bricht dann den ersten ab, dessen Aufräumer sieht
   * eine fremde Kennung und lässt die Sperre stehen — ab da nimmt der Chat
   * nichts mehr an, ohne dass irgendwo etwas steht.
   */
  const busyRef = useRef(false);
  const busyGuardRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // voiceMode = true sobald der User Mic gedrückt hat → VoiceRecordBar wird
  // statt der normalen Input-Bar gerendert. listening allein reicht nicht
  // weil bei „Pause" der User die VoiceRecordBar sehen WILL, aber listening
  // dann false ist.
  const [voiceMode, setVoiceMode] = useState(false);
  const [mood, setMood] = useState<BoMood>(() => persistedMood);
  const [listening, setListening] = useState(false);

  // Verlauf deckeln: Läuft er über MAX_CHAT_MESSAGES, die ältesten wegtrimmen.
  // Trimmt vom ANFANG (slice(-N)) — die neueste, evtl. gerade streamende
  // Nachricht liegt immer am Ende und bleibt unberührt. Ein Trim ist selten
  // (nur alle N Nachrichten ein Extra-Render), begrenzt aber den Speicher hart.
  useEffect(() => {
    if (messages.length > MAX_CHAT_MESSAGES) {
      setMessages((prev) =>
        prev.length > MAX_CHAT_MESSAGES ? prev.slice(-MAX_CHAT_MESSAGES) : prev,
      );
    }
  }, [messages]);

  // Bei jeder Message- oder Mood-Änderung den Module-Level-Snapshot mit-
  // aktualisieren — sonst gehen Änderungen die nach dem letzten Mount
  // passierten beim nächsten Mount verloren. `messages` ist hier bereits
  // gedeckelt (Effekt oben), der Mirror erbt den Deckel.
  useEffect(() => {
    persistedMessages = messages;
  }, [messages]);
  useEffect(() => {
    persistedMood = mood;
  }, [mood]);

  const scrollRef = useRef<FlatList<Msg>>(null);
  const abortRef = useRef<AbortController | null>(null);
  // Während aktivem Scrollen pausieren wir Bo's Reanimated-Worklets —
  // diese laufen auf der UI-Thread und konkurrieren mit dem ScrollView-
  // Native-Driver um Frame-Time. Bei Discord/WhatsApp-Style chats sind die
  // Avatar-Animationen ebenfalls statisch während des Scrollens.
  const [isScrolling, setIsScrolling] = useState(false);
  // Fallback-Timer: bei sehr langsamem Drag kommt onMomentumScrollEnd nie,
  // und wir würden Bo für immer pausiert lassen. Nach scrollEndDrag warten
  // wir 120ms — wenn bis dahin kein onMomentumScrollBegin kam, gibt's kein
  // Momentum und wir clearen isScrolling.
  const scrollEndTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Wir tracken die ID der aktuell streamenden Bot-Message — Text-Deltas
  // landen alle dort. Wenn search_result kommt, hängen wir's an dieselbe ID.
  const streamingBotIdRef = useRef<string | null>(null);
  /**
   * Für welche Antwort die Blase schon in der Liste steht.
   *
   * Steht bewusst HIER und nicht beim Text-Puffer: Das Aufräumen beim Abbau und
   * der Abschluss von `send` greifen darauf zu, und beide stehen weiter oben.
   */
  const bubbleReadyRef = useRef<string | null>(null);
  /** Siehe `flushText` — hier nur deklariert, damit `send` drankommt. */
  const flushTextRef = useRef<((force?: boolean) => void) | null>(null);
  // Letzte Such-Params aus einem vorherigen Turn — Server ist stateless,
  // deshalb müssen WIR die mitsenden damit Cross-Turn-Tools wie
  // open_all_results funktionieren („zeig mir alle gefundenen Verbindungen"
  // im 2. Turn nach einer Suche).
  const lastSearchRef = useRef<LastSearchParams | null>(null);
  // Mutable Ref auf messages — von mehreren Effects (re-focus-wave,
  // onRetry-Callback) gelesen ohne dass sie als Dependency triggern.
  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  // KEYBOARD — absolute Inputbar + dynamisches FlatList-paddingBottom.
  //
  // FRÜHER (klappte nicht): root.paddingBottom = kbOffset+lift → FlatList
  // sollte via flex:1 schrumpfen. Auf Android Edge-to-Edge hat die FlatList
  // ihre Visible-Bounds aber nicht zuverlässig neu gemessen, neue
  // Stream-Bubbles landeten unter dem Inputbar.
  //
  // JETZT: FlatList behält volle Höhe (kein root.paddingBottom mehr). Das
  // Inputbar liegt absolut über dem Chat (bottom = kbOffset). Das
  // FlatList-contentContainerStyle.paddingBottom wird so groß gesetzt, dass
  // der letzte Bubble beim Scrollen-zum-Ende immer ÜBER dem Inputbar landet:
  //
  //   contentPaddingBottom = inputbarHeight + (kbOffset > 0 ? kbOffset + LIFT : insets.bottom)
  //
  // Mit dem Pattern ändert sich nur der contentContainer-Pad und die
  // Inputbar-Position — die FlatList an sich wird nie ge-resized → Android
  // hat null Layout-Drift.
  // Zwei Gaps:
  //   BAR_LIFT_FROM_KB → sichtbarer Abstand zwischen Bar-Unterkante und
  //                      Keyboard-Oberkante (User wollte die Bar höher).
  //   MSG_GAP_FROM_BAR → Abstand zwischen letzter Bubble und Bar-Oberkante.
  const BAR_LIFT_FROM_KB = 16;
  const MSG_GAP_FROM_BAR = 32;
  /**
   * Anfangswerte aus dem TATSÄCHLICHEN Tastatur-Zustand, nicht aus Annahmen.
   *
   * Dieser Bildschirm wird beim Verlassen abgebaut und beim Zurückkehren neu
   * aufgebaut. Bisher startete er dabei mit „Leiste folgt der Tastatur" (Tor
   * offen) und „kein Platz reserviert" (Abstand 0) — zwei Annahmen, die sich
   * widersprechen, sobald `useAnimatedKeyboard` mit einer stehengebliebenen
   * Höhe zurückkommt. Genau das beschreibt der Kommentar am Tor: Schließt die
   * Tastatur, während der Bildschirm schon abgebaut wird, verpasst das Modul
   * die Bewegung und behält den alten Wert.
   *
   * Die Folge war im Bild zu sehen: Die Eingabeleiste stand auf Tastaturhöhe
   * mitten im Bildschirm, während die Liste den ganzen Platz für sich nahm und
   * ihre Nachrichten hinter und unter der Leiste durchliefen.
   */
  const initialKbHeight = Keyboard.isVisible() ? (Keyboard.metrics()?.height ?? 0) : 0;
  const lastKbHeightRef = useRef(
    initialKbHeight > 0 ? initialKbHeight : persistedKeyboardHeight,
  );
  const [kbOffset, setKbOffset] = useState(initialKbHeight);
  const contentHRef = useRef(0);
  const listHRef = useRef(0);
  const [flowing, setFlowing] = useState(false);
  const flowingRef = useRef(false);
  /**
   * Die reine Höhe der Nachrichten — ohne jeden Innenabstand.
   *
   * Der einzige Messwert, den diese Geometrie noch braucht, und der zuverlässig
   * kommt: Die Liste meldet ihre Inhaltshöhe, wenn sich der Inhalt ändert. Alle
   * anderen Summanden setze ich selbst, also bleibt die Stapelhöhe übrig.
   */
  /**
   * Bis zur ersten Meldung ist die Stapelhöhe unbekannt und der Freiraum
   * entsprechend daneben — ein einzelnes Bild lang säßen die Nachrichten
   * sichtbar zu hoch. Also erst zeigen, wenn gemessen ist.
   */

  /** Für das ausdrückliche Abmelden beim Schließen — siehe `closeScreen`. */
  const chatInputRef = useRef<TextInput>(null);
  /**
   * Der Startwert wird GERECHNET, nicht geraten.
   *
   * Hier stand 64. Die Leiste ist aber nie 64 hoch — sie ist oberer Abstand
   * plus Trennlinie plus Feld plus unterer Abstand, je nach Gerät 79 bis 111.
   * Die Berichtigung nach der ersten Messung fiel damit IMMER an, und zwar in
   * den ersten Bildern der Einfahrt. Sie ändert den Innenabstand des
   * Listeninhalts, und der steht nicht auf Reanimateds Liste der schnellen
   * Eigenschaften: Das ist ein Yoga-Durchgang über alle gemounteten Zeilen,
   * genau während die Bewegung jedes Bild braucht — und er wird teurer, je
   * länger der Verlauf ist.
   *
   * Mit der richtigen Zahl greift `Math.abs(h - inputbarHeight) > 1` gar nicht
   * erst. Bleibt eine Abweichung (anderer Schriftgrad, mehrzeiliges Feld),
   * berichtigt sie sich wie bisher — nur eben nicht mehr jedes Mal.
   */
  const [inputbarHeight, setInputbarHeight] = useState(
    () => ms(10) + 1 + ms(44) + Math.max(12, insets.bottom + 8),
  );
  // Tor vor kb.height: 1 = Bar folgt dem Keyboard, 0 = Bar bleibt unten.
  //
  // Nötig, weil useAnimatedKeyboard die Schließ-Transition VERPASST, wenn das
  // IME zugeht, während der Screen gerade detached/eingefroren wird (Tab-
  // Wechsel mit offenem Keyboard). kb.height bleibt dann auf der alten Höhe
  // stehen, und beim Zurückkommen hing die Bar samt Chat dort, wo das Keyboard
  // mal war. Das Tor schließt beim Verlassen des Tabs und öffnet erst wieder,
  // wenn das Keyboard nachweislich (wieder) da ist — ein stehengebliebener
  // kb.height-Wert erreicht die Bar damit nie.
  const kbGate = useSharedValue(initialKbHeight > 0 ? 1 : 0);

  useEffect(() => {
    const showSub = Keyboard.addListener("keyboardDidShow", (e) => {
      const h = e.endCoordinates?.height ?? 320;
      lastKbHeightRef.current = h;
      persistedKeyboardHeight = h;
      if (kbConfirmRef.current) {
        clearTimeout(kbConfirmRef.current);
        kbConfirmRef.current = null;
      }
      setKbOffset(h);
      // Keyboard ist nachweislich da → Tor auf (Sicherheitsnetz, falls es ohne
      // onInputFocus aufging).
      kbGate.value = 1;
    });
    const hideSub = Keyboard.addListener("keyboardDidHide", () => {
      // Auch das ist ein Commit — und er trifft die Ausfahrt zuverlässig, weil
      // dort die Tastatur geschlossen wird. Während einer Fahrt ist der Wert
      // ohnehin eingefroren (`kbFreeze`), das Nachziehen kann also warten.
      if (isTransitionBusy()) {
        kbOffsetTimerRef.current = setTimeout(function retry() {
          if (isTransitionBusy()) {
            kbOffsetTimerRef.current = setTimeout(retry, 120);
            return;
          }
          kbOffsetTimerRef.current = null;
          setKbOffset(0);
        }, 120);
        return;
      }
      setKbOffset(0);
    });
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, [kbGate]);

  /**
   * Sicherheitsnetz: Was, wenn die Tastatur gar nicht kommt?
   *
   * `onInputFocus` stellt die Höhe schon auf den GEMERKTEN Wert, bevor die
   * Tastatur da ist — damit die Leiste bildgenau mit ihr hochfährt. Das ist
   * richtig, solange auf den Fokus auch wirklich eine Tastatur folgt.
   *
   * Genau das ist beim Zurückkehren in den Tab nicht der Fall: Beim Verlassen
   * wird die Tastatur geschlossen, das Eingabefeld behält aber seinen Fokus,
   * und Android stellt ihn beim Wiedereinhängen her. `onInputFocus` feuert
   * also erneut, die Liste und die Leiste springen auf Tastaturhöhe — und die
   * Tastatur erscheint nie. Die Leiste stand dann mitten im Bild, mit
   * Nachrichten darunter.
   *
   * Bleibt die Bestätigung aus, wird der Wert deshalb zurückgenommen.
   */
  const kbConfirmRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onInputFocus = useCallback(() => {
    // Tor auf, BEVOR die IME-Animation startet — so bleibt die Bar frame-synced
    // mit dem aufgehenden Keyboard.
    kbGate.value = 1;
    /**
     * Nur vorgreifen, wenn wir die Höhe WIRKLICH kennen.
     *
     * Der Vorgriff ist richtig: Er lässt den Inhalt gemeinsam mit der Tastatur
     * hochwandern, statt erst hinterher zu springen. Aber nur mit dem echten
     * Wert. Mit dem alten Schätzwert sprang die Liste erst auf 320 und dann ein
     * zweites Mal auf die tatsächliche Höhe.
     *
     * Beim allerersten Öffnen auf einem Gerät ist noch nichts bekannt — dann
     * lieber gar nicht vorgreifen und den bestätigten Wert abwarten. Das ist
     * ein Sprung statt zweier.
     */
    if (lastKbHeightRef.current > 0) setKbOffset(lastKbHeightRef.current);
    if (kbConfirmRef.current) clearTimeout(kbConfirmRef.current);
    kbConfirmRef.current = setTimeout(() => {
      kbConfirmRef.current = null;
      if (!Keyboard.isVisible()) {
        setKbOffset(0);
        kbGate.value = 0;
      }
      // 800ms statt 450: Eine kalt startende Android-Tastatur braucht auf
      // Mittelklasse-Geräten gut eine halbe Sekunde. Zu früh zurückgenommen,
      // fällt die Leiste herunter und springt gleich wieder hoch — genau der
      // Doppelsprung, gegen den der Vorgriff gedacht war.
    }, 800);
  }, [kbGate]);

  const onInputBlur = useCallback(() => {
    // Die Bestätigungs-Frist mit abräumen — sonst setzt sie später auf einem
    // Bildschirm zurück, der längst wieder woanders steht.
    if (kbConfirmRef.current) {
      clearTimeout(kbConfirmRef.current);
      kbConfirmRef.current = null;
    }
    setKbOffset(0);
  }, []);

  // KONSTANTE Bar-Padding damit die Bar-Höhe sich nicht ändert beim
  // Keyboard-Toggle. Bei kbClosed brauchen wir insets.bottom für den
  // Home-Indicator.
  const baseBottomPad = Math.max(12, insets.bottom + 8);
  const inputbarPadBottom = baseBottomPad;
  // Content-Padding der FlatList bleibt STATE-SNAP (kbOffset via
  // keyboardDidShow): das ist Layout und läge sonst pro Frame auf dem
  // JS-Thread. Der Snap passiert hinter dem letzten Bubble → unsichtbar.
  /**
   * Die Tastatur gehört in DIESEN Abstand — den unteren. Das ist der Kern.
   *
   * Die Liste ist gespiegelt (`inverted`). Ihr Inhalt beginnt damit am unteren
   * Bildrand, und `paddingTop` des Inhalts liegt genau dort, über der
   * Eingabeleiste. Wächst er, rückt der ganze Stapel nach OBEN — exakt die
   * Bewegung, die die Leiste selbst macht.
   *
   * Ich hatte den Tastaturanteil stattdessen an das andere Ende gelegt (oben,
   * unter Bo) und die Verschiebung durch Scrollen erzeugen wollen. Beides war
   * verkehrt herum:
   *
   *  - Oben liegt der Zuschlag HINTER den Nachrichten. Bei langen
   *    Unterhaltungen verschiebt er sie gar nicht, sie blieben also unter der
   *    Tastatur stehen. Bei kurzen drückte er sie herunter, statt sie zu heben.
   *  - Gescrollt wurde zusätzlich in die falsche Richtung: Bei `inverted` ist 0
   *    das untere Ende, ein GRÖSSERER Versatz fährt den Inhalt nach UNTEN. Die
   *    Nachrichten sind also nicht trotz des Ausgleichs nach unten gerutscht,
   *    sondern WEGEN ihm.
   *
   * Nachweisen lässt sich die Richtung an der Stelle, die nachweislich stimmt:
   * `onThreadContentSize` springt beim Eintreffen einer Nachricht erst auf
   * `+grown` und fährt dann auf 0 — und das Sichtbare daran ist, dass die
   * Nachrichten nach OBEN wandern.
   *
   * Der Sprung, wegen dem ich den Zuschlag hier ausgebaut hatte, ist echt: Der
   * Abstand ist Layout und springt in einem Schritt, die Tastatur braucht ihre
   * Viertelsekunde. Der wird aber dort behandelt, wo er entsteht — siehe
   * `catchDisp`: Die Zeilen werden um genau die gesprungene Strecke
   * zurückgehalten und bildgenau mit der Tastatur freigegeben.
   */
  /**
   * Die Tastatur steht NICHT mehr im Layout — das ist der Kern gegen das
   * Flackern.
   *
   * Sie stand im unteren Innenabstand, und gerechnet war das richtig. Nur
   * springt Layout in einem Schritt, während die Tastatur eine Viertelsekunde
   * fährt. Der Ausgleich dafür ging als Reanimated-Wert von JS auf den
   * UI-Strang, die Abstandsänderung über den React-Commit — ZWEI Kanäle, deren
   * Reihenfolge niemand garantiert. Landet der Ausgleich ein Bild später,
   * sieht man den Sprung; landet er rechtzeitig, ist es sauber. Genau das
   * „manchmal geht es problemlos, meistens nicht".
   *
   * Ohne Layout-Änderung gibt es nichts auszugleichen: Die Bewegung ist ein
   * Transform auf dem UI-Strang, gespeist aus derselben Zahl wie die Leiste
   * (`kbLift`). Zwischen beiden kann sich nichts mehr verschieben, und es gibt
   * keinen Wettlauf, den man gewinnen oder verlieren könnte.
   */
  /**
   * Der Zuschlag am oberen Ende folgt VERZÖGERT — und das ist der Hebel gegen
   * „die Tastatur schiebt die Nachrichten ruckelig hoch".
   *
   * An dieser Zahl hängt der Innenabstand des Listeninhalts. Ändert er sich,
   * ändert sich der Inhalts-Container: Die `thread`-Merkschranke bricht, die
   * Liste rendert komplett neu, Yoga läuft über den ganzen Container, und
   * JEDE gemountete Zeile bekommt eine neue Lage und meldet sie. Das wächst mit
   * dem Verlauf — und es fiel bisher exakt in den Moment, in dem die Tastatur
   * losfährt: `onInputFocus` greift dem echten Wert vor, um den Inhalt
   * „gemeinsam mit der Tastatur hochwandern" zu lassen.
   *
   * Dieser Vorgriff ist seit dem Umbau nicht mehr nötig. Die Bewegung kommt
   * nicht mehr aus dem Layout, sondern aus dem Transform der Hülle
   * (`threadShiftStyle`) und läuft bildgenau auf dem UI-Strang. Was dieser
   * Zuschlag noch leistet, ist allein die SCROLL-STRECKE: Ganz oben angekommen
   * wären die ältesten Zeilen sonst um die Hebe-Strecke aus dem Bild geschoben
   * und nicht mehr erreichbar. Und die braucht niemand, solange die Tastatur
   * noch fährt.
   *
   * Also erst danach. 320ms decken die Einblend-Animation ab; schließt sie
   * vorher wieder, wird der Wecker zurückgenommen und es passiert gar nichts.
   */
  const [kbPadOffset, setKbPadOffset] = useState(initialKbHeight);
  useEffect(() => {
    if (kbOffset === kbPadOffset) return;
    /**
     * Dieser Wecker fiel MITTEN in die Ausfahrt — und er wird mit dem Verlauf
     * teurer.
     *
     * Ablauf: Tipp auf das X, `onPressIn` meldet das Feld ab, der Fokus-Verlust
     * setzt die Tastatur-Zahl auf null — und damit startet dieser Wecker im
     * BERÜHRUNGS-Bild. Die Kurve läuft erst 80 bis 150ms später los. Bei 320ms
     * landet er also 170 bis 240ms in der 380ms-Ausfahrt, genau in ihrer Mitte.
     *
     * Was daran hängt, ist nicht klein: Der Innenabstand ändert sich, damit ist
     * der Stil des Listeninhalts ein neues Array, damit bricht die Merkschranke
     * der Liste — sie rendert komplett neu, Yoga läuft über den ganzen
     * Inhalts-Container, und JEDE gemountete Zeile meldet ein neues Layout.
     * Jede dieser Meldungen schreibt einen geteilten Wert, der zwei weitere
     * Auswerter und einen nativen Schreibvorgang auslöst. Bei zwanzig Zeilen
     * sind das zwanzig Layout-Ereignisse und vierzig Auswerter-Läufe, gebündelt
     * in ein bis zwei Bilder.
     *
     * Und die Zahl der Zeilen ist die Zahl der Nachrichten: Die Verkleinerung
     * auf fünf läuft erst nach dem Fokus-Verlust plus 630ms, also NACH der
     * Ausfahrt.
     */
    let id: ReturnType<typeof setTimeout>;
    const attempt = () => {
      /**
       * KEIN Ausstieg beim Schließen mehr — der ließ den Wert für immer stehen.
       *
       * Hier stand „beim Schließen gar nicht mehr, der Bildschirm verschwindet
       * ja". Das galt, solange Bo beim Schließen abgebaut wurde. Seit er
       * dauerhaft gemountet bleibt, ist es falsch: Der Versuch bricht ab, die
       * Abhängigkeiten des Effekts ändern sich nicht mehr, und die Zahl bleibt
       * auf dem Stand der OFFENEN Tastatur stehen.
       *
       * An ihr hängt der Innenabstand am unteren Ende des Listeninhalts. Er
       * blieb damit reserviert, obwohl die Tastatur längst zu ist — sichtbar
       * als leerer Bereich, in den man scrollen kann. Genau das war der
       * gemeldete Fehler.
       */
      if (isTransitionBusy()) {
        id = setTimeout(attempt, 200);
        return;
      }
      setKbPadOffset(kbOffset);
    };
    id = setTimeout(attempt, 320);
    return () => clearTimeout(id);
  }, [kbOffset, kbPadOffset]);
  const kbPad = kbPadOffset > 0 ? kbPadOffset + BAR_LIFT_FROM_KB : 0;
  const contentPaddingBottom = inputbarHeight + MSG_GAP_FROM_BAR;

  // Die BAR selbst folgt dem Keyboard FRAME-SYNCED via useAnimatedKeyboard
  // (WindowInsetsAnimation auf dem UI-Thread) — exakt der Mechanismus, der
  // die native Bottom-Tab-Bar so smooth über das Keyboard hebt. Der alte
  // keyboardDidShow-Snap feuerte erst NACH der Keyboard-Animation → die Bar
  // sprang sichtbar. kb.height ist der volle IME-Inset ab physischem
  // Screen-Bottom; die System-Nav-Bar (insets.bottom) ziehen wir ab, analog
  // zur keyboardDidShow-Höhe (ime - systemBars) auf der die alte Position
  // getunt war. Der BAR_LIFT wird über die ersten 80px eingeblendet statt
  // hart addiert — kein 16px-Hop am Animationsstart.
  /**
   * Die Tastaturhöhe kommt aus dem Wurzel-Layout, nicht aus diesem Bildschirm.
   *
   * Der Aufruf stand hier im Render-Körper — also im ersten Durchgang, der
   * mitten in der laufenden Einfahrt liegt. Die erste Anmeldung erzwingt eine
   * Neuvermessung des GESAMTEN nativen Baums (Begründung in
   * `lib/nav/keyboardHeight.ts`), und die wird mit jeder Nachricht teurer, weil
   * mehr Zeilen gemountet sind. Beim Abbau dasselbe noch einmal, am Ende der
   * Ausfahrt.
   *
   * Angemeldet wird jetzt einmal beim App-Start. Gelesen wird derselbe Wert,
   * an derselben einen Stelle (`kbShift`) — an der Rechnung ändert sich nichts.
   */
  const navInset = insets.bottom;
  /**
   * Wie weit Leiste UND Liste der Tastatur folgen — EINE Quelle für beide.
   *
   * Vorher hatte die Leiste diesen Transform und die Liste einen
   * Layout-Sprung. Zwei Wege für dieselbe Bewegung heißt: Sie können nicht
   * zusammenpassen. Jetzt hängen beide an diesem Wert, der bildgenau mit der
   * Tastatur läuft.
   */
  /**
   * Wie weit die TASTATUR trägt — ungefiltert.
   *
   * Die Leiste hängt hier dran und folgt der Tastatur IMMER. Ich hatte sie
   * vorübergehend an denselben Wert wie die Liste gehängt, und der ist bei
   * kurzen Unterhaltungen auf null gesperrt — dadurch blieb die Leiste unten
   * stehen, während die Tastatur hochfuhr. Die Sperre gilt nur für die Liste:
   * Ob deren Inhalt mitwandern muss, hängt davon ab, ob er den Platz überhaupt
   * füllt. Für die Leiste gibt es diese Frage nicht, sie muss immer über der
   * Tastatur stehen.
   */
  /**
   * Eingefroren, sobald die Ausfahrt läuft — und das ist der Hebel gegen das
   * „je mehr Nachrichten, desto ruckeliger".
   *
   * An dieser Zahl hängen Leiste UND jede einzelne Zeile (über `kbLift` →
   * `slideShift`). Beim Schließen wird die Tastatur eingeklappt, `kb.height`
   * läuft also herunter — und damit rechnete JEDE gemountete Zeile ihre Tiefe
   * und ihren Transform bei JEDEM Bild neu, mitten in der Ausfahrt. Genau diese
   * Last wächst mit der Zahl der Nachrichten, weil dann mehr Zeilen gemountet
   * sind. Eingefroren wird der Wert nicht mehr WEITERGEREICHT — der Auswerter
   * selbst läuft weiter, denn seine Eingänge sammelt Reanimated aus der
   * Schließung, nicht aus dem tatsächlich ausgeführten Zweig. Gestoppt wird die
   * Ausbreitung erst eine Ebene später, durch die Gleichheitsprüfung beim
   * Schreiben. Kosten hier: zwei Vergleiche pro Bild, vernachlässigbar — aber
   * wer hinter den frühen Ausstieg einen teureren Rumpf legt, zahlt ihn voll;
   * der Bildschirm fährt als Ganzes weg, verschieben kann sich darin ohnehin
   * nichts mehr.
   */
  const kbFreeze = useSharedValue(-1);
  const kbShift = useDerivedValue(() => {
    if (kbFreeze.value >= 0) return kbFreeze.value;
    const kbHeight = kbGate.value === 0 ? 0 : Math.max(0, keyboardHeight.value - navInset);
    const lift = interpolate(kbHeight, [0, 80], [0, BAR_LIFT_FROM_KB], Extrapolation.CLAMP);
    return kbHeight + lift;
  });
  const barAnimStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: -kbShift.value }],
  }));



  // Welcome-Message beim ersten Mount. Zufällige Variante aus pickWelcome,
  // damit der User nicht immer dieselbe Begrüßung sieht.
  useEffect(() => {
    if (messages.length === 0) {
      // Beim allerersten Öffnen fällt dieser Commit sonst in Bild 1 der
      // Einfahrt — und ein Commit pausiert dort die Kurve (siehe die
      // Begründung an der Leisten-Höhe). Ein Bild später ist die Begrüßung
      // genauso da; zu sehen ist der Unterschied nicht, weil die Fläche
      // darüber ohnehin erst nachrückt.
      const welcome = () => {
        if (isTransitionBusy()) {
          welcomeTimerRef.current = setTimeout(welcome, 120);
          return;
        }
        welcomeTimerRef.current = null;
        setMessages((prev) =>
          prev.length === 0
            ? [{ id: idGen(), kind: "bot", text: pickWelcome(locale) }]
            : prev,
        );
      };
      welcome();
    }
    /**
     * Der Wecker aus dem Winken heraus gilt IMMER, nicht nur beim allerersten
     * Aufbau.
     *
     * Die Stimmung überlebt im Modul-Speicher, der Bildschirm nicht — er wird
     * beim Schließen abgebaut. Hing der Wecker am leeren Verlauf, dann reichte
     * ein Schließen innerhalb der fünf Sekunden, und „winkt" blieb für immer
     * stehen: Beim nächsten Öffnen ist der Verlauf nicht mehr leer, der Wecker
     * wird nie wieder gestellt, und die beiden anderen Wege dorthin setzen
     * genau diese Stimmung voraus, um überhaupt zu greifen.
     */
    if (persistedMood !== "waving") return;
    const id = setTimeout(() => setMood("idle"), 5000);
    return () => clearTimeout(id);
  }, []);


  // ----- Voice ---------------------------------------------------------------
  // pendingSendRef = true sobald der User in der VoiceRecordBar auf Senden
  // tippt während die Aufnahme noch läuft. Wir stoppen die Recognition,
  // warten auf das finale Result-Event (mit isFinal=true) und schicken DANN
  // den finalen Transkript an Bo. Sonst würden wir mit dem letzten interim
  // result senden — der manchmal mid-word abgeschnitten ist.
  const pendingSendRef = useRef(false);
  // sendRef wird unten initialisiert, hier nur deklariert damit der Result-
  // Listener Zugriff hat auch wenn `send` per Closure-Capture an alten
  // Stand kommt.
  const sendRef = useRef<((text: string) => void) | null>(null);
  const setVoiceModeRef = useRef<((on: boolean) => void) | null>(null);

  useSpeechRecognitionEvent("result", (e) => {
    const text = e.results?.[0]?.transcript ?? "";
    if (text) setInput(text);
    // Final-Result UND pending Send → jetzt an Bo schicken.
    if (e.isFinal && pendingSendRef.current) {
      pendingSendRef.current = false;
      setVoiceModeRef.current?.(false);
      const trimmed = text.trim();
      if (trimmed) sendRef.current?.(trimmed);
    }
  });
  useSpeechRecognitionEvent("end", () => {
    // Pending Send → finalen Transkript schicken (oder den letzten Interim
    // wenn kein isFinal-Result kam).
    if (pendingSendRef.current) {
      setListening(false);
      pendingSendRef.current = false;
      setVoiceModeRef.current?.(false);
      const trimmed = input.trim();
      if (trimmed) sendRef.current?.(trimmed);
      explicitStopRef.current = false;
      return;
    }
    // User hat manuell gestoppt (Pause/Delete) → KEIN Restart, listening
    // auf false damit der Pause-Button auf Play wechselt.
    if (explicitStopRef.current) {
      setListening(false);
      explicitStopRef.current = false;
      return;
    }
    // Auto-End (Android-Silence-Timeout, ~5s) während User noch in voiceMode
    // ist → Recognition transparent neu starten OHNE listening zu togglen.
    // Vorher: setListening(false) + ~80ms später startVoice → Pause-Button
    // blinkte kurz auf Play (sah wie ein zufälliger Pause-State aus). Jetzt
    // bleibt listening durchgehend true → UI keine Flicker.
    if (voiceModeRef.current) {
      autoRestartingRef.current = true;
      // Zeitgeber merken UND auf Fokus prüfen. Wechselt der Nutzer in diesen 80ms
      // den Tab, stoppt der Blur-Effekt zwar die Aufnahme, setzt aber `voiceMode`
      // nicht zurück — der Zeitgeber startete das Mikrofon danach wieder, während
      // der Nutzer längst woanders war.
      if (restartRef.current) clearTimeout(restartRef.current);
      restartRef.current = setTimeout(() => {
        if (voiceModeRef.current && isFocusedRef.current) void startVoice();
      }, 80);
      return;
    }
    // Fallback: nichts läuft mehr.
    setListening(false);
  });
  useSpeechRecognitionEvent("error", (e) => {
    // Bei fatalen Fehlern (Permission, Audio-Capture, Network etc.) voice
    // mode sofort verlassen — Recovery nicht sinnvoll. Bei recoverable
    // Errors ("no-speech" = Silence-Timeout, kommt bei jeder Pause) NICHTS
    // tun → der end-Handler kümmert sich um Auto-Restart ohne dass
    // listening kurz auf false flackert (= sah aus wie ein zufälliger
    // Pause-Toggle in der UI).
    const fatal =
      e.error === "not-allowed" ||
      e.error === "service-not-allowed" ||
      e.error === "audio-capture" ||
      e.error === "language-not-supported";
    if (fatal) {
      setListening(false);
      setVoiceModeRef.current?.(false);
      pendingSendRef.current = false;
      explicitStopRef.current = false;
    }
  });

  /** Volume vom Mikrofon. Auf Android ist das `rmsdB` aus SpeechRecognizer.
   *  onRmsChanged — non-linear, geräte-abhängig (typisch 0..10 dB für
   *  Pixel, 0..50 für andere). Normale Sprechlautstärke gibt oft nur 1-3 dB
   *  was bei linearer /10 Normalisierung zu fast unsichtbaren Balken führt.
   *  Daher: Math.pow(_, 0.5) als kompressive Kurve — pusht leise Sprache in
   *  den sichtbaren Bereich, sättigt bei lauten Spitzen. */
  const micVolumeSV = useSharedValue(0);
  useSpeechRecognitionEvent("volumechange", (e) => {
    const raw = Math.max(0, e.value);
    const norm = Math.min(1, Math.pow(raw / 5, 0.5));
    micVolumeSV.value = norm;
  });

  const startVoice = useCallback(async () => {
    if (!ExpoSpeechRecognitionModule) return;
    const perm = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
    if (!perm.granted) return;
    // Nur beim ALLER-ersten Start input clearen — bei Auto-Restarts (nach
    // Android-Silence-Timeout) wollen wir den bisherigen Transkript behalten.
    if (!autoRestartingRef.current) setInput("");
    autoRestartingRef.current = false;
    setListening(true);
    ExpoSpeechRecognitionModule.start({
      lang:
        locale === "de"
          ? "de-DE"
          : locale === "fr"
            ? "fr-FR"
            : locale === "es"
              ? "es-ES"
              : "en-US",
      interimResults: true,
      continuous: true,
      volumeChangeEventOptions: {
        enabled: true,
        intervalMillis: 100,
      },
    });
  }, [locale]);

  /** True wenn der User explizit gestoppt hat (Pause/Delete/Send). Steuert
   *  ob das "end"-Event in einen Auto-Restart führen soll. */
  const explicitStopRef = useRef(false);
  /** True während einer Auto-Restart-Phase damit startVoice den bisherigen
   *  Input nicht clearet. */
  const autoRestartingRef = useRef(false);
  /** Spiegel von voiceMode in einem Ref damit der "end"-Listener immer den
   *  aktuellen Wert sieht (Closure-Capture-Stale sonst). */
  const voiceModeRef = useRef(false);

  const stopVoice = useCallback(() => {
    // explicitStopRef: das nächste "end"-Event soll KEINEN Auto-Restart
    // triggern. Wird vom Pause/Delete/Send-Pfad gesetzt. Auto-End (Android-
    // Silence-Timeout) lässt das Flag false → Restart greift.
    explicitStopRef.current = true;
    ExpoSpeechRecognitionModule?.stop?.();
    setListening(false);
  }, []);

  // autoVoice=1 vom Home-Mic-Tap: einmalig nach Mount starten.
  const autoVoiceFiredRef = useRef(false);
  useEffect(() => {
    if (params.autoVoice !== "1" || autoVoiceFiredRef.current) return;
    autoVoiceFiredRef.current = true;
    /**
     * ERST NACH der Fahrt, nicht sofort.
     *
     * `startVoice` fragt die Berechtigung ab und startet die native
     * Erkennungs-Session — Dienst-Anbindung, Audio-Fokus, dazu ein
     * `setListening(true)`, also ein voller Neu-Render. Das lief bislang rund
     * ein Bild in die laufende Einfahrt hinein.
     *
     * Derselbe Abstand wie beim Wecker, der Bo wieder anlaufen lässt. Der
     * Unterschied ist für den Nutzer nicht zu bemerken: Das Mikrofon geht
     * dreiviertel Sekunden nach dem Tipp an, und bis dahin fährt der
     * Bildschirm ohnehin noch.
     */
    const id = setTimeout(() => void startVoice(), ASSISTANT_IN.duration + 320);
    return () => clearTimeout(id);
  }, [params.autoVoice, startVoice]);

  // Wenn der Tab den Focus verliert (User wechselt zu Home etc.): laufende
  // Stream-XHRs abbrechen + Voice-Recognition stoppen. Sonst läuft die
  // Connection im Hintergrund weiter und der Mic-State bleibt offen.
  //
  // Außerdem Keyboard-Layout ZURÜCKSETZEN: Keyboard aktiv dismissen, Listen-
  // Padding auf 0, Tor vor kb.height zu. Schließt das IME erst, während der
  // Screen schon detached ist, verpasst useAnimatedKeyboard die Transition und
  // kb.height bleibt stehen — beim Zurückkommen hing der Chat dann dort, wo
  // die Tastatur war. Beim Re-Fokus öffnen wir das Tor nur, wenn das Keyboard
  // wirklich sichtbar ist (sonst beim nächsten onInputFocus/keyboardDidShow).
  useEffect(() => {
    if (!isFocused) {
      /**
       * Die laufende Antwort NICHT mehr abbrechen.
       *
       * Hier stand `abortRef.current?.abort()`. Das Aufräumen danach ist
       * absichtlich still — Tipp-Blase weg, Stimmung auf „schwebt", keine
       * Meldung. Genau dieses Bild entsteht, wenn jemand eine Nachricht
       * schickt und nie eine Antwort bekommt: Der Server hat sauber mit 200
       * geantwortet (im Protokoll nachgesehen), der Client hat den Stream nur
       * unterwegs weggeworfen.
       *
       * Ausgelöst wird es von jedem kurzen Fokuswechsel — und dieser Effekt
       * hängt zusätzlich an `listening` und `stopVoice`, läuft also öfter, als
       * man denkt.
       *
       * Eine Antwort zu Ende laufen zu lassen kostet ein paar Sekunden
       * Verbindung. Der Verlauf liegt modulweit, die Antwort ist beim
       * Zurückkommen also da. Abgebrochen wird nur noch beim endgültigen Abbau
       * des Bildschirms.
       */
      // Auch den Neustart-Zeitgeber killen: er wurde 80ms vor dem Tab-Wechsel
      // gesetzt und hätte das Mikrofon danach wieder geöffnet.
      if (restartRef.current) {
        clearTimeout(restartRef.current);
        restartRef.current = null;
      }
      if (listening) stopVoice();
      Keyboard.dismiss();
      /**
       * Das Tor und die Zahl NICHT im selben Bild — hier startet gerade eine
       * FREMDE Fahrt.
       *
       * Dieser Zweig läuft, wenn Bo den Vordergrund verliert, und der häufigste
       * Weg dorthin ist „Alle Treffer anzeigen": Die Ergebnisliste setzt ihre
       * Parameter und startet ihre Einfahrt im SELBEN Durchgang. Fällt das Tor
       * hier, stürzt die Tastatur-Zahl auf null — und daran hängt nicht nur die
       * Leiste, sondern über die Verschiebung JEDE gemountete Zeile. Bei N
       * Zeilen sind das 2N+3 Auswerter plus N native Schreibvorgänge, im ersten
       * Bild einer 430ms-Fahrt.
       *
       * Eine Fahrtlänge später kostet es niemanden etwas: Bo ist zu dem
       * Zeitpunkt vollständig verdeckt.
       */
      const closeGate = () => {
        /**
         * ABBRECHEN, wenn Bo den Vordergrund inzwischen zurückhat.
         *
         * Dieser Effekt hat kein Aufräumen — der Wecker überlebt also einen
         * Fokus-Wechsel. Wer aus der Ergebnisliste schnell zu Bo zurückkommt,
         * bekäme das Tor sonst zugezogen, WÄHREND Bo wieder offen ist: Die
         * Leiste folgte der Tastatur dann nicht mehr, bis das nächste
         * Auftauchen sie wieder aufmacht.
         *
         * Die Ablage statt der Zustandsgröße, weil dieser Rückruf aus einer
         * alten Schließung stammt — `isFocused` darin wäre der Stand von
         * damals.
         */
        if (isFocusedRef.current) {
          gateTimerRef.current = null;
          return;
        }
        if (isTransitionBusy()) {
          gateTimerRef.current = setTimeout(closeGate, 200);
          return;
        }
        gateTimerRef.current = null;
        setKbOffset(0);
        kbGate.value = 0;
      };
      if (gateTimerRef.current) clearTimeout(gateTimerRef.current);
      gateTimerRef.current = setTimeout(closeGate, 0);
    } else if (Keyboard.isVisible()) {
      kbGate.value = 1;
    }
  }, [isFocused, listening, stopVoice, kbGate]);

  // Re-Focus auf Assistant-Tab: wenn der User noch keine Nachricht
  // geschrieben hat, mit 75% Wahrscheinlichkeit nochmal die Wink-Animation
  // abspielen. Sobald der Chat ernsthaft läuft (User hat min. 1 Message
  // geschrieben), entfällt das — wäre dann anbiedernd.
  const prevFocusedRef = useRef(isFocused);
  useEffect(() => {
    const wasUnfocused = !prevFocusedRef.current;
    prevFocusedRef.current = isFocused;
    if (!isFocused || !wasUnfocused) return;
    const hasUserMessage = messagesRef.current.some((m) => m.kind === "user");
    if (hasUserMessage) return;
    if (Math.random() >= 0.75) return;
    /**
     * ERST NACH der Fahrt winken.
     *
     * `setMood` rendert den kompletten Bildschirm neu — und der Fokus-Wechsel,
     * an dem das hier hängt, kippt in Bild 1 der 430ms-Einfahrt. Das traf ein
     * VIERTEL aller Öffnungen und war damit buchstäblich das „manchmal ruckelt
     * es beim Reinsliden": mal winkt er, mal nicht, und nur wenn er winkt,
     * liegt der Render in der Bewegung.
     *
     * Derselbe Abstand wie bei Bos Wiederanlauf — vorher steht er ohnehin
     * still, ein Stimmungswechsel wäre bis dahin gar nicht zu sehen.
     */
    const waveId = setTimeout(() => setMood("waving"), ASSISTANT_IN.duration + 320);
    const id = setTimeout(() => {
      setMood((current) => (current === "waving" ? "idle" : current));
    }, ASSISTANT_IN.duration + 320 + 4500);
    return () => {
      clearTimeout(waveId);
      clearTimeout(id);
    };
  }, [isFocused]);

  // Periodic Idle-Wink: alle 60s winkt Bo kurz wenn er gerade idled und
  // nichts anderes läuft (kein Chat in-flight, Tab fokussiert). Hält die
  // Figur lebendig, suggeriert Aufmerksamkeit ohne aufdringlich zu sein.
  useEffect(() => {
    if (mood !== "idle" || busy || !isFocused) return;
    // Inner setTimeout-ID tracken damit wir es im Cleanup auch killen
    // können — sonst fired der setMood("idle") noch ~3s nachdem die
    // Component unmounted ist (kein direkter Leak da setState auf
    // unmounted no-op ist, aber das Closure hält ungenutzte Refs).
    let innerTimeout: ReturnType<typeof setTimeout> | null = null;
    const interval = setInterval(() => {
      /**
       * NICHT, während etwas fährt — und das ist das perfekte „manchmal".
       *
       * `setMood` rendert den kompletten Bildschirm neu, und der
       * Zustandswechsel bricht in Bo 15 Werte ab und startet rund zehn
       * Endlos-Ketten, darunter vier animierte SVG-Eigenschaften. Genau dafür
       * hat der einmalige Begrüßungs-Wink weiter oben längst seinen Abstand
       * bekommen; dieser Takt hier hatte ihn nie.
       *
       * Er läuft alle 60 Sekunden, solange Bo im Vordergrund und untätig ist —
       * und `isFocused` bleibt während der GANZEN Ausfahrt wahr (es fällt erst,
       * wenn die Kurve durch ist). Ein Takt gegen ein Fenster von gut 400ms
       * trifft also hin und wieder, scheinbar zufällig. Und weil `mood` in den
       * Abhängigkeiten steht, verschiebt sich die Phase bei jedem
       * Stimmungswechsel zusätzlich.
       *
       * Übersprungen wird nur dieser eine Takt; der nächste kommt in einer
       * Minute. Ein Winken, das niemand angefordert hat, ist der billigste
       * Verzicht der ganzen App.
       */
      if (isTransitionBusy()) return;
      setMood("waving");
      const backToIdle = () => {
        // Auch der Rückweg: Er liegt drei Sekunden später und kann damit
        // genauso in eine Fahrt fallen. Hier wird nachgeholt statt verzichtet —
        // sonst bliebe Bo winkend stehen.
        if (isTransitionBusy()) {
          innerTimeout = setTimeout(backToIdle, 300);
          return;
        }
        setMood((current) => (current === "waving" ? "idle" : current));
      };
      innerTimeout = setTimeout(backToIdle, 3000);
    }, 60_000);
    return () => {
      clearInterval(interval);
      if (innerTimeout) clearTimeout(innerTimeout);
    };
  }, [mood, busy, isFocused]);

  // Auf Unmount: alles aufräumen.
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      abortRef.current = null;
      if (moodTimerRef.current) {
        clearTimeout(moodTimerRef.current);
        moodTimerRef.current = null;
      }
      if (gateTimerRef.current) {
        clearTimeout(gateTimerRef.current);
        gateTimerRef.current = null;
      }
      if (drainTimerRef.current) {
        clearTimeout(drainTimerRef.current);
        drainTimerRef.current = null;
      }
      if (kbOffsetTimerRef.current) {
        clearTimeout(kbOffsetTimerRef.current);
        kbOffsetTimerRef.current = null;
      }
      if (welcomeTimerRef.current) {
        clearTimeout(welcomeTimerRef.current);
        welcomeTimerRef.current = null;
      }
      if (barHeightTimerRef.current) {
        clearTimeout(barHeightTimerRef.current);
        barHeightTimerRef.current = null;
      }
      /**
       * Den GEMERKTEN Zustand mit aufräumen, nicht nur den lebenden.
       *
       * Wer Bo mitten in einer Antwort schließt, bricht den Strom ab. Das
       * Aufräumen dazu läuft über `setMessages`/`setMood` — und die sind nach
       * dem Abbau wirkungslos. Im Modul-Speicher blieben deshalb die
       * Punkte-Blase und die Stimmung „denkt nach" stehen, und beim nächsten
       * Öffnen empfing einen ein Bo, der ewig tippt und nie ankommt.
       *
       * Der Speicher wird hier direkt geradegezogen; er ist die Quelle, aus der
       * der nächste Aufbau liest.
       */
      if (streamingBotIdRef.current) {
        /**
         * ZUERST den Puffer leeren.
         *
         * Stücke sammeln sich bis zu `TEXT_FLUSH_MS` an, bevor sie in den
         * Strom-Speicher wandern. Wer genau in diesem Fenster schließt, verlor
         * den letzten Satzteil — und zwar nicht nur auf dem Schirm: Der
         * Modul-Speicher ist die Quelle für den Verlauf, den der NÄCHSTE Turn
         * an den Server schickt. Bos eigene vorige Antwort wäre dort still
         * abgeschnitten gewesen.
         */
        flushTextRef.current?.(true);
        /**
         * Auch den halben Text retten.
         *
         * Er liegt im Strom-Speicher, und die Übernahme läuft über
         * `setMessages` — nach dem Abbau wirkungslos. Ohne diese Zeilen stünde
         * beim nächsten Öffnen eine leere Blase da, und im Verlauf an den
         * Server fehlte die angefangene Antwort ganz.
         */
        const streamed = takeStreamText(streamingBotIdRef.current);
        if (streamed !== null && streamed.length > 0) {
          persistedMessages = commitBotText(
            persistedMessages,
            streamingBotIdRef.current,
            streamed,
          );
        }
        persistedMessages = persistedMessages.filter((m) => m.kind !== "typing");
        persistedMood = "idle";
        bubbleReadyRef.current = null;
        streamingBotIdRef.current = null;
      }
      /**
       * Auch den Mikrofon-Neustart abräumen.
       *
       * Er wird 80ms nach dem Stoppen der Spracheingabe gesetzt und bisher nur
       * beim Fokusverlust gelöscht. Wird der Bildschirm ohne vorherigen
       * Fokusverlust abgebaut, stehen die beiden Merker noch auf ihren letzten
       * Werten — und der Zeitgeber öffnet das Mikrofon NACH dem Abbau.
       */
      if (restartRef.current) {
        clearTimeout(restartRef.current);
        restartRef.current = null;
      }
      // Die beiden anderen ebenso: Der eine hält sonst über eine Minute die
      // ganze `send`-Umgebung fest, der andere schreibt nach dem Abbau noch am
      // Tastatur-Tor.
      if (busyGuardRef.current) {
        clearTimeout(busyGuardRef.current);
        busyGuardRef.current = null;
      }
      if (kbConfirmRef.current) {
        clearTimeout(kbConfirmRef.current);
        kbConfirmRef.current = null;
      }
      if (flushTimerRef.current) {
        clearTimeout(flushTimerRef.current);
        flushTimerRef.current = null;
      }
      if (scrollEndTimeoutRef.current) {
        clearTimeout(scrollEndTimeoutRef.current);
        scrollEndTimeoutRef.current = null;
      }
    };
  }, []);

  // ----- Send + Stream -------------------------------------------------------
  /**
   * Das Zeichen NOTFALLS direkt aus dem Schlüsselbund holen.
   *
   * Im Server-Protokoll stand die erste Anfrage nach dem Öffnen regelmäßig mit
   * `401` und 0,6ms Antwortzeit — sie ging also ohne gültige Kopfzeile hinaus.
   * Der zweite Versuch mit demselben Text lief dann durch. Genau das Muster
   * „ich schreibe hi, nichts kommt, ich schreibe nochmal hi".
   *
   * Der Grund ist ein Wettlauf: Das Zeichen liegt nicht im gewöhnlichen
   * Speicher, sondern im Schlüsselbund des Geräts, und der Weg dorthin führt
   * über eine Verzögerung, einen Lesevorgang UND einen Netz-Aufruf, bevor es im
   * Speicher ankommt. Wer in diesem Fenster absendet, feuert ins Leere.
   *
   * Hier wird der Speicher deshalb nur noch als schneller Weg benutzt. Ist er
   * leer, wird einmal direkt im Schlüsselbund nachgesehen — das ist ein
   * Lesevorgang ohne Netz und kostet kaum etwas. Wird dort etwas gefunden,
   * wandert es gleich in den Speicher, damit der nächste Aufruf ihn wieder
   * nutzen kann.
   */
  const resolveAuthToken = useCallback(async (): Promise<string | null> => {
    const fromStore = useSearchStore.getState().authToken;
    if (fromStore) return fromStore;
    try {
      const stored = await loadAuthToken();
      if (stored) {
        useSearchStore.setState({ authToken: stored });
        return stored;
      }
    } catch {
      // Kein Zugriff auf den Schlüsselbund — dann eben ohne, der Server
      // antwortet mit 401 und der Anmelde-Ablauf greift wie bisher.
    }
    return null;
  }, []);

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || busyRef.current) return;
      busyRef.current = true;
      /**
       * Notbremse für die Sperre.
       *
       * Die Frist im Stream-Aufruf ist die eigentliche Absicherung. Diese hier
       * fängt alles ab, was daran vorbeikommt — ein Rückruf, der nie feuert,
       * ein Fehler vor dem `try`. Eine Sperre, die niemand mehr löst, macht den
       * Chat stumm, ohne dass irgendwo etwas steht; das darf nicht von einer
       * einzigen Stelle abhängen.
       */
      if (busyGuardRef.current) clearTimeout(busyGuardRef.current);
      busyGuardRef.current = setTimeout(() => {
        busyGuardRef.current = null;
        busyRef.current = false;
        setBusy(false);
      }, 70_000);
      // Keyboard bleibt OFFEN während Bo antwortet — User kann direkt
      // weitertippen. Nur bei Voice-Submit (onSend in VoiceRecordBar)
      // schließen wir explizit. Frame der Inputbar wandert NICHT ein/aus
      // zwischen Messages.
      haptic("button");

      const userMsg: Msg = { id: idGen(), kind: "user", text: trimmed };
      const typingMsg: Msg = { id: idGen(), kind: "typing" };
      const botId = idGen();
      streamingBotIdRef.current = botId;

      // Verlauf zur Server-API: alle bestehenden User/Bot-Bubbles plus die
      // gerade gepuste User-Message. Welcome-Message zählt als erste Bot-Turn.
      // Via messagesRef statt messages — sonst landet messages in der
      // useCallback-dep-Liste, und bei jedem Stream-Chunk re-creates `send`
      // → kaskadiert auf onBubbleRetry/renderItem → alle Bubbles re-rendern.
      // Das war die Haupt-Ursache fürs Scroll-Ruckeln bei langen Chats.
      const history = [
        ...messagesRef.current
          .filter((m): m is Extract<Msg, { kind: "user" | "bot" }> =>
            m.kind === "user" || m.kind === "bot",
          )
          .map((m) => ({
            role: m.kind === "user" ? ("user" as const) : ("assistant" as const),
            content: m.text,
          }))
          // Leere Bubbles (Card-only, text="") raus — das Server-Schema
          // verlangt content.min(1), EINE leere Bubble im Verlauf würde sonst
          // jeden Folge-Turn mit 400 abbrechen.
          .filter((m) => m.content.trim().length > 0)
          // Server-Schema erlaubt max 60 Einträge INKLUSIVE der neuen
          // Nachricht — der lokale Bubble-Cap liegt bei 80, ungekappt liefe
          // jeder lange Chat in „Bad request".
          .slice(-59),
        { role: "user" as const, content: trimmed },
      ];

      // Inverted FlatList rendert neueste Bubble strukturell am Bottom —
      // kein manuelles Scroll-Management nötig.
      setMessages((prev) => [...prev, userMsg, typingMsg]);
      setInput("");
      setBusy(true);

      // Vorigen Stream abbrechen falls noch aktiv.
      abortRef.current?.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;

      try {
        await streamChat({
          history,
          locale,
          currency,
          today: todayLocal(),
          // Cross-Turn-Memory: letzte Such-Params mitsenden, damit der
          // Server-State (der per-Turn neu erstellt wird) wieder weiß was
          // gerade präsentiert wurde.
          lastSearch: lastSearchRef.current ?? undefined,
          authToken: await resolveAuthToken(),
          signal: ctrl.signal,
          onEvent: (ev) => handleStreamEvent(ev, botId),
        });
      } catch (err) {
        if ((err as Error).name === "AbortError") {
          /**
           * Abbruch — aber nicht mehr lautlos.
           *
           * Abgebrochen wird nur noch, wenn eine NEUE Nachricht die alte
           * ablöst (dann übernimmt deren Blase) oder der Bildschirm abgebaut
           * wird (dann sieht es ohnehin niemand). Landet man hier trotzdem,
           * während dieser Turn noch der aktuelle ist, ist etwas schiefgelaufen
           * — und dann gehört das sichtbar gemacht statt weggeräumt. Vorher
           * blieb genau in diesem Fall ein Chat zurück, der nichts anzeigt und
           * nichts erklärt.
           */
          /**
           * Die Prüfung gehört VOR das Aufräumen, nicht dahinter.
           *
           * Genau der häufige Fall ist der abgelöste Turn — und dessen
           * Aufräumen traf den NEUEN: Es entfernte dessen Punkte-Blase und
           * setzte die Stimmung auf ruhig, während der noch lief. Wer abgelöst
           * wurde, fasst nichts mehr an; die Anzeige gehört dem laufenden Turn.
           */
          if (streamingBotIdRef.current !== botId) return;
          setMessages((prev) => [
            ...prev.filter((m) => m.kind !== "typing"),
            { id: idGen(), kind: "error", message: t("assistant.error.generic") },
          ]);
          setMood("idle");
          return;
        }
        // Bo ist kontogebunden: 401 = nicht eingeloggt → Login-Screen öffnen,
        // 429 = Stunden-Kontingent des Kontos aufgebraucht. Beide bekommen
        // eine spezifische Meldung statt des generischen Fehlers.
        const status = err instanceof ChatApiError ? err.status : null;
        if (status === 401) openAuthOverlay();
        const rawMessage = err instanceof Error ? err.message : String(err);
        if (__DEV__) console.log("[chat] stream error:", rawMessage);
        setMood("error");
        setMessages((prev) =>
          replaceTyping(prev, {
            id: idGen(),
            kind: "error",
            message:
              status === 401
                ? t("assistant.error.loginrequired")
                : status === 429
                  ? t("assistant.error.ratelimit")
                  : // Im Dev-Build die echte Fehlermeldung, damit wir sofort
                    // sehen ob's 404 (Server-Code alt), 503 (Key fehlt),
                    // Network o.ä. ist. In Prod fallback auf generisch.
                    __DEV__
                    ? rawMessage
                    : t("assistant.error.generic"),
          }),
        );
      } finally {
        // Rest ausgeben, bevor der Turn zumacht — sonst fehlten die letzten
        // bis zu 50ms Text.
        flushTextRef.current?.(true);
        if (abortRef.current === ctrl) abortRef.current = null;
        // Nur aufräumen, wenn noch DIESE Antwort läuft. Wurde die alte
        // abgebrochen und schon die nächste losgeschickt, machte dieser Block
        // sonst die neue kaputt: `busy` fiel mitten im Schreiben auf false, und
        // mit der geleerten Bot-Kennung landeten die restlichen Bruchstücke in
        // keiner Sprechblase mehr — Bo brach mitten im Satz ab.
        /**
         * Die Notbremse gehört DEM LAUFENDEN Turn — nicht dem, der hier endet.
         *
         * Sie stand außerhalb der Prüfung, obwohl der Kommentar darüber genau
         * begründet, warum hier nichts angefasst werden darf, was einem anderen
         * Turn gehört. Der Ablauf:
         *
         *   Turn 1 hängt → die Notbremse greift nach 70s und gibt die Sperre
         *   frei → der Nutzer schreibt erneut → Turn 2 setzt Sperre und EIGENE
         *   Notbremse und bricht Turn 1 ab → Turn 1 landet hier und räumt
         *   Turn 2s Notbremse weg.
         *
         * Turn 2 läuft danach ohne jede Absicherung. Hängt auch er, bleibt die
         * Sperre für immer gesetzt und jedes weitere Senden wird stillschweigend
         * verworfen — der Chat nimmt nichts mehr an. Genau das ist „Bo ist
         * einfach stuck": Der eine Fall, für den die Notbremse da ist, hat sie
         * selbst entschärft.
         */
        /**
         * Den fertigen Text aus dem Strom-Speicher in die Nachricht übernehmen.
         *
         * Hier und nicht bei `done`: Dieser Block läuft am Ende JEDES Turns,
         * also auch nach einem Fehler und nach einem Abbruch. Was der Nutzer
         * schon gelesen hat, bleibt damit stehen und geht in den Verlauf ein,
         * den der nächste Turn an den Server schickt — sonst wäre eine
         * abgebrochene Antwort für Bo nie passiert.
         */
        flushTextRef.current?.(true);
        const streamed = takeStreamText(botId);
        if (streamed !== null && streamed.length > 0) {
          setMessages((prev) => commitBotText(prev, botId, streamed));
        }
        if (bubbleReadyRef.current === botId) bubbleReadyRef.current = null;
        if (streamingBotIdRef.current === botId) {
          if (busyGuardRef.current) {
            clearTimeout(busyGuardRef.current);
            busyGuardRef.current = null;
          }
          setBusy(false);
          busyRef.current = false;
          streamingBotIdRef.current = null;
        }
      }
    },
    // KEIN `busy`: Gelesen wird `busyRef`, weil zwei Aufrufe im selben
    // Durchgang sonst beide durchkämen. Als Abhängigkeit stehengeblieben, hätte
    // jeder Wechsel eine neue `send`-Kennung erzeugt — und über
    // `onBubbleRetry` → `renderItem` die ganze Liste zweimal pro Antwort neu
    // aufgebaut. Genau das, wogegen sie gerade gemerkt wird.
    [locale, currency, t, resolveAuthToken, openAuthOverlay],
  );

  /**
   * Text-Stücke sammeln statt jedes einzeln einzutragen.
   *
   * Das Modell schickt viele kleine Stücke — je nach Antwort dreißig bis
   * fünfzig pro Sekunde. Jedes löste bisher ein `setMessages` aus, und damit
   * einen vollständigen Durchgang des Bildschirms samt Abgleich aller
   * gemounteten Zeilen. Das ist die größte Dauerlast überhaupt, und sie liegt
   * ausgerechnet in dem Moment an, in dem man hinschaut.
   *
   * Gesammelt und alle 50ms ausgegeben sind es zwanzig Durchgänge pro Sekunde —
   * für den Lesefluss nicht zu unterscheiden, für den Strang ein Vielfaches
   * weniger Arbeit.
   *
   * Vor jedem ANDEREN Ereignis wird geleert: Sonst erschiene eine Karte vor dem
   * Text, der eigentlich über ihr steht.
   */
  const textBufRef = useRef<{ botId: string; text: string } | null>(null);
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Aufgeschobener Stimmungswechsel — muss beim Abbau sterben. */
  const moodTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Aufgeschobenes Schließen des Tastatur-Tors — muss beim Abbau sterben. */
  const gateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Höhe der Eingabeleiste, gemessen während einer Fahrt — siehe dort. */
  const pendingBarHeightRef = useRef<number | null>(null);
  /** Wiederversuch für die aufgeschobene Leisten-Höhe. */
  const barHeightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Aufgeschobenes Nachziehen der Tastatur-Zahl. */
  const kbOffsetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Aufgeschobene Begrüßung. */
  const welcomeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * @param force Aufschub übergehen. Nötig am ENDE eines Turns und beim Abbau:
   *        Dort wird der Strom-Speicher in die Nachricht übernommen, und ein
   *        noch gepufferter Rest wäre sonst verloren.
   */
  const flushText = useCallback((force = false) => {
    if (flushTimerRef.current) {
      clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }
    const buf = textBufRef.current;
    if (!buf || buf.text.length === 0) return;
    /**
     * NICHT ausgeben, solange etwas fährt.
     *
     * Der Strom läuft weiter, wenn man mitten in einer Antwort etwas öffnet
     * oder schließt — die Ergebnisliste aus Bo heraus, eine Ergebniskarte, Bo
     * selbst. Jede Ausgabe lässt die Blase wachsen, und das ist ein echter
     * Yoga-Durchgang über den Inhalts-Container samt einer Maß-Meldung pro
     * gemounteter Zeile. Zehnmal pro Sekunde trifft das eine 380ms-Fahrt mit
     * hoher Wahrscheinlichkeit — und weil es eben nur mit Wahrscheinlichkeit
     * trifft, ist es ein „manchmal ruckelt es".
     *
     * Der Puffer bleibt stehen und wird gleich danach ausgegeben; für den
     * Lesefluss ist eine Verzögerung von unter einer halben Sekunde nicht von
     * der normalen Antwortzeit zu unterscheiden.
     */
    if (!force && isTransitionBusy()) {
      flushTimerRef.current = setTimeout(() => flushTextRef.current?.(), 120);
      return;
    }
    textBufRef.current = null;
    /**
     * Der Text geht in den Strom-Speicher, NICHT in die Liste.
     *
     * Begründung ausführlich in `lib/assistant/streamText.ts`. Kurz: Solange er
     * in `messages` steht, ist jedes Stück eine Änderung an den Daten der
     * Liste — und die rendert daraufhin komplett neu, mit Referenz-Wechsel auf
     * jeder gemounteten Zelle. Zehnmal pro Sekunde, mal Verlaufslänge.
     *
     * Die Liste wird nur noch ein einziges Mal pro Antwort angefasst: um die
     * (leere) Blase anzulegen. Ab da schreibt der Strom an ihr vorbei, und beim
     * Ende wird der fertige Text übernommen.
     */
    appendStreamText(buf.botId, buf.text);
    if (bubbleReadyRef.current === buf.botId) return;
    bubbleReadyRef.current = buf.botId;
    setMessages((prev) => appendBotText(prev, buf.botId, ""));
  }, []);
  flushTextRef.current = flushText;

  /** Aufgeschobene Strom-Ereignisse, in Eingangsreihenfolge. */
  const eventQueueRef = useRef<{ event: ChatStreamEvent; botId: string }[]>([]);
  const drainTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Spiegel auf den Behandler — der Abfluss darf nicht an einer alten
   *  Schließung hängen. */
  const handleStreamEventRef = useRef<
    ((event: ChatStreamEvent, botId: string) => void) | null
  >(null);
  const scheduleDrain = useCallback(() => {
    if (drainTimerRef.current) return;
    const run = () => {
      if (isTransitionBusy()) {
        drainTimerRef.current = setTimeout(run, 120);
        return;
      }
      drainTimerRef.current = null;
      // ZUERST leeren, dann anwenden: Sonst reihte der Behandler die Ereignisse
      // sofort wieder ein, weil die Schlange noch als nicht leer gilt.
      const pending = eventQueueRef.current;
      eventQueueRef.current = [];
      for (const item of pending) {
        handleStreamEventRef.current?.(item.event, item.botId);
      }
    };
    drainTimerRef.current = setTimeout(run, 120);
  }, []);

  // Stream-Event-Handler — closure over botId der aktuellen Antwort.
  const handleStreamEvent = useCallback(
    (event: ChatStreamEvent, botId: string) => {
      /**
       * Während einer Fahrt wird EINGEREIHT statt angewandt.
       *
       * Von den sieben Ereignissen des Stroms waren nur zwei abgesichert —
       * Stimmung und Text. Die anderen fünf (`search_result`, `stop_board`,
       * `action`, `error`, `done`) schreiben alle in die Nachrichtenliste, und
       * jeder dieser Schreibvorgänge ist ein neues Datenfeld: Die Liste rendert
       * durch, mountet eine neue Zelle, und die bringt zwei neue
       * Reanimated-Zuordnungen mit. Jede Anmeldung verwirft die sortierte
       * Reihenfolge ALLER Zuordnungen der App, die im nächsten Bild komplett
       * neu aufgebaut wird.
       *
       * Der Inhalt ist dabei nicht klein: `stop_board` mountet eine Tafel mit
       * SVG-Ring, `search_result` eine Ergebniskarte mit Logo und Verlauf. Ein
       * Erst-Zeichnen liegt weit über dem Bildbudget.
       *
       * Eingereiht statt einzeln gegattert, weil die REIHENFOLGE zählt: Ein
       * `done` vor seinem letzten `text` würde die Antwort abschneiden. Solange
       * die Schlange nicht leer ist, geht deshalb auch alles Neue hinein.
       */
      if (isTransitionBusy() || eventQueueRef.current.length > 0) {
        eventQueueRef.current.push({ event, botId });
        scheduleDrain();
        return;
      }
      if (event.type !== "text") flushText();
      switch (event.type) {
        case "mood":
          /**
           * Auch die Stimmung wartet, solange etwas fährt.
           *
           * `setMood` rendert diesen Bildschirm komplett neu — zweieinhalbtausend
           * Zeilen. Der Strom liefert Stimmungswechsel zu beliebigen
           * Zeitpunkten; fällt einer in eine Fahrt, ist das derselbe Ruck wie
           * beim Text-Ausgeben daneben, nur seltener und damit noch schwerer zu
           * fassen. Zu sehen ist von der Verzögerung nichts: Während einer Fahrt
           * steht Bo ohnehin still.
           */
          if (isTransitionBusy()) {
            /**
             * WIEDERVERSUCH, kein fester Aufschub — das war zu kurz gedacht.
             *
             * Hier standen feste 140ms. Eine Fahrt dauert aber 380 bis 430ms:
             * Ein Stimmungswechsel, der kurz nach ihrem Start eintrifft, wurde
             * damit nicht hinter sie geschoben, sondern in ihre MITTE. Genau
             * dort ist er am teuersten — und in `Bo.tsx` zündete er an dieser
             * Stelle bis eben zwölf 200ms-Animationen auf SVG-treibenden
             * Werten (siehe die Begründung am dortigen Pausen-Ausstieg).
             *
             * Der Text-Ausgeber daneben macht es seit jeher richtig: Er stellt
             * sich alle 120ms neu und prüft dabei JEDES MAL erneut. Genau das
             * hier auch. Der Wiederversuch selbst ist nur ein
             * Zeitstempel-Vergleich und stört keine Bewegung.
             */
            const mood = event.mood;
            const apply = () => {
              if (isTransitionBusy()) {
                moodTimerRef.current = setTimeout(apply, 120);
                return;
              }
              moodTimerRef.current = null;
              setMood(mood);
            };
            if (moodTimerRef.current) clearTimeout(moodTimerRef.current);
            moodTimerRef.current = setTimeout(apply, 120);
            return;
          }
          setMood(event.mood);
          return;
        case "text": {
          const buf = textBufRef.current;
          if (buf && buf.botId === botId) buf.text += event.delta;
          else textBufRef.current = { botId, text: event.delta };
          if (!flushTimerRef.current) {
            flushTimerRef.current = setTimeout(flushText, TEXT_FLUSH_MS);
          }
          return;
        }
        case "search_result":
          // Such-Params merken — der nächste Request schickt sie zurück,
          // damit Tools wie open_all_results den Kontext der vorigen Suche
          // wieder zur Verfügung haben.
          /**
           * Bei einer mehrteiligen Reise gilt der HAUPTLAUF, nicht das letzte
           * Bein.
           *
           * Der Server schickt pro Bein ein Ereignis, in Reisereihenfolge. Hier
           * stand ein schlichtes Überschreiben — zuletzt gewann damit der
           * Zubringer am Ziel, und beim nächsten Zug bezog sich „speicher das"
           * oder „zeig alle Treffer" auf den Flughafen-Shuttle statt auf den
           * Flug. Serverseitig war der Hauptlauf längst bestimmt, er stand nur
           * nicht im Ereignis.
           *
           * `isMain` fehlt bei einer einfachen Suche — dort gibt es genau ein
           * Ergebnis, und das wird wie bisher übernommen.
           */
          if (event.isMain !== false) lastSearchRef.current = event.params;
          setMessages((prev) => appendFlightMessage(prev, botId, event.result));
          return;
        case "stop_board":
          // Der Server hat die Tafel bereits geladen (Bo liest sie mit) und
          // schickt sie mit — die Karte übernimmt sie, statt ein zweites Mal zu
          // holen. Fehlt sie, holt die Karte wie bisher selbst.
          if (__DEV__) console.log("[chat] stop_board:", event.stop.code, event.stop.label, event.board);
          setMessages((prev) =>
            appendBoardMessage(prev, botId, event.stop, event.board, event.data),
          );
          return;
        case "action":
          // Bo löst eine App-State-Mutation oder eine Navigation aus.
          if (event.action === "open_results" && event.payload) {
            // Statt sofort zu navigieren: an die Bot-Message einen
            // „Alle Treffer anzeigen"-Button hängen. User entscheidet
            // selbst wann er den vollen Results-Screen sehen will.
            const p = event.payload as Partial<LastSearchParams>;
            if (p.mode && p.origin && p.destination && p.departDate) {
              const params: LastSearchParams = {
                origin: p.origin,
                destination: p.destination,
                originLabel: p.originLabel ?? "",
                destLabel: p.destLabel ?? "",
                mode: p.mode as LastSearchParams["mode"],
                departDate: p.departDate,
                passengers: p.passengers ?? 1,
                currency: p.currency ?? "EUR",
              };
              setMessages((prev) => appendActionMessage(prev, botId, params));
            }
            return;
          }
          // save_trip / unsave_trip — letzten Flight aus dem Verlauf nehmen
          // (bei Vergleichs-Bubbles mit mehreren Cards: die zuletzt gezeigte).
          setMessages((prev) => {
            const lastFlight = [...prev]
              .reverse()
              .find((m): m is Extract<Msg, { kind: "result" }> => m.kind === "result")
              ?.result;
            if (!lastFlight) return prev;
            const store = useSearchStore.getState();
            if (event.action === "save_trip") {
              store.saveTrip(lastFlight, 1);
              store.showSavedToast(lastFlight);
              haptic("important");
            } else if (event.action === "unsave_trip") {
              store.unsaveTrip(lastFlight.id);
              haptic("button");
            }
            return prev;
          });
          return;
        case "tool_use":
          // tool_use ist nur Hint — die Mood-Events vom Server liefern die
          // sichtbare State-Change. Hier reicht's, das Event zu loggen.
          if (__DEV__) console.log("[chat] tool_use:", event.name);
          return;
        case "usage":
          if (__DEV__) {
            console.log(
              `[chat] usage: in=${event.input} out=${event.output} cacheRead=${event.cacheRead} cacheWrite=${event.cacheWrite}`,
            );
          }
          return;
        case "error":
          setMood("error");
          setMessages((prev) =>
            replaceTyping(prev, {
              id: idGen(),
              kind: "error",
              message: event.message || t("assistant.error.generic"),
            }),
          );
          return;
        case "done":
          // Stream-Ende — Mood-Reset überlassen wir normalerweise dem Server
          // (er emittiert happy/idle/error VOR done). Aber als SAFETY-NET:
          // wenn der Server-Idle-Event verloren ging (Network-Race, Stream-
          // Abort-Timing), würde Bo sonst ewig in happy/talking/thinking
          // kleben. Hier zwingen wir den Mood zurück auf idle FALLS er noch
          // in einem aktiven (non-idle, non-error) Zustand ist.
          setMessages((prev) => prev.filter((m) => m.kind !== "typing"));
          setMood((current) =>
            current === "happy" || current === "talking" || current === "thinking"
              ? "idle"
              : current,
          );
          return;
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [t, scheduleDrain],
  );
  handleStreamEventRef.current = handleStreamEvent;

  // Sync send + setVoiceMode + voiceMode in Refs damit die Speech-
  // Recognition-Event-Handler (oben definiert) auf die jeweils aktuelle
  // Function-Instanz und den aktuellen voiceMode-State zugreifen.
  sendRef.current = send;
  setVoiceModeRef.current = setVoiceMode;
  voiceModeRef.current = voiceMode;

  // useSharedValue für die Mic-Volume — wird in VoiceRecordBar als
  // Animations-Source für die Balken-Amplitude genutzt.
  // (siehe useSpeechRecognitionEvent("volumechange") oben)

  // ----- Render ---------------------------------------------------------------
  const moodLabel = useMemo(() => t(`assistant.mood.${mood}`), [mood, t]);
  const canSend = input.trim().length > 0 && !busy;
  const voiceAvailable = ExpoSpeechRecognitionModule != null;

  // onRetry für Error-Bubbles MUSS stabile Referenz haben damit der memo'te
  // <Bubble> nicht bei jedem Re-Render alle Bubbles neu zeichnet. messagesRef
  // ist oben deklariert, useCallback dep nur `send`.
  const onBubbleRetry = useCallback(() => {
    const lastUser = [...messagesRef.current].reverse().find((x) => x.kind === "user");
    if (lastUser && lastUser.kind === "user") send(lastUser.text);
  }, [send]);

  // Handler für „Alle Treffer anzeigen"-Button — navigiert zum
  // /search/results mit den vom Server zurückgegebenen Params.
  const onOpenResults = useCallback(
    (params: LastSearchParams) => {
      haptic("button");
      router.navigate({
        pathname: "/search/results",
        params: {
          mode: params.mode,
          origin: params.origin,
          destination: params.destination,
          originLabel: params.originLabel,
          destLabel: params.destLabel,
          departDate: params.departDate,
          passengers: String(params.passengers),
          currency: params.currency,
        },
      });
    },
    [router],
  );

  // Für inverted FlatList: data wird umgekehrt übergeben damit die neueste
  // Message bei index=0 steht (mit `inverted` ist das visuell der Bottom).
  // useMemo damit nicht bei jedem Render ein neues Array entsteht.
  const reversedMessages = useMemo(() => [...messages].reverse(), [messages]);
  /** Die fünf neuesten — siehe `data` an der Liste. Eigener Merker, damit die
   *  Schranke der Liste nicht bei jedem Durchgang bricht. */
  /**
   * ZWÖLF statt fünf — fünf füllen den Bildschirm nicht.
   *
   * Die Begrenzung während der Fahrt hat einen guten Grund (siehe `data` an der
   * Liste): Sie sperrt den Eil-Pfad der Virtualisierung aus, der sonst mitten in
   * der Bewegung synchron nachrendert. Die ZAHL war aber falsch gewählt. Fünf
   * Zeilen decken eine Fläche nur, wenn die Nachrichten hoch sind — bei kurzem
   * Text, und erst recht ohne ausgefahrene Tastatur, bleibt der obere Teil leer,
   * bis der Rest 120ms nach der Ankunft nachrückt. Genau das ist als „es sind
   * noch nicht alle Nachrichten da" aufgefallen.
   *
   * Zwölf ist dieselbe Zahl, die die Liste nach der Fahrt ohnehin als
   * Anfangsbereich benutzt — der Eil-Pfad bleibt damit gesperrt, weil der
   * gekürzte Datensatz weiterhin vollständig gerendert wird.
   *
   * Und teurer wird die Fahrt dadurch nicht: Bo bleibt seit dem Umbau dauerhaft
   * gemountet, diese zwölf Zeilen stehen also schon, bevor der Finger die
   * Suchleiste berührt. Gebaut wird während der Bewegung nichts mehr.
   */
  const enteringSlice = useMemo(() => reversedMessages.slice(0, 12), [reversedMessages]);



  /**
   * Als eigener Wert, nicht als Feld im JSX.
   *
   * Während Bo antwortet, rendert dieser Bildschirm pro eintreffendem Wort neu.
   * Ein hier erzeugtes Feld hätte jedes Mal eine neue Kennung — und damit einen
   * Eigenschafts-Wechsel auf der Inhalts-Ansicht der Liste, obwohl sich nichts
   * daran geändert hat.
   */
  /**
   * Die verschobene Strecke kommt am oberen Rand als Innenabstand zurück.
   *
   * Die Liste fährt mit der Tastatur nach oben — ihr Inhalt aber nicht mit.
   * Dadurch fehlte oben genau diese Strecke: Man kam beim Scrollen nicht mehr
   * bis zur ersten Nachricht, sie stand hinter der Kopfzeile.
   *
   * Als Innenabstand am visuellen OBEREN Rand ergänzt, stimmt beides wieder —
   * und zwar ohne sichtbaren Sprung, denn dieser Abstand liegt am ENDE des
   * Inhalts: Die Lage der Zeilen selbst ändert sich dadurch nicht, nur die
   * Scroll-Strecke wird länger.
   *
   * Für kurze Unterhaltungen hebt sich damit sogar beides exakt auf: Die
   * Nachrichten hängen am oberen Rand, der Abstand drückt sie um die Strecke
   * nach unten, die Verschiebung hebt sie um dieselbe wieder an. Sie bleiben
   * stehen und damit lesbar — vorher rutschten zwei Nachrichten hinter Bo.
   */
  /**
   * Der Zuschlag am oberen Rand gilt NUR, wenn der Inhalt fließt.
   *
   * Das war der Fehler, der alle drei Meldungen erklärt. Bei einer kurzen
   * Unterhaltung hängen die Nachrichten am oberen Rand — dieser Zuschlag drückt
   * sie dann um genau die Strecke nach unten, um die die Liste nach oben fährt.
   * Netto bewegte sich nichts, und die Tastatur verdeckte sie.
   *
   * Fließt der Inhalt dagegen (länger als die Liste), liegt der Zuschlag HINTER
   * den Nachrichten: Er verschiebt sie nicht, sondern gibt nur die Scroll-
   * Strecke zurück, die durch das Verschieben oben fehlt. Dort ist er richtig.
   */
  /**
   * Scroll-Strecke für die Tastatur — immer, wenn sie steht.
   *
   * Der Ansatz davor war falsch, und das Bild hat es gezeigt: Ich habe die
   * GANZE LISTE per Transform nach oben geschoben. Damit wandert auch ihre
   * Oberkante nach oben — die Nachrichten lagen über dem Binch-Schriftzug. Und
   * weil dabei nie gescrollt wurde, blieb die Tiefe stehen: Sie hängt an der
   * Scrollposition, und die änderte sich nicht.
   *
   * Richtig ist Scrollen. Das bewegt den Inhalt IM festen Rahmen, die Kopfzeile
   * bleibt frei, und die Tiefe bekommt genau das fortlaufende Signal, an dem
   * sie hängt.
   *
   * Dafür braucht der Inhalt am oberen Ende so viel Strecke, wie gescrollt
   * werden soll — die gibt dieser Zuschlag. Er liegt am ENDE des Inhalts:
   * Fließt der Inhalt, verschiebt er die Nachrichten nicht. Hängen sie
   * verankert oben, drückt er sie herunter — und genau um diesen Betrag wird
   * anschließend gescrollt, also stehen sie am Ende wieder da, wo sie waren.
   * Beide Fälle ergeben sich damit von selbst, ohne Fallunterscheidung.
   */


  /**
   * Steht HIER oben, weil der Inhalts-Stil der Liste davon abhängt (siehe
   * `threadContentStyle`). Die ausführliche Begründung zu `entering` steht
   * weiter unten bei den beiden Weckern, die es zurücksetzen.
   */
  const [entering, setEntering] = useState(true);
  /**
   * Wird während der Fahrt WIRKLICH gekürzt?
   *
   * Nur dann, wenn es überhaupt mehr als fünf Nachrichten gibt. Bei kürzerem
   * Verlauf ist die Kürzung wirkungslos — und die Layout-Ausnahme darunter
   * wäre dann eine Verschiebung ohne Grund.
   */
  const sliced = entering && reversedMessages.length > enteringSlice.length;

  /**
   * Mindesthöhe = VOLLE Listenhöhe. Das ist keine Willkür.
   *
   * Ich hatte sie kurz auf die nutzbare Höhe gesetzt, um daran ablesen zu
   * können, ob der Inhalt überläuft. Das war falsch herum gedacht: Bei einer
   * invertierten Liste liegt der Inhalt am unteren Ende verankert, und die
   * Kinder hängen am ANDEREN Ende des Containers. Ein kürzerer Container zieht
   * sie damit nicht nach oben, sondern nach unten — bei offener Tastatur also
   * genau dahinter. Deshalb verschwand die Begrüßung.
   *
   * Zusammen mit `justifyContent: flex-end` ergibt das die Verankerung oben:
   * Solange der Stapel die Liste nicht füllt, hängt er unter Bo statt über der
   * Leiste zu schweben. Genau daraus folgt auch, dass kurze Unterhaltungen beim
   * Öffnen der Tastatur stehen bleiben — der Platz dafür kommt aus der freien
   * Fläche, nicht aus einer Verschiebung.
   */
  const threadContentStyle = useMemo(
    () => [
      styles.threadContent,
      /**
       * Der Zuschlag am OBEREN Ende gibt den Scroll-Weg zurück, den das Heben
       * kostet — und nur dort ist er gefahrlos.
       *
       * Gehoben wird per Transform, der Inhalt bleibt also gleich hoch: Ganz
       * oben angekommen wären die ältesten Zeilen um die Hebe-Strecke aus dem
       * Bild geschoben und nicht mehr erreichbar. Am oberen Ende angehängt
       * wächst der Weg genau um diesen Betrag.
       *
       * Nur bei vollem Stapel. Ist noch Platz frei, zehrt `flexGrow` den
       * Zuschlag aus dem freien Platz — dann verschöbe er die Zeilen, und genau
       * das soll hier nicht passieren. Gebraucht wird er dort auch nicht: Ohne
       * Überhang gibt es nichts, das aus dem Bild geschoben würde.
       */
      { paddingTop: contentPaddingBottom, paddingBottom: THREAD_TOP_GAP + (flowing ? kbPad : 0) },
      /**
       * Solange gekürzt wird, NICHT am oberen Rand verankern.
       *
       * `flexGrow: 1` + `justifyContent: "flex-end"` schiebt wenige Nachrichten
       * an den visuellen OBEREN Rand — bei kurzen Unterhaltungen ist das genau
       * richtig und ausdrücklich so gebaut. Während der Einfahrt kennt die
       * Liste aber nur die fünf neuesten, und die sahen damit aus wie eine
       * kurze Unterhaltung: Sie standen oben, und als der Rest nachrückte,
       * rutschten sie nach unten. Das ist das „oben fehlen Nachrichten, die
       * ploppen rein und alles verschiebt sich".
       *
       * Ohne die Verankerung packen sie am Flussanfang — in der gespiegelten
       * Liste also unten, wo sie hingehören. Der Rest füllt danach nach oben
       * auf, ohne dass sich etwas verschiebt.
       */
      sliced ? NO_END_ANCHOR : null,
    ],
    [contentPaddingBottom, flowing, kbPad, sliced],
  );

  /**
   * Scrollposition auf dem UI-Strang — Auslöser für die Tiefen-Rechnung.
   */
  /**
   * Steht die Liste nahe am unteren Ende?
   *
   * Als einfacher Merker, gespeist von einer Reaktion, die NUR beim Umschlagen
   * feuert — nicht pro Bild. Ein Lesezugriff auf die Scrollposition vom
   * JS-Strang aus wäre ein blockierender Sprung in die andere Laufzeit, und der
   * läge hier mitten im Eintreffen einer Nachricht.
   */


  /**
   * Wie weit die Zeilen hinter ihrem Layout zurückgehalten werden.
   *
   * Das ersetzt die Ausgleichsfahrt über die Scrollposition, und zwar für
   * BEIDE Bewegungen — neue Nachricht wie Tastatur. Der alte Weg sprang erst
   * auf einen Versatz und fuhr zurück; das lief über zwei Stränge (Befehl an
   * die native Liste, Ereignis zurück) und ist genau dort auseinandergelaufen:
   * Blieb das Ereignis aus, blieb der von Hand gesetzte Wert stehen und die
   * Tiefe rechnete dauerhaft daneben. Ein Transform hat diesen Rückkanal nicht.
   *
   * Wie weit verschoben wurde, muss dabei nicht geraten werden: Es ist die
   * Änderung der gemeldeten INHALTSHÖHE. Das gilt in jedem Fall, weil
   * `flexGrow: 1` genau den freien Platz aufzehrt — bei kurzen Unterhaltungen
   * bleibt sie gleich (dort bewegt sich auch nichts), bei langen wächst sie um
   * die volle Strecke, dazwischen um genau den Rest.
   */
  /**
   * Wie weit der Stapel noch Luft nach unten hat — die einzige Zahl, die die
   * Tastatur-Bewegung braucht.
   *
   * Die neueste Zeile liegt bei `unterer Abstand + freier Platz`. Der Abstand
   * ist bekannt und ohne die Tastatur jetzt konstant; was übrig bleibt, ist
   * der Freiraum. Solange die Tastatur weniger verdeckt als er, muss sich
   * nichts bewegen — genau das gewünschte Verhalten bei kurzen Unterhaltungen.
   * Darüber hinaus wird um den Rest gehoben, bildgenau an derselben Zahl wie
   * die Leiste.
   */
  const firstY = useSharedValue(0);
  const padBottomSV = useSharedValue(0);
  /**
   * Beide Zahlen MÜSSEN aus demselben Bild stammen — hier lag der Ruckler beim
   * Absenden.
   *
   * `free` ist die Differenz aus beiden. Der Abstand wurde bisher beim
   * Übernehmen geschrieben (also sofort), die Lage der obersten Zeile kommt
   * aber aus deren Messung, also mindestens ein Bild später. Beim Absenden
   * springt das mehrzeilige Feld auf eine Zeile zurück — der Abstand schrumpft
   * um bis zu 66 Punkt, die Lage folgt erst danach. Für genau ein Bild ist
   * `free` deshalb um diesen Betrag zu groß, und daran hängt über `kbLift` →
   * `slideShift` die Hülle um die GANZE Liste: Der Stapel rutscht ein Bild
   * lang herunter und im nächsten zurück.
   *
   * Dass es nur „gelegentlich" auftrat, passt genau: Beim WACHSEN des Feldes
   * wird die Differenz negativ und von `max(0, …)` aufgefangen. Nur die
   * Schrumpf-Richtung glitcht — und die gibt es ausschließlich beim Absenden
   * einer umgebrochenen Nachricht.
   *
   * Also wird der Abstand dort geschrieben, wo auch die Lage herkommt: im Maß
   * der obersten Zeile. Ändert sich der Abstand, ändert sich der Innenabstand
   * des Inhalts, und damit misst diese Zeile ohnehin neu.
   */
  const padBottomRef = useRef(contentPaddingBottom);
  padBottomRef.current = contentPaddingBottom;
  const kbLift = useDerivedValue(() => {
    const free = Math.max(0, firstY.value - padBottomSV.value);
    return Math.max(0, kbShift.value - free);
  });

  /**
   * Kein Rückhalt mehr für neue Nachrichten — die Bewegung wird umgedreht.
   *
   * Der Rückhalt musste auf ein LAYOUT-Ereignis warten: Wie hoch eine neue
   * Blase wird, weiß erst das Layout. Bis die Meldung durch JS zurück auf den
   * UI-Strang gelaufen war, stand mindestens ein Bild mit der neuen Lage schon
   * auf dem Schirm. Ist der Strang gerade frei, landet alles im selben Bild und
   * es sieht sauber aus; ist er beschäftigt — und beim Absenden ist er das —
   * sieht man hoch, zurück, gleiten. Genau das „manchmal abrupt".
   *
   * Dieses Rennen kann man nicht gewinnen, nur vermeiden. Also bewegt sich der
   * bestehende Stapel gar nicht mehr animiert: Er rückt in einem Schritt, so
   * wie es jede Chat-App macht und wie es niemandem auffällt. Was auffällt, ist
   * die NEUE Nachricht — und die zieht jetzt von unten ein. Ihre eigene Höhe
   * kennt sie aus ihrer ersten Messung, und weil sie bis dahin unsichtbar ist,
   * gibt es kein Bild, in dem etwas an der falschen Stelle steht.
   */
  /**
   * Als einfacher Merker, NICHT als geteilter Wert.
   *
   * Gelesen wird er ausschließlich aus JS (in `handleLayout`), geschrieben
   * ebenso. Ein `.value`-Lesezugriff von dort ist bei Reanimated 4 aber ein
   * synchroner Sprung in die UI-Laufzeit, der beide Stränge gegeneinander
   * sperrt — und er lag beim ersten Maß JEDER Zeile, beim Öffnen mit vollem
   * Verlauf also dutzendfach mitten in der Einfahrt. Für einen Wert, den die
   * UI-Seite nie anfasst, ist das reiner Verlust.
   */
  const allowEnter = useRef(false);
  const slideShift = useDerivedValue(() => -kbLift.value);

  const threadScrollY = useSharedValue(0);
  const onThreadScroll = useAnimatedScrollHandler((e) => {
    threadScrollY.value = e.contentOffset.y;
  });
  // KEINE Reaktion mehr auf „steht die Liste unten": Der Merker hing an der
  // Ausgleichsbewegung, und die gibt es nicht mehr. Stehengeblieben wäre er ein
  // Worklet, das bei JEDEM Scroll-Bild läuft und einen Wert schreibt, den
  // niemand liest.



  /** Inhaltshöhe mitführen — nur noch für die Bedarfs-Prüfung oben. */
  /**
   * Füllt der Stapel die Liste? Steuert den Zuschlag am oberen Ende.
   *
   * Aus BEIDEN Messungen bestimmt, denn welche zuerst eintrifft, ist nicht
   * gesagt. Stünde es nur in der Inhalts-Meldung, wäre die Listenhöhe dort
   * womöglich noch null — dann käme „füllt" heraus, und weil sich die
   * Inhaltshöhe bei einer kurzen Unterhaltung danach nie wieder ändert, bliebe
   * es dabei. Der Zuschlag zöge dann den freien Platz auf und schöbe die
   * Unterhaltung hinter die Tastatur: genau das, wogegen die Prüfung da ist.
   */
  /**
   * Während der Einfahrt gemerkt, nicht geschaltet.
   *
   * Der Merker hängt am Innenabstand des Listeninhalts. Bei langem Verlauf
   * kippt er beim Aufbau zwangsläufig von falsch auf wahr — und das ist ein
   * neues Stil-Objekt, ein neuer Listen-Baum und ein Yoga-Durchgang, mitten in
   * der Bewegung. Nachgeholt wird er, sobald sie durch ist; zu sehen ist davon
   * nichts, denn er betrifft nur den Abstand am oberen Rand.
   */
  const flowingPendingRef = useRef<boolean | null>(null);
  const enteringRef = useRef(true);
  const updateFlowing = useCallback((contentH: number, listHeight: number) => {
    if (listHeight === 0 || contentH === 0) return;
    const isFlowing = contentH > listHeight + 1;
    if (isFlowing === flowingRef.current) return;
    flowingRef.current = isFlowing;
    if (enteringRef.current) {
      flowingPendingRef.current = isFlowing;
      return;
    }
    setFlowing(isFlowing);
  }, []);

  /**
   * Die Inhaltshöhe mitführen — mehr passiert hier nicht mehr.
   *
   * Hier hing früher die Ausgleichsbewegung für neue Nachrichten. Sie ist
   * ersatzlos weg: Als Reaktion auf ein Layout-Ereignis kam sie zwangsläufig zu
   * spät (siehe `allowEnter`). Geblieben ist die Buchführung — die Höhe für den
   * Vergleich mit der Listenhöhe, und daraus der Zuschlag am oberen Ende.
   */
  const onThreadContentSize = useCallback(
    (_w: number, h: number) => {
      contentHRef.current = h;
      updateFlowing(h, listHRef.current);
    },
    [updateFlowing],
  );


  const threadHeight = useSharedValue(0);
  const onThreadLayout = useCallback(
    (e: LayoutChangeEvent) => {
      threadHeight.value = e.nativeEvent.layout.height;
      listHRef.current = e.nativeEvent.layout.height;
      // Auch hier: Welche der beiden Messungen zuerst eintrifft, ist nicht
      // gesagt — siehe `updateFlowing`.
      updateFlowing(contentHRef.current, e.nativeEvent.layout.height);
    },
    [threadHeight, updateFlowing],
  );



  // Einmal erzeugen — eine neue Kennung würde jede Zelle neu aufbauen.
  /**
   * Der Bezugspunkt für die Tiefen-Messung: die Oberkante der Liste.
   *
   * Gemessen wird gegen diese Hülle, nicht gegen das Fenster. Beide — Hülle und
   * Zeile — hängen an denselben Transformationen (Parkposition des Bildschirms,
   * Hub über der Tastatur), und in der Differenz kürzen die sich heraus. Ein
   * Fensterbezug würde dagegen bei jeder Parkbewegung mitwandern.
   *
   * Dieselben Auslöser wie in den Zellen, damit der Wert im selben Durchgang
   * frisch ist, in dem die Zeilen ihn lesen.
   */
  const threadWrapRef = useAnimatedRef<View>();
  const threadTopY = useDerivedValue(() => {
    threadScrollY.value;
    threadHeight.value;
    slideShift.value;
    const m = safeMeasure(threadWrapRef);
    // NaN heißt „nicht messbar" — die Zellen fallen dann auf die Rechnung
    // zurück. Null wäre eine gültige Lage und würde stumm falsch rechnen.
    return m === null ? NaN : m.pageY;
  });

  const RecedingCell = useMemo(
    () =>
      makeRecedingCell(
        threadScrollY,
        threadHeight,
        slideShift,
        threadTopY,
        firstY,
        padBottomSV,
        padBottomRef,
        allowEnter,
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [threadScrollY, threadHeight, slideShift, threadTopY, firstY, padBottomSV, allowEnter],
  );

  /**
   * Nach dem Einfügen weich ans untere Ende scrollen.
   *
   * Das ist die Bewegung, die vorher ein Sprung war. Sie läuft nativ, dauert
   * ihre eigene Zeit und erzeugt dabei fortlaufende Scrollmeldungen — genau
   * daran hängt der Tiefeneffekt. Die Nachrichten werden also KLEINER, WÄHREND
   * sie nach oben wandern, statt erst zu springen und dann zu schrumpfen.
   *
   * Nur bei geänderter Anzahl: Während einer Antwort wächst die letzte Blase
   * fortlaufend, und die hält die Verankerung oben ohnehin ruhig.
   */
  const keyExtractor = useCallback((m: Msg) => m.id, []);
  const renderItem = useCallback(
    ({ item }: ListRenderItemInfo<Msg>) => (
      <Bubble
        msg={item}
        accent={accent.solid}
        onRetry={onBubbleRetry}
        onOpenResults={onOpenResults}
        t={t}
      />
    ),
    [accent.solid, onBubbleRetry, onOpenResults, t],
  );

  /**
   * Die Slide von rechts — dieselbe wie zur Ergebnisliste und zu den
   * Profil-Unterseiten.
   *
   * Angestoßen wird sie unten, ein Bild nach dem ersten Zeichnen — die
   * Begründung steht dort. Hier wird der Wert nur abgelesen.
   *
   * Bis dahin steht der Bildschirm auf 0, also eine volle Höhe unter dem Bild.
   * Das ist zugleich der Notausgang für den Fall, dass jemand direkt hier
   * landet (Verknüpfung, Wiederherstellung): Auch dann stößt der Haken unten
   * an, sonst bliebe der Bildschirm für immer neben dem Sichtfeld stehen.
   */
  /**
   * Die Tastatur-Verschiebung liegt auf EINEM Knoten, nicht auf jeder Zeile.
   *
   * Sie ist für alle Zeilen dieselbe Zahl — trotzdem stand sie im Stil JEDER
   * gemounteten Zeile. Und ein Stil, der ein `transform`-Array zurückgibt, gilt
   * bei Reanimated immer als geändert (der Vergleich ist flach, das Array ist
   * jedes Mal neu). Pro Bild der Tastatur ging damit ein nativer Schreibvorgang
   * an jede Zeile hinaus — bei zwanzig gemounteten Zeilen zwanzig statt einem,
   * und das ist genau das „die Tastatur wird mit jeder Nachricht zäher".
   *
   * Geklammert wird die Liste von einem Kasten, der STEHEN BLEIBT und schneidet.
   * Damit bewegt sich innen genau das, was sich vorher bewegt hat, und der
   * sichtbare Ausschnitt bleibt derselbe — es ist Bild für Bild dasselbe
   * Ergebnis, nur mit einem Schreibvorgang statt zwanzig.
   *
   * In der Tiefen-Rechnung (`progress`) bleibt die Zahl drin: Dort geht es
   * darum, wo eine Zeile AUF DEM SCHIRM steht, und das ändert die Verschiebung
   * weiterhin.
   */
  const threadShiftStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: slideShift.value }],
  }));


  const slideStyle = useAnimatedStyle(() => {
    const p = pushProgress(assistantPush.value);
    /**
     * NUR der Transform — und genau das ist der Unterschied zum Such-Blatt.
     *
     * Hier stand zusätzlich `elevation` in jedem Bild. Seit die führende Kante
     * abgeschaltet ist (`SLIDE_LIFT = 0`), war der Wert konstant null — der
     * Zweig also tot, geschrieben wurde er trotzdem.
     *
     * Und das ist nicht gratis: Reanimated vergleicht den zurückgegebenen Stil
     * flach. `transform` ist bei jeder Auswertung ein FRISCHES Array, gilt also
     * immer als geändert — und damit wird das ganze Objekt nativ geschrieben,
     * `elevation` eingeschlossen. Eine Höhe zu setzen fasst auf Android die
     * Kontur der Ansicht an (`invalidateOutline`), und das zieht ein Neuzeichnen
     * nach sich. Fünfzig Mal während der Fahrt, auf einer bildschirmfüllenden
     * Fläche.
     *
     * Das Such-Blatt gibt ausschließlich `transform` zurück — und genau seine
     * Fahrt ist die, die sich glatt anfühlt. Bo war der einzige Push der App mit
     * einer zweiten Eigenschaft im Bild-Takt.
     *
     * Kommt die Kante zurück, gehört `elevation` NICHT hierher, sondern in einen
     * Stil, der nur beim Wechsel von "steht" auf "fährt" neu gesetzt wird.
     */
    return { transform: [{ translateX: (1 - p) * PARK_X }] };
  });

  /**
   * Das Stil-ARRAY einmal, nicht nur die Objekte darin.
   *
   * Die inneren Objekte waren längst memoisiert, das Array darum herum nicht —
   * damit wechselte die Prop-Kennung auf dem animierten Knoten trotzdem bei
   * jedem Durchgang. Dieselbe halbe Sache steckte in Tab-Leiste und
   * `SlidingPanels` und ist dort schon behoben.
   */
  const rootStyle = useMemo(
    () => [
        styles.root,
        /**
         * Runde Ecken wie bei jeder anderen Slide — plus der Schatten, ohne den
         * man sie nicht sehen KANN.
         *
         * Der Radius war schon gesetzt und tat auch, was er soll. Sichtbar wurde
         * er trotzdem nicht: Bos Hintergrund ist exakt derselbe Wert wie der des
         * Landingscreens darunter (beide `palette.bg`), die Aussparung in der
         * Ecke gab also dieselbe Farbe frei, die dort ohnehin schon lag. Eine
         * unsichtbare Kante ist von einer eckigen nicht zu unterscheiden.
         *
         * Genau dafür tragen die anderen Überlagerungen `elevation` — bei
         * `DetailsOverlay` steht die Begründung ausführlich daneben, samt der
         * Falle, dass der Hintergrund dabei PFLICHT ist: Ohne ihn berechnet
         * Android die Schatten-Kontur aus den eckigen Grenzen und füllt die runde
         * Aussparung wieder mit einem dunklen Quadrat.
         */
        screenShellStyle,
        slideStyle,],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [screenShellStyle, slideStyle],
  );
  /**
   * Die Fahrt läuft SCHON, wenn dieser Bildschirm zum ersten Mal zeichnet.
   *
   * Angestoßen wird sie im Tipp-Handler des Landingscreens — genau wie bei
   * jedem anderen Push der App (Ergebnisliste, Detail-Blatt, Ticket-Blatt,
   * Profil-Unterschirm). Der Bildschirm baut sich also WÄHREND der Bewegung
   * auf, und das ist hier die richtige Reihenfolge.
   *
   * Ich hatte es zwischenzeitlich umgedreht — erst mounten, dann fahren — um
   * den Aufbau aus der Bewegung herauszuhalten. Das hat den Aufbau nicht
   * billiger gemacht, sondern nur nach VORNE verschoben: Zwischen Fingerdruck
   * und erster Bewegung lag dann die komplette Erstellung des Bildschirms,
   * inklusive fünfzehn Nachrichten-Zeilen mit Ergebniskarten. Genau das ist als
   * Eingabe-Verzug zu spüren, und es wird mit dem Gewicht des Verlaufs
   * schlimmer — also dasselbe Problem, nur an einer Stelle, an der es sich
   * schlechter anfühlt.
   *
   * Der Hebel ist nicht die Reihenfolge, sondern die MENGE: Was in der
   * Bewegung entsteht, muss klein sein. Dafür sorgen die Listen-Parameter
   * weiter unten (`entering`), und der Rest rückt nach, wenn die Fahrt durch
   * ist.
   *
   * Der Haken hier bleibt als Notausgang: Wer über eine Verknüpfung direkt
   * hier landet, hat keinen Tipp-Handler durchlaufen — ohne ihn stünde der
   * Bildschirm für immer neben dem Sichtfeld.
   */
  useEffect(() => {
    // Über ein Modul-Flag, NICHT über `assistantPush.value`. Ein Lesezugriff aus
    // React ist ein synchroner Sprung in die UI-Laufzeit, der beide Stränge
    // gegeneinander sperrt — und dieser hier lag mitten in Bos laufender Kurve.
    // Die beiden anderen Bewegungen haben ihr Gegenstück längst.
    // Sofort, ohne Bild-Vorlauf: Normalerweise läuft die Kurve längst (der
    // Tipp-Handler hat sie gestartet), und dieser Zweig greift nur beim
    // Direkteinstieg. Dort auf ein Bild zu warten, verzögert nur.
    // NUR wenn wirklich geöffnet wird. Beim reinen Vorbereiten (Finger liegt
    // auf der Suchleiste, Bo ist geparkt) darf sich nichts bewegen.
    if (!isFocused) return;
    /**
     * EIN BILD SPÄTER — sonst hebt dieser Notausgang die Staffelung auf, die er
     * gar nicht betrifft.
     *
     * Der Tipp-Handler im Landingscreen staffelt bewusst: erst der
     * Speicher-Schreibvorgang, dann EIN BILD SPÄTER die Kurve. Die Begründung
     * steht dort ausführlich — der schwere Neu-Durchlauf dieses Bildschirms soll
     * VOR der Bewegung liegen, nicht in ihrem zweiten Bild („als müsse sich die
     * Bewegung einen Ruck geben").
     *
     * Genau das lief hier ins Leere. Ein passiver Effekt wird in React Native
     * über die Aufgaben-Warteschlange eingeplant, ein `requestAnimationFrame`
     * über den Bild-Takt — der Effekt gewinnt das Rennen typischerweise. Er
     * startete die Kurve also im SELBEN Bild wie der Commit, und der rAF des
     * Tipp-Handlers fand sie danach bereits laufend vor und tat nichts mehr.
     * Die Staffelung war damit still ausgehebelt, obwohl beide Stellen sie
     * beschreiben.
     *
     * Das Such-Blatt hat denselben Notausgang — und es legt ihn in einen rAF.
     * Genau dieser Unterschied bleibt sonst übrig, wenn man alles andere
     * angeglichen hat.
     *
     * Gebraucht wird der Ausgang nur für Wege OHNE Tipp-Handler
     * (Verknüpfung, Wiederherstellung, Sprachbefehl); dort kostet ein Bild
     * nichts.
     */
    let startRaf: number | null = requestAnimationFrame(() => {
      startRaf = null;
      if (!isAssistantPushStarted()) startAssistantPush();
    });
    return () => {
      if (startRaf !== null) {
        cancelAnimationFrame(startRaf);
        startRaf = null;
      }
      // Beim Verschwinden zurücksetzen — ohne Animation, der Bildschirm ist ja
      // weg. Sonst bliebe der Landingscreen darunter für immer um seine
      // Parallax-Strecke verschoben, wenn Bo je auf einem anderen Weg als über
      // `closeScreen` verlassen wird (Verknüpfung, Wiederherstellung).
      resetAssistantPush();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isFocused]);

  /**
   * Bo steht still, solange der Bildschirm fährt.
   *
   * Seine Bewegungen sind animierte SVG-Eigenschaften, und die machen die ganze
   * Fläche ungültig — jedes Bild neu gerastert, genau während die Slide jedes
   * Bild braucht. Ein GPU-Puffer über die Fläche hilft hier ausdrücklich NICHT,
   * sondern schadet: Er müsste wegen derselben Animation ohnehin jedes Bild neu
   * hochgeladen werden. Also die Ursache anhalten statt das Ergebnis puffern.
   */
  /**
   * KEINE Zustandsgröße mehr — Begründung samt Messwerten bei `setBoBlocked`.
   *
   * Der Wert lebt in einer Ablage und wird über den Verteiler bekanntgegeben.
   * `isFocused` und `isScrolling` bleiben Zustand (sie haben andere Aufgaben);
   * ändern sie sich, wird die Sperre unten im Effekt neu berechnet.
   */
  const slidingRef = useRef(true);
  const isScrollingRef = useRef(isScrolling);
  isScrollingRef.current = isScrolling;
  /**
   * Die Sprachleiste hängt an derselben Sperre — abonniert aber NUR, solange
   * sie sichtbar ist. Im Normalfall (Text-Eingabe) gibt es damit kein
   * Abonnement und keinen Durchgang.
   */
  const [voiceBarPaused, setVoiceBarPaused] = useState(true);
  useEffect(() => {
    if (!voiceMode) return;
    return subscribeBoBlocked(setVoiceBarPaused);
  }, [voiceMode]);
  const publishPause = useCallback(() => {
    const blocked = slidingRef.current || !isFocusedRef.current;
    setDotsPaused(blocked);
    setBoBlocked(blocked || isScrollingRef.current);
  }, []);
  const setSliding = useCallback(
    (v: boolean) => {
      if (slidingRef.current === v) return;
      slidingRef.current = v;
      publishPause();
    },
    [publishPause],
  );
  /**
   * Für die Ausfahrt die ganze Fläche einmal in eine GPU-Textur legen.
   *
   * Sonst zeichnet Android bei jedem Bild der Fahrt sämtliche Kinder neu — bei
   * vollem Verlauf sind das Dutzende Textblöcke und Karten. Als Textur wird
   * nur noch geschoben.
   *
   * Für die EINfahrt taugt das nicht: Dort baut sich der Baum gerade erst auf,
   * die Textur wäre sofort wieder ungültig und müsste neu hochgeladen werden.
   * Beim Schließen steht der Inhalt fest, und Bo ist ohnehin angehalten.
   */
  /**
   * Getrennt von `sliding`: nur die EINFAHRT verkleinert die gehaltene Strecke.
   *
   * `sliding` gilt für beide Richtungen — Bo soll in beiden stillstehen. An
   * derselben Zahl hing aber auch, wie viel die Liste gemountet hält, und das
   * war beim Schließen genau verkehrt: Der Wert fällt von 5 auf 1, die Liste
   * baut im selben Moment einen Schwung Zeilen ab, und dieses Abbauen läuft auf
   * dem UI-Strang — dort, wo gerade die Ausfahrt jedes Bild braucht. Genau
   * deshalb ruckelt das Schließen bei vollem Verlauf, während das Öffnen läuft.
   *
   * Beim Öffnen ist das Verkleinern richtig: Dort ist noch nichts gebaut, es
   * wird also weniger AUFgebaut. Beim Schließen gibt es nichts zu gewinnen —
   * der Bildschirm verschwindet ohnehin.
   */

  /**
   * Die Tipp-Punkte an dieselbe Sperre hängen wie Bo.
   *
   * Sie sind der einzige weitere Dauerläufer in diesem Baum, und die
   * ausführliche Begründung steht bei `setDotsPaused`. Zwei Fälle:
   *
   *  • `sliding` — während der Fahrt. Die Textur der Ausfahrt liegt über diesem
   *    Baum, und was sich darunter bewegt, macht sie in jedem Bild ungültig.
   *  • `!isFocused` — Bo liegt hinter der Ergebnisliste. Dort liefen die Punkte
   *    unsichtbar weiter und kosteten trotzdem in jedem Bild UI-Zeit, auch
   *    während DEREN Bewegungen.
   */
  useEffect(() => {
    publishPause();
  }, [isFocused, isScrolling, publishPause]);

  const enterTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const windowTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Netz für den Fall, dass die Einfahrt nie ankommt — siehe unten. */
  const safetyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /**
   * `entering` WIEDER scharf stellen, sobald Bo den Vordergrund verliert.
   *
   * Der Merker war ein Einweg-Riegel: einmal auf falsch, blieb er es für die
   * ganze Lebensdauer des Bildschirms. Bo wird aber nicht nur ab- und wieder
   * aufgebaut — er BLEIBT stehen, wenn er selbst die Ergebnisliste öffnet
   * („Alle Treffer anzeigen"). `isFocused` fällt dort auf falsch, der Baum
   * bleibt. Kommt der Nutzer zurück, läuft dieselbe Einfahrt noch einmal — nur
   * mit `entering === false`.
   *
   * Und das ist der teure Unterschied. Mit dem Merker kennt die Liste während
   * der Fahrt fünf Einträge, hält eine Bildschirmhöhe und taktet alles Weitere
   * hinter die Bewegung. Ohne ihn sind es zwölf Einträge, fünf Bildschirmhöhen
   * und der Eil-Pfad der Virtualisierung, der mitten in der Fahrt synchron
   * nachrendert. Jede dieser Zeilen bringt zwei Reanimated-Zuordnungen mit, und
   * jede neue Zuordnung wirft die sortierte Reihenfolge ALLER Zuordnungen weg.
   * Genau deshalb wurde diese Einfahrt mit jeder Nachricht schlechter, während
   * die erste nach dem Aufbau sauber lief.
   *
   * MIT ABSTAND, nicht sofort: Das Verkleinern baut Zeilen ab, und das läuft auf
   * dem UI-Strang. Im Moment des Fokus-Verlusts fährt gerade die Ergebnisliste
   * herein — dort gehört es nicht hinein. Eine Fahrtlänge später steht alles,
   * und Bo ist ohnehin verdeckt: Zu sehen ist von der Umstellung nichts.
   */

  useEffect(() => {
    if (isFocused) return;
    /**
     * AUCH beim Schließen — und das ist seit dem verzögerten Abbau der Punkt.
     *
     * Hier stand ein Ausstieg für den Schließ-Fall, begründet damit, dass der
     * Baum ohnehin gleich verschwindet. Das stimmte, solange er 300ms später
     * abgebaut wurde. Inzwischen wartet der Abbau auf eine echte Lücke (siehe
     * `AssistantHost`) — und dann ist es genau umgekehrt richtig: Erst den
     * Verlauf auf fünf Zeilen zurückräumen, DANN abbauen. Jede gemountete Zeile
     * bringt zwei Reanimated-Zuordnungen mit, und deren Entfernen verwirft die
     * sortierte Reihenfolge aller Zuordnungen der App. Ein kleiner Baum ist
     * billiger abzubauen als ein großer.
     */
    let id: ReturnType<typeof setTimeout>;
    const attempt = () => {
      /**
       * Und auch das wartet auf eine Lücke.
       *
       * Es ist ein Commit, und er fällt in ein Fenster, in dem der Nutzer
       * typischerweise schon das Nächste geöffnet hat. Ungeprüft landete er
       * dann in DESSEN Fahrt — dieselbe Falle wie beim Abbau, nur eine
       * Zehntelsekunde früher.
       */
      if (isTransitionBusy()) {
        id = setTimeout(attempt, 200);
        return;
      }
      enteringRef.current = true;
      setEntering(true);
      // Bo hält dabei ebenfalls wieder an — die nächste Einfahrt soll ihn
      // stillstehend antreffen, so wie die erste.
      setSliding(true);
    };
    id = setTimeout(attempt, ASSISTANT_IN.duration + 200);
    return () => clearTimeout(id);
  }, [isFocused]);
  useEffect(() => {
    /**
     * Die Wecker hängen am ÖFFNEN, nicht am Aufbau.
     *
     * Seit der Bildschirm schon beim Berühren der Suchleiste aufgebaut wird
     * (geparkt, unsichtbar), sind das zwei verschiedene Zeitpunkte. Liefen sie
     * beim Aufbau los, wäre die Einfahrt vorbei, bevor sie überhaupt beginnt —
     * die Liste stünde dann schon voll da und Bo liefe, während die Fahrt noch
     * ansteht.
     */
    if (!isFocused) return;
    /**
     * Ein noch laufendes Schließen ABBRECHEN — hier liegt der Unterschied zum
     * Such-Blatt, nach dem du gefragt hast.
     *
     * Das Such-Blatt hat gar keinen Schließ-Vorgang, den man unterbrechen
     * könnte: Sein Zustand ist EIN Speicherfeld, das beim Schließen sofort
     * fällt und beim Öffnen sofort wieder steht. Der Effekt dort reagiert auf
     * beide Richtungen gleich, ein Wechsel mittendrin ist schlicht der nächste
     * Wechsel dieses Feldes.
     *
     * Bo schließt dagegen in einer FOLGE, die über eine halbe Sekunde läuft:
     * Riegel setzen, Textur an, Bo anhalten, ein Bild warten, Kurve, und ganz
     * am Ende ein Wecker, der den Baum abbaut. Nichts davon war rücknehmbar.
     * Wer in diesem Fenster wieder öffnete, bekam:
     *
     *   • den Abbau-Wecker mitten in die Einfahrt (Bo fährt herein und ist
     *     sofort wieder weg — das ist das sichtbar „Buggy"),
     *   • `closingRef` dauerhaft gesetzt, das X und die Zurück-Geste also tot,
     *   • `sliding` dauerhaft gesetzt, Bo blieb also eingefroren,
     *   • und die eingefrorene Tastatur-Zahl, die nie wieder auftaute.
     *
     * Alles davon wird hier zurückgenommen. Der Auslöser ist der Zähler in den
     * Abhängigkeiten, nicht `isFocused` — siehe dort.
     */
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
    if (closeRafRef.current !== null) {
      cancelAnimationFrame(closeRafRef.current);
      closeRafRef.current = null;
    }
    closingRef.current = false;
    /**
     * Auch den Rücknahme-Wecker des Knopfes, sonst greift er MITTEN in die
     * Wieder-Einfahrt.
     *
     * `onPressOut` stellt ihn beim Loslassen auf 400ms — gedacht für den Fall,
     * dass aus dem Tipp doch kein Schließen wird. Nach einem abgebrochenen
     * Schließen fände er `closingRef` auf falsch und täte genau das, was er
     * soll: Textur weg, Bo wieder anlaufen lassen. Nur läge das jetzt rund
     * 300ms in der laufenden Einfahrt, und Bos Anlaufen bricht 15 Werte ab und
     * startet vier animierte SVG-Eigenschaften. Der Wecker am Ende der
     * Einfahrt erledigt beides ohnehin, an der richtigen Stelle.
     */
    if (disarmTimerRef.current) {
      clearTimeout(disarmTimerRef.current);
      disarmTimerRef.current = null;
    }
    /**
     * Die Tastatur-Zahl wieder AUFTAUEN.
     *
     * `closeScreen` friert sie ein, damit Leiste und Nachrichten während der
     * Ausfahrt nicht springen; zurückgesetzt wurde sie nie, weil der Baum
     * danach ohnehin verschwand. Sobald ein Schließen abgebrochen werden kann,
     * gilt das nicht mehr: Der Wert bliebe für den Rest der Sitzung auf dem
     * Stand von damals stehen, und die Tastatur bewegte danach nichts mehr.
     *
     * Auf dem UI-Strang geschrieben, wie schon beim Einfrieren — ein
     * Schreibzugriff aus React sperrt beide Stränge gegeneinander.
     */
    runOnUI(() => {
      "worklet";
      kbFreeze.value = -1;
    })();
    /**
     * Die gehaltene Strecke wächst ERST NACH der Einfahrt, mit Abstand.
     *
     * Sie sprang bisher genau zum Ablauf der Fahrt von 1 auf 5, und in diesem
     * Moment mountet die Liste einen Schwung Zeilen — bei vollem Verlauf
     * entsprechend viele. Das fällt ins letzte Stück der Bewegung, also
     * ausgerechnet dorthin, wo man einen Ruckler am ehesten sieht. Ein bisschen
     * Luft dahinter kostet nichts: Solange steht nur weniger im Voraus bereit.
     */
    /**
     * Und zwar SPÄTER als der Wecker darunter, nicht gleichzeitig.
     *
     * Beide standen zuletzt auf derselben Zahl — und beide sind teuer: Hier
     * wächst die gehaltene Strecke von einer auf fünf Bildschirmhöhen, die
     * Liste mountet also auf einen Schlag einen Schwung Zeilen, jede davon mit
     * zwei Reanimated-Zuordnungen. Und jede neue Zuordnung wirft die sortierte
     * Reihenfolge weg, die beim nächsten Bild komplett neu aufgebaut wird. Im
     * selben Bild lief zusätzlich Bo wieder an. Das ist der Ruckler AM ENDE der
     * Einfahrt, und er wird mit dem Verlauf schlimmer, weil mehr Zeilen
     * nachrücken.
     */
    /**
     * Beide Wecker hängen an der ANKUNFT der Kurve, nicht an einer Stoppuhr.
     *
     * Sie standen auf `ASSISTANT_IN.duration + x` — gemessen ab dem Moment, in
     * dem dieser Effekt lief. Das ist nicht derselbe Moment, in dem die Kurve
     * startet: Dazwischen liegen mindestens ein Bild Vorlauf und, bei Last,
     * deutlich mehr. Wird die Fahrt unterbrochen und läuft weiter, stimmt die
     * Rechnung ohnehin nicht mehr. Die Uhr lief also regelmäßig zu FRÜH ab, und
     * dann fiel das Nachrücken der Liste oder Bos Wiederanlauf in die letzten
     * Bilder der Bewegung.
     *
     * Der Abschluss-Rückruf der Kurve weiß genau, wann der Bildschirm steht.
     * Ab da gelten die beiden Abstände unverändert weiter — erst der Inhalt,
     * dann Bo, aus den Gründen, die an beiden Weckern stehen.
     */
    let armed = false;
    const arm = () => {
      if (armed) return;
      armed = true;
      startEntryTimers();
    };
    const startEntryTimers = () => {
    windowTimerRef.current = setTimeout(() => {
      windowTimerRef.current = null;
      if (closingRef.current) return;
      enteringRef.current = false;
      setEntering(false);
      if (flowingPendingRef.current !== null) {
        setFlowing(flowingPendingRef.current);
        flowingPendingRef.current = null;
      }
      /**
       * Dicht hinter das Kurvenende, nicht mehr weit dahinter.
       *
       * Hier standen 560ms, weil an dieser Stelle ein Schwung Zeilen nachrückt
       * und das nicht in die letzten Bilder fallen sollte. Seit die Liste
       * während der Fahrt nur fünf Einträge kennt (siehe `data`), ist das
       * Nachrücken aber zugleich das SICHTBARE Auffüllen der Fläche darüber —
       * eine halbe Sekunde später wäre es ein Nachklappen. 120ms reichen, um
       * aus der Bewegung heraus zu sein.
       */
    }, 120);
    enterTimerRef.current = setTimeout(() => {
      enterTimerRef.current = null;
      // Nicht mehr, wenn schon geschlossen wird: Sonst hebt genau dieser Wecker
      // mitten in der Ausfahrt die Sperre auf — Bo läuft wieder an und die
      // Liste mountet einen Schwung Zeilen. Bei einem Schließen kurz nach dem
      // Öffnen ist das nicht theoretisch.
      if (closingRef.current) return;
      setSliding(false);
      // Ab jetzt ziehen neu eintreffende Zeilen ein — vorher fährt der ganze
      // Bildschirm, da wäre es Bewegung in der Bewegung.
      allowEnter.current = true;
      /**
       * Dieselben 220ms Luft wie beim Wecker darüber.
       *
       * Er lag exakt auf dem Ende der Fahrt — und `setTimeout` ist nicht
       * bildgenau, traf also regelmäßig noch deren letzte Bilder. Was dort
       * losgeht, ist nicht wenig: Der ganze Bildschirm rendert neu, Bos Wirkung
       * bricht 15 Werte ab und startet rund zehn Endlos-Ketten, darunter vier
       * animierte SVG-Eigenschaften — und die machen die ganze Fläche ungültig.
       * Der Nachbar-Wecker hat seine Luft aus genau demselben Grund bekommen.
       */
      // Bo läuft NACH dem Nachfüllen wieder an, nicht dazwischen: Sein Start
      // bricht 15 Werte ab und startet rund zehn Endlos-Ketten, darunter vier
      // animierte SVG-Eigenschaften.
    }, 320);
    };

    setAssistantArrivedHandler(arm);
    /**
     * Notausgang: Kommt die Kurve nie an, muss es trotzdem weitergehen.
     *
     * Eine unterbrochene Bewegung meldet sich mit `finished === false` und ruft
     * den Verteiler gar nicht. Ohne dieses Netz bliebe die Liste dauerhaft auf
     * fünf Zeilen und Bo für immer angehalten. Großzügig bemessen — er soll nur
     * greifen, wenn wirklich etwas schiefging.
     */
    safetyTimerRef.current = setTimeout(arm, ASSISTANT_IN.duration + 600);
    return () => {
      if (enterTimerRef.current) clearTimeout(enterTimerRef.current);
      if (windowTimerRef.current) clearTimeout(windowTimerRef.current);
      if (safetyTimerRef.current) clearTimeout(safetyTimerRef.current);
      // Den Verteiler leeren — sonst liefe die Arbeit eines alten Durchgangs in
      // einen neuen hinein.
      setAssistantArrivedHandler(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isFocused, openSeq]);

  const onDragStart = useCallback(() => {
    if (scrollEndTimeoutRef.current) {
      clearTimeout(scrollEndTimeoutRef.current);
      scrollEndTimeoutRef.current = null;
    }
    setIsScrolling(true);
  }, []);
  const onDragStop = useCallback(() => {
    if (scrollEndTimeoutRef.current) clearTimeout(scrollEndTimeoutRef.current);
    scrollEndTimeoutRef.current = setTimeout(() => {
      setIsScrolling(false);
      scrollEndTimeoutRef.current = null;
    }, 120);
  }, []);
  const onMomentumStop = useCallback(() => setIsScrolling(false), []);

  /**
   * Die Liste EINMAL bauen und beim Tippen nicht anfassen.
   *
   * Jeder Tastendruck setzt den Eingabe-Zustand und rendert damit den ganzen
   * Bildschirm neu. Die Sprechblasen selbst sind gegen das Neurendern
   * abgesichert, die LISTE war es nicht: Vier ihrer Rückrufe wurden als
   * Pfeilfunktionen direkt im Element angelegt und waren damit bei jedem
   * Durchgang neu — die Liste sah lauter geänderte Eigenschaften und arbeitete
   * ihre gemounteten Zeilen jedes Mal durch. Das ist die Verzögerung beim
   * Schreiben, und sie wächst mit dem Verlauf.
   */
  const thread = useMemo(
    () => (
    <AnimatedThread
      ref={scrollRef}
      /**
       * WÄHREND der Fahrt nur die fünf neuesten — und das ist der Hebel gegen
       * „mit jeder Nachricht ruckeliger".
       *
       * `updateCellsBatchingPeriod={700}` weiter unten sollte das Nachrücken aus
       * der Fahrt heraushalten. Es tut das ab sechs Nachrichten NICHT:
       * `VirtualizedList` hat einen Eil-Pfad, der beim ersten Zellen-Maß prüft,
       * ob die unterste gerenderte Zelle noch INNERHALB des Fensters liegt — und
       * genau das ist beim Aufbau der Fall. Dann löscht er den Wecker und
       * rendert SYNCHRON nach, mitten in der Bewegung.
       *
       * Wie viel dabei entsteht, hängt an der Bildschirmhöhe geteilt durch die
       * mittlere Zeilenhöhe: bei kurzen Textblasen rund zehn Zeilen, bei
       * Ergebniskarten weniger. Zwischen fünf und zwölf Nachrichten verdoppelt
       * sich die Arbeit in der Fahrt also, darüber sättigt sie — exakt das
       * beschriebene Bild.
       *
       * Sind es nur fünf Einträge, ist die unterste GLEICH der letzten, der
       * Eil-Pfad kann gar nicht erst greifen, und in der Fahrt mounten genau
       * fünf Zellen — unabhängig davon, wie lang der Verlauf ist.
       *
       * Der Rest kommt, sobald die Bewegung steht (siehe den Wecker für
       * `entering`, jetzt dicht hinter dem Kurvenende). Er füllt die Fläche
       * OBEN, und dort zieht der Tiefen-Effekt ihn ohnehin auf 12% Deckkraft.
       */
      data={sliced ? enteringSlice : reversedMessages}
      keyExtractor={keyExtractor}
      renderItem={renderItem}
      inverted
      /**
       * ACHTUNG: HIER KEIN `getItemLayout` SETZEN.
       *
       * Die Liste reicht `onLayout` nur dann an ihre Zellen durch, wenn
       * `getItemLayout` fehlt (`VirtualizedList`: `shouldListenForLayout`).
       * Mit gesetztem `getItemLayout` bekäme die Zellen-Hülle nie ein Layout,
       * ihr Wächter bliebe auf falsch — und der Tiefeneffekt wäre lautlos weg.
       * Keine Warnung, kein Fehler, er fehlt einfach.
       */
      CellRendererComponent={RecedingCell}
      // Der Handler ist ein Worklet und wird nativ am Scroll-Knoten
      // angemeldet — `scrollEventThrottle` stand hier mit einer Begründung,
      // die nicht zutrifft: Auf Android wird die Eigenschaft ignoriert, und
      // die Liste setzt ohnehin ihren eigenen Wert.
      onScroll={onThreadScroll}
      onLayout={onThreadLayout}
      onContentSizeChange={onThreadContentSize}
      style={styles.thread}
      // Mit inverted: paddingTop ist visuell unten. contentPaddingBottom
      // reserviert dort Platz für Bar + Lift + Gap. Snap via React-State.
      contentContainerStyle={threadContentStyle}
      showsVerticalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
      removeClippedSubviews={false}
      /**
       * 5 statt 21 — und 11 wären wirkungslos gewesen.
       *
       * `windowSize` ist keine Zellen-Zahl, sondern eine STRECKE in
       * Bildschirmhöhen. Bei 11 fasst das Fenster rund 115 Zeilen; der
       * Verlauf ist aber auf 80 gedeckelt. Es waren also immer alle 80
       * gemountet — der Wechsel von 21 auf 11 hat exakt nichts gespart.
       *
       * Wirksam wird es erst bei 3 bis 5. Fünf Bildschirmhöhen sind gut zwei
       * nach oben und unten, also weiterhin Vorlauf gegen leere Flächen.
       */
      /**
       * Während der Einfahrt nur das Nötigste aufbauen.
       *
       * Das Ruckeln beim Hochsliden kam nicht von der Bewegung, sondern von
       * dem, was WÄHREND ihr entsteht: Bei vollem Verlauf baut die Liste im
       * ersten Bild ihre komplette Anfangs-Region auf — zehn Zeilen, darunter
       * Ergebnis-Karten mit Logos und Verläufen. Deren Einhängen läuft auf
       * demselben Strang wie die Kurve, und zwar genau in dem Moment, in dem
       * sie jedes Bild braucht.
       *
       * Die Strecke wird deshalb für die Dauer der Einfahrt auf eine
       * Bildschirmhöhe zusammengezogen und danach wieder geöffnet. Sichtbar
       * ist das nicht: Was fehlt, liegt oberhalb des Bildrands, und
       * Nachrücken bewegt nichts — die Liste hängt am unteren Ende.
       */
      windowSize={entering ? 1 : 5}
      /**
       * WÄHREND der Fahrt klein, danach groß.
       *
       * Die Zahl ist beides: die erste Region UND die Untergrenze, die dauerhaft
       * gemountet bleibt. Was hier steht, entsteht in den ersten Bildern der
       * Bewegung — fünfzehn Zeilen mit Ergebniskarten sind dort zu viel, und
       * ihr Gewicht wächst mit dem Verlauf.
       *
       * Fünf decken den unteren, sofort sichtbaren Teil ab; der Rest rückt nach,
       * wenn die Fahrt durch ist, und liegt oben — dort, wo der Tiefen-Effekt
       * ihn ohnehin auf 12% Deckkraft zieht.
       *
       * Den Eil-Pfad, der diese Zahl sonst überstimmen würde, sperrt der
       * gekürzte Datensatz oben aus (siehe `data`).
       *
       * `VirtualizedList` hat einen Eil-Pfad: Liegt die unterste gerenderte
       * Zelle noch INNERHALB des Fensters, rendert sie sofort und synchron
       * nach und übergeht den gedehnten Takt darunter komplett
       * (`_shouldRenderWithPriority`). Deckt der Anfangsbereich das Fenster
       * nicht, mountet die Liste also trotzdem mitten in der Fahrt weiter.
       * Erst wenn er darüber hinausreicht, greift der Takt.
       *
       */
      /**
       * Zwölf in BEIDEN Fällen — die Zahl muss zum gekürzten Datensatz passen.
       *
       * Der Eil-Pfad der Virtualisierung greift genau dann nicht, wenn die
       * unterste gerenderte Zelle die LETZTE des Datensatzes ist. Stünde hier
       * eine kleinere Zahl als die Länge des Ausschnitts, wäre er wieder offen
       * und würde mitten in der Fahrt synchron nachrendern.
       */
      initialNumToRender={12}
      maxToRenderPerBatch={6}
      /**
       * Und was danach noch fehlt, rückt erst NACH der Fahrt nach.
       *
       * Die Liste füllt ihr Fenster in Häppchen, standardmäßig alle 50ms — bei
       * einer 300ms-Fahrt also fünf- bis sechsmal mittendrin, jedes Mal mit
       * Rendern, Vermessen, nativem Einhängen und zwei Reanimated-Zuordnungen
       * pro Zeile. Während der Einfahrt wird der Takt deshalb so weit gedehnt,
       * dass nichts mehr hineinfällt; danach steht er wieder auf dem
       * Normalwert.
       */
      updateCellsBatchingPeriod={entering ? 700 : 50}
      onScrollBeginDrag={onDragStart}
      onScrollEndDrag={onDragStop}
      onMomentumScrollBegin={onDragStart}
      onMomentumScrollEnd={onMomentumStop}
    />
    ),
    [
      reversedMessages,
      keyExtractor,
      renderItem,
      RecedingCell,
      onThreadScroll,
      onThreadLayout,
      onThreadContentSize,
      threadContentStyle,
      entering,
      enteringSlice,
      onDragStart,
      onDragStop,
      onMomentumStop,
    ],
  );


  return (
    // Chat-Layout: FlatList full-height, Inputbar overlay'd absolut darüber.
    // Der letzte sichtbare Bubble wird über contentContainer.paddingBottom
    // geschützt → er steht immer über dem Inputbar, egal ob Keyboard auf
    // oder zu ist.
    <Animated.View
      style={rootStyle}
      /**
       * Textur für BEIDE Richtungen — die Einfahrt kann das jetzt auch.
       *
       * Hier stand nur `closing`, mit der ausdrücklichen Begründung, für die
       * Einfahrt tauge das nicht: Dort baue sich der Baum gerade erst auf, die
       * Textur wäre sofort wieder ungültig und müsste neu hochgeladen werden.
       * Das stimmte — solange die Kurve im Tipp-Handler losfuhr und der Aufbau
       * in sie hineinfiel.
       *
       * Und sie gilt weiterhin: Die Kurve startet im Tipp-Handler des
       * Landingscreens, dieser Bildschirm mountet also WÄHREND der Fahrt. Seine
       * ersten fünf Zeilen entstehen in den ersten Bildern — eine Ebene wäre
       * dort sofort wieder ungültig und damit teurer als keine.
       *
       * Für die AUSFAHRT ist es umgekehrt: Der Inhalt steht fest, Bo ist
       * angehalten, und ohne Ebene würden bei jedem Bild sämtliche Kinder neu
       * gezeichnet (im Projekt mit 14,7ms gegen ein Budget von 8,3ms vermessen).
       */
      /**
       * IMMER fangen, solange der Bildschirm da ist.
       *
       * Hier stand `closing ? "none" : "auto"` — genau verkehrt herum. Die
       * Absicht war richtig: Während der Ausfahrt gibt diese bildschirmfüllende
       * Wurzel den Landingscreen von links her frei, und ein Tipp auf dessen
       * Suchleiste startet Bo wieder — während die Doppeldruck-Sperre noch steht
       * und der Abbau-Wecker läuft. Er fährt dann herein und wird 500ms später
       * trotzdem abgebaut.
       *
       * Nur bewirkt `none` das GEGENTEIL: Es macht Bo für Berührungen
       * durchlässig, der Tipp erreicht den Landingscreen also erst recht.
       * Gebraucht wird das Fangen — und zwar über die ganze Ausfahrt, bis der
       * Baum wirklich weg ist.
       */
      /**
       * KEINE GPU-Ebene für die Ausfahrt — und das ist kein Kompromiss.
       *
       * Hier lag eine, mit der Begründung, der Baum werde beim Wandern sonst in
       * jedem Bild neu gezeichnet. Diese Annahme galt lange als gesetzt und ist
       * falsch: Android hält je Ansicht eine AUFGEZEICHNETE Zeichenliste, eine
       * Verschiebung ist eine Eigenschaft davon und löst keine Neuaufzeichnung
       * aus. Die vermessenen 14,7ms fallen erst an, wenn NACHFAHREN ungültig
       * werden — und Bos Inhalt steht während der Ausfahrt ausdrücklich still
       * (`sliding` hält das Maskottchen an, die Tipp-Punkte pausieren, der
       * Strom wird gestaut). Genau der Fall, in dem eine Ebene nichts einspart.
       *
       * Gekostet hat sie dagegen sicher: Text verliert in einer GPU-Ebene die
       * Subpixel-Glättung, weshalb Schriftzug und Maskottchen beim Aufsetzen
       * des Fingers sichtbar weich wurden. Der Aufbau der Ebene selbst liegt bei
       * gemessenen 66ms und fiel in dasselbe Berührungs-Bild. Und der Merker
       * dafür war ein React-Zustand — jedes Setzen und Zurücknehmen ein Commit
       * auf dem Bildschirm, der gleich fahren soll.
       *
       * Dieselbe Falle wie beim Landingscreen, wo dieselbe Annahme dieselbe
       * Maschinerie getragen hat. Wieder aufnehmen nur mit Messung am Gerät.
       */
    >
        {/* Slim Top-Bar: Binch-Logo links, Close-Button rechts. Da wir die
            FloatingTabBar im Chat verstecken, ist X der einzige Weg zurück
            (System-Back funktioniert nicht zwischen Tab-Geschwistern). */}
      <View style={[styles.topbar, { paddingTop: insets.top + TOPBAR_TOP }]}>
        {/* Dieselbe Komponente wie in allen anderen Tabs — nicht mehr ein
            nachgebauter Text. Die Zahlen waren zwar gleich, aber `lineHeight`
            fehlte, und genau das entscheidet hier über die Position. */}
        <ScreenHeading>
          B<Text style={{ color: accent.solid }}>i</Text>nch
        </ScreenHeading>
        {/* Die Statuszeile sitzt IN der Kopfzeile und senkrecht mittig zum
            Schriftzug — dafür absolut über die volle Breite gelegt und
            zentriert, statt sie zwischen Schriftzug und Knopf einzureihen
            (dort wäre sie von deren Breiten abhängig und nie wirklich mittig). */}
        <Text
          style={[
            styles.mood,
            // Deckungsgleich mit der Zeile des Schriftzugs: gleiche Oberkante,
            // gleiche Höhe. Damit liegt die Mitte beider exakt aufeinander,
            // unabhängig von den Schriftgrößen.
            /**
             * Das Kästchen ist die ZEILE selbst, nicht die Höhe des Schriftzugs.
             *
             * Vorher stand hier dessen volle Höhe, und mittig gesetzt wurde die
             * Zeile darin über `textAlignVertical` — das es nur auf Android
             * gibt. Auf iOS säße sie oben. Ein Kästchen in Zeilenhöhe, um die
             * halbe Differenz nach unten gerückt, trifft die Mitte überall,
             * ohne sich auf die Ausrichtung zu verlassen.
             */
            {
              top: insets.top + TOPBAR_TOP + (HEADING_LINE_HEIGHT - MOOD_LINE_H) / 2,
              height: MOOD_LINE_H,
            },
            mood === "error" && { color: C.error },
          ]}
          numberOfLines={1}
          pointerEvents="none"
        >
          {moodLabel.toUpperCase()}
        </Text>
        <Pressable
          onTouchStart={armClose}
          onPressIn={() => {
            chatInputRef.current?.blur();
            Keyboard.dismiss();
          }}
          onPressOut={disarmClose}
          onPress={closeScreen}
          hitSlop={10}
          style={closeBtnStyle}
          accessibilityLabel="Close"
        >
          <X size={20} color="#E5E7EB" strokeWidth={2} />
        </Pressable>
      </View>


      {/* Conversation-Thread — INVERTED FlatList. Das ist DAS Standard-Chat-
          Pattern (Discord, WhatsApp, Slack). Mechanik:
          - `inverted` flippt die Y-Axis: scroll-Y=0 ist visuell UNTEN
          - data wird reversed übergeben → neueste Nachricht steht bei
            index=0, also visuell IMMER am Bottom
          - Neue Messages werden bei index=0 prepended → erscheinen ohne
            jegliches scrollTo automatisch im sichtbaren Bottom-Bereich
          - contentContainerStyle.paddingBottom ist mit `inverted` visuell
            am Bottom (unter der neuesten Bubble) → reserviert Platz für
            Inputbar + Lift + Gap
          Damit ist ZERO scroll-Synchronisation nötig: die letzte Bubble
          steht IMMER über der Bar, weil sie strukturell dort hingerendert
          wird, nicht weil wir hin-scrollen müssen. */}
      {/* Steht still und schneidet — bewegt wird die Hülle darin. So bleibt der
          sichtbare Ausschnitt exakt der von vorher, als jede Zeile sich einzeln
          verschoben hat. */}
      <View style={styles.threadClip}>
        <Animated.View ref={threadWrapRef} style={[styles.threadFill, threadShiftStyle]}>
          {thread}
        </Animated.View>
      </View>

      {/* Bo + Mood-Label.
          `paused={!isFocused}` schaltet Bo's Reanimated-Worklets ab wenn der
          User auf einem anderen Tab ist. Ohne das laufen 5-8 endlose Repeats
          (Schweben, Blinzeln, ggf. Wink/Yap) auf der UI-Thread im Hinter-
          grund weiter — verlangsamt jeden anderen Tab spürbar. */}
      <View style={[styles.hero, { top: insets.top + HERO_TOP }]} pointerEvents="none">
        <BoGate state={mood} size={BO_SIZE} />
      </View>

      {/* Input-Bar Wrapper — absolut bei bottom:0, die Hochbewegung kommt
          frame-synced mit dem Keyboard via barAnimStyle (useAnimatedKeyboard,
          UI-Thread). onLayout misst die echte Bar-Höhe für die
          contentPaddingBottom-Berechnung. */}
      <Animated.View
        style={[styles.inputbarWrap, inputbarWrapStyle, barAnimStyle]}
        onLayout={(e) => {
          const h = e.nativeEvent.layout.height;
          /**
           * NICHT während der Fahrt — jeder Commit hält die Kurve an.
           *
           * Belegt in Reanimateds eigener Quelle: Kommt ein Commit von React,
           * klont der Commit-Hook den Shadow-Tree-Pfad für JEDEN animierten
           * Knoten der App und pausiert danach ausdrücklich Reanimateds eigene
           * Commits („if we didn't pause Reanimated commits, it could lead to
           * RN commits being delayed until the animation is finished"). Ein
           * `setState` mitten in der Einfahrt ist damit kein bisschen
           * Mehrarbeit, sondern eine PAUSE der Bewegung.
           *
           * Die Zahl selbst eilt nicht: Sie steuert nur den Innenabstand am
           * unteren Listenrand, und ihr Startwert wird gerechnet statt geraten
           * (siehe dort) — die Abweichung ist im Regelfall null.
           */
          if (Math.abs(h - inputbarHeight) <= 1) return;
          /**
           * Aufschieben heißt NACHHOLEN, nicht verwerfen.
           *
           * Der Wert wurde hier nur in eine Ablage geschrieben und nie wieder
           * angewandt — die Leisten-Höhe blieb also auf ihrem gerechneten
           * Startwert stehen, wenn die Messung zufällig in eine Fahrt fiel. An
           * ihr hängt der Abstand zwischen letzter Blase und Eingabeleiste.
           */
          if (isTransitionBusy()) {
            pendingBarHeightRef.current = h;
            if (barHeightTimerRef.current) return;
            const apply = () => {
              if (isTransitionBusy()) {
                barHeightTimerRef.current = setTimeout(apply, 200);
                return;
              }
              barHeightTimerRef.current = null;
              const pending = pendingBarHeightRef.current;
              pendingBarHeightRef.current = null;
              if (pending !== null) setInputbarHeight(pending);
            };
            barHeightTimerRef.current = setTimeout(apply, 200);
            return;
          }
          pendingBarHeightRef.current = null;
          setInputbarHeight(h);
        }}
      >
      {voiceMode ? (
        <VoiceRecordBar
          recording={listening}
          /**
           * Still, während etwas fährt — UND solange Bo nicht zu sehen ist.
           *
           * Hier stand nur `sliding`. Verliert Bo den Vordergrund, ohne
           * abgebaut zu werden — er öffnet die Ergebnisliste selbst, oder er
           * steht nach dem Schließen noch geparkt da —, lief der
           * Wellenform-Sampler im Bild-Takt weiter, unsichtbar, und damit auch
           * während FREMDER Bewegungen. Die Aufnahme selbst läuft weiter;
           * angehalten wird nur ihre Darstellung.
           */
          paused={voiceBarPaused}
          onPauseToggle={() => {
            if (listening) stopVoice();
            else void startVoice();
          }}
          onDelete={() => {
            if (listening) stopVoice();
            setInput("");
            setVoiceMode(false);
          }}
          onSend={() => {
            if (listening) {
              pendingSendRef.current = true;
              stopVoice();
            } else {
              const text = input.trim();
              setVoiceMode(false);
              if (text) send(text);
            }
          }}
          bottomInset={inputbarPadBottom}
          micVolumeSV={micVolumeSV}
        />
      ) : (
      <View style={[styles.inputbar, { backgroundColor: palette.s2, paddingBottom: inputbarPadBottom }]}>
        <View style={[styles.field, { backgroundColor: palette.s3 }]}>
          <TextInput
            ref={chatInputRef}
            value={input}
            onChangeText={setInput}
            placeholder={t("assistant.placeholder")}
            placeholderTextColor={C.textTertiary}
            style={styles.fieldText}
            multiline
            maxLength={500}
            // KEIN editable={!busy} — sonst dropt Android beim Stream den
            // Focus → keyboard closet → onBlur feuert → kbOffset auf 0 →
            // Bar springt runter mitten in Bo's Antwort. User soll während
            // des Streams die nächste Frage schon vortippen können (Send-
            // Button ist via canSend disabled, also kein versehentliches
            // Doppel-Senden).
            onSubmitEditing={() => send(input)}
            onFocus={onInputFocus}
            onBlur={onInputBlur}
            blurOnSubmit={false}
            returnKeyType="send"
          />
        </View>

        <Pressable
          style={[
            styles.iconBtn,
            { backgroundColor: C.surface3 },
            !voiceAvailable && { opacity: 0.4 },
          ]}
          disabled={!voiceAvailable}
          onPress={() => {
            haptic("button");
            // Keyboard zuerst dismissen — slidet runter, dann erscheint die
            // VoiceRecordBar an dessen Stelle. Ohne dismiss bliebe das
            // Keyboard offen und überlagerte die Bar.
            Keyboard.dismiss();
            setVoiceMode(true);
            void startVoice();
          }}
          accessibilityLabel="Voice"
        >
          <Mic size={20} color={C.white} strokeWidth={2} />
        </Pressable>

        <Pressable
          style={[
            styles.iconBtn,
            {
              backgroundColor: canSend ? accent.solid : C.surface3,
              opacity: canSend || busy ? 1 : 0.5,
            },
          ]}
          disabled={!canSend}
          onPress={() => send(input)}
          accessibilityLabel="Send"
        >
          {busy ? (
            <ActivityIndicator color={C.white} size="small" />
          ) : (
            <Send size={20} color={canSend ? accent.textOnSolid : C.white} strokeWidth={2} />
          )}
        </Pressable>
      </View>
      )}
      </Animated.View>
    </Animated.View>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Wie weit Bos Block in die Kopfzeile hineinragt.
 *
 * Ursprünglich 33 — dieser Wert galt Bos OBERKANTE, als er das erste Element
 * des Blocks war. Als die Statuszeile darüber rückte, zog derselbe Überhang die
 * ZEILE in die Kopfzeile.
 *
 * Inzwischen sitzt die Zeile ohnehin IN der Kopfzeile (mittig zum Schriftzug),
 * Bos Block enthält also nur noch ihn selbst. 23 = die vorherigen 8 plus die
 * 15, um die er höher sollte — minus 2, weil die Zeile ihn vorher um ihre
 * Resthöhe nach unten gedrückt hat. Danach nochmal 15 höher: 36.
 */
/**
 * Tiefeneffekt: Nachrichten kippen nach hinten weg, statt an einer Kante zu enden.
 *
 * Bo schwebt als Überlagerung über der Liste. Was nach oben läuft, wird kleiner
 * und dunkler — die Ansicht auf ein Rad von vorn: Was oben ist, dreht sich weg.
 *
 * # Warum die Lage GEMESSEN und nicht gemeldet wird
 *
 * Der naheliegende Weg ist `onLayout` pro Zelle. Er ist der Grund, warum dieser
 * Effekt sechs Anläufe gebraucht hat: `onLayout` meldet vom JS-Strang, und
 * genau beim Absenden einer Nachricht ist der mit dem React-Commit belegt. Die
 * Zeile stand dann schon an der neuen Stelle und trug noch die alte Größe —
 * sichtbar als zwei Schritte, erst nach oben, dann zur Mitte.
 *
 * `measure` läuft auf dem UI-Strang und liefert die Lage, die im GERADE
 * entstehenden Bild gilt. Position und Größe ändern sich damit im selben Bild.
 *
 * # Die drei Absicherungen, ohne die es abstürzt
 *
 * Ein erster Anlauf hat die App beendet. Aus dem Gerätelog:
 *
 *   CppException: Value is null, expected an Object
 *     at _measure (native) … at styleUpdater
 *
 * Reanimated prüft vor dem Messen auf `viewTag === -1` — die Prüfung der ALTEN
 * Architektur. Auf Fabric kommt ein Shadow-Node, der `null` sein kann, und der
 * geht ungeprüft an den nativen Teil.
 *
 *  1. `collapsable={false}`: Sonst zieht Android die reine Container-Ansicht
 *     flach, dann gibt es gar keinen Knoten zum Messen.
 *  2. Erst messen, wenn die Zelle nachweislich ein Layout hatte.
 *  3. Und trotzdem abfangen — ein Bild mit dem alten Wert ist besser als eine
 *     geschlossene App.
 *
 * # Was hier bewusst NICHT steht
 *
 * Keine Layout-Animation auf der Zelle: `inverted` spiegelt über eine
 * Skalierung mit -1, und eine Layout-Animation verschiebt über einen Transform
 * — unter einem gespiegelten Vorfahren kehrt sich deren Richtung um. Die Zeile
 * glitt von ihrem Ziel weg und schnappte zurück („alles fliegt").
 *
 * Und keine zweite Positionsquelle als Rückfall im laufenden Betrieb: Zwei
 * Quellen weichen voneinander ab, und jeder Wechsel ist genau ein Sprung. Der
 * Rückfall unten greift nur, solange NOCH NIE gemessen wurde.
 */

const HERO_PULL_UP = 46;
const BO_SIZE = 120;
/**
 * Zeilenhöhe der Statuszeile — FEST gesetzt, nicht geschätzt: Sonst bestimmt
 * Android sie aus der Schrift, und Bos Position wäre geräteabhängig.
 */
const MOOD_LINE_H = 14;
/** Bos Unterkante, gemessen ab der Oberkante der Liste. */
/**
 * Bos Unterkante, gemessen ab der Oberkante der Liste.
 *
 * Hier stand `BO_SIZE` als Höhe — das war falsch. `size` ist die BREITE; der
 * gezeichnete Körper reicht bis rund `size * 1.25`, der Rahmen samt Schatten
 * sogar bis `size * 1.62`. Mit 120 statt 150 waren die beabsichtigten 18 Punkte
 * Luft in Wahrheit 12 Punkte ÜBERLAPPUNG: Bos Kinn stand in der ersten Zeile
 * der obersten Nachricht, sein Boden-Schatten lag komplett darüber — und zwar
 * bei voller Deckkraft, also gut sichtbar.
 *
 * Bo meldet sein Maß jetzt selbst (`boBodyHeight`), statt dass es hier aus der
 * Breite erraten wird. Der Schatten darf über einer Nachricht liegen, das Kinn
 * nicht — deshalb der Körper und nicht der Rahmen.
 */
const HERO_BOTTOM_FROM_LIST_TOP = -HERO_PULL_UP + boBodyHeight(BO_SIZE);
/**
 * Freiraum am visuellen OBEREN Rand der Liste, damit kurze Unterhaltungen
 * unter Bo beginnen statt hinter ihm.
 */
const THREAD_TOP_GAP = HERO_BOTTOM_FROM_LIST_TOP + 18;

/**
 * Ab dieser Höhe über der Listenoberkante beginnt das Wegkippen.
 *
 * Genau die Ruheposition: Was liegen bleibt, ist unberührt; gekippt wird nur,
 * was darüber hinausläuft.
 */
const RECEDE_START_Y = THREAD_TOP_GAP;
/**
 * Über diese Strecke läuft es durch — und die ist nicht frei wählbar.
 *
 * Hier stand 132 als eigene Zahl. Nachgerechnet an einem Bild: Eine Zeile, die
 * VOLLSTÄNDIG hinter Bo steht, kam damit auf 38% der Strecke — also 11%
 * kleiner und 72% Deckkraft. Sie ist zu dem Zeitpunkt komplett verdeckt und
 * sieht trotzdem fast unberührt aus. Genau das war „die müsste doch längst
 * dahinter sein".
 *
 * Der Bezugspunkt steht fest, man muss ihn nur benennen: Ganz hinten ist eine
 * Zeile, wenn ihre Mitte auf Bos Mitte liegt — weiter kann sie nicht
 * verschwinden, dort ist sie zur Gänze hinter ihm. Die Strecke ist also der
 * Weg von der Ruhelage bis dorthin, und beides ist bekannt.
 */
const BO_MIDDLE_FROM_LIST_TOP = HERO_BOTTOM_FROM_LIST_TOP - boBodyHeight(BO_SIZE) / 2;
const RECEDE_LENGTH = RECEDE_START_Y - BO_MIDDLE_FROM_LIST_TOP;
/** Wie klein eine ganz nach hinten gekippte Nachricht wird. */
const RECEDE_MIN_SCALE = 0.66;
/** Und wie dunkel — der Hintergrund ist dunkel, weniger Deckkraft = dunkler. */
const RECEDE_MIN_OPACITY = 0.12;

interface CellProps {
  children?: ReactNode;
  onLayout?: (e: LayoutChangeEvent) => void;
  style?: StyleProp<ViewStyle>;
  /** Buchhaltung der Liste — gehört nicht an die native Ansicht. */
  item?: unknown;
  index?: number;
  cellKey?: string;
}

/**
 * `measure`, das nicht in die Luft geht.
 *
 * Die Bibliothek verspricht `null`, wenn nicht gemessen werden kann — der
 * native Teil darunter WIRFT aber, wenn die Ansicht noch gar nicht im Baum
 * steht („Value is null, expected an Object"). Beim App-Start läuft dieser Wert
 * genau einmal, bevor die Hülle hängt, und riss die App mit. Ein abgeleiteter
 * Wert darf niemals werfen: Er läuft auf dem UI-Strang, und dort gibt es
 * niemanden, der den Fehler auffängt.
 */
function safeMeasure(ref: AnimatedRef<View>) {
  "worklet";
  try {
    return measure(ref);
  } catch {
    return null;
  }
}

function makeRecedingCell(
  scrollY: SharedValue<number>,
  listH: SharedValue<number>,
  slide: SharedValue<number>,
  listTop: SharedValue<number>,
  firstY: SharedValue<number>,
  padBottomSV: SharedValue<number>,
  padBottomRef: { current: number },
  allowEnter: { current: boolean },
) {
  /**
   * Maße über das Ab- und Wiederaufbauen hinweg merken — gegen das Flackern.
   *
   * Die Liste baut Zeilen ab, die aus dem Bild laufen, und wieder auf, wenn sie
   * zurückkommen. Frisch aufgebaut kennt eine Zeile ihre Höhe noch nicht, die
   * Stärke rechnet dann 0 — also VOLLE Größe und volle Deckkraft. Erst die
   * Layout-Meldung ein Bild später setzt sie auf ihren echten Wert.
   *
   * Sichtbar ist das ein helles Aufblitzen in voller Größe, und zwar genau
   * dort, wo die Zeilen eigentlich schon fast verschwunden sein sollten: oben,
   * beim Hochschieben. Das ist das gemeldete Flackern.
   *
   * Die Höhe einer Nachricht ändert sich nicht, also ist sie beim Wiederaufbau
   * längst bekannt. Der Speicher lebt mit dem Bildschirm und verschwindet mit
   * ihm — die Kennung kommt aus dem Schlüssel der Zeile.
   */
  const known = new Map<string, { y: number; h: number }>();
  /** JS-Spiegel von `firstY` — nur zum Vergleichen, siehe unten. */
  const firstYRef = { current: -1 };
  /** Dasselbe für den unteren Abstand. */
  const padBottomSeenRef = { current: -1 };

  return function RecedingCell({
    children,
    onLayout,
    style,
    item: _item,
    index,
    cellKey,
    ...rest
  }: CellProps) {
    const key = cellKey ?? `#${index}`;
    const cellRef = useAnimatedRef<View>();
    const seen = known.get(key);
    /**
     * Neu im Verlauf — oder nur wieder aufgebaut, weil sie ins Bild zurückkommt?
     *
     * Der Unterschied steht im Maß-Speicher: Was dort liegt, gab es schon
     * einmal. Nur wirklich neue Zeilen ziehen ein, zurückkehrende erscheinen
     * sofort, sonst blitzte beim Scrollen alles ein.
     */
    const isNew = seen === undefined;
    /**
     * Unsichtbar starten nur, wenn auch wirklich eingezogen wird.
     *
     * Der Maß-Speicher entsteht beim Aufbau des Bildschirms neu — beim Öffnen
     * ist also JEDE Zeile „neu" und startete damit auf Deckkraft null. Das
     * erste gezeichnete Bild zeigte einen leeren Verlauf, und erst wenn die
     * Messungen eintrudeln, wurde Zeile für Zeile sichtbar geschrieben: N
     * native Schreibvorgänge, mitten in der Einfahrt, und sie entwerten dabei
     * die GPU-Ebene, die genau dafür angelegt wurde.
     *
     * Während der Einfahrt ist der Einzug ohnehin gesperrt (`allowEnter`) — die
     * Zeilen wurden also auf null gesetzt, um dann ohne Kurve auf eins zu
     * springen. Reine Arbeit ohne Wirkung. Für später eintreffende Nachrichten
     * ändert sich nichts.
     */
    const enter = useSharedValue(isNew && allowEnter.current ? 0 : 1);
    const y = useSharedValue(seen?.y ?? 0);
    const h = useSharedValue(seen?.h ?? 0);

    /**
     * Der Rang gehört in einen Merker, nicht in die Abhängigkeiten.
     *
     * Die Liste zählt beim Voranstellen einer Nachricht JEDEN Rang hoch. Stand
     * er in der Liste darunter, bekam damit jede gemountete Zeile eine neue
     * Funktions-Kennung — und die animierte Hülle darum hängt daran ihre
     * Eigenschaften neu ein. Gebraucht wird der Rang aber nur zum Vergleich mit
     * null, und dafür reicht der jeweils letzte Stand.
     */
    const indexRef = useRef(index);
    indexRef.current = index;
    /** Schon eingezogen? Als JS-Wert — siehe `allowEnter`. */
    const enteredRef = useRef(!isNew);

    const handleLayout = useCallback(
      (e: LayoutChangeEvent) => {
        const ny = e.nativeEvent.layout.y;
        const nh = e.nativeEvent.layout.height;
        const prev = known.get(key);
        const first = prev === undefined;
        /**
         * NUR schreiben, was sich wirklich geändert hat.
         *
         * Das ist der Hebel. Ein Maß-Ereignis feuert hier nicht, weil sich
         * etwas bewegt hat, sondern weil Yoga den Behälter durchgelaufen ist —
         * und das tut er bei jedem Text-Zuwachs der laufenden Blase, für JEDE
         * gemountete Zeile. Ein Schreibzugriff auf einen geteilten Wert ist von
         * JS aus kein Feldzugriff, sondern ein Auftrag über die Laufzeit-Grenze
         * mit Closure und Warteschlange. Zwei davon pro Zeile, zehnmal pro
         * Sekunde, mal Verlaufslänge.
         *
         * Die HÖHE einer bestehenden Zeile ändert sich praktisch nie — die
         * fällt damit vollständig weg. Die Lage verschiebt sich, solange über
         * ihr etwas wächst, aber auch nur dann.
         */
        if (first || prev.y !== ny) y.value = ny;
        if (first || prev.h !== nh) h.value = nh;
        if (first || prev.y !== ny || prev.h !== nh) known.set(key, { y: ny, h: nh });
        // Erst JETZT einblenden: Ab hier steht die Zeile an ihrer Stelle, und
        // die Strecke ist ihre eigene, gerade gemessene Höhe. Beim Aufbau des
        // Bildschirms nicht — dort fährt ohnehin alles schon.
        if (first && !enteredRef.current) {
          enteredRef.current = true;
          enter.value = allowEnter.current
            ? withTiming(1, { duration: 220, easing: Easing.out(Easing.cubic) })
            : 1;
        }
        /**
         * Die neueste Zeile meldet den Anfang des Stapels.
         *
         * Daraus ergibt sich der freie Platz nach unten, und daran hängt, wie
         * weit die Tastatur den Stapel überhaupt heben muss. NUR melden, nie
         * von anderer Stelle verändern — daran ist dieselbe Rechnung schon
         * einmal gescheitert.
         */
        // Auch hier nur bei echter Änderung: Daran hängt die Hebe-Rechnung der
        // Tastatur, und die weckt ihrerseits den Stil JEDER gemounteten Zeile.
        if (indexRef.current === 0) {
          if (firstYRef.current !== ny) {
            firstYRef.current = ny;
            firstY.value = ny;
          }
          // Im SELBEN Bild — siehe `padBottomRef` oben.
          if (padBottomSeenRef.current !== padBottomRef.current) {
            padBottomSeenRef.current = padBottomRef.current;
            padBottomSV.value = padBottomRef.current;
          }
        }
        // Die eigene Buchhaltung der Liste MUSS weiterlaufen — sie misst hier
        // ihre Zellen. Ohne das Durchreichen bricht die Virtualisierung.
        onLayout?.(e);
      },
      [onLayout, y, h, key, firstY, enter, allowEnter],
    );

    /**
     * Die Stärke als EINZELNE ZAHL — und das ist der Hebel gegen die Last.
     *
     * Reanimated überspringt eine native Aktualisierung, wenn sich der Stil
     * nicht geändert hat. Der Vergleich ist aber flach und über Referenzen: Ein
     * `transform: [{ scale }]` ist bei jedem Durchlauf ein FRISCHES Array, gilt
     * also immer als geändert. Vorher ging deshalb für JEDE gemountete Zeile ein
     * nativer Commit pro Bild hinaus, obwohl nur zwei bis drei überhaupt im
     * Kipp-Bereich liegen — das war das ruckelnde Scrollen und Bos Zappeln.
     *
     * Über eine Zahl greift die Abkürzung: Ändert sie sich nicht, wird sie nicht
     * geschrieben, und der Stil-Auswerter läuft gar nicht erst. Gerundet, damit
     * ein Zittern in der sechsten Nachkommastelle nicht als Änderung durchgeht.
     */
    /**
     * DIE ZEILE WIRD GEFRAGT, NICHT GERECHNET.
     *
     * Vorher entstand ihre Bildschirmlage aus `listH - (y + h) + scrollY +
     * slide` — vier Werte aus DREI verschiedenen Quellen: `y` und `h` aus der
     * Layout-Meldung dieser Zelle, `listH` aus der der Liste (beide JS-Strang),
     * `scrollY` aus dem Scroll-Ereignis (UI-Strang). Die Rechnung stimmt nur,
     * solange alle vier denselben Augenblick beschreiben.
     *
     * Bleibt für EINE Zelle eine Layout-Meldung aus, rechnet ab da genau diese
     * eine falsch — und zwar beliebig weit daneben. Sichtbar wurde das als
     * einzelne Nachricht, die mitten im Bild auf 12% Deckkraft und 66% Größe
     * steht, während die darüber und darunter normal aussehen. Ein
     * positionsabhängiger Effekt kann das gar nicht erzeugen; genau daran war
     * zu erkennen, dass nicht die Position schuld ist, sondern die Buchhaltung
     * darüber.
     *
     * `measure` liest die Lage direkt aus dem Schattenbaum, auf dem UI-Strang,
     * im selben Bild, in dem sie gebraucht wird. Es gibt dann nichts mehr, was
     * auseinanderlaufen könnte — weder zwischen zwei Zellen noch zwischen Zelle
     * und Liste. Gemessen wird gegen die Liste (`listTop`), nicht gegen das
     * Fenster: Beide hängen an denselben Transformationen (Parkposition, Hub
     * über der Tastatur), und die Differenz kürzt sie damit heraus.
     *
     * Die vier alten Werte bleiben als AUSLÖSER stehen. Ein abgeleiteter Wert
     * rechnet nur neu, wenn sich eine seiner gelesenen Größen ändert — ohne sie
     * würde einmal gemessen und nie wieder.
     *
     * Fällt die Messung aus (Zeile noch nicht im Baum), gilt null: volle
     * Deckkraft. Im Zweifel sichtbar, nie fälschlich weggeblendet.
     */
    const progress = useDerivedValue(() => {
      scrollY.value;
      listH.value;
      slide.value;
      y.value;
      const hv = h.value;
      if (hv === 0) return 0;
      /**
       * Gemessen, wenn möglich — gerechnet, wenn nicht.
       *
       * Die Messung ist der bessere Weg: Sie liest die Lage im selben Bild aus
       * dem Schattenbaum, es kann also nichts auseinanderlaufen. Sie kann aber
       * ausfallen — eine Zeile, die noch nicht im Baum hängt, eine Ansicht, die
       * Android flachgelegt hat. Wer dann einfach null meldet, schaltet den
       * Effekt stillschweigend ab; genau das ist passiert.
       *
       * Also: Rückfall auf die alte Rechnung. Die kann in seltenen Fällen
       * danebenliegen (dafür steht die Sicherung darunter), aber sie ist immer
       * da. Nie ist beides gleichzeitig weg.
       */
      const lt = listTop.value;
      const m = lt === lt ? safeMeasure(cellRef) : null;
      const visualTop =
        m === null ? listH.value - (y.value + hv) + scrollY.value + slide.value : m.pageY - lt;
      const height = m === null ? hv : m.height;
      // Was rechnerisch KOMPLETT über dem Rand liegt, wird nicht verblasst:
      // Stimmen die Werte, ist die Zeile dann ohnehin außerhalb des Bildes;
      // stimmen sie nicht, wird sie lieber gezeigt als fälschlich ausgeblendet.
      if (visualTop + height < 0) return 0;
      const center = visualTop + height / 2;
      const len = Math.max(RECEDE_LENGTH, height * 0.6);
      const t = Math.min(1, Math.max(0, (RECEDE_START_Y - center) / len));
      return Math.round(t * t * (3 - 2 * t) * 512) / 512;
    });

    const depth = useAnimatedStyle(() => {
      const e = progress.value;
      const inn = enter.value;
      /**
       * UNGEMESSEN heißt UNSICHTBAR — sonst blitzt die Zeile auf.
       *
       * Die Tiefe wird aus Lage und Höhe der Zeile gerechnet, und beide kennt
       * erst ihre erste Messung. Bis dahin steht `progress` auf null, also auf
       * „ganz vorn": Eine Zeile, die eigentlich weit hinten liegt und mit 12%
       * Deckkraft erscheinen soll, wird für ein bis zwei Bilder in voller
       * Größe und Deckkraft gezeichnet und kippt dann zurück.
       *
       * Sichtbar wird das genau dort, wo Zeilen nachrücken: nach der Einfahrt,
       * wenn der Rest des Verlaufs oben auffüllt. Das ist das „die Nachrichten
       * blitzen oben auf".
       *
       * Ungemessen bedeutet auch: noch an keiner Stelle. Sie gar nicht zu
       * zeichnen ist damit nicht nur ruhiger, sondern ehrlicher — und es kostet
       * nichts, denn das erste Maß kommt im nächsten Bild.
       */
      if (h.value === 0) return { opacity: 0 };
      return {
        opacity: (1 - (1 - RECEDE_MIN_OPACITY) * e) * inn,
        transform: [
          // Der Einzug kommt von unten und ist an die eigene Höhe gebunden —
          // eine hohe Karte legt damit denselben Anteil zurück wie eine kurze
          // Zeile und wirkt nicht schneller.
          //
          // OHNE die Tastatur-Verschiebung: Die ist für alle Zeilen gleich und
          // sitzt deshalb auf der Hülle um die Liste (siehe `threadShiftStyle`).
          { translateY: (1 - inn) * (h.value * 0.5 + 12) },
          { scale: 1 - (1 - RECEDE_MIN_SCALE) * e },
        ],
      };
    });

    return (
      <View
        ref={cellRef}
        {...rest}
        // NACH `rest`, damit nichts es überschreibt: Ohne das legt Android die
        // Ansicht flach, und `measure` liefert dann NaN — die Bibliothek warnt
        // wörtlich davor.
        collapsable={false}
        style={style}
        onLayout={handleLayout}
      >
        <Animated.View style={depth}>{children}</Animated.View>
      </View>
    );
  };
}


function idGen(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function replaceTyping(messages: Msg[], next: Msg): Msg[] {
  const filtered = messages.filter((m) => m.kind !== "typing");
  return [...filtered, next];
}

/**
 * Die Antwort-Blase VOR die Karten desselben Zuges setzen.
 *
 * Die Reihenfolge im Strom ist nicht garantiert: Ein Treffer oder eine
 * Abfahrtstafel kann vor dem ersten Textstück ankommen. Ans Ende gehängt stünde
 * die Antwort dann unter ihren eigenen Karten. Das galt für den Text schon,
 * für die beiden anderen Wege aber nicht — dieselbe Regel, eine Stelle.
 */
function insertBotBefore(messages: Msg[], botId: string, bot: Msg): Msg[] {
  const rest = messages.filter((m) => m.kind !== "typing");
  const firstCard = rest.findIndex((m) => m.kind === "result" && m.botId === botId);
  if (firstCard === -1) return [...rest, bot];
  return [...rest.slice(0, firstCard), bot, ...rest.slice(firstCard)];
}

function appendBotText(messages: Msg[], botId: string, delta: string): Msg[] {
  // Erste Text-Delta → Typing-Bubble durch Bot-Bubble ersetzen UND den Bot-
  // Bubble mit der reservierten ID anlegen. Folge-Deltas appenden an die ID.
  const idx = messages.findIndex((m) => m.id === botId);
  if (idx === -1) {
    /**
     * Der Text kann NACH den Karten eintreffen — dann gehört er trotzdem davor.
     *
     * Die Reihenfolge im Strom ist nicht garantiert: Ein Treffer kann vor dem
     * ersten Text-Stück ankommen. Angehängt stünde die Antwort dann unter ihren
     * eigenen Karten.
     */
    return insertBotBefore(messages, botId, { id: botId, kind: "bot", text: delta });
  }
  return messages.map((m, i) =>
    i === idx && m.kind === "bot" ? { ...m, text: m.text + delta } : m,
  );
}

/**
 * Den fertigen Strom-Text in die Blase schreiben.
 *
 * Angehängt, nicht ersetzt: `appendBotText` legt die Blase mit leerem Text an,
 * es kann aber auch ein Rest aus einem früheren Weg darin stehen.
 */
function commitBotText(messages: Msg[], botId: string, text: string): Msg[] {
  const idx = messages.findIndex((m) => m.id === botId);
  if (idx === -1) return insertBotBefore(messages, botId, { id: botId, kind: "bot", text });
  return messages.map((m, i) =>
    i === idx && m.kind === "bot" ? { ...m, text: m.text + text } : m,
  );
}

function appendFlightMessage(
  messages: Msg[],
  botId: string,
  flight: SearchResult,
): Msg[] {
  /**
   * Doppelte aussortieren — aber nur INNERHALB desselben Turns.
   *
   * Ein Wiederholungsversuch kann denselben Treffer zweimal liefern, das gehört
   * gefiltert. Über den ganzen Verlauf zu prüfen wäre aber falsch: Fragt jemand
   * später noch einmal nach derselben Verbindung, ist das eine neue Antwort und
   * hat ihre eigene Karte verdient — sonst bliebe sie stumm aus.
   */
  const dupe = messages.some(
    (m) => m.kind === "result" && m.botId === botId && m.result.id === flight.id,
  );
  // Die Punkte-Blase verschwindet in JEDEM Fall: Ist der Treffer die einzige
  // Ausgabe dieses Turns, bliebe sie sonst als ewiges „tippt…" stehen.
  const rest = messages.filter((m) => m.kind !== "typing");
  if (dupe) return rest;
  return [...rest, { id: `${botId}:${flight.id}`, kind: "result", result: flight, botId }];
}

function appendBoardMessage(
  messages: Msg[],
  botId: string,
  stop: { code: string; label: string },
  board: "departures" | "arrivals",
  data?: StopBoardResponse,
): Msg[] {
  const rest = messages.filter((m) => m.kind !== "typing");
  /**
   * Die Doppel-Prüfung gilt DIESEM Halt, nicht dem ganzen Zug.
   *
   * Sie stand nur auf `botId` — fragte jemand in einer Nachricht nach zwei
   * Stationen („Abfahrten in Köln und Düsseldorf"), verschwand die zweite Tafel
   * stillschweigend. Die Schwester-Funktion für Treffer macht es richtig und
   * schlüsselt zusätzlich über die Kennung des Ergebnisses.
   */
  const id = `${botId}:board:${stop.code}:${board}`;
  if (rest.some((m) => m.id === id)) return rest;
  return [...rest, { id, kind: "board", stop, board, data, botId }];
}

function appendActionMessage(
  messages: Msg[],
  botId: string,
  params: LastSearchParams,
): Msg[] {
  const rest = messages.filter((m) => m.kind !== "typing");
  if (rest.some((m) => m.kind === "action" && m.botId === botId)) return rest;
  return [...rest, { id: `${botId}:action`, kind: "action", params, botId }];
}

// ---------------------------------------------------------------------------
// Sub-Components
// ---------------------------------------------------------------------------

interface BubbleProps {
  msg: Msg;
  accent: string;
  onRetry: () => void;
  /** Tap-Handler für den „Alle Treffer"-Button. */
  onOpenResults: (params: LastSearchParams) => void;
  t: ReturnType<typeof useT>;
}

// Memo-Wrapper: bei wachsender Conversation würden sonst alle Bubbles bei
// jedem State-Update neu rendern (Text-Stream, Tab-Switch, etc.). Mit memo
// re-rendert nur die Bubble deren `msg`-Referenz sich tatsächlich geändert
// hat. Das ist der wichtigste Perf-Fix für lange Chats.
const Bubble = memo(BubbleInner, (prev, next) => {
  return (
    prev.msg === next.msg &&
    prev.accent === next.accent &&
    prev.onRetry === next.onRetry &&
    prev.onOpenResults === next.onOpenResults &&
    prev.t === next.t
  );
});

function BubbleInner({ msg, accent, onRetry, onOpenResults, t }: BubbleProps) {
  // KEINE FadeInDown.entering Animationen mehr — bei FlatList-Virtualisierung
  // unmounted und remountet die Liste die Items beim Scrollen ständig.
  // Jeder Remount würde die Entering-Animation neu feuern → sichtbares
  // Flackern + JS-Last → Scroll-Ruckeln. Bubbles erscheinen jetzt instant
  // beim Mount (was bei Stream-Deltas eh nur den ersten Frame betrifft).
  if (msg.kind === "typing") {
    return (
      <View style={[styles.bubble, styles.botBubble, styles.typing]}>
        <View style={styles.dots}>
          <Dot delay={0} />
          <Dot delay={120} />
          <Dot delay={240} />
        </View>
      </View>
    );
  }

  if (msg.kind === "result") {
    return (
      <View style={styles.flightWrap}>
        <ResultCard result={msg.result} />
      </View>
    );
  }

  if (msg.kind === "user") {
    return (
      <View style={[styles.bubble, styles.userBubble, { backgroundColor: accent }]}>
        <Text style={[styles.userText, { color: "#000000" }]}>{msg.text}</Text>
      </View>
    );
  }

  if (msg.kind === "board") {
    return (
      <View style={styles.flightWrap}>
        <StopBoardCard stop={msg.stop} initialBoard={msg.board} initialData={msg.data} />
      </View>
    );
  }

  if (msg.kind === "action") {
    return (
      <View style={styles.flightWrap}>
        <RippleTouch style={styles.resultsButton} onPress={() => onOpenResults(msg.params)}>
          <GradientFill />
          <Text style={styles.resultsButtonText}>{t("assistant.button.allResults")}</Text>
        </RippleTouch>
      </View>
    );
  }

  if (msg.kind === "error") {
    return (
      <View style={[styles.bubble, styles.botBubble, styles.errBubble]}>
        <View style={styles.errRow}>
          <AlertTriangle size={16} color={C.error} strokeWidth={2.2} />
          <Text style={styles.errTitle}>{t("assistant.error.title")}</Text>
        </View>
        <Text style={styles.botText}>{msg.message}</Text>
        <Pressable style={styles.retry} onPress={onRetry}>
          <RotateCw size={14} color={C.white} strokeWidth={2} />
          <Text style={styles.retryText}>{t("assistant.error.retry")}</Text>
        </Pressable>
      </View>
    );
  }

  // Bot — Text-Bubble plus optional ResultCard (search_journey-Treffer) ODER
  // StopBoardCard (Live-Departures/Arrivals). Beide außerhalb der Bubble
  // damit sie volle Breite haben.
  return (
    <View style={styles.botMessageWrap}>
      <BotText id={msg.id} text={msg.text} accent={accent} />
    </View>
  );
}

/**
 * Die Blase einer Bot-Antwort — mit eigenem Draht zum laufenden Text.
 *
 * Solange die Antwort läuft, steht ihr Text nicht in der Nachricht, sondern im
 * Strom-Speicher (siehe `lib/assistant/streamText.ts`). Diese Blase hört dort
 * selbst zu und rendert sich allein neu; die Liste darüber merkt davon nichts.
 * Ist der Strom durch, ist der Speicher leer und der Text steht in der
 * Nachricht — dieselbe Anzeige, nur aus der anderen Quelle.
 *
 * Sichtbar ändert sich dadurch nichts: gleiche Blase, gleiche Stile, gleiche
 * Auszeichnung, und leer bleibt sie wie zuvor unsichtbar.
 */
const BotText = memo(function BotText({
  id,
  text,
  accent,
}: {
  id: string;
  text: string;
  accent: string;
}) {
  const [live, setLive] = useState(() => peekStreamText(id));
  useEffect(() => subscribeStreamText(id, setLive), [id]);
  const shown = live ?? text;
  if (shown.length === 0) return null;
  return (
    <View style={[styles.bubble, styles.botBubble]}>
      <RichText text={shown} accent={accent} />
    </View>
  );
});

/** Rendert `**bold**` als Accent-farbenen Bold-Text. */
function RichText({ text, accent }: { text: string; accent: string }) {
  const parts = text.split("**");
  return (
    <Text style={styles.botText}>
      {parts.map((p, i) =>
        i % 2 === 1 ? (
          <Text key={i} style={[styles.boldAccent, { color: accent }]}>
            {p}
          </Text>
        ) : (
          <Text key={i}>{p}</Text>
        ),
      )}
    </Text>
  );
}

/**
 * Laufen die Tipp-Punkte gerade? — EIN Merker für alle drei.
 *
 * WARUM DAS ÜBERHAUPT NÖTIG IST:
 *
 * Die Punkte sind der einzige Dauerläufer in Bos Baum außer Bo selbst — sechs
 * Endlos-Animationen (drei Punkte mal Lage und Deckkraft). Und Bos Ausfahrt
 * legt genau über diesen Baum eine GPU-Textur. Eine Textur ist aber eine
 * GERASTERTE MOMENTAUFNAHME: Ändert ein Nachfahre etwas, wird sie im selben
 * Bild ungültig und muss neu hochgeladen werden.
 *
 * Solange die Punkte laufen, passiert das in JEDEM Bild der Fahrt. Die Textur
 * ist damit nicht nur wirkungslos, sondern teurer als keine — der ganze
 * Bildschirm samt Verlauf wird jedes Bild neu gezeichnet UND jedes Bild
 * hochgeladen. Dieselbe Begründung steht wörtlich an Bos eigener Pause und am
 * Sonnenaufgang des Such-Blattes.
 *
 * Zu sehen sind die Punkte nur, während Bo antwortet. Genau dann schließt man
 * ihn aber gern — und dann ist es kein „manchmal" mehr, sondern jedes Mal.
 *
 * WARUM EIN MODUL-VERTEILER STATT EINES PROPS: Die Punkte stecken in einer
 * Listen-Blase. Ein Prop müsste durch `renderItem` und den Memo-Vergleich, und
 * jede Änderung daran renderte JEDE gemountete Blase neu — mitten in der Fahrt,
 * also genau das, was hier vermieden werden soll. Über einen Verteiler weckt es
 * die drei Punkte und sonst niemanden; `lib/assistant/streamText.ts` begründet
 * dasselbe Vorgehen ausführlicher.
 */
/**
 * Dieselbe Bauart für BO — und der Grund ist gemessen, nicht vermutet.
 *
 * `sliding` war eine Zustandsgröße, die AUSSCHLIESSLICH zwei `paused`-Props
 * gespeist hat. Ihr Umlegen rendert dafür diesen Bildschirm komplett neu, und
 * das kostet auf dem Gerät 28ms — bei 120Hz drei bis vier verlorene Bilder.
 *
 * Gemessen wurde es so (Sonde über `logcat`, acht Durchgänge, ausnahmslos):
 *
 *     bo-laeuft-an    +774      Zustand kippt
 *     STALL 28ms      +802
 *     bo-effekt-start +802      Bo baut JETZT ERST seine Animationen auf
 *
 * Die 28ms liegen vollständig ZWISCHEN dem Zustandswechsel und Bos Effekt. Es
 * ist also nicht der Animations-Neustart, es ist der Neu-Durchlauf davor. Über
 * einen Verteiler weckt das Entsperren nur noch Bo und sonst niemanden.
 *
 * Der Zeitpunkt liegt 200ms hinter dem Kurvenende — die Fahrt selbst ist davon
 * nicht betroffen. Sichtbar ist es als Haken in Bos ERSTER Bewegung.
 */
let boBlocked = true;
const boBlockedListeners = new Set<(blocked: boolean) => void>();

function setBoBlocked(blocked: boolean): void {
  if (boBlocked === blocked) return;
  boBlocked = blocked;
  for (const fn of boBlockedListeners) fn(blocked);
}

function subscribeBoBlocked(fn: (blocked: boolean) => void): () => void {
  boBlockedListeners.add(fn);
  fn(boBlocked);
  return () => {
    boBlockedListeners.delete(fn);
  };
}

/** Bo hinter dem Verteiler — nur DIESER Knoten rendert beim Entsperren neu. */
const BoGate = memo(function BoGate({ state, size }: { state: BoMood; size: number }) {
  const [paused, setPaused] = useState(true);
  useEffect(() => subscribeBoBlocked(setPaused), []);
  return <Bo state={state} size={size} paused={paused} />;
});

let dotsPaused = false;
const dotsListeners = new Set<(paused: boolean) => void>();

function setDotsPaused(paused: boolean): void {
  if (dotsPaused === paused) return;
  dotsPaused = paused;
  for (const fn of dotsListeners) fn(paused);
}

/** Meldet sofort den aktuellen Stand — ein frisch gemounteter Punkt soll nicht
 *  loslaufen, wenn gerade gefahren wird. */
function subscribeDotsPaused(fn: (paused: boolean) => void): () => void {
  dotsListeners.add(fn);
  fn(dotsPaused);
  return () => {
    dotsListeners.delete(fn);
  };
}

function Dot({ delay }: { delay: number }) {
  // Wave-Animation auf Reanimated-Worklet: jeder Dot bobst sanft hoch & runter
  // (translateY -6 → 0) und glow't dabei (opacity 0.35 → 1). Mit phase-versetztem
  // `delay` zwischen den drei Dots entsteht eine elegante Welle, wie wenn Bo
  // gerade tippt. Worklets laufen auf UI-Thread → kein JS-Stutter selbst
  // während Bo's Stream einen großen Response liefert.
  const ty = useSharedValue(0);
  const op = useSharedValue(0.35);

  useEffect(() => {
    /**
     * Anhalten heißt auch hier: in die RUHESTELLUNG, nicht irgendwo stehen
     * bleiben.
     *
     * `cancelAnimation` lässt den Wert dort, wo er zufällig war — ein Punkt
     * fröre also halb angehoben und halb durchsichtig ein und führe so aus dem
     * Bild. Dieselbe Falle wie bei Bos Pose, und dieselbe Antwort: hart auf den
     * Ruhewert setzen. Sichtbar ist der Sprung nicht, denn er passiert im
     * Berührungs-Bild des Schließens, und der Bildschirm fährt danach weg.
     */
    const apply = (paused: boolean) => {
      cancelAnimation(ty);
      cancelAnimation(op);
      if (paused) {
        ty.value = 0;
        op.value = 0.35;
        return;
      }
      // Sequence pro Dot: hoch → runter → kurze Pause → repeat
      // Cycle-Dauer: 320+320+360 = 1000ms. Mit Phase-Offsets 0/120/240ms
      // (siehe Dot-Call-Site) ergibt sich der Wellen-Effekt.
      ty.value = withDelay(
        delay,
        withRepeat(
          withSequence(
            withTiming(-6, { duration: 320, easing: Easing.inOut(Easing.ease) }),
            withTiming(0, { duration: 320, easing: Easing.inOut(Easing.ease) }),
            withTiming(0, { duration: 360 }), // pause am Boden
          ),
          -1,
        ),
      );
      op.value = withDelay(
        delay,
        withRepeat(
          withSequence(
            withTiming(1, { duration: 320, easing: Easing.inOut(Easing.ease) }),
            withTiming(0.35, { duration: 320, easing: Easing.inOut(Easing.ease) }),
            withTiming(0.35, { duration: 360 }),
          ),
          -1,
        ),
      );
    };
    const off = subscribeDotsPaused(apply);
    return () => {
      off();
      cancelAnimation(ty);
      cancelAnimation(op);
    };
  }, [delay]);

  const animStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: ty.value }],
    opacity: op.value,
  }));

  return <Animated.View style={[styles.dot, animStyle]} />;
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

/**
 * Oberer Abstand des Schriftzugs — hergeleitet, nicht geschätzt.
 *
 * Im Landingscreen steht neben dem Logo die Glocke (44), hier der
 * Schließen-Knopf (36). Beide sind höher als die Textzeile (32), und
 * `alignItems: "center"` schiebt den Text deshalb um die halbe Differenz nach
 * unten — um 6 dort, um 2 hier. Wer beide Zeilen auf denselben Wert setzt,
 * bekommt genau diesen Unterschied als Versatz: Das Logo saß 2px zu hoch.
 *
 * Also den Überhang herausrechnen, wie es der Landingscreen auch tut. Beide
 * Schriftzüge beginnen damit exakt HEADING_TOP unter der sicheren Fläche.
 */
const CLOSE_BTN_SIZE = 36;
/**
 * Die Liste mit animierten Eigenschaften — als eigener, typisierter Alias.
 *
 * `Animated.FlatList` verliert in den Typen den Element-Typ und damit auch
 * `CellRendererComponent`. Der Alias stellt die Signatur der normalen
 * `FlatList` wieder her; zur Laufzeit sind es dieselben Eigenschaften.
 */
type ThreadProps = Omit<FlatListProps<Msg>, "onScroll"> & {
  /** Der Scroll-Handler ist ein Worklet, kein gewöhnlicher Rückruf. */
  onScroll?: ReturnType<typeof useAnimatedScrollHandler>;
  ref?: React.Ref<FlatList<Msg>>;
};
const AnimatedThread = Animated.createAnimatedComponent(
  FlatList,
) as unknown as React.ComponentType<ThreadProps>;

const TOPBAR_TOP = HEADING_TOP - (CLOSE_BTN_SIZE - HEADING_LINE_HEIGHT) / 2;
/**
 * Wo Bo schwebt — gemessen von der sicheren Fläche.
 *
 * Seine Position bleibt exakt die alte; er liegt nur nicht mehr im Fluss über
 * der Liste, sondern als Überlagerung darüber. Der Wert ist deshalb genau das,
 * was der Fluss vorher ergab: Kopfzeile plus deren Innenabstand, minus der
 * Überhang, mit dem der Block schon vorher nach oben gezogen wurde.
 */
const TOPBAR_CONTENT_H = Math.max(CLOSE_BTN_SIZE, HEADING_LINE_HEIGHT);
const HERO_TOP = TOPBAR_TOP + TOPBAR_CONTENT_H + 14 - HERO_PULL_UP;

const styles = scaledStyles({
  // `overflow` ist zwingend: Ohne es rundet Android zwar den Rahmen, aber die
  // Kinder malen weiter bis in die Ecken.
  /**
   * ABSOLUT bildschirmfüllend, nicht `flex: 1`.
   *
   * Als Route lag dieser Bildschirm allein im Stapel und füllte ihn mit `flex`.
   * Seit er als Überlagerung am Wurzel-Layout hängt, ist er dort ein
   * GESCHWISTER des Stapels — beide mit `flex: 1` teilen sich die Höhe, und Bo
   * begann auf halber Strecke. Genau das war im Bild zu sehen.
   *
   * `zIndex` so gewählt, dass Bo ÜBER der Tab-Leiste (kein zIndex, also 0) und
   * UNTER allem liegt, was er selbst öffnen kann:
   *
   *   Halt-Blatt 100 · Ergebnisliste 150 · Detail-/Ticket-Blatt 200
   *
   * Mit 120 lag er über dem Halt-Blatt — und das steht im Wurzel-Layout sogar
   * VOR ihm. Tippte man im Chat auf eine Abfahrtstafel, öffnete sich das Blatt
   * also hinter Bo: unsichtbar, aber da. Genau der Fall, den der Nutzer
   * gemeldet hat.
   */
  root: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 50,
    backgroundColor: C.bg,
    overflow: "hidden",
  },

  // Position des Schriftzugs — 1:1 zum Landingscreen, siehe TOPBAR_TOP oben.
  topbar: {
    // GUTTER statt 22 — dieselbe Kante wie überall sonst.
    paddingHorizontal: GUTTER,
    paddingBottom: 14,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  closeBtn: {
    // Über die Konstante, damit der Überhang in TOPBAR_TOP mitwandert, falls
    // der Knopf je eine andere Größe bekommt.
    width: CLOSE_BTN_SIZE,
    height: CLOSE_BTN_SIZE,
    borderRadius: CLOSE_BTN_SIZE / 2,
    backgroundColor: C.surface2,
    borderWidth: 1,
    borderColor: C.border,
    alignItems: "center",
    justifyContent: "center",
  },

  // marginTop: -33 zieht den ganzen Hero (Bo + Box + Glow + Mood-Label)
  // näher an die Topbar ran. Bo's SVG hat oben Whitespace für den Glow-
  // Effekt — der bleibt sichtbar, schiebt sich nur hinter die Topbar.
  // marginBottom: -10 holt zusätzlich Platz für den Thread raus (Bo's SVG
  // hat unten Padding für Sweat-Drops). Effekt: Bo bleibt 120px groß,
  // sitzt aber deutlich weiter oben → mehr Chat-Fläche.
  /**
   * Bo als Überlagerung, nicht mehr im Fluss.
   *
   * Vorher stand er über der Liste, die Liste begann darunter — eine Nachricht,
   * die nach oben lief, endete an deren Oberkante vor einer Fläche in
   * Hintergrundfarbe. Jetzt füllt die Liste die Fläche, und er schwebt darüber.
   * `pointerEvents` bleibt aus, damit man durch ihn hindurch scrollen kann.
   */
  hero: {
    position: "absolute",
    left: 0,
    right: 0,
    alignItems: "center",
    zIndex: 5,
  },
  /**
   * Statuszeile — senkrecht mittig zum Binch-Schriftzug.
   *
   * Absolut über die ganze Breite gelegt und mit `textAlign` zentriert: In der
   * Zeile eingereiht hinge ihre Position von den Breiten des Schriftzugs und
   * des Schließen-Knopfes ab. Die senkrechte Mitte kommt über die volle Höhe
   * der Zeile plus `textAlignVertical`, damit sie unabhängig von der eigenen
   * Zeilenhöhe genau auf der Mitte des Schriftzugs sitzt.
   */
  mood: {
    position: "absolute",
    left: 0,
    right: 0,
    textAlign: "center",
    textAlignVertical: "center",
    fontSize: 11,
    // Siehe `MOOD_LINE_H`: Die Geometrie des Tiefeneffekts hängt daran.
    lineHeight: MOOD_LINE_H,
    letterSpacing: 1.2,
    color: C.textTertiary,
    fontWeight: "600",
  },

  thread: { flex: 1 },
  threadClip: { flex: 1, overflow: "hidden" },
  threadFill: { ...StyleSheet.absoluteFillObject },
  // Mit inverted FlatList: flexGrow:1 + justifyContent:'flex-end' ankert
  // bei wenigen Messages die Children am visuellen TOP (statt am Bottom
  // anhäufen). Kurze Chats: Welcome + paar Messages unter Bo, Empty-Space
  // nach unten zur Bar. Lange Chats: Stack füllt naturlich, neueste am
  // visuellen Bottom.
  // Mit gespiegelter Liste verankert `flexGrow: 1` + `justifyContent: flex-end`
  // wenige Nachrichten am visuellen OBEREN Rand — sie beginnen unter Bo, statt
  // sich über der Leiste zu sammeln. Lange Unterhaltungen füllen von selbst.
  threadContent: {
    flexGrow: 1,
    justifyContent: "flex-end",
    paddingHorizontal: 16,
    gap: 10,
  },

  bubble: {
    maxWidth: "82%",
    paddingVertical: 11,
    paddingHorizontal: 15,
    borderRadius: 24,
  },
  botBubble: {
    alignSelf: "flex-start",
    backgroundColor: C.surface2,
    borderWidth: 1,
    borderColor: C.border,
    borderBottomLeftRadius: 8,
  },
  userBubble: {
    alignSelf: "flex-end",
    borderBottomRightRadius: 8,
  },
  errBubble: { borderColor: "rgba(255,122,107,0.55)" },

  botText: { color: C.white, fontSize: 15, lineHeight: 21 },
  userText: { fontSize: 15, lineHeight: 21, fontWeight: "500" },
  boldAccent: { fontWeight: "700" },

  errRow: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 3 },
  errTitle: { color: C.error, fontWeight: "600", fontSize: 15 },
  retry: {
    marginTop: 10,
    alignSelf: "flex-start",
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    backgroundColor: C.surface4,
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 9999,
  },
  retryText: { color: C.white, fontWeight: "600", fontSize: 13 },

  typing: { paddingVertical: 14, paddingHorizontal: 16 },
  dots: { flexDirection: "row", gap: 6 },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: C.textTertiary },

  // Bot-Message-Wrap: Container für Text-Bubble + optionale ResultCard.
  // Beide stacken vertikal mit kleinem gap. Wrap selber ist full-width damit
  // die ResultCard sich nicht in die 82%-Bubble-Breite quetschen muss.
  botMessageWrap: { gap: 8, alignSelf: "stretch" },
  // ResultCard wird full-width gerendert, mit kleiner Ränder-Korrektur damit
  // sie nicht ganz an den Bildschirmrand stößt (Thread hat paddingHorizontal:16).
  flightWrap: { marginTop: 2 },
  // „Alle Treffer anzeigen"-Button — spiegelt den Home-CTA-Style:
  // RippleTouch + GradientFill (Akzent-Gradient) + Bold-Schwarz-Text.
  // overflow:hidden ist nötig damit der GradientFill von borderRadius
  // beschnitten wird (sonst quillt der Gradient an den Pill-Enden raus).
  resultsButton: {
    alignSelf: "flex-start",
    paddingVertical: 13,
    paddingHorizontal: 22,
    borderRadius: 9999,
    overflow: "hidden",
    alignItems: "center",
    justifyContent: "center",
  },
  resultsButtonText: {
    color: "#000000",
    fontSize: 14,
    fontWeight: "700",
    letterSpacing: -0.13,
  },

  // Absolute Container der die Inputbar/VoiceRecordBar über der FlatList
  // schwebend hält. Bottom:0 (Screen-Bottom), die Hochbewegung kommt via
  // Reanimated translateY (siehe barAnimStyle) — smooth mit dem Keyboard.
  inputbarWrap: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "#1A1A1A",
  },
  inputbar: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 10,
    paddingHorizontal: 16,
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: C.border,
    backgroundColor: "#1A1A1A",
  },
  field: {
    flex: 1,
    minHeight: 44,
    maxHeight: 110,
    backgroundColor: C.surface2,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 22,
    justifyContent: "center",
    paddingHorizontal: 16,
    paddingVertical: Platform.OS === "ios" ? 12 : 4,
  },
  fieldText: {
    color: C.white,
    fontSize: 15,
    lineHeight: 20,
    padding: 0,
    margin: 0,
  },
  iconBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
    // KEIN overflow:hidden — der Inhalt overflowt eh nicht, und ClippingView
    // erhöht die Crash-Wahrscheinlichkeit unter RN Fabric ohne Mehrwert.
  },
});
