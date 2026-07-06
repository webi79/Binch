/**
 * Kleiner In-Memory-Cache mit LRU-Verdrängung + TTL.
 *
 * Für Caches, deren Keyspace von User-Input abhängt (Stations-Queries,
 * Resolve-Koordinaten): ohne Cap wachsen die Maps über die Prozess-Laufzeit
 * unbegrenzt (langsames Memory-Leak), und ohne TTL bleiben veraltete Werte
 * (z.B. ungültig gewordene HAFAS-IDs) für immer falsch.
 */
export class BoundedTtlCache<V> {
  private map = new Map<string, { value: V; expiresAt: number }>();

  constructor(
    private readonly maxEntries: number,
    private readonly ttlMs: number,
  ) {}

  get(key: string): V | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.map.delete(key);
      return undefined;
    }
    // LRU-Touch: Re-Insert schiebt den Key ans Ende der Insertion-Order.
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  /**
   * @param ttlMs optionaler Per-Eintrag-TTL (überschreibt den Default). Nutzen
   *   z.B. für negative Ergebnisse, die kürzer leben sollen als positive —
   *   damit ein vorübergehender Upstream-Ausfall den Cache nicht für die volle
   *   Default-TTL vergiftet.
   */
  set(key: string, value: V, ttlMs?: number): void {
    if (this.map.has(key)) {
      this.map.delete(key);
    } else if (this.map.size >= this.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    this.map.set(key, { value, expiresAt: Date.now() + (ttlMs ?? this.ttlMs) });
  }
}
