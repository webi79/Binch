/**
 * Bausteine der Einstellungs-Seiten: Reisen, Darstellung, Sprache & Währung,
 * Mitteilungen und Bo.
 *
 * Jede Seite beginnt mit einer VORSCHAU-KARTE. Links steht ein Mini-Handy, das
 * zeigt, was die Einstellung bewirkt; rechts stehen Titel, Erklärung und die
 * Bedienung. Das Handy ist keine Attrappe: Es liest dieselben Werte wie die App
 * (Grund, Akzent, Sprache, Währung, Lage der Bestätigung) und ändert sich im
 * selben Moment wie die Auswahl. Das Muster stammt von der Mitteilungs-Seite,
 * die der Nutzer so abgenommen hat.
 *
 * Die Auswahl ist bewusst NEUTRAL: eine hellere Fläche mit weißer Schrift, kein
 * Akzent. Grün tragen nur die Schalter und die Stellen, die auch in der App
 * grün sind. Es gibt keine Verläufe.
 *
 * Die Umschalter gleiten wie überall in der App (`SegmentedToggle`). Design und
 * Akzent bauen beim Umschalten die ganze App neu auf; deren Commit schriebe die
 * Lage der Pille mitten in der Fahrt zu spät zurück. Dort wird die Wahl deshalb
 * erst gemeldet, wenn die Pille angekommen ist (`commitAfterSlide`). Das
 * Tasten-Raster für Sprache und Währung springt, es hat keine Pille.
 *
 * Im Handy stehen keine Beträge. Eine Zahl neben „Köln → Berlin" läse sich wie
 * ein echter Preis, und den gibt es nicht. Deshalb zeigt die Währungs-Vorschau
 * Platzhalter und nur die Währung selbst.
 */
