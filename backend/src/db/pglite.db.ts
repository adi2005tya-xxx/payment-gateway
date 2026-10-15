import { PGlite } from '@electric-sql/pglite';
import { Db, Queryable } from './db';

/** In-process PostgreSQL (WASM). Real Postgres semantics; used for the sandbox and tests. */
export class PgliteDb implements Db {
  private constructor(private readonly pg: PGlite) {}

  static async open(dataDir?: string): Promise<PgliteDb> {
    // int8 -> JS number (amounts stay far below 2^53 paise).
    const pg = new PGlite(dataDir, { parsers: { 20: (v: string) => Number(v) } });
    await pg.waitReady;
    return new PgliteDb(pg);
  }

  /** Opens a database from a gzip tarball produced by dumpDataDir() (restore into a fresh, empty instance). */
  static async openFromDump(dump: Buffer): Promise<PgliteDb> {
    const pg = new PGlite({ loadDataDir: new Blob([new Uint8Array(dump)]), parsers: { 20: (v: string) => Number(v) } });
    await pg.waitReady;
    return new PgliteDb(pg);
  }

  /** Physical snapshot of the whole data directory (call while no transaction is open). */
  async dumpDataDir(): Promise<Buffer> {
    const f = await this.pg.dumpDataDir('gzip');
    return Buffer.from(await f.arrayBuffer());
  }

  async query<T = any>(sql: string, params: unknown[] = []): Promise<T[]> {
    return (await this.pg.query<T>(sql, params)).rows;
  }

  async exec(sql: string): Promise<void> {
    await this.pg.exec(sql);
  }

  async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
    return this.pg.transaction(async (t) => fn({ query: async (sql, params = []) => (await t.query<any>(sql, params)).rows }));
  }

  async close(): Promise<void> {
    await this.pg.close();
  }
}
