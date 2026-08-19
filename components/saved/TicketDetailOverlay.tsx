/**
 * TicketDetailOverlay — slidet beim Tap auf eine TicketCard von rechts rein.
 * Zeigt die gleiche Bordkarte (TicketHead) wie die Card oben, im Stub
 * unten den Barcode statt Countdown, darunter den "Original-PDF öffnen"-
 * Button. Wird am Root-Level (app/_layout.tsx) mit `selectedTicket !== null`
 * gemountet, ähnlich zum DetailsOverlay-Pattern.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  View,
  Text,
  Pressable,
  ScrollView,
  StyleSheet,
  BackHandler,
  Platform,
  Image,
  Modal,
  useWindowDimensions,
} from "react-native";
import { usePalette } from "@/lib/theme/appBg";
import { SafeAreaView } from "react-native-safe-area-context";
import Animated, {
  useAnimatedStyle,
  withTiming,
  runOnJS,
} from "react-native-reanimated";
// Gesture/GestureDetector wurden für den alten image-zoom-modal genutzt —
// nicht mehr nötig seit react-native-pdf nativ pinch+pan handled.
import { ChevronLeft, FileText, X } from "lucide-react-native";
import Pdf from "react-native-pdf";
import { useT } from "@/lib/i18n/useT";
import { useSearchStore } from "@/stores/searchStore";
import { useAccent } from "@/lib/theme/accent";
import { haptic } from "@/lib/haptics";
import {
  overlayCover,
  ticketPush,
  isTicketPushStarted,
  startTicketPush,
  endTicketPush,
  PUSH_SPRING,
  POP_SPRING,
  COVER_OUT_SPRING,
  SCREEN_CORNER_RADIUS,
} from "@/lib/nav/overlayCover";
import { holdLayer, layerGeneration, rearmLayer, releaseLayer } from "@/lib/nav/transitionLayer";
import { RippleTouch } from "@/components/ui/RippleTouch";
import { TicketHead, Perforation, bookingRefFor } from "./TicketParts";
import { scaledStyles } from "@/lib/ui/compact";

const C = {
  bg: "#1A1A1A",
  surface: "#242425",
  surface3: "#2A2A2C",
  white: "#FFFFFF",
  gray200: "#C8C8CC",
  gray300: "#8A8A90",
  gray400: "#56565C",
  codeBg: "#FFFFFF",
  codeLabel: "#56565C",
  black: "#000000",
};

export function TicketDetailOverlay() {
  const ticket = useSearchStore((s) => s.selectedTicket);
  // KEEP-MOUNTED (Pattern wie DetailsOverlay): nach dem ersten Öffnen bleibt
  // das Sheet gemountet und wird beim nächsten Öffnen wiederverwendet.
  // Gründe (per Perfetto gemessen): (1) der Mount kostete ~66ms in einem
  // Frame = sichtbarer Hänger bei jedem Öffnen; (2) react-native-svg leakt
  // Views bei jedem Unmount auf Fabric. Das Ticket wird synchron in einem
  // Ref gelatcht → kein Flash des alten Tickets beim Re-Open.
  const lastTicketRef = useRef(ticket);
  if (ticket) lastTicketRef.current = ticket;
  const displayTicket = lastTicketRef.current;
  if (!displayTicket) return null;
  return <TicketDetailSheet ticket={displayTicket} open={!!ticket} />;
}

function TicketDetailSheet({
  ticket,
  open,
}: {
  ticket: NonNullable<ReturnType<typeof useSearchStore.getState>["selectedTicket"]>;
  open: boolean;
}) {
  const palette = usePalette();
  const t = useT();
  const accent = useAccent();
  const clearSelectedTicket = useSearchStore((s) => s.clearSelectedTicket);
  const screenWidth = useWindowDimensions().width;

  // Park-Position +48px: Elevation-Schatten (elevation 24) darf im
  // geschlossenen Zustand nicht am rechten Rand durchscheinen.
  /**
   * Die Position wird nur noch ABGELESEN — geschrieben wird sie im Tipp-Handler
   * der Karte (`startTicketPush`). Begründung dort.
   *
   * Park-Position +48 Punkt über den Rand hinaus: Der Schatten darf im
   * geschlossenen Zustand nicht am rechten Bildschirmrand durchscheinen.
   */
  const parkX = screenWidth + 48;
  const slideStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: (1 - ticketPush.value) * parkX }],
    // Außerhalb ⇔ unsichtbar — kein Durchscheinen, kein Aufblitzen.
    opacity: (1 - ticketPush.value) * parkX >= screenWidth ? 0 : 1,
  }));

  // Sichtbarkeit store-getrieben. Die Slide-In startet NICHT mehr hier, sondern
  // im Tipp-Handler der Karte (siehe startTicketPush) — dieser Effekt hält nur
  // noch die Textur und fährt die Rückfahrt.
  // Kein Unmount mehr — der Tree bleibt stehen (Leak- & Mount-Hänger-Fix).
  // Textur der Unterlage über den GANZEN Vorgang halten, Rückfahrt eingeschlossen.
  //
  // Vorher gab die Aufräumfunktion sie frei, sobald `open` auf false kippte —
  // also EXAKT in dem Moment, in dem der Tab darunter anfängt zurückzuwandern.
  // Die Rückfahrt lief damit als einzige ohne Textur, und genau dort ist das
  // Ruckeln aufgefallen.
  //
  // Jetzt: solange offen, halten (die Fläche ist verdeckt, kostet also nichts);
  // beim Schließen auf die Zeitgrenze umstellen, die sie über die Rückfahrt
  // hinweg trägt und danach von selbst fallen lässt.
  const [moving, setMoving] = useState(false);
  const ownsCoverRef = useRef(false);
  const wasOpenRef = useRef(false);
  const closingGenRef = useRef<number | null>(null);
  /** Gibt die Textur der Unterlage frei — am ENDE der Bewegung, nicht auf einem
   *  blinden Zeitgeber. Sonst stand sie noch fast eine Sekunde über einer wieder
   *  scrollbaren Liste und wurde mitten im Scrollen abgebaut. */
  const releaseUnderlayLayer = useCallback(() => {
    const gen = closingGenRef.current;
    if (gen == null) return;
    closingGenRef.current = null;
    releaseLayer("saved", gen);
  }, []);
  useEffect(() => {
    if (open) {
      wasOpenRef.current = true;
      // Angefordert wird sie im bestätigten Tipp (TicketCard) — hier nur halten.
      holdLayer("saved");
      return;
    }
    if (!wasOpenRef.current) return;
    wasOpenRef.current = false;
    // Fürs Zurückfahren gibt es keinen Fingerdruck — hier also anfordern.
    // `rearmLayer` genügt: Angefordert wurde beim Antippen der Karte, die Textur
    // ist längst da, und eine neu ANZULEGEN wäre falsch, wenn sie es nicht wäre.
    rearmLayer("saved");
    // Stand festhalten, den die Freigabe unten meint — sonst räumt der Rückruf
    // dieser Rückfahrt die frische Textur des nächsten Antippens wieder ab.
    closingGenRef.current = layerGeneration("saved");
  }, [open]);

  useEffect(() => {
    if (open) {
      // Nicht nach einem festen Bild starten, sondern sobald der JS-Thread frei
      // ist (gedeckelt). Gemessen am Ergebnis-Bildschirm: Der Commit, der den
      // Inhalt anlegt, belegt den Thread rund 80ms; ein Bild Vorlauf lag mitten
      // drin, und die Feder lief dagegen an. Nach der Umstellung fiel dort das
      // schlechteste Bild WÄHREND der Bewegung von 25ms auf 8ms — also auf den
      // Takt, ohne ein einziges verpasstes Bild. Hier gilt derselbe Aufbau.
      // Kein Warten mehr auf einen freien Thread.
      //
      // Die Begründung dafür („der Commit, der den Inhalt anlegt, belegt den
      // Thread rund 80ms") galt für Overlays, die beim Öffnen aufgebaut wurden.
      // Dieses hier bleibt dauerhaft gemountet — es gibt beim Öffnen gar keinen
      // Aufbau-Commit, auf den zu warten wäre. Die Wartezeit war damit reine
      // Latenz zwischen Finger und Bewegung, und sie hatte einen garantierten
      // Boden von zwei Bildern (die Schleife kann frühestens im zweiten rAF
      // feuern). Ein Bild Vorlauf reicht, damit die nativen Ansichten stehen.
      /**
       * Die Bewegung läuft bereits — gestartet im Tipp-Handler der Karte.
       * Hier bleibt nur die Textur für ihre Dauer und der Vermerk, dass DIESES
       * Blatt den geteilten Parallax-Wert gesetzt hat.
       *
       * Der Notausgang darunter greift, wenn niemand angestoßen hat (eine
       * Verknüpfung, das Wiederherstellen nach einem Umweg).
       */
      setMoving(true);
      ownsCoverRef.current = true;
      if (!isTicketPushStarted()) startTicketPush();
      const settle = setTimeout(() => setMoving(false), PUSH_SPRING.duration + 80);
      return () => clearTimeout(settle);
    }
    setMoving(true);
    endTicketPush();
    ticketPush.value = withTiming(0, POP_SPRING, (finished?: boolean) => {
      "worklet";
      if (!finished) return;
      runOnJS(setMoving)(false);
      runOnJS(releaseUnderlayLayer)();
    });
    // Siehe DetailsOverlay: nur zurücknehmen, wenn dieses Blatt den geteilten
    // Wert auch gesetzt hat — sonst reißt eine Größenänderung den Parallax eines
    // anderen Overlays auf 0.
    if (ownsCoverRef.current) {
      ownsCoverRef.current = false;
      overlayCover.value = withTiming(0, COVER_OUT_SPRING);
    }
    return undefined;
  }, [open, screenWidth]);

  useEffect(() => () => { overlayCover.value = 0; }, []);

  // Schließen = Store-Flag löschen → open false → Slide-Out oben.
  const animateClose = () => clearSelectedTicket();

  useEffect(() => {
    if (Platform.OS !== "android") return;
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      if (!open) return false;
      animateClose();
      return true;
    });
    return () => sub.remove();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const openPdf = () => {
    haptic("button");
    setPdfOpen(true);
  };

  // Echter PDF-Viewer via react-native-pdf: rendert die PDF mit nativen
  // Fonts (kein font-stubbing-Problem mehr) und bietet Pinch-Zoom +
  // Page-Navigation out of the box.
  const [pdfOpen, setPdfOpen] = useState(false);
  // Keep-mounted: beim Schließen offenes PDF-Modal mit zumachen, sonst
  // wäre es beim nächsten Öffnen noch offen.
  useEffect(() => {
    if (!open) setPdfOpen(false);
  }, [open]);

  const ticketCode = bookingRefFor(ticket);

  return (
    // renderToHardwareTextureAndroid: promotet das Sheet auf eine GPU-Layer.
    // Per Perfetto gemessen: ohne Layer wird der komplette Screen JEDEN
    // Animations-Frame neu gezeichnet (~14.7ms > 8.3ms-Budget bei 120Hz →
    // jeder zweite Frame droppt). Als Textur ist der Frame ein Blit.
    // Statisch an (kein Mid-Flight-Toggle — der verursachte früher selbst
    // Stutter); Kosten: ~12MB GPU-Speicher solange gemountet.
    <Animated.View
      style={[styles.root, { backgroundColor: palette.bg }, slideStyle]}
      // NUR während der Bewegung.
      //
      // Stand hier statisch, aus einer Zeit, in der „gemountet" gleich „offen"
      // hieß. Seit dieses Blatt dauerhaft steht, lag die vollflächige Textur
      // permanent über seiner eigenen Scroll-Fläche — jedes Scroll-Bild im
      // Ticket-Detail rasterte damit den ganzen Bildschirm neu. Genau der Fall,
      // den lib/nav/transitionLayer.ts als „schlimmer als gar keine" ausschließt.
      renderToHardwareTextureAndroid={Platform.OS === "android" && moving}
      collapsable={false}
      // Fehlte bisher ganz. Dieses Blatt bleibt dauerhaft gemountet, deckt die
      // volle Fläche und liegt mit zIndex 200 über allem — nur wegen seiner
      // Position außerhalb des Bildes fing es keine Berührungen ab. Beim
      // Hinausfahren (rund 380ms) tut es das aber sehr wohl, und in dieser Zeit
      // kam ein Tipp auf den Tab darunter nicht an.
      pointerEvents={open ? "auto" : "none"}
    >
      <SafeAreaView style={[styles.safe, { backgroundColor: palette.bg }]} edges={["top"]}>
        <View style={styles.header}>
          <Pressable
            onPress={() => {
              haptic("button");
              animateClose();
            }}
            style={[styles.roundBtn, { backgroundColor: palette.s2 }]}
            hitSlop={10}
            accessibilityLabel={t("common.cancel")}
          >
            <ChevronLeft color={C.white} size={22} strokeWidth={2.2} />
          </Pressable>
          <Text style={styles.headerTitle}>{t("saved.ticket.detail.title")}</Text>
          <View style={[styles.roundBtn, { backgroundColor: palette.s2 }]} />
        </View>

        <ScrollView
          contentContainerStyle={{ paddingBottom: 32 }}
          showsVerticalScrollIndicator={false}
        >
          <Text style={styles.boardingTitle}>{t("saved.ticket.bordkarte")}</Text>

          <View style={[styles.card, { backgroundColor: palette.s2 }]}>
            <TicketHead ticket={ticket} />

            <Perforation notchColor={palette.bg} />

            <View style={styles.stub}>
              {ticket.codeImage ? (
                // Echter QR/Barcode aus dem PDF — pixel-genau gecroppt vom
                // Server, KEIN Re-Encoding → bleibt scanbar. Aspect-Ratio
                // je nach Typ: QR/Aztec/DataMatrix square, 1D-Barcode breit.
                <View style={[styles.codePanel, { backgroundColor: palette.s1 }]}>
                  <Text style={styles.codeLabel}>
                    {t("saved.ticket.code")} · {ticketCode}
                  </Text>
                  <View
                    style={{
                      width: "100%",
                      aspectRatio: ticket.codeType === "barcode" ? 4 : 1,
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    <Image
                      source={{ uri: ticket.codeImage }}
                      style={{ width: "100%", height: "100%" }}
                      resizeMode="contain"
                    />
                  </View>
                </View>
              ) : (
                // Fallback: Vision konnte den Code nicht lokalisieren.
                // Wir zeigen KEIN Fake-Pattern (das wäre nicht scanbar und
                // wäre irreführend) sondern eine ehrliche Message + Hinweis
                // auf den PDF-Button.
                <View style={[styles.codeFallback, { backgroundColor: palette.s3 }]}>
                  <Text style={styles.codeFallbackText}>
                    {t("saved.ticket.codeUnreadable")}
                  </Text>
                </View>
              )}
              {ticket.codeImage ? (
                <Text style={styles.helper}>{t("saved.ticket.scanHint")}</Text>
              ) : null}
            </View>
          </View>

          {/* Original-PDF Button — öffnet das Zoom-Modal mit dem gerenderten
              PDF-Bild. KEINE inline-Preview mehr im Detail — der User will
              die PDF nur explizit beim Tap auf den Button sehen. */}
          {ticket.pageImage ? (
            <>
              <RippleTouch
                onPress={openPdf}
                style={[styles.pdfBtn, { backgroundColor: accent.solid }]}
                rippleColor="rgba(0,0,0,0.2)"
              >
                <FileText size={18} color={C.black} strokeWidth={2} />
                <Text style={styles.pdfBtnText}>{t("saved.ticket.openPdf")}</Text>
              </RippleTouch>
              <Text style={styles.pdfNote}>{t("saved.ticket.pdfNote")}</Text>
            </>
          ) : null}
        </ScrollView>
      </SafeAreaView>

      {/* Native PDF-Viewer via react-native-pdf — nutzt platform-natives
          PDF-Rendering (PDFKit auf iOS, PdfRenderer auf Android) mit ALLEN
          embedded Fonts. Built-in pinch-zoom, page-navigation, hi-res
          rendering. Ersetzt unseren ehemaligen pageImage-Zoom-Modal der
          wegen pdfjs-Font-Issues halb-leer war. */}
      <Modal
        visible={pdfOpen}
        animationType="fade"
        transparent
        onRequestClose={() => setPdfOpen(false)}
      >
        <NativePdfModal
          pdfUri={ticket.pdfUri}
          onClose={() => setPdfOpen(false)}
        />
      </Modal>
    </Animated.View>
  );
}

/**
 * Native-PDF-Viewer für gespeicherte Tickets. Wenn keine pdfUri vorhanden
 * (älteres Ticket vor dem Persist-Fix), zeigt einen Hinweis statt zu
 * crashen.
 */
function NativePdfModal({
  pdfUri,
  onClose,
}: {
  pdfUri?: string;
  onClose: () => void;
}) {
  const palette = usePalette();
  const t = useT();
  const { width: screenW, height: screenH } = useWindowDimensions();

  return (
    <View style={styles.pdfRoot}>
      <Pressable
        onPress={onClose}
        hitSlop={12}
        style={[styles.pdfClose, { backgroundColor: palette.s2 }]}
      >
        <X size={20} color="#FFFFFF" />
      </Pressable>
      {pdfUri ? (
        <Pdf
          source={{ uri: pdfUri, cache: false }}
          trustAllCerts={false}
          style={{
            flex: 1,
            width: screenW,
            height: screenH,
            backgroundColor: "#000000",
          }}
          enablePaging
          horizontal={false}
          // Default-Scale 1.0, User kann pinch-zoomen bis maxScale.
          minScale={1.0}
          maxScale={4.0}
          scale={1.0}
          spacing={8}
          fitPolicy={2}
          onError={() => {
            // Bei Lade-Fehler nichts crashen — User kann manuell schließen.
            // (TODO: optionale Error-Message overlayen.)
          }}
        />
      ) : (
        <View style={styles.pdfMissing}>
          <Text style={styles.pdfMissingText}>
            {t("saved.modal.error.title")}
          </Text>
        </View>
      )}
    </View>
  );
}

const styles = scaledStyles({
  root: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: C.bg,
    zIndex: 200,
    elevation: 24,
    // Gerundete Ecken beim Reinsliden (siehe SCREEN_CORNER_RADIUS). Der Root
    // ist ohnehin renderToHardwareTextureAndroid → der runde Clip wird als
    // Textur geblittet, kostet im Slide nichts extra.
    borderRadius: SCREEN_CORNER_RADIUS,
    overflow: "hidden",
  },
  safe: { flex: 1, backgroundColor: C.bg },

  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 18,
    paddingTop: 6,
    paddingBottom: 4,
  },
  roundBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: C.surface,
    alignItems: "center",
    justifyContent: "center",
  },
  headerTitle: {
    fontSize: 16,
    fontWeight: "700",
    color: C.white,
  },

  boardingTitle: {
    textAlign: "center",
    fontSize: 20,
    fontWeight: "800",
    color: C.white,
    letterSpacing: -0.4,
    paddingTop: 12,
    paddingBottom: 16,
  },

  card: {
    marginHorizontal: 16,
    backgroundColor: C.surface,
    borderRadius: 26,
    overflow: "hidden",
  },

  stub: { paddingHorizontal: 18, paddingTop: 20, paddingBottom: 18 },
  codePanel: {
    backgroundColor: C.codeBg,
    borderRadius: 16,
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 14,
  },
  codeLabel: {
    textAlign: "center",
    fontSize: 11,
    color: C.codeLabel,
    fontWeight: "600",
    marginBottom: 12,
  },
  codeFallback: {
    backgroundColor: C.surface3,
    borderWidth: 1,
    borderColor: "#3A3A3E",
    borderStyle: "dashed",
    borderRadius: 16,
    paddingHorizontal: 18,
    paddingVertical: 22,
    alignItems: "center",
    justifyContent: "center",
  },
  codeFallbackText: {
    textAlign: "center",
    fontSize: 13,
    color: C.gray200,
    fontWeight: "500",
    lineHeight: 19,
  },
  helper: {
    textAlign: "center",
    fontSize: 11,
    color: C.gray300,
    marginTop: 14,
    lineHeight: 16,
    paddingHorizontal: 8,
  },

  pdfBtn: {
    marginHorizontal: 16,
    marginTop: 16,
    marginBottom: 6,
    borderRadius: 9999,
    paddingVertical: 16,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 9,
    overflow: "hidden",
  },
  pdfBtnText: {
    fontSize: 15,
    fontWeight: "800",
    color: C.black,
  },
  pdfNote: {
    textAlign: "center",
    fontSize: 11,
    color: C.gray400,
    marginHorizontal: 16,
    marginTop: 4,
  },

  previewWrap: {
    marginHorizontal: 16,
    marginTop: 20,
  },
  previewLabel: {
    fontSize: 11,
    color: C.gray300,
    letterSpacing: 0.6,
    fontWeight: "700",
    marginBottom: 8,
    paddingHorizontal: 4,
  },
  previewBox: {
    backgroundColor: C.surface,
    borderRadius: 18,
    overflow: "hidden",
    padding: 10,
  },

  pdfRoot: { flex: 1, backgroundColor: C.black },
  pdfClose: {
    position: "absolute",
    top: 56,
    right: 20,
    zIndex: 10,
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: C.surface,
    alignItems: "center",
    justifyContent: "center",
  },
  pdfMissing: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 32,
  },
  pdfMissingText: {
    color: C.gray200,
    fontSize: 14,
    textAlign: "center",
    lineHeight: 20,
  },
});
