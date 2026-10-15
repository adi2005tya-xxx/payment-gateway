import { Db, Queryable } from '../db/db';
import { DeferJob, TransientError } from '../common/errors';

export type JobHandler = (payload: any, ctx: { attempt: number; maxAttempts: number }) => Promise<void>;

/** Exponential backoff with full jitter, capped at 15 minutes. */
export function backoffMs(attempt: number, rand: () => number = Math.random): number {
  const cap = Math.min(15 * 60_000, 1000 * 2 ** attempt);
  return Math.floor(rand() * cap) + 500;
}

/**
 * Durable job queue (also the transactional outbox: enqueue() runs in the caller's DB transaction,
 * so a job exists if and only if the business change committed).
 * Handlers must be idempotent: delivery is at-least-once.
 */
export class JobsService {
  constructor(private readonly db: Db) {}

  async enqueue(tx: Queryable, kind: string, payload: unknown, opts: { dedupeKey?: string; runAt?: Date; maxAttempts?: number } = {}) {
    await tx.query(
      `INSERT INTO jobs(kind, payload, dedupe_key, run_at, max_attempts) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (dedupe_key) DO NOTHING`,
      [kind, JSON.stringify(payload), opts.dedupeKey ?? null, (opts.runAt ?? new Date()).toISOString(), opts.maxAttempts ?? 8],
    );
  }

  private async claim(now: Date) {
    return this.db.transaction(async (tx) => {
      const rows = await tx.query<any>(
        `SELECT id FROM jobs
          WHERE (status = 'PENDING' AND run_at <= $1) OR (status = 'RUNNING' AND locked_until < $1)
          ORDER BY run_at, id LIMIT 1 FOR UPDATE SKIP LOCKED`,
        [now.toISOString()],
      );
      if (rows.length === 0) return null;
      const job = await tx.query<any>(
        `UPDATE jobs SET status='RUNNING', attempts = attempts + 1, locked_until = $2::timestamptz + interval '60 seconds'
          WHERE id = $1 RETURNING *`,
        [rows[0].id, now.toISOString()],
      );
      return job[0];
    });
  }

  /** Runs one due job. Returns false when the queue has nothing due. */
  async runOne(handlers: Record<string, JobHandler>, now: Date = new Date()): Promise<boolean> {
    const job = await this.claim(now);
    if (!job) return false;
    try {
      const handler = handlers[job.kind];
      if (!handler) throw new Error(`No handler for job kind ${job.kind}`);
      await handler(job.payload, { attempt: job.attempts, maxAttempts: job.max_attempts });
      await this.db.query(`UPDATE jobs SET status='DONE', last_error=NULL WHERE id=$1`, [job.id]);
    } catch (e: any) {
      if (e instanceof DeferJob) {
        await this.db.query(`UPDATE jobs SET status='PENDING', attempts = attempts - 1, run_at=$2, locked_until=NULL, last_error=$3 WHERE id=$1`, [
          job.id,
          new Date(now.getTime() + e.delayMs).toISOString(),
          e.message,
        ]);
        return true;
      }
      const message = String(e?.message ?? e).slice(0, 500);
      if (job.attempts >= job.max_attempts) {
        await this.db.transaction(async (tx) => {
          await tx.query(`UPDATE jobs SET status='DEAD', last_error=$2 WHERE id=$1`, [job.id, message]);
          await tx.query(`INSERT INTO alerts(kind, detail) VALUES ('JOB_DEAD_LETTER', $1)`, [JSON.stringify({ jobId: job.id, kind: job.kind, error: message })]);
        });
      } else {
        const next = new Date(now.getTime() + (e instanceof TransientError ? backoffMs(job.attempts) : backoffMs(job.attempts + 1)));
        await this.db.query(`UPDATE jobs SET status='PENDING', run_at=$2, last_error=$3, locked_until=NULL WHERE id=$1`, [
          job.id,
          next.toISOString(),
          message,
        ]);
      }
    }
    return true;
  }

  /** Drains due jobs (including ones enqueued by other jobs). `now` lets tests skip over backoff delays. */
  async drain(handlers: Record<string, JobHandler>, now: Date = new Date(), limit = 200): Promise<number> {
    let n = 0;
    while (n < limit && (await this.runOne(handlers, now))) n++;
    return n;
  }

  /** Manual replay of a dead-lettered job. */
  async replayDead(jobId: number) {
    await this.db.query(`UPDATE jobs SET status='PENDING', attempts=0, run_at=now(), locked_until=NULL WHERE id=$1 AND status='DEAD'`, [jobId]);
  }
}
