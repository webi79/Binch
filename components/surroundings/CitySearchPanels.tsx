import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";
import { format } from "date-fns";
import { SearchEditPanel } from "@/components/results/SearchEditPanel";
import { PriceAlertSheet } from "@/components/results/PriceAlertSheet";
import { extraOptionsFor, type SearchHeroInitial } from "@/components/search/SearchHero";
import { createSearchAlert } from "@/lib/notifications/createSearchAlert";
import { isTransitionBusy } from "@/lib/nav/transitionBusy";
import { SHEET_OUT } from "@/lib/nav/overlayCover";
import { whenMapQuiet } from "@/lib/surroundings/mapViewport";
import { useT } from "@/lib/i18n/useT";
import { useSearchStore, type CityQuery, type SelectedCity } from "@/stores/searchStore";
import type { TravelMode } from "@/types/search";

/**
 * Die Vorbelegung der Slide aus der Suche des Blattes.
 *
 * Ohne gewählte Uhrzeit steht darin JETZT, nicht Mitternacht: Das Blatt sucht
 * ab jetzt. Wer die Slide unverändert bestätigt, bekäme sonst ein Suchfenster ab
 * 0 Uhr — dessen Züge sind längst weg und fielen aus der Liste. Dieses „jetzt"
 * wird in `applyEdit` wieder als „keine Uhrzeit" gelesen (siehe `nowIso`).
 */
function buildPrefill(q: CityQuery): {
  q: CityQuery;
  mode: TravelMode;
  initial: SearchHeroInitial;
  nowIso: string | null;
} {
  const today = format(new Date(), "yyyy-MM-dd");
  const now = !q.departTime && q.departDate === today ? new Date() : null;
  return {
    q,
    mode: q.mode,
    nowIso: now ? now.toISOString() : null,
    initial: {
      origin: q.origin ? { code: q.origin, label: q.originLabel } : null,
      destination: q.destination ? { code: q.destination, label: q.destLabel } : null,
      departDate: q.departTime || now || q.departDate,
      // Nur einfache Fahrt (siehe `oneWayOnly` unten).
      returnDate: null,
      passengers: q.passengers,
      travelClassKey: q.travelClass || null,
      tripType: "oneway",
    },
  };
}

/** Wiederversuch, solange gerade etwas fährt — wie in der Ergebnisliste. */
const PREFILL_RETRY_MS = 120;
/** Frühestens so lange nach dem Öffnen einer Stadt wird das Formular vorgebaut. */
const ARM_AFTER_MS = 1200;

/**
 * Such-Slide und Preis-Alarm hinter dem Kasten über dem Stadt-Blatt
 * (`CitySearchMorph`) — dieselben zwei Blätter, die in der Ergebnisliste hinter
 * Kasten und Glocke liegen.
 *
 * AM WURZEL-LAYOUT, nicht im Karten-Tab: Das Stadt-Blatt hängt selbst an der
 * Wurzel und liegt über dem Tab. Die Slide kommt von oben und reicht über die
 * halbe Höhe — im Tab gemountet läge ihre untere Hälfte UNTER dem Stadt-Blatt,
 * und ihre Verdunkelung ließe das Blatt unverdunkelt stehen.
 *
 * DIE HÖHE (`elevation`) ist die Sortierung, nicht Zierde: Android ordnet
 * Geschwister zuerst nach Höhe. Das Stadt-Blatt trägt 20 — mit bloßem `zIndex`
 * zeichnete es sich trotzdem über die Slide. 30 liegt darüber und unter den
 * Wählern für Ort und Datum (40), die aus der Slide heraus aufgehen. Gesetzt
 * nur, solange eine Stadt offen ist: Nur dann kann die Slide überhaupt
 * aufgehen, und sonst bleibt die Wurzel, wie sie war. Die Hülle ist
 * durchsichtig und lässt jede Berührung durch.
 *
 * Gesucht wird NICHT hier: „Suchen" in der Slide legt die Änderung als
 * `cityEdit` ab, das Stadt-Blatt sucht damit neu — so wie die Ergebnisliste
 * nach der Slide ihre Parameter umschreibt und nicht selbst sucht.
 */
