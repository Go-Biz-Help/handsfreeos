/**
 * Partners in core (HANDSFREEOS_PARTNERS_IMPLEMENTATION_PLAN.md, stage 2; docs/outreach.md decision 81): people who
 * send the business its customers for a share of what they pay. Whoever holds `partners.manage` saves the partner
 * settings, adds a partner and changes their rate or status, and marks by hand who sent a customer. The worker notes
 * a booking through a partner's link, each payment's share, and what a refund takes back.
 *
 * People's commands refuse while no add-on that uses partners runs here (`partners_not_in_use`), as the main offer's
 * do. The worker's keep counting all the same: a partner was promised their share, and nothing is earned without one.
 */
import { randomInt } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { rows, sql } from '@hfos/db/client';
import { partnerReferrals, partners, workspaces } from '@hfos/db/schema';
import { ADDON_CATALOG } from '../addons/catalog';
import { addonsUsing, coreFeatureRunning } from '../addons/capabilities';
import { loadActiveAddons } from '../addons/load';
import { HfosError } from '../errors';
import { requireHuman, userIdOf } from '../kernel/actor';
import { defineCommand } from '../kernel/define';
import { changeMoment } from '../kernel/moment';
import type { CommandContext, QueryContext } from '../kernel/types';
import {
  commissionCents,
  monthsEndAt,
  partnerCodeOf,
  PARTNER_CODE_LENGTH,
  PARTNER_LINK_PREFIX,
  payableAt,
} from '../partners/rules';
import { partnerSettingsOf, type PartnerSettings } from '../partners/settings';
import {
  PartnerAddInput,
  PartnerAddOutput,
  PartnerCommissionNoteInput,
  PartnerCommissionNoteOutput,
  PartnerCommissionTakeBackInput,
  PartnerCommissionTakeBackOutput,
  PartnerReferralNoteInput,
  PartnerReferralNoteOutput,
  PartnerReferralSetInput,
  PartnerReferralSetOutput,
  PartnersSaveSettingsInput,
  PartnersSaveSettingsOutput,
  PartnerUpdateInput,
  PartnerUpdateOutput,
} from '../schemas/partners';

const inWorkspace = (i: { workspaceId: string }) => ({
  kind: 'workspace' as const,
  workspaceId: i.workspaceId,
});

/** "Social Outreach", or "Social Outreach or another". */
function comesWithWords(): string {
  const names = addonsUsing(ADDON_CATALOG, 'partners');
  if (names.length <= 1) return names[0] ?? 'an add-on';
  return `${names.slice(0, -1).join(', ')} or ${names.at(-1)}`;
}

/** Whether an add-on that uses partners runs in the business. */
export async function partnersInUse(
  ctx: Pick<CommandContext | QueryContext, 'tx'>,
  workspaceId: string,
): Promise<boolean> {
  const running = await loadActiveAddons(ctx.tx, workspaceId);
  return coreFeatureRunning(ADDON_CATALOG, running, 'partners');
}

/** Refuses unless an add-on that uses partners runs here. */
export async function requirePartnersInUse(ctx: CommandContext): Promise<void> {
  if (await partnersInUse(ctx, ctx.scope.workspaceId!)) return;
  throw HfosError.rule(
    'partners_not_in_use',
    409,
    `Partners come with ${comesWithWords()}, which isn’t on in this business. An owner or admin can turn it on in Settings → Add-ons. Your partners and what they earned are kept until then.`,
  );
}

/** The business's partner settings, every default filled in. */
export async function loadPartnerSettings(
  ctx: Pick<CommandContext | QueryContext, 'tx'>,
  workspaceId: string,
): Promise<PartnerSettings> {
  const [w] = await rows<{ settings: Record<string, unknown> | null }>(
    ctx.tx,
    sql`select settings from app.workspaces where id = ${workspaceId}`,
  );
  return partnerSettingsOf(w?.settings ?? null);
}

/** A person's name as the business sees it: their name, else their email. */
export const PERSON_NAME = sql.raw(
  `coalesce(nullif(btrim(coalesce(pp.first_name, '') || ' ' || coalesce(pp.last_name, '')), ''), pp.email::text, 'A customer')`,
);

/** A contact of the business, still kept, with their name. */
async function contactOf(ctx: CommandContext, personId: string) {
  const [row] = await rows<{ id: string; name: string }>(
    ctx.tx,
    sql`select pp.id, ${PERSON_NAME} as name from app.people pp
        where pp.workspace_id = ${ctx.scope.workspaceId} and pp.id = ${personId}
          and pp.merged_into_id is null and pp.erased_at is null`,
  );
  if (!row)
    throw HfosError.notFound(
      'That contact isn’t there anymore. They may have been merged or deleted. Refresh and try again.',
    );
  return row;
}

