import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { createApp } from '../src/app';
import { hashPassword } from '../src/auth/password';
import { base32Decode, hotp, stepAt, totpAt } from '../src/auth/totp';
import { Ctx, setup } from './helpers';

const PW = 'correct-horse-battery';
const JWT_SECRET = 'j'.repeat(40);
let ctx: Ctx;
let app: INestApplication;
let http: ReturnType<typeof request>;
let pwHash: string;

/** Everything secret that flows through the tests; asserted absent from logs, audit and alerts at the end. */
const sensitive: string[] = [];
const captured: string[] = [];
const restore: Array<() => void> = [];

beforeAll(async () => {
  for (const [obj, name] of [[console, 'log'], [console, 'error'], [console, 'warn'], [console, 'info'], [process.stdout, 'write'], [process.stderr, 'write']] as const) {
    const orig = (obj as any)[name].bind(obj);
    (obj as any)[name] = (...args: unknown[]) => {
      captured.push(args.map(String).join(' '));
      return orig(...args);
    };
    restore.push(() => ((obj as any)[name] = orig));
  }
  ctx = await setup();
  app = await createApp({ platform: ctx.p, jwtSecret: JWT_SECRET, rateLimits: { auth: 1000, mfa: 1000, recovery: 1000, global: 10000 } });
  await app.init();
  http = request(app.getHttpServer());
  pwHash = await hashPassword(PW);
});
afterAll(async () => {
  restore.forEach((r) => r());
  await app.close();
  await ctx.db.close();
});

const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
const sidOf = (t: string) => JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString()).sid as string;
let n = 0;
const mkUser = async (role = 'ADMIN') => {
  const email = `u-${role.toLowerCase()}-${++n}@example.test`;
  await ctx.db.query(`INSERT INTO users(email, password_hash, role) VALUES ($1,$2,$3)`, [email, pwHash, role]);
  return email;
};
const loginRaw = (email: string, password = PW) => http.post('/auth/login').send({ email, password });
const code = (secret: string) => {
  const c = ctx.freshCode(secret);
  sensitive.push(c);
  return c;
};

/** Full enrolment through the HTTP API. Returns the secret, recovery codes and a verified token. */
async function enrol(email: string) {
  const l = await loginRaw(email).expect(201);
  expect(l.body.mfa).toBe('ENROL_REQUIRED');
  const st = await http.post('/auth/mfa/enrol/start').set(bearer(l.body.token)).expect(201);
  sensitive.push(st.body.secret);
  const c = await http.post('/auth/mfa/enrol/confirm').set(bearer(l.body.token)).send({ code: code(st.body.secret) }).expect(201);
  sensitive.push(...c.body.recoveryCodes);
  return { secret: st.body.secret as string, codes: c.body.recoveryCodes as string[], token: c.body.token as string, pendingToken: l.body.token as string, startBody: st.body };
}
/** Password login + TOTP challenge. */
async function signIn(email: string, secret: string) {
  const l = await loginRaw(email).expect(201);
  expect(l.body.mfa).toBe('CHALLENGE_REQUIRED');
  const c = await http.post('/auth/mfa/challenge').set(bearer(l.body.token)).send({ code: code(secret) }).expect(201);
  return { token: c.body.token as string, pendingToken: l.body.token as string };
}
const auditActions = async (userId?: string) =>
  (await ctx.db.query<any>(`SELECT action, detail FROM audit_logs ${userId ? 'WHERE subject_id=$1' : ''} ORDER BY id`, userId ? [userId] : [])).map((r) => r.action);
const userId = async (email: string) => (await ctx.db.query<any>('SELECT id FROM users WHERE email=$1', [email]))[0].id as string;

