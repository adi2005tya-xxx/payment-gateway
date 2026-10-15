import { Queryable } from '../db/db';
import { DomainError } from '../common/errors';

export type Direction = 'D' | 'C';
export interface Line {
  account: string;
  dir: Direction;
  amountMinor: number;
}
export interface JournalInput {
  kind: string;
  refType: string;
  refId: string;
  currency?: string;
  memo?: string;
  sandbox?: boolean;
  lines: Line[];
}

export const ACCOUNTS = {
  /** Asset: customer funds held at the approved provider / partner and not yet paid out. */
  PROVIDER_CLEARING: { code: 'PLATFORM:PROVIDER_CLEARING', type: 'ASSET' },
  /** Revenue: platform fees earned. */
  FEE_REVENUE: { code: 'PLATFORM:FEE_REVENUE', type: 'REVENUE' },
  /** Liability: captured funds not yet attributed to a merchant (under review). */
  SUSPENSE: { code: 'PLATFORM:SUSPENSE', type: 'LIABILITY' },
  /** Liability: payouts reserved or submitted but not yet confirmed. */
  PAYOUT_CLEARING: { code: 'PLATFORM:PAYOUT_CLEARING', type: 'LIABILITY' },
} as const;

export const merchantPayable = (merchantId: string) => `MERCHANT:${merchantId}:PAYABLE`;

function accountType(code: string): string {
  const fixed = Object.values(ACCOUNTS).find((a) => a.code === code);
  if (fixed) return fixed.type;
  if (code.endsWith(':PAYABLE')) return 'LIABILITY';
  throw new DomainError('UNKNOWN_ACCOUNT', `Unknown ledger account ${code}`, 500);
}

/** Append-only double-entry ledger. Posted journals are never edited; corrections are new journals. */
export class LedgerService {
  /**
   * Posts a balanced journal inside the caller's transaction.
   * Idempotent: a journal with the same (kind, refType, refId) is posted at most once.
   * Returns false if it had already been posted.
   */
  async post(tx: Queryable, j: JournalInput): Promise<boolean> {
    const currency = j.currency ?? 'INR';
    if (j.lines.length < 2) throw new DomainError('BAD_JOURNAL', 'Journal needs at least two lines', 500);
    let d = 0;
    let c = 0;
    for (const l of j.lines) {
      if (!Number.isSafeInteger(l.amountMinor) || l.amountMinor <= 0) throw new DomainError('BAD_JOURNAL', 'Line amounts must be positive integers', 500);
      if (l.dir === 'D') d += l.amountMinor;
      else c += l.amountMinor;
    }
    if (d !== c) throw new DomainError('UNBALANCED_JOURNAL', `Debits ${d} != credits ${c}`, 500);

    const rows = await tx.query<{ id: string }>(
      `INSERT INTO ledger_journals(kind, ref_type, ref_id, currency, memo, is_sandbox)
       VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (kind, ref_type, ref_id) DO NOTHING RETURNING id`,
      [j.kind, j.refType, j.refId, currency, j.memo ?? '', j.sandbox ?? true],
    );
    if (rows.length === 0) return false;
    const journalId = rows[0].id;

    for (const l of j.lines) {
      const accountId = await this.ensureAccount(tx, l.account, currency);
      await tx.query(`INSERT INTO ledger_entries(journal_id, account_id, direction, amount_minor) VALUES ($1,$2,$3,$4)`, [
        journalId,
        accountId,
        l.dir,
        l.amountMinor,
      ]);
    }
    return true;
  }

  private async ensureAccount(tx: Queryable, code: string, currency: string): Promise<string> {
    const merchantId = code.startsWith('MERCHANT:') ? code.split(':')[1] : null;
    const rows = await tx.query<{ id: string }>(
      `INSERT INTO ledger_accounts(code, type, merchant_id, currency) VALUES ($1,$2,$3,$4)
       ON CONFLICT (code) DO UPDATE SET code = EXCLUDED.code RETURNING id`,
      [code, accountType(code), merchantId, currency],
    );
    return rows[0].id;
  }

  /** Balance on the account's normal side (assets/expenses: D-C; others: C-D). */
  async balance(tx: Queryable, code: string): Promise<number> {
    const rows = await tx.query<{ type: string; d: number; c: number }>(
      `SELECT a.type,
              COALESCE(SUM(e.amount_minor) FILTER (WHERE e.direction='D'),0) AS d,
              COALESCE(SUM(e.amount_minor) FILTER (WHERE e.direction='C'),0) AS c
         FROM ledger_accounts a LEFT JOIN ledger_entries e ON e.account_id = a.id
        WHERE a.code = $1 GROUP BY a.type`,
      [code],
    );
    if (rows.length === 0) return 0;
    const { type, d, c } = rows[0];
    return Number(type === 'ASSET' || type === 'EXPENSE' ? d - c : c - d);
  }

  /** Integrity check used by reconciliation and monitoring: lists journals whose debits != credits. */
  async findUnbalancedJournals(tx: Queryable): Promise<{ journal_id: string; d: number; c: number }[]> {
    return tx.query(
      `SELECT journal_id,
              SUM(amount_minor) FILTER (WHERE direction='D') AS d,
              SUM(amount_minor) FILTER (WHERE direction='C') AS c
         FROM ledger_entries GROUP BY journal_id
       HAVING COALESCE(SUM(amount_minor) FILTER (WHERE direction='D'),0) <> COALESCE(SUM(amount_minor) FILTER (WHERE direction='C'),0)`,
    );
  }
}
