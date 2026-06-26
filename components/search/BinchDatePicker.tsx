/**
 * BinchDatePicker — Slide-Up Overlay für Datum + Zeit Auswahl.
 *
 * Always-Mounted Pattern wie LocationPicker (offset/opacity SharedValues):
 *  - Picker ist beim App-Start IMMER im Tree → kein Cold-Start-Lag beim
 *    ersten Open
 *  - Tap → useEffect fires → withTiming auf UI-Thread startet SOFORT
 *  - Content immer fertig gerendert während des Slides
 *
 * Calendar ist via FlatList virtualisiert + Infinite-Scroll:
 *  - Initial nur 3 Monate gemountet (~90 Cells statt 180+)
 *  - Beim Scrollen ans untere Ende werden mehr Monate nachgeladen
 *  - DayCell als React.memo damit Selection-Changes nur 2 Cells re-rendern
 */
import { memo, useCallback, useMemo, useState, type ReactNode } from "react";
import {
  BackHandler,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { FlashList } from "@shopify/flash-list";
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { useEffect } from "react";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { X, Clock } from "lucide-react-native";
import { useAccent } from "@/lib/theme/accent";
import { haptic } from "@/lib/haptics";
import { SlidingPanels } from "@/components/ui/SlidingPanels";

const C = {
  bg: "#1A1A1A",
  surface1: "#1F1F20",
  surface2: "#242425",
  surface3: "#2A2A2C",
  popup: "#222223",
  border: "#2E2E30",
  white: "#FFFFFF",
  gray200: "#C8C8CC",
  gray300: "#8A8A90",
  gray500: "#56565C",
  gray700: "#3A3A3E",
  wheelBg: "#161617",
};

const MONTHS = [
  "Januar", "Februar", "März", "April", "Mai", "Juni",
  "Juli", "August", "September", "Oktober", "November", "Dezember",
];
const WD_MON = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];
const WD_SUN = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"];
const WD_FULL = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"];

const ITEM = 44;
const CHEAP_DAY = 80;
const CHEAP_MONTH = 70;
// Wir bieten — wie die großen Apps — ein rollierendes 12-Monats-Fenster ab dem
// aktuellen Monat an (Juni → bis Ende Mai nächsten Jahres). Alle 12 sofort laden
// (kein Infinite-Scroll) → KEINE setLoadedMonths-Re-Renders mehr während des
// Scrollens (die recreaten months/monthLayouts mitten im Scroll = Ruckler).
const INITIAL_MONTHS = 12;
const LOAD_MORE_MONTHS = 12;
const MAX_MONTHS = 12;

const pad = (n: number) => String(n).padStart(2, "0");

function priceFor(y: number, m: number, d: number): number {
  const seed = Math.abs(((y * 372 + m * 31 + d) * 2654435761) % 100000);
  const dow = new Date(y, m, d).getDay();
  let p = 58 + (seed % 92);
  if (dow === 0 || dow === 5 || dow === 6) p += 16;
  return Math.round(p);
}
function monthFrom(y: number, m: number): number {
  const seed = Math.abs(((y * 372 + m * 31 + 7) * 40503) % 100000);
  return 50 + (seed % 52);
}

type Mode = "specific" | "flexible";
type Sel = { y: number; m: number; d: number } | null;
type MonthBlock = { y: number; m: number; weeks: ({ d: number } | null)[][] };
// Für FlashList flachgeklopft: jede Zeile ist entweder ein Monats-Label ODER
// eine Wochen-Zeile (7 Zellen). So recycelt FlashList winzige Einheiten (7 Zellen
// statt 42) → minimale JS-Render-Arbeit pro Recycle = flüssiges Scrollen.
type CalRow =
  | { kind: "label"; key: string; label: string; first: boolean }
  | { kind: "week"; key: string; y: number; m: number; cells: ({ d: number } | null)[] };

export interface BinchDatePickerProps {
  visible: boolean;
  onClose: () => void;
  minimumDate?: Date;
  initialDate?: Date | null;
  initialMode?: Mode;
  minuteStep?: number;
  startMonday?: boolean;
  onConfirmDate?: (v: { year: number; month: number; day: number; hour: number; minute: number }) => void;
  onConfirmMonth?: (v: { year: number; month: number }) => void;
  fieldLabel?: string;
  title?: string;
}

