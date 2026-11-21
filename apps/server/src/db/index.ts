import { mkdirSync } from "node:fs";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { config } from "../config";
import * as schema from "./schema";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type DB = PgDatabase<any, typeof schema>;

/**
 * Postgres when DATABASE_URL is set (VPS / homelab), otherwise embedded PGlite on disk —
 * same SQL, same code, no setup for local dev. `memory: true` is used by tests.
 */
export async function openDb(opts: { memory?: boolean } = {}): Promise<DB> {
  if (config.databaseUrl && !opts.memory) {
    const { Pool } = await import("pg");
    const { drizzle } = await import("drizzle-orm/node-postgres");
    const pool = new Pool({ connectionString: config.databaseUrl });
    await pool.query(schema.bootstrapSql);
    return drizzle(pool, { schema }) as unknown as DB;
  }
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  let client;
  if (opts.memory) client = new PGlite();
  else {
    mkdirSync(config.dataDir, { recursive: true });
    client = new PGlite(`${config.dataDir}/pg`);
  }
  await client.exec(schema.bootstrapSql);
  return drizzle(client, { schema }) as unknown as DB;
}
