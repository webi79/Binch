import { config } from "../../config.js";
import type { SearchProvider, ProviderSearchInput, ProviderResult } from "../types.js";

export const cruisedirectProvider: SearchProvider = {
  name: "cruisedirect",
  mode: "CRUISE",

  isConfigured() {
    return Boolean(config.CRUISEDIRECT_API_KEY);
  },

  async search(_input: ProviderSearchInput, _signal?: AbortSignal): Promise<ProviderResult> {
    const start = Date.now();
    if (!this.isConfigured()) {
      return { results: [], raw: { skipped: "no token" }, statusCode: 0, durationMs: 0 };
    }

    // TODO: CruiseDirect API anbinden.

    return {
      results: [],
      raw: { stub: true, provider: "cruisedirect" },
      statusCode: 200,
      durationMs: Date.now() - start,
    };
  },
};