export function BinchDatePicker({
  visible,
  onClose,
  minimumDate,
  initialDate,
  initialMode = "specific",
  minuteStep = 5,
  startMonday = true,
  onConfirmDate,
  onConfirmMonth,
  fieldLabel = "Abreise",
  title = "Reisedatum",
}: BinchDatePickerProps) {
  const accent = useAccent();
  const { height: screenH } = useWindowDimensions();

  // Slide-Pattern wie LocationPicker — always-mounted, offset/opacity via
  // SharedValue + withTiming. Tap → useEffect → withTiming auf UI-Thread.
  const offset = useSharedValue(screenH);
  const opacity = useSharedValue(0);
  // Pre-warm: einmaliger no-op withTiming am Mount damit Reanimated v4
  // die Worklets JIT-kompiliert BEVOR der User zum ersten Mal tippt.
  // Ohne pre-warm ist der erste richtige Slide messbar stuttery (cold
  // start kann auf Android 50-100ms kosten).
  useEffect(() => {
    offset.value = withTiming(screenH, { duration: 1 });
    opacity.value = withTiming(0, { duration: 1 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    cancelAnimation(offset);
    cancelAnimation(opacity);
    if (visible) {
      offset.value = withTiming(0, { duration: 280, easing: Easing.out(Easing.cubic) });
      // Opacity steuert NUR den Backdrop (siehe backdropStyle). Sync mit
      // offset-Duration damit Backdrop in derselben Zeit ein-/ausfadet wie
      // der Picker rein-/rausslidet.
      opacity.value = withTiming(1, { duration: 280 });
    } else {
      offset.value = withTiming(screenH, { duration: 280, easing: Easing.in(Easing.cubic) });
      opacity.value = withTiming(0, { duration: 280 });
    }
  }, [visible, offset, opacity, screenH]);

  // Picker selbst NUR translateY, KEINE Opacity — sonst fadet er beim
  // Slide-Out (160ms) schneller weg als er translatet (280ms) und der
  // User sieht nur einen Disappear-Effekt statt einem Slide. Mit reinem
  // translateY ist der Picker während der gesamten 280ms voll sichtbar
  // bis er off-screen ist.
  const wrapStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: offset.value }],
  }));

  // Backdrop-Style: opacity fadet von 0 auf 1 wenn Picker visible →
  // darkens SearchHero hinter dem Picker. Verwendet `opacity` SharedValue.
  const backdropStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
  }));

  useEffect(() => {
    if (Platform.OS !== "android" || !visible) return;
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      onClose();
      return true;
    });
    return () => sub.remove();
  }, [visible, onClose]);

  return (
    <>
      {/* Backdrop — abdunkelt den SearchHero hinter dem Picker während
          des Slide-Ins. Liegt zIndex 9998 = unter dem Picker (9999).
          pointerEvents=none, damit der User-Tap auf den Picker-Content
          nicht blockiert wird. */}
      <Animated.View
        pointerEvents="none"
        style={[
          StyleSheet.absoluteFillObject,
          { zIndex: 9998, backgroundColor: "rgba(0,0,0,0.75)" },
          backdropStyle,
        ]}
      />
      <Animated.View
        pointerEvents={visible ? "auto" : "none"}
        style={[
          StyleSheet.absoluteFillObject,
          // KEIN elevation mehr: das Sheet ist Vollbild + opak (deckt alles ab),
          // ein 32dp-Android-Schatten ist unsichtbar (Ränder offscreen), zwingt
          // aber die ganze View samt scrollendem FlashList-Inhalt auf einen
          // Hardware-Layer → jeder Scroll-Frame = Layer-Recomposite + Shadow-Pass
          // = UI-Thread-Last. Stacking macht render-order + zIndex.
          { zIndex: 9999, backgroundColor: C.bg },
          wrapStyle,
        ]}
      >
        <DatePickerContent
        accentSolid={accent.solid}
        accentSubtle={accent.subtle}
        accentBorder={accent.border}
        accentTextOnSolid={accent.textOnSolid}
        onClose={onClose}
        minimumDate={minimumDate}
        initialDate={initialDate}
        initialMode={initialMode}
        minuteStep={minuteStep}
        startMonday={startMonday}
        onConfirmDate={onConfirmDate}
        onConfirmMonth={onConfirmMonth}
        fieldLabel={fieldLabel}
        title={title}
          sessionKey={visible}
        />
      </Animated.View>
    </>
  );
}

interface ContentProps {
  accentSolid: string;
  accentSubtle: string;
  accentBorder: string;
  accentTextOnSolid: string;
  onClose: () => void;
  minimumDate?: Date;
  initialDate?: Date | null;
  initialMode: Mode;
  minuteStep: number;
  startMonday: boolean;
  onConfirmDate?: (v: { year: number; month: number; day: number; hour: number; minute: number }) => void;
  onConfirmMonth?: (v: { year: number; month: number }) => void;
  fieldLabel: string;
  title: string;
  sessionKey: boolean;
}

