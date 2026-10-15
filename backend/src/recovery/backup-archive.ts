import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';
import { closeSync, cpSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from 'fs';
import { dirname, join, relative, resolve, sep } from 'path';

/**
 * Encrypted, integrity-checked backup container (single file).
 *   file    = "GWBK1" | iv(12) | AES-256-GCM( entries... , manifest ) | tag(16)
 *   entry   = pathLen u32 | path utf8 | size u64 | bytes
 * The manifest (last entry) lists every file with size + SHA-256. A sidecar `<file>.manifest.json` carries the SHA-256 of the
 * ENCRYPTED file so integrity can be checked without the key; the GCM tag authenticates the content with it.
 * Nothing is written into the restore target until decryption, tag check and per-file hashes have all passed.
 */
const MAGIC = Buffer.from('GWBK1');
const CHUNK = 1 << 20;

export interface ManifestEntry {
  path: string;
  size: number;
  sha256: string;
}
export interface Manifest {
  version: 1;
  label: string;
  createdAt: string;
  files: ManifestEntry[];
  /** Every directory (including empty ones: PostgreSQL will not start without pg_notify, pg_wal, ...). */
  dirs?: string[];
  meta: Record<string, unknown>;
}
export interface Sidecar {
  file: string;
  encryptedSha256: string;
  encryptedBytes: number;
  keyId: string;
  label: string;
  createdAt: string;
  files: number;
}

export const keyIdOf = (key: Buffer) => createHash('sha256').update(key).update('backup-key-id').digest('hex').slice(0, 8);

function listTree(root: string, skip: (rel: string) => boolean): { files: string[]; dirs: string[] } {
  const files: string[] = [];
  const dirs: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      const rel = relative(root, full).split(sep).join('/');
      if (skip(rel)) continue;
      const st = statSync(full);
      if (st.isDirectory()) {
        dirs.push(rel);
        walk(full);
      } else if (st.isFile()) files.push(rel);
    }
  };
  walk(root);
  return { files, dirs };
}

export function sha256File(file: string): string {
  const h = createHash('sha256');
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.alloc(CHUNK);
    for (let n; (n = readSync(fd, buf, 0, CHUNK, null)) > 0; ) h.update(buf.subarray(0, n));
  } finally {
    closeSync(fd);
  }
  return h.digest('hex');
}

export function createEncryptedBackup(opts: {
  sourceDir: string;
  outFile: string;
  key: Buffer;
  label: string;
  meta?: Record<string, unknown>;
  skip?: (rel: string) => boolean;
}): Sidecar {
  if (opts.key.length !== 32) throw new Error('backup key must be 32 bytes');
  if (existsSync(opts.outFile)) throw new Error('refusing to overwrite an existing backup file');
  mkdirSync(dirname(opts.outFile), { recursive: true });
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', opts.key, iv);
  const tmp = opts.outFile + '.partial';
  const fd = openSync(tmp, 'wx', 0o600);
  const put = (b: Buffer) => {
    const enc = cipher.update(b);
    if (enc.length) writeSync(fd, enc);
  };
  writeSync(fd, MAGIC);
  writeSync(fd, iv);
  const files: ManifestEntry[] = [];
  const entryHeader = (path: string, size: number) => {
    const p = Buffer.from(path, 'utf8');
    const h = Buffer.alloc(4 + p.length + 8);
    h.writeUInt32BE(p.length, 0);
    p.copy(h, 4);
    h.writeBigUInt64BE(BigInt(size), 4 + p.length);
    return h;
  };
  try {
    const tree = listTree(opts.sourceDir, opts.skip ?? (() => false));
    for (const rel of tree.files) {
      const full = join(opts.sourceDir, rel);
      const size = statSync(full).size;
      put(entryHeader(rel, size));
      const h = createHash('sha256');
      const rfd = openSync(full, 'r');
      let read = 0;
      try {
        const buf = Buffer.alloc(CHUNK);
        for (let n; read < size && (n = readSync(rfd, buf, 0, Math.min(CHUNK, size - read), null)) > 0; read += n) {
          const piece = buf.subarray(0, n);
          h.update(piece);
          put(Buffer.from(piece));
        }
      } finally {
        closeSync(rfd);
      }
      if (read !== size) throw new Error(`file changed while backing up: ${rel}`);
      files.push({ path: rel, size, sha256: h.digest('hex') });
    }
    const manifest: Manifest = { version: 1, label: opts.label, createdAt: new Date().toISOString(), files, dirs: tree.dirs, meta: opts.meta ?? {} };
    const mb = Buffer.from(JSON.stringify(manifest));
    put(entryHeader('.manifest.json', mb.length));
    put(mb);
    const last = cipher.final();
    if (last.length) writeSync(fd, last);
    writeSync(fd, cipher.getAuthTag());
  } catch (e) {
    closeSync(fd);
    rmSync(tmp, { force: true });
    throw e;
  }
  closeSync(fd);
  renameSync(tmp, opts.outFile);
  const sidecar: Sidecar = {
    file: opts.outFile,
    encryptedSha256: sha256File(opts.outFile),
    encryptedBytes: statSync(opts.outFile).size,
    keyId: keyIdOf(opts.key),
    label: opts.label,
    createdAt: new Date().toISOString(),
    files: files.length,
  };
  writeFileSync(opts.outFile + '.manifest.json', JSON.stringify(sidecar, null, 2), { mode: 0o600 });
  return sidecar;
}

