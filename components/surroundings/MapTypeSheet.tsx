import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Text, View } from "react-native";
import Animated, { Easing, useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { Building2, Moon, Satellite, Sun, X } from "lucide-react-native";
import { RippleTouch } from "@/components/ui/RippleTouch";
import { haptic } from "@/lib/haptics";
import { useT } from "@/lib/i18n/useT";
import { usePalette } from "@/lib/theme/appBg";
import { CLOSE_ICON_SIZE, FIELD_H, GROUP_GAP, SECTION_GAP, SPACE, TITLE_GAP } from "@/lib/theme/spacing";
import { scaledStyles } from "@/lib/ui/compact";
import { SheetModal, SHEET_SUBTITLE, SHEET_TITLE } from "@/components/ui/SheetModal";
import { BinchSwitch } from "@/components/ui/BinchSwitch";
import { SegmentedToggle, type SegmentedToggleItem } from "@/components/ui/SegmentedToggle";
import { MapStylePreview } from "@/components/surroundings/MapStylePreview";
import { useSearchStore } from "@/stores/searchStore";
import { resolveMapStyle, type MapStyleChoice, type ResolvedMapStyle } from "@/lib/theme/mapStyleChoice";
import { useDataSaverActive } from "@/lib/net/dataSaver";
import { showSheetStatus } from "@/components/ui/StatusToast";
import { markTransitionBusy } from "@/lib/nav/transitionBusy";
import { whenMapQuiet } from "@/lib/surroundings/mapViewport";

/**
 * Das Blatt für den Kartentyp — erreichbar über den obersten Knopf der
 * Karten-Knopfreihe.
 *
 * AUFBAU wie in jedem anderen Blatt dieser App: `SheetModal` liefert
 * Verdunkelung, Griff, Rundung, seitliches Polster und die Wisch-Geste; hier
 * drin steht nur der Inhalt.
 *
 * SEIT 06.11.2026 „IDEE 2" (Nutzer: „sehr cool — der Übergang zwischen den
 * Varianten muss makellos sein"):
 *  - Kopf wie im Preisalarm: Titel und X, kein Untertitel mehr.
 *  - EINE große Vorschau (`MapStylePreview`): zeigt den gewählten Stil und, ob
 *    die Häuser stehen. Vorher drei kleine Kacheln.
 *  - Darunter die Umschalt-Pille der App (`SegmentedToggle`, wie „Hin- und
 *    Rückfahrt / Einfach") mit Zeichen, dann „3D-Gebäude" als Schalter-Zeile im
 *    Stil der Einstellungen. Gesperrt (Satellit, Datensparen) ist sie nur
 *    gedimmt; ein Tipp sagt oben warum (`showSheetStatus`) — das Blatt ändert
 *    nie seine Höhe.
 *
 * WIE DER ÜBERGANG MAKELLOS BLEIBT. Die App lässt Reanimated direkt an die
 * Ansichten schreiben; ein React-Durchgang MITTEN in einer Bewegung schreibt
 * ältere Werte zurück, und die Pille zuckt (siehe `startDragHeal` in
 * lib/ui/sheetSwipe.ts). Deshalb:
 *  1. Beim Tipp auf ein Segment startet die Vorschau sofort mit der Pille
 *     (`onPick`) — nur über geteilte Werte, ohne zu rendern.
 *  2. Gerendert wird erst, wenn die Pille steht (`commitAfterSlide`).
 *  3. Der Schalter rendert zuerst und bewegt DANACH (Effekt) — beide Fahrten,
 *     seine und die der Häuser, beginnen nach dem Durchgang.
 *  4. Die Karte dahinter zieht nach, sobald die Pille steht. Ein neuer Stil
 *     wartet dabei NICHT auf das Ende der eigenen Überblendung: Die steht dann
 *     schon bei über 95 %, und der Durchgang samt Neuaufbau landet ohnehin erst
 *     danach (gemessen: der Speicher kam vorher erst nach ~400 ms, die Pille
 *     steht nach ~230 ms). Fremde Fahrten (Blatt schließt) hält er weiter ab.
 *     Das Kippen für 3D wartet, bis die Häuser in der Vorschau stehen
 *     (`whenMapQuiet`): Die Kamerafahrt fiele sonst in ihr Aufstellen.
 *
 * Überblendet wird so, dass nie der Grund durchscheint: Der untere Stil steht
 * voll, während der obere ein- oder ausblendet (siehe `crossTo`). Zwei Bilder,
 * die gleichzeitig halb durchsichtig sind, zeigten in der Mitte ein dunkles
 * Loch — beim Wechsel auf Hell ein Flackern.
 */

const C = { white: "#F4F4F5", sub: "#8E8E93", icon: "#C8C8CC", closeIcon: "#E5E7EB" };

/** Reihenfolge = Schichtung in der Vorschau (unten → oben). */
const STYLES: readonly ResolvedMapStyle[] = ["dark", "light", "satellite"];
const indexOf = (st: ResolvedMapStyle) => STYLES.indexOf(st);

/** Überblenden der Stile — so lang wie die Pille plus Auslauf. */
const CROSS = { duration: 300, easing: Easing.inOut(Easing.cubic) };
/** Häuser aufstellen: weich ankommen; Hinlegen etwas kürzer. */
const RISE = { duration: 460, easing: Easing.out(Easing.cubic) };
const FALL = { duration: 300, easing: Easing.inOut(Easing.cubic) };
/** Dimmen der gesperrten 3D-Zeile. */
const DIM = { duration: 220, easing: Easing.out(Easing.cubic) };
const DIMMED = 0.4;

/** Trefferfläche des X — dieselbe Rechnung wie im Preisalarm. */
const ICON_HIT_SLOP = (44 - CLOSE_ICON_SIZE) / 2;

/** Was eine Wahl gerade zeigt: „automatisch" folgt dem Thema der App. */
function shownFor(choice: MapStyleChoice, theme: "light" | "dark" | "gray"): ResolvedMapStyle {
  return choice === "auto" ? resolveMapStyle("auto", theme) : choice;
}

function MapTypeBody({
  onClose,
  onBuildingsChange,
}: {
  onClose: () => void;
  onBuildingsChange?: (on: boolean) => void;
}) {
  const t = useT();
  const palette = usePalette();
  const theme = useSearchStore((st) => st.theme);
  /** Datensparen hält Luftbild und Häuser ohne WLAN zurück (lib/net/dataSaver.ts). */
  const saving = useDataSaverActive();

  /**
   * Der Zustand des Blattes ist LOKAL, solange es offen ist — die Karte
   * dahinter bekommt ihn verzögert (siehe oben, Punkt 4). Startwert aus dem
   * Speicher: „automatisch" zeigt, wozu es gerade wird.
   */
  const [shown, setShown] = useState<ResolvedMapStyle>(() => {
    const st = useSearchStore.getState();
    return shownFor(st.mapStyleChoice, st.theme);
  });
  const [buildings, setBuildings] = useState(() => useSearchStore.getState().mapBuildings3d);
  /** Im Luftbild gibt es keine Häuser zum Aufstellen — sie stehen schon im Bild. */
  const blocked = shown === "satellite" || saving;
  const on3d = buildings && !blocked;

  /** Was der Speicher am Ende bekommen soll. */
  const desired = useRef({
    choice: useSearchStore.getState().mapStyleChoice,
    buildings: useSearchStore.getState().mapBuildings3d,
  });
  const buildingsRef = useRef(buildings);
  buildingsRef.current = buildings;
  const onBuildingsRef = useRef(onBuildingsChange);
  onBuildingsRef.current = onBuildingsChange;
  const commitPending = useRef(false);
  /**
   * Ende der eigenen Fahrten des letzten Stil-Tipps (Überblendung, Häuser) —
   * die hält das Nachziehen der Karte nicht auf (siehe Punkt 4 oben).
   */
  const ownBusyUntil = useRef(0);
  const scheduleCommit = useCallback((ownUntil = 0) => {
    if (commitPending.current) return;
    commitPending.current = true;
    // Läuft auch, wenn das Blatt inzwischen zu ist — der Speicher ist global.
    whenMapQuiet(() => {
      commitPending.current = false;
      const st = useSearchStore.getState();
      const d = desired.current;
      if (d.choice !== st.mapStyleChoice) st.setMapStyleChoice(d.choice);
      if (d.buildings !== st.mapBuildings3d) {
        st.setMapBuildings3d(d.buildings);
        onBuildingsRef.current?.(d.buildings);
      }
    }, ownUntil);
  }, []);

  // ── Die geteilten Werte der Vorschau und der 3D-Zeile ──────────────────────
  const opDark = useSharedValue(shown === "dark" ? 1 : 0);
  const opLight = useSharedValue(shown === "light" ? 1 : 0);
  const opSat = useSharedValue(shown === "satellite" ? 1 : 0);
  const ops = useMemo(() => [opDark, opLight, opSat] as const, [opDark, opLight, opSat]);
  const p3 = useSharedValue(on3d ? 1 : 0);
  const live = useSharedValue(blocked ? DIMMED : 1);
  /** Wohin gerade gefahren wird — ein zweiter Auftrag mit demselben Ziel startet nichts neu. */
  const aim = useRef({ style: shown, p3: on3d ? 1 : 0, live: blocked ? DIMMED : 1 });

  /**
   * Überblenden auf einen Stil, ohne dass der Grund durchscheint.
   *
   * Regel: Was ÜBER dem neuen Stil liegt, blendet aus; der neue blendet ein.
   * Was DARUNTER liegt, bleibt stehen, bis der neue voll da ist, und geht dann
   * weg. Liegt der neue unter einem voll sichtbaren, wird er sofort voll
   * gesetzt — er ist ja verdeckt — und der obere gibt ihn frei. So ist in jedem
   * Bild unten ein deckendes Bild.
   */
  const crossTo = useCallback(
    (next: ResolvedMapStyle) => {
      const idx = indexOf(next);
      const vals = ops.map((o) => o.value);
      let top = -1;
      for (let i = vals.length - 1; i >= 0; i--) {
        if (vals[i] > 0.001) {
          top = i;
          break;
        }
      }
      const clearBelow = () => {
        "worklet";
        if (idx > 0) opDark.value = 0;
        if (idx > 1) opLight.value = 0;
      };
      for (let i = idx + 1; i < ops.length; i++) {
        if (vals[i] > 0) {
          ops[i].value = withTiming(0, CROSS, (f) => {
            "worklet";
            if (f) clearBelow();
          });
        }
      }
      if (top > idx && vals[top] >= 0.99) {
        ops[idx].value = 1;
      } else {
        ops[idx].value = withTiming(1, CROSS, (f) => {
          "worklet";
          if (f) clearBelow();
        });
      }
    },
    [ops, opDark, opLight],
  );
  /** Häuser aufstellen bzw. hinlegen; gibt das Ende dieser Fahrt zurück (0: keine). */
  const riseTo = useCallback(
    (on: boolean) => {
      const to = on ? 1 : 0;
      if (aim.current.p3 === to) return 0;
      aim.current.p3 = to;
      const until = markTransitionBusy((on ? RISE : FALL).duration);
      p3.value = withTiming(to, on ? RISE : FALL);
      return until;
    },
    [p3],
  );
  const dimTo = useCallback(
    (isBlocked: boolean) => {
      const to = isBlocked ? DIMMED : 1;
      if (aim.current.live === to) return;
      aim.current.live = to;
      live.value = withTiming(to, DIM);
    },
    [live],
  );

  /** Ein Stil fährt an — mit allem, was an ihm hängt. Nur geteilte Werte. */
  const goTo = useCallback(
    (next: ResolvedMapStyle) => {
      if (aim.current.style === next) return;
      aim.current.style = next;
      const crossUntil = markTransitionBusy(CROSS.duration);
      crossTo(next);
      const nextBlocked = next === "satellite" || saving;
      const riseUntil = riseTo(buildingsRef.current && !nextBlocked);
      ownBusyUntil.current = Math.max(crossUntil, riseUntil);
      dimTo(nextBlocked);
    },
    [crossTo, riseTo, dimTo, saving],
  );

  /**
   * Schalter und Sperre nach jedem Durchgang nachziehen — der Häuser-Tipp
   * kommt so an (erst rendern, dann fahren), und eine Wahl, die über `goTo`
   * schon fährt, wird nicht neu angesetzt (gleiches Ziel).
   */
  useEffect(() => {
    riseTo(on3d);
    dimTo(blocked);
  }, [on3d, blocked, riseTo, dimTo]);

  // ── Bedienung ──────────────────────────────────────────────────────────────
  /** Sofort beim Tipp, gleichzeitig mit der Pille — ohne zu rendern. */
  const onPick = useCallback((id: string) => goTo(id as ResolvedMapStyle), [goTo]);
  /** Wenn die Pille steht: rendern und die Karte dahinter vormerken. */
  const onChange = useCallback(
    (id: string) => {
      const next = id as ResolvedMapStyle;
      setShown(next);
      desired.current.choice = next;
      scheduleCommit(ownBusyUntil.current);
    },
    [scheduleCommit],
  );
  /**
   * Dasselbe Segment noch einmal: zurück auf „automatisch" — die Kopplung an
   * das Thema der App muss erreichbar bleiben. Meist ändert sich dabei nichts
   * Sichtbares (alle Themen sind dunkel).
   */
  const onReselect = useCallback(() => {
    if (desired.current.choice === "auto") return;
    desired.current.choice = "auto";
    const next = shownFor("auto", theme);
    if (next !== aim.current.style) {
      haptic("button");
      goTo(next);
      setShown(next);
    }
    scheduleCommit();
  }, [theme, goTo, scheduleCommit]);

  const toggleBuildings = useCallback(() => {
    haptic("button");
    // Gesperrt: nichts schalten, aber sagen, warum — oben, ohne dass das Blatt
    // seine Höhe ändert.
    if (blocked) {
      showSheetStatus(saving ? "buildingsSaver" : "buildingsSatellite");
      return;
    }
    const next = !buildings;
    setBuildings(next);
    desired.current.buildings = next;
    // Die Karte kippt erst, wenn die Häuser in der Vorschau stehen.
    markTransitionBusy((next ? RISE : FALL).duration);
    scheduleCommit();
  }, [blocked, saving, buildings, scheduleCommit]);

  const items = useMemo<SegmentedToggleItem[]>(
    () => [
      { id: "dark", label: t("map.type.dark"), Icon: Moon },
      { id: "light", label: t("map.type.light"), Icon: Sun },
      { id: "satellite", label: t("map.type.satellite"), Icon: Satellite },
    ],
    [t],
  );
  const labels = useMemo(
    () => [t("map.type.dark"), t("map.type.light"), t("map.type.satellite")] as const,
    [t],
  );
  const liveStyle = useAnimatedStyle(() => ({ opacity: live.value }));
  const liveLabel = useAnimatedStyle(() => ({ opacity: live.value }));
  const liveSwitch = useAnimatedStyle(() => ({ opacity: live.value }));

  return (
    <>
      <View style={s.head}>
        <Text style={s.title} numberOfLines={1}>
          {t("map.type.title")}
        </Text>
        <RippleTouch
          borderless
          hitSlop={ICON_HIT_SLOP}
          onPress={onClose}
          accessibilityLabel={t("common.close")}
          style={s.closeBtn}
        >
          <X size={CLOSE_ICON_SIZE} color={C.closeIcon} strokeWidth={2} />
        </RippleTouch>
      </View>

      <View style={s.preview}>
        <MapStylePreview ops={ops} p3={p3} labels={labels} />
      </View>

      <SegmentedToggle
        items={items}
        selectedId={shown}
        onPick={onPick}
        onChange={onChange}
        onReselect={onReselect}
        commitAfterSlide
        segmentHeight={44}
        borderRadius={16}
        activeTextStyle={s.segActive}
        inactiveTextStyle={s.segRest}
        style={s.segments}
      />
      {saving ? <Text style={s.note}>{t("map.type.dataSaver")}</Text> : null}

      <Text style={s.section}>{t("map.details.title")}</Text>

      {/**
        * Eine Schalter-Zeile wie in den Einstellungen (`SwitchRow` in
        * SettingsBlocks.tsx): freies Zeichen, Name, Schalter, auf einer Karte
        * in der Kartenfarbe. Die ganze Zeile schaltet; der Schalter steht
        * deshalb auf `readOnly`, sonst zählte ein Tipp doppelt.
        *
        * Gesperrt wird GEDIMMT (weich, mit der Vorschau), nicht versteckt —
        * eine Zeile, die im Luftbild verschwände, sähe aus wie ein Fehler.
        * Antippen bleibt möglich und sagt den Grund.
        */}
      <View style={[s.card, { backgroundColor: palette.s2 }]}>
        <RippleTouch
          onPress={toggleBuildings}
          accessibilityRole="switch"
          accessibilityLabel={t("map.details.buildings")}
          accessibilityState={{ checked: on3d, disabled: blocked }}
          style={s.detailRow}
        >
          <Animated.View style={liveStyle}>
            <Building2 size={18} color={C.icon} strokeWidth={1.9} />
          </Animated.View>
          <Animated.Text style={[s.detailLabel, liveLabel]} numberOfLines={1}>
            {t("map.details.buildings")}
          </Animated.Text>
          <Animated.View style={liveSwitch}>
            <BinchSwitch value={on3d} readOnly />
          </Animated.View>
        </RippleTouch>
      </View>
    </>
  );
}

export function MapTypeSheet({
  visible,
  onClose,
  onBuildingsChange,
}: {
  visible: boolean;
  onClose: () => void;
  /** 3D-Gebäude an/aus — der Karten-Bildschirm kippt die Karte dazu (`tiltTo`). */
  onBuildingsChange?: (on: boolean) => void;
}) {
  /**
   * `onClose` muss vom Aufrufer FEST sein — eine neue Funktion pro Durchgang
   * richtet in der Hülle Wisch-Geste und Zurück-Taste-Merker mitten in der
   * Bewegung neu ein (siehe `SheetModal`).
   */
  return (
    <SheetModal visible={visible} onClose={onClose}>
      {(close) => <MapTypeBody onClose={close} onBuildingsChange={onBuildingsChange} />}
    </SheetModal>
  );
}

const s = scaledStyles({
  /** Kopf wie im Preisalarm: Titel und X auf einer Linie. */
  head: { flexDirection: "row", alignItems: "center", gap: SPACE.md },
  title: { ...SHEET_TITLE, flex: 1, minWidth: 0 },
  closeBtn: { alignItems: "center", justifyContent: "center" },
  preview: { marginTop: GROUP_GAP },
  segments: { marginTop: GROUP_GAP },
  /** Schrift der Pille eine Stufe größer als ihre Vorgabe — sie ist hier die Hauptbedienung. */
  segActive: { fontSize: 14, fontWeight: "700", color: "#000000" },
  segRest: { fontSize: 14, fontWeight: "600", color: C.sub },
  note: { ...SHEET_SUBTITLE, marginTop: TITLE_GAP },
  section: { ...SHEET_TITLE, fontSize: 17, marginTop: SECTION_GAP, marginBottom: TITLE_GAP },
  /** Karte wie die Einstellungs-Listen, Radius der Felder in Blättern (16). */
  card: { borderRadius: 16, overflow: "hidden" },
  /** Maße der Einstellungs-Zeile: 16 Rand, 16 zwischen Zeichen und Text. */
  detailRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: SPACE.lg,
    paddingHorizontal: SPACE.lg,
    minHeight: FIELD_H,
    borderRadius: 16,
  },
  detailLabel: {
    flex: 1,
    minWidth: 0,
    fontSize: 15,
    fontWeight: "600",
    letterSpacing: -0.2,
    color: C.white,
  },
});
