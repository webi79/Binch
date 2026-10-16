import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { config } from "../config.js";
import * as schema from "./schema.js";

export const pool = new pg.Pool({
  connectionString: config.DATABASE_URL,
  max: 10,
});

/**
 * Bricht die Datenbank eine RUHENDE Verbindung ab (Neustart, Wartung,
 * Netzaussetzer), meldet der Pool das als `error`-Ereignis. Ohne Zuhörer ist
 * das in Node ein unbehandelter Fehler — der ganze Server stürzte ab, statt die
 * Verbindung zu verwerfen und beim nächsten Mal eine neue aufzubauen.
 */
pool.on("error", (err) => {
  console.warn("[db] ruhende Verbindung verloren:", err.message);
});

export const db = drizzle(pool, { schema });
export type Db = typeof db;
