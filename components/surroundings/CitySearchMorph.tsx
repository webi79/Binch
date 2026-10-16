import { useCallback, useEffect, useRef, type ReactNode } from "react";
import { View, type LayoutChangeEvent } from "react-native";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { format } from "date-fns";
import { ArrowLeft, Bell } from "lucide-react-native";
import { RippleTouch } from "@/components/ui/RippleTouch";
import { SummaryBoxContent, useSummaryLabels } from "@/components/results/SearchSummaryBar";
import { SHEET_IN, SHEET_OUT } from "@/lib/nav/overlayCover";
import { haptic } from "@/lib/haptics";
import { useT } from "@/lib/i18n/useT";
import { usePalette } from "@/lib/theme/appBg";
import { SPACE } from "@/lib/theme/spacing";
import { ms, scaledStyles } from "@/lib/ui/compact";
import { useSearchStore, type CityQuery } from "@/stores/searchStore";

/**
 * DIE SUCHLEISTE WIRD ZUM KASTEN — sobald eine Stadt angetippt ist.
 *
 * Über dem Stadt-Blatt steht dann, was in der Ergebnisliste oben steht: links
 * der Pfeil, in der Mitte der Kasten mit Strecke und Eckdaten, rechts die
 * Glocke. Und er kann dasselbe: Der Kasten öffnet die Such-Slide (Datum,
 * Reisende, Klasse, Stationen ändern), die Glocke den Preis-Alarm, der Pfeil
 * schließt die Stadt. Die beiden Blätter dahinter hängen an der Wurzel
 * (`CitySearchPanels`).
 *
 * DIE VERWANDLUNG — nur Verschiebung, Deckkraft und Eckenradius, kein Layout:
 *
 *   • Die FLÄCHE der Leiste besteht aus zwei Hälften und einer Brücke
 *     darüber. Die Hälften rücken von beiden Seiten um Knopf + Abstand nach
 *     innen, ihr Radius geht dabei von der Pille (halbe Höhe) auf den des
 *     Kastens. Die Brücke deckt in der Mitte die inneren Kanten der Hälften
 *     ab — so sieht es in jedem Bild aus wie EINE Fläche, die schmaler und
 *     eckiger wird.
 *   • Die Beschriftung der Suchleiste blendet in der ersten Hälfte aus, die des
 *     Kastens in der zweiten ein — nie beide zugleich lesbar.
 *   • Pfeil und Glocke wachsen in die frei werdenden Seiten hinein.
 *
 * Warum kein animiertes `left`/`right`/`width`: Das sind Layout-Eigenschaften.
 * Jedes Bild wäre ein Layout-Durchgang samt Neuvermessung der Texte darin, und
 * die Leiste liegt über einer Karte, die in denselben Bildern zeichnet.
 * Verschiebung, Deckkraft und Radius rechnet Reanimated auf dem UI-Strang, ohne
 * Layout.
 *
 * Getaktet wie das Blatt darunter (`SHEET_IN`/`SHEET_OUT`): Kasten und Blatt
 * kommen als EINE Bewegung.
 *
 * Maße wie in der Ergebnisliste: Knopffelder links und rechts, der Kasten mit
 * Radius 16, Symbol 20, Strecke 14/700, Eckdaten 12/600 (`SummaryBoxContent`
 * ist derselbe Baustein). Die Höhe ist die der Suchleiste — sonst müsste die
 * Höhe mitlaufen, und das wäre wieder Layout. Pfeil und Glocke tragen auf der
 * Karte eine Scheibe wie die übrigen Kartenknöpfe: Freistehend wie in der
 * Liste gingen sie auf der hellen Karte und dem Luftbild unter.
 */

/**
 * Scheibe für Pfeil und Glocke — und daraus die Breite des Kastens.
 *
 * Mit 44 (der Größe der Kartenknöpfe) plus 8 Abstand blieb der Kasten auf jeder
 * Seite rund 10 Punkte schmaler als in der Ergebnisliste — gemeldet als „zu
 * klein in der Breite". Die Liste rechnet 20 Rand + 26 Zeichenfeld + 12 = 58
 * je Seite; hier sind es jetzt 16 Rand + 40 + 6 = 62. Vier Punkte Unterschied
 * je Seite bleiben, weil die Zeichen hier eine Scheibe tragen (siehe oben) und
 * mit ihrer rechten Kante auf der Linie der Knopfreihe darunter stehen sollen.
 * Treffer bleiben bequem: `hitSlop` an den Scheiben.
 */
const CIRCLE = 40;
const CIRCLE_GAP = 6;
/** Radius des Kastens — derselbe wie in der Ergebnisliste. */
const BOX_RADIUS = 16;
/** Um so viel rückt jede Seite der Fläche nach innen: Scheibe + Abstand. */
const INSET = ms(CIRCLE) + ms(CIRCLE_GAP);

const WHITE = "#F4F4F5";