/** A partner of the business, held until the command ends, with their contact's name. */
async function partnerOf(ctx: CommandContext, partnerId: string) {
  const [row] = await rows<{
    id: string;
    person_id: string;
    code: string;
    rate_bp: number | null;
    status: 'active' | 'paused' | 'ended';
    name: string;
  }>(
    ctx.tx,
    sql`select pa.id, pa.person_id, pa.code, pa.rate_bp, pa.status, ${PERSON_NAME} as name
        from app.partners pa join app.people pp on pp.id = pa.person_id
        where pa.workspace_id = ${ctx.scope.workspaceId} and pa.id = ${partnerId}
        for update of pa`,
  );
  if (!row)
    throw HfosError.notFound('That partner isn’t there anymore. Refresh your Partners list.');
  return row;
}

const CODE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

/** A new code for a partner's link: 10 letters and digits, none easily misread. */
export function newPartnerCode(): string {
  let code = '';
  for (let i = 0; i < PARTNER_CODE_LENGTH; i++)
    code += CODE_LETTERS[randomInt(CODE_LETTERS.length)];
  return code;
}

// ---------- settings ----------

export const partnersSaveSettings = defineCommand({
  name: 'partners.save_settings',
  description:
    'Save the partner settings: the share partners earn unless they have their own, the terms they accept, the smallest payout ($25 or lower), and the calendar their links book. Partners accept changed terms again.',
  risk: 2,
  input: PartnersSaveSettingsInput,
  output: PartnersSaveSettingsOutput,
  permission: 'partners.manage',
  scope: inWorkspace,
  emits: ['partners.settings_saved'],
  async handler(ctx, input) {
    requireHuman(ctx);
    await requirePartnersInUse(ctx);
    const ws = ctx.scope.workspaceId!;
    const [w] = await ctx.tx
      .select({ settings: workspaces.settings })
      .from(workspaces)
      .where(eq(workspaces.id, ws));
    if (!w)
      throw HfosError.notFound(
        'That business isn’t there, or you’re no longer in it. Pick a business from your list.',
      );
    const stored = (w.settings ?? {}) as Record<string, unknown>;
    const current = partnerSettingsOf(stored);
    if (input.settings.calendarId) {
      const [calendar] = await rows<{ public: boolean; name: string; status: string }>(
        ctx.tx,
        sql`select c.public, c.name, c.status::text as status from app.calendars c
            where c.workspace_id = ${ws} and c.id = ${input.settings.calendarId} and c.status <> 'archived'`,
      );
      if (!calendar)
        throw HfosError.validation(
          [
            {
              path: 'settings.calendarId',
              message: 'That calendar isn’t there anymore. Pick another.',
            },
          ],
          'That calendar isn’t there anymore. Pick another in Settings → Partners.',
        );
      if (!calendar.public || calendar.status !== 'active')
        throw HfosError.validation(
          [
            {
              path: 'settings.calendarId',
              message: `${calendar.name} isn’t taking bookings on the booking page, so partners’ clients couldn’t book it. Pick another.`,
            },
          ],
          `${calendar.name} isn’t taking bookings on the booking page. Pick another, or turn it on and make it public in Settings → Calendars.`,
        );
    }
    const termsChanged = input.settings.terms !== current.terms;
    const next: PartnerSettings = {
      rateBp: input.settings.rateBp,
      terms: input.settings.terms,
      // New words to accept: partners see them on their page and accept them again.
      termsVersion:
        termsChanged && input.settings.terms ? current.termsVersion + 1 : current.termsVersion,
      smallestPayoutCents: input.settings.smallestPayoutCents,
      calendarId: input.settings.calendarId,
    };
    if (JSON.stringify(next) !== JSON.stringify(current)) {
      const [row] = await ctx.tx
        .update(workspaces)
        .set({ settings: { ...stored, partners: next } })
        .where(eq(workspaces.id, ws))
        .returning({ id: workspaces.id });
      if (!row) throw HfosError.forbidden();
      await ctx.emit({
        type: 'partners.settings_saved',
        entityType: 'workspace',
        entityId: ws,
        payload: {
          fields: (Object.keys(next) as (keyof PartnerSettings)[]).filter(
            (k) => next[k] !== current[k],
          ),
        },
        before: { partners: current },
        after: { partners: next },
      });
    }
    return { settings: next };
  },
});

