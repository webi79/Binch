import { memo, useCallback, useEffect, useMemo, useRef } from "react";
import { Image, Pressable, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Animated from "react-native-reanimated";
import { router, usePathname } from "expo-router";

import { noteTabPress, usePressBounce } from "@/lib/motion";
import { useSearchStore } from "@/stores/searchStore";
import { haptic } from "@/lib/haptics";
import { useT } from "@/lib/i18n/useT";
import { ms } from "@/lib/ui/compact";
import { scaledStyles } from "@/lib/ui/compact";

/**
 * Die Tab-Leiste, selbst gebaut.
 *
 * WARUM NICHT DIE NATIVE: Zwei Wünsche gehen mit ihr auf Android nicht.
 *
 *  • Durchscheinend. `barTintColor` und `translucent` stehen zwar in der
 *    TypeScript-Schnittstelle von react-native-bottom-tabs, tauchen auf Android
 *    aber nur im generierten Codegen auf — in `RCTTabView.kt` liest sie niemand.
 *    Gesetzt wurde die Leiste dadurch schlicht schwarz.
 *  • Druck-Effekt auf den Symbolen. Die vier Symbole sind dort keine
 *    React-Ansichten, sondern `ImageSource`-Werte, die Android selbst zeichnet.
 *    Es gibt kein Element, an das ein Transform passen würde.
 *
 * Beides ist hier gelöst, weil die Leiste aus gewöhnlichen Ansichten besteht.
 *
 * WAS DABEI NICHT VERLOREN GEHEN DARF: das Tempo. Die native Leiste startete den
 * Wechsel beim Antippen, ohne Umweg über den JS-Thread (eigener Patch). Drei
 * Dinge halten das hier:
 *
 *  1. Umgeschaltet wird in `onPressIn`, nicht in `onPress` — also beim Aufsetzen
 *     des Fingers statt beim Loslassen. Das allein sind je nach Tipp 60-120ms.
 *  2. Der Wechsel steht als ERSTE Anweisung im Handler. Haptik und die
 *     Takt-Erkennung laufen danach; sie dürfen den Navigations-Aufruf nicht
 *     hinter sich haben.
 *  3. Der Druck-Effekt ist ein geteilter Wert. Nach dem Auslösen rechnet ihn der
 *     UI-Thread allein zu Ende — er kann den Wechsel nicht aufhalten, auch wenn
 *     der JS-Thread danach beschäftigt ist.
 *
 * Der Seitenwechsel selbst bleibt nativ: Die Bibliothek blendet die Seiten in
 * ihrer eigenen Ansicht um, `disablePageAnimations` ist weiterhin an. Wir sagen
 * ihr nur, welche.
 */

/** Symbole der vier Tabs, in der Reihenfolge der Routen. */
const ICONS: Record<string, ReturnType<typeof require>> = {
  index: require("@/assets/tabs/home.png"),
  surroundings: require("@/assets/tabs/tag.png"),
  saved: require("@/assets/tabs/calendar.png"),
  settings: require("@/assets/tabs/user.png"),
};

/** Die vier Tabs in ihrer Reihenfolge. `href` ist der Pfad, `name` der
 *  Routenname (den braucht nur die Sonderbehandlung fürs Schließen der Suche). */
const TABS = [
  { name: "index", href: "/", labelKey: "bottomnav.booking" },
  { name: "surroundings", href: "/surroundings", labelKey: "bottomnav.surroundings" },
  { name: "saved", href: "/saved", labelKey: "bottomnav.saved" },
  { name: "settings", href: "/settings", labelKey: "bottomnav.settings" },
] as const;

/**
 * Aktiv ist WEISS, nicht der Akzent.
 *
 * Zwischendurch stand hier `accent.solid`, damit die Farbwahl aus den
 * Einstellungen die Leiste wieder erreicht. Das war der falsche Ort dafür: Ein
 * grünes oder mintfarbenes Symbol liest sich in einer Leiste nicht als „hier bin
 * ich", sondern als eigener Zustand. Der Akzent gehört auf Knöpfe und
 * Auswahlen, die Leiste unterscheidet über hell gegen gedämpft.
 */
/**
 * Bildschirme OHNE Tab-Leiste.
 *
 * Als Präfix geprüft, damit Unterpfade mitgehen. Bo hat eine eigene
 * Eingabezeile am unteren Rand (63dp), die exakt unter der Leiste läge; die
 * Routen-Karte und die Spracheingabe füllen den Bildschirm und haben eigene
 * Bedienelemente unten.
 */
const HIDE_ON = ["/search/route-map", "/search/voice"] as const;


const ACTIVE = "#F4F4F5";
const INACTIVE = "#8E8E93";

/**
 * Höhe der Leiste OHNE die sichere Fläche darunter.
 *
 * Exportiert, weil andere Bildschirme genau wissen müssen, wo sie endet — der
 * Such-Screen legt sich bis dorthin und keinen Pixel weiter. Mit einer Schätzung
 * (der Konstante NAVBAR_SPACE) klaffte darunter eine Lücke, durch die man den
 * Landingscreen sah.
 */
/**
 * ROHWERT. Wer ihn außerhalb eines Stilblatts benutzt, muss `ms()` selbst
 * anwenden (siehe `useNavbarSpace`) — innerhalb eines Stilblatts erledigt das
 * `scaledStyles`, und beides zusammen wäre der Faktor zweimal.
 */
export const TAB_BAR_H = 66;
/**
 * Für alles AUSSERHALB des Stilblatts — dort skaliert `scaledStyles` selbst.
 *
 * Die Leiste rechnet ihre Deckung und die Höhe ihres Hintergrunds direkt aus,
 * beides als Zahl in einem Stil-Objekt am Ort. Diese Zahlen laufen an keinem
 * Stilblatt vorbei und brauchen den Faktor daher hier.
 */
const BAR_H = ms(TAB_BAR_H);
const ICON = 26;
/** Durchmesser des roten Punktes am Symbol. */
const BADGE = 9;

/**
 * Wo im Bild steckt das Zeichen wirklich?
 *
 * Nicht in der Ecke — die Dateien haben durchsichtigen Rand eingebacken. Der
 * Punkt hing deshalb sichtbar neben dem Zeichen: Er saß an der Ecke des FELDES,
 * und die liegt beim Kalender knapp 2 Punkt weiter rechts und 1 Punkt weiter
 * oben als die Ecke des Zeichens selbst.
 *
 * Die Zahlen sind gemessen, nicht geschätzt — Alpha-Grenzen von
 * `assets/tabs/calendar@3x.png` (72x72 Quellpixel, Schwelle 64, um die
 * Kantenglättung nicht mitzuzählen): oben bei 3, rechts endet es bei 67. Bei
 * einem quadratischen Bild in einem quadratischen Feld ist der Maßstab überall
 * gleich, also lässt sich das direkt umrechnen.
 *
 * Nur der Kalender ist gemessen, weil nur er den Punkt trägt. Bekommt je ein
 * anderes Symbol einen, muss dessen Rand hier mit hinein.
 */
const BADGE_ICON_SRC = 72;
const BADGE_ICON_TOP = 3;
const BADGE_ICON_RIGHT = 67;
const BADGE_ICON_LEFT = 5;
const BADGE_ICON_BOTTOM = 70;
const PX = ICON / BADGE_ICON_SRC;

/**
 * Und dann noch ein Stück nach innen.
 *
 * Genau auf der Ecke saß der Punkt rechnerisch richtig, sah aber zu weit
 * abgesetzt aus — was daran liegt, dass die Ecke eines Kalenderblatts nicht die
 * Ecke einer gefüllten Fläche ist: Dort treffen zwei dünne Striche zusammen, und
 * das Auge nimmt die Kontur wahr, nicht das Rechteck darum.
 *
 * Deshalb wird die Ecke um diesen Anteil auf die Mitte des Zeichens zubewegt.
 * Kein fester Versatz in Punkten, sondern eine Strecke zwischen zwei gemessenen
 * Orten — dadurch bleibt es richtig, falls sich Symbolgröße oder Bild ändern.
 */
const BADGE_PULL_IN = 0.15;

/**
 * Der Punkt bekommt eine Aussparung im Symbol.
 *
 * Er saß direkt auf den Strichen des Kalenders — zwei rote Ränder an dünnen
 * weißen Linien, das liest sich als Gedränge, nicht als Hinweis. Dahinter liegt
 * jetzt ein größerer Kreis in der Farbe der Leiste. Er überdeckt den Punkt
 * nicht, er liegt DARUNTER; sichtbar ist von ihm nur der Ring, der ringsum
 * hervorschaut, und der schneidet das Symbol an dieser Stelle sauber weg.
 *
 * Drei Punkt Luft auf jeder Seite.
 */
const BADGE_RING = BADGE + 6;

/**
 * Die Aussparung braucht eine DECKENDE Farbe.
 *
 * Die Leiste selbst ist getönt, nicht deckend (siehe BAR_TINT) — mit derselben
 * Angabe schiene das Symbol durch die Aussparung hindurch, und genau die soll
 * sie ja wegnehmen. Hier stehen dieselben Farbwerte ohne die Durchsichtigkeit.
 * Da die Leiste zu 92-93% deckt, ist der Unterschied zur gemischten Fläche
 * darunter kleiner als eine Stufe im Farbwert.
 */
const BAR_SOLID: Record<string, string> = {
  dark: "#171719",
  gray: "#171719",
  light: "#171719",
};
const GLYPH_CX = ((BADGE_ICON_LEFT + BADGE_ICON_RIGHT) / 2) * PX;
const GLYPH_CY = ((BADGE_ICON_TOP + BADGE_ICON_BOTTOM) / 2) * PX;
/** Zielpunkt für den Mittelpunkt des Punktes, vom Feldrand aus gemessen. */
const GLYPH_TOP = BADGE_ICON_TOP * PX + (GLYPH_CY - BADGE_ICON_TOP * PX) * BADGE_PULL_IN;
const GLYPH_RIGHT_INSET =
  (BADGE_ICON_SRC - BADGE_ICON_RIGHT) * PX +
  (BADGE_ICON_RIGHT * PX - GLYPH_CX) * BADGE_PULL_IN;

interface ItemProps {
  /** Einfache Werte statt des Routen-Objekts: React Navigation baut `routes`
   *  bei JEDER Zustandsänderung neu auf, das Objekt hat also nie dieselbe
   *  Identität — `memo` verglich damit garantiert ungleich und lief nie. */
  routeKey: string;
  routeName: string;
  label: string;
  focused: boolean;
  /** Roter Punkt am Symbol — „hier ist etwas Neues". */
  badge?: boolean;
  /** Deckende Farbe der Leiste — füllt die Aussparung um den Punkt. */
  barSolid: string;
  onPress: (routeName: string, routeKey: string, focused: boolean) => void;
}

const TabItem = memo(function TabItem({
  routeKey,
  routeName,
  label,
  focused,
  badge,
  barSolid,
  onPress,
}: ItemProps) {
  // Kräftiger als der Standard (0.93): Auf einem 26px-Symbol ist derselbe
  // prozentuale Weg viel weniger sichtbar als auf einer großen Kachel.
  const bounce = usePressBounce(0.82);
  const icon = ICONS[routeName];
  /** Merkt, dass `onPressIn` schon gehandelt hat — siehe `onPress`. */
  const handledRef = useRef(false);
  const handledTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (handledTimer.current) clearTimeout(handledTimer.current);
    },
    [],
  );

  return (
    <Pressable
      style={styles.item}
      // Kein `onPress`: Der Wechsel hängt bewusst am Aufsetzen des Fingers.
      // `Pressable` verzögert `onPressIn` nicht (anders als RippleTouch mit
      // seinen 50ms) — hier ist das genau richtig, denn eine Tab-Leiste ist
      // nichts, worauf man scrollt.
      onPressIn={() => {
        // Der Handler läuft AUCH auf dem bereits aktiven Tab — nur die
        // Navigation darin nicht.
        //
        // Vorher stand hier `if (!focused)`, und damit war der Weg zurück aus
        // dem Such-Screen tot: Der hängt nicht an einer Route, sondern am
        // Speicher — `pathname` steht also weiter auf „/", der Home-Tab gilt als
        // aktiv, und ein Tipp darauf tat gar nichts. Vorher schloss genau das
        // das Blatt. Die native Leiste meldete den Tipp ebenfalls immer und
        // stieg erst DANACH aus.
        /**
         * Der Riegel verfällt von selbst.
         *
         * Er wurde nur in `onPress` gelöscht — und das kommt gar nicht, wenn der
         * Finger von der Fläche weggezogen wird. Danach blieb er gesetzt und
         * verschluckte die NÄCHSTE Aktivierung über die Barrierefreiheit, also
         * genau den Weg, den er absichern soll. Ihn stattdessen in `onPressOut`
         * zu löschen ginge nicht: Der läuft VOR `onPress`, damit wäre der Riegel
         * immer schon offen.
         *
         * Eine halbe Sekunde ist reichlich für das Paar aus einem echten Tipp und
         * weit unter dem Abstand, in dem eine Bedienung über die
         * Barrierefreiheit folgt.
         */
        handledRef.current = true;
        if (handledTimer.current) clearTimeout(handledTimer.current);
        handledTimer.current = setTimeout(() => {
          handledRef.current = false;
        }, 500);
        onPress(routeName, routeKey, focused);
        bounce.onPressIn();
      }}
      onPressOut={bounce.onPressOut}
      // Zusätzlich zu `onPressIn`: Eine Aktivierung über die Barrierefreiheit
      // (TalkBack-Doppeltipp) oder eine externe Tastatur läuft in React Native
      // AUSSCHLIESSLICH über `onPress` — es gibt keinen Pfad zu `onPressIn`.
      // Ohne das war der Tab-Wechsel für diese Wege gar nicht möglich. Der
      // Riegel verhindert, dass beim normalen Tippen beides feuert.
      onPress={() => {
        if (handledRef.current) {
          handledRef.current = false;
          return;
        }
        onPress(routeName, routeKey, focused);
      }}
      accessibilityRole="tab"
      accessibilityState={{ selected: focused }}
      android_ripple={{ color: "rgba(255,255,255,0.08)", borderless: true, radius: 34 }}
    >
      {/* Symbol UND Beschriftung im selben Rahmen — der Druck-Effekt soll das
          Feld als Ganzes stauchen, nicht nur das Bild darin. */}
      <Animated.View style={[styles.itemInner, bounce.style]}>
        {icon ? (
          // Eigener Rahmen NUR um das Bild — der Punkt darin bezieht sich damit
          // auf das Symbol. Läge er eine Ebene höher, säße er am rechten Rand
          // der BESCHRIFTUNG, und die ist deutlich breiter als die 26 Punkt des
          // Bildes; er stünde also sichtbar daneben statt daran.
          <View style={styles.iconBox}>
            <Image
              source={icon}
              style={[styles.icon, { tintColor: focused ? ACTIVE : INACTIVE }]}
              // Die Symbole liegen in mehreren Auflösungen vor und werden auf 26
              // gezeigt. Ohne das dekodiert Android die volle Größe und skaliert
              // bei jedem Zeichnen herunter.
              resizeMethod="resize"
              resizeMode="contain"
              fadeDuration={0}
            />
            {badge ? (
              <>
                <View style={[styles.badgeRing, { backgroundColor: barSolid }]} />
                <View style={styles.badge} />
              </>
            ) : null}
          </View>
        ) : null}
        <Text
          style={[styles.label, { color: focused ? ACTIVE : INACTIVE }]}
          numberOfLines={1}
        >
          {label}
        </Text>
      </Animated.View>
    </Pressable>
  );
});

