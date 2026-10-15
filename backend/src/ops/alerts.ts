import { Db } from '../db/db';
import { AuditService } from '../audit/audit.service';
import { LedgerService } from '../ledger/ledger.service';

export interface AlertSink {
  send(alert: { id: number; kind: string; severity: Severity; detail: unknown; at: string }): Promise<void>;
}
export type Severity = 'critical' | 'warning' | 'info';

/** Which alert kinds page someone. Everything not listed is 'info'. */
const SEVERITY: Record<string, Severity> = {
  LEDGER_UNBALANCED: 'critical',
  AUDIT_CHAIN_BROKEN: 'critical',
  PAYOUT_UNKNOWN_OUTCOME: 'critical',
  RECONCILIATION_DISCREPANCY: 'critical',
  MONEY_OUT_FROZEN: 'critical',
  JOB_DEAD_LETTER: 'critical',
  PAYOUT_RETURNED: 'critical',
  PAYOUT_AMOUNT_MISMATCH: 'critical',
  MFA_RECOVERY_COMPLETED: 'critical',
  PROVIDER_BALANCE_LOW: 'warning',
  WEBHOOK_SIGNATURE_FAILURE: 'warning',
  WEBHOOK_BACKLOG: 'warning',
  JOBS_LATE: 'warning',
  PAYOUTS_STUCK: 'warning',
  MFA_LOCKOUT: 'warning',
  MFA_RECOVERY_REQUESTED: 'warning',
  MFA_RECOVERY_CODES_LOW: 'info',
  POST_RESTORE_COMPLETED: 'info',
};
export const severityOf = (kind: string): Severity => SEVERITY[kind] ?? 'info';

/** Slack-compatible incoming-webhook sink (also fine for any JSON endpoint). Optionally signs the body with HMAC-SHA256. */
export class WebhookAlertSink implements AlertSink {
  constructor(private readonly url: string, private readonly secret?: string, private readonly minSeverity: Severity = 'warning') {}
  async send(a: Parameters<AlertSink['send']>[0]) {
    const rank = { info: 0, warning: 1, critical: 2 } as const;
    if (rank[a.severity] < rank[this.minSeverity]) return;
    const body = JSON.stringify({ text: `[${a.severity.toUpperCase()}] gateway alert ${a.kind}`, kind: a.kind, severity: a.severity, detail: a.detail, at: a.at });
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.secret) headers['x-gateway-signature'] = (await import('crypto')).createHmac('sha256', this.secret).update(body).digest('hex');
    const res = await fetch(this.url, { method: 'POST', headers, body, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`alert sink responded ${res.status}`);
  }
}

/** Test double. */
export class MemoryAlertSink implements AlertSink {
  sent: Array<Parameters<AlertSink['send']>[0]> = [];
  async send(a: Parameters<AlertSink['send']>[0]) {
    this.sent.push(a);
  }
}

/** Pushes new rows of the alerts table to the sink (at least once; failures are retried on the next tick). */
export class AlertRouter {
  constructor(private readonly db: Db, private readonly sink?: AlertSink) {}

  async routeDue(limit = 50): Promise<{ routed: number; failed: number }> {
    if (!this.sink) return { routed: 0, failed: 0 };
    const rows = await this.db.query<any>(`SELECT id, kind, detail, created_at FROM alerts WHERE routed_at IS NULL AND route_attempts < 10 ORDER BY id LIMIT $1`, [limit]);
    let routed = 0;
    let failed = 0;
    for (const r of rows) {
      try {
        await this.sink.send({ id: Number(r.id), kind: r.kind, severity: severityOf(r.kind), detail: r.detail, at: new Date(r.created_at).toISOString() });
        await this.db.query('UPDATE alerts SET routed_at=now() WHERE id=$1', [r.id]);
        routed++;
      } catch {
        await this.db.query('UPDATE alerts SET route_attempts = route_attempts + 1 WHERE id=$1', [r.id]);
        failed++;
      }
    }
    return { routed, failed };
  }
}

/**
 * Periodic health checks that turn silent conditions into alerts (deduplicated: one alert per kind per hour).
 * Details never contain personal data or secrets.
 */
export class OpsMonitor {
  constructor(private readonly db: Db, private readonly ledger: LedgerService, private readonly audit: AuditService) {}

  private async raise(kind: string, detail: Record<string, unknown>) {
    const [recent] = await this.db.query(`SELECT 1 FROM alerts WHERE kind=$1 AND created_at > now() - interval '1 hour'`, [kind]);
    if (recent) return false;
    await this.db.query('INSERT INTO alerts(kind, detail) VALUES ($1,$2)', [kind, JSON.stringify(detail)]);
    return true;
  }

  async runChecks(opts: { fullAudit?: boolean } = {}): Promise<string[]> {
    const raised: string[] = [];
    const add = async (kind: string, detail: Record<string, unknown>) => {
      if (await this.raise(kind, detail)) raised.push(kind);
    };
    const [late] = await this.db.query<any>(`SELECT COUNT(*)::int n FROM jobs WHERE status='PENDING' AND run_at < now() - interval '5 minutes' AND attempts = 0`);
    if (late.n > 0) await add('JOBS_LATE', { count: late.n });
    const [backlog] = await this.db.query<any>(`SELECT COUNT(*)::int n FROM webhook_events WHERE status='RECEIVED' AND received_at < now() - interval '10 minutes'`);
    if (backlog.n > 0) await add('WEBHOOK_BACKLOG', { count: backlog.n });
    const [stuck] = await this.db.query<any>(`SELECT COUNT(*)::int n FROM payouts WHERE status IN ('SUBMITTED','PROCESSING') AND updated_at < now() - interval '1 hour'`);
    if (stuck.n > 0) await add('PAYOUTS_STUCK', { count: stuck.n });
    const unbalanced = await this.ledger.findUnbalancedJournals(this.db);
    if (unbalanced.length) await add('LEDGER_UNBALANCED', { journals: unbalanced.length });
    if (opts.fullAudit && !(await this.audit.verifyChain(this.db))) await add('AUDIT_CHAIN_BROKEN', {});
    return raised;
  }
}
