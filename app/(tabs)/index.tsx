import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  View,
  Text,
  Dimensions,
  PixelRatio,
  Pressable,
  StatusBar,
  StyleSheet,
  Image,
  ImageBackground,
  useWindowDimensions,
  type GestureResponderEvent,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import {
  Bell,
  Plane,
  Train,
  Bus,
  Ship,
  Heart,
  ChevronDown,
  ChevronUp,
  type LucideIcon,
} from "lucide-react-native";
import { SearchBar } from "@/components/SearchBar";
import { OnFocusLost } from "@/lib/nav/FocusSentinel";
import { markTransitionBusy } from "@/lib/nav/transitionBusy";
import {
  resultsPush,
  assistantPush,
  armAssistantPush,
  startAssistantPush,
  searchHeroPush,
  startSearchHeroPush,
  pushProgress,
  UNDERLAY_TRAVEL_FRAC,
} from "@/lib/nav/overlayCover";
import { isSearchHandoff } from "@/lib/nav/searchHandoff";
import { LinearGradient } from "expo-linear-gradient";
import Animated, {
  FadeInDown,
  FadeOutUp,
  useAnimatedReaction,
  useAnimatedStyle,
  useSharedValue,
  runOnJS,
  withSequence,
  withSpring,
  withTiming,
  withDelay,
  useDerivedValue,
  Easing,
  type SharedValue,
} from "react-native-reanimated";
import { useT } from "@/lib/i18n/useT";
import { haptic } from "@/lib/haptics";
import { GUTTER, SPACE, HEADING_TOP, HEADING_GAP, useNavbarSpace } from "@/lib/theme/spacing";
import { ScreenHeading, HEADING_LINE_HEIGHT } from "@/components/ui/ScreenHeading";
import { MOTION } from "@/lib/motion";
import { RippleTouch } from "@/components/ui/RippleTouch";
import { GradientFill } from "@/components/ui/GradientFill";
import { RecentCard } from "@/components/home/RecentCard";
import { useSearchStore, type SearchOverlayLaunch } from "@/stores/searchStore";
import { TravelMode } from "@/types/search";
import { useAccent } from "@/lib/theme/accent";
import { useAppBg, usePalette } from "@/lib/theme/appBg";
import { fs, ms, scaledStyles } from "@/lib/ui/compact";

// === Design Tokens ============================================================
const C = {
  bg: "#0D0D0D",
  surface1: "#171719",
  surface2: "#171719",
  surface3: "#212123",
  border: "#212123",
  lime: "#7FEA4D",
  limePressed: "#3ED35A",
  white: "#F4F4F5",
  gray1: "#C8C8CC",
  gray2: "#8E8E93",
  gray3: "#56565C",
  black: "#000000",
};

const FONT = {
  medium: "500" as const,
  semibold: "600" as const,
  bold: "700" as const,
  extrabold: "800" as const,
};

const MODE_ICON: Record<TravelMode, LucideIcon> = {
  FLIGHT: Plane,
  TRAIN: Train,
  BUS: Bus,
  CRUISE: Ship,
};

/** Beschriftung zum Symbol — dieselben Schlüssel, die auch die Tab-Leiste nutzt. */
const MODE_LABEL: Record<TravelMode, string> = {
  FLIGHT: "mode.flights",
  TRAIN: "mode.trains",
  BUS: "mode.buses",
  CRUISE: "mode.cruises",
};

type CategoryId = "ocean" | "mountain" | "forest" | "city";

interface Destination {
  id: string;
  city: string;
  country: string;
  /** Landesflagge als Emoji — steht in der Kopfzeile vor dem Landesnamen. */
  flag: string;
  priceFrom: number;
  currency: string;
  // String = Remote-URL (Unsplash etc.), number = lokales require()-Asset.
  imageUrl: string | number;
  popular?: boolean;
  mode: TravelMode;
}

// Stock-Daten pro Kategorie. Echte Backend-Anbindung folgt — diese Listen
// dienen erstmal nur dazu, das visuelle Verhalten (Slide-Animation,
// Kategorie-Switch) zu simulieren.
const DESTINATIONS_BY_CATEGORY: Record<CategoryId, Destination[]> = {
  ocean: [
    {
      id: "tenerife",
      city: "Teneriffa",
      country: "Spanien",
      flag: "🇪🇸",
      priceFrom: 89,
      currency: "EUR",
      imageUrl: "https://images.unsplash.com/photo-1593693397690-362cb9666fc2?w=900&q=80",
      popular: true,
      mode: "FLIGHT",
    },
    {
      id: "bali",
      city: "Bali",
      country: "Indonesien",
      flag: "🇮🇩",
      priceFrom: 612,
      currency: "EUR",
      imageUrl: "https://images.unsplash.com/photo-1537996194471-e657df975ab4?w=900&q=80",
      mode: "FLIGHT",
    },
    {
      id: "mykonos",
      city: "Mykonos",
      country: "Griechenland",
      flag: "🇬🇷",
      priceFrom: 219,
      currency: "EUR",
      imageUrl: "https://images.unsplash.com/photo-1601581875309-fafbf2d3ed3a?w=900&q=80",
      mode: "FLIGHT",
    },
    {
      id: "maldives",
      city: "Malediven",
      country: "Indischer Ozean",
      flag: "🇲🇻",
      priceFrom: 749,
      currency: "EUR",
      imageUrl: "https://images.unsplash.com/photo-1514282401047-d79a71a590e8?w=900&q=80",
      mode: "FLIGHT",
    },
  ],
  mountain: [
    {
      id: "zermatt",
      city: "Zermatt",
      country: "Schweiz",
      flag: "🇨🇭",
      priceFrom: 119,
      currency: "EUR",
      imageUrl: "https://images.unsplash.com/photo-1530122037265-a5f1f91d3b99?w=900&q=80",
      popular: true,
      mode: "TRAIN",
    },
    {
      id: "innsbruck",
      city: "Innsbruck",
      country: "Österreich",
      flag: "🇦🇹",
      priceFrom: 69,
      currency: "EUR",
      imageUrl: require("@/assets/destinations/innsbruck.jpg"),
      mode: "TRAIN",
    },
    {
      id: "chamonix",
      city: "Chamonix",
      country: "Frankreich",
      flag: "🇫🇷",
      priceFrom: 99,
      currency: "EUR",
      imageUrl: "https://images.unsplash.com/photo-1551524559-8af4e6624178?w=900&q=80",
      mode: "TRAIN",
    },
    {
      id: "banff",
      city: "Banff",
      country: "Kanada",
      flag: "🇨🇦",
      priceFrom: 689,
      currency: "EUR",
      imageUrl: "https://images.unsplash.com/photo-1561134643-668f9057cce4?w=900&q=80",
      mode: "FLIGHT",
    },
  ],
  forest: [
    {
      id: "blackforest",
      city: "Schwarzwald",
      country: "Deutschland",
      flag: "🇩🇪",
      priceFrom: 49,
      currency: "EUR",
      imageUrl: "https://images.unsplash.com/photo-1469474968028-56623f02e42e?w=900&q=80",
      mode: "TRAIN",
    },
    {
      id: "patagonia",
      city: "Patagonien",
      country: "Argentinien",
      flag: "🇦🇷",
      priceFrom: 899,
      currency: "EUR",
      imageUrl: "https://images.unsplash.com/photo-1483683804023-6ccdb62f86ef?w=900&q=80",
      mode: "FLIGHT",
    },
    {
      id: "lapland",
      city: "Lappland",
      country: "Finnland",
      flag: "🇫🇮",
      priceFrom: 329,
      currency: "EUR",
      imageUrl: "https://images.unsplash.com/photo-1483347756197-71ef80e95f73?w=900&q=80",
      mode: "FLIGHT",
    },
    {
      id: "costarica",
      city: "Costa Rica",
      country: "Mittelamerika",
      flag: "🇨🇷",
      priceFrom: 599,
      currency: "EUR",
      imageUrl: "https://images.unsplash.com/photo-1518182170546-07661fd94144?w=900&q=80",
      mode: "FLIGHT",
    },
  ],
  city: [
    {
      id: "ny",
      city: "New York",
      country: "USA",
      flag: "🇺🇸",
      priceFrom: 456,
      currency: "USD",
      imageUrl: "https://images.unsplash.com/photo-1496442226666-8d4d0e62e6e9?w=900&q=80",
      popular: true,
      mode: "FLIGHT",
    },
    {
      id: "tokyo",
      city: "Tokio",
      country: "Japan",
      flag: "🇯🇵",
      priceFrom: 689,
      currency: "EUR",
      imageUrl: "https://images.unsplash.com/photo-1540959733332-eab4deabeeaf?w=900&q=80",
      mode: "FLIGHT",
    },
    {
      id: "berlin",
      city: "Berlin",
      country: "Deutschland",
      flag: "🇩🇪",
      priceFrom: 29,
      currency: "EUR",
      imageUrl: "https://images.unsplash.com/photo-1560969184-10fe8719e047?w=900&q=80",
      mode: "TRAIN",
    },
    {
      id: "bangkok",
      city: "Bangkok",
      country: "Thailand",
      flag: "🇹🇭",
      priceFrom: 598,
      currency: "EUR",
      imageUrl: "https://images.unsplash.com/photo-1508009603885-50cf7c579365?w=900&q=80",
      mode: "FLIGHT",
    },
  ],
};

/**
 * Der Stapel — Geometrie, am Entwurf ABGEMESSEN statt geschätzt.
 *
 * Der Entwurf zeigt die Telefonbreite auf 275 Bildpunkten, die vorderste Karte
 * auf 246 — also 0,894 der Breite, was bei 390 Punkten Bildschirm und 20
 * Punkten Rand genau hinkommt. Ein Bildpunkt im Entwurf sind damit 1,42 Punkte.
 * Daraus gerechnet:
 *
 *   - Einzug je Stufe:  7-8 Bildpunkte je Seite  →  rund 10 Punkte
 *   - Höhe je Streifen: 33-41 Bildpunkte         →  rund 47 bis 58 Punkte
 *   - Herztaste:        26 Bildpunkte             →  rund 37 Punkte
 *
 * Und der Entwurf zeigt DREI Karten, nicht vier: zwei Streifen plus die
 * vorderste. Das ist der eigentliche Grund, warum die Treppe hier zu steil
 * aussah — nicht die einzelne Stufe, sondern ihre Anzahl. Bei vier Karten
 * stapeln sich drei Stufen, und der Blick liest die Summe, nicht den Schritt.
 *
 * Übernommen: Streifen 52, Herz und Landespille 38 (also fast so hoch wie der
 * Buchen-Knopf mit seinen 40 — sie standen vorher bei 30 und 25 und waren neben
 * ihm sichtbar zu leicht), drei Karten. Der Einzug liegt mit 8 UNTER dem
 * gemessenen Wert: Bei nur noch zwei Stufen verjüngt sich der Stapel insgesamt
 * um 16 Punkte je Seite statt um 24 — die Neigung je Stufe ist damit flacher
 * als im Entwurf, und genau das war die Bitte.
 *
 * `ms()` von Hand, weil diese Zahlen NICHT im Stilblatt stehen: Sie gehen in
 * gerechnete Werte (Stapelhöhe, Versatz je Stufe), und `scaledStyles` greift
 * nur auf feste Einträge.
 */
/** Höhe von Landespille UND Herztaste — dieselbe Zahl, das ist der Punkt. */
const DECK_CTRL_RAW = 38;
/**
 * EIN Abstand zum Kartenrand — für alles, was den Rand berührt.
 *
 * Der Wert ist der, den der Buchen-Knopf schon immer zur Seite hatte. Jetzt
 * gilt er in alle vier Richtungen und für beide Enden der Karte: oben für
 * Landespille und Herz, unten für das Textfeld. Damit sitzt kein Element der
 * Karte näher an einer Kante als ein anderes.
 */
const DECK_CARD_INSET = 18;
/**
 * Der Streifen, bei dem die Landespille bündig abschließt.
 *
 * Vorlauf plus Taste: Steht eine Karte genau so weit über der Karte davor, dann
 * endet ihre Pille exakt an deren Oberkante. Das ist der Nullpunkt, von dem aus
 * gerechnet wird.
 */
const DECK_FLUSH_RAW = DECK_CARD_INSET + DECK_CTRL_RAW;

/**
 * Zeilenhöhe des Landesnamens — FEST, nicht dem Zeichensatz überlassen.
 *
 * Sie steht hier, weil die hinterste Stufe darauf zielt (siehe DECK_SINK) und
 * eine gerechnete Kante nur so genau ist wie die Zahl, aus der sie kommt. Ohne
 * Vorgabe bestimmt der Zeichensatz die Zeilenhöhe, und die weiß hier niemand.
 *
 * 14 zu Schriftgrad 12 ist die NATÜRLICHE Zeile des Zeichensatzes (Roboto:
 * 0,927 Oberlänge plus 0,244 Unterlänge, macht 1,171 em). Genau darum diese
 * Zahl und keine luftigere: Der Zeilenkasten fällt damit mit dem Buchstabenkasten
 * zusammen, und die Unterkante, auf die der Stapel zielt, ist dann wirklich die
 * Unterkante der Schrift statt ein paar Punkte Luft darunter.
 *
 * `includeFontPadding: false` gehört dazu — Android legt sonst noch einmal
 * Polster um die Zeile, und der Text säße nicht mehr genau mittig in der Pille.
 */
const DECK_LABEL_SIZE = 12;
const DECK_LABEL_LINE = 14;
/**
 * Unterlänge als Anteil der Schriftgröße — Robotos Metrik.
 *
 * Steht als Zahl da, weil aus ihr eine Kante wird und man einer Kante ansehen
 * können muss, woher sie kommt. Bei einem anderen Zeichensatz gehört sie
 * getauscht; bleibt sie stehen, wandert der Stapel um den Unterschied.
 */
const FONT_DESCENT = 0.244;

/**
 * Unterkante der Textzeile, von der Oberkante der eigenen Karte aus gemessen.
 *
 * Vorlauf, halbe Pille (der Text sitzt mittig darin), halbe Zeile.
 *
 * Zwei Kanten, keine eine — die Buchstaben haben unten zwei davon:
 *
 *   - `BOTTOM` ist die Unterkante der UNTERLÄNGEN, also des Zeilenkastens. Bis
 *     dahin kann nichts angeschnitten werden, auch kein „y" in „Uruguay".
 *   - `BASELINE` ist der Grundstrich, knapp drei Punkte höher. Darauf steht
 *     „Spanien" auf; die drei Punkte darunter sind reiner Unterlängen-Platz.
 *
 * Der Stapel zielt auf den GRUNDSTRICH — der Schriftzug sitzt damit sichtbar
 * auf der Kante der Karte davor, statt darüber zu schweben. Der Preis: Bei
 * einem Namen mit Unterlänge wird deren Schwanz von der vorderen Karte
 * verdeckt. Keiner der aktuellen Namen hat eine; kommt das Backend mit
 * „Uruguay", ist `DECK_LABEL_BOTTOM` die Zeile, die den Fall zurückholt.
 *
 * BEIDE stehen in GERÄTEPUNKTEN, nicht in Rohwerten — und das ist der Grund,
 * warum das Ganze auf kurzen Geräten überhaupt trägt. Die Fläche geht dort über
 * `ms()`, die Schrift über `fs()`, also über zwei verschiedene Kurven. Rechnet
 * man die Kante aus Rohwerten und skaliert erst das Ergebnis, rundet man beide
 * unabhängig voneinander — im Durchlauf über 0,80 bis 1,00 lief das um bis zu
 * einen Punkt in die Buchstaben. Hier gerechnet, ist der Fehler durch das
 * Runden auf ganze Punkte begrenzt, also höchstens ein halber.
 */
const DECK_LABEL_BOTTOM = ms(DECK_CARD_INSET) + ms(DECK_CTRL_RAW) / 2 + fs(DECK_LABEL_LINE) / 2;
const DECK_LABEL_BASELINE = DECK_LABEL_BOTTOM - fs(DECK_LABEL_SIZE) * FONT_DESCENT;
/**
 * Ein Punkt Luft unter dem Grundstrich.
 *
 * Genau auf dem Grundstrich sah es zu knapp aus — die Buchstaben standen nicht
 * auf der Kante, sie klebten daran. Der eine Punkt kostet nichts und bringt
 * nebenbei die Sicherheit zurück, die das Runden gefressen hatte: Über den
 * ganzen Bereich von 0,80 bis 1,00 lag die Kante bis zu einem Drittelpunkt ÜBER
 * dem Grundstrich, schnitt also minimal in die Buchstaben. Mit dem Punkt liegt
 * sie überall darunter.
 */
const DECK_LABEL_CLEARANCE = 1;

/**
 * Der sichtbare Streifen je Stufe, in Gerätepunkten — die Geometrie des Stapels.
 *
 * Die vorderste Karte hat keinen: Auf ihr liegt nichts, sie ist der Boden.
 *
 * Die mittlere steht über ihre VERDECKUNG da: Von ihrer Pille deckt die
 * vorderste 7 Punkte zu. So gerechnet und nicht als Streifenhöhe gesetzt, weil
 * das die Größe ist, die man am Gerät beurteilt.
 *
 * Die hinterste ist nicht gesetzt, sondern gezielt: Die Oberkante der Karte
 * davor landet auf dem Grundstrich ihres Landesnamens. Der Schriftzug sitzt
 * damit auf der Kante statt darüber zu schweben — und weil die Zahl aus Pille,
 * Zeilenhöhe und Unterlänge kommt statt fest dazustehen, hält das auch, wenn am
 * Schriftgrad einmal jemand dreht.
 */
const DECK_PEEK = [
  0,
  ms(DECK_FLUSH_RAW - 7),
  Math.round(DECK_LABEL_BASELINE) + DECK_LABEL_CLEARANCE,
];

/**
 * Wie viele Karten im Stapel liegen — die Länge der Geometrie oben.
 *
 * Die Kategorien haben je vier Ziele; das vierte liegt hinter dem Stapel und
 * ist damit aus der Sektion heraus. Ein vierter Streifen kostet eine weitere
 * Stufe in der Treppe, und die war schon zweimal zu steil. Der Entwurf zeigt
 * ebenfalls drei.
 *
 * Aus der Länge gelesen statt daneben gesetzt: Sonst gäbe es zwei Zahlen, die
 * zueinander passen müssen, und die eine davon wäre eine Stufe ohne Maße.
 */