/**
 * Tönung der Leiste, je Thema.
 *
 * EINE Farbe für beide Themen geht nicht auf: `rgba(7,7,8,0.93)` sitzt im
 * Dark-Theme richtig (Hintergrund ist dort echtes Schwarz, die Leiste hebt sich
 * gerade eben ab). Über dem Grau-Theme mit seinem #0D0D0D wirkt dieselbe Farbe
 * wie ein dunkles Loch — dort muss die Leiste HELLER sein als der Untergrund,
 * nicht dunkler, sonst liest sie sich nicht als eigene Fläche.
 *
 * Die Deckkraft bleibt in beiden Fällen unter 1, der Inhalt scheint also weiter
 * durch.
 */
const BAR_TINT: Record<string, string> = {
  // Dark bekommt DENSELBEN Ton wie Grau: Zwischen den Themes wechselt nur der
  // Bildschirm, nicht die Flächen darauf (siehe lib/theme/appBg.ts).
  dark: "rgba(23,23,25,0.92)",
  // Die Leiste liegt auf der Stufe der Eingabeflächen (s1, #171719), nicht auf
  // der der Karten und Knöpfe (s2): Über dem Hintergrund gemischt ergibt das
  // rund #161618 — gerade genug Abstand, um als eigene Fläche gelesen zu
  // werden, ohne wie ein aufgesetzter Balken zu wirken.
  //
  // Die Zahlen sind mit der Palette gewandert (früher rgba(31,31,32) auf
  // #1A1A1A); das Verhältnis ist dasselbe geblieben.
  gray: "rgba(23,23,25,0.92)",
  light: "rgba(23,23,25,0.92)",
};

