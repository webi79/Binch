import { useState } from "react";
import { View, Text, Pressable } from "react-native";
import Svg, { Line, Polyline } from "react-native-svg";
import { useAccent } from "@/lib/theme/accent";
import { usePalette, getAppBg } from "@/lib/theme/appBg";
import { useT } from "@/lib/i18n/useT";
import { GROUP_GAP, GUTTER, SPACE } from "@/lib/theme/spacing";
import { ms, scaledStyles } from "@/lib/ui/compact";

// App-Farben (Akzent kommt live aus useAccent(), Flächen aus usePalette()):
const META = "#7E7E86";
const BARCODE = "#2D2D31";

/**
 * Stub-Breite und Ausstanzung — roh, weil sie im Stilblatt VERRECHNET werden
 * (`left: STUB_W - NOTCH / 2`, `borderRadius: NOTCH / 2`) und das Stilblatt
 * das Ergebnis einmal skaliert. Zweimal skaliert liefen Perforation und
 * Aussparung gegeneinander.
 */
const STUB_W = 76;
const NOTCH = 18;

/** Strichcode: Strichbreiten, Abstand dazwischen, Höhe (vor `ms`). */
const BARS = [3, 1, 2, 1, 3, 2, 1, 2, 1, 3, 1, 2] as const;
const BAR_GAP = 2;
const BAR_H = 32;
const BARCODE_W = BARS.reduce((a, b) => a + b, 0) + BAR_GAP * (BARS.length - 1);
/** Pfeil rechts und sein Abstand zum Inhalt davor. */
const CHEVRON = 20;
const CHEVRON_GAP = SPACE.md;
/** Innenränder des Körpers (rechts vom Stub). */
const BODY_PAD_L = SPACE.xl;
const BODY_PAD_R = SPACE.lg;
/** Mindestabstand zwischen Text und Strichcode. */
const CODE_GAP = SPACE.lg;

interface Props {
  onPress: () => void;
  /** Hintergrund HINTER dem Button (für die ausgestanzten Notch-Kreise).
   *  Default = Saved-Screen-Background. */
  bgColor?: string;
}

/**
 * „Ticket hinzufügen" in Ticket-Optik: linker Stub, Perforation, oben/unten
 * ausgestanzte Kreise, rechts ein Strichcode-Motiv und der Pfeil.
 *
 * Das PLUS (05.11.2026): Vorher stand es hellgrün auf einer hellgrün getönten
 * Kachel — „sieht nicht mehr zeitgemäß aus, passt nicht zur App". Jetzt ist es
 * ein voller Akzent-Kreis mit dunklem Plus, wie jeder Hauptknopf der App
 * (Senden, „Nochmal versuchen"). Und es ist der EINZIGE Akzent der Karte:
 * Strichcode und Pfeil sind neutral — ein Blickpunkt, eine Handlung.
 *
 * KLEINE GERÄTE: Titel, Hinweis und Strichcode teilten sich eine Zeile mit
 * festen Breiten; „Ticket hinzufügen" lief auf schmalen Bildschirmen in den
 * Strichcode bzw. brach um. Jetzt bleibt jede Zeile einzeilig, und der
 * Strichcode erscheint nur, wenn er neben dem VOLLEN Text Platz hat — sonst
 * fällt er ganz weg (ein halber Strichcode sähe nach Fehler aus). Gemessen
 * wird einmal: die Breite des Körpers und die natürliche Breite der Texte.
 */
