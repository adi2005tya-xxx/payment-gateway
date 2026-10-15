import { execFileSync, spawnSync } from 'child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { join, resolve } from 'path';

/** Locates the PostgreSQL binaries shipped by the `embedded-postgres` dev dependency (or PG_BIN_DIR). */
export function pgBinDir(): string {
  if (process.env.PG_BIN_DIR) return process.env.PG_BIN_DIR;
  const scope = resolve(__dirname, '..', '..', 'node_modules', '@embedded-postgres');
  const pkg = existsSync(scope) ? readdirSync(scope)[0] : undefined;
  if (!pkg) throw new Error('No PostgreSQL binaries found: install embedded-postgres or set PG_BIN_DIR');
  return join(scope, pkg, 'native', 'bin');
}

const exe = (name: string) => join(pgBinDir(), process.platform === 'win32' ? `${name}.exe` : name);
const fwd = (p: string) => p.replace(/\\/g, '/');

export interface ClusterOptions {
  dataDir: string;
  port: number;
  /** Absolute dir where completed WAL segments are archived (enables PITR). */
  archiveDir?: string;
  /** File holding base64(32 bytes): WAL segments are encrypted with it before archiving. */
  walKeyFile?: string;
  extraConf?: string[];
}

/**
 * A disposable PostgreSQL cluster (test/DR drills only: trust auth on 127.0.0.1, random high port).
 * Production recovery uses the managed service's own tooling; this exercises the same physical-backup / WAL-archive mechanics.
 */
export class PgCluster {
  constructor(readonly opts: ClusterOptions) {}

  get url() {
    return `postgres://postgres@127.0.0.1:${this.opts.port}/postgres`;
  }
  urlFor(db: string) {
    return `postgres://postgres@127.0.0.1:${this.opts.port}/${db}`;
  }

  init() {
    mkdirSync(this.opts.dataDir, { recursive: true });
    execFileSync(exe('initdb'), ['-D', this.opts.dataDir, '-U', 'postgres', '--auth=trust', '-E', 'UTF8', '--locale=C'], { stdio: 'pipe' });
    this.writeConf();
  }

  /** (Re)writes tuning/archiving settings. Safe to call on a restored data dir before starting it. */
  writeConf(extra: string[] = []) {
    const lines = [
      '',
      '# --- gateway DR drill settings ---',
      `port = ${this.opts.port}`,
      `listen_addresses = '127.0.0.1'`,
      'wal_level = replica',
      'fsync = on',
      'synchronous_commit = on',
      'max_connections = 100',
    ];
    if (this.opts.archiveDir) {
      if (!this.opts.walKeyFile) throw new Error('walKeyFile is required when archiving (WAL must be encrypted)');
      mkdirSync(this.opts.archiveDir, { recursive: true });
      const script = fwd(resolve(__dirname, 'wal-archive.js'));
      lines.push('archive_mode = on', `archive_command = 'node "${script}" archive "${fwd(this.opts.archiveDir)}" "${fwd(this.opts.walKeyFile)}" "%p" "%f"'`, 'archive_timeout = 60');
    }
    lines.push(...(this.opts.extraConf ?? []), ...extra);
    appendFileSync(join(this.opts.dataDir, 'postgresql.conf'), lines.join('\n') + '\n');
  }

  start(timeoutSec = 120) {
    const log = join(this.opts.dataDir, '..', `${this.opts.port}.log`);
    // stdio must not be piped: the long-lived postgres process would inherit the pipes and spawnSync would never return (Windows).
    const r = spawnSync(exe('pg_ctl'), ['start', '-w', '-t', String(timeoutSec), '-D', this.opts.dataDir, '-l', log], { stdio: 'ignore' });
    if (r.status !== 0) throw new Error(`pg_ctl start failed (exit ${r.status}); see ${log}`);
  }

  /** mode: 'fast' (clean) or 'immediate' (simulated crash: no shutdown checkpoint, WAL replay on next start). */
  stop(mode: 'fast' | 'immediate' = 'fast') {
    spawnSync(exe('pg_ctl'), ['stop', '-w', '-m', mode, '-D', this.opts.dataDir], { stdio: 'ignore' });
  }

  isRunning(): boolean {
    return spawnSync(exe('pg_ctl'), ['status', '-D', this.opts.dataDir], { stdio: 'ignore' }).status === 0;
  }
}


/** restore_command line for recovery from the encrypted archive. */
export function restoreCommand(archiveDir: string, walKeyFile: string): string {
  const script = fwd(resolve(__dirname, 'wal-archive.js'));
  return `restore_command = 'node "${script}" restore "${fwd(archiveDir)}" "${fwd(walKeyFile)}" "%f" "%p"'`;
}
