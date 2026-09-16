/**
 * Playwright's routes for money (M9), under the worker's test-route guard: http/test-routes.ts registers them
 * only with the stand-in provider, and never in production.
 *
 * The money specs must never wait on real time or on a real provider. These two give them the only two things
 * time would otherwise bring: an event from the provider, and a job whose hour has come.
 *
 * - `POST /test/money/provider-event { workspaceId, paymentId? | subscriptionId?, event }` makes the stand-in
 *   do the thing and post its **properly signed** webhook at our own endpoint, exactly as Stripe or Square
 *   would: `settle` (a bank transfer lands), `fail_transfer` (the bank sends it back days later), `dispute`
 *   (the customer's bank takes it back), `cycle` (a plan bills its next month) and `revoke` (the seller ends
 *   our access at the provider). It answers with what the stand-in did and how many webhooks it posted.
 * - `POST /test/money/run-due { workspaceId }` moves this business's money jobs up to now and runs them —
 *   reminders, overdue marks, estimates expiring, plan cycles, refunds and the token refresh — answering
 *   `{ moved, ran }`.
 * - `POST /test/money/link { workspaceId, estimateId | invoiceId | subscriptionId }` hands back the customer's
 *   own link for a document or a plan. A link is `<public_ref><code>` and the code is an HMAC with the worker's
 *   key, so a browser test has no other way to reach `/e/…`, `/i/…` or `/p/…`: the real ones travel by text and
 *   email, and the specs must not read the key. Exactly what `estimateUrlFor`, `invoiceUrlFor` and `planUrlFor`
 *   hand the messages.
 *
 * **A job and the record that armed it commit together, but the event that armed them is handled by the
 * worker's own loop.** So a spec that has just made something happen should wait for that work to drain — or
 * call `run-due` again while `moved` is 0 — rather than reading a row once and assuming.
 */
import { randomUUID } from 'node:crypto';
import { HfosError } from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parseBody, type HttpDeps } from '../http/common';
import { processJobs, type JobMap, type JobStats } from '../jobs';
import type { TenantScope } from '../services';
import { estimateUrlFor, invoiceUrlFor, planUrlFor } from './links';

/**
 * Every money job kind, by the prefix its name starts with. A prefix rather than a list so that a job added
 * later (a reminder, a plan's cycle) is driven by these routes without anyone remembering to come back here.
 */
const MONEY_JOB_PREFIXES = [
  'payments.',
  'payment.',
  'invoice.',
  'estimate.',
  'subscription.',
  'refund.',
  'money.',
] as const;

const ProviderEvent = z.object({
  workspaceId: z.uuid(),
  /** The provider's own payment id (`pi_…`, `sqpay_…`), for everything but a plan's cycle. */
  paymentId: z.string().trim().min(1).max(200).optional(),
  /** The provider's own plan id, for `cycle`. */
  subscriptionId: z.string().trim().min(1).max(200).optional(),
  /** The account to end our access to, for `revoke`. */
  accountId: z.string().trim().min(1).max(200).optional(),
  event: z.enum(['settle', 'fail_transfer', 'dispute', 'cycle', 'revoke']),
  /** A dispute's reason, or the code a returned bank transfer comes back with. */
  reason: z.string().trim().min(1).max(100).optional(),
});

const RunDue = z.object({ workspaceId: z.uuid() });

const MoneyLink = z
  .object({
    workspaceId: z.uuid(),
    estimateId: z.uuid().optional(),
    invoiceId: z.uuid().optional(),
    subscriptionId: z.uuid().optional(),
  })
  .refine((b) => [b.estimateId, b.invoiceId, b.subscriptionId].filter(Boolean).length === 1, {
    error: 'Name one of estimateId, invoiceId or subscriptionId.',
  });

async function scopeOf(deps: HttpDeps, workspaceId: string): Promise<TenantScope> {
  const [ws] = await asWorker(deps.db, { workspaceId }, (tx) =>
    rows<{ organization_id: string }>(
      tx,
      sql`select organization_id from app.workspaces where id = ${workspaceId}`,
    ),
  );
  if (!ws) throw HfosError.notFound('Workspace not found.');
  return { workspaceId, organizationId: ws.organization_id };
}