export function AddTicketButton({ onPress, bgColor }: Props) {
  const accent = useAccent();
  const palette = usePalette();
  const t = useT();
  // Die Notch-Kreise stanzen den Button aus, müssen also exakt die Farbe
  // DAHINTER haben — der Aufrufer reicht sie durch, sonst der Screen-Grund.
  const behind = bgColor ?? getAppBg();

  /** Breite des Körpers und die natürliche Breite von Titel und Hinweis. */
  const [bodyW, setBodyW] = useState(0);
  const [titleW, setTitleW] = useState(0);
  const [metaW, setMetaW] = useState(0);
  const measured = bodyW > 0 && titleW > 0 && metaW > 0;
  // Platz für den Text, wenn der Strichcode steht.
  const room =
    bodyW - ms(BODY_PAD_L) - ms(BODY_PAD_R) - ms(CHEVRON) - ms(CHEVRON_GAP) - BARCODE_W - ms(CODE_GAP);
  const showCode = !measured || Math.max(titleW, metaW) <= room;

  return (
    <Pressable
      onPress={onPress}
      style={[styles.ticket, { backgroundColor: palette.s2 }]}
      android_ripple={{ color: "rgba(255,255,255,0.06)" }}
      accessibilityRole="button"
      accessibilityLabel={t("saved.tickets.add")}
    >
      {/* Stub mit Plus */}
      <View style={styles.stub}>
        <View style={[styles.plus, { backgroundColor: accent.solid }]}>
          <Svg width={ms(22)} height={ms(22)} viewBox="0 0 24 24">
            <Line x1={12} y1={5} x2={12} y2={19} stroke={accent.textOnSolid} strokeWidth={2.6} strokeLinecap="round" />
            <Line x1={5} y1={12} x2={19} y2={12} stroke={accent.textOnSolid} strokeWidth={2.6} strokeLinecap="round" />
          </Svg>
        </View>
      </View>

      {/* Perforation (gestrichelte Linie) */}
      <View style={styles.perforation} pointerEvents="none" />

      {/* Ausgestanzte Notches oben/unten — Farbe = Hintergrund */}
      <View style={[styles.notch, styles.notchTop, { backgroundColor: behind }]} pointerEvents="none" />
      <View style={[styles.notch, styles.notchBottom, { backgroundColor: behind }]} pointerEvents="none" />

      {/* Body */}
      <View style={styles.body} onLayout={(e) => setBodyW(e.nativeEvent.layout.width)}>
        {/* Natürliche Breite der Texte — unsichtbar, nur zum Messen. */}
        <Text
          style={[styles.title, styles.ghost]}
          numberOfLines={1}
          onLayout={(e) => setTitleW(e.nativeEvent.layout.width)}
          aria-hidden
        >
          {t("saved.tickets.add")}
        </Text>
        <Text
          style={[styles.meta, styles.ghost]}
          numberOfLines={1}
          onLayout={(e) => setMetaW(e.nativeEvent.layout.width)}
          aria-hidden
        >
          {t("saved.tickets.addhint")}
        </Text>

        <View style={[styles.text, showCode && styles.textBeforeCode]}>
          <Text style={styles.title} numberOfLines={1}>
            {t("saved.tickets.add")}
          </Text>
          <Text style={styles.meta} numberOfLines={1}>
            {t("saved.tickets.addhint")}
          </Text>
        </View>

        {/* Strichcode-Motiv — bis gemessen ist unsichtbar (Platz bleibt), dann ganz oder gar nicht. */}
        {showCode ? (
          <View style={[styles.barcode, !measured && styles.hidden]}>
            {BARS.map((w, i) => (
              <View
                key={i}
                style={{
                  width: w,
                  // Maße AM ORT werden von `scaledStyles` nicht erfasst — daher `ms`.
                  height: ms(BAR_H),
                  borderRadius: 1,
                  marginLeft: i === 0 ? 0 : BAR_GAP,
                  backgroundColor: BARCODE,
                }}
              />
            ))}
          </View>
        ) : null}

        <Svg width={ms(CHEVRON)} height={ms(CHEVRON)} viewBox="0 0 24 24" style={{ marginLeft: ms(CHEVRON_GAP) }}>
          <Polyline
            points="9 18 15 12 9 6"
            fill="none"
            stroke={META}
            strokeWidth={2.4}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </Svg>
      </View>
    </Pressable>
  );
}

const styles = scaledStyles({
  ticket: {
    flexDirection: "row",
    alignItems: "stretch",
    borderRadius: 18,
    minHeight: 72,
    overflow: "visible",
    marginHorizontal: GUTTER,
    marginBottom: GROUP_GAP,
  },
  stub: {
    width: STUB_W,
    alignItems: "center",
    justifyContent: "center",
  },
  /** Voller Akzent-Kreis — wie die runden Hauptknöpfe der App. */
  plus: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
  },
  perforation: {
    position: "absolute",
    left: STUB_W,
    top: 8,
    bottom: 8,
    borderLeftWidth: 2,
    borderColor: BARCODE,
    borderStyle: "dashed",
  },
  notch: {
    position: "absolute",
    left: STUB_W - NOTCH / 2,
    width: NOTCH,
    height: NOTCH,
    borderRadius: NOTCH / 2,
  },
  notchTop: { top: -NOTCH / 2 },
  notchBottom: { bottom: -NOTCH / 2 },
  body: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    paddingLeft: BODY_PAD_L,
    paddingRight: BODY_PAD_R,
  },
  /** Schrumpft, damit lange Übersetzungen kürzen statt den Pfeil zu verdrängen. */
  text: { flex: 1, minWidth: 0 },
  textBeforeCode: { marginRight: CODE_GAP },
  title: {
    fontSize: 17,
    fontWeight: "700",
    color: "#F4F4F5",
    letterSpacing: -0.2,
  },
  meta: {
    marginTop: SPACE.xs,
    fontSize: 12.5,
    fontWeight: "500",
    color: META,
  },
  /** Mess-Text: aus dem Fluss, unsichtbar, ohne Berührung. */
  ghost: { position: "absolute", left: 0, top: 0, opacity: 0 },
  barcode: {
    flexDirection: "row",
    alignItems: "center",
  },
  hidden: { opacity: 0 },
});
