import { create } from "zustand";
import { isTransitionBusy } from "@/lib/nav/transitionBusy";
import { persist, type PersistStorage, type StorageValue } from "zustand/middleware";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { AppState } from "react-native";
import { SearchResult, TravelMode, Location } from "@/types/search";
import { SavedTrip, Ticket } from "@/types/saved";
import { POPULAR_LOCATIONS } from "@/lib/data/popularLocations";
import { tripSignature } from "@/lib/results/signature";
import { saveAuthToken } from "@/lib/auth/tokenStorage";
import type { AuthUser } from "@/lib/api/client";
import { fetchLocationsByCodes } from "@/lib/api/client";
import { trimPolyline } from "@/lib/routing/trimPolyline";

export type Locale = "en" | "de" | "fr" | "es";

/**
 * Persist-Adapter, der WEDER serialisiert NOCH schreibt, solange der Nutzer aktiv ist.
 *
 * Problem: Zustands `persist` ruft `setItem` SYNCHRON nach jedem `set()` — also
 * bei jedem Save, jedem Toggle, jedem Öffnen eines Overlays. Die Serialisierung
 * (JSON.stringify über einen >50kB-Zustand) blockiert den JS-Thread 10-30ms.
 * Genau in diesen Fenstern stottern Animationen, und Tipper wirken verschluckt.
 *
 * Der vorherige Adapter hat nur den SCHREIBVORGANG gebündelt: `createJSONStorage`
 * lag darüber und hat trotzdem bei jedem einzelnen `set()` serialisiert. Damit
 * war der teure Teil — das Stringify — nie gebündelt. Das war der eigentliche
 * Grund, warum ein Tipp auf eine Reise im Verlauf oder auf „Preis vergleichen"
 * spürbar hakte.
 *
 * Jetzt merkt sich der Adapter nur die Referenz auf den Zustand und serialisiert
 * erst beim Flush: nach 2.5s Ruhe oder sofort beim Wechsel in den Hintergrund
 * (Datensicherheit). Während der Nutzung kostet ein `set()` damit nichts mehr
 * außer dem React-Update.
 */
function createDeferredJSONStorage<S>(
  underlying: typeof AsyncStorage,
  delayMs = 2500,
): PersistStorage<S> {
  /** Spätestens dann wird geschrieben, auch wenn der JS-Thread nie ruhig wird. */
  const IDLE_TIMEOUT_MS = 4000;
  const pending = new Map<string, StorageValue<S> | null>();
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (pending.size === 0) return;
    const entries = Array.from(pending.entries());
    pending.clear();
    for (const [key, value] of entries) {
      // Fehler NICHT verschlucken: Läuft der Speicher voll oder scheitert
      // AsyncStorage, verlöre der Nutzer sonst stillschweigend gespeicherte
      // Reisen und Tickets — ohne dass irgendwo etwas davon zu sehen wäre.
      const onFail = (e: unknown) => {
        if (__DEV__) console.warn("[persist] Schreiben fehlgeschlagen", key, e);
      };
      if (value === null) {
        underlying.removeItem(key).catch(onFail);
      } else {
        // HIER wird serialisiert — einmal pro Ruhephase, nicht pro set().
        underlying.setItem(key, JSON.stringify(value)).catch(onFail);
      }
    }
  };

  /**
   * Führt `fn` in einer Leerlauf-Lücke des JS-Threads aus.
   *
   * Der Flush selbst ist der teure Teil: `JSON.stringify` über den ganzen
   * persistierten Zustand (gespeicherte Reisen, Tickets, Verlauf) blockt den
   * JS-Thread 10-30ms. Bisher lag er auf einem nackten Timer — und der feuert
   * 2,5s nach der LETZTEN Änderung, also ausgerechnet oft mittendrin: Man tippt
   * etwas an (Änderung), navigiert kurz darauf weiter, und der Flush landet im
   * laufenden Übergang. Das erklärt Slides, die nur MANCHMAL haken.
   *
   * `requestIdleCallback` wartet stattdessen auf ein Bild mit Restzeit. Das
   * `timeout` ist die Notbremse, damit bei dauerhafter Last trotzdem geschrieben
   * wird.
   */
  const runWhenIdle = (fn: () => void) => {
    const ric = (
      globalThis as {
        requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => void;
      }
    ).requestIdleCallback;
    /**
     * Die Sperre wird HIER nochmal geprüft, nicht nur vor dem Einreihen.
     *
     * Zwischen dem Einreihen und dem Feuern des Leerlauf-Rückrufs liegen
     * beliebig viele Bilder — die Notbremse greift erst nach vier Sekunden.
     * In dieser Zeit kann der Nutzer längst etwas angetippt haben, und der
     * Schreibvorgang landete dann in der frisch gestarteten Bewegung. Die
     * Prüfung davor allein reicht also nicht.
     */
    const guarded = () => {
      if (isTransitionBusy()) {
        schedule();
        return;
      }
      fn();
    };
    if (typeof ric === "function") ric(guarded, { timeout: IDLE_TIMEOUT_MS });
    else guarded();
  };

  /**
   * Zusätzlich zum Leerlauf: NICHT, während eine Bewegung läuft.
   *
   * `requestIdleCallback` misst die Ruhe des JS-Strangs — und genau während
   * einer Slide ist der ruhig, weil die Kurve auf dem UI-Strang rechnet. Die
   * Leerlauf-Bedingung war also ausgerechnet in den Fenstern erfüllt, die sie
   * ausschließen sollte, und der 10-30ms-Schreibvorgang lief hinein. Kein Bild
   * fiel dabei aus, aber alles, was in diesem Fenster über den JS-Strang muss —
   * die Abschluss-Rückrufe der Bewegung, React-Commits, Berührungen — stand
   * dahinter an.
   *
   * Ein erneuter Anlauf statt eines Verzichts: Die Bewegung ist nach ein paar
   * hundert Millisekunden vorbei, und der Zeitstempel verfällt von selbst — es
   * kann also nichts dauerhaft verstummen. Der Wechsel in den Hintergrund
   * schreibt weiterhin sofort, ohne jede Abfrage; dort zählt nur, dass die Daten
   * sicher sind.
   */
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      if (isTransitionBusy()) {
        schedule();
        return;
      }
      runWhenIdle(flush);
    }, delayMs);
  };

  // Beim Wechsel in den Hintergrund SOFORT alles flushen — sonst gehen
  // die letzten 2.5s an Änderungen verloren wenn die App gekillt wird.
  AppState.addEventListener("change", (state) => {
    if (state === "background" || state === "inactive") flush();
  });

  return {
    getItem: async (key) => {
      if (pending.has(key)) return pending.get(key) ?? null;
      const raw = await underlying.getItem(key);
      if (raw == null) return null;
      try {
        return JSON.parse(raw) as StorageValue<S>;
      } catch {
        return null;
      }
    },
    setItem: (key, value) => {
      // Nur die Referenz merken. Der Zustand wird ohnehin unveränderlich
      // behandelt (jede Änderung erzeugt neue Objekte/Arrays), und ein späterer
      // Schreibvorgang überschreibt den Eintrag hier — geflusht wird also immer
      // der jeweils neueste Stand.
      pending.set(key, value);
      schedule();
    },
    removeItem: (key) => {
      pending.set(key, null);
      schedule();
    },
  };
}

export type SavedToastPosition = "top" | "bottom";

export interface SelectedStop {
  code: string;
  label: string;
  /** Distanz in Metern zum User-Standort, falls vorhanden. */
  distanceMeters?: number;
  /** Mode-Kategorien an dem Stop (z.B. ["subway","bus"]). Steuert die
   *  Filter-Pillen im Detail-Sheet. */
  kinds?: ("train" | "subway" | "bus" | "tram" | "airport" | "cruise")[];
}

/** Snapshot der UI-Stati der Surroundings-Tab-Overlays. Wird beim Show-on-
 *  Map-Tap aus dem Surroundings-Tab gefüllt und beim Back wieder ausgepackt
 *  damit der User in den selben Sheet/Overlay-Zustand zurückkommt. */
export interface SurroundingsStash {
  selectedStop: SelectedStop | null;
  selectedResult: SearchResult | null;
  selectedPassengers: number;
  legTimelineOverlayOpen: boolean;
  directTripResult: SearchResult | null;
}

export interface SavedToast {
  /** Unique key, bumped each show so identical content retriggers animation */
  key: number;
  resultId: string;
  originLabel: string;
  destLabel: string;
  price: number;
  currency: string;
}

/** Ursprung des Home→Search Launch-Übergangs: gemessenes Kachel-Rect in
 *  Fensterkoordinaten + dominante Kachelfarbe (für den Farb-Morph). */
