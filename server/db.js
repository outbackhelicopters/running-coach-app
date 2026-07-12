/* ============================================================
   DATABASE LAYER
   Postgres via the `pg` module. Athlete records are stored mostly
   as a JSONB blob (matching the shape the frontend already expects)
   plus a handful of indexed columns (id, name, email, stage,
   password_hash) kept in sync on every write. This keeps the huge
   existing frontend rendering code working almost unchanged — it
   already treats an "athlete" as one flexible object.
   ============================================================ */
function createPool() {
  // Test-only hook: an in-memory pg-compatible engine (pg-mem) so the API
  // logic can be exercised without a real Postgres server available. Never
  // set in production — see server/index.js / .env.example.
  if (process.env.PG_MEM === "1") {
    const { newDb } = require("pg-mem");
    const mem = newDb({ autoCreateForeignKeyIndices: true });
    mem.public.registerFunction({
      name: "gen_random_uuid",
      returns: "text",
      implementation: () => require("crypto").randomUUID(),
    });
    const adapter = mem.adapters.createPg();
    return new adapter.Pool();
  }

  const { Pool } = require("pg");
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL environment variable is not set.");
  }
  // DigitalOcean's managed Postgres requires SSL but uses a certificate
  // that isn't in Node's default trust store unless you download it —
  // rejectUnauthorized:false keeps the connection encrypted without
  // requiring that extra setup step, which is a normal trade-off for
  // an app at this scale.
  const useSSL = process.env.DATABASE_SSL !== "false";
  return new Pool({
    connectionString,
    ssl: useSSL ? { rejectUnauthorized: false } : false,
  });
}

async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS coach (
      id INTEGER PRIMARY KEY DEFAULT 1,
      email TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT single_coach CHECK (id = 1)
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS athletes (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      email TEXT NOT NULL DEFAULT '',
      stage INTEGER NOT NULL DEFAULT 0,
      password_hash TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      data JSONB NOT NULL DEFAULT '{}'::jsonb
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS athletes_email_idx ON athletes ((lower(email)));`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS resources (
      id TEXT PRIMARY KEY,
      category TEXT NOT NULL DEFAULT 'Other',
      title TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      link TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

function rowToAthlete(row) {
  if (!row) return null;
  const data = row.data || {};
  return Object.assign({}, data, {
    id: row.id,
    name: row.name,
    email: row.email,
    stage: row.stage,
    hasLogin: !!row.password_hash,
  });
}

module.exports = { createPool, migrate, rowToAthlete };