describe('enforcement: admins cannot use privileged routes without MFA', () => {
  it('blocks every admin route for a password-only session and tells the client what to do', async () => {
    const email = await mkUser();
    const l = await loginRaw(email).expect(201);
    expect(l.body).toMatchObject({ role: 'ADMIN', mfa: 'ENROL_REQUIRED' });
    for (const [method, path] of [['get', '/admin/merchants'], ['get', '/admin/audit-logs'], ['get', '/admin/health'], ['post', '/admin/reconciliation/run'], ['get', '/admin/payouts'], ['get', '/admin/mfa-recovery-requests']] as const) {
      const r = await (http as any)[method](path).set(bearer(l.body.token));
      expect([path, r.status, r.body.error, r.body.mfa]).toEqual([path, 403, 'MFA_REQUIRED', 'ENROL_REQUIRED']);
    }
  });

  it('an enrolled admin who has only passed the password step is still blocked (challenge required)', async () => {
    const email = await mkUser();
    const { secret } = await enrol(email);
    const l = await loginRaw(email).expect(201);
    expect(l.body.mfa).toBe('CHALLENGE_REQUIRED');
    const r = await http.get('/admin/merchants').set(bearer(l.body.token)).expect(403);
    expect(r.body).toMatchObject({ error: 'MFA_REQUIRED', mfa: 'CHALLENGE_REQUIRED' });
    const ok = await signIn(email, secret);
    await http.get('/admin/merchants').set(bearer(ok.token)).expect(200);
  });

  it('rejects legacy tokens (no session id), forged sessions and tokens bound to another user', async () => {
    const email = await mkUser();
    const { token } = await enrol(email);
    const jwt = new JwtService({ secret: JWT_SECRET });
    const uid = await userId(email);
    const legacy = await jwt.signAsync({ sub: uid, role: 'ADMIN' }, { expiresIn: 600 }); // pre-MFA token format
    await http.get('/admin/merchants').set(bearer(legacy)).expect(401);
    const unknownSid = await jwt.signAsync({ sub: uid, sid: '00000000-0000-4000-8000-000000000000', role: 'ADMIN' });
    await http.get('/admin/merchants').set(bearer(unknownSid)).expect(401);
    const otherUser = await userId(await mkUser());
    const mismatched = await jwt.signAsync({ sub: otherUser, sid: sidOf(token), role: 'ADMIN' });
    await http.get('/admin/merchants').set(bearer(mismatched)).expect(401);
    await http.get('/admin/merchants').set(bearer('not.a.jwt')).expect(401);
    await http.get('/admin/merchants').set(bearer(token)).expect(200);
  });

  it('a session cannot be upgraded in place: verification issues a brand-new session and revokes the old one', async () => {
    const email = await mkUser();
    const { secret } = await enrol(email);
    const l = await loginRaw(email).expect(201);
    const c = await http.post('/auth/mfa/challenge').set(bearer(l.body.token)).send({ code: code(secret) }).expect(201);
    expect(sidOf(c.body.token)).not.toBe(sidOf(l.body.token)); // no session fixation
    await http.get('/admin/merchants').set(bearer(l.body.token)).expect(401); // pre-auth token is dead, not upgraded
    await http.get('/admin/merchants').set(bearer(c.body.token)).expect(200);
  });

  it('logout revokes the session server-side', async () => {
    const { token } = await enrol(await mkUser());
    await http.post('/auth/logout').set(bearer(token)).expect(201);
    await http.get('/admin/merchants').set(bearer(token)).expect(401);
  });

  it('sessions expire server-side', async () => {
    const email = await mkUser();
    const { secret } = await enrol(email);
    const { token } = await signIn(email, secret);
    await http.get('/admin/merchants').set(bearer(token)).expect(200);
    ctx.advance(61 * 60_000);
    await http.get('/admin/merchants').set(bearer(token)).expect(401);
  });

  it('merchant routes and boundaries are unchanged (no MFA for merchants who have not opted in)', async () => {
    const email = await mkUser('MERCHANT');
    const l = await loginRaw(email).expect(201);
    expect(l.body.mfa).toBe('NOT_REQUIRED');
    await http.get('/admin/merchants').set(bearer(l.body.token)).expect(403);
  });
});

