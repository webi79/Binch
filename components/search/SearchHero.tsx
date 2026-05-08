import { useMemo, useState } from "react";
import {
  View,
  Text,
  Pressable,
  ScrollView,
  ImageBackground,
  StyleSheet,
  Platform,
} from "react-native";
import { showAlert } from "@/lib/alert";
import { RippleTouch } from "@/components/ui/RippleTouch";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";
import DateTimePicker, {
  DateTimePickerEvent,
} from "@react-native-community/datetimepicker";
import {
  Plane,
  Train,
  Bus,
  Ship,
  Mic,
  ArrowLeftRight,
  type LucideIcon,
} from "lucide-react-native";
import { format } from "date-fns";
import { de as deLocale, enUS, fr as frLocale, es as esLocale, type Locale as DateLocale } from "date-fns/locale";
import { useRouter } from "expo-router";
import { Location, TravelMode } from "@/types/search";
import { useT } from "@/lib/i18n/useT";
import { useSearchStore } from "@/stores/searchStore";
import { haptic } from "@/lib/haptics";
import { LocationPicker } from "./LocationPicker";
import { POPULAR_LOCATIONS } from "@/lib/data/popularLocations";

const C = {
  bg: "#1A1A1A",
  surface1: "#1F1F20",
  surface2: "#242425",
  surface3: "#2A2A2C",
  border: "#2E2E30",
  green: "#7FEA4D",
  greenSubtle: "#1A3D26",
  white: "#FFFFFF",
  gray1: "#C8C8CC",
  gray2: "#8A8A90",
  gray3: "#56565C",
};

const DATE_LOCALES: Record<string, DateLocale> = {
  en: enUS,
  de: deLocale,
  fr: frLocale,
  es: esLocale,
};

const HERO_IMAGES: Record<TravelMode, ReturnType<typeof require>> = {
  FLIGHT: require("@/assets/search/fliegen.png"),
  TRAIN: require("@/assets/search/trains.png"),
  BUS: require("@/assets/search/buses.png"),
  CRUISE: require("@/assets/search/cruises.png"),
};

const MODE_ICON: Record<TravelMode, LucideIcon> = {
  FLIGHT: Plane,
  TRAIN: Train,
  BUS: Bus,
  CRUISE: Ship,
};

type TripType = "roundtrip" | "oneway" | "multicity";

function tripTypesFor(mode: TravelMode): { id: TripType; key: string }[] {
  if (mode === "CRUISE") {
    return [
      { id: "roundtrip", key: "search.cruise.roundtrip" },
      { id: "oneway", key: "search.cruise.oneway" },
    ];
  }
  const base: { id: TripType; key: string }[] = [
    { id: "roundtrip", key: "search.tabs.roundtrip" },
    { id: "oneway", key: "search.tabs.oneway" },
  ];
  if (mode === "FLIGHT") base.push({ id: "multicity", key: "search.tabs.multicity" });
  return base;
}

function extraOptionsFor(mode: TravelMode): string[] {
  switch (mode) {
    case "FLIGHT":
      return ["search.class.economy", "search.class.business", "search.class.first"];
    case "TRAIN":
      return ["search.class.second", "search.class.first", "search.class.sparpreis"];
    case "BUS":
      return ["search.seat.standard", "search.seat.comfort", "search.seat.premium"];
    case "CRUISE":
      return ["search.cabin.inside", "search.cabin.outside", "search.cabin.balcony", "search.cabin.suite"];
  }
}

interface Props {
  mode: TravelMode;
}