/**
 * Die Umrandung der Suchleiste (`rgba(255,255,255,0.14)` in SearchBar.tsx),
 * DECKEND auf ihrer Fläche ausgerechnet.
 *
 * Die Fläche besteht hier aus drei sich überlappenden Teilen. Eine
 * durchscheinende Umrandung wäre an den Überlappungen doppelt so hell zu sehen;
 * deckend verrechnet ist sie überall gleich — und sieht genau aus wie die der
 * Leiste, weil Android die Umrandung ohnehin auf die eigene Fläche zeichnet.
 */
function mixWhite(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1, 7), 16);
  const ch = (shift: number) => {
    const c = (n >> shift) & 0xff;
    return Math.round(c + (255 - c) * alpha)
      .toString(16)
      .padStart(2, "0");
  };
  return `#${ch(16)}${ch(8)}${ch(0)}`;
}

/**
 * Die Suchleiste OHNE eigene Fläche und Umrandung — die zeichnet hier die
 * Verwandlung. Als `style` an `SearchBar` zu geben.
 */
export const SEARCH_BAR_BARE = {
  backgroundColor: "transparent",
  borderColor: "transparent",
} as const;

export function CitySearchMorph({ children }: { children: ReactNode }) {
  const t = useT();
  const palette = usePalette();
  const selectedCity = useSearchStore((s) => s.selectedCity);
  const query = useSearchStore((s) => s.cityQuery);
  const clearSelectedCity = useSearchStore((s) => s.clearSelectedCity);
  const setCityPanel = useSearchStore((s) => s.setCityPanel);
  const active = selectedCity != null;

  /**
   * Beim Schließen bleibt der letzte Inhalt stehen, bis er ausgeblendet ist —
   * die Suche wird mit der Stadt sofort geleert, und der Kasten spränge sonst
   * mitten im Ausblenden auf „Aktueller Standort".
   */
  const lastQuery = useRef<CityQuery | null>(null);
  if (query) lastQuery.current = query;
  const shown = query ?? lastQuery.current;
  const lastCity = useRef<string>("");
  if (selectedCity) lastCity.current = selectedCity.label ?? selectedCity.name;

  const { Icon, routeLabel, metaLabel } = useSummaryLabels({
    mode: shown?.mode ?? "TRAIN",
    // Bis der Vorlauf die Stationen kennt: Standort und Stadt.
    fromLabel: shown?.originLabel || t("search.location.current"),
    toLabel: shown?.destLabel || lastCity.current,
    departDate: shown?.departDate ?? format(new Date(), "yyyy-MM-dd"),
    returnDate: shown?.returnDate ?? "",
    passengers: shown?.passengers ?? 1,
    travelClassKey: shown?.travelClass ?? "",
  });
  const canAlert = !!shown?.origin && !!shown?.destination;

  /** 0 = Suchleiste, 1 = Kasten. */
  const p = useSharedValue(0);
  /**
   * Gestartet NACH dem Commit, der den Inhalt wechselt (Effekt, nicht im
   * Render): Ein geteilter Wert, der im selben Takt wie ein React-Commit
   * geschrieben wird, kann von dessen veralteten Eigenschaften überschrieben
   * werden — im Projekt als schwarzer Such-Bildschirm belegt.
   */
  useEffect(() => {
    p.value = withTiming(active ? 1 : 0, active ? SHEET_IN : SHEET_OUT);
  }, [active, p]);

  /** Höhe der Leiste — für den Radius der Pille (halbe Höhe). */
  const barH = useSharedValue(0);
  const onLayout = useCallback(
    (e: LayoutChangeEvent) => {
      barH.value = e.nativeEvent.layout.height;
    },
    [barH],
  );

  const boxRadius = ms(BOX_RADIUS);
  const leftHalf = useAnimatedStyle(() => {
    const pill = barH.value > 0 ? barH.value / 2 : 9999;
    return {
      borderRadius: pill + (boxRadius - pill) * p.value,
      transform: [{ translateX: INSET * p.value }],
    };
  });
  const rightHalf = useAnimatedStyle(() => {
    const pill = barH.value > 0 ? barH.value / 2 : 9999;
    return {
      borderRadius: pill + (boxRadius - pill) * p.value,
      transform: [{ translateX: -INSET * p.value }],
    };
  });
  const searchFade = useAnimatedStyle(() => ({
    opacity: 1 - Math.min(1, p.value / 0.45),
  }));
  const boxFade = useAnimatedStyle(() => ({
    opacity: Math.max(0, (p.value - 0.4) / 0.6),
  }));
  const sideIn = useAnimatedStyle(() => {
    const o = Math.max(0, (p.value - 0.25) / 0.75);
    return { opacity: o, transform: [{ scale: 0.6 + 0.4 * o }] };
  });

  const fill = palette.s2;
  const edge = mixWhite(palette.s2, 0.14);

  const onBack = useCallback(() => {
    haptic("button");
    clearSelectedCity();
  }, [clearSelectedCity]);
  const onEdit = useCallback(() => {
    haptic("button");
    setCityPanel("edit");
  }, [setCityPanel]);
  const onBell = useCallback(() => {
    if (!useSearchStore.getState().cityQuery?.origin) return;
    haptic("button");
    setCityPanel("alert");
  }, [setCityPanel]);

  return (
    <View onLayout={onLayout}>
      {/* Die Fläche: zwei Hälften, darüber die Brücke. */}
      <Animated.View
        pointerEvents="none"
        style={[styles.half, styles.halfLeft, { backgroundColor: fill, borderColor: edge }, leftHalf]}
      />
      <Animated.View
        pointerEvents="none"
        style={[styles.half, styles.halfRight, { backgroundColor: fill, borderColor: edge }, rightHalf]}
      />
      <View
        pointerEvents="none"
        style={[styles.bridge, { backgroundColor: fill, borderColor: edge }]}
      />

      {/* Die Suchleiste selbst — ohne eigene Fläche (SEARCH_BAR_BARE). */}
      <Animated.View style={searchFade} pointerEvents={active ? "none" : "box-none"}>
        {children}
      </Animated.View>

      {/* Der Kasten — Tipp öffnet die Such-Slide. */}
      <Animated.View
        style={[styles.boxWrap, { left: INSET, right: INSET }, boxFade]}
        pointerEvents={active ? "box-none" : "none"}
      >
        <RippleTouch
          style={styles.box}
          onPress={onEdit}
          accessibilityLabel={[routeLabel, metaLabel, t("results.summary.edit")]
            .filter(Boolean)
            .join(". ")}
        >
          <SummaryBoxContent Icon={Icon} routeLabel={routeLabel} metaLabel={metaLabel} />
        </RippleTouch>
      </Animated.View>

      {/* Pfeil links, Glocke rechts. */}
      <Animated.View
        style={[styles.side, styles.sideLeft, sideIn]}
        pointerEvents={active ? "box-none" : "none"}
      >
        <RippleTouch
          style={styles.circle}
          hitSlop={4}
          onPress={onBack}
          accessibilityLabel={t("common.back")}
        >
          <ArrowLeft size={20} color={WHITE} strokeWidth={2.2} />
        </RippleTouch>
      </Animated.View>
      <Animated.View
        style={[styles.side, styles.sideRight, sideIn]}
        pointerEvents={active ? "box-none" : "none"}
      >
        <RippleTouch
          style={[styles.circle, canAlert ? null : styles.dimmed]}
          hitSlop={4}
          onPress={onBell}
          accessibilityLabel={t("alert.title")}
        >
          <Bell size={19} color={WHITE} />
        </RippleTouch>
      </Animated.View>
    </View>
  );
}