const DECK_MAX = DECK_PEEK.length;

/**
 * Platz je Stufe — beim Laden einmal aufsummiert.
 *
 * `top` wird von OBEN gemessen: Die hinterste Karte sitzt bei 0, die vorderste
 * ganz unten, jede Stufe dazwischen einen Streifen tiefer.
 */
/**
 * Höhe einer Karte — im Stapel wie aufgefächert dieselbe.
 *
 * 285 statt 320, und die 35 Punkte Differenz sind gerechnet, nicht geschätzt.
 *
 * Der Abstand unter der letzten Karte war die ganze Zeit da — man sah ihn nur
 * nicht, weil die Seite ein Stück höher war als der Bildschirm. Bei einer
 * scrollenden Seite liegt das letzte Element samt seinem unteren Rand unter der
 * Falz; sichtbar wurde er erst, wenn man ganz nach unten schob. Weil die
 * Unterkante der Karte dabei fast genau auf der Leiste landete, las sich das
 * nicht als „da geht es weiter", sondern als „der Abstand fehlt".
 *
 * Die Rechnung: `UI_SCALE` ist definitionsgemäß Fensterhöhe durch 900, die
 * Fensterhöhe also 900 mal Skala. Alle Maße der Seite laufen durch `ms` und
 * skalieren mit — die sicheren Flächen oben und unten nicht. Für die Rohmaße
 * bleiben damit rund 840 Punkte Platz, und die Seite stand bei rund 875. Genau
 * diese 35 nimmt die Karte zurück.
 *
 * Weil die Rechnung über die Skala geht statt über ein bestimmtes Gerät, hält
 * sie über die Gerätegrößen hinweg. Was sie NICHT auffangen kann: Sobald
 * Einträge im Verlauf stehen, ist die Seite ohnehin länger als der Bildschirm
 * und scrollt — dann liegt der Abstand wieder unter der Falz, und das ist bei
 * einer langen Seite auch richtig so.
 */
const DECK_CARD_H = ms(285);
/** Seitlicher Einzug je Stufe, in Gerätepunkten. */
const DECK_INSET = ms(8);
/**
 * Breite der Stapelfläche.
 *
 * Einmal beim Laden aus der Fensterbreite gelesen — die Ausrichtung ist auf
 * Hochkant festgelegt (`app.config.js`), sie ändert sich also nicht. Gebraucht
 * wird sie, um den Einzug in einen MASSSTAB umzurechnen (siehe DECK_SQUEEZE).
 */
const DECK_W = Dimensions.get("window").width - 2 * ms(GUTTER);

const DECK_ROWS = (() => {
  const rise = [0];
  for (let depth = 1; depth < DECK_MAX; depth++) rise.push(rise[depth - 1] + DECK_PEEK[depth]);
  return { rise: rise[DECK_MAX - 1], top: DECK_PEEK.map((_, d) => rise[DECK_MAX - 1] - rise[d]) };
})();
const DECK_RISE = DECK_ROWS.rise;
/**
 * Senkrechte Lage je Stufe — als ZAHL, nicht als `top` im Stil.
 *
 * Sie stand als Layout-Wert am Platz der Karte. Solange nur auf- und zugeklappt
 * wurde, fiel das nicht auf: Der Wert änderte sich nie. Mit dem Ring ändert er
 * sich bei jedem Wischen — und als Layout-Wert wäre jeder Wisch wieder ein
 * Messlauf über den halben Kartenbaum. Als Verschiebung ist er frei.
 */
const DECK_TOP = DECK_ROWS.top;

/**
 * Höhe der Stapelfläche im eingefahrenen Zustand — als eigenes Objekt, NICHT
 * im Stilblatt. Beide Summanden sind bereits heruntergerechnet; im Stilblatt
 * bekämen sie den Faktor ein zweites Mal. Sie steht als statischer Startwert
 * unter dem animierten Stil, damit die Fläche im ersten Bild schon richtig ist.
 */
const DECK_CLOSED = { height: DECK_CARD_H + DECK_RISE } as const;
/** Kartengröße im Platz — für alle Stufen gleich, deshalb hier statt je Stufe. */
const DECK_SLOT_BOX = { height: DECK_CARD_H } as const;

/**
 * Der seitliche Einzug als MASSSTAB statt als Layout-Wert.
 *
 * Das ist der teuerste Posten der ganzen Animation gewesen. Vorher liefen
 * `left` und `right` je Bild durchs Worklet — beides Layout-Werte. Zwei der
 * drei Karten wurden dadurch in JEDEM Bild neu vermessen, und in einer Karte
 * stecken sechs Textabsätze. Androids Textmessung ist ein Sprung in die
 * Laufzeitumgebung, und der Zwischenspeicher greift nicht: Sein Schlüssel
 * enthält die verfügbare Breite, und die war jedes Bild eine andere.
 *
 * Besonders absurd bei der hintersten Karte: Sie bewegt sich senkrecht gar
 * nicht (`travel` ist 0) und zahlte den vollen Preis allein für 16 Punkte
 * Breite.
 *
 * Ein Maßstab ist eine Eigenschaft der Zeichenliste — kein Layout, keine
 * Messung. Dass er den Karteninhalt mitstaucht, ist bei Foto und Verlauf
 * folgenlos; Landespille und Herz bekommen den Maßstab weiter unten wieder
 * herausgerechnet, damit an ihnen nichts schmaler wird.
 */
const DECK_SQUEEZE = DECK_TOP.map((_, depth) => 1 - (2 * DECK_INSET * depth) / DECK_W);

/**
 * Der Ring.
 *
 * Sichtbar sind drei Stufen, im Ring laufen ALLE Ziele einer Kategorie. Das
 * vierte lag bisher hinter dem Stapel und war damit tote Daten — jetzt kommt es
 * durch Wischen nach vorn.
 *
 * Karten jenseits der dritten Stufe sitzen auf demselben Platz wie die dritte
 * und liegen dahinter. Sie sind damit vollständig verdeckt — und werden genau
 * dadurch sichtbar, wenn die Karte davor nach vorn rückt. Es braucht kein
 * Ein- und Ausblenden.
 */
/**
 * Rest im Ring. JavaScripts `%` liefert bei negativen Zahlen ein negatives
 * Ergebnis — hier wird aber immer nach vorne gezählt.
 */
function modSlot(v: number, n: number): number {
  "worklet";
  const r = v % n;
  return r < 0 ? r + n : r;
}
/**
 * Ein Bildpunkt des Geräts — die Rasterweite, auf die alle Wege gerundet werden.
 *
 * Hier liegt die Ursache des „griseligen" Ein-Punkt-Streifens an der Unterkante,
 * und zwar auch an Karten, die sich GAR NICHT drehen: Eine Verschiebung ist eine
 * Fließkommazahl. Landet die Unterkante einer Karte zwischen zwei Bildpunkten,
 * deckt sie die letzte Reihe nur teilweise ab — der Zeichenstrang mischt dort
 * das dunkle Ende des Verlaufs mit dem, was dahinter liegt, und heraus kommt
 * genau ein Punkt hoher, unruhiger Saum. Dasselbe trifft die Haarlinie des
 * Textfeldes, die ebenfalls einen Punkt misst.
 *
 * Auf ganze Gerätepunkte gerundet gibt es keine Teilabdeckung mehr, die Kante
 * ist entweder da oder nicht. Sichtbar kostet das nichts: Die Rasterweite
 * beträgt bei diesem Gerät rund 0,42 Punkte, die Bewegung wird also um weniger
 * gerastert, als das Display ohnehin auflöst.
 */
const DECK_PX = 1 / PixelRatio.get();

/**
 * WICHTIG: `DECK_PX` steht ÜBER dieser Funktion, nicht darunter.
 *
 * Genau das war eben der Fehler, der die Karten unsichtbar gemacht hat. Ein
 * Worklet greift die Werte, die es benutzt, beim ANLEGEN ab — und angelegt wird
 * es, sobald die Datei ausgewertet wird. Stand die Konstante achtzig Zeilen
 * weiter unten, war sie zu diesem Zeitpunkt noch nicht da: Die Rundung lieferte
 * „keine Zahl", der Stil wurde ungültig, und die Karten blieben auf ihrer
 * statischen Startdeckkraft stehen — also auf null.
 */
/** Auf das Bildpunkt-Raster runden — siehe DECK_PX. */
function snapPx(v: number): number {
  "worklet";
  return Math.round(v / DECK_PX) * DECK_PX;
}
function deckSlotOf(b: number): number {
  "worklet";
  return b < DECK_MAX ? b : DECK_MAX - 1;
}
/**
 * Wie weit die abgehende Karte fährt — deutlich WEITER als der Bildschirm breit ist.
 *
 * Das ist kein Übermut, sondern der Sicherheitsabstand für die
 * Zeichenreihenfolge. Die kommt aus React und hinkt der Bewegung ein bis zwei
 * Bilder hinterher; solange sie noch alt ist, gilt die abgegangene Karte
 * weiterhin als die vorderste und läge damit OBEN auf der neuen dritten Stufe.
 * Genau so weit vom Bildrand weg, dass das nicht zu sehen ist: Umgeschaltet
 * wird, sobald die Karte vollständig draußen ist (bei 60% des Wegs), und von
 * dort bleiben bis zum Ende der Kurve rund 60 Millisekunden Luft.
 *
 * Der Versuch, das auf dem UI-Strang zu rechnen und diesen Vorlauf damit
 * überflüssig zu machen, ist gescheitert — nicht an der Rechnung, sondern an
 * der Zustellung. Siehe die Eigenschaft `z` an der Karte.
 *
 * Dass die Karte dem Finger trotzdem eins zu eins folgt, bleibt erhalten: Der
 * Fortschritt wird an DERSELBEN Strecke gemessen, mit der er hier multipliziert
 * wird — beides kürzt sich weg.
 */
const DECK_EXIT_X = Dimensions.get("window").width * 1.6;
/** Ab hier ist die Karte sicher draußen — Zeichenreihenfolge darf umschalten. */
const DECK_Z_FLIP = 0.6;
/**
 * Das Nachrücken läuft auf einer EIGENEN Zahl, nicht auf der des Abgangs.
 *
 * Erst hingen beide an derselben, und das ging in beide Richtungen schief. Die
 * abgehende Karte folgt dem Finger eins zu eins und braucht dafür mehr als eine
 * Bildschirmbreite; wer 100 Punkte zieht, hat davon ein Sechstel geschafft — die
 * Karten dahinter rückten also um sieben Punkte vor und wirkten taub. Rechnet
 * man das Nachrücken auf einer kürzeren Strecke, ist es beim Loslassen schon
 * fast fertig und legt den Rest in fünfundzwanzig Millisekunden zurück: ein
 * Schnappen.
 *
 * Zwei Zahlen lösen beides. Beide zählen vom selben ganzzahligen Stand, und das
 * Nachrücken liest sich als Abstand zu diesem Stand — dadurch stellt es sich
 * beim Weiterzählen von selbst zurück, ohne dass irgendwo ein Wert im richtigen
 * Bild genullt werden müsste.
 *
 * Wichtig ist nur eines: Das Nachrücken muss VOR dem Abgang fertig sein. Sonst
 * springt beim Weiterzählen jede Karte um den Rest, der noch offen war.
 */
const DECK_ADVANCE_DIST = DECK_W * 0.7;
/** Nachrücken nach dem Loslassen — eine Zeitkurve, es soll sich setzen, nicht fliegen. */
const DECK_ADVANCE_IN = { duration: 260, easing: MOTION.easing } as const;
/** Spätestens hier ist das Nachrücken durch, unabhängig von der eigenen Zahl. */
const DECK_ADVANCE_BY = 0.5;
/**
 * Kippwinkel beim Abgang, in Grad — und der Weg, auf dem er möglich wurde.
 *
 * Er war schon einmal drin und flog wieder raus, weil die Kanten der Karte
 * flackerten. Die Ursache stand im Projekt schon beschrieben: Ein gerundeter
 * Clip (`overflow: hidden` plus Eckradius) rendert unter einer Verformung
 * fehlerhaft. Beim Verschieben fällt das nicht auf — eine Verschiebung bleibt
 * achsenparallel, der Clip lässt sich unverändert weiterverwenden. Eine Drehung
 * tut das nicht.
 *
 * Die Kippung war aber nicht der Fehler, sondern was sie sichtbar gemacht hat.
 * Weggenommen ist deshalb jetzt der CLIP: Bild und Verlauf runden sich selbst,
 * nativ, ohne Beschneidung (siehe `card` im Stilblatt). Damit gibt es unter der
 * Drehung nichts mehr neu zu bestimmen — und die Karte darf kippen.
 */
const DECK_EXIT_TILT = 9;
/** Zusätzlich ein leichtes Zurücktreten. Achsenparallel, also für nichts ein Problem. */
const DECK_EXIT_SHRINK = 0.05;
/** Ab dieser Strecke gilt der Wisch als vollzogen, sonst federt die Karte zurück. */
const DECK_SWIPE_TRIGGER = DECK_W * 0.3;
/** Ab dieser Geschwindigkeit zählt auch ein kurzer Wisch. */
const DECK_SWIPE_FLICK = 700;
/**
 * Abgang und Rückkehr laufen als FEDER, nicht als Zeitkurve.
 *
 * Der Grund ist die Geschwindigkeit beim Loslassen. Eine Zeitkurve kennt sie
 * nicht: Sie fängt immer bei null an, egal wie schnell die Hand war. Wer die
 * Karte schnippt, sieht sie im Moment des Loslassens also abbremsen und dann
 * neu anlaufen — genau der Bruch, der sich als „nicht flüssig" liest, obwohl
 * kein Bild fehlt. Eine Feder übernimmt die Geschwindigkeit und führt sie
 * weiter; die Bewegung geht ohne Naht aus der Hand in die Animation über.
 *
 * `overshootClamping` ist bei BEIDEN gesetzt, und das ist keine Geschmacksfrage:
 * Der Ring-Stand ist eine fortlaufende Zahl, deren Ganzzahlanteil sagt, welche
 * Karte vorn liegt. Schwingt die Feder über das Ziel hinaus, springt dieser
 * Anteil um eins — beim Abgang begänne die neu aufgerückte Karte sofort selbst
 * zu verschwinden, bei der Rückkehr rutschte der ganze Stapel eine Stufe. Ein
 * Nachschwingen ist hier also nicht bloß Geschmack, sondern ein Zustandsfehler.
 *
 * Die Feder ist leicht unterdämpft (Dämpfungsgrad rund 0,9): Sie läuft zügig
 * an und legt sich weich ins Ziel, statt sich überdämpft heranzuschleichen.
 */
const DECK_SWIPE_OUT = {
  damping: 15,
  stiffness: 120,
  mass: 0.6,
  overshootClamping: true,
} as const;
const DECK_SWIPE_BACK = {
  damping: 17,
  stiffness: 200,
  mass: 0.7,
  overshootClamping: true,
} as const;

/**
 * Der aufgefächerte Zustand — dieselben Karten, nur nebeneinander statt
 * ineinander.
 *
 * Die HINTERSTE Karte bleibt stehen. Sie sitzt im Stapel schon ganz oben, und
 * oben ist auch ihr Platz in der Liste — sie hat also gar keinen Weg, sie wird
 * nur breit. Die beiden davor holen ihren Weg von unten nach, und weil sie
 * dieselbe Kurve zur selben Zeit fahren, kommen sie gemeinsam an.
 *
 * Der Abstand ist derselbe 16er, der schon unter dem Stapel steht — sonst säße
 * die letzte Karte anders zur Leiste als die Karten zueinander.
 */
const DECK_GAP = ms(16);
const DECK_OPEN_H = DECK_MAX * DECK_CARD_H + (DECK_MAX - 1) * DECK_GAP;
/** Höhe der Fläche im aufgefächerten Zustand — fester Stil, siehe toggleDeck. */
const DECK_OPENED = { height: DECK_OPEN_H } as const;
const DECK_TRAVEL = DECK_TOP.map(
  (top, depth) => (DECK_MAX - 1 - depth) * (DECK_CARD_H + DECK_GAP) - top,
);

/**
 * Dauer und Kurve des Auffächerns.
 *
 * Erst stand hier `durationLarge` (700) mit dem Argument, große Flächen
 * brauchten mehr Zeit. Das gilt für Elemente, die sich SETZEN — hier reagiert
 * die Bewegung auf einen Tipp, und darauf will man nicht warten. 500 ist die
 * reguläre Dauer des Projekts und deutlich griffiger.
 */
const DECK_OPENING = { duration: MOTION.duration, easing: MOTION.easing } as const;
/**
 * Ein- und Ausfahren laufen auf DERSELBEN Kurve — ausrollend.
 *
 * Beim Einfahren stand hier kurz eine beschleunigende: Sie sollte die teuren
 * Bilder, in denen sich die Karten wieder übereinanderschieben, in den schnellen
 * Teil der Bewegung legen. Am Gerät liest sich das aber falsch herum — eine
 * Bewegung, die langsam anfängt und schnell endet, wirkt, als würde sie
 * hineingerissen. Was sich SETZT, rollt aus, in beide Richtungen.
 */
const DECK_CLOSING = { duration: MOTION.duration, easing: MOTION.easing } as const;

/** Breite der beiden Striche im Schalter — geschlossen der untere, offen beide. */
const DECK_BAR_WIDE = 18;
const DECK_BAR_NARROW = 10;

/**
 * Zeichenreihenfolge, EINMAL beim Laden gebaut.
 *
 * Zwei Gründe, warum das hier steht und nicht im Render:
 *
 * 1. Die Überlappung braucht die umgekehrte Reihenfolge — die hinterste Karte
 *    muss ZUERST gezeichnet werden, damit die vorderste darüber liegt. Auf
 *    Android bestimmt die Geschwister-Reihenfolge auch die Treffer-Erkennung:
 *    Ein Tipp auf die verdeckte Fläche einer hinteren Karte landet dadurch von
 *    selbst auf der vorderen, ohne dass jemand `zIndex` setzen muss.
 * 2. `reverse()` im Render gäbe bei JEDEM Durchlauf ein neues Feld — die
 *    Karten sind aber `memo`, und ein neues Feld pro Durchlauf macht das
 *    zunichte.
 */
