import { memo, useCallback, useMemo, useState } from "react";
import { View, Text, Share, Image, StyleSheet } from "react-native";
import { usePalette } from "@/lib/theme/appBg";
import { useRouter } from "expo-router";
import { useRouteMirror } from "@/lib/nav/routeMirror";
import { Heart, Share2, Plane, Train, Bus, Ship, ChevronRight, Route as RouteIcon } from "lucide-react-native";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSequence,
  withTiming,
  Easing,
} from "react-native-reanimated";
import { SearchResult, TravelMode } from "@/types/search";
import { useSearchStore } from "@/stores/searchStore";
import { useT } from "@/lib/i18n/useT";
import { formatTimeInZone, formatDateInZone, shiftIsoByMinutes } from "@/lib/time-format";
import { DelayedTime } from "@/components/results/DelayedTime";
import { redirectUrl, fetchTripPolylines, fetchFlightBookingOptions } from "@/lib/api/client";
import { useAccent } from "@/lib/theme/accent";
import { useQueryClient } from "@tanstack/react-query";
import { haptic } from "@/lib/haptics";
import { RippleTouch } from "@/components/ui/RippleTouch";
import { GradientFill } from "@/components/ui/GradientFill";
import { displayCode, displayProvider, logoUrls } from "@/lib/results/logos";
import { tripSignature } from "@/lib/results/signature";
import { usePressBounce } from "@/lib/motion";
import { prepareLayer, type LayerKey } from "@/lib/nav/transitionLayer";
import { preloadDetails } from "@/lib/nav/detailsPreload";
import { startDetailsPush } from "@/lib/nav/overlayCover";
import { buildRoutePlan } from "@/lib/routing/buildRoute";
import { scaledStyles } from "@/lib/ui/compact";

interface Props {
  result: SearchResult;
  passengers?: number;
  /**
   * Welche Fläche liegt unter dieser Karte?
   *
   * Wird beim bestätigten Tipp als GPU-Textur angelegt, damit sie während der
   * Bewegung des Detail-Blatts nicht jedes Bild neu gezeichnet wird. Dieselbe
   * Karte steht in der Ergebnisliste, im Saved-Tab und in Bos Antworten — welche
   * Fläche dahinter liegt, weiß nur die aufrufende Seite. Ohne Angabe passiert
   * nichts (Bos Liste hat keine eigene Ebene).
   */
  underlay?: LayerKey;
}

const C = {
  card: "#242425",
  border: "#2E2E30",
  text: "#FFFFFF",
  sub: "#8A8A90",
  subDim: "#56565C",
  lime: "#7FEA4D",
  black: "#000000",
};

const MODE_ICON = { FLIGHT: Plane, TRAIN: Train, BUS: Bus, CRUISE: Ship };

// Mode-Farben übernommen aus dem Surroundings-Map (MarkerLayer): einheitliche
// visuelle Sprache zwischen Karten-Markern und Result-Card-Badges.
const MODE_COLOR: Record<TravelMode, { bg: string; fg: string }> = {
  FLIGHT: { bg: "#7FEA4D", fg: "#000000" },
  TRAIN: { bg: "#FFD60A", fg: "#000000" },
  BUS: { bg: "#9D5FE0", fg: "#FFFFFF" },
  CRUISE: { bg: "#6B95B5", fg: "#FFFFFF" },
};

function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

function currencyCode(code: string): string {
  return code.toUpperCase();
}