describe('enrolment', () => {
  it('returns a standard otpauth URI and QR, and stores the secret encrypted', async () => {
    const email = await mkUser();
    const { secret, startBody, codes } = await enrol(email);
    expect(startBody.otpauthUri).toContain(`secret=${secret}`);
    expect(startBody.otpauthUri).toMatch(/^otpauth:\/\/totp\/GatewayTest%3A/);
    expect(startBody.qrImage).toMatch(/^data:image\/png;base64,/);
    const [row] = await ctx.db.query<any>('SELECT * FROM user_mfa WHERE user_id=$1', [await userId(email)]);
    expect(row.secret_enc.startsWith('v1.')).toBe(true);
    expect(JSON.stringify(row)).not.toContain(secret);
    expect(row.pending_secret_enc).toBeNull();
    // 10 recovery codes, stored only as hashes.
    expect(codes).toHaveLength(10);
    const stored = await ctx.db.query<any>('SELECT * FROM mfa_recovery_codes WHERE user_id=$1', [await userId(email)]);
    expect(stored).toHaveLength(10);
    const dump = JSON.stringify(stored);
    for (const c of codes) expect(dump).not.toContain(c.replace('-', ''));
  });

  it('rejects confirmation with a wrong code and leaves the account un-enrolled', async () => {
    const email = await mkUser();
    const l = await loginRaw(email).expect(201);
    const st = await http.post('/auth/mfa/enrol/start').set(bearer(l.body.token)).expect(201);
    sensitive.push(st.body.secret);
    const wrong = hotp(base32Decode(st.body.secret), stepAt(ctx.nowMs()) + 10);
    const r = await http.post('/auth/mfa/enrol/confirm').set(bearer(l.body.token)).send({ code: wrong }).expect(401);
    expect(r.body.error).toBe('INVALID_MFA_CODE');
    const status = await http.get('/auth/mfa/status').set(bearer(l.body.token)).expect(200);
    expect(status.body).toMatchObject({ required: true, enrolled: false });
    await http.post('/auth/mfa/enrol/confirm').set(bearer(l.body.token)).send({}).expect(400);
    expect(await auditActions(await userId(email))).toContain('mfa.challenge.failed');
  });

  it('cannot confirm without starting, and a started-but-unconfirmed secret never counts as enrolled', async () => {
    const email = await mkUser();
    const l = await loginRaw(email).expect(201);
    await http.post('/auth/mfa/enrol/confirm').set(bearer(l.body.token)).send({ code: '123456' }).expect(409);
    await http.post('/auth/mfa/enrol/start').set(bearer(l.body.token)).expect(201);
    expect((await loginRaw(email).expect(201)).body.mfa).toBe('ENROL_REQUIRED');
  });

  it('a pre-enrolment (password-only) session cannot be used to replace an existing authenticator', async () => {
    const email = await mkUser();
    await enrol(email);
    const l = await loginRaw(email).expect(201); // password only
    const r = await http.post('/auth/mfa/enrol/start').set(bearer(l.body.token)).expect(403);
    expect(r.body.error).toBe('STEP_UP_REQUIRED');
  });

  it('replacing the authenticator needs step-up, invalidates old codes/secret and revokes all other sessions', async () => {
    const email = await mkUser();
    const first = await enrol(email);
    const other = await signIn(email, first.secret);
    ctx.advance(10 * 60_000); // step-up window lapses
    await http.post('/auth/mfa/enrol/start').set(bearer(first.token)).expect(403);
    await http.post('/auth/mfa/step-up').set(bearer(first.token)).send({ code: code(first.secret) }).expect(201);
    const st = await http.post('/auth/mfa/enrol/start').set(bearer(first.token)).expect(201);
    sensitive.push(st.body.secret);
    const done = await http.post('/auth/mfa/enrol/confirm').set(bearer(first.token)).send({ code: code(st.body.secret) }).expect(201);
    sensitive.push(...done.body.recoveryCodes);
    await http.get('/admin/merchants').set(bearer(other.token)).expect(401);
    await http.get('/admin/merchants').set(bearer(first.token)).expect(401);
    await http.get('/admin/merchants').set(bearer(done.body.token)).expect(200);
    // Old recovery code no longer works; old secret no longer verifies.
    const l = await loginRaw(email).expect(201);
    await http.post('/auth/mfa/challenge').set(bearer(l.body.token)).send({ recoveryCode: first.codes[0] }).expect(401);
    await http.post('/auth/mfa/challenge').set(bearer(l.body.token)).send({ code: hotp(base32Decode(first.secret), stepAt(ctx.nowMs()) + 1) }).expect(401);
    expect(await auditActions(await userId(email))).toContain('mfa.device_replaced');
  });
});

