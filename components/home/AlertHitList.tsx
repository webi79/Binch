import { memo, useCallback } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { Bus, Plane, Ship, Train, X, type LucideIcon } from "lucide-react-native";
import { haptic } from "@/lib/haptics";
import { useRouteMeta } from "@/lib/format/routeMeta";
import { useT } from "@/lib/i18n/useT";
import { useAccent } from "@/lib/theme/accent";
import { usePalette } from "@/lib/theme/appBg";
import { GUTTER, SPACE } from "@/lib/theme/spacing";
import { scaledStyles } from "@/lib/ui/compact";
import { useSearchStore } from "@/stores/searchStore";
import type { AlertHit } from "@/types/saved";
import type { TravelMode } from "@/types/search";

/**
 * Die Alarme, die AUSGELÖST haben — der Inhalt der Glocke.
 *
 * Hier standen bis eben die gesetzten Alarme selbst, und das war falsch herum:
 * Eine Glocke zeigt, was passiert IST. Ein gesetzter Alarm ist eine stehende
 * Beobachtung und gehört zu den gespeicherten Reisen; erst wenn er anschlägt,
 * entsteht ein Ereignis — mit Zeitpunkt, Preis und Änderung.
 *
 * Die Zahlen kommen aus dem DATENTEIL der Meldung, nicht aus ihrem Text. Den
 * wieder auseinanderzunehmen hieße, gekürzte Ortsnamen und Währungszeichen
 * zurückzurechnen — ein Parser, der bei jeder Textänderung still bricht.
 */

const MODE_ICON: Record<TravelMode, LucideIcon> = {
  FLIGHT: Plane,
  TRAIN: Train,
  BUS: Bus,
  CRUISE: Ship,
};

const C = {
  text: "#F4F4F5",
  sub: "#8E8E93",
  rise: "#FF3B5C",
};

function Card({ hit }: { hit: AlertHit }) {
  const t = useT();
  const palette = usePalette();
  const accent = useAccent();
  const { metaLine, routeLine, fmtDate } = useRouteMeta();
  const removeAlertHit = useSearchStore((s) => s.removeAlertHit);
  const Icon = MODE_ICON[hit.mode] ?? Train;

  /**
   * Gefallen oder gestiegen — die FARBE trägt es, nicht ein Wort.
   *
   * Der Prozentsatz steht mit Vorzeichen da („-11 %"), genau wie in der
   * Meldung selbst. Grün für den Sturz, Rot für den Anstieg: dieselbe
   * Zuordnung wie beim Abzeichen im Alarm-Blatt, damit nicht zwei Stellen
   * dasselbe verschieden ausdrücken.
   */
  const dropped = hit.pct > 0;
  const pctColor = dropped ? accent.solid : C.rise;
  const pctText = `${dropped ? "-" : "+"}${Math.abs(hit.pct)}%`;

  return (
    <View style={[styles.card, { backgroundColor: palette.s2 }]}>
      <View style={styles.head}>
        <View style={styles.headText}>
          <Text style={styles.route} numberOfLines={2}>
            {routeLine(hit.originLabel, hit.destLabel)}
          </Text>
          <Text style={styles.meta} numberOfLines={1}>
            {metaLine({
              departDate: hit.departDate,
              returnDate: hit.returnDate,
              passengers: hit.passengers,
              travelClassKey: hit.travelClass,
            })}
          </Text>
        </View>
        {/* Wegwischen gibt es hier nicht — das Blatt selbst liegt auf einer
            Wisch-Geste, und zwei Gesten in derselben Richtung verhaken sich.
            Ein Kreuz an der Stelle des Papierkorbs auf der Alarm-Karte. */}
        <Pressable
          onPress={() => {
            haptic("button");
            removeAlertHit(hit.id);
          }}
          hitSlop={10}
          accessibilityRole="button"
          accessibilityLabel={t("common.delete")}
          style={({ pressed }) => [
            styles.close,
            { opacity: pressed ? 0.6 : 1 },
          ]}
        >
          <X size={16} color={C.sub} strokeWidth={2.5} />
        </Pressable>
      </View>

      <View style={styles.divider} />

      {/* Statt des Schalters der Alarm-Karte steht hier das EREIGNIS: der
          Preis, um den es geht, und wie weit er sich bewegt hat. */}
      <View style={styles.factRow}>
        <Icon size={16} color={C.sub} strokeWidth={2} />
        <Text style={styles.price}>{`${Math.round(hit.price)} ${hit.currency}`}</Text>
        <Text style={[styles.pct, { color: pctColor }]}>{pctText}</Text>
        <View style={styles.spacer} />
        <Text style={styles.when}>{fmtDate(hit.receivedAt.slice(0, 10))}</Text>
      </View>
    </View>
  );
}

