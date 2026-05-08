import { useState } from "react";
import { View, Text, Share, Image, StyleSheet } from "react-native";
import { useRouter } from "expo-router";
import { Heart, Share2, Plane, Train, Bus, Ship, ChevronRight } from "lucide-react-native";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSequence,
  withTiming,
  Easing,
} from "react-native-reanimated";
import { SearchResult, TravelMode } from "@/types/search";
import { useSearchStore } from "@/stores/searchStore";
import { useT } from "@/lib/i18n/useT";
import { formatTimeInZone, formatDateInZone } from "@/lib/time-format";
import { redirectUrl } from "@/lib/api/client";
import { haptic } from "@/lib/haptics";
import { RippleTouch } from "@/components/ui/RippleTouch";
import { GradientFill } from "@/components/ui/GradientFill";
import { displayCode, displayProvider, logoUrls } from "@/lib/results/logos";
import { tripSignature } from "@/lib/results/signature";

interface Props {
  result: SearchResult;
  passengers?: number;
}

const C = {
  card: "#242425",
  border: "#2E2E30",
  text: "#FFFFFF",
  sub: "#8A8A90",
  subDim: "#56565C",
  lime: "#7FEA4D",
  black: "#000000",
};

const MODE_ICON = { FLIGHT: Plane, TRAIN: Train, BUS: Bus, CRUISE: Ship };

function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

function currencyCode(code: string): string {
  return code.toUpperCase();
}

