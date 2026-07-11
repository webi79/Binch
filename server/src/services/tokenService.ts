import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { redirectTokens } from "../db/schema.js";
import { config } from "../config.js";
import { randomToken } from "../util/hash.js";

export interface BookingContext {
  mode?: string;
  origin?: string;
  destination?: string;
  departDate?: string;
  returnDate?: string;
  passengers?: number;
  currency?: string;
  /** App-Sprache (de/en/fr/es) — für die Sprach-Lokalisierung der aufgelösten
   *  Anbieter-Deeplinks. */
  lang?: string;
  /** Suchpreis (it.price = Card-Preis) — Detail snappt den günstigsten
   *  geschätzten Anbieter darauf, damit Card- und Detail-Preis übereinstimmen. */
  searchPrice?: number;
  /** Zug-Direkt-Buchungslink („Reise teilen"): Station-Namen + konkrete
   *  Verbindungs-Abfahrt (hinfahrtDatum) für den teilen-Call. */
  originLabel?: string;
  destLabel?: string;
  departTime?: string;
}

export interface IssueOptions {
  bookingToken?: string;
  bookingContext?: BookingContext;
}

export async function issueRedirectToken(
  resultId: string,
  deepLink: string,
  opts?: IssueOptions,
): Promise<string> {
  const token = randomToken(24);
  const expiresAt = new Date(Date.now() + config.REDIRECT_TOKEN_TTL_SECONDS * 1000);

  await db.insert(redirectTokens).values({
    token,
    resultId,
    deepLink,
    expiresAt,
    bookingToken: opts?.bookingToken,
    bookingContext: (opts?.bookingContext as Record<string, unknown> | undefined) ?? undefined,
  });

  return token;
}

export interface ConsumedToken {
  deepLink: string;
  bookingToken: string | null;
  bookingContext: BookingContext | null;
}

export async function consumeRedirectToken(token: string): Promise<ConsumedToken | null> {
  const [row] = await db.select().from(redirectTokens).where(eq(redirectTokens.token, token)).limit(1);
  if (!row) return null;
  if (row.expiresAt.getTime() < Date.now()) return null;

  await db
    .update(redirectTokens)
    .set({
      usedAt: row.usedAt ?? new Date(),
      clickCount: row.clickCount + 1,
    })
    .where(eq(redirectTokens.token, token));

  return {
    deepLink: row.deepLink,
    bookingToken: row.bookingToken,
    bookingContext: (row.bookingContext as BookingContext | null) ?? null,
  };
}
