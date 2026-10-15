import { createHash } from 'crypto';
import { Db } from '../db/db';
import { AuditService, SYSTEM_ACTOR } from '../audit/audit.service';
import { SecretBox } from '../auth/secretbox';
import { VerificationService } from '../payments/verification.service';
import { checkAuthenticity, DnsResolver, readMessage, systemResolver } from './authenticity';
import { parseAlert, TemplateDefinition, normaliseText } from './templates';

export type MatchPolicy = 'reference_required' | 'unique_amount_window';

export interface IngestOptions {
  /** reference_required (default, safest): the alert text must carry the order id. unique_amount_window: also accept exactly one pending order with that exact amount whose window contains the credit. */
  matchPolicy: MatchPolicy;
  maxAlertAgeHours: number;
  /** The bank cannot email a credit before it happens: a credit time later than the email's receipt time by more than this is rejected. */
  clockSkewMinutes: number;
  /** An order's window opens this many minutes before it was created (clock differences between bank and server). */
  orderWindowLeadMinutes: number;
  /** Phone notification/SMS evidence only: a credit above this amount is never confirmed automatically (held for a reviewer). */
  deviceAutoConfirmMaxMinor: number;
  /** Phone notification/SMS evidence only: most that may be auto-confirmed in any rolling 24 hours. */
  deviceDailyLimitMinor: number;
  /** A forwarded notification must have been posted within this many minutes of arriving (blocks replays of old notifications). */
  deviceMaxAgeMinutes: number;
  resolver?: DnsResolver;
  now?: () => Date;
}
export const defaultIngestOptions: IngestOptions = {
  matchPolicy: 'reference_required',
  maxAlertAgeHours: 48,
  clockSkewMinutes: 5,
  orderWindowLeadMinutes: 2,
  deviceAutoConfirmMaxMinor: 50_000,
  deviceDailyLimitMinor: 500_000,
  deviceMaxAgeMinutes: 10,
};

export interface MessageOutcome {
  status: string;
  reason?: string;
  messageId?: string;
  creditId?: string;
  creditStatus?: string;
}

const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const minute = 60_000;

/**
 * Turns bank credit alert emails into PAYMENT EVIDENCE, and nothing more. An order becomes PAID only through the existing
 * verification engine, which re-checks amount and request state and posts the ledger atomically. Anything not certain is held
 * (never guessed): unmatched/ambiguous credits sit in suspense with a risk review for a human.
 */