export const AlertHitList = memo(function AlertHitList() {
  const t = useT();
  const hits = useSearchStore((s) => s.alertHits);
  const clearAlertHits = useSearchStore((s) => s.clearAlertHits);
  const clear = useCallback(() => {
    haptic("button");
    clearAlertHits();
  }, [clearAlertHits]);

  if (hits.length === 0) return null;

  return (
    <View style={styles.wrap}>
      <View style={styles.headRow}>
        <Text style={styles.headText2}>{t("alert.hits.title")}</Text>
        <Pressable
          onPress={clear}
          hitSlop={8}
          accessibilityRole="button"
          style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
        >
          <Text style={styles.clear}>{t("alert.hits.clear")}</Text>
        </Pressable>
      </View>
      {/**
        * Eine Scroll-Fläche mit gedeckelter Höhe statt einer Liste: Es sind
        * höchstens fünfzig Einträge, und eine virtualisierte Liste in einem
        * Blatt, das selbst auf einer Wisch-Geste liegt, bringt zwei Gesten in
        * Konflikt, die sich nichts zu sagen haben.
        */}
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {hits.map((h) => (
          <Card key={h.id} hit={h} />
        ))}
      </ScrollView>
    </View>
  );
});

const styles = scaledStyles({
  wrap: { paddingHorizontal: GUTTER, paddingTop: SPACE.sm },
  headRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingBottom: SPACE.md,
  },
  headText2: { fontSize: 13, fontWeight: "600", color: C.sub },
  clear: { fontSize: 13, fontWeight: "600", color: C.sub },
  scroll: { maxHeight: 320 },
  scrollContent: { gap: SPACE.sm },

  /**
   * DIESELBEN Maße wie `PriceAlertCard` — Zeichen für Zeichen.
   *
   * Beide zeigen dieselbe Strecke in derselben Form; stünden sie in zwei
   * Größen da, sähe es nach zwei verschiedenen Sachen aus. Wer hier etwas
   * ändert, ändert es dort mit.
   */
  /** Dieselbe Aufteilung und dieselben Zahlen wie `PriceAlertCard`. */
  card: { borderRadius: 20, paddingVertical: 14, paddingHorizontal: 16 },
  head: { flexDirection: "row", alignItems: "flex-start", gap: SPACE.md },
  headText: { flex: 1, minWidth: 0 },
  route: { fontSize: 17, fontWeight: "700", color: C.text, lineHeight: 23 },
  meta: { fontSize: 14, fontWeight: "500", color: C.sub, marginTop: SPACE.xs + 2 },
  close: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.08)",
    marginTop: -2,
  },
  divider: { height: 1, backgroundColor: "#212123", marginVertical: 14 },
  factRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: SPACE.sm,
  },
  price: { fontSize: 15, fontWeight: "700", color: C.text },
  pct: { fontSize: 15, fontWeight: "700" },
  spacer: { flex: 1 },
  when: { fontSize: 12, fontWeight: "600", color: C.sub },
});