/**
 * Kein Umsortieren mehr, keine Beschneidung.
 *
 * Vorher lagen die Karten in umgekehrter Reihenfolge im Baum, damit die
 * vorderste zuletzt gezeichnet wird — und nur die ersten drei überhaupt. Beides
 * geht mit dem Ring nicht mehr: Welche Karte vorn liegt, wechselt mit jedem
 * Wisch, und alle Ziele laufen mit. Die Zeichenreihenfolge macht jetzt `zIndex`
 * (siehe DeckSection), die Reihenfolge im Baum bleibt die der Daten.
 */
const DECK_BY_CATEGORY = DESTINATIONS_BY_CATEGORY;

/**
 * Die Bilder der ÜBRIGEN Kategorien vorladen — sonst nützt die schönste
 * Übergangs-Kurve nichts.
 *
 * Beim ersten Wechsel auf „Berge" sind deren Fotos noch nirgends: Die Karten
 * stehen dann als dunkle Flächen da und die Bilder springen einzeln hinein,
 * sobald sie eintreffen. Das ist der unruhigste Teil des Wechsels, und er hat
 * mit der Animation nichts zu tun.
 *
 * Drei Vorsichtsmaßnahmen, damit das Laden selbst nichts kostet:
 *
 *  - Es beginnt ERST NACH einer Sekunde. Beim Start hat das Gerät genug zu tun,
 *    und die erste Kategorie steht ohnehin schon.
 *  - Die Bilder gehen EINZELN nacheinander los, nicht als Schwall. Zwölf
 *    gleichzeitige Anfragen würden die Verbindung für das blockieren, was der
 *    Nutzer gerade wirklich braucht.
 *  - Es läuft genau einmal je App-Start (Modul-Merker).
 */
let deckImagesWarmed = false;

function warmDeckImages(): () => void {
  if (deckImagesWarmed) return () => {};
  deckImagesWarmed = true;
  const urls: string[] = [];
  for (const list of Object.values(DESTINATIONS_BY_CATEGORY)) {
    for (const d of list) {
      if (typeof d.imageUrl === "string") urls.push(sizedImageUrl(d.imageUrl));
    }
  }
  let i = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Der Abbruch-Merker ist NICHT überflüssig.
   *
   * Ohne ihn hätte das Aufräumen eine Lücke: Läuft gerade eine Anfrage, wenn der
   * Bildschirm verlassen wird, setzt ihr `finally` danach seelenruhig den
   * nächsten Zeitgeber — der geräumte ist ja schon weg. Die Kette liefe weiter,
   * am gelöschten Bildschirm vorbei, bis alle zwölf Bilder durch sind.
   */
  let cancelled = false;
  const next = () => {
    if (cancelled || i >= urls.length) return;
    const url = urls[i++];
    // Fehler sind hier bedeutungslos: Schlägt das Vorladen fehl, lädt das Bild
    // später auf dem normalen Weg. Nur unbehandelt bleiben darf es nicht.
    Image.prefetch(url)
      .catch(() => {})
      .finally(() => {
        if (!cancelled) timer = setTimeout(next, 120);
      });
  };
  timer = setTimeout(next, 1000);
  return () => {
    cancelled = true;
    if (timer) clearTimeout(timer);
  };
}

/**
 * Die Scroll-Fläche des Landingscreens.
 *
 * EIGENE KOMPONENTE, damit der Parallax-Stil nur diesen Knoten betrifft und
 * nicht den ganzen Baum des Landingscreens.
 *
 * KEINE GPU-TEXTUR MEHR. Sie lag hier für die Dauer eines Übergangs, gestützt
 * auf die Annahme, dieser Baum werde beim Zur-Seite-Wandern in jedem Bild neu
 * gezeichnet. Die Annahme war falsch: Android hält je Ansicht eine
 * aufgezeichnete Zeichenliste, eine Verschiebung ist eine Eigenschaft davon und
 * zeichnet nichts neu. Der Landingscreen steht während der Fahrt vollständig
 * still — keine Dauerläufer, keine Zeitgeber.
 *
 * Gekostet hat sie dagegen sicher: einen bildschirmgroßen GPU-Puffer je Zyklus,
 * eine Rasterung des Inhalts (die als „verzerrte Reiseziel-Karten" auffiel), und
 * ihr leerer Puffer war der schwarze Balken. Vor allem aber hing an ihr eine
 * Zustandsgröße in DIESER Komponente: Jedes Anfordern und Freigeben schickte
 * einen Fabric-Commit auf genau die Ansicht, die Reanimated Bild für Bild
 * beschreibt. Die Selbstverfall-Wecker (1,4s) schoben einen Teil davon weit
 * hinter die Bewegung — bis mitten in ein späteres Scrollen. Genau das war das
 * „nach schnellem Auf und Zu ruckelt das Scrollen".
 */

function ParallaxScroll({
  style,
  contentContainerStyle,
  children,
}: {
  style: StyleProp<ViewStyle>;
  contentContainerStyle: StyleProp<ViewStyle>;
  children: ReactNode;
}) {

  /**
   * Der Parallax liegt HIER, nicht im Landingscreen — und er läuft nur, wenn
   * dieser Bildschirm überhaupt die Unterlage ist.
   *
   * Zwei Dinge daran sind wichtig:
   *
   * 1. Er liest `resultsPush` nur, wenn das Such-Blatt NICHT offen ist. Sucht
   *    man aus dem Such-Blatt heraus, liegt das bildschirmfüllend über dem
   *    Landingscreen — die Unterlage ist dann das Blatt, nicht dieser Baum. Der
   *    Auswerter lief trotzdem jedes Bild und schrieb einen Transform auf eine
   *    vollständig verdeckte Scroll-Fläche. Was das Worklet nicht liest,
   *    abonniert es auch nicht: Bei offenem Blatt läuft er gar nicht erst mit.
   *
   * 2. Er steht in DIESER kleinen Komponente. Im Landingscreen selbst hätte das
   *    Abonnement auf den Zustand des Blattes dessen kompletten Baum bei jedem
   *    Öffnen und Schließen neu gerendert — genau im Bild des Übergangs.
   */
  const { width: screenW } = useWindowDimensions();
  /**
   * Die Unterlage wandert für JEDEN Bildschirm, der von rechts über sie kommt.
   *
   * Bisher stand hier allein die Ergebnisliste. Seit Bo und das Such-Blatt
   * denselben Weg nehmen, sind es drei — und weil immer nur einer davon fährt,
   * genügt der größte Wert. Ein `Math.max` ist im Worklet nichts, und es
   * erspart drei getrennte Auswerter auf derselben bildschirmfüllenden Fläche.
   *
   * Die Ergebnisliste bleibt an eine Bedingung geknüpft: Sucht man AUS dem
   * Such-Blatt heraus, liegt das dazwischen — dann ist ES die Unterlage, nicht
   * dieser Baum, und der Parallax gehört nicht hierher.
   *
   * Diese Bedingung kommt jetzt aus einem GETEILTEN WERT, nicht aus dem
   * Speicher. Der Unterschied ist keine Kosmetik: Als React-Abhängigkeit
   * (`searchClosed`) kippte sie in genau dem Durchgang, in dem sich das Blatt
   * öffnet — und Reanimated beantwortet eine geänderte Abhängigkeit mit Abriss
   * und Neuanlage der Zuordnung. Der nächste Lauf baut daraufhin die
   * topologische Reihenfolge ÜBER ALLE Zuordnungen der App neu auf, und das
   * ausgerechnet im ersten Bild der Bewegung.
   *
   * Über die Lage des Blattes gefragt ist es zugleich genauer: Nicht „ist es
   * angefordert", sondern „deckt es tatsächlich".
   */
  const parallaxStyle = useAnimatedStyle(() => {
    const sheet = pushProgress(searchHeroPush.value);
    const results = sheet > 0.99 ? 0 : pushProgress(resultsPush.value);
    const p = Math.max(results, pushProgress(assistantPush.value), sheet);
    if (p === 0) return NO_HOME_PARALLAX;
    return { transform: [{ translateX: p * screenW * UNDERLAY_TRAVEL_FRAC }] };
  }, [screenW]);
  /**
   * Transform UND Textur sitzen wieder auf der SCROLL-FLÄCHE.
   *
   * Sie lagen kurzzeitig auf einer schlichten Hülle darum — mit der
   * Begründung, eine ScrollView sei der komplizierteste Knoten, den man
   * dafür wählen kann (Fling-Maschinerie, Überzieh-Effekt,
   * Scroll-Buchhaltung), und die Wähler machten es an anderer Stelle bereits
   * so.
   *
   * Am Gerät kam dabei ein sichtbarer Fehler heraus: Die Reiseziel-Karten
   * und besonders ihre Knöpfe wirkten während der Fahrt verzerrt. Eine
   * GPU-Ebene rastert den Inhalt einmal und schiebt danach das Ergebnis —
   * auf einer eigenen Hülle traf das offenbar andere Kanten als vorher.
   * Gewonnen war dabei nichts: Der gemeldete Ruckler blieb unverändert.
   *
   * Ein Umbau, der ein sichtbares Problem einbringt und die Ursache nicht
   * trifft, gehört zurückgenommen.
   */
  return (
    <Animated.ScrollView
      // Reanimated setzt auf seinen Scroll-Flächen ungefragt
      // `scrollEventThrottle: 1`. Diese Fläche hat gar keinen `onScroll`-Handler
      // (der Parallax hängt an geteilten Werten auf dem UI-Strang), die
      // Ereignisse sind also restlos Abfall.
      /**
       * 17, nicht 16 — und das ist kein Rundungsgeschmack.
       *
       * Der Filter auf der Android-Seite lautet
       * `throttle >= max(17, now - lastDispatch)` (ReactScrollViewHelper). Mit
       * 16 ist die Bedingung NIE erfüllt: Es wurde also gar nichts gedrosselt,
       * und die Ereignisse liefen weiter mit voller Bildrate zum JS-Strang —
       * für einen Handler, den es hier nicht gibt. Der Kommentar, der hier
       * stand, beschrieb eine Wirkung, die der Wert nicht hatte.
       */
      scrollEventThrottle={17}
      style={[style, parallaxStyle]}
      contentContainerStyle={contentContainerStyle}
      showsVerticalScrollIndicator={false}
    >
      {children}
    </Animated.ScrollView>
  );
}

/** Ruhestellung des Parallax — als Konstante, kein neues Objekt pro Auswertung. */
const NO_HOME_PARALLAX = { transform: [{ translateX: 0 }] } as const;

/** Kantenlänge der Glocke rechts in der Kopfzeile (siehe styles.bell). */
const BELL_SIZE = 44;
/** Um so viel überragt die Glocke die Textzeile nach oben UND unten. */
const BELL_OVERHANG = (BELL_SIZE - HEADING_LINE_HEIGHT) / 2;

// === Subcomponents ============================================================

function Header() {
  const accent = useAccent();
  const palette = usePalette();
  return (
    <View style={styles.headerRow}>
      <ScreenHeading>
        B<Text style={{ color: accent.solid }}>i</Text>nch
      </ScreenHeading>
      <RippleTouch
        style={[styles.bell, { backgroundColor: palette.s2 }]}
        hitSlop={6}
        accessibilityLabel="Notifications"
        borderless
      >
        <Bell size={19} color={C.white} />
        <View style={styles.bellDot} />
      </RippleTouch>
    </View>
  );
}

/** Press-Feedback der Kategorie-Kacheln (HyperOS-Gefühl): beim Antippen leicht
 *  zusammendrücken. Interaktive Elemente brauchen sofortige Rückmeldung → hohe
 *  Steifigkeit beim Reindrücken; das Zurückfedern darf weicher sein. */
const TILE_PRESS_SCALE = 0.93;
const TILE_PRESS_IN = { damping: 18, stiffness: 320, mass: 0.7 };
const TILE_PRESS_OUT = { damping: 15, stiffness: 200, mass: 0.8 };

/** Eckenradius der großen Reiseziel-Karten. Wird auf JEDE Ebene der Karte einzeln
 *  angewandt (Bild, Verlauf, Container) statt per `overflow: "hidden"` — siehe
 *  styles.card. */
const CARD_RADIUS = 28;

const TRANSPORT: { id: TravelMode; labelKey: string; icon: LucideIcon }[] = [
  { id: "FLIGHT", labelKey: "mode.flights", icon: Plane },
  { id: "TRAIN", labelKey: "mode.trains", icon: Train },
  { id: "BUS", labelKey: "mode.buses", icon: Bus },
  { id: "CRUISE", labelKey: "mode.cruises", icon: Ship },
];

function TransportTile({
  id,
  labelKey,
  Icon,
}: {
  id: TravelMode;
  labelKey: string;
  Icon: LucideIcon;
}) {
  const t = useT();
  const palette = usePalette();
  const openSearchOverlay = useSearchStore((s) => s.openSearchOverlay);
  // Die Kachel wird NICHT mehr ausgeblendet.
  //
  // Sie verschwand, sobald der Launch lief — weil eine gleich große Deckfläche
  // pixelgenau an ihre Stelle trat und von dort auf Vollbild wuchs. Diese Fläche
  // gibt es nicht mehr: Der Such-Screen fährt jetzt als Blatt von unten herein
  // und schiebt sich über den Landingscreen. Bliebe das Ausblenden stehen,
  // klaffte während der Bewegung ein Loch im Kachelraster — sichtbar, weil der
  // Landingscreen unter dem hereinfahrenden Blatt bis zuletzt zu sehen ist.
  // Kein natives Messen: das Kachel-Rect kommt aus dem Press-Event. pageX/pageY
  // (Tap in Fensterkoordinaten) minus locationX/locationY (Tap-Position in der
  // Kachel) = obere linke Ecke; Größe aus onLayout.
  const size = useRef({ w: 0, h: 0 });

  // Press-Feedback wie auf HyperOS: die Kachel wird beim Antippen physisch
  // zusammengedrückt. Der Launch startet danach aus GENAU dieser gedrückten
  // Größe (siehe TILE_PRESS_SCALE unten) — dadurch wirkt das Icon wie ein
  // Objekt mit Masse, das sich zum Fenster aufzieht, statt wie ein Rechteck,
  // das plötzlich skaliert.
  const press = useSharedValue(1);
  const pressStyle = useAnimatedStyle(() => ({ transform: [{ scale: press.value }] }));
  // Rect wird aus dem ROHEN Touch-Down der äußeren View gelesen. TouchableNative-
  // Feedback (Android) füllt locationX/Y in seinen synthetischen Press-Events
  // NICHT zuverlässig (kommt ~0) → x = pageX − 0 = Tap-Punkt statt Kachel-Ecke.
  // onTouchStart der View liefert pageX/pageY UND locationX/locationY korrekt,
  // relativ zu genau dieser View — und die View ist noch unskaliert.
  const launchRect = useRef<SearchOverlayLaunch | null>(null);

  const capture = (e: GestureResponderEvent) => {
    // Den schweren Himmel-SVG des Such-Blattes jetzt schon zeichnen lassen —
    // Begründung dort beim Abonnenten. Ohne das fällt seine Erstzeichnung in
    // die ersten Bilder der Fahrt.
    useSearchStore.getState().setSearchContentVisible(true);
    const { pageX, pageY, locationX, locationY } = e.nativeEvent;
    const { w, h } = size.current;
    if (w > 0 && h > 0 && pageX != null && locationX != null) {
      // In GEDRÜCKTER Größe merken. Der Kommentar oben behauptet das bereits,
      // `onLayout` liefert aber die ungedrückte: Der Druck ist ein Transform und
      // ändert das Layout nicht. Das Letzte, was man sieht, ist die Kachel bei
      // 93 % — der erste Frame der Box war 100 %, also ein Sprung um 7 % in einem
      // Bild, an Kante und Beschriftung sichtbar.
      const pw = w * TILE_PRESS_SCALE;
      const ph = h * TILE_PRESS_SCALE;
      launchRect.current = {
        x: pageX - locationX + (w - pw) / 2,
        y: pageY - locationY + (h - ph) / 2,
        w: pw,
        h: ph,
        color: palette.s2,
      };
    }
  };

  const launch = () => {
    // Läuft schon ein Launch, nichts tun. Sonst startet der zweite Tipp den
    // Zustandsautomaten neu (`session`-Bump) — die schon wachsende Box
    // verschwindet für ein Bild und fängt von vorn an. Das Fenster dafür ist
    // real: Bis der Commit durch ist, steht der Overlay-Root noch auf
    // `pointerEvents: none`, die Kacheln darunter sind also weiter tippbar.
    if (useSearchStore.getState().searchOverlayMode != null) return;
    haptic("button");
    // Bewegung zuerst, Speicher danach — wie bei jedem anderen Push. Der
    // Fortschritt ist ein Modul-Wert und braucht den Bildschirm nicht.
    // Erst der Commit, dann die Kurve — siehe die Begründung beim Weg zu Bo.
    // Dieser Aufruf schreibt acht Felder auf einmal, und das Blatt setzt daraufhin
    // neun weitere Zustände zurück. Das gehört vor die Bewegung, nicht hinein.
    openSearchOverlay(id, launchRect.current ?? undefined);
    requestAnimationFrame(startSearchHeroPush);
  };

  return (
    <Animated.View
      // opacity 0 SOFORT beim Launch dieser Kachel: der Splash übernimmt.
      style={[styles.tabWrap, pressStyle]}
      onLayout={(e) => {
        size.current = { w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height };
      }}
      onTouchStart={capture}
    >
      {/* Reines Pressable statt RippleTouch → auf diesen vier Launch-Kacheln
          GAR KEIN Material-Ripple mehr. Das helle Default-Ripple zündete beim
          Tap und blitzte 1-2 Frames vor dem Splash am Rand durch (das
          „gelegentliche Aufblitzen von der Box"); rippleColor="transparent"
          reichte nicht, weil die native Ripple-Drawable trotzdem lief. Das
          physische Zusammendrücken (press-scale) ist das eigentliche Feedback. */}
      <Pressable
        style={[styles.tab, styles.tabIdle, { backgroundColor: palette.s2 }]}
        onPress={launch}
        onPressIn={() => {
          press.value = withSpring(TILE_PRESS_SCALE, TILE_PRESS_IN);
        }}
        onPressOut={() => {
          press.value = withSpring(1, TILE_PRESS_OUT);
        }}
      >
        {/* pointerEvents none: der Touch soll IMMER auf die Kachel treffen,
            nie auf Icon/Label. Sonst ist locationX relativ zum kleinen Kind
            (Icon liegt zentral) → x = pageX - locationX falsch bei Mitte-Tap. */}
        <View pointerEvents="none" style={styles.tabContent}>
          <Icon size={24} color={C.white} strokeWidth={1.8} />
          <Text numberOfLines={1} style={[styles.tabLabel, styles.tabLabelIdle]}>
            {t(labelKey)}
          </Text>
        </View>
      </Pressable>
    </Animated.View>
  );
}

