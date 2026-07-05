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

  set(key: string, value: V): void {
    if (this.map.has(key)) {
      this.map.delete(key);
    } else if (this.map.size >= this.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    this.map.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }
}
