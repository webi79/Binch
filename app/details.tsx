import { useRef, useState } from "react";
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  Image,
  Linking,
  Share,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import {
  ArrowLeft,
  Heart,
  Share2,
  ChevronRight,
  Plane,
  Train,
  Bus,
  Ship,
  AlertCircle,
  type LucideIcon,
} from "lucide-react-native";
import { format, parseISO } from "date-fns";
import { de, enGB, es, fr } from "date-fns/locale";
import { useT } from "@/lib/i18n/useT";
import { useSearchStore } from "@/stores/searchStore";
import { haptic } from "@/lib/haptics";
import { redirectUrl } from "@/lib/api/client";
import { RippleTouch } from "@/components/ui/RippleTouch";
import { GradientFill } from "@/components/ui/GradientFill";
import { displayCode, displayProvider, logoUrls } from "@/lib/results/logos";
import { tripSignature } from "@/lib/results/signature";
import { TravelMode } from "@/types/search";

const C = {
  bg: "#1A1A1A",
  card: "#242425",
  surface: "#1F1F20",
  surface3: "#2A2A2C",
  border: "#2E2E30",
  text: "#FFFFFF",
  sub: "#8A8A90",
  subDim: "#56565C",
  lime: "#7FEA4D",
  black: "#000000",
  red: "#FF3B5C",
};

const MODE_ICON: Record<TravelMode, LucideIcon> = {
  FLIGHT: Plane,
  TRAIN: Train,
  BUS: Bus,
  CRUISE: Ship,
};

const DATE_LOCALES = { en: enGB, de, fr, es } as const;