function ResultCardInner({ result, passengers = 1, underlay }: Props) {
  const palette = usePalette();
  const accent = useAccent();
  const t = useT();
  const router = useRouter();
  // Route NICHT per Hook abonnieren: `usePathname()`/`useLocalSearchParams()`
  // hängen an expo-routers routeInfo-Store, der sich bei JEDEM Tab-Wechsel
  // ändert — das rendete jede gemountete Karte neu, an der memo-Schranke unten
  // vorbei (der Hook saß hier drin). Im Saved-Tab sind alle Trips gleichzeitig
  // gemountet → N schwere Renders im Wechsel-Frame. Gebraucht wird die Route
  // ohnehin nur in onSelect, also lesen wir sie erst dort aus der Ref.
  const routeRef = useRouteMirror();
  /** Druck-Effekt wie an den Kacheln im Landingscreen. */
  const selectBounce = usePressBounce();
  // Sig pro Render einmal berechnen statt im Selector und im handleSave-
  // Callback erneut.
  const resultSig = useMemo(() => tripSignature(result), [result]);
  // KRITISCH: Subscribe nur zum Boolean ob DIESES result gespeichert ist,
  // NICHT zur ganzen savedTrips-Array. Vorher: jeder Save → savedTrips
  // bekommt neue Array-Ref → alle 5-20 sichtbaren ResultCards re-rendern
  // + iterieren ALLE saved trips für ihren .some()-Check. Wachstum:
  // O(N_cards × M_saved) pro Save → mit jedem gespeicherten Trip wurde die
  // App messbar langsamer.
  // Jetzt: O(1) Set-Lookup auf `savedTripSignatures` + Boolean-Vergleich
  // → Re-Render dieser einen Card nur wenn IHR favored-State sich ändert,
  // unabhängig wie viele Trips gespeichert sind.
  const favored = useSearchStore((s) => s.savedTripSignatures.has(resultSig));
  // App-Sprache für die Deeplink-Lokalisierung (Teil des Prefetch-QueryKeys,
  // muss mit DetailsOverlay übereinstimmen damit der Prefetch-Cache greift).
  const locale = useSearchStore((s) => s.locale);
  // Actions sind stable refs → wir holen sie direkt aus getState() statt
  // sie zu subscriben. Sonst hängen pro ResultCard 4 zusätzliche Store-
  // Subscriber-Slots, die bei JEDER Store-Mutation ihren Selector evaluieren
  // (auch wenn das Ergebnis derselbe Function-Ref ist). Bei 5-20 sichtbaren
  // Cards × 4 Subscriptions wird das spürbar.
  const toggleSavedTrip = useSearchStore.getState().toggleSavedTrip;
  const selectResult = useSearchStore.getState().selectResult;
  const setRoute = useSearchStore.getState().setRoute;
  const setRoutePolylines = useSearchStore.getState().setRoutePolylines;
  const queryClient = useQueryClient();

  const bookUrl = result.redirectToken
    ? redirectUrl(result.redirectToken, locale)
    : result.deepLink || "";

  async function onShare() {
    haptic("button");
    try {
      // Preis nur nennen, wenn es einen gibt — Zug-Treffer ohne bahn.de-
      // Anreicherung haben price 0 und verschickten sonst „EUR 0".
      const pricePart =
        result.price > 0 ? ` · ${result.currency} ${result.price.toFixed(0)}` : "";
      await Share.share({
        title: `${result.originLabel} → ${result.destLabel}`,
        message: `${result.provider}${pricePart} — ${bookUrl}`,
        url: bookUrl,
      });
    } catch {
      /* ignore */
    }
  }

  // Doppel-Tap-Guard ist nicht mehr nötig: das Details-Overlay reagiert
  // idempotent auf wiederholtes selectResult (gleiche Daten ⇒ kein
  // Re-Mount, kein doppelter Slide).
  /**
   * Die Textur der Unterlage entsteht beim AUFSETZEN des Fingers.
   *
   * Sie stand bis eben in `onSelect`, also beim LOSLASSEN — entgegen der
   * ausdrücklichen Regel des Moduls, und mit genau der Folge, gegen die die
   * Regel geschrieben ist: Das Einschalten der Ebene erzwingt ein Neuzeichnen
   * des gesamten Baumes darunter, in `saved.tsx` mit 66ms vermessen. Das fiel
   * damit in dieselben Bilder, in denen die Bewegung anlaufen soll — sie startet
   * pünktlich und hängt trotzdem, weil der Strang belegt ist.
   *
   * Zwischen Aufsetzen und Loslassen liegen 80 bis 150ms, die ohnehin
   * verstreichen. Dort kostet der Aufbau niemanden etwas.
   *
   * Welche Fläche darunter liegt, weiß nur die aufrufende Seite: Dieselbe Karte
   * steht in der Ergebnisliste, im Saved-Tab und in Bos Antworten. Ohne Angabe
   * wird nichts vorbereitet.
   */
  const onSelectTouchStart = useCallback(() => {
    if (underlay) prepareLayer(underlay);
    // Detail-Blatt im Berührungsfenster bauen statt im Loslass-Bild.
    preloadDetails(result);
    selectBounce.onPressIn();
  }, [underlay, selectBounce]);

  function onSelect() {
    // Overlay-Pattern: nur den Store füllen — DetailsOverlay im _layout
    // hört auf `selectedResult` und slidet rein. Kein router.push mehr,
    // also keine Navigation-Stack-Mount-Arbeit die den Slide-Start verzögert.
    //
    // Zusätzlich Route-Kontext mit speichern. Die Overlays (DetailsOverlay/
    // LegTimelineOverlay) sind global gemountet → ihre eigenen useLocalSearchParams
    // liefern leere Objekte. Damit „Show on Map" aus dem LegTimeline später
    // sauber via previousHref zurück zur Ergebnis-Liste navigieren kann, muss
    // hier (im Results-Screen, wo die echten Params verfügbar sind) der Kontext
    // mit eingefangen werden.
    // Textur der Unterlage anlegen, solange der Finger gerade abhebt.
    //
    // Das fehlte für das Detail-Blatt komplett — als einziger der vier Übergänge.
    // Der Baum darunter (Ergebnisliste bzw. Saved-Tab) wurde dabei jedes Bild der
    // Bewegung neu gezeichnet. Im Saved-Tab ist genau das der Unterschied
    // zwischen den zwei Reitern: Eine Ticket-Karte legt die Textur an
    // (TicketCard), eine Reise-Karte tat es nicht — dasselbe Blatt, einmal glatt
    // und einmal ruckelig, je nachdem worauf man tippt.
    //
    /**
     * ERSTE Zeile, und das ist keine Kosmetik.
     *
     * Alles darunter kostet Zeit auf demselben Strang: der Speicher-
     * Schreibvorgang weckt jeden Abonnenten, das Detail-Blatt rendert mit einem
     * anderen Ticket komplett durch, Fabric committet das. Stand die Bewegung
     * dahinter, war genau das die Wartezeit zwischen Finger und erster
     * Regung. Von hier aus läuft sie los, und der Rest läuft daneben.
     */
    startDetailsPush();
    /**
     * Und die Druck-Feder auf der Stelle beenden.
     *
     * Sie läuft sonst rund 430ms nach — also fast die ganze Slide — und zwar
     * INNERHALB der Ergebnisliste, die für den Übergang gerade als GPU-Textur
     * eingefroren wurde. Eine Ebene mit sich änderndem Inhalt muss jedes Bild
     * neu gerastert werden: Die beim Aufsetzen vorbereitete Textur war damit
     * nicht nur wertlos, sondern teurer als gar keine.
     *
     * Genau das ist der Unterschied zur Ticket-Karte im Saved-Tab, die als
     * „glatt" gilt — dort bewegt sich in der Unterlage nichts.
     */
    selectBounce.settle();
    const route = routeRef.current;

    /**
     * DER SPEICHER ERST EIN BILD SPÄTER — und das ist der eigentliche Punkt.
     *
     * Hier stand die Annahme, `startDetailsPush()` als erste Zeile lasse die
     * Bewegung „daneben" laufen, während React committet. Auf diesem Stapel
     * stimmt das nicht, und der Grund ist die Zustellreihenfolge:
     *
     *  • Eine Zuweisung an einen geteilten Wert geht über `runOnUI`. Das reiht
     *    nur ein und leert die Schlange in einem MICROTASK — beim Verlassen
     *    dieser Zeile ist auf dem UI-Strang also noch nichts angekommen.
     *  • Ein Loslassen trägt in React die höchste Dringlichkeit. Der Commit,
     *    den `selectResult` auslöst, läuft deshalb SYNCHRON noch in diesem
     *    Aufruf zu Ende.
     *  • Microtasks kommen erst danach dran.
     *
     * Die Reihenfolge im Handler war damit wirkungslos: Erst lief der komplette
     * Commit, dann erst wurde die Bewegung überhaupt zugestellt. Der Commit
     * stand also nicht neben ihr, sondern davor — genau die Verzögerung, die zu
     * beheben er gedacht war.
     *
     * Ein Bild Abstand dreht das um: Die Bewegung ist zugestellt und läuft,
     * bevor der Commit anfängt. Für den Speicher ist das Bild ohne Bedeutung —
     * das Blatt zieht seinen Inhalt ohnehin erst nach, wenn es unterwegs ist.
     */
    requestAnimationFrame(() => {
      selectResult(result, passengers, {
        pathname: route.pathname,
        params: route.params,
      });
    });
    // "button", nicht "important" — dieselbe Stufe wie beim Auslösen der Suche
    // von einer Kachel im Landingscreen. "important" ist der kräftige Stoß und
    // fühlte sich neben demselben Druck-Effekt nach einer anderen Geste an.
    haptic("button");

    // Prefetch: schon beim Card-Tap die Buchungs-Optionen für diesen Flug
    // anfordern. Bis das Overlay durch die Slide-In durch ist, ist
    // die RapidAPI-Antwort meistens schon da → Provider-Liste erscheint
    // ohne sichtbaren Spinner. Reine Network-Last, kein UI-Konflikt mit
    // der Slide-Animation (die läuft auf der UI-Thread via Reanimated).
    //
    // NICHT im Berührungs-Frame: `prefetchQuery` legt synchron einen Beobachter
    // an, schreibt in den Zwischenspeicher und stößt die Anfrage an — alles auf
    // dem JS-Thread, in genau dem Bild, in dem die Bewegung anlaufen soll. Ein
    // Bild später ist für eine Anfrage, auf die ohnehin die ganze Bewegung lang
    // niemand wartet, völlig unerheblich.
    if (result.mode === "FLIGHT" && result.bookingToken) {
      requestAnimationFrame(() => {
      queryClient.prefetchQuery({
        queryKey: ["flightBookingOptions", result.bookingToken, result.currency, passengers, locale],
        queryFn: () =>
          fetchFlightBookingOptions({
            token: result.bookingToken!,
            origin: result.origin,
            destination: result.destination,
            departDate: result.departTime.slice(0, 10),
            passengers,
            currency: result.currency.toUpperCase(),
            lang: locale,
            searchPrice: result.price,
          }),
        staleTime: 5 * 60_000,
      });
      });
    }
  }

  const scale = useSharedValue(1);
  const cardAnim = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  function onToggleFav() {
    haptic("button");
    const justSaved = !favored;
    // toggleSavedTrip batcht Save + Toast in einem set() (sonst zwei
    // Render-Wellen). Hier nur noch die lokale Scale-Bounce-Animation.
    toggleSavedTrip(result, passengers);
    if (justSaved) {
      scale.value = withSequence(
        withTiming(0.92, { duration: 140, easing: Easing.out(Easing.quad) }),
        withTiming(1, { duration: 320, easing: Easing.elastic(1.5) })
      );
    }
  }

  function onShowRoute() {
    haptic("button");
    const plan = buildRoutePlan(result);
    if (!plan) return;
    // PUSH /search/route-map IM selben Stack — KEIN Tab-Wechsel mehr,
    // KEIN router.replace mit previousHref. Results-Screen bleibt drunter
    // gemountet, Back im RouteMapScreen ruft router.back() → pop. Vorher
    // ging das via Surroundings-Tab + router.replace, was beim Zurück-
    // Navigieren den Results-Screen frisch mountete → Loader-Animation
    // spielte unnötig wieder ab.
    setRoute({ ...plan });
    router.push("/search/route-map");

    const tripIds = plan.legs.map((l) => l.tripId).filter((id): id is string => Boolean(id));
    if (tripIds.length > 0) {
      fetchTripPolylines(tripIds)
        .then((r) => setRoutePolylines(r.polylines))
        .catch(() => {});
    }
  }

  const ModeIcon = MODE_ICON[result.mode] ?? Plane;
  const modeColor = MODE_COLOR[result.mode] ?? MODE_COLOR.FLIGHT;
  const carrierName = displayProvider(result);
  const urls = logoUrls(result, carrierName);
  const [logoIdx, setLogoIdx] = useState(0);
  const currentLogoUrl = urls[logoIdx];
  // Zeitformatierung memoisiert: Jeder Aufruf baut ein Date und schlägt die
  // Zeitzone nach. Das lief bei JEDEM Render — also bei jeder hereinscrollenden
  // Karte und erneut bei jedem Favoriten-, Theme- oder Sprachwechsel, obwohl es
  // nur von `result` abhängt.
  const { departStr, arriveStr } = useMemo(
    () => ({
      departStr: formatTimeInZone(result.departTime, result.originTz),
      arriveStr: formatTimeInZone(result.arriveTime, result.destinationTz),
    }),
    [result.departTime, result.originTz, result.arriveTime, result.destinationTz],
  );
  const dateStr = formatDateInZone(result.departTime, result.originTz);
  const arriveDateStr = formatDateInZone(result.arriveTime, result.destinationTz);
  // Verspätung: neue Ist-Zeit = Soll + delayMinutes (zonen-korrekt formatiert).
  const departDelayedStr =
    (result.departDelayMinutes ?? 0) > 0
      ? formatTimeInZone(shiftIsoByMinutes(result.departTime, result.departDelayMinutes!), result.originTz)
      : undefined;
  const arriveDelayedStr =
    (result.arriveDelayMinutes ?? 0) > 0
      ? formatTimeInZone(shiftIsoByMinutes(result.arriveTime, result.arriveDelayMinutes!), result.destinationTz)
      : undefined;
  const isDirect = result.stops === 0;
  const stopVia = !isDirect && result.stopLabels?.length ? result.stopLabels[0] : null;
  const stopLabel = isDirect
    ? t("results.direct")
    : `${result.stops} ${result.stops === 1 ? t("results.stop") : t("results.stops")}${stopVia ? ` · ${stopVia}` : ""}`;
  const flightCode = result.flightNumber ?? "";

  return (
    // Die Hardware-Textur ist RAUS.
    //
    // cardShadow trägt den Schatten, nicht die Karte selbst: Die braucht
    // overflow:"hidden" für ihre runden Ecken, und das schnitte einen
    // Außenschatten weg.
    //
    // Darum lag hier noch ein zweiter Rahmen (`shadowClip`) mit Innenabstand in
    // Schattengröße plus gegenläufigem negativen Rand. Sein einziger Zweck war,
    // die Hardware-Textur groß genug zu machen, damit sie den Schatten nicht
    // abschneidet. Die Textur ist weg (sie invalidierte sich bei jeder
    // Inhaltsänderung selbst), also ist der Rahmen ein Paar Zahlen, die sich
    // gegenseitig aufheben — und eine Ansicht pro Karte, die Fabric bei jedem
    // Listen-Nachschub mit anlegen muss.
    <View style={styles.cardShadow}>
    <Animated.View style={[styles.card, { backgroundColor: palette.s2 }, cardAnim]}>
      <View style={styles.headerRow}>
        <View style={styles.providerWrap}>
          {/* Logo-Box: bei vorhandenem Carrier-Logo transparent, damit das
              echte Logo (Eurowings, DB, FlixBus, …) ohne brand-getönte Box
              dargestellt wird. Beim Fallback ohne Logo behalten wir die
              mode-Farbbox + Lucide-Icon damit die Card visuell strukturiert
              bleibt und der Mode auf einen Blick erkennbar ist. */}
          <View
            style={[
              styles.providerLogo,
              { backgroundColor: currentLogoUrl ? "transparent" : modeColor.bg },
            ]}
          >
            {currentLogoUrl ? (
              <Image
                key={currentLogoUrl}
                source={{ uri: currentLogoUrl }}
                style={styles.providerLogoImg}
                resizeMode="contain"
                // Anbieter-Logos kommen in Originalgröße (oft 512px+) und werden
                // hier auf ~28px gezeigt. Ohne das dekodiert Android das volle
                // Bild in den Speicher und skaliert bei JEDEM Zeichnen herunter;
                // mit "resize" passiert das einmal beim Laden.
                resizeMethod="resize"
                onError={() => setLogoIdx((i) => i + 1)}
              />
            ) : (
              <ModeIcon color={modeColor.fg} size={16} />
            )}
          </View>
          {flightCode ? (
            <Text style={styles.providerCode}>{flightCode}</Text>
          ) : null}
        </View>
        <View style={styles.headerActions}>
          <RippleTouch onPress={onShare} hitSlop={8} borderless style={styles.iconBtn}>
            <Share2 color={C.text} size={18} />
          </RippleTouch>
          <RippleTouch onPress={onShowRoute} hitSlop={8} borderless style={styles.iconBtn}>
            <RouteIcon color={C.text} size={18} />
          </RippleTouch>
          <RippleTouch onPress={onToggleFav} hitSlop={8} borderless style={styles.iconBtn}>
            <Heart
              color={favored ? "#FF3B5C" : C.text}
              fill={favored ? "#FF3B5C" : "transparent"}
              size={18}
            />
          </RippleTouch>
        </View>
      </View>

      <View style={styles.timeRow}>
        <View style={styles.timeCol}>
          {result.dateOnly ? (
            <Text style={styles.timeBig}>—</Text>
          ) : (
            <DelayedTime scheduled={departStr} delayed={departDelayedStr} style={styles.timeBig} />
          )}
        </View>
        <View style={styles.timeCenter}>
          <Text style={styles.durationText}>{formatDuration(result.durationMinutes)}</Text>
          <View style={styles.dottedLineWrap}>
            <View style={[styles.dot, { backgroundColor: isDirect ? accent.solid : "#FFB266" }]} />
            <View style={styles.dottedLine} />
            <View style={[styles.dot, { backgroundColor: isDirect ? accent.solid : "#FFB266" }]} />
          </View>
          <Text style={[isDirect ? styles.statusDirect : styles.statusStops, isDirect && { color: accent.solid }]} numberOfLines={1}>
            {stopLabel}
          </Text>
        </View>
        <View style={[styles.timeCol, { alignItems: "flex-end" }]}>
          {result.dateOnly ? (
            <Text style={styles.timeBig}>—</Text>
          ) : (
            <DelayedTime scheduled={arriveStr} delayed={arriveDelayedStr} style={styles.timeBig} align="flex-end" />
          )}
        </View>
      </View>

      <View style={styles.metaRow}>
        {(() => {
          const code = result.mode === "FLIGHT" ? displayCode(result.origin) : "";
          const label = code || (result.originLabel?.split(",")[0]?.trim() ?? "");
          return (
            <View style={styles.metaCol}>
              <Text style={styles.metaCode} numberOfLines={1}>{label}</Text>
              {dateStr ? <Text style={styles.metaDate}>{dateStr}</Text> : null}
            </View>
          );
        })()}
        {(() => {
          const code = result.mode === "FLIGHT" ? displayCode(result.destination) : "";
          const label = code || (result.destLabel?.split(",")[0]?.trim() ?? "");
          return (
            <View style={[styles.metaCol, { alignItems: "flex-end" }]}>
              <Text style={[styles.metaCode, { textAlign: "right" }]} numberOfLines={1}>
                {label}
              </Text>
              {arriveDateStr ? (
                <Text style={[styles.metaDate, { textAlign: "right" }]}>{arriveDateStr}</Text>
              ) : null}
            </View>
          );
        })()}
      </View>

      <View style={styles.divider} />

      <View style={styles.footerRow}>
        <View style={styles.priceCol}>
          {result.price > 0 ? (
            <Text style={[styles.priceText, { color: accent.solid }]}>
              <Text style={styles.priceLabelInline}>{t("results.from")} </Text>
              {result.price.toFixed(0)}
              <Text style={styles.priceCurrency}>  {currencyCode(result.currency)}</Text>
            </Text>
          ) : (
            <Text style={styles.priceUnknownText}>{t("results.price.provider")}</Text>
          )}
        </View>
        {/* Druck-Effekt am Aufsetzen, NICHT an `onPressIn`: RippleTouch hält
            das um 50ms zurück (Scroll-Schutz), und ein Tipp ist meist kürzer —
            man sähe nichts. Dieselbe Lösung wie am Such-Knopf. */}
        <Animated.View
          style={selectBounce.style}
          onTouchStart={onSelectTouchStart}
          onTouchEnd={selectBounce.onPressOut}
          onTouchCancel={selectBounce.onPressOut}
        >
          {/* Kein sichtbarer Ripple: Sein Auslauf dauert einige hundert
              Millisekunden und läuft damit ebenfalls in der eingefrorenen
              Fläche weiter — dieselbe Begründung wie bei `settle()` oben. Die
              Ticket-Karte im Saved-Tab macht es genauso, und die Rückmeldung
              beim Drücken übernimmt der Druck-Effekt. */}
          <RippleTouch onPress={onSelect} style={styles.cta} rippleColor="transparent">
            <GradientFill />
            <Text style={styles.ctaText}>{t("results.select")}</Text>
            <ChevronRight color={C.black} size={14} strokeWidth={2.5} />
          </RippleTouch>
        </Animated.View>
      </View>
    </Animated.View>
    </View>
  );
}

