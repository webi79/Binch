import { useState, useEffect } from "react";
import { View, Text, Pressable, ActivityIndicator } from "react-native";
import { useAppBg, usePalette } from "@/lib/theme/appBg";
import { showAlert } from "@/lib/alert";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { Mic, X } from "lucide-react-native";
import { parseVoice } from "@/lib/voice/parse";
import { useSearchStore } from "@/stores/searchStore";
import { fetchLocations } from "@/lib/api/client";
import { useT } from "@/lib/i18n/useT";
import { useAccent } from "@/lib/theme/accent";

let ExpoSpeechRecognitionModule: any = null;
let useSpeechRecognitionEvent: (name: string, cb: (e: any) => void) => void = () => {};
try {
  const mod = require("expo-speech-recognition");
  ExpoSpeechRecognitionModule = mod.ExpoSpeechRecognitionModule;
  useSpeechRecognitionEvent = mod.useSpeechRecognitionEvent;
} catch {
  // Native module unavailable (e.g. Expo Go without a dev client build).
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
function looksLikeMatch(spoken: string, loc?: { label?: string; city?: string; code?: string }): boolean {
  if (!loc) return false;
  const norm = (v: string) =>
    v
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]/g, "");
  const q = norm(spoken);
  if (!q) return false;
  return [loc.label, loc.city, loc.code]
    .filter(Boolean)
    .some((v) => {
      const n = norm(String(v));
      return n.includes(q) || q.includes(n);
    });
}

export default function VoiceScreen() {
  const appBg = useAppBg();
  const palette = usePalette();
  const accent = useAccent();
  const router = useRouter();
  const t = useT();
  const locale = useSearchStore((s) => s.locale);
  const currency = useSearchStore((s) => s.currency);

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
    ExpoSpeechRecognitionModule?.stop?.();
    setListening(false);
  }

  async function handleFinal(text: string) {
    setBusy(true);
    try {
      const parsed = parseVoice(text);
      if (!parsed.origin || !parsed.destination) {
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
        router.replace({ pathname: `/search/${parsed.mode.toLowerCase()}s` as any });
        return;
      }
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
    <SafeAreaView style={{ flex: 1, backgroundColor: appBg }} edges={["top"]}>
      <View className="flex-row items-center justify-end px-4 py-3">
        <Pressable
          onPress={() => router.back()}
          hitSlop={10}
          className="w-10 h-10 rounded-full border items-center justify-center"
          style={{ backgroundColor: palette.s2, borderColor: palette.border }}
        >
          <X color="#E5E7EB" size={20} />
        </Pressable>
      </View>
      <View className="flex-1 items-center justify-center px-6 gap-8">
        <Pressable
          onPress={listening ? stop : start}
          disabled={busy}
          className="w-24 h-24 rounded-full items-center justify-center shadow-lg"
          style={({ pressed }) => ({ backgroundColor: accent.solid, opacity: pressed ? 0.85 : 1 })}
        >
          {busy ? <ActivityIndicator color="#000" /> : <Mic color="#000000" size={40} />}
        </Pressable>
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