// ---------- a partner ----------

export const partnerAdd = defineCommand({
  name: 'partner.add',
  description:
    'Make a contact a partner of the business: they get a link of their own, and each customer who books through it earns them a share of what that customer pays in their first 12 months. Brings back a partner who was paused or ended.',
  risk: 2,
  input: PartnerAddInput,
  output: PartnerAddOutput,
  permission: 'partners.manage',
  scope: inWorkspace,
  emits: ['partner.added', 'partner.updated'],
  async handler(ctx, input) {
    await requirePartnersInUse(ctx);
    const ws = ctx.scope.workspaceId!;
    const person = await contactOf(ctx, input.personId);
    const [existing] = await ctx.tx
      .select()
      .from(partners)
      .where(and(eq(partners.workspaceId, ws), eq(partners.personId, person.id)))
      .for('update');
    if (existing) {
      if (existing.status !== 'active') {
        await ctx.tx.update(partners).set({ status: 'active' }).where(eq(partners.id, existing.id));
        await ctx.emit({
          type: 'partner.updated',
          entityType: 'partner',
          entityId: existing.id,
          payload: { partnerId: existing.id, personId: person.id, fields: ['status'] },
          before: { status: existing.status },
          after: { status: 'active' },
        });
      }
      return { partnerId: existing.id, code: existing.code, created: false };
    }
    // Codes are unguessable and unique everywhere: a clash is all but impossible, and tried again if it comes.
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = newPartnerCode();
      const [row] = await ctx.tx
        .insert(partners)
        .values({
          workspaceId: ws,
          personId: person.id,
          code,
          rateBp: input.rateBp,
          addedBy: userIdOf(ctx.actor),
        })
        .onConflictDoNothing({ target: partners.code })
        .returning({ id: partners.id });
      if (!row) continue;
      await ctx.emit({
        type: 'partner.added',
        entityType: 'partner',
        entityId: row.id,
        payload: { partnerId: row.id, personId: person.id },
        after: { name: person.name, rateBp: input.rateBp },
      });
      return { partnerId: row.id, code, created: true };
    }
    throw HfosError.rule(
      'partner_code_taken',
      409,
      'HandsFreeOS couldn’t make a link for them just now. Try again in a minute.',
    );
  },
});

export const partnerUpdate = defineCommand({
  name: 'partner.update',
  description:
    'Change a partner’s own share (or go back to the business’s), or pause or end them. A paused or ended partner earns nothing on payments from then on; what they earned is kept.',
  risk: 2,
  input: PartnerUpdateInput,
  output: PartnerUpdateOutput,
  permission: 'partners.manage',
  scope: inWorkspace,
  emits: ['partner.updated'],
  async handler(ctx, input) {
    await requirePartnersInUse(ctx);
    const row = await partnerOf(ctx, input.partnerId);
    const set: { rateBp?: number | null; status?: 'active' | 'paused' | 'ended' } = {};
    if (input.rateBp !== undefined && input.rateBp !== row.rate_bp) set.rateBp = input.rateBp;
    if (input.status !== undefined && input.status !== row.status) set.status = input.status;
    const updated = Object.keys(set);
    if (!updated.length) return { partnerId: row.id, updated: [] };
    await ctx.tx.update(partners).set(set).where(eq(partners.id, row.id));
    await ctx.emit({
      type: 'partner.updated',
      entityType: 'partner',
      entityId: row.id,
      payload: { partnerId: row.id, personId: row.person_id, fields: updated },
      before: { rateBp: row.rate_bp, status: row.status },
      after: set,
    });
    return { partnerId: row.id, updated };
  },
});

// ---------- the clients they sent ----------

/** Whether a referral ever earned its partner anything, even what was taken back since. */
async function hasEarned(ctx: CommandContext, referralId: string): Promise<boolean> {
  const [row] = await rows<{ earned: boolean }>(
    ctx.tx,
    sql`select exists (select 1 from app.partner_commissions where referral_id = ${referralId}) as earned`,
  );
  return row?.earned ?? false;
}