// Memoization-Wrapper: verhindert dass jede FlatList-Re-Render alle Cards
// re-rendert. Verglichen wird über `result.id` + passengers — gleiche ID =
// gleiche Card, kein Re-Render. Wichtig wenn der Store wegen anderer Felder
// (selectedResult etc.) updated, oder die FlatList neue Prop-Refs vergibt
// nach einem Daten-Refresh.
export const ResultCard = memo(
  ResultCardInner,
  (prev, next) =>
    prev.result.id === next.result.id &&
    prev.passengers === next.passengers &&
    prev.underlay === next.underlay,
);

const styles = scaledStyles({
  cardShadow: {
    borderRadius: 20,
    // EINE Schicht statt drei. Jede Schicht ist ein eigener weicher Verlauf über
    // die volle Kartenbreite, den die GPU beim Zeichnen mit dem Untergrund
    // mischt — beim Scrollen und bei jeder Karten-Animation erneut. Drei davon
    // übereinander kosteten das Dreifache für einen Unterschied, den man im
    // direkten Vergleich nicht sieht: Die mittlere Schicht liegt fast deckungs-
    // gleich unter der ersten, die dritte (2px, ohne Ausbreitung) verschwindet
    // hinter der Kartenkante. Die eine hier ist die Summe: etwas kräftiger
    // (0.55 statt 0.42) und dafür enger gezogen.
    boxShadow: "0px 8px 20px -6px rgba(0, 0, 0, 0.55)",
  },
  card: {
    backgroundColor: C.card,
    borderRadius: 20,
    paddingVertical: 14,
    paddingHorizontal: 16,
  },
  headerRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 14,
    gap: 10,
  },
  providerWrap: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    minWidth: 0,
  },
  providerLogo: {
    width: 28,
    height: 28,
    borderRadius: 8,
    backgroundColor: "#FFFFFF",
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  providerLogoImg: { width: 24, height: 24 },
  providerCode: { color: C.sub, fontSize: 12, fontWeight: "600" },
  headerActions: { flexDirection: "row", alignItems: "center", gap: 12 },
  iconBtn: { padding: 2 },

  timeRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  timeCol: { minWidth: 70, flexShrink: 0 },
  timeBig: { color: C.text, fontSize: 24, fontWeight: "800", letterSpacing: -0.6 },
  timeCenter: { flex: 1, alignItems: "center", gap: 4 },
  durationText: { color: C.sub, fontSize: 11, fontWeight: "600" },
  dottedLineWrap: {
    flexDirection: "row",
    alignItems: "center",
    width: "100%",
    gap: 4,
  },
  // backgroundColor inline mit accent.solid gesetzt am Use-Site.
  dot: { width: 6, height: 6, borderRadius: 3 },
  dottedLine: {
    flex: 1,
    height: 0,
    borderTopWidth: 1,
    borderColor: C.subDim,
    borderStyle: "dashed",
  },
  // color inline mit accent.solid gesetzt.
  statusDirect: { fontWeight: "700", fontSize: 12 },
  statusStops: { color: "#FFB266", fontWeight: "700", fontSize: 12 },

  metaRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    marginTop: 6,
    gap: 10,
  },
  metaCol: { flex: 1, minWidth: 0, alignItems: "flex-start" },
  metaCode: { color: C.sub, fontSize: 12, fontWeight: "700", letterSpacing: 0.4 },
  metaDate: { color: C.subDim, fontSize: 11, fontWeight: "500", marginTop: 2 },

  divider: { height: 1, backgroundColor: C.border, marginVertical: 14 },

  footerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  priceCol: { flex: 1 },
  priceLabelInline: { color: C.sub, fontSize: 11, fontWeight: "700", letterSpacing: 0.4 },
  // color inline mit accent.solid gesetzt.
  priceText: { fontSize: 22, fontWeight: "800", letterSpacing: -0.5 },
  priceCurrency: { color: C.text, fontSize: 12, fontWeight: "700", letterSpacing: 0 },
  priceUnknownText: { color: C.sub, fontSize: 13, fontWeight: "600", marginTop: 1 },
  cta: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    borderRadius: 9999,
    paddingHorizontal: 16,
    paddingVertical: 10,
    overflow: "hidden",
  },
  ctaText: { color: C.black, fontSize: 13, fontWeight: "700", letterSpacing: -0.1 },
});