export function ResultCard({ result, passengers = 1 }: Props) {
  const t = useT();
  const router = useRouter();
  const savedTrips = useSearchStore((s) => s.savedTrips);
  const toggleSavedTrip = useSearchStore((s) => s.toggleSavedTrip);
  const selectResult = useSearchStore((s) => s.selectResult);
  const showSavedToast = useSearchStore((s) => s.showSavedToast);
  const resultSig = tripSignature(result);
  const favored = savedTrips.some((trip) => tripSignature(trip) === resultSig);

  const bookUrl = result.redirectToken
    ? redirectUrl(result.redirectToken)
    : result.deepLink || "";

  async function onShare() {
    haptic("button");
    try {
      await Share.share({
        title: `${result.originLabel} → ${result.destLabel}`,
        message: `${result.provider} · ${result.currency} ${result.price.toFixed(0)} — ${bookUrl}`,
        url: bookUrl,
      });
    } catch {
      /* ignore */
    }
  }

  function onSelect() {
    haptic("important");
    selectResult(result, passengers);
    router.push("/details");
  }

  const scale = useSharedValue(1);
  const cardAnim = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  function onToggleFav() {
    haptic("button");
    const justSaved = !favored;
    toggleSavedTrip(result, passengers);
    if (justSaved) {
      scale.value = withSequence(
        withTiming(0.92, { duration: 140, easing: Easing.out(Easing.quad) }),
        withTiming(1, { duration: 320, easing: Easing.elastic(1.5) })
      );
      showSavedToast(result);
    }
  }

  const ModeIcon = MODE_ICON[result.mode] ?? Plane;
  const carrierName = displayProvider(result);
  const urls = logoUrls(result, carrierName);
  const [logoIdx, setLogoIdx] = useState(0);
  const currentLogoUrl = urls[logoIdx];
  const departStr = formatTimeInZone(result.departTime, result.originTz);
  const arriveStr = formatTimeInZone(result.arriveTime, result.destinationTz);
  const dateStr = formatDateInZone(result.departTime, result.originTz);
  const arriveDateStr = formatDateInZone(result.arriveTime, result.destinationTz);
  const isDirect = result.stops === 0;
  const stopVia = !isDirect && result.stopLabels?.length ? result.stopLabels[0] : null;
  const stopLabel = isDirect
    ? t("results.direct")
    : `${result.stops} ${result.stops === 1 ? t("results.stop") : t("results.stops")}${stopVia ? ` · ${stopVia}` : ""}`;
  const flightCode = result.flightNumber ?? "";

  return (
    <Animated.View style={[styles.card, cardAnim]}>
      <View style={styles.headerRow}>
        <View style={styles.providerWrap}>
          <View style={styles.providerLogo}>
            {currentLogoUrl ? (
              <Image
                key={currentLogoUrl}
                source={{ uri: currentLogoUrl }}
                style={styles.providerLogoImg}
                resizeMode="contain"
                onError={() => setLogoIdx((i) => i + 1)}
              />
            ) : (
              <ModeIcon color={C.black} size={16} />
            )}
          </View>
          <Text style={styles.providerName} numberOfLines={1}>
            {carrierName}
          </Text>
          {flightCode ? (
            <>
              <Text style={styles.providerSep}>·</Text>
              <Text style={styles.providerCode}>{flightCode}</Text>
            </>
          ) : null}
        </View>
        <View style={styles.headerActions}>
          <RippleTouch onPress={onShare} hitSlop={8} borderless style={styles.iconBtn}>
            <Share2 color={C.text} size={18} />
          </RippleTouch>
          <RippleTouch onPress={onToggleFav} hitSlop={8} borderless style={styles.iconBtn}>
            <Heart
              color={favored ? "#FF3B5C" : C.text}
              fill={favored ? "#FF3B5C" : "transparent"}
              size={18}
            />
          </RippleTouch>
        </View>
      </View>

      <View style={styles.timeRow}>
        <View style={styles.timeCol}>
          {result.dateOnly ? (
            <Text style={styles.timeBig}>—</Text>
          ) : (
            <Text style={styles.timeBig}>{departStr}</Text>
          )}
        </View>
        <View style={styles.timeCenter}>
          <Text style={styles.durationText}>{formatDuration(result.durationMinutes)}</Text>
          <View style={styles.dottedLineWrap}>
            <View style={[styles.dot, { backgroundColor: isDirect ? C.lime : "#FFB266" }]} />
            <View style={styles.dottedLine} />
            <View style={[styles.dot, { backgroundColor: isDirect ? C.lime : "#FFB266" }]} />
          </View>
          <Text style={isDirect ? styles.statusDirect : styles.statusStops} numberOfLines={1}>
            {stopLabel}
          </Text>
        </View>
        <View style={[styles.timeCol, { alignItems: "flex-end" }]}>
          {result.dateOnly ? (
            <Text style={styles.timeBig}>—</Text>
          ) : (
            <Text style={styles.timeBig}>{arriveStr}</Text>
          )}
        </View>
      </View>

      <View style={styles.metaRow}>
        {(() => {
          const code = result.mode === "FLIGHT" ? displayCode(result.origin) : "";
          const label = code || (result.originLabel?.split(",")[0]?.trim() ?? "");
          return (
            <View style={styles.metaCol}>
              <Text style={styles.metaCode} numberOfLines={1}>{label}</Text>
              {dateStr ? <Text style={styles.metaDate}>{dateStr}</Text> : null}
            </View>
          );
        })()}
        {(() => {
          const code = result.mode === "FLIGHT" ? displayCode(result.destination) : "";
          const label = code || (result.destLabel?.split(",")[0]?.trim() ?? "");
          return (
            <View style={[styles.metaCol, { alignItems: "flex-end" }]}>
              <Text style={[styles.metaCode, { textAlign: "right" }]} numberOfLines={1}>
                {label}
              </Text>
              {arriveDateStr ? (
                <Text style={[styles.metaDate, { textAlign: "right" }]}>{arriveDateStr}</Text>
              ) : null}
            </View>
          );
        })()}
      </View>

      <View style={styles.divider} />

      <View style={styles.footerRow}>
        <View style={styles.priceCol}>
          {result.price > 0 ? (
            <Text style={styles.priceText}>
              <Text style={styles.priceLabelInline}>{t("results.from")} </Text>
              {result.price.toFixed(0)}
              <Text style={styles.priceCurrency}>  {currencyCode(result.currency)}</Text>
            </Text>
          ) : (
            <Text style={styles.priceUnknownText}>Tarif beim Anbieter</Text>
          )}
        </View>
        <RippleTouch onPress={onSelect} style={styles.cta}>
          <GradientFill />
          <Text style={styles.ctaText}>{t("results.select")}</Text>
          <ChevronRight color={C.black} size={14} strokeWidth={2.5} />
        </RippleTouch>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: C.card,
    borderRadius: 20,
    paddingVertical: 14,
    paddingHorizontal: 16,
  },
  headerRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 14,
    gap: 10,
  },
  providerWrap: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    minWidth: 0,
  },
  providerLogo: {
    width: 28,
    height: 28,
    borderRadius: 8,
    backgroundColor: "#FFFFFF",
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  providerLogoImg: { width: 24, height: 24 },
  providerName: { color: C.text, fontSize: 14, fontWeight: "700", letterSpacing: -0.1 },
  providerSep: { color: C.subDim, fontSize: 13 },
  providerCode: { color: C.sub, fontSize: 12, fontWeight: "600" },
  headerActions: { flexDirection: "row", alignItems: "center", gap: 12 },
  iconBtn: { padding: 2 },

  timeRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  timeCol: { minWidth: 70, flexShrink: 0 },
  timeBig: { color: C.text, fontSize: 24, fontWeight: "800", letterSpacing: -0.6 },
  timeCenter: { flex: 1, alignItems: "center", gap: 4 },
  durationText: { color: C.sub, fontSize: 11, fontWeight: "600" },
  dottedLineWrap: {
    flexDirection: "row",
    alignItems: "center",
    width: "100%",
    gap: 4,
  },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: C.lime },
  dottedLine: {
    flex: 1,
    height: 0,
    borderTopWidth: 1,
    borderColor: C.subDim,
    borderStyle: "dashed",
  },
  statusDirect: { color: C.lime, fontWeight: "700", fontSize: 12 },
  statusStops: { color: "#FFB266", fontWeight: "700", fontSize: 12 },

  metaRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    marginTop: 6,
    gap: 10,
  },
  metaCol: { flex: 1, minWidth: 0, alignItems: "flex-start" },
  metaCode: { color: C.sub, fontSize: 12, fontWeight: "700", letterSpacing: 0.4 },
  metaDate: { color: C.subDim, fontSize: 11, fontWeight: "500", marginTop: 2 },

  divider: { height: 1, backgroundColor: C.border, marginVertical: 14 },

  footerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  priceCol: { flex: 1 },
  priceLabelInline: { color: C.sub, fontSize: 11, fontWeight: "700", letterSpacing: 0.4 },
  priceText: { color: C.lime, fontSize: 22, fontWeight: "800", letterSpacing: -0.5 },
  priceCurrency: { color: C.text, fontSize: 12, fontWeight: "700", letterSpacing: 0 },
  priceUnknownText: { color: C.sub, fontSize: 13, fontWeight: "600", marginTop: 1 },
  cta: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    borderRadius: 9999,
    paddingHorizontal: 16,
    paddingVertical: 10,
    overflow: "hidden",
  },
  ctaText: { color: C.black, fontSize: 13, fontWeight: "700", letterSpacing: -0.1 },
});
