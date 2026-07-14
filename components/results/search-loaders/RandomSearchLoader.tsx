/**
 * Such-Lade-Animation für den Results-Screen. Beim Mount wird zufällig
 * EINE der vier Bo-Animationen ausgewählt (25% Chance pro Variante). Die
 * gewählte Szene bleibt bis zum Unmount stabil.
 *
 * Wird statt des einfachen ActivityIndicator angezeigt während die Suche
 * läuft — sitzt unter der Such-Kriterien-Box am oberen Rand.
 */
import { useEffect, useMemo, type ReactElement } from "react";
import { View, StyleSheet } from "react-native";
import { GlobetrotterScene } from "./GlobetrotterScene";
import { DealHunterScene } from "./DealHunterScene";
import { GreetingScene } from "./GreetingScene";
import { WeatherScene } from "./WeatherScene";
import { useT } from "@/lib/i18n/useT";
import { LoaderPausedContext, SpruecheLine } from "./SearchSceneChrome";

interface Props {
  originLabel: string;
  destLabel: string;
  /** Wird bei JEDEM vollen Cycle-Ende aufgerufen (also alle cycleMs). Der
   *  Caller (Results-Screen) nutzt das als „natürlichen Cut-Point": sobald
   *  die API fertig ist UND der nächste Cycle-Puls feuert, schaltet er auf
   *  die Tickets um. So wird eine laufende Animation NIE mittendrin
   *  abgebrochen — sie spielt immer bis zum nächsten Cycle-Ende durch. */
  onCyclePulse?: () => void;
  /** Wenn true bleiben alle Scene-Animationen pausiert (kein Worklet
   *  initialisiert, keine setInterval laufen). Die Scene-Bilder rendern
   *  trotzdem normal — der User sieht das statische Frame 0. Sobald auf
   *  false gewechselt wird, fangen alle Animationen synchron an zu spielen.
   *  Genutzt vom Results-Screen während der Slide-In-Animation. */
  paused?: boolean;
}

type Variant = "globe" | "deal" | "greet" | "weather";

/** Dauer eines vollen Animation-Cycles pro Variante (ms). Muss zu den
 *  withRepeat-Timings in den Scenes passen. */
const CYCLE_MS_BY_VARIANT: Record<Variant, number> = {
  globe: 5000, // useArcMotion(5000) — ein voller Arc
  deal: 5500, // chip-stagger bis ~2600ms + 2700ms drop = 5300ms + Puffer
  greet: 3400, // MiniPlane traverse 3400ms
  weather: 5000, // useArcMotion(5000)
};

/**
 * Die Sprüche standen hier als deutsche String-Literale — die App zeigte sie
 * also auch bei französischer Oberfläche auf Deutsch. Jetzt sind es
 * Dictionary-Keys; den Text holt useT() zur Sprache des Users.
 */
const SPRUCH_KEYS_BY_VARIANT: Record<Variant, string[]> = {
  globe: ["loader.globe.1", "loader.globe.2", "loader.globe.3"],
  deal: ["loader.deal.1", "loader.deal.2", "loader.deal.3"],
  greet: ["loader.greet.1", "loader.greet.2", "loader.greet.3"],
  weather: ["loader.weather.1", "loader.weather.2", "loader.weather.3"],
};

function pickVariant(): Variant {
  const variants: Variant[] = ["globe", "deal", "greet", "weather"];
  return variants[Math.floor(Math.random() * variants.length)]!;
}

export function RandomSearchLoader({ originLabel, destLabel, onCyclePulse, paused = false }: Props) {
  // Nur EINMAL beim Mount würfeln — sonst flackerts beim Re-Render.
  const t = useT();
  const variant = useMemo(() => pickVariant(), []);
  const sprueche = useMemo(
    () => SPRUCH_KEYS_BY_VARIANT[variant].map((k) => t(k)),
    [variant, t],
  );

  // Pulse-Interval: jeder vollendete Cycle ruft den Callback. Caller
  // entscheidet ob er beim nächsten Pulse auf die Tickets umschalten will
  // (Daten schon da) oder weiter warten lässt.
  useEffect(() => {
    if (!onCyclePulse || paused) return;
    const id = setInterval(() => onCyclePulse(), CYCLE_MS_BY_VARIANT[variant]);
    return () => clearInterval(id);
  }, [variant, onCyclePulse, paused]);

  // Origin/Destination als 3-Letter-Code für die Map-Pin-Labels (Globetrotter).
  const originCode = useMemo(() => abbreviate(originLabel), [originLabel]);
  const destCode = useMemo(() => abbreviate(destLabel), [destLabel]);

  let scene: ReactElement;
  if (variant === "globe") {
    scene = <GlobetrotterScene originCode={originCode} destCode={destCode} />;
  } else if (variant === "deal") {
    scene = <DealHunterScene />;
  } else if (variant === "greet") {
    scene = <GreetingScene destLabel={destLabel} />;
  } else {
    scene = <WeatherScene destLabel={destLabel} />;
  }

  return (
    <LoaderPausedContext.Provider value={paused}>
      <View style={styles.wrap}>
        <View style={styles.sceneWrap}>{scene}</View>
        <SpruecheLine items={sprueche} />
      </View>
    </LoaderPausedContext.Provider>
  );
}

/** „Berlin Hbf" → „BER", „München Flughafen" → „MUC". Sehr grobe Heuristik
 *  — die Mini-Codes sind nur Deko in der Animation, kein echter IATA. */
function abbreviate(label: string): string {
  if (!label) return "—";
  const cleaned = label.replace(/[(),]/g, " ").trim();
  const first = cleaned.split(/\s+/)[0] ?? "";
  return first.slice(0, 3).toUpperCase() || "—";
}

const styles = StyleSheet.create({
  wrap: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 16,
    paddingHorizontal: 16,
  },
  sceneWrap: { alignItems: "center", justifyContent: "center" },
});