function DatePickerContent({
  accentSolid,
  accentSubtle,
  accentBorder,
  accentTextOnSolid,
  onClose,
  minimumDate,
  initialDate,
  initialMode,
  minuteStep,
  startMonday,
  onConfirmDate,
  onConfirmMonth,
  fieldLabel,
  title,
  sessionKey,
}: ContentProps) {
  const insets = useSafeAreaInsets();
  const [mode, setMode] = useState<Mode>(initialMode);
  const [sel, setSel] = useState<Sel>(() => {
    if (!initialDate) return null;
    return { y: initialDate.getFullYear(), m: initialDate.getMonth(), d: initialDate.getDate() };
  });
  const [hour, setHour] = useState(initialDate?.getHours() ?? 9);
  const [minute, setMinute] = useState(initialDate?.getMinutes() ?? 30);
  const [timeOpen, setTimeOpen] = useState(false);
  const [selMonthKey, setSelMonthKey] = useState<string | null>(null);
  // Infinite Scroll — startet bei INITIAL_MONTHS, lädt LOAD_MORE_MONTHS
  // bei jedem onEndReached.
  const [loadedMonths, setLoadedMonths] = useState(INITIAL_MONTHS);

  // Beim Open: initialDate sofort übernehmen wenn vorhanden. Wenn der User
  // schon mal eine Date confirmed hat, soll die hier hervorgehoben sein.
  // Das ist nur 1 Cell-Highlight (React.memo greift) → kein Stutter.
  useEffect(() => {
    if (!sessionKey) return;
    if (initialDate) {
      setSel({
        y: initialDate.getFullYear(),
        m: initialDate.getMonth(),
        d: initialDate.getDate(),
      });
      setHour(initialDate.getHours());
      setMinute(initialDate.getMinutes());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionKey]);

  // Beim CLOSE (320ms nach Slide-Out): ALLES auf Defaults zurück. Dadurch
  // wird die unbestätigte sel (= User hat im Kalender getippt aber nicht
  // "Weiter" gedrückt) verworfen. Beim nächsten Open ist State sauber.
  // 320ms = Slide-Out-Duration + Puffer → User sieht den Reset nicht
  // (Picker ist da schon off-screen).
  useEffect(() => {
    if (sessionKey) return;
    const timer = setTimeout(() => {
      setSel(null);
      setHour(9);
      setMinute(30);
      setMode(initialMode);
      setLoadedMonths(INITIAL_MONTHS);
      setSelMonthKey(null);
    }, 320);
    return () => clearTimeout(timer);
  }, [sessionKey, initialMode]);

  const today = useMemo(() => {
    const d = minimumDate ?? new Date();
    return { y: d.getFullYear(), m: d.getMonth(), d: d.getDate() };
  }, [minimumDate]);
  const startYear = today.y;
  const startMonth = today.m;

  const weekdays = startMonday ? WD_MON : WD_SUN;
  const todayVal = today.y * 372 + today.m * 31 + today.d;

  const minuteValues = useMemo(() => {
    const arr: number[] = [];
    for (let m = 0; m < 60; m += minuteStep) arr.push(m);
    return arr;
  }, [minuteStep]);

  const hourValues = useMemo(() => Array.from({ length: 24 }, (_, i) => i), []);

  // Monate werden lazy berechnet — nur die `loadedMonths` ersten kommen
  // tatsächlich in die FlatList. Beim Scrollen kommt mehr dazu.
  const months = useMemo<MonthBlock[]>(() => {
    const blocks: MonthBlock[] = [];
    for (let k = 0; k < loadedMonths; k++) {
      const y = startYear + Math.floor((startMonth + k) / 12);
      const m = (startMonth + k) % 12;
      const firstDow = new Date(y, m, 1).getDay();
      const lead = startMonday ? (firstDow + 6) % 7 : firstDow;
      const dim = new Date(y, m + 1, 0).getDate();
      const cells: ({ d: number } | null)[] = [];
      for (let i = 0; i < lead; i++) cells.push(null);
      for (let d = 1; d <= dim; d++) cells.push({ d });
      while (cells.length % 7 !== 0) cells.push(null);
      const weeks: ({ d: number } | null)[][] = [];
      for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
      blocks.push({ y, m, weeks });
    }
    return blocks;
  }, [startYear, startMonth, loadedMonths, startMonday]);

  // Monate → flache Liste aus Label- + Wochen-Zeilen (FlashList-Items).
  const rows = useMemo<CalRow[]>(() => {
    const out: CalRow[] = [];
    months.forEach((mo, k) => {
      out.push({ kind: "label", key: `L${mo.y}-${mo.m}`, label: MONTHS[mo.m]!, first: k === 0 });
      mo.weeks.forEach((week, wi) => {
        out.push({ kind: "week", key: `W${mo.y}-${mo.m}-${wi}`, y: mo.y, m: mo.m, cells: week });
      });
    });
    return out;
  }, [months]);

  const monthCards = useMemo(() => {
    const cards: { key: string; y: number; m: number; from: number }[] = [];
    for (let k = 0; k < MAX_MONTHS; k++) {
      const y = startYear + Math.floor((startMonth + k) / 12);
      const m = (startMonth + k) % 12;
      cards.push({ key: `${y}-${m}`, y, m, from: monthFrom(y, m) });
    }
    return cards;
  }, [startYear, startMonth]);

  const hasDate = sel != null;
  const hasSelection = mode === "flexible" ? selMonthKey != null : hasDate;
  const selTime = `${pad(hour)}:${pad(minute)}`;
  const selFull = hasDate
    ? `${WD_FULL[new Date(sel!.y, sel!.m, sel!.d).getDay()]}, ${sel!.d}. ${MONTHS[sel!.m]}`
    : "";

  let bottomTitle: string;
  if (mode === "flexible") {
    if (selMonthKey) {
      const [yy, mmn] = selMonthKey.split("-").map(Number);
      bottomTitle = `${MONTHS[mmn]} ${yy}`;
    } else bottomTitle = "Reisemonat wählen";
  } else {
    bottomTitle = hasDate ? `${selFull} · ${selTime} Uhr` : "Abreisedatum wählen";
  }

  const openTime = useCallback(() => {
    if (sel == null) return;
    haptic("button");
    setTimeOpen(true);
  }, [sel]);

  // Stabiler onDayPress damit DayCell-memo greift.
  const onDayPress = useCallback((y: number, m: number, d: number) => {
    haptic("button");
    setSel({ y, m, d });
  }, []);

  const onWeiter = () => {
    haptic("button");
    if (mode === "flexible" && selMonthKey) {
      const [yy, mmn] = selMonthKey.split("-").map(Number);
      onConfirmMonth?.({ year: yy, month: mmn });
    } else if (sel) {
      onConfirmDate?.({ year: sel.y, month: sel.m, day: sel.d, hour, minute });
    }
  };

  // Infinite Scroll Handler — wird bei ~50% des unteren Endes der FlatList
  // gefeuert und lädt mehr Monate nach.
  const onEndReached = useCallback(() => {
    setLoadedMonths((prev) => Math.min(prev + LOAD_MORE_MONTHS, MAX_MONTHS));
  }, []);

  const renderRow = useCallback(
    ({ item }: { item: CalRow }) => {
      if (item.kind === "label") {
        return (
          <Text style={[s.monthLabel, { marginTop: item.first ? 4 : 20, paddingHorizontal: 20 }]}>
            {item.label}
          </Text>
        );
      }
      const { y, m, cells } = item;
      return (
        <View style={[s.dayRow, { paddingHorizontal: 20 }]}>
          {cells.map((cell, ci) => {
            if (!cell) return <View key={ci} style={s.dayCell} />;
            const d = cell.d;
            const isSel = !!sel && sel.y === y && sel.m === m && sel.d === d;
            const isToday = y === today.y && m === today.m && d === today.d;
            const isPast = y * 372 + m * 31 + d < todayVal;
            const price = priceFor(y, m, d);
            return (
              <DayCell
                key={ci}
                y={y}
                m={m}
                d={d}
                price={price}
                isSel={isSel}
                isToday={isToday}
                isPast={isPast}
                cheap={price < CHEAP_DAY}
                accentSolid={accentSolid}
                accentTextOnSolid={accentTextOnSolid}
                onPress={onDayPress}
              />
            );
          })}
        </View>
      );
    },
    [sel, today, todayVal, accentSolid, accentTextOnSolid, onDayPress],
  );

  // getItemType: FlashList recycelt Label- und Wochen-Zeilen getrennt (eigene
  // Recycling-Pools) → optimales Wiederverwenden gleichartiger Views.
  const getItemType = useCallback((item: CalRow) => item.kind, []);

  const keyExtractor = useCallback((item: CalRow) => item.key, []);

  return (
    <View style={s.root}>
      {/* Header — Padding-Top: safe-area + 24 (entspricht pt-6 vom Saved-
          Tab) damit alles unter der Statusbar liegt. Title-Style matched
          den "Saved"-Header (26px, font-black, tracking-tight). */}
      <View style={[s.header, { paddingTop: insets.top + 24 }]}>
        <Pressable style={s.closeBtn} onPress={onClose} hitSlop={8}>
          <X color={C.white} size={18} strokeWidth={2.4} />
        </Pressable>
        <Text style={s.title}>{title}</Text>
      </View>

      {/* Tabs — Design wie SearchHero's toggleRow: borderRadius 14 außen,
          11 innen, padding 4. Active-Indicator gleitet smooth zwischen den
          Tabs via Reanimated SharedValue (kein abrupter Background-Swap). */}
      <ModeTabs
        mode={mode}
        accentSolid={accentSolid}
        accentTextOnSolid={accentTextOnSolid}
        onChange={(m) => {
          haptic("button");
          setMode(m);
        }}
      />

      {/* Pager-Style: beide Sections side-by-side in einem breiten Container
          der als Ganzes translateX'd wird. Kein flackerndes Reposition mehr
          der inneren Elemente während der Animation.

          Die Abreise-Box ist TEIL des Specific-Panels (nicht mehr darüber mit
          display:none) → sie slidet beim Wechsel zu Flexibel sauber mit raus,
          statt abrupt zu verschwinden + einen Layout-Sprung auszulösen. */}
      <SlidingPanels activeIndex={mode === "specific" ? 0 : 1}>
        <View style={{ flex: 1 }}>
          <Pressable style={s.field} onPress={openTime}>
            <View style={{ flex: 1 }}>
              <Text style={s.fieldLabel}>{fieldLabel}</Text>
              {hasDate ? (
                <Text style={s.fieldValue}>{selFull}</Text>
              ) : (
                <Text style={s.fieldPlaceholder}>Datum wählen</Text>
              )}
            </View>
            {hasDate && (
              <View style={[s.timeChip, { backgroundColor: accentSubtle }]}>
                <Clock color={accentSolid} size={13} strokeWidth={2.4} />
                <Text style={[s.timeChipTxt, { color: accentSolid }]}>{selTime}</Text>
              </View>
            )}
          </Pressable>
          <View style={s.weekRow}>
            {weekdays.map((wd) => (
              <Text key={wd} style={s.weekday}>{wd}</Text>
            ))}
          </View>
          {/* FlashList statt FlatList: RECYCELT die Monats-Views beim Scrollen
              (wie native Listen / Skyscanner) statt sie zu mounten/unmounten →
              kein Mount-Churn = butterweiches Scrollen. v2 misst selbst, daher
              kein getItemLayout/estimatedItemSize. Muss in einem Container mit
              definierter Höhe sitzen → flex:1-Wrapper. */}
          <View style={{ flex: 1 }}>
            <FlashList
              data={rows}
              keyExtractor={keyExtractor}
              renderItem={renderRow}
              getItemType={getItemType}
              // Begrenzt den gemounteten Puffer (FlashList-v2-Analogon zu
              // windowSize) → weniger Wochen-Zeilen gleichzeitig im nativen Tree.
              drawDistance={200}
              // FlashList memoisiert Items intern — ohne extraData würde die
              // Auswahl-Markierung beim Tippen eines Tags NICHT aktualisieren.
              extraData={sel}
              // friert das Panel ein sobald auf Flexibel gewechselt wird.
              scrollEnabled={mode === "specific"}
              onEndReached={onEndReached}
              onEndReachedThreshold={0.5}
              contentContainerStyle={{ paddingBottom: 120 }}
              showsVerticalScrollIndicator={false}
            />
          </View>
        </View>

        <View style={{ flex: 1 }}>
          <View style={s.flexHead}>
            <Text style={s.flexTitle}>Monat</Text>
            <Text style={[s.flexLink, { color: accentSolid }]}>Jederzeit suchen</Text>
          </View>
          <ScrollView
            style={{ flex: 1 }}
            contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 120 }}
            showsVerticalScrollIndicator={false}
            // Nur aktiv im Flexibel-Mode — friert das offscreen-Panel ein.
            scrollEnabled={mode === "flexible"}
          >
            <View style={s.cardGrid}>
              {monthCards.map((mc) => {
                const isSel = selMonthKey === mc.key;
                const cheap = mc.from < CHEAP_MONTH;
                return (
                  <Pressable
                    key={mc.key}
                    style={[
                      s.monthCard,
                      isSel && { backgroundColor: accentSubtle, borderWidth: 1, borderColor: accentBorder },
                    ]}
                    onPress={() => {
                      haptic("button");
                      setSelMonthKey(mc.key);
                    }}
                  >
                    <Text style={s.cardName}>{MONTHS[mc.m]}</Text>
                    <Text style={[s.cardPrice, cheap && { color: accentSolid }]}>
                      ab {mc.from} €
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </ScrollView>
        </View>
      </SlidingPanels>

      {/* Bottom Bar */}
      <View style={s.bottomBar}>
        <View style={{ flex: 1 }}>
          <Text style={s.bottomTitle} numberOfLines={1}>{bottomTitle}</Text>
          <View style={s.estRow}>
            <Text style={s.estTxt}>Geschätzte Preise</Text>
            <View style={s.infoDot}><Text style={s.infoTxt}>i</Text></View>
          </View>
        </View>
        {hasSelection && (
          <Pressable
            style={[s.weiter, { backgroundColor: accentSolid }]}
            onPress={onWeiter}
          >
            <Text style={[s.weiterTxt, { color: accentTextOnSolid }]}>Weiter</Text>
          </Pressable>
        )}
      </View>

      {/* Time Popup */}
      <Modal visible={timeOpen} transparent animationType="fade" onRequestClose={() => setTimeOpen(false)}>
        <Pressable style={s.backdrop} onPress={() => setTimeOpen(false)} />
        <View style={s.popupWrap} pointerEvents="box-none">
          <View style={s.popup}>
            <View style={s.grabber} />
            <Text style={s.popupLabel}>ABFAHRTSZEIT</Text>
            <View style={s.bigTimeRow}>
              <Text style={[s.bigTime, { color: accentSolid }]}>{selTime}</Text>
              <Text style={s.bigTimeUnit}>Uhr</Text>
            </View>

            <View style={s.wheelBox}>
              <View
                pointerEvents="none"
                style={[
                  s.wheelBand,
                  { backgroundColor: accentSubtle, borderColor: accentBorder },
                ]}
              />
              <View style={s.wheelRow}>
                <Wheel data={hourValues} value={hour} onChange={setHour} />
                <Text style={[s.wheelColon, { color: accentSolid }]}>:</Text>
                <Wheel data={minuteValues} value={minute} onChange={setMinute} />
              </View>
            </View>
            <View style={s.wheelLabels}>
              <Text style={s.wheelLabel}>Stunde</Text>
              <Text style={s.wheelLabel}>Minute</Text>
            </View>

            <View style={s.popupBtns}>
              <Pressable
                style={[s.popupBtn, s.popupBtnGhost]}
                onPress={() => setTimeOpen(false)}
              >
                <Text style={s.popupBtnGhostTxt}>Abbrechen</Text>
              </Pressable>
              <Pressable
                style={[s.popupBtn, s.popupBtnPrimary, { backgroundColor: accentSolid }]}
                onPress={() => setTimeOpen(false)}
              >
                <Text style={[s.popupBtnPrimaryTxt, { color: accentTextOnSolid }]}>
                  Bestätigen
                </Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

// ----------------------------------------------------------------------
// ModeTabs — Tabs mit slidendem Active-Indicator (SearchHero-Design).
// Box-Style: 14/11px borderRadius, padding 4. Indicator translateX
// animated via withTiming für smooth aber snappy Wechsel.
// ----------------------------------------------------------------------
interface ModeTabsProps {
  mode: Mode;
  accentSolid: string;
  accentTextOnSolid: string;
  onChange: (m: Mode) => void;
}

const ModeTabs = memo(function ModeTabs({
  mode,
  accentSolid,
  accentTextOnSolid,
  onChange,
}: ModeTabsProps) {
  const [trackWidth, setTrackWidth] = useState(0);
  // Indicator-Breite = halbe Track-Breite minus die 4px Padding auf jeder Seite
  const indicatorWidth = Math.max(0, (trackWidth - 8) / 2);
  // 0 = "specific" (links), 1 = "flexible" (rechts)
  const progress = useSharedValue(mode === "specific" ? 0 : 1);
  useEffect(() => {
    progress.value = withTiming(mode === "specific" ? 0 : 1, {
      duration: 240,
      easing: Easing.out(Easing.cubic),
    });
  }, [mode, progress]);

  const indicatorStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: progress.value * indicatorWidth }],
    width: indicatorWidth,
  }));

  return (
    <View
      style={s.tabs}
      onLayout={(e) => setTrackWidth(e.nativeEvent.layout.width)}
    >
      <Animated.View
        style={[
          s.tabIndicator,
          { backgroundColor: accentSolid },
          indicatorStyle,
        ]}
      />
      <Pressable style={s.tab} onPress={() => onChange("specific")}>
        <Text
          style={[
            s.tabTxt,
            mode === "specific" && { color: accentTextOnSolid },
          ]}
        >
          Feste Daten
        </Text>
      </Pressable>
      <Pressable style={s.tab} onPress={() => onChange("flexible")}>
        <Text
          style={[
            s.tabTxt,
            mode === "flexible" && { color: accentTextOnSolid },
          ]}
        >
          Flexibel
        </Text>
      </Pressable>
    </View>
  );
});