describe('challenge: invalid codes, replay, lockout', () => {
  it('rejects wrong, malformed and out-of-window codes; accepts a valid one', async () => {
    const email = await mkUser();
    const { secret } = await enrol(email);
    const l = await loginRaw(email).expect(201);
    const t = bearer(l.body.token);
    const far = hotp(base32Decode(secret), stepAt(ctx.nowMs()) + 5);
    for (const bad of [far, '12345', 'abcdef']) {
      const r = await http.post('/auth/mfa/challenge').set(t).send({ code: bad });
      expect([r.status, r.body.error]).toEqual([bad.length === 5 ? 400 : 401, bad.length === 5 ? 'VALIDATION_FAILED' : 'INVALID_MFA_CODE']);
    }
    await http.post('/auth/mfa/challenge').set(t).send({ code: far, recoveryCode: 'AAAAA-BBBBB' }).expect(400); // exactly one factor
    await http.post('/auth/mfa/challenge').set(t).send({ code: code(secret) }).expect(201);
  });

  it('a one-time code cannot be replayed, even concurrently and even from another session', async () => {
    const email = await mkUser();
    const { secret } = await enrol(email);
    const s1 = (await loginRaw(email).expect(201)).body.token;
    const s2 = (await loginRaw(email).expect(201)).body.token;
    const s3 = (await loginRaw(email).expect(201)).body.token;
    const c = code(secret); // valid right now
    const results = await Promise.all([s1, s2].map((t) => http.post('/auth/mfa/challenge').set(bearer(t)).send({ code: c })));
    expect(results.map((r) => r.status).sort()).toEqual([201, 401]);
    // Same code, third session, a moment later: still rejected.
    const again = await http.post('/auth/mfa/challenge').set(bearer(s3)).send({ code: c }).expect(401);
    expect(again.body.error).toBe('INVALID_MFA_CODE'); // indistinguishable from an invalid code
    const reasons = (await ctx.db.query<any>(`SELECT detail FROM audit_logs WHERE action='mfa.challenge.failed'`)).map((r) => r.detail.reason);
    expect(reasons).toContain('replayed_code');
    // The previous step's code is also burned once a later step was used.
    const prev = hotp(base32Decode(secret), stepAt(ctx.nowMs()) - 1);
    await http.post('/auth/mfa/challenge').set(bearer(s3)).send({ code: prev }).expect(401);
  });

  it('replay is also blocked for step-up', async () => {
    const email = await mkUser();
    const { secret } = await enrol(email);
    const { token } = await signIn(email, secret);
    const used = totpAt(secret, ctx.nowMs()); // same step the challenge consumed
    await http.post('/auth/mfa/step-up').set(bearer(token)).send({ code: used }).expect(401);
    await http.post('/auth/mfa/step-up').set(bearer(token)).send({ code: code(secret) }).expect(201);
  });

  it('locks the factor after repeated failures, revokes the session, and recovers after the lock period', async () => {
    const email = await mkUser();
    const { secret } = await enrol(email);
    const l = await loginRaw(email).expect(201);
    const t = bearer(l.body.token);
    const bad = hotp(base32Decode(secret), stepAt(ctx.nowMs()) + 7);
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) statuses.push((await http.post('/auth/mfa/challenge').set(t).send({ code: bad })).status);
    expect(statuses).toEqual([401, 401, 401, 401, 429]);
    await http.post('/auth/mfa/challenge').set(t).send({ code: bad }).expect(401); // attempting session was revoked
    // Even the right code is refused while locked.
    const l2 = await loginRaw(email).expect(201);
    const locked = await http.post('/auth/mfa/challenge').set(bearer(l2.body.token)).send({ code: code(secret) }).expect(429);
    expect(locked.body.error).toBe('MFA_LOCKED');
    expect((await ctx.db.query('SELECT 1 FROM alerts WHERE kind=$1', ['MFA_LOCKOUT'])).length).toBeGreaterThan(0);
    const actions = await auditActions(await userId(email));
    expect(actions).toEqual(expect.arrayContaining(['mfa.challenge.failed', 'mfa.locked', 'mfa.challenge.rejected_locked']));
    ctx.advance(16 * 60_000);
    const l3 = await loginRaw(email).expect(201);
    await http.post('/auth/mfa/challenge').set(bearer(l3.body.token)).send({ code: code(secret) }).expect(201);
  });

  it('a successful code resets the failure counter', async () => {
    const email = await mkUser();
    const { secret } = await enrol(email);
    const bad = () => hotp(base32Decode(secret), stepAt(ctx.nowMs()) + 7);
    for (let round = 0; round < 3; round++) {
      const l = await loginRaw(email).expect(201);
      for (let i = 0; i < 4; i++) await http.post('/auth/mfa/challenge').set(bearer(l.body.token)).send({ code: bad() }).expect(401);
      await http.post('/auth/mfa/challenge').set(bearer(l.body.token)).send({ code: code(secret) }).expect(201);
    }
  });
});

describe('password lockout', () => {
  it('locks after repeated wrong passwords without revealing the lock, then recovers', async () => {
    const email = await mkUser();
    for (let i = 0; i < 5; i++) {
      const r = await loginRaw(email, 'wrong-password-12345').expect(401);
      expect(r.body.error).toBe('INVALID_CREDENTIALS');
    }
    const locked = await loginRaw(email).expect(401); // correct password, but locked: same generic error
    expect(locked.body).toEqual({ error: 'INVALID_CREDENTIALS', message: 'Invalid email or password' });
    expect(await auditActions(await userId(email))).toEqual(expect.arrayContaining(['auth.login.failed', 'auth.account.locked', 'auth.login.rejected_locked']));
    ctx.advance(16 * 60_000);
    await loginRaw(email).expect(201);
  });

  it('unknown users get the same response as wrong passwords', async () => {
    const a = await loginRaw('nobody@example.test', 'whatever-password-1').expect(401);
    const b = await loginRaw(await mkUser(), 'whatever-password-1').expect(401);
    expect(a.body).toEqual(b.body);
  });
});

