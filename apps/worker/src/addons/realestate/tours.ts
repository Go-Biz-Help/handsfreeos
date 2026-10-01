/**
 * Tours in the worker (HANDSFREEOS_REAL_ESTATE_IMPLEMENTATION_PLAN.md, "Round two: Buyer core"): a tour is an
 * appointment on the calendar, so when someone moves or cancels the appointment there (the team on the calendar, or
 * the client from their booking's link), the tour follows, with a line in the deal's history saying who did it.
 * Changes the tour made itself come back here too, and change nothing.
 */
import { tourFollow } from '@hfos/core/addons/realestate/ops/tours';
import { executeCommand } from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import type { AddonEventContext } from '../types';

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

/** `appointment.rescheduled` / `appointment.cancelled`: a tour's appointment changed on the calendar. */
export async function tourAppointmentChanged(ctx: AddonEventContext): Promise<void> {
  const appointmentId = ctx.event.entityId;
  if (!appointmentId) return;
  const [tour] = await asWorker(ctx.db, ctx.scope, (tx) =>
    rows<{ id: string }>(
      tx,
      sql`select id from addon_realestate.tours where appointment_id = ${appointmentId} and status = 'planned'`,
    ),
  );
  if (!tour) return;
  const p = (ctx.event.payload ?? {}) as Record<string, unknown>;
  const to = (p['to'] ?? {}) as Record<string, unknown>;
  const cancelled = ctx.event.eventType === 'appointment.cancelled';
  await executeCommand(
    ctx.db,
    tourFollow,
    {
      workspaceId: ctx.scope.workspaceId,
      appointmentId,
      change: cancelled ? 'cancelled' : 'rescheduled',
      ...(cancelled ? {} : { startsAt: str(to['startsAt']), endsAt: str(to['endsAt']) }),
      by: str(p['by']),
      reason: str(p['reason']) ?? null,
    },
    ctx.actor,
    ctx.meta,
  );
}
