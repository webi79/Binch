/**
 * Animated Search-Hero — ersetzt die statischen PNG-Hintergründe für
 * Flug/Zug/Bus/Cruise mit einer SVG-Animation (Himmel + Sonne/Mond +
 * Wolken/Sterne + ruhige Dünen-Silhouette).
 *
 * Vier Categories × drei Zeit-Stimmungen:
 *   - category: "flug" | "zug" | "bus" | "kreuzfahrt"  → Dünen-Phase (Seed)
 *   - time:     "morgen" | "tag" | "nacht"             → Farbpalette
 *
 * `time` kommt typischerweise aus pickTimeOfDay() (siehe Helper unten),
 * basierend auf der aktuellen Geräte-Uhrzeit.
 *
 * Animationen via RN's eingebautes Animated-API (kein Reanimated) damit
 * keine Worklets nötig sind und der Hero auch in Liste/Modal ohne extra
 * Setup läuft.
 */
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { Platform, StyleSheet, View, type LayoutChangeEvent, type StyleProp, type ViewStyle } from "react-native";
import Reanimated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withTiming,
} from "react-native-reanimated";
import Svg, {
  Defs,
  LinearGradient,
  RadialGradient,
  Stop,
  Rect,
  Circle,
  Ellipse,
  G,
  Path,
} from "react-native-svg";
import { useSearchStore } from "@/stores/searchStore";
import { isSheetMoving, subscribeSheetMoving } from "@/lib/nav/searchHandoff";
import { subscribeLayer } from "@/lib/nav/transitionLayer";
import { PICKER_OUT } from "@/lib/nav/overlayCover";

/**
 * Zusätzlicher Maßstab der SVG gegenüber dem viewBox (siehe `scale: 1.07` unten).
 * Steht als Konstante, weil der Sonnen-Weg damit umgerechnet werden muss.
 */
const SVG_ZOOM = 1.07;

/** Weg des Sonnen-/Mond-Aufgangs in viewBox-Einheiten. */
const SUN_RISE_TRAVEL = 17;


const W = 390;
/**
 * Höhe des viewBox = Höhe des Bandes (siehe `hero` in SearchHero).
 *
 * Vorher 446 bei einem rund 350 hohen Band: Mit `slice` wurde also ohnehin
 * beschnitten, und als das Band auf das Maß des Auth-Screens (220) flach wurde,
 * hätte der Ausschnitt entweder die Gestirne oder die vorderste Düne gefressen —
 * das Motiv braucht bei den alten Koordinaten rund 310 Einheiten Höhe.
 *
 * Jetzt entspricht das viewBox dem Band-Seitenverhältnis, `slice` schneidet
 * nichts mehr weg, und die Koordinaten unten sind auf diese Höhe eingepasst.
 */
const H = 220;

export type HeroCategory = "flug" | "zug" | "bus" | "kreuzfahrt";
export type HeroTime = "morgen" | "tag" | "nacht";

interface TimePalette {
  sky: Array<[number, string]>;
  warm?: { x: number; y: number; col: string };
  light: { cx: number; cy: number; r: number; core: string; glow: string; moon?: boolean };
  hills: [string, string, string];
  rim: string;
  stars: number;
}

// Drei Tages-Variants, alle aus der Original-Vorlage:
//   morgen → dunkler Sunrise (purple→pink→orange→gold) mit niedriger Sonne
//   tag    → heller Mittag (lila→pink→peach→cream) mit hoher Cremesonne
//   nacht  → tiefes Navy mit Mond + 32 Sterne
const TIMES: Record<HeroTime, TimePalette> = {
  morgen: {
    // Sky-Palette aus dem BinchAuthScreen — gelb → orange → lila → navy
    // (Sunrise/Sunset-Look). Locations exakt wie im AuthScreen-Gradient.
    sky: [
      [0, "#f7b15c"],
      [0.3, "#e8784e"],
      [0.64, "#7a4a6e"],
      [1, "#2c3a63"],
    ],
    // Sonne tief am Horizont, größer (r=62). End-Position cy=230 (nochmal
    // 15dp höher), horizontal zentriert (cx=W/2=195). Wird komplett von
    // ALLEN Dünen überlagert — nur die obere Kuppe schaut über die
    // hinterste Dünen-Linie.
    light: { cx: 195, cy: 113, r: 31, core: "#FCE7B6", glow: "#F3A858" },
    hills: ["#3a2740", "#22182f", "#0e0a18"],
    rim: "#e8784e",
    stars: 0,
  },
  tag: {
    // Pure 5-Stop-Gradient OHNE warm-Overlay. Vorher hat der warm-Radial
    // die unteren Stopps mit Orange übertönt → die reinen Lavendel/Rose-
    // Töne waren verfälscht. Jetzt sieht der Sky aus wie der saubere
    // Gradient den der LinearGradient-Placeholder zeigte.
    sky: [
      [0, "#8C7BA8"],
      [0.38, "#B98EA0"],
      [0.66, "#E2A878"],
      [0.85, "#F0C290"],
      [1, "#F6D3A2"],
    ],
    light: { cx: 300, cy: 74, r: 25, core: "#F0DFB8", glow: "#E8C088" },
    hills: ["#3A4A63", "#26354C", "#141E2E"],
    rim: "#C99A86",
    stars: 0,
  },
  nacht: {
    sky: [[0, "#070A1C"], [0.55, "#101634"], [1, "#26315C"]],
    light: { cx: 300, cy: 69, r: 20, core: "#ECF1FF", glow: "#9FB6E0", moon: true },
    hills: ["#1E2B4A", "#16213A", "#0A1120"],
    rim: "#5E7CB4",
    stars: 32,
  },
};