export interface SearchOverlayLaunch {
  x: number;
  y: number;
  w: number;
  h: number;
  color: string;
}

export interface StationToast {
  /** Unique key, bumped each show so identical content retriggers animation */
  key: number;
  title: string;
  subtitle: string;
}

export interface RecentSearch {
  id: string;
  mode: TravelMode;
  origin: { code: string; label: string };
  destination: { code: string; label: string };
  departDate: string;
  /** Wenn gesetzt: Hin&Rück-Suche. Beim Wieder-Aufrufen aus der History
   *  reaktivieren wir damit den Round-Trip-Modus inkl. Rück-Datum. */
  returnDate?: string;
  tripType?: "roundtrip" | "oneway" | "multicity";
  passengers: number;
  currency: string;
  timestamp: number;
}

const MAX_RECENT = 5;
const MAX_RECENT_HISTORY = 30;

export type SearchStoreState = SearchStore;

interface SearchStore {
  activeMode: TravelMode;
  setActiveMode: (mode: TravelMode) => void;
  currency: string;
  setCurrency: (code: string) => void;
  locale: Locale;
  setLocale: (l: Locale) => void;
  theme: "light" | "dark" | "gray";
  setTheme: (t: "light" | "dark" | "gray") => void;
  /** Akzent-Farbe für UI (Tabs, Buttons, Line-Badges, …). Wird im Settings-
   *  Screen gewählt und propagiert über `useAccent()` hook in jeden Component
   *  der den Akzent nutzt. Default "lime" = die bisherige hardcoded Brand-Farbe. */
  accent: "lime" | "mint";
  setAccent: (a: "lime" | "mint") => void;
  hapticsEnabled: boolean;
  setHapticsEnabled: (on: boolean) => void;
  notificationsEnabled: boolean;
  setNotificationsEnabled: (on: boolean) => void;
  priceAlertsEnabled: boolean;
  setPriceAlertsEnabled: (on: boolean) => void;
  savedToastPosition: SavedToastPosition;
  setSavedToastPosition: (p: SavedToastPosition) => void;
  savedToast: SavedToast | null;
  showSavedToast: (result: SearchResult) => void;
  hideSavedToast: () => void;
  /** Toast beim Speichern einer Station (Surroundings-Tab). */
  stationToast: StationToast | null;
  showStationToast: (title: string, subtitle: string) => void;
  hideStationToast: () => void;
  searchOverlayMode: TravelMode | null;
  /** Ursprungs-Rect (Fensterkoordinaten) + Farbe der angetippten Kategorie-
   *  Kachel. Treibt den „aus der Kachel wachsenden"-Launch-Übergang in
   *  SearchHeroOverlay. null = Aufruf ohne Kachel (Ziel-Karten, NotFound-
   *  Modal) → Overlay fadet fullscreen ein statt zu wachsen. */
  searchOverlayTileRect: SearchOverlayLaunch | null;
  /** Incrementiert bei jedem openSearchOverlay-Call. Wird als React-Key
   *  in SearchHeroOverlay genutzt um SearchHero pro Open frisch zu mounten —
   *  damit bleibt nichts an State aus einem vorherigen (nicht abgeschickten)
   *  Such-Versuch übrig. */
  searchOverlaySession: number;
  /** Gemessene Höhe des Home-Inhaltsbereichs (= Fenster minus Tab-Bar). Der
   *  Launch-Overlay endet exakt hier → die native Tab-Bar bleibt sichtbar. */
  homeContentHeight: number;
  setHomeContentHeight: (h: number) => void;
  /** true, solange der Launch-Übergang läuft (inkl. Schließ-Animation). Die
   *  DestinationCards rendern dann als Hardware-Textur, sonst clippt Android die
   *  gerundete overflow:hidden-Karte unter dem Depth-Scale falsch
   *  (clipToOutline-Bug). NUR währenddessen — Dauer-Textur kostet Scroll-Perf. */
  launchActive: boolean;
  setLaunchActive: (v: boolean) => void;
  /**
   * Ist Bo offen? — er ist eine Überlagerung am Wurzel-Layout, keine Route.
   *
   * Der Grund steht bei `AssistantScreen`: Als Route lag er im Navigations-
   * Stapel, und der steht im Wurzel-Layout vor der Tab-Leiste — überdecken
   * konnte er sie damit nicht.
   *
   * NICHT persistiert (siehe `partialize`): Beim nächsten App-Start soll der
   * Landingscreen kommen, nicht ein aufgeklappter Chat.
   */
  assistantOpen: boolean;
  /**
   * Bo IM VORAUS aufbauen, ohne ihn zu öffnen.
   *
   * Gesetzt beim Aufsetzen des Fingers auf die Suchleiste. Der Bildschirm ist
   * dann schon gebaut, wenn die Bewegung losgeht — geparkt außerhalb des
   * Bildes und deshalb unsichtbar. Genau der Weg, den Wähler und Such-Blatt
   * längst gehen: Zwischen Aufsetzen und Loslassen liegen 80 bis 150ms, die
   * ohnehin verstreichen; der Aufbau des schwersten Baums der App gehört
   * dorthin und nicht in die ersten Bilder der Fahrt.
   *
   * Bleibt gesetzt, wenn aus der Berührung kein Tipp wird — dann ist Bo eben
   * warm für das nächste Mal. Zurückgesetzt wird er nie zur Laufzeit; er
   * verschwindet mit dem App-Lauf.
   */
  assistantPreload: boolean;
  preloadAssistant: () => void;
  /** Kam der Aufruf über das Mikrofon? Dann startet Bo die Spracheingabe. */
  assistantAutoVoice: boolean;
  /**
   * Zählt JEDES Öffnen — auch eines, das auf ein noch laufendes Schließen trifft.
   *
   * Bo braucht einen Auslöser für „doch wieder auf", und `assistantOpen` taugt
   * dafür nicht: Der Merker steht während der ganzen Ausfahrt noch auf `true`
   * (er fällt erst, wenn die Kurve durch ist), ein erneutes Öffnen ändert ihn
   * also gar nicht. Ein Zähler ändert sich immer.
   */
  assistantOpenSeq: number;
  openAssistant: (autoVoice?: boolean) => void;
  closeAssistant: () => void;
  /** true erst NACH dem Reveal (Content sichtbar). Gatet den schweren Hero-SVG:
   *  WÄHREND die Box wächst (Suche offen, aber noch nicht revealed) muss er weg —
   *  react-native-svg compositet sein Hardware-Layer sonst pro Frame mit (auch
   *  unter opacity 0, siehe [[feedback_overlay_svg_compositing_lag]]) und ruckelt
   *  genau den Expand. Erst beim Reveal einschalten. */
  /** Offener Unterschirm im Profil-Tab. Liegt im Speicher, weil der Tab ihn
   *  auslöst und das Wurzel-Layout ihn anzeigt. */
  settingsSub: "details" | "settings" | "support" | null;
  setSettingsSub: (v: "details" | "settings" | "support" | null) => void;
  searchContentVisible: boolean;
  setSearchContentVisible: (v: boolean) => void;
  openSearchOverlay: (mode: TravelMode, launch?: SearchOverlayLaunch) => void;
  /** instant=true → ohne Schrumpf-zurück-Animation schließen (Tab-Wechsel). */
  closeSearchOverlay: (instant?: boolean, silent?: boolean) => void;
  searchOverlayCloseInstant: boolean;
  /**
   * true = ersatzlos verschwinden, ohne Deck-Fläche und ohne Ausblenden.
   * Für den Fall, dass bereits etwas ANDERES den Bildschirm deckt — nach der
   * Übergabe an die Ergebnis-Liste. Der Instant-Pfad ist dafür falsch: Der
   * lässt für den Tab-Wechsel absichtlich eine deckende Fläche stehen und
   * blendet sie aus.
   */
  searchOverlayCloseSilent: boolean;
  voiceOverlayOpen: boolean;
  openVoiceOverlay: () => void;
  closeVoiceOverlay: () => void;
  recentHistoryOverlayOpen: boolean;
  openRecentHistoryOverlay: () => void;
  closeRecentHistoryOverlay: () => void;
  /** Globaler DatePicker-State — der eigentliche BinchDatePicker ist im
   *  Root-Layout gemountet, damit er die Nav-Bar überdecken kann (und nicht
   *  von SearchHeroOverlay clippt wird). Caller setzt `request`, bekommt
   *  das Resultat in `result` zurück (separater Key, damit der Caller
   *  Re-Reads via useEffect erkennen kann). */
  datePickerRequest: {
    sessionKey: number;
    field: "depart" | "return";
    initialDate: Date | null;
    minimumDate: Date | null;
  } | null;
  datePickerResult: {
    sessionKey: number;
    field: "depart" | "return";
    date: Date;
  } | null;
  openDatePicker: (params: {
    field: "depart" | "return";
    initialDate: Date | null;
    minimumDate: Date | null;
  }) => void;
  closeDatePicker: () => void;
  confirmDatePicker: (date: Date) => void;
  /** Globaler LocationPicker-State — gleicher Trick wie DatePicker:
   *  am Root-Layout gemountet damit kein Cold-Start beim ersten Open. */
  locationPickerRequest: {
    sessionKey: number;
    field: "from" | "to";
    mode: TravelMode | "ALL";
    suggested: Location[];
    /** Optionale Präsentation (z.B. Surroundings-Stationssuche). */
    title?: string;
    leadingLabel?: string;
    placeholderKey?: string;
    /** Wenn gesetzt, wird die Auswahl HIER abgeliefert statt in
     *  locationPickerResult (Callback-Consumer wie Surroundings, die kein
     *  from/to-Field-Konzept haben). Nicht persistiert — Request lebt nur
     *  in-memory. */
    onSelect?: (location: Location) => void;
    /** „Aktueller Standort" im Picker — nur gezeigt, wenn gesetzt. */
    onCurrentLocation?: () => void;
  } | null;
  locationPickerResult: {
    sessionKey: number;
    field: "from" | "to";
    location: Location;
  } | null;
  openLocationPicker: (params: {
    field: "from" | "to";
    mode: TravelMode | "ALL";
    suggested: Location[];
    title?: string;
    leadingLabel?: string;
    placeholderKey?: string;
    onSelect?: (location: Location) => void;
    onCurrentLocation?: () => void;
}) => void;
  closeLocationPicker: () => void;
  confirmLocationPicker: (location: Location) => void;
  selectedResult: SearchResult | null;
  selectedPassengers: number;
  /** Welche Route+Params haben das DetailsOverlay geöffnet. Wird vom
   *  ResultCard beim Tap mitgesetzt — die ResultCard lebt INNERHALB des
   *  Results-Screens und hat damit Zugriff auf die echten URL-Params via
   *  useLocalSearchParams. Die Overlays (DetailsOverlay/LegTimelineOverlay)
   *  sind global gemountet → ihre eigenen useLocalSearchParams würden leere
   *  Objekte liefern. Wir brauchen den Kontext aber für „Show on Map"-
   *  previousHref (Back-Navigation aus Surroundings zurück zur Ergebnis-
   *  Liste mit den gleichen Such-Params). */
  /**
   * Parameter der aktuell angezeigten Ergebnis-Suche.
   *
   * Der Ergebnis-Bildschirm zieht damit aus der Route heraus und wird dauerhaft
   * am Root gemountet — wie die vier Detail-Überlagerungen. Grund: Beim Antippen
   * entstand bisher ein kompletter Bildschirm, und dieser Aufbau läuft auf Fabric
   * auf dem UI-THREAD, also demselben, auf dem die Bewegung gerechnet wird. Genau
   * daher kommt das Hängen in den ersten Bildern — und daher auch, dass sich das
   * ERSTE Öffnen anders anfühlt als jedes weitere.
   *
   * Die Route bleibt bestehen: Sie trägt weiterhin Zurück-Geste, Verlinkungen und
   * die Karten-Route darüber. Nur das Rendern wandert nach oben.
   */
  resultsParams: Record<string, string> | null;
  setResultsParams: (p: Record<string, string> | null) => void;
  /**
   * Noch nicht nachgeholte Navigation.
   *
   * Geöffnet wird die Ergebnisliste über `resultsParams` — sofort, ohne Router.
   * Die ROUTE wird erst danach nachgezogen, wenn die Bewegung durch ist: Ein
   * `router.push` aktualisiert den Navigationszustand und lässt
   * react-native-screens einen nativen Container anlegen, und diese Arbeit läuft
   * auf dem UI-Thread — also dort, wo auch die Bewegung gerechnet wird. Genau
   * das war der letzte Unterschied zum Übergang im Saved-Tab, der ohne Router
   * auskommt und sich deshalb richtig anfühlt.
   *
   * Gebraucht wird die Route weiterhin für die Zurück-Geste, für Verlinkungen
   * und für die Karten-Route, die über den Ergebnissen aufgeht.
   */
  pendingResultsRoute: Record<string, string> | null;
  setPendingResultsRoute: (p: Record<string, string> | null) => void;
  selectedResultContext: { pathname: string; params?: Record<string, string> } | null;
  selectResult: (
    r: SearchResult,
    passengers: number,
    context?: { pathname: string; params?: Record<string, string> },
  ) => void;
  /** True wenn das aktuelle `selectedResult` ein Stub ist — die echte Suche
   *  läuft noch. Wird gesetzt wenn der User im Surroundings-Sheet eine
   *  Departure tappt: wir öffnen DetailsOverlay sofort (instant slide-in)
   *  und ersetzen das Stub-Result sobald die Search-API antwortet.
   *  DetailsOverlay rendert in dem Zustand Skeletons statt der Provider-Cards. */
  selectedResultPending: boolean;
  setSelectedResultPending: (pending: boolean) => void;
  clearSelectedResult: () => void;
  /** Aktuell im Surroundings-Tab ausgewählter Stop — steuert das globale
   *  StopDetailSheet-Overlay. Wird in app/_layout.tsx gerendert damit es ÜBER
   *  der FloatingTabBar liegt. */
  selectedStop: SelectedStop | null;
  selectStop: (s: SelectedStop) => void;
  clearSelectedStop: () => void;
  /** Snapshot der Surroundings-UI-Stati für den "Show on Map"-Flow.
   *  Use-Case: User ist in Surroundings, hat irgendeine Kombo aus Slide
   *  (selectedStop), Booking-Overlay (selectedResult) und Trip-Details-
   *  Sheet (legTimelineOverlayOpen, directTripResult) offen, tappt dann
   *  „Auf Karte anzeigen". Wir wollen die Route auf der Map sehen ohne
   *  dass Overlays davor liegen — aber beim Back-Button soll alles wieder
   *  so sein wie vorher. Lösung: kompletten Surroundings-UI-Zustand in
   *  einen Stash parken, im LiveStore null'en, beim Back zurückspielen. */
  stashedSurroundings: SurroundingsStash | null;
  stashSurroundingsForRoute: () => void;
  restoreSurroundings: () => void;
  legTimelineOverlayOpen: boolean;
  openLegTimelineOverlay: () => void;
  closeLegTimelineOverlay: () => void;
  /** Direct-Trip-Flow: vom StopDetailSheet-Tap auf eine Bus-/Zug-Abfahrt
   *  gesetzt. Liefert genau einen Trip mit Stopovers — UMGEHT den
   *  DetailsOverlay (Booking) und öffnet stattdessen direkt LegTimelineOverlay
   *  (Stop-Sequenz). Daten kommen vom `/api/trips/:id/detail`-Endpoint,
   *  nicht von einer Journey-Suche.
   *  Wenn gesetzt: DetailsOverlay rendert nichts, LegTimelineOverlay
   *  bevorzugt dieses Result. Wird beim Schließen des Timelines geleert. */
  directTripResult: SearchResult | null;
  openDirectTrip: (r: SearchResult) => void;
  clearDirectTrip: () => void;
  recentSearches: RecentSearch[];
  addRecentSearch: (s: Omit<RecentSearch, "id" | "timestamp">) => void;
  removeRecentSearch: (id: string) => void;
  clearRecentSearches: () => void;
  /** Validiert persistierte Recent-Searches und Saved-Stations gegen die DB.
   *  Beim App-Start einmal aufgerufen — entfernt Einträge deren Code nicht mehr
   *  existiert (z.B. nach Audit-Cleanup) und syncht veraltete Labels mit dem
   *  aktuellen DB-Stand. Schlägt der Server-Call fehl, bleibt der Store
   *  unverändert (offline-friendly). */
  validatePersistedCodes: () => Promise<void>;
  /** Codes aus POPULAR_LOCATIONS, die NICHT (mehr) zu ihrem Label passen.
   *  Der LocationPicker blendet sie aus. Nicht persistiert — wird bei jedem
   *  Start neu gegen die DB geprüft.
   *
   *  Warum es das braucht: die Vorschlagsliste ist HARTKODIERT. Driftet ein Code
   *  von der DB ab, wählt der User einen Ort, der nach woanders routet — real
   *  passiert: „Wien Hbf" trug sta:8101003, was „Inzersdorf Wien Blumental
   *  Bahnhof" ist. Das Label stimmte, also fiel es niemandem auf; die Suche fuhr
   *  stumm in den falschen Ort. Ein Vorschlag, der nicht auflösbar ist, darf gar
   *  nicht erst antippbar sein. */
  invalidSuggestionCodes: string[];
  recentSpots: string[];
  /**
   * Zuletzt bestätigte eigene Position.
   *
   * Ersetzt den fest verdrahteten Platzhalter (Berlin Hbf), der bis dahin als
   * „dein Standort" durchging, wenn die Ortung noch lief, abgelehnt war oder
   * ins Leere lief. Ein Nutzer in Dortmund bekam damit Berlin als Ursprung —
   * inklusive der Umkreis-Abfrage dafür.
   *
   * Persistiert, damit der nächste Start dort weitermacht, wo man zuletzt
   * wirklich war, statt wieder bei einem Fremdort. `null` heißt ehrlich: Wir
   * wissen es noch nicht.
   */
  lastKnownCoord: { latitude: number; longitude: number } | null;
  setLastKnownCoord: (c: { latitude: number; longitude: number }) => void;
  addRecentSpot: (query: string) => void;
  removeRecentSpot: (query: string) => void;
  favoriteResultIds: string[];
  toggleFavorite: (id: string) => void;
  savedTrips: SavedTrip[];
  /** Set der `tripSignature(trip)` aller gespeicherten Trips. Wird in Sync
   *  mit `savedTrips` gehalten und gibt O(1) "is-saved?"-Lookups statt der
   *  vorher gebrauchten O(N) `.some()`-Iteration. Pro Save sparsen sich
   *  damit (Anzahl sichtbarer ResultCards) × N Vergleiche → bei vielen
   *  gespeicherten Trips spürbarer Performance-Unterschied. */
  savedTripSignatures: ReadonlySet<string>;
  saveTrip: (result: SearchResult, passengers: number) => void;
  unsaveTrip: (id: string) => void;
  toggleSavedTrip: (result: SearchResult, passengers: number) => void;
  setTripPriceAlert: (id: string, on: boolean) => void;
  /** Räumt Tickets weg deren Ankunfts-Datum schon vorbei ist (User-Lokalzeit,
   *  Tagesgranularität). Wird beim App-Start und beim Öffnen des Saved-Screens
   *  aufgerufen — Trip mit Ankunft am 14. verschwindet am 15. um 00:00. */
  pruneExpiredSavedTrips: () => void;
  /**
   * Ist seit dem letzten Besuch des Saved-Tabs etwas dazugekommen?
   *
   * Treibt den roten Punkt an der Tab-Leiste. Bewusst NICHT persistiert (siehe
   * `partialize`): Ein Hinweis auf „neu seit deinem letzten Blick" soll einen
   * App-Neustart nicht überleben — sonst klebt er nach Tagen noch dort und
   * bedeutet nichts mehr.
   */
  /**
   * Wie viele ungesehene Tickets seit dem letzten Blick in „Gespeichert"?
   *
   * War ein Ja/Nein und wurde beim ENTFERNEN bewusst nicht zurückgenommen —
   * mit der Begründung, dort sei nichts Neues zu sehen. Das stimmt nur, wenn
   * noch etwas Ungesehenes übrig ist: Wer ein Ticket speichert und dasselbe
   * gleich wieder verwirft, hatte den Punkt danach dauerhaft an der Leiste,
   * obwohl es nichts mehr zu sehen gab.
   *
   * Als Zähler geht beides auf: Speichern zählt hoch, Verwerfen wieder herunter
   * (nicht unter null), und der Blick in den Tab setzt auf null. Zwei speichern,
   * eins verwerfen lässt den Punkt also stehen — richtig, eines ist ja noch da.
   */
  savedBadge: number;
  clearSavedBadge: () => void;
  tickets: Ticket[];
  addTicket: (t: Omit<Ticket, "id" | "createdAt">) => void;
  removeTicket: (id: string) => void;
  /** Partielles Update eines Tickets — genutzt von der Bild-Migration
   *  (lib/saved/ticketImages.ts), die data-URLs durch file://-URIs ersetzt. */
  patchTicket: (id: string, patch: Partial<Ticket>) => void;
  /** Aktuell im Saved-Tab angetapptes Ticket — steuert das Root-Level
   *  TicketDetailOverlay (slide-from-right). null = Overlay geschlossen. */
  selectedTicket: Ticket | null;
  openTicketDetail: (t: Ticket) => void;
  clearSelectedTicket: () => void;
  authToken: string | null;
  authUser: AuthUser | null;
  authOverlayOpen: boolean;
  openAuthOverlay: () => void;
  closeAuthOverlay: () => void;
  setAuth: (token: string, user: AuthUser) => void;
  setAuthUser: (user: AuthUser | null) => void;
  clearAuth: () => void;

