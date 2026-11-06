/**
 * Bos Gedächtnis und sein Zugriff auf frühere Unterhaltungen — je Konto.
 *
 * Zwei Dinge, die zusammengehören, weil sie dieselbe Frage beantworten: Was
 * weiß Bo über DIESEN Nutzer, über den laufenden Chat hinaus?
 *
 *  • Das Gedächtnis (`bo_memories`): kurze Sätze, die Bo selbst schreibt —
 *    Heimatbahnhof, BahnCard, Vorlieben. Jeder Turn bekommt sie fertig in
 *    seine Anweisungen (`loadBoProfile`), gelesen wird also ohne Werkzeug.
 *  • Frühere Chats (`chat_conversations` / `chat_messages`): Die neuesten
 *    stehen als Liste in den Anweisungen, den Inhalt holt Bo bei Bedarf über
 *    das Werkzeug `past_chats` (Suche nach Wörtern oder ein ganzer Chat).
 *
 * JEDE Abfrage hier ist an `userId` gebunden — das ist die eine Regel, die
 * nicht brechen darf. Fremde Chats sehen aus wie nicht vorhandene.
 */
import { and, asc, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { boMemories, chatConversations, chatMessages, users } from "../db/schema.js";

/** So viele Einträge hält ein Konto höchstens — darüber muss Bo erst vergessen oder ersetzen. */
export const MAX_MEMORIES_PER_USER = 60;
/** Länge eines Eintrags — dieselbe Grenze wie die Spalte. */
export const MAX_MEMORY_CHARS = 300;
/** So viele frühere Chats stehen als Liste in Bos Anweisungen. */
const RECENT_CHATS_IN_PROMPT = 8;
/** Kürzel eines Chats für Bo: die ersten acht Zeichen der UUID. */
const CHAT_REF_LEN = 8;

export interface BoMemoryItem {
  id: number;
  content: string;
  updatedAt: string;
}

export interface BoRecentChat {
  /** Kürzel für `past_chats({ chat })` — acht Zeichen der Kennung. */
  ref: string;
  title: string;
  /** Tag der letzten Nachricht, yyyy-MM-dd. */
  date: string;
}

/** Was ein Turn über das Konto mitbekommt — einmal zu Beginn geladen, im Turn fest. */
export interface BoProfile {
  firstName: string | null;
  memoryEnabled: boolean;
  memories: { id: number; content: string }[];
  recentChats: BoRecentChat[];
}

function day(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Für den Beginn eines Turns: Schalter, Einträge, die neuesten anderen Chats.
 *
 * Drei kleine Abfragen über Indizes (Nutzer-Schlüssel), parallel. Der laufende
 * Chat fehlt in der Liste — den hat Bo ohnehin vor sich.
 */
export async function loadBoProfile(userId: string, currentConversationId: string | null): Promise<BoProfile> {
  const [userRows, memoryRows, recentChats] = await Promise.all([
    db
      .select({ firstName: users.firstName, enabled: users.boMemoryEnabled })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1),
    db
      .select({ id: boMemories.id, content: boMemories.content })
      .from(boMemories)
      .where(eq(boMemories.userId, userId))
      .orderBy(asc(boMemories.id))
      .limit(MAX_MEMORIES_PER_USER),
    listRecentChats(userId, currentConversationId, RECENT_CHATS_IN_PROMPT),
  ]);
  const enabled = userRows[0]?.enabled ?? true;
  return {
    firstName: userRows[0]?.firstName?.trim() || null,
    memoryEnabled: enabled,
    // Aus = Bo liest es nicht. Gelöscht wird dabei nichts.
    memories: enabled ? memoryRows : [],
    recentChats: recentChats.map(({ ref, title, date }) => ({ ref, title, date })),
  };
}

/** Die neuesten anderen Chats des Kontos — für die Liste in den Anweisungen und `past_chats` ohne Angaben. */
export async function listRecentChats(
  userId: string,
  currentConversationId: string | null,
  limit = 10,
): Promise<(BoRecentChat & { preview: string | null })[]> {
  const rows = await db
    .select({
      id: chatConversations.id,
      title: chatConversations.title,
      preview: chatConversations.lastMessagePreview,
      at: chatConversations.lastMessageAt,
    })
    .from(chatConversations)
    .where(
      currentConversationId
        ? and(eq(chatConversations.userId, userId), ne(chatConversations.id, currentConversationId))
        : eq(chatConversations.userId, userId),
    )
    .orderBy(desc(chatConversations.lastMessageAt))
    .limit(limit);
  return rows
    .filter((c) => c.title || c.preview)
    .map((c) => ({
      ref: c.id.slice(0, CHAT_REF_LEN),
      title: (c.title ?? c.preview ?? "").slice(0, 80),
      date: day(c.at),
      preview: c.preview ? c.preview.slice(0, 160) : null,
    }));
}

/** Ein Satz fürs Gedächtnis: eine Zeile, ohne Steuerzeichen, auf die Spaltenlänge. */
function cleanFact(raw: string): string {
  return raw
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_MEMORY_CHARS);
}

