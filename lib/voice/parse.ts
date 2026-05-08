import { TravelMode } from "@/types/search";
import { addDays, format } from "date-fns";

export interface VoiceParseResult {
  mode: TravelMode;
  origin: string | null;
  destination: string | null;
  departDate: string | null;
  raw: string;
}

const MODE_KEYWORDS: { mode: TravelMode; patterns: RegExp[] }[] = [
  {
    mode: "FLIGHT",
    patterns: [/\bflug\b/i, /\bflight\b/i, /\bfliegen\b/i, /\bplane\b/i, /\bavion\b/i, /\bvuelo\b/i, /\bvol\b/i],
  },
  {
    mode: "TRAIN",
    patterns: [/\bzug\b/i, /\btrain\b/i, /\bbahn\b/i, /\btren\b/i],
  },
  {
    mode: "BUS",
    patterns: [/\bbus\b/i, /\bautobus\b/i, /\bcoach\b/i],
  },
];

export function parseVoice(transcript: string): VoiceParseResult {
  const text = transcript.trim();
  const lower = text.toLowerCase();

  let mode: TravelMode = "FLIGHT";
  for (const { mode: m, patterns } of MODE_KEYWORDS) {
    if (patterns.some((p) => p.test(lower))) {
      mode = m;
      break;
    }
  }

  const routeMatch =
    /(?:von|from|de|desde)\s+([a-zäöüéèà]+(?:\s+[a-zäöüéèà]+)?)\s+(?:nach|to|à|hasta|a)\s+([a-zäöüéèà]+(?:\s+[a-zäöüéèà]+)?)/i.exec(
      text,
    );

  const origin = routeMatch ? titleCase(routeMatch[1]) : null;
  const destination = routeMatch ? titleCase(routeMatch[2]) : null;

  const today = new Date();
  let departDate: string | null = null;
  if (/\bheute\b|\btoday\b|\baujourd'?hui\b|\bhoy\b/i.test(lower)) {
    departDate = format(today, "yyyy-MM-dd");
  } else if (/\bmorgen\b|\btomorrow\b|\bdemain\b|\bmañana\b/i.test(lower)) {
    departDate = format(addDays(today, 1), "yyyy-MM-dd");
  } else if (/\bübermorgen\b|\bday after tomorrow\b/i.test(lower)) {
    departDate = format(addDays(today, 2), "yyyy-MM-dd");
  } else if (/\bnächste woche\b|\bnext week\b|\bsemaine prochaine\b|\bpróxima semana\b/i.test(lower)) {
    departDate = format(addDays(today, 7), "yyyy-MM-dd");
  }

  return { mode, origin, destination, departDate, raw: text };
}

function titleCase(s: string): string {
  return s
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}
