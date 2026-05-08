import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { SearchResult, TravelMode } from "@/types/search";
import { SavedTrip, Ticket } from "@/types/saved";
import { tripSignature } from "@/lib/results/signature";
import type { AuthUser } from "@/lib/api/client";

export type Locale = "en" | "de" | "fr" | "es";

export type SavedToastPosition = "top" | "bottom";

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
  clearSelectedResult: () => void;
  legTimelineOverlayOpen: boolean;
  openLegTimelineOverlay: () => void;
  closeLegTimelineOverlay: () => void;
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
      selectedResult: null,
      selectedPassengers: 1,
      selectResult: (r, passengers) => set({ selectedResult: r, selectedPassengers: passengers }),
      clearSelectedResult: () => set({ selectedResult: null }),
      legTimelineOverlayOpen: false,
      openLegTimelineOverlay: () => set({ legTimelineOverlayOpen: true }),
      closeLegTimelineOverlay: () => set({ legTimelineOverlayOpen: false }),
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
        tickets: state.tickets,
        authToken: state.authToken,
        authUser: state.authUser,
      }),
    }
  )
);
