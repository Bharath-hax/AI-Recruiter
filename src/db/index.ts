import fs from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle as drizzleNodePg, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { drizzle as drizzlePglite, type PgliteDatabase } from 'drizzle-orm/pglite';
import { Pool } from 'pg';
import { RECRUITER_SCHEMA_DDL } from './bootstrapSql.ts';
import * as schema from './schema.ts';

type PlatformDrizzleDb = NodePgDatabase<typeof schema> | PgliteDatabase<typeof schema>;

declare global {
  var _postgresPool: Pool | undefined;
  var _pgliteClient: PGlite | undefined;
  var _drizzleDbInstance: PlatformDrizzleDb | undefined;
  var _schemaBootstrappedPromise: Promise<void> | undefined;
}

function canUseCloudSqlSocketOrTcp(): boolean {
  if (process.env.REC_TEST_IN_MEMORY_DB === '1') {
    return false;
  }
  const sqlHost = process.env.SQL_HOST;
  if (!sqlHost || !process.env.SQL_USER || !process.env.SQL_DB_NAME) {
    return false;
  }
  if (sqlHost.startsWith('/')) {
    return fs.existsSync(sqlHost);
  }
  return true;
}

export const createPool = (): Pool => {
  if (!global._postgresPool) {
    global._postgresPool = new Pool({
      host: process.env.SQL_HOST,
      user: process.env.SQL_USER,
      password: process.env.SQL_PASSWORD,
      database: process.env.SQL_DB_NAME,
      max: 10,
      connectionTimeoutMillis: 15000,
    });

    global._postgresPool.on('error', (err) => {
      console.error('Unexpected error on idle SQL pool client:', err);
    });
  }
  return global._postgresPool;
};

function switchToLocalPglite(): PlatformDrizzleDb {
  const dataDir =
    process.env.REC_TEST_IN_MEMORY_DB === '1'
      ? 'memory://'
      : path.resolve(process.cwd(), '.local-pgdata');
  global._pgliteClient = new PGlite(dataDir);
  global._drizzleDbInstance = drizzlePglite(global._pgliteClient, { schema });
  return global._drizzleDbInstance;
}

function getOrCreateDatabaseInstance(): PlatformDrizzleDb {
  if (global._drizzleDbInstance) {
    return global._drizzleDbInstance;
  }

  if (canUseCloudSqlSocketOrTcp()) {
    const pool = createPool();
    global._drizzleDbInstance = drizzleNodePg(pool, { schema });
    return global._drizzleDbInstance;
  }

  return switchToLocalPglite();
}

export const db = new Proxy({} as NodePgDatabase<typeof schema>, {
  get(_target, prop) {
    const instance = getOrCreateDatabaseInstance() as unknown as Record<
      string | symbol,
      unknown
    >;
    const val = instance[prop];
    return typeof val === 'function' ? val.bind(instance) : val;
  },
});

export async function ensureDatabaseReady(): Promise<void> {
  if (global._schemaBootstrappedPromise) {
    return global._schemaBootstrappedPromise;
  }

  global._schemaBootstrappedPromise = (async () => {
    getOrCreateDatabaseInstance();

    if (global._postgresPool && !global._pgliteClient) {
      try {
        await global._postgresPool.query(RECRUITER_SCHEMA_DDL);
        return;
      } catch (err) {
        console.warn(
          'Cloud SQL connection unavailable; falling back to embedded PostgreSQL 16 (PGlite):',
          err instanceof Error ? err.message : err
        );
        switchToLocalPglite();
      }
    }

    if (global._pgliteClient) {
      await global._pgliteClient.exec(RECRUITER_SCHEMA_DDL);
    }
  })();

  return global._schemaBootstrappedPromise;
}
