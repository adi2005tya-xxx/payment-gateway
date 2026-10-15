import { CanActivate, ExecutionContext, Inject, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { DomainError } from '../common/errors';
import { Platform } from '../platform';
import { Actor } from '../audit/audit.service';
import { SessionInfo } from './auth.service';

export { hashPassword, validatePasswordStrength, verifyPassword } from './password';

export interface AuthUser extends Actor {
  id: string;
}

export const PLATFORM = Symbol('PLATFORM');
export const JWT = Symbol('JWT');
export const ROLES_KEY = 'roles';
export const ALLOW_PENDING_MFA = 'allowPendingMfa';
export const STEP_UP = 'stepUp';

export const Roles = (...roles: string[]) => SetMetadata(ROLES_KEY, roles);
/** Route may be used by a session that has not completed MFA yet (enrolment, challenge, logout). */
export const AllowPendingMfa = () => SetMetadata(ALLOW_PENDING_MFA, true);
/**
 * High-risk operation: needs a factor re-verified within the step-up window.
 * `ifEnrolled` limits the requirement to users who have MFA (used where MFA is not mandatory for the role).
 */
export const StepUp = (opts: { ifEnrolled?: boolean } = {}) => SetMetadata(STEP_UP, opts);

/** Mutable so tests (and ops config) can tune route rate limits; read lazily on every request. */
export const RATE_LIMITS = { auth: 10, mfa: 10, recovery: 3, global: 120, ingest: 60 };

/**
 * Authenticates the bearer token against a server-side session, then enforces on the BACKEND:
 *  - role (@Roles)
 *  - MFA: any session of a user who must use MFA (mandatory role, or enrolled) is limited to @AllowPendingMfa
 *    routes until a second factor has been verified on that very session
 *  - step-up (@StepUp) freshness for high-risk routes
 * Tokens without a valid session id (e.g. issued before MFA existed) are rejected.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(JWT) private readonly jwt: JwtService,
    @Inject(PLATFORM) private readonly platform: Platform,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest();
    const header: string | undefined = req.headers['authorization'];
    if (!header?.startsWith('Bearer ')) throw new DomainError('UNAUTHENTICATED', 'Missing bearer token', 401);
    let claims: any;
    try {
      claims = await this.jwt.verifyAsync(header.slice(7));
    } catch {
      throw new DomainError('UNAUTHENTICATED', 'Invalid or expired token', 401);
    }
    const auth = this.platform.auth;
    const session: SessionInfo | null = await auth.resolve(claims.sid);
    if (!session || session.userId !== claims.sub) throw new DomainError('UNAUTHENTICATED', 'Session invalid or expired', 401);

    const target = [ctx.getHandler(), ctx.getClass()];
    const roles = this.reflector.getAllAndOverride<string[]>(ROLES_KEY, target);
    if (roles?.length && !roles.includes(session.role)) throw new DomainError('FORBIDDEN', 'Insufficient permissions', 403);

    const needsMfa = auth.isMfaRequired(session.role, session.enrolled);
    if (needsMfa && !session.mfaVerifiedAt && !this.reflector.getAllAndOverride<boolean>(ALLOW_PENDING_MFA, target)) {
      throw new DomainError('MFA_REQUIRED', session.enrolled ? 'MFA verification required' : 'MFA enrolment required', 403, {
        mfa: session.enrolled ? 'CHALLENGE_REQUIRED' : 'ENROL_REQUIRED',
      });
    }

    const stepUp = this.reflector.getAllAndOverride<{ ifEnrolled?: boolean } | undefined>(STEP_UP, target);
    if (stepUp && !(stepUp.ifEnrolled && !session.enrolled) && !auth.stepUpFresh(session)) {
      throw new DomainError('STEP_UP_REQUIRED', 'Recent MFA verification required for this operation', 403, { stepUp: true });
    }

    req.user = { id: session.userId, role: session.role, merchantId: session.merchantId } satisfies AuthUser;
    req.session = session;
    return true;
  }
}
