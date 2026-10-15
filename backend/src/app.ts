import { INestApplication, Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, NestFactory } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import helmet from 'helmet';
import { AdminController, AuthController, ErrorFilter, MerchantController, PublicController } from './api/controllers';
import { AuthGuard, JWT, PLATFORM, RATE_LIMITS } from './auth/auth';
import { Platform } from './platform';

export interface AppDeps {
  platform: Platform;
  jwtSecret: string;
  rateLimits?: Partial<typeof RATE_LIMITS>;
  /** Browser origin allowed to call the API. */
  corsOrigin?: string;
}

/** Builds the Nest app around an already-constructed Platform (so tests can inject an in-memory DB). */
export async function createApp({ platform, jwtSecret, rateLimits, corsOrigin }: AppDeps): Promise<INestApplication> {
  Object.assign(RATE_LIMITS, { auth: 10, mfa: 10, recovery: 3, global: 120, ingest: 60 }, rateLimits);

  @Module({
    imports: [ThrottlerModule.forRoot([{ ttl: 60_000, limit: () => RATE_LIMITS.global }])],
    controllers: [PublicController, AuthController, MerchantController, AdminController],
    providers: [
      { provide: PLATFORM, useValue: platform },
      { provide: JWT, useValue: new JwtService({ secret: jwtSecret, signOptions: {} }) },
      AuthGuard,
      { provide: APP_GUARD, useClass: ThrottlerGuard },
      { provide: APP_FILTER, useClass: ErrorFilter },
    ],
  })
  class AppModule {}

  const app = await NestFactory.create(AppModule, { rawBody: true, logger: ['error', 'warn'] });
  app.use(helmet());
  if (corsOrigin) app.enableCors({ origin: corsOrigin, methods: ['GET', 'POST'], allowedHeaders: ['content-type', 'authorization', 'idempotency-key'], maxAge: 600 });
  app.getHttpAdapter().getInstance().set('trust proxy', 1);
  return app;
}
