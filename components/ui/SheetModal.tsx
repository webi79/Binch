import { useCallback, useEffect, useRef, type ReactNode } from "react";
import {
  Dimensions,
  Modal,
  Pressable,
  StyleSheet,
  View,
  type LayoutChangeEvent,
  type TextStyle,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Animated, {
  FadeIn,
  FadeOut,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { GestureDetector, GestureHandlerRootView } from "react-native-gesture-handler";
import { usePalette } from "@/lib/theme/appBg";
import { SHEET_IN, SHEET_OUT, markSheetMoving } from "@/lib/nav/overlayCover";
import { scaledStyles } from "@/lib/ui/compact";
import { useSheetSwipe } from "@/lib/ui/sheetSwipe";

/**
 * Blatt von unten — die Hülle, die sich das Ticket-Blatt und die Optionen des
 * Such-Screens teilen.
 *
 * Bewegung, Kurve und Dauer sind die von `AddTicketModal` (Saved-Tab,
 * „Ticket hinzufügen"), und zwar nicht nachgebaut, sondern über dieselben
 * zentralen Werte: `SHEET_IN` (300ms) herein, `SHEET_OUT` (260ms) hinaus, beide
 * mit `SHEET_EASE`. Wer dort etwas ändert, ändert es hier mit — genau dafür
 * stehen die Zahlen in `overlayCover`.
 *
 * Die drei Eigenheiten, die dort teuer erarbeitet wurden, gelten auch hier:
 *
 *  1. `animationType="none"` — die Fenster-Animation von Android ist in ihrer
 *     Dauer nicht einstellbar und deutlich schneller als alles andere in der
 *     App. Das Fenster gibt nur die Fläche frei, die Bewegung kommt aus
 *     Reanimated.
 *  2. Kein `entering` am Blatt, sondern ein eigener Wert: Der Baum entsteht mit
 *     dem Fenster neu, und eine Ein-Sprung-Animation hängt die Ansichten erst an
 *     ihrem ENDplatz ein. Trifft das ein Bild schlecht, steht der Inhalt kurz
 *     oben, bevor er von unten hereinfährt. Stattdessen wird er unterhalb des
 *     Bildrands geparkt und fährt ein Bild später los — der Aufbau ist dann
 *     durch.
 *  3. Erst hinausfahren, DANN abmelden. Fällt `visible`, ist das Fenster samt
 *     Inhalt weg; eine Aussprung-Animation hätte keine Fläche mehr.
 */
interface Props {
  visible: boolean;
  /** Läuft, wenn das Blatt unten angekommen ist — hier `visible` zurücknehmen. */
  onClose: () => void;
  /** Inhalt. `close` fährt hinaus und meldet danach ab. */
  children: (close: () => void) => ReactNode;
}

export function SheetModal({ visible, onClose, children }: Props) {
  const closeRef = useRef<() => void>(onClose);
  closeRef.current = onClose;
  // Feste Kennung — sonst liefe der Effekt im Blatt bei jedem Bild neu an.
  const registerClose = useCallback((fn: () => void) => {
    closeRef.current = fn;
  }, []);
  return (
    <Modal
      visible={visible}
      animationType="none"
      transparent
      presentationStyle="overFullScreen"
      // Bis an beide Ränder — sonst bliebe unten ein Streifen der App stehen
      // (bei uns die Tab-Leiste, die unter dem Blatt hervorschaut). Den sicheren
      // Abstand trägt dafür das Blatt selbst, siehe `bottomPad`.
      statusBarTranslucent
      navigationBarTranslucent
      // Systemtaste „zurück" nimmt den Weg MIT Bewegung: Das Fenster meldet sie,
      // den Weg kennt aber nur das Blatt darin — es hinterlegt ihn beim Aufbau.
      onRequestClose={() => closeRef.current()}
    >
      {visible ? (
        <Sheet onClose={onClose} registerClose={registerClose}>
          {children}
        </Sheet>
      ) : null}
    </Modal>
  );
}

function Sheet({
  onClose,
  registerClose,
  children,
}: {
  onClose: () => void;
  registerClose: (fn: () => void) => void;
  children: (close: () => void) => ReactNode;
}) {
  const palette = usePalette();
  const insets = useSafeAreaInsets();
  const bottomPad = 20 + insets.bottom;

  /**
   * Parkplatz unterhalb des Bildrands. Die Fensterhöhe, nicht eine feste Zahl:
   * Auf einem kurzen Bildschirm parkte das Blatt mit 900 weit außerhalb, und
   * käme die Einfahrt aus irgendeinem Grund nicht zustande, läge es
   * unerreichbar dort unten.
   */
  const translateY = useSharedValue(Dimensions.get("window").height);
  /**
   * Geteilter Wert, keine React-Ablage: Die Höhe braucht auch die Wisch-Geste,
   * und die läuft auf dem UI-Strang. Ein `useRef` wird beim Anlegen eines
   * Worklets kopiert — die Messung passiert aber erst danach, der Wert dort
   * bliebe also dauerhaft 0.
   */
  const sheetH = useSharedValue(0);
  const started = useRef(false);
  /**
   * Notanlauf, falls die Vermessung nichts Brauchbares liefert.
   *
   * Die Einfahrt hängt an `onLayout`: erst mit der echten Höhe steht fest, wie
   * weit unten das Blatt zu parken ist. Meldet die Vermessung im Fenster des
   * Blattes aber 0 — und das kann sie, solange das Fenster selbst noch keine
   * Höhe hat —, wird der Zweig übersprungen und NICHTS setzt ihn erneut an.
   * Das Blatt bliebe dann unten stehen: sichtbar ist die Verdunkelung, drücken
   * lässt sich nichts.
   *
   * Nach zwei Bildern wird deshalb notfalls von Hand angeschoben. Kam die echte
   * Höhe rechtzeitig, passiert hier gar nichts — `started` ist dann längst
   * gesetzt.
   */
  useEffect(() => {
    const id = setTimeout(() => {
      if (started.current) return;
      started.current = true;
      const fallback = Dimensions.get("window").height * 0.6;
      sheetH.value = fallback;
      translateY.value = fallback;
      markSheetMoving();
      translateY.value = withTiming(0, SHEET_IN);
    }, 32);
    return () => clearTimeout(id);
  }, [translateY, sheetH]);
  const onSheetLayout = useCallback(
    (e: LayoutChangeEvent) => {
      const h = e.nativeEvent.layout.height;
      if (h <= 0) return;
      sheetH.value = h;
      if (started.current) return;
      started.current = true;
      // Erst jetzt ist die echte Höhe bekannt — vorher stünde das Blatt entweder
      // zu weit unten (Ersatzwert zu groß) oder ragte schon herein (zu klein).
      translateY.value = h;
      requestAnimationFrame(() => {
        markSheetMoving();
        translateY.value = withTiming(0, SHEET_IN);
      });
    },
    [translateY, sheetH],
  );

  const sheetAnim = useAnimatedStyle(() => ({
    transform: [{ translateY: translateY.value }],
  }));

  const closingRef = useRef(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (closeTimer.current) clearTimeout(closeTimer.current);
    },
    [],
  );
  /**
   * Nur den Abschluss planen — die Bewegung macht der Aufrufer.
   *
   * Getrennt, weil die Wisch-Geste sie selbst schon fährt: Sie läuft auf dem
   * UI-Strang und kann den Wert ohne Umweg setzen. Ginge auch ihr Weg über
   * diese Funktion, läge zwischen Loslassen und Losfahren ein Sprung auf den
   * JS-Strang — ein Bild, das man bei einer Wisch-Geste spürt.
   */
  /**
   * Die Kennung dieser Funktion muss FEST sein.
   *
   * An ihr hängen `requestClose`, der Effekt, der die Zurück-Taste hinterlegt,
   * und die Wisch-Geste. Hing sie am Rückruf von außen, genügte ein Aufrufer,
   * der ihn als Pfeilfunktion hineinschreibt (`onClose={() => ...}`), damit bei
   * JEDEM Durchgang des Bildschirms darüber alle drei neu entstehen — die Geste
   * also mitten im Blatt neu eingerichtet wird. Der Rückruf kommt deshalb aus
   * einem Merker, der still nachgeführt wird.
   */
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const scheduleClose = useCallback((afterMs: number) => {
    if (closingRef.current) return;
    closingRef.current = true;
    closeTimer.current = setTimeout(() => onCloseRef.current(), afterMs);
  }, []);

  /** Antippen: hinausfahren und danach abmelden. */
  const requestClose = useCallback(() => {
    if (closingRef.current) return;
    markSheetMoving(SHEET_OUT.duration);
    translateY.value = withTiming(sheetH.value || 900, SHEET_OUT);
    scheduleClose(SHEET_OUT.duration);
  }, [scheduleClose, translateY, sheetH]);
  useEffect(() => registerClose(requestClose), [registerClose, requestClose]);

  /**
   * Die Wisch-Geste liegt auf dem GANZEN Blatt, nicht mehr nur auf dem Griff.
   *
   * Sie kommt aus `useSheetSwipe` — dort steht auch, warum ein Tipper auf einen
   * Knopf trotzdem ein Tipper bleibt. Eine Liste hat hier keines der drei
   * Blätter (Uhrzeit, Reisende, Klasse); käme eine dazu, gehört ihr der
   * Torhüter aus derselben Datei.
   */
  const panGesture = useSheetSwipe({
    y: translateY,
    travel: sheetH,
    onDismiss: scheduleClose,
  });

  return (
    <GestureHandlerRootView style={styles.root}>
      {/* Verdunkelung und Blatt bewegen sich getrennt — 1:1 wie im Ticket- und
          im Verlaufs-Blatt. */}
      <Animated.View
        entering={FadeIn.duration(SHEET_IN.duration)}
        exiting={FadeOut.duration(SHEET_OUT.duration)}
        style={styles.backdrop}
      >
        <Pressable style={StyleSheet.absoluteFill} onPress={requestClose} />
      </Animated.View>
      <View style={styles.sheetWrap} pointerEvents="box-none">
        <GestureDetector gesture={panGesture}>
          <Animated.View
            onLayout={onSheetLayout}
            style={[
              styles.sheet,
              { backgroundColor: palette.s1, paddingBottom: bottomPad },
              sheetAnim,
            ]}
          >
            {/* Der Strich ist nur noch Zeichen, nicht mehr Griff: Gezogen wird
                überall. Er bleibt, weil er ansagt, DASS gezogen werden kann. */}
            <View style={styles.handleWrap}>
              <View style={styles.handle} />
            </View>

            {children(requestClose)}
          </Animated.View>
        </GestureDetector>
      </View>
    </GestureHandlerRootView>
  );
}

/**
 * Titel und Unterzeile eines Blattes — EINMAL, für alle.
 *
 * Es gab hiervon zwei Fassungen, und keine wusste von der anderen: Die Wähler
 * (Ort, Datum) setzten ihren Titel groß und halbfett, die Blätter von unten
 * (Suchverlauf, Ticket hinzufügen, Reisende, Klasse, Uhrzeit) klein und fett.
 * Nebeneinander gelesen wirkte das nicht wie zwei Sorten Blatt, sondern wie
 * zwei Entwürfe.
 *
 * 24/600 ist die Fassung der Wähler und damit die, die als Aufschrift eines
 * Blattes gedacht war — nicht als zweite Bildschirm-Überschrift (26/900, das ist
 * `ScreenHeading` für die Tabs) und nicht als Abschnittstitel (18/700).
 *
 * Als ROHWERTE zum Hineinstreuen, nicht als fertiges Stilblatt: Jede Datei
 * dreht ihre Maße selbst durch `scaledStyles`, und ein hier schon skaliertes
 * Objekt bekäme den Faktor dort ein zweites Mal.
 */
/**
 * Der seitliche Abstand des Blattinhalts — EXPORTIERT, nicht eingemauert.
 *
 * Ein Blatt, das seinen Inhalt selbst vermessen muss, kann das erst NACH dem
 * ersten Layout. Unter Android macht `Modal` dafür ein eigenes Fenster auf, und
 * dessen erstes Layout kommt nicht im nächsten Bild, sondern spürbar später.
 * Wer in dieser Lücke etwas zeichnet, das von der Breite abhängt, zeichnet es
 * falsch — beim Preis-Regler standen Füllung und Griff sichtbar auseinander,
 * bis die Messung eintraf.
 *
 * Mit dieser Zahl lässt sich die Breite VORHER ausrechnen (Fensterbreite minus
 * zweimal diesen Abstand) und das erste Bild ist schon richtig. Sie muss
 * deshalb an einer Stelle stehen und nicht zweimal: Eine Kopie, die
 * auseinanderläuft, verschöbe den Regler um genau die Differenz.
 */
export const SHEET_PAD_H = 20;

export const SHEET_TITLE: TextStyle = {
  fontSize: 24,
  fontWeight: "600",
  color: "#F4F4F5",
};

export const SHEET_SUBTITLE: TextStyle = {
  fontSize: 13,
  lineHeight: 18,
  color: "#8E8E93",
};

const styles = scaledStyles({
  root: { flex: 1 },
  /** Nimmt die Fläche ein, in der das Blatt unten sitzt — nötig, weil
   *  Verdunkelung und Blatt getrennte Geschwister sind. */
  sheetWrap: { ...StyleSheet.absoluteFillObject, justifyContent: "flex-end" },
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: "rgba(0,0,0,0.6)" },
  sheet: {
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    paddingHorizontal: SHEET_PAD_H,
    /**
     * Höher als das Fenster darf es nicht werden.
     *
     * Ein Blatt wächst mit seinem Inhalt, und auf einem kurzen Bildschirm mit
     * umbrechenden Zeilen kann das über die Fensterhöhe hinausgehen. Was oben
     * hinausragt, liegt außerhalb seines Elternteils — und was dort liegt,
     * bekommt auf Android keine Berührungen mehr ab.
     */
    maxHeight: "92%",
  },
  handleWrap: { alignItems: "center", paddingTop: 12, paddingBottom: 16 },
  handle: { width: 40, height: 4, borderRadius: 9999, backgroundColor: "#FFFFFF" },
});