const SEED: Record<HeroCategory, number> = { flug: 0, zug: 1, bus: 2, kreuzfahrt: 3 };

/**
 * ZWEI Dünen, nicht drei — die hinterste und die vorderste.
 *
 * Im flachen Band standen drei Linien so dicht übereinander, dass die mittlere
 * nur noch als Strich zwischen den anderen lag. Ohne sie bleibt der Tiefen-
 * eindruck erhalten (hell hinten, dunkel vorne), und beide dürfen mehr
 * Amplitude haben als drei gequetschte — die Skyline wird eher kräftiger.
 *
 * Die vordere reicht mit ihrer Grundlinie bis unter die Oberkante des Sheets
 * (das liegt bei y≈200 dieser Einheiten): Das Fenster schneidet dadurch sichtbar
 * in die Düne hinein, statt an ihr abzuschließen.
 */
const DUNES = [
  { baseY: 116, amp: 28, n: 4 },
  { baseY: 172, amp: 34, n: 3 },
];


function smoothTop(pts: number[][]): string {
  let d = `M ${pts[0][0]},${pts[0][1]}`;
  for (let i = 1; i < pts.length; i++) {
    const mx = (pts[i - 1][0] + pts[i][0]) / 2;
    const my = (pts[i - 1][1] + pts[i][1]) / 2;
    d += ` Q ${pts[i - 1][0]},${pts[i - 1][1]} ${mx},${my}`;
  }
  const last = pts[pts.length - 1];
  return d + ` L ${last[0]},${last[1]}`;
}

function duneTop(layer: { baseY: number; amp: number; n: number }, ph: number): string {
  const pts: number[][] = [[0, layer.baseY + layer.amp * 0.3]];
  for (let i = 0; i <= layer.n; i++) {
    pts.push([(W * i) / layer.n, layer.baseY - layer.amp * (0.5 + 0.5 * Math.sin(i * 1.7 + ph))]);
  }
  pts.push([W, layer.baseY + layer.amp * 0.3]);
  return smoothTop(pts);
}

const closeDune = (top: string) => `${top} L ${W},${H} L 0,${H} Z`;

function makeStars(n: number): Array<[number, number, number, number]> {
  // Deterministischer PRNG damit Sterne pro Reload an gleicher Stelle bleiben
  // und nicht jeden Mount unterschiedlich tanzen (sähe nervös aus).
  let s = 91;
  const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const out: Array<[number, number, number, number]> = [];
  for (let i = 0; i < n; i++) {
    out.push([rnd() * W, rnd() * 84 + 4, rnd() * 1.1 + 0.5, rnd() * 2 + 1]);
  }
  return out;
}

/** Bestimmt anhand der aktuellen Stunde welche Tageszeit-Stimmung passt.
 *  06-12 = morgen, 12-21 = tag (mittag), 21-06 = nacht. */
export function pickTimeOfDay(date: Date = new Date()): HeroTime {
  const h = date.getHours();
  if (h >= 6 && h < 12) return "morgen";
  if (h >= 12 && h < 21) return "tag";
  return "nacht";
}

interface Props {
  category: HeroCategory;
  time?: HeroTime;
  /** Farbe in die der untere Rand auslaufen soll (App-Bg-Farbe). */
  melt?: string;
  style?: StyleProp<ViewStyle>;
  /** Stoppt alle Animations-Loops und die Rise-Anim. Nützlich wenn ein
   *  Modal-Overlay über dem Hero auf slidet — sonst konkurriert unsere
   *  RAF-getriebene Animation mit der Reanimated-Slide-Animation des
   *  Modals und produziert sichtbares Lag. */
  paused?: boolean;
  /** Ändert sich pro Such-Öffnung → die Sonne geht neu auf. Nötig, seit der
   *  Screen dauerhaft gemountet bleibt (sonst liefe der Aufgang nur einmal). */
  riseKey?: number;
}