export class BoMemoryError extends Error {
  constructor(
    readonly code: "disabled" | "full" | "not_found" | "empty",
    message: string,
  ) {
    super(message);
  }
}

/**
 * Merken — neu oder als Ersatz für einen veralteten Eintrag (`replaceId`).
 *
 * Ein Ersatz behält seine Nummer; Bo verweist damit weiter auf dieselbe Sache.
 * Ein Eintrag mit genau demselben Text wird nicht doppelt angelegt.
 */
export async function rememberFact(
  userId: string,
  rawFact: string,
  replaceId?: number,
): Promise<{ id: number; content: string; replaced: boolean }> {
  const fact = cleanFact(rawFact);
  if (!fact) throw new BoMemoryError("empty", "Nothing to remember");
  return db.transaction(async (tx) => {
    const [u] = await tx
      .select({ enabled: users.boMemoryEnabled })
      .from(users)
      .where(eq(users.id, userId))
      .for("update");
    if (!u?.enabled) throw new BoMemoryError("disabled", "Memory is switched off by the user");
    if (replaceId !== undefined) {
      const [row] = await tx
        .update(boMemories)
        .set({ content: fact, updatedAt: new Date() })
        .where(and(eq(boMemories.id, replaceId), eq(boMemories.userId, userId)))
        .returning({ id: boMemories.id });
      if (!row) throw new BoMemoryError("not_found", `No memory #${replaceId}`);
      return { id: row.id, content: fact, replaced: true };
    }
    const [dupe] = await tx
      .select({ id: boMemories.id })
      .from(boMemories)
      .where(and(eq(boMemories.userId, userId), sql`lower(${boMemories.content}) = lower(${fact})`))
      .limit(1);
    if (dupe) return { id: dupe.id, content: fact, replaced: false };
    const [{ n }] = (await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(boMemories)
      .where(eq(boMemories.userId, userId))) as [{ n: number }];
    if (n >= MAX_MEMORIES_PER_USER) {
      throw new BoMemoryError("full", `Memory is full (${MAX_MEMORIES_PER_USER} entries)`);
    }
    const [row] = await tx
      .insert(boMemories)
      .values({ userId, content: fact })
      .returning({ id: boMemories.id });
    if (!row) throw new Error("Eintrag konnte nicht angelegt werden");
    return { id: row.id, content: fact, replaced: false };
  });
}

/** Vergessen — nur Einträge dieses Kontos. Liefert, was wirklich gelöscht wurde. */
export async function forgetFacts(userId: string, ids: number[]): Promise<{ id: number; content: string }[]> {
  if (ids.length === 0) return [];
  return db
    .delete(boMemories)
    .where(and(eq(boMemories.userId, userId), inArray(boMemories.id, ids)))
    .returning({ id: boMemories.id, content: boMemories.content });
}

// ---------------------------------------------------------------------------
// Verwaltung durch den Nutzer (Profil → Einstellungen → Bo)
// ---------------------------------------------------------------------------

export async function listMemories(userId: string): Promise<{ enabled: boolean; items: BoMemoryItem[] }> {
  const [[u], rows] = await Promise.all([
    db.select({ enabled: users.boMemoryEnabled }).from(users).where(eq(users.id, userId)).limit(1),
    db
      .select({ id: boMemories.id, content: boMemories.content, updatedAt: boMemories.updatedAt })
      .from(boMemories)
      .where(eq(boMemories.userId, userId))
      .orderBy(desc(boMemories.updatedAt), desc(boMemories.id)),
  ]);
  return {
    enabled: u?.enabled ?? true,
    items: rows.map((r) => ({ id: r.id, content: r.content, updatedAt: r.updatedAt.toISOString() })),
  };
}

export async function deleteMemory(userId: string, id: number): Promise<boolean> {
  const rows = await forgetFacts(userId, [id]);
  return rows.length > 0;
}

export async function deleteAllMemories(userId: string): Promise<number> {
  const rows = await db
    .delete(boMemories)
    .where(eq(boMemories.userId, userId))
    .returning({ id: boMemories.id });
  return rows.length;
}

export async function setMemoryEnabled(userId: string, enabled: boolean): Promise<void> {
  await db.update(users).set({ boMemoryEnabled: enabled, updatedAt: new Date() }).where(eq(users.id, userId));
}

// ---------------------------------------------------------------------------
// Frühere Unterhaltungen (Werkzeug `past_chats`)
// ---------------------------------------------------------------------------

