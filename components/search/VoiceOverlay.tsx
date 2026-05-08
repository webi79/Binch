import { useEffect } from "react";
import { StyleSheet, View, BackHandler, Platform } from "react-native";
import Animated, { SlideInDown, SlideOutDown } from "react-native-reanimated";
import { useSearchStore } from "@/stores/searchStore";
import { VoiceContent } from "@/components/search/VoiceContent";

/**
 * Renders the voice screen as a top-most overlay above the SearchHero overlay.
 * Slides in from the bottom — the SearchHero stays mounted/visible behind so
 * dismissing the voice modal returns the user straight back to the search.
 */
export function VoiceOverlay() {
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
        entering={SlideInDown.duration(350)}
        exiting={SlideOutDown.duration(350)}
        style={[StyleSheet.absoluteFillObject, styles.sheet]}
      >
        <VoiceContent onClose={close} />
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  sheet: { backgroundColor: "#1A1A1A" },
});
