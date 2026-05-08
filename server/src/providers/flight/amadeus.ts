import { config } from "../../config.js";
import type { SearchProvider, ProviderSearchInput, ProviderResult } from "../types.js";

export const amadeusProvider: SearchProvider = {
  name: "amadeus",
  mode: "FLIGHT",

  isConfigured() {
    return Boolean(config.AMADEUS_CLIENT_ID && config.AMADEUS_CLIENT_SECRET);
  },

  async search(_input: ProviderSearchInput, _signal?: AbortSignal): Promise<ProviderResult> {
    const start = Date.now();
    if (!this.isConfigured()) {
      return { results: [], raw: { skipped: "no token" }, statusCode: 0, durationMs: 0 };
    }

    // TODO: Amadeus OAuth-Flow + /v2/shopping/flight-offers anbinden.

    return {
      results: [],
      raw: { stub: true, provider: "amadeus" },
      statusCode: 200,
      durationMs: Date.now() - start,
    };
  },
};