interface DayCellProps {
  y: number;
  m: number;
  d: number;
  price: number;
  isSel: boolean;
  isToday: boolean;
  isPast: boolean;
  cheap: boolean;
  accentSolid: string;
  accentTextOnSolid: string;
  onPress: (y: number, m: number, d: number) => void;
}

const DayCell = memo(function DayCell({
  y,
  m,
  d,
  price,
  isSel,
  isToday,
  isPast,
  cheap,
  accentSolid,
  accentTextOnSolid,
  onPress,
}: DayCellProps) {
  const handlePress = useCallback(
    () => onPress(y, m, d),
    [onPress, y, m, d],
  );
  return (
    <Pressable
      style={[
        s.dayCell,
        isSel && { backgroundColor: accentSolid },
        !isSel && isToday && { borderWidth: 1.5, borderColor: accentSolid },
      ]}
      disabled={isPast}
      onPress={handlePress}
    >
      {/* Tag + Preis in EINEM Text-Node (verschachtelt) statt zwei separaten
          Text-Views → eine native View weniger pro Zelle. Bei ~56 Zellen spart
          das ~56 Views/Frame auf dem UI-Thread. */}
      <Text
        style={[
          s.dayNum,
          { textAlign: "center" },
          isSel
            ? { color: accentTextOnSolid, fontWeight: "800" }
            : isPast
            ? s.dayNumPast
            : s.dayNumNormal,
        ]}
      >
        {d}
        {!isPast && (
          <Text
            style={[
              s.dayPrice,
              isSel
                ? { color: "rgba(0,0,0,0.62)" }
                : cheap
                ? { color: accentSolid }
                : s.dayPriceNormal,
            ]}
          >
            {"\n"}
            {price} €
          </Text>
        )}
      </Text>
    </Pressable>
  );
});

