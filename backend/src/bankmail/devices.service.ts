import { createHash, randomBytes } from 'crypto';
import { DomainError } from '../common/errors';
import { Db } from '../db/db';
import { Actor, AuditService } from '../audit/audit.service';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

/**
 * Forwarding devices (a phone running a notification-forwarding app). Each has a bearer token, shown ONCE at creation; only its
 * SHA-256 is stored (the token is 256 bits of randomness, so a fast hash is appropriate). A revoked device stops working at once.
 */
export class DevicesService {
  constructor(private readonly db: Db, private readonly audit: AuditService) {}

  async create(actor: Actor, name: string) {
    if (!/^[A-Za-z0-9 ._-]{2,60}$/.test(name)) throw new DomainError('INVALID_NAME', 'Use 2-60 letters, digits, spaces, dots, dashes');
    const token = 'gwd_' + randomBytes(32).toString('base64url');
    return this.db.transaction(async (tx) => {
      const dup = await tx.query('SELECT 1 FROM ingest_devices WHERE name=$1', [name]);
      if (dup.length) throw new DomainError('DEVICE_EXISTS', 'A device with this name already exists', 409);
      const [d] = await tx.query<any>('INSERT INTO ingest_devices(name, token_hash, created_by) VALUES ($1,$2,$3) RETURNING id', [name, sha(token), actor.id]);
      await this.audit.record(tx, actor, 'device.created', 'ingest_device', d.id, { name });
      return { id: d.id as string, name, token }; // the token is returned only here
    });
  }

  list() {
    return this.db.query('SELECT id, name, status, last_seen_at, created_at, revoked_at FROM ingest_devices ORDER BY created_at DESC');
  }

  async revoke(actor: Actor, id: string) {
    await this.db.transaction(async (tx) => {
      const rows = await tx.query(`UPDATE ingest_devices SET status='REVOKED', revoked_at=now() WHERE id=$1 AND status='ACTIVE' RETURNING id`, [id]);
      if (!rows.length) throw new DomainError('NOT_FOUND', 'Active device not found', 404);
      await this.audit.record(tx, actor, 'device.revoked', 'ingest_device', id);
    });
  }

  /** Returns the device for a valid, active token, else null. The lookup is by hash of the token. */
  async authenticate(token: string | undefined): Promise<{ id: string; name: string } | null> {
    if (!token || token.length < 20 || token.length > 200) return null;
    const [d] = await this.db.query<any>(`SELECT id, name FROM ingest_devices WHERE token_hash=$1 AND status='ACTIVE'`, [sha(token)]);
    if (!d) return null;
    await this.db.query('UPDATE ingest_devices SET last_seen_at=now() WHERE id=$1', [d.id]);
    return d;
  }
}
