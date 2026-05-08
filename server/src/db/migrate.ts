import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db, pool } from "./client.js";

async function main() {
  await migrate(db, { migrationsFolder: "./src/db/migrations" });
  await pool.end();
  // eslint-disable-next-line no-console
  console.log("Migrations applied.");
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e);
  process.exit(1);
});
