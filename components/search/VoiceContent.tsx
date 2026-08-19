import { useState, useEffect } from "react";
import { View, Text, Pressable, ActivityIndicator } from "react-native";
import { showAlert } from "@/lib/alert";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { Mic, X } from "lucide-react-native";
import { parseVoice } from "@/lib/voice/parse";
import { useSearchStore } from "@/stores/searchStore";
import { fetchLocations } from "@/lib/api/client";
import { useT } from "@/lib/i18n/useT";
import { usePalette } from "@/lib/theme/appBg";
import { haptic } from "@/lib/haptics";
import { RippleTouch } from "@/components/ui/RippleTouch";
import { useAccent } from "@/lib/theme/accent";

let ExpoSpeechRecognitionModule: any = null;
let useSpeechRecognitionEvent: (name: string, cb: (e: any) => void) => void = () => {};
try {
  const mod = require("expo-speech-recognition");
  ExpoSpeechRecognitionModule = mod.ExpoSpeechRecognitionModule;
  useSpeechRecognitionEvent = mod.useSpeechRecognitionEvent;
} catch {
  // Native module unavailable (Expo Go without dev client).
}


/**
 * Passt der gefundene Ort überhaupt zu dem, was gesagt wurde?
 *
 * Ohne diese Prüfung wurde der ERSTE Autocomplete-Treffer blind übernommen. Das
 * ist die teuerste Bugklasse dieses Projekts: „Roma" wurde so schon zu
 * „Re di Roma", ein Berliner Fernbus-Halt zu einem in Mannheim. Der Nutzer sieht
 * keine Rückfrage — er sieht nur falsche Verbindungen und hält sie für echt.
 *
 * Verglichen wird großzügig (Akzente, Groß-/Kleinschreibung, Teilstrings), aber
 * es MUSS eine Beziehung zwischen Gesagtem und Gefundenem geben.
 */
/** Siehe `looksLikeMatch`: Wörter, die keinen Ort bezeichnen. */
const GENERIC_WORDS = new Set([
  "zob", "hbf", "hauptbahnhof", "bahnhof", "bhf", "flughafen", "airport",
  "aeroport", "aeropuerto", "aeroporto", "gare", "estacion", "stazione",
  "station", "terminal", "bus", "busbahnhof", "central", "centrale", "centro",
  "city", "stadt", "nord", "sued", "ost", "west", "north", "south", "east",
  "international", "main", "airportbahnhof",
]);

function looksLikeMatch(spoken: string, loc?: { label?: string; city?: string; code?: string }): boolean {
  if (!loc) return false;
  const norm = (v: string) =>
    v
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]/g, "");
  /**
   * Über WÖRTER vergleichen, nicht über Teilstrings — und den Code exakt.
   *
   * Der Teilstring-Vergleich lief in beide Richtungen, und damit reichte ein
   * dreibuchstabiger Code, der zufällig im Gesagten vorkommt: „berlin" enthält
   * „lin", also galt Mailand-Linate als Treffer für Berlin. Das ist genau die
   * Bugklasse, gegen die diese Prüfung geschrieben wurde — nur andersherum.
   *
   * Gleichzeitig war er zu streng, wo er großzügig sein soll: „Frankfurt
   * Flughafen" und „Frankfurt am Main Airport" enthalten einander nicht,
   * teilen aber das entscheidende Wort.
   */
  const words = (v: string) =>
    v
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 3);

  const q = norm(spoken);
  if (!q) return false;
  // Ein Code zählt nur, wenn er GENAU das Gesagte ist („BER" für „ber").
  if (loc.code && norm(loc.code) === q) return true;

  /**
   * Gattungswörter auch auf DIESER Seite streichen.
   *
   * Sie flogen nur aus dem Treffer, nicht aus dem Gesagten — damit konnte ein
   * Gattungswort allein die Beziehung tragen: „Frankfurt am **Main**" passt so
   * auf „**Main**z", weil „main" der Anfang von „mainz" ist. Genau die
   * Bugklasse, gegen die diese Funktion geschrieben ist.
   */
  const spokenWords = words(spoken).filter((w) => !GENERIC_WORDS.has(w));
  if (spokenWords.length === 0) return false;
  const found = new Set([...words(loc.label ?? ""), ...words(loc.city ?? "")]);
  if (found.size === 0) return false;
  /**
   * Wortanfang zählt mit: „Rom" ist im Deutschen der übliche Name für „Rome",
   * „Wien" für „Vienna" nicht — das ist die Grenze dieser Prüfung, und sie ist
   * bewusst hier: Exonyme löst der Server, hier geht es nur darum, einen
   * offensichtlich fremden Treffer abzuweisen.
   */
  /**
   * Gattungswörter zählen NICHT als Beziehung.
   *
   * Sonst passt „Berlin ZOB" auf „Mannheim ZOB", weil beide „ZOB" enthalten —
   * und genau dieser Fall steht oben als Beispiel für die teuerste Bugklasse
   * dieses Projekts. Was verbindet, muss der ORTSNAME sein, nicht die Art der
   * Haltestelle.
   */
  const list = [...found].filter((w) => !GENERIC_WORDS.has(w));
  return spokenWords.some((w) => list.some((x) => x.startsWith(w) || w.startsWith(x)));
}

interface Props {
  onClose: () => void;
}