function Wheel({
  data,
  value,
  onChange,
}: {
  data: number[];
  value: number;
  onChange: (v: number) => void;
}) {
  const idx = Math.max(0, data.indexOf(value));
  return (
    <ScrollView
      style={s.wheel}
      showsVerticalScrollIndicator={false}
      snapToInterval={ITEM}
      decelerationRate="fast"
      contentContainerStyle={{ paddingVertical: 70 }}
      contentOffset={{ x: 0, y: idx * ITEM }}
      onMomentumScrollEnd={(e) => {
        const i = Math.round(e.nativeEvent.contentOffset.y / ITEM);
        const v = data[Math.max(0, Math.min(data.length - 1, i))];
        if (v !== value) onChange(v);
      }}
    >
      {data.map((v) => (
        <View key={v} style={s.wheelItem}>
          <Text style={[s.wheelTxt, v === value ? s.wheelTxtActive : s.wheelTxtIdle]}>
            {pad(v)}
          </Text>
        </View>
      ))}
    </ScrollView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },

  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    paddingHorizontal: 16,
    paddingBottom: 14,
  },
  closeBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: C.surface2,
    alignItems: "center",
    justifyContent: "center",
  },
  // Matched die "Saved"-Überschrift aus app/(tabs)/saved.tsx:
  //   text-[26px] font-black text-white tracking-tight
  title: { fontSize: 26, fontWeight: "900", color: C.white, letterSpacing: -0.6 },

  // Tabs — matched SearchHero's toggleRow: 14px außen, 11px innen, padding 4
  tabs: {
    marginHorizontal: 16,
    marginBottom: 14,
    flexDirection: "row",
    backgroundColor: C.surface2,
    borderRadius: 14,
    padding: 4,
    position: "relative",
  },
  // Slidender Active-Indicator. Absolute positioniert, top/bottom 4 = padding
  // des Containers; left 4; translateX wird in der Animated.View gesetzt.
  tabIndicator: {
    position: "absolute",
    top: 4,
    bottom: 4,
    left: 4,
    borderRadius: 11,
  },
  tab: { flex: 1, paddingVertical: 9, borderRadius: 11, alignItems: "center" },
  tabTxt: { fontSize: 13, fontWeight: "700", color: C.gray300 },

  field: {
    marginHorizontal: 20,
    marginBottom: 16,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 13,
    paddingLeft: 18,
    paddingRight: 16,
    backgroundColor: C.surface1,
    borderRadius: 18,
  },
  fieldLabel: { fontSize: 11, color: C.gray300, fontWeight: "600", letterSpacing: 0.4 },
  fieldValue: { fontSize: 17, color: C.white, fontWeight: "700", marginTop: 1, letterSpacing: -0.2 },
  fieldPlaceholder: { fontSize: 17, color: C.gray500, fontWeight: "600", marginTop: 1, letterSpacing: -0.2 },
  timeChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    height: 38,
    paddingHorizontal: 14,
    borderRadius: 9999,
  },
  timeChipTxt: { fontSize: 15, fontWeight: "800" },

  body: { flex: 1 },
  weekRow: {
    flexDirection: "row",
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderTopWidth: 1,
    borderTopColor: C.surface2,
  },
  weekday: { flex: 1, textAlign: "center", fontSize: 12, fontWeight: "600", color: C.gray500 },

  monthLabel: { fontSize: 24, lineHeight: 30, includeFontPadding: false, fontWeight: "800", color: C.white, letterSpacing: -0.4, marginBottom: 8 },
  dayRow: { flexDirection: "row", marginBottom: 3 },
  dayCell: {
    flex: 1,
    minHeight: 52,
    marginHorizontal: 1.5,
    borderRadius: 13,
    alignItems: "center",
    justifyContent: "center",
  },
  dayNum: { fontSize: 15, fontWeight: "600" },
  dayNumNormal: { color: C.white },
  dayNumPast: { color: C.gray700 },
  dayPrice: { fontSize: 10.5, fontWeight: "600", marginTop: 1 },
  dayPriceNormal: { color: C.gray300 },

  flexHead: {
    flexDirection: "row",
    alignItems: "baseline",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingTop: 8,
    paddingBottom: 12,
  },
  flexTitle: { fontSize: 22, fontWeight: "800", color: C.white, letterSpacing: -0.4 },
  flexLink: { fontSize: 14, fontWeight: "700", textDecorationLine: "underline" },
  cardGrid: { flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between" },
  monthCard: {
    width: "48%",
    minHeight: 112,
    marginBottom: 12,
    paddingVertical: 18,
    paddingHorizontal: 12,
    borderRadius: 22,
    backgroundColor: C.surface2,
    alignItems: "center",
    justifyContent: "center",
  },
  cardName: { fontSize: 19, color: C.white, fontWeight: "700", letterSpacing: -0.2 },
  cardPrice: { fontSize: 13, fontWeight: "600", color: C.gray300, marginTop: 5 },

  bottomBar: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    paddingHorizontal: 20,
    paddingTop: 14,
    paddingBottom: 28,
    backgroundColor: C.bg,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  bottomTitle: { fontSize: 13, color: C.white, fontWeight: "700" },
  estRow: { flexDirection: "row", alignItems: "center", gap: 5, marginTop: 3 },
  estTxt: { fontSize: 12, color: C.gray300, fontWeight: "600", textDecorationLine: "underline" },
  infoDot: {
    width: 15,
    height: 15,
    borderRadius: 8,
    backgroundColor: C.surface3,
    alignItems: "center",
    justifyContent: "center",
  },
  infoTxt: { fontSize: 10, color: C.gray300, fontWeight: "700" },
  weiter: { paddingVertical: 15, paddingHorizontal: 30, borderRadius: 9999 },
  weiterTxt: { fontSize: 15, fontWeight: "700" },

  // Popup
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: "rgba(8,8,9,0.72)" },
  popupWrap: { ...StyleSheet.absoluteFillObject, alignItems: "center", justifyContent: "center", padding: 22 },
  popup: {
    width: "100%",
    maxWidth: 320,
    backgroundColor: C.popup,
    borderRadius: 34,
    paddingHorizontal: 22,
    paddingVertical: 22,
  },
  grabber: {
    width: 38,
    height: 5,
    borderRadius: 9999,
    backgroundColor: "#3C3C42",
    alignSelf: "center",
    marginBottom: 16,
    marginTop: 2,
  },
  popupLabel: { fontSize: 11, color: C.gray300, letterSpacing: 1.3, fontWeight: "700", textAlign: "center" },
  bigTimeRow: { flexDirection: "row", alignItems: "baseline", justifyContent: "center", gap: 8, marginTop: 6 },
  bigTime: { fontSize: 46, fontWeight: "800", letterSpacing: -1.4 },
  bigTimeUnit: { fontSize: 16, fontWeight: "600", color: C.gray300 },

  wheelBox: { position: "relative", marginTop: 20, backgroundColor: C.wheelBg, borderRadius: 24, overflow: "hidden" },
  wheelBand: {
    position: "absolute",
    left: 14,
    right: 14,
    top: "50%",
    marginTop: -23,
    height: 46,
    borderWidth: 1,
    borderRadius: 15,
  },
  wheelRow: { flexDirection: "row", height: 184, alignItems: "stretch" },
  wheel: { flex: 1, height: 184 },
  wheelItem: { height: ITEM, alignItems: "center", justifyContent: "center" },
  wheelTxt: { fontVariant: ["tabular-nums"] },
  wheelTxtActive: { fontSize: 24, fontWeight: "800", color: C.white },
  wheelTxtIdle: { fontSize: 19, fontWeight: "600", color: C.gray500 },
  wheelColon: { width: 16, textAlign: "center", fontSize: 22, fontWeight: "800", alignSelf: "center" },
  wheelLabels: { flexDirection: "row", justifyContent: "space-around", marginTop: 8 },
  wheelLabel: { fontSize: 10, color: C.gray500, letterSpacing: 1, fontWeight: "600" },

  popupBtns: { flexDirection: "row", gap: 10, marginTop: 18 },
  popupBtn: { paddingVertical: 15, borderRadius: 9999, alignItems: "center" },
  popupBtnGhost: { flex: 1, backgroundColor: C.surface3 },
  popupBtnGhostTxt: { color: C.gray200, fontSize: 15, fontWeight: "600" },
  popupBtnPrimary: { flex: 1.4 },
  popupBtnPrimaryTxt: { fontSize: 15, fontWeight: "700" },
});
