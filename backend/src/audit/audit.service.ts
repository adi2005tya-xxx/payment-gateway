import { createHash } from 'crypto';
import { Queryable } from '../db/db';

export interface Actor {
  id: string | null;
  role: string;
  merchantId?: string | null;
}

/** Deterministic JSON (sorted keys): jsonb storage does not preserve key order. Undefined fields are dropped, as JSON storage drops them. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v as object).filter((k) => (v as any)[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as any)[k])}`).join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

export const SYSTEM_ACTOR: Actor = { id: null, role: 'SYSTEM' };

/** Append-only, hash-chained audit trail. Never log secrets or full account numbers in `detail`. */
export class AuditService {
  async record(tx: Queryable, actor: Actor, action: string, subjectType: string, subjectId: string, detail: Record<string, unknown> = {}) {
    // Serialise appends so the chain cannot fork.
    await tx.query('SELECT pg_advisory_xact_lock(7001)');
    const prev = await tx.query<{ hash: string }>('SELECT hash FROM audit_logs ORDER BY id DESC LIMIT 1');
    const prevHash = prev[0]?.hash ?? 'GENESIS';
    const body = canonical({ actor: actor.id, role: actor.role, action, subjectType, subjectId, detail, prevHash });
    const hash = createHash('sha256').update(body).digest('hex');
    await tx.query(
      `INSERT INTO audit_logs(actor_id, actor_role, action, subject_type, subject_id, detail, prev_hash, hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [actor.id, actor.role, action, subjectType, subjectId, JSON.stringify(detail), prevHash, hash],
    );
  }

  async verifyChain(tx: Queryable): Promise<boolean> {
    const rows = await tx.query<any>('SELECT * FROM audit_logs ORDER BY id');
    let prev = 'GENESIS';
    for (const r of rows) {
      if (r.prev_hash !== prev) return false;
      const body = canonical({
        actor: r.actor_id,
        role: r.actor_role,
        action: r.action,
        subjectType: r.subject_type,
        subjectId: r.subject_id,
        detail: r.detail,
        prevHash: r.prev_hash,
      });
      if (createHash('sha256').update(body).digest('hex') !== r.hash) return false;
      prev = r.hash;
    }
    return true;
  }
}
