import { randomUUID } from 'crypto';
import { migrate } from '../src/db/db';
import { PgliteDb } from '../src/db/pglite.db';
import { PgDb } from '../src/db/pg.db';
import { Db } from '../src/db/db';
import { Client } from 'pg';
import { createPlatform, Platform } from '../src/platform';
import { SandboxProvider } from '../src/provider/sandbox.provider';
import { Actor } from '../src/audit/audit.service';
import { merchantPayable } from '../src/ledger/ledger.service';
import { SecurityOptions } from '../src/auth/auth.service';
import { stepAt, totpAt } from '../src/auth/totp';
import { randomBytes } from 'crypto';

export const WEBHOOK_SECRET = 'test-webhook-secret-123456';

export interface Ctx {
  p: Platform;
  provider: SandboxProvider;
  db: Db;
  admin: Actor;
  admin2: Actor;
  security: SecurityOptions;
  /** Moves the auth clock (and TOTP time) forward. */
  advance(ms: number): void;
  nowMs(): number;
  /** A valid TOTP code for `secret` that has not been used before in this ctx (advances the clock if needed). */
  freshCode(secret: string): string;
}

export const testSecurity = (clock: () => Date): SecurityOptions => ({
  mfaKey: randomBytes(32),
  issuer: 'GatewayTest',
  stepUpWindowSeconds: 300,
  recoveryDelayHours: 24,
  requiredRoles: ['ADMIN'],
  sessionTtlMinutes: 60,
  maxMfaAttempts: 5,
  mfaLockMinutes: 15,
  maxLoginAttempts: 5,
  loginLockMinutes: 15,
  clock,
});

export async function setup(): Promise<Ctx> {
  const db = await openTestDb();
  await migrate(db);
  const provider = new SandboxProvider(WEBHOOK_SECRET);
  let offset = 0;
  const nowMs = () => Date.now() + offset;
  const security = testSecurity(() => new Date(nowMs()));
  const p = createPlatform(db, provider, security);
  const lastStep = new Map<string, number>();
  const advance = (ms: number) => {
    offset += ms;
  };
  const freshCode = (secret: string) => {
    const last = lastStep.get(secret) ?? 0;
    if (stepAt(nowMs()) <= last) advance((last + 1) * 30_000 - nowMs() + 1000);
    lastStep.set(secret, stepAt(nowMs()));
    return totpAt(secret, nowMs());
  };
  const admin = await makeAdmin(db, 'admin1@example.test');
  const admin2 = await makeAdmin(db, 'admin2@example.test');
  return { p, provider, db, admin, admin2, security, advance, nowMs, freshCode };
}

/**
 * Default: in-process PostgreSQL (PGlite). With TEST_PG_URL set (admin URL of a real PostgreSQL cluster) every test gets its own
 * database on that cluster instead, so the whole suite can be run against a real, e.g. restored, server.
 */
async function openTestDb(): Promise<Db> {
  const admin = process.env.TEST_PG_URL;
  if (!admin) return PgliteDb.open();
  const name = `t_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const c = new Client({ connectionString: admin });
  await c.connect();
  await c.query(`CREATE DATABASE ${name}`);
  await c.end();
  const url = new URL(admin);
  url.pathname = `/${name}`;
  const inner = new PgDb(url.toString());
  const close = inner.close.bind(inner);
  inner.close = async () => {
    await close();
    const d = new Client({ connectionString: admin });
    await d.connect();
    await d.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await d.end();
  };
  return inner;
}

async function makeAdmin(db: Db, email: string): Promise<Actor> {
  const [u] = await db.query<{ id: string }>(`INSERT INTO users(email, password_hash, role) VALUES ($1,'x','ADMIN') RETURNING id`, [email]);
  return { id: u.id, role: 'ADMIN' };
}

/** Registers, verifies and gives a merchant a verified settlement destination. */
export async function seedMerchant(ctx: Ctx, opts: { feeBps?: number; holdHours?: number; reviewThreshold?: number; name?: string } = {}) {
  const email = `m-${randomUUID().slice(0, 8)}@example.test`;
  const reg = await ctx.p.merchants.register({ email, passwordHash: 'x', legalName: opts.name ?? 'Test Traders Pvt Ltd', displayName: opts.name ?? 'Test Traders' });
  await ctx.p.merchants.decideVerification(reg.verificationCaseId, 'APPROVED', ctx.admin);
  const destId = await ctx.p.merchants.addDestination(
    reg.merchantId,
    { label: 'Primary', providerDestinationRef: `fa_sbx_${randomUUID().slice(0, 8)}`, maskedAccount: 'XXXX1234' },
    { id: reg.userId, role: 'MERCHANT', merchantId: reg.merchantId },
  );
  await ctx.p.merchants.verifyDestination(destId, ctx.admin);
  await ctx.db.query(
    `UPDATE merchants SET fee_bps=$2, settlement_hold_hours=$3, review_threshold_minor=$4 WHERE id=$1`,
    [reg.merchantId, opts.feeBps ?? 200, opts.holdHours ?? 0, opts.reviewThreshold ?? 5_000_000],
  );
  const actor: Actor = { id: reg.userId, role: 'MERCHANT', merchantId: reg.merchantId };
  return { merchantId: reg.merchantId, userId: reg.userId, actor, destId };
}

export async function createRequest(ctx: Ctx, m: { merchantId: string; actor: Actor }, amountMinor: number, ref = `ORD-${randomUUID().slice(0, 8)}`) {
  return ctx.p.requests.create(m.merchantId, { orderReference: ref, amountMinor, description: 'test order' }, m.actor);
}

/** Full happy path: request -> customer pays (simulated) -> signed webhook -> worker verifies. */
export async function collect(ctx: Ctx, m: { merchantId: string; actor: Actor }, amountMinor: number) {
  const req = await createRequest(ctx, m, amountMinor);
  const sim = ctx.provider.simulateCustomerPayment(req.provider_order_id);
  await ctx.p.verification.ingestWebhook(sim.webhook.body, sim.webhook.signature);
  await ctx.p.jobs.drain(ctx.p.handlers);
  const [payment] = await ctx.db.query<any>('SELECT * FROM payments WHERE provider_payment_id=$1', [sim.payment.id]);
  return { req, sim, payment };
}

export const payableOf = (ctx: Ctx, merchantId: string) => ctx.p.ledger.balance(ctx.db, merchantPayable(merchantId));
export const farFuture = () => new Date(Date.now() + 7 * 24 * 3600 * 1000);
