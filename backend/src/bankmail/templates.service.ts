import { createHash } from 'crypto';
import { DomainError } from '../common/errors';
import { Db } from '../db/db';
import { Actor, AuditService } from '../audit/audit.service';
import { normaliseText, parseAlert, TemplateDefinition, validateDefinition } from './templates';

export interface Sample {
  subject: string;
  text: string;
  /** Phone notifications carry no credit time; a dry run uses this (default: now) as the receipt time. */
  receivedAt?: Date;
}

const view = (r: any) => ({ id: r.id, name: r.name, bankName: r.bank_name, status: r.status, validatedAt: r.validated_at, definition: r.definition, createdAt: r.created_at });

/**
 * Templates describe the operator's REAL bank alert format. A template can only be activated after it parsed a sample email the
 * operator supplied, and a definition is never edited in place (create a new one), so what was validated is what runs.
 */
export class AlertTemplatesService {
  constructor(private readonly db: Db, private readonly audit: AuditService) {}

  async list() {
    return (await this.db.query<any>('SELECT * FROM alert_templates ORDER BY created_at DESC')).map(view);
  }

  async create(actor: Actor, input: { name: string; bankName: string; definition: unknown }) {
    const def = validateDefinition(input.definition);
    if (!input.name.trim() || !input.bankName.trim()) throw new DomainError('INVALID_TEMPLATE', 'name and bankName are required');
    return this.db.transaction(async (tx) => {
      const dup = await tx.query('SELECT 1 FROM alert_templates WHERE name=$1', [input.name.trim()]);
      if (dup.length) throw new DomainError('TEMPLATE_EXISTS', 'A template with this name already exists', 409);
      const [r] = await tx.query<any>(`INSERT INTO alert_templates(name, bank_name, definition, created_by) VALUES ($1,$2,$3,$4) RETURNING *`, [input.name.trim(), input.bankName.trim(), JSON.stringify(def), actor.id]);
      await this.audit.record(tx, actor, 'alert_template.created', 'alert_template', r.id, { name: r.name });
      return view(r);
    });
  }

  /** Dry run: shows what would be extracted. Writes nothing and credits nothing. Authenticity is only checked on real ingestion. */
  testDefinition(definition: unknown, sample: Sample) {
    const def = validateDefinition(definition);
    const r = parseAlert(def, { ...sample, receivedAt: sample.receivedAt ?? new Date() });
    return r.ok ? { ok: true as const, credit: { ...r.credit, creditedAt: r.credit.creditedAt.toISOString() } } : { ok: false as const, reason: r.reason, kind: r.kind };
  }

  async testStored(id: string, sample: Sample) {
    const [t] = await this.db.query<any>('SELECT definition FROM alert_templates WHERE id=$1', [id]);
    if (!t) throw new DomainError('NOT_FOUND', 'Template not found', 404);
    return this.testDefinition(t.definition, sample);
  }

  /** The operator attests that `sample` is a real alert from their bank; the template must parse it completely. */
  async validateWithSample(actor: Actor, id: string, sample: Sample) {
    const [t] = await this.db.query<any>('SELECT * FROM alert_templates WHERE id=$1', [id]);
    if (!t) throw new DomainError('NOT_FOUND', 'Template not found', 404);
    const res = parseAlert(t.definition as TemplateDefinition, { ...sample, receivedAt: sample.receivedAt ?? new Date() });
    if (!res.ok) throw new DomainError('SAMPLE_DOES_NOT_PARSE', `The sample did not parse (${res.reason}); adjust the template and create a new one`, 422);
    const hash = createHash('sha256').update(normaliseText(sample.text)).digest('hex');
    await this.db.transaction(async (tx) => {
      await tx.query(`UPDATE alert_templates SET validated_at=now(), validated_sample_hash=$2 WHERE id=$1`, [id, hash]);
      await this.audit.record(tx, actor, 'alert_template.validated', 'alert_template', id, { sampleHash: hash.slice(0, 16) });
    });
    return { ok: true, credit: { ...res.credit, creditedAt: res.credit.creditedAt.toISOString() } };
  }

  async activate(actor: Actor, id: string) {
    return this.db.transaction(async (tx) => {
      const [t] = await tx.query<any>('SELECT * FROM alert_templates WHERE id=$1 FOR UPDATE', [id]);
      if (!t) throw new DomainError('NOT_FOUND', 'Template not found', 404);
      if (!t.validated_at) throw new DomainError('NOT_VALIDATED', 'Validate the template against a real sample email first', 409);
      await tx.query(`UPDATE alert_templates SET status='ACTIVE' WHERE id=$1`, [id]);
      await this.audit.record(tx, actor, 'alert_template.activated', 'alert_template', id, { name: t.name });
    });
  }

  async disable(actor: Actor, id: string) {
    await this.db.transaction(async (tx) => {
      const rows = await tx.query(`UPDATE alert_templates SET status='DISABLED' WHERE id=$1 RETURNING id`, [id]);
      if (!rows.length) throw new DomainError('NOT_FOUND', 'Template not found', 404);
      await this.audit.record(tx, actor, 'alert_template.disabled', 'alert_template', id);
    });
  }
}
