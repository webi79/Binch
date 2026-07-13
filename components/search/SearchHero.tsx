import { useEffect, useMemo, useRef, useState } from "react";
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import {
  View,
  Text,
  Pressable,
  ScrollView,
  StyleSheet,
  Platform,
  type ViewStyle,
} from "react-native";
import { BinchHero, pickTimeOfDay, type HeroCategory } from "./BinchHero";
import { RippleTouch } from "@/components/ui/RippleTouch";
import { SegmentedToggle } from "@/components/ui/SegmentedToggle";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";
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
import { POPULAR_LOCATIONS } from "@/lib/data/popularLocations";
import { useAccent } from "@/lib/theme/accent";

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
  red: "#FF3B5C",
};

type ErrorField = "origin" | "destination" | "depart" | "return";

const DATE_LOCALES: Record<string, DateLocale> = {
  en: enUS,
  de: deLocale,
  fr: frLocale,
  es: esLocale,
};

// Mapping unserer internen TravelMode-Codes auf die BinchHero-Categories.
// BinchHero benutzt deutsche Slugs als Seed-Keys (flug/zug/bus/kreuzfahrt) —
// jede Category bekommt eine eigene Dünen-Skyline-Phase.
const HERO_CATEGORY: Record<TravelMode, HeroCategory> = {
  FLIGHT: "flug",
  TRAIN: "zug",
  BUS: "bus",
  CRUISE: "kreuzfahrt",
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
  // Multi-City ist noch nicht implementiert (kein Leg-Input, kein Server-Contract)
  // → Tab vorerst ausgeblendet, damit er nicht ins Leere läuft. Wird als eigenes
  // Feature nachgezogen (Client-UI + SearchParams.legs[] + beide Provider-Adapter).
  // if (mode === "FLIGHT") base.push({ id: "multicity", key: "search.tabs.multicity" });
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
  const accent = useAccent();
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
  // LocationPicker läuft jetzt am Root-Level via LocationPickerHost.
  // Store-getriebene Open/Result-Flow, keine lokale pickerField-State mehr.
  // Picker läuft am Root-Level via DatePickerHost. Wir lesen das Result
  // aus dem Store; das Field kommt direkt im Result mit, kein lokaler
  // pendingDateField nötig → keine zusätzliche Re-Render-Welle in SearchHero
  // beim Tap. heroPaused wird in BinchHero direkt aus dem Store gelesen.
  // Breite des Title-Text via onLayout messen → der Strich darunter
  // bekommt genau diese Breite.
  const [titleWidth, setTitleWidth] = useState(0);
  // Sobald User auf irgendwas TAPPT (außer dem Tripty-Toggle), wird die
  // Hero-Animation final beendet — Sonne bleibt wo sie ist, Vögel/Geister
  // verschwinden sofort. Einmal getriggert, bleibt's so bis zum nächsten
  // Open des Search-Sheets.
  const [animFinished, setAnimFinished] = useState(false);
  const finishAnim = () => {
    if (!animFinished) setAnimFinished(true);
  };

  // Welche Felder beim letzten Submit fehlerhaft waren → rote Border. Wird
  // sobald der User das jeweilige Feld ausfüllt automatisch geleert.
  const [errors, setErrors] = useState<Set<ErrorField>>(() => new Set());
  const clearError = (field: ErrorField) =>
    setErrors((prev) => {
      if (!prev.has(field)) return prev;
      const next = new Set(prev);
      next.delete(field);
      return next;
    });

  const Icon = MODE_ICON[mode];
  const tripTypes = useMemo(() => tripTypesFor(mode), [mode]);
  const extraOpts = useMemo(() => extraOptionsFor(mode), [mode]);
  // BinchHero-Props stabil halten damit memo greift. Time-of-Day einmal beim
  // Mount auswerten — würde sich während einer Session sowieso kaum ändern.
  // Style ist ein Konstantenliteral, sonst gibt's jedes Render eine neue
  // Referenz und memo muss tief comparen / passt nicht.
  const heroCategory = HERO_CATEGORY[mode];
  const heroTime = useMemo(() => pickTimeOfDay(), []);
  const heroStyle = useMemo<ViewStyle>(() => ({ flex: 1, height: undefined }), []);
  // paused=true wenn Modal offen ODER User irgendwas getappt hat (animFinished).
  // Beides verhindert dass die Hero-Animations weiter spielen.
  // heroPaused fokussiert nur auf animFinished — die Picker-States werden
  // direkt in BinchHero subscribed (kein Pass-Through nötig, spart einen
  // SearchHero-Re-Render bei jedem Picker-Open).
  const heroPaused = animFinished;
  const tripTypeIds = tripTypes.map((tt) => tt.id);
  const isRoundtrip = tripType === "roundtrip";

  const modeKey = mode.toLowerCase();
  const fromLabel = t(`search.fromLabel.${modeKey}`);
  const toLabel = t(`search.toLabel.${modeKey}`);
  const fromPlaceholder = t(`search.fromPlaceholder.${modeKey}`);
  const toPlaceholder = t(`search.toPlaceholder.${modeKey}`);
  const extraLabel = t(`search.extraLabel.${modeKey}`);
  const heroTitle = t(`search.title.${modeKey}`);

  // Visuelles Feedback beim Tausch: das Icon rotiert um 180° pro Klick.
  // Kumulativ (180, 360, 540...), damit jeder Tap eine sichtbare halbe Drehung
  // liefert, statt immer auf 180° zu springen.
  //
  // WICHTIG: das Target wird in einem Ref getrackt, nicht aus swapRotation.value
  // gelesen. Bei einem Doppelklick während die erste Animation noch läuft hat
  // swapRotation.value einen interpolierten Zwischenwert (z.B. 90° statt 180°),
  // und `swapRotation.value + 180 = 270` statt der erwarteten 360. Mit dem
  // Target-Ref inkrementieren wir IMMER um 180 unabhängig vom Animation-State.
  const swapRotation = useSharedValue(0);
  const swapRotationTarget = useRef(0);
  const swapIconStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${swapRotation.value}deg` }],
  }));
  function handleSwap() {
    haptic("button");
    finishAnim();
    setOrigin(destination);
    setDestination(origin);
    swapRotationTarget.current += 180;
    swapRotation.value = withTiming(swapRotationTarget.current, {
      duration: 320,
      easing: Easing.out(Easing.cubic),
    });
  }

  // Result vom Root-Level LocationPickerHost lesen.
  const locationPickerResult = useSearchStore((s) => s.locationPickerResult);
  const lastLocationSessionRef = useRef<number | null>(null);
  useEffect(() => {
    if (!locationPickerResult) return;
    if (locationPickerResult.sessionKey === lastLocationSessionRef.current) return;
    lastLocationSessionRef.current = locationPickerResult.sessionKey;
    if (locationPickerResult.field === "from") {
      setOrigin(locationPickerResult.location);
      clearError("origin");
    } else {
      setDestination(locationPickerResult.location);
      clearError("destination");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locationPickerResult]);

  const openLocationPicker = useSearchStore((s) => s.openLocationPicker);
  const triggerLocationPicker = (field: "from" | "to") => {
    openLocationPicker({
      field,
      mode,
      suggested: POPULAR_LOCATIONS[mode],
    });
  };

  // Result vom Root-Level DatePickerHost lesen. sessionKey ändert sich pro
  // Open, sodass wir das Result genau einmal anwenden. Field kommt direkt
  // im Result mit → keine lokale pendingDateField-State nötig.
  const datePickerResult = useSearchStore((s) => s.datePickerResult);
  const lastAppliedSessionRef = useRef<number | null>(null);
  useEffect(() => {
    if (!datePickerResult) return;
    if (datePickerResult.sessionKey === lastAppliedSessionRef.current) return;
    lastAppliedSessionRef.current = datePickerResult.sessionKey;
    const picked = datePickerResult.date;
    if (datePickerResult.field === "depart") {
      setDepartDate(picked);
      clearError("depart");
      if (returnDate && returnDate < picked) setReturnDate(null);
    } else if (datePickerResult.field === "return") {
      setReturnDate(picked);
      clearError("return");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [datePickerResult]);

  const openDatePicker = useSearchStore((s) => s.openDatePicker);
  const triggerDatePicker = (field: "depart" | "return") => {
    openDatePicker({
      field,
      initialDate:
        field === "depart" ? departDate : (returnDate ?? departDate),
      minimumDate: field === "return" && departDate ? departDate : new Date(),
    });
  };

  function handleSubmit() {
    finishAnim();
    // Fehlende/ungültige Felder einsammeln und rot umrandet markieren.
    const missing = new Set<ErrorField>();
    if (!origin) missing.add("origin");
    if (!destination) missing.add("destination");
    if (!departDate) missing.add("depart");
    if (isRoundtrip && !returnDate) missing.add("return");
    if (missing.size > 0 || !origin || !destination || !departDate) {
      // Visuelles Feedback via roter Border auf den fehlenden Feldern reicht —
      // ein zusätzlicher Alert würde den User unnötig unterbrechen.
      setErrors(missing);
      haptic("error");
      return;
    }
    setErrors(new Set());
    haptic("important");
    const departIso = format(departDate, "yyyy-MM-dd");
    const returnIso = isRoundtrip && returnDate ? format(returnDate, "yyyy-MM-dd") : "";
    // Der Picker liefert Datum UND Uhrzeit (DatePickerHost baut
    // `new Date(y, m, d, hour, minute)`). Die Uhrzeit wurde hier bisher
    // weggeworfen — der Server suchte dann ab einer Default-Zeit statt ab dem
    // gewünschten Zeitpunkt. Als UTC-ISO mitgeben; `departDate` bleibt daneben
    // bestehen (Cache-Key, Anzeige).
    const departTimeIso = departDate.toISOString();
    addRecentSearch({
      mode,
      origin: { code: origin.code, label: origin.label },
      destination: { code: destination.code, label: destination.label },
      departDate: departIso,
      returnDate: returnIso || undefined,
      tripType,
      passengers: pax,
      currency,
    });
    closeSearchOverlay();
    const travelClass = extraOpts[extraOpt] ?? "";
    // Navigation HINTER die SlideOutDown-Animation des Overlays (350ms)
    // schieben. Sonst mountet die Results-Screen mit FlatList + Loader +
    // useQuery gleichzeitig während das Overlay nach unten slidet → JS-Last
    // blockt die UI-Thread-Animation → sichtbare Frame-Drops. Mit setTimeout
    // hat die Slide-Animation den Frame frei und der User sieht's smooth.
    setTimeout(() => {
      router.push({
        pathname: "/search/results",
        params: {
          mode,
          origin: origin.code,
          destination: destination.code,
          originLabel: origin.label,
          destLabel: destination.label,
          departDate: departIso,
          departTime: departTimeIso,
          returnDate: returnIso,
          tripType,
          passengers: String(pax),
          currency,
          travelClass,
        },
      });
    }, 280);
  }

  // Uhrzeit mit anzeigen — sie wird im Picker gewählt und wirkt sich echt auf die
  // Suche aus (Zug/Bus: Suchzeitpunkt, Flug/Cruise: Filter). Ohne sichtbare Zeit
  // wirkte der Picker wirkungslos.
  const formatDate = (d: Date) => format(d, "EEE, d MMM · HH:mm", { locale: dateLocale });

  return (
    <View style={styles.container}>
      <View style={[styles.hero, { paddingTop: insets.top, height: 310 + insets.top }]}>
        {/* BinchHero mountet sofort beim Slide-In — Sky + Dünen sind also
            schon da. Animationen (Sun-Rise, Bird-Spawn) sind intern
            deferred bis nach Slide-Ende → konkurriert nicht mit der
            SearchHeroOverlay-SlideInDown-Animation. */}
        <View style={StyleSheet.absoluteFill}>
          <BinchHero
            category={heroCategory}
            time={heroTime}
            melt={C.bg}
            style={heroStyle}
            paused={heroPaused}
          />
        </View>

        {/* Dezentes Overlay nur am Bottom für Titel-Lesbarkeit. BinchHero
            bringt eh schon einen eigenen Bottom-Fade in `melt` (= C.bg).
            Vorher war hier ein 60%-Schwarz mitten im Bild — das hat die
            Sky-Farben der Animation matschig gemacht. */}
        <LinearGradient
          colors={["transparent", "transparent", "rgba(26,26,26,0.45)"]}
          locations={[0, 0.7, 1]}
          style={StyleSheet.absoluteFill}
          pointerEvents="none"
        />

        <View style={[styles.logoWrap, { top: insets.top + 16 }]} pointerEvents="none">
          <Text style={styles.logo}>
            B<Text style={[styles.logoAccent, { color: accent.solid }]}>i</Text>nch
          </Text>
        </View>

        <View style={styles.heroBottom}>
          <View style={styles.titleRow}>
            <Text
              style={styles.heroTitle}
              onLayout={(e) => setTitleWidth(e.nativeEvent.layout.width)}
            >
              {heroTitle}
            </Text>
            <RippleTouch
              onPress={() => {
                haptic("button");
                finishAnim();
                openVoiceOverlay();
              }}
              borderless
              style={styles.micButton}
              accessibilityLabel={t("mode.voice")}
            >
              <Mic color={C.white} size={20} />
            </RippleTouch>
          </View>
          {/* Strich darunter mit exakter Text-Breite (via onLayout des
              Title-Text gemessen). Damit spannt die Linie genau über das
              "Flug suchen" und nicht darüber hinaus. */}
          <View
            style={[
              styles.greenBar,
              { width: titleWidth, backgroundColor: accent.solid },
            ]}
          />
        </View>
      </View>

      <ScrollView
        style={styles.form}
        contentContainerStyle={[styles.formContent, { paddingBottom: insets.bottom + 90 }]}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        {tripTypes.length > 1 ? (
          <SegmentedToggle
            items={tripTypes.map((tt) => ({ id: tt.id, label: t(tt.key) }))}
            selectedId={tripType}
            onChange={(id) => setTripType(id as TripType)}
          />
        ) : null}

        <View style={styles.fromToRow}>
          <RippleTouch
            style={[styles.fieldBox, styles.flex1, errors.has("origin") && styles.fieldBoxError]}
            onPress={() => {
              haptic("button");
              // Picker-Open ZUERST — finishAnim deferred (pausiert Hero
              // Animationen, was einen heavy Re-Render triggert). Sonst
              // konkurriert das mit dem Slide-In.
              triggerLocationPicker("from");
              requestAnimationFrame(finishAnim);
            }}
          >
            <Text style={styles.fieldLabel}>{fromLabel.toUpperCase()}</Text>
            <Text style={styles.fieldInput} numberOfLines={1}>
              {origin ? origin.label : t("search.choose")}
            </Text>
            <Text style={styles.fieldMeta}>{fromPlaceholder}</Text>
          </RippleTouch>

          <RippleTouch onPress={handleSwap} style={styles.swapBtn}>
            <Animated.View style={swapIconStyle}>
              <ArrowLeftRight size={20} color={accent.solid} />
            </Animated.View>
          </RippleTouch>

          <RippleTouch
            style={[styles.fieldBox, styles.flex1, errors.has("destination") && styles.fieldBoxError]}
            onPress={() => {
              haptic("button");
              triggerLocationPicker("to");
              requestAnimationFrame(finishAnim);
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
            style={[styles.fieldBox, styles.flex1, errors.has("depart") && styles.fieldBoxError]}
            onPress={() => {
              haptic("button");
              // Picker ZUERST öffnen — der ist der wichtige Visual-Effekt.
              // finishAnim() pausiert die Hero-Animationen (BinchHero/
              // BinchCreatures) und triggert einen schweren Re-Render des
              // ganzen Hero-Subtrees. Wenn das vor triggerDatePicker läuft,
              // konkurriert es mit dem Slide-In → janky. requestAnimationFrame
              // defert es um genau einen Frame.
              triggerDatePicker("depart");
              requestAnimationFrame(finishAnim);
            }}
          >
            <Text style={styles.fieldLabel}>{t("search.date.depart").toUpperCase()}</Text>
            <Text style={[styles.fieldInput, styles.fieldInputMd]}>
              {departDate ? formatDate(departDate) : t("search.date.placeholder")}
            </Text>
          </RippleTouch>

          {isRoundtrip ? (
            <RippleTouch
              style={[styles.fieldBox, styles.flex1, errors.has("return") && styles.fieldBoxError]}
              onPress={() => {
                haptic("button");
                triggerDatePicker("return");
                requestAnimationFrame(finishAnim);
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
                  finishAnim();
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
                  finishAnim();
                  setPax((p) => Math.min(9, p + 1));
                }}
                borderless
                style={[styles.paxBtn, styles.paxBtnPlus, { backgroundColor: accent.solid }]}
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
                      finishAnim();
                      setExtraOpt(i);
                    }}
                    style={[styles.pill, active && [styles.pillActive, { backgroundColor: accent.subtle, borderColor: accent.solid }]]}
                  >
                    <Text style={[styles.pillText, active && [styles.pillTextActive, { color: accent.solid }]]}>
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
          style={[styles.cta, { backgroundColor: accent.solid }]}
        >
          <Icon size={20} color="rgba(0,0,0,0.6)" style={styles.ctaIcon} />
          <Text style={styles.ctaText}>{t("search.cta.compare")}</Text>
        </RippleTouch>
      </ScrollView>

      {/* LocationPicker liegt am Root-Layout via LocationPickerHost.
          Trigger via openLocationPicker. */}

      {/* BinchDatePicker ist im Root-Layout via DatePickerHost gemountet —
          überdeckt damit auch die Nav-Bar. Trigger via openDatePicker. */}

      {/* preserve unused-tripTypeIds reference for future analytics hooks */}
      {tripTypeIds.length === 0 ? <View /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg },

  hero: { height: 310, justifyContent: "flex-end" },
  // Position + Typo identisch zur Header-Logo in app/(tabs)/index.tsx:
  // left=22, fontWeight=900 (Fett), letterSpacing=-0.6. Top wird via
  // insets.top + 16 inline gesetzt damit die Position auch ohne SafeAreaView
  // korrekt unter der StatusBar sitzt — identisch zur Landingpage
  // (scroll-paddingTop = insets.top + 8, plus Header-paddingTop = 8).
  logoWrap: { position: "absolute", left: 22, zIndex: 2 },
  logo: { fontSize: 26, fontWeight: "900", letterSpacing: -0.6, color: C.white },
  logoAccent: {},
  heroBottom: { paddingHorizontal: 20, paddingBottom: 20 },
  titleRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  // KEIN flex:1 — sonst nimmt der Text immer die volle verfügbare Breite,
  // und onLayout würde die Container-Breite (nicht die Text-Breite)
  // reporten. flexShrink:1 erlaubt Schrumpfen falls der Title doch mal
  // länger als der Platz wird (Safety, eigentlich passen alle vier
  // Mode-Titles in eine Zeile).
  heroTitle: {
    fontSize: 28,
    fontWeight: "800",
    letterSpacing: -0.84,
    color: C.white,
    flexShrink: 1,
  },
  // Width wird inline gesetzt (= gemessene Text-Breite via onLayout).
  greenBar: { marginTop: 8, height: 3, borderRadius: 2 },
  micButton: {
    width: 42,
    height: 42,
    borderRadius: 9999,
    backgroundColor: "rgba(36,36,37,0.75)",
    alignItems: "center",
    justifyContent: "center",
    marginLeft: 8,
  },

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
  toggleBtnActive: {},
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

  fieldBox: {
    backgroundColor: C.surface1,
    borderRadius: 16,
    padding: 14,
    // Default-Border transparent damit der rote Error-State keinen Layout-
    // Shift verursacht (Box behält identische Größe).
    borderWidth: 1,
    borderColor: "transparent",
  },
  fieldBoxError: { borderColor: C.red },
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
  paxBtnPlus: {},
  paxBtnText: { fontSize: 18, color: C.white, lineHeight: 22 },
  paxBtnTextDark: { color: "#000" },
  paxCount: { fontSize: 20, fontWeight: "700", color: C.white },

  pillRow: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 4 },
  pill: { paddingVertical: 5, paddingHorizontal: 10, borderRadius: 9999, backgroundColor: C.surface3 },
  // backgroundColor + borderColor inline mit accent.subtle / accent.solid.
  pillActive: { borderWidth: 1 },
  pillText: { fontSize: 11, fontWeight: "600", color: C.gray2 },
  pillTextActive: {},

  cta: {

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
