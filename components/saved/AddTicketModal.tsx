import { useState } from "react";
import {
  View,
  Text,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  ActivityIndicator,
} from "react-native";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
  runOnJS,
} from "react-native-reanimated";
import {
  Gesture,
  GestureDetector,
  GestureHandlerRootView,
} from "react-native-gesture-handler";
import { showAlert } from "@/lib/alert";
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
  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent
      presentationStyle="overFullScreen"
      onRequestClose={onClose}
    >
      {visible ? <AddTicketSheet onClose={onClose} onAdd={onAdd} /> : null}
    </Modal>
  );
}

function AddTicketSheet({
  onClose,
  onAdd,
}: {
  onClose: () => void;
  onAdd: Props["onAdd"];
}) {
  const t = useT();
  const accent = useAccent();
  const [busy, setBusy] = useState(false);

  const translateY = useSharedValue(0);
  const sheetAnim = useAnimatedStyle(() => ({
    transform: [{ translateY: translateY.value }],
  }));

  const panGesture = Gesture.Pan()
    .activeOffsetY(8)
    .failOffsetY(-8)
    .enabled(!busy)
    .onUpdate((e) => {
      translateY.value = Math.max(0, e.translationY);
    })
    .onEnd((e) => {
      if (e.translationY > 110 || e.velocityY > 700) {
        translateY.value = withTiming(600, { duration: 220 });
        runOnJS(onClose)();
      } else {
        translateY.value = withSpring(0, { damping: 22, stiffness: 220 });
      }
    });

  const pickAndParse = async (fallbackMode: TravelMode) => {
    if (busy) return;
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
      try {
        await FileSystem.makeDirectoryAsync(`${docDir}tickets`, { intermediates: true });
        await FileSystem.copyAsync({ from: asset.uri, to: persistedUri });
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
        pdfUri: persistedUri,
        codeImage: images.codeImage,
        codeType: parsed.codeType ?? undefined,
      });

      onClose();
    } catch (err) {
      // Kontogebundener Endpoint: 401 = nicht eingeloggt → Login-Screen
      // öffnen, 429 = Tageslimit des Kontos erreicht.
      const status = err instanceof TicketParseError ? err.status : null;
      if (status === 401) {
        onClose();
        useSearchStore.getState().openAuthOverlay();
        return;
      }
      showAlert(
        t("saved.modal.error.title"),
        status === 429 ? t("saved.modal.error.ratelimit") : (err as Error).message,
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <GestureHandlerRootView style={styles.root}>
      <View style={styles.backdrop}>
        <Pressable style={StyleSheet.absoluteFill} onPress={busy ? undefined : onClose} />
        <Animated.View style={[styles.sheet, sheetAnim]}>
          <GestureDetector gesture={panGesture}>
            <View style={styles.handleWrap}>
              <View style={styles.handle} />
            </View>
          </GestureDetector>

          <Text style={styles.title}>{t("saved.modal.title")}</Text>
          <Text style={styles.subtitle}>{t("saved.modal.subtitle")}</Text>

          {busy ? (
            <View style={styles.busyWrap}>
              <ActivityIndicator size="large" color={accent.solid} />
              <Text style={styles.busyText}>{t("saved.modal.parsing")}</Text>
            </View>
          ) : (
            <ScrollView showsVerticalScrollIndicator={false}>
              <View style={styles.tilesRow}>
                {MODES.map((m) => {
                  const Icon = m.icon;
                  return (
                    <RippleTouch
                      key={m.id}
                      onPress={() => pickAndParse(m.id)}
                      style={({ pressed }) => [
                        styles.tile,
                        { opacity: pressed ? 0.85 : 1 },
                      ]}
                    >
                      <Icon size={22} color="#FFFFFF" strokeWidth={1.8} />
                      <Text style={styles.tileLabel}>{t(m.labelKey)}</Text>
                    </RippleTouch>
                  );
                })}
              </View>

              <Text style={styles.hint}>{t("saved.modal.hint")}</Text>
            </ScrollView>
          )}
        </Animated.View>
      </View>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(0,0,0,0.6)" },
  sheet: {
    backgroundColor: "#1F1F20",
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    paddingHorizontal: 20,
    paddingBottom: 40,
    minHeight: 320,
  },
  root: { flex: 1 },
  handleWrap: { alignItems: "center", paddingTop: 12, paddingBottom: 16 },
  handle: { width: 40, height: 4, borderRadius: 9999, backgroundColor: "#FFFFFF" },
  title: { fontSize: 18, fontWeight: "700", color: "#FFFFFF", marginBottom: 6 },
  subtitle: { fontSize: 13, color: "#8A8A90", marginBottom: 18, lineHeight: 18 },
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
    backgroundColor: "#1F1F20",
    borderWidth: 1,
    borderColor: "#2E2E30",
    alignItems: "center",
    gap: 8,
  },
  tileLabel: { fontSize: 13, fontWeight: "600", color: "#FFFFFF" },
  hint: { fontSize: 12, color: "#56565C", textAlign: "center", lineHeight: 18, paddingHorizontal: 6, marginTop: 6 },
  busyWrap: { alignItems: "center", justifyContent: "center", paddingVertical: 50, gap: 14 },
  busyText: { fontSize: 14, color: "#C8C8CC" },
});
