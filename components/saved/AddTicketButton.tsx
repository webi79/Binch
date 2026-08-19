import { View, Text, Pressable, StyleSheet } from "react-native";
import Svg, { Line, Polyline } from "react-native-svg";
import { useAccent } from "@/lib/theme/accent";
import { usePalette, getAppBg } from "@/lib/theme/appBg";
import { useT } from "@/lib/i18n/useT";
import { GUTTER, SPACE } from "@/lib/theme/spacing";
import { ms, scaledStyles } from "@/lib/ui/compact";

// App-Farben (Akzent kommt live aus useAccent(), Flächen aus usePalette()):
const META = "#7E7E86";
const BARCODE = "#3A3A3D";

/**
 * Auch diese beiden über `ms`.
 *
 * Sie stehen zwar im Stilblatt, aber nicht als eigenes Maß — sie werden dort
 * verrechnet (`left: STUB_W - NOTCH / 2`, `borderRadius: NOTCH / 2`). Was der
 * Wrapper sieht, ist das Ergebnis; skalierte er es ein zweites Mal, liefen
 * Perforation und Aussparung gegeneinander. Deshalb hier einmal, dort roh.
 */
const STUB_W = 76; // Breite des linken Stubs (Plus-Icon)
const NOTCH = 18; // Durchmesser der ausgestanzten Kreise

interface Props {
  onPress: () => void;
  /** Hintergrund HINTER dem Button (für die ausgestanzten Notch-Kreise).
   *  Default = Saved-Screen-Background. */
  bgColor?: string;
}

/**
 * Add-Ticket-Button in Ticket-Optik: linker Stub mit Plus, Perforation,
 * oben/unten ausgestanzte Notch-Kreise, Barcode-Motiv + Chevron rechts.
 * Akzentfarben (Plus, Barcode-Akzentstriche, Chevron) folgen dem User-Akzent.
 */
export function AddTicketButton({ onPress, bgColor }: Props) {
  const accent = useAccent();
  const palette = usePalette();
  const t = useT();
  // Die Notch-Kreise stanzen den Button aus, müssen also exakt die Farbe
  // DAHINTER haben — der Aufrufer reicht sie durch, sonst der Screen-Grund.
  const behind = bgColor ?? getAppBg();
  return (
    <Pressable onPress={onPress} style={[styles.ticket, { backgroundColor: palette.s2 }]} android_ripple={{ color: accent.subtle }}>
      {/* Stub mit Plus-Icon */}
      <View style={styles.stub}>
        <View style={[styles.plusBox, { backgroundColor: accent.subtle }]}>
          <Svg width={24} height={24} viewBox="0 0 24 24">
            <Line x1={12} y1={5} x2={12} y2={19} stroke={accent.solid} strokeWidth={2.6} strokeLinecap="round" />
            <Line x1={5} y1={12} x2={19} y2={12} stroke={accent.solid} strokeWidth={2.6} strokeLinecap="round" />
          </Svg>
        </View>
      </View>

      {/* Perforation (gestrichelte Linie) */}
      <View style={styles.perforation} pointerEvents="none" />

      {/* Ausgestanzte Notches oben/unten — Farbe = Hintergrund */}
      <View style={[styles.notch, styles.notchTop, { backgroundColor: behind }]} pointerEvents="none" />
      <View style={[styles.notch, styles.notchBottom, { backgroundColor: behind }]} pointerEvents="none" />

      {/* Body */}
      <View style={styles.body}>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>{t("saved.tickets.add")}</Text>
          <Text style={styles.meta}>{t("saved.tickets.addhint")}</Text>
        </View>

        {/* Barcode-Motiv */}
        <View style={styles.barcode}>
          {[3, 1, 2, 1, 3, 2, 1, 2, 1, 3, 1, 2].map((w, i) => (
            <View
              key={i}
              style={{
                width: w,
                // Maße AM ORT werden von `scaledStyles` nicht erfasst — das
                // gilt nur für Stilblätter. Ohne `ms` bliebe der Barcode in
                // voller Höhe stehen, während der Rahmen um ihn herum
                // schrumpft: Genau daher der Eindruck „viel zu dick".
                height: ms(34),
                borderRadius: 1,
                marginLeft: i === 0 ? 0 : 2,
                backgroundColor: i % 4 === 0 ? accent.solid : BARCODE,
              }}
            />
          ))}
        </View>

        {/* Chevron */}
        <Svg width={ms(22)} height={ms(22)} viewBox="0 0 24 24" style={{ marginLeft: ms(12) }}>
          <Polyline
            points="9 18 15 12 9 6"
            fill="none"
            stroke={accent.solid}
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
    marginBottom: 14,
  },
  stub: {
    width: STUB_W,
    alignItems: "center",
    justifyContent: "center",
  },
  plusBox: {
    width: 48,
    height: 48,
    borderRadius: 14,
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
    paddingLeft: SPACE.xl,
    paddingRight: SPACE.lg,
  },
  title: {
    fontSize: 17,
    fontWeight: "700",
    color: "#FFFFFF",
    letterSpacing: -0.2,
  },
  meta: {
    marginTop: 3,
    fontSize: 12.5,
    fontWeight: "500",
    color: META,
  },
  barcode: {
    flexDirection: "row",
    alignItems: "center",
    height: 34,
  },
});
