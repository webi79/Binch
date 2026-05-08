import { config } from "../../config.js";
import type { SearchProvider, ProviderSearchInput, ProviderResult } from "../types.js";

export const skyscannerProvider: SearchProvider = {
  name: "skyscanner",
  mode: "FLIGHT",

  isConfigured() {
    return Boolean(config.SKYSCANNER_API_KEY);
  },

  async search(_input: ProviderSearchInput, _signal?: AbortSignal): Promise<ProviderResult> {
    const start = Date.now();
    if (!this.isConfigured()) {
      return { results: [], raw: { skipped: "no token" }, statusCode: 0, durationMs: 0 };
    }

    // TODO: Echte Skyscanner-API anbinden, sobald Token vorhanden.
    // Endpoint-Beispiel: https://partners.api.skyscanner.net/apiservices/v3/flights/live/search/create
    // Header: x-api-key: <SKYSCANNER_API_KEY>

    return {
      results: [],
      raw: { stub: true, provider: "skyscanner" },
      statusCode: 200,
      durationMs: Date.now() - start,
    };
  },
};
