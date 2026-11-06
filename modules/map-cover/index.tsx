import { forwardRef, useImperativeHandle, useRef, type ComponentType, type Ref } from "react";
import { Platform, StyleSheet, View, type ViewProps } from "react-native";
import { requireNativeView, requireOptionalNativeModule } from "expo";

/**
 * Das Standbild beim Wechsel des Kartentyps (nur Android; Umsetzung und
 * Begründung in android/…/MapCoverView.kt). Ohne das Modul (anderes System,
 * alter Entwickler-Client) meldet `capture` einfach `false` — die Karte wird
 * dann ohne Standbild getauscht.
 */
interface NativeMapCoverMethods {
  capture(mapTag: number): Promise<boolean>;
  reveal(mapTag: number, capMs: number, maxMs: number, fadeMs: number): Promise<boolean>;
  fadeNow(fadeMs: number): Promise<void>;
}

const available = Platform.OS === "android" && requireOptionalNativeModule("MapCover") != null;
const NativeMapCover = available
  ? (requireNativeView<ViewProps>("MapCover") as unknown as ComponentType<
      ViewProps & { ref?: Ref<NativeMapCoverMethods> }
    >)
  : null;

export interface MapCoverTiming {
  /** Spätestens so lange nach dem geladenen Stil freigeben, auch wenn noch Kacheln fehlen. */
  capMs: number;
  /** Ganz spätestens so lange nach dem Auftrag (kein Netz, Stil hängt). */
  maxMs: number;
  /** Dauer des Ausblendens. */
  fadeMs: number;
}

export interface MapCoverHandle {
  /** Bild der Karte mit dieser Kennung festhalten und zeigen — `true`, sobald es auf dem Schirm steht. */
  capture(mapTag: number): Promise<boolean>;
  /**
   * Auf die neue Karte warten und ausblenden. `true`, sobald das Ausblenden
   * BEGINNT; `false`, wenn ein neuerer Auftrag diesen ablöst.
   */
  reveal(mapTag: number, timing: MapCoverTiming): Promise<boolean>;
  /** Sofort ausblenden (die Karte wird angefasst). */
  fadeNow(fadeMs: number): void;
}

/**
 * Liegt über der Karte, unter allem anderen. Berührungen gehen durch: Die Hülle
 * ist `pointerEvents="none"` — sonst wäre die native Ansicht für React das
 * Ziel jeder Berührung, und `onTouchStart` der Karte käme nie an.
 */
export const MapCover = forwardRef<MapCoverHandle>(function MapCover(_props, ref) {
  const nativeRef = useRef<NativeMapCoverMethods | null>(null);
  useImperativeHandle(
    ref,
    () => ({
      capture: (mapTag) => nativeRef.current?.capture(mapTag).catch(() => false) ?? Promise.resolve(false),
      reveal: (mapTag, t) =>
        nativeRef.current?.reveal(mapTag, t.capMs, t.maxMs, t.fadeMs).catch(() => false) ?? Promise.resolve(false),
      fadeNow: (fadeMs) => {
        void nativeRef.current?.fadeNow(fadeMs).catch(() => {});
      },
    }),
    [],
  );
  if (!NativeMapCover) return null;
  return (
    <View pointerEvents="none" collapsable={false} style={StyleSheet.absoluteFill}>
      <NativeMapCover ref={nativeRef} style={StyleSheet.absoluteFill} />
    </View>
  );
});