export function VoiceContent({ onClose }: Props) {
  const router = useRouter();
  const t = useT();
  const accent = useAccent();
  const palette = usePalette();
  const locale = useSearchStore((s) => s.locale);
  const currency = useSearchStore((s) => s.currency);
  const closeSearchOverlay = useSearchStore((s) => s.closeSearchOverlay);

  const [transcript, setTranscript] = useState("");

  // Mikrofon IMMER freigeben, wenn dieser Bildschirm verschwindet.
  //
  // Es gab keinen Abbau-Pfad: Schloss man über X, die Zurück-Geste oder durch
  // einen Tab-Wechsel, lief die native Erkennung samt Mikrofon-Anzeige einfach
  // weiter. Der Assistent macht es richtig vor und stoppt bei Fokusverlust.
  useEffect(
    () => () => {
      try {
        ExpoSpeechRecognitionModule?.abort?.();
      } catch {
        // Modul nicht verfügbar (Expo Go) — nichts zu tun.
      }
    },
    [],
  );
  const [listening, setListening] = useState(false);
  const [busy, setBusy] = useState(false);

  useSpeechRecognitionEvent("result", (e) => {
    const text = e.results?.[0]?.transcript ?? "";
    if (text) setTranscript(text);
  });
  useSpeechRecognitionEvent("end", async () => {
    setListening(false);
    if (transcript) await handleFinal(transcript);
  });
  useSpeechRecognitionEvent("error", (e) => {
    setListening(false);
    // `no-speech` ist auf Android der normale Stille-Timeout und kommt bei JEDER
    // Pause. Dafür einen (unübersetzten) Alarm zu zeigen, ist schlicht falsch —
    // der Assistent unterscheidet das bereits korrekt.
    const code = e.error ?? "unknown";
    if (code === "no-speech" || code === "aborted" || code === "client") return;
    showAlert(t("voice.error") || "Speech error", code);
  });

  async function start() {
    haptic("button");
    if (!ExpoSpeechRecognitionModule) {
      showAlert(t("voice.unsupported"));
      return;
    }
    const perm = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
    if (!perm.granted) {
      showAlert(t("voice.unsupported"));
      return;
    }
    setTranscript("");
    setListening(true);
    ExpoSpeechRecognitionModule.start({
      lang: locale === "de" ? "de-DE" : locale === "fr" ? "fr-FR" : locale === "es" ? "es-ES" : "en-US",
      interimResults: true,
      continuous: false,
    });
  }

  function stop() {
    haptic("button");
    ExpoSpeechRecognitionModule?.stop?.();
    setListening(false);
  }

  async function handleFinal(text: string) {
    setBusy(true);
    try {
      const parsed = parseVoice(text);
      if (!parsed.origin || !parsed.destination) {
        onClose();
        closeSearchOverlay();
        router.replace({ pathname: `/search/${parsed.mode.toLowerCase()}s` as any });
        return;
      }
      const [originLocs, destLocs] = await Promise.all([
        fetchLocations(parsed.origin, parsed.mode).catch(() => []),
        fetchLocations(parsed.destination, parsed.mode).catch(() => []),
      ]);
      // Namensprüfung statt blind results[0] — siehe looksLikeMatch.
      const o = originLocs.find((l) => looksLikeMatch(parsed.origin!, l));
      const d = destLocs.find((l) => looksLikeMatch(parsed.destination!, l));
      if (!o || !d || !parsed.departDate) {
        onClose();
        closeSearchOverlay();
        router.replace({ pathname: `/search/${parsed.mode.toLowerCase()}s` as any });
        return;
      }
      onClose();
      closeSearchOverlay();
      router.replace({
        pathname: "/search/results",
        params: {
          mode: parsed.mode,
          origin: o.code,
          destination: d.code,
          originLabel: o.label,
          destLabel: d.label,
          departDate: parsed.departDate,
          passengers: "1",
          currency,
        },
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <SafeAreaView className="flex-1" style={{ backgroundColor: palette.s1 }} edges={["top"]}>
      <View className="flex-row items-center justify-end px-4 py-3">
        <RippleTouch
          onPress={() => {
            haptic("button");
            onClose();
          }}
          hitSlop={10}
          className="w-10 h-10 rounded-full border items-center justify-center"
          style={{ backgroundColor: palette.s2, borderColor: palette.border }}
          borderless
        >
          <X color="#E5E7EB" size={20} />
        </RippleTouch>
      </View>
      <View className="flex-1 items-center justify-center px-6 gap-8">
        <RippleTouch
          onPress={listening ? stop : start}
          disabled={busy}
          className="w-24 h-24 rounded-full items-center justify-center shadow-lg"
          rippleColor="rgba(0,0,0,0.32)"
          style={({ pressed }) => ({ backgroundColor: accent.solid, opacity: pressed ? 0.85 : 1 })}
        >
          {busy ? <ActivityIndicator color="#000" /> : <Mic color="#000000" size={40} />}
        </RippleTouch>
        <Text className="text-lg text-center text-white">
          {listening ? t("voice.listening") : t("voice.start")}
        </Text>
        {transcript ? (
          <View className="border rounded-2xl px-4 py-3 max-w-full" style={{ backgroundColor: palette.s2, borderColor: palette.border }}>
            <Text className="text-base text-gray-300 text-center italic">
              &ldquo;{transcript}&rdquo;
            </Text>
          </View>
        ) : null}
      </View>
    </SafeAreaView>
  );
}