function TransportTabs() {
  return (
    <View style={styles.tabsRow}>
      {TRANSPORT.map(({ id, labelKey, icon }) => (
        <TransportTile key={id} id={id} labelKey={labelKey} Icon={icon} />
      ))}
    </View>
  );
}

function SectionHeaderSmall({ title, onViewAll }: { title: string; onViewAll?: () => void }) {
  const t = useT();
  const accent = useAccent();
  return (
    <View style={styles.sectionHeader}>
      <Text style={styles.sectionTitleSmall}>{title}</Text>
      <Pressable hitSlop={8} onPress={onViewAll}>
        <Text style={[styles.actionLink, { color: accent.solid }]}>{t("home.viewall")}</Text>
      </Pressable>
    </View>
  );
}

const CATEGORIES: { id: CategoryId; labelKey: string }[] = [
  { id: "ocean", labelKey: "home.category.beach" },
  { id: "mountain", labelKey: "home.category.mountain" },
  { id: "forest", labelKey: "home.category.nature" },
  { id: "city", labelKey: "home.category.city" },
];

function CategoryChips({ value, onChange }: { value: CategoryId; onChange: (id: CategoryId) => void }) {
  const palette = usePalette();
  const t = useT();
  return (
    <View style={styles.chipsRow}>
      {CATEGORIES.map((it) => {
        const on = value === it.id;
        return (
          <RippleTouch
            key={it.id}
            style={[styles.chip, { backgroundColor: on ? "transparent" : palette.s2 }]}
            onPress={() => {
              haptic("button");
              onChange(it.id);
            }}
          >
            {on && <GradientFill />}
            <Text
              style={[
                styles.chipLabel,
                { color: on ? C.black : C.white, fontWeight: on ? "700" : "600" },
              ]}
            >
              {t(it.labelKey)}
            </Text>
          </RippleTouch>
        );
      })}
    </View>
  );
}

/**
 * Abstand von einer Bedienzeile zu dem, was sie steuert.
 *
 * Zweimal auf diesem Bildschirm: Suchleiste über den Transport-Tabs, und
 * Kategorie-Chips über dem Reiseziel-Stapel. Beide Male dieselbe Beziehung,
 * also dieselbe Zahl — vorher standen dort 12 und 18, und der Unterschied fiel
 * genau deshalb auf, weil die beiden Stellen sich sonst gleichen.
 */
const CONTROL_GAP = 12;

const HEART_RED = "#FF3B5C";

/**
 * Das Glas der Kopfzeile — Landespille und Herztaste teilen es sich.
 *
 * Als Konstante und nicht zweimal getippt, weil genau diese beiden Flächen
 * nebeneinander in derselben Zeile liegen: Weicht eine der Zahlen ab, sieht man
 * es sofort als zwei verschiedene Materialien.
 */
const GLASS_FILL = "rgba(18,18,20,0.42)";
const GLASS_EDGE = "rgba(255,255,255,0.20)";

// Unsplash-URLs sind mit w=900 hinterlegt — die Karte ist aber nur ~340px breit
// (×2 für Retina ≈ 700px). RNs Image dekodiert Remote-Bilder in VOLLER Quell-
// Auflösung (kein Auto-Downsampling), d.h. 900px-JPEGs zu dekodieren kostet beim
// Scrollen spürbar. Wir verkleinern die angefragte Breite auf 700 → ~40% weniger
// Pixel zu dekodieren, ohne sichtbaren Schärfeverlust. (Echter Fix wäre expo-image
// mit Disk-Cache + exaktem Downsampling — separate Dependency.)
function sizedImageUrl(url: string): string {
  return url.replace(/([?&]w=)\d+/, "$1700");
}

/** Startzustand der Einblendung — siehe Begründung am JSX unten. */
/** Seitenabstand der Kopfzeile in Gerätepunkten — Grundlage der Gegenrechnung. */
const DECK_PAD = ms(DECK_CARD_INSET);

/**
 * Startzustände je Stufe — STATISCH, für das erste Bild nach dem Einbau.
 *
 * Der animierte Stil kommt vom UI-Strang und greift erst, wenn er einmal
 * durchgelaufen ist. Bei der Karte stand das schon; Pille und Herz hatten es
 * NICHT, und das war ein echter Fehler: Ihre Gegenrechnung gegen den Maßstab
 * der Karte fehlte im ersten Bild, sie standen dort neun Prozent zu schmal und
 * knapp zwei Punkte versetzt — sichtbar bei jedem Kategorie-Wechsel, weil die
 * Karten dabei neu entstehen.
 */
/**
 * Der Kategorie-Wechsel — Schnitt, dann kommt der neue Stapel herein.
 *
 * Drei Fassungen davor waren falsch, und alle drei hatten dieselbe Wurzel: Ich
 * wollte den Tausch VERSTECKEN, statt ihn einfach zu machen.
 *
 *  1. An derselben Stelle getauscht — man sah, wie Bilder ersetzt werden.
 *  2. Vorher zur Seite geschoben — las sich als Wegfliegen.
 *  3. Vorher nach unten und ausgeblendet — 120 Punkte reichen nicht, um einen
 *     376 Punkte hohen Stapel aus dem Blick zu bringen, also blieb der Tausch
 *     sichtbar, und das Hinunter-und-wieder-Herauf las sich als Abprallen.
 *
 * Der Fehler war die Überblendung selbst. Ein Kategorie-Wechsel ist keine
 * Verwandlung des alten Stapels in den neuen — es ist ein anderer Stapel. Also
 * ein SCHNITT: Der alte ist weg, der neue kommt von unten herein. Kein
 * Ausblenden, kein Weg nach unten, nichts, was von den alten Bildern zu den
 * neuen überleitet.
 */
/**
 * Weg, Anlauf und Dauer des Hereinkommens.
 *
 * Der WEG ist auf den Abstand zur Leiste begrenzt und nicht frei gewählt: Fährt
 * der Stapel weiter als das nach unten, beginnt seine Bewegung hinter der
 * Navigationsleiste — man sieht dann nicht, wie er hereinkommt, sondern nur,
 * wie er darunter hervorkommt. 40 Punkte sind genau der Platz, der unter ihm
 * frei ist.
 *
 * Weil der Weg damit kurz ist, trägt ihn ein zweiter Anteil: Der Stapel kommt
 * zugleich aus 95 Prozent Größe nach vorn. Das liest sich als Annähern und
 * braucht keinen Platz.
 *
 * Die DAUER liegt bei 620 Millisekunden und damit nahe an dem Wert, den das
 * Projekt für große Flächen vorsieht (700). Das ist hier richtig: Ein Wechsel
 * der Kategorie tauscht die ganze Sektion aus, das darf sich Zeit nehmen — im
 * Unterschied zum Auffächern, das auf einen Tipp antwortet.
 *
 * Der ANLAUF ist der eigentliche Kniff. Beim Wechsel muss React vier
 * Karteninhalte austauschen und Android vier Texturen neu rastern — ein
 * teures Bild, und ohne Anlauf fällt es mitten in den Beginn der Bewegung.
 * Diese siebzig Millisekunden verschieben es dorthin, wo der Stapel noch
 * stillsteht: Man sieht es dann nicht, weil sich nichts bewegt, das ruckeln
 * könnte.
 */
const DECK_SWITCH_RISE = 40;
const DECK_SWITCH_ZOOM = 0.95;
const DECK_SWITCH_LEAD = 70;
const DECK_SWITCH_IN = { duration: 620, easing: MOTION.easing } as const;
/** Startzustand je Stufe — für das erste Bild, bevor das Worklet greift. */
const DECK_ENTER_FROM = DECK_SQUEEZE.map((squeeze, depth) => ({
  transform: [{ translateY: DECK_TOP[depth] }, { scaleX: squeeze }],
}));
const DECK_PILL_FROM = DECK_SQUEEZE.map((squeeze) => ({
  transform: [{ translateX: DECK_PAD * (1 / squeeze - 1) }, { scaleX: 1 / squeeze }],
}));
const DECK_HEART_FROM = DECK_SQUEEZE.map((squeeze) => ({
  transform: [{ translateX: -DECK_PAD * (1 / squeeze - 1) }, { scaleX: 1 / squeeze }],
}));

/**
 * Eine Karte im Stapel.
 *
 * `depth` ist die Tiefe: 0 ist die vorderste (volle Breite, unten, mit Preis
 * und Knopf), alles darüber liegt dahinter und zeigt nur noch die Kopfzeile.
 * `riseMax` ist die Tiefe der hintersten Karte — daraus ergibt sich, wie weit
 * oben im Stapel diese hier sitzt.
 */
