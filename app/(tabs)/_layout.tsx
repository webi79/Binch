import { withLayoutContext } from "expo-router";
import {
  createNativeBottomTabNavigator,
  type NativeBottomTabNavigationOptions,
  type NativeBottomTabNavigationEventMap,
} from "@bottom-tabs/react-navigation";
import type {
  ParamListBase,
  TabNavigationState,
} from "@react-navigation/native";
import { View } from "react-native";
import { useT } from "@/lib/i18n/useT";
import { useSearchStore } from "@/stores/searchStore";
import { useAccent } from "@/lib/theme/accent";

const NativeBottomTabs = createNativeBottomTabNavigator();
const Tabs = withLayoutContext<
  NativeBottomTabNavigationOptions,
  typeof NativeBottomTabs.Navigator,
  TabNavigationState<ParamListBase>,
  NativeBottomTabNavigationEventMap
>(NativeBottomTabs.Navigator);

const COLORS = {
  bar: "#242425",
  active: "#FFFFFF",
  inactive: "#8A8A90",
};

const NAVBAR_TRIM = 16;

export default function TabsLayout() {
  const t = useT();
  const closeSearchOverlay = useSearchStore((s) => s.closeSearchOverlay);
  // Akzent reaktiv lesen: wenn der User in Settings auf Mint switcht, kriegt
  // der Tab-Bar-Pill (activeIndicatorColor) sofort die neue Farbe. Vorher
  // war es hartcoded grün → ignorierte die Mint-Wahl.
  const accent = useAccent();

  return (
    // Wrapper mit marginBottom: -7 schiebt die TabView 7px unter den Screen-
    // Rand. Effektiv: die unteren 7px der nativen Tab-Bar liegen außerhalb
    // des sichtbaren Bereichs → Bar erscheint 7px schlanker. Material 3
    // BottomNavigationView hat 56dp Mindesthöhe, dieser Trick macht's
    // optisch näher an unsere alte FloatingTabBar.
    <View style={{ flex: 1, marginBottom: -NAVBAR_TRIM }}>
      <Tabs
        // tabPress feuert wenn der User auf irgendein Tab-Icon tippt.
        // Wir schließen den SearchHero-Overlay damit er nicht weiter offen
        // bleibt während der Tab im Hintergrund wechselt.
        screenListeners={{
          tabPress: () => closeSearchOverlay(),
        }}
        tabBarActiveTintColor={COLORS.active}
        tabBarInactiveTintColor={COLORS.inactive}
        tabBarStyle={{ backgroundColor: COLORS.bar }}
        // accent.border ist die rgba-Variante (~30% Opacity) des aktiven
        // Akzents — gibt den dezent translucenten Pill-Hintergrund, der zum
        // Rest der App-Akzente passt (gleiche Border-Farbe wie z.B. der
        // FAB-Highlight).
        activeIndicatorColor={accent.border}
        rippleColor="transparent"
        // labeled=TRUE (statt false): Android Material 3 positioniert dann
        // das Icon im OBEREN Teil des Slots (mit reserviertem Label-Bereich
        // darunter). Wir machen die Label aber unsichtbar via fontSize=0
        // → Icon erscheint visuell höher in der Bar, ohne dass Text
        // sichtbar ist. Der zusätzliche Label-Slot-Höhe wird durch unseren
        // NAVBAR_TRIM-Crop unten wieder kompensiert.
        labeled={true}
        tabLabelStyle={{ fontSize: 0 }}
        hapticFeedbackEnabled
        disablePageAnimations
        translucent={false}
        scrollEdgeAppearance="opaque"
      >
        {/* FREEZE-STRATEGIE (gemessen, nicht geraten):
            freezeOnBlur stoppt Hintergrund-Rendering unfokussierter Tabs
            (react-freeze/Suspense) — aber jeder Freeze/Unfreeze ist ein
            dicker React-Commit + Fabric-Mount-Burst, der EXAKT im Moment
            des Tab-Wechsels landet. Wer direkt nach dem Wechsel scrollt,
            scrollt in diesen Burst → Erst-Scroll-Ruckler in JEDEM Tab
            ([jsstall]-Messung: 50–130ms Stalls genau bei Entry in
            gefrorene Tabs). Deshalb: Freeze NUR wo der Hintergrund-Nutzen
            die Wechsel-Kosten übersteigt — bei der Map (MapLibre-GL-Thread,
            Viewport-Queries). Landing/Saved/Settings sind leichte Trees
            ohne Loops: ungefroren kosten sie im Hintergrund fast nichts,
            und der Tab-Wechsel bleibt commit-frei. */}
        <Tabs.Screen
          name="index"
          options={{
            title: t("bottomnav.booking"),
            tabBarIcon: () => require("@/assets/tabs/home.png"),
          }}
        />
        <Tabs.Screen
          name="surroundings"
          options={{
            title: t("bottomnav.surroundings"),
            tabBarIcon: () => require("@/assets/tabs/tag.png"),
            freezeOnBlur: true,
          }}
        />
        <Tabs.Screen
          name="saved"
          options={{
            title: t("bottomnav.saved"),
            tabBarIcon: () => require("@/assets/tabs/calendar.png"),
          }}
        />
        <Tabs.Screen
          name="settings"
          options={{
            title: t("bottomnav.settings"),
            tabBarIcon: () => require("@/assets/tabs/user.png"),
          }}
        />
      </Tabs>
    </View>
  );
}