describe('recovery codes', () => {
  it('each recovery code works exactly once', async () => {
    const email = await mkUser();
    const { codes } = await enrol(email);
    const l1 = await loginRaw(email).expect(201);
    const ok = await http.post('/auth/mfa/challenge').set(bearer(l1.body.token)).send({ recoveryCode: codes[0] }).expect(201);
    expect(ok.body).toMatchObject({ method: 'recovery', recoveryCodesRemaining: 9 });
    await http.get('/admin/merchants').set(bearer(ok.body.token)).expect(200);
    const l2 = await loginRaw(email).expect(201);
    const reuse = await http.post('/auth/mfa/challenge').set(bearer(l2.body.token)).send({ recoveryCode: codes[0] }).expect(401);
    expect(reuse.body.error).toBe('INVALID_MFA_CODE');
    // A different code still works; format is forgiving (case, missing dash).
    await http.post('/auth/mfa/challenge').set(bearer(l2.body.token)).send({ recoveryCode: codes[1].toLowerCase().replace('-', '') }).expect(201);
    const actions = await auditActions(await userId(email));
    expect(actions.filter((a) => a === 'mfa.recovery_code.used')).toHaveLength(2);
  });

  it('concurrent use of one recovery code succeeds for exactly one session', async () => {
    const email = await mkUser();
    const { codes } = await enrol(email);
    const tokens = [(await loginRaw(email)).body.token, (await loginRaw(email)).body.token, (await loginRaw(email)).body.token];
    const res = await Promise.all(tokens.map((t) => http.post('/auth/mfa/challenge').set(bearer(t)).send({ recoveryCode: codes[3] })));
    expect(res.map((r) => r.status).sort()).toEqual([201, 401, 401]);
  });

  it('wrong recovery codes count toward the lockout', async () => {
    const email = await mkUser();
    await enrol(email);
    const l = await loginRaw(email).expect(201);
    const out: number[] = [];
    for (let i = 0; i < 5; i++) out.push((await http.post('/auth/mfa/challenge').set(bearer(l.body.token)).send({ recoveryCode: 'AAAAA-BBBBB' })).status);
    expect(out).toEqual([401, 401, 401, 401, 429]);
  });

  it('regeneration requires step-up and invalidates the previous set', async () => {
    const email = await mkUser();
    const { codes, secret } = await enrol(email);
    const { token } = await signIn(email, secret);
    ctx.advance(6 * 60_000);
    await http.post('/auth/mfa/recovery-codes/regenerate').set(bearer(token)).expect(403);
    await http.post('/auth/mfa/step-up').set(bearer(token)).send({ code: code(secret) }).expect(201);
    const r = await http.post('/auth/mfa/recovery-codes/regenerate').set(bearer(token)).expect(201);
    sensitive.push(...r.body.recoveryCodes);
    expect(r.body.recoveryCodes).toHaveLength(10);
    const l = await loginRaw(email).expect(201);
    await http.post('/auth/mfa/challenge').set(bearer(l.body.token)).send({ recoveryCode: codes[0] }).expect(401);
    await http.post('/auth/mfa/challenge').set(bearer(l.body.token)).send({ recoveryCode: r.body.recoveryCodes[0] }).expect(201);
  });
});