const DestinationCard = memo(function DestinationCard({
  d,
  index,
  count,
  z,
  open,
  pos,
  dir,
  adv,
}: {
  d: Destination;
  /** Fester Platz in den Daten. Die STUFE ergibt sich erst aus `pos`. */
  index: number;
  /** Wie viele Karten im Ring laufen. */
  count: number;
  /**
   * Zeichenreihenfolge — kommt als gewöhnliche Eigenschaft aus React.
   *
   * Sie hat hier schon einmal auf dem UI-Strang gerechnet, aus derselben Zahl
   * wie die Lage. Die RECHNUNG war richtig — ich habe sie über 258 Bilder
   * zweier Wische nachgestellt, kein einziges mit falscher Reihenfolge. Nur
   * kommt der Wert auf diesem Weg nicht rechtzeitig in der Zeichenreihenfolge
   * des Behälters an: Ein animierter Wert wird direkt an der Ansicht gesetzt,
   * die Umsortierung der Geschwister ist aber ein zweiter Schritt, und der
   * kommt sichtbar hinterher. Die weggewischte Karte stand dadurch beim
   * Zurückkommen vor dem ganzen Stapel.
   *
   * Über React committet, kam sie rechtzeitig — so lief es, bevor ich es
   * umgebaut habe. Also wieder so, und der Grund steht hier, damit es nicht
   * noch einmal jemand „aufräumt".
   */
  z: number;
  /** 0 = gestapelt, 1 = aufgefächert. Läuft auf dem UI-Strang. */
  open: SharedValue<number>;
  /** Stand des Rings. Ganzzahlanteil = Stufe, Nachkomma = laufender Wisch. */
  pos: SharedValue<number>;
  /** Richtung des laufenden Wischs: -1 links, +1 rechts. */
  dir: SharedValue<number>;
  /** Stand des Nachrückens — eigene Zahl, siehe DECK_ADVANCE_DIST. */
  adv: SharedValue<number>;

}) {
  const t = useT();
  const accent = useAccent();
  const openSearchOverlay = useSearchStore((s) => s.openSearchOverlay);
  // WICHTIG: selektiv abonnieren — sonst löst JEDER Favorite-Toggle einen
  // Re-Render ALLER DestinationCards aus. Wir interessieren uns nur dafür ob
  // GENAU DIESE Destination gespeichert ist; Zustand's shallow-compare
  // verhindert dann den Re-Render wenn sich nur fremde Favoriten ändern.
  const saved = useSearchStore((s) => s.favoriteResultIds.includes(d.id));
  const toggleFavorite = useSearchStore((s) => s.toggleFavorite);

  const ModeIcon = MODE_ICON[d.mode];

  /**
   * Die Stufe, auf der diese Karte beim Einbau liegt. Danach entscheidet allein
   * `pos` — hier steht nur noch der Startzustand fürs erste Bild.
   */
  const startSlot = index < DECK_MAX ? index : DECK_MAX - 1;

  /** Als eigenes Objekt gemerkt — ein Literal wäre bei jedem Bild eine neue
   *  Kennung in der Stil-Reihe und damit ein Prop-Wechsel ohne Anlass. */
  const zBox = useMemo(() => ({ zIndex: z }), [z]);

  // Bild-Source STABIL memoisieren: sonst entsteht bei jedem Render ein neues
  // `{uri}`-Objekt → RN-Image kann das Bild neu laden → sichtbares Flackern.
  const imageSource = useMemo(
    () => (typeof d.imageUrl === "number" ? d.imageUrl : { uri: sizedImageUrl(d.imageUrl) }),
    [d.imageUrl],
  );

  /** Der Sprung beim Merken — er tritt die ganze Karte zurück. */
  const scale = useSharedValue(1);
  /**
   * Einblenden beim Entstehen — selbst getrieben statt über `entering`.
   *
   * `entering={FadeIn}` stand hier und tat nichts Sichtbares. Reanimateds
   * Ein-/Aussprung-Animationen hängen daran, dass Fabric den Einbau der Ansicht
   * als solchen meldet; in einer Liste innerhalb einer bewegten ScrollView kommt
   * das nicht verlässlich an. Ein eigener Wert, der im Mount-Effekt losläuft,
   * hängt an nichts davon — dasselbe Muster, mit dem in dieser App auch alle
   * anderen Mikro-Bewegungen laufen.
   *
   * Der `key` der Karte enthält die Kategorie: Beim Wechsel entstehen die vier
   * Karten neu, dieser Effekt läuft also erneut.
   */
  /**
   * Die Lage dieser Karte im Ring — EINMAL gerechnet, dreimal gelesen.
   *
   * `pos` ist eine fortlaufende Zahl: Der Ganzzahlanteil sagt, wie oft schon
   * gewischt wurde, der Nachkomma-Anteil, wie weit der laufende Wisch ist.
   * Daraus ergibt sich für jede Karte ihre Stufe — und weil die Zahl einfach
   * weiterläuft und nie zurückgesetzt wird, gibt es keinen Moment, in dem
   * Zustand und Bild auseinanderfallen könnten.
   *
   * Die vorderste Karte (Stufe 0) verlässt den Stapel zur Seite. Alle anderen
   * rücken eine Stufe auf. Karten hinter der dritten Stufe liegen auf deren
   * Platz und rühren sich nicht — sie werden sichtbar, weil die Karte davor
   * weggeht, nicht weil sie selbst etwas tut.
   */
  const geo = useDerivedValue(() => {
    const f = pos.value;
    const k = Math.floor(f);
    const frac = f - k;
    /**
     * Das Nachrücken, doppelt abgesichert.
     *
     * Es hat eine eigene Zahl, damit es beim Ziehen früher anspricht als der
     * Abgang (siehe DECK_ADVANCE_DIST). Nur muss es UNBEDINGT fertig sein, bevor
     * der Ring weiterzählt — sonst springt jede Karte um den Rest, der noch
     * offen war.
     *
     * Mit einer Feder für den Abgang lässt sich das nicht mehr über die Dauer
     * garantieren: Wie lange sie braucht, hängt daran, wie schnell geschnippt
     * wurde. Deshalb der zweite Anteil — spätestens auf halbem Abgangsweg ist
     * das Nachrücken durch, egal was die eigene Zahl gerade sagt. Ob die Feder
     * dann 120 oder 400 Millisekunden braucht, spielt keine Rolle mehr.
     */
    const a = Math.min(1, Math.max(0, adv.value - k, frac / DECK_ADVANCE_BY));
    let b = (index - k) % count;
    if (b < 0) b += count;

    if (b === 0) {
      // Geht ab: bleibt auf ihrem Platz und wandert seitlich hinaus.
      return {
        b,
        ty: DECK_TOP[0],
        sx: DECK_SQUEEZE[0],
        tv: DECK_TRAVEL[0],
        tx: dir.value * DECK_EXIT_X * frac,
        // Die Kippung läuft dreimal so schnell hoch wie der Weg: Der sichtbare
        // Teil des Abgangs ist nur das erste Drittel, und ein Kippen, das erst
        // außerhalb des Bildes seinen Wert erreicht, sieht man nie.
        // Kippung und Verkleinern laufen dreimal so schnell hoch wie der Weg:
        // Der sichtbare Teil des Abgangs ist nur das erste Drittel, und was
        // erst außerhalb des Bildes seinen Wert erreicht, sieht man nie.
        tilt: dir.value * DECK_EXIT_TILT * Math.min(1, frac * 3),
        shrink: 1 - DECK_EXIT_SHRINK * Math.min(1, frac * 3),
        last: false,
      };
    }
    const from = deckSlotOf(b);
    const to = deckSlotOf(b - 1);
    return {
      b,
      ty: DECK_TOP[from] + (DECK_TOP[to] - DECK_TOP[from]) * a,
      sx: DECK_SQUEEZE[from] + (DECK_SQUEEZE[to] - DECK_SQUEEZE[from]) * a,
      tv: DECK_TRAVEL[from] + (DECK_TRAVEL[to] - DECK_TRAVEL[from]) * a,
      tx: 0,
      tilt: 0,
      shrink: 1,
      last: b === count - 1,
    };
  });

  const cardAnim = useAnimatedStyle(() => {
    const g = geo.value;
    const o = open.value;
    const ty = g.ty + g.tv * o;
    // „Steht still" heißt: weder Auffächern noch Wisch in Bewegung.
    const still = (o === 0 || o === 1) && g.tx === 0;
    // Aufgefächert wird der Maßstab auf 1 gezogen; im Stapel bleibt er der
    // Stufe entsprechend.
    const sx = g.sx + (1 - g.sx) * open.value;
    return {
      /**
       * Die hinterste Karte des Rings verschwindet, sobald aufgefächert ist —
       * sie liegt dort hinter der obersten und käme nur zum Vorschein, wenn die
       * sich bewegt (etwa beim Merken).
       *
       * Die Prüfung steht HIER und nicht in der Lage-Rechnung, und das ist kein
       * Ordnungsdetail: Sie war der einzige Grund, warum jene den Auffächer-Wert
       * überhaupt las — und damit in jedem Bild der Bewegung mitlief, für vier
       * Karten. Hier hängt sie an einem Stil, der ohnehin daran hängt.
       */
      opacity: g.last && o === 1 ? 0 : 1,
      transform: [
        // Senkrechte Lage, Auffächer-Weg und Einblenden in EINER Zahl. Alles
        // Verschiebung und Maßstab — keine Layout-Werte, also kein Messlauf.
        /**
         * Gerundet wird nur im RUHEZUSTAND, nicht während einer Bewegung.
         *
         * Das Runden auf ganze Bildpunkte kam gegen einen unruhigen Ein-Punkt-
         * Saum an der Unterkante. Im Auslauf einer Bewegung richtet es aber
         * Schaden an, und zwar rechnerisch nachweisbar: Die Ausroll-Kurve endet
         * mit Steigung null, die letzten Bilder legen also weniger als eine
         * Rasterweite zurück. Gerundet wird aus der streng fallenden Folge
         * (…2,6 · 2,2 · 1,8 · 1,4 · 1,1 · 0,9 · 0,6 · 0,4 · 0,2 · 0,1) eine mit
         * Umkehrungen (…2 · 3 · 1 · 2 · 1 · 1 · 0 · 1 · 0 · 0) — die Karte
         * beschleunigt kurz vor dem Stillstand wieder. Genau das liest sich als
         * „stottert beim Setzen", und weil die beiden bewegten Karten
         * verschiedene Wege haben, geraten sie dabei auch noch gegeneinander.
         *
         * Im Ruhezustand bleibt die Rundung, dort wird nichts quantisiert, was
         * sich bewegt. Und während der Fahrt braucht es sie nicht: Die Karte
         * liegt in einer Textur, eine gebrochene Verschiebung wird dort
         * gefiltert statt getreppt.
         */
        { translateY: still ? snapPx(ty) : ty },
        { translateX: still ? snapPx(g.tx) : g.tx },
        { rotateZ: `${g.tilt}deg` },
        { scale: scale.value * g.shrink },
        { scaleX: sx },
      ],
    };
  });

  /**
   * Pille und Herz bekommen den Maßstab wieder heraus.
   *
   * Der Maßstab auf der Karte staucht alles darin mit. Bei Foto und Verlauf ist
   * das folgenlos — bei Landespille und Herztaste nicht: Aus dem Kreis würde
   * eine Ellipse, und die Elemente der hinteren Karten sollen ausdrücklich
   * nicht kleiner werden.
   *
   * Der Kehrwert hebt ihn exakt auf. Die Schrift wird dadurch NICHT zweimal
   * abgetastet: Android fasst beide Matrizen zusammen, übrig bleibt die
   * Einheit. Der Ursprung liegt an der äußeren Kante (links für die Pille,
   * rechts für das Herz) — steht er dort, bleibt für den Randabstand genau ein
   * Glied übrig, und die Rechnung hängt nicht an der Breite der Pille.
   */
  /**
   * Der Kehrwert des Maßstabs — EINMAL gerechnet, zweimal gelesen.
   *
   * Pille und Herz lasen vorher beide das ganze Lage-Objekt und rechneten
   * denselben Kehrwert doppelt. Als eigene Zahl hängen sie nur noch an dem
   * einen Wert, der sie betrifft: Ändert sich der Maßstab nicht — und bei der
   * abgehenden Karte tut er das nie —, laufen ihre Stile gar nicht erst an.
   */
  const inv = useDerivedValue(() => {
    const sx = geo.value.sx;
    return 1 / (sx + (1 - sx) * open.value);
  });
  const pillAnim = useAnimatedStyle(() => ({
    transform: [{ translateX: DECK_PAD * (inv.value - 1) }, { scaleX: inv.value }],
  }));
  const heartAnim = useAnimatedStyle(() => ({
    transform: [
      { translateX: -DECK_PAD * (inv.value - 1) },
      { scaleX: inv.value },
    ],
  }));

  /**
   * Das Textfeld der dritten Stufe und dahinter wird nicht gezeichnet.
   *
   * Es liegt im Stapel IMMER hinter der Karte davor — nachgerechnet über die
   * ganze Wischbewegung: Die Karte auf Stufe 2 sitzt bei y 0 bis 285, ihr Feld
   * bei 187 bis 267; die Karte auf Stufe 1 deckt ab 42 und ist zudem breiter.
   * Auch bei halbem Wisch bleibt das so. Sichtbar wird es erst beim
   * Auffächern — daran hängt es deshalb.
   */
  /**
   * KEIN eigener Stil mehr für das Textfeld.
   *
   * Es war ausgeblendet, solange es verdeckt ist — das sparte Zeichenarbeit,
   * als die Karte noch Ebene für Ebene gezeichnet wurde. Seit sie als Textur
   * gehalten wird, spart es nichts: Was in der Textur steht, ist EINMAL
   * gerastert, ob sichtbar oder nicht.
   *
   * Gekostet hat es zweierlei. Ein vierter laufender Stil je Karte, also
   * sechzehn zusätzliche Worklet-Läufe in jedem Bild. Und schlimmer: Jede
   * Änderung darin macht die Textur ungültig, sie musste beim Auf- und
   * Zuklappen also neu entstehen.
   */

  const handleLike = useCallback((e: { stopPropagation?: () => void }) => {
    e.stopPropagation?.();
    haptic("button");
    const justSaved = !saved;
    toggleFavorite(d.id);
    if (justSaved) {
      scale.value = withSequence(
        withTiming(0.92, { duration: 140, easing: Easing.out(Easing.quad) }),
        withTiming(1, { duration: 320, easing: Easing.elastic(1.5) })
      );
    }
  }, [saved, toggleFavorite, d.id, scale]);

  const prepareSearch = useCallback(() => {
    useSearchStore.getState().setSearchContentVisible(true);
  }, []);
  const openSearch = useCallback(() => {
    haptic("button");
    openSearchOverlay(d.mode);
    requestAnimationFrame(startSearchHeroPush);
  }, [openSearchOverlay, d.mode]);
  /** Derselbe Weg wie die Karte, nur mit kräftigerer Rückmeldung — es ist der Knopf. */
  const bookNow = useCallback(
    (e: { stopPropagation?: () => void }) => {
      e.stopPropagation?.();
      haptic("important");
      openSearchOverlay(d.mode);
      requestAnimationFrame(startSearchHeroPush);
    },
    [openSearchOverlay, d.mode],
  );

  /**
   * Der Karteninhalt wird FESTGEHALTEN.
   *
   * Er hängt an der Destination und am Merk-Zustand, sonst an nichts. Was sich
   * je Wisch ändert, ist allein die Zeichenreihenfolge — und die sitzt an der
   * Hülle darum. Ohne dieses Festhalten baute React bei jedem Wisch den
   * kompletten Inhalt aller vier Karten neu: Bilder, Verläufe, Glasfelder,
   * sechs Textabsätze je Karte. Das käme genau im Bild nach dem Abgang an, wo
   * man es als Stocken sieht.
   */
  const body = useMemo(
    () => (
        <>
        {/* DIE TEXTUR liegt auf DIESER Ebene, nicht auf der ganzen Karte.
            Darin steht nur Unveränderliches: Foto, Verlauf, Textfeld. Was sich
            beim Auffächern in jedem Bild ändert — die Gegenrechnung an Pille
            und Herz — liegt bewusst DARÜBER und damit außerhalb. Läge es darin,
            müsste die Textur in jedem Bild neu entstehen, und genau das war das
            Ruckeln beim Aus- und Einfahren. */}
        <Animated.View style={styles.cardBody} renderToHardwareTextureAndroid>
        <RippleTouch
          style={styles.card}
          onTouchStart={prepareSearch}
          onPress={openSearch}
        >
          <ImageBackground
            source={imageSource}
            style={styles.cardBg}
            // Androids Default-Einblend-Fade (~300ms) AUS: Sonst fadet jedes
            // (Nach-)Laden sichtbar ein → wirkt auf den Karten wie ein Flackern,
            // vor allem wenn während der Expand-Animation ein Bild (nach-)lädt.
            fadeDuration={0}
          >
            {/* Verlauf und Textfeld stehen auf JEDER Karte, auch auf den
                verdeckten.
  
                Naheliegend wäre, sie dort wegzulassen — von einer Karte im Stapel
                sieht man nur den Streifen. Genau das stand hier auch. Es hieß
                aber, dass beim Auffächern zuerst ein React-Durchlauf zwei
                Textblöcke und zwei Knöpfe hätte bauen müssen, und zwar im selben
                Bild, in dem die Kurve losläuft. In diesem Projekt ist ein
                Durchlauf an dieser Stelle der teuerste Posten überhaupt: Er hält
                die Reanimated-Commits an, solange er dauert.
  
                So gebaut ist das Auffächern eine reine Kurve auf dem UI-Strang —
                kein Zustand, kein Durchlauf, nichts, das erst entstehen muss.
                Gekostet hat es ein paar Dutzend Knoten, die im Stapel hinter der
                vordersten Karte liegen und nie gezeichnet werden.
  
                Ein Schleier lag hier kurz zusätzlich auf den hinteren Karten, mit
                jeder Stufe dichter. Gedacht war er als Tiefe, gewirkt hat er als
                Treppe — jede Stufe trat zweimal in Erscheinung, einmal schmaler
                und einmal dunkler. Der Entwurf dunkelt nicht ab. */}
            {/* Der Verlauf deckt nur noch die UNTEREN 65% der Karte.
                Er lag über der ganzen Fläche, und das war reine Verschwendung:
                Oben stand er bei 5 bis 15 Prozent Schwarz — praktisch unsichtbar,
                aber volles Alpha-Mischen über 350×320 Punkte, dreimal
                übereinander. Beim Einfahren schieben sich die drei Karten wieder
                übereinander, die Überzeichnung erreicht ihr Maximum also genau im
                Ausrollen der Kurve, wo der Blick hängt.
                Die obere Kante ist vollständig durchsichtig, es entsteht dort
                also keine Naht — und lesbar bleibt oben ohnehin alles, weil
                Pille und Herz ihr eigenes Glas mitbringen. */}
            <LinearGradient
              colors={["rgba(0,0,0,0)", "rgba(0,0,0,0.28)", "rgba(0,0,0,0.85)"]}
              locations={[0, 0.45, 1]}
              style={styles.cardScrim}
            />
  

            {/* Stadt, Preis und Knopf — auf JEDER Karte, auch auf den
                verdeckten. Sie erst beim Auffächern zu bauen hieße, einen
                React-Durchlauf in das Bild zu legen, in dem die Kurve losläuft;
                der hält die Reanimated-Commits an, solange er dauert. */}
            <View style={styles.cardBottom}>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={styles.cityText} numberOfLines={1}>
                  {d.city}
                </Text>
                {/* Merkmalzeile: Reiseart und Preis, jeweils mit Symbol davor —
                    dieselbe Machart wie die Zeile unter dem Titel im Entwurf.
                    Erfunden wird dafür nichts: Beides steht ohnehin an der
                    Destination, es stand nur bisher nicht nebeneinander. */}
                <View style={styles.metaRow}>
                  <ModeIcon size={13} color={C.gray1} strokeWidth={2.2} />
                  <Text style={styles.metaText}>{t(MODE_LABEL[d.mode])}</Text>
                  <View style={styles.metaDot} />
                  <Text style={styles.metaText}>
                    {t("home.popular.from")}{" "}
                    <Text style={[styles.priceValue, { color: accent.solid }]}>{d.priceFrom}</Text>{" "}
                    {d.currency}
                  </Text>
                </View>
              </View>
              <RippleTouch style={styles.cta} onTouchStart={prepareSearch} onPress={bookNow}>
                <GradientFill style={styles.ctaFill} />
                <Text style={styles.ctaText}>{t("home.book")}</Text>
              </RippleTouch>
            </View>
          </ImageBackground>
        </RippleTouch>
        </Animated.View>

        {/* Kopfzeile — ÜBER der Textur, nicht darin.
            `box-none` lässt Tipps auf die Fläche dahinter durch; nur Herz und
            Pille selbst fangen sie ab. Die Pille fängt gar nichts, sie ist
            durchlässig gestellt. */}
        <View style={[styles.cardTopLayer, styles.cardTop]} pointerEvents="box-none">
          {/* EINE Pille für alle Stufen — auch für die vorderste.
              Sie war dort im Akzent gefüllt, und das war zu viel: Der Akzent
              ist in dieser Sektion der Buchen-Knopf, und eine grüne Pille am
              oberen Rand derselben Karte hat ihm die Aufmerksamkeit
              weggenommen. Glas trägt den Landesnamen genauso, ohne eine
              zweite Stimme aufzumachen. */}
          <Animated.View
              style={[styles.pillWrap, DECK_PILL_FROM[startSlot], pillAnim]}
              pointerEvents="none"
            >
            <View style={styles.countryPill}>
              <Text style={styles.countryFlag}>{d.flag}</Text>
              <Text style={styles.countryPillText} numberOfLines={1}>
                {d.country}
              </Text>
            </View>
          </Animated.View>
          <Animated.View style={[styles.heartWrap, DECK_HEART_FROM[startSlot], heartAnim]}>
            <RippleTouch
              borderless
              hitSlop={10}
              style={styles.heartBtn}
              onPress={handleLike}
            >
              <Heart
                size={18}
                color={saved ? HEART_RED : C.white}
                fill={saved ? HEART_RED : "transparent"}
              />
            </RippleTouch>
          </Animated.View>
        </View>
        </>
    ),
    [d, t, accent.solid, saved, ModeIcon, imageSource, pillAnim, heartAnim, handleLike, prepareSearch, openSearch, bookNow, startSlot],
  );

  return (
    /**
     * Der Startzustand steht auch STATISCH da, nicht nur im Worklet.
     *
     * Genau hier kam das Aufblitzen beim Kategorie-Wechsel her. Der `key` der
     * Karte enthält die Kategorie, beim Wechsel entstehen also vier neue
     * Ansichten — und Fabric hängt sie mit ihrem STATISCHEN Stil ein. Der
     * animierte Stil kommt vom UI-Strang und greift erst, wenn der einmal
     * durchgelaufen ist. Fällt das ungünstig, steht die fertige Karte für ein
     * Bild vollständig sichtbar da, bevor sie auf Deckkraft 0 zurückgesetzt wird
     * und von unten hereinfährt.
     *
     * Dasselbe gilt seit dem Ring auch für Pille und Herz: Ihre Gegenrechnung
     * gegen den Maßstab der Karte fehlte im ersten Bild, sie standen dort neun
     * Prozent zu schmal — sichtbar bei jedem Kategorie-Wechsel.
     */
    <Animated.View
      /**
       * Die Karte wird als TEXTUR gehalten — und das ist hier ausnahmsweise
       * richtig, obwohl das Projekt mit GPU-Ebenen schlechte Erfahrung hat.
       *
       * Die frühere Erkenntnis lautete: Eine Verschiebung zeichnet nichts neu,
       * eine Ebene spart dort also nichts und kostet nur. Das stimmt — nur geht
       * es hier nicht ums Neuzeichnen, sondern um KANTENGLÄTTUNG. Beim Wischen
       * kippt die Karte, ihre Unterkante wird dadurch zu einer schrägen Linie,
       * und Android glättet die Kanten einer gedrehten Ansicht nicht: Es treppt
       * sie, in jedem Bild ein Stück anders. Genau das ist der grisselige Rand.
       *
       * Als Textur wird die Karte EINMAL gerastert — mit sauber geglätteten
       * Ecken, achsenparallel — und danach wird das fertige Bild gedreht und
       * dabei gefiltert. Die Kante bleibt weich, egal in welchem Winkel.
       *
       * Nebenbei fällt damit auch das sub-pixelgenaue Zittern der waagerechten
       * Unterkante weg, das an den nicht gedrehten Karten dahinter zu sehen war.
       *
       * Der Preis: eine Textur je Karte im Grafikspeicher, und Schrift wird
       * darin ohne Subpixel-Glättung gesetzt — sie kann eine Spur weicher
       * wirken. Ändert sich der Inhalt (Herz umgeschaltet, Kategorie
       * gewechselt), muss die Textur neu entstehen; beides passiert nicht
       * während einer Bewegung.
       */
      /**
       * KEINE Textur auf DIESER Hülle — die liegt eine Ebene tiefer, auf
       * `cardBody`.
       *
       * Hier stand sie, und das war der halbe Umbau: Ich hatte Pille und Herz
       * aus der inneren Textur herausgenommen, damit ihre Gegenrechnung sie
       * nicht in jedem Bild ungültig macht — sie aber beide in DIESER äußeren
       * Hülle gelassen. Die äußere Textur enthielt damit weiterhin zwei Dinge,
       * die sich je Bild ändern, und wurde folglich je Bild neu gerastert. Vier
       * zusätzliche Renderdurchgänge pro Bild, für eine Hülle, die selbst gar
       * nichts zeichnet.
       *
       * Für die geglättete Kante beim Kippen genügt die innere: Der gerundete
       * Clip sitzt auf `styles.card` und liegt damit INNERHALB von `cardBody`.
       */
      style={[styles.deckSlot, DECK_SLOT_BOX, DECK_ENTER_FROM[startSlot], zBox, cardAnim]}
    >
      {body}
    </Animated.View>
  );
});

/**
 * Der Schalter neben der Überschrift — und zugleich die Anzeige des Zustands.
 *
 * Zwei Striche, mittig. Gestapelt ist der untere kürzer, aufgefächert sind
 * beide gleich lang. Das Zeichen sagt damit dasselbe wie der Stapel darunter:
 * ungleich hohe Karten hintereinander gegen gleich große Karten nebeneinander.
 *
 * Die Breite läuft auf DERSELBEN Kurve wie die Karten, nicht als Umschalten am
 * Ende. Ein Zeichen, das erst springt, wenn die Bewegung fertig ist, liest sich
 * als zweite, verspätete Meldung; mitlaufend ist es Teil derselben.
 */
