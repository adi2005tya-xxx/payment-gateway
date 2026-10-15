import { Pool, types } from 'pg';
import { Db, Queryable } from './db';

/** Production driver: node-postgres against a managed PostgreSQL. */
export class PgDb implements Db {
  private readonly pool: Pool;

  constructor(connectionString: string) {
    types.setTypeParser(20, (v) => Number(v));
    this.pool = new Pool({ connectionString, max: 10, connectionTimeoutMillis: 10_000 });
    // A database restart/crash makes idle pooled connections emit 'error'. Unhandled, that kills the whole process;
    // handled, the pool simply discards the broken client and later queries reconnect (and the failed unit of work is retried by the job queue).
    this.pool.on('error', (e) => console.warn('database pool error (connection discarded):', e.message));
  }

  async query<T = any>(sql: string, params: unknown[] = []): Promise<T[]> {
    return (await this.pool.query(sql, params as any[])).rows as T[];
  }

  async exec(sql: string): Promise<void> {
    await this.pool.query(sql);
  }

  async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    const swallow = () => undefined; // errors surface through the failing query's rejection; they must not crash the process
    client.on('error', swallow);
    try {
      await client.query('BEGIN');
      const out = await fn({ query: async (sql, params = []) => (await client.query(sql, params as any[])).rows });
      await client.query('COMMIT');
      return out;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      client.off('error', swallow);
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
