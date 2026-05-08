import { config } from "../../config.js";
import type { SearchProvider, ProviderSearchInput, ProviderResult } from "../types.js";

export const busbudProvider: SearchProvider = {
  name: "busbud",
  mode: "BUS",

  isConfigured() {
    return Boolean(config.BUSBUD_API_KEY);
  },

  async search(_input: ProviderSearchInput, _signal?: AbortSignal): Promise<ProviderResult> {
    const start = Date.now();
    if (!this.isConfigured()) {
      return { results: [], raw: { skipped: "no token" }, statusCode: 0, durationMs: 0 };
    }

    // TODO: BusBud API anbinden.

    return {
      results: [],
      raw: { stub: true, provider: "busbud" },
      statusCode: 200,
      durationMs: Date.now() - start,
    };
  },
};