function DeckToggle({ open, onPress }: { open: SharedValue<number>; onPress: () => void }) {
  const t = useT();
  /**
   * MASSSTAB, nicht Breite — und das ist kein Detail.
   *
   * Hier stand `width`, und damit lag ein Layout-Wert in der Bewegung. Der
   * Strich sitzt in der Überschriftenzeile, die Zeile in der Scroll-Fläche:
   * Jedes Bild markierte die Zeile als schmutzig, Android vermaß daraufhin die
   * Überschrift „Beliebte Reiseziele" NEU — Textmessung ist auf Android ein
   * Sprung in die Laufzeitumgebung — und Yoga ging den Inhalt der Scroll-Fläche
   * durch. Für zwei Striche von zusammen 20 Punkten Breite, hundertmal in der
   * Sekunde, während gleichzeitig drei Karten fahren.
   *
   * Ein Maßstab ist eine Eigenschaft der Zeichenliste: kein Layout, keine
   * Messung, kein Commit auf die Zeile. Sichtbar ist es dasselbe — der Strich
   * ist ein einfarbiges Rechteck, an dem sich beim Stauchen nichts verzieht
   * außer einem Eckradius von einem Punkt.
   */
  const lower = useAnimatedStyle(() => ({
    transform: [
      { scaleX: (DECK_BAR_NARROW + (DECK_BAR_WIDE - DECK_BAR_NARROW) * open.value) / DECK_BAR_WIDE },
    ],
  }));
  return (
    <RippleTouch
      borderless
      hitSlop={12}
      style={styles.deckToggle}
      onPress={onPress}
      accessibilityLabel={t("home.destinations.toggle")}
    >
      <View style={styles.deckBar} />
      {/* Startzustand auch STATISCH, nicht nur im Worklet: Der animierte Stil
          kommt vom UI-Strang und greift erst, wenn der einmal durchgelaufen
          ist — bis dahin stünde der Strich sonst auf voller Breite. */}
      <Animated.View style={[styles.deckBar, styles.deckBarNarrow, lower]} />
    </RippleTouch>
  );
}

/**
 * Der Stapel — eigene Komponente, und das aus einem einzigen Grund.
 *
 * Die Zeichenreihenfolge ist der letzte Wert am Stapel, der noch über React
 * läuft, und sie schaltet MITTEN in der Wischbewegung um (siehe unten, rund 60
 * Millisekunden vor dem Ende). Läge sie im Landingscreen, ginge dieser
 * Durchlauf durch dessen kompletten Baum — Verlauf, Kacheln, Chips —, und zwar
 * genau während die Karten fahren. Hier betrifft er nur den Stapel; die vier
 * Karteninhalte sind zusätzlich festgehalten, es bleiben also vier Hüllen.
 */
function DeckSection({
  category,
  deck,
  open,
  heightStyle,
  switchStyle,
}: {
  /** Nur als Auslöser: Wechselt sie, geht der Ring auf Anfang. */
  category: CategoryId;
  deck: Destination[];
  /** 0 = gestapelt, 1 = aufgefächert. Gehört dem Landingscreen (Schalter). */
  open: SharedValue<number>;
  /** Fester Stil, kein animierter: die Höhe hängt am React-Zustand. */
  heightStyle: StyleProp<ViewStyle>;
  /** Der Kategorie-Wechsel — reiner Transform. */
  switchStyle: StyleProp<ViewStyle>;
}) {
  /**
   * Der Ring — eine einzige fortlaufende Zahl.
   *
   * Ganzzahlanteil: wie oft schon gewischt wurde. Nachkomma: wie weit der
   * laufende Wisch ist. Sie wird NIE zurückgesetzt, und genau daran hängt die
   * Sauberkeit des Ganzen: Ein Rücksetzen müsste im selben Bild geschehen wie
   * das Umsortieren der Karten, sonst blitzt für ein Bild ein falscher Zustand
   * auf. Eine Zahl, die einfach weiterläuft, hat dieses Problem nicht.
   */
  const pos = useSharedValue(0);
  const adv = useSharedValue(0);
  const base = useSharedValue(0);
  /** Stand beim Aufsetzen — der Ansatz des laufenden Zugs, siehe `onStart`. */
  const dragFrom = useSharedValue(0);
  const advFrom = useSharedValue(0);
  const dragBase = useSharedValue(0);
  const dir = useSharedValue(1);
  const count = deck.length;

  /**
   * Kategorie gewechselt → Ring auf Anfang.
   *
   * Ohne das startete die neue Kategorie an dem Stand, den die alte gerade
   * hatte, und das beliebteste Ziel läge irgendwo hinten.
   *
   * Ein ausdrückliches Abbrechen der laufenden Federn braucht es NICHT — eine
   * schlichte Zuweisung tut das bereits (`valueSetter` setzt `cancelled` auf der
   * vorigen Animation und hängt sie ab; der Schreibvorgang von außen läuft über
   * `runOnUI` genau in diesen Setzer hinein). Nachgesehen, weil ich zunächst das
   * Gegenteil angenommen und daraus die falsche Ursache abgeleitet hatte.
   */
  /**
   * Der Stand, aus dem die Zeichenreihenfolge gebaut wird.
   *
   * Er zählt EINE Stufe früher weiter als der Ring — bei 60% des Abgangswegs,
   * wenn die Karte draußen ist (siehe DECK_Z_FLIP). Genau dieser Vorlauf
   * deckt die ein bis zwei Bilder ab, die React braucht.
   */
  const [zRing, setZRing] = useState(0);
  /**
   * Und hier die Absicherung gegen den Wettlauf, an dem es schon einmal
   * hängengeblieben ist.
   *
   * Die Meldung von der Bewegung an React ist asynchron. Wechselt man die
   * Kategorie, während eine unterwegs ist, setzt der Rücksetzer unten auf null
   * — und die verspätete Meldung schreibt danach den ALTEN Stand hinein. Ring
   * und Reihenfolge liefen ab da dauerhaft auseinander, und die hinterste Karte
   * bekam die Reihenfolge der vordersten.
   *
   * Jede Meldung trägt deshalb die Kennung der Kategorie, aus der sie stammt.
   * Der Rücksetzer zählt sie hoch; was aus einer älteren kommt, fällt weg. Der
   * geteilte Wert ist die Kopie für den UI-Strang, die Ablage daneben die
   * Wahrheit für React — beide werden nur an dieser einen Stelle gesetzt.
   */
  const gen = useSharedValue(0);
  const genRef = useRef(0);
  const applyZRing = useCallback((v: number, g: number) => {
    if (g !== genRef.current) return;
    setZRing((prev) => (prev === v ? prev : v));
  }, []);

  useAnimatedReaction(
    () => Math.floor(pos.value + (1 - DECK_Z_FLIP)),
    (v, prev) => {
      if (v === prev) return;
      runOnJS(applyZRing)(v, gen.value);
    },
  );

  useEffect(() => {
    genRef.current += 1;
    // Erst die Kennung, dann der Stand: Die Reihenfolge auf dem UI-Strang ist
    // die der Zuweisungen, die Reaktion auf `pos` meldet sich also bereits mit
    // der neuen Kennung.
    gen.value = genRef.current;
    setZRing(0);
    pos.value = 0;
    adv.value = 0;
    base.value = 0;
    dir.value = 1;
  }, [category, pos, adv, base, dir, gen]);


  /**
   * Wischen im eingefahrenen Zustand — die vorderste Karte geht, der Rest rückt auf.
   *
   * `activeOffsetX` lässt die Geste erst nach zwölf Punkten seitlich anspringen:
   * Ein Tipp auf eine Karte bleibt damit ein Tipp, und ein senkrechtes Ziehen
   * bleibt beim Scrollen. `failOffsetY` gibt zusätzlich auf, sobald es
   * eindeutig senkrecht wird — sonst müsste man sich zwischen Wischen und
   * Scrollen entscheiden, bevor man weiß, was man will.
   *
   * Aufgefächert ist das Wischen aus: Dort liegen die Karten nebeneinander, es
   * gibt keinen Stapel, durch den man blättern könnte.
   */
  const pan = useMemo(
    () =>
      Gesture.Pan()
        /**
         * Acht Punkte statt zwölf, bis die Geste anspringt.
         *
         * Der Wert ist ein Tauschgeschäft: Er hält die Geste aus dem Scrollen
         * und aus jedem Tipp heraus, und er ist zugleich der Ansatz, mit dem die
         * Karte losspringt (siehe `onUpdate`). Acht sind klein genug, dass man
         * den Ansatz nicht sieht, und groß genug, dass ein Tipp ein Tipp bleibt
         * — senkrecht sichert ohnehin `failOffsetY`.
         */
        .activeOffsetX([-8, 8])
        .failOffsetY([-14, 14])
        .onStart(() => {
          /**
           * Ein neuer Wisch setzt HIER an, wo der Stapel gerade steht — nicht
           * dort, wo er stehen sollte.
           *
           * Genau das war das Stottern beim schnellen Wischen. Der Ring-Stand
           * wird beim Loslassen sofort weitergezählt, die Feder braucht danach
           * aber noch ihre Zeit. Griff man in diese Zeit hinein, rechnete der
           * nächste Zug vom bereits weitergezählten Stand — der Ring sprang also
           * im ersten Bild des neuen Wischs um den Rest, den die Feder noch offen
           * hatte. Bis zu einer ganzen Stufe: Die abgehende Karte verschwand
           * schlagartig, die nächste stand plötzlich vorn.
           *
           * Mit dem laufenden Stand als Ansatz geht der zweite Wisch nahtlos aus
           * dem ersten hervor. Überschreitet er dabei eine ganze Stufe, ist das
           * richtig so — dann ist die erste Karte eben unterwegs fertig geworden.
           */
          dragFrom.value = pos.value;
          advFrom.value = adv.value;
          dragBase.value = base.value;
        })
        .onUpdate((e) => {
          if (open.value !== 0) return;
          const dx = e.translationX;
          if (dx !== 0) dir.value = dx < 0 ? -1 : 1;
          // Die Strecke zählt ab dem Aufsetzen, damit die Karte am Finger klebt.
          pos.value = dragFrom.value + Math.abs(dx) / DECK_EXIT_X;
          adv.value = advFrom.value + Math.abs(dx) / DECK_ADVANCE_DIST;
        })
        .onEnd((e) => {
          if (open.value !== 0) return;
          const dx = e.translationX;
          const done =
            Math.abs(dx) > DECK_SWIPE_TRIGGER ||
            Math.abs(e.velocityX) > DECK_SWIPE_FLICK;
          /**
           * Das Ziel wird aus dem AKTUELLEN Stand gerechnet, nie aus einer
           * gemerkten Zahl.
           *
           * `Math.max` gegen den Stand beim Aufsetzen ist die Absicherung gegen
           * den Fall, dass die Feder des vorigen Wischs noch nicht angekommen
           * war: Ohne sie würde ein abgebrochener Zweitwisch den ersten wieder
           * zurücknehmen.
           */
          const anchor = Math.max(dragBase.value, Math.floor(pos.value));
          const target = done ? anchor + 1 : anchor;
          /**
           * Die Geschwindigkeit der Hand, umgerechnet in die Einheit des Rings.
           * `velocityX` sind Punkte je Sekunde auf dem Bildschirm; der Ring zählt
           * in Kartenabgängen. Das Vorzeichen kommt über die Richtung dazu.
           */
          const v = (e.velocityX * dir.value) / DECK_EXIT_X;
          base.value = target;
          adv.value = withTiming(target, DECK_ADVANCE_IN);
          pos.value = withSpring(
            target,
            { ...(done ? DECK_SWIPE_OUT : DECK_SWIPE_BACK), velocity: v },
          );
        }),
    [open, pos, adv, base, dir, dragFrom, advFrom, dragBase],
  );

  return (
    <GestureDetector gesture={pan}>
      <Animated.View style={[styles.deck, heightStyle, switchStyle]}>
        {deck.map((d, i) => (
          <DestinationCard
            /**
             * Schlüssel ist der PLATZ, nicht die Destination.
             *
             * Er stand auf `d.id`, und weil sich die Ziele beim
             * Kategorie-Wechsel komplett austauschen, hat React dabei jede
             * Karte abgerissen und neu gebaut: vier Bildflächen, vier Verläufe,
             * acht Vektorsymbole, rund zwei Dutzend Textknoten — in einem
             * einzigen Durchlauf. Genau das war das Ruckeln beim Wechsel.
             *
             * Über den Platz geglichen bleiben die Ansichten stehen und
             * bekommen nur neue Werte. Aus Abriss und Neubau wird eine
             * Aktualisierung.
             */
            key={i}
            d={d}
            index={i}
            count={count}
            /**
             * Zeichenreihenfolge: Die vorderste Stufe liegt oben. Der EINZIGE
             * Wert am Stapel, der noch aus React kommt — Lage, Maßstab und
             * Kippung rechnet die Karte selbst aus `pos`.
             */
            z={count - modSlot(i - zRing, count)}
            open={open}
            pos={pos}
            dir={dir}
            adv={adv}
          />
        ))}
      </Animated.View>
    </GestureDetector>
  );
}

const RECENT_COLLAPSED = 3;
const RECENT_EXPANDED = 8;