import { ReactNode, useEffect, useState } from "react";
import { View, Text, Pressable, TextInput } from "react-native";
import { useQuery } from "@tanstack/react-query";
import Animated, { Easing, useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import {
  Bell,
  Bookmark,
  Brain,
  Bus,
  Bike,
  Briefcase,
  Check,
  ChevronRight,
  Clock,
  House,
  Map as MapIcon,
  Minus,
  Plane,
  Plus,
  Search,
  Ship,
  Train,
  User,
  X,
  type LucideIcon,
} from "lucide-react-native";
import { useSearchStore } from "@/stores/searchStore";
import { usePalette } from "@/lib/theme/appBg";
import { useAccent } from "@/lib/theme/accent";
import { useT } from "@/lib/i18n/useT";
import { haptic } from "@/lib/haptics";
import { usePressBounce } from "@/lib/motion";
import { ms, scaledStyles } from "@/lib/ui/compact";
import { GUTTER, SPACE, SECTION_GAP, TITLE_GAP } from "@/lib/theme/spacing";
import { BinchSwitch } from "@/components/ui/BinchSwitch";
import { RippleTouch } from "@/components/ui/RippleTouch";
import { SegmentedToggle } from "@/components/ui/SegmentedToggle";
import { fetchLocations } from "@/lib/api/client";
import { RAIL_CARD_LABEL } from "@/lib/travel/fareProfile";
import type { Location } from "@/types/search";
import { GridLoader } from "@/components/ui/GridLoader";
import { LoadGate } from "@/components/ui/LoadGate";

const WHITE = "#F4F4F5";
const G2 = "#8E8E93";
const G3 = "#56565C";
const RED = "#FF453A";
/**
 * Eine Stufe über `s3`: die gewählte Fläche einer Auswahl, Platzhalter auf
 * Karten. Die Palette endet bei `s3`. Eine Auswahl liegt aber AUF einer Spur
 * in `s3` und braucht deshalb einen Ton darüber.
 */
const RAISED = "#2C2C2F";

const PHONE_W = 128;
const PHONE_H = 212;
/** Abstand der Bestätigung zum oberen bzw. unteren Rand des Mini-Handys. */
const TOAST_EDGE = 12;
const TOAST_H = 40;
/** Weg der Bestätigung von oben nach unten. Die 2 sind der Rahmen des Handys. */
const TOAST_TRAVEL = ms(PHONE_H) - 2 - 2 * ms(TOAST_EDGE) - ms(TOAST_H);

/* ─────────────────────── Karte, Überschrift, Fußnote ─────────────────────── */

/** Vorschau-Karte: Handy links, rechts Titel und Erklärung oben, Bedienung unten. */
export function PreviewCard({
  phone,
  title,
  desc,
  children,
}: {
  phone: ReactNode;
  title: string;
  desc: string;
  children: ReactNode;
}) {
  const palette = usePalette();
  return (
    <View style={[styles.card, { backgroundColor: palette.s2 }]}>
      {phone}
      <View style={styles.cardBody}>
        <View>
          <Text style={styles.cardTitle}>{title}</Text>
          <Text style={styles.cardDesc}>{desc}</Text>
        </View>
        <View style={styles.cardControls}>{children}</View>
      </View>
    </View>
  );
}

/** Kleine Überschrift über einer Bedienung innerhalb der Karte („Akzentfarbe"). */
export function ControlLabel({ text }: { text: string }) {
  return <Text style={styles.controlLabel}>{text}</Text>;
}

/** Abschnitts-Überschrift zwischen den Karten. Normale Schreibung, keine Akzent-Marke. */
export function SectionTitle({ text }: { text: string }) {
  return <Text style={styles.sectionTitle}>{text}</Text>;
}

export function Footnote({ text }: { text: string }) {
  return <Text style={styles.footnote}>{text}</Text>;
}

/** Fläche für Zeilen: Schalter, Bos Einträge. */
export function ListCard({ children }: { children: ReactNode }) {
  const palette = usePalette();
  return <View style={[styles.list, { backgroundColor: palette.s2 }]}>{children}</View>;
}

/**
 * Zeile mit Symbol, Titel, Erklärung und Schalter. Das Symbol steht frei, ohne Kachel.
 *
 * `disabled`: Der Schalter hängt an einem anderen, der gerade aus ist
 * („Preisalarme" unter „Benachrichtigungen"). Er bleibt sichtbar mit seinem
 * Wert, aber gedämpft und ohne Wirkung — wie in den Systemeinstellungen.
 */
export function SwitchRow({
  Icon,
  label,
  desc,
  value,
  onChange,
  isLast,
  disabled,
}: {
  Icon: LucideIcon;
  label: string;
  desc?: string;
  value: boolean;
  onChange: (v: boolean) => void;
  isLast?: boolean;
  disabled?: boolean;
}) {
  const palette = usePalette();
  return (
    <View style={styles.switchRow} accessibilityState={{ disabled: !!disabled }}>
      <View style={disabled && styles.dimmed}>
        <Icon size={18} color="#C8C8CC" strokeWidth={1.9} />
      </View>
      <View style={[styles.switchRowBody, !isLast && { borderBottomWidth: 1, borderBottomColor: palette.border }]}>
        <View style={[styles.switchRowText, disabled && styles.dimmed]}>
          <Text style={styles.switchRowLabel}>{label}</Text>
          {desc ? <Text style={styles.switchRowDesc}>{desc}</Text> : null}
        </View>
        <View style={disabled && styles.dimmed}>
          <BinchSwitch value={value} onValueChange={onChange} readOnly={disabled} accessibilityLabel={label} />
        </View>
      </View>
    </View>
  );
}

/**
 * Zeile, die etwas AUSLÖST (Test-Mitteilung) — Maße wie `SwitchRow`. Rechts der
 * Stand in Worten („In 10 s", „Angekommen") statt eines Knopfs im Knopf.
 */
export function ActionRow({
  Icon,
  label,
  desc,
  status,
  onPress,
  isLast,
  disabled,
}: {
  Icon: LucideIcon;
  label: string;
  desc?: string;
  status?: string;
  onPress: () => void;
  isLast?: boolean;
  disabled?: boolean;
}) {
  const palette = usePalette();
  return (
    <RippleTouch
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityState={{ disabled: !!disabled }}
      accessibilityLabel={status ? `${label}, ${status}` : label}
      style={styles.switchRow}
    >
      <View style={disabled && styles.dimmed}>
        <Icon size={18} color="#C8C8CC" strokeWidth={1.9} />
      </View>
      <View style={[styles.switchRowBody, !isLast && { borderBottomWidth: 1, borderBottomColor: palette.border }]}>
        <View style={[styles.switchRowText, disabled && styles.dimmed]}>
          <Text style={styles.switchRowLabel}>{label}</Text>
          {desc ? <Text style={styles.switchRowDesc}>{desc}</Text> : null}
        </View>
        {status ? (
          <Text style={styles.rowAction}>{status}</Text>
        ) : (
          <ChevronRight size={16} color={G3} strokeWidth={2} style={disabled ? styles.dimmed : undefined} />
        )}
      </View>
    </RippleTouch>
  );
}

/**
 * Hinweis-Zeile mit Weg dorthin, wo es sich ändern lässt („Mitteilungen sind am
 * Handy aus → Einstellungen öffnen"). Neutral, nicht rot: Es ist kein Fehler,
 * sondern eine Entscheidung des Nutzers, die wir nur sichtbar machen.
 */
export function NoticeRow({
  Icon,
  title,
  action,
  onPress,
}: {
  Icon: LucideIcon;
  title: string;
  action: string;
  onPress: () => void;
}) {
  const palette = usePalette();
  return (
    <RippleTouch
      onPress={onPress}
      accessibilityRole="button"
      style={({ pressed }) => [styles.notice, { backgroundColor: pressed ? palette.s3 : palette.s2 }]}
    >
      <Icon size={18} color="#C8C8CC" strokeWidth={1.9} />
      <View style={styles.switchRowText}>
        <Text style={styles.noticeTitle}>{title}</Text>
        <Text style={styles.noticeAction}>{action}</Text>
      </View>
      <ChevronRight size={16} color={G3} strokeWidth={2} />
    </RippleTouch>
  );
}

/** Schalter mit Beschriftung, für die Bedienung rechts in einer Vorschau-Karte. */
export function SwitchLine({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <View style={styles.switchLine}>
      <Text style={styles.switchLineLabel} numberOfLines={2}>
        {label}
      </Text>
      <BinchSwitch value={value} onValueChange={onChange} accessibilityLabel={label} />
    </View>
  );
}

/** Zerstörende Aktion: dieselbe rot getönte Fläche wie „Abmelden" im Profil, mit derselben Federung. */
export function DangerButton({ label, Icon, onPress }: { label: string; Icon: LucideIcon; onPress: () => void }) {
  const bounce = usePressBounce();
  return (
    <Animated.View
      style={bounce.style}
      onTouchStart={bounce.onPressIn}
      onTouchEnd={bounce.onPressOut}
      onTouchCancel={bounce.onPressOut}
    >
      <RippleTouch
        onPress={onPress}
        accessibilityRole="button"
        style={({ pressed }) => [styles.danger, pressed && { opacity: 0.7 }]}
      >
        <Icon size={18} color={RED} strokeWidth={2} />
        <Text style={styles.dangerText}>{label}</Text>
      </RippleTouch>
    </Animated.View>
  );
}

/** Fläche mit Innenabstand für eine Bedienung über die ganze Breite (Kartenwahl, Erinnerung). */
export function Panel({ children, title, desc, disabled }: { children: ReactNode; title?: string; desc?: string; disabled?: boolean }) {
  const palette = usePalette();
  return (
    <View style={[styles.panel, { backgroundColor: palette.s2 }]}>
      {title ? <Text style={[styles.switchRowLabel, disabled && styles.dimmed]}>{title}</Text> : null}
      {desc ? <Text style={[styles.switchRowDesc, styles.panelDesc, disabled && styles.dimmed]}>{desc}</Text> : null}
      <View style={disabled && styles.dimmed} pointerEvents={disabled ? "none" : "auto"}>
        {children}
      </View>
    </View>
  );
}

/** Zeile mit Zähler (− n +), etwa für die Zahl der Reisenden. */
export function StepperRow({
  Icon,
  label,
  desc,
  value,
  min,
  max,
  onChange,
  lessLabel,
  moreLabel,
}: {
  Icon: LucideIcon;
  label: string;
  desc?: string;
  value: number;
  min: number;
  max: number;
  onChange: (n: number) => void;
  lessLabel: string;
  moreLabel: string;
}) {
  const palette = usePalette();
  const step = (d: number) => {
    const next = Math.min(max, Math.max(min, value + d));
    if (next === value) return;
    haptic("tick");
    onChange(next);
  };
  const btn = (d: number, I: LucideIcon, a11y: string) => {
    const off = d < 0 ? value <= min : value >= max;
    return (
      <RippleTouch
        onPress={() => step(d)}
        disabled={off}
        borderless
        accessibilityRole="button"
        accessibilityLabel={a11y}
        style={[styles.stepBtn, { backgroundColor: palette.s3 }, off && styles.dimmed]}
      >
        <I size={16} color={WHITE} strokeWidth={2.4} />
      </RippleTouch>
    );
  };
  return (
    <View style={styles.switchRow}>
      <Icon size={18} color="#C8C8CC" strokeWidth={1.9} />
      <View style={styles.switchRowBody}>
        <View style={styles.switchRowText}>
          <Text style={styles.switchRowLabel}>{label}</Text>
          {desc ? <Text style={styles.switchRowDesc}>{desc}</Text> : null}
        </View>
        <View style={styles.stepper} accessibilityRole="adjustable" accessibilityValue={{ now: value, min, max }}>
          {btn(-1, Minus, lessLabel)}
          <Text style={styles.stepValue}>{value}</Text>
          {btn(1, Plus, moreLabel)}
        </View>
      </View>
    </View>
  );
}

/**
 * „Zuhause" oder „Arbeit" festlegen — mit eigener kleiner Ortssuche statt des Ortswählers.
 *
 * Der Ortswähler hängt im Wurzel-Layout UNTER der Einstellungs-Slide und ist
 * mit seinen Fahrten auf das Such-Blatt abgestimmt; ihn darüber zu legen, hätte
 * beides verbogen. Gesucht wird über dieselbe Schnittstelle (`/api/locations`).
 */
export function PlaceField({
  which,
  emptyLabel,
  hint,
  placeholder,
  changeLabel,
  removeLabel,
  cancelLabel,
}: {
  /** Zuhause oder Arbeit — dieselbe Bedienung, ein anderes Feld im Speicher. */
  which: "home" | "work";
  emptyLabel: string;
  hint: string;
  placeholder: string;
  changeLabel: string;
  removeLabel: string;
  cancelLabel: string;
}) {
  const palette = usePalette();
  const home = useSearchStore((s) => (which === "home" ? s.homeStation : s.workStation));
  const setHome = useSearchStore((s) => (which === "home" ? s.setHomeStation : s.setWorkStation));
  const PlaceIcon = which === "home" ? House : Briefcase;
  const [editing, setEditing] = useState(false);
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  useEffect(() => {
    const h = setTimeout(() => setDebounced(query.trim()), 250);
    return () => clearTimeout(h);
  }, [query]);
  const results = useQuery({
    queryKey: ["locations", "ALL", debounced],
    queryFn: () => fetchLocations(debounced, "ALL"),
    enabled: editing && debounced.length >= 2,
    staleTime: 5 * 60 * 1000,
  });

  const pick = (loc: Location) => {
    haptic("button");
    setHome(loc);
    setEditing(false);
    setQuery("");
  };

  if (!editing) {
    return (
      <ListCard>
        <RippleTouch
          onPress={() => {
            haptic("button");
            setEditing(true);
          }}
          accessibilityRole="button"
          style={({ pressed }) => [styles.switchRow, pressed && { backgroundColor: palette.s3 }]}
        >
          <PlaceIcon size={18} color="#C8C8CC" strokeWidth={1.9} />
          <View style={styles.switchRowBody}>
            <View style={styles.switchRowText}>
              <Text style={styles.switchRowLabel} numberOfLines={1}>
                {home ? home.label : emptyLabel}
              </Text>
              <Text style={styles.switchRowDesc} numberOfLines={1}>
                {home ? [home.city, home.country].filter(Boolean).join(", ") || hint : hint}
              </Text>
            </View>
            <Text style={styles.rowAction}>{home ? changeLabel : ""}</Text>
            {home ? null : <ChevronRight size={16} color={G3} strokeWidth={2} />}
          </View>
        </RippleTouch>
        {home ? (
          <RippleTouch
            onPress={() => {
              haptic("button");
              setHome(null);
            }}
            accessibilityRole="button"
            style={({ pressed }) => [styles.removeRow, { borderTopColor: palette.border }, pressed && { backgroundColor: palette.s3 }]}
          >
            <Text style={styles.removeText}>{removeLabel}</Text>
          </RippleTouch>
        ) : null}
      </ListCard>
    );
  }

  const list = results.data ?? [];
  return (
    <ListCard>
      <View style={[styles.searchRow, { borderBottomColor: palette.border }]}>
        <Search size={16} color={G2} strokeWidth={2.2} />
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder={placeholder}
          placeholderTextColor={G3}
          autoFocus
          autoCorrect={false}
          returnKeyType="search"
          style={styles.searchInput}
        />
        <RippleTouch
          onPress={() => {
            setEditing(false);
            setQuery("");
          }}
          borderless
          accessibilityRole="button"
          accessibilityLabel={cancelLabel}
          style={styles.searchClose}
        >
          <X size={18} color={G2} strokeWidth={2.2} />
        </RippleTouch>
      </View>
      {/* Lader nach der einen Regel (`LoadGate`): erst nach 2 s, dann mindestens zwei Durchläufe. */}
      <LoadGate
        loading={results.isFetching && list.length === 0}
        style={styles.searchLoading}
        loader={<GridLoader size={44} />}
      >
      {() => (
        list.slice(0, 6).map((loc, i) => (
          <RippleTouch
            key={loc.code}
            onPress={() => pick(loc)}
            accessibilityRole="button"
            style={({ pressed }) => [
              styles.resultRow,
              i < Math.min(list.length, 6) - 1 && { borderBottomWidth: 1, borderBottomColor: palette.border },
              pressed && { backgroundColor: palette.s3 },
            ]}
          >
            <Text style={styles.switchRowLabel} numberOfLines={1}>
              {loc.label}
            </Text>
            <Text style={styles.switchRowDesc} numberOfLines={1}>
              {[loc.detail, loc.city, loc.country].filter(Boolean).join(" · ")}
            </Text>
          </RippleTouch>
        ))
      )}
      </LoadGate>
    </ListCard>
  );
}

/* ─────────────────────── Auswahl ─────────────────────── */

export interface Choice<T extends string> {
  id: T;
  label: string;
  /** Farbpunkt vor der Beschriftung, für die Akzentfarbe. */
  dot?: string;
}

/**
 * Umschalter für zwei oder drei Möglichkeiten: derselbe gleitende Umschalter
 * wie überall in der App (samt Dehnen beim Drücken), nur neutral — Spur in
 * `s3`, die Pille eine Stufe heller statt im Akzent.
 */
export function ChoiceSegment<T extends string>({
  items,
  value,
  onChange,
  commitAfterSlide,
}: {
  items: Choice<T>[];
  value: T;
  onChange: (id: T) => void;
  /** Für Design und Akzent: Die App baut erst um, wenn die Pille angekommen ist (siehe SegmentedToggle). */
  commitAfterSlide?: boolean;
}) {
  const palette = usePalette();
  return (
    <SegmentedToggle
      items={items}
      selectedId={value}
      onChange={(id) => onChange(id as T)}
      containerColor={palette.s3}
      pillColor={RAISED}
      withShadow={false}
      innerPadding={3}
      segmentHeight={30}
      borderRadius={12}
      activeTextStyle={styles.segTextOn}
      inactiveTextStyle={styles.segText}
      commitAfterSlide={commitAfterSlide}
    />
  );
}

/** Tasten-Raster für mehr Möglichkeiten (Sprachen, Währungen), in derselben Sprache wie der Umschalter. */
export function ChoiceGrid<T extends string>({
  items,
  value,
  onChange,
  columns,
}: {
  items: Choice<T>[];
  value: T;
  onChange: (id: T) => void;
  columns: number;
}) {
  const palette = usePalette();
  const rows: Choice<T>[][] = [];
  for (let i = 0; i < items.length; i += columns) rows.push(items.slice(i, i + columns));
  return (
    <View style={styles.grid} accessibilityRole="radiogroup">
      {rows.map((row, r) => (
        <View key={r} style={styles.gridRow}>
          {row.map((it) => {
            const on = it.id === value;
            return (
              <Pressable
                key={it.id}
                onPress={() => {
                  if (on) return;
                  haptic("button");
                  onChange(it.id);
                }}
                accessibilityRole="radio"
                accessibilityState={{ checked: on }}
                accessibilityLabel={it.label}
                style={[
                  styles.key,
                  { backgroundColor: on ? RAISED : palette.s3, borderColor: on ? G3 : "transparent" },
                ]}
              >
                <Text numberOfLines={1} style={[styles.choiceText, on && styles.choiceTextOn]}>
                  {it.label}
                </Text>
              </Pressable>
            );
          })}
        </View>
      ))}
    </View>
  );
}

/* ─────────────────────── Mini-Handys ─────────────────────── */

function MiniPhone({ children }: { children: ReactNode }) {
  const palette = usePalette();
  return (
    <View
      style={[styles.phone, { backgroundColor: palette.bg, borderColor: palette.border }]}
      // Eine Vorschau, keine Bedienung: Der Bildschirmleser soll sie überspringen.
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      pointerEvents="none"
    >
      {children}
    </View>
  );
}

const MODE_ICONS: LucideIcon[] = [Plane, Train, Bus, Ship];
const TAB_ICONS: LucideIcon[] = [House, MapIcon, Bookmark, User];

/**
 * Der Startbildschirm im Kleinen: Kopf mit Logo, Suche, die vier
 * Verkehrsmittel, zuletzt gesucht, beliebte Ziele, die Leiste.
 *
 * Er zeigt den Grund des Designs, den Akzent an denselben Stellen wie die App
 * (das „i" im Logo, „Alle anzeigen", die gewählte Kategorie) und die Texte in
 * der eingestellten Sprache. Die Kacheln tragen keine Beschriftung: Bei dieser
 * Größe passt „Kreuzfahrten" nicht hinein.
 */
export function MiniHome() {
  const t = useT();
  const palette = usePalette();
  const accent = useAccent();
  return (
    <MiniPhone>
      <View style={styles.mhHeader}>
        <Text style={styles.mhLogo}>
          B<Text style={{ color: accent.solid }}>i</Text>nch
        </Text>
        <View style={[styles.mhBell, { backgroundColor: palette.s2 }]}>
          <Bell size={8} color={WHITE} strokeWidth={2.2} />
        </View>
      </View>
      <View style={[styles.mhSearch, { backgroundColor: palette.s2 }]}>
        <Search size={7} color={G2} strokeWidth={2.6} />
        <Text numberOfLines={1} style={styles.mhSearchText}>
          {t("home.search.placeholder")}
        </Text>
      </View>
      <View style={styles.mhTiles}>
        {MODE_ICONS.map((Icon, i) => (
          <View key={i} style={[styles.mhTile, { backgroundColor: palette.s2 }]}>
            <Icon size={10} color={WHITE} strokeWidth={1.8} />
          </View>
        ))}
      </View>
      <View style={styles.mhSectionRow}>
        <Text numberOfLines={1} style={styles.mhSection}>
          {t("home.recent.title")}
        </Text>
        <Text numberOfLines={1} style={[styles.mhLink, { color: accent.solid }]}>
          {t("home.viewall")}
        </Text>
      </View>
      <View style={[styles.mhRecent, { backgroundColor: palette.s2 }]}>
        <View style={[styles.mhRecentIcon, { backgroundColor: palette.s3 }]}>
          <Train size={8} color={WHITE} strokeWidth={2} />
        </View>
        <View style={styles.mhRecentText}>
          <Text numberOfLines={1} style={styles.mhRoute}>
            Köln → Berlin
          </Text>
          <View style={[styles.bar, styles.mhRecentBar]} />
        </View>
      </View>
      <Text numberOfLines={1} style={[styles.mhSection, styles.mhSectionAlone]}>
        {t("home.destinations.title")}
      </Text>
      <View style={styles.mhChips}>
        {[0, 1, 2, 3].map((i) => (
          <View key={i} style={[styles.mhChip, { backgroundColor: i === 0 ? accent.solid : palette.s2 }]} />
        ))}
      </View>
      <View style={[styles.mhDeck, { backgroundColor: palette.s2 }]} />
      <View style={[styles.mhTabBar, { backgroundColor: palette.s2 }]}>
        {TAB_ICONS.map((Icon, i) => (
          // Aktiv ist WEISS, nicht der Akzent, wie in der echten Leiste.
          <Icon key={i} size={8} color={i === 0 ? WHITE : G2} strokeWidth={2.2} />
        ))}
      </View>
    </MiniPhone>
  );
}

/**
 * Die Trefferliste im Kleinen: An der Stelle des Preises steht die gewählte
 * Währung. Sie steht als Kürzel hinter dem Betrag, genau wie auf den
 * Ergebniskarten. Die Beträge selbst sind Platzhalter (siehe Dateikopf).
 */
export function MiniResults() {
  const t = useT();
  const palette = usePalette();
  const currency = useSearchStore((s) => s.currency);
  return (
    <MiniPhone>
      <View style={styles.mrHead}>
        <Text numberOfLines={1} style={styles.mrRoute}>
          Köln → Berlin
        </Text>
        <View style={[styles.bar, styles.mrHeadBar, { backgroundColor: palette.s3 }]} />
      </View>
      {[0, 1, 2, 3].map((i) => (
        <View key={i} style={[styles.mrCard, { backgroundColor: palette.s2 }]}>
          <View style={styles.mrLeft}>
            <View style={[styles.bar, styles.mrTimeBar]} />
            <View style={[styles.bar, styles.mrSubBar, { backgroundColor: palette.s3 }]} />
          </View>
          <View style={styles.mrPrice}>
            <Text style={styles.mrFrom}>{t("results.from")}</Text>
            <View style={styles.mrDigits} />
            <Text style={styles.mrCode}>{currency}</Text>
          </View>
        </View>
      ))}
    </MiniPhone>
  );
}

/**
 * Eine Seite mit der Bestätigung „Ticket gespeichert", oben oder unten.
 *
 * Die einzige bewegte Vorschau: Die Lage hängt an einem Wert, den nur die
 * Bestätigung selbst liest. Das Umschalten baut also nichts Großes neu auf, das
 * der Bewegung in die Quere käme.
 */
export function MiniToast({ position }: { position: "top" | "bottom" }) {
  const t = useT();
  const palette = usePalette();
  const accent = useAccent();
  const atBottom = useSharedValue(position === "bottom" ? 1 : 0);
  useEffect(() => {
    atBottom.value = withTiming(position === "bottom" ? 1 : 0, {
      duration: 340,
      easing: Easing.out(Easing.cubic),
    });
  }, [position, atBottom]);
  const toastStyle = useAnimatedStyle(() => ({ transform: [{ translateY: atBottom.value * TOAST_TRAVEL }] }));
  return (
    <MiniPhone>
      <View style={[styles.bar, styles.mtTitleBar, { backgroundColor: palette.s2 }]} />
      <View style={[styles.mtBlock, { backgroundColor: palette.s2 }]} />
      <View style={[styles.mtBlock, { backgroundColor: palette.s2 }]} />
      <View style={[styles.mtBlock, { backgroundColor: palette.s2 }]} />
      <View style={[styles.bar, styles.mtLine, { backgroundColor: palette.s3 }]} />
      <Animated.View style={[styles.mtToast, { backgroundColor: palette.s2, borderColor: palette.border }, toastStyle]}>
        <View style={[styles.mtIcon, { backgroundColor: accent.solid }]}>
          <Check size={11} color={accent.textOnSolid} strokeWidth={3.4} />
        </View>
        <View style={styles.mtText}>
          <Text numberOfLines={1} style={styles.mtTitle}>
            {t("toast.saved.title")}
          </Text>
          <Text numberOfLines={1} style={styles.mtSub}>
            Köln → Berlin
          </Text>
        </View>
      </Animated.View>
    </MiniPhone>
  );
}

/** Bos Chat im Kleinen: Er merkt sich etwas und nutzt es beim nächsten Mal. Blasen wie im echten Chat. */
export function MiniChat() {
  const t = useT();
  const palette = usePalette();
  const accent = useAccent();
  const user = (text: string) => (
    <View style={[styles.mcBubble, styles.mcUser, { backgroundColor: accent.solid }]}>
      <Text style={[styles.mcUserText, { color: accent.textOnSolid }]}>{text}</Text>
    </View>
  );
  const bot = (text: string) => (
    <View style={[styles.mcBubble, styles.mcBot, { backgroundColor: palette.s2, borderColor: palette.border }]}>
      <Text style={styles.mcBotText}>{text}</Text>
    </View>
  );
  return (
    <MiniPhone>
      <View style={styles.mcThread}>
        {user(t("settings.bo.preview.q1"))}
        {bot(t("settings.bo.preview.a1"))}
        <View style={styles.mcNote}>
          <Brain size={8} color={G3} strokeWidth={2} />
          <Text numberOfLines={2} style={styles.mcNoteText}>
            <Text style={styles.mcNoteLabel}>{t("assistant.memory.saved")}</Text> {t("settings.bo.preview.fact")}
          </Text>
        </View>
        {user(t("settings.bo.preview.q2"))}
        {bot(t("settings.bo.preview.a2"))}
      </View>
      <View style={[styles.mcInput, { backgroundColor: palette.s2 }]}>
        <Text numberOfLines={1} style={styles.mcInputText}>
          {t("assistant.placeholder")}
        </Text>
      </View>
    </MiniPhone>
  );
}

/**
 * Eine NEUE Zugsuche im Kleinen — womit sie beginnt: Zuhause als Abfahrt,
 * Reisende, Klasse, Karte, Deutschlandticket. Ohne „Zuhause" steht dort ein
 * Platzhalter, ohne Karte fehlt ihr Feld.
 */
export function MiniSearch() {
  const t = useT();
  const palette = usePalette();
  const accent = useAccent();
  const home = useSearchStore((s) => s.homeStation);
  const pax = useSearchStore((s) => s.defaultPassengers);
  const cls = useSearchStore((s) => s.defaultTrainClass);
  const card = useSearchStore((s) => s.railCard);
  const dTicket = useSearchStore((s) => s.dTicket);
  const dTicketOnly = useSearchStore((s) => s.dTicketOnly);
  const transfer = useSearchStore((s) => s.transferMinutes);
  const bike = useSearchStore((s) => s.bikeCarriage);
  const chip = (key: string, text: string, Icon?: LucideIcon) => (
    <View key={key} style={[styles.msChip, { backgroundColor: palette.s2 }]}>
      {Icon ? <Icon size={7} color={WHITE} strokeWidth={2.4} /> : null}
      {text ? (
        <Text style={styles.msChipText} numberOfLines={1}>
          {text}
        </Text>
      ) : null}
    </View>
  );
  return (
    <MiniPhone>
      <View style={styles.msBody}>
        <Text style={styles.msTitle} numberOfLines={1}>
          {t("mode.trains")}
        </Text>
        <View style={[styles.msField, { backgroundColor: palette.s2 }]}>
          <Text style={styles.msLabel} numberOfLines={1}>
            {t("search.fromLabel.train")}
          </Text>
          {home ? (
            <View style={styles.msValueRow}>
              <House size={8} color={WHITE} strokeWidth={2.2} />
              <Text style={styles.msValue} numberOfLines={1}>
                {home.label}
              </Text>
            </View>
          ) : (
            <View style={[styles.bar, styles.msBar]} />
          )}
        </View>
        <View style={[styles.msField, { backgroundColor: palette.s2 }]}>
          <Text style={styles.msLabel} numberOfLines={1}>
            {t("search.toLabel.train")}
          </Text>
          <View style={[styles.bar, styles.msBar]} />
        </View>
        <View style={styles.msChips}>
          {chip("pax", String(pax), User)}
          {chip("cls", t(cls))}
          {card ? chip("card", RAIL_CARD_LABEL[card].short) : null}
          {dTicket ? chip("dt", dTicketOnly ? "nur D-Ticket" : "D-Ticket") : null}
          {transfer ? chip("tr", `≥ ${transfer}'`, Clock) : null}
          {bike ? chip("bike", "", Bike) : null}
        </View>
      </View>
      <View style={[styles.msButton, { backgroundColor: accent.solid }]}>
        <Text style={[styles.msButtonText, { color: accent.textOnSolid }]} numberOfLines={1}>
          {t("search.cta.trains")}
        </Text>
      </View>
    </MiniPhone>
  );
}

const styles = scaledStyles({
  /* — Karte — */
  card: {
    marginHorizontal: GUTTER,
    borderRadius: 20,
    padding: SPACE.lg,
    flexDirection: "row",
    gap: SPACE.lg,
  },
  cardBody: { flex: 1, minWidth: 0, justifyContent: "space-between" },
  cardTitle: { fontSize: 15, fontWeight: "600", color: WHITE, letterSpacing: -0.2 },
  cardDesc: { fontSize: 12.5, lineHeight: 18, color: G2, marginTop: SPACE.xs },
  cardControls: { marginTop: SPACE.md },
  controlLabel: { fontSize: 15, fontWeight: "600", color: WHITE, letterSpacing: -0.2, marginTop: SPACE.lg, marginBottom: SPACE.sm },

  sectionTitle: {
    fontSize: 13,
    fontWeight: "600",
    color: G2,
    paddingHorizontal: GUTTER + SPACE.xs,
    paddingTop: SECTION_GAP,
    paddingBottom: TITLE_GAP,
  },
  footnote: {
    fontSize: 12.5,
    lineHeight: 18,
    color: G2,
    paddingHorizontal: GUTTER + SPACE.xs,
    paddingTop: SPACE.md,
  },

  list: { marginHorizontal: GUTTER, borderRadius: 20, overflow: "hidden" },
  switchRow: { flexDirection: "row", alignItems: "center", gap: 16, paddingLeft: SPACE.lg },
  switchRowBody: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: SPACE.md,
    paddingVertical: 16,
    paddingRight: SPACE.lg,
  },
  switchRowText: { flex: 1, minWidth: 0 },
  switchRowLabel: { fontSize: 15, fontWeight: "600", color: WHITE, letterSpacing: -0.2 },
  switchRowDesc: { fontSize: 12.5, lineHeight: 17, color: G2, marginTop: 4 },

  dimmed: { opacity: 0.4 },
  panel: { marginHorizontal: GUTTER, borderRadius: 20, padding: SPACE.lg },
  panelDesc: { marginBottom: SPACE.md },
  stepper: { flexDirection: "row", alignItems: "center", gap: SPACE.sm },
  stepBtn: { width: 34, height: 34, borderRadius: 17, alignItems: "center", justifyContent: "center", overflow: "hidden" },
  stepValue: { minWidth: 22, textAlign: "center", fontSize: 16, fontWeight: "700", color: WHITE },
  rowAction: { fontSize: 13.5, fontWeight: "600", color: G2 },
  removeRow: { borderTopWidth: 1, paddingHorizontal: SPACE.lg, paddingVertical: 12 },
  removeText: { fontSize: 14, fontWeight: "600", color: RED },
  searchRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingLeft: SPACE.lg,
    paddingRight: SPACE.sm,
    borderBottomWidth: 1,
  },
  searchInput: { flex: 1, fontSize: 15, color: WHITE, paddingVertical: 16 },
  searchClose: { width: 36, height: 36, alignItems: "center", justifyContent: "center" },
  searchState: { paddingVertical: SPACE.lg, alignItems: "center" },
  /** Fläche für Warten und Lader — so hoch wie der Lader mit Rand, damit beim Erscheinen nichts springt. */
  searchLoading: { minHeight: 76, paddingVertical: SPACE.lg },
  resultRow: { paddingHorizontal: SPACE.lg, paddingVertical: 12 },
  notice: {
    marginHorizontal: GUTTER,
    marginBottom: SPACE.sm,
    borderRadius: 20,
    flexDirection: "row",
    alignItems: "center",
    gap: 16,
    paddingHorizontal: SPACE.lg,
    paddingVertical: 16,
    overflow: "hidden",
  },
  noticeTitle: { fontSize: 14, lineHeight: 19, color: WHITE },
  noticeAction: { fontSize: 12.5, fontWeight: "600", color: G2, marginTop: 4 },

  switchLine: { flexDirection: "row", alignItems: "center", gap: SPACE.sm },
  switchLineLabel: { flex: 1, fontSize: 13.5, fontWeight: "600", color: WHITE },

  danger: {
    marginHorizontal: GUTTER,
    marginTop: SPACE.lg,
    backgroundColor: "rgba(255,69,58,0.05)",
    borderRadius: 16,
    paddingHorizontal: SPACE.lg,
    paddingVertical: 16,
    flexDirection: "row",
    alignItems: "center",
    gap: SPACE.md,
  },
  dangerText: { fontSize: 15, fontWeight: "600", color: RED },

  /* — Auswahl — */
  segText: { fontSize: 13.5, fontWeight: "500", color: G2 },
  segTextOn: { fontSize: 13.5, fontWeight: "700", color: WHITE },
  choiceText: { fontSize: 13.5, fontWeight: "500", color: G2 },
  choiceTextOn: { fontWeight: "700", color: WHITE },
  grid: { gap: 8 },
  gridRow: { flexDirection: "row", gap: 8 },
  key: {
    flex: 1,
    height: 34,
    borderRadius: 10,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: SPACE.xs,
  },

  /* — Handy — */
  phone: { width: PHONE_W, height: PHONE_H, borderRadius: 20, borderWidth: 1, overflow: "hidden" },
  /** Platzhalter für Text, dessen Inhalt hier nichts zur Sache tut. */
  bar: { height: 4, borderRadius: 2, backgroundColor: RAISED },

  mhHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingTop: 11,
    paddingHorizontal: 9,
  },
  mhLogo: { fontSize: 13, fontWeight: "900", color: WHITE, letterSpacing: -0.3 },
  mhBell: { width: 16, height: 16, borderRadius: 8, alignItems: "center", justifyContent: "center" },
  mhSearch: {
    marginTop: 7,
    marginHorizontal: 8,
    height: 18,
    borderRadius: 9,
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 7,
  },
  mhSearchText: { flex: 1, fontSize: 6.5, color: G2 },
  mhTiles: { flexDirection: "row", gap: 3, marginTop: 6, marginHorizontal: 8 },
  mhTile: { flex: 1, height: 24, borderRadius: 7, alignItems: "center", justifyContent: "center" },
  mhSectionRow: {
    flexDirection: "row",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: 4,
    marginTop: 10,
    marginHorizontal: 9,
  },
  mhSection: { flexShrink: 1, fontSize: 8, fontWeight: "800", color: WHITE, letterSpacing: -0.1 },
  mhSectionAlone: { marginTop: 10, marginHorizontal: 9 },
  mhLink: { fontSize: 5.5, fontWeight: "600" },
  mhRecent: {
    marginTop: 5,
    marginHorizontal: 8,
    height: 28,
    borderRadius: 8,
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 6,
  },
  mhRecentIcon: { width: 16, height: 16, borderRadius: 5, alignItems: "center", justifyContent: "center" },
  mhRecentText: { flex: 1, minWidth: 0, gap: 3 },
  mhRoute: { fontSize: 6.5, fontWeight: "700", color: WHITE },
  mhRecentBar: { width: 34, height: 3 },
  mhChips: { flexDirection: "row", gap: 3, marginTop: 5, marginHorizontal: 8 },
  mhChip: { flex: 1, height: 11, borderRadius: 5.5 },
  /** Die Ziel-Karte darunter, von der Leiste angeschnitten — da geht es weiter. */
  mhDeck: { marginTop: 6, marginHorizontal: 8, height: 40, borderRadius: 9 },
  mhTabBar: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    height: 20,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-around",
  },

  mrHead: { paddingTop: 12, paddingHorizontal: 9, gap: 4 },
  mrRoute: { fontSize: 9, fontWeight: "800", color: WHITE, letterSpacing: -0.1 },
  mrHeadBar: { width: 40, height: 3 },
  mrCard: {
    marginTop: 6,
    marginHorizontal: 8,
    height: 40,
    borderRadius: 9,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 8,
  },
  mrLeft: { gap: 5 },
  mrTimeBar: { width: 40, height: 5, borderRadius: 2.5 },
  mrSubBar: { width: 26, height: 3 },
  mrPrice: { flexDirection: "row", alignItems: "center", gap: 3 },
  mrFrom: { fontSize: 5, fontWeight: "700", color: G2, letterSpacing: 0.3 },
  mrDigits: { width: 14, height: 7, borderRadius: 2, backgroundColor: RAISED },
  mrCode: { fontSize: 7, fontWeight: "800", color: WHITE },

  mtTitleBar: { marginTop: 18, marginHorizontal: 10, width: 48, height: 7, borderRadius: 3.5 },
  mtBlock: { marginTop: 8, marginHorizontal: 8, height: 30, borderRadius: 8 },
  mtLine: { marginTop: 10, marginHorizontal: 10, width: 64, height: 7, borderRadius: 3.5 },
  /**
   * Maße so gewählt, dass „Ticket gespeichert" (die längste Fassung) in eine
   * Zeile passt. Mit der 26er Kachel blieben dem Text 66 dp, und der Titel
   * endete in „Ticket gespei…".
   */
  mtToast: {
    position: "absolute",
    top: TOAST_EDGE,
    left: 6,
    right: 6,
    height: TOAST_H,
    borderRadius: 13,
    borderWidth: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 6,
  },
  mtIcon: { width: 22, height: 22, borderRadius: 7, alignItems: "center", justifyContent: "center" },
  mtText: { flex: 1, minWidth: 0 },
  mtTitle: { fontSize: 7.5, fontWeight: "700", color: WHITE, letterSpacing: -0.1 },
  mtSub: { fontSize: 6.5, fontWeight: "600", color: G3, marginTop: 1 },

  mcThread: { paddingTop: 14, paddingHorizontal: 8, gap: 6 },
  mcBubble: { paddingVertical: 5, paddingHorizontal: 8, borderRadius: 10 },
  mcUser: { alignSelf: "flex-end", maxWidth: "86%", borderBottomRightRadius: 3 },
  mcBot: { alignSelf: "flex-start", maxWidth: "90%", borderWidth: 1, borderBottomLeftRadius: 3 },
  mcUserText: { fontSize: 7.5, lineHeight: 10, fontWeight: "600" },
  mcBotText: { fontSize: 7.5, lineHeight: 10, color: WHITE },
  mcNote: { flexDirection: "row", alignItems: "center", gap: 3, marginLeft: 2 },
  mcNoteText: { flexShrink: 1, fontSize: 6.5, lineHeight: 9, color: G3 },
  mcNoteLabel: { fontWeight: "700" },
  mcInput: {
    position: "absolute",
    left: 8,
    right: 8,
    bottom: 9,
    height: 20,
    borderRadius: 10,
    justifyContent: "center",
    paddingHorizontal: 8,
  },
  mcInputText: { fontSize: 6.5, color: G2 },

  msBody: { paddingTop: 12, paddingHorizontal: 8, gap: 5 },
  msTitle: { fontSize: 11, fontWeight: "900", color: WHITE, letterSpacing: -0.2, marginLeft: 1, marginBottom: 1 },
  msField: { borderRadius: 8, paddingHorizontal: 7, paddingVertical: 5, gap: 3 },
  msLabel: { fontSize: 5.5, fontWeight: "600", color: G2 },
  msValueRow: { flexDirection: "row", alignItems: "center", gap: 3 },
  msValue: { flexShrink: 1, fontSize: 7.5, fontWeight: "700", color: WHITE },
  msBar: { width: 44, height: 4, marginVertical: 2 },
  msChips: { flexDirection: "row", flexWrap: "wrap", gap: 3, marginTop: 1 },
  msChip: { flexDirection: "row", alignItems: "center", gap: 2, borderRadius: 6, paddingHorizontal: 5, paddingVertical: 3 },
  msChipText: { fontSize: 6, fontWeight: "700", color: WHITE },
  msButton: {
    position: "absolute",
    left: 8,
    right: 8,
    bottom: 10,
    height: 22,
    borderRadius: 11,
    alignItems: "center",
    justifyContent: "center",
  },
  msButtonText: { fontSize: 7, fontWeight: "800" },
});
