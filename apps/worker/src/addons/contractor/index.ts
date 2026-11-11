/**
 * Contractor Operations in the worker (docs/contractor.md, docs/addon-architecture.md). The worker hands it work only
 * while it's on, and everything it does through the kernel (with `ctx.actor`) is refused the moment it's turned off.
 *
 * - **A job follows its visits:** a visit booked on a job (an appointment whose record is the job) moves a new job to
 *   Scheduled, and a visit started there moves a new or scheduled job to In progress. Never backwards, and never a
 *   job that's on hold, done or cancelled. Both are safe to run again: the command does nothing the second time.
 * - **A visit booked on a job gets its work order,** with the checklist a new visit starts with (the business's own
 *   list, else its trade's), so the crew finds it there whoever booked the visit and from wherever. Safe to run
 *   again: a visit that has one keeps it.
 * - **An approved estimate fills its job:** when a customer says yes to an estimate the builder wrote for a job, the
 *   job's price and budget become what was agreed, at the option they picked. Safe to run again: it adds up every
 *   approved estimate on the job afresh.
 * - **An estimate waiting for an OK is an alert** (the owner's decision 6) for the people who can give it, on Home
 *   and their phones, until it's OK'd, changed so it needs none, sent, or voided.
 */
import { estimateFillJob } from '@hfos/core/addons/contractor/ops/estimates';
import { jobFollowVisit } from '@hfos/core/addons/contractor/ops/jobs';
import { workOrderStart } from '@hfos/core/addons/contractor/ops/work-orders';
import { catalogAddon, executeCommand } from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import { clearAddonAlert, raiseAddonAlert } from '../alerts';
import type { AddonEventContext, AddonWorkerModule } from '../types';

const follow = (what: 'booked' | 'started') => async (ctx: AddonEventContext) => {
  const appointmentId = ctx.event.entityId;
  if (!appointmentId) return;
  await executeCommand(
    ctx.db,
    jobFollowVisit,
    { workspaceId: ctx.scope.workspaceId, appointmentId, what },
    ctx.actor,
    ctx.meta,
  );
};

const visitStarted = follow('started');
const visitBooked = follow('booked');

/** A visit booked on a job: its work order starts, then the job moves along. Anything else booked is left alone. */
async function booked(ctx: AddonEventContext): Promise<void> {
  const appointmentId = ctx.event.entityId;
  if (!appointmentId) return;
  await executeCommand(
    ctx.db,
    workOrderStart,
    { workspaceId: ctx.scope.workspaceId, appointmentId },
    ctx.actor,
    ctx.meta,
  );
  await visitBooked(ctx);
}

const okAlertKey = (estimateId: string) => `estimate-ok:${estimateId}`;
const payloadOf = (ctx: AddonEventContext) => (ctx.event.payload ?? {}) as Record<string, unknown>;
const estimateIdOf = (ctx: AddonEventContext) => {
  const id = payloadOf(ctx)['estimateId'] ?? ctx.event.entityId;
  return typeof id === 'string' ? id : null;
};

/** Someone asked for an OK on an estimate: the people who can give it are told. No amounts: an alert is read widely. */
async function okAsked(ctx: AddonEventContext): Promise<void> {
  const estimateId = estimateIdOf(ctx);
  if (!estimateId) return;
  const [e] = await asWorker(ctx.db, ctx.scope, (tx) =>
    rows<{ customer: string; asker: string | null; record_id: string | null; waiting: boolean }>(
      tx,
      sql`select coalesce(nullif(btrim(concat_ws(' ', p.first_name, p.last_name)), ''), p.email::text, 'a customer')
              as customer,
            coalesce(nullif(btrim(u.full_name), ''), u.email::text) as asker, x.record_id,
            (e.status = 'draft' and x.asked_at is not null) as waiting
          from addon_contractor.estimates x
          join app.estimates e on e.id = x.estimate_id
          left join app.people p on p.id = e.person_id
          left join app.users u on u.id = x.asked_by
          where x.estimate_id = ${estimateId} and x.workspace_id = ${ctx.scope.workspaceId}`,
    ),
  );
  // Already OK'd, changed or sent by the time this ran: nothing to tell anyone.
  if (!e?.waiting) return;
  const why =
    payloadOf(ctx)['reason'] === 'uncosted'
      ? 'Some of its lines have no cost yet, so its margin can’t be checked.'
      : 'It’s under your lowest margin.';
  await raiseAddonAlert(ctx, {
    key: okAlertKey(estimateId),
    severity: 'attention',
    title: `An estimate for ${e.customer} needs your OK`.slice(0, 200),
    detail: `${e.asker ?? 'Someone on the team'} asked for an OK to send it. ${why} Open it to see its costs and profit, then OK it or change it.`,
    href: `/a/contractor/estimates/${estimateId}`,
    permission: 'contractor.approve',
    customRecordId: e.record_id,
  });
}

const okDone = (reason: string) => async (ctx: AddonEventContext) => {
  const estimateId = estimateIdOf(ctx);
  if (estimateId) await clearAddonAlert(ctx, okAlertKey(estimateId), reason);
};

export const contractorAddonWorker: AddonWorkerModule = {
  manifest: catalogAddon('contractor'),
  subscribers: {
    'appointment.booked': booked,
    // A visit's crew pressing Started (core's job.status_changed, its entity the appointment).
    'job.status_changed': async (ctx) => {
      const payload = (ctx.event.payload ?? {}) as Record<string, unknown>;
      if (payload['status'] !== 'in_progress' || payload['statusChanged'] === false) return;
      await visitStarted(ctx);
    },
    'estimate.accepted': async (ctx) => {
      const estimateId = estimateIdOf(ctx);
      if (!estimateId) return;
      await executeCommand(
        ctx.db,
        estimateFillJob,
        { workspaceId: ctx.scope.workspaceId, estimateId },
        ctx.actor,
        ctx.meta,
      );
    },
    'contractor.estimate.ok_asked': okAsked,
    'contractor.estimate.okayed': okDone('done'),
    'contractor.estimate.sent': okDone('done'),
    'estimate.voided': okDone('gone'),
    // A save that leaves nothing to OK ends the ask.
    'contractor.estimate.saved': async (ctx) => {
      if (payloadOf(ctx)['waitingOk'] === false) await okDone('changed')(ctx);
    },
  },
};
