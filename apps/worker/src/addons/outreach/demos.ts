/**
 * The demo link (docs/outreach.md, decision 24; core's rules in packages/core/src/addons/outreach/demos.ts). A booking
 * page opened from a person's demo link keeps its `ref` on the booking (`app.appointment_attendees.link_ref`). When
 * core says something was booked (`appointment.booked`), this reads each new booking's `ref` and, for a demo link's,
 * counts the demo (`outreach.demo.note`), once a booking. A held booking counts once its deposit is paid, when core
 * says it's booked.
 */
import { DEMO_REF_PREFIX, PARTNER_REF_PREFIX } from '@hfos/core/addons/outreach/demos';
import { demoNote } from '@hfos/core/addons/outreach/ops/demos';
import { partnerCall } from '@hfos/core/addons/outreach/ops/partners';
import { executeCommand } from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import type { AddonEventContext } from '../types';

/**
 * `appointment.booked`: a booking through a demo link counts as a demo; one through a partner link (decision 81) moves
 * that partner to Call booked, and is never a demo.
 */
export async function appointmentBooked(ctx: AddonEventContext): Promise<void> {
  const p = (ctx.event.payload ?? {}) as { attendeeId?: string | null };
  const appointmentId = ctx.event.entityId;
  if (!appointmentId) return;
  const linked = await asWorker(ctx.db, ctx.scope, (tx) =>
    rows<{ link_ref: string; person_id: string; created_at: Date | string }>(
      tx,
      sql`select link_ref, person_id, created_at from app.appointment_attendees
          where workspace_id = ${ctx.scope.workspaceId} and appointment_id = ${appointmentId}
            and (link_ref like ${`${DEMO_REF_PREFIX}%`} or link_ref like ${`${PARTNER_REF_PREFIX}%`})
            and (${p.attendeeId ?? null}::uuid is null or id = ${p.attendeeId ?? null}::uuid)`,
    ),
  );
  for (const a of linked)
    if (a.link_ref.startsWith(PARTNER_REF_PREFIX))
      await executeCommand(
        ctx.db,
        partnerCall,
        {
          workspaceId: ctx.scope.workspaceId,
          ref: a.link_ref,
          appointmentId,
          at: new Date(a.created_at).toISOString(),
        },
        ctx.actor,
        ctx.meta,
      );
    else
      await executeCommand(
        ctx.db,
        demoNote,
        {
          workspaceId: ctx.scope.workspaceId,
          ref: a.link_ref,
          appointmentId,
          personId: a.person_id,
          at: new Date(a.created_at).toISOString(),
        },
        ctx.actor,
        ctx.meta,
      );
}