export const partnerReferralSet = defineCommand({
  name: 'partner.referral_set',
  description:
    'Mark which partner sent a customer, or that none did. Their payments from then on, in their first 12 months, earn that partner their share. A customer who has earned a partner something stays theirs.',
  risk: 2,
  input: PartnerReferralSetInput,
  output: PartnerReferralSetOutput,
  permission: 'partners.manage',
  scope: inWorkspace,
  emits: ['partner.referred', 'partner.referral_removed'],
  async handler(ctx, input) {
    const human = requireHuman(ctx);
    await requirePartnersInUse(ctx);
    const ws = ctx.scope.workspaceId!;
    const person = await contactOf(ctx, input.personId);
    const partner = input.partnerId ? await partnerOf(ctx, input.partnerId) : null;
    if (partner && partner.person_id === person.id)
      throw HfosError.rule(
        'partner_own_client',
        409,
        `${partner.name} is the partner, so they can’t be their own client.`,
      );
    const [current] = await rows<{ id: string; partner_id: string; name: string }>(
      ctx.tx,
      sql`select r.id, r.partner_id, ${PERSON_NAME} as name from app.partner_referrals r
          join app.partners pa on pa.id = r.partner_id join app.people pp on pp.id = pa.person_id
          where r.workspace_id = ${ws} and r.person_id = ${person.id}`,
    );
    if (current && current.partner_id === partner?.id) return { referralId: current.id };
    if (current) {
      // What a client earned their partner is that partner's: they stay their client. A commission the worker notes
      // meanwhile holds the referral too (its key never cascades), so the delete below is refused rather than lost.
      if (await hasEarned(ctx, current.id))
        throw HfosError.rule(
          'partner_client_has_earned',
          409,
          `${person.name} has earned ${current.name} commission already, so they stay ${current.name}’s client.`,
        );
      await ctx.tx.delete(partnerReferrals).where(eq(partnerReferrals.id, current.id));
      await ctx.emit({
        type: 'partner.referral_removed',
        entityType: 'person',
        entityId: person.id,
        payload: { referralId: current.id, partnerId: current.partner_id, personId: person.id },
      });
    }
    if (!partner) return { referralId: null };
    const [row] = await ctx.tx
      .insert(partnerReferrals)
      .values({
        workspaceId: ws,
        partnerId: partner.id,
        personId: person.id,
        how: 'by_hand',
        referredAt: changeMoment(ctx.meta),
        markedBy: human.userId,
      })
      .returning({ id: partnerReferrals.id });
    if (!row) throw HfosError.forbidden();
    await ctx.emit({
      type: 'partner.referred',
      entityType: 'person',
      entityId: person.id,
      payload: { referralId: row.id, partnerId: partner.id, personId: person.id, how: 'by_hand' },
    });
    return { referralId: row.id };
  },
});

export const partnerReferralNote = defineCommand({
  name: 'partner.referral_note',
  description:
    'Worker: a booking came in. Each customer on it who booked through a partner’s link becomes that partner’s client, unless they’re someone’s already or they’re the partner.',
  risk: 0,
  input: PartnerReferralNoteInput,
  output: PartnerReferralNoteOutput,
  permission: null,
  actors: ['system'],
  scope: inWorkspace,
  emits: ['partner.referred', 'partner.commission_earned', 'partner.commission_taken_back'],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const seats = await rows<{ person_id: string; link_ref: string; created_at: Date | string }>(
      ctx.tx,
      sql`select t.person_id, t.link_ref, t.created_at from app.appointment_attendees t
          where t.workspace_id = ${ws} and t.appointment_id = ${input.appointmentId}
            and t.link_ref like ${`${PARTNER_LINK_PREFIX}%`} and t.person_id is not null`,
    );
    let referred = 0;
    for (const seat of seats) {
      const code = partnerCodeOf(seat.link_ref);
      if (!code) continue;
      const [partner] = await rows<{ id: string; person_id: string }>(
        ctx.tx,
        sql`select pa.id, pa.person_id from app.partners pa
            where pa.workspace_id = ${ws} and pa.code = ${code} and pa.status <> 'ended'`,
      );
      if (!partner || partner.person_id === seat.person_id) continue;
      const [row] = await ctx.tx
        .insert(partnerReferrals)
        .values({
          workspaceId: ws,
          partnerId: partner.id,
          personId: seat.person_id,
          how: 'link',
          appointmentId: input.appointmentId,
          referredAt: new Date(seat.created_at),
        })
        .onConflictDoNothing({ target: [partnerReferrals.workspaceId, partnerReferrals.personId] })
        .returning({ id: partnerReferrals.id });
      if (!row) continue;
      referred++;
      await ctx.emit({
        type: 'partner.referred',
        entityType: 'person',
        entityId: seat.person_id,
        payload: {
          referralId: row.id,
          partnerId: partner.id,
          personId: seat.person_id,
          how: 'link',
          appointmentId: input.appointmentId,
        },
      });
      // A deposit paid as they booked can be noted before the booking is: what they paid since counts all the same.
      const paid = await rows<{ id: string }>(
        ctx.tx,
        sql`select p.id from app.payments p join app.invoices i on i.id = p.invoice_id
            where p.workspace_id = ${ws} and i.person_id = ${seat.person_id} and p.status = 'succeeded'
              and p.received_at >= ${new Date(seat.created_at).toISOString()}::timestamptz
            order by p.received_at, p.id`,
      );
      for (const p of paid) await earnOn(ctx, p.id);
    }
    return { referred };
  },
});

