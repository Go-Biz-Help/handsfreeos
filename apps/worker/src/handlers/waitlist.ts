import { eq } from 'drizzle-orm';
import { executeCommand, waitlistPromote } from '@hfos/core/server';
import { appointments } from '@hfos/db/schema';
import { offerFreedTime } from '../booking/waitlist';
import { systemActor, tenantOf, workerMeta } from '../services';
import type { EventHandler } from './types';

/**
 * A seat or a 1:1 time opened on a calendar with people waiting. In a session or group time, the oldest
 * waiting customers that fit are booked in and told (their confirmation follows from appointment.booked).
 * A 1:1 time on an hours calendar is offered to the next person whose wanted times cover it.
 */
export const onSeatFreed: EventHandler = async (ctx) => {
  const scope = tenantOf(ctx.scope);
  const appointmentId = ctx.event.entityId;
  if (!appointmentId) return;
  const [appt] = await ctx.tx
    .select({ kind: appointments.kind, capacity: appointments.capacity })
    .from(appointments)
    .where(eq(appointments.id, appointmentId));
  if (!appt) return;
  const meta = workerMeta(ctx.event.correlationId, ctx.event.id);
  if (appt.kind === 'session' || appt.capacity > 1) {
    await executeCommand(
      ctx.db,
      waitlistPromote,
      { workspaceId: scope.workspaceId, appointmentId },
      systemActor(scope),
      meta,
    );
    return;
  }
  await offerFreedTime(ctx, scope, appointmentId, meta, Date.now());
};