function formatDuration(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

export default function DetailsScreen() {
  const router = useRouter();
  const t = useT();
  const storeResult = useSearchStore((s) => s.selectedResult);
  const passengers = useSearchStore((s) => s.selectedPassengers);
  const locale = useSearchStore((s) => s.locale);
  const savedTrips = useSearchStore((s) => s.savedTrips);
  const toggleSavedTrip = useSearchStore((s) => s.toggleSavedTrip);
  const openLegTimelineOverlay = useSearchStore((s) => s.openLegTimelineOverlay);

  // Damit der Screen während der Slide-Back-Animation gerendert bleibt: wenn der
  // Store den selectedResult durch Navigation zurücksetzt, halten wir lokal die
  // letzte Version, sodass die UI nicht in einen Empty-State flippt.
  const cachedRef = useRef(storeResult);
  if (storeResult) cachedRef.current = storeResult;
  const result = storeResult ?? cachedRef.current;

  if (!result) {
    return (
      <SafeAreaView style={styles.root} edges={["top"]}>
        <View style={styles.topbar}>
          <RippleTouch onPress={() => router.back()} hitSlop={10} borderless style={styles.iconBtn}>
            <ArrowLeft color={C.text} size={22} />
          </RippleTouch>
        </View>
      </SafeAreaView>
    );
  }

  const dateLocale = DATE_LOCALES[locale] ?? enGB;
  const carrier = displayProvider(result);
  const urls = logoUrls(result, carrier);
  const [logoIdx, setLogoIdx] = useState(0);
  const ModeIcon = MODE_ICON[result.mode] ?? Plane;
  const resultSig = tripSignature(result);
  const favored = savedTrips.some((trip) => tripSignature(trip) === resultSig);
  const isDirect = result.stops === 0;
  const stopVia = !isDirect && result.stopLabels?.length ? result.stopLabels[0] : null;
  const stopLabel =
    result.stops === 0
      ? t("details.stop.zero")
      : result.stops === 1
      ? t("details.stop.one")
      : t("details.stop.many").replace("{count}", String(result.stops));
  const dateStr = (() => {
    try {
      return format(parseISO(result.departTime), "d MMM", { locale: dateLocale });
    } catch {
      return "";
    }
  })();
  const departTime = (() => {
    try {
      return format(parseISO(result.departTime), "HH:mm");
    } catch {
      return "";
    }
  })();
  const arriveTime = (() => {
    try {
      return format(parseISO(result.arriveTime), "HH:mm");
    } catch {
      return "";
    }
  })();

  const originName = displayCode(result.origin) || result.originLabel?.split(",")[0]?.trim() || result.origin;
  const destName = displayCode(result.destination) || result.destLabel?.split(",")[0]?.trim() || result.destination;

  const paxKey = passengers === 1 ? "details.passenger.one" : "details.passenger.many";
  const paxLabel = t(paxKey).replace("{count}", String(passengers));
  const classLabel = result.mode === "FLIGHT" ? t("search.class.economy") : t("search.class.second");

  const bookUrl = result.redirectToken
    ? redirectUrl(result.redirectToken)
    : result.deepLink || "";

  async function onShare() {
    if (!result) return;
    haptic("button");
    try {
      await Share.share({
        title: `${result.originLabel} → ${result.destLabel}`,
        message: `${carrier} · ${result.currency} ${result.price.toFixed(0)} — ${bookUrl}`,
        url: bookUrl,
      });
    } catch {
      /* ignore */
    }
  }

  async function onBook() {
    if (!bookUrl) return;
    haptic("important");
    const ok = await Linking.canOpenURL(bookUrl);
    if (ok) Linking.openURL(bookUrl);
  }

  const currentLogoUrl = urls[logoIdx];

  return (
    <SafeAreaView style={styles.root} edges={["top"]}>
      <View style={styles.topbar}>
        <RippleTouch
          onPress={() => {
            haptic("button");
            router.back();
          }}
          hitSlop={10}
          borderless
          style={styles.iconBtn}
        >
          <ArrowLeft color={C.text} size={22} />
        </RippleTouch>
        <Text style={styles.topbarTitle} numberOfLines={1}>
          {t("details.title")}
        </Text>
        <View style={styles.topbarActions}>
          <RippleTouch onPress={onShare} hitSlop={8} borderless style={styles.iconBtn}>
            <Share2 color={C.text} size={20} />
          </RippleTouch>
          <RippleTouch
            onPress={() => {
              haptic("button");
              toggleSavedTrip(result, passengers);
            }}
            hitSlop={8}
            borderless
            style={styles.iconBtn}
          >
            <Heart
              color={favored ? C.red : C.text}
              fill={favored ? C.red : "transparent"}
              size={20}
            />
          </RippleTouch>
        </View>
      </View>

      <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
        <View style={styles.tripCard}>
          <View style={styles.tripTitleBlock}>
            <Text style={styles.tripTitle} numberOfLines={2}>
              {originName}
            </Text>
            <View style={styles.tripTitleDivider} />
            <Text style={styles.tripTitle} numberOfLines={2}>
              {destName}
            </Text>
          </View>
          <View style={styles.tripMetaRow}>
            <Text style={styles.tripMeta}>{dateStr}</Text>
            <Text style={styles.tripMetaDot}>·</Text>
            <Text style={styles.tripMeta}>{paxLabel}</Text>
            <Text style={styles.tripMetaDot}>·</Text>
            <Text style={styles.tripMeta}>{t("details.oneway")}</Text>
            <Text style={styles.tripMetaDot}>·</Text>
            <Text style={styles.tripMeta}>{classLabel}</Text>
          </View>

          <View style={styles.divider} />

          <Text style={styles.legSummaryTitle}>
            {originName} {t("home.popular.from") === "from" ? "to" : "→"} {destName}
          </Text>
          <View style={styles.legSummaryRow}>
            <View style={styles.legLogo}>
              {currentLogoUrl ? (
                <Image
                  key={currentLogoUrl}
                  source={{ uri: currentLogoUrl }}
                  style={styles.legLogoImg}
                  resizeMode="contain"
                  onError={() => setLogoIdx((i) => i + 1)}
                />
              ) : (
                <ModeIcon color={C.black} size={20} />
              )}
            </View>
            <View style={styles.legBody}>
              <Text style={styles.legTimes}>
                {departTime} – {arriveTime}
              </Text>
              {stopVia ? (
                <Text style={styles.legSub} numberOfLines={1}>
                  via {stopVia}
                </Text>
              ) : (
                <Text style={styles.legSub} numberOfLines={1}>
                  {carrier}
                </Text>
              )}
            </View>
            <View style={styles.legRight}>
              <Text style={isDirect ? styles.statusDirect : styles.statusStops}>{stopLabel}</Text>
              <Text style={styles.statusDuration}>{formatDuration(result.durationMinutes)}</Text>
            </View>
          </View>

          <View style={styles.divider} />

          <RippleTouch
            style={styles.viewDetailsBtn}
            onPress={() => {
              haptic("button");
              openLegTimelineOverlay();
            }}
          >
            <Text style={styles.viewDetailsText}>{t("details.viewdetails")}</Text>
          </RippleTouch>
        </View>

        {!isDirect ? (
          <>
            <Text style={styles.sectionTitle}>Good to know</Text>
            <View style={styles.warnCard}>
              <View style={styles.warnIcon}>
                <AlertCircle color={C.red} size={16} fill={C.red} />
              </View>
              <Text style={styles.warnText}>Self transfer</Text>
              <ChevronRight color={C.subDim} size={18} />
            </View>
          </>
        ) : null}

        <Text style={styles.sectionTitle}>{t("details.bookticket")}</Text>
        <Text style={styles.sectionSub}>1 provider · Prices in {result.currency.toUpperCase()}</Text>

        <View style={styles.providerCard}>
          <View style={styles.providerCardTop}>
            <Text style={styles.providerCardName}>{carrier}</Text>
            <Text style={styles.providerCardPrice}>
              {result.price > 0 ? `${result.price.toFixed(0)} ${result.currency.toUpperCase()}` : "—"}
            </Text>
          </View>
          <RippleTouch onPress={onBook} style={styles.gotoSiteBtn}>
            <GradientFill />
            <Text style={styles.gotoSiteText}>{t("details.gotosite")}</Text>
            <ChevronRight color={C.black} size={16} strokeWidth={2.5} />
          </RippleTouch>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },
  topbar: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 12,
    gap: 12,
  },
  iconBtn: { width: 40, height: 40, alignItems: "center", justifyContent: "center" },
  topbarTitle: { color: C.text, fontSize: 20, fontWeight: "800", flex: 1, letterSpacing: -0.4 },
  topbarActions: { flexDirection: "row" },

  scrollContent: { paddingHorizontal: 16, paddingBottom: 100 },

  tripCard: {
    backgroundColor: C.card,
    borderRadius: 24,
    padding: 18,
  },
  tripTitleBlock: { gap: 10 },
  tripTitle: {
    color: C.text,
    fontSize: 26,
    fontWeight: "800",
    letterSpacing: -0.5,
    lineHeight: 30,
  },
  tripTitleDivider: { height: 1, backgroundColor: C.border },
  tripMetaRow: { flexDirection: "row", flexWrap: "wrap", marginTop: 14, gap: 6, alignItems: "center" },
  tripMeta: { color: C.sub, fontSize: 13, fontWeight: "500" },
  tripMetaDot: { color: C.subDim, fontSize: 13 },

  divider: { height: 1, backgroundColor: C.border, marginVertical: 16 },

  legSummaryTitle: { color: C.sub, fontSize: 13, fontWeight: "500", marginBottom: 10 },
  legSummaryRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  legLogo: {
    width: 44,
    height: 44,
    borderRadius: 10,
    backgroundColor: "#FFFFFF",
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  legLogoImg: { width: 36, height: 36 },
  legBody: { flex: 1, minWidth: 0 },
  legTimes: { color: C.text, fontSize: 18, fontWeight: "800", letterSpacing: -0.3 },
  legSub: { color: C.sub, fontSize: 12, marginTop: 2 },
  legRight: { alignItems: "flex-end" },
  statusDirect: { color: C.lime, fontSize: 13, fontWeight: "700" },
  statusStops: { color: "#FFB266", fontSize: 13, fontWeight: "700" },
  statusDuration: { color: C.sub, fontSize: 12, marginTop: 2 },

  viewDetailsBtn: {
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 4,
  },
  viewDetailsText: {
    color: C.lime,
    fontSize: 13,
    fontWeight: "600",
    textDecorationLine: "underline",
  },

  sectionTitle: {
    color: C.text,
    fontSize: 22,
    fontWeight: "800",
    letterSpacing: -0.4,
    marginTop: 28,
    marginBottom: 12,
  },
  sectionSub: { color: C.sub, fontSize: 13, marginTop: -8, marginBottom: 12 },

  warnCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: C.card,
    borderRadius: 16,
    padding: 14,
    marginBottom: 8,
  },
  warnIcon: {
    width: 26,
    height: 26,
    borderRadius: 13,
    alignItems: "center",
    justifyContent: "center",
  },
  warnText: { color: C.text, fontSize: 15, fontWeight: "600", flex: 1 },

  providerCard: {
    backgroundColor: C.card,
    borderRadius: 20,
    padding: 16,
    gap: 14,
  },
  providerCardTop: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  providerCardName: { color: C.text, fontSize: 18, fontWeight: "700", letterSpacing: -0.2 },
  providerCardPrice: { color: C.lime, fontSize: 22, fontWeight: "800", letterSpacing: -0.5 },
  gotoSiteBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    height: 46,
    borderRadius: 9999,
    overflow: "hidden",
  },
  gotoSiteText: { color: C.black, fontSize: 14, fontWeight: "700" },
});