/** Key-less check: file present, complete, and matches the SHA-256 recorded at backup time. */
export function verifyBackupChecksum(file: string): { ok: boolean; reason?: string } {
  const side = file + '.manifest.json';
  if (!existsSync(file)) return { ok: false, reason: 'backup file missing' };
  if (!existsSync(side)) return { ok: false, reason: 'sidecar manifest missing' };
  const s: Sidecar = JSON.parse(readFileSync(side, 'utf8'));
  if (statSync(file).size !== s.encryptedBytes) return { ok: false, reason: `size mismatch: ${statSync(file).size} != ${s.encryptedBytes} (truncated or incomplete)` };
  if (sha256File(file) !== s.encryptedSha256) return { ok: false, reason: 'SHA-256 mismatch (corrupted or tampered)' };
  return { ok: true };
}

function decryptToTemp(file: string, key: Buffer, tmpPlain: string) {
  const total = statSync(file).size;
  if (total < MAGIC.length + 12 + 16) throw new Error('backup too small to be valid');
  const fd = openSync(file, 'r');
  try {
    const head = Buffer.alloc(MAGIC.length + 12);
    readSync(fd, head, 0, head.length, 0);
    if (!head.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('not a gateway backup (bad magic)');
    const tag = Buffer.alloc(16);
    readSync(fd, tag, 0, 16, total - 16);
    const d = createDecipheriv('aes-256-gcm', key, head.subarray(MAGIC.length));
    d.setAuthTag(tag);
    const out = openSync(tmpPlain, 'wx', 0o600);
    try {
      let pos = head.length;
      const end = total - 16;
      const buf = Buffer.alloc(CHUNK);
      while (pos < end) {
        const n = readSync(fd, buf, 0, Math.min(CHUNK, end - pos), pos);
        if (n <= 0) break;
        pos += n;
        const dec = d.update(buf.subarray(0, n));
        if (dec.length) writeSync(out, dec);
      }
      const fin = d.final(); // throws if the authentication tag does not match (wrong key, corruption, tampering)
      if (fin.length) writeSync(out, fin);
    } finally {
      closeSync(out);
    }
  } finally {
    closeSync(fd);
  }
}

/** Parses the decrypted stream; `emit` is called per entry. Throws on any structural problem. */
function parseEntries(plain: string, emit: (path: string, size: number, readInto: (dest: number | null) => string) => void) {
  const fd = openSync(plain, 'r');
  try {
    const total = statSync(plain).size;
    let pos = 0;
    const read = (n: number) => {
      const b = Buffer.alloc(n);
      if (n > 0 && readSync(fd, b, 0, n, pos) !== n) throw new Error('truncated archive stream');
      pos += n;
      return b;
    };
    while (pos < total) {
      const plen = read(4).readUInt32BE(0);
      if (plen === 0 || plen > 4096) throw new Error('corrupt entry header');
      const path = read(plen).toString('utf8');
      const size = Number(read(8).readBigUInt64BE(0));
      emit(path, size, (dest) => {
        const h = createHash('sha256');
        const buf = Buffer.alloc(CHUNK);
        let left = size;
        while (left > 0) {
          const n = readSync(fd, buf, 0, Math.min(CHUNK, left), pos);
          if (n <= 0) throw new Error('truncated archive stream');
          pos += n;
          left -= n;
          h.update(buf.subarray(0, n));
          if (dest !== null) writeSync(dest, buf, 0, n);
        }
        return h.digest('hex');
      });
    }
  } finally {
    closeSync(fd);
  }
}

function readManifest(plain: string): Manifest {
  let manifest: Manifest | undefined;
  const total = statSync(plain).size;
  const rfd = openSync(plain, 'r');
  try {
    let pos = 0;
    const rd = (n: number) => {
      const b = Buffer.alloc(n);
      if (readSync(rfd, b, 0, n, pos) !== n) throw new Error('truncated archive stream');
      pos += n;
      return b;
    };
    while (pos < total) {
      const plen = rd(4).readUInt32BE(0);
      const path = rd(plen).toString('utf8');
      const size = Number(rd(8).readBigUInt64BE(0));
      if (path === '.manifest.json') manifest = JSON.parse(rd(size).toString('utf8'));
      else pos += size;
    }
  } finally {
    closeSync(rfd);
  }
  if (!manifest) throw new Error('backup has no manifest (incomplete backup)');
  return manifest;
}

/**
 * Decrypts, authenticates and verifies every file against the manifest, then extracts into `targetDir`.
 * Refuses a non-empty target (a restore must never be laid over existing data). Returns the manifest.
 */
export function restoreEncryptedBackup(file: string, key: Buffer, targetDir: string, opts: { scratchDir?: string } = {}): Manifest {
  const chk = verifyBackupChecksum(file);
  if (!chk.ok) throw new Error(`backup failed integrity check: ${chk.reason}`);
  if (existsSync(targetDir) && readdirSync(targetDir).length > 0) throw new Error(`refusing to restore into non-empty directory ${targetDir}`);
  const scratch = opts.scratchDir ?? dirname(targetDir);
  mkdirSync(scratch, { recursive: true });
  const tmpPlain = join(scratch, `.restore-${randomBytes(6).toString('hex')}.plain`);
  const staging = targetDir + `.staging-${randomBytes(4).toString('hex')}`;
  try {
    decryptToTemp(file, key, tmpPlain);
    const manifest = readManifest(tmpPlain);
    const expected = new Map(manifest.files.map((f) => [f.path, f]));
    mkdirSync(staging, { recursive: true });
    const seen = new Set<string>();
    parseEntries(tmpPlain, (path, size, readInto) => {
      if (path === '.manifest.json') {
        readInto(null);
        return;
      }
      const full = resolve(staging, path);
      if (path.startsWith('/') || path.includes('..') || !full.startsWith(resolve(staging) + sep)) throw new Error(`unsafe path in backup: ${path}`);
      mkdirSync(dirname(full), { recursive: true });
      const out = openSync(full, 'wx');
      let digest: string;
      try {
        digest = readInto(out);
      } finally {
        closeSync(out);
      }
      const want = expected.get(path);
      if (!want || want.size !== size || want.sha256 !== digest) throw new Error(`file failed manifest verification: ${path}`);
      seen.add(path);
    });
    for (const d of manifest.dirs ?? []) {
      const full = resolve(staging, d);
      if (d.startsWith('/') || d.includes('..') || !full.startsWith(resolve(staging) + sep)) throw new Error(`unsafe directory in backup: ${d}`);
      mkdirSync(full, { recursive: true });
    }
    const missing = manifest.files.filter((f) => !seen.has(f.path));
    if (missing.length) throw new Error(`backup is missing ${missing.length} file(s), e.g. ${missing[0].path}`);
    if (existsSync(targetDir)) rmSync(targetDir, { recursive: true });
    moveDir(staging, targetDir);
    return manifest;
  } catch (e) {
    rmSync(staging, { recursive: true, force: true });
    throw e;
  } finally {
    rmSync(tmpPlain, { force: true });
  }
}

/** rename() of a freshly written directory can fail on Windows (EPERM/EBUSY) while antivirus/indexers hold handles; retry, then copy. */
function moveDir(from: string, to: string) {
  for (let i = 0; i < 20; i++) {
    try {
      renameSync(from, to);
      return;
    } catch (e: any) {
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
    }
  }
  cpSync(from, to, { recursive: true });
  rmSync(from, { recursive: true, force: true });
}
