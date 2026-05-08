import { View, Text, StyleSheet } from "react-native";
import { useRouter } from "expo-router";
import { Plane, Train, Bus, Ship, ChevronRight, type LucideIcon } from "lucide-react-native";
import { format, parseISO } from "date-fns";
import { de as deLocale, enUS, es as esLocale, fr as frLocale, type Locale as DateLocale } from "date-fns/locale";
import { useT } from "@/lib/i18n/useT";
import { useSearchStore, RecentSearch } from "@/stores/searchStore";
import { TravelMode } from "@/types/search";
import { RippleTouch } from "@/components/ui/RippleTouch";
import { GradientFill } from "@/components/ui/GradientFill";

const C = {
  surface1: "#1F1F20",
  surface2: "#242425",
  green: "#7FEA4D",
  white: "#FFFFFF",
  gray1: "#C8C8CC",
  gray2: "#8A8A90",
  gray3: "#56565C",
};

const MODE_ICON: Record<TravelMode, LucideIcon> = {
  FLIGHT: Plane,
  TRAIN: Train,
  BUS: Bus,
  CRUISE: Ship,
};

const DATE_LOCALES: Record<string, DateLocale> = {
  en: enUS,
  de: deLocale,
  fr: frLocale,
  es: esLocale,
};

export function RecentCard({ search, bordered = false }: { search: RecentSearch; bordered?: boolean }) {
  const t = useT();
  const router = useRouter();
  const locale = useSearchStore((s) => s.locale);
  const closeRecentHistoryOverlay = useSearchStore((s) => s.closeRecentHistoryOverlay);
  const Icon = MODE_ICON[search.mode];
  const dateLocale = DATE_LOCALES[locale] ?? enUS;
  const dateLabel = (() => {
    try {
      return format(parseISO(search.departDate), "d. MMM", { locale: dateLocale });
    } catch {
      return search.departDate;
    }
  })();
  const paxLabel = `${search.passengers} ${
    search.passengers === 1 ? t("search.passenger.singular") : t("search.passenger.plural")
  }`;
  const classLabel =
    search.mode === "FLIGHT" ? t("search.class.economy") : t("search.class.second");
  const isCleanCode = (code: string) =>
    code.length > 0 && code.length <= 6 && !code.includes(":");
  const formatEndpoint = (e: { code: string; label: string }) => {
    const city = e.label.split(",")[0]?.trim() ?? e.label;
    return isCleanCode(e.code) && search.mode === "FLIGHT" ? `${city} (${e.code})` : city;
  };

  function open() {
    closeRecentHistoryOverlay();
    router.push({
      pathname: "/search/results",
      params: {
        mode: search.mode,
        origin: search.origin.code,
        destination: search.destination.code,
        originLabel: search.origin.label,
        destLabel: search.destination.label,
        departDate: search.departDate,
        passengers: String(search.passengers),
        currency: search.currency,
      },
    });
  }

  return (
    <RippleTouch style={[styles.recentCard, bordered && styles.recentCardBordered]} onPress={open}>
      <View style={styles.recentIconWrap}>
        <Icon size={20} color={C.gray1} />
      </View>
      <View style={styles.recentText}>
        <Text style={styles.recentRoute} numberOfLines={1}>
          {formatEndpoint(search.origin)} – {formatEndpoint(search.destination)}
        </Text>
        <Text style={styles.recentMeta} numberOfLines={1}>
          {dateLabel} · {paxLabel} · {classLabel}
        </Text>
      </View>
      <View style={styles.recentRight}>
        <View style={styles.pricePill}>
          <GradientFill />
          <Text style={styles.pricePillText}>{search.currency}</Text>
        </View>
        <ChevronRight size={14} color={C.gray3} />
      </View>
    </RippleTouch>
  );
}

const styles = StyleSheet.create({
  recentCard: {
    backgroundColor: C.surface1,
    borderRadius: 16,
    paddingHorizontal: 16,
    paddingVertical: 14,
    flexDirection: "row",
    alignItems: "center",
    marginHorizontal: 20,
    marginBottom: 8,
    gap: 12,
  },
  recentCardBordered: {
    borderWidth: 1,
    borderColor: "#2E2E30",
  },
  recentIconWrap: {
    width: 44,
    height: 44,
    borderRadius: 14,
    backgroundColor: C.surface2,
    alignItems: "center",
    justifyContent: "center",
  },
  recentText: { flex: 1, minWidth: 0 },
  recentRoute: { fontSize: 14, fontWeight: "600", color: C.white },
  recentMeta: { fontSize: 12, color: C.gray2, marginTop: 3 },
  recentRight: { alignItems: "flex-end", gap: 6 },
  pricePill: {
    borderRadius: 9999,
    paddingHorizontal: 9,
    paddingVertical: 4,
    overflow: "hidden",
  },
  pricePillText: { fontSize: 11, fontWeight: "700", color: "#000" },
});
