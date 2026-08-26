/**
 * SlidingPanels — Pager-Style Container für 2+ Panels.
 *
 * Beide (oder N) Panels sitzen side-by-side in EINEM breiten Container
 * (width = screenW * N). Bei Mode-Wechsel wird der gesamte Container
 * per translateX bewegt, sodass das gewünschte Panel im Viewport landet.
 *
 * Vorteil gegenüber 2× separaten Animationen: es gibt nur EINE bewegte
 * View. Die Inhalte (auch SVGs wie Bo) werden während des Slides nicht
 * pro Frame neu compositet — sie sind einfach Children einer einzigen
 * sich bewegenden View. Wirkt wie ein durchgehender Pager (Shazam-Style).
 */
import { Children, useEffect, useMemo, useRef, useState } from "react";
import { SHEET_OUT, markSheetMoving } from "@/lib/nav/overlayCover";
import { Platform, StyleSheet, useWindowDimensions, View } from "react-native";
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import type { ReactNode } from "react";
import { scaledStyles } from "@/lib/ui/compact";

interface Props {
  /** Welches Panel ist aktiv (0-indexed). */
  activeIndex: number;
  /** Panels — jedes Kind wird in einen full-width Slot gepackt. */
  children: ReactNode;
}

export function SlidingPanels({ activeIndex, children }: Props) {
  const { width: screenW } = useWindowDimensions();
  const panels = Children.toArray(children);
  const tx = useSharedValue(-activeIndex * screenW);

  // Hardware-Texture/Rasterisierung NUR während der Slide-Animation aktiv.
  // Vorher war's permanent ON für saubere Bo-Animation (siehe Saved-Tab
  // EmptyState). Das hat aber bei Panels mit FlatLists drin (z.B.
  // BinchDatePicker-Kalender) verursacht dass die gecachte Bitmap mid-
  // Animation aus dem Sync gerät → Zellen visuell verrutschen.
  //
  // Lösung: bei activeIndex-Wechsel rasterize=true setzen, nach Animation-
  // Ende auf false. Außerhalb des Slides ist die Tree wieder normal.
  const [rasterize, setRasterize] = useState(false);
  /** Erster Durchgang? Dann ist nichts zu bewegen — siehe Effekt. */
  const startedRef = useRef(false);

  useEffect(() => {
    /**
     * Rasterung ein Bild VOR der Bewegung, nicht im selben Durchlauf.
     *
     * Beides stand hier direkt untereinander. Der Aufbau einer
     * bildschirmfüllenden Ebene ist im Projekt mit 66ms vermessen — bei 120Hz
     * acht Bilder, in ein Fenster von einem. Jeder andere Textur-Nutzer der App
     * hat mindestens ein Bild Vorlauf oder rastert schon beim Fingerdruck; hier
     * fehlte es, und zwar an drei Stellen gleichzeitig (Saved-Reiter,
     * Ergebnis-Richtung, Datums-Modus).
     */
    /**
     * Beim ERSTEN Durchgang gar nichts tun.
     *
     * Der Effekt läuft auch beim Einhängen — und fährt dort eine Kurve zum
     * SELBEN Wert, legt also eine bildschirmfüllende Ebene an und räumt sie
     * wieder ab, für eine Bewegung, die es nicht gibt. Beim Saved-Reiter fällt
     * das in den Tab-Wechsel, der ihn aufbaut.
     */
    if (!startedRef.current) {
      startedRef.current = true;
      tx.value = -activeIndex * screenW;
      return;
    }
    /**
     * Die Bewegung ANMELDEN — hier fehlte es ganz.
     *
     * Ohne sie ist `isTransitionBusy()` während dieser 260ms falsch, und die
     * aufgeschobene Arbeit (Persistenz, Sekunden-Takt, die drei
     * Leerlauf-Aufbauten) darf hineinlaufen. Sie läuft an drei Stellen:
     * Saved-Reiter, Ergebnis-Richtung und Datums-Modus.
     */
    markSheetMoving(SHEET_OUT.duration);
    setRasterize(true);
    const id = requestAnimationFrame(() => {
    tx.value = withTiming(
      -activeIndex * screenW,
      // Gehörte vorher keiner Familie an: 280ms mit der Kurve der
      // Seitwärts-Slides. Das hier ist ein Blatt-artiger Wechsel innerhalb einer
      // Fläche, also die Blatt-Vorgabe.
      SHEET_OUT,
      (finished) => {
        // `finished` prüfen ist hier RICHTIG, ich hatte es fälschlich entfernt:
        // Bei einem Wechsel während einer laufenden Slide bricht die neue die alte
        // ab, deren Rückruf feuert mit false — und hätte die Ebene damit direkt
        // nach dem Einschalten wieder abgeräumt. Die neue Slide liefe dann ohne.
        if (finished) runOnJS(setRasterize)(false);
      },
    );
    });
    return () => cancelAnimationFrame(id);
  }, [activeIndex, screenW, tx]);

  const style = useAnimatedStyle(() => ({
    transform: [{ translateX: tx.value }],
  }));

  /**
   * Die Schiene EINMAL, nicht pro Durchgang.
   *
   * Sie sitzt auf dem animierten Knoten, der die Panel-Fahrt trägt — und ein
   * frisches Objekt dort ist auf Fabric ein Commit gegen ebendiese Bewegung.
   * Die Werte hängen allein an Bildschirmbreite und Anzahl der Flächen; beides
   * ändert sich nicht, während gefahren wird.
   */
  const railStyle = useMemo(
    () => [
      { flexDirection: "row" as const, width: screenW * panels.length, flex: 1 },
      style,
    ],
    [screenW, panels.length, style],
  );

  return (
    <View style={s.viewport}>
      <Animated.View
        collapsable={false}
        renderToHardwareTextureAndroid={Platform.OS === "android" && rasterize}
        shouldRasterizeIOS={Platform.OS === "ios" && rasterize}
        style={railStyle}
      >
        {panels.map((panel, i) => (
          <View key={i} style={[s.slot, { width: screenW }]}>
            {panel}
          </View>
        ))}
      </Animated.View>
    </View>
  );
}

const s = scaledStyles({
  viewport: { flex: 1, overflow: "hidden" },
  slot: { flex: 1 },
});
