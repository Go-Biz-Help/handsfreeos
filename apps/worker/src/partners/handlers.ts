/**
 * Partners (HANDSFREEOS_PARTNERS_IMPLEMENTATION_PLAN.md, stage 2): what the worker notes as the business's work goes
 * on. A booking through a partner's link makes its customer that partner's client; each payment a client makes earns
 * their partner a share; a refund takes back the share of what went back. Core's commands do the sums, in the event's
 * own transaction, so a retry finds what the last try wrote and adds nothing.
 *
 * They run whether or not an add-on that uses partners is on: a partner was promised their share. Most bookings,
 * payments and refunds have nothing to do with a partner, and those cost one look here and nothing more.
 */
import {
  executeCommandIn,
  partnerCommissionNote,
  partnerCommissionTakeBack,
  partnerReferralNote,
  PARTNER_LINK_PREFIX,
} from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import type { EventHandler, HandlerContext } from '../handlers/types';
import { systemActor, tenantOf, workerMeta } from '../services';

const payloadOf = (ctx: HandlerContext): Record<string, unknown> =>
  (ctx.event.payload ?? {}) as Record<string, unknown>;

const idIn = (p: Record<string, unknown>, field: string, fallback: string | null): string | null =>
  typeof p[field] === 'string' && p[field] ? (p[field] as string) : fallback;

const metaOf = (ctx: HandlerContext) => workerMeta(ctx.event.correlationId, ctx.event.id);

/** `appointment.booked`: a customer who booked through a partner's link becomes their client. */
export const onPartnerBooking: EventHandler = async (ctx) => {
  const scope = tenantOf(ctx.scope);
  const appointmentId = ctx.event.entityId;
  if (!appointmentId) return;
  const [linked] = await rows<{ id: string }>(
    ctx.tx,
    sql`select t.id from app.appointment_attendees t
        where t.workspace_id = ${scope.workspaceId} and t.appointment_id = ${appointmentId}
          and t.link_ref like ${`${PARTNER_LINK_PREFIX}%`}
        limit 1`,
  );
  if (!linked) return;
  await executeCommandIn(
    ctx.tx,
    partnerReferralNote,
    { workspaceId: scope.workspaceId, appointmentId },
    systemActor(scope),
    metaOf(ctx),
  );
};

/** `payment.recorded`: a partner's client paid, so the partner earns their share. */
export const onPartnerPayment: EventHandler = async (ctx) => {
  const scope = tenantOf(ctx.scope);
  const p = payloadOf(ctx);
  const paymentId = idIn(p, 'paymentId', ctx.event.entityId);
  if (!paymentId || p['status'] !== 'succeeded') return;
  const [client] = await rows<{ id: string }>(
    ctx.tx,
    sql`select r.id from app.payments p join app.invoices i on i.id = p.invoice_id
        join app.partner_referrals r on r.workspace_id = p.workspace_id and r.person_id = i.person_id
        where p.workspace_id = ${scope.workspaceId} and p.id = ${paymentId}`,
  );
  if (!client) return;
  await executeCommandIn(
    ctx.tx,
    partnerCommissionNote,
    { workspaceId: scope.workspaceId, paymentId },
    systemActor(scope),
    metaOf(ctx),
  );
};

/** `refund.recorded`: money went back on a payment a partner earned on, so their share of it goes back too. */
export const onPartnerRefund: EventHandler = async (ctx) => {
  const scope = tenantOf(ctx.scope);
  const p = payloadOf(ctx);
  const refundId = idIn(p, 'refundId', ctx.event.entityId);
  if (!refundId || p['status'] !== 'succeeded') return;
  const [earned] = await rows<{ id: string }>(
    ctx.tx,
    sql`select c.id from app.refunds r
        join app.partner_commissions c on c.payment_id = r.payment_id and c.kind = 'earned'
        where r.workspace_id = ${scope.workspaceId} and r.id = ${refundId}`,
  );
  if (!earned) return;
  await executeCommandIn(
    ctx.tx,
    partnerCommissionTakeBack,
    { workspaceId: scope.workspaceId, refundId },
    systemActor(scope),
    metaOf(ctx),
  );
};
