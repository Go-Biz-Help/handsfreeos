/**
 * A lead in the pipeline for whoever wants a demo (docs/outreach.md, decision 105; core's rules in
 * packages/core/src/addons/outreach/leads.ts). What can show it (the AI's read of a chat, an answer, the person's Ready
 * mark, a demo booked or marked) asks for one (`outreach.lead.wanted`); this has core look again and open it as the
 * system (`outreach.lead.open`), so it lands in the main pipeline's first stage, assigned to whoever reached them.
 * Once they came to a demo booked through the link, the lead moves on and waits for the person's won or lost
 * (decision 106, `outreach.demo.held`).
 */
import { demoHeld, leadOpen } from '@hfos/core/addons/outreach/ops/leads';
import { executeCommand } from '@hfos/core/server';
import type { AddonEventContext } from '../types';

/** `outreach.lead.wanted`: someone the person reached may want a demo. Core says whether they do, once a profile. */
export async function leadWanted(ctx: AddonEventContext): Promise<void> {
  const profileId = ctx.event.entityId;
  const p = (ctx.event.payload ?? {}) as { userId?: string };
  if (!profileId || !p.userId) return;
  await executeCommand(
    ctx.db,
    leadOpen,
    { workspaceId: ctx.scope.workspaceId, profileId, userId: p.userId },
    ctx.actor,
    ctx.meta,
  );
}

/** `appointment.completed`: a demo booked through a demo link was done; its leads move on. */
export async function appointmentCompleted(ctx: AddonEventContext): Promise<void> {
  const appointmentId = ctx.event.entityId;
  if (!appointmentId) return;
  await executeCommand(
    ctx.db,
    demoHeld,
    { workspaceId: ctx.scope.workspaceId, appointmentId },
    ctx.actor,
    ctx.meta,
  );
}