export function CitySearchPanels() {
  const t = useT();
  const cityOpen = useSearchStore((s) => s.selectedCity != null);
  const q = useSearchStore((s) => s.cityQuery);
  const panel = useSearchStore((s) => s.cityPanel);
  const setCityPanel = useSearchStore((s) => s.setCityPanel);
  const cheapest = useSearchStore((s) => s.cityCheapest);
  const currency = useSearchStore((s) => s.currency);

  /**
   * Die Vorbelegung der Slide — veröffentlicht, wenn sich die Suche ändert,
   * und nicht in eine laufende Bewegung hinein (dieselbe Regel und Begründung
   * wie `editPrefill` in der Ergebnisliste: Das Formular rendert bei jeder
   * neuen Vorbelegung komplett durch).
   *
   * NICHT, solange die Slide offen ist: Lädt der Vorlauf, während man darin
   * tippt, überschriebe die neue Vorbelegung die Eingabe. Nach dem Schließen
   * läuft der Effekt erneut und holt nach.
   *
   * Zum „jetzt" in der Vorbelegung siehe `buildPrefill`.
   */
  const [prefill, setPrefill] = useState<ReturnType<typeof buildPrefill> | null>(null);
  useEffect(() => {
    if (!q || panel === "edit") return;
    let cancelled = false;
    const publish = () => {
      if (!cancelled) setPrefill(buildPrefill(q));
    };
    /**
     * Nicht in eine Bewegung hinein: Blatt-Einfahrt, ein Finger am Blatt, und
     * AUCH die Kamerafahrt der Karte — die meldet sich nicht als Übergang an,
     * dauert aber 800 ms, und die Vorbelegung rendert das ganze Formular.
     */
    const attempt = () => {
      if (cancelled) return;
      if (isTransitionBusy()) {
        setTimeout(attempt, PREFILL_RETRY_MS);
        return;
      }
      whenMapQuiet(publish);
    };
    attempt();
    return () => {
      cancelled = true;
    };
  }, [q, panel]);
  /**
   * Geht die Slide auf, bevor die Vorbelegung zur aktuellen Suche kam (Pille
   * gewechselt, während die Kamera noch fuhr, und gleich den Kasten
   * angetippt), wird sie JETZT nachgeholt — im selben Bild wie das Öffnen.
   * Sonst zeigte die Slide das vorige Verkehrsmittel samt dessen Stationen,
   * und „Suchen" legte die Änderung unter dem falschen ab. Ein Durchgang beim
   * Öffnen fällt ohnehin an (das Formular wird aktiv), dieser kommt dazu nur im
   * seltenen verspäteten Fall.
   */
  /**
   * NUR im Moment des Öffnens: Ändert sich die Suche, WÄHREND die Slide offen
   * ist (Vorlauf kommt an, das Blatt springt auf ein anderes Verkehrsmittel),
   * überschriebe eine neue Vorbelegung, was man gerade eintippt.
   */
  const prevPanelRef = useRef(panel);
  useLayoutEffect(() => {
    const opened = panel === "edit" && prevPanelRef.current !== "edit";
    prevPanelRef.current = panel;
    if (!opened || !q || prefill?.q === q) return;
    setPrefill(buildPrefill(q));
  }, [panel, q, prefill]);
  const prefillRef = useRef(prefill);
  prefillRef.current = prefill;

  /**
   * Das Formular VORBAUEN erst, wenn die Stadt steht — Blatt eingefahren UND
   * Kamera angekommen. Die Slide baut 700 ms nach `armed` (siehe
   * SearchEditPanel), und das lag bisher mitten in der 800-ms-Kamerafahrt.
   */
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!cityOpen) return;
    let cancelled = false;
    const id = setTimeout(() => {
      whenMapQuiet(() => {
        if (!cancelled) setArmed(true);
      });
    }, ARM_AFTER_MS);
    return () => {
      cancelled = true;
      clearTimeout(id);
    };
  }, [cityOpen]);

  /**
   * Die Anhebung über das Stadt-Blatt erst NACH der Ausfahrt der Slide
   * abnehmen. Fiel sie im Moment des Schließens weg, rutschte die gerade
   * hinausfahrende Slide unter das Blatt.
   */
  const [raised, setRaised] = useState(false);
  useEffect(() => {
    if (cityOpen) {
      setRaised(true);
      return;
    }
    const id = setTimeout(() => setRaised(false), SHEET_OUT.duration + 60);
    return () => clearTimeout(id);
  }, [cityOpen]);

  /**
   * Zu welcher Stadt die offene Slide gehört. „Suchen" kommt erst nach deren
   * Ausfahrt an — wer in diesem Moment eine andere Stadt antippt, darf die
   * Änderung nicht dorthin mitnehmen.
   */
  const editCityRef = useRef<SelectedCity | null>(null);
  useEffect(() => {
    if (panel === "edit") editCityRef.current = useSearchStore.getState().selectedCity;
  }, [panel]);

  const closePanel = useCallback(() => setCityPanel(null), [setCityPanel]);

  /**
   * „Suchen" in der Slide — die Änderung ablegen, das Blatt sucht neu.
   *
   * Kommt erst NACH der Ausfahrt der Slide an (siehe `handleSubmit` dort). Ist
   * die Stadt bis dahin geschlossen, gehört die Änderung zu nichts mehr.
   *
   * Start und Ziel werden nur übernommen, wenn sie sich GEÄNDERT haben — dann
   * aber für alle Verkehrsmittel (siehe `CityEdit`). Unverändert bleibt der
   * Vorlauf zuständig: Er sucht für Bus und Flug die passende Station bzw. den
   * Flughafen, statt den Bahnhof des Zugs überall einzusetzen. Eine frühere
   * Änderung bleibt stehen, bis eine neue kommt.
   */
  const applyEdit = useCallback((params: Record<string, string>) => {
    const st = useSearchStore.getState();
    const current = st.cityQuery;
    if (!st.selectedCity || !current) return;
    if (st.selectedCity !== editCityRef.current) return;
    const mode = (params.mode as TravelMode | undefined) ?? current.mode;
    const prev = st.cityEdit;
    const fromChanged = !!params.origin && params.origin !== current.origin;
    const toChanged = !!params.destination && params.destination !== current.destination;
    st.setCityEdit({
      mode,
      from: fromChanged
        ? { code: params.origin!, label: params.originLabel ?? "", mode }
        : (prev?.from ?? null),
      to: toChanged
        ? { code: params.destination!, label: params.destLabel ?? "", mode }
        : (prev?.to ?? null),
      departDate: params.departDate ?? "",
      // Das vorbelegte „jetzt" unverändert bestätigt = keine Uhrzeit gewählt.
      // Als feste Uhrzeit ginge es sonst mit — ein neuer Schlüssel am Server
      // (also eine frische Anbieter-Suche) und, ein paar Minuten später, eine
      // Suche ab einer Zeit, die schon vorbei ist.
      departTime:
        params.departTime && params.departTime !== prefillRef.current?.nowIso
          ? params.departTime
          : "",
      // Nur einfache Fahrt — auch falls doch ein Rückdatum ankäme.
      returnDate: "",
      tripType: "oneway",
      passengers: Number(params.passengers) || 1,
      /**
       * Die STANDARD-Klasse (2. Klasse, Economy, Standard) als „keine": Sie ist
       * das, was die Anbieter ohnehin suchen — aber eine gesetzte Klasse
       * schaltet den Server-Zwischenspeicher ab, jede Stadt-Suche liefe live.
       */
      travelClass:
        params.travelClass && params.travelClass !== extraOptionsFor(mode)[0]
          ? params.travelClass
          : "",
    });
  }, []);

  /**
   * Preis-Alarm für genau die Suche, die das Blatt zeigt — derselbe Ablauf wie
   * in der Ergebnisliste (`createSearchAlert`). Gelesen zum Zeitpunkt des
   * Anlegens: Das Blatt des Alarms ruft erst, wenn es unten ist.
   */
  const submitAlert = useCallback(
    (desiredPrice: number, notifyOnRise: boolean) => {
      const st = useSearchStore.getState();
      const cq = st.cityQuery;
      if (!cq || !cq.origin || !cq.destination) return;
      createSearchAlert(
        {
          mode: cq.mode,
          origin: cq.origin,
          destination: cq.destination,
          originLabel: cq.originLabel,
          destLabel: cq.destLabel,
          departDate: cq.departDate,
          returnDate: cq.returnDate,
          passengers: cq.passengers,
          travelClass: cq.travelClass,
          currency: st.currency,
          cheapestPrice: st.cityCheapest,
          desiredPrice,
          notifyOnRise,
        },
        t,
      );
    },
    [t],
  );

  return (
    <>
      <View
        style={[styles.layer, raised ? styles.raised : null]}
        pointerEvents="box-none"
      >
        <SearchEditPanel
          visible={panel === "edit"}
          armed={armed}
          oneWayOnly
          onClose={closePanel}
          onApply={applyEdit}
          mode={prefill?.mode ?? q?.mode ?? "TRAIN"}
          initial={prefill?.initial ?? null}
          slideKey="citySearchEdit"
        />
      </View>
      {/* Ein eigenes Fenster (`SheetModal`) — die Lage im Baum spielt keine Rolle. */}
      <PriceAlertSheet
        visible={panel === "alert"}
        onClose={closePanel}
        currentPrice={cheapest}
        currency={currency}
        fromLabel={q?.originLabel ?? ""}
        toLabel={q?.destLabel ?? ""}
        onCreate={submitAlert}
      />
    </>
  );
}

const styles = StyleSheet.create({
  layer: { ...StyleSheet.absoluteFillObject },
  raised: {
    zIndex: 150,
    elevation: 30,
    // Nur die Sortierung ist gewollt — ein Schatten für eine durchsichtige,
    // bildschirmfüllende Hülle wäre Arbeit ohne Bild.
    shadowColor: "transparent",
  },
});
