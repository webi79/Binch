import { useEffect } from "react";
import { SHEET_IN, SHEET_OUT } from "@/lib/nav/overlayCover";
import { StyleSheet, View, BackHandler, Platform } from "react-native";
import { usePalette } from "@/lib/theme/appBg";
import Animated, { SlideInDown, SlideOutDown } from "react-native-reanimated";
import { useSearchStore } from "@/stores/searchStore";
import { VoiceContent } from "@/components/search/VoiceContent";
import { scaledStyles } from "@/lib/ui/compact";

/**
 * Renders the voice screen as a top-most overlay above the SearchHero overlay.
 * Slides in from the bottom — the SearchHero stays mounted/visible behind so
 * dismissing the voice modal returns the user straight back to the search.
 */
export function VoiceOverlay() {
  const palette = usePalette();
  const open = useSearchStore((s) => s.voiceOverlayOpen);
  const close = useSearchStore((s) => s.closeVoiceOverlay);

  useEffect(() => {
    if (Platform.OS !== "android" || !open) return;
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      close();
      return true;
    });
    return () => sub.remove();
  }, [open, close]);

  if (!open) return null;

  return (
    <View style={StyleSheet.absoluteFillObject} pointerEvents="box-none">
      <Animated.View
        entering={SlideInDown.duration(SHEET_IN.duration).easing(SHEET_IN.easing)}
        exiting={SlideOutDown.duration(SHEET_OUT.duration).easing(SHEET_OUT.easing)}
        style={[StyleSheet.absoluteFillObject, styles.sheet, { backgroundColor: palette.s1 }]}
      >
        <VoiceContent onClose={close} />
      </Animated.View>
    </View>
  );
}

const styles = scaledStyles({
  sheet: { backgroundColor: "#0D0D0D" },
});