// ---------- what they earn ----------

/**
 * A client's payment earns their partner a share: their first payment after they were sent starts their 12 months,
 * and each payment in them earns an active partner their share of what the client paid, free to pay out 30 days later.
 * A refund already noted on the payment takes its share back at once, so it doesn't matter which is noted first.
 */
async function earnOn(ctx: CommandContext, paymentId: string): Promise<boolean> {
  const ws = ctx.scope.workspaceId!;
  const [payment] = await rows<{
    amount_cents: string | number;
    status: string;
    received_at: Date | string | null;
    person_id: string;
    test: boolean;
  }>(
    ctx.tx,
    sql`select p.amount_cents, p.status::text as status, p.received_at, i.person_id,
          coalesce(c.environment = 'test', false) as test
        from app.payments p join app.invoices i on i.id = p.invoice_id
        left join app.payment_connections c on c.id = p.connection_id
        where p.workspace_id = ${ws} and p.id = ${paymentId}`,
  );
  if (!payment || payment.status !== 'succeeded' || !payment.received_at) return false;
  const receivedAt = new Date(payment.received_at);
  const [referral] = await rows<{
    id: string;
    partner_id: string;
    referred_at: Date | string;
    first_paid_at: Date | string | null;
    status: string;
    rate_bp: number | null;
  }>(
    ctx.tx,
    sql`select r.id, r.partner_id, r.referred_at, r.first_paid_at, pa.status, pa.rate_bp
        from app.partner_referrals r join app.partners pa on pa.id = r.partner_id
        where r.workspace_id = ${ws} and r.person_id = ${payment.person_id}
        for update of r`,
  );
  // Only what they pay after they were sent counts.
  if (!referral || receivedAt < new Date(referral.referred_at)) return false;
  const firstPaidAt =
    referral.first_paid_at && new Date(referral.first_paid_at) <= receivedAt
      ? new Date(referral.first_paid_at)
      : receivedAt;
  if (
    !referral.first_paid_at ||
    firstPaidAt.getTime() !== new Date(referral.first_paid_at).getTime()
  )
    await ctx.tx
      .update(partnerReferrals)
      .set({ firstPaidAt })
      .where(eq(partnerReferrals.id, referral.id));
  if (receivedAt >= monthsEndAt(firstPaidAt) || referral.status !== 'active') return false;
  const rateBp = referral.rate_bp ?? (await loadPartnerSettings(ctx, ws)).rateBp;
  const baseCents = Number(payment.amount_cents);
  const amountCents = commissionCents(baseCents, rateBp);
  if (amountCents <= 0) return false;
  const [row] = await rows<{ id: string }>(
    ctx.tx,
    sql`insert into app.partner_commissions
          (workspace_id, partner_id, referral_id, payment_id, kind, base_cents, rate_bp, amount_cents,
           earned_at, payable_at, test)
        values (${ws}, ${referral.partner_id}, ${referral.id}, ${paymentId}, 'earned', ${baseCents},
          ${rateBp}, ${amountCents}, ${receivedAt.toISOString()}::timestamptz,
          ${payableAt(receivedAt).toISOString()}::timestamptz, ${payment.test})
        on conflict (payment_id) where kind = 'earned' do nothing
        returning id`,
  );
  if (!row) return false;
  await ctx.emit({
    type: 'partner.commission_earned',
    entityType: 'partner',
    entityId: referral.partner_id,
    payload: {
      commissionId: row.id,
      partnerId: referral.partner_id,
      referralId: referral.id,
      paymentId,
      amountCents,
      rateBp,
      test: payment.test,
    },
  });
  const refunded = await rows<{ id: string }>(
    ctx.tx,
    sql`select r.id from app.refunds r
        where r.workspace_id = ${ws} and r.payment_id = ${paymentId} and r.status = 'succeeded'
        order by r.refunded_at, r.id`,
  );
  for (const r of refunded) await takeBackOn(ctx, r.id);
  return true;
}

