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
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
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
  useWindowDimensions,
} from "react-native";
import { useAppBg, usePalette } from "@/lib/theme/appBg";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useIsFocused } from "@react-navigation/native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Animated, {
  Extrapolation,
  interpolate,
  useAnimatedKeyboard,
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
  type SharedValue,
} from "react-native-reanimated";
import { Send, Mic, AlertTriangle, RotateCw, X } from "lucide-react-native";
import {
  assistantPush,
  isAssistantPushStarted,
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
import { streamChat, todayLocal, ChatApiError, type ChatStreamEvent, type LastSearchParams } from "@/lib/api/chat";
import { pickWelcome } from "@/lib/assistant/welcomes";
import { StopBoardCard } from "@/components/assistant/StopBoardCard";
import type { SearchResult } from "@/types/search";
import { scaledStyles } from "@/lib/ui/compact";

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
export default function AssistantScreen() {
  const palette = usePalette();
  const appBg = useAppBg();
  const t = useT();
  const accent = useAccent();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const isFocused = useIsFocused();
  const { height: screenH } = useWindowDimensions();

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
  const closingRef = useRef(false);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
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
    // Siehe `kbFreeze`: ab hier steht die Tastatur-Zahl still.
    kbFreeze.value = kbShift.value;
    endAssistantPush();
    setSliding(true);
    setClosing(true);
    closeTimerRef.current = setTimeout(() => {
      // Kein `canGoBack`-Zweig mehr nötig? Doch: Wer über eine Verknüpfung
      // direkt hier landet, hat keine Vorgeschichte zum Zurückgehen.
      if (router.canGoBack()) router.back();
      else router.navigate("/");
    }, ASSISTANT_OUT.duration);
  }, [router]);

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
      closeScreen();
      return true;
    });
    return () => sub.remove();
  }, [closeScreen, isFocused]);
  /** Neustart-Zeitgeber der Spracheingabe — muss beim Verlassen sterben. */
  const restartRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isFocusedRef = useRef(true);
  isFocusedRef.current = isFocused;
  const locale = useSearchStore((s) => s.locale);
  const currency = useSearchStore((s) => s.currency);
  const openAuthOverlay = useSearchStore((s) => s.openAuthOverlay);

  // ?autoVoice=1 wird vom Home-Mic-Tap mitgeschickt → wir starten Voice direkt.
  const params = useLocalSearchParams<{ autoVoice?: string }>();

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
  /** Siehe `flushText` — hier nur deklariert, damit `send` drankommt. */
  const flushTextRef = useRef<(() => void) | null>(null);
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
  const [inputbarHeight, setInputbarHeight] = useState(64);
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
  const kbPad = kbOffset > 0 ? kbOffset + BAR_LIFT_FROM_KB : 0;
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
  const kb = useAnimatedKeyboard();
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
   * sind. Eingefroren ändert sich nichts mehr, also rechnet auch nichts mehr;
   * der Bildschirm fährt als Ganzes weg, verschieben kann sich darin ohnehin
   * nichts mehr.
   */
  const kbFreeze = useSharedValue(-1);
  const kbShift = useDerivedValue(() => {
    if (kbFreeze.value >= 0) return kbFreeze.value;
    const kbHeight = kbGate.value === 0 ? 0 : Math.max(0, kb.height.value - navInset);
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
      setMessages([{ id: idGen(), kind: "bot", text: pickWelcome(locale) }]);
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
    if (params.autoVoice === "1" && !autoVoiceFiredRef.current) {
      autoVoiceFiredRef.current = true;
      void startVoice();
    }
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
      setKbOffset(0);
      kbGate.value = 0;
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
    setMood("waving");
    const id = setTimeout(() => {
      setMood((current) => (current === "waving" ? "idle" : current));
    }, 4500);
    return () => clearTimeout(id);
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
      setMood("waving");
      innerTimeout = setTimeout(() => {
        setMood((current) => (current === "waving" ? "idle" : current));
      }, 3000);
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
        persistedMessages = persistedMessages.filter((m) => m.kind !== "typing");
        persistedMood = "idle";
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
        flushTextRef.current?.();
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
  const flushText = useCallback(() => {
    if (flushTimerRef.current) {
      clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }
    const buf = textBufRef.current;
    if (!buf || buf.text.length === 0) return;
    textBufRef.current = null;
    setMessages((prev) => appendBotText(prev, buf.botId, buf.text));
  }, []);
  flushTextRef.current = flushText;

  // Stream-Event-Handler — closure over botId der aktuellen Antwort.
  const handleStreamEvent = useCallback(
    (event: ChatStreamEvent, botId: string) => {
      if (event.type !== "text") flushText();
      switch (event.type) {
        case "mood":
          setMood(event.mood);
          return;
        case "text": {
          const buf = textBufRef.current;
          if (buf && buf.botId === botId) buf.text += event.delta;
          else textBufRef.current = { botId, text: event.delta };
          if (!flushTimerRef.current) {
            flushTimerRef.current = setTimeout(flushText, 50);
          }
          return;
        }
        case "search_result":
          // Such-Params merken — der nächste Request schickt sie zurück,
          // damit Tools wie open_all_results den Kontext der vorigen Suche
          // wieder zur Verfügung haben.
          lastSearchRef.current = event.params;
          setMessages((prev) => appendFlightMessage(prev, botId, event.result));
          return;
        case "stop_board":
          // Stop-Board-Hint vom Server — Karte inline rendern. Die Live-
          // Daten holt die Karte selbst direkt über /api/stops/:code/{board}.
          if (__DEV__) console.log("[chat] stop_board:", event.stop.code, event.stop.label, event.board);
          setMessages((prev) => appendBoardMessage(prev, botId, event.stop, event.board));
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
    [t],
  );

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
    ],
    [contentPaddingBottom, flowing, kbPad],
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
  // Beim Übernehmen setzen, nicht beim Rendern: Ein Schreibzugriff während des
  // Renderns ist bei Reanimated nicht zulässig. Ein Wettlauf droht hier nicht —
  // der Abstand hängt nur noch an der Höhe der Leiste, nicht an der Tastatur.
  useLayoutEffect(() => {
    padBottomSV.value = contentPaddingBottom;
  }, [contentPaddingBottom, padBottomSV]);
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
  const allowEnter = useSharedValue(0);
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
  const updateFlowing = useCallback((contentH: number, listHeight: number) => {
    if (listHeight === 0 || contentH === 0) return;
    const isFlowing = contentH > listHeight + 1;
    if (isFlowing === flowingRef.current) return;
    flowingRef.current = isFlowing;
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
  const RecedingCell = useMemo(
    () =>
      makeRecedingCell(threadScrollY, threadHeight, slideShift, firstY, allowEnter),
    [threadScrollY, threadHeight, slideShift, firstY, allowEnter],
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
   * Die Bewegung startet schon im Tipp-Handler (`startAssistantPush`), nicht
   * hier: Wenn dieser Bildschirm zum ersten Mal zeichnet, läuft sie bereits. Wir
   * lesen den Wert nur ab. Deshalb steht hier auch kein `useEffect` mit Start —
   * das wäre genau die Verzögerung, die wir loswerden wollten.
   *
   * Der Notausgang darunter ist für den Fall, dass jemand direkt hier landet
   * (Verknüpfung, Wiederherstellung nach Absturz): Dann hat niemand die
   * Bewegung angestoßen, der Wert steht auf 0 — und ohne diese Zeile bliebe der
   * Bildschirm für immer neben dem Sichtfeld stehen.
   */
  const slideStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: (1 - assistantPush.value) * screenH }],
  }));
  useEffect(() => {
    // Über ein Modul-Flag, NICHT über `assistantPush.value`. Ein Lesezugriff aus
    // React ist ein synchroner Sprung in die UI-Laufzeit, der beide Stränge
    // gegeneinander sperrt — und dieser hier lag mitten in Bos laufender Kurve.
    // Die beiden anderen Bewegungen haben ihr Gegenstück längst.
    if (!isAssistantPushStarted()) startAssistantPush();
    return () => {
      // Beim Verschwinden zurücksetzen — ohne Animation, der Bildschirm ist ja
      // weg. Sonst bliebe der Landingscreen darunter für immer um seine
      // Parallax-Strecke verschoben, wenn Bo je auf einem anderen Weg als über
      // `closeScreen` verlassen wird (Verknüpfung, Wiederherstellung).
      resetAssistantPush();
    };
  }, []);

  /**
   * Bo steht still, solange der Bildschirm fährt.
   *
   * Seine Bewegungen sind animierte SVG-Eigenschaften, und die machen die ganze
   * Fläche ungültig — jedes Bild neu gerastert, genau während die Slide jedes
   * Bild braucht. Ein GPU-Puffer über die Fläche hilft hier ausdrücklich NICHT,
   * sondern schadet: Er müsste wegen derselben Animation ohnehin jedes Bild neu
   * hochgeladen werden. Also die Ursache anhalten statt das Ergebnis puffern.
   */
  const [sliding, setSliding] = useState(true);
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
  const [closing, setClosing] = useState(false);
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
  const [entering, setEntering] = useState(true);
  const enterTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const windowTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    /**
     * Die gehaltene Strecke wächst ERST NACH der Einfahrt, mit Abstand.
     *
     * Sie sprang bisher genau zum Ablauf der Fahrt von 1 auf 5, und in diesem
     * Moment mountet die Liste einen Schwung Zeilen — bei vollem Verlauf
     * entsprechend viele. Das fällt ins letzte Stück der Bewegung, also
     * ausgerechnet dorthin, wo man einen Ruckler am ehesten sieht. Ein bisschen
     * Luft dahinter kostet nichts: Solange steht nur weniger im Voraus bereit.
     */
    windowTimerRef.current = setTimeout(() => {
      windowTimerRef.current = null;
      if (closingRef.current) return;
      setEntering(false);
    }, ASSISTANT_IN.duration + 220);
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
      allowEnter.value = 1;
    }, ASSISTANT_IN.duration);
    return () => {
      if (enterTimerRef.current) clearTimeout(enterTimerRef.current);
      if (windowTimerRef.current) clearTimeout(windowTimerRef.current);
    };
  }, []);

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
      data={reversedMessages}
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
       * 10 statt 20 — das ist eine UNTERGRENZE, kein Startwert.
       *
       * Die Liste hält die Anfangs-Region dauerhaft im Baum („zurück nach
       * oben"-Optimierung). Bei 20 blieben also immer zwanzig Zeilen
       * gemountet, egal wie weit man zurückscrollt, und die haben alle
       * mitgerechnet.
       *
       * Von 10 auf 4 heruntergesetzt, weil dieselbe Zahl auch die Größe des
       * ERSTEN Aufbaus bestimmt — und der fällt mit der Einfahrt zusammen.
       * Vier Zeilen füllen den sichtbaren Bereich; der Rest kommt in Häppchen
       * nach, oberhalb des Bildrands.
       */
      initialNumToRender={4}
      maxToRenderPerBatch={6}
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
      style={[
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
        {
          backgroundColor: palette.bg,
          borderRadius: SCREEN_CORNER_RADIUS,
          elevation: 24,
        },
        slideStyle,
      ]}
      // Siehe `closing`: die Fläche für die Ausfahrt einmal rastern statt bei
      // jedem Bild sämtliche Kinder neu zu zeichnen.
      renderToHardwareTextureAndroid={closing}
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
          onPress={closeScreen}
          hitSlop={10}
          style={[styles.closeBtn, { backgroundColor: palette.s2 }]}
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
      {thread}

      {/* Bo + Mood-Label.
          `paused={!isFocused}` schaltet Bo's Reanimated-Worklets ab wenn der
          User auf einem anderen Tab ist. Ohne das laufen 5-8 endlose Repeats
          (Schweben, Blinzeln, ggf. Wink/Yap) auf der UI-Thread im Hinter-
          grund weiter — verlangsamt jeden anderen Tab spürbar. */}
      <View style={[styles.hero, { top: insets.top + HERO_TOP }]} pointerEvents="none">
        <Bo state={mood} size={BO_SIZE} paused={!isFocused || isScrolling || sliding} />
      </View>

      {/* Input-Bar Wrapper — absolut bei bottom:0, die Hochbewegung kommt
          frame-synced mit dem Keyboard via barAnimStyle (useAnimatedKeyboard,
          UI-Thread). onLayout misst die echte Bar-Höhe für die
          contentPaddingBottom-Berechnung. */}
      <Animated.View
        style={[styles.inputbarWrap, { backgroundColor: appBg }, barAnimStyle]}
        onLayout={(e) => {
          const h = e.nativeEvent.layout.height;
          if (Math.abs(h - inputbarHeight) > 1) setInputbarHeight(h);
        }}
      >
      {voiceMode ? (
        <VoiceRecordBar
          recording={listening}
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

function makeRecedingCell(
  scrollY: SharedValue<number>,
  listH: SharedValue<number>,
  slide: SharedValue<number>,
  firstY: SharedValue<number>,
  allowEnter: SharedValue<number>,
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
    const seen = known.get(key);
    /**
     * Neu im Verlauf — oder nur wieder aufgebaut, weil sie ins Bild zurückkommt?
     *
     * Der Unterschied steht im Maß-Speicher: Was dort liegt, gab es schon
     * einmal. Nur wirklich neue Zeilen ziehen ein, zurückkehrende erscheinen
     * sofort, sonst blitzte beim Scrollen alles ein.
     */
    const isNew = seen === undefined;
    const enter = useSharedValue(isNew ? 0 : 1);
    const y = useSharedValue(seen?.y ?? 0);
    const h = useSharedValue(seen?.h ?? 0);

    const handleLayout = useCallback(
      (e: LayoutChangeEvent) => {
        y.value = e.nativeEvent.layout.y;
        h.value = e.nativeEvent.layout.height;
        const first = !known.has(key);
        known.set(key, {
          y: e.nativeEvent.layout.y,
          h: e.nativeEvent.layout.height,
        });
        // Erst JETZT einblenden: Ab hier steht die Zeile an ihrer Stelle, und
        // die Strecke ist ihre eigene, gerade gemessene Höhe. Beim Aufbau des
        // Bildschirms nicht — dort fährt ohnehin alles schon.
        if (first && enter.value === 0) {
          enter.value =
            allowEnter.value === 1
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
        if (index === 0) firstY.value = e.nativeEvent.layout.y;
        // Die eigene Buchhaltung der Liste MUSS weiterlaufen — sie misst hier
        // ihre Zellen. Ohne das Durchreichen bricht die Virtualisierung.
        onLayout?.(e);
      },
      [onLayout, y, h, key, index, firstY, enter, allowEnter],
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
    const progress = useDerivedValue(() => {
      if (listH.value === 0 || h.value === 0) return 0;
      /**
       * Sichtbare Oberkante der Zeile.
       *
       * Die Liste ist gespiegelt: Ein Inhaltspunkt `p` landet auf der Höhe
       * `listH - (p - scrollY)`. Für die Zeile [y, y+h] ist die sichtbar OBERE
       * Kante damit die des unteren Inhaltsrandes.
       */
      /**
       * Die Nachhol-Strecke gehört HIER hinein.
       *
       * Gerechnet werden muss die Stelle, an der die Zeile GERADE ZU SEHEN ist
       * — nicht die, an der das Layout sie schon führt. Ohne sie wäre die Zeile
       * bereits klein, während sie noch unten steht: genau das Aufblitzen beim
       * Öffnen der Tastatur. So folgt die Größe der Bewegung, statt ihr
       * vorauszulaufen, und beide hängen an derselben Zahl.
       */
      /**
       * Die Verschiebung gehört HIER hinein.
       *
       * Gerechnet werden muss die Stelle, an der die Zeile GERADE ZU SEHEN ist
       * — nicht die, an der das Layout sie schon führt. Ohne sie wäre die Zeile
       * bereits klein, während sie noch unten steht. So folgt die Größe der
       * Bewegung, statt ihr vorauszulaufen, und beide hängen an derselben Zahl.
       */
      const visualTop =
        listH.value - (y.value + h.value) + scrollY.value + slide.value;
      /**
       * Gemessen wird die MITTE, und über eine mit der Höhe wachsende Strecke.
       *
       * An der Oberkante begänne eine hohe Karte zu schrumpfen, während sie noch
       * vollständig im Bild steht; mit fester Strecke kippte sie zudem auf einen
       * Schlag weg. Über die Mitte kippt Großes von selbst später und langsamer.
       */
      const center = visualTop + h.value / 2;
      const len = Math.max(RECEDE_LENGTH, h.value * 0.6);
      const t = Math.min(1, Math.max(0, (RECEDE_START_Y - center) / len));
      /**
       * Sanfter Anlauf, aber er muss auch ANKOMMEN.
       *
       * Vorher quadratisch. Der Anlauf war damit richtig weich, nur blieb der
       * Effekt danach zu klein: Eine Zeile hinter Bo steht typischerweise bei
       * knapp der halben Strecke, und quadratisch sind das 22% — 7% kleiner,
       * 81% Deckkraft. Sichtbar ist das kaum, obwohl sie schon halb verdeckt
       * ist.
       *
       * Eine S-Kurve läuft am Anfang genauso weich an (Steigung null bei null),
       * kommt in der Mitte aber auf 45% und läuft am Ende ebenso weich aus.
       */
      return Math.round(t * t * (3 - 2 * t) * 512) / 512;
    });

    const depth = useAnimatedStyle(() => {
      const e = progress.value;
      const inn = enter.value;
      return {
        opacity: (1 - (1 - RECEDE_MIN_OPACITY) * e) * inn,
        transform: [
          // Der Einzug kommt von unten und ist an die eigene Höhe gebunden —
          // eine hohe Karte legt damit denselben Anteil zurück wie eine kurze
          // Zeile und wirkt nicht schneller.
          { translateY: slide.value + (1 - inn) * (h.value * 0.5 + 12) },
          { scale: 1 - (1 - RECEDE_MIN_SCALE) * e },
        ],
      };
    });

    return (
      <View {...rest} style={style} onLayout={handleLayout}>
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
): Msg[] {
  const rest = messages.filter((m) => m.kind !== "typing");
  if (rest.some((m) => m.kind === "board" && m.botId === botId)) return rest;
  return [...rest, { id: `${botId}:board`, kind: "board", stop, board, botId }];
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
        <StopBoardCard stop={msg.stop} initialBoard={msg.board} />
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
      {msg.text.length > 0 && (
        <View style={[styles.bubble, styles.botBubble]}>
          <RichText text={msg.text} accent={accent} />
        </View>
      )}
    </View>
  );
}

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

function Dot({ delay }: { delay: number }) {
  // Wave-Animation auf Reanimated-Worklet: jeder Dot bobst sanft hoch & runter
  // (translateY -6 → 0) und glow't dabei (opacity 0.35 → 1). Mit phase-versetztem
  // `delay` zwischen den drei Dots entsteht eine elegante Welle, wie wenn Bo
  // gerade tippt. Worklets laufen auf UI-Thread → kein JS-Stutter selbst
  // während Bo's Stream einen großen Response liefert.
  const ty = useSharedValue(0);
  const op = useSharedValue(0.35);

  useEffect(() => {
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
    return () => {
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
  root: { flex: 1, backgroundColor: C.bg, overflow: "hidden" },

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