export function SearchHero({ mode }: Props) {
  const t = useT();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const locale = useSearchStore((s) => s.locale);
  const currency = useSearchStore((s) => s.currency);
  const addRecentSearch = useSearchStore((s) => s.addRecentSearch);
  const closeSearchOverlay = useSearchStore((s) => s.closeSearchOverlay);
  const openVoiceOverlay = useSearchStore((s) => s.openVoiceOverlay);
  const dateLocale = DATE_LOCALES[locale] ?? enUS;

  const [tripType, setTripType] = useState<TripType>("roundtrip");
  const [origin, setOrigin] = useState<Location | null>(null);
  const [destination, setDestination] = useState<Location | null>(null);
  const [departDate, setDepartDate] = useState<Date | null>(null);
  const [returnDate, setReturnDate] = useState<Date | null>(null);
  const [pax, setPax] = useState(1);
  const [extraOpt, setExtraOpt] = useState(0);
  const [pickerField, setPickerField] = useState<"from" | "to" | null>(null);
  const [dateField, setDateField] = useState<"depart" | "return" | null>(null);

  const Icon = MODE_ICON[mode];
  const tripTypes = useMemo(() => tripTypesFor(mode), [mode]);
  const extraOpts = useMemo(() => extraOptionsFor(mode), [mode]);
  const tripTypeIds = tripTypes.map((tt) => tt.id);
  const isRoundtrip = tripType === "roundtrip";

  const modeKey = mode.toLowerCase();
  const fromLabel = t(`search.fromLabel.${modeKey}`);
  const toLabel = t(`search.toLabel.${modeKey}`);
  const fromPlaceholder = t(`search.fromPlaceholder.${modeKey}`);
  const toPlaceholder = t(`search.toPlaceholder.${modeKey}`);
  const extraLabel = t(`search.extraLabel.${modeKey}`);
  const heroTitle = t(`search.title.${modeKey}`);

  function handleSwap() {
    haptic("button");
    setOrigin(destination);
    setDestination(origin);
  }

  function onPickerSelect(loc: Location) {
    if (pickerField === "from") setOrigin(loc);
    else if (pickerField === "to") setDestination(loc);
  }

  function onDateChange(_: DateTimePickerEvent, picked?: Date) {
    if (Platform.OS === "android") setDateField(null);
    if (!picked) return;
    if (dateField === "depart") setDepartDate(picked);
    else if (dateField === "return") setReturnDate(picked);
  }

  function handleSubmit() {
    if (!origin || !destination || !departDate) {
      haptic("error");
      showAlert(t("search.missingdata.title"), t("search.missingdata.body"));
      return;
    }
    haptic("important");
    const departIso = format(departDate, "yyyy-MM-dd");
    addRecentSearch({
      mode,
      origin: { code: origin.code, label: origin.label },
      destination: { code: destination.code, label: destination.label },
      departDate: departIso,
      passengers: pax,
      currency,
    });
    closeSearchOverlay();
    const returnIso = isRoundtrip && returnDate ? format(returnDate, "yyyy-MM-dd") : "";
    router.push({
      pathname: "/search/results",
      params: {
        mode,
        origin: origin.code,
        destination: destination.code,
        originLabel: origin.label,
        destLabel: destination.label,
        departDate: departIso,
        returnDate: returnIso,
        tripType,
        passengers: String(pax),
        currency,
      },
    });
  }

  const formatDate = (d: Date) => format(d, "EEE, d MMM", { locale: dateLocale });

  return (
    <View style={styles.container}>
      <ImageBackground
        source={HERO_IMAGES[mode]}
        style={[styles.hero, { paddingTop: insets.top, height: 310 + insets.top }]}
        resizeMode="cover"
      >
        <LinearGradient
          colors={["transparent", "rgba(26,26,26,0.6)", C.bg]}
          locations={[0, 0.55, 1]}
          style={StyleSheet.absoluteFill}
          pointerEvents="none"
        />

        <View style={[styles.logoWrap, { top: insets.top + 10 }]} pointerEvents="none">
          <Text style={styles.logo}>
            B<Text style={styles.logoAccent}>i</Text>nch
          </Text>
        </View>

        <View style={styles.heroBottom}>
          <View style={styles.titleRow}>
            <Text style={styles.heroTitle}>{heroTitle}</Text>
            <RippleTouch
              onPress={() => {
                haptic("button");
                openVoiceOverlay();
              }}
              borderless
              style={styles.micButton}
              accessibilityLabel={t("mode.voice")}
            >
              <Mic color={C.white} size={20} />
            </RippleTouch>
          </View>
          <View style={styles.greenBar} />
        </View>
      </ImageBackground>

      <ScrollView
        style={styles.form}
        contentContainerStyle={[styles.formContent, { paddingBottom: insets.bottom + 90 }]}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        {tripTypes.length > 1 ? (
          <View style={styles.toggleRow}>
            {tripTypes.map((tt) => {
              const active = tt.id === tripType;
              return (
                <Pressable
                  key={tt.id}
                  onPress={() => {
                    haptic("button");
                    setTripType(tt.id);
                  }}
                  style={[styles.toggleBtn, active && styles.toggleBtnActive]}
                >
                  <Text style={[styles.toggleText, active && styles.toggleTextActive]}>
                    {t(tt.key)}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        ) : null}

        <View style={styles.fromToRow}>
          <RippleTouch
            style={[styles.fieldBox, styles.flex1]}
            onPress={() => {
              haptic("button");
              setPickerField("from");
            }}
          >
            <Text style={styles.fieldLabel}>{fromLabel.toUpperCase()}</Text>
            <Text style={styles.fieldInput} numberOfLines={1}>
              {origin ? origin.label : t("search.choose")}
            </Text>
            <Text style={styles.fieldMeta}>{fromPlaceholder}</Text>
          </RippleTouch>

          <RippleTouch onPress={handleSwap} borderless style={styles.swapBtn}>
            <ArrowLeftRight size={20} color={C.green} />
          </RippleTouch>

          <RippleTouch
            style={[styles.fieldBox, styles.flex1]}
            onPress={() => {
              haptic("button");
              setPickerField("to");
            }}
          >
            <Text style={styles.fieldLabel}>{toLabel.toUpperCase()}</Text>
            <Text style={styles.fieldInput} numberOfLines={1}>
              {destination ? destination.label : t("search.choose")}
            </Text>
            <Text style={styles.fieldMeta}>{toPlaceholder}</Text>
          </RippleTouch>
        </View>

        <View style={styles.dateRow}>
          <RippleTouch
            style={[styles.fieldBox, styles.flex1]}
            onPress={() => {
              haptic("button");
              setDateField("depart");
            }}
          >
            <Text style={styles.fieldLabel}>{t("search.date.depart").toUpperCase()}</Text>
            <Text style={[styles.fieldInput, styles.fieldInputMd]}>
              {departDate ? formatDate(departDate) : t("search.date.placeholder")}
            </Text>
          </RippleTouch>

          {isRoundtrip ? (
            <RippleTouch
              style={[styles.fieldBox, styles.flex1]}
              onPress={() => {
                haptic("button");
                setDateField("return");
              }}
            >
              <Text style={styles.fieldLabel}>{t("search.date.return").toUpperCase()}</Text>
              <Text style={[styles.fieldInput, styles.fieldInputMd]}>
                {returnDate ? formatDate(returnDate) : t("search.date.placeholder")}
              </Text>
            </RippleTouch>
          ) : null}
        </View>

        <View style={styles.dateRow}>
          <View style={[styles.fieldBox, styles.flex1]}>
            <Text style={styles.fieldLabel}>{t("search.persons").toUpperCase()}</Text>
            <View style={styles.paxRow}>
              <RippleTouch
                onPress={() => {
                  haptic("button");
                  setPax((p) => Math.max(1, p - 1));
                }}
                borderless
                style={styles.paxBtn}
              >
                <Text style={styles.paxBtnText}>−</Text>
              </RippleTouch>
              <Text style={styles.paxCount}>{pax}</Text>
              <RippleTouch
                onPress={() => {
                  haptic("button");
                  setPax((p) => Math.min(9, p + 1));
                }}
                borderless
                style={[styles.paxBtn, styles.paxBtnPlus]}
              >
                <Text style={[styles.paxBtnText, styles.paxBtnTextDark]}>+</Text>
              </RippleTouch>
            </View>
          </View>

          <View style={[styles.fieldBox, styles.flex1]}>
            <Text style={styles.fieldLabel}>{extraLabel.toUpperCase()}</Text>
            <View style={styles.pillRow}>
              {extraOpts.map((opt, i) => {
                const active = i === extraOpt;
                return (
                  <Pressable
                    key={opt}
                    onPress={() => {
                      haptic("button");
                      setExtraOpt(i);
                    }}
                    style={[styles.pill, active && styles.pillActive]}
                  >
                    <Text style={[styles.pillText, active && styles.pillTextActive]}>
                      {t(opt)}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </View>
        </View>

        <RippleTouch
          onPress={handleSubmit}
          rippleColor="rgba(0,0,0,0.32)"
          style={styles.cta}
        >
          <Icon size={20} color="rgba(0,0,0,0.6)" style={styles.ctaIcon} />
          <Text style={styles.ctaText}>{t("search.cta.compare")}</Text>
        </RippleTouch>
      </ScrollView>

      <LocationPicker
        visible={pickerField !== null}
        onClose={() => setPickerField(null)}
        onSelect={onPickerSelect}
        field={pickerField ?? "from"}
        mode={mode}
        suggested={POPULAR_LOCATIONS[mode]}
      />

      {dateField !== null ? (
        <DateTimePicker
          value={(dateField === "depart" ? departDate : returnDate) ?? new Date()}
          mode="date"
          display={Platform.OS === "ios" ? "inline" : "default"}
          minimumDate={new Date()}
          onChange={onDateChange}
          themeVariant="dark"
        />
      ) : null}

      {/* preserve unused-tripTypeIds reference for future analytics hooks */}
      {tripTypeIds.length === 0 ? <View /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg },

  hero: { height: 310, justifyContent: "flex-end" },
  logoWrap: { position: "absolute", left: 20, zIndex: 2 },
  logo: { fontSize: 26, fontWeight: "800", letterSpacing: -0.8, color: C.white },
  logoAccent: { color: "#7FEA4D" },
  heroBottom: { paddingHorizontal: 20, paddingBottom: 20 },
  titleRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  heroTitle: { fontSize: 28, fontWeight: "800", letterSpacing: -0.84, color: C.white, flex: 1 },
  micButton: {
    width: 42,
    height: 42,
    borderRadius: 9999,
    backgroundColor: "rgba(36,36,37,0.75)",
    alignItems: "center",
    justifyContent: "center",
    marginLeft: 8,
  },
  greenBar: { marginTop: 8, width: 36, height: 3, borderRadius: 2, backgroundColor: C.green },

  form: { flex: 1, backgroundColor: C.bg, marginTop: -18 },
  formContent: { padding: 16, gap: 10 },

  toggleRow: {
    flexDirection: "row",
    backgroundColor: C.surface2,
    borderRadius: 14,
    padding: 4,
    gap: 4,
  },
  toggleBtn: { flex: 1, paddingVertical: 9, borderRadius: 11, alignItems: "center" },
  toggleBtnActive: { backgroundColor: C.green },
  toggleText: { fontSize: 13, fontWeight: "600", color: C.gray2 },
  toggleTextActive: { color: "#000" },

  fromToRow: { flexDirection: "row", alignItems: "stretch", gap: 10 },
  swapBtn: {
    width: 38,
    height: 38,
    borderRadius: 9999,
    backgroundColor: C.surface3,
    alignItems: "center",
    justifyContent: "center",
    alignSelf: "center",
  },

  fieldBox: { backgroundColor: C.surface1, borderRadius: 16, padding: 14 },
  flex1: { flex: 1 },
  fieldLabel: {
    fontSize: 11,
    fontWeight: "600",
    color: C.gray3,
    letterSpacing: 0.6,
    marginBottom: 6,
  },
  fieldInput: { fontSize: 22, fontWeight: "700", color: C.white, padding: 0 },
  fieldInputMd: { fontSize: 16 },
  fieldMeta: { fontSize: 12, color: C.gray3, marginTop: 3 },

  dateRow: { flexDirection: "row", gap: 10 },

  paxRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 4 },
  paxBtn: {
    width: 30,
    height: 30,
    borderRadius: 9999,
    backgroundColor: C.surface3,
    alignItems: "center",
    justifyContent: "center",
  },
  paxBtnPlus: { backgroundColor: C.green },
  paxBtnText: { fontSize: 18, color: C.white, lineHeight: 22 },
  paxBtnTextDark: { color: "#000" },
  paxCount: { fontSize: 20, fontWeight: "700", color: C.white },

  pillRow: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 4 },
  pill: { paddingVertical: 5, paddingHorizontal: 10, borderRadius: 9999, backgroundColor: C.surface3 },
  pillActive: { backgroundColor: C.greenSubtle, borderWidth: 1, borderColor: C.green },
  pillText: { fontSize: 11, fontWeight: "600", color: C.gray2 },
  pillTextActive: { color: C.green },

  cta: {
    backgroundColor: C.green,
    borderRadius: 16,
    paddingVertical: 17,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    marginTop: 4,
  },
  ctaIcon: { marginRight: 8 },
  ctaText: { fontSize: 17, fontWeight: "700", color: "#000" },
});
