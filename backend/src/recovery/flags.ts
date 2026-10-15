import { DomainError } from '../common/errors';
import { Queryable } from '../db/db';

export const MONEY_OUT_FROZEN = 'money_out_frozen';
export const DB_FINGERPRINT = 'db_fingerprint';

export async function getFlag(q: Queryable, key: string): Promise<{ value: string; reason: string; set_at: Date } | null> {
  const [r] = await q.query<any>('SELECT value, reason, set_at FROM system_flags WHERE key=$1', [key]);
  return r ?? null;
}

export async function isMoneyOutFrozen(q: Queryable): Promise<boolean> {
  return (await getFlag(q, MONEY_OUT_FROZEN))?.value === 'true';
}

/** Guard for operations that create new external money movement (payouts, refunds). */
export async function assertMoneyOutNotFrozen(q: Queryable): Promise<void> {
  const f = await getFlag(q, MONEY_OUT_FROZEN);
  if (f?.value === 'true') {
    throw new DomainError('MONEY_OUT_FROZEN', 'Outbound money movement is frozen pending post-restore reconciliation', 503);
  }
}

export async function setFlag(q: Queryable, key: string, value: string, reason: string, by: string | null, now: Date) {
  await q.query(
    `INSERT INTO system_flags(key, value, reason, set_by, set_at) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, reason=EXCLUDED.reason, set_by=EXCLUDED.set_by, set_at=EXCLUDED.set_at`,
    [key, value, reason, by, now],
  );
}
