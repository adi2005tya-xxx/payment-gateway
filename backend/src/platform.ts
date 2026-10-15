import { Db } from './db/db';
import { AuditService } from './audit/audit.service';
import { JobHandler, JobsService } from './jobs/jobs.service';
import { LedgerService } from './ledger/ledger.service';
import { MerchantsService } from './merchants/merchants.service';
import { PaymentRequestsService } from './payments/payments.service';
import { VerificationService } from './payments/verification.service';
import { PayoutsService } from './payouts/payouts.service';
import { PaymentProvider } from './provider/provider';
import { ReconciliationService } from './reconciliation/reconciliation.service';
import { RefundsService } from './refunds/refunds.service';
import { AuthService, SecurityOptions } from './auth/auth.service';
import { MfaService } from './auth/mfa.service';
import { SecretBox } from './auth/secretbox';
import { RecoveryService } from './recovery/recovery.service';
import { ConsoleNotifier, Notifier, NotificationService } from './ops/notifications';
import { AlertRouter, AlertSink, OpsMonitor } from './ops/alerts';
import { AlertIngestService, defaultIngestOptions, IngestOptions } from './bankmail/ingest.service';
import { MailboxService, MailboxOptions } from './bankmail/mailbox.service';
import { AlertTemplatesService } from './bankmail/templates.service';
import { CollectionsReviewService } from './bankmail/review.service';
import { DevicesService } from './bankmail/devices.service';
import { GoogleOAuth, GoogleOAuthConfig } from './bankmail/gmail';

/** Composition root: wires the domain services. Used by the Nest app, workers and tests alike. */
export interface OpsOptions {
  notifier?: Notifier;
  alertSink?: AlertSink;
  /** Base URL of the web app, used in links inside emails. */
  webBaseUrl?: string;
  /** Bank-alert email integration (provider kind "bank-email"). Everything here is optional. */
  bankmail?: {
    ingest?: Partial<IngestOptions>;
    google?: GoogleOAuthConfig;
    mailbox?: Partial<MailboxOptions>;
  };
}

export function createPlatform(db: Db, provider: PaymentProvider, security: SecurityOptions, ops: OpsOptions = {}) {
  const audit = new AuditService();
  const ledger = new LedgerService();
  const jobs = new JobsService(db);
  const merchants = new MerchantsService(db, audit, provider);
  const requests = new PaymentRequestsService(db, provider, audit);
  const verification = new VerificationService(db, provider, ledger, jobs, audit);
  const payouts = new PayoutsService(db, provider, ledger, jobs, audit);
  const refunds = new RefundsService(db, provider, ledger, jobs, audit);
  const reconciliation = new ReconciliationService(db, provider, ledger, payouts);
  const auth = new AuthService(db, audit, security);
  const mfa = new MfaService(db, audit, auth, new SecretBox(security.mfaKey, security.mfaKeyPrevious));

  const recovery = new RecoveryService(db, provider, audit, auth, payouts, verification, reconciliation, ledger);

  const notifications = new NotificationService(db, ops.notifier ?? new ConsoleNotifier(), new SecretBox(security.mfaKey, security.mfaKeyPrevious), ops.webBaseUrl ?? 'http://localhost:3000');
  const alerts = new AlertRouter(db, ops.alertSink);
  const monitor = new OpsMonitor(db, ledger, audit);

  const secretBox = new SecretBox(security.mfaKey, security.mfaKeyPrevious);
  const ingest = new AlertIngestService(db, audit, verification, secretBox, provider, { ...defaultIngestOptions, ...(ops.bankmail?.ingest ?? {}) });
  const mailbox = new MailboxService(db, audit, secretBox, ops.bankmail?.google ? new GoogleOAuth(ops.bankmail.google) : null, ingest, {
    syncIntervalSeconds: 60,
    overlapMinutes: 15,
    maxAlertAgeHours: ops.bankmail?.ingest?.maxAlertAgeHours ?? defaultIngestOptions.maxAlertAgeHours,
    returnUrl: ops.webBaseUrl,
    ...(ops.bankmail?.mailbox ?? {}),
  });
  const alertTemplates = new AlertTemplatesService(db, audit);
  const devices = new DevicesService(db, audit);
  const collections = new CollectionsReviewService(db, audit, verification, ingest, secretBox, provider);

  const handlers: Record<string, JobHandler> = {
    process_webhook: (p, ctx) => verification.processWebhookEvent(p.webhookEventId, ctx),
    advance_payout: (p, ctx) => payouts.advance(p.payoutId, ctx),
    complete_refund: (p) => refunds.complete(p.refundId),
  };

  return { db, provider, audit, ledger, jobs, merchants, requests, verification, payouts, refunds, reconciliation, auth, mfa, recovery, notifications, alerts, monitor, ingest, mailbox, alertTemplates, devices, collections, handlers };
}
export type Platform = ReturnType<typeof createPlatform>;
