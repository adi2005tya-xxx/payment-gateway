'use client';
import { PageHeader } from '@/components/providers';
import { MfaSetup } from '@/components/mfa-setup';
import { Card, Notice } from '@/components/ui';

export default function MySecurity() {
  return (
    <>
      <PageHeader title="My security" />
      <div className="grid gap-6 lg:grid-cols-2">
        <MfaSetup />
        <Card title="How sensitive actions are protected">
          <ul className="list-disc space-y-2 pl-5 text-sm text-slate-700">
            <li>Two-step verification is mandatory for administrators and enforced by the server, not by this screen.</li>
            <li>High-risk actions (approvals, refunds, verification, freezes) ask for a fresh code if your last check was more than a few minutes ago.</li>
            <li>Each recovery code works once. If you lose your authenticator and your codes, another administrator must approve recovery, followed by a waiting period.</li>
          </ul>
          <div className="mt-4"><Notice>Keep at least two administrators so recovery is always possible without database access.</Notice></div>
        </Card>
      </div>
    </>
  );
}