const styles = scaledStyles({
  /**
   * Jede Hälfte ist gut halb so breit wie die Leiste — die zwei Prozent
   * Überlappung halten die Mitte auch im ersten Bild geschlossen.
   */
  half: {
    position: "absolute",
    top: 0,
    bottom: 0,
    width: "51%",
    borderWidth: 1.5,
  },
  halfLeft: { left: 0 },
  halfRight: { right: 0 },
  /**
   * Deckt die inneren Kanten der Hälften ab: nur oben und unten umrandet,
   * ohne Radius — eine teilweise Umrandung MIT Radius zeichnet Android an den
   * Ecken fehlerhaft (siehe SurroundingsSheet.tsx), ohne Radius nicht.
   *
   * Von einem Viertel bis drei Viertel der Breite: Die inneren Kanten der
   * Hälften liegen bei knapp der Hälfte ± Einrückung, und die Einrückung
   * (Scheibe + Abstand, rund 46) bleibt auf jedem Telefon unter einem Viertel
   * der Leistenbreite. Zugleich liegt die Brücke immer innerhalb des Kastens.
   */
  bridge: {
    position: "absolute",
    top: 0,
    bottom: 0,
    left: "25%",
    right: "25%",
    borderTopWidth: 1.5,
    borderBottomWidth: 1.5,
  },
  boxWrap: {
    position: "absolute",
    top: 0,
    bottom: 0,
  },
  /** Wie `box` in SearchSummaryBar.tsx — nur ohne eigene Fläche und Höhe. */
  box: {
    flex: 1,
    borderRadius: BOX_RADIUS,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: SPACE.lg,
    gap: SPACE.md,
  },
  side: {
    position: "absolute",
    top: 0,
    bottom: 0,
    justifyContent: "center",
  },
  sideLeft: { left: 0 },
  sideRight: { right: 0 },
  /** Dieselbe Scheibe wie die Kartenknöpfe (`fab` in MapFabs.tsx), etwas kleiner. */
  circle: {
    width: CIRCLE,
    height: CIRCLE,
    borderRadius: CIRCLE / 2,
    backgroundColor: "rgba(13,13,13,0.92)",
    borderColor: "#212123",
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.4,
    shadowRadius: 12,
    elevation: 6,
  },
  dimmed: { opacity: 0.5 },
});
