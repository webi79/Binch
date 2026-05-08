import { SearchResult } from "@/types/search";

type SignatureSource = Pick<
  SearchResult,
  "mode" | "origin" | "destination" | "departTime" | "arriveTime" | "provider"
> & { flightNumber?: string };

/**
 * Stable identifier for a trip across searches. The backend assigns fresh
 * UUIDs to every search response, so `id` cannot be used to detect whether
 * a result is already saved. The signature is derived from the trip's
 * intrinsic properties.
 */
export function tripSignature(r: SignatureSource): string {
  return [
    r.mode,
    r.origin,
    r.destination,
    r.departTime,
    r.arriveTime,
    r.provider,
    r.flightNumber ?? "",
  ].join("|");
}