  /** Vom User gespeicherte Stationen (Airports, Bahnhöfe, Bus-Stops, Häfen).
   *  Wird in den LocationPicker-Listen oben angezeigt und im StopDetailSheet
   *  über den Stern getoggled. Persistiert via AsyncStorage. */
  /**
   * Codes der gespeicherten Stationen als Set.
   *
   * Der Ortspicker prüfte pro Zeile mit `savedStations.some(...)` — also über
   * alle gespeicherten Stationen, für jede der ~20 Zeilen, bei JEDER
   * Store-Änderung. Dasselbe Muster ist in ResultCard als Ursache dafür
   * dokumentiert, dass „die App mit jedem gespeicherten Trip messbar langsamer
   * wurde"; dort wurde es genauso ersetzt.
   */
  savedStationCodes: ReadonlySet<string>;
  savedStations: Location[];
  toggleSavedStation: (loc: Location) => void;

  /** Flag: wenn `true`, soll der nächste `beforeRemove` auf dem results-Screen
   *  KEINEN Slide-Out animieren sondern direkt dispatchen. Wird vom Toast-
   *  "Ansehen"-Klick gesetzt damit die Modal-Pop sofort passiert (sonst läuft
   *  die 260ms-Slide-Out-Worklet parallel zu Tab-Switch + DetailsOverlay-
   *  Unmount + Saved-Tab-Mount = UI-Thread-Spike). Wird nach Verbrauch
   *  zurückgesetzt. */
  bypassResultsSlideOut: boolean;
  setBypassResultsSlideOut: (on: boolean) => void;