function BinchHeroComponent({
  category,
  time = "tag",
  melt = "#1A1A1A",
  style,
  paused = false,
  riseKey = 0,
}: Props) {
  // Picker-Open direkt aus dem Store lesen — damit pausiert BinchHero
  // SOFORT beim Tap auf ein Feld (Store-Update ist synchron, BinchHero
  // re-rendert mit pickerOpen=true im SELBEN React-Commit wie der Picker
  // sliden anfängt). Ohne diese direkte Subscription musste SearchHero
  // erst re-rendern → paused=true Prop nach unten → BinchHero re-render
  // → erst dann cancelAnimation. 2 Frames Verzögerung waren genug für
  // sichtbares Stutter im Slide.
  /**
   * EIN Signal statt vier — und das ist der Kern des Ruckelns beim Öffnen.
   *
   * Hier hingen vier unabhängige Abonnements, die zu VERSCHIEDENEN Zeitpunkten
   * umspringen: die Textur-Anforderung (`pickerLayer`, beim AUFSETZEN), der
   * Speicher-Zustand (`pickerOpen`, beim LOSLASSEN), der Nachlauf
   * (`holdAfterClose`, dessen Effekt beim Öffnen ebenfalls umspringt) und die
   * Bewegungsmeldung. Jedes davon ist ein eigener Zustand, also ein eigener
   * Neuaufbau dieses Baums — und dieser Baum sind drei SVG-Wurzeln mit
   * Verläufen, bis zu 39 Formknoten und nachts 32 Sternen.
   *
   * ZWEI davon — `pickerOpen` und `holdAfterClose` — springen im selben
   * Durchgang, in dem das Blatt losfährt. Und weil ein Neuaufbau die
   * Hardware-Textur ungültig macht, war genau die Textur wertlos, die beim
   * Aufsetzen extra vorgebaut wird: bauen, verwerfen, verwerfen, mitten in der
   * Fahrt neu bauen. Dieselbe Falle, die am Blatt selbst behoben wurde, nur eine
   * Ebene tiefer und teurer — hier liegt der sichtbare Unterschied zum
   * Such-Blatt, unter dem der geparkte Landingscreen liegt und dessen eigene
   * SVG währenddessen auf `display:none` stehen.
   *
   * Deshalb jetzt ein einziger Zustand. Er wird beim Aufsetzen wahr und bleibt
   * es. Das Öffnen und der Bewegungsstart melden ihn erneut als wahr — React
   * bricht bei gleichem Wert ab, es gibt also KEINEN Neuaufbau mehr in genau
   * den Bildern, auf die es ankommt.
   *
   * Der Speicher wird bewusst über `subscribe` beobachtet statt über den
   * Auswahl-Haken: Der Haken erzwingt den Neuaufbau schon dadurch, dass sich
   * sein Wert ändert. Hier soll aber nur der Übergang von „ruhig" nach
   * „beschäftigt" zählen, und der ist beim Loslassen längst passiert.
   *
   * Die Spracheingabe zählt mit — ihr Blatt liegt genauso über diesem
   * Bildschirm. Sie hat kein Berührungsfenster, dort bleibt es also bei einem
   * Neuaufbau beim Öffnen; das ist der ehrliche Preis dafür, dass es dort
   * keinen Vorlauf gibt.
   */
  const pickerBusyNow = () => {
    const st = useSearchStore.getState();
    return (
      st.locationPickerRequest !== null ||
      st.datePickerRequest !== null ||
      st.voiceOverlayOpen
    );
  };
  const [heroBusy, setHeroBusy] = useState(() => pickerBusyNow() || isSheetMoving());
  const releaseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * Getrennte Felder je Schlüssel.
   *
   * Beide Ebenen-Abonnements schrieben auf dasselbe Feld. Die automatische
   * Freigabe des einen (1400ms) löschte damit die Anforderung des anderen —
   * im Fall „Datumsfeld berührt, dann doch das Ortsfeld" verlor der Hero seine
   * Textur mitten in der Fahrt.
   */
  const busyFlags = useRef({
    layerLoc: false,
    layerDate: false,
    open: pickerBusyNow(),
    moving: isSheetMoving(),
  });

  useEffect(() => {
    const apply = () => {
      const f = busyFlags.current;
      /**
       * Bei geschlossener Suche gar nichts tun.
       *
       * `prepareLayer("pickerLocation")` wird auch aus dem Umgebungs-Tab
       * gerufen. Dieser Baum hängt dauerhaft am Wurzel-Layout — ohne diesen
       * Wächter löste ein Tipp dort einen kompletten Neuaufbau des Hero-SVG aus
       * UND eine Textur-Anforderung auf einer Fläche, die gerade `display:none`
       * trägt, plus 1400ms später den Gegen-Commit. Reine Verschwendung auf
       * einem Bildschirm, der den Hero gar nicht zeigt.
       */
      // Der Wächter unterdrückt nur das EINSCHALTEN. Als vollständiger
      // Ausstieg wäre er ein Fehler: Schließt die Suche, während der Wert wahr
      // steht, käme er nie mehr zurück — und beim nächsten Öffnen bliebe der
      // Hero pausiert, die Sonne ginge nicht auf.
      const searchOpen = useSearchStore.getState().searchOverlayMode != null;
      if (searchOpen && (f.layerLoc || f.layerDate || f.open || f.moving)) {
        if (releaseTimer.current) {
          clearTimeout(releaseTimer.current);
          releaseTimer.current = null;
        }
        // Gleicher Wert → React bricht ab. Genau darauf beruht der Fix.
        setHeroBusy(true);
        return;
      }
      // Nachlauf beim Schließen: `pickerOpen` fällt im ERSTEN Bild der
      // Rückfahrt, ohne ihn verlöre der Hero seine Ebene genau dann, wenn er
      // wieder sichtbar wird.
      if (releaseTimer.current) clearTimeout(releaseTimer.current);
      releaseTimer.current = setTimeout(
        () => setHeroBusy(false),
        PICKER_OUT.duration + 80,
      );
    };
    const offLoc = subscribeLayer("pickerLocation", (v) => {
      busyFlags.current.layerLoc = v;
      apply();
    });
    const offDate = subscribeLayer("pickerDate", (v) => {
      busyFlags.current.layerDate = v;
      apply();
    });
    const offStore = useSearchStore.subscribe(() => {
      const next = pickerBusyNow();
      if (next === busyFlags.current.open) return;
      busyFlags.current.open = next;
      apply();
    });
    const offMoving = subscribeSheetMoving((v) => {
      busyFlags.current.moving = v;
      apply();
    });
    return () => {
      offLoc();
      offDate();
      offStore();
      offMoving();
      if (releaseTimer.current) clearTimeout(releaseTimer.current);
    };
  }, []);
  // Aus demselben Grund direkt hier abonniert: Der Such-Screen bleibt inzwischen
  // DAUERHAFT gemountet. Ist die Suche zu, liegt dieser Hero unsichtbar im Baum
  // und darf nicht weiteranimieren. Würde SearchHero das abonnieren, müsste sein
  // schwerer Baum bei jedem Öffnen/Schließen neu rendern — mitten im Launch.
  const searchClosed = useSearchStore((s) => s.searchOverlayMode == null);
  /**
   * Auch während das Blatt FÄHRT stillstehen.
   *
   * Das fehlte, und daran hing der Sprung der Sonne. Ablauf vorher:
   *
   *   Tippen        → Blatt fährt hoch, Hero NICHT pausiert
   *                 → der Sonnenaufgang startet sofort und läuft 880ms
   *   Blatt ist oben → der Reveal zählt `riseKey` hoch
   *                 → neuer Schlüssel = neue Öffnung = Sonne auf Anfang
   *                 → sie fällt herunter und geht ein zweites Mal auf
   *
   * Genau so wurde es beschrieben: „steht schon an der richtigen Position, geht
   * dann wieder runter und fährt normal rein." Es sind zwei Aufgänge
   * hintereinander, von denen der erste zu früh beginnt.
   *
   * Pausiert bleibt die Sonne für diese Öffnung unten geparkt (siehe unten), und
   * der Reveal — der die Pause beendet und den Schlüssel hochzählt — startet
   * genau einen Aufgang. Das ist auch die ursprüngliche Absicht: „Sonne kommt
   * bewusst ZULETZT, zeitgleich mit der Formular-Welle."
   */
  /**
   * Anfangswert aus der Quelle, NICHT `false`.
   *
   * Genau daran ist mein erster Anlauf gescheitert. Dieser Baum wird pro Öffnung
   * neu aufgebaut — und beim ersten Zeichnen stand hier `false`, obwohl das
   * Blatt längst fuhr. Der Effekt für die Sonne läuft im selben Durchgang, sah
   * also „nicht pausiert" und startete den Aufgang. Das Abonnement korrigierte
   * den Wert erst danach, da war es zu spät: `risenForRef` stand schon, und der
   * Reveal zählte den Schlüssel hoch — Sonne zurück auf Anfang, zweiter Aufgang.
   *
   * Mit dem echten Stand als Anfangswert ist der Baum von seinem ersten Bild an
   * pausiert. Das Abonnement meldet danach nur noch Änderungen.
   */
  // Alles, was diesen Baum stilllegen muss, steckt in `heroBusy` — siehe dort.
  const effectivePaused = paused || heroBusy || searchClosed;
  // Steuert das display:none-Gating der schweren SVG (siehe unten). true erst NACH
  // dem Reveal — WÄHREND die Box wächst bleibt der SVG aus, sonst compositet er
  // pro Frame mit und ruckelt den Expand.
  const searchContentVisible = useSearchStore((s) => s.searchContentVisible);
  const palette = TIMES[time];
  const light = palette.light;
  const seed = SEED[category] ?? 0;
  const ph = seed * 0.9;

  const stars = useMemo(() => (palette.stars ? makeStars(palette.stars) : []), [palette.stars]);

  const dunes = useMemo(
    () =>
      DUNES.map((layer, i) => {
        const top = duneTop(layer, ph + i * 1.6);
        // Beide Töne kommen UNVERÄNDERT aus der Palette — hinten hills[0],
        // vorne hills[1].
        //
        // Zwischendurch stand hier eine gerechnete Farbe für die hintere Düne
        // (erst gemischt, dann aufgehellt). Beides sah gemacht aus: Mischen
        // nahm ihr die Farbe, Aufhellen traf einen Ton, den es in der Palette
        // nicht gibt. Und vorne stand hills[2] — der dunkelste der drei, der
        // als vorderste von nur noch ZWEI Dünen zu schwer wirkt.
        //
        // Mit hills[0] und hills[1] sehen beide genau so aus wie vorher, als sie
        // die ersten beiden von drei Lagen waren. Weggefallen ist allein die
        // dunkelste, nicht die Abstufung.
        return { d: closeDune(top), top, color: palette.hills[i === 0 ? 0 : 1] };
      }),
    [category, time, ph, palette.hills],
  );

  // Sun-Rise via Reanimated (RN's Animated mit useNativeDriver hat auf
  // Fabric/New-Architecture buggy gerendert — Animation startete nicht).
  // Reanimated v4 ist explizit für Fabric gebaut → läuft zuverlässig.
  const sunRise = useSharedValue(0);
  const glowR = light.r * 2.7;
  const cloudX = 7;
  const starOpacity = 0.77;

  /**
   * Der Aufgang hängt an der ÖFFNUNG, nicht am Aufdecken.
   *
   * Vorher hing er am `riseKey`, und der zählt erst beim Aufdecken hoch — also
   * NACH der Fahrt. Während der Fahrt galten Merker und Schlüssel deshalb als
   * gleich, die Sonne wurde voll aufgegangen gezeichnet, und beim Aufdecken
   * fiel sie hart auf Anfang zurück, um ein zweites Mal aufzugehen. Genau das
   * war zu sehen: „steht schon richtig, springt runter, geht nochmal auf."
   *
   * Ein Merker, der beim ÖFFNEN hochzählt, kann das nicht: Er ist ab dem ersten
   * Bild der Fahrt anders als der zuletzt animierte Stand. Die Sonne steht
   * damit die ganze Fahrt über unten — also unsichtbar, wie gewünscht — und
   * geht erst los, wenn die Pause endet.
   */
  const openIdRef = useRef(0);
  const [openId, setOpenId] = useState(0);
  useEffect(
    () =>
      useSearchStore.subscribe((st, prev) => {
        if (prev.searchOverlayMode == null && st.searchOverlayMode != null) {
          openIdRef.current += 1;
          setOpenId(openIdRef.current);
        }
      }),
    [],
  );
  /** Für welche Öffnung der Aufgang schon gelaufen ist. */
  const risenForRef = useRef<number | null>(null);

  useEffect(() => {
    if (effectivePaused) {
      cancelAnimation(sunRise);
      /**
       * DER GRUND FÜR DEN SPRUNG DER SONNE.
       *
       * Hier stand fest `= 1`, also die Endstellung — unabhängig davon, ob die
       * Sonne für diese Öffnung überhaupt schon aufgegangen war. Beim Öffnen des
       * Such-Blattes ist der Hero aber pausiert, damit er nicht gegen die Slide
       * anläuft. Der Ablauf war deshalb:
       *
       *   Blatt fährt hoch  → pausiert → Sonne springt auf ENDstellung
       *   Blatt ist oben    → Pause endet → Sonne springt auf ANFANG zurück
       *                     → und geht dann über 700ms auf
       *
       * Man sah sie also fertig oben stehen, hinunterfallen und noch einmal
       * aufgehen. Das liest sich als Ruckler, ist aber keiner — es sind zwei
       * harte Sprünge.
       *
       * Richtig ist: die Pause hält den Stand, den die Sonne für DIESE Öffnung
       * hat. War sie schon oben (ein Picker legt sich über den Bildschirm),
       * bleibt sie oben. Steht der Aufgang noch aus (das Blatt fährt gerade
       * herein), bleibt sie unten — und geht danach von dort aus auf, ohne
       * vorher irgendwohin zu springen.
       */
      sunRise.value = risenForRef.current === openId ? 1 : 0;
      return;
    }
    if (risenForRef.current === openId) return;
    risenForRef.current = openId;
    // Sonne kommt bewusst ZULETZT — zeitgleich mit der Button-/Formular-Welle
    // (Himmel + Dünen sind über den Scrim schon vorher da). Delay ~ WAVE_DELAY.
    sunRise.value = 0;
    sunRise.value = withDelay(
      180,
      withTiming(1, { duration: 700, easing: Easing.out(Easing.cubic) }),
    );
  }, [effectivePaused, openId, sunRise]);

  // Der Aufgang bewegt eine EIGENE Ebene, nicht mehr die Kreise in der großen
  // SVG.
  //
  // Vorher hingen `cy` und `opacity` als animierte SVG-Eigenschaften direkt an
  // den Sonnen-Kreisen. Jede Wertänderung macht react-native-svg aber die
  // gesamte Zeichenfläche ungültig — 700ms lang wurde also pro Bild der ganze
  // Hero neu gerastert: Himmel-Verlauf, Radial-Glows, drei Dünen-Pfade samt
  // Konturen, Auslauf-Verlauf. Und das ausgerechnet gleichzeitig mit dem
  // Wachsen des Such-Fensters und der Einblend-Welle darüber. Wie teuer diese
  // SVG ist, steht schon im Kommentar weiter unten — sie muss sogar ausgeblendet
  // werden, wenn sie niemand sieht.
  //
  // Jetzt liegt die Sonne in einer eigenen, ansonsten leeren Ebene dazwischen.
  // Alle drei Ebenen sind statisch und werden genau einmal gerastert; bewegt
  // wird nur noch verschoben und überblendet, und das läuft auf dem UI-Thread
  // ohne Neuzeichnen.
  //
  // Die Reihenfolge bleibt dabei erhalten: Himmel/Sterne/Wolken hinten, Sonne in
  // der Mitte, Dünen davor — also weiterhin der Sonnenuntergang-hinter-den-Bergen.
  const [layoutW, setLayoutW] = useState(0);
  const onLayout = (e: LayoutChangeEvent) => setLayoutW(e.nativeEvent.layout.width);
  // Umrechnung viewBox-Einheiten → dp. preserveAspectRatio="slice" skaliert auf
  // Abdeckung, die Höhe des Containers ist exakt H — also entscheidet die Breite.
  const unit = (layoutW > 0 ? Math.max(layoutW / W, 1) : 1) * SVG_ZOOM;
  const sunLayerStyle = useAnimatedStyle(() => ({
    opacity: sunRise.value,
    transform: [{ translateY: (1 - sunRise.value) * SUN_RISE_TRAVEL * unit }],
  }));

  const warmFade = palette.warm
    ? palette.warm.col.replace(/[\d.]+\)$/, "0)")
    : null;

  /**
   * AUSGEBLENDET wird nur noch, wenn die Suche ganz zu ist.
   *
   * `pickerOpen` stand hier mit drin — beim Öffnen von Datum oder Ort wurde der
   * Himmel also schlagartig schwarz. Der Grund war echt: Das Picker-Blatt ist
   * deckend UND wird verschoben, und ein Transform hebelt Androids
   * Verdeckungs-Erkennung aus. Der Himmel wurde damit hinter dem Blatt jedes
   * Bild mit-gezeichnet, obwohl ihn niemand sieht.
   *
   * Nur ist Ausblenden nicht die einzige Antwort darauf. Der Grund fürs
   * Mitzeichnen ist nicht, DASS er da ist, sondern dass er bei jedem Bild neu
   * gerastert werden muss. Als Hardware-Ebene ist er eine fertige Bitmap, und
   * das Mitzeichnen kostet nur noch einen Kopiervorgang. Genau dafür ist
   * `heroLayer` unten da.
   *
   * Das funktioniert hier, weil in diesem Zustand nichts im Himmel animiert:
   * `effectivePaused` schließt `pickerOpen` ein, der Sonnenaufgang steht also
   * still. Eine Ebene über einem Baum, in dem sich etwas bewegt, wäre jedes Bild
   * ungültig und damit schlimmer als keine.
   */
  const svgDisplay = !searchContentVisible ? "none" : "flex";
  // Alle Ebenen teilen sich exakt dieselbe Abbildung des viewBox auf die Fläche,
  // damit die Koordinaten deckungsgleich bleiben.
  /**
   * Beide als STABILE Objekte — sonst laufen die Klammern unten ins Leere.
   *
   * Sie standen als Literale hier, waren also bei jedem Durchgang neu. Genau
   * diese beiden stehen in den Abhängigkeiten von `skyLayer` und `dunesLayer`;
   * die Klammern, die den Neuaufbau der SVG-Bäume verhindern sollten, lösten
   * sich damit bei jedem Rendern selbst auf — auch bei dem, der im Startbild
   * einer Wähler-Fahrt liegt.
   */
  const layerProps = useMemo(
    () =>
      ({
        width: "100%",
        height: "100%",
        viewBox: `0 0 ${W} ${H}`,
        preserveAspectRatio: "xMidYMid slice",
      }) as const,
    [],
  );
  const layerStyle = useMemo(
    () => ({ transform: [{ scale: SVG_ZOOM }], display: svgDisplay }) as const,
    [svgDisplay],
  );
  /** Siehe `svgDisplay`: Solange ein Picker darüber liegt, ist der Himmel eine
   *  fertige Bitmap statt eines pro Bild neu gerasterten SVG. */
  /**
   * Die Textur des Heros hängt jetzt am Textur-Modul, nicht mehr allein am
   * Speicher — und das ist der Kern des Unterschieds zum Such-Blatt.
   *
   * `pickerOpen` wird durch DENSELBEN Speicher-Schreibvorgang wahr, der auch die
   * Bewegung des Pickers auslöst. Die Ebene entstand damit im Commit direkt
   * davor, also mit genau einem Bild Vorlauf (8,3ms bei 120Hz) für einen Aufbau,
   * der hier drei SVG-Wurzeln mit Verläufen, bis zu 39 Formknoten und
   * nachts 32 Sternen umfasst. Die ersten Bilder der Fahrt zahlten den Aufbau.
   *
   * Der Schlüssel dafür ist längst da und wird 80 bis 150ms früher scharf: Die
   * Felder, die einen Picker öffnen, rufen beim BERÜHREN `prepareLayer(...)`.
   * Der Picker selbst hört darauf — der Hero als einzige Unterlage der App nicht.
   * Jetzt schon.
   *
   * Der Nachlauf deckt das Schließen ab: `pickerOpen` fällt im ersten Bild der
   * Rückfahrt, und ohne ihn verlöre der Hero seine Ebene genau dann, wenn er
   * wieder sichtbar wird.
   */
  // Textur und Pause hängen jetzt am SELBEN Signal. Vorher waren es zwei
  // Zustände mit unterschiedlichen Umschaltpunkten — und jeder Umschaltpunkt
  // war ein Neuaufbau, der die Textur wieder wegwarf. Der Nachlauf beim
  // Schließen steckt in `heroBusy` selbst.
  /**
   * KEINE eigene Textur mehr.
   *
   * Sie war richtig, solange dieser Baum die einzige Fläche unter einem Picker
   * war, die eine bekam. Inzwischen fordert der Such-Bildschirm selbst eine an,
   * sobald ein Picker anrollt (siehe `pickerBusy` dort) — und die deckt Hero UND
   * Formular ab, also auch den nur oben gerundeten Rahmen, der die eigentlichen
   * Kosten trägt.
   *
   * Zwei ineinander liegende Ebenen bringen nichts dazu: Die äußere zeichnet die
   * innere ohnehin in sich hinein. Kosten tut es trotzdem — eine zweite
   * bildschirmgroße Zuteilung, und genau dieses Anlegen ist der teure Teil (im
   * Projekt mit 66ms vermessen). Das Stilllegen der Bewegungen hängt weiterhin
   * an `heroBusy`, nur die Ebene nicht mehr.
   */
  /**
   * NACHTRAG: Die Begründung darüber verweist auf eine Textur, die es an der
   * genannten Stelle NICHT gibt.
   *
   * Sie sagt, der Such-Bildschirm fordere selbst eine an — und meint
   * `SearchHeroOverlay`, wo `renderToHardwareTextureAndroid` tatsächlich am
   * Blatt hängt (`moving || pickerBusy`). Das stimmt, und damit stimmt auch der
   * Schluss: Die äußere Ebene deckt diesen Baum mit ab, eine zweite darunter
   * brächte nichts und kostete eine weitere bildschirmgroße Zuteilung.
   *
   * Nachgeprüft und bewusst so gelassen — nicht vergessen.
   */
  const heroLayer = false;

  /**
   * Die beiden statischen Ebenen EINMAL bauen — und das ist der eigentliche
   * Fund zu den Picker-Fahrten.
   *
   * Dieser Baum ist zwar memoisiert, hört aber selbst zu: Öffnet ein Wähler,
   * meldet `setSheetMoving(true)`, `heroBusy` springt um, und der Baum rendert
   * neu. Dabei entstehen Himmel und Dünen komplett neu — Verläufe, Sterne,
   * Wolken und ein gutes Dutzend Pfade. Dieser Neuaufbau fällt in genau das
   * Bild, in dem die Fahrt startet: erst der Abgleich auf dem JS-Strang, dann
   * die Einbau-Schritte auf dem UI-Strang, dort wo die Bewegung jedes Bild
   * braucht.
   *
   * Beide hängen an nichts, was sich beim Öffnen ändert: Tageszeit, Palette,
   * Maßeinheit, Ausblendfarbe. Als gemerkte Elemente wiederverwendet React sie
   * unverändert — der Wechsel von `heroBusy` kostet dann nichts mehr als das
   * Umschalten einer Sichtbarkeit.
   */
  const skyLayer = useMemo(
    () => (
      <Svg {...layerProps} style={layerStyle}>
        <Defs>
          {/* Vertikaler Sky-Gradient (oben → unten) wie in der Vorlage —
              Farben werden über die Höhe verteilt, am Horizont (kurz vor
              den Dünen) ist's am hellsten/wärmsten, oben am Zenit dunkler. */}
          <LinearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
            {palette.sky.map(([o, c], i) => (
              <Stop key={i} offset={o} stopColor={c} />
            ))}
          </LinearGradient>
          {palette.warm && warmFade ? (
            <RadialGradient
              id="warm"
              cx={String(palette.warm.x)}
              cy={String(palette.warm.y)}
              r="0.7"
            >
              <Stop offset="0" stopColor={palette.warm.col} />
              <Stop offset="1" stopColor={warmFade} />
            </RadialGradient>
          ) : null}
        </Defs>

        <Rect x="0" y="0" width={W} height={H} fill="url(#sky)" />
        {palette.warm ? <Rect x="0" y="0" width={W} height={H} fill="url(#warm)" /> : null}

        {/* Sterne (nur nachts) */}
        {stars.length > 0 ? (
          <G opacity={starOpacity}>
            {stars.map((s, i) => (
              <Circle key={i} cx={s[0]} cy={s[1]} r={s[2]} fill="#fff" />
            ))}
          </G>
        ) : null}

        {/* Wolken (nur tagsüber/morgens — bei Sternen-Modus aus). */}
        {palette.stars === 0 ? (
          <G opacity={time === "tag" ? 0.7 : 0.45} x={cloudX}>
            {/* cy waren 132 und 100 — Werte aus dem alten, 446 hohen viewBox.
                In den jetzt 220 Einheiten lagen sie damit auf halber Höhe, also
                mitten im Motiv statt oben am Himmel. */}
            <Ellipse cx="91" cy="44" rx="74" ry="11" fill="#fff" opacity="0.12" />
            <Ellipse cx="233" cy="26" rx="56" ry="8" fill="#fff" opacity="0.10" />
          </G>
        ) : null}
      </Svg>
    ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [palette, light, layerProps, layerStyle, starOpacity, cloudX, unit],
  );

  const dunesLayer = useMemo(
    () => (
      <Svg {...layerProps} style={[StyleSheet.absoluteFill, layerStyle]} pointerEvents="none">
        {dunes.map((d, i) => (
          <G key={i}>
            <Path d={d.d} fill={d.color} />
            <Path d={d.top} fill="none" stroke={palette.rim} strokeOpacity="0.4" strokeWidth="1.4" />
          </G>
        ))}

        {/* Der Auslauf nach unten ist ENTFALLEN.
            Er blendete die vordere Düne über die letzten Einheiten in die
            App-Farbe — sinnvoll, solange das Formular unmittelbar darunter in
            genau dieser Farbe weiterging. Seit dort das Fenster mit eigener
            Farbe und harter, gerundeter Oberkante liegt, verblasste die Düne
            nur noch grundlos nach unten. Genau das las sich als „die unterste
            Düne ist zu hell". */}
      </Svg>
    ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [dunes, palette, layerProps, layerStyle, melt, unit],
  );

  return (
    <View
      onLayout={onLayout}
      style={[
        // Hintergrund = `melt` (die Screen-Hintergrundfarbe, vom Aufrufer je nach
        // Theme gesetzt). Fest verdrahtet wäre er bei „Dark" sichtbar heller
        // als der Screen.
        { width: "100%", height: H, backgroundColor: melt, overflow: "hidden" },
        style,
      ]}
      // Siehe `heroLayer`: als fertige Bitmap kostet das Mitzeichnen hinter dem
      // Picker-Blatt nur noch einen Kopiervorgang statt einer Neurasterung.
      // NUR währenddessen — dauerhaft müsste die Bitmap bei jeder Änderung im
      // Formular neu entstehen.
      renderToHardwareTextureAndroid={heroLayer}
    >
      {/* Die schweren Hero-SVGs (Verlauf/Sonne/Glows/Dünen) bleiben IMMER gemountet,
          werden aber per display:none schlafen gelegt, wenn sie niemand sieht.
          react-native-svg hält nach dem ERSTEN Zeichnen ein teures Hardware-Layer,
          das Android auch unter opacity 0 pro Frame mit-compositet — das kostet an
          ZWEI Stellen:
          - Landing-Scroll: bei geschlossener Suche (SVG einmal gezeichnet) laggte
            der Scroll dauerhaft (im Release verifiziert).
          - Expand-Wachstum: WÄHREND die Box wächst ist die Suche zwar offen, der
            Content-Wrapper aber noch opacity 0 (Reveal kommt erst am Ende). Stünde
            der SVG hier schon auf flex, würde er pro Frame mit-compositet und genau
            den Expand rucklig machen (transform am Splash brachte deshalb nichts —
            die Kosten waren der SVG, nicht der Splash).
          Deshalb hängt das Gate an searchContentVisible (true erst beim Reveal),
          nicht an searchClosed. Zusätzlich pickerOpen aus (opakes, TRANSFORMIERTES
          Picker-Sheet defeated Occlusion-Culling). display:none statt Unmount →
          SVG bleibt gemountet (kein Remount-Ruckler), Layer wird aber freigegeben. */}

      {/* HINTEN — Himmel, Sterne, Wolken. Statisch. */}
      {skyLayer}

      {/* MITTE — Sonne / Mond. Einzige bewegte Ebene: Der Aufgang verschiebt und
          blendet diese View, ihr Inhalt wird nie neu gezeichnet. Die Kreise stehen
          auf ihrer ENDposition; den Weg macht der Transform. */}
      <Reanimated.View
        pointerEvents="none"
        style={[StyleSheet.absoluteFill, { display: svgDisplay }, sunLayerStyle]}
      >
        <Svg {...layerProps} style={{ transform: [{ scale: SVG_ZOOM }] }}>
          <Defs>
            <RadialGradient id="glow" cx="0.5" cy="0.5" r="0.5">
              <Stop offset="0" stopColor={light.glow} stopOpacity="0.8" />
              <Stop offset="1" stopColor={light.glow} stopOpacity="0" />
            </RadialGradient>
          </Defs>
          <Circle cx={light.cx} cy={light.cy} r={glowR} fill="url(#glow)" opacity={0.8} />
          <Circle cx={light.cx} cy={light.cy} r={light.r} fill={light.core} />
        </Svg>
      </Reanimated.View>

      {/* VORNE — Dünen und Auslauf. Statisch, liegt ÜBER der Sonne: Nur ihr
          oberster Teil ragt über die hinterste Dünen-Linie hinaus. */}
      {dunesLayer}

    </View>
  );
}

// memo verhindert Re-Renders wenn SearchHero seinen State ändert (z.B.
// pickerField oder Segment-Wechsel). Der schwere SVG-Tree muss nur bei
// wirklicher Prop-Änderung neu durchlaufen werden.
export const BinchHero = memo(BinchHeroComponent);
