import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createApp } from '../src/app';
import { hashPassword } from '../src/auth/password';
import { Ctx, setup } from './helpers';

let ctx: Ctx;
let app: INestApplication;
let http: ReturnType<typeof request>;
const PW = 'correct-horse-battery';

beforeAll(async () => {
  ctx = await setup();
  app = await createApp({ platform: ctx.p, jwtSecret: 'j'.repeat(40), rateLimits: { auth: 4, mfa: 3, recovery: 2, global: 10000 } });
  await app.init();
  http = request(app.getHttpServer());
  await ctx.db.query(`INSERT INTO users(email, password_hash, role) VALUES ('rl@example.test',$1,'ADMIN')`, [await hashPassword(PW)]);
});
afterAll(async () => {
  await app.close();
  await ctx.db.close();
});

describe('route rate limits (per client, independent of account lockout)', () => {
  it('throttles login attempts', async () => {
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) codes.push((await http.post('/auth/login').send({ email: 'rl@example.test', password: 'wrong-password-123' })).status);
    expect(codes).toEqual([401, 401, 401, 401, 429, 429]);
  });
});

describe('MFA endpoints under a fresh limiter', () => {
  let app2: INestApplication;
  beforeAll(async () => {
    app2 = await createApp({ platform: ctx.p, jwtSecret: 'j'.repeat(40), rateLimits: { auth: 100, mfa: 3, recovery: 2, global: 10000 } });
    await app2.init();
  });
  afterAll(async () => app2.close());

  it('throttles MFA verification attempts per client', async () => {
    const h = request(app2.getHttpServer());
    const l = await h.post('/auth/login').send({ email: 'rl@example.test', password: PW }).expect(201);
    const auth = { Authorization: `Bearer ${l.body.token}` };
    await h.post('/auth/mfa/enrol/start').set(auth).expect(201);
    const out: number[] = [];
    for (let i = 0; i < 4; i++) out.push((await h.post('/auth/mfa/enrol/confirm').set(auth).send({ code: '000000' })).status);
    expect(out).toEqual([401, 401, 401, 429]);
  });

  it('throttles recovery requests', async () => {
    const h = request(app2.getHttpServer());
    const out: number[] = [];
    for (let i = 0; i < 4; i++) out.push((await h.post('/auth/mfa/recovery-request').send({ email: 'rl@example.test', password: PW })).status);
    expect(out).toEqual([201, 201, 429, 429]);
  });
});