export class AlertIngestService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
    private readonly verification: VerificationService,
    private readonly box: SecretBox,
    private readonly provider: { name: string },
    readonly opts: IngestOptions = defaultIngestOptions,
  ) {}

  private now() {
    return (this.opts.now ?? (() => new Date()))();
  }

  private async alertOnce(kind: string, detail: Record<string, unknown>, dedupeMinutes = 60) {
    const [recent] = await this.db.query(`SELECT 1 FROM alerts WHERE kind=$1 AND created_at > now() - make_interval(mins => $2::int)`, [kind, dedupeMinutes]);
    if (!recent) await this.db.query('INSERT INTO alerts(kind, detail) VALUES ($1,$2)', [kind, JSON.stringify(detail)]);
  }

  /** Entry point for every message from any source (Gmail, folder, upload). Idempotent per (source, sourceMessageId). */
  async ingestRaw(raw: Buffer, meta: { source: string; sourceMessageId: string; receivedAt: Date }): Promise<MessageOutcome> {
    const hash = sha(raw);
    const ins = await this.db.query<{ id: string }>(
      `INSERT INTO mail_messages(source, source_message_id, content_hash, received_at) VALUES ($1,$2,$3,$4)
       ON CONFLICT (source, source_message_id) DO NOTHING RETURNING id`,
      [meta.source, meta.sourceMessageId, hash, meta.receivedAt.toISOString()],
    );
    let id = ins[0]?.id;
    if (!id) {
      const [ex] = await this.db.query<any>('SELECT id, status FROM mail_messages WHERE source=$1 AND source_message_id=$2', [meta.source, meta.sourceMessageId]);
      if (ex.status !== 'ERROR') return { status: 'ALREADY_SEEN', messageId: ex.id };
      id = ex.id; // retry of a message whose processing failed unexpectedly
    }
    try {
      return await this.process(id, raw, hash, meta.receivedAt);
    } catch (e: any) {
      const [r] = await this.db.query<{ attempts: number }>(`UPDATE mail_messages SET status='ERROR', attempts = attempts + 1, reason=$2, next_retry_at=$3 WHERE id=$1 RETURNING attempts`, [
        id,
        String(e?.message ?? e).slice(0, 200),
        new Date(this.now().getTime() + Math.min(60, 2 ** Number((await this.db.query<any>('SELECT attempts FROM mail_messages WHERE id=$1', [id]))[0].attempts)) * minute),
      ]);
      if (r.attempts >= 8) await this.alertOnce('BANK_EMAIL_PROCESSING_FAILED', { messageId: id, attempts: r.attempts });
      return { status: 'ERROR', reason: 'PROCESSING_ERROR', messageId: id };
    }
  }

  private async finish(id: string, status: string, reason: string | null, extra: { templateId?: string; creditId?: string; bodyText?: string } = {}) {
    await this.db.query(
      `UPDATE mail_messages SET status=$2, reason=$3, template_id=COALESCE($4, template_id), body_enc=COALESCE($5, body_enc), processed_at=$6 WHERE id=$1`,
      [id, status, reason, extra.templateId ?? null, extra.bodyText ? this.box.encrypt(extra.bodyText.slice(0, 8000), 'mail-body') : null, this.now().toISOString()],
    );
  }

  private async process(id: string, raw: Buffer, hash: string, receivedAt: Date): Promise<MessageOutcome> {
    const msg = await readMessage(raw).catch(() => null);
    if (!msg) {
      await this.finish(id, 'UNPARSEABLE', 'MIME_PARSE_FAILED');
      return { status: 'UNPARSEABLE', reason: 'MIME_PARSE_FAILED', messageId: id };
    }
    await this.db.query('UPDATE mail_messages SET from_addr=$2, subject=$3 WHERE id=$1', [id, msg.from, msg.subject.slice(0, 200)]);
    if (!msg.from || msg.fromCount !== 1 || !msg.fromDomain) {
      await this.finish(id, 'UNTRUSTED_SENDER', 'FROM_HEADER_INVALID');
      return { status: 'UNTRUSTED_SENDER', reason: 'FROM_HEADER_INVALID', messageId: id };
    }

    const templates = (await this.db.query<any>(`SELECT id, definition FROM alert_templates WHERE status='ACTIVE'`)).map((t) => ({ id: t.id as string, def: t.definition as TemplateDefinition }));
    const forSender = templates.filter((t) => (t.def.channel ?? 'email') === 'email' && (t.def.fromAddresses ?? []).includes(msg.from!));
    if (!forSender.length) {
      await this.finish(id, 'UNTRUSTED_SENDER', 'SENDER_NOT_ALLOWLISTED');
      return { status: 'UNTRUSTED_SENDER', reason: 'SENDER_NOT_ALLOWLISTED', messageId: id };
    }

    // Authenticity: cryptographic DKIM check for the allowlisted bank domain. A spoofed bank address fails here.
    let chosen: (typeof forSender)[number] | null = null;
    let lastReason = 'NO_TEMPLATE';
    for (const t of forSender) {
      const a = await checkAuthenticity(raw, t.def, msg.fromDomain, this.opts.resolver ?? systemResolver);
      if (a.ok) {
        chosen = t;
        break;
      }
      lastReason = a.reason;
    }
    if (!chosen) {
      await this.finish(id, 'AUTH_FAILED', lastReason);
      await this.db.transaction((tx) => this.audit.record(tx, SYSTEM_ACTOR, 'bankmail.auth_failed', 'mail_message', id, { reason: lastReason }));
      await this.alertOnce('BANK_EMAIL_AUTH_FAILURE', { reason: lastReason, note: 'an email using an allowlisted bank sender failed authentication; possible forgery' });
      return { status: 'AUTH_FAILED', reason: lastReason, messageId: id };
    }

    const parsed = parseAlert(chosen.def, { subject: msg.subject, text: msg.text });
    if (!parsed.ok) {
      if (parsed.kind === 'NOT_A_CREDIT') {
        await this.finish(id, 'IGNORED', parsed.reason, { templateId: chosen.id });
        return { status: 'IGNORED', reason: parsed.reason, messageId: id };
      }
      await this.finish(id, 'UNPARSEABLE', parsed.reason, { templateId: chosen.id, bodyText: normaliseText(msg.text) });
      await this.alertOnce('BANK_EMAIL_UNPARSEABLE', { reason: parsed.reason, template: chosen.id, note: 'an authenticated bank email looked like a credit but could not be parsed; the template may need updating' });
      return { status: 'UNPARSEABLE', reason: parsed.reason, messageId: id };
    }
    const c = parsed.credit;

    // Sanity: a credit cannot be emailed before it happens, and old alerts are not trusted as fresh evidence.
    const now = this.now();
    if (c.creditedAt.getTime() > receivedAt.getTime() + this.opts.clockSkewMinutes * minute) {
      await this.finish(id, 'REJECTED', 'CREDIT_TIME_AFTER_EMAIL_RECEIPT', { templateId: chosen.id });
      await this.alertOnce('BANK_EMAIL_SUSPICIOUS', { reason: 'CREDIT_TIME_AFTER_EMAIL_RECEIPT' });
      return { status: 'REJECTED', reason: 'CREDIT_TIME_AFTER_EMAIL_RECEIPT', messageId: id };
    }
    if (now.getTime() - c.creditedAt.getTime() > this.opts.maxAlertAgeHours * 3600_000) {
      await this.finish(id, 'REJECTED', 'CREDIT_TOO_OLD', { templateId: chosen.id });
      return { status: 'REJECTED', reason: 'CREDIT_TOO_OLD', messageId: id };
    }

    // The same email content seen again (e.g. re-delivered under a new message id) is not a second credit.
    const [sameContent] = await this.db.query(`SELECT 1 FROM mail_messages WHERE content_hash=$1 AND status='CREDIT_RECORDED' AND id <> $2`, [hash, id]);
    if (sameContent) {
      await this.finish(id, 'DUPLICATE', 'SAME_CONTENT', { templateId: chosen.id });
      return { status: 'DUPLICATE', reason: 'SAME_CONTENT', messageId: id };
    }

    const rows = await this.db.query<{ id: string }>(
      `INSERT INTO bank_credits(reference, amount_minor, credited_at, payer_masked, order_tokens, evidence, source_message_id)
       VALUES ($1,$2,$3,$4,$5,'BANK_EMAIL',$6) ON CONFLICT (reference) DO NOTHING RETURNING id`,
      [c.reference, c.amountMinor, c.creditedAt.toISOString(), c.payerMasked, c.orderTokens, id],
    );
    if (!rows.length) {
      await this.finish(id, 'DUPLICATE', 'SAME_REFERENCE', { templateId: chosen.id });
      return { status: 'DUPLICATE', reason: 'SAME_REFERENCE', messageId: id };
    }
    const creditId = rows[0].id;
    await this.finish(id, 'CREDIT_RECORDED', null, { templateId: chosen.id, creditId, bodyText: normaliseText(msg.text) });
    await this.db.transaction((tx) => this.audit.record(tx, SYSTEM_ACTOR, 'bankmail.credit_recorded', 'bank_credit', creditId, { amountMinor: c.amountMinor, reference: c.reference }));
    const m = await this.matchCredit(creditId);
    return { status: 'CREDIT_RECORDED', messageId: id, creditId, creditStatus: m.status };
  }

  /**
   * Phone notification / SMS forwarded by an authenticated device. WEAKER EVIDENCE than a signed email: nothing in the text can be
   * verified cryptographically and the source package/sender is asserted by the forwarding app. Guards: device token, exact-package/sender
   * allowlist from an operator-validated template, freshness, unique bank/PhonePe transaction id, exact-amount matching, and
   * per-credit and rolling-24h limits (anything above is held for a person). The credit is labelled DEVICE_NOTIFICATION everywhere.
   */
  async ingestNotification(input: { deviceId: string; packageName?: string; sender?: string; title: string; text: string; postedAt: Date }): Promise<MessageOutcome> {
    const now = this.now();
    const origin = (input.packageName ?? input.sender ?? '').toLowerCase();
    const hash = sha(`${origin}|${input.title}|${input.text}`);
    const ins = await this.db.query<{ id: string }>(
      `INSERT INTO mail_messages(source, source_message_id, content_hash, received_at, from_addr, subject) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (source, source_message_id) DO NOTHING RETURNING id`,
      ['device', `${input.deviceId}:${hash}`, hash, now.toISOString(), origin.slice(0, 100), input.title.slice(0, 200)],
    );
    if (!ins.length) return { status: 'ALREADY_SEEN' }; // the very same notification text again
    const id = ins[0].id;
    try {
      const templates = (await this.db.query<any>(`SELECT id, definition FROM alert_templates WHERE status='ACTIVE'`))
        .map((t) => ({ id: t.id as string, def: t.definition as TemplateDefinition }))
        .filter((t) => t.def.channel === 'notification' && ((input.packageName && (t.def.packages ?? []).includes(input.packageName.toLowerCase())) || (input.sender && (t.def.smsSenders ?? []).includes(input.sender.toLowerCase()))));
      if (!templates.length) {
        await this.finish(id, 'UNTRUSTED_SENDER', 'SOURCE_NOT_ALLOWLISTED');
        return { status: 'UNTRUSTED_SENDER', reason: 'SOURCE_NOT_ALLOWLISTED', messageId: id };
      }
      const ageMs = now.getTime() - input.postedAt.getTime();
      if (ageMs > this.opts.deviceMaxAgeMinutes * minute || ageMs < -this.opts.clockSkewMinutes * minute) {
        await this.finish(id, 'REJECTED', 'NOTIFICATION_NOT_FRESH', { templateId: templates[0].id });
        await this.alertOnce('BANK_EMAIL_SUSPICIOUS', { reason: 'NOTIFICATION_NOT_FRESH' });
        return { status: 'REJECTED', reason: 'NOTIFICATION_NOT_FRESH', messageId: id };
      }
      const postedAt = input.postedAt.getTime() > now.getTime() ? now : input.postedAt;
      let chosen: { id: string; def: TemplateDefinition } | null = null;
      let parsed: ReturnType<typeof parseAlert> | null = null;
      for (const t of templates) {
        const r = parseAlert(t.def, { subject: input.title, text: input.text, receivedAt: postedAt });
        if (r.ok || !parsed || (parsed.ok === false && parsed.kind === 'NOT_A_CREDIT' && r.ok === false && r.kind === 'UNPARSEABLE')) {
          parsed = r;
          chosen = t;
        }
        if (r.ok) break;
      }
      if (!parsed || !chosen) throw new Error('no template evaluated');
      if (!parsed.ok) {
        if (parsed.kind === 'NOT_A_CREDIT') {
          await this.finish(id, 'IGNORED', parsed.reason, { templateId: chosen.id });
          return { status: 'IGNORED', reason: parsed.reason, messageId: id };
        }
        await this.finish(id, 'UNPARSEABLE', parsed.reason, { templateId: chosen.id, bodyText: normaliseText(input.text) });
        await this.alertOnce('BANK_EMAIL_UNPARSEABLE', { reason: parsed.reason, template: chosen.id, note: 'a forwarded notification from an allowed source looked like a credit but could not be parsed; the wording may have changed' });
        return { status: 'UNPARSEABLE', reason: parsed.reason, messageId: id };
      }
      const c = parsed.credit;
      if (chosen.def.maxAmountMinor && c.amountMinor > chosen.def.maxAmountMinor) {
        await this.finish(id, 'REJECTED', 'ABOVE_TEMPLATE_MAXIMUM', { templateId: chosen.id });
        return { status: 'REJECTED', reason: 'ABOVE_TEMPLATE_MAXIMUM', messageId: id };
      }
      const rows = await this.db.query<{ id: string }>(
        `INSERT INTO bank_credits(reference, amount_minor, credited_at, payer_masked, order_tokens, evidence, source_message_id)
         VALUES ($1,$2,$3,$4,$5,'DEVICE_NOTIFICATION',$6) ON CONFLICT (reference) DO NOTHING RETURNING id`,
        [c.reference, c.amountMinor, c.creditedAt.toISOString(), c.payerMasked, c.orderTokens, id],
      );
      if (!rows.length) {
        await this.finish(id, 'DUPLICATE', 'SAME_REFERENCE', { templateId: chosen.id });
        return { status: 'DUPLICATE', reason: 'SAME_REFERENCE', messageId: id };
      }
      const creditId = rows[0].id;
      await this.finish(id, 'CREDIT_RECORDED', null, { templateId: chosen.id, creditId, bodyText: normaliseText(input.text) });
      await this.db.transaction((tx) => this.audit.record(tx, SYSTEM_ACTOR, 'bankmail.notification_recorded', 'bank_credit', creditId, { amountMinor: c.amountMinor, reference: c.reference, deviceId: input.deviceId }));
      const m = await this.matchCredit(creditId);
      return { status: 'CREDIT_RECORDED', messageId: id, creditId, creditStatus: m.status };
    } catch (e: any) {
      await this.db.query(`UPDATE mail_messages SET status='ERROR', attempts = attempts + 1, reason=$2 WHERE id=$1`, [id, String(e?.message ?? e).slice(0, 200)]);
      return { status: 'ERROR', reason: 'PROCESSING_ERROR', messageId: id };
    }
  }

  /** Decides which order (if any) a recorded credit belongs to, then lets the verification engine apply or hold it. Idempotent. */
  async matchCredit(creditId: string): Promise<{ status: string; reason?: string }> {
    const [c] = await this.db.query<any>('SELECT * FROM bank_credits WHERE id=$1', [creditId]);
    if (!c) return { status: 'MISSING' };
    if (c.status !== 'NEW') return { status: c.status };
    const lead = this.opts.orderWindowLeadMinutes * minute;
    const credited = new Date(c.credited_at).getTime();
    const inWindow = (o: any) => credited >= new Date(o.created_at).getTime() - lead && (!o.expires_at || credited <= new Date(o.expires_at).getTime());

    let order: any = null;
    let status = 'UNMATCHED';
    let reason = 'NO_ORDER_REFERENCE_IN_ALERT';
    let method: string | null = null;
    let candidates: string[] = [];

    const device = c.evidence === 'DEVICE_NOTIFICATION';
    const policy: MatchPolicy = device ? 'unique_amount_window' : this.opts.matchPolicy; // phone text has no order id: only an exact, unique amount can match
    const tokens: string[] = c.order_tokens ?? [];
    if (tokens.length) {
      const found = await this.db.query<any>(`SELECT * FROM payment_requests WHERE provider=$1 AND provider_order_id = ANY($2::text[])`, [this.provider.name, tokens]);
      candidates = found.map((o) => o.id);
      if (found.length > 1) [status, reason] = ['AMBIGUOUS', 'MULTIPLE_ORDER_REFERENCES_IN_ALERT'];
      else if (found.length === 0) [status, reason] = ['UNMATCHED', 'UNKNOWN_ORDER_REFERENCE'];
      else if (!inWindow(found[0])) [status, reason] = ['REVIEW', 'CREDIT_TIME_OUTSIDE_ORDER_WINDOW'];
      else {
        order = found[0];
        method = 'ORDER_REFERENCE';
      }
    } else if (policy === 'unique_amount_window') {
      const cands = (await this.db.query<any>(`SELECT * FROM payment_requests WHERE provider=$1 AND status='PENDING' AND amount_minor=$2`, [this.provider.name, c.amount_minor])).filter(inWindow);
      candidates = cands.map((o) => o.id);
      if (cands.length === 1) {
        order = cands[0];
        method = 'UNIQUE_AMOUNT_IN_WINDOW';
      } else if (cands.length > 1) [status, reason] = ['AMBIGUOUS', 'SEVERAL_PENDING_ORDERS_WITH_THIS_AMOUNT'];
      else [status, reason] = ['UNMATCHED', 'NO_PENDING_ORDER_FOR_AMOUNT_IN_WINDOW'];
    }

    // Unverified (phone) evidence is limited: above the per-credit cap, or past the rolling 24h cap, it is held for a person.
    if (device && order) {
      const [day] = await this.db.query<any>(
        `SELECT COALESCE(SUM(amount_minor),0) AS s FROM bank_credits WHERE evidence='DEVICE_NOTIFICATION' AND status='MATCHED' AND updated_at > $1::timestamptz - interval '24 hours'`,
        [this.now().toISOString()],
      );
      const held = Number(c.amount_minor) > this.opts.deviceAutoConfirmMaxMinor ? 'ABOVE_UNVERIFIED_LIMIT' : Number(day.s) + Number(c.amount_minor) > this.opts.deviceDailyLimitMinor ? 'DAILY_UNVERIFIED_LIMIT_REACHED' : null;
      if (held) {
        candidates = [order.id];
        order = null;
        method = null;
        [status, reason] = ['REVIEW', held];
      }
    }

    // The engine re-checks amount, merchant, order state; with no order it books the money to suspense and opens a risk review.
    const res = await this.verification.applyProviderPayment({
      id: c.reference,
      orderId: order?.provider_order_id ?? '',
      amountMinor: Number(c.amount_minor),
      currency: c.currency.trim(),
      status: 'captured',
      merchantRef: order?.merchant_id ?? '',
      refundedMinor: 0,
    });
    const paymentId = res.paymentId;
    if (res.outcome === 'SUCCEEDED' || (res.outcome === 'DUPLICATE' && (await this.paymentStatus(paymentId)) === 'SUCCEEDED')) {
      status = 'MATCHED';
      reason = '';
    } else if (order) {
      status = 'REVIEW';
      reason = res.outcome === 'UNDER_REVIEW' ? res.reasons.join(',') : 'ALREADY_RECORDED_UNDER_REVIEW';
      method = null;
    }
    await this.db.query(
      `UPDATE bank_credits SET status=$2, reason=$3, match_method=$4, order_id=$5, payment_id=$6, candidates=$7, updated_at=now() WHERE id=$1`,
      [creditId, status, reason || null, method, status === 'MATCHED' || order ? order?.id ?? null : null, paymentId, JSON.stringify(candidates)],
    );
    await this.db.transaction(async (tx) => {
      await this.audit.record(tx, SYSTEM_ACTOR, status === 'MATCHED' ? 'bankmail.credit_matched' : 'bankmail.credit_held', 'bank_credit', creditId, { status, reason, method, orderId: order?.id ?? null });
      if (status !== 'MATCHED') await tx.query(`INSERT INTO alerts(kind, detail) VALUES ('BANK_CREDIT_NEEDS_REVIEW', $1)`, [JSON.stringify({ creditId, status, reason })]);
    });
    return { status, reason };
  }

  private async paymentStatus(paymentId: string) {
    return (await this.db.query<any>('SELECT status FROM payments WHERE id=$1', [paymentId]))[0]?.status;
  }

  /** Credits recorded but not yet matched (e.g. a crash between the two steps) are finished here. */
  async matchNew(): Promise<number> {
    const rows = await this.db.query<{ id: string }>(`SELECT id FROM bank_credits WHERE status='NEW' AND created_at < now() - interval '30 seconds' ORDER BY created_at LIMIT 50`);
    for (const r of rows) await this.matchCredit(r.id);
    return rows.length;
  }

  /** Messages whose processing failed unexpectedly and are due for another attempt. */
  async retryDue(): Promise<Array<{ source: string; sourceMessageId: string }>> {
    return (await this.db.query<any>(`SELECT source, source_message_id FROM mail_messages WHERE status='ERROR' AND attempts < 8 AND next_retry_at <= $1`, [this.now().toISOString()])).map((r) => ({ source: r.source, sourceMessageId: r.source_message_id }));
  }
}
