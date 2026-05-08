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
  travelClass?: string;
  pageImage: string;
  pageImageRatio?: number;
  originalName?: string;
  createdAt: number;
}
