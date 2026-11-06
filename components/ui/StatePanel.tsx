/**
 * Leerer, Fehler- oder Anmelde-Zustand — mit einer Zeichnung statt nackter
 * Textzeilen (04.11.2026, „Dead Screens"). Titel und Satz sagen, was los ist,
 * EIN Knopf, was jetzt geht.
 *
 * Die Zeichnung ist eine Strichzeichnung (`StateArt`), kein Bo: „Bo sitzt
 * mittlerweile überall … man hat sich satt gesehen" (04.11.2026). Bo gibt es
 * hier nur noch, wo er selbst gemeint ist (`bo`, z. B. „Lass Bo für dich
 * aufpassen" im Bo-Fenster) — und auch dort lebt er nur, solange man ihn sieht
 * (`active`), und dann nur ein paar Sekunden.
 *
 * WARUM SO STRENG: Bo bewegt SVG-Teile, und die laufen auf Fabric über einen
 * Commit je Bild. Diese Flächen bleiben oft unsichtbar eingehängt — die Seite
 * „Geplant" nach dem ersten Öffnen, die Schublade im vorgebauten Bo-Fenster,
 * ein verdecktes Blatt. Ein frei laufender Bo dort machte die GANZE App zäh,
 * Karte zuerst (04.11.2026).
 *
 * `active`: Ist die Fläche gerade zu sehen? Bis dahin zeichnet sich nichts,
 * Bo schläft.
 */
import { useEffect, useState } from "react";
import { ActivityIndicator, Text, View, type StyleProp, type ViewStyle } from "react-native";
import Animated, { FadeInDown } from "react-native-reanimated";
import { Bo, type BoMood } from "@/components/assistant/Bo";
import { RippleTouch } from "@/components/ui/RippleTouch";
import { StateArt, type StateArtKind } from "@/components/ui/StateArt";
import { useAccent } from "@/lib/theme/accent";
import { GROUP_GAP, ITEM_GAP, SECTION_GAP } from "@/lib/theme/spacing";
import { ms, scaledStyles } from "@/lib/ui/compact";

const WHITE = "#F4F4F5";
const G2 = "#8E8E93";
const RISE = 340;
/**
 * Bo wacht erst auf, wenn die Fläche angekommen ist (Fenster- oder
 * Blatt-Einfahrt um 300–450 ms) — seine Bewegung läuft über Commits und hat in
 * einer Fahrt nichts zu suchen. Dann bewegt er sich `BO_AWAKE_MS` lang und
 * steht still.
 */
const BO_WAKE_DELAY_MS = 480;
const BO_AWAKE_MS = 5200;

/** Bo lebt nur, solange er zu sehen ist, und dann nur kurz. */
function useBoAwake(on: boolean): boolean {
  const [awake, setAwake] = useState(false);
  useEffect(() => {
    if (!on) {
      setAwake(false);
      return;
    }
    const wake = setTimeout(() => setAwake(true), BO_WAKE_DELAY_MS);
    const sleep = setTimeout(() => setAwake(false), BO_WAKE_DELAY_MS + BO_AWAKE_MS);
    return () => {
      clearTimeout(wake);
      clearTimeout(sleep);
    };
  }, [on]);
  return awake;
}

export function StatePanel({
  art,
  bo,
  title,
  body,
  action,
  onAction,
  busy = false,
  compact = false,
  active = true,
  surface,
  style,
}: {
  /** Die Strichzeichnung — der Normalfall. */
  art?: StateArtKind;
  /** Bo statt der Zeichnung — nur, wo Bo selbst gemeint ist. */
  bo?: BoMood;
  title?: string;
  body: string;
  action?: string;
  onAction?: () => void;
  /** Läuft der Knopf gerade (z. B. neu laden)? Dann Kreisel statt Text. */
  busy?: boolean;
  /** In Blättern und Listen: kleinere Zeichnung, knappere Abstände. */
  compact?: boolean;
  /** Gerade zu sehen? Sonst zeichnet sich nichts und Bo schläft. */
  active?: boolean;
  /** Fläche dahinter — die Zeichnung deckt damit ab, was hinter ihren Teilen liegt. */
  surface?: string;
  style?: StyleProp<ViewStyle>;
}) {
  const accent = useAccent();
  const boAwake = useBoAwake(bo != null && active);
  return (
    <View style={[styles.wrap, compact && styles.wrapCompact, style]}>
      {bo ? (
        <Animated.View entering={FadeInDown.duration(RISE)}>
          <Bo state={bo} size={compact ? 72 : 112} paused={!boAwake} />
        </Animated.View>
      ) : art ? (
        <StateArt kind={art} play={active} size={ms(compact ? 104 : 136)} surface={surface} />
      ) : null}
      {title ? (
        <Animated.Text
          entering={FadeInDown.delay(90).duration(RISE)}
          style={[styles.title, compact && styles.titleCompact]}
        >
          {title}
        </Animated.Text>
      ) : null}
      <Animated.Text
        entering={FadeInDown.delay(140).duration(RISE)}
        style={[styles.body, compact && styles.bodyCompact, !title && styles.bodyAlone]}
      >
        {body}
      </Animated.Text>
      {action && onAction ? (
        <Animated.View entering={FadeInDown.delay(200).duration(RISE)}>
          <RippleTouch
            onPress={onAction}
            disabled={busy}
            accessibilityRole="button"
            rippleColor="rgba(0,0,0,0.12)"
            style={[styles.action, compact && styles.actionCompact, { backgroundColor: accent.solid }]}
          >
            {busy ? (
              <ActivityIndicator color={accent.textOnSolid} />
            ) : (
              <Text style={[styles.actionText, { color: accent.textOnSolid }]}>{action}</Text>
            )}
          </RippleTouch>
        </Animated.View>
      ) : null}
    </View>
  );
}

const styles = scaledStyles({
  wrap: { alignItems: "center", paddingHorizontal: 32, paddingVertical: SECTION_GAP },
  wrapCompact: { paddingHorizontal: 24, paddingVertical: GROUP_GAP },
  title: {
    marginTop: GROUP_GAP,
    fontSize: 22,
    lineHeight: 28,
    fontWeight: "600",
    color: WHITE,
    textAlign: "center",
    letterSpacing: -0.3,
  },
  titleCompact: { marginTop: 12, fontSize: 17, lineHeight: 22 },
  body: { marginTop: ITEM_GAP, fontSize: 15, lineHeight: 22, color: G2, textAlign: "center", maxWidth: 320 },
  bodyCompact: { fontSize: 14, lineHeight: 20 },
  bodyAlone: { marginTop: 12 },
  /** Wie die übrigen Hauptknöpfe: Akzentfläche, Schrift `textOnSolid` — als Pille. */
  action: {
    marginTop: SECTION_GAP,
    height: 48,
    minWidth: 180,
    paddingHorizontal: 28,
    borderRadius: 24,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  actionCompact: { marginTop: GROUP_GAP, height: 44, borderRadius: 22, minWidth: 160 },
  actionText: { fontSize: 15, fontWeight: "700" },
});