export function BinchTabBar() {
  const insets = useSafeAreaInsets();
  const theme = useSearchStore((st) => st.theme);
  const barSolid = BAR_SOLID[theme] ?? BAR_SOLID.gray;

  const t = useT();
  /**
   * Die Leiste hängt am WURZEL-Layout, nicht mehr im Tab-Baum — nur von dort
   * liegt sie über dem Such-Screen, statt von ihm verdeckt zu werden.
   *
   * Damit gibt es hier keinen Navigator-Kontext mehr. Statt `useNavigationState`
   * und `dispatch` läuft beides über expo-router: der Pfad sagt, welcher Tab
   * aktiv ist, und `router.navigate` schaltet um. Das geht durch denselben
   * Navigator und schaltet die Seiten weiterhin nativ um.
   */
  // Zähler im Speicher, hier nur „gibt es überhaupt etwas?" — siehe dort.
  const savedBadge = useSearchStore((st) => st.savedBadge > 0);
  const pathname = usePathname();
  /**
   * Verstecken über eine SPERRLISTE, nicht über eine Erlaubnisliste.
   *
   * Hier stand „zeige die Leiste nur, wenn der Pfad exakt einer der vier Tabs
   * ist". Das hatte einen guten Grund — sie hängt am Wurzel-Layout und lag sonst
   * über Bildschirmen ohne Tabs, allen voran über Bos Eingabezeile. Aber die
   * Regel greift zu weit: Auf dem Rückweg aus der Ergebnisliste steht der Pfad
   * noch auf `/search/results`, bis die Route wirklich gepoppt ist — Schließ-
   * Bewegung plus Stapel-Aufräumen. Solange war die Leiste weg, und der
   * Landingscreen stand ohne sie da. Genau die Sekunden, die als „die braucht
   * erst zwei Sekunden" auffielen.
   *
   * Andersherum stimmt es: Es gibt eine kurze, benennbare Liste von
   * Bildschirmen, auf denen die Leiste nichts zu suchen hat. Überall sonst darf
   * sie stehen — bildschirmfüllende Überlagerungen wie die Ergebnisliste liegen
   * ohnehin ÜBER ihr (siehe Reihenfolge im Wurzel-Layout) und verdecken sie,
   * ohne dass jemand sie ausblenden müsste.
   */
  const hidden = HIDE_ON.some((prefix) => pathname.startsWith(prefix));

  /**
   * Welcher Tab gilt als aktiv, wenn der Pfad gerade woanders steht?
   *
   * Der zuletzt besuchte. Ohne das wäre auf jedem Nicht-Tab-Pfad KEIN Tab
   * hervorgehoben, und beim Zurückkommen blitzte die Leiste ohne Auswahl auf.
   */
  const activeHrefRef = useRef(TABS[0].href as string);
  const matched = TABS.find((tab) => tab.href === pathname);
  if (matched) activeHrefRef.current = matched.href;
  const activeHref = activeHrefRef.current;

  const go = useCallback((routeName: string, href: string, focused: boolean) => {
    /**
     * HIER wird die Textur des Landingscreens NICHT mehr angefordert.
     *
     * Der Gedanke war: Solange der Tab verdeckt war, wurde er nicht gezeichnet;
     * fordert man die Ebene erst nach dem Wechsel an, rastert Android dieselbe
     * Fläche ein zweites Mal. Also vorher anfordern, dann geht die erste
     * Zeichnung direkt in die Ebene.
     *
     * Am Gerät kam dabei ein sichtbarer Fehler heraus: ein schwarzer Balken am
     * oberen Rand, der erst nach ein bis zwei Sekunden die Hintergrundfarbe
     * annahm. Der Puffer einer GPU-Ebene entsteht leer — wird sie angelegt,
     * bevor die Seite gezeichnet ist, sieht man genau das. Und der erhoffte
     * Gewinn blieb aus: Der gemeldete Ruckler beim Wechsel Umgebung →
     * Landingscreen → Bo war unverändert.
     *
     * Ein Eingriff, der einen sichtbaren Fehler einbringt und die Ursache nicht
     * trifft, gehört zurückgenommen. Die Ebene wird wieder dort angefordert, wo
     * sie sicher ist: beim Aufsetzen des Fingers, wenn die Seite längst steht.
     */
    // ZUERST der Wechsel — alles andere danach. Siehe Kopf der Datei.
    // Auf dem aktiven Tab entfällt er; der Rest unten läuft trotzdem.
    if (!focused) router.navigate(href as never);

    /**
     * Was früher am `tabPress`-Ereignis des Navigators hing. Das Ereignis kommt
     * von der nativen Leiste, und die ist weg; `navigate` löst es nicht aus.
     * Beides muss deshalb hier stehen, sonst verstummen zwei Mechanismen, ohne
     * dass etwas offensichtlich kaputt aussieht.
     */
    // 1. Der Takt ALLER Tabs — daran hängen die „schnell durchgeklickt"-
    //    Erkennung der Einblend-Welle und das aufgeschobene Einfrieren der Karte.
    noteTabPress();
    // 2. Den Such-Screen schließen — bei JEDEM Tab, nicht nur beim Home-Tab.
    //
    //    Die Einschränkung auf „index" stammte von der nativen Leiste, wo sie
    //    einen Grund hatte: Dort wäre der Landingscreen sonst freigegeben
    //    worden, BEVOR der Wechsel greift, und man hätte ihn kurz aufblitzen
    //    sehen. Das Blatt hängt aber gar nicht am Home-Tab — aus der Umgebung
    //    heraus öffnet es der Dialog „Verbindung nicht gefunden", und der Tab
    //    bleibt dabei stehen. Mit der Einschränkung blieb es dann beim
    //    Tab-Wechsel offen über dem neuen Tab stehen, mit dem Zurück-Pfeil als
    //    einzigem Ausweg.
    //
    //    Die Abfrage davor ist nicht Zierde: `closeSearchOverlay` ist ein
    //    ungeschütztes set().
    if (useSearchStore.getState().searchOverlayMode != null) {
      useSearchStore.getState().// MIT `true`: der Sofort-Zweig ohne Bewegung. Ohne das Argument fuhr das
      // Blatt seine volle Ausfahrt über den Tab-Wechsel hinweg — und der
      // Kommentar im Blatt beschreibt für genau diesen Fall einen Weg, den der
      // Code gar nicht nahm.
      closeSearchOverlay(true);
    }
    haptic("button");
  }, []);

  /**
   * Der Wert steht auf 0, solange Bo nicht im Spiel ist — die Formel gilt also
   * überall und braucht keine Fallunterscheidung. Nur die Tipp-Sperre unten
   * braucht den Pfad: Auf halb durchsichtige Symbole soll man nicht drücken.
   */
  /**
   * Bo überdeckt die Leiste inzwischen wirklich — sie muss nichts mehr tun.
   *
   * Er hängt seit dem Umbau NACH dieser Leiste im Wurzel-Layout und fährt als
   * Push von rechts über sie hinweg. Vorher lag er im Navigations-Stapel, also
   * davor, und konnte sie baulich nicht überdecken; deshalb stand hier ein
   * Ausblenden. Das war beim Blatt von unten unauffällig (er hatte sie ohnehin
   * gleich verdeckt) und beim Push von rechts sichtbar falsch: Die Leiste war
   * nach einem Zehntel der Fahrt weg, während Bo noch fast ganz rechts stand.
   *
   * Geblieben ist nur die Frage, ob sie noch anfassbar sein soll — und das ist
   * sie nicht, solange Bo darüber liegt.
   */
  /**
   * Ab welchem Anteil von Bos Weg liegt er vollständig über der Leiste?
   *
   * Bo fährt über die ganze Bildschirmhöhe. Seine Oberkante hat die Leiste also
   * passiert, sobald er ihre Höhe zurückgelegt hat — das ist dieser Anteil. Die
   * Deckkraft läuft über genau diese Strecke herunter und auf dem Rückweg über
   * dieselbe wieder hinauf: Die Leiste ist exakt so lange zu sehen, wie sie
   * nicht verdeckt ist.
   */

  /**
   * Die Deckkraft hängt am Pfad UND am Wert, nicht nur am Wert.
   *
   * Bo bleibt gemountet, wenn er selbst die Ergebnisliste öffnet — der Wert
   * steht dann weiter auf 1, obwohl Bo im Hintergrund liegt. Ohne die Abfrage
   * wäre die Leiste auf der Ergebnisliste unsichtbar, aber anfassbar: Sie ist
   * dort zwar von der Liste verdeckt, doch das ist eine Eigenschaft der
   * Reihenfolge im Wurzel-Layout und keine, auf die man sich verlassen sollte.
   */
  /**
   * Die Leiste GEHT MIT dem Landingscreen — sie verschwindet nicht mehr vorweg.
   *
   * Hier stand `opacity: 1 - p / coverFrac` mit `coverFrac = Leistenhöhe /
   * Fensterhöhe`, also rund 0,1. Das war für Bos frühere Bewegung gerechnet: Er
   * kam von UNTEN, und sobald er die Leistenhöhe überfahren hatte, war sie
   * ohnehin verdeckt — das Ausblenden fiel nicht auf.
   *
   * Seit Bo von RECHTS hereinfährt, stimmt diese Geometrie nicht mehr: Nach 10%
   * der Fahrt ist die Leiste komplett weg, während Bo noch fast ganz rechts
   * steht. Genau das sieht man als „die Leiste verschwindet einfach".
   *
   * Jetzt läuft sie denselben Weg wie der Landingscreen, dem sie gehört: nach
   * links im Parallax, dabei über die volle Fahrt ausblendend. Sie zieht sich
   * also mit ihrem Bildschirm zurück, statt vorweg zu verschwinden.
   *
   * Warum nicht einfach dahinter? Weil Bo im Router-Stapel liegt und der im
   * Wurzel-Layout VOR der Leiste steht — er kann sie baulich nicht überdecken.
   * Ergebnisliste und Detail-Blatt können es, weil sie danach stehen. Bo dorthin
   * zu holen hieße, ihn aus dem Stapel zu nehmen; das ist ein eigener Umbau.
   */
  /**
   * Der Wurzel-Stil EINMAL, nicht pro Durchgang neu.
   *
   * Ein frisches Array oder Objekt auf einem animierten Knoten ist auf Fabric
   * nicht bloß Arbeit für den Vergleicher, sondern ein Commit auf genau dem
   * Knoten, den Reanimated Bild für Bild beschreibt. Dieselbe Änderung wie an
   * Detail-, Ticket- und Profil-Blatt.
   */
  const barStyle = useMemo(
    () => [
      styles.bar,
      {
        paddingBottom: insets.bottom,
        height: BAR_H + insets.bottom,
        backgroundColor: BAR_TINT[theme] ?? BAR_TINT.gray,
      },
    ],
    [insets.bottom, theme],
  );


  if (hidden) return null;

  return (
    <Animated.View
      /**
       * IMMER anfassbar — die Ausnahme für Bo war ein Fehler.
       *
       * Hier stand `onAssistant ? "none" : "auto"`, und der Merker dahinter gilt
       * über Bos GANZE Ausfahrt: Er fällt erst, wenn die Kurve durch ist, rund
       * eine halbe Sekunde nachdem Bo aus dem Bild gefahren ist. In diesem
       * Fenster war die Leiste für Berührungen durchlässig — ein Tipp auf einen
       * Tab fiel durch auf das, was darunter lag, und öffnete dort etwas
       * anderes. Genau das gemeldete „der Tab-Wechsel kommt nicht an, stattdessen
       * lande ich im Such-Screen".
       *
       * Gebraucht wird die Ausnahme gar nicht: Bo hängt seit dem Umbau NACH
       * dieser Leiste im Wurzel-Layout, wird also über ihr gezeichnet — und die
       * Berührungsverteilung fragt von oben nach unten. Solange er das Feld
       * deckt, bekommt er den Tipp; sobald er weg ist, die Leiste. Das ist genau
       * das gewünschte Verhalten, und es braucht keinen Merker.
       *
       * Die Ausnahme stammt aus der Zeit, als Bo eine Route war und BAULICH
       * unter der Leiste lag. Damals war sie richtig.
       */
      pointerEvents="auto"
      style={barStyle}
      // Der Inhalt scheint durch: Die Fläche ist dunkel getönt statt deckend,
      // und die Seiten darunter haben volle Höhe (die Bibliothek gibt ihnen
      // `fullWidth`, sobald eine eigene Leiste gesetzt ist).
    >
      {TABS.map((tab) => (
        <TabItem
          key={tab.name}
          routeKey={tab.href}
          routeName={tab.name}
          label={t(tab.labelKey)}
          focused={activeHref === tab.href}
          badge={tab.name === "saved" && savedBadge}
          barSolid={barSolid}
          onPress={go}
        />
      ))}
    </Animated.View>
  );
}

