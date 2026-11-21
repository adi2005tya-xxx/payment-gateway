import {
  ArgumentsHost, BadRequestException, Body, Catch, Controller, ExceptionFilter, Get, Header, HttpException, Inject, Param, Post,
  Query, RawBodyRequest, Req, Res, UseGuards, Headers,
} from '@nestjs/common';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
import { JwtService } from '@nestjs/jwt';
import { z, ZodError, ZodType } from 'zod';
import * as QRCode from 'qrcode';
import { AllowPendingMfa, AuthGuard, DEMO_PAYMENTS, AuthUser, hashPassword, JWT, PLATFORM, RATE_LIMITS, Roles, StepUp, validatePasswordStrength } from '../auth/auth';
import { DomainError, TransientError } from '../common/errors';
import { Platform } from '../platform';
import { SandboxProvider } from '../provider/sandbox.provider';
import { SandboxBankAccountProvider } from '../provider/sandbox-bank.provider';
import { validateQrPayload } from '../payments/payments.service';
import { nameMatches } from '../merchants/merchants.service';

const parse = <T>(schema: ZodType<T>, data: unknown): T => schema.parse(data);
const uuid = z.string().uuid();

@Catch()
export class ErrorFilter implements ExceptionFilter {
  catch(e: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse();
    if (e instanceof DomainError) return res.status(e.status).json({ error: e.code, message: e.message, ...e.extra });
    if (e instanceof ZodError) return res.status(400).json({ error: 'VALIDATION_FAILED', issues: e.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
    if (e instanceof HttpException) return res.status(e.getStatus()).json({ error: 'HTTP_ERROR', message: e.message });
    console.error('Unhandled error', e instanceof Error ? e.message : e); // never log request bodies or secrets
    return res.status(500).json({ error: 'INTERNAL', message: 'Internal error' });
  }
}

// ------------------------------------------------------------------ auth + public
@Controller()
export class PublicController {
  constructor(@Inject(PLATFORM) private readonly p: Platform, @Inject(JWT) private readonly jwt: JwtService, @Inject(DEMO_PAYMENTS) private readonly demoEnabled: boolean) {}

  /** Whether the "try a test payment" button should be shown. */
  @Get('public/demo-payment')
  demoStatus() {
    return { enabled: this.demoEnabled && this.p.provider.isSandbox };
  }

  /** No-login Rs 1 TEST payment against the built-in demo merchant. Disabled unless DEMO_PAYMENTS_ENABLED=true, and never with a non-test provider. */
  @Post('public/demo-payment')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async demoPayment() {
    if (!this.demoEnabled || !this.p.provider.isSandbox) throw new DomainError('NOT_FOUND', 'Not found', 404);
    return this.p.demo.createDemoPayment();
  }

  @Post('auth/register')
  @Throttle({ default: { limit: () => RATE_LIMITS.auth, ttl: 60_000 } })
  async register(@Body() body: unknown) {
    const b = parse(z.object({ email: z.string().email(), password: z.string(), legalName: z.string().min(2).max(200), displayName: z.string().min(2).max(100) }), body);
    validatePasswordStrength(b.password);
    const r = await this.p.merchants.register({ ...b, passwordHash: await hashPassword(b.password) });
    return { merchantId: r.merchantId, status: 'PENDING_VERIFICATION' };
  }

  @Post('auth/login')
  @Throttle({ default: { limit: () => RATE_LIMITS.auth, ttl: 60_000 } })
  async login(@Body() body: unknown) {
    const b = parse(z.object({ email: z.string().email(), password: z.string() }), body);
    const r = await this.p.auth.login(b.email, b.password);
    // The returned token only works on MFA endpoints until the second factor is verified (when MFA applies).
    return { token: await issueToken(this.jwt, this.p, r.user.id, r.user.role, r.session), role: r.user.role, mfa: r.mfa, expiresAt: r.session.expiresAt };
  }

  /** Step 1 of controlled MFA recovery. Needs the password; changes nothing until another admin approves and the delay elapses. */
  @Post('auth/mfa/recovery-request')
  @Throttle({ default: { limit: () => RATE_LIMITS.recovery, ttl: 60_000 } })
  async recoveryRequest(@Body() body: unknown) {
    const b = parse(z.object({ email: z.string().email(), password: z.string() }), body);
    await this.p.mfa.requestRecovery(b.email, b.password);
    return { received: true, message: 'If recovery applies to this account, it has been queued for administrator review.' };
  }

  /** Always the same reply (no account enumeration). */
  @Post('auth/password-reset/request')
  @Throttle({ default: { limit: () => RATE_LIMITS.recovery, ttl: 60_000 } })
  async passwordResetRequest(@Body() body: unknown) {
    const b = parse(z.object({ email: z.string().email() }), body);
    await this.p.auth.requestPasswordReset(b.email);
    return { received: true, message: 'If an account exists for this email, a reset link has been sent.' };
  }

  @Post('auth/password-reset/confirm')
  @Throttle({ default: { limit: () => RATE_LIMITS.recovery, ttl: 60_000 } })
  async passwordResetConfirm(@Body() body: unknown) {
    const b = parse(z.object({ token: z.string().min(20).max(100), password: z.string() }), body);
    return this.p.auth.confirmPasswordReset(b.token, b.password);
  }

  /** Google redirects the operator's browser here after consent. Only the one-time state (bound to the admin who started it) authorises it. */
  @Get('auth/google/callback')
  @SkipThrottle()
  async googleCallback(@Query() q: Record<string, string>, @Res() res: any) {
    const back = (qs: string) => res.redirect(`${this.p.mailbox.opts.returnUrl ?? ''}/admin/mailbox?${qs}`);
    if (q.error) return back(`error=${encodeURIComponent(String(q.error).slice(0, 60))}`);
    try {
      await this.p.mailbox.completeConnect(String(q.code ?? ''), String(q.state ?? ''));
      return back('connected=1');
    } catch (e: any) {
      return back(`error=${encodeURIComponent(e?.code ?? 'FAILED')}`);
    }
  }

  /**
   * Forwarding endpoint for a phone running a notification/SMS forwarder. Authenticated by a per-device bearer token.
   * Phone text is WEAKER evidence than a signed email: see docs/phone-notifications.md.
   */
  @Post('ingest/notification')
  @Throttle({ default: { limit: () => RATE_LIMITS.ingest, ttl: 60_000 } })
  async ingestNotification(@Headers('authorization') authz: string | undefined, @Body() body: unknown) {
    const device = await this.p.devices.authenticate(authz?.startsWith('Bearer ') ? authz.slice(7).trim() : undefined);
    if (!device) throw new DomainError('UNAUTHENTICATED', 'Invalid or revoked device token', 401);
    const b = parse(
      z.object({ package: z.string().max(100).optional(), sender: z.string().max(40).optional(), title: z.string().max(300).default(''), text: z.string().min(1).max(4000), postedAt: z.number().int() })
        .refine((v) => !!(v.package || v.sender), 'package or sender is required'),
      body,
    );
    const out = await this.p.ingest.ingestNotification({ deviceId: device.id, packageName: b.package, sender: b.sender, title: b.title, text: b.text, postedAt: new Date(b.postedAt) });
    return { status: out.status, reason: out.reason };
  }

  /** Customer-facing payment link data. Exposes nothing beyond what the customer needs. */
  @Get('public/pay/:token')
  async payLink(@Param('token') token: string) {
    const v = await this.p.requests.publicView(token);
    // payLink lets a phone open the customer's UPI app directly; it holds the payee UPI ID, amount and reference (all public by design).
    return { ...v, qrPayload: undefined, payLink: v.qrPayload?.startsWith('upi://') ? v.qrPayload : undefined, qrImage: v.qrPayload ? await this.qr(v.qrPayload) : undefined };
  }

  /** Parameters for a custom (razorpay.js) checkout. Only the public key id leaves the server. */
  @Get('public/pay/:token/checkout')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  async checkoutParams(@Param('token') token: string) {
    const p = this.p.provider;
    if (!p.customCheckoutKeyId) throw new DomainError('NOT_FOUND', 'Custom checkout is not available', 404);
    const c = await this.p.requests.checkoutParams(token);
    if (c.provider !== p.name) throw new DomainError('NOT_FOUND', 'Custom checkout is not available', 404);
    if (c.status !== 'PENDING') throw new DomainError('NOT_PAYABLE', 'This payment request can no longer be paid', 409);
    return { keyId: p.customCheckoutKeyId, orderId: c.orderId, amountMinor: c.amountMinor, currency: c.currency, merchantName: c.merchantName, description: c.description };
  }

  private async qr(payload: string) {
    validateQrPayload(payload);
    return QRCode.toDataURL(payload, { errorCorrectionLevel: 'M', margin: 2 });
  }

  /** Provider webhook endpoint. Signature is verified over the exact raw body; 2xx only after durable storage. */
  @Post('webhooks/:provider')
  @SkipThrottle()
  async webhook(@Param('provider') provider: string, @Req() req: RawBodyRequest<any>, @Headers() headers: Record<string, string | undefined>) {
    const sig = headers['x-gateway-signature'] ?? headers['x-razorpay-signature'] ?? headers['x-verify']; // Razorpay / PhonePe send theirs in their own header; Paytm signs inside the body
    if (provider !== this.p.provider.name) throw new DomainError('UNKNOWN_PROVIDER', 'Unknown provider', 404);
    if (!req.rawBody) throw new DomainError('MALFORMED_EVENT', 'Empty body', 400);
    return this.p.verification.ingestWebhook(req.rawBody.toString('utf8'), sig);
  }

  /** Where a customer lands after paying at a hosted gateway. It never confirms payment: only the verified webhook/status lookup does. */
  @Get('pay/done')
  @Post('pay/done')
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'")
  payDone() {
    return '<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>Payment submitted</title><body style="font:16px system-ui;max-width:420px;margin:12vh auto;padding:0 16px"><h1>Thanks</h1><p>Your payment was submitted. The merchant is notified once the payment is confirmed with the provider.</p>';
  }

  /** Razorpay-style checkout return: verifies the HMAC signature, then asks the provider (not the browser) for the payment's real state. */
  @Post('pay/:provider/verify')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  async verifyCheckout(@Param('provider') provider: string, @Body() body: unknown) {
    const p = this.p.provider;
    if (provider !== p.name || !p.verifyCheckoutReturn) throw new DomainError('NOT_FOUND', 'Not found', 404);
    const b = parse(z.object({ orderId: z.string().min(1).max(100), paymentId: z.string().min(1).max(100), signature: z.string().min(1).max(200) }), body);
    if (!p.verifyCheckoutReturn(b)) throw new DomainError('INVALID_SIGNATURE', 'Payment signature mismatch', 400);
    let status = 'pending';
    try {
      await p.captureIfAuthorized?.(b.paymentId).catch((e) => {
        if (e instanceof TransientError) throw e; // anything else: leave it authorized; the status lookup below reports it as pending
      });
      const pp = await p.getPayment(b.paymentId);
      if (pp.orderId === b.orderId) {
        await this.p.verification.applyProviderPayment(pp);
        status = pp.status;
      }
    } catch (e) {
      // Not final yet (or provider briefly down): the webhook / retry path will settle it. The signature itself is valid.
      if (!(e instanceof TransientError)) throw e;
    }
    return { verified: true, status };
  }

  /** Hosted checkout page for a real gateway (Razorpay/Paytm). PhonePe redirects to its own page instead. */
  @Get('pay/:provider/:orderId')
  async hostedCheckout(@Param('provider') provider: string, @Param('orderId') orderId: string, @Query() query: Record<string, string>, @Res() res: any) {
    const p = this.p.provider;
    if (provider !== p.name || !p.renderCheckoutPage || !/^[A-Za-z0-9_-]{4,80}$/.test(orderId)) throw new DomainError('NOT_FOUND', 'Not found', 404);
    let page;
    try {
      page = await p.renderCheckoutPage(orderId, query);
    } catch (e: any) {
      if (e instanceof TransientError) throw new DomainError('PROVIDER_UNAVAILABLE', 'Payment provider unavailable, try again shortly', 503);
      throw new DomainError('NOT_FOUND', 'Not found', 404);
    }
    res.set({ 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': page.csp, 'Referrer-Policy': 'no-referrer' }).send(page.html);
  }

  // ---- Sandbox-only customer simulation. Absent entirely when the provider is not the sandbox.
  @Get('pay/sandbox/:orderId')
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'")
  sandboxPage(@Param('orderId') orderId: string) {
    this.requireSandbox();
    const safe = orderId.replace(/[^a-zA-Z0-9_]/g, '');
    return `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>Sandbox checkout</title>
<style>body{font:16px system-ui;max-width:420px;margin:12vh auto;padding:0 16px}button{font:inherit;padding:10px 16px;margin:4px 4px 0 0}.t{background:#fff3cd;padding:8px 12px;border-radius:6px}</style>
<p class=t>SANDBOX - simulated payment, no real money moves.</p><h1>Pay (test)</h1>
<button onclick="go('captured')">Simulate successful payment</button><button onclick="go('failed')">Simulate failed payment</button>
<p id=m aria-live=polite></p>
<script>async function go(o){const r=await fetch('/sandbox/pay/${safe}',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({outcome:o})});
document.getElementById('m').textContent=r.ok?'Submitted. Awaiting confirmation from the platform (this page does not confirm payment).':'Error'}</script>`;
  }

  @Post('sandbox/pay/:orderId')
  async sandboxPay(@Param('orderId') orderId: string, @Body() body: unknown) {
    this.requireSandbox();
    const b = parse(z.object({ outcome: z.enum(['captured', 'failed']).default('captured') }), body);
    const sp = this.p.provider;
    let sim: { webhook: { body: string; signature: string } } | null;
    if (sp instanceof SandboxBankAccountProvider) {
      // A bank has no "failed payment" event: a failure at the customer's bank simply produces no credit.
      sim = b.outcome === 'captured' ? sp.simulateBankCredit(orderId) : null;
    } else sim = (sp as SandboxProvider).simulateCustomerPayment(orderId, { outcome: b.outcome });
    // Delivered through the very same ingestion path a real provider webhook uses.
    if (sim) await this.p.verification.ingestWebhook(sim.webhook.body, sim.webhook.signature);
    return { submitted: true };
  }

  private requireSandbox() {
    if (!this.p.provider.isSandbox) throw new DomainError('NOT_FOUND', 'Not found', 404);
  }
}

async function issueToken(jwt: JwtService, p: Platform, userId: string, role: string, session: { id: string; expiresAt: Date }) {
  const ttl = Math.max(1, Math.floor((session.expiresAt.getTime() - p.auth.now().getTime()) / 1000));
  return jwt.signAsync({ sub: userId, sid: session.id, role }, { expiresIn: ttl });
}

const factorSchema = z
  .object({ code: z.string().min(6).max(8).optional(), recoveryCode: z.string().min(8).max(16).optional() })
  .refine((v) => (v.code === undefined) !== (v.recoveryCode === undefined), 'provide exactly one of code or recoveryCode');

// ------------------------------------------------------------------ session + MFA (any authenticated session, even before MFA)
@Controller('auth')
@UseGuards(AuthGuard)
@AllowPendingMfa()
export class AuthController {
  constructor(@Inject(PLATFORM) private readonly p: Platform, @Inject(JWT) private readonly jwt: JwtService) {}

  @Post('logout')
  async logout(@Req() req: any) {
    await this.p.auth.logout(req.session);
    return { ok: true };
  }

  @Get('mfa/status')
  status(@Req() req: any) {
    return this.p.mfa.status(req.session);
  }

  @Post('mfa/enrol/start')
  @Throttle({ default: { limit: () => RATE_LIMITS.mfa, ttl: 60_000 } })
  startEnrol(@Req() req: any) {
    return this.p.mfa.startEnrol(req.session);
  }

  @Post('mfa/enrol/confirm')
  @Throttle({ default: { limit: () => RATE_LIMITS.mfa, ttl: 60_000 } })
  async confirmEnrol(@Req() req: any, @Body() body: unknown) {
    const b = parse(z.object({ code: z.string().min(6).max(8) }), body);
    const r = await this.p.mfa.confirmEnrol(req.session, b.code);
    return { token: await issueToken(this.jwt, this.p, req.session.userId, req.session.role, r.session), recoveryCodes: r.recoveryCodes, note: 'Store these recovery codes offline now; they are shown only once.' };
  }

  @Post('mfa/challenge')
  @Throttle({ default: { limit: () => RATE_LIMITS.mfa, ttl: 60_000 } })
  async challenge(@Req() req: any, @Body() body: unknown) {
    const r = await this.p.mfa.challenge(req.session, parse(factorSchema, body));
    return { token: await issueToken(this.jwt, this.p, req.session.userId, req.session.role, r.session), method: r.method, recoveryCodesRemaining: r.remainingCodes };
  }

  @Post('mfa/step-up')
  @Throttle({ default: { limit: () => RATE_LIMITS.mfa, ttl: 60_000 } })
  stepUp(@Req() req: any, @Body() body: unknown) {
    return this.p.mfa.stepUp(req.session, parse(factorSchema, body));
  }

  @Post('mfa/recovery-codes/regenerate')
  async regenerate(@Req() req: any) {
    return { recoveryCodes: await this.p.mfa.regenerateRecoveryCodes(req.session) };
  }
}

// ------------------------------------------------------------------ merchant
@Controller('merchant')
@UseGuards(AuthGuard)
@Roles('MERCHANT')
export class MerchantController {
  constructor(@Inject(PLATFORM) private readonly p: Platform) {}

  // Object-level authorisation: the merchant id ALWAYS comes from the verified token, never from the request.
  private mid(req: { user: AuthUser }): string {
    if (!req.user.merchantId) throw new DomainError('FORBIDDEN', 'No merchant context', 403);
    return req.user.merchantId;
  }

  @Get('me')
  async me(@Req() req: any) {
    const id = this.mid(req);
    const m = await this.p.merchants.get(id);
    const dests = await this.p.db.query('SELECT id, label, masked_account, status, created_at FROM merchant_settlement_destinations WHERE merchant_id=$1 ORDER BY created_at', [id]);
    const [vc] = await this.p.db.query('SELECT status, notes FROM merchant_verification_cases WHERE merchant_id=$1 ORDER BY created_at DESC LIMIT 1', [id]);
    return { id, displayName: m.display_name, legalName: m.legal_name, status: m.status, feeBps: m.fee_bps, verification: vc, destinations: dests };
  }

  @Post('destinations')
  @StepUp({ ifEnrolled: true })
  async addDestination(@Req() req: any, @Body() body: unknown) {
    const b = parse(z.object({ label: z.string().min(1).max(60), providerDestinationRef: z.string().min(3).max(100), maskedAccount: z.string().regex(/^[X*\d]{4,20}$/, 'send only a masked account (e.g. XXXX1234)') }), body);
    return { id: await this.p.merchants.addDestination(this.mid(req), b, req.user), status: 'PENDING' };
  }

  @Post('destinations/upi')
  @StepUp({ ifEnrolled: true })
  async addUpiDestination(@Req() req: any, @Body() body: unknown) {
    const b = parse(z.object({ vpa: z.string().min(5).max(80) }), body);
    const r = await this.p.merchants.addUpiDestination(this.mid(req), b.vpa, req.user);
    return { id: r.id, maskedVpa: r.maskedVpa, beneficiaryName: r.beneficiaryName, status: 'PENDING', note: 'An administrator must verify this UPI ID before payouts can use it.' };
  }

  @Post('payment-requests')
  async createRequest(@Req() req: any, @Body() body: unknown) {
    const b = parse(z.object({ orderReference: z.string().min(1).max(100), description: z.string().max(500).optional(), amountMinor: z.number().int(), currency: z.string().length(3).optional(), expiresInMinutes: z.number().int().min(1).max(60 * 24 * 30).optional() }), body);
    const r = await this.p.requests.create(this.mid(req), b, req.user);
    return { id: r.id, status: r.status, checkoutUrl: r.checkoutUrl, publicToken: r.public_token, sandbox: r.is_sandbox };
  }

  @Get('payment-requests')
  list(@Req() req: any, @Query() q: Record<string, string>) {
    const { limit, offset } = page(q);
    return this.p.db.query(
      `SELECT id, order_reference, description, amount_minor, currency, status, expires_at, public_token, is_sandbox, created_at
         FROM payment_requests WHERE merchant_id=$1 AND ($2::text IS NULL OR status=$2) ORDER BY created_at DESC LIMIT $3 OFFSET $4`,
      [this.mid(req), q.status ?? null, limit, offset],
    );
  }

  @Post('payment-requests/:id/cancel')
  async cancel(@Req() req: any, @Param('id') id: string) {
    await this.p.requests.cancel(this.mid(req), parse(uuid, id), req.user);
    return { status: 'CANCELLED' };
  }

  @Get('payments')
  payments(@Req() req: any, @Query() q: Record<string, string>) {
    const { limit, offset } = page(q);
    return this.p.db.query(
      `SELECT pm.id, pr.order_reference, pm.amount_minor, pm.fee_minor, pm.net_minor, pm.currency, pm.status, pm.provider_payment_id,
              pm.verification_result, pm.refunded_minor, pm.is_sandbox, pm.created_at
         FROM payments pm LEFT JOIN payment_requests pr ON pr.id = pm.payment_request_id
        WHERE pm.merchant_id=$1 AND ($2::text IS NULL OR pm.status=$2)
          AND ($3::text IS NULL OR pr.order_reference ILIKE '%' || $3 || '%' OR pm.provider_payment_id ILIKE '%' || $3 || '%')
        ORDER BY pm.created_at DESC LIMIT $4 OFFSET $5`,
      [this.mid(req), q.status ?? null, q.search ?? null, limit, offset],
    );
  }

  @Get('payments/:id')
  async payment(@Req() req: any, @Param('id') id: string) {
    const [p] = await this.p.db.query<any>('SELECT * FROM payments WHERE id=$1 AND merchant_id=$2', [parse(uuid, id), this.mid(req)]);
    if (!p) throw new DomainError('NOT_FOUND', 'Payment not found', 404);
    const refunds = await this.p.db.query('SELECT id, amount_minor, status, created_at FROM refunds WHERE payment_id=$1', [id]);
    return { ...p, refunds };
  }

  @Get('payments.csv')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  async csv(@Req() req: any) {
    const rows = await this.p.db.query<any>(
      `SELECT pm.created_at, pr.order_reference, pm.provider_payment_id, pm.amount_minor, pm.fee_minor, pm.net_minor, pm.currency, pm.status, pm.is_sandbox
         FROM payments pm LEFT JOIN payment_requests pr ON pr.id = pm.payment_request_id WHERE pm.merchant_id=$1 ORDER BY pm.created_at DESC LIMIT 10000`,
      [this.mid(req)],
    );
    const esc = (v: unknown) => {
      let s = v instanceof Date ? v.toISOString() : String(v ?? '');
      if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // neutralise spreadsheet formula injection
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const head = 'created_at,order_reference,provider_payment_id,amount_minor,fee_minor,net_minor,currency,status,sandbox';
    return [head, ...rows.map((r) => Object.values(r).map(esc).join(','))].join('\n');
  }

  @Get('balance')
  async balance(@Req() req: any) {
    const id = this.mid(req);
    const b = await this.p.payouts.availableBalance(this.p.db, id);
    const [t] = await this.p.db.query<any>(
      `SELECT COALESCE(SUM(amount_minor) FILTER (WHERE status IN ('SUCCEEDED','PARTIALLY_REFUNDED','REFUNDED')),0) AS gross,
              COALESCE(SUM(fee_minor) FILTER (WHERE status IN ('SUCCEEDED','PARTIALLY_REFUNDED','REFUNDED')),0) AS fees FROM payments WHERE merchant_id=$1`,
      [id],
    );
    const [inflight] = await this.p.db.query<any>(`SELECT COALESCE(SUM(amount_minor),0) AS s FROM payouts WHERE merchant_id=$1 AND status IN ('QUEUED','SUBMITTED','PROCESSING','UNDER_REVIEW')`, [id]);
    const [paid] = await this.p.db.query<any>(`SELECT COALESCE(SUM(amount_minor),0) AS s FROM payouts WHERE merchant_id=$1 AND status='SUCCEEDED'`, [id]);
    return { grossCollectionsMinor: t.gross, platformFeesMinor: t.fees, payableMinor: b.payable, heldMinor: b.held, availableMinor: b.available, payoutsInFlightMinor: inflight.s, payoutsCompletedMinor: paid.s, currency: 'INR' };
  }

  @Post('payouts')
  async requestPayout(@Req() req: any, @Body() body: unknown, @Headers('idempotency-key') headerKey?: string) {
    const b = parse(z.object({ amountMinor: z.number().int().positive().optional(), idempotencyKey: z.string().min(8).max(128).optional() }), body);
    const key = b.idempotencyKey ?? headerKey;
    if (!key) throw new BadRequestException('Idempotency-Key header or idempotencyKey is required');
    const p = await this.p.payouts.request(this.mid(req), { amountMinor: b.amountMinor, idempotencyKey: key }, req.user);
    return { id: p.id, status: p.status, amountMinor: p.amount_minor, sandbox: p.is_sandbox };
  }

  @Get('payouts')
  payouts(@Req() req: any, @Query() q: Record<string, string>) {
    const { limit, offset } = page(q);
    return this.p.db.query(
      `SELECT id, amount_minor, currency, status, provider_payout_id, failure_reason, is_sandbox, created_at, updated_at FROM payouts WHERE merchant_id=$1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
      [this.mid(req), limit, offset],
    );
  }

  @Get('notifications')
  notifications(@Req() req: any) {
    return this.p.db.query('SELECT id, kind, payload, created_at FROM notification_jobs WHERE merchant_id=$1 ORDER BY id DESC LIMIT 50', [this.mid(req)]);
  }
}

// ------------------------------------------------------------------ admin
@Controller('admin')
@UseGuards(AuthGuard)
@Roles('ADMIN')
export class AdminController {
  constructor(@Inject(PLATFORM) private readonly p: Platform) {}

  // ------------------------------------------------------------------ UPI collections confirmed by bank-credit emails
  @Get('devices')
  devices() {
    return this.p.devices.list();
  }

  @Post('devices')
  @StepUp()
  async createDevice(@Req() req: any, @Body() body: unknown) {
    const b = parse(z.object({ name: z.string().min(2).max(60) }), body);
    return this.p.devices.create(req.user, b.name);
  }

  @Post('devices/:id/revoke')
  @StepUp()
  async revokeDevice(@Req() req: any, @Param('id') id: string) {
    await this.p.devices.revoke(req.user, parse(uuid, id));
    return { ok: true };
  }

  @Get('collections/dashboard')
  collectionsDashboard() {
    return this.p.collections.dashboard();
  }

  @Get('collections/orders')
  collectionOrders(@Query() q: Record<string, string>) {
    return this.p.collections.orders(q.status);
  }

  @Post('collections/orders')
  async createCollectionOrder(@Req() req: any, @Body() body: unknown) {
    const b = parse(z.object({ merchantId: z.string().uuid().optional(), payeeVpa: z.string().min(5).max(80), amountMinor: z.number().int(), description: z.string().max(500).optional(), expiresInMinutes: z.number().int().min(1).max(60 * 24 * 30).optional(), orderReference: z.string().min(1).max(100).optional(), uniqueAmount: z.boolean().optional() }), body);
    let merchantId = b.merchantId;
    if (!merchantId) {
      const [own] = await this.p.db.query<any>(`SELECT id FROM merchants WHERE legal_name='Owner collections'`);
      merchantId = own?.id ?? (await this.p.db.query<any>(`INSERT INTO merchants(legal_name, display_name, status) VALUES ('Owner collections','Owner collections','ACTIVE') RETURNING id`))[0].id;
    }
    const r = await this.p.requests.create(merchantId!, { orderReference: b.orderReference ?? `ORD-${Date.now().toString(36).toUpperCase()}`, amountMinor: b.amountMinor, description: b.description, expiresInMinutes: b.expiresInMinutes, payeeVpa: b.payeeVpa, uniqueAmount: b.uniqueAmount }, req.user);
    return { id: r.id, orderId: r.provider_order_id, status: r.status, amountMinor: Number(r.amount_minor), baseAmountMinor: r.base_amount_minor === null ? null : Number(r.base_amount_minor), upiLink: r.qr_payload, qrImage: await QRCode.toDataURL(r.qr_payload, { errorCorrectionLevel: 'M', margin: 2 }), publicToken: r.public_token, expiresAt: r.expires_at, payeeVpa: r.payee_vpa };
  }

  @Get('collections/credits')
  collectionCredits(@Query() q: Record<string, string>) {
    return this.p.collections.credits(q.status);
  }

  @Post('collections/credits/:id/assign')
  @StepUp()
  async assignCredit(@Req() req: any, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(z.object({ orderId: z.string().uuid(), note: z.string().min(10).max(500) }), body);
    await this.p.collections.assignCredit(req.user, parse(uuid, id), b.orderId, b.note);
    return { ok: true };
  }

  @Post('collections/credits/:id/dismiss')
  @StepUp()
  async dismissCredit(@Req() req: any, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(z.object({ note: z.string().min(10).max(500) }), body);
    await this.p.collections.dismissCredit(req.user, parse(uuid, id), b.note);
    return { ok: true };
  }

  @Get('collections/attestations')
  attestations() {
    return this.p.collections.attestations();
  }

  @Post('collections/attestations')
  @StepUp()
  async proposeAttestation(@Req() req: any, @Body() body: unknown) {
    const b = parse(z.object({ orderId: z.string().uuid(), reference: z.string().min(6).max(64), creditedAt: z.string().datetime({ offset: true }), note: z.string().min(10).max(500) }), body);
    return this.p.collections.proposeAttestation(req.user, b.orderId, b.reference, new Date(b.creditedAt), b.note);
  }

  @Post('collections/attestations/:id/decision')
  @StepUp()
  async decideAttestation(@Req() req: any, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(z.object({ decision: z.enum(['APPLY', 'REJECT']) }), body);
    return this.p.collections.decideAttestation(req.user, parse(uuid, id), b.decision);
  }

  @Get('mailbox/status')
  mailboxStatus() {
    return this.p.mailbox.status();
  }

  @Post('mailbox/connect')
  @StepUp()
  connectMailbox(@Req() req: any) {
    return this.p.mailbox.beginConnect(req.user);
  }

  @Post('mailbox/disconnect')
  @StepUp()
  async disconnectMailbox(@Req() req: any) {
    await this.p.mailbox.disconnect(req.user);
    return { ok: true };
  }

  @Post('mailbox/sync')
  @Throttle({ default: { limit: 6, ttl: 60_000 } })
  async syncMailbox() {
    return { processed: await this.p.mailbox.sync() };
  }

  @Get('mailbox/messages')
  mailMessages() {
    return this.p.collections.messages();
  }

  @Get('mailbox/messages/:id/text')
  @StepUp()
  mailText(@Req() req: any, @Param('id') id: string) {
    return this.p.collections.messageText(parse(uuid, id), req.user);
  }

  /** Runs a real .eml through the FULL pipeline (DKIM, allowlist, template, matching). Sandbox use: testing with a bank email you saved. */
  @Post('mailbox/ingest-eml')
  @StepUp()
  async ingestEml(@Req() req: any, @Body() body: unknown) {
    const b = parse(z.object({ emlBase64: z.string().min(50).max(600_000) }), body);
    return this.p.mailbox.ingestUploaded(Buffer.from(b.emlBase64, 'base64'), req.user);
  }

  @Get('alert-templates')
  alertTemplates() {
    return this.p.alertTemplates.list();
  }

  @Post('alert-templates')
  @StepUp()
  createTemplate(@Req() req: any, @Body() body: unknown) {
    const b = parse(z.object({ name: z.string().min(2).max(80), bankName: z.string().min(2).max(80), definition: z.record(z.string(), z.any()) }), body);
    return this.p.alertTemplates.create(req.user, b);
  }

  /** Dry run: parses the sample with the definition; credits nothing. */
  @Post('alert-templates/test')
  testTemplate(@Body() body: unknown) {
    const b = parse(z.object({ definition: z.record(z.string(), z.any()), subject: z.string().max(300).default(''), text: z.string().min(1).max(40_000) }), body);
    return this.p.alertTemplates.testDefinition(b.definition, { subject: b.subject, text: b.text });
  }

  @Post('alert-templates/:id/validate')
  @StepUp()
  validateTemplate(@Req() req: any, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(z.object({ subject: z.string().max(300).default(''), text: z.string().min(1).max(40_000) }), body);
    return this.p.alertTemplates.validateWithSample(req.user, parse(uuid, id), b);
  }

  @Post('alert-templates/:id/activate')
  @StepUp()
  async activateTemplate(@Req() req: any, @Param('id') id: string) {
    await this.p.alertTemplates.activate(req.user, parse(uuid, id));
    return { ok: true };
  }

  @Post('alert-templates/:id/disable')
  @StepUp()
  async disableTemplate(@Req() req: any, @Param('id') id: string) {
    await this.p.alertTemplates.disable(req.user, parse(uuid, id));
    return { ok: true };
  }

  @Get('overview')
  async overview() {
    const one = async (sql: string) => (await this.p.db.query<any>(sql))[0];
    const merchants = await this.p.db.query<any>('SELECT status, COUNT(*)::int AS n FROM merchants GROUP BY status');
    const today = await one(`SELECT COUNT(*)::int n, COALESCE(SUM(amount_minor),0) AS volume, COALESCE(SUM(fee_minor),0) AS fees FROM payments WHERE status IN ('SUCCEEDED','PARTIALLY_REFUNDED','REFUNDED') AND created_at >= date_trunc('day', now())`);
    const review = await one(`SELECT COUNT(*)::int n FROM payments WHERE status='UNDER_REVIEW'`);
    const inflight = await one(`SELECT COUNT(*)::int n, COALESCE(SUM(amount_minor),0) AS amount FROM payouts WHERE status IN ('QUEUED','SUBMITTED','PROCESSING','UNDER_REVIEW')`);
    const reviews = await one(`SELECT COUNT(*)::int n FROM risk_reviews WHERE status='OPEN'`);
    const alerts = await one(`SELECT COUNT(*)::int n FROM alerts WHERE created_at > now() - interval '24 hours'`);
    const cases = await one(`SELECT COUNT(*)::int n FROM merchant_verification_cases WHERE status IN ('SUBMITTED','INFO_REQUIRED')`);
    const dests = await one(`SELECT COUNT(*)::int n FROM merchant_settlement_destinations WHERE status='PENDING'`);
    return {
      merchantsByStatus: Object.fromEntries(merchants.map((m) => [m.status, m.n])),
      today: { payments: today.n, volumeMinor: today.volume, feesMinor: today.fees },
      paymentsUnderReview: review.n,
      payoutsInFlight: { count: inflight.n, amountMinor: inflight.amount },
      openRiskReviews: reviews.n,
      alertsLast24h: alerts.n,
      pendingVerificationCases: cases.n,
      pendingDestinations: dests.n,
      recovery: await this.p.recovery.status(),
    };
  }

  @Get('merchants')
  merchants(@Query() q: Record<string, string>) {
    const { limit, offset } = page(q);
    return this.p.db.query(`SELECT id, legal_name, display_name, status, fee_bps, created_at FROM merchants WHERE ($1::text IS NULL OR status=$1) ORDER BY created_at DESC LIMIT $2 OFFSET $3`, [q.status ?? null, limit, offset]);
  }

  @Get('verification-cases')
  cases() {
    return this.p.db.query(`SELECT c.id, c.merchant_id, c.status, c.notes, m.legal_name, c.created_at FROM merchant_verification_cases c JOIN merchants m ON m.id=c.merchant_id ORDER BY c.created_at DESC LIMIT 200`);
  }

  @Post('verification-cases/:id/decision')
  @StepUp()
  async decide(@Req() req: any, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(z.object({ decision: z.enum(['APPROVED', 'REJECTED']), notes: z.string().max(500).optional() }), body);
    await this.p.merchants.decideVerification(parse(uuid, id), b.decision, req.user, b.notes);
    return { ok: true };
  }

  @Get('destinations')
  async destinations(@Query() q: Record<string, string>) {
    const rows = await this.p.db.query<any>(
      `SELECT d.id, d.merchant_id, m.legal_name, d.beneficiary_kind, d.masked_account, d.beneficiary_name, d.status, d.created_at,
              EXISTS (SELECT 1 FROM risk_reviews r WHERE r.subject_type='destination' AND r.subject_id=d.id::text AND r.status='OPEN') AS open_review
         FROM merchant_settlement_destinations d JOIN merchants m ON m.id=d.merchant_id WHERE ($1::text IS NULL OR d.status=$1) ORDER BY d.created_at DESC LIMIT 200`,
      [q.status ?? null],
    );
    return rows.map((r) => ({ ...r, nameMatches: r.beneficiary_name ? nameMatches(r.legal_name, r.beneficiary_name) : null }));
  }

  @Post('destinations/:id/verify')
  @StepUp()
  async verifyDest(@Req() req: any, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(z.object({ confirmReview: z.boolean().optional() }), body ?? {});
    await this.p.merchants.verifyDestination(parse(uuid, id), req.user, { confirmReview: b.confirmReview });
    return { ok: true };
  }

  @Post('merchants/:id/status')
  @StepUp()
  async setStatus(@Req() req: any, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(z.object({ status: z.enum(['ACTIVE', 'SUSPENDED']), reason: z.string().max(500).optional() }), body);
    await this.p.merchants.setStatus(parse(uuid, id), b.status, req.user, b.reason);
    return { ok: true };
  }

  @Get('payments')
  payments(@Query() q: Record<string, string>) {
    const { limit, offset } = page(q);
    return this.p.db.query(`SELECT * FROM payments WHERE ($1::text IS NULL OR status=$1) ORDER BY created_at DESC LIMIT $2 OFFSET $3`, [q.status ?? null, limit, offset]);
  }

  @Get('payments/:id/events')
  events(@Param('id') id: string) {
    return this.p.db.query('SELECT * FROM payment_events WHERE payment_id=$1 ORDER BY id', [parse(uuid, id)]);
  }

  @Get('webhook-events')
  webhooks(@Query() q: Record<string, string>) {
    return this.p.db.query(`SELECT id, provider_event_id, event_type, status, attempts, last_error, received_at FROM webhook_events WHERE ($1::text IS NULL OR status=$1) ORDER BY received_at DESC LIMIT 200`, [q.status ?? null]);
  }

  @Get('payouts')
  payouts(@Query() q: Record<string, string>) {
    const { limit, offset } = page(q);
    return this.p.db.query(`SELECT * FROM payouts WHERE ($1::text IS NULL OR status=$1) ORDER BY created_at DESC LIMIT $2 OFFSET $3`, [q.status ?? null, limit, offset]);
  }

  @Post('payouts/:id/approve')
  @StepUp()
  async approve(@Req() req: any, @Param('id') id: string) {
    await this.p.payouts.approve(parse(uuid, id), req.user);
    return { ok: true };
  }

  @Post('payouts/:id/reject')
  @StepUp()
  async reject(@Req() req: any, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(z.object({ reason: z.string().min(3).max(500) }), body);
    await this.p.payouts.reject(parse(uuid, id), req.user, b.reason);
    return { ok: true };
  }

  @Post('payouts/:id/retry')
  @StepUp()
  async retry(@Req() req: any, @Param('id') id: string) {
    await this.p.payouts.retryUnknown(parse(uuid, id), req.user);
    return { ok: true };
  }

  @Post('payments/:id/refund')
  @StepUp()
  async refund(@Req() req: any, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(z.object({ amountMinor: z.number().int().positive(), idempotencyKey: z.string().min(8).max(128), reason: z.string().max(500).optional() }), body);
    const r = await this.p.refunds.request(parse(uuid, id), b, req.user);
    return { id: r.id, status: r.status };
  }

  @Post('payments/:id/approve-review')
  @StepUp()
  async approveReview(@Req() req: any, @Param('id') id: string) {
    await this.p.verification.approveReviewedPayment(parse(uuid, id), req.user);
    return { ok: true };
  }

  @Get('risk-reviews')
  reviews() {
    return this.p.db.query(`SELECT * FROM risk_reviews WHERE status='OPEN' ORDER BY created_at DESC LIMIT 200`);
  }

  @Get('alerts')
  alerts() {
    return this.p.db.query('SELECT * FROM alerts ORDER BY id DESC LIMIT 200');
  }

  @Get('audit-logs')
  audit(@Query() q: Record<string, string>) {
    const { limit, offset } = page(q);
    return this.p.db.query('SELECT id, actor_id, actor_role, action, subject_type, subject_id, detail, created_at FROM audit_logs ORDER BY id DESC LIMIT $1 OFFSET $2', [limit, offset]);
  }

  @Post('reconciliation/run')
  async reconcile() {
    const r = await this.p.reconciliation.run();
    return { runId: r.runId, checked: r.checked, discrepancies: r.discrepancies, items: r.items };
  }

  @Get('reconciliation/runs')
  runs() {
    return this.p.db.query('SELECT * FROM reconciliation_runs ORDER BY created_at DESC LIMIT 50');
  }

  @Get('jobs/dead')
  dead() {
    return this.p.db.query(`SELECT id, kind, attempts, last_error, created_at FROM jobs WHERE status='DEAD' ORDER BY id DESC LIMIT 200`);
  }

  @Post('jobs/:id/replay')
  @StepUp()
  async replay(@Req() req: any, @Param('id') id: string) {
    await this.p.jobs.replayDead(Number(parse(z.coerce.number().int().positive(), id)));
    await this.p.db.transaction((tx) => this.p.audit.record(tx, req.user, 'job.replayed', 'job', id));
    return { ok: true };
  }

  @Get('mfa-recovery-requests')
  recoveryRequests() {
    return this.p.mfa.listRecoveryRequests();
  }

  @Post('mfa-recovery-requests/:id/approve')
  @StepUp()
  async approveRecovery(@Req() req: any, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(z.object({ note: z.string().min(10).max(500) }), body);
    const r = await this.p.mfa.approveRecovery(req.session, parse(uuid, id), b.note);
    return { ok: true, executeAfter: r.executeAfter };
  }

  @Post('mfa-recovery-requests/:id/reject')
  @StepUp()
  async rejectRecovery(@Req() req: any, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(z.object({ note: z.string().min(3).max(500) }), body);
    await this.p.mfa.rejectRecovery(req.session, parse(uuid, id), b.note);
    return { ok: true };
  }

  @Get('recovery/status')
  recoveryStatus() {
    return this.p.recovery.status();
  }

  @Post('recovery/freeze')
  @StepUp()
  async freeze(@Req() req: any, @Body() body: unknown) {
    const b = parse(z.object({ reason: z.string().min(5).max(300) }), body);
    return { frozen: await this.p.recovery.freeze(req.user, b.reason) };
  }

  @Post('recovery/payouts/:id/resolve')
  @StepUp()
  async resolveHeld(@Req() req: any, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(z.object({ outcome: z.enum(['sync', 'confirmed_not_sent']), note: z.string().max(500).default('') }), body);
    await this.p.recovery.resolveHeldPayout(req.user, parse(uuid, id), b.outcome, b.note);
    return { ok: true };
  }

  @Post('recovery/unfreeze')
  @StepUp()
  unfreeze(@Req() req: any) {
    return this.p.recovery.unfreeze(req.user);
  }

  @Get('recovery/adoptions')
  adoptions() {
    return this.p.recovery.listAdoptions();
  }

  @Post('recovery/adoptions')
  @StepUp()
  async proposeAdoption(@Req() req: any, @Body() body: unknown) {
    const b = parse(z.object({ providerPayoutId: z.string().min(3).max(100), merchantId: z.string().uuid(), note: z.string().min(10).max(500) }), body);
    return this.p.recovery.proposeAdoption(req.user, b.providerPayoutId, b.merchantId, b.note);
  }

  @Post('recovery/adoptions/:id/decision')
  @StepUp()
  async decideAdoption(@Req() req: any, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(z.object({ decision: z.enum(['APPLY', 'REJECT']) }), body);
    return this.p.recovery.decideAdoption(req.user, parse(uuid, id), b.decision);
  }

  @Get('health')
  async health() {
    const [j] = await this.p.db.query<any>(`SELECT COUNT(*) FILTER (WHERE status='PENDING' AND run_at < now() - interval '5 minutes') AS late, COUNT(*) FILTER (WHERE status='DEAD') AS dead FROM jobs`);
    return { database: 'ok', provider: this.p.provider.name, sandbox: this.p.provider.isSandbox, lateJobs: Number(j.late), deadJobs: Number(j.dead), unbalancedJournals: (await this.p.ledger.findUnbalancedJournals(this.p.db)).length, auditChainValid: await this.p.audit.verifyChain(this.p.db) };
  }
}

function page(q: Record<string, string>) {
  const limit = Math.min(Math.max(parseInt(q.limit ?? '25', 10) || 25, 1), 100);
  const offset = Math.max(parseInt(q.offset ?? '0', 10) || 0, 0);
  return { limit, offset };
}
