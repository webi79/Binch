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
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  View,
  Text,
  FlatList,
  type ListRenderItemInfo,
  Pressable,
  StyleSheet,
  TextInput,
  Platform,
  Keyboard,
  ActivityIndicator,
} from "react-native";
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
} from "react-native-reanimated";
import { Send, Mic, AlertTriangle, RotateCw, X } from "lucide-react-native";
import { Bo, type BoMood } from "@/components/assistant/Bo";
import { VoiceRecordBar } from "@/components/assistant/VoiceRecordBar";
import { ResultCard } from "@/components/results/ResultCard";
import { RippleTouch } from "@/components/ui/RippleTouch";
import { GradientFill } from "@/components/ui/GradientFill";
import { useT } from "@/lib/i18n/useT";
import { useAccent } from "@/lib/theme/accent";
import { haptic } from "@/lib/haptics";
import { useSearchStore } from "@/stores/searchStore";
import { streamChat, todayLocal, ChatApiError, type ChatStreamEvent, type LastSearchParams } from "@/lib/api/chat";
import { pickWelcome } from "@/lib/assistant/welcomes";
import { StopBoardCard } from "@/components/assistant/StopBoardCard";
import type { SearchResult } from "@/types/search";

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
      flight?: SearchResult;
      stopBoard?: {
        stop: { code: string; label: string };
        board: "departures" | "arrivals";
      };
      /** Wenn gesetzt: zeige einen „Alle Treffer anzeigen"-Button unter der
       *  Message. Tap führt zur Navigation in den ResultsScreen. Nicht Auto-
       *  Navigation — User soll selber entscheiden. */
      resultsAction?: LastSearchParams;
    }
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

export default function AssistantScreen() {
  // Lazy-Render-Gate: der Tabs-Navigator mountet uns eager (lazy: false im
  // Layout) damit alle Tab-Switches snappy sind. Aber AssistantScreen ist
  // unser schwerster Tab (Bo + State + Cards), und beim Cold-Start braucht
  // ihn niemand. Wir rendern erst dann den vollen Tree wenn der Tab das
  // erste Mal fokussiert wird — danach bleibt's mounted. Spart Cold-Start-
  // CPU + macht den ersten Wechsel auf Home/Surroundings deutlich smoother.
  const isFocused = useIsFocused();
  const [hasBeenFocused, setHasBeenFocused] = useState(false);
  useEffect(() => {
    if (isFocused && !hasBeenFocused) setHasBeenFocused(true);
  }, [isFocused, hasBeenFocused]);
  if (!hasBeenFocused) return <View style={{ flex: 1, backgroundColor: "#1A1A1A" }} />;

  return <AssistantScreenInner />;
}

