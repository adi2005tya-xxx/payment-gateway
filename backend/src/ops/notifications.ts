import { createTransport, Transporter } from 'nodemailer';
import { Db } from '../db/db';
import { SecretBox } from '../auth/secretbox';

export interface Mail {
  to: string;
  subject: string;
  text: string;
  kind: string;
}
export interface Notifier {
  send(mail: Mail): Promise<void>;
}

const maskEmail = (e: string) => e.replace(/^(.).*(@.*)$/, '$1***$2');

/** Development default: logs the event kind and a masked recipient only (never the message body). */
export class ConsoleNotifier implements Notifier {
  async send(m: Mail) {
    console.log(`[notify] ${m.kind} -> ${maskEmail(m.to)}`);
  }
}

/** Real delivery over SMTP (SMTP_URL, e.g. smtps://user:pass@host:465). */
export class SmtpNotifier implements Notifier {
  private readonly transport: Transporter;
  constructor(url: string, private readonly from: string) {
    this.transport = createTransport(url);
  }
  async send(m: Mail) {
    await this.transport.sendMail({ from: this.from, to: m.to, subject: m.subject, text: m.text });
  }
}

/** Test double that records what would have been sent. */
export class MemoryNotifier implements Notifier {
  sent: Mail[] = [];
  failNext = 0;
  async send(m: Mail) {
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error('simulated delivery failure');
    }
    this.sent.push(m);
  }
}

export const inr = (minor: number) => `INR ${(Number(minor) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const MAX_ATTEMPTS = 8;

/**
 * Delivers queued notification_jobs. At-least-once with backoff; a row is claimed with SKIP LOCKED and leased, so a crashed worker's
 * rows are retried and two workers never send the same row concurrently. Bodies carry no secrets except the password-reset link
 * (its token is stored encrypted and scrubbed from the row once sent).
 */
export class NotificationService {
  constructor(private readonly db: Db, private readonly notifier: Notifier, private readonly box: SecretBox, private readonly webBaseUrl: string) {}

  async dispatchDue(now: Date = new Date(), limit = 20): Promise<{ sent: number; failed: number; skipped: number }> {
    const rows = await this.db.transaction(async (tx) =>
      tx.query<any>(
        `UPDATE notification_jobs SET attempts = attempts + 1, next_attempt_at = $1::timestamptz + interval '5 minutes'
          WHERE id IN (SELECT id FROM notification_jobs WHERE status='PENDING' AND next_attempt_at <= $1 ORDER BY id LIMIT $2 FOR UPDATE SKIP LOCKED)
          RETURNING *`,
        [now.toISOString(), limit],
      ),
    );
    const out = { sent: 0, failed: 0, skipped: 0 };
    for (const r of rows) {
      try {
        const mails = await this.build(r);
        if (!mails.length) {
          await this.db.query(`UPDATE notification_jobs SET status='SKIPPED', last_error='no recipient' WHERE id=$1`, [r.id]);
          out.skipped++;
          continue;
        }
        for (const m of mails) await this.notifier.send(m);
        const scrub = r.kind === 'PASSWORD_RESET' ? `, payload='{"scrubbed":true}'::jsonb` : '';
        await this.db.query(`UPDATE notification_jobs SET status='SENT', sent_at=$2, last_error=NULL${scrub} WHERE id=$1`, [r.id, now.toISOString()]);
        out.sent++;
      } catch (e: any) {
        const dead = r.attempts >= MAX_ATTEMPTS;
        const delay = Math.min(3600_000, 2 ** r.attempts * 1000);
        await this.db.query(`UPDATE notification_jobs SET status=$2, last_error=$3, next_attempt_at=$4 WHERE id=$1`, [
          r.id,
          dead ? 'FAILED' : 'PENDING',
          String(e?.message ?? e).slice(0, 200),
          new Date(now.getTime() + delay).toISOString(),
        ]);
        out.failed++;
      }
    }
    return out;
  }

  private async emailsForMerchant(merchantId: string): Promise<string[]> {
    return (await this.db.query<any>(`SELECT email FROM users WHERE merchant_id=$1 AND status='ACTIVE' ORDER BY created_at`, [merchantId])).map((u) => u.email);
  }

  private async build(r: any): Promise<Mail[]> {
    const p = r.payload ?? {};
    const mk = (to: string[], subject: string, text: string): Mail[] => to.map((t) => ({ to: t, subject, text, kind: r.kind }));
    switch (r.kind) {
      case 'PAYMENT_RECEIVED':
        return mk(await this.emailsForMerchant(r.merchant_id), 'Payment received', `A payment of ${inr(p.amountMinor)} was verified and recorded. Payment id: ${p.paymentId}.`);
      case 'PAYOUT_SUCCEEDED': {
        const [po] = await this.db.query<any>('SELECT po.amount_minor, d.masked_account FROM payouts po JOIN merchant_settlement_destinations d ON d.id=po.destination_id WHERE po.id=$1', [p.payoutId]);
        return mk(await this.emailsForMerchant(r.merchant_id), 'Settlement completed', `A payout of ${inr(po?.amount_minor ?? 0)} to ${po?.masked_account ?? 'your destination'} was completed. Reference: ${p.payoutId}.`);
      }
      case 'PAYOUT_FAILED':
        return mk(await this.emailsForMerchant(r.merchant_id), 'Settlement failed', `A payout (${p.payoutId}) did not complete and the amount has been returned to your balance. Reason: ${String(p.reason ?? 'see dashboard')}.`);
      case 'REFUND_PROCESSED':
        return mk(await this.emailsForMerchant(r.merchant_id), 'Refund processed', `A refund (${p.refundId}) was processed against one of your payments.`);
      case 'MFA_RECOVERY_APPROVED': {
        const [u] = await this.db.query<any>('SELECT email FROM users WHERE id=$1', [p.userId]);
        return u ? mk([u.email], 'Security: MFA recovery approved', 'An administrator approved an MFA recovery for your account. It takes effect after the waiting period. If you did not request it, sign in with your authenticator now: that cancels it, and tell your security contact.') : [];
      }
      case 'PASSWORD_RESET': {
        const token = this.box.decrypt(p.tokenEnc, 'password-reset');
        return mk([p.to], 'Reset your password', `Use this link within 30 minutes to choose a new password:\n${this.webBaseUrl}/reset-password?token=${token}\nIf you did not ask for this, ignore this message; your password has not changed.`);
      }
      default:
        return [];
    }
  }
}