// === Screen ===================================================================
export default function HomeScreen() {
  const accent = useAccent();
  const appBg = useAppBg();
  const t = useT();
  const insets = useSafeAreaInsets();
  const navbarSpace = useNavbarSpace();
  const recentSearches = useSearchStore((s) => s.recentSearches);
  const openRecentHistoryOverlay = useSearchStore((s) => s.openRecentHistoryOverlay);

  // Tab gewechselt, WÄHREND die Suche offen ist → sofort schließen, ohne
  // Rück-Expansion (die Kachel ist auf dem neuen Tab gar nicht sichtbar).
  //
  // Bewusst HIER (Fokus-Verlust) und nicht im tabPress: tabPress feuert VOR dem
  // Wechsel — das Overlay gäbe den Landingscreen frei und man sähe ihn kurz
  // aufblitzen. Der Fokus-Verlust kommt NACH dem Wechsel, das Overlay deckt bis
  // dahin, und darunter liegt schon der neue Tab.
  //
  // Geprüft wird der echte Fokus-VERLUST (war fokussiert → ist es nicht mehr),
  // nicht bloß „nicht fokussiert": Sonst würde eine Suche, die aus einem anderen
  // Screen geöffnet wird (NotFound aus der Ergebnisliste), sofort zuklappen.
  // Als <OnFocusLost/> unten im JSX statt useIsFocused() hier: Der Hook an
  // dieser Stelle rendete den kompletten Home-Baum zweimal pro Tab-Wechsel neu
  // — genau im Wechsel-Frame. Die Sentinel-Komponente rendert nur sich selbst.
  // Hier stand ein `useWindowDimensions()`, dessen Wert niemand las. Der Haken
  // abonniert Änderungen der Fenstergröße — und die kommen nicht nur beim
  // Drehen, sondern auch, wenn sich die sicheren Flächen ändern. Jede davon
  // hat den kompletten Baum des Landingscreens neu durchlaufen lassen, für
  // eine Zahl, die nirgends vorkam.

  const closeOpenSearchOnLeave = useCallback(() => {
    const store = useSearchStore.getState();
    // Läuft gerade die Übergabe an die Ergebnisse („Preis vergleichen")? Dann
    // NICHT schließen: Der Such-Screen soll unter der reinslidenden Ergebnis-
    // Liste stehenbleiben. Geschlossen wird er dort, sobald die Slide deckt.
    if (isSearchHandoff()) return;
    if (store.searchOverlayMode == null) return;
    // SOFORT schließen — bewusst KEIN Timer. Ein Delay hier (auch nur ~180ms,
    // um den Tab-Crossfade abzudecken) fühlt sich als Input-Lag an: Man tippt
    // den Tab und es passiert sichtbar nichts. Responsivität schlägt das
    // kurze Durchblitzen des Hintergrunds.
    store.closeSearchOverlay(true);
  }, []);
  const [recentExpanded, setRecentExpanded] = useState(false);
  const [category, setCategory] = useState<CategoryId>("ocean");
  /**
   * Der Kategorie-Wechsel als Bewegung: 0 = an Ort und Stelle, 1 = seitlich raus.
   *
   * Der Tausch der Karten passiert am Umkehrpunkt — dort, wo der Stapel aus dem
   * Bild geschoben ist. Der Wert steht in einem Shared Value, die Richtung
   * ebenso: Der Stapel fährt damit vollständig auf dem UI-Strang, und der
   * einzige React-Durchlauf ist der Tausch selbst.
   */
  /** 1 = um DECK_SWITCH_RISE nach unten versetzt. Trägt das Hereinkommen. */
  const switchRise = useSharedValue(0);
  const switchCategory = useCallback(
    (next: CategoryId) => {
      // Kein Vorspiel: Der Wechsel ist ein Schnitt. Was danach passiert, steht
      // im Effekt darunter.
      if (next !== category) setCategory(next);
    },
    [category],
  );
  /**
   * Der Versatz wird gesetzt, NACHDEM der neue Stapel im Baum steht — und dann
   * zurückgefahren.
   *
   * `useLayoutEffect` und nicht `useEffect`: Der Versatz muss greifen, bevor das
   * erste Bild mit dem neuen Stapel gezeichnet wird. Käme er ein Bild zu spät,
   * stünde der neue Stapel für dieses eine Bild schon an seinem Platz und
   * spränge dann nach unten, um von dort hereinzukommen — ein sichtbarer
   * Rückzieher.
   *
   * Gesetzt wird ohne Animation, zurückgefahren mit: Das Springen selbst sieht
   * niemand, weil es im selben Bild passiert, in dem der alte Stapel ohnehin
   * verschwindet.
   */
  useLayoutEffect(() => {
    switchRise.value = 1;
    switchRise.value = withDelay(DECK_SWITCH_LEAD, withTiming(0, DECK_SWITCH_IN));
  }, [category, switchRise]);
  // Der Slide-nach-links/rechts beim Kategorie-Wechsel ist raus — die Karten
  // kaskadieren jetzt einzeln (ScrollReveal, key enthält die Kategorie). Damit
  // entfällt auch die ganze Buchhaltung, WANN der Slide feuern durfte: Sie war
  // nur nötig, weil `entering` bei jedem Refocus mit dem Scroll auf dem
  // UI-Thread kollidierte.
  // Zeichenreihenfolge des Stapels (hinterste Karte zuerst) — schon beim Laden
  // gebaut, siehe DECK_BY_CATEGORY.
  const deck = DECK_BY_CATEGORY[category];
  /**
   * Auffächern — ohne EINEN React-Zustand.
   *
   * Der Wert lebt im Shared Value, die Richtung in einer Referenz. Beides
   * absichtlich: Ein Zustand hier würde bei jedem Tipp den kompletten Baum des
   * Landingscreens neu durchlaufen, und zwar in genau dem Bild, in dem die
   * Kurve losläuft — React-Commits halten die Reanimated-Commits an, solange
   * sie dauern. Der Stapel, die Kartenhöhe und die Striche im Schalter hängen
   * alle am selben Wert und laufen vollständig auf dem UI-Strang.
   */
  // Bilder der übrigen Kategorien im Hintergrund holen — siehe warmDeckImages.
  useEffect(warmDeckImages, []);

  const deckOpen = useSharedValue(0);
  const deckOpenRef = useRef(false);

  /**
   * Die Höhe der Fläche ist ein REACT-Zustand, kein animierter Wert — und die
   * Kurve startet ein Bild später.
   *
   * Sie lag als geteilter Wert im laufenden Stil, und das hatte eine Folge, die
   * ich unterschätzt hatte. Diese Fläche ist das letzte Kind der Scroll-Fläche:
   * Schrumpft sie beim Einfahren um rund 500 Punkte, liegt der Scroll-Stand
   * plötzlich hinter dem Ende, und Androids ScrollView zieht ihn nach. Dieses
   * Nachziehen schreibt seinerseits einen Zustand zurück in den Baum — ein
   * vollwertiger Commit, der über die Ereignis-Warteschlange läuft und damit
   * ein bis zwei Bilder NACH dem Tipp landet, also mitten im Anlauf der Kurve.
   * Und solange er läuft, hält er Reanimateds eigene Commits an.
   *
   * Als Zustand fällt die Höhenänderung in den Tipp, das Nachziehen unmittelbar
   * danach — und die Kurve beginnt erst im Bild darauf, wenn beides erledigt
   * ist. Dasselbe Muster steht in dieser Datei schon zweimal: erst der schwere
   * Durchlauf, dann die Bewegung.
   */
  const [deckTall, setDeckTall] = useState(false);
  const toggleDeck = useCallback(() => {
    markTransitionBusy(MOTION.duration + 120);
    haptic("button");
    const next = !deckOpenRef.current;
    deckOpenRef.current = next;
    setDeckTall(next);
    requestAnimationFrame(() => {
      deckOpen.value = withTiming(next ? 1 : 0, next ? DECK_OPENING : DECK_CLOSING);
    });
  }, [deckOpen]);

  /**
   * Die Höhe der Sektion springt — EINMAL, im Bild des Tipps, in beide Richtungen.
   *
   * Sie lief beim Einfahren kurz mit, um Androids Zurückziehen des Scroll-Stands
   * über die ganze Kurve zu verteilen statt in ein Bild zu legen. Der Preis war
   * höher als der Gewinn: Diese Ansicht ist ein direktes Kind der Scroll-Fläche,
   * jede Höhenänderung kostet einen Layout-Durchgang über den Seiteninhalt UND
   * ein Nachziehen des Scroll-Stands durch die ScrollView — pro Bild, und zwar
   * genau in der Richtung, die ohnehin schon die schlechtere war.
   *
   * Jetzt hängt die Höhe an einem EIGENEN Wert, den der Schalter direkt setzt,
   * nicht an der laufenden Kurve. Damit schaltet sie im Tipp-Bild um, bevor sich
   * etwas bewegt:
   *
   *  - Ausfahren: Die Fläche wächst sofort. Wachsender Inhalt zieht nie nach,
   *    die Sicht bleibt stehen.
   *  - Einfahren: Die Fläche schrumpft sofort. Steht man weit unten, zieht die
   *    ScrollView den Stand einmal nach — im Bild des Tipps, wo ein Nachrücken
   *    als Reaktion auf den Druck liest, und nicht am Ende der Bewegung, wo es
   *    als Aufschlag liest.
   *
   * Die Karten ragen währenddessen über die geschrumpfte Fläche hinaus. Das ist
   * unbedenklich: React Natives Ansichten klippen ihre Kinder nicht (`clipChildren`
   * steht auf false), sie werden also weitergezeichnet, bis sie den sichtbaren
   * Ausschnitt verlassen.
   *
   * Danach ist die ganze Fahrt frei von Layout — jede Bewegung darin ist
   * Verschiebung oder Maßstab.
   */
  /**
   * NUR der Transform — die Höhe steht daneben als fester Stil.
   *
   * Beides in EINEM Stil zu führen wäre teuer geworden: Reanimated trennt beim
   * Anwenden zwischen Eigenschaften, die es direkt setzen kann (Transform,
   * Deckkraft), und solchen, die einen Commit brauchen — aber es trennt je
   * OBJEKT. Steht eine Höhe darin, geht das ganze Objekt den langsamen Weg,
   * auch der Transform.
   */
  const deckStyle = useAnimatedStyle(() => ({
    transform: [
      { translateY: DECK_SWITCH_RISE * switchRise.value },
      { scale: 1 - (1 - DECK_SWITCH_ZOOM) * switchRise.value },
    ],
  }));
  const visibleRecents = recentSearches.slice(
    0,
    recentExpanded ? RECENT_EXPANDED : RECENT_COLLAPSED
  );
  const canExpand = recentSearches.length > RECENT_COLLAPSED;


  // Keine gestaffelte Einblend-Welle mehr, und inzwischen auch keine Überblendung
  // der Leiste: Der Tab-Wechsel schaltet direkt um, der Inhalt ist dabei sofort
  // vollständig da (siehe _layout.tsx).
  return (
    <>
    <OnFocusLost run={closeOpenSearchOnLeave} />
    {/* HomeContentDepth: NUR der Home-Inhalt dunkelt beim Launch ab (Dim) —
        die native Tab-Bar bleibt statisch. */}
    <View style={styles.fill}>
    <View style={[styles.root, { backgroundColor: appBg }]}>
      <StatusBar barStyle="light-content" backgroundColor="transparent" translucent />
      {/* Unterlay-Parallax: Tippt man im Verlauf auf eine Reise, slidet die
          Ergebnis-Liste von rechts darüber — der Landingscreen rückt dabei ein
          Stück mit, wie bei allen anderen Push-Übergängen.
          Der Stil hängt DIREKT an der Scroll-Fläche (sie ist ohnehin eine
          Animated.ScrollView). Ein eigener Wrapper-Knoten darum hatte das
          Scrollen wieder ruckeln lassen: Android muss eine transformierte
          Ebene um eine scrollende Liste beim Scrollen mit-compositen. */}
      <ParallaxScroll
        style={styles.scroll}
        // Platz für die durchsichtige Leiste — zur Laufzeit, weil er von der
        // sicheren Fläche des Geräts abhängt (siehe useNavbarSpace).
        contentContainerStyle={[styles.scrollContent, { paddingTop: insets.top, paddingBottom: navbarSpace }]}
      >
          {/* Der Header animiert NICHT mit. Dauerhafte Chrome-Elemente (Logo,
              Titel, Tab-Bar) sollen stehen — wandern sie mit, sieht es aus, als
              fiele die ganze Seite von oben herein, statt dass sich der Inhalt
              setzt. Die Welle beginnt darunter. */}
          <Header />

            <SearchBar
              style={styles.searchBarSpacing}
              onTouchStart={() => {
                /**
                 * KEINE Textur für Bos EINfahrt — ausprobiert und verworfen.
                 *
                 * Der Gedanke war schlüssig: Das Such-Blatt schaltet seine Ebene
                 * vor der Kurve ein und fährt als ein fertiges Bild, Bo lief
                 * ohne. Am Gerät wurde es dadurch SCHLECHTER, und zwar auf zwei
                 * Arten gleichzeitig — neue Ruckler bei der Einfahrt und ein
                 * sichtbares Weichzeichnen von Schriftzug und Maskottchen.
                 *
                 * Der Grund: Bos Baum steht während der Einfahrt NICHT still.
                 * Die fünf Zeilen bekommen darin ihre erste Messung, und der
                 * Tiefen-Effekt schreibt daraufhin pro Zeile Deckkraft und
                 * Transform — eine Zeile ohne Maß ist ausdrücklich unsichtbar
                 * und wird erst mit dem ersten Maß sichtbar. Eine GPU-Ebene ist
                 * aber eine gerasterte Momentaufnahme: Ändert ein Nachfahre
                 * etwas, wird sie im selben Bild ungültig und muss neu
                 * hochgeladen werden. Sie war damit teurer als keine — dieselbe
                 * Falle wie bei den Tipp-Punkten, nur andersherum entdeckt.
                 *
                 * Für die AUSFAHRT gilt das nicht: Dort steht der Inhalt fest.
                 * Deshalb hat Bo dort weiterhin eine.
                 */
                /**
                 * Bo schon JETZT aufbauen — er ist geparkt und unsichtbar.
                 *
                 * Zwischen Aufsetzen und Loslassen liegen 80 bis 150ms, die
                 * ohnehin verstreichen. Ohne diesen Vorlauf mountet der
                 * schwerste Baum der App (3500 Zeilen, Bos SVG, die Liste, die
                 * Eingabeleiste) im SELBEN Bild, in dem die Kurve losläuft — die
                 * ersten Bilder der Fahrt gehen dann für den Aufbau drauf.
                 *
                 * Genau der Weg, den Wähler, Such-Blatt und die Texturen längst
                 * gehen: vorbereiten beim Berühren, bewegen beim Loslassen.
                 */
                useSearchStore.getState().preloadAssistant();
              }}
              /**
               * Bewegung zuerst, Navigation danach — wie bei jedem anderen Push.
               *
               * Der Fortschritt ist ein Modul-Wert; er fängt also im
               * Berührungs-Bild an zu laufen, noch bevor der Bildschirm
               * überhaupt existiert. Sichtbar wird das sofort am Parallax des
               * Landingscreens — genau das ist die Rückmeldung „es passiert
               * etwas", und sie ist der Grund, warum die anderen Übergänge sich
               * unmittelbar anfühlen.
               */
              /**
               * Erst der schwere Commit, DANN die Kurve — ein Bild später.
               *
               * Ich hatte es zwischenzeitlich andersherum: Kurve sofort,
               * Speicher-Schreibvorgang im nächsten Bild. Das fühlte sich an,
               * als müsse sich die Bewegung „einen Ruck geben" — und genau das
               * war es auch. `AssistantScreen` hat 3764 Zeilen und hängt selbst
               * an `assistantOpen`; kippt der Schalter, rendert die ganze
               * Komponente neu. Im nächsten Bild heißt: mitten in Bild 2 der
               * Fahrt. Die Kurve rechnet zeitbasiert weiter, während nichts
               * gezeichnet wird, und das nächste sichtbare Bild zeigt sie schon
               * ein Stück weiter — der Ruck.
               *
               * Umgekehrt passiert derselbe Render, während noch nichts in
               * Bewegung ist. Er kostet dann nichts Sichtbares: Bo ist längst
               * aufgebaut (Leerlauf-Vorlauf), es ist ein reiner Neu-Durchlauf
               * ohne Mount. Und die Textur der Unterlage bekommt dadurch ein
               * Bild mehr Zeit, fertig zu werden.
               */
              onPress={() => {
                armAssistantPush();
                useSearchStore.getState().openAssistant();
                requestAnimationFrame(startAssistantPush);
              }}
              onMicPress={() => {
                armAssistantPush();
                useSearchStore.getState().openAssistant(true);
                requestAnimationFrame(() => startAssistantPush());
              }}
            />

          
            <TransportTabs />

          {recentSearches.length > 0 && (
            // Kein ScrollReveal um den GANZEN Block — sonst blenden die Karten
            // doppelt ein (der Block als Ganzes und jede Karte einzeln). Der
            // Container bleibt statisch, nur Kopf und Karten kommen in der Welle.
            <View style={styles.recentSection}>

                <SectionHeaderSmall
                  title={t("home.recent.title")}
                  onViewAll={() => {
                    haptic("button");
                    openRecentHistoryOverlay();
                  }}
                />

              {visibleRecents.map((s, idx) =>
                idx < RECENT_COLLAPSED ? (
                  <RecentCard key={s.id} search={s} />
                ) : (
                  <Animated.View
                    key={s.id}
                    entering={FadeInDown.duration(220)}
                    exiting={FadeOutUp.duration(180)}
                  >
                    <RecentCard search={s} />
                  </Animated.View>
                )
              )}
              {canExpand && (
                // KEIN layout={LinearTransition} mehr — sonst flog der
                // Button bei jeder neuen Recent-Search von oben rein (weil
                // sich die List-Höhe ändert und der Button seine Position
                // animiert). Statisch positioniert: kein Re-Anim wenn man
                // vom Results zurück zum Landing kommt.
                <RippleTouch
                  style={styles.recentToggle}
                  onPress={() => {
                    haptic("button");
                    setRecentExpanded((v) => !v);
                  }}
                >
                  <Text style={[styles.recentToggleText, { color: accent.solid }]}>
                    {recentExpanded ? t("home.recent.showLess") : t("home.recent.showMore")}
                  </Text>
                  {recentExpanded ? (
                    <ChevronUp size={14} color={accent.solid} strokeWidth={2.5} />
                  ) : (
                    <ChevronDown size={14} color={accent.solid} strokeWidth={2.5} />
                  )}
                </RippleTouch>
              )}
            </View>
          )}

          {/* Plain View statt Animated.View+LinearTransition — die Layout-
              Animation war zwar selten aktiv (Section-Height ändert sich kaum
              zwischen Categories), aber Reanimated installiert pro-Frame
              onLayout-Listener auf jedem layout-Prop, was während Scroll
              spürbare Frame-Drops im ScrollView verursachte. Ohne
              LinearTransition snappt die Höhe direkt — kaum sichtbarer
              Verlust, viel smoother Scroll. */}

            {/* „Alle anzeigen" ist raus — es führte nirgendwohin (leerer
                Pressable ohne onPress), und die vier Kategorie-Chips darunter
                sind ohnehin der Weg zu mehr Zielen. */}
            <View style={styles.popularHeader}>
              <Text style={styles.sectionTitle}>{t("home.destinations.title")}</Text>
              <DeckToggle open={deckOpen} onPress={toggleDeck} />
            </View>

            <CategoryChips value={category} onChange={switchCategory} />

          {/* Der Stapel.
              Eine Fläche, in der alle Karten ÜBEREINANDER liegen — ihre Höhe
              ist die vorderste Karte plus der Versatz aller dahinter. Die
              Karten selbst sind absolut gesetzt, deshalb muss die Höhe hier
              stehen: Absolut gesetzte Kinder tragen nichts zum Layout bei, ohne
              diese Zahl bliebe die Fläche flach und der Verlauf darunter liefe
              in die Karten hinein.

              Alle Karten faden GLEICHZEITIG — kein Versatz je Karte. Einzeln
              kaskadierend wirkten sie unruhig, und in einem Stapel wäre es
              zusätzlich irreführend: Eine Welle über übereinanderliegende
              Flächen liest sich als Aufbauen, nicht als Rhythmus. Die Welle
              davor (Suchleiste → Tabs → Verlauf → Überschrift → Chips) trägt
              die Bewegung; der Stapel ist ihr Schlusspunkt.

              Der `key` enthält die Kategorie: Beim Wechsel entstehen die Karten
              neu und faden als Block ein. Das ersetzt den früheren
              Slide-nach-links/rechts. */}
          {/* KEIN `key` mit der Kategorie mehr — der riss die Sektion bei jedem
              Wechsel ab. Der Ring wird stattdessen zurückgesetzt, während der
              Stapel ausgefahren und damit unsichtbar ist (siehe DeckSection). */}
          <DeckSection
            category={category}
            deck={deck}
            open={deckOpen}
            heightStyle={deckTall ? DECK_OPENED : DECK_CLOSED}
            switchStyle={deckStyle}
          />
      </ParallaxScroll>
    </View>
    </View>
    </>
  );
}

