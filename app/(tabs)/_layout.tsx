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
import { View, useWindowDimensions } from "react-native";
import { useT } from "@/lib/i18n/useT";

const NativeBottomTabs = createNativeBottomTabNavigator();
const Tabs = withLayoutContext<
  NativeBottomTabNavigationOptions,
  typeof NativeBottomTabs.Navigator,
  TabNavigationState<ParamListBase>,
  NativeBottomTabNavigationEventMap
>(NativeBottomTabs.Navigator);



/** Modulweit und damit stabil. Liefert bewusst nichts: Gesetzt sein MUSS das
 *  Prop trotzdem, denn erst dadurch versteckt die Bibliothek ihre eigene Leiste
 *  und gibt den Seiten volle Höhe. */
const renderNoTabBar = () => null;

export default function TabsLayout() {
  const t = useT();
  const { width: winW, height: winH } = useWindowDimensions();

  return (
    // Der frühere negative Rand ist weg: Er schnitt die native Leiste unten an,
    // damit sie schlanker wirkte als Materials 56dp-Mindesthöhe. Unsere eigene
    // Leiste hat ihre Höhe selbst in der Hand.
    <View style={{ flex: 1 }}>
      <Tabs
        /**
         * ECHTE PIXELMASSE für die Bildschirme — das ist der Fix für die Karte.
         *
         * Mit der nativen Leiste bekam jeder Tab-Bildschirm gemessene Pixelwerte
         * (`measuredDimensions`). Sobald eine eigene Leiste gesetzt ist, vergibt
         * die Bibliothek stattdessen `width: "100%", height: "100%"` — und ein
         * Prozentwert ist erst dann eine Größe, wenn der Elternknoten schon eine
         * hat. Für alles aus React ist das folgenlos; MapLibre legt seine
         * GL-Fläche aber EINMAL an und rechnet aus deren Größe aus, welche
         * Kacheln es überhaupt anfragt. Zu früh angelegt fragt es nichts an und
         * holt das später nicht nach. Genau deshalb blieb die Karte leer, obwohl
         * Netz UND Zwischenspeicher in Ordnung waren.
         *
         * `sceneStyle` landet in derselben Stil-Liste, nur dahinter — und
         * überschreibt die Prozentwerte damit.
         */
        screenOptions={{ sceneStyle: { width: winW, height: winH } }}
        // Der frühere `screenListeners`-Block mit `tabPress` ist entfallen: Das
        // Ereignis kommt von der nativen Leiste, und die ist weg. Was daran hing
        // (Takt-Erkennung, Schließen des Such-Screens) steht jetzt im Handler
        // der eigenen Leiste — siehe BinchTabBar.tsx.
        // Farben, Beschriftungen und Symbolgrößen lagen hier für die native
        // Leiste. Sie sind mit ihr entfallen — das alles steht jetzt in
        // BinchTabBar.tsx, wo es auch hingehört.
        // Tab-Wechsel OHNE Überblendung — sofort.
        //
        // Das stand hier lange auf „aus", weil ein statisches `true` damals
        // generell flackerte: Der alte Screen verschwand im selben Frame, in dem
        // der neue stand — und der neue war zu dem Zeitpunkt noch nicht fertig.
        // Genau die Gründe dafür sind inzwischen weg:
        //
        //   • Der Wechsel startet nativ beim Antippen, nicht erst nach einer Runde
        //     über den JS-Thread (Patch in react-native-bottom-tabs).
        //   • Die gestaffelte Einblend-Welle ist aus den Tabs raus — der Inhalt
        //     ist beim Fokus vollständig da, statt sich über ~1s aufzubauen.
        //   • Die schweren Commits im Wechsel-Frame sind behoben (Store
        //     serialisiert nicht mehr synchron, die Ergebniskarten hängen nicht
        //     mehr am Router, der Karten-Freeze liegt außerhalb des Wechsels).
        //
        // Warum überhaupt ohne: Die Überblendung legt Alpha auf den ganzen
        // Tab-Baum. Bei den großen Reiseziel-Karten liegen Bild, Verlauf und
        // Textebenen übereinander — die blenden dann sichtbar getrennt, was als
        // Fehler gelesen wird. Genau dieselbe Ursache ist in lib/motion.tsx
        // dokumentiert (needsOffscreenAlphaCompositing). Kein Alpha, kein Problem.
        //
        // Und es ist auch, was sich in anderen Apps richtig anfühlt: Instagram
        // wechselt hart, und Apples neuer Zoom-Übergang aus iOS 18 wird von
        // Entwicklern verbreitet durch einen Übergang mit Dauer null ersetzt.
        //
        // DYNAMISCH darf es nicht werden (`={searchOpen}`): Ein natives Prop
        // mitten in der Interaktion umzuschalten konfiguriert den TabView neu und
        // blitzt sichtbar auf. Das bleibt gültig — deshalb fest auf true.
        disablePageAnimations={true}
        /**
         * EIGENE LEISTE statt der nativen — siehe components/ui/BinchTabBar.tsx.
         *
         * Kurzfassung: `barTintColor`/`translucent`/`activeIndicatorColor` sind
         * auf Android in dieser Bibliothek nicht umgesetzt (stehen nur im
         * generierten Codegen, nicht in `RCTTabView.kt`), und die Symbole der
         * nativen Leiste sind keine React-Ansichten. Durchscheinen und
         * Druck-Effekt gehen damit beide nur so.
         *
         * Der Seitenwechsel bleibt nativ: Die Bibliothek versteckt bei gesetztem
         * `tabBar` nur ihre eigene Leiste (`tabBarHidden`), blendet die Seiten
         * aber weiterhin selbst um — und gibt ihnen dabei VOLLE Höhe, was die
         * Voraussetzung fürs Durchscheinen ist.
         */
        // `() => null` versteckt nur die NATIVE Leiste (tabBarHidden). Unsere
        // eigene liegt am Wurzel-Layout — von hier aus würde sie vom Such-Screen
        // verdeckt, weil der als Wurzel-Overlay über dem ganzen Tab-Baum liegt.
        tabBar={renderNoTabBar}
      >
        {/* lazy={false} auf ALLEN Tabs — der Grund für den ruckeligen ERSTEN
            Wechsel nach dem App-Start.
            react-native-bottom-tabs rendert Tabs standardmäßig verzögert: Bis
            ein Tab zum ersten Mal angesteuert wird, steht an seiner Stelle eine
            LEERE View (TabView.tsx: „Don't render a screen if we've never
            navigated to it"). Beim ersten Tippen passierte deshalb genau das,
            was man sah — nativ schaltete der Container sofort um und zeigte die
            leere Fläche, DANACH baute React den ganzen Screen erstmals auf und
            vermaß ihn. Die Elemente mussten sich also wirklich einmal setzen.
            Ab dem zweiten Mal war der Screen fertig, deshalb nie wieder.
            Mit lazy={false} entsteht jeder Screen einmalig beim App-Start —
            hinter der Splash, wo niemand darauf wartet. Sichtbarmachen ist
            danach reine native Sichtbarkeit, ohne React-Arbeit.
            Die Karte kostet dabei nichts extra: MapLibre hängt in
            surroundings.tsx an einem eigenen Gate (mapMounted), das erst bei
            Fokus greift. Vorgerendert wird nur das Gerüst. */}

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
            lazy: false,
            title: t("bottomnav.booking"),
            tabBarIcon: () => require("@/assets/tabs/home.png"),
          }}
        />
        <Tabs.Screen
          name="surroundings"
          options={{
            lazy: false,
            title: t("bottomnav.surroundings"),
            tabBarIcon: () => require("@/assets/tabs/tag.png"),
            // freezeOnBlur ENTFERNT — ersetzt durch einen VERZÖGERTEN Freeze im
            // Screen selbst (surroundings.tsx, <Freeze>). Grund: freezeOnBlur
            // friert EXAKT im Tab-Wechsel ein → der dicke Freeze-Commit fällt in
            // den Crossfade und verschluckt gelegentlich einen Frame („Aufblitzen"
            // beim Verlassen der Map). Der verzögerte Freeze (nach dem Crossfade)
            // behält den Map-Hintergrund-Perf-Vorteil, ohne den Wechsel zu stören.
          }}
        />
        <Tabs.Screen
          name="saved"
          options={{
            lazy: false,
            title: t("bottomnav.saved"),
            tabBarIcon: () => require("@/assets/tabs/calendar.png"),
          }}
        />
        <Tabs.Screen
          name="settings"
          options={{
            lazy: false,
            title: t("bottomnav.settings"),
            tabBarIcon: () => require("@/assets/tabs/user.png"),
          }}
        />
      </Tabs>
    </View>
  );
}
