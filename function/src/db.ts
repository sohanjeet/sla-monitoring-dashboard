import { Pool, type PoolConfig } from 'pg'

let pool: Pool | undefined

/**
 * Creates a small, reusable connection pool for a warm serverless instance.
 * Importing the HTTP handler must not require a database connection: that
 * keeps cold starts and request validation independent of configuration.
 */
export function getPool(): Pool {
  if (pool) return pool

  const connectionString = process.env.DATABASE_URL
  if (!connectionString) {
    throw new Error('DATABASE_URL must be set to connect to PostgreSQL.')
  }
  if ((process.env.DATABASE_SSL ?? 'require') !== 'require') {
    throw new Error('DATABASE_SSL must be "require" for Neon PostgreSQL.')
  }

  const config: PoolConfig = {
    connectionString,
    // A Lambda execution environment only needs a very small reusable pool.
    // Keeping this low avoids exhausting Neon connections across cold starts.
    max: 2,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 5_000,
  }

  // Neon presents a publicly trusted certificate. Never disable certificate
  // verification for the database connection.
  config.ssl = { rejectUnauthorized: true }

  pool = new Pool(config)
  return pool
}