describe('step-up for high-risk operations', () => {
  const HIGH_RISK: Array<[string, string, object]> = [
    ['post', '/admin/payouts/00000000-0000-4000-8000-000000000001/approve', {}],
    ['post', '/admin/payouts/00000000-0000-4000-8000-000000000001/reject', { reason: 'nope' }],
    ['post', '/admin/payouts/00000000-0000-4000-8000-000000000001/retry', {}],
    ['post', '/admin/destinations/00000000-0000-4000-8000-000000000001/verify', {}],
    ['post', '/admin/merchants/00000000-0000-4000-8000-000000000001/status', { status: 'SUSPENDED' }],
    ['post', '/admin/verification-cases/00000000-0000-4000-8000-000000000001/decision', { decision: 'APPROVED' }],
    ['post', '/admin/payments/00000000-0000-4000-8000-000000000001/refund', { amountMinor: 100, idempotencyKey: 'abcdefgh' }],
    ['post', '/admin/payments/00000000-0000-4000-8000-000000000001/approve-review', {}],
    ['post', '/admin/jobs/1/replay', {}],
    ['post', '/admin/mfa-recovery-requests/00000000-0000-4000-8000-000000000001/approve', { note: 'verified by phone call' }],
    ['post', '/admin/mfa-recovery-requests/00000000-0000-4000-8000-000000000001/reject', { note: 'no' }],
  ];

  it('requires a recent factor verification, and refuses once the window lapses', async () => {
    const email = await mkUser();
    const { secret } = await enrol(email);
    const { token } = await signIn(email, secret);
    // Fresh right after login: the guard lets requests through to the handler (which 404s/ignores our dummy ids).
    for (const [m, path, body] of HIGH_RISK) {
      const r = await (http as any)[m](path).set(bearer(token)).send(body);
      expect([path, r.status === 403 && r.body.error === 'STEP_UP_REQUIRED']).toEqual([path, false]);
    }
    ctx.advance(5 * 60_000 + 5000);
    for (const [m, path, body] of HIGH_RISK) {
      const r = await (http as any)[m](path).set(bearer(token)).send(body);
      expect([path, r.status, r.body.error, r.body.stepUp]).toEqual([path, 403, 'STEP_UP_REQUIRED', true]);
    }
    // Ordinary admin reads are unaffected.
    await http.get('/admin/merchants').set(bearer(token)).expect(200);
    await http.post('/auth/mfa/step-up').set(bearer(token)).send({ code: hotp(base32Decode(secret), stepAt(ctx.nowMs()) + 9) }).expect(401);
    await http.post('/auth/mfa/step-up').set(bearer(token)).send({ code: code(secret) }).expect(201);
    const r = await http.post('/admin/jobs/1/replay').set(bearer(token)).expect(201);
    expect(r.body.ok).toBe(true);
  });

  it('step-up cannot be obtained on a session that has not completed MFA', async () => {
    const email = await mkUser();
    const { secret } = await enrol(email);
    const l = await loginRaw(email).expect(201);
    const r = await http.post('/auth/mfa/step-up').set(bearer(l.body.token)).send({ code: code(secret) }).expect(403);
    expect(r.body.error).toBe('MFA_REQUIRED');
  });

  it('payout approval keeps its dual-control rule on top of step-up', async () => {
    // Requester == approver is still refused after a valid step-up (existing payout control preserved).
    const email = await mkUser();
    const { secret } = await enrol(email);
    const { token } = await signIn(email, secret);
    const adminId = await userId(email);
    const m = await ctx.db.query<any>(`INSERT INTO merchants(legal_name, display_name, status) VALUES ('X','X','ACTIVE') RETURNING id`);
    const d = await ctx.db.query<any>(`INSERT INTO merchant_settlement_destinations(merchant_id, provider_destination_ref, label, masked_account, status) VALUES ($1,'fa','l','XXXX','VERIFIED') RETURNING id`, [m[0].id]);
    const po = await ctx.db.query<any>(`INSERT INTO payouts(merchant_id, destination_id, amount_minor, status, idempotency_key, provider, requested_by) VALUES ($1,$2,1000,'UNDER_REVIEW','k','sandbox',$3) RETURNING id`, [m[0].id, d[0].id, adminId]);
    const r = await http.post(`/admin/payouts/${po[0].id}/approve`).set(bearer(token)).expect(403);
    expect(r.body.error).toBe('DUAL_APPROVAL_REQUIRED');
  });

  it('merchant settlement-destination changes need step-up once the merchant uses MFA, and stay open for merchants without it', async () => {
    const plain = await http.post('/auth/register').send({ email: 'plain@example.test', password: PW, legalName: 'Plain Co', displayName: 'Plain' }).expect(201);
    const tPlain = (await loginRaw('plain@example.test').expect(201)).body.token;
    const body = { label: 'Main', providerDestinationRef: 'fa_sbx_1', maskedAccount: 'XXXX1234' };
    await http.post('/merchant/destinations').set(bearer(tPlain)).send(body).expect(201);
    expect(plain.body.merchantId).toBeTruthy();

    // Same merchant opts in to MFA.
    const stale = (await loginRaw('plain@example.test').expect(201)).body.token;
    const st = await http.post('/auth/mfa/enrol/start').set(bearer(tPlain)).expect(201);
    sensitive.push(st.body.secret);
    const done = await http.post('/auth/mfa/enrol/confirm').set(bearer(tPlain)).send({ code: code(st.body.secret) }).expect(201);
    sensitive.push(...done.body.recoveryCodes);
    // Every older session died when MFA was enabled (cannot bypass the new requirement).
    await http.get('/merchant/me').set(bearer(stale)).expect(401);
    // New logins must challenge, and password-only sessions are blocked.
    const l = await loginRaw('plain@example.test').expect(201);
    expect(l.body.mfa).toBe('CHALLENGE_REQUIRED');
    await http.get('/merchant/me').set(bearer(l.body.token)).expect(403);
    const ver = await http.post('/auth/mfa/challenge').set(bearer(l.body.token)).send({ code: code(st.body.secret) }).expect(201);
    await http.post('/merchant/destinations').set(bearer(ver.body.token)).send(body).expect(201); // fresh from the challenge
    ctx.advance(6 * 60_000);
    const r = await http.post('/merchant/destinations').set(bearer(ver.body.token)).send(body).expect(403);
    expect(r.body.error).toBe('STEP_UP_REQUIRED');
    await http.post('/auth/mfa/step-up').set(bearer(ver.body.token)).send({ code: code(st.body.secret) }).expect(201);
    await http.post('/merchant/destinations').set(bearer(ver.body.token)).send(body).expect(201);
    await http.get('/merchant/me').set(bearer(ver.body.token)).expect(200); // merchant data boundary intact
  });
});

