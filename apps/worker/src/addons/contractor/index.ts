/**
 * Contractor Operations in the worker (docs/contractor.md, docs/addon-architecture.md). The worker hands it work only
 * while it's on, and everything it does through the kernel (with `ctx.actor`) is refused the moment it's turned off.
 *
 * - **A job follows its visits:** a visit booked on a job (an appointment whose record is the job) moves a new job to
 *   Scheduled, and a visit started there moves a new or scheduled job to In progress. Never backwards, and never a
 *   job that's on hold, done or cancelled. Both are safe to run again: the command does nothing the second time.
 */
import { jobFollowVisit } from '@hfos/core/addons/contractor/ops/jobs';
import { catalogAddon, executeCommand } from '@hfos/core/server';
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

export const contractorAddonWorker: AddonWorkerModule = {
  manifest: catalogAddon('contractor'),
  subscribers: {
    'appointment.booked': follow('booked'),
    // A visit's crew pressing Started (core's job.status_changed, its entity the appointment).
    'job.status_changed': async (ctx) => {
      const payload = (ctx.event.payload ?? {}) as Record<string, unknown>;
      if (payload['status'] !== 'in_progress' || payload['statusChanged'] === false) return;
      await visitStarted(ctx);
    },
  },
};
