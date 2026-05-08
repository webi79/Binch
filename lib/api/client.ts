import Constants from "expo-constants";
import { Location, SearchParams, SearchResponse, TravelMode } from "@/types/search";

export const API_BASE_URL: string =
  (Constants.expoConfig?.extra as { apiBaseUrl?: string })?.apiBaseUrl ?? "http://localhost:3000";

function buildUrl(path: string, params?: Record<string, string | number | undefined>): string {
  const url = new URL(path, API_BASE_URL);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

// Default 20s timeout für Search-Calls, 8s für Locations/kleine Calls.
// Verhindert dass der Client minutenlang hängt wenn der Server unerreichbar ist.
async function getJson<T>(
  path: string,
  params?: Record<string, string | number | undefined>,
  timeoutMs = 20_000,
): Promise<T> {
  const url = buildUrl(path, params);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`API ${res.status} ${res.statusText} for ${url}`);
    return (await res.json()) as T;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`Request timeout after ${timeoutMs}ms — Server nicht erreichbar (${url})`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export function searchFlights(p: SearchParams): Promise<SearchResponse> {
  return getJson("/api/search/flights", {
    origin: p.origin,
    destination: p.destination,
    originLabel: p.originLabel,
    destLabel: p.destLabel,
    departDate: p.departDate,
    passengers: p.passengers,
    currency: p.currency,
  });
}

export function searchTrains(p: SearchParams): Promise<SearchResponse> {
  return getJson("/api/search/trains", {
    origin: p.origin,
    destination: p.destination,
    originLabel: p.originLabel,
    destLabel: p.destLabel,
    departDate: p.departDate,
    passengers: p.passengers,
    currency: p.currency,
  });
}

export function searchBuses(p: SearchParams): Promise<SearchResponse> {
  return getJson("/api/search/buses", {
    origin: p.origin,
    destination: p.destination,
    originLabel: p.originLabel,
    destLabel: p.destLabel,
    departDate: p.departDate,
    passengers: p.passengers,
    currency: p.currency,
  });
}

export function searchCruises(p: SearchParams): Promise<SearchResponse> {
  return getJson("/api/search/cruises", {
    origin: p.origin,
    destination: p.destination,
    originLabel: p.originLabel,
    destLabel: p.destLabel,
    departDate: p.departDate,
    passengers: p.passengers,
    currency: p.currency,
  });
}

export function searchByMode(p: SearchParams): Promise<SearchResponse> {
  if (p.mode === "FLIGHT") return searchFlights(p);
  if (p.mode === "TRAIN") return searchTrains(p);
  if (p.mode === "CRUISE") return searchCruises(p);
  return searchBuses(p);
}

export function fetchLocations(query: string, mode: TravelMode | "ALL" = "ALL"): Promise<Location[]> {
  return getJson<{ results: Location[] }>("/api/locations", { q: query, mode }, 8_000).then(
    (r) => r.results ?? [],
  );
}

export function redirectUrl(token: string): string {
  return `${API_BASE_URL}/redirect/${token}`;
}

export interface ParsedTicketResponse {
  fields: {
    mode?: "FLIGHT" | "TRAIN" | "BUS" | "CRUISE";
    carrier?: string;
    flightNumber?: string;
    fromCode?: string;
    fromCity?: string;
    toCode?: string;
    toCity?: string;
    departTime?: string;
    arriveTime?: string;
    durationMinutes?: number;
    passenger?: string;
    seat?: string;
    travelClass?: string;
  };
  pageImage: string;
  pageWidth: number;
  pageHeight: number;
  pageCount: number;
  originalName?: string;
}

export interface AuthUser {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  avatarDataUrl: string | null;
}

export interface AuthResponse {
  token: string;
  user: AuthUser;
}

async function postJson<T>(path: string, body: unknown, token?: string): Promise<T> {
  const url = buildUrl(path);
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let detail = "";
    try {
      const j = await res.json();
      detail = (j && typeof j === "object" && "error" in j ? String(j.error) : "") || "";
    } catch {
      /* ignore */
    }
    throw new Error(detail || `API ${res.status} ${res.statusText}`);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export function authRegister(input: {
  email: string;
  password: string;
  firstName: string;
  lastName: string;
}): Promise<AuthResponse> {
  return postJson("/api/auth/register", input);
}

export function authLogin(input: { email: string; password: string }): Promise<AuthResponse> {
  return postJson("/api/auth/login", input);
}

export function authLogout(token: string): Promise<void> {
  return postJson<void>("/api/auth/logout", {}, token);
}

export async function authMe(token: string): Promise<AuthUser> {
  const url = buildUrl("/api/auth/me");
  const res = await fetch(url, {
    headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`API ${res.status} ${res.statusText}`);
  const j = (await res.json()) as { user: AuthUser };
  return j.user;
}

export async function authUpdateAvatar(
  token: string,
  dataUrl: string | null,
): Promise<AuthUser> {
  const url = buildUrl("/api/auth/avatar");
  const res = await fetch(url, {
    method: "PUT",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ dataUrl }),
  });
  if (!res.ok) {
    let msg = `API ${res.status} ${res.statusText}`;
    try {
      const j = await res.json();
      if (j && typeof j === "object" && "error" in j) msg = String(j.error);
    } catch {
      /* ignore */
    }
    throw new Error(msg);
  }
  const j = (await res.json()) as { user: AuthUser };
  return j.user;
}

export async function parseTicketPdf(
  uri: string,
  name: string,
  mimeType = "application/pdf"
): Promise<ParsedTicketResponse> {
  const url = `${API_BASE_URL}/api/tickets/parse`;
  const form = new FormData();
  form.append("file", {
    uri,
    name,
    type: mimeType,
  } as unknown as Blob);

  const res = await fetch(url, {
    method: "POST",
    body: form,
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`API ${res.status} ${res.statusText} for ${url}${txt ? ` :: ${txt}` : ""}`);
  }
  return (await res.json()) as ParsedTicketResponse;
}