describe('controlled MFA recovery', () => {
  const sessionFor = (token: string) => ctx.p.auth.resolve(sidOf(token));
  const stepUpWith = (token: string, secret: string) => http.post('/auth/mfa/step-up').set(bearer(token)).send({ code: code(secret) }).expect(201);

  it('requires the password, changes nothing by itself, and is idempotent', async () => {
    const victim = await mkUser();
    await enrol(victim);
    await http.post('/auth/mfa/recovery-request').send({ email: victim, password: 'wrong-password-12345' }).expect(401);
    for (let i = 0; i < 2; i++) await http.post('/auth/mfa/recovery-request').send({ email: victim, password: PW }).expect(201);
    expect(await ctx.db.query('SELECT 1 FROM mfa_recovery_requests WHERE user_id=$1', [await userId(victim)])).toHaveLength(1);
    expect((await loginRaw(victim).expect(201)).body.mfa).toBe('CHALLENGE_REQUIRED'); // MFA still on
    expect((await ctx.db.query('SELECT 1 FROM alerts WHERE kind=$1', ['MFA_RECOVERY_REQUESTED'])).length).toBeGreaterThan(0);
    // A user with nothing to recover gets the same reply but no request is created.
    const fresh = await mkUser();
    await http.post('/auth/mfa/recovery-request').send({ email: fresh, password: PW }).expect(201);
    expect(await ctx.db.query('SELECT 1 FROM mfa_recovery_requests WHERE user_id=$1', [await userId(fresh)])).toHaveLength(0);
  });

  it('needs ANOTHER admin with step-up and a written note; after the delay the owner re-enrols at next sign-in', async () => {
    const victim = await mkUser();
    const v = await enrol(victim);
    const approver = await mkUser();
    const a = await enrol(approver);
    await http.post('/auth/mfa/recovery-request').send({ email: victim, password: PW }).expect(201);
    const [req] = await ctx.db.query<any>('SELECT id FROM mfa_recovery_requests WHERE user_id=$1', [await userId(victim)]);

    // Merchants cannot approve; the subject cannot approve their own request; a note is mandatory.
    const m = await mkUser('MERCHANT');
    const mt = (await loginRaw(m).expect(201)).body.token;
    await http.post(`/admin/mfa-recovery-requests/${req.id}/approve`).set(bearer(mt)).send({ note: 'I am a merchant, approve me' }).expect(403);
    const victimSession = (await sessionFor(v.token))!;
    await expect(ctx.p.mfa.approveRecovery(victimSession, req.id, 'approving myself, trust me')).rejects.toMatchObject({ code: 'SELF_APPROVAL_FORBIDDEN' });
    await http.post(`/admin/mfa-recovery-requests/${req.id}/approve`).set(bearer(a.token)).send({ note: 'short' }).expect(400);

    const approved = await http.post(`/admin/mfa-recovery-requests/${req.id}/approve`).set(bearer(a.token)).send({ note: 'Verified via video call with the CTO' }).expect(201);
    const executeAfter = new Date(approved.body.executeAfter).getTime();
    expect(executeAfter - ctx.nowMs()).toBeGreaterThanOrEqual(24 * 3600_000 - 5000);

    // During the delay nothing changes: MFA still required, existing secret still works as the only way in.
    ctx.advance(12 * 3600_000);
    expect((await loginRaw(victim).expect(201)).body.mfa).toBe('CHALLENGE_REQUIRED');
    ctx.advance(13 * 3600_000); // delay elapsed
    const l = await loginRaw(victim).expect(201); // executes at the owner's next password login
    expect(l.body.mfa).toBe('ENROL_REQUIRED');
    await http.get('/admin/merchants').set(bearer(l.body.token)).expect(403);
    await http.get('/admin/merchants').set(bearer(v.token)).expect(401); // all earlier sessions revoked
    const [mfaRow] = await ctx.db.query<any>('SELECT secret_enc, pending_secret_enc FROM user_mfa WHERE user_id=$1', [await userId(victim)]);
    expect(mfaRow).toMatchObject({ secret_enc: null, pending_secret_enc: null });
    expect(await ctx.db.query('SELECT 1 FROM mfa_recovery_codes WHERE user_id=$1', [await userId(victim)])).toHaveLength(0);
    const st = await http.post('/auth/mfa/enrol/start').set(bearer(l.body.token)).expect(201);
    sensitive.push(st.body.secret);
    const done = await http.post('/auth/mfa/enrol/confirm').set(bearer(l.body.token)).send({ code: code(st.body.secret) }).expect(201);
    sensitive.push(...done.body.recoveryCodes);
    await http.get('/admin/merchants').set(bearer(done.body.token)).expect(200);

    const actions = await auditActions(await userId(victim));
    expect(actions).toEqual(expect.arrayContaining(['mfa.recovery.requested', 'mfa.recovery.approved', 'mfa.recovery.completed', 'mfa.enrolled']));
    const [r] = await ctx.db.query<any>('SELECT status, approved_by FROM mfa_recovery_requests WHERE id=$1', [req.id]);
    expect(r).toMatchObject({ status: 'COMPLETED', approved_by: await userId(approver) });
    // The request cannot be replayed to reset MFA again.
    const again = await signIn(approver, a.secret);
    await stepUpWith(again.token, a.secret);
    await http.post(`/admin/mfa-recovery-requests/${req.id}/approve`).set(bearer(again.token)).send({ note: 'second attempt at same request' }).expect(409);
  });

  it('is cancelled automatically if the real owner authenticates during the delay', async () => {
    const victim = await mkUser();
    const v = await enrol(victim);
    const approver = await mkUser();
    const a = await enrol(approver);
    await http.post('/auth/mfa/recovery-request').send({ email: victim, password: PW }).expect(201);
    const [req] = await ctx.db.query<any>('SELECT id FROM mfa_recovery_requests WHERE user_id=$1', [await userId(victim)]);
    await stepUpWith(a.token, a.secret);
    await http.post(`/admin/mfa-recovery-requests/${req.id}/approve`).set(bearer(a.token)).send({ note: 'Requester verified in person at HQ' }).expect(201);
    ctx.advance(2 * 3600_000);
    await signIn(victim, v.secret); // owner still has the device
    const [after] = await ctx.db.query<any>('SELECT status FROM mfa_recovery_requests WHERE id=$1', [req.id]);
    expect(after.status).toBe('CANCELLED');
    ctx.advance(30 * 3600_000);
    expect((await loginRaw(victim).expect(201)).body.mfa).toBe('CHALLENGE_REQUIRED'); // never reset
    expect(await auditActions(await userId(victim))).toContain('mfa.recovery.cancelled');
  });

  it('can be rejected, and an unapproved request never resets MFA', async () => {
    const victim = await mkUser();
    await enrol(victim);
    const approver = await mkUser();
    const a = await enrol(approver);
    await http.post('/auth/mfa/recovery-request').send({ email: victim, password: PW }).expect(201);
    const [req] = await ctx.db.query<any>('SELECT id FROM mfa_recovery_requests WHERE user_id=$1', [await userId(victim)]);
    ctx.advance(60 * 3600_000); // far beyond the delay, but nobody approved
    expect((await loginRaw(victim).expect(201)).body.mfa).toBe('CHALLENGE_REQUIRED');
    const fresh = await signIn(approver, a.secret);
    await http.post(`/admin/mfa-recovery-requests/${req.id}/reject`).set(bearer(fresh.token)).send({ note: 'could not verify' }).expect(201);
    expect(await auditActions(await userId(victim))).toContain('mfa.recovery.rejected');
    const list = await http.get('/admin/mfa-recovery-requests').set(bearer(fresh.token)).expect(200);
    expect(list.body.find((x: any) => x.id === req.id).status).toBe('REJECTED');
  });
});