/** A refund takes back the partner's share of what went back, never more than they earned on that payment. */
async function takeBackOn(ctx: CommandContext, refundId: string): Promise<boolean> {
  const ws = ctx.scope.workspaceId!;
  const [refund] = await rows<{
    payment_id: string;
    amount_cents: string | number;
    status: string;
    refunded_at: Date | string | null;
  }>(
    ctx.tx,
    sql`select r.payment_id, r.amount_cents, r.status::text as status, r.refunded_at from app.refunds r
        where r.workspace_id = ${ws} and r.id = ${refundId}`,
  );
  if (!refund || refund.status !== 'succeeded') return false;
  const [earned] = await rows<{
    id: string;
    partner_id: string;
    referral_id: string;
    amount_cents: string | number;
    rate_bp: number;
    payable_at: Date | string;
    test: boolean;
  }>(
    ctx.tx,
    sql`select c.id, c.partner_id, c.referral_id, c.amount_cents, c.rate_bp, c.payable_at, c.test
        from app.partner_commissions c
        where c.workspace_id = ${ws} and c.payment_id = ${refund.payment_id} and c.kind = 'earned'
        for update`,
  );
  if (!earned) return false;
  const [taken] = await rows<{ cents: string | number | null }>(
    ctx.tx,
    sql`select coalesce(sum(amount_cents), 0) as cents from app.partner_commissions
        where payment_id = ${refund.payment_id} and kind = 'taken_back'`,
  );
  const left = Number(earned.amount_cents) + Number(taken?.cents ?? 0);
  const baseCents = Number(refund.amount_cents);
  const back = Math.min(commissionCents(baseCents, earned.rate_bp), left);
  if (back <= 0) return false;
  const at = refund.refunded_at ? new Date(refund.refunded_at) : changeMoment(ctx.meta);
  // It comes off what it takes back from: while that still waits its 30 days, so does this.
  const payable = new Date(Math.max(at.getTime(), new Date(earned.payable_at).getTime()));
  const [row] = await rows<{ id: string }>(
    ctx.tx,
    sql`insert into app.partner_commissions
          (workspace_id, partner_id, referral_id, payment_id, refund_id, kind, base_cents, rate_bp,
           amount_cents, earned_at, payable_at, test)
        values (${ws}, ${earned.partner_id}, ${earned.referral_id}, ${refund.payment_id}, ${refundId},
          'taken_back', ${baseCents}, ${earned.rate_bp}, ${-back}, ${at.toISOString()}::timestamptz,
          ${payable.toISOString()}::timestamptz, ${earned.test})
        on conflict (refund_id) where refund_id is not null do nothing
        returning id`,
  );
  if (!row) return false;
  await ctx.emit({
    type: 'partner.commission_taken_back',
    entityType: 'partner',
    entityId: earned.partner_id,
    payload: {
      commissionId: row.id,
      partnerId: earned.partner_id,
      referralId: earned.referral_id,
      paymentId: refund.payment_id,
      refundId,
      amountCents: -back,
    },
  });
  return true;
}

export const partnerCommissionNote = defineCommand({
  name: 'partner.commission_note',
  description:
    'Worker: a payment succeeded. A client’s first payment after they were referred starts their 12 months; each payment in them earns an active partner their share of what the client paid, free to pay out 30 days later.',
  risk: 0,
  input: PartnerCommissionNoteInput,
  output: PartnerCommissionNoteOutput,
  permission: null,
  actors: ['system'],
  scope: inWorkspace,
  emits: ['partner.commission_earned', 'partner.commission_taken_back'],
  async handler(ctx, input) {
    return { earned: await earnOn(ctx, input.paymentId) };
  },
});

export const partnerCommissionTakeBack = defineCommand({
  name: 'partner.commission_take_back',
  description:
    'Worker: a refund went back. The partner’s share of what was refunded is taken back from what they earned on that payment, never more than they earned.',
  risk: 0,
  input: PartnerCommissionTakeBackInput,
  output: PartnerCommissionTakeBackOutput,
  permission: null,
  actors: ['system'],
  scope: inWorkspace,
  emits: ['partner.commission_taken_back'],
  async handler(ctx, input) {
    return { takenBack: await takeBackOn(ctx, input.refundId) };
  },
});
