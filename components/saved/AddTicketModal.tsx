import { useCallback, useEffect, useRef, useState } from "react";
import { SHEET_IN, SHEET_OUT, markSheetMoving } from "@/lib/nav/overlayCover";
import {
  View,
  Text,
  Modal,
  Pressable,
  StyleSheet,
  ActivityIndicator,
  type LayoutChangeEvent,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { usePalette } from "@/lib/theme/appBg";
import Animated, {
  FadeIn,
  FadeOut,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { GestureDetector, GestureHandlerRootView } from "react-native-gesture-handler";
import { showAlert } from "@/lib/alert";
import { SHEET_SUBTITLE, SHEET_TITLE } from "@/components/ui/SheetModal";
import * as DocumentPicker from "expo-document-picker";
import * as FileSystem from "expo-file-system/legacy";
import { Plane, TrainFront, Bus, Ship } from "lucide-react-native";
import { TravelMode } from "@/types/search";
import { Ticket } from "@/types/saved";
import { useT } from "@/lib/i18n/useT";
import { parseTicketPdf, TicketParseError } from "@/lib/api/client";
import { useSearchStore } from "@/stores/searchStore";
import { persistTicketImages } from "@/lib/saved/ticketImages";
import { RippleTouch } from "@/components/ui/RippleTouch";
import { useAccent } from "@/lib/theme/accent";
import { scaledStyles } from "@/lib/ui/compact";
import { dragHealOffset, snapToPixel, useSheetScrollGate, useSheetSwipe } from "@/lib/ui/sheetSwipe";

interface Props {
  visible: boolean;
  onClose: () => void;
  onAdd: (t: Omit<Ticket, "id" | "createdAt">) => void;
}

const MODES: { id: TravelMode; icon: typeof Plane; labelKey: string }[] = [
  { id: "FLIGHT", icon: Plane, labelKey: "saved.modal.type.flight" },
  { id: "TRAIN", icon: TrainFront, labelKey: "saved.modal.type.train" },
  { id: "BUS", icon: Bus, labelKey: "saved.modal.type.bus" },
  { id: "CRUISE", icon: Ship, labelKey: "saved.modal.type.cruise" },
];

export function AddTicketModal({ visible, onClose, onAdd }: Props) {
  const closeRef = useRef<() => void>(onClose);
  closeRef.current = onClose;
  // Feste Kennung — sonst liefe der Effekt im Blatt bei jedem Bild neu an.
  const registerClose = useCallback((fn: () => void) => {
    closeRef.current = fn;
  }, []);
  return (
    <Modal
      visible={visible}
      /**
       * `none` — die Bewegung machen wir selbst, unten am Blatt.
       *
       * `animationType="slide"` ist Androids eigene Modal-Animation. Ihre Dauer
       * ist vom System vorgegeben und nicht einstellbar, und sie ist deutlich
       * schneller als alles andere in der App — das Blatt schoss herein, während
       * dasselbe Blatt im Verlauf gemächlich hochfährt. Mit `none` gibt das
       * Fenster nur noch die Fläche frei; die Bewegung kommt aus Reanimated und
       * benutzt exakt dieselben Werte wie das Verlaufs-Blatt.
       */
      animationType="none"
      transparent
      presentationStyle="overFullScreen"
      /**
       * Bis an beide Ränder — sonst bleibt unten ein Streifen der App stehen.
       *
       * Ein Fenster dieser Art endet auf Android standardmäßig VOR den
       * System-Leisten. Die Verdunkelung füllt dann nur den Bereich dazwischen,
       * und im Streifen darunter ist weiter die App zu sehen — bei uns also die
       * Tab-Leiste, die unter dem Blatt hervorschaut. Genau das war „unten
       * abgeschnitten, man sieht noch Teile der Nav-Leiste".
       *
       * Damit reicht das Fenster über die volle Höhe; den sicheren Abstand am
       * unteren Rand trägt jetzt das Blatt selbst (siehe `bottomPad`).
       */
      statusBarTranslucent
      navigationBarTranslucent
      /**
       * Systemtaste „zurück" — auch die nimmt den Weg MIT Bewegung.
       *
       * Das Fenster meldet sie hier oben, den Weg kennt aber nur das Blatt
       * darin. Es hinterlegt ihn beim Aufbau; bis dahin (und wenn gar kein Blatt
       * steht) bleibt es beim direkten Schließen.
       */
      onRequestClose={() => closeRef.current()}
    >
      {visible ? (
        <AddTicketSheet
          onClose={onClose}
          onAdd={onAdd}
          registerClose={registerClose}
        />
      ) : null}
    </Modal>
  );
}

function AddTicketSheet({
  onClose,
  onAdd,
  registerClose,
}: {
  onClose: () => void;
  onAdd: Props["onAdd"];
  registerClose: (fn: () => void) => void;
}) {
  const palette = usePalette();
  const t = useT();
  const accent = useAccent();
  const [busy, setBusy] = useState(false);
  /** Synchrone Sperre für den Auswahl-Dialog — greift schon im selben Frame. */
  const pickingRef = useRef(false);

  const insets = useSafeAreaInsets();
  /**
   * Sicherer Abstand unten, plus der bisherige Innenabstand.
   *
   * Nötig, seit das Fenster über die volle Höhe geht: Vorher endete es über der
   * System-Leiste und die 40 Punkt reichten; jetzt liegt das Blatt darunter und
   * bräuchte ohne diesen Zuschlag seine unterste Zeile hinter der Wischleiste.
   */
  const bottomPad = 40 + insets.bottom;

  /**
   * Die Bewegung läuft über einen eigenen Wert, nicht über `entering`.
   *
   * `SlideInDown` ist eine Ein-Sprung-Animation: Sie beginnt in DEM Commit, in
   * dem der Baum entsteht — und dieser Baum entsteht komplett neu, sobald das
   * Fenster aufgeht. Auf Fabric heißt das, dass die Ansichten zuerst an ihrem
   * ENDplatz eingehängt und erst danach von der Animation zurückgesetzt werden.
   * Trifft das ein Bild schlecht, sieht man den Inhalt für den Bruchteil einer
   * Sekunde an seiner endgültigen Stelle stehen, bevor er von unten hereinfährt.
   * Genau das war „da buggen noch irgendwelche Icons rum".
   *
   * Stattdessen dasselbe Vorgehen wie beim Such-Blatt: Der Inhalt wird zuerst
   * aufgebaut — geparkt unterhalb des Bildrands, sichtbar ist davon nichts — und
   * fährt erst ein Bild später los. Der Aufbau ist dann durch und läuft der
   * Bewegung nicht mehr in die Quere.
   *
   * Die Höhe kommt aus `onLayout`; bis sie bekannt ist, steht das Blatt auf
   * einem großzügigen Ersatzwert. `translateY` ist derselbe Wert, den auch die
   * Wisch-Geste schreibt — es gibt nur EINE Position, und damit keine zwei
   * Bewegungen, die sich gegenseitig überschreiben können.
   */
  const translateY = useSharedValue(900);
  /**
   * Geteilter Wert, keine React-Ablage.
   *
   * Die Höhe wird an drei Stellen gebraucht, und eine davon ist die Wisch-Geste
   * — die läuft auf dem UI-Strang. Ein `useRef` wird beim Anlegen eines Worklets
   * KOPIERT: Was dort ankommt, ist der Stand von damals, spätere Zuweisungen an
   * `.current` erreichen ihn nie. Die Messung passiert aber genau danach und
   * ohne erneutes Rendern — der Wert im Worklet wäre also dauerhaft 0 gewesen
   * und die Geste immer auf den Ersatzwert gelaufen. Ein geteilter Wert ist auf
   * beiden Strängen derselbe.
   */
  const sheetH = useSharedValue(0);
  const started = useRef(false);
  const onSheetLayout = useCallback((e: LayoutChangeEvent) => {
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
  }, [translateY, sheetH]);

  /**
   * Ganze Gerätepixel + Selbstkorrektur beim Ziehen — beides erklärt in
   * lib/ui/sheetSwipe.ts (`snapToPixel`, `startDragHeal`).
   */
  const heal = useSharedValue(0);
  /** Wird von woanders geschlossen — die Wisch-Geste hält sich dann heraus (`closing` in useSheetSwipe). */
  const closingSv = useSharedValue(false);
  const sheetAnim = useAnimatedStyle(() => ({
    transform: [{ translateY: snapToPixel(translateY.value) + dragHealOffset(heal) }],
  }));

  /**
   * Schließen heißt: erst hinausfahren, DANN abmelden.
   *
   * Vorher verschwand das Blatt schlagartig. Der Grund liegt im Fenster: Sobald
   * `visible` auf falsch fällt, ist es weg — samt allem darin. Eine
   * Aussprung-Animation am Blatt hat dann keine Fläche mehr, auf der sie laufen
   * könnte; sie war zwar angegeben, aber nie zu sehen.
   *
   * Also andersherum: Hier fährt das Blatt hinunter, und erst wenn es unten ist,
   * wird nach oben gemeldet, dass zugemacht werden kann. Genau die Reihenfolge,
   * die auch Bo benutzt.
   *
   * `closingRef` fängt den zweiten Druck ab — ohne ihn setzt jeder weitere
   * Tipper eine neue Bewegung an und schiebt das Schließen weiter nach hinten.
   */
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
    closingSv.value = true;
    closeTimer.current = setTimeout(() => onCloseRef.current(), afterMs);
  }, []);

  /** Antippen: hinausfahren und danach abmelden. */
  const requestClose = useCallback(() => {
    if (closingRef.current) return;
    // Auch hier: die Ausfahrt war nicht angemeldet, siehe LegTimelineOverlay.
    markSheetMoving(SHEET_OUT.duration);
    closingSv.value = true;
    translateY.value = withTiming(sheetH.value || 900, SHEET_OUT);
    scheduleClose(SHEET_OUT.duration);
  }, [scheduleClose, translateY, sheetH]);
  useEffect(() => registerClose(requestClose), [registerClose, requestClose]);

  /**
   * Gezogen wird am ganzen Blatt, nicht mehr nur am Strich oben.
   *
   * Der Torhüter gehört dazu, obwohl die vier Kacheln fast immer hineinpassen:
   * Auf einem kurzen Bildschirm mit großer Schrift scrollt die Fläche eben doch
   * — und dann muss die Liste scrollen und nicht das Blatt wandern.
   *
   * `enabled(!busy)`: Während eine Datei gelesen wird, ist das Blatt gesperrt;
   * das galt schon für den Tipper daneben.
   */
  const gate = useSheetScrollGate();
  const panGesture = useSheetSwipe({
    y: translateY,
    travel: sheetH,
    onDismiss: scheduleClose,
    enabled: !busy,
    gate,
    heal,
    closing: closingSv,
  });

  const pickAndParse = async (fallbackMode: TravelMode) => {
    // Sperre SOFORT setzen, nicht erst nach dem Dateiauswahl-Dialog: `busy` wurde
    // bisher erst gesetzt, wenn die Datei schon dastand. Der Zustand aus dem
    // letzten Render sagt in den Sekunden davor noch „frei", also öffneten zwei
    // schnelle Tipper zwei Dialoge — und beide legten am Ende ein Ticket an.
    if (busy || pickingRef.current) return;
    pickingRef.current = true;
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: "application/pdf",
        copyToCacheDirectory: true,
        multiple: false,
      });
      if (result.canceled) return;
      const asset = result.assets[0];
      if (!asset) return;

      setBusy(true);
      const parsed = await parseTicketPdf(
        asset.uri,
        asset.name,
        asset.mimeType ?? "application/pdf",
        useSearchStore.getState().authToken,
      );

      const ratio =
        parsed.pageWidth > 0 ? parsed.pageHeight / parsed.pageWidth : undefined;

      // PDF aus dem Cache (DocumentPicker copyToCacheDirectory) ins
      // persistente Document-Directory verschieben. Sonst kann der OS-Cache
      // sie jederzeit löschen → "Original-PDF öffnen"-Button im Detail-Screen
      // wäre nach 1-2 Tagen kaputt. Filename = ticket-{timestamp}-{name}.pdf
      // damit's eindeutig ist (mehrere Imports vom selben PDF überschreiben
      // sich nicht).
      const docDir = FileSystem.documentDirectory ?? "";
      const safeName = (asset.name ?? "ticket.pdf").replace(/[^\w.-]/g, "_");
      const persistedUri = `${docDir}tickets/${Date.now()}-${safeName}`;
      // Ob das Kopieren geklappt hat, muss unten ausgewertet werden: Der
      // Kommentar dort behauptete „pdfUri bleibt dann undefined", der Code hat
      // den Pfad aber bedingungslos gespeichert. Schlug das Kopieren fehl (kein
      // Speicher, fehlende Rechte), lag im Ticket ein Pfad auf eine Datei, die es
      // nicht gibt — „Original-PDF öffnen" wurde angeboten und scheiterte dann.
      let pdfCopied = false;
      try {
        await FileSystem.makeDirectoryAsync(`${docDir}tickets`, { intermediates: true });
        await FileSystem.copyAsync({ from: asset.uri, to: persistedUri });
        pdfCopied = true;
      } catch {
        // Wenn Persistierung fehlschlägt (z.B. kein Speicherplatz), trotzdem
        // weiter — pdfUri bleibt dann undefined, der Button im Detail-Screen
        // wird ausgeblendet.
      }

      // Page-/Code-Bild als PNG-Dateien ablegen und nur file://-URIs in den
      // Store geben — Base64 im persistierten Store würde jeden Persist-
      // stringify um MB aufblähen (JS-Thread-Blocks bei jedem set()).
      const images = await persistTicketImages(
        `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        parsed.pageImage,
        parsed.codeImage ?? undefined,
      );

      onAdd({
        mode: parsed.fields.mode ?? fallbackMode,
        carrier: parsed.fields.carrier,
        flightNumber: parsed.fields.flightNumber,
        fromCode: parsed.fields.fromCode,
        fromCity: parsed.fields.fromCity,
        fromStation: parsed.fields.fromStation,
        toCode: parsed.fields.toCode,
        toCity: parsed.fields.toCity,
        toStation: parsed.fields.toStation,
        departTime: parsed.fields.departTime,
        arriveTime: parsed.fields.arriveTime,
        durationMinutes: parsed.fields.durationMinutes,
        stops: 0,
        passenger: parsed.fields.passenger,
        seat: parsed.fields.seat,
        wagon: parsed.fields.wagon,
        travelClass: parsed.fields.travelClass,
        pageImage: images.pageImage,
        pageImageRatio: ratio,
        originalName: parsed.originalName ?? asset.name,
        bookingRef: parsed.fields.bookingRef,
        pdfUri: pdfCopied ? persistedUri : undefined,
        codeImage: images.codeImage,
        codeType: parsed.codeType ?? undefined,
      });

      requestClose();
    } catch (err) {
      // Kontogebundener Endpoint: 401 = nicht eingeloggt → Login-Screen
      // öffnen, 429 = Tageslimit des Kontos erreicht.
      const status = err instanceof TicketParseError ? err.status : null;
      if (status === 401) {
        requestClose();
        useSearchStore.getState().openAuthOverlay();
        return;
      }
      showAlert(
        t("saved.modal.error.title"),
        status === 429 ? t("saved.modal.error.ratelimit") : (err as Error).message,
      );
    } finally {
      pickingRef.current = false;
      /**
       * Beim Schließen NICHT zurückschalten.
       *
       * Vorher war das folgenlos: Das Blatt verschwand schlagartig, niemand sah,
       * was danach im Baum passierte. Jetzt steht es noch 300ms sichtbar da und
       * fährt hinunter — der Wechsel von der Ladeanzeige zurück auf die Kacheln
       * würde also mitten in der Bewegung stattfinden. Wer schließt, hat mit dem
       * Blatt abgeschlossen; es soll so hinausfahren, wie es war.
       */
      if (!closingRef.current) setBusy(false);
    }
  };

  return (
    <GestureHandlerRootView style={styles.root}>
      {/* Verdunkelung und Blatt bewegen sich getrennt — 1:1 wie im
          Verlaufs-Blatt (components/home/RecentHistoryOverlay.tsx). */}
      <Animated.View
        // Mit dem Blatt, nicht daneben — siehe SHEET_IN.
        entering={FadeIn.duration(SHEET_IN.duration)}
        exiting={FadeOut.duration(SHEET_OUT.duration)}
        style={styles.backdrop}
      >
        <Pressable style={StyleSheet.absoluteFill} onPress={busy ? undefined : requestClose} />
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
            {/* Nur noch Zeichen, nicht mehr Griff — gezogen wird überall. */}
            <View style={styles.handleWrap}>
              <View style={styles.handle} />
            </View>

            <Text style={styles.title}>{t("saved.modal.title")}</Text>
            <Text style={styles.subtitle}>{t("saved.modal.subtitle")}</Text>

            {busy ? (
              <View style={styles.busyWrap}>
                <ActivityIndicator size="large" color={accent.solid} />
                <Text style={styles.busyText}>{t("saved.modal.parsing")}</Text>
              </View>
            ) : (
              /* Eigener nativer Erkenner um die Liste, damit das Ziehen am Blatt
                 sie nicht abwürgt — siehe `useSheetScrollGate`. */
              <GestureDetector gesture={gate.native}>
                <Animated.ScrollView
                  ref={gate.ref}
                  showsVerticalScrollIndicator={false}
                  onScroll={gate.onScroll}
                  scrollEventThrottle={16}
                  // Kein Überzieh-Schimmer an der Oberkante: Dort zieht ab
                  // sofort das Blatt, und der Schimmer liefe dagegen an.
                  overScrollMode="never"
                  bounces={false}
                >
                  <View style={styles.tilesRow}>
                    {MODES.map((m) => {
                      const Icon = m.icon;
                      return (
                        <RippleTouch
                          key={m.id}
                          onPress={() => pickAndParse(m.id)}
                          style={({ pressed }) => [
                            styles.tile,
                            { backgroundColor: palette.s2, borderColor: palette.border },
                            { opacity: pressed ? 0.85 : 1 },
                          ]}
                        >
                          <Icon size={22} color="#F4F4F5" strokeWidth={1.8} />
                          <Text style={styles.tileLabel}>{t(m.labelKey)}</Text>
                        </RippleTouch>
                      );
                    })}
                  </View>

                  <Text style={styles.hint}>{t("saved.modal.hint")}</Text>
                </Animated.ScrollView>
              </GestureDetector>
            )}
          </Animated.View>
        </GestureDetector>
      </View>
    </GestureHandlerRootView>
  );
}

const styles = scaledStyles({
  /** Nimmt die Fläche ein, in der das Blatt unten sitzt — nötig, seit
   *  Verdunkelung und Blatt getrennte Geschwister sind. */
  sheetWrap: { ...StyleSheet.absoluteFillObject, justifyContent: "flex-end" },
  // Nur noch die Verdunkelung: `flex: 1` und die Ausrichtung sind an `sheetWrap`
  // gewandert, weil diese Ebene das Blatt nicht mehr enthält.
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: "rgba(0,0,0,0.6)" },
  sheet: {
    backgroundColor: "#171719",
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    paddingHorizontal: 20,
    minHeight: 320,
  },
  root: { flex: 1 },
  handleWrap: { alignItems: "center", paddingTop: 12, paddingBottom: 16 },
  handle: { width: 40, height: 4, borderRadius: 9999, backgroundColor: "#FFFFFF" },
  title: { ...SHEET_TITLE, marginBottom: 8 },
  subtitle: { ...SHEET_SUBTITLE, marginBottom: 16 },
  tilesRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
    marginBottom: 14,
  },
  tile: {
    flexBasis: "47%",
    flexGrow: 1,
    paddingVertical: 18,
    borderRadius: 14,
    backgroundColor: "#171719",
    borderWidth: 1,
    borderColor: "#212123",
    alignItems: "center",
    gap: 8,
  },
  tileLabel: { fontSize: 13, fontWeight: "600", color: "#F4F4F5" },
  hint: { fontSize: 12, color: "#56565C", textAlign: "center", lineHeight: 18, paddingHorizontal: 6, marginTop: 6 },
  busyWrap: { alignItems: "center", justifyContent: "center", paddingVertical: 50, gap: 14 },
  busyText: { fontSize: 14, color: "#C8C8CC" },
});