  /** Aktuell auf der Karte angezeigte Route — null wenn keine. */
  pendingRoute: RoutePlan | null;
  setRoute: (r: RoutePlan) => void;
  /** Ergänzt die geladenen Polyline-Coords pro Leg (TripId-Mapping). */
  setRoutePolylines: (polylines: Record<string, [number, number][]>) => void;
  clearRoute: () => void;
}

export interface RouteWaypoint {
  /** Anzeigename: „Berlin Hbf", „Frankfurt am Main" etc. */
  label: string;
  latitude: number;
  longitude: number;
  /** Marker-Icon-Typ — bestimmt die Farbe/Form auf der Karte. */
  type: "train" | "bus" | "tram" | "airport" | "cruise";
  /** Rolle in der Route: Start, Umstieg oder Ziel. */
  role: "origin" | "transfer" | "destination";
}

export interface RouteLegGeometry {
  /** HAFAS Trip-ID — Schlüssel zum Nachladen der Polyline. */
  tripId?: string;
  /** Index in der waypoints-Liste: der Origin-Stop dieses Legs. */
  fromIndex: number;
  /** Index in der waypoints-Liste: der Destination-Stop dieses Legs. */
  toIndex: number;
  /** Echte Schienen-/Straßen-Coords nach Polyline-Fetch — sonst undefined (= gerade Linie). */
  coords?: [number, number][];
  /** Fußweg-Etappe → auf der Karte gestrichelt, nicht wie eine Fahrt. */
  walking?: boolean;
}

export interface RoutePlan {
  mode: TravelMode;
  waypoints: RouteWaypoint[];
  /** Pro Leg ein Geometry-Block für genaues Route-Drawing. */
  legs: RouteLegGeometry[];
  /** Optionales Label für das Top-Banner („Berlin → Amsterdam"). */
  title?: string;
  /** Pfad + Query-Params von dem aus die Route geöffnet wurde — Back-Button
   *  navigiert exakt dorthin zurück (inkl. origin/destination/passengers etc.). */
  previousHref?: { pathname: string; params?: Record<string, string> };
}

