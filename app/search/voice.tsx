import { useState } from "react";
import { View, Text, Pressable, ActivityIndicator } from "react-native";
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

export default function VoiceScreen() {
  const accent = useAccent();
  const router = useRouter();
  const t = useT();
  const locale = useSearchStore((s) => s.locale);
  const currency = useSearchStore((s) => s.currency);

  const [transcript, setTranscript] = useState("");
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
    showAlert("Speech error", e.error ?? "unknown");
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
      const o = originLocs[0];
      const d = destLocs[0];
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
    <SafeAreaView className="flex-1 bg-[#1A1A1A]" edges={["top"]}>
      <View className="flex-row items-center justify-end px-4 py-3">
        <Pressable
          onPress={() => router.back()}
          hitSlop={10}
          className="w-10 h-10 rounded-full bg-[#1F1F20] border border-[#2E2E30] items-center justify-center"
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
          <View className="bg-[#1F1F20] border border-[#2E2E30] rounded-2xl px-4 py-3 max-w-full">
            <Text className="text-base text-gray-300 text-center italic">
              &ldquo;{transcript}&rdquo;
            </Text>
          </View>
        ) : null}
      </View>
    </SafeAreaView>
  );
}
