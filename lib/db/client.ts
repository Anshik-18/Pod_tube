import { Pool, PoolConfig } from 'pg';

let pool: Pool | null = null;

export function getDbPool(): Pool {
  if (!pool) {
    // Prefer DATABASE_URL if set, otherwise use individual variables
    const connectionString = process.env.DATABASE_URL;
    
    let config: PoolConfig;

    if (connectionString) {
      // Use connection string
      config = {
        connectionString,
      };
    } else {
      // Build config from individual variables
      const dbHost = process.env.DB_HOST;
      const dbPort = process.env.DB_PORT ? parseInt(process.env.DB_PORT, 10) : 5432;
      const dbName = process.env.DB_NAME;
      const dbUser = process.env.DB_USER;
      const dbPassword = process.env.DB_PASSWORD;

      if (!dbHost || !dbName || !dbUser || !dbPassword) {
        throw new Error('Database configuration incomplete. Set DATABASE_URL or all DB_* variables.');
      }

      config = {
        host: dbHost,
        port: dbPort,
        database: dbName,
        user: dbUser,
        password: dbPassword,
      };
    }

    // SSL follows the standard `sslmode` in DATABASE_URL (or DB_SSL_MODE, which wins):
    //   require / prefer / no-verify  -> encrypted, certificate not verified (Neon, most hosts)
    //   verify-full / verify-ca       -> encrypted and verified
    //   disable / not set             -> plain (a database on the same private network, e.g. Coolify)
    let sslMode = process.env.DB_SSL_MODE?.toLowerCase();
    if (config.connectionString) {
      try {
        const url = new URL(config.connectionString);
        sslMode = sslMode ?? url.searchParams.get('sslmode')?.toLowerCase() ?? undefined;
        // pg would otherwise re-parse sslmode itself and override the choice below.
        url.searchParams.delete('sslmode');
        url.searchParams.delete('sslrootcert');
        config.connectionString = url.toString();
      } catch {
        // Not a URL (e.g. key=value form): leave it to pg.
      }
    }
    if (sslMode === 'verify-full' || sslMode === 'verify-ca') {
      config.ssl = { rejectUnauthorized: true };
    } else if (sslMode === 'require' || sslMode === 'prefer' || sslMode === 'no-verify') {
      config.ssl = { rejectUnauthorized: false };
    } else {
      config.ssl = false;
    }

    // Set pool size if specified
    if (process.env.DB_POOL_SIZE) {
      config.max = parseInt(process.env.DB_POOL_SIZE, 10);
    }

    pool = new Pool(config);
  }

  return pool;
}

export async function closeDbPool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