export const useSearchStore = create<SearchStore>()(
  persist(
    (set, get) => ({
      activeMode: "FLIGHT",
      setActiveMode: (mode) => set({ activeMode: mode }),
      currency: "EUR",
      setCurrency: (code) => set({ currency: code.toUpperCase() }),
      locale: "de",
      setLocale: (l) => set({ locale: l }),
      theme: "gray",
      setTheme: (t) => set({ theme: t }),
      accent: "lime",
      setAccent: (a) => set({ accent: a }),
      hapticsEnabled: true,
      setHapticsEnabled: (on) => set({ hapticsEnabled: on }),
      notificationsEnabled: true,
      setNotificationsEnabled: (on) => set({ notificationsEnabled: on }),
      priceAlertsEnabled: false,
      setPriceAlertsEnabled: (on) => set({ priceAlertsEnabled: on }),
      savedToastPosition: "bottom",
      setSavedToastPosition: (p) => set({ savedToastPosition: p }),
      savedToast: null,
      showSavedToast: (result) =>
        set({
          savedToast: {
            key: Date.now(),
            resultId: result.id,
            originLabel: result.originLabel,
            destLabel: result.destLabel,
            price: result.price,
            currency: result.currency,
          },
        }),
      hideSavedToast: () => set({ savedToast: null }),
      stationToast: null,
      showStationToast: (title, subtitle) =>
        set({ stationToast: { key: Date.now(), title, subtitle } }),
      hideStationToast: () => set({ stationToast: null }),
      searchOverlayMode: null,
      searchOverlayTileRect: null,
      searchOverlaySession: 0,
      searchOverlayCloseInstant: false,
      searchOverlayCloseSilent: false,
      homeContentHeight: 0,
      setHomeContentHeight: (h) => {
        if (h > 0 && Math.abs(h - get().homeContentHeight) > 0.5) set({ homeContentHeight: h });
      },
      launchActive: false,
      setLaunchActive: (v) => {
        if (v !== get().launchActive) set({ launchActive: v });
      },
      assistantOpen: false,
      assistantPreload: false,
      preloadAssistant: () => {
        if (!get().assistantPreload) set({ assistantPreload: true });
      },
      assistantAutoVoice: false,
      assistantOpenSeq: 0,
      openAssistant: (autoVoice = false) => {
        /**
         * KEIN vorzeitiger Ausstieg mehr — er war der Kern des Fehlers.
         *
         * Hier stand `if (get().assistantOpen) return;`, gedacht als Schutz vor
         * überflüssigen Schreibvorgängen. Nur gilt Bo während seiner GANZEN
         * Ausfahrt weiterhin als offen: Der Merker fällt erst, wenn die Kurve
         * durch ist und der Baum abgebaut wird. Wer in diesem Fenster erneut
         * tippt — also bei jedem schnellen Auf und Zu —, lief damit in einen
         * stillen Ausstieg: Die Kurve fuhr zwar zurück nach oben (der
         * Tipp-Handler startet sie unabhängig davon), aber der Bildschirm
         * erfuhr nie, dass er wieder geöffnet wurde. Der Wecker des
         * ABGEBROCHENEN Schließens lief weiter und baute Bo mitten in seiner
         * Einfahrt ab — er fuhr herein und war sofort wieder weg.
         *
         * Das Such-Blatt hat dieses Problem nie gehabt: Sein Zustand liegt in
         * EINEM Speicherfeld, das beim Schließen sofort fällt und beim Öffnen
         * sofort wieder steht. Ein erneutes Öffnen ist dort einfach der nächste
         * Wechsel dieses Feldes.
         */
        set((s) => ({
          assistantOpen: true,
          assistantAutoVoice: autoVoice,
          assistantOpenSeq: s.assistantOpenSeq + 1,
        }));
      },
      closeAssistant: () => {
        if (!get().assistantOpen) return;
        /**
         * Den Vorbereitungs-Merker MIT zurücknehmen.
         *
         * Sonst bliebe Bo nach dem Schließen gemountet, und der Bildschirm
         * würde nie abgebaut — sein Aufräumen (Timer, Abos, Strom-Abbruch,
         * Zurücksetzen der Fahrt) hängt aber genau daran. So bleibt der
         * Lebenszyklus derselbe wie vorher: aufgebaut beim Berühren,
         * abgebaut beim Schließen.
         */
        set({ assistantOpen: false, assistantAutoVoice: false, assistantPreload: false });
      },
      settingsSub: null,
      setSettingsSub: (v) => set({ settingsSub: v }),
      searchContentVisible: false,
      setSearchContentVisible: (v) => {
        if (v !== get().searchContentVisible) set({ searchContentVisible: v });
      },
      openSearchOverlay: (mode, launch) =>
        set((state) => ({
          searchOverlayMode: mode,
          searchOverlayTileRect: launch ?? null,
          searchOverlayCloseInstant: false,
          searchOverlayCloseSilent: false,
          // SVG bleibt aus, bis der Reveal ihn einschaltet — sonst compositet er
          // während des Box-Wachstums pro Frame mit (Expand-Ruckler).
          searchContentVisible: false,
          activeMode: mode,
          // Bei jedem Open Session bumpen — als React-Key in der Overlay,
          // garantiert frischen SearchHero-Mount auch wenn dieselbe
          // Kategorie zweimal hintereinander geöffnet wird.
          searchOverlaySession: state.searchOverlaySession + 1,
          // Stale Picker-Results aus der vorherigen Session löschen.
          // Sonst würden sie via useEffect-Subscription im neu gemounteten
          // SearchHero erneut angewandt → "Hamburg ist wieder da"-Bug.
          locationPickerResult: null,
          datePickerResult: null,
        })),
      closeSearchOverlay: (instant, silent) =>
        set({
          searchOverlayMode: null,
          // true = OHNE Schrumpf-Animation schließen. Wird beim Tab-Wechsel
          // gesetzt: Dort wäre die Rück-Expansion sinnlos (die Kachel, zu der
          // geschrumpft würde, ist gar nicht mehr sichtbar).
          searchOverlayCloseInstant: !!instant,
          searchOverlayCloseSilent: !!silent,
          // `searchContentVisible` bleibt hier ABSICHTLICH stehen.
          //
          // Früher fiel es sofort auf false — der Himmel-SVG ging damit auf
          // `display: none`. Das war richtig, solange eine Deckfläche darüber lag
          // und der Screen zur Kachel zurückschrumpfte: Zu sehen war davon
          // nichts. Seit das Blatt mit sichtbarem Inhalt nach unten hinausfährt,
          // sieht man es sehr wohl — der Himmel verschwand im ersten Bild der
          // Bewegung und übrig blieb eine schwarze Fläche, die hinausgleitet.
          //
          // Abgeschaltet wird der SVG jetzt am ENDE der Bewegung, im Rückruf in
          // SearchHeroOverlay. Dass er überhaupt abgeschaltet werden MUSS, bleibt
          // wichtig: Eine unsichtbare, aber gelayoutete SVG lässt das Scrollen im
          // Landingscreen dauerhaft ruckeln (im Release-Build verifiziert).
          // Rect NICHT löschen — der Overlay braucht ihn noch für die
          // Schrumpf-zurück-zur-Kachel-Animation, die nach dem Close-Aufruf
          // läuft. Der nächste Open überschreibt ihn ohnehin.
          // Auch beim Close clearen — der nächste Open hat dann definitiv
          // einen leeren Result-Slot, egal über welchen Pfad wieder geöffnet wird.
          locationPickerResult: null,
          datePickerResult: null,
        }),
      voiceOverlayOpen: false,
      openVoiceOverlay: () => set({ voiceOverlayOpen: true }),
      closeVoiceOverlay: () => set({ voiceOverlayOpen: false }),
      datePickerRequest: null,
      datePickerResult: null,
      openDatePicker: ({ field, initialDate, minimumDate }) =>
        set({
          datePickerRequest: {
            sessionKey: Date.now(),
            field,
            initialDate,
            minimumDate,
          },
        }),
      closeDatePicker: () => set({ datePickerRequest: null }),
      confirmDatePicker: (date) =>
        set((state) => {
          if (!state.datePickerRequest) return state;
          return {
            datePickerResult: {
              sessionKey: state.datePickerRequest.sessionKey,
              field: state.datePickerRequest.field,
              date,
            },
            datePickerRequest: null,
          };
        }),
      locationPickerRequest: null,
      locationPickerResult: null,
      openLocationPicker: ({ field, mode, suggested, title, leadingLabel, placeholderKey, onSelect, onCurrentLocation }) =>
        set({
          locationPickerRequest: {
            sessionKey: Date.now(),
            field,
            mode,
            suggested,
            title,
            leadingLabel,
            placeholderKey,
            onSelect,
            onCurrentLocation,
          },
        }),
      closeLocationPicker: () => set({ locationPickerRequest: null }),
      confirmLocationPicker: (location) =>
        set((state) => {
          if (!state.locationPickerRequest) return state;
          // Callback-Consumer (z.B. Surroundings): Auswahl direkt abliefern,
          // kein locationPickerResult — das würde sonst der SearchHero-Flow
          // als from/to-Auswahl interpretieren.
          if (state.locationPickerRequest.onSelect) {
            state.locationPickerRequest.onSelect(location);
            return { locationPickerRequest: null };
          }
          return {
            locationPickerResult: {
              sessionKey: state.locationPickerRequest.sessionKey,
              field: state.locationPickerRequest.field,
              location,
            },
            locationPickerRequest: null,
          };
        }),
      recentHistoryOverlayOpen: false,
      openRecentHistoryOverlay: () => set({ recentHistoryOverlayOpen: true }),
      closeRecentHistoryOverlay: () => {
        // Nur schreiben, wenn wirklich offen: Jedes set() serialisiert den
        // persistierten Store synchron (10-30ms JS-Blockade). Der Tipp auf
        // eine Reise im Verlauf rief das bedingungslos auf — die Blockade
        // lag damit genau im Touch-Frame.
        if (get().recentHistoryOverlayOpen) set({ recentHistoryOverlayOpen: false });
      },
      selectedStop: null,
      selectStop: (s) => set({ selectedStop: s }),
      clearSelectedStop: () => set({ selectedStop: null }),
      stashedSurroundings: null,
      stashSurroundingsForRoute: () => {
        // Kompletten UI-State der Surroundings-Tab-Overlays in einen Snapshot
        // sichern + die Live-Felder leeren. Damit verschwinden visuell:
        //   - Slide (selectedStop=null → translateY-Animation runter)
        //   - DetailsOverlay (selectedResult=null → return null)
        //   - LegTimelineOverlay (legTimelineOpen=false oder directTrip=null)
        // Die Route sieht der User dann sauber auf der Map.
        const s = get();
        // No-op wenn nichts offen ist — sonst stashen wir leere Objects und
        // restoreSurroundings würde fälschlich zu „alles zu" führen.
        if (!s.selectedStop && !s.selectedResult && !s.directTripResult) return;
        set({
          stashedSurroundings: {
            selectedStop: s.selectedStop,
            selectedResult: s.selectedResult,
            selectedPassengers: s.selectedPassengers,
            legTimelineOverlayOpen: s.legTimelineOverlayOpen,
            directTripResult: s.directTripResult,
          },
          selectedStop: null,
          selectedResult: null,
          legTimelineOverlayOpen: false,
          directTripResult: null,
        });
      },
      restoreSurroundings: () => {
        const stash = get().stashedSurroundings;
        if (!stash) return;
        set({
          selectedStop: stash.selectedStop,
          selectedResult: stash.selectedResult,
          selectedPassengers: stash.selectedPassengers,
          legTimelineOverlayOpen: stash.legTimelineOverlayOpen,
          directTripResult: stash.directTripResult,
          stashedSurroundings: null,
        });
      },
      selectedResult: null,
      selectedPassengers: 1,
      resultsParams: null,
      pendingResultsRoute: null,
      setPendingResultsRoute: (p) => set({ pendingResultsRoute: p }),
      setResultsParams: (p) => set({ resultsParams: p }),
      selectedResultContext: null,
      selectResult: (r, passengers, context) =>
        // Wenn ein vorheriger Stub-Result da war (Pending), wird er hier mit
        // dem echten Result überschrieben — Pending bleibt true bis der
        // Caller explizit `setSelectedResultPending(false)` aufruft. So kann
        // der Caller den Übergang Stub → Real präzise steuern.
        set({
          selectedResult: r,
          selectedPassengers: passengers,
          // Kontext nur überschreiben wenn der Caller einen mitschickt —
          // sonst beim Stub-→-Real-Übergang (gleiche Card-Quelle) bleibt der
          // ursprüngliche Kontext bestehen.
          ...(context ? { selectedResultContext: context } : {}),
        }),
      selectedResultPending: false,
      setSelectedResultPending: (pending) => set({ selectedResultPending: pending }),
      clearSelectedResult: () =>
        set({
          selectedResult: null,
          selectedResultContext: null,
          // Wenn das Details-Overlay zugemacht wird, hat ein offenes
          // Leg-Timeline-Sheet keine sinnvolle Grundlage mehr. Außerdem
          // verhindert das, dass beim nächsten Öffnen eines anderen
          // Tickets der Leg-Timeline mit nach oben slidet.
          legTimelineOverlayOpen: false,
          // Pending-Flag immer mit zurücksetzen — sonst hängt der Skeleton-
          // State beim nächsten Open.
          selectedResultPending: false,
        }),
      legTimelineOverlayOpen: false,
      openLegTimelineOverlay: () => set({ legTimelineOverlayOpen: true }),
      // Beim Schließen des Timelines IMMER auch den Direct-Trip-Slot leeren —
      // sonst würde der nächste Open-Aufruf (über DetailsOverlay) noch den
      // alten Bus/Zug aus dem Stop-Tap anzeigen statt der neuen Strecke.
      closeLegTimelineOverlay: () => set({ legTimelineOverlayOpen: false, directTripResult: null }),
      directTripResult: null,
      openDirectTrip: (r) => set({ directTripResult: r, legTimelineOverlayOpen: true }),
      clearDirectTrip: () => set({ directTripResult: null, legTimelineOverlayOpen: false }),
      recentSearches: [],
      addRecentSearch: (s) =>
        set((state) => {
          const filtered = state.recentSearches.filter(
            (r) =>
              !(
                r.mode === s.mode &&
                r.origin.code === s.origin.code &&
                r.destination.code === s.destination.code
              )
          );
          const entry: RecentSearch = {
            ...s,
            id: `${s.mode}-${s.origin.code}-${s.destination.code}-${Date.now()}`,
            timestamp: Date.now(),
          };
          return { recentSearches: [entry, ...filtered].slice(0, MAX_RECENT_HISTORY) };
        }),
      removeRecentSearch: (id) =>
        set((state) => ({
          recentSearches: state.recentSearches.filter((r) => r.id !== id),
        })),
      clearRecentSearches: () => set({ recentSearches: [] }),
      invalidSuggestionCodes: [],
      validatePersistedCodes: async () => {
        const state = get();
        // Codes aus Recents (origin+destination), Saved-Stations UND der
        // hartkodierten Vorschlagsliste einsammeln. Dedupliziert via Set.
        const codes = new Set<string>();
        for (const r of state.recentSearches) {
          if (r.origin.code) codes.add(r.origin.code);
          if (r.destination.code) codes.add(r.destination.code);
        }
        for (const s of state.savedStations) {
          if (s.code) codes.add(s.code);
        }
        // POPULAR_LOCATIONS mitprüfen — die Liste steht fest im Code und kann
        // von der DB abdriften, ohne dass es jemandem auffällt (das Label sieht
        // ja richtig aus). Nur auflösbare Codes prüfen (Flug=IATA, Bus/Hafen
        // haben eigene Namensräume und liegen nicht in `locations`).
        const suggestionCodes = Object.values(POPULAR_LOCATIONS)
          .flat()
          .map((l) => l.code)
          .filter((c) => /^(sta|gtfs|osm):/.test(c));
        for (const c of suggestionCodes) codes.add(c);

        if (codes.size === 0) return;
        let lookup: Map<string, { exists: boolean; label?: string }>;
        try {
          const results = await fetchLocationsByCodes(Array.from(codes));
          lookup = new Map(
            results.map((r) => [
              r.code,
              r.exists ? { exists: true, label: r.label } : { exists: false },
            ]),
          );
        } catch {
          // Server unerreichbar / Timeout → konservativ nichts ändern.
          return;
        }
        // Erst Recents prunen+labelen: Eintrag rausnehmen wenn entweder Origin
        // oder Destination nicht mehr existiert. Sonst beide Labels syncen.
        //
        // ANGEWANDT AUF DEN FRISCHEN STAND, nicht auf den von oben.
        //
        // Hier wurden bis eben `state.recentSearches` und `state.savedStations`
        // umgeformt und als KOMPLETTE Felder zurückgeschrieben — beides aus dem
        // `get()` ganz am Anfang, also von VOR dem Netzaufruf. Der läuft direkt
        // nach dem Wiederherstellen und darf bis zu zehn Sekunden dauern. Wer in
        // diesem Fenster eine Station mit dem Stern speichert oder eine Suche
        // macht, bekam sie stillschweigend wieder gelöscht: Der alte Stand
        // überschrieb den neuen.
        //
        // Das ist dieselbe Falle wie beim Wächter in `loadMore` — nur dort war
        // die Folge ein wirkungsloser Vergleich, hier echter Datenverlust. Die
        // Regel ist beide Male dieselbe: Nach einem `await` darf nichts mehr aus
        // der alten Closure kommen. Die Umformung ist deshalb eine Funktion, und
        // ihren Eingang liefert das `set((cur) => …)` ganz unten.
        const applyRecents = (list: RecentSearch[]): RecentSearch[] => {
        const nextRecents: RecentSearch[] = [];
        for (const r of list) {
          const o = lookup.get(r.origin.code);
          const d = lookup.get(r.destination.code);
          // Wenn ein Code im Lookup fehlt (z.B. Server hat ihn nicht
          // zurückgegeben) → konservativ als „noch da" werten.
          if (o && !o.exists) continue;
          if (d && !d.exists) continue;
          nextRecents.push({
            ...r,
            origin: o?.exists && o.label ? { ...r.origin, label: o.label } : r.origin,
            destination: d?.exists && d.label ? { ...r.destination, label: d.label } : r.destination,
          });
        }
          return nextRecents;
        };
        // Saved-Stations: Eintrag raus wenn Code weg, sonst Label syncen.
        const applyStations = (list: Location[]): Location[] => {
        const nextStations: Location[] = [];
        for (const s of list) {
          const hit = lookup.get(s.code);
          if (hit && !hit.exists) continue;
          nextStations.push(
            hit?.exists && hit.label ? { ...s, label: hit.label } : s,
          );
        }
          return nextStations;
        };

        // Vorschlagsliste gegenprüfen: der Code muss existieren UND sein
        // DB-Name muss zum angezeigten Label passen. Tut er das nicht, führt
        // der Vorschlag den User woanders hin (siehe Wien Hbf / Blumental) —
        // dann lieber gar nicht anbieten, statt ihn stumm falsch fahren zu
        // lassen. Codes, die der Server nicht zurückgab, bewerten wir nicht.
        const norm = (v: string) => v.toLowerCase().replace(/[^a-z0-9]/g, "");
        const invalid: string[] = [];
        for (const l of Object.values(POPULAR_LOCATIONS).flat()) {
          if (!/^(sta|gtfs|osm):/.test(l.code)) continue;
          const hit = lookup.get(l.code);
          if (!hit) continue;
          const want = norm(l.label);
          const got = hit.exists && hit.label ? norm(hit.label) : "";
          const matches =
            !!got && (got.includes(want.slice(0, 8)) || want.includes(got.slice(0, 8)));
          if (!matches) {
            invalid.push(l.code);
            if (__DEV__) {
              console.warn(
                `[popularLocations] "${l.label}" (${l.code}) zeigt auf ` +
                  `"${hit.exists ? hit.label : "— existiert nicht —"}". Vorschlag ausgeblendet.`,
              );
            }
          }
        }
        set((cur) => {
          // `cur` ist der Stand JETZT, nicht der von vor dem Netzaufruf.
          const nextRecents = applyRecents(cur.recentSearches);
          const nextStations = applyStations(cur.savedStations);
          const recentsChanged =
            nextRecents.length !== cur.recentSearches.length ||
            nextRecents.some(
              (r, i) =>
                r.origin.label !== cur.recentSearches[i]?.origin.label ||
                r.destination.label !== cur.recentSearches[i]?.destination.label,
            );
          const stationsChanged =
            nextStations.length !== cur.savedStations.length ||
            nextStations.some((s, i) => s.label !== cur.savedStations[i]?.label);
          const invalidChanged =
            invalid.length !== cur.invalidSuggestionCodes.length ||
            invalid.some((c, i) => c !== cur.invalidSuggestionCodes[i]);
          if (!recentsChanged && !stationsChanged && !invalidChanged) return cur;
          return {
            ...(invalidChanged ? { invalidSuggestionCodes: invalid } : {}),
            ...(recentsChanged ? { recentSearches: nextRecents } : {}),
            ...(stationsChanged
              ? {
                  savedStations: nextStations,
                  savedStationCodes: new Set(nextStations.map((s) => s.code)),
                }
              : {}),
          };
        });
      },
      recentSpots: [],
      lastKnownCoord: null,
      setLastKnownCoord: (c) =>
        set((state) => {
          // Nur bei nennenswerter Bewegung schreiben — sonst löst jeder GPS-Fix
          // einen Speicher-Schreibvorgang samt Persistenz-Uhr aus.
          const prev = state.lastKnownCoord;
          if (
            prev &&
            Math.abs(prev.latitude - c.latitude) < 0.0005 &&
            Math.abs(prev.longitude - c.longitude) < 0.0005
          ) {
            return state;
          }
          return { lastKnownCoord: c };
        }),
      addRecentSpot: (query) =>
        set((state) => {
          const q = query.trim();
          if (!q) return state;
          const filtered = state.recentSpots.filter((s) => s.toLowerCase() !== q.toLowerCase());
          return { recentSpots: [q, ...filtered].slice(0, MAX_RECENT) };
        }),
      removeRecentSpot: (query) =>
        set((state) => ({
          recentSpots: state.recentSpots.filter((s) => s !== query),
        })),
      favoriteResultIds: [],
      toggleFavorite: (id) =>
        set((state) => ({
          // Cap 200: Result-IDs sind vergänglich (jede Suche erzeugt neue) —
          // ohne Deckel wächst das persistierte Array über Monate unbegrenzt.
          // Bei Überlauf fliegen die ältesten (vorne) raus.
          favoriteResultIds: state.favoriteResultIds.includes(id)
            ? state.favoriteResultIds.filter((x) => x !== id)
            : [...state.favoriteResultIds, id].slice(-200),
        })),
      savedTrips: [],
      savedTripSignatures: new Set<string>(),
      saveTrip: (result, passengers) =>
        set((state) => {
          const sig = tripSignature(result);
          if (state.savedTripSignatures.has(sig)) return state;
          const trip: SavedTrip = {
            ...result,
            savedAt: Date.now(),
            passengers,
            priceAlert: false,
          };
          const sigs = new Set(state.savedTripSignatures);
          sigs.add(sig);
          return {
            savedTrips: [trip, ...state.savedTrips],
            savedTripSignatures: sigs,
          };
        }),
      unsaveTrip: (id) =>
        set((state) => {
          const removed = state.savedTrips.find((t) => t.id === id);
          if (!removed) return state;
          const sigs = new Set(state.savedTripSignatures);
          sigs.delete(tripSignature(removed));
          return {
            savedTrips: state.savedTrips.filter((t) => t.id !== id),
            savedTripSignatures: sigs,
            // Herunterzählen, nicht unter null — siehe `savedBadge`.
            savedBadge: Math.max(0, state.savedBadge - 1),
          };
        }),
      toggleSavedTrip: (result, passengers) =>
        set((state) => {
          const sig = tripSignature(result);
          const sigs = new Set(state.savedTripSignatures);
          if (sigs.has(sig)) {
            sigs.delete(sig);
            return {
              savedTrips: state.savedTrips.filter(
                (t) => tripSignature(t) !== sig,
              ),
              savedTripSignatures: sigs,
              savedBadge: Math.max(0, state.savedBadge - 1),
            };
          }
          const trip: SavedTrip = {
            ...result,
            savedAt: Date.now(),
            passengers,
            priceAlert: false,
          };
          sigs.add(sig);
          // Save UND Toast in EINEM set() — sonst zwei sequentielle Store-
          // Notifications = zwei Re-Render-Wellen über alle Subscriber.
          return {
            savedTrips: [trip, ...state.savedTrips],
            savedTripSignatures: sigs,
            savedBadge: state.savedBadge + 1,
            savedToast: {
              key: Date.now(),
              resultId: result.id,
              originLabel: result.originLabel,
              destLabel: result.destLabel,
              price: result.price,
              currency: result.currency,
            },
          };
        }),
      setTripPriceAlert: (id, on) =>
        set((state) => ({
          savedTrips: state.savedTrips.map((t) =>
            t.id === id ? { ...t, priceAlert: on } : t
          ),
        })),
      pruneExpiredSavedTrips: () =>
        set((state) => {
          // Tagesvergleich in User-Lokalzeit: arriveTime ist ISO-UTC, JS
          // parsiert das korrekt und `getFullYear/getMonth/getDate` geben
          // den lokalen Kalendertag. Trip am 14. (z.B. arriveTime
          // 2026-05-14T22:00:00Z = lokal 15.05. 00:00 in Europa) wird also
          // erst gelöscht wenn der lokale Kalendertag ECHT größer ist als
          // der Ankunftstag — Edge-Case „lange Nachtfahrt über Mitternacht"
          // bleibt am Ankunftstag sichtbar.
          const now = new Date();
          const todayKey = now.getFullYear() * 10000 + (now.getMonth() + 1) * 100 + now.getDate();
          const kept = state.savedTrips.filter((tr) => {
            const a = new Date(tr.arriveTime);
            if (Number.isNaN(a.getTime())) return true; // unparsbares Datum → drinlassen
            const arrivalKey = a.getFullYear() * 10000 + (a.getMonth() + 1) * 100 + a.getDate();
            return arrivalKey >= todayKey;
          });
          if (kept.length === state.savedTrips.length) return state;
          return {
            savedTrips: kept,
            savedTripSignatures: new Set(kept.map((t) => tripSignature(t))),
          };
        }),
      savedBadge: 0,
      clearSavedBadge: () => {
        // Nur schreiben, wenn wirklich etwas zu löschen ist: Ein ungeschütztes
        // set() weckt ALLE Abonnenten — und das hier läuft bei jedem Fokus des
        // Saved-Tabs, also mitten im Tab-Wechsel.
        if (get().savedBadge > 0) set({ savedBadge: 0 });
      },
      tickets: [],
      addTicket: (t) =>
        set((state) => {
          const ticket: Ticket = {
            ...t,
            id: `ticket-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            createdAt: Date.now(),
          };
          /**
           * KEIN Punkt in der Leiste beim Hinzufügen eines Tickets.
           *
           * Der Punkt meldet „hier ist etwas Neues, das du noch nicht gesehen
           * hast". Ein Ticket legt man selbst an, im Saved-Tab, und sieht es im
           * selben Moment in der Liste stehen — es gibt nichts zu melden. Beim
           * Speichern einer Verbindung ist das anders: Das passiert aus der
           * Ergebnisliste heraus, also woanders.
           */
          return { tickets: [ticket, ...state.tickets] };
        }),
      removeTicket: (id) =>
        set((state) => ({
          tickets: state.tickets.filter((t) => t.id !== id),
          // Wenn das gerade offene Detail-Overlay-Ticket gelöscht wird,
          // Overlay mit-schließen damit keine Ghost-Daten gerendert werden.
          selectedTicket: state.selectedTicket?.id === id ? null : state.selectedTicket,
        })),
      patchTicket: (id, patch) =>
        set((state) => ({
          tickets: state.tickets.map((t) => (t.id === id ? { ...t, ...patch } : t)),
          selectedTicket:
            state.selectedTicket?.id === id
              ? { ...state.selectedTicket, ...patch }
              : state.selectedTicket,
        })),
      selectedTicket: null,
      openTicketDetail: (t) => set({ selectedTicket: t }),
      clearSelectedTicket: () => set({ selectedTicket: null }),
      authToken: null,
      authUser: null,
      authOverlayOpen: false,
      openAuthOverlay: () => set({ authOverlayOpen: true }),
      closeAuthOverlay: () => set({ authOverlayOpen: false }),
      // KEINE Auto-Close auf authOverlayOpen mehr — der Auth-Screen schließt
      // sich selbst nachdem die Success-Animation durch ist. Vorher schloss
      // setAuth den Overlay sofort, was den Bo-Reinflieg-Effekt unsichtbar
      // gemacht hat. Die Closer-Pfade rufen jetzt explizit closeAuthOverlay.
      // Write-through in den SecureStore (Keystore/Keychain): das Token wird
      // NICHT mehr über die persist-Middleware in AsyncStorage geschrieben
      // (siehe partialize) — Bearer-Tokens gehören nicht in eine
      // unverschlüsselte, backup-fähige Datei.
      setAuth: (token, user) => {
        set({ authToken: token, authUser: user });
        void saveAuthToken(token);
      },
      setAuthUser: (user) => set({ authUser: user }),
      clearAuth: () => {
        set({ authToken: null, authUser: null });
        void saveAuthToken(null);
      },

      savedStations: [],
      savedStationCodes: new Set<string>(),
      toggleSavedStation: (loc) =>
        set((state) => {
          // Gegen die LISTE prüfen, nicht gegen das abgeleitete Set: Die Liste ist
          // die Wahrheit, das Set nur ihr Index. Wäre er je wieder aus dem Tritt,
          // entstünden hier sonst Duplikate.
          const exists = state.savedStations.some((st) => st.code === loc.code);
          const next = exists
            ? state.savedStations.filter((s) => s.code !== loc.code)
            // Neu hinzugefügte Stationen vorne einsortieren — Recent-First-Order
            // in der LocationPicker-Liste matched dann die Save-Reihenfolge.
            : [loc, ...state.savedStations];
          return { savedStations: next, savedStationCodes: new Set(next.map((s) => s.code)) };
        }),

      pendingRoute: null,
      setRoute: (r) => set({ pendingRoute: r }),
      setRoutePolylines: (polylines) =>
        set((s) => {
          if (!s.pendingRoute) return {};
          const { waypoints } = s.pendingRoute;
          const updated = s.pendingRoute.legs.map((leg) => {
            if (!leg.tripId) return leg;
            const full = polylines[leg.tripId];
            if (!full) return leg;
            // Polyline auf das Stück zwischen Origin und Destination des Legs
            // zuschneiden — sonst zeichnen wir „Äste" durch den Rest der
            // Zugfahrt nach unserer Aussteigestation.
            const from = waypoints[leg.fromIndex];
            const to = waypoints[leg.toIndex];
            const trimmed = from && to ? trimPolyline(full, from, to) : full;
            return { ...leg, coords: trimmed };
          });
          return { pendingRoute: { ...s.pendingRoute, legs: updated } };
        }),
      clearRoute: () => set({ pendingRoute: null }),
      bypassResultsSlideOut: false,
      setBypassResultsSlideOut: (on) => set({ bypassResultsSlideOut: on }),
    }),
    {
      name: "binch-search",
      // Siehe createDeferredJSONStorage: serialisiert erst in der Ruhephase,
      // nicht bei jedem set().
      storage: createDeferredJSONStorage(AsyncStorage),
      partialize: (state) => ({
        currency: state.currency,
        locale: state.locale,
        theme: state.theme,
        accent: state.accent,
        hapticsEnabled: state.hapticsEnabled,
        notificationsEnabled: state.notificationsEnabled,
        priceAlertsEnabled: state.priceAlertsEnabled,
        savedToastPosition: state.savedToastPosition,
        recentSearches: state.recentSearches,
        recentSpots: state.recentSpots,
        lastKnownCoord: state.lastKnownCoord,
        favoriteResultIds: state.favoriteResultIds,
        savedTrips: state.savedTrips,
        savedStations: state.savedStations,
        tickets: state.tickets,
        // authToken bewusst NICHT hier: liegt im SecureStore (Keystore/
        // Keychain), siehe lib/auth/tokenStorage.ts + AuthHydrator.
        // avatarDataUrl (bis ~800 KB Base64) NICHT mitpersistieren — es
        // hinge sonst in jedem JSON.stringify des Persist-Layers mit drin.
        // AuthHydrator holt den Avatar beim App-Start via /api/auth/me zurück.
        authUser: state.authUser ? { ...state.authUser, avatarDataUrl: null } : null,
      }),
      // Nach Rehydration die `savedTripSignatures` aus den geladenen Trips
      // ableiten — Set ist nicht JSON-serialisierbar und wir wollen sie eh
      // nicht persistieren (immer aus savedTrips berechenbar).
      onRehydrateStorage: () => (state) => {
        if (!state) return;
        /**
         * BEIDE abgeleiteten Sets neu aufbauen — und über `setState`, nicht per
         * Direktzuweisung.
         *
         * `savedStationCodes` fehlte hier. Persistiert wird nur die Liste (ein Set
         * überlebt JSON nicht), und der Merge von `persist` ist flach — nach jedem
         * Kaltstart war die Liste also voll und das Set leer. Sichtbar wurde das
         * im Ortspicker: Jede gespeicherte Station zeigte einen leeren Stern,
         * während dieselbe Station in derselben Liste unter „Gespeichert" stand.
         * Und ein Tipp auf den Stern entfernte sie dann nicht, sondern legte eine
         * ZWEITE Kopie an — doppelter Code in der persistierten Liste.
         *
         * `setState` statt Direktzuweisung, weil eine Zuweisung keine Abonnenten
         * benachrichtigt: Bereits gemountete Bäume hätten sonst bis zum nächsten
         * beliebigen Schreibvorgang mit dem leeren Set gerendert.
         */
        useSearchStore.setState({
          savedTripSignatures: new Set(state.savedTrips.map((t) => tripSignature(t))),
          savedStationCodes: new Set(state.savedStations.map((st) => st.code)),
        });
      },
    }
  )
);
