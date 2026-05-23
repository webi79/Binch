import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { SearchResult, TravelMode, Location } from "@/types/search";
import { SavedTrip, Ticket } from "@/types/saved";
import { tripSignature } from "@/lib/results/signature";
import type { AuthUser } from "@/lib/api/client";
import { trimPolyline } from "@/lib/routing/trimPolyline";

export type Locale = "en" | "de" | "fr" | "es";

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

export interface SavedToast {
  /** Unique key, bumped each show so identical content retriggers animation */
  key: number;
  resultId: string;
  originLabel: string;
  destLabel: string;
  price: number;
  currency: string;
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

interface SearchStore {
  activeMode: TravelMode;
  setActiveMode: (mode: TravelMode) => void;
  currency: string;
  setCurrency: (code: string) => void;
  locale: Locale;
  setLocale: (l: Locale) => void;
  theme: "light" | "dark" | "gray";
  setTheme: (t: "light" | "dark" | "gray") => void;
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
  searchOverlayMode: TravelMode | null;
  openSearchOverlay: (mode: TravelMode) => void;
  closeSearchOverlay: () => void;
  voiceOverlayOpen: boolean;
  openVoiceOverlay: () => void;
  closeVoiceOverlay: () => void;
  recentHistoryOverlayOpen: boolean;
  openRecentHistoryOverlay: () => void;
  closeRecentHistoryOverlay: () => void;
  selectedResult: SearchResult | null;
  selectedPassengers: number;
  selectResult: (r: SearchResult, passengers: number) => void;
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
  recentSpots: string[];
  addRecentSpot: (query: string) => void;
  removeRecentSpot: (query: string) => void;
  favoriteResultIds: string[];
  toggleFavorite: (id: string) => void;
  savedTrips: SavedTrip[];
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
    (set) => ({
      activeMode: "FLIGHT",
      setActiveMode: (mode) => set({ activeMode: mode }),
      currency: "EUR",
      setCurrency: (code) => set({ currency: code.toUpperCase() }),
      locale: "de",
      setLocale: (l) => set({ locale: l }),
      theme: "gray",
      setTheme: (t) => set({ theme: t }),
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
      searchOverlayMode: null,
      openSearchOverlay: (mode) => set({ searchOverlayMode: mode, activeMode: mode }),
      closeSearchOverlay: () => set({ searchOverlayMode: null }),
      voiceOverlayOpen: false,
      openVoiceOverlay: () => set({ voiceOverlayOpen: true }),
      closeVoiceOverlay: () => set({ voiceOverlayOpen: false }),
      recentHistoryOverlayOpen: false,
      openRecentHistoryOverlay: () => set({ recentHistoryOverlayOpen: true }),
      closeRecentHistoryOverlay: () => set({ recentHistoryOverlayOpen: false }),
      selectedStop: null,
      selectStop: (s) => set({ selectedStop: s }),
      clearSelectedStop: () => set({ selectedStop: null }),
      selectedResult: null,
      selectedPassengers: 1,
      selectResult: (r, passengers) =>
        // Wenn ein vorheriger Stub-Result da war (Pending), wird er hier mit
        // dem echten Result überschrieben — Pending bleibt true bis der
        // Caller explizit `setSelectedResultPending(false)` aufruft. So kann
        // der Caller den Übergang Stub → Real präzise steuern.
        set({ selectedResult: r, selectedPassengers: passengers }),
      selectedResultPending: false,
      setSelectedResultPending: (pending) => set({ selectedResultPending: pending }),
      clearSelectedResult: () =>
        set({
          selectedResult: null,
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
          favoriteResultIds: state.favoriteResultIds.includes(id)
            ? state.favoriteResultIds.filter((x) => x !== id)
            : [...state.favoriteResultIds, id],
        })),
      savedTrips: [],
      saveTrip: (result, passengers) =>
        set((state) => {
          const sig = tripSignature(result);
          if (state.savedTrips.some((t) => tripSignature(t) === sig)) return state;
          const trip: SavedTrip = {
            ...result,
            savedAt: Date.now(),
            passengers,
            priceAlert: false,
          };
          return { savedTrips: [trip, ...state.savedTrips] };
        }),
      unsaveTrip: (id) =>
        set((state) => ({
          savedTrips: state.savedTrips.filter((t) => t.id !== id),
        })),
      toggleSavedTrip: (result, passengers) =>
        set((state) => {
          const sig = tripSignature(result);
          const exists = state.savedTrips.some((t) => tripSignature(t) === sig);
          if (exists) {
            return {
              savedTrips: state.savedTrips.filter((t) => tripSignature(t) !== sig),
            };
          }
          const trip: SavedTrip = {
            ...result,
            savedAt: Date.now(),
            passengers,
            priceAlert: false,
          };
          return { savedTrips: [trip, ...state.savedTrips] };
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
          return { savedTrips: kept };
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
        })),
      authToken: null,
      authUser: null,
      authOverlayOpen: false,
      openAuthOverlay: () => set({ authOverlayOpen: true }),
      closeAuthOverlay: () => set({ authOverlayOpen: false }),
      setAuth: (token, user) => set({ authToken: token, authUser: user, authOverlayOpen: false }),
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
    }),
    {
      name: "binch-search",
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (state) => ({
        currency: state.currency,
        locale: state.locale,
        theme: state.theme,
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
        authUser: state.authUser,
      }),
    }
  )
);