const styles = scaledStyles({
  bar: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: "row",
    alignItems: "center",
    // Die Farbe kommt zur Laufzeit aus BAR_TINT (siehe dort) — sie hängt am
    // gewählten Thema. Die Abgrenzung nach oben trägt allein diese Fläche:
    // Vorher lag dort eine Haarlinie im Akzentton, die sich als grüner Strich
    // las statt als Kante.
  },
  item: {
    flex: 1,
    // Rohwert: Dieses Stilblatt läuft durch `scaledStyles`.
    height: TAB_BAR_H,
    alignItems: "center",
    justifyContent: "center",
  },
  itemInner: { alignItems: "center", justifyContent: "center", gap: 3 },
  iconBox: { width: ICON, height: ICON },
  /**
   * Mittelpunkt GENAU auf der oberen rechten Ecke des ZEICHENS.
   *
   * Zwei Korrekturen stecken in den beiden Zahlen, und beide sind nötig:
   *
   *  • der eingebackene Rand des Bildes (GLYPH_*) — sonst sitzt der Punkt an der
   *    Ecke des Feldes statt an der des Zeichens;
   *  • der halbe Durchmesser — `top: 0` setzte die KANTE des Punktes auf die
   *    Ecke, nicht sein Zentrum, und verschöbe ihn um seinen halben Durchmesser
   *    nach innen.
   *
   * Dasselbe Rot wie das gefüllte Herz an den Karten und der Abmelden-Knopf —
   * es ist in der App die Farbe für „beachte mich".
   */
  /** Gleicher Mittelpunkt wie der Punkt, nur größer — daher dieselbe Rechnung
   *  mit dem eigenen Durchmesser. Liegt davor im Baum, also darunter im Bild. */
  badgeRing: {
    position: "absolute",
    top: GLYPH_TOP - BADGE_RING / 2,
    right: GLYPH_RIGHT_INSET - BADGE_RING / 2,
    width: BADGE_RING,
    height: BADGE_RING,
    borderRadius: BADGE_RING / 2,
  },
  badge: {
    position: "absolute",
    top: GLYPH_TOP - BADGE / 2,
    right: GLYPH_RIGHT_INSET - BADGE / 2,
    width: BADGE,
    height: BADGE,
    borderRadius: BADGE / 2,
    backgroundColor: "#FF3B5C",
  },
  icon: { width: ICON, height: ICON },
  label: { fontSize: 11, fontWeight: "600", letterSpacing: -0.1 },
});
