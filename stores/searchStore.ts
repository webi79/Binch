import { create } from "zustand";
import { persist, createJSONStorage, type StateStorage } from "zustand/middleware";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { AppState } from "react-native";
import { SearchResult, TravelMode, Location } from "@/types/search";
import { SavedTrip, Ticket } from "@/types/saved";
import { tripSignature } from "@/lib/results/signature";
import type { AuthUser } from "@/lib/api/client";
import { fetchLocationsByCodes } from "@/lib/api/client";
import { trimPolyline } from "@/lib/routing/trimPolyline";

export type Locale = "en" | "de" | "fr" | "es";

/**
 * Debounced AsyncStorage-Adapter mit AppState-Flush.
 *
 * Problem: Zustands `persist` ruft `setItem` SYNCHRON nach jedem `set()` —
 * also bei jedem Save, jedem Toggle, jeder Currency-Änderung etc. Die
 * Serialization (JSON.stringify auf einem >50kB-State) plus der Native-
 * Bridge-Roundtrip blockieren den JS-Thread für 10-30ms pro Call. Während
 * dieser Zeit stuttern Reanimated-Animations, Tab-Switches und Slide-Ins.
 *
 * Lösung:
 *  1. Writes 2.5s debounce'n — pendings landen in einer In-Memory-Map
 *  2. Bei App-Background wird sofort geflushed (Daten-Sicherheit)
 *  3. Reads liefern erstmal den pending In-Memory-Wert wenn vorhanden
 *
 * Effekt: während aktiver Nutzung gibt's praktisch keine JS-Thread-Blocks
 * mehr durch Persistierung. Geschrieben wird wenn der User pausiert oder
 * die App in den Hintergrund geht.
 */
function createDebouncedStorage(
  underlying: typeof AsyncStorage,
  delayMs = 2500,
): StateStorage {
  const pending = new Map<string, string | null>();
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (pending.size === 0) return;
    const entries = Array.from(pending.entries());
    pending.clear();
    for (const [key, value] of entries) {
      if (value === null) {
        void underlying.removeItem(key);
      } else {
        void underlying.setItem(key, value);
      }
    }
  };

  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, delayMs);
  };

  // Beim Wechsel in den Hintergrund SOFORT alles flushen — sonst gehen
  // die letzten 2.5s an Änderungen verloren wenn die App gekillt wird.
  AppState.addEventListener("change", (state) => {
    if (state === "background" || state === "inactive") flush();
  });

  return {
    getItem: async (key) => {
      if (pending.has(key)) {
        const v = pending.get(key);
        return v ?? null;
      }
      return underlying.getItem(key);
    },
    setItem: (key, value) => {
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
  /** Incrementiert bei jedem openSearchOverlay-Call. Wird als React-Key
   *  in SearchHeroOverlay genutzt um SearchHero pro Open frisch zu mounten —
   *  damit bleibt nichts an State aus einem vorherigen (nicht abgeschickten)
   *  Such-Versuch übrig. */
  searchOverlaySession: number;
  openSearchOverlay: (mode: TravelMode) => void;
  closeSearchOverlay: () => void;
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
  recentSpots: string[];
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
      searchOverlaySession: 0,
      openSearchOverlay: (mode) =>
        set((state) => ({
          searchOverlayMode: mode,
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
      closeSearchOverlay: () =>
        set({
          searchOverlayMode: null,
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
      openLocationPicker: ({ field, mode, suggested, title, leadingLabel, placeholderKey, onSelect }) =>
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
      closeRecentHistoryOverlay: () => set({ recentHistoryOverlayOpen: false }),
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
      validatePersistedCodes: async () => {
        const state = get();
        // Codes aus Recents (origin+destination) UND aus Saved-Stations
        // einsammeln. Dedupliziert via Set.
        const codes = new Set<string>();
        for (const r of state.recentSearches) {
          if (r.origin.code) codes.add(r.origin.code);
          if (r.destination.code) codes.add(r.destination.code);
        }
        for (const s of state.savedStations) {
          if (s.code) codes.add(s.code);
        }
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
        const nextRecents: RecentSearch[] = [];
        for (const r of state.recentSearches) {
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
        // Saved-Stations: Eintrag raus wenn Code weg, sonst Label syncen.
        const nextStations: Location[] = [];
        for (const s of state.savedStations) {
          const hit = lookup.get(s.code);
          if (hit && !hit.exists) continue;
          nextStations.push(
            hit?.exists && hit.label ? { ...s, label: hit.label } : s,
          );
        }
        const recentsChanged =
          nextRecents.length !== state.recentSearches.length ||
          nextRecents.some(
            (r, i) =>
              r.origin.label !== state.recentSearches[i]?.origin.label ||
              r.destination.label !== state.recentSearches[i]?.destination.label,
          );
        const stationsChanged =
          nextStations.length !== state.savedStations.length ||
          nextStations.some((s, i) => s.label !== state.savedStations[i]?.label);
        if (!recentsChanged && !stationsChanged) return;
        set({
          ...(recentsChanged ? { recentSearches: nextRecents } : {}),
          ...(stationsChanged ? { savedStations: nextStations } : {}),
        });
      },
      recentSpots: [],
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
      tickets: [],
      addTicket: (t) =>
        set((state) => {
          const ticket: Ticket = {
            ...t,
            id: `ticket-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            createdAt: Date.now(),
          };
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
      setAuth: (token, user) => set({ authToken: token, authUser: user }),
      setAuthUser: (user) => set({ authUser: user }),
      clearAuth: () => set({ authToken: null, authUser: null }),

      savedStations: [],
      toggleSavedStation: (loc) =>
        set((state) => {
          const exists = state.savedStations.some((s) => s.code === loc.code);
          if (exists) {
            return { savedStations: state.savedStations.filter((s) => s.code !== loc.code) };
          }
          // Neu hinzugefügte Stationen vorne einsortieren — Recent-First-Order
          // in der LocationPicker-Liste matched dann die Save-Reihenfolge.
          return { savedStations: [loc, ...state.savedStations] };
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
      // Debounced Adapter: bündelt Writes innerhalb 600ms → ein einziger
      // JSON.stringify + AsyncStorage-Write statt zehn. Eliminiert die
      // 10-30ms JS-Thread-Blocks die sonst bei jedem Save/Toggle die App
      // ruckeln lassen.
      storage: createJSONStorage(() => createDebouncedStorage(AsyncStorage)),
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
        favoriteResultIds: state.favoriteResultIds,
        savedTrips: state.savedTrips,
        savedStations: state.savedStations,
        tickets: state.tickets,
        authToken: state.authToken,
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
        state.savedTripSignatures = new Set(
          state.savedTrips.map((t) => tripSignature(t)),
        );
      },
    }
  )
);