describe('audit and log hygiene', () => {
  it('records MFA events and never contains secrets, OTPs or recovery codes in audit rows, alerts, notifications or logs', async () => {
    const actions = new Set(await auditActions());
    for (const a of ['mfa.enrol.started', 'mfa.enrolled', 'mfa.recovery_codes.generated', 'mfa.challenge.succeeded', 'mfa.challenge.failed', 'mfa.recovery_code.used', 'mfa.stepup.succeeded', 'mfa.stepup.failed', 'mfa.recovery_codes.regenerated', 'mfa.device_replaced', 'mfa.locked', 'auth.login.failed']) {
      expect(actions).toContain(a);
    }
    expect(sensitive.length).toBeGreaterThan(100);
    const haystack = [
      JSON.stringify(await ctx.db.query('SELECT * FROM audit_logs')),
      JSON.stringify(await ctx.db.query('SELECT * FROM alerts')),
      JSON.stringify(await ctx.db.query('SELECT * FROM notification_jobs')),
      JSON.stringify(await ctx.db.query('SELECT * FROM mfa_recovery_requests')),
      captured.join('\n'),
    ].join('\n');
    expect(haystack.length).toBeGreaterThan(1000);
    // 6-digit OTPs are matched as standalone tokens (a random 6-digit run inside a UUID/timestamp is not a leak); longer secrets by substring.
    const leaked = sensitive.filter((s) =>
      /^\d{6}$/.test(s) ? new RegExp(`(?<![0-9A-Za-z])${s}(?![0-9A-Za-z])`).test(haystack) : s.length >= 6 && (haystack.includes(s) || haystack.includes(s.replace('-', ''))),
    );
    expect(leaked).toEqual([]);
    expect(await ctx.p.audit.verifyChain(ctx.db)).toBe(true);
  });
});
