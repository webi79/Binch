/**
 * „Test-Mitteilung senden" — Profil → Einstellungen → Mitteilungen.
 *
 * Prüft die letzte Meile selbst: Der Server schickt nach 10 s (Zeit genug, die
 * App zu schließen) über denselben Weg und Kanal wie die Erinnerungen
 * (lib/notifications/testPush.ts). Kommt sie bei offener App an, steht hier
 * „Angekommen"; bei geschlossener zeigt sie das Handy selbst — oder eben
 * nicht, und dafür steht auf Handys mit strengem Akku-Sparen darunter, woran
 * es dann fast immer liegt.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Linking, Platform, View } from "react-native";
import { BatteryWarning, Send } from "lucide-react-native";
import { useT } from "@/lib/i18n/useT";
import { haptic } from "@/lib/haptics";
import { ensurePushToken, onTestArrived } from "@/lib/notifications/push";
import { sendTestPush, TEST_DELAY_SEC, type TestPushResult } from "@/lib/notifications/testPush";
import { ActionRow, ListCard, NoticeRow, SectionTitle } from "@/components/settings/SettingsBlocks";
import { scaledStyles } from "@/lib/ui/compact";
import { SPACE } from "@/lib/theme/spacing";

/**
 * Hersteller, deren Akku-Sparen Apps im Hintergrund zurückhält — dann nimmt
 * Firebase die Mitteilung an, und das Handy zeigt sie nicht (dontkillmyapp.com).
 */
const STRICT_BRANDS = ["xiaomi", "redmi", "poco", "huawei", "honor", "oppo", "realme", "oneplus", "vivo", "meizu"];

function strictBrand(): string | null {
  if (Platform.OS !== "android") return null;
  try {
    const c = Platform.constants as { Brand?: string; Manufacturer?: string } | undefined;
    const name = c?.Manufacturer || c?.Brand || "";
    const lower = name.toLowerCase();
    if (!STRICT_BRANDS.some((b) => lower.includes(b))) return null;
    return name.charAt(0).toUpperCase() + name.slice(1);
  } catch {
    return null;
  }
}

type Phase =
  | { kind: "idle" }
  | { kind: "busy" }
  | { kind: "count"; left: number }
  | { kind: "sent" }
  | { kind: "arrived" }
  | { kind: "error"; result: Exclude<TestPushResult, "queued"> };

export function DeliveryTest({ disabled }: { disabled: boolean }) {
  const t = useT();
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const ticker = useRef<ReturnType<typeof setInterval> | null>(null);
  const brand = useMemo(strictBrand, []);

  const stopTicker = () => {
    if (ticker.current) clearInterval(ticker.current);
    ticker.current = null;
  };

  useEffect(() => {
    const off = onTestArrived(() => {
      stopTicker();
      setPhase({ kind: "arrived" });
    });
    return () => {
      off();
      stopTicker();
    };
  }, []);

  const run = async () => {
    if (phase.kind === "busy" || phase.kind === "count") return;
    haptic("button");
    setPhase({ kind: "busy" });
    const send = () => sendTestPush(t("settings.test.pushTitle"), t("settings.test.pushBody"));
    let result = await send();
    // Noch nie erlaubt: Wer eine Test-Mitteilung will, wird jetzt gefragt.
    if (result === "noToken" && (await ensurePushToken()).ok) result = await send();
    if (result !== "queued") {
      setPhase({ kind: "error", result });
      return;
    }
    let left = TEST_DELAY_SEC;
    setPhase({ kind: "count", left });
    stopTicker();
    ticker.current = setInterval(() => {
      left -= 1;
      if (left <= 0) stopTicker();
      setPhase((p) => (p.kind === "arrived" ? p : left <= 0 ? { kind: "sent" } : { kind: "count", left }));
    }, 1000);
  };

  const status =
    phase.kind === "busy"
      ? "…"
      : phase.kind === "count"
        ? t("settings.test.in").replace("{n}", String(phase.left))
        : phase.kind === "sent"
          ? t("settings.test.sent")
          : phase.kind === "arrived"
            ? t("settings.test.arrived")
            : phase.kind === "error"
              ? t(
                  phase.result === "tooSoon"
                    ? "settings.test.tooSoon"
                    : phase.result === "noToken"
                      ? "settings.test.noPermission"
                      : "settings.test.failed",
                )
              : undefined;

  return (
    <View>
      <SectionTitle text={t("settings.test.section")} />
      <ListCard>
        <ActionRow
          Icon={Send}
          label={t("settings.test.label")}
          desc={t("settings.test.desc")}
          status={status}
          onPress={() => void run()}
          disabled={disabled}
          isLast
        />
      </ListCard>
      {brand ? (
        <View style={styles.hint}>
          <NoticeRow
            Icon={BatteryWarning}
            title={t("settings.test.brandHint").replace("{brand}", brand)}
            action={t("settings.test.openAppInfo")}
            onPress={() => void Linking.openSettings()}
          />
        </View>
      ) : null}
    </View>
  );
}

const styles = scaledStyles({
  hint: { marginTop: SPACE.sm },
});
