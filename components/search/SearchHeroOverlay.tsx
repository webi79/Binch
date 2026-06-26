import { useEffect } from "react";
import { StyleSheet, View, BackHandler, Platform } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import Animated, {
  FadeIn,
  FadeOut,
  SlideInDown,
  SlideOutDown,
} from "react-native-reanimated";
import { useSearchStore } from "@/stores/searchStore";
import { SearchHero } from "@/components/search/SearchHero";

/**
 * Renders the SearchHero as an overlay above the tab navigator's content area.
 * Slides in from the bottom (matching the voice / location-picker animations).
 * The bottom edge of the overlay is clipped just above the tab bar so the
 * navigation bar stays visible — the user can switch tabs to dismiss.
 *
 * The active tab content (e.g. the home screen) remains mounted underneath
 * because we don't navigate; it's just visually covered by the sheet.
 */
export function SearchHeroOverlay() {
  const mode = useSearchStore((s) => s.searchOverlayMode);
  const session = useSearchStore((s) => s.searchOverlaySession);
  const close = useSearchStore((s) => s.closeSearchOverlay);
  const insets = useSafeAreaInsets();
  // Matches FloatingTabBar: paddingTop 6 + slot 52 + paddingBottom (insets.bottom + 6)
  const tabBarHeight = 6 + 52 + 6 + insets.bottom;

  useEffect(() => {
    if (Platform.OS !== "android" || !mode) return;
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      close();
      return true;
    });
    return () => sub.remove();
  }, [mode, close]);

  if (!mode) return null;

  return (
    <View
      style={[StyleSheet.absoluteFillObject, { bottom: tabBarHeight }]}
      pointerEvents="box-none"
    >
      <StatusBar style="light" />
      {/* Darkening-Backdrop — fadet beim Open ein, fadet beim Close raus.
          Liegt UNTER dem Sheet aber ÜBER dem Landing-Screen → der Landing
          wird visuell abgedunkelt während die Slide-In Animation läuft
          (gleicher Effekt wie der AddTicketModal-Backdrop auf der
          Saved-Tab). pointerEvents="auto" damit der Backdrop Taps am
          Landing blockt (kein versehentliches Antippen während Sheet
          offen ist). */}
      <Animated.View
        entering={FadeIn.duration(280)}
        exiting={FadeOut.duration(280)}
        style={[StyleSheet.absoluteFillObject, styles.backdrop]}
        pointerEvents="auto"
      />
      <Animated.View
        entering={SlideInDown.duration(350)}
        exiting={SlideOutDown.duration(350)}
        style={[StyleSheet.absoluteFillObject, styles.sheet]}
      >
        {/* key=session-mode → JEDER Open (auch derselbe Mode zweimal
            hintereinander) remountet SearchHero. Garantiert leeren State
            beim Wieder-Öffnen, falls der User die letzte Suche nicht
            abgeschickt hatte. */}
        <SearchHero key={`${session}-${mode}`} mode={mode} />
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: { backgroundColor: "rgba(0,0,0,0.75)" },
  sheet: { backgroundColor: "#1A1A1A" },
});
