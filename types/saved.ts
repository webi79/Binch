import { SearchResult, TravelMode } from "./search";

export interface SavedTrip extends SearchResult {
  savedAt: number;
  passengers: number;
  priceAlert: boolean;
}

export interface Ticket {
  id: string;
  mode: TravelMode;
  carrier?: string;
  flightNumber?: string;
  fromCode?: string;
  fromCity?: string;
  toCode?: string;
  toCity?: string;
  departTime?: string;
  arriveTime?: string;
  originTz?: string;
  destinationTz?: string;
  durationMinutes?: number;
  stops: number;
  passenger?: string;
  seat?: string;
  wagon?: string;
  travelClass?: string;
  pageImage: string;
  pageImageRatio?: number;
  originalName?: string;
  /** Original-Code-Bild (QR/Aztec/Barcode) gecroppt aus dem PDF. Pixel-genau
   *  übertragen aus dem Server-Render, also bei Bedarf scanbar.
   *  undefined wenn der Vision-Parser den Code nicht lokalisieren konnte
   *  (Detail-Screen zeigt dann eine Fallback-Message statt was Fake-
   *  Generiertes). */
  codeImage?: string;
  codeType?: "qr" | "barcode";
  // Persistierter Pfad zur Original-PDF (im Document-Storage, NICHT im Cache).
  // Wird vom AddTicketModal beim Import gesetzt — `copyAsync` vom Cache-URI
  // (vom DocumentPicker) ins App-Document-Directory, damit das File auch nach
  // OS-Cache-Cleanup noch existiert.
  pdfUri?: string;
  // Buchungsnummer aus dem Parser (z.B. "TRN-2024-789456"). Wenn nicht
  // verfügbar, fallback auf flightNumber im UI.
  bookingRef?: string;
  // Bahnhof/Station-Name (z.B. "Wrocław Główny"). fromCity ist nur die Stadt,
  // hier kommt der konkrete Station-/Terminal-Name rein wenn der Parser ihn
  // ausgelesen hat. Fallback im UI = fromCity.
  fromStation?: string;
  toStation?: string;
  createdAt: number;
}
