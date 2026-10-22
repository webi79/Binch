import { memo, useCallback, useEffect, useRef, useState, type RefObject } from "react";
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
  type LayoutChangeEvent,
} from "react-native";
import Animated, {
  Easing,
  FadeIn,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";
import { ArrowLeft, Navigation, Plane, Route } from "lucide-react-native";
import { RippleTouch } from "@/components/ui/RippleTouch";
import { iconForProduct } from "@/components/results/LinePill";
import { TAB_BAR_H } from "@/components/ui/BinchTabBar";
import type { CameraPadding, MapSurfaceHandle } from "@/components/surroundings/MapSurface";
import { useAccent } from "@/lib/theme/accent";
import { TRANSIT_COLOR, transitCategory } from "@/lib/theme/transitColors";
import { SPACE } from "@/lib/theme/spacing";
import { ms, scaledStyles } from "@/lib/ui/compact";
import { useT } from "@/lib/i18n/useT";
import { haptic } from "@/lib/haptics";
import { formatTimeInZone } from "@/lib/time-format";
import { getAirportTimezone } from "@/lib/airports/timezones";
import { useSearchStore } from "@/stores/searchStore";
import { distanceM } from "@/lib/live/geo";
import { cameraTarget, nextBearing, overviewCamera, viewHeading, type CameraTarget } from "@/lib/live/camera";
import type { LiveFrame, LiveModel } from "@/lib/live/model";
import type { LiveStatus } from "@/lib/live/useLiveModel";
import type { LiveSession } from "@/lib/live/types";
import type { ZoomTrack } from "@/lib/live/zoomTrack";

/**
 * DIE BEDIENUNG DER LIVE-ANSICHT — Banner oben, Karte unten, zwei Knöpfe — und
 * die Kamera, die dem Fahrzeug folgt.
 *
 * Gestaltet wie die Nachbarn auf der Karte: Das Banner ist das Routen-Banner
 * (Zurück-Kreis 44, Titel-Pille), die Karte unten ist eine Hero-Karte der
 * Abfahrtstafel (Radius 24, Innenabstand 18/20), die Knöpfe sind die runden
 * Kartenknöpfe (`MapFabs`). Abstände auf dem 4er-Raster (`SPACE`), Rand 16 wie
 * alles, was auf der Karte schwebt.
 *
 * KEINE DAUERANIMATION hier (auch kein pulsierender LIVE-Punkt): Die Karte
 * zeichnet das Fahrzeug bis zu 20-mal je Sekunde neu, und jeder dieser Commits
 * schreibt laufende Reanimated-Werte ein, zwei Bilder zu spät zurück
 * (feedback_reanimated_commit_race) — ein Puls würde flackern.
 */

const C = {
  white: "#F4F4F5",
  g1: "#C4C4C8",
  g2: "#8E8E93",
  g3: "#56565C",
  border: "#212123",
};
const LIVE_RED = "#FF3B5C";
/** Abstand zwischen runden Kartenknöpfen — derselbe wie in `MapFabs`. */
const FAB_GAP = 10;
const DELAY_RED = "#F26565";

interface Props {
  session: LiveSession;
  model: LiveModel | null;
  status: LiveStatus;
  mapRef: RefObject<MapSurfaceHandle | null>;
  /** Zoom, für den die Fahrzeug-Ebene baut — die Kamera kündigt ihre Fahrten hier an. */
  zoom: ZoomTrack;
  /** false = Tab nicht im Bild oder App im Hintergrund: Takt und Kamera ruhen. */
  running: boolean;
  topInset: number;
  bottomInset: number;
  /** Lage des Banners — die Knopfreihe der Karte richtet sich danach. */
  onBannerLayout: (e: LayoutChangeEvent) => void;
  onClose: () => void;
}

export function LiveOverlay({
  session,
  model,
  status,
  mapRef,
  zoom,
  running,
  topInset,
  bottomInset,
  onBannerLayout,
  onClose,
}: Props) {
  const { width, height } = useWindowDimensions();
  const follow = useSearchStore((s) => s.liveFollow);
  const setLiveFollow = useSearchStore((s) => s.setLiveFollow);
  const modelRef = useRef(model);
  modelRef.current = model;
  /** Unterkante des Banners und Oberkante der Karte — der freie Ausschnitt. */
  const bannerBottomRef = useRef(topInset + 60);
  const panelTopRef = useRef(height - 260);
  const [panelTop, setPanelTop] = useState<number | null>(null);

  const padding = useCallback(
    (extra = 0): CameraPadding => ({
      top: bannerBottomRef.current + ms(SPACE.sm) + extra,
      bottom: Math.max(0, height - panelTopRef.current) + ms(SPACE.sm) + extra,
      left: extra,
      right: extra,
    }),
    [height],
  );

  const handleBannerLayout = useCallback(
    (e: LayoutChangeEvent) => {
      const { y, height: h } = e.nativeEvent.layout;
      bannerBottomRef.current = y + h;
      onBannerLayout(e);
    },
    [onBannerLayout],
  );
  const handlePanelLayout = useCallback((e: LayoutChangeEvent) => {
    const { y } = e.nativeEvent.layout;
    panelTopRef.current = y;
    setPanelTop(y);
  }, []);

  /**
   * DIE KAMERA FOLGT — einmal je Sekunde ein neues Ziel, jeweils 1,1 s voraus
   * gerechnet und in genau 1,1 s gleichmäßig angefahren. Die nächste Fahrt
   * kommt nach einer Sekunde, also immer kurz bevor die vorige ankommt: Die
   * Kamera gleitet ohne Halt, statt jede Sekunde anzufahren und zu bremsen.
   *
   * DER ANFLUG: in der Nähe gleitend; ist das Fahrzeug weit weg (der Weg wäre
   * ein Bogenflug), ein SCHNITT — das Bild friert ein, die Kamera springt
   * darunter und das alte Bild blendet aus (`followTo` mit `cut`). Der Flug
   * mit Neigung durch fremde Kacheln ruckelte, und er fiel genau in den
   * Moment, in dem die Oberfläche umgebaut wird. Beim Schnitt zeigt die
   * Kamera gleich die Stelle von JETZT, und das Folgen setzt sofort ein.
   *
   * Jede Fahrt wird beim Zoom angemeldet (`zoom`): Das Fahrzeug wird für den
   * Zoom gebaut, den die Karte gerade zeigt — nicht schon für das Ziel.
   *
   * Die Daten werden jede Minute frisch geladen; der Kreislauf liest sie über
   * eine Ablage und beginnt deshalb NICHT neu (sonst gäbe es jede Minute einen
   * neuen Anflug).
   */
  const hasModel = model != null;
  useEffect(() => {
    if (!hasModel || !follow || !running) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let bearing: number | null = null;
    const target = (t: number): CameraTarget | null => {
      const m = modelRef.current;
      if (!m) return null;
      const f = m.frameAt(t);
      bearing = nextBearing(bearing, viewHeading(m, f));
      return cameraTarget(m, f, bearing, height);
    };
    // Erst der Anflug (dem Weg angemessen), dann das Folgen.
    const glideTarget = target(Date.now() + 800);
    if (!glideTarget) return;
    const map = mapRef.current;
    const cut = map?.isFar(glideTarget.latitude, glideTarget.longitude, glideTarget.zoom) ?? false;
    const first = cut ? target(Date.now() + 60) ?? glideTarget : glideTarget;
    const approach = map?.followTo({ ...first, padding: padding(), cut }) ?? 0;
    if (approach > 0) {
      zoom.glide(first.zoom, approach);
    } else {
      zoom.setView(first.bearing, first.pitch);
      zoom.jump(first.zoom);
    }
    let last = first;
    const tick = () => {
      // Den Schalter im Store prüfen, nicht nur das Abräumen des Effekts: Das
      // kommt erst nach dem nächsten Durchgang — fiele ein Takt dazwischen,
      // schwenkte die Kamera aus „Ganze Strecke" oder unter dem Finger zurück.
      if (cancelled || !useSearchStore.getState().liveFollow) return;
      const next = target(Date.now() + 1_100);
      if (next) {
        const moved =
          distanceM([last.longitude, last.latitude], [next.longitude, next.latitude]) > 0.3 ||
          Math.abs(next.bearing - last.bearing) > 0.2 ||
          Math.abs(next.zoom - last.zoom) > 0.01;
        // Im Stand nichts schicken — jede Fahrt meldet Beginn und Ende an die Karte.
        if (moved) {
          zoom.glide(next.zoom, 1_100);
          mapRef.current?.followTo({ ...next, padding: padding(), duration: 1_100 });
          last = next;
        }
      }
      timer = setTimeout(tick, 1_000);
    };
    // Nach einem Schnitt gleich weiter — die Kamera steht schon an der Stelle.
    timer = setTimeout(tick, cut ? 0 : Math.max(300, approach));
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [hasModel, follow, running, mapRef, zoom, padding, height]);

  const onFollow = useCallback(() => {
    haptic("button");
    setLiveFollow(true);
  }, [setLiveFollow]);
  const onOverview = useCallback(() => {
    haptic("button");
    setLiveFollow(false);
    const m = modelRef.current;
    if (!m) return;
    const pad = padding(ms(SPACE.xxl));
    const cam = overviewCamera(m.coords, width, height, pad);
    if (!cam) return;
    // Weit weg (fast immer: von der Folge-Stufe auf die ganze Strecke) ein
    // SCHNITT wie beim Start und Ende der Ansicht — der Bogenflug lud mit
    // Neigung auf jeder Zwischenstufe Kacheln nach („Übersicht öffnen laggt").
    // Nah dran gleitend; den Zoom dann NICHT vorab aufs Ziel setzen: Gebaut für
    // die Übersicht wäre ein Zug auf der Folge-Stufe ein kilometerbreiter Block,
    // und die Kamera stünde zu Beginn der Fahrt mitten darin.
    const map = mapRef.current;
    const cut = map?.isFar(cam.latitude, cam.longitude, cam.zoom) ?? false;
    const dur = map?.followTo({ ...cam, padding: pad, cut }) ?? 0;
    if (dur > 0) {
      zoom.glide(cam.zoom, dur);
    } else {
      zoom.setView(cam.bearing, cam.pitch);
      zoom.jump(cam.zoom);
    }
  }, [setLiveFollow, padding, width, height, mapRef, zoom]);

  const panelBottom = ms(TAB_BAR_H) + bottomInset + ms(SPACE.md);
  return (
    <>
      <LiveBanner
        session={session}
        // Auf der Ankunftstafel kennt die Zeile nur die Herkunft — das Ziel
        // kommt dann aus den Live-Daten.
        direction={session.direction || model?.direction || ""}
        topInset={topInset}
        onLayout={handleBannerLayout}
        onClose={onClose}
      />
      {panelTop != null && status === "ready" ? (
        <View
          style={[styles.fabCol, { top: panelTop - ms(SPACE.md) - ms(44) * 2 - ms(FAB_GAP) }]}
          pointerEvents="box-none"
        >
          <LiveFab onPress={onOverview} label="live.overview">
            <Route size={ms(20)} color={C.white} strokeWidth={2.2} />
          </LiveFab>
          <LiveFab onPress={onFollow} label="live.follow" active={follow}>
            <FollowIcon active={follow} />
          </LiveFab>
        </View>
      ) : null}
      <Animated.View
        entering={FadeIn.duration(220)}
        style={[styles.panel, { bottom: panelBottom }]}
        onLayout={handlePanelLayout}
      >
        <LivePanel session={session} model={model} status={status} running={running} />
      </Animated.View>
    </>
  );
}

function FollowIcon({ active }: { active: boolean }) {
  const accent = useAccent();
  return (
    <Navigation
      size={ms(19)}
      color={active ? accent.solid : C.white}
      fill={active ? accent.solid : "transparent"}
      strokeWidth={2.2}
    />
  );
}

function LiveFab({
  children,
  onPress,
  active,
  label,
}: {
  children: React.ReactNode;
  onPress: () => void;
  active?: boolean;
  label: string;
}) {
  const accent = useAccent();
  const t = useT();
  return (
    <RippleTouch
      onPress={onPress}
      borderless
      accessibilityRole="button"
      accessibilityLabel={t(label)}
      accessibilityState={active != null ? { selected: active } : undefined}
      style={[styles.fab, active ? { borderColor: accent.solid } : null]}
    >
      {children}
    </RippleTouch>
  );
}

// --- Banner -----------------------------------------------------------------
const LiveBanner = memo(function LiveBanner({
  session,
  direction,
  topInset,
  onLayout,
  onClose,
}: {
  session: LiveSession;
  direction: string;
  topInset: number;
  onLayout: (e: LayoutChangeEvent) => void;
  onClose: () => void;
}) {
  const accent = useAccent();
  const t = useT();
  const ModeIcon = session.kind === "flight" ? Plane : iconForProduct(session.product, session.line);
  // Die Linie in der Farbe ihrer Verkehrsart, wie auf der Tafel, von der sie kam.
  const category = session.kind === "flight" ? "flight" : transitCategory(session.product, session.line);
  const badge = category === "flight" ? accent.dark : TRANSIT_COLOR[category];
  return (
    <View style={[styles.bannerWrap, { top: topInset + 8 }]} pointerEvents="box-none" onLayout={onLayout}>
      <RippleTouch onPress={onClose} hitSlop={8} style={styles.backBtn}>
        <ArrowLeft color={C.white} size={20} strokeWidth={2.2} />
      </RippleTouch>
      <View style={styles.titleBox}>
        <View style={[styles.lineBadge, { backgroundColor: badge, borderColor: badge }]}>
          <ModeIcon size={13} color="#FFFFFF" strokeWidth={2.2} />
          <Text style={[styles.lineText, { color: "#FFFFFF" }]} numberOfLines={1}>
            {session.line}
          </Text>
        </View>
        <Text style={styles.direction} numberOfLines={1}>
          {direction || "—"}
        </Text>
        <View style={styles.livePill}>
          <View style={styles.liveDot} />
          <Text style={styles.liveText}>{t("live.badge")}</Text>
        </View>
      </View>
    </View>
  );
});

// --- Karte unten -------------------------------------------------------------
const pad2 = (n: number) => String(n).padStart(2, "0");

/** Tausender gruppiert, wie man es in der jeweiligen Sprache schreibt. */
function grouped(n: number, locale: string): string {
  const sep = locale === "en" ? "," : locale === "fr" ? " " : ".";
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, sep);
}

function LivePanel({
  session,
  model,
  status,
  running,
}: {
  session: LiveSession;
  model: LiveModel | null;
  status: LiveStatus;
  running: boolean;
}) {
  const accent = useAccent();
  const t = useT();
  const locale = useSearchStore((s) => s.locale);
  // Eine Sekunde Takt — die Zahlen hier ändern sich nicht schneller sichtbar.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, [running]);

  if (status === "error") {
    return <Text style={styles.message}>{t("live.error")}</Text>;
  }
  if (!model) {
    return (
      <View style={styles.loadingRow}>
        <ActivityIndicator color={C.g1} size="small" />
        <Text style={styles.message}>{t("live.loading")}</Text>
      </View>
    );
  }

  const frame = model.frameAt(now);
  const stops = model.stops;
  const last = stops.length - 1;
  const tzOf = (i: number): string | undefined =>
    session.kind === "trip" ? session.tz : (getAirportTimezone(stops[i]?.code) ?? undefined);
  const time = (at: number | null, i: number): string => {
    if (at == null || !Number.isFinite(at)) return "–";
    const tz = tzOf(i);
    if (tz) return formatTimeInZone(new Date(at).toISOString(), tz);
    const d = new Date(at);
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  };

  // Das Stück, auf dem es gerade ist (Balken): vom zuletzt verlassenen zum nächsten Halt.
  let from: number;
  let to: number;
  let frac: number;
  if (model.kind === "plane") {
    from = 0;
    to = 1;
    frac = frame.progress;
  } else if (frame.phase === "arrived") {
    from = Math.max(0, last - 1);
    to = last;
    frac = 1;
  } else if (frame.phase === "moving") {
    from = frame.stopIndex;
    to = frame.nextIndex ?? last;
    const span = stops[to]!.d - stops[from]!.d;
    frac = span > 0 ? (frame.d - stops[from]!.d) / span : 0;
  } else {
    from = Math.min(frame.stopIndex, last - 1);
    to = from + 1;
    frac = 0;
  }
  frac = Math.max(0, Math.min(1, frac));

  const head = headline(model, frame, now, t, locale, time);
  /**
   * DEIN HALT: Liegt der Halt der Tafel noch vor dem Fahrzeug, steht unten,
   * wann es dort ist — die Zahl, für die man die Live-Ansicht öffnet. Die
   * Minuten rechts, damit ein langer Name sie nicht abschneidet. Ist dein Halt
   * der, den die Karte ohnehin groß nennt, stehen die Minuten gleich dort.
   */
  const b = model.boardIndex;
  let eta: { name: string; when: string } | null = null;
  let sub = head.sub;
  if (b != null && stops[b]) {
    const ahead =
      model.kind === "plane" ? b === 1 && frame.phase !== "taxiIn" && frame.phase !== "arrived" : b > frame.stopIndex;
    const at = stops[b]!.arr ?? stops[b]!.dep;
    if (ahead && at != null) {
      const min = Math.ceil((at - now) / 60_000);
      const when = min >= 1 ? t("live.etaIn").replace("{min}", String(min)) : t("live.etaNowShort");
      if (head.stopIndex === b) sub = `${when.charAt(0).toUpperCase()}${when.slice(1)} · ${sub}`;
      else eta = { name: stopName(stops[b]!), when };
    }
  }

  return (
    <>
      <View style={styles.head}>
        <View style={styles.headText}>
          <Text style={styles.eyebrow} numberOfLines={1}>
            {head.eyebrow}
          </Text>
          <Text style={styles.title} numberOfLines={1}>
            {head.title}
          </Text>
          <Text style={[styles.sub, head.late ? styles.subLate : null]} numberOfLines={1}>
            {sub}
          </Text>
        </View>
        {head.metric ? (
          <View style={styles.metric}>
            <Text style={styles.metricValue}>{head.metric.value}</Text>
            <Text style={styles.metricUnit}>{head.metric.unit}</Text>
          </View>
        ) : null}
      </View>

      <SegmentBar progress={frac} color={accent.solid} />

      {eta ? (
        <View style={styles.etaRow}>
          <View style={[styles.etaDot, { borderColor: accent.solid }]} />
          <Text style={styles.etaName} numberOfLines={1}>
            {eta.name}
          </Text>
          <Text style={[styles.etaWhen, { color: accent.solid }]}>{eta.when}</Text>
        </View>
      ) : null}
    </>
  );
}

/**
 * DER FORTSCHRITT als Kette aus zehn Segmenten, die sich von links nach rechts
 * füllen — das gerade befahrene teilweise. Die Füllung gleitet auf dem
 * UI-Strang: Jede Sekunde kommt ein neuer Wert, und der Balken fährt ihn in
 * knapp einer Sekunde gleichmäßig an, statt zu springen. Geht der Wert zurück
 * (nächster Abschnitt nach einem Halt), setzt er sofort neu an, statt sichtbar
 * rückwärts zu laufen.
 *
 * Bewegt wird nur `scaleX` der Füllung (vom linken Rand aus) — keine Breite,
 * also kein Layout je Bild. Die Rundung macht das Segment mit `overflow:
 * hidden`, die Füllung selbst bleibt eckig und verzerrt beim Strecken nichts.
 */
const SEGMENTS = 10;

function SegmentBar({ progress, color }: { progress: number; color: string }) {
  const p = useSharedValue(progress);
  useEffect(() => {
    if (progress < p.value - 0.02) p.value = progress;
    else p.value = withTiming(progress, { duration: 950, easing: Easing.linear });
  }, [progress, p]);
  return (
    <View style={styles.bar}>
      {Array.from({ length: SEGMENTS }, (_, i) => (
        <Segment key={i} index={i} progress={p} color={color} />
      ))}
    </View>
  );
}

function Segment({ index, progress, color }: { index: number; progress: SharedValue<number>; color: string }) {
  const fill = useAnimatedStyle(() => ({
    transform: [{ scaleX: Math.min(1, Math.max(0, progress.value * SEGMENTS - index)) }],
  }));
  return (
    <View style={styles.seg}>
      <Animated.View style={[styles.segFill, { backgroundColor: color }, fill]} />
    </View>
  );
}

function stopName(s: { name: string; code?: string }): string {
  return s.code ? `${s.code} · ${s.name}` : s.name;
}

/**
 * Der Kopf der Karte — wie die „Nächste"-Karte der Tafel: eine kleine
 * Überzeile (was es gerade tut), groß der Halt, um den es geht, darunter seine
 * Zeit (rot bei Verspätung). Rechts eine große Zahl: Tempo bzw. Flughöhe.
 * `stopIndex` sagt, welchen Halt der Titel nennt (für „dein Halt").
 */
function headline(
  model: LiveModel,
  f: LiveFrame,
  now: number,
  t: (k: string) => string,
  locale: string,
  time: (at: number | null, i: number) => string,
): {
  eyebrow: string;
  title: string;
  sub: string;
  late: boolean;
  stopIndex: number;
  metric?: { value: string; unit: string };
} {
  const stops = model.stops;
  const last = stops.length - 1;
  const delay = (i: number) => stops[i]?.delayMin ?? 0;
  const withDelay = (text: string, i: number) => (delay(i) > 0 ? `${text} · +${delay(i)} Min` : text);
  const arrSub = (i: number) => withDelay(t("live.sub.arr").replace("{time}", time(stops[i]?.arr ?? null, i)), i);
  const depSub = (i: number) => withDelay(t("live.sub.dep").replace("{time}", time(stops[i]?.dep ?? null, i)), i);

  if (model.kind === "plane") {
    const title = stopName(stops[1]!);
    const landing = withDelay(t("live.sub.flightArr").replace("{time}", time(stops[1]!.arr, 1)), 1);
    const base = { title, stopIndex: 1, late: delay(1) > 0, sub: landing };
    switch (f.phase) {
      case "gate":
        return {
          ...base,
          eyebrow: t("live.eb.gate"),
          sub: withDelay(t("live.sub.flightDep").replace("{time}", time(stops[0]!.dep, 0)), 0),
          late: delay(0) > 0,
        };
      case "taxiOut":
        return { ...base, eyebrow: t("live.flight.taxiOut") };
      case "climb":
      case "cruise":
      case "descent":
        return {
          ...base,
          eyebrow: t(`live.flight.${f.phase}`),
          // Auf 50 m gerundet — die Rechnung ist nicht genauer.
          metric: { value: grouped(Math.round(f.altitude / 50) * 50, locale), unit: "m" },
        };
      case "taxiIn":
        return { ...base, eyebrow: t("live.eb.landed") };
      default:
        return { ...base, eyebrow: t("live.eb.arrived") };
    }
  }

  switch (f.phase) {
    case "waiting": {
      const dep = stops[0]?.dep;
      const min = dep != null ? Math.ceil((dep - now) / 60_000) : 0;
      return {
        eyebrow: min >= 1 ? t("live.eb.departsIn").replace("{min}", String(min)) : t("live.eb.departsNow"),
        title: stops[0]!.name,
        sub: depSub(0),
        late: delay(0) > 0,
        stopIndex: 0,
      };
    }
    case "moving": {
      const next = f.nextIndex ?? last;
      return {
        eyebrow: t("live.eb.next"),
        title: stops[next]!.name,
        sub: arrSub(next),
        late: delay(next) > 0,
        stopIndex: next,
        metric: { value: String(Math.round(f.speed * 3.6)), unit: "km/h" },
      };
    }
    case "dwelling":
      return {
        eyebrow: t("live.eb.stopped"),
        title: stops[f.stopIndex]!.name,
        sub: depSub(f.stopIndex),
        late: delay(f.stopIndex) > 0,
        stopIndex: f.stopIndex,
      };
    default:
      return {
        eyebrow: t("live.eb.arrived"),
        title: stops[last]!.name,
        sub: arrSub(last),
        late: delay(last) > 0,
        stopIndex: last,
      };
  }
}

const styles = scaledStyles({
  bannerWrap: {
    position: "absolute",
    left: 16,
    right: 16,
    zIndex: 30,
    flexDirection: "row",
    alignItems: "center",
    columnGap: 12,
  },
  backBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: "rgba(27,27,27,0.95)",
    borderColor: C.border,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.4,
    shadowRadius: 12,
    elevation: 6,
  },
  titleBox: {
    flex: 1,
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    columnGap: 10,
    backgroundColor: "rgba(27,27,27,0.95)",
    borderColor: C.border,
    borderWidth: 1,
    borderRadius: 9999,
    paddingLeft: 8,
    paddingRight: 8,
    paddingVertical: 6,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.5,
    shadowRadius: 20,
    elevation: 10,
  },
  lineBadge: {
    flexDirection: "row",
    alignItems: "center",
    columnGap: 5,
    borderWidth: 1,
    borderRadius: 9999,
    paddingHorizontal: 9,
    paddingVertical: 4,
    flexShrink: 0,
    maxWidth: 120,
  },
  lineText: { fontSize: 12, fontWeight: "700" },
  direction: {
    flex: 1,
    color: C.white,
    fontSize: 14,
    fontWeight: "700",
    letterSpacing: -0.2,
  },
  livePill: {
    flexDirection: "row",
    alignItems: "center",
    columnGap: 5,
    borderRadius: 9999,
    paddingHorizontal: 9,
    paddingVertical: 4,
    backgroundColor: "rgba(255,59,92,0.14)",
    borderColor: "rgba(255,59,92,0.32)",
    borderWidth: 1,
    flexShrink: 0,
  },
  liveDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: LIVE_RED },
  liveText: { color: LIVE_RED, fontSize: 10, fontWeight: "800", letterSpacing: 1 },

  fabCol: {
    position: "absolute",
    right: 16,
    rowGap: FAB_GAP,
    zIndex: 25,
  },
  fab: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: "rgba(13,13,13,0.92)",
    borderColor: C.border,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.4,
    shadowRadius: 12,
    elevation: 6,
  },

  panel: {
    position: "absolute",
    left: 16,
    right: 16,
    zIndex: 30,
    backgroundColor: "rgba(23,23,25,0.97)",
    borderColor: C.border,
    borderWidth: 1,
    borderRadius: 24,
    paddingVertical: 18,
    paddingHorizontal: 20,
    rowGap: 16,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.5,
    shadowRadius: 20,
    elevation: 10,
  },
  loadingRow: { flexDirection: "row", alignItems: "center", columnGap: 12 },
  message: { color: C.g1, fontSize: 14, fontWeight: "600", flexShrink: 1 },
  head: { flexDirection: "row", alignItems: "center", columnGap: 16 },
  headText: { flex: 1, minWidth: 0 },
  eyebrow: {
    color: C.g2,
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 1.2,
    textTransform: "uppercase",
    marginBottom: 4,
  },
  title: { color: C.white, fontSize: 22, fontWeight: "700", letterSpacing: -0.4 },
  sub: { color: C.g2, fontSize: 15, fontWeight: "600", marginTop: 4 },
  subLate: { color: DELAY_RED },
  /** Große Zahl mit Einheit — wie die Minuten im Ring der Tafel. */
  metric: { alignItems: "center", minWidth: 56, flexShrink: 0 },
  metricValue: {
    color: C.white,
    fontSize: 26,
    fontWeight: "800",
    letterSpacing: -0.6,
    lineHeight: 30,
    fontVariant: ["tabular-nums"],
  },
  metricUnit: { color: C.g2, fontSize: 11, fontWeight: "700", marginTop: 1 },
  bar: { flexDirection: "row", columnGap: 4 },
  seg: {
    flex: 1,
    height: 8,
    borderRadius: 4,
    backgroundColor: "#2A2A2F",
    overflow: "hidden",
  },
  segFill: { ...StyleSheet.absoluteFillObject, transformOrigin: "left" },
  etaRow: { flexDirection: "row", alignItems: "center", columnGap: 10 },
  /** Der Ring „deines" Halts auf der Karte, im Kleinen (Akzent-Rand). */
  etaDot: { width: 10, height: 10, borderRadius: 5, borderWidth: 2.5, backgroundColor: C.white },
  etaName: { flex: 1, color: C.white, fontSize: 15, fontWeight: "600" },
  etaWhen: { fontSize: 15, fontWeight: "800", flexShrink: 0 },
});