/** Moves the business's waiting money jobs to now, then runs them until nothing is left. */
async function runDue(
  deps: HttpDeps,
  jobs: JobMap,
  workspaceId: string,
): Promise<{ moved: number; ran: JobStats }> {
  const mine = sql`(${sql.join(
    MONEY_JOB_PREFIXES.map((p) => sql`kind like ${`${p}%`}`),
    sql` or `,
  )})`;
  const moved = await asWorker(deps.db, {}, (tx) =>
    rows<{ id: string }>(
      tx,
      sql`update app.scheduled_jobs set run_at = now()
          where workspace_id = ${workspaceId} and status = 'pending' and run_at > now() and ${mine}
          returning id`,
    ),
  );
  const workerId = `test-money:${randomUUID()}`;
  const ran: JobStats = { claimed: 0, done: 0, rescheduled: 0, retried: 0, failed: 0 };
  // A job that asks to run again right away (it changed while it ran) gets another pass.
  for (let pass = 0; pass < 5; pass++) {
    await asWorker(deps.db, {}, (tx) =>
      tx.execute(
        sql`update app.scheduled_jobs set locked_at = now(), locked_by = ${workerId}
            where workspace_id = ${workspaceId} and status = 'pending' and run_at <= now() and ${mine}
              and (locked_at is null or locked_at < now() - interval '5 minutes')`,
      ),
    );
    const stats = await processJobs({
      ...deps,
      jobs,
      workerId,
      batchSize: 100,
      reservedOnly: true,
    });
    for (const k of Object.keys(ran) as (keyof JobStats)[]) ran[k] += stats[k];
    if (stats.claimed === 0) break;
  }
  return { moved: moved.length, ran };
}

export function registerMoneyTestRoutes(app: FastifyInstance, deps: HttpDeps, jobs: JobMap): void {
  if (process.env.NODE_ENV === 'production') return;

  /**
   * The customer's own link for a document, as the messages will send it. Above the stand-in's guard on
   * purpose: reaching `/e/…` and `/i/…` from a browser test has nothing to do with which provider is on.
   */
  app.post('/test/money/link', async (req) => {
    const body = parseBody(MoneyLink, req.body ?? {});
    const scope = await scopeOf(deps, body.workspaceId);
    const kind = body.estimateId ? 'estimate' : body.invoiceId ? 'invoice' : 'plan';
    const id = body.estimateId ?? body.invoiceId ?? body.subscriptionId!;
    const url = await asWorker(deps.db, scope, (tx) =>
      kind === 'estimate'
        ? estimateUrlFor(tx, deps.moneyLinks, id)
        : kind === 'invoice'
          ? invoiceUrlFor(tx, deps.moneyLinks, id)
          : planUrlFor(tx, deps.moneyLinks, id),
    );
    if (!url) throw HfosError.notFound('No such document.');
    return { kind, url, token: url.slice(url.lastIndexOf('/') + 1) };
  });

  const fake = deps.payments.fake;
  if (!fake) return;

  app.post('/test/money/provider-event', async (req) => {
    const body = parseBody(ProviderEvent, req.body ?? {});
    await scopeOf(deps, body.workspaceId);
    const before = fake.webhooks().length;
    const needs = (value: string | undefined, what: string): string => {
      if (!value) throw HfosError.validation([{ path: what, message: `Name the ${what}.` }]);
      return value;
    };
    let acted: { id: string; status: string } | null = null;
    switch (body.event) {
      case 'settle': {
        const c = await fake.settle(needs(body.paymentId, 'paymentId'));
        acted = c ? { id: c.id, status: c.status } : null;
        break;
      }
      case 'fail_transfer': {
        const c = await fake.failTransfer(needs(body.paymentId, 'paymentId'), body.reason);
        acted = c ? { id: c.id, status: c.status } : null;
        break;
      }
      case 'dispute': {
        const c = await fake.dispute(needs(body.paymentId, 'paymentId'), body.reason);
        acted = c ? { id: c.id, status: c.status } : null;
        break;
      }
      case 'cycle': {
        const c = await fake.cycle(needs(body.subscriptionId, 'subscriptionId'));
        acted = c ? { id: c.id, status: c.status } : null;
        break;
      }
      case 'revoke': {
        await fake.revoke(needs(body.accountId, 'accountId'));
        acted = { id: body.accountId!, status: 'revoked' };
        break;
      }
    }
    const posted = fake.webhooks().slice(before);
    return {
      event: body.event,
      /** Null when the stand-in had nothing to do (a payment that has already settled, say). */
      payment: acted,
      /** Every webhook it posted at us, and whether our own endpoint took it. */
      webhooks: posted.map((p) => ({ type: p.type, eventId: p.eventId, ok: p.ok })),
    };
  });

  app.post('/test/money/run-due', async (req) => {
    const body = parseBody(RunDue, req.body ?? {});
    await scopeOf(deps, body.workspaceId);
    return runDue(deps, jobs, body.workspaceId);
  });
}