function AssistantScreenInner() {
  const t = useT();
  const accent = useAccent();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const isFocused = useIsFocused();
  const locale = useSearchStore((s) => s.locale);
  const currency = useSearchStore((s) => s.currency);
  const authToken = useSearchStore((s) => s.authToken);
  const openAuthOverlay = useSearchStore((s) => s.openAuthOverlay);

  // ?autoVoice=1 wird vom Home-Mic-Tap mitgeschickt → wir starten Voice direkt.
  const params = useLocalSearchParams<{ autoVoice?: string }>();

  // Initial-Werte aus dem Module-Level-State: erste Mount = leere Liste,
  // jedes spätere Re-Mount kriegt die vorhin geführte Konversation zurück.
  const [messages, setMessages] = useState<Msg[]>(() => persistedMessages);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  // voiceMode = true sobald der User Mic gedrückt hat → VoiceRecordBar wird
  // statt der normalen Input-Bar gerendert. listening allein reicht nicht
  // weil bei „Pause" der User die VoiceRecordBar sehen WILL, aber listening
  // dann false ist.
  const [voiceMode, setVoiceMode] = useState(false);
  const [mood, setMood] = useState<BoMood>(() => persistedMood);
  const [listening, setListening] = useState(false);

  // Bei jeder Message- oder Mood-Änderung den Module-Level-Snapshot mit-
  // aktualisieren — sonst gehen Änderungen die nach dem letzten Mount
  // passierten beim nächsten Mount verloren.
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
  const lastKbHeightRef = useRef(320);
  const [kbOffset, setKbOffset] = useState(0);
  const keyboardOpen = kbOffset > 0;
  const [inputbarHeight, setInputbarHeight] = useState(64);

  useEffect(() => {
    const showSub = Keyboard.addListener("keyboardDidShow", (e) => {
      const h = e.endCoordinates?.height ?? 320;
      lastKbHeightRef.current = h;
      setKbOffset(h);
    });
    const hideSub = Keyboard.addListener("keyboardDidHide", () => {
      setKbOffset(0);
    });
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);

  const onInputFocus = useCallback(() => {
    setKbOffset(lastKbHeightRef.current);
  }, []);

  const onInputBlur = useCallback(() => {
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
  const barBottom = keyboardOpen ? kbOffset + BAR_LIFT_FROM_KB : 0;
  const contentPaddingBottom = inputbarHeight + barBottom + MSG_GAP_FROM_BAR;

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
  const barAnimStyle = useAnimatedStyle(() => {
    const kbHeight = Math.max(0, kb.height.value - navInset);
    const lift = interpolate(kbHeight, [0, 80], [0, BAR_LIFT_FROM_KB], Extrapolation.CLAMP);
    return { transform: [{ translateY: -(kbHeight + lift) }] };
  });

  // Welcome-Message beim ersten Mount. Zufällige Variante aus pickWelcome,
  // damit der User nicht immer dieselbe Begrüßung sieht.
  useEffect(() => {
    if (messages.length === 0) {
      setMessages([{ id: idGen(), kind: "bot", text: pickWelcome(locale) }]);
      const id = setTimeout(() => setMood("idle"), 5000);
      return () => clearTimeout(id);
    }
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
      setTimeout(() => {
        if (voiceModeRef.current) void startVoice();
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
  useEffect(() => {
    if (!isFocused) {
      abortRef.current?.abort();
      abortRef.current = null;
      if (listening) stopVoice();
    }
  }, [isFocused, listening, stopVoice]);

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
    };
  }, []);

  // ----- Send + Stream -------------------------------------------------------
  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || busy) return;
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
          })),
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
          authToken,
          signal: ctrl.signal,
          onEvent: (ev) => handleStreamEvent(ev, botId),
        });
      } catch (err) {
        if ((err as Error).name === "AbortError") {
          // Stream wurde abgebrochen (z.B. User wechselt mitten in Bo's
          // Antwort den Tab). Wir räumen den UI-State auf, damit Bo nicht
          // im „thinking"-Mood hängen bleibt und die typing-Bubble nicht
          // ewig sichtbar ist wenn der User zurückkommt.
          setMessages((prev) => prev.filter((m) => m.kind !== "typing"));
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
        if (abortRef.current === ctrl) abortRef.current = null;
        setBusy(false);
        streamingBotIdRef.current = null;
      }
    },
    [busy, locale, currency, t, authToken, openAuthOverlay],
  );

  // Stream-Event-Handler — closure over botId der aktuellen Antwort.
  const handleStreamEvent = useCallback(
    (event: ChatStreamEvent, botId: string) => {
      switch (event.type) {
        case "mood":
          setMood(event.mood);
          return;
        case "text":
          setMessages((prev) => appendBotText(prev, botId, event.delta));
          return;
        case "search_result":
          // Such-Params merken — der nächste Request schickt sie zurück,
          // damit Tools wie open_all_results den Kontext der vorigen Suche
          // wieder zur Verfügung haben.
          lastSearchRef.current = event.params;
          setMessages((prev) => attachFlightToBot(prev, botId, event.result));
          return;
        case "stop_board":
          // Stop-Board-Hint vom Server — Karte inline rendern. Die Live-
          // Daten holt die Karte selbst direkt über /api/stops/:code/{board}.
          if (__DEV__) console.log("[chat] stop_board:", event.stop.code, event.stop.label, event.board);
          setMessages((prev) => attachStopBoardToBot(prev, botId, event.stop, event.board));
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
              setMessages((prev) => attachResultsActionToBot(prev, botId, params));
            }
            return;
          }
          // save_trip / unsave_trip — letzten Flight aus dem Verlauf nehmen.
          setMessages((prev) => {
            const lastFlight = [...prev]
              .reverse()
              .find((m): m is Extract<Msg, { kind: "bot"; flight?: SearchResult }> =>
                m.kind === "bot" && m.flight !== undefined,
              )?.flight;
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

  return (
    // Chat-Layout: FlatList full-height, Inputbar overlay'd absolut darüber.
    // Der letzte sichtbare Bubble wird über contentContainer.paddingBottom
    // geschützt → er steht immer über dem Inputbar, egal ob Keyboard auf
    // oder zu ist.
    <View style={styles.root}>
        {/* Slim Top-Bar: Binch-Logo links, Close-Button rechts. Da wir die
            FloatingTabBar im Chat verstecken, ist X der einzige Weg zurück
            (System-Back funktioniert nicht zwischen Tab-Geschwistern). */}
      <View style={[styles.topbar, { paddingTop: insets.top + 20 }]}>
        <Text style={styles.brand}>
          B<Text style={[styles.brandI, { color: accent.solid }]}>i</Text>nch
        </Text>
        <Pressable
          onPress={() => {
            haptic("button");
            // Versuche Stack-Back; falls keine History (Direct-Open), fallback
            // auf Home-Tab.
            if (router.canGoBack()) router.back();
            else router.navigate("/");
          }}
          hitSlop={10}
          style={styles.closeBtn}
          accessibilityLabel="Close"
        >
          <X size={20} color="#E5E7EB" strokeWidth={2} />
        </Pressable>
      </View>

      {/* Bo + Mood-Label.
          `paused={!isFocused}` schaltet Bo's Reanimated-Worklets ab wenn der
          User auf einem anderen Tab ist. Ohne das laufen 5-8 endlose Repeats
          (Schweben, Blinzeln, ggf. Wink/Yap) auf der UI-Thread im Hinter-
          grund weiter — verlangsamt jeden anderen Tab spürbar. */}
      <View style={styles.hero}>
        <Bo state={mood} size={120} paused={!isFocused || isScrolling} />
        <Text style={[styles.mood, mood === "error" && { color: C.error }]}>
          {moodLabel.toUpperCase()}
        </Text>
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
      <FlatList
        ref={scrollRef}
        data={reversedMessages}
        keyExtractor={keyExtractor}
        renderItem={renderItem}
        inverted
        style={styles.thread}
        // Mit inverted: paddingTop ist visuell unten. contentPaddingBottom
        // reserviert dort Platz für Bar + Lift + Gap. Snap via React-State.
        contentContainerStyle={[
          styles.threadContent,
          { paddingTop: contentPaddingBottom, paddingBottom: 8 },
        ]}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        removeClippedSubviews={false}
        windowSize={21}
        initialNumToRender={20}
        maxToRenderPerBatch={10}
        onScrollBeginDrag={() => {
          if (scrollEndTimeoutRef.current) {
            clearTimeout(scrollEndTimeoutRef.current);
            scrollEndTimeoutRef.current = null;
          }
          setIsScrolling(true);
        }}
        onScrollEndDrag={() => {
          if (scrollEndTimeoutRef.current) clearTimeout(scrollEndTimeoutRef.current);
          scrollEndTimeoutRef.current = setTimeout(() => {
            setIsScrolling(false);
            scrollEndTimeoutRef.current = null;
          }, 120);
        }}
        onMomentumScrollBegin={() => {
          if (scrollEndTimeoutRef.current) {
            clearTimeout(scrollEndTimeoutRef.current);
            scrollEndTimeoutRef.current = null;
          }
          setIsScrolling(true);
        }}
        onMomentumScrollEnd={() => {
          setIsScrolling(false);
        }}
      />

      {/* Input-Bar Wrapper — absolut bei bottom:0, die Hochbewegung kommt
          frame-synced mit dem Keyboard via barAnimStyle (useAnimatedKeyboard,
          UI-Thread). onLayout misst die echte Bar-Höhe für die
          contentPaddingBottom-Berechnung. */}
      <Animated.View
        style={[styles.inputbarWrap, barAnimStyle]}
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
      <View style={[styles.inputbar, { paddingBottom: inputbarPadBottom }]}>
        <View style={styles.field}>
          <TextInput
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
    </View>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function idGen(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function replaceTyping(messages: Msg[], next: Msg): Msg[] {
  const filtered = messages.filter((m) => m.kind !== "typing");
  return [...filtered, next];
}

function appendBotText(messages: Msg[], botId: string, delta: string): Msg[] {
  // Erste Text-Delta → Typing-Bubble durch Bot-Bubble ersetzen UND den Bot-
  // Bubble mit der reservierten ID anlegen. Folge-Deltas appenden an die ID.
  const idx = messages.findIndex((m) => m.id === botId);
  if (idx === -1) {
    return [
      ...messages.filter((m) => m.kind !== "typing"),
      { id: botId, kind: "bot", text: delta },
    ];
  }
  return messages.map((m, i) =>
    i === idx && m.kind === "bot" ? { ...m, text: m.text + delta } : m,
  );
}

function attachFlightToBot(messages: Msg[], botId: string, flight: SearchResult): Msg[] {
  const idx = messages.findIndex((m) => m.id === botId);
  if (idx === -1) {
    // Noch kein Text-Delta zur Bot-Bubble → leere Bubble mit Flight anlegen
    // (Text füllt sich dann mit der Folge-Delta).
    return [
      ...messages.filter((m) => m.kind !== "typing"),
      { id: botId, kind: "bot", text: "", flight },
    ];
  }
  return messages.map((m, i) =>
    i === idx && m.kind === "bot" ? { ...m, flight } : m,
  );
}

function attachStopBoardToBot(
  messages: Msg[],
  botId: string,
  stop: { code: string; label: string },
  board: "departures" | "arrivals",
): Msg[] {
  const idx = messages.findIndex((m) => m.id === botId);
  const stopBoard = { stop, board };
  if (idx === -1) {
    return [
      ...messages.filter((m) => m.kind !== "typing"),
      { id: botId, kind: "bot", text: "", stopBoard },
    ];
  }
  return messages.map((m, i) =>
    i === idx && m.kind === "bot" ? { ...m, stopBoard } : m,
  );
}

function attachResultsActionToBot(
  messages: Msg[],
  botId: string,
  params: LastSearchParams,
): Msg[] {
  const idx = messages.findIndex((m) => m.id === botId);
  if (idx === -1) {
    return [
      ...messages.filter((m) => m.kind !== "typing"),
      { id: botId, kind: "bot", text: "", resultsAction: params },
    ];
  }
  return messages.map((m, i) =>
    i === idx && m.kind === "bot" ? { ...m, resultsAction: params } : m,
  );
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

  if (msg.kind === "user") {
    return (
      <View style={[styles.bubble, styles.userBubble, { backgroundColor: accent }]}>
        <Text style={[styles.userText, { color: "#000000" }]}>{msg.text}</Text>
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
      {msg.flight && (
        <View style={styles.flightWrap}>
          <ResultCard result={msg.flight} />
        </View>
      )}
      {msg.stopBoard && (
        <View style={styles.flightWrap}>
          <StopBoardCard stop={msg.stopBoard.stop} initialBoard={msg.stopBoard.board} />
        </View>
      )}
      {msg.resultsAction && (
        <View style={styles.flightWrap}>
          <RippleTouch
            style={styles.resultsButton}
            onPress={() => onOpenResults(msg.resultsAction!)}
          >
            <GradientFill />
            <Text style={styles.resultsButtonText}>
              {t("assistant.button.allResults")}
            </Text>
          </RippleTouch>
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

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },

  // Topbar-Padding + Brand-Typografie spiegeln Home's headerRow / logoHeading
  // (siehe app/(tabs)/index.tsx) — damit der „Binch"-Schriftzug auf dem
  // Assistant-Tab dieselbe Größe und Position hat wie auf der Landing-Page.
  // paddingTop kommt INLINE als `insets.top + 16` (Home: insets.top+8 von
  // scrollContent + 8 von headerRow). Hier statisch nur die anderen Werte.
  topbar: {
    paddingHorizontal: 22,
    paddingBottom: 14,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  brand: { fontSize: 26, fontWeight: "900", letterSpacing: -0.6, color: C.white },
  brandI: {},
  closeBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
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
  hero: {
    alignItems: "center",
    justifyContent: "flex-end",
    marginTop: -33,
    marginBottom: -10,
  },
  mood: {
    marginTop: -15,
    fontSize: 11,
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
