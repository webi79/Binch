import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import Animated, { useAnimatedStyle, type useAnimatedProps } from "react-native-reanimated";
import { LinearGradient } from "expo-linear-gradient";
import { GestureDetector } from "react-native-gesture-handler";
import { useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import { Bus, ChevronRight, Plane, Train } from "lucide-react-native";
import {
  fetchCityTripPlan,
  fetchTripPolylines,
  fetchWalkRoute,
  searchByMode,
  type CityModeReason,
  type CityTripMode,
} from "@/lib/api/client";
import { useSearchStore, type RoutePlan, type SelectedCity } from "@/stores/searchStore";
import { useT } from "@/lib/i18n/useT";
import { usePalette } from "@/lib/theme/appBg";
import { useAccent } from "@/lib/theme/accent";
import { scaledStyles } from "@/lib/ui/compact";
import { dayOffset, formatTimeInZone } from "@/lib/time-format";
import { buildRoutePlan } from "@/lib/routing/buildRoute";
import type { useSheetScrollGate } from "@/lib/ui/sheetSwipe";
import type { SearchResult } from "@/types/search";
import { LinePill, iconForProduct, productLabel } from "@/components/results/LinePill";
import { WalkIcon } from "@/components/ui/WalkIcon";
import { ModePill } from "@/components/surroundings/ModePill";
import { whenMapQuiet } from "@/lib/surroundings/mapViewport";
import { RippleTouch } from "@/components/ui/RippleTouch";

/**
 * Der Inhalt des Stadt-Blatts: vom eigenen Standort in die angetippte Stadt.
 *
 * Er sitzt in derselben Hülle wie die Abfahrten einer Haltestelle
 * (`StopDetailSheet`) — gleiche Höhe, gleiche Bewegung, gleiche Geste. Der
 * Aufbau folgt dem Beispiel von Google Maps, in Binchs Farben und Bauteilen:
 *
 *   • Kopf: die Stadt, darunter Entfernung und Startstation. Geschlossen wird
 *     wie das Haltestellen-Blatt — herunterwischen oder Zurück-Taste.
 *   • Zug · Bus · Flug als dieselben Pillen wie an der Haltestelle
 *     (`ModePill`, mit Welle). Zug ist vorgewählt. Was für diese Strecke keinen
 *     Sinn hat, ist gedimmt; antippen erklärt, warum. Die Prüfung macht der
 *     Server (`/api/trip-plan/city`).
 *   • Darunter die Verbindungen als ZEILEN, nicht als Ticket-Karten: links groß
 *     die Dauer, rechts Uhrzeiten, die Linien als Plaketten, Startstation und
 *     „auch um …" für dieselbe Strecke zu anderen Zeiten.
 *
 * Eine Zeile antippen zeigt ihre Strecke auf der Karte; die gewählte Zeile
 * noch einmal antippen öffnet die Buchung (dasselbe Detail-Blatt wie aus der
 * Ergebnisliste).
 *
 * DIE SUCHE STEHT IM STORE (`cityQuery`): Die Suchleiste der Karte verwandelt
 * sich über diesem Blatt in den Kasten der Ergebnisliste (`CitySearchMorph`) —
 * Strecke, Datum, Reisende. Ein Tipp darauf öffnet dieselbe Such-Slide wie
 * dort; was man ändert, landet als `cityEdit` hier und wird neu gesucht. Die
 * Glocke daneben legt einen Preis-Alarm für genau diese Suche an.
 *
 * GESUCHT WIRD NUR DIE GEWÄHLTE ART. Das DB-Kontingent gehört der Suche; alle
 * drei auf einmal hieße drei Suchen pro Tipp auf eine Stadt.
 *
 * FESTER KOPF: Stadtname, Unterzeile und Pillen haben feste Höhen und stehen
 * immer da — beim Wechsel der Stadt ändern sich nur ihre Texte. Vorher fehlte
 * die Unterzeile, solange der Plan lud, und die Auswahl rutschte erst hoch und
 * dann wieder herunter.
 */

type ListProps = ReturnType<typeof useAnimatedProps>;
type Gate = ReturnType<typeof useSheetScrollGate>;

const MODE_ORDER: CityTripMode[] = ["TRAIN", "BUS", "FLIGHT"];
const MODE_TAB = {
  TRAIN: { Icon: Train, tKey: "stop.kind.train" },
  BUS: { Icon: Bus, tKey: "stop.kind.bus" },
  FLIGHT: { Icon: Plane, tKey: "city.mode.flight" },
} as const;

const C = {
  white: "#F4F4F5",
  g1: "#C4C4C8",
  g2: "#8E8E93",
  g3: "#56565C",
  border: "#212123",
};

/** Seitenrand — das App-Raster (`GUTTER` in lib/theme/spacing.ts). */
const GUTTER = 20;

/**
 * Der Schatten an der Kante: dezent, aber sichtbar — ein Drittel Schwarz, das
 * auf zehn Punkten ausläuft. Auf dem fast schwarzen Blatt reicht das.
 */
const EDGE_SHADOW = ["rgba(0,0,0,0.38)", "rgba(0,0,0,0)"] as const;

function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

/** Dauer für die linke Spalte, zweizeilig wie im Beispiel: „1h" / „31m". */
function durationLines(minutes: number): [string, string] {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return [`${m}`, "min"];
  return [`${h}h`, `${m}m`];
}

function formatKm(km: number): string {
  return km < 10 ? `${km.toFixed(1).replace(".", ",")} km` : `${Math.round(km)} km`;
}

/**
 * Welche Strecke eine Verbindung fährt — gleiche Halte, gleiche Linie auf der
 * Karte. Derselbe Zug zu verschiedenen Zeiten ist EINE Strecke; in der Liste
 * steht er einmal, mit „auch um …", und auf der Karte einmal.
 */
function routeSignature(plan: RoutePlan): string {
  return plan.waypoints.map((w) => `${w.latitude.toFixed(3)},${w.longitude.toFixed(3)}`).join("|");
}

interface Group {
  /** Die Zeile: gleiche Strecke UND gleicher Preis (siehe `groups`). */
  sig: string;
  /** Die Strecke auf der Karte — mehrere Zeilen können dieselbe haben. */
  geo: string;
  plan: RoutePlan | null;
  /** Die früheste zuerst — sie steht in der Zeile, die übrigen als „auch um". */
  results: SearchResult[];
}

/** Wie viele verschiedene Strecken die Karte höchstens zeichnet. */
const MAX_ROUTES = 4;

/**
 * Echte Gleis- und Straßenverläufe nachladen — ZUERST die gewählte Strecke,
 * DANACH die grauen Alternativen.
 *
 * Jede Kennung ist ein Abruf bei der Bahn, deren Kontingent der Suche gehört;
 * der Server drosselt deshalb selbst (eigenes Budget, Vorrang für laufende
 * Suchen, siehe routes/trips.ts) und merkt sich jeden Verlauf. Hier heißt das:
 * Die gewählte Strecke kommt in einem eigenen, ersten Abruf und steht sofort
 * richtig; die Alternativen folgen in Paketen zu höchstens zehn.
 *
 * Was der Server wegen seines Budgets diesmal NICHT geliefert hat, wird einmal
 * nach `POLYLINE_RETRY_MS` nachgefragt — sonst blieben graue Linien gerade.
 * Nacheinander, nicht gleichzeitig; ein Zug, der in mehreren Verbindungen
 * steckt, wird nur einmal geholt.
 */
async function loadPolylines(
  plans: RoutePlan[],
  first: number,
  key: string,
  apply: (p: Record<string, [number, number][]>) => void,
) {
  const idsOf = (p: RoutePlan | undefined) =>
    (p?.legs ?? []).filter((l) => l.tripId && !l.walking).map((l) => l.tripId!);
  const selected = [...new Set(idsOf(plans[first]))];
  const rest = [
    ...new Set(plans.flatMap((p, i) => (i === first ? [] : idsOf(p)))),
  ].filter((id) => !selected.includes(id));

  const stillCurrent = () => useSearchStore.getState().cityRoutes?.key === key;
  const missing: string[] = [];
  const load = async (ids: string[]) => {
    for (let i = 0; i < ids.length; i += 10) {
      // Längst eine andere Suche gezeigt? Dann nicht weiter nachladen.
      if (!stillCurrent()) return;
      const chunk = ids.slice(i, i + 10);
      try {
        const res = await fetchTripPolylines(chunk);
        if (!stillCurrent()) return;
        for (const id of chunk) if (!res.polylines[id]) missing.push(id);
        // Nicht in eine Kamerafahrt oder ein Ziehen hinein — siehe `whenMapQuiet`.
        whenMapQuiet(() => {
          if (stillCurrent()) apply(res.polylines);
        });
      } catch {
        // Ein Paket ohne Verlauf bleibt gerade — die übrigen versuchen wir trotzdem.
      }
    }
  };
  await load(selected);
  await load(rest);
  if (missing.length === 0) return;
  await new Promise((done) => setTimeout(done, POLYLINE_RETRY_MS));
  const again = missing.splice(0);
  await load(again);
}

/** Wann Verläufe, die der Server wegen seines Budgets zurückgestellt hat, erneut gefragt werden. */
const POLYLINE_RETRY_MS = 8000;

export function CityTripBody({
  city,
  bodyReady,
  gate,
  listProps,
  listBottomInset,
}: {
  city: SelectedCity;
  bodyReady: boolean;
  gate: Gate;
  listProps: ListProps;
  /** Wie viel vom Blatt in der Mitte unter dem Bildrand liegt — Luft am Listenende. */
  listBottomInset: number;
}) {
  const t = useT();
  const palette = usePalette();
  const currency = useSearchStore((s) => s.currency);
  const setCityRoutes = useSearchStore((s) => s.setCityRoutes);
  const selectCityRoute = useSearchStore((s) => s.selectCityRoute);
  const setCityRoutePolylines = useSearchStore((s) => s.setCityRoutePolylines);
  const selectResult = useSearchStore((s) => s.selectResult);
  const mapSelected = useSearchStore((s) => s.cityRoutes?.selected ?? 0);
  const routesKey = useSearchStore((s) => s.cityRoutes?.key ?? null);
  const setCityRouteLegCoords = useSearchStore((s) => s.setCityRouteLegCoords);
  const edit = useSearchStore((s) => s.cityEdit);
  const setCityQuery = useSearchStore((s) => s.setCityQuery);
  const setCityCheapest = useSearchStore((s) => s.setCityCheapest);

  const cityKey = `${city.name}|${city.latitude.toFixed(4)}|${city.longitude.toFixed(4)}`;
  /**
   * Neue Stadt: beim Zug anfangen. Dieser Baustein wird je Stadt NEU
   * aufgebaut (`key` im Blatt), der Anfangswert reicht also.
   *
   * Ausnahme: zurück aus „Auf Karte anzeigen" — dann liegt die Suche dieser
   * Stadt wieder im Store (`restoreSurroundings`), samt Verkehrsmittel. Dort
   * weitermachen, nicht beim Zug.
   */
  const restoredMode = (): CityTripMode | null => {
    const q = useSearchStore.getState().cityQuery;
    return q && MODE_ORDER.includes(q.mode as CityTripMode) ? (q.mode as CityTripMode) : null;
  };
  const [mode, setMode] = useState<CityTripMode>(() => restoredMode() ?? "TRAIN");
  /** Hat der Nutzer selbst gewählt? Dann wird nie mehr automatisch umgestellt. */
  const pickedRef = useRef(restoredMode() != null);
  const modeRef = useRef(mode);
  modeRef.current = mode;
  /**
   * FLÜGE NUR AUF AUSDRÜCKLICHEN WUNSCH.
   *
   * Jede Flugsuche kostet vom knappen Kontingent des Flug-Anbieters. Springt
   * die Auswahl von selbst auf „Flug" (kein Zug, kein Bus — siehe unten),
   * steht dort erst ein Knopf „Flüge suchen"; gesucht wird nach dessen Tipp,
   * nach einem Tipp auf die Pille oder nach „Suchen" in der Slide.
   *
   * Freigegeben ist GENAU die Suche, für die getippt wurde — ihr Schlüssel aus
   * Strecke, Datum, Reisenden, Klasse, Tag und Währung (`flightKey`). Ändert
   * sich einer davon ohne Tipp (Währung in den Einstellungen, Mitternacht),
   * steht wieder der Knopf da: Vorher galt die Freigabe für die ganze
   * Lebensdauer des Blattes, und jeder dieser Wechsel löste still eine neue,
   * kostenpflichtige Flugsuche aus. `"next"` = die nächste Suche, die zustande
   * kommt (Tipp auf die Pille — der Schlüssel entsteht erst mit dem Wechsel —,
   * oder „Suchen" in der Slide).
   *
   * Zurück aus „Auf Karte anzeigen": nichts freigegeben. Die Ergebnisse kommen
   * aus dem Zwischenspeicher (gleicher Schlüssel); sind sie verfallen,
   * entscheidet wieder der Knopf.
   */
  const [flightArm, setFlightArm] = useState<string | null>(null);

  const from = city.from;
  /**
   * In der Such-Slide gewählter Start bzw. Ziel — gelten für ALLE
   * Verkehrsmittel (siehe `CityEdit`). Der Vorlauf plant dann von dort bzw.
   * dorthin, und jedes Verkehrsmittel wird neu geprüft.
   */
  const editFrom = edit?.from ?? null;
  const editTo = edit?.to ?? null;
  const planQ = useQuery({
    queryKey: [
      "cityPlan",
      editFrom ? editFrom.code : `${from?.latitude.toFixed(3)},${from?.longitude.toFixed(3)}`,
      editTo ? editTo.code : cityKey,
    ],
    queryFn: () =>
      fetchCityTripPlan(from, city, {
        fromCode: editFrom?.code,
        fromLabel: editFrom?.label,
        toCode: editTo?.code,
        toLabel: editTo?.label,
      }),
    // Ohne Standort geht es nur, wenn ein Start gewählt wurde.
    enabled: !!from || !!editFrom,
    staleTime: 10 * 60 * 1000,
    retry: 1,
  });
  const plan = planQ.data;

  /**
   * Zug ist vorgewählt — gibt es aber keinen (Europa → Sydney), springt die
   * Auswahl einmal auf die erste Art, die es gibt. Der gedimmte Zug bleibt
   * sichtbar und erklärt sich beim Antippen. Ist das der Flug, wird damit noch
   * NICHT gesucht (siehe `flightArmed`).
   */
  useEffect(() => {
    if (!plan || pickedRef.current) return;
    if (plan.modes[mode].available) return;
    const first = MODE_ORDER.find((m) => plan.modes[m].available);
    if (first) setMode(first);
  }, [plan, mode]);

  const modePlan = plan?.modes[mode];
  const planRoute = modePlan && modePlan.available ? modePlan : null;
  /**
   * DIE STRECKE — aus dem Vorlauf.
   *
   * Der Vorlauf rechnet schon mit gewähltem Start und Ziel (siehe `planQ`).
   * Für das Verkehrsmittel, in dem ein Ort gewählt wurde, gilt er selbst — wer
   * dort „Münster-Hiltrup" wählt, meint Hiltrup und nicht den Bahnhof, den der
   * Vorlauf in Münster fände.
   *
   * Sind Start UND Ziel in diesem Verkehrsmittel gewählt, gilt die Strecke
   * auch dann, wenn der Vorlauf dafür nichts gefunden hat: Wer beide Stationen
   * selbst einträgt, soll seine Verbindungen bekommen.
   */
  const ownFrom = editFrom && editFrom.mode === mode ? editFrom : null;
  const ownTo = editTo && editTo.mode === mode ? editTo : null;
  const route =
    ownFrom && ownTo
      ? {
          origin: { code: ownFrom.code, label: ownFrom.label },
          destination: { code: ownTo.code, label: ownTo.label },
        }
      : planRoute
        ? {
            origin: ownFrom ? { code: ownFrom.code, label: ownFrom.label } : planRoute.origin,
            destination: ownTo ? { code: ownTo.code, label: ownTo.label } : planRoute.destination,
          }
        : null;
  /**
   * Start und Ziel dieselbe Station — nur möglich, wenn in der Slide gewählt
   * wurde (der Vorlauf bietet so etwas nie an). Eine Suche dafür ergibt nichts
   * und kostet trotzdem; statt ihrer steht ein Hinweis.
   */
  const sameEnds = route != null && route.origin.code === route.destination.code;
  /** Anderes Ziel gewählt? Dann trägt der Kopf dessen Stadt statt der angetippten. */
  const destChanged = editTo != null;
  /** Der Name des Ziels — im Kopf UND in den Hinweisen („… ist zu nah"). */
  const headerTitle = destChanged
    ? (plan?.destination.name ?? editTo!.label)
    : (city.label ?? city.name);

  /**
   * Datum, Uhrzeit, Reisende, Klasse — ohne Änderung wie bisher: heute, ab
   * jetzt, eine Person, ohne Klasse.
   */
  const today = format(new Date(), "yyyy-MM-dd");
  const departDate = edit?.departDate || today;
  const departTime = edit?.departTime ?? "";
  const returnDate = edit?.returnDate ?? "";
  const passengers = edit?.passengers ?? 1;
  const travelClass = edit?.travelClass ?? "";
  const searchKey = route
    ? [
        mode,
        route.origin.code,
        route.destination.code,
        departDate,
        departTime,
        returnDate,
        passengers,
        travelClass,
      ].join("|")
    : null;

  /**
   * Die Suche für den Kasten oben, die Such-Slide und den Preis-Alarm
   * veröffentlichen — auch ohne Strecke, damit der Kasten wenigstens
   * Verkehrsmittel, Datum und Reisende zeigt, solange der Vorlauf lädt.
   */
  const routeOriginCode = route?.origin.code ?? "";
  const routeOriginLabel = route?.origin.label ?? "";
  const routeDestCode = route?.destination.code ?? "";
  const routeDestLabel = route?.destination.label ?? "";
  const tripType = edit?.tripType ?? "";
  useEffect(() => {
    // Nur für eine OFFENE Stadt. Beim Schließen bleibt dieser Inhalt für die
    // Ausfahrt stehen, und das Zurücksetzen der Änderungen ließe diesen Effekt
    // sonst noch einmal laufen — die Suche einer geschlossenen Stadt stünde
    // danach wieder im Store.
    if (useSearchStore.getState().selectedCity !== city) return;
    setCityQuery({
      mode,
      origin: routeOriginCode,
      originLabel: routeOriginLabel,
      destination: routeDestCode,
      destLabel: routeDestLabel,
      departDate,
      departTime,
      returnDate,
      tripType,
      passengers,
      travelClass,
    });
  }, [
    mode,
    routeOriginCode,
    routeOriginLabel,
    routeDestCode,
    routeDestLabel,
    departDate,
    departTime,
    returnDate,
    tripType,
    passengers,
    travelClass,
    setCityQuery,
    // Dieselbe Stadt NEU angetippt, während sie noch hinausfuhr: neues Objekt,
    // gleicher Baustein (kein Neuaufbau) — ohne `city` hier bliebe die Suche
    // leer, und „Suchen" und die Glocke täten nichts.
    city,
  ]);

  const flightKey = searchKey ? `${searchKey}|${today}|${currency}` : null;
  // „next" gilt schon im selben Durchgang für den dann feststehenden Schlüssel —
  // sonst blitzte zwischen Tipp und Festschreiben der Knopf „Flüge suchen" auf.
  const flightArmed = flightKey != null && (flightArm === flightKey || flightArm === "next");
  // „Die nächste Suche" auf die jetzt feststehende festschreiben.
  useEffect(() => {
    if (flightArm === "next" && flightKey) setFlightArm(flightKey);
  }, [flightArm, flightKey]);

  const searchQ = useQuery({
    // Die Währung gehört dazu: Sie geht an den Server, und ein Treffer aus dem
    // Zwischenspeicher in EUR landete sonst nach dem Wechsel auf CHF als
    // Grundpreis eines CHF-Alarms.
    queryKey: ["citySearch", searchKey, today, currency],
    queryFn: () =>
      searchByMode({
        mode,
        origin: route!.origin.code,
        destination: route!.destination.code,
        originLabel: route!.origin.label,
        destLabel: route!.destination.label,
        departDate,
        /**
         * Nur eine GEWÄHLTE Uhrzeit geht mit. „Ab jetzt" für heute machen die
         * Anbieter ohnehin selbst (db-vendo auf 5 Minuten gerundet, MOTIS ab
         * jetzt — siehe `initialDepartureTime` bzw. `startForDate` am Server).
         *
         * Hier stand bis eben `new Date().toISOString()` — auf die Millisekunde
         * genau. Die Uhrzeit ist Teil der Cache-Identität am Server: Jede
         * Stadt-Suche lief damit live bei den Anbietern, keine wurde je
         * wiederverwendet, und ein Wiederholungsversuch baute einen neuen
         * Zeitstempel — also eine zweite, vollständige Suche.
         */
        ...(departTime ? { departTime } : {}),
        // Nur einfache Fahrt (siehe CitySearchPanels) — kein Rückdatum.
        ...(travelClass ? { travelClass } : {}),
        passengers,
        currency,
      }),
    // Erst nach der Einfahrt: Die Liste soll nicht mitten in die Bewegung
    // hineinpoppen, und ein Tipp, der sofort wieder zugewischt wird, sucht nicht.
    // Flüge nur auf Wunsch (`flightArmed`), nie von einer Station zu sich selbst.
    enabled: !!route && bodyReady && !sameEnds && (mode !== "FLIGHT" || flightArmed),
    /**
     * Flüge: KEIN Nachladen von selbst — nicht beim Wiedereinhängen (zurück aus
     * „Auf Karte anzeigen"), nicht nach einem Netzabbruch, kein zweiter Versuch
     * nach einem Fehler. Jede Flugsuche kostet vom Kontingent des Anbieters;
     * neu gesucht wird nur auf Tipp (Pille, Knopf, „Suchen", „Nochmal").
     */
    ...(mode === "FLIGHT"
      ? { staleTime: Infinity, refetchOnMount: false, refetchOnReconnect: false, retry: 0 }
      : { staleTime: 5 * 60 * 1000, retry: 1 }),
  });

  /** Nur Hinfahrten, nur was noch nicht weg ist, früheste zuerst. */
  const results: SearchResult[] = useMemo(() => {
    const now = Date.now() - 60_000;
    return (searchQ.data?.results ?? [])
      .filter(
        (r) => r.direction !== "RETURN" && (r.dateOnly || new Date(r.departTime).getTime() >= now),
      )
      .sort((a, b) => new Date(a.departTime).getTime() - new Date(b.departTime).getTime());
  }, [searchQ.data]);

  /**
   * Der günstigste ECHTE Preis dieser Suche — für den Preis-Alarm der Glocke.
   *
   * Über ALLE Treffer, wie in der Ergebnisliste (`cheapestPrice` dort): Der
   * Server vergleicht die Schwelle später mit derselben Suche, also muss der
   * Grundpreis aus derselben Menge stammen. 0 heißt: kein Preis — das Blatt
   * des Alarms sagt das dann selbst. Nichts wird geschätzt.
   */
  useEffect(() => {
    if (useSearchStore.getState().selectedCity !== city) return;
    let min = 0;
    for (const r of searchQ.data?.results ?? []) {
      if (r.price > 0 && (min === 0 || r.price < min)) min = r.price;
    }
    setCityCheapest(min);
  }, [searchQ.data, setCityCheapest, city]);

  /** Dieselbe Strecke zu mehreren Zeiten → eine Zeile. Reihenfolge: früheste Abfahrt. */
  const groups: Group[] = useMemo(() => {
    const out: Group[] = [];
    const bySig = new Map<string, Group>();
    for (const r of results) {
      const p = buildRoutePlan(r);
      const geo = p ? routeSignature(p) : `id:${r.id}`;
      /**
       * Zusammengefasst wird nur, was auch GLEICH KOSTET — und bei Flügen nur
       * derselbe Flug.
       *
       * Vorher reichte dieselbe Strecke. Die Zeile zeigte dann „ab 350 EUR"
       * für die früheste Fahrt, während unter „auch um …" eine für 49 EUR
       * stand; bei Flügen (die Karte kennt nur die zwei Flughäfen) lagen
       * sogar alle Flüge des Tages in einer Zeile. „ab" hieß damit nicht mehr
       * „der günstigste" — das ist irreführend, und gebucht werden konnte
       * ohnehin nur die erste.
       */
      const priceKey = r.price > 0 ? Math.round(r.price * 100) : 0;
      const flightKey = r.mode === "FLIGHT" ? `#${r.flightNumber ?? r.id}` : "";
      const sig = `${geo}#${priceKey}${flightKey}`;
      const g = bySig.get(sig);
      if (g) g.results.push(r);
      else {
        const ng = { sig, geo, plan: p, results: [r] };
        bySig.set(sig, ng);
        out.push(ng);
      }
    }
    return out;
  }, [results]);

  /** Die gezeichneten Strecken der Karte, als Strecken-Signatur je Index. */
  const geosRef = useRef<string[]>([]);
  const [selectedSig, setSelectedSig] = useState<string | null>(null);

  /**
   * Die Strecken für die Karte — die ersten `MAX_ROUTES` Zeilen, die erste
   * gewählt. Mehr würde die Karte zu einem Knäuel.
   */
  useEffect(() => {
    /**
     * Nur für die OFFENE Stadt. Beim Schließen bleibt dieser Inhalt noch für
     * die Ausfahrt stehen; das Zurücksetzen der Änderungen ließ ihn dabei mit
     * der unveränderten Suche weiterrechnen — die kam sofort aus dem
     * Zwischenspeicher, und die Routen einer geschlossenen Stadt standen wieder
     * im Store (samt Kamerafahrt und Gleisverlauf-Abrufen).
     */
    if (useSearchStore.getState().selectedCity !== city) return;
    if (!searchKey || groups.length === 0) {
      setCityRoutes(null);
      geosRef.current = [];
      setSelectedSig(null);
      return;
    }
    // Jede Strecke EINMAL auf die Karte — mehrere Zeilen (andere Preise,
    // andere Flüge) können dieselbe fahren.
    const seen = new Set<string>();
    const drawn = groups
      .filter((g) => {
        if (!g.plan || seen.has(g.geo)) return false;
        seen.add(g.geo);
        return true;
      })
      .slice(0, MAX_ROUTES);
    const plans = drawn.map((g) => g.plan!);
    geosRef.current = drawn.map((g) => g.geo);
    setSelectedSig(drawn[0]?.sig ?? null);
    if (plans.length === 0) {
      setCityRoutes(null);
      return;
    }
    setCityRoutes({
      key: searchKey,
      plans,
      resultIds: drawn.map((g) => g.results[0]!.id),
      durations: drawn.map((g) => formatDuration(g.results[0]!.durationMinutes)),
      selected: 0,
    });
    void loadPolylines(plans, 0, searchKey, setCityRoutePolylines);
  }, [searchKey, groups, setCityRoutes, setCityRoutePolylines, city]);

  /**
   * Umstiege zu Fuß entlang der Straßen — für die GEWÄHLTE Verbindung.
   *
   * Die Anbieter liefern für einen Fußweg nur Anfang und Ende; die Karte zog
   * eine Gerade quer über die Häuser. Der Verlauf kommt von derselben Stelle
   * wie der Weg vom Standort zur Station (`/api/walk`), nacheinander und nur
   * für die Verbindung, die man ansieht.
   */
  useEffect(() => {
    if (!routesKey) return;
    const plan = useSearchStore.getState().cityRoutes?.plans[mapSelected];
    if (!plan) return;
    let cancelled = false;
    void (async () => {
      for (let i = 0; i < plan.legs.length; i++) {
        const leg = plan.legs[i]!;
        if (!leg.walking || leg.coords) continue;
        const a = plan.waypoints[leg.fromIndex];
        const b = plan.waypoints[leg.toIndex];
        if (!a || !b) continue;
        try {
          const w = await fetchWalkRoute(a, b);
          if (cancelled) return;
          if (w) {
            // Nicht in eine Kamerafahrt oder ein Ziehen hinein — siehe `whenMapQuiet`.
            whenMapQuiet(() => {
              if (!cancelled) setCityRouteLegCoords(routesKey, mapSelected, i, w.coords);
            });
          }
        } catch {
          // Ohne Verlauf bleibt dieser Fußweg eine Gerade.
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [routesKey, mapSelected, setCityRouteLegCoords]);

  /**
   * Tipp auf eine graue Linie der Karte → ihre Zeile markieren. Gehört die
   * markierte Zeile schon zu dieser Strecke, bleibt sie es (mehrere Zeilen
   * können dieselbe Strecke fahren); sonst die erste dieser Strecke.
   */
  const groupsRef = useRef(groups);
  groupsRef.current = groups;
  useEffect(() => {
    const geo = geosRef.current[mapSelected];
    if (!geo) return;
    setSelectedSig((cur) => {
      const curGroup = groupsRef.current.find((g) => g.sig === cur);
      if (curGroup?.geo === geo) return cur;
      return groupsRef.current.find((g) => g.geo === geo)?.sig ?? cur;
    });
  }, [mapSelected]);

  /** Eine Zeile wählen: ihre Strecke auf die Karte — auch wenn sie noch nicht gezeichnet war. */
  const selectGroup = useCallback(
    (g: Group) => {
      setSelectedSig(g.sig);
      const idx = geosRef.current.indexOf(g.geo);
      if (idx >= 0) {
        selectCityRoute(idx);
        return;
      }
      const current = useSearchStore.getState().cityRoutes;
      if (!current || !g.plan) return;
      geosRef.current = [...geosRef.current, g.geo];
      setCityRoutes({
        ...current,
        plans: [...current.plans, g.plan],
        resultIds: [...current.resultIds, g.results[0]!.id],
        durations: [...current.durations, formatDuration(g.results[0]!.durationMinutes)],
        selected: current.plans.length,
      });
      void loadPolylines([g.plan], 0, current.key, setCityRoutePolylines);
    },
    [selectCityRoute, setCityRoutes, setCityRoutePolylines],
  );

  /**
   * Fest über die ganze Lebenszeit — die Auswahl kommt aus einem Merker.
   * Hing der Rückruf an `selectedSig`, war er nach jeder Auswahl neu, und das
   * `memo` JEDER Zeile griff ins Leere: Ein Tipp baute die ganze Liste neu, im
   * selben Durchgang wie die Kamerafahrt und die Strecken der Karte.
   */
  const selectedSigRef = useRef(selectedSig);
  selectedSigRef.current = selectedSig;
  const passengersRef = useRef(passengers);
  passengersRef.current = passengers;
  const onRowPress = useCallback(
    (g: Group) => {
      if (g.sig !== selectedSigRef.current) {
        selectGroup(g);
        return;
      }
      // Die gewählte noch einmal → Buchung, wie aus der Ergebnisliste — mit
      // den Reisenden dieser Suche (die Preise der Liste gelten für sie).
      selectResult(g.results[0]!, passengersRef.current);
    },
    [selectGroup, selectResult],
  );

  /**
   * DER SCHATTEN AN DER KANTE — die Liste läuft beim Hochscrollen UNTER Kopf
   * und Pillen hindurch, die stehen bleiben. Ein weicher Schatten unter der
   * Trennlinie zeigt, dass dort etwas darunter liegt; oben angekommen ist er
   * weg. Er blendet über die ersten 16 Punkte ein, damit er nicht beim ersten
   * Pixel aufspringt.
   *
   * Direkt am Scroll-Stand (UI-Strang), ohne React-Durchgang.
   */
  const edgeShadowStyle = useAnimatedStyle(() => ({
    opacity: Math.min(1, Math.max(0, gate.scrollY.value / 16)),
  }));
  /**
   * Neue Liste (andere Suche, anderes Verkehrsmittel) → Scroll-Stand auf null.
   *
   * Die Liste entsteht neu und steht oben, der geteilte Wert behielte aber den
   * alten Stand bis zum ersten Scrollen: Der Schatten stünde über einer Liste
   * am Anfang, und das Blatt hielte die Liste für gescrollt — ein Zug nach
   * unten auf ihr schlösse es dann nicht (siehe `onTouchesMove` im Blatt).
   */
  useEffect(() => {
    gate.scrollY.value = 0;
  }, [searchKey, gate]);

  const pickMode = (m: CityTripMode) => {
    pickedRef.current = true;
    if (m === "FLIGHT") setFlightArm(m === mode && flightKey ? flightKey : "next");
    setMode(m);
  };

  /** „Suchen" in der Slide, während Flug gewählt ist, zählt als Wunsch. */
  /**
   * „Suchen" in der Slide: Das Blatt übernimmt das Verkehrsmittel des
   * Formulars, und NUR ein Flug-Formular gibt die Flugsuche frei. Hier zählte
   * das Verkehrsmittel des Blattes — sprang das von selbst auf „Flug", während
   * die Slide noch das Zug-Formular zeigte, startete ein Zug-„Suchen" eine
   * kostenpflichtige Flugsuche.
   */
  const lastEditRef = useRef(edit);
  useEffect(() => {
    if (edit === lastEditRef.current) return;
    lastEditRef.current = edit;
    if (!edit) return;
    const m = edit.mode;
    if (m && MODE_ORDER.includes(m as CityTripMode) && m !== modeRef.current) {
      pickedRef.current = true;
      setMode(m as CityTripMode);
    }
    if (m === "FLIGHT") setFlightArm("next");
  }, [edit]);

  // --- Kopf -----------------------------------------------------------------
  const subtitleParts: string[] = [];
  // Die Entfernung rechnet der Vorlauf — auch zu einem gewählten Ziel.
  if (plan) subtitleParts.push(formatKm(plan.distanceKm));
  if (route) subtitleParts.push(t("city.from").replace("{origin}", route.origin.label));
  // Immer eine Zeile, auch leer — sonst rückten die Reiter beim Laden hoch.
  const subtitle = subtitleParts.join(" · ") || " ";

  return (
    <>
      <View style={styles.header}>
        <Text style={styles.title} numberOfLines={1}>
          {headerTitle}
        </Text>
        <Text style={styles.subtitle} numberOfLines={1}>
          {subtitle}
        </Text>
      </View>

      <View style={styles.pillsRow}>
        {MODE_ORDER.map((m) => (
          <ModePill
            key={m}
            Icon={MODE_TAB[m].Icon}
            label={t(MODE_TAB[m].tKey)}
            active={mode === m}
            disabled={plan ? !plan.modes[m].available : false}
            onPress={() => pickMode(m)}
          />
        ))}
      </View>
      {/* Trennt die Auswahl von den Verbindungen — dieselbe Kante wie unter den
          Reitern des Auswahlfensters. */}
      <View style={styles.controlsDivider} />

      <View style={styles.body}>
        {!bodyReady ? null : !from && !editFrom ? (
          <Empty title={t("city.noLocation.title")} body={t("city.noLocation.body")} />
        ) : planQ.isLoading ? (
          <ActivityIndicator color={C.g1} style={styles.spinner} />
        ) : (planQ.isError || !plan) && !route ? (
          // Ohne Plan geht es nur weiter, wenn Start UND Ziel selbst gewählt
          // sind (dann steht die Strecke auch so) — sonst ehrlich „nochmal".
          <Retry
            title={t("city.error.title")}
            body={t("results.error.body")}
            label={t("results.retry")}
            bg={palette.s3}
            onPress={() => void planQ.refetch()}
          />
        ) : !route ? (
          <Empty
            title={t(`city.reason.${(modePlan as { reason: CityModeReason }).reason}.title`)}
            body={t(`city.reason.${(modePlan as { reason: CityModeReason }).reason}.body`).replace(
              "{city}",
              headerTitle,
            )}
          />
        ) : sameEnds ? (
          <Empty
            title={t("city.sameStation.title")}
            body={t("city.sameStation.body").replace("{station}", route.origin.label)}
          />
        ) : mode === "FLIGHT" && !flightArmed && !searchQ.data ? (
          <Retry
            title={t("city.flightPrompt.title").replace("{city}", headerTitle)}
            body={t("city.flightPrompt.body").replace("{city}", headerTitle)}
            label={t("city.flightPrompt.button")}
            bg={palette.s3}
            onPress={() => setFlightArm(flightKey ?? "next")}
          />
        ) : searchQ.isPending ? (
          <ActivityIndicator color={C.g1} style={styles.spinner} />
        ) : searchQ.isError ? (
          <Retry
            title={t("city.error.title")}
            body={t("results.error.body")}
            label={t("results.retry")}
            bg={palette.s3}
            onPress={() => void searchQ.refetch()}
          />
        ) : groups.length === 0 ? (
          <Empty
            title={t("city.empty.title")}
            // „Für heute" stimmt nur ohne Änderung — mit anderem Datum, anderen
            // Reisenden oder anderer Klasse ist es „diese Suche".
            body={t(edit ? "city.empty.bodyEdited" : "city.empty.body")
              .replace("{origin}", route.origin.label)
              .replace("{dest}", route.destination.label)}
          />
        ) : (
          <GestureDetector gesture={gate.native}>
            <Animated.ScrollView
              // Neue Suche = neue Liste, oben beginnend (passend zum
              // zurückgesetzten Scroll-Stand, siehe `gate.scrollY`).
              key={searchKey ?? "none"}
              ref={gate.ref}
              contentContainerStyle={[styles.list, { paddingBottom: listBottomInset + 24 }]}
              showsVerticalScrollIndicator
              // Scrollt, solange das Blatt nicht selbst fährt — wer der Zug
              // gehört, entscheidet die Geste des Blattes (`onTouchesMove`).
              animatedProps={listProps}
              onScroll={gate.onScroll}
              scrollEventThrottle={16}
              overScrollMode="never"
              bounces={false}
            >
              {groups.map((g, i) => (
                <ConnectionRow
                  key={g.sig}
                  group={g}
                  selected={g.sig === selectedSig}
                  afterSelected={i > 0 && groups[i - 1]!.sig === selectedSig}
                  first={i === 0}
                  onPress={onRowPress}
                />
              ))}
            </Animated.ScrollView>
          </GestureDetector>
        )}
        {/* Schatten an der Kante — siehe `edgeShadowStyle`. Über der Liste,
            nimmt keine Berührung. */}
        <Animated.View pointerEvents="none" style={[styles.edgeShadow, edgeShadowStyle]}>
          <LinearGradient colors={EDGE_SHADOW} style={StyleSheet.absoluteFill} />
        </Animated.View>
      </View>
    </>
  );
}

/**
 * Eine Verbindung als Zeile — der Aufbau aus dem Beispiel:
 *
 *   1h    17:08 – 18:39                    ab 25 EUR
 *   31m   🚶 9 › R41 › ICE 643
 *         17:17 ab Werl, Bahnhof
 *         Auch um 18:17, 19:17
 */
const ConnectionRow = memo(function ConnectionRow({
  group,
  selected,
  afterSelected,
  first,
  onPress,
}: {
  group: Group;
  selected: boolean;
  /** Steht direkt unter der gewählten Zeile — dann trägt die Trennlinie keine Farbe. */
  afterSelected: boolean;
  first: boolean;
  onPress: (g: Group) => void;
}) {
  const t = useT();
  const accent = useAccent();
  const palette = usePalette();
  const r = group.results[0]!;
  const [big, small] = durationLines(r.durationMinutes);
  const dep = r.dateOnly ? "—" : formatTimeInZone(r.departTime, r.originTz);
  const arr = r.dateOnly ? "—" : formatTimeInZone(r.arriveTime, r.destinationTz);
  const plusDays = r.dateOnly ? 0 : dayOffset(r.departTime, r.arriveTime, r.originTz, r.destinationTz);

  // Die Etappen als Plaketten. Ohne Etappen (manche Flug- und Busanbieter):
  // eine Plakette aus Flugnummer bzw. Anbieter.
  const legs = r.legs && r.legs.length > 0 ? r.legs : null;
  const firstRide = legs?.find((l) => !l.walking);
  const startTime =
    firstRide && !r.dateOnly ? formatTimeInZone(firstRide.departTime, r.originTz) : dep;
  const startStation = firstRide?.originLabel ?? r.originLabel;
  const also = group.results
    .slice(1, 4)
    .map((o) => (o.dateOnly ? null : formatTimeInZone(o.departTime, o.originTz)))
    .filter(Boolean)
    .join(", ");

  return (
    <>
      {/* Grenzt die Linie an die gewählte Zeile, bleibt sie stehen, aber ohne
          Farbe: Eingerückt zeichnete sie eine Kerbe in die Kante der hellen
          Fläche. Die Höhe bleibt, damit beim Wechsel der Auswahl nichts um ein
          Pixel springt. */}
      {first ? null : (
        <View
          style={[styles.divider, selected || afterSelected ? styles.dividerHidden : null]}
        />
      )}
      {/* Welle statt `Pressable`: Deren React-Zustand „gedrückt" rendert beim
          Aufsetzen und beim Abbruch neu — genau am Anfang eines Ziehens, das
          hier meist beginnt (siehe `startDragHeal` in lib/ui/sheetSwipe.ts). */}
      <RippleTouch
        onPress={() => onPress(group)}
        style={[styles.row, selected ? { backgroundColor: palette.s2 } : null]}
        accessibilityRole="button"
        accessibilityState={{ selected }}
      >
        <View style={styles.durCol}>
          <Text style={styles.durBig}>{big}</Text>
          <Text style={styles.durSmall}>{small}</Text>
        </View>
        <View style={styles.rowBody}>
          <View style={styles.rowTop}>
            <Text style={styles.times} numberOfLines={1}>
              {dep} – {arr}
              {plusDays > 0 ? <Text style={styles.plusDay}>{` +${plusDays}`}</Text> : null}
            </Text>
            {r.price > 0 ? (
              <Text style={[styles.price, { color: accent.solid }]} numberOfLines={1}>
                <Text style={styles.priceFrom}>{t("results.from")} </Text>
                {r.price.toFixed(0)} {r.currency.toUpperCase()}
              </Text>
            ) : null}
          </View>
          <View style={styles.chips}>
            {legs ? (
              legs.map((l, i) => (
                <View key={i} style={styles.chipCell}>
                  {i > 0 ? <ChevronRight size={12} color={C.g3} strokeWidth={2.5} /> : null}
                  {l.walking ? (
                    // Figur, die Minuten klein und tiefgestellt daneben — wie
                    // Google Maps es vor einen Fußweg setzt.
                    <View style={styles.walk}>
                      <WalkIcon size={18} color={C.g1} />
                      <Text style={styles.walkText}>{l.durationMinutes}</Text>
                    </View>
                  ) : (
                    <LegChip product={l.product} label={l.line ?? productLabel(l.product) ?? "—"} />
                  )}
                </View>
              ))
            ) : (
              <LegChip
                product={r.mode === "FLIGHT" ? "flight" : r.mode === "BUS" ? "bus" : undefined}
                label={r.flightNumber ?? r.provider}
              />
            )}
          </View>
          {/* Start und „auch um" gehören zusammen — enger als die übrigen Zeilen. */}
          <View style={styles.metaGroup}>
            <Text style={styles.meta} numberOfLines={1}>
              {t("city.row.from").replace("{time}", startTime).replace("{station}", startStation)}
            </Text>
            {also ? (
              <Text style={styles.metaDim} numberOfLines={1}>
                {t("city.row.also").replace("{times}", also)}
              </Text>
            ) : null}
          </View>
        </View>
      </RippleTouch>
    </>
  );
});

/** Eine Fahrt: das Symbol ihrer Verkehrsart vor der farbigen Linien-Plakette. */
function LegChip({ product, label }: { product?: string; label: string }) {
  const Icon = iconForProduct(product);
  return (
    <View style={styles.legChip}>
      <Icon size={16} color={C.g1} strokeWidth={2.2} />
      <LinePill compact label={label} product={product} />
    </View>
  );
}

function Empty({ title, body }: { title: string; body: string }) {
  return (
    <View style={styles.empty}>
      <Text style={styles.emptyTitle}>{title}</Text>
      <Text style={styles.emptyBody}>{body}</Text>
    </View>
  );
}

function Retry({
  title,
  body,
  label,
  bg,
  onPress,
}: {
  title: string;
  body: string;
  label: string;
  bg: string;
  onPress: () => void;
}) {
  return (
    <View style={styles.empty}>
      <Text style={styles.emptyTitle}>{title}</Text>
      <Text style={styles.emptyBody}>{body}</Text>
      <RippleTouch onPress={onPress} style={[styles.retryBtn, { backgroundColor: bg }]} hitSlop={8}>
        <Text style={styles.retryText}>{label}</Text>
      </RippleTouch>
    </View>
  );
}

/**
 * DAS RASTER — Stufen von 4, Seitenrand `GUTTER` (20) wie jeder Bildschirm der
 * App. Nachgemessen am Referenzbild und an der Haltestelle:
 *
 *   Griff (Blatt)           10 · Strich 4 · 8
 *   Kopf                     4 oben, 16 unten; Name 28 hoch, Unterzeile 20
 *   Pillen                   8 zwischeneinander, 16 bis zur Kante darunter
 *   Kante                    1 — trennt Auswahl und Liste; die erste Zeile
 *                            schließt ohne Abstand an
 *   Zeile                   16 oben/unten, 16 zwischen Dauer und Inhalt;
 *                            im Inhalt 8 zwischen Uhrzeit, Linien, Start
 *   Linien                   6 um jeden Pfeil, 6 zwischen umbrochenen Reihen
 *   Start + „auch um"        2 — sie gehören zusammen
 *   Trennlinie zwischen      1, eingerückt um den Seitenrand
 *
 * Der Kopf hat feste Zeilenhöhen (siehe oben: nichts darf beim Wechsel der
 * Stadt rutschen).
 */
const styles = scaledStyles({
  header: {
    paddingHorizontal: GUTTER,
    paddingTop: 4,
    paddingBottom: 16,
  },
  title: { color: C.white, fontSize: 22, lineHeight: 28, fontWeight: "700", letterSpacing: -0.3 },
  subtitle: { color: C.g1, fontSize: 14, lineHeight: 20, fontWeight: "500", marginTop: 2 },
  pillsRow: {
    flexDirection: "row",
    gap: 8,
    paddingHorizontal: GUTTER,
    paddingBottom: 16,
  },
  controlsDivider: { height: 1, backgroundColor: C.border },
  body: { flex: 1 },
  /** Schatten unter der Trennlinie: 10 hoch, oben kräftig, nach unten auslaufend. */
  edgeShadow: { position: "absolute", top: 0, left: 0, right: 0, height: 10 },
  spinner: { marginTop: 32 },
  /**
   * Kein Abstand oben: Die erste Zeile beginnt direkt unter der Kante. Hier
   * standen 4 Punkte — war die erste Zeile gewählt, lag zwischen Kante und
   * heller Fläche ein dunkler Streifen. Die Luft über dem Inhalt gibt die Zeile
   * selbst (16 oben).
   */
  list: { paddingTop: 0 },

  row: {
    flexDirection: "row",
    paddingHorizontal: GUTTER,
    paddingVertical: 16,
    gap: 16,
  },
  divider: { height: 1, backgroundColor: C.border, marginHorizontal: GUTTER },
  dividerHidden: { backgroundColor: "transparent" },
  durCol: { width: 48 },
  durBig: { color: C.white, fontSize: 22, lineHeight: 26, fontWeight: "800", letterSpacing: -0.5 },
  durSmall: { color: C.white, fontSize: 15, lineHeight: 20, fontWeight: "700" },
  rowBody: { flex: 1, minWidth: 0, gap: 8 },
  rowTop: { flexDirection: "row", alignItems: "center", gap: 8 },
  times: { flex: 1, color: C.white, fontSize: 16, lineHeight: 22, fontWeight: "600" },
  plusDay: { color: C.g2, fontSize: 12, fontWeight: "700" },
  price: { fontSize: 15, lineHeight: 22, fontWeight: "800", letterSpacing: -0.2 },
  priceFrom: { color: C.g2, fontSize: 11, fontWeight: "700", letterSpacing: 0.4 },
  chips: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", rowGap: 6 },
  chipCell: { flexDirection: "row", alignItems: "center", gap: 6, marginRight: 6 },
  walk: { flexDirection: "row", alignItems: "flex-end" },
  // Tiefgestellt: an der Grundlinie der Figur, nicht in ihrer Mitte.
  walkText: { color: C.g1, fontSize: 11, lineHeight: 12, fontWeight: "700", marginLeft: 1 },
  legChip: { flexDirection: "row", alignItems: "center", gap: 4 },
  metaGroup: { gap: 2 },
  meta: { color: C.g2, fontSize: 13, lineHeight: 18, fontWeight: "500" },
  metaDim: { color: C.g3, fontSize: 13, lineHeight: 18, fontWeight: "500" },

  empty: { alignItems: "center", paddingTop: 32, paddingHorizontal: 24 },
  emptyTitle: { color: C.white, fontSize: 18, fontWeight: "700", textAlign: "center" },
  emptyBody: { color: C.g1, fontSize: 15, marginTop: 6, textAlign: "center", lineHeight: 22 },
  retryBtn: {
    marginTop: 16,
    paddingVertical: 10,
    paddingHorizontal: 22,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: C.border,
  },
  retryText: { color: C.white, fontSize: 15, fontWeight: "700" },
});