/** `%`, `_` und `\` in Suchwörtern wörtlich nehmen — sonst wären sie Platzhalter in ILIKE. */
function likeTerm(term: string): string {
  return `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** Ein Ausschnitt rund um den ersten Treffer, statt der ganzen (womöglich langen) Nachricht. */
function snippetAround(text: string, terms: string[], width = 240): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const lower = flat.toLowerCase();
  let at = -1;
  for (const t of terms) {
    const i = lower.indexOf(t.toLowerCase());
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  if (flat.length <= width) return flat;
  const start = Math.max(0, (at < 0 ? 0 : at) - Math.floor(width / 3));
  const piece = flat.slice(start, start + width);
  return `${start > 0 ? "…" : ""}${piece}${start + width < flat.length ? "…" : ""}`;
}

export interface PastChatHit {
  chat: string;
  title: string;
  date: string;
  from: "user" | "bo";
  snippet: string;
}

/**
 * Stichwortsuche über die TEXTE der eigenen früheren Chats (nicht den laufenden).
 *
 * Erst müssen alle Wörter in einer Nachricht stehen; findet das nichts, reicht
 * eines. Neueste zuerst. Karten und Tafeln (Nutzlasten) bleiben außen vor —
 * worüber gesprochen wurde, steht ohnehin im Text.
 */
export async function searchPastChats(
  userId: string,
  currentConversationId: string | null,
  query: string,
  limit = 8,
): Promise<PastChatHit[]> {
  const terms = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length >= 2)
    .slice(0, 6);
  if (terms.length === 0) return [];
  const scope = currentConversationId
    ? and(eq(chatConversations.userId, userId), ne(chatConversations.id, currentConversationId))
    : eq(chatConversations.userId, userId);
  const run = (mode: "all" | "any") => {
    const conds = terms.map((t) => sql`${chatMessages.content} ILIKE ${likeTerm(t)}`);
    const match = mode === "all" ? and(...conds) : sql.join(conds, sql` OR `);
    return db
      .select({
        conversationId: chatConversations.id,
        title: chatConversations.title,
        role: chatMessages.role,
        content: chatMessages.content,
        at: chatMessages.createdAt,
      })
      .from(chatMessages)
      .innerJoin(chatConversations, eq(chatConversations.id, chatMessages.conversationId))
      .where(and(scope, eq(chatMessages.kind, "text"), sql`(${match})`))
      .orderBy(desc(chatMessages.createdAt))
      .limit(limit);
  };
  let rows = await run("all");
  if (rows.length === 0 && terms.length > 1) rows = await run("any");
  return rows.map((r) => ({
    chat: r.conversationId.slice(0, CHAT_REF_LEN),
    title: (r.title ?? "").slice(0, 80),
    date: day(r.at),
    from: r.role === "user" ? "user" : "bo",
    snippet: snippetAround(r.content ?? "", terms),
  }));
}

/**
 * Ein früherer Chat am Stück — über sein Kürzel aus der Liste oder der Suche.
 *
 * Die letzten `limit` Textnachrichten, jede gekürzt: genug, um „wie letztes
 * Mal" aufzugreifen, ohne einen langen Verlauf komplett in den Prompt zu holen.
 */
export async function readPastChat(
  userId: string,
  currentConversationId: string | null,
  ref: string,
  limit = 16,
): Promise<{ chat: string; title: string; date: string; messages: { from: "user" | "bo"; text: string }[] } | null> {
  const clean = ref.trim().toLowerCase();
  if (!/^[0-9a-f-]{4,36}$/.test(clean)) return null;
  const [conv] = await db
    .select({ id: chatConversations.id, title: chatConversations.title, at: chatConversations.lastMessageAt })
    .from(chatConversations)
    .where(
      and(
        eq(chatConversations.userId, userId),
        sql`${chatConversations.id}::text LIKE ${`${clean}%`}`,
        ...(currentConversationId ? [ne(chatConversations.id, currentConversationId)] : []),
      ),
    )
    .orderBy(desc(chatConversations.lastMessageAt))
    .limit(1);
  if (!conv) return null;
  const rows = await db
    .select({ role: chatMessages.role, content: chatMessages.content })
    .from(chatMessages)
    .where(and(eq(chatMessages.conversationId, conv.id), eq(chatMessages.kind, "text")))
    .orderBy(desc(chatMessages.seq))
    .limit(limit);
  return {
    chat: conv.id.slice(0, CHAT_REF_LEN),
    title: (conv.title ?? "").slice(0, 80),
    date: day(conv.at),
    messages: rows.reverse().map((r) => ({
      from: r.role === "user" ? ("user" as const) : ("bo" as const),
      text: (r.content ?? "").replace(/\s+/g, " ").trim().slice(0, 400),
    })),
  };
}
