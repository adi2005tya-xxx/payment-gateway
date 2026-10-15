// Used by PostgreSQL as archive_command / restore_command in DR drills. WAL segments contain plaintext financial data,
// so they are encrypted (AES-256-GCM, segment name as AAD so segments cannot be swapped) before they leave the primary.
//   archive: node wal-archive.js archive <archiveDir> <keyFile> <%p> <%f>   -> <archiveDir>/<%f>.enc ; never overwrites a different segment
//   restore: node wal-archive.js restore <archiveDir> <keyFile> <%f> <%p>   -> decrypt+authenticate; exit 1 if absent or tampered
// Plain CommonJS on purpose: it runs outside the TypeScript build. The key file holds base64 of 32 bytes (mode 0600).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const [mode, dir, keyFile, a, b] = process.argv.slice(2);
const key = Buffer.from(fs.readFileSync(keyFile, 'utf8').trim(), 'base64');
if (key.length !== 32) {
  console.error('bad WAL key');
  process.exit(2);
}

function seal(buf, name) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from(name));
  const ct = Buffer.concat([c.update(buf), c.final()]);
  return Buffer.concat([Buffer.from('GWWAL1'), iv, ct, c.getAuthTag()]);
}
function open(buf, name) {
  if (buf.subarray(0, 6).toString() !== 'GWWAL1') throw new Error('bad magic');
  const iv = buf.subarray(6, 18);
  const tag = buf.subarray(buf.length - 16);
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
  d.setAAD(Buffer.from(name));
  d.setAuthTag(tag);
  return Buffer.concat([d.update(buf.subarray(18, buf.length - 16)), d.final()]);
}

try {
  if (mode === 'archive') {
    const plain = fs.readFileSync(a);
    const dest = path.join(dir, b + '.enc');
    if (fs.existsSync(dest)) {
      // Idempotent retry of the same segment is fine; a different segment under the same name is refused.
      try {
        if (open(fs.readFileSync(dest), b).equals(plain)) process.exit(0);
      } catch (_) {}
      console.error('refusing to overwrite differing archived segment ' + b);
      process.exit(1);
    }
    const tmp = dest + '.tmp';
    fs.writeFileSync(tmp, seal(plain, b), { mode: 0o600 });
    fs.renameSync(tmp, dest); // atomic publish
    process.exit(0);
  }
  if (mode === 'restore') {
    const src = path.join(dir, a + '.enc');
    if (!fs.existsSync(src)) process.exit(1);
    fs.writeFileSync(b, open(fs.readFileSync(src), a));
    process.exit(0);
  }
  console.error('unknown mode');
  process.exit(2);
} catch (e) {
  console.error(String(e && e.message));
  process.exit(1);
}