// === Styles ===================================================================
const styles = scaledStyles({
  root: { flex: 1, backgroundColor: C.bg },
  scroll: { flex: 1 },
  /** Ersetzt den früheren Launch-Tiefe-Wrapper — der war nur noch flex:1. */
  fill: { flex: 1 },
  // ACHTUNG, KOMMENTAR KORRIGIERT: Hier stand, die Leiste reserviere ihren
  // eigenen Platz und überlagere die Scroll-Fläche nicht. Das stimmt seit dem
  // Umbau auf `BinchTabBar` nicht mehr — sie liegt absolut am Wurzel-Layout
  // ÜBER allen Tabs (BinchTabBar.tsx: `position: "absolute", bottom: 0`), und
  // die Szene bekommt die volle Fensterhöhe. Der Platz für sie kommt deshalb
  // sehr wohl aus dem `paddingBottom: navbarSpace` am Inhalt, genau wie in
  // Saved und Profil. Wer das Padding entfernt, schiebt die letzte Karte
  // hinter die Leiste.
  scrollContent: {},

  // Header
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: GUTTER,
    // Der Takt liegt komplett HIER, nicht halb im Scroll-Inhalt: Der trägt nur
    // noch die sichere Fläche (insets.top), diese Zeile den Rest.
    //
    // Abzüglich BELL_OVERHANG — und genau das fehlte, weshalb das Logo trotz
    // gleicher Zahlen tiefer saß als „Saved" und „Profil": In dieser Zeile steht
    // rechts die Glocke, und die ist mit 44 höher als die Textzeile mit 32. Die
    // Zeile ist damit 44 hoch, und `alignItems: "center"` schiebt den Text um die
    // halbe Differenz nach unten. Der Abstand stimmte also — nur nicht zum Text,
    // sondern zur Glocke. Die Kompensation zieht ihn wieder heraus, oben wie
    // unten, sodass Text und Abstand exakt auf denselben Werten landen wie in
    // den anderen Tabs.
    paddingTop: HEADING_TOP - BELL_OVERHANG,
    paddingBottom: HEADING_GAP - BELL_OVERHANG,
  },
  bell: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: C.surface2,
    alignItems: "center",
    justifyContent: "center",
  },
  bellDot: {
    position: "absolute",
    top: 9,
    right: 10,
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: "#B6F44A",
    borderWidth: 2,
    borderColor: C.surface2,
  },

  // SearchBar spacing
  searchBarSpacing: { marginHorizontal: GUTTER, marginBottom: CONTROL_GAP },

  // Transport tabs
  tabsRow: {
    flexDirection: "row",
    gap: 8,
    paddingHorizontal: GUTTER,
    paddingBottom: 8,
  },
  tabWrap: { flex: 1 },
  tabContent: { alignItems: "center", justifyContent: "center", gap: 6 },
  tabIdle: { backgroundColor: C.surface2 },
  tabLabelIdle: { color: C.white, fontWeight: "600" },
  tab: {
    flex: 1,
    borderRadius: 22,
    paddingVertical: 14,
    paddingHorizontal: 4,
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    overflow: "hidden",
  },
  tabLabel: { fontSize: 12, letterSpacing: -0.1 },

  // Recent
  recentSection: { paddingTop: 18, paddingBottom: 4 },
  sectionHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "baseline",
    marginBottom: 12,
    paddingHorizontal: GUTTER,
  },
  sectionTitleSmall: {
    fontSize: 26,
    fontWeight: FONT.extrabold,
    color: C.white,
    letterSpacing: -0.6,
  },
  actionLink: { fontSize: 13, fontWeight: FONT.semibold },

  recentToggle: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
    paddingVertical: 12,
    marginHorizontal: GUTTER,
    marginTop: 4,
    marginBottom: 8,
    borderRadius: 16,
  },
  recentToggleText: { fontSize: 13, fontWeight: FONT.semibold },

  // Popular header
  popularHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    /**
     * `center` statt `baseline` — wegen des Schalters rechts.
     *
     * An der Grundlinie ausgerichtet hinge ein Zeichen ohne Schrift an der
     * Grundlinie seines eigenen Kastens, also am unteren Rand. `center` stellt
     * beide auf dieselbe Mittellinie. Auf die Höhe der Zeile schlägt das nicht
     * durch: Der Schalter ist 32 hoch, die Überschrift mit ihren 26 Punkten
     * Schriftgrad rund 31 — die Zeile bleibt, wie sie war.
     */
    alignItems: "center",
    paddingHorizontal: GUTTER,
    paddingTop: 20,
    paddingBottom: 14,
  },
  /**
   * Der Auffächer-Schalter. Kein Hintergrund, keine Kante — auf dem dunklen
   * Grund der Seite wäre beides entweder unsichtbar oder ein zweiter Knopf
   * neben dem Buchen-Knopf der Karte. Die Rückmeldung gibt der Ripple.
   *
   * Der rechte Rand ist der GUTTER der Kopfzeile, also derselbe, an dem auch
   * die vorderste Karte und die Suchleiste stehen.
   */
  deckToggle: {
    width: 32,
    height: 32,
    alignItems: "center",
    justifyContent: "center",
    gap: 5,
  },
  deckBar: {
    width: DECK_BAR_WIDE,
    height: 2,
    borderRadius: 1,
    backgroundColor: C.white,
  },
  /** Startzustand als Maßstab — dieselbe Größe, die auch das Worklet schreibt. */
  deckBarNarrow: { transform: [{ scaleX: DECK_BAR_NARROW / DECK_BAR_WIDE }] },
  sectionTitle: {
    fontSize: 26,
    fontWeight: FONT.extrabold,
    color: C.white,
    letterSpacing: -0.6,
  },

  // Category chips
  chipsRow: {
    flexDirection: "row",
    gap: 8,
    paddingHorizontal: GUTTER,
    paddingTop: 4,
    // Kein unterer Rand: Der Abstand zum Stapel steht an DIESEM als `marginTop`,
    // und zwar als derselbe Wert, der auch unter der Suchleiste steht. Hier
    // zusätzlich vier Punkte zu vergeben hieße, den Abstand an zwei Stellen zu
    // führen — und beim nächsten Anfassen stünde er wieder woanders.
    paddingBottom: 0,
  },
  chip: {
    flex: 1,
    borderRadius: 9999,
    paddingVertical: 10,
    paddingHorizontal: SPACE.sm,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  chipLabel: { fontSize: 13, letterSpacing: -0.1 },

  // Destination-Stapel
  /**
   * Die Fläche, über die der Stapel liegt.
   *
   * Der Seitenrand steht HIER und nicht mehr an der Karte: Der Einzug der
   * hinteren Karten wird relativ zu dieser Fläche gerechnet, die vorderste
   * füllt sie ganz aus. So bleibt der Rand des Landingscreens für die vorderste
   * Karte genau derselbe wie vorher.
   *
   * Die Höhe kommt zur Laufzeit dazu (siehe JSX) — sie hängt davon ab, wie
   * viele Karten die Kategorie hat.
   */
  deck: {
    marginHorizontal: GUTTER,
    marginTop: CONTROL_GAP,
    /**
     * 40 unten gegen 12 oben — und das ist Absicht, kein Versehen.
     *
     * Oben grenzt der Stapel an die Kategorie-Chips, also an Inhalt derselben
     * Sektion; dort gilt derselbe Abstand wie zwischen Suchleiste und
     * Transport-Kacheln. Unten grenzt er an die Navigationsleiste — eine
     * fremde, dauerhaft aufliegende Fläche, und die verträgt mehr Luft als zwei
     * Inhalte untereinander.
     *
     * Der Wert war vorher ähnlich groß, aber aus dem falschen Grund: Die
     * Kartenhöhe wurde zweimal heruntergerechnet, die Karte war also kleiner
     * als ihr Platz und ließ unten einen toten Streifen von bis zu 32 Punkten
     * übrig — der zugleich der überschüssige Scroll-Weg war. Mit der Korrektur
     * füllt die Karte ihren Platz aus, und der Abstand steht jetzt als Zahl da,
     * statt aus einem Rechenfehler zu stammen.
     */
    marginBottom: 40,
  },
  /**
   * Höhe der Stapelfläche.
   *
   * Absolut gesetzte Kinder tragen nichts zum Layout bei — ohne diese Zahl
   * bliebe die Fläche flach und der Rest des Landingscreens liefe in die Karten
   * hinein. Beide Summanden sind bereits herunterskaliert (DECK_ROWS und
   * DECK_CARD_H laufen durch `ms`), deshalb steht die Höhe hier NICHT als
   * Rohwert: Das Stilblatt würde sie ein zweites Mal rechnen.
   */
  /**
   * Gemeinsamer Teil des Platzes im Stapel — Höhe inklusive, weil sie für alle
   * Stufen gleich ist. Was sich je Stufe unterscheidet (top, left, right),
   * rechnet die Karte selbst.
   */
  /**
   * Der Platz im Stapel. Links und rechts fest auf 0 — die Karten sind IMMER so
   * breit wie die Fläche; schmaler werden sie über den Maßstab, nicht über das
   * Layout (siehe DECK_SQUEEZE). `top` und `height` kommen je Stufe dazu.
   */
  deckSlot: { position: "absolute", left: 0, right: 0, top: 0 },
  /**
   * Hülle um die Pille, die den Maßstab der Karte gegenrechnet. Ursprung an der
   * linken Kante; `flexShrink` erbt sie von der Pille, damit ein langer
   * Landesname weiterhin gekürzt statt überstellt wird.
   */
  pillWrap: { flexShrink: 1, transformOrigin: "0% 50%" },
  /** Dasselbe für das Herz, Ursprung an der rechten Kante. */
  heartWrap: { transformOrigin: "100% 50%" },
  card: {
    flex: 1,
    borderRadius: CARD_RADIUS,
    /**
     * Der Clip ist WIEDER DA, und die Ebenen runden sich nicht mehr selbst.
     *
     * Der Versuch, ihn wegzulassen, hatte einen klaren Zweck — er sollte das
     * Flackern der Kanten beim Kippen beheben — und er hat ihn verfehlt: Die
     * Kanten flackerten weiter, dafür waren die Ecken gar nicht mehr rund.
     * Damit ist auch die Ursache geklärt: Nicht der Clip flackert, sondern die
     * DREHUNG. Sie lässt die weichen Ecken in jedem Bild etwas anders ausfallen,
     * gleich ob die Rundung aus einer Beschneidung kommt oder aus dem Bild
     * selbst.
     *
     * Ein Clip ist dann die bessere Wahl: EINE Kante statt zweier getrennt
     * geglätteter, und der Ripple der Karte bleibt darin.
     */
    overflow: "hidden",
  },
  /**
   * Die Bildebene — sie trägt die Textur.
   *
   * Getrennt von der Kopfzeile, weil eine Textur nur solange etwas bringt, wie
   * sich in ihr nichts ändert. Hier drin steht Unveränderliches: Foto, Verlauf,
   * Textfeld. Die Gegenrechnung an Pille und Herz, die sich beim Auffächern in
   * jedem Bild ändert, liegt darüber.
   */
  cardBody: { position: "absolute", left: 0, right: 0, top: 0, bottom: 0 },
  /**
   * Die Kopfzeile als eigene Ebene über der Bildebene.
   *
   * Sie sitzt außerhalb des Clips — das ist unbedenklich, weil sie 18 Punkte
   * innen beginnt und an keine Ecke kommt.
   */
  cardTopLayer: { position: "absolute", left: 0, right: 0, top: 0 },
  cardBg: { flex: 1, justifyContent: "flex-end" },
  /** Der Verlauf — nur unten, siehe die Begründung am JSX. */
  cardScrim: { position: "absolute", left: 0, right: 0, bottom: 0, height: "65%" },
  /**
   * Kopfzeile jeder Karte — und zugleich der sichtbare Streifen der hinteren.
   *
   * Die Höhe ist deshalb GENAU der Stapel-Versatz: Was die nächste Karte
   * verdeckt, beginnt exakt dort, wo diese Zeile endet. Der Inhalt sitzt
   * mittig darin, dadurch stehen Land und Herz über alle Stufen hinweg auf
   * gleichmäßigen Abständen.
   */
  /**
   * Kopfzeile — für JEDE Karte dieselbe, nur unten unterschiedlich hoch.
   *
   * `alignItems: "flex-start"` statt `center`, und die Höhe kommt nicht aus der
   * Mitte, sondern aus `paddingTop` plus Tastenhöhe: Bei einer Karte dahinter
   * ist genau das der sichtbare Streifen, die Taste schließt also unten bündig
   * mit der Oberkante der Karte davor ab. Zentriert wäre sie stattdessen
   * mittig in einem Streifen gelandet, dessen Höhe niemand vorgibt.
   *
   * Ein Wert für alle vier Richtungen: oben und seitlich dieselbe Zahl, unten
   * — bei der vordersten Karte, siehe `cardTopFront` — ebenfalls.
   */
  /**
   * Kopfzeile — für JEDE Karte im Stapel dieselbe, ohne Ausnahme.
   *
   * KEINE Höhe: Sie ergibt sich aus Vorlauf plus Taste und muss auch gar nichts
   * steuern. Wie viel von einer Karte dahinter zu sehen ist, entscheidet allein
   * ihr Platz im Stapel — hier stünde die Zahl ein zweites Mal und könnte
   * auseinanderlaufen.
   *
   * `alignItems: "flex-start"`, damit die Tasten am Vorlauf hängen und nicht in
   * der Mitte einer Zeile, deren Höhe niemand vorgibt.
   */
  cardTop: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: SPACE.sm,
    paddingTop: DECK_CARD_INSET,
    paddingHorizontal: DECK_CARD_INSET,
  },
  /**
   * Herz und Landespille sind DASSELBE Glas und DIESELBE Höhe.
   *
   * Dieselbe Höhe, weil sie in einer Zeile nebeneinander liegen: 30 gegen 25
   * las sich als zwei verschiedene Sorten Knopf. Und 38 statt der früheren 30,
   * weil auf derselben Karte der Buchen-Knopf mit 40 steht — daneben waren sie
   * sichtbar zu leicht.
   *
   * Dunkles Glas, kein helles: Was dahinter liegt, ist ein Foto, das an dieser
   * Stelle hell oder dunkel sein kann. Ein dunkler, leicht durchscheinender
   * Grund mit heller Haarlinie hält weißen Text und weißes Symbol über beidem
   * lesbar; eine helle Glasfläche täte das über einem hellen Himmel nicht.
   */
  heartBtn: {
    width: DECK_CTRL_RAW,
    height: DECK_CTRL_RAW,
    borderRadius: DECK_CTRL_RAW / 2,
    backgroundColor: GLASS_FILL,
    borderWidth: 1,
    borderColor: GLASS_EDGE,
    alignItems: "center",
    justifyContent: "center",
  },
  /**
   * Der untere Block ist ein eigenes Feld auf der Karte, kein Text am Rand.
   *
   * Vorher lagen Stadt, Preis und Knopf direkt auf dem Foto, gehalten allein
   * vom Verlauf. Das funktioniert nur, solange das Foto unten dunkel ist — und
   * welches Foto dort einmal liegt, wissen wir nicht. Als abgesetztes Glasfeld
   * trägt der Block seinen eigenen Grund mit; der Verlauf dahinter hilft noch,
   * ist aber nicht mehr die einzige Absicherung.
   *
   * `margin` statt `padding` an der Karte: Der Abstand gehört zum Feld, nicht
   * zum Foto — dadurch ist er links, rechts und unten dieselbe Zahl, und zwar
   * dieselbe, die oben die Tasten von der Kante hält.
   */
  cardBottom: {
    margin: DECK_CARD_INSET,
    /**
     * Der Radius ist GERECHNET: Kartenradius minus Einzug.
     *
     * Genau hier kamen die hervorstechenden unteren Ecken her. Zwei ineinander
     * liegende Rundungen wirken nur dann ruhig, wenn sie denselben Mittelpunkt
     * haben — und das heißt: innen so viel weniger Radius, wie außen Abstand
     * ist. Bei 28 Kartenradius und 18 Einzug sind das 10.
     *
     * Gesetzt waren 20. Damit lief das Feld in der Ecke von der Kartenkante
     * weg: In der Mitte der Kante 18 Punkte Abstand, auf der Winkelhalbierenden
     * nur noch 10 — nachgerechnet 18,0 / 16,9 / 15,7 / 14,0 / 10,0 über den
     * Viertelkreis. Der Streifen zwischen Feld und Kartenkante wurde zur Ecke
     * hin also immer schmaler und bildete dort einen keilförmigen Zwickel.
     *
     * Sichtbar war das nur UNTEN, und auch das erklärt sich: Der Zwickel zeigt
     * den Verlauf ohne das dunklere Glas darüber, ist dort also heller als seine
     * Umgebung. Oben gibt es kein Feld, das die Ecke einengt.
     */
    borderRadius: CARD_RADIUS - DECK_CARD_INSET,
    backgroundColor: GLASS_FILL,
    /**
     * KEINE Haarlinie mehr.
     *
     * Bei Pille und Herz trägt sie: Die beiden sind klein, und die helle Kante
     * macht aus einer Glasfläche einen Knopf. Am Textfeld tut sie das Gegenteil.
     * Es ist fast so breit wie die Karte, seine unteren Ecken liegen dicht an
     * deren Ecken — und dort läuft die Linie als heller Bogen um die Ecke, der
     * sich vom Foto absetzt und als Umrandung liest, nicht als Material.
     *
     * Das Glas trägt sich ohne sie: Die Fläche hebt sich durch ihren eigenen
     * Grund vom Foto ab, und der Verlauf darunter stützt sie zusätzlich.
     */
    // Ringsum gleich — auch innerhalb des Feldes.
    padding: 14,
    flexDirection: "row",
    alignItems: "flex-end",
    justifyContent: "space-between",
    gap: 12,
  },
  metaRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginTop: 6,
  },
  metaText: { fontSize: 12, color: C.gray1, fontWeight: FONT.semibold },
  /** Trennpunkt zwischen den Merkmalen — kein Zeichen, damit er nicht mitfärbt. */
  metaDot: {
    width: 3,
    height: 3,
    borderRadius: 2,
    backgroundColor: C.gray3,
    marginHorizontal: 2,
  },
  countryPill: {
    height: DECK_CTRL_RAW,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    flexShrink: 1,
    borderRadius: DECK_CTRL_RAW / 2,
    paddingHorizontal: 12,
    backgroundColor: GLASS_FILL,
    borderWidth: 1,
    borderColor: GLASS_EDGE,
    // Kein Clip: Der Hintergrund ist schon gerundet, und Text ragt nicht über
    // die Kante. Ein Clip wäre unter der Kipp-Bewegung derselbe Fehler wie an
    // der Karte, nur kleiner.
  },
  /** Die Flagge läuft NICHT durch `textTransform` — Emoji vertragen das nicht. */
  countryFlag: { fontSize: 14 },
  /**
   * Gemischt statt Versalien, und 12 statt 10.
   *
   * Als kleine Versalien war die Pille eine Bildunterschrift auf einem Foto.
   * Hier ist sie eine der beiden Tasten in der Kopfzeile und liegt direkt neben
   * dem gleich hohen Herz — in dieser Rolle muss die Schrift die Fläche auch
   * füllen, sonst wirkt die Pille leer. Der Entwurf setzt die Länder ebenfalls
   * gemischt.
   */
  countryPillText: {
    fontSize: DECK_LABEL_SIZE,
    // Fest, weil die hinterste Stufe des Stapels auf die Unterkante dieser
    // Zeile zielt — siehe DECK_LABEL_BOTTOM.
    lineHeight: DECK_LABEL_LINE,
    includeFontPadding: false,
    fontWeight: FONT.semibold,
    color: C.white,
    letterSpacing: -0.1,
  },
  cityText: {
    // 22 statt 26: Der Titel steht jetzt in einem Feld, das links und rechts je
    // 18 Rand und 14 Polsterung abgibt — die Spalte ist damit rund 60 Punkte
    // schmaler als vorher. Bei 26 stieß „Schwarzwald" an den Buchen-Knopf.
    fontSize: 22,
    fontWeight: FONT.bold,
    color: C.white,
    letterSpacing: -0.66,
    lineHeight: 26,
    /**
     * KEIN Textschatten mehr.
     *
     * Ein Schatten mit Radius geht auf Android über `Paint.setShadowLayer` —
     * einen Weichzeichner, der den schnellen Zeichenweg für Text umgeht, und
     * zwar auf allen drei Karten. Gedacht war er als Absicherung gegen helle
     * Fotos; die leistet inzwischen das Glasfeld unter dem Text, das es damals
     * noch nicht gab. Zweimal abgesichert, einmal davon teuer.
     */
  },
  // 13 statt 16: Der Preis steht jetzt IN der Merkmalzeile. Eine größere
  // Schrift darin würde die Zeilenhöhe der ganzen Zeile hochziehen und Symbol
  // und Text daneben aus der Mitte kippen. Hervorgehoben ist er über Farbe und
  // Schnitt, nicht über die Größe.
  priceValue: { fontSize: 13, fontWeight: FONT.extrabold },
  cta: {
    borderRadius: 9999,
    paddingVertical: 12,
    paddingHorizontal: SPACE.lg,
    // Kein Clip — die Akzentfläche darunter rundet sich selbst (siehe JSX).
  },
  ctaFill: { borderRadius: 9999 },
  ctaText: { fontSize: 13, fontWeight: FONT.bold, color: C.black, letterSpacing: -0.13 },
});
