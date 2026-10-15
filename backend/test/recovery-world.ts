import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomBytes } from 'crypto';
import { migrate } from '../src/db/db';
import { PgliteDb } from '../src/db/pglite.db';
import { createPlatform, Platform } from '../src/platform';
import { SandboxProvider } from '../src/provider/sandbox.provider';
import { drillSecurity, seedRepresentativeData, SeedResult } from '../src/recovery/seed';
import { createEncryptedBackup } from '../src/recovery/backup-archive';
import { financialSnapshot, schemaFingerprint, Snapshot } from '../src/recovery/integrity';
import { WEBHOOK_SECRET } from './helpers';

export interface World {
  db: PgliteDb;
  provider: SandboxProvider;
  p: Platform;
  seed: SeedResult;
  security: ReturnType<typeof drillSecurity>;
  work: string;
}

export const newWorkDir = () => mkdtempSync(join(tmpdir(), 'gw-dr-'));
export const cleanup = (dir: string) => rmSync(dir, { recursive: true, force: true });

export async function buildWorld(): Promise<World> {
  const db = await PgliteDb.open();
  await migrate(db);
  const provider = new SandboxProvider(WEBHOOK_SECRET);
  const security = drillSecurity();
  const p = createPlatform(db, provider, security);
  const seed = await seedRepresentativeData(p, provider);
  return { db, provider, p, seed, security, work: newWorkDir() };
}

/** Takes a physical backup of the PGlite data dir, encrypts it and returns the snapshot taken at the same instant. */
export async function backupWorld(w: World, key: Buffer, label = 'test-backup') {
  const snapshot: Snapshot = await financialSnapshot(w.db);
  const dump = await w.db.dumpDataDir();
  const src = join(w.work, 'src-' + randomBytes(3).toString('hex'));
  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, 'pgdata.tar.gz'), dump);
  const out = join(w.work, `${label}-${randomBytes(3).toString('hex')}.gwbk`);
  const sidecar = createEncryptedBackup({ sourceDir: src, outFile: out, key, label });
  return { file: out, sidecar, snapshot, dump };
}

export async function freshSchemaDigest(): Promise<string> {
  const db = await PgliteDb.open();
  await migrate(db);
  const d = (await schemaFingerprint(db)).digest;
  await db.close();
  return d;
}
