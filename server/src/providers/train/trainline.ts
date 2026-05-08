import { config } from "../../config.js";
import type { SearchProvider, ProviderSearchInput, ProviderResult } from "../types.js";

export const trainlineProvider: SearchProvider = {
  name: "trainline",
  mode: "TRAIN",

  isConfigured() {
    return Boolean(config.TRAINLINE_API_KEY);
  },

  async search(_input: ProviderSearchInput, _signal?: AbortSignal): Promise<ProviderResult> {
    const start = Date.now();
    if (!this.isConfigured()) {
      return { results: [], raw: { skipped: "no token" }, statusCode: 0, durationMs: 0 };
    }

    // TODO: Trainline API anbinden.

    return {
      results: [],
      raw: { stub: true, provider: "trainline" },
      statusCode: 200,
      durationMs: Date.now() - start,
    };
  },
};
