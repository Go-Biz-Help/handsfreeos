/**
 * Partners in core (HANDSFREEOS_PARTNERS_IMPLEMENTATION_PLAN.md, stage 2), for whoever holds `partners.manage`: the
 * partner settings, the partners with their clients and what they earned, one partner's clients and commissions, and
 * a customer's partner side (whether they're a partner, and who sent them). What's earned leaves out payments taken
 * in a provider's test mode, which are shown on their own lines but never paid out; what's on a payment with a dispute
 * open is held until it's settled.
 */
import { rows, sql } from '@hfos/db/client';
import { ADDON_CATALOG } from '../addons/catalog';
import { requireCustomer } from '../kernel/actor';
import { defineQuery } from '../kernel/define';
import type { QueryContext } from '../kernel/types';
import { loadPartnerSettings, partnersInUse, PERSON_NAME } from '../commands/partners';
import { monthsEndAt, partnerLinkPath } from '../partners/rules';
import { partnerSettingsOf, type PartnerSettings } from '../partners/settings';
import { clientShortName } from '../partners/words';
import { payoutAccountOut, payoutsOfPartner } from './partner-payouts';
import {
  PartnerGetInput,
  PartnerGetOutput,
  PartnerListInput,
  PartnerListOutput,
  PartnerOfPersonInput,
  PartnerOfPersonOutput,
  PartnersSettingsInput,
  PartnersSettingsOutput,
  PortalPartnerInput,
  PortalPartnerOutput,
  type PartnerEarnings,
  type PartnerOut,
} from '../schemas/partners';
import { HfosError } from '../errors';

const inWorkspace = (i: { workspaceId: string }) => ({
  kind: 'workspace' as const,
  workspaceId: i.workspaceId,
});

const iso = (v: Date | string) => new Date(v).toISOString();

/** A commission (`c`) whose payment has a dispute open: it waits until that's settled. */
const HELD = sql.raw(
  `exists (select 1 from app.payment_disputes d where d.payment_id = c.payment_id and d.status = 'open')`,
);
const isoOrNull = (v: Date | string | null) => (v ? iso(v) : null);

/** The calendar partners' links book: the one the settings name, else the first that takes bookings. */
async function linkCalendarOf(
  ctx: QueryContext,
  settings: PartnerSettings,
): Promise<{ id: string; name: string } | null> {
  const ws = ctx.scope.workspaceId!;
  const [calendar] = await rows<{ id: string; name: string }>(
    ctx.tx,
    sql`select c.id, c.name from app.calendars c
        where c.workspace_id = ${ws} and c.public and c.status = 'active'
        order by (c.id = ${settings.calendarId ?? '00000000-0000-0000-0000-000000000000'}) desc, c.created_at, c.id
        limit 1`,
  );
  return calendar ?? null;
}

interface PartnerRow extends Record<string, unknown> {
  id: string;
  person_id: string;
  name: string;
  email: string | null;
  status: PartnerOut['status'];
  rate_bp: number | null;
  code: string;
  terms_version: number | null;
  created_at: Date | string;
  clients: number;
  earned: string | number;
  waiting: string | number;
  payable: string | number;
  held: string | number;
  paying: string | number;
  paid: string | number;
}

/** The partners of the business, one or all, with how many clients they sent and what they earned. */
async function partnersOf(ctx: QueryContext, partnerId: string | null): Promise<PartnerRow[]> {
  const ws = ctx.scope.workspaceId!;
  const one = partnerId ? sql`and pa.id = ${partnerId}` : sql``;
  return rows<PartnerRow>(
    ctx.tx,
    sql`select pa.id, pa.person_id, ${PERSON_NAME} as name, pp.email::text as email, pa.status, pa.rate_bp,
          pa.code, pa.terms_version, pa.created_at,
          (select count(*)::int from app.partner_referrals r where r.partner_id = pa.id) as clients,
          coalesce(e.earned, 0) as earned, coalesce(e.waiting, 0) as waiting, coalesce(e.payable, 0) as payable,
          coalesce(e.held, 0) as held, coalesce(e.paying, 0) as paying, coalesce(e.paid, 0) as paid
        from app.partners pa
        join app.people pp on pp.id = pa.person_id
        left join lateral (
          select sum(c.amount_cents) as earned,
            sum(c.amount_cents) filter (where s.free and not s.held and c.payable_at > now()) as waiting,
            sum(c.amount_cents) filter (where s.free and not s.held and c.payable_at <= now()) as payable,
            sum(c.amount_cents) filter (where s.free and s.held) as held,
            sum(c.amount_cents) filter (where l.status in ('pending', 'held')) as paying,
            sum(c.amount_cents) filter (where l.status = 'paid') as paid
          from app.partner_commissions c
          left join app.partner_payout_lines l on l.id = c.payout_line_id
          cross join lateral (select l.id is null or l.status = 'cancelled' as free, ${HELD} as held) s
          where c.partner_id = pa.id and not c.test
        ) e on true
        where pa.workspace_id = ${ws} ${one}
        order by pa.status = 'ended', pa.status = 'paused', coalesce(e.earned, 0) desc, pa.created_at, pa.id`,
  );
}

function partnerOut(
  r: PartnerRow,
  settings: PartnerSettings,
  linkCalendarId: string | null,
): PartnerOut {
  const earnings: PartnerEarnings = {
    earnedCents: Number(r.earned),
    waitingCents: Number(r.waiting),
    payableCents: Number(r.payable),
    heldCents: Number(r.held),
    payingCents: Number(r.paying),
    paidCents: Number(r.paid),
  };
  return {
    partnerId: r.id,
    personId: r.person_id,
    name: r.name,
    email: r.email,
    status: r.status,
    rateBp: r.rate_bp ?? settings.rateBp,
    ownRate: r.rate_bp !== null,
    code: r.code,
    linkPath: linkCalendarId ? partnerLinkPath(linkCalendarId, r.code) : null,
    clients: r.clients,
    earnings,
    // Nothing to accept until the business writes its terms.
    termsAccepted: settings.termsVersion === 0 || (r.terms_version ?? 0) >= settings.termsVersion,
    addedAt: iso(r.created_at),
  };
}

export const partnersSettings = defineQuery({
  name: 'partners.settings',
  description:
    'The partner settings, every default filled in: the share partners earn unless they have their own, the terms they accept, the smallest payout and the calendar their links book; and whether partners are on here.',
  input: PartnersSettingsInput,
  output: PartnersSettingsOutput,
  permission: 'partners.manage',
  scope: inWorkspace,
  async handler(ctx) {
    const ws = ctx.scope.workspaceId!;
    const settings = await loadPartnerSettings(ctx, ws);
    return {
      settings,
      inUse: await partnersInUse(ctx, ws),
      linkCalendar: await linkCalendarOf(ctx, settings),
    };
  },
});

export const partnerList = defineQuery({
  name: 'partner.list',
  description:
    'The business’s partners: each one’s share, link, how many clients they sent, and what they earned, what’s waiting its 30 days and what’s free to pay out. Active partners first, the biggest earners first.',
  input: PartnerListInput,
  output: PartnerListOutput,
  permission: 'partners.manage',
  scope: inWorkspace,
  async handler(ctx) {
    const ws = ctx.scope.workspaceId!;
    const settings = await loadPartnerSettings(ctx, ws);
    const calendar = await linkCalendarOf(ctx, settings);
    return {
      partners: (await partnersOf(ctx, null)).map((r) =>
        partnerOut(r, settings, calendar?.id ?? null),
      ),
    };
  },
});

export const partnerGet = defineQuery({
  name: 'partner.get',
  description:
    'One partner: their share, link and what they earned; the clients they sent, how, when, and when each one’s 12 months end; and their latest commissions, with what each was worked out on.',
  input: PartnerGetInput,
  output: PartnerGetOutput,
  permission: 'partners.manage',
  scope: inWorkspace,
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const [row] = await partnersOf(ctx, input.partnerId);
    if (!row)
      throw HfosError.notFound('That partner isn’t there anymore. Refresh your Partners list.');
    const settings = await loadPartnerSettings(ctx, ws);
    const calendar = await linkCalendarOf(ctx, settings);
    const clients = await rows<{
      id: string;
      person_id: string | null;
      name: string | null;
      how: 'link' | 'by_hand';
      referred_at: Date | string;
      first_paid_at: Date | string | null;
      earned: string | number;
    }>(
      ctx.tx,
      sql`select r.id, r.person_id, case when pp.id is null then null else ${PERSON_NAME} end as name, r.how,
            r.referred_at, r.first_paid_at,
            coalesce((select sum(c.amount_cents) from app.partner_commissions c
              where c.referral_id = r.id and not c.test), 0) as earned
          from app.partner_referrals r left join app.people pp on pp.id = r.person_id
          where r.workspace_id = ${ws} and r.partner_id = ${row.id}
          order by r.referred_at desc, r.id`,
    );
    const commissions = await rows<{
      id: string;
      kind: 'earned' | 'taken_back';
      amount_cents: string | number;
      base_cents: string | number;
      rate_bp: number;
      earned_at: Date | string;
      payable_at: Date | string;
      test: boolean;
      held: boolean;
      client: string | null;
      number: string | null;
    }>(
      ctx.tx,
      sql`select c.id, c.kind, c.amount_cents, c.base_cents, c.rate_bp, c.earned_at, c.payable_at, c.test,
            ${HELD} as held, case when pp.id is null then null else ${PERSON_NAME} end as client, i.number
          from app.partner_commissions c
          join app.partner_referrals r on r.id = c.referral_id
          left join app.people pp on pp.id = r.person_id
          join app.payments p on p.id = c.payment_id
          join app.invoices i on i.id = p.invoice_id
          where c.workspace_id = ${ws} and c.partner_id = ${row.id}
          order by c.earned_at desc, c.created_at desc
          limit 200`,
    );
    const deleted = 'A deleted customer';
    return {
      partner: partnerOut(row, settings, calendar?.id ?? null),
      clients: clients.map((c) => ({
        referralId: c.id,
        personId: c.person_id,
        name: c.name ?? deleted,
        how: c.how,
        referredAt: iso(c.referred_at),
        firstPaidAt: isoOrNull(c.first_paid_at),
        monthsEndAt: c.first_paid_at ? monthsEndAt(new Date(c.first_paid_at)).toISOString() : null,
        earnedCents: Number(c.earned),
      })),
      commissions: commissions.map((c) => ({
        commissionId: c.id,
        kind: c.kind,
        amountCents: Number(c.amount_cents),
        baseCents: Number(c.base_cents),
        rateBp: c.rate_bp,
        earnedAt: iso(c.earned_at),
        payableAt: iso(c.payable_at),
        test: c.test,
        held: c.held,
        clientName: c.client ?? deleted,
        invoiceNumber: c.number,
      })),
      payouts: await payoutsOfPartner(ctx, row.id),
    };
  },
});

export const partnerOfPerson = defineQuery({
  name: 'partner.of_person',
  description:
    'A customer’s partner side: whether they’re a partner of the business, and which partner sent them, how and when, with what they earned that partner.',
  input: PartnerOfPersonInput,
  output: PartnerOfPersonOutput,
  permission: 'partners.manage',
  scope: inWorkspace,
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const [partner] = await rows<{ id: string; status: PartnerOut['status'] }>(
      ctx.tx,
      sql`select pa.id, pa.status from app.partners pa
          where pa.workspace_id = ${ws} and pa.person_id = ${input.personId}`,
    );
    const [referral] = await rows<{
      id: string;
      partner_id: string;
      name: string;
      how: 'link' | 'by_hand';
      referred_at: Date | string;
      earned: string | number;
    }>(
      ctx.tx,
      sql`select r.id, r.partner_id, ${PERSON_NAME} as name, r.how, r.referred_at,
            coalesce((select sum(c.amount_cents) from app.partner_commissions c
              where c.referral_id = r.id and not c.test), 0) as earned
          from app.partner_referrals r join app.partners pa on pa.id = r.partner_id
          join app.people pp on pp.id = pa.person_id
          where r.workspace_id = ${ws} and r.person_id = ${input.personId}`,
    );
    return {
      inUse: await partnersInUse(ctx, ws),
      partner: partner ? { partnerId: partner.id, status: partner.status } : null,
      referredBy: referral
        ? {
            referralId: referral.id,
            partnerId: referral.partner_id,
            name: referral.name,
            how: referral.how,
            referredAt: iso(referral.referred_at),
            earnedCents: Number(referral.earned),
          }
        : null,
    };
  },
});

// ---------- the partner's own page, in the business's portal (stage 2c) ----------

/**
 * Whether an add-on that uses partners runs in the business, as a customer's portal asks it (`portal_actor` never
 * reaches the add-on tables): `portal.addon_in_use` for each add-on that names partners.
 */
async function partnersInPortal(ctx: QueryContext): Promise<boolean> {
  for (const m of ADDON_CATALOG.filter((a) => a.uses?.includes('partners'))) {
    const [row] = await rows<{ on: boolean }>(
      ctx.tx,
      sql`select portal.addon_in_use(${m.id}) as on`,
    );
    if (row?.on) return true;
  }
  return false;
}

/** Whether the signed-in customer is a partner of the business, while partners are on in it. */
export async function isPortalPartner(ctx: QueryContext): Promise<boolean> {
  if (!(await partnersInPortal(ctx))) return false;
  const [row] = await rows<{ yes: boolean }>(
    ctx.tx,
    sql`select exists (select 1 from portal.partner()) as yes`,
  );
  return row?.yes ?? false;
}

export const portalPartner = defineQuery({
  name: 'portal.partner',
  description:
    'A partner’s own page in the business’s portal: their share, their link once they accept the terms, the terms, what they earned, and the clients they sent by first name and last initial.',
  input: PortalPartnerInput,
  output: PortalPartnerOutput,
  permission: null,
  actors: ['customer'],
  scope: inWorkspace,
  async handler(ctx) {
    requireCustomer(ctx);
    if (!(await partnersInPortal(ctx))) return { partner: null };
    const [me] = await rows<{
      code: string;
      rate_bp: number | null;
      status: PartnerOut['status'];
      terms_version: number | null;
      terms_accepted_at: Date | string | null;
      created_at: Date | string;
    }>(
      ctx.tx,
      sql`select code, rate_bp, status, terms_version, terms_accepted_at, created_at from portal.partner()`,
    );
    if (!me) return { partner: null };
    const [stored] = await rows<{ settings: Record<string, unknown> | null }>(
      ctx.tx,
      sql`select portal.partner_settings() as settings`,
    );
    const settings = partnerSettingsOf({ partners: stored?.settings ?? {} });
    const [calendar] = await rows<{ id: string | null }>(
      ctx.tx,
      sql`select portal.partner_link_calendar() as id`,
    );
    const [earned] = await rows<{
      earned_cents: string | number;
      waiting_cents: string | number;
      payable_cents: string | number;
      held_cents: string | number;
      paying_cents: string | number;
      paid_cents: string | number;
    }>(
      ctx.tx,
      sql`select * from portal.partner_earnings() cross join portal.partner_payout_totals()`,
    );
    const [open] = await rows<{ open: boolean }>(
      ctx.tx,
      sql`select portal.partner_payouts_open() as open`,
    );
    const [account] = await rows<{
      details_submitted: boolean;
      payouts_enabled: boolean;
      transfers_active: boolean;
      disabled_reason: string | null;
      due_count: number;
    }>(ctx.tx, sql`select * from portal.partner_payout_account()`);
    const paidLines = await rows<{
      line_id: string;
      month: string;
      amount_cents: string | number;
      status: 'pending' | 'paid' | 'held';
      paid_at: Date | string | null;
      livemode: boolean;
    }>(
      ctx.tx,
      sql`select line_id, month::text as month, amount_cents, status, paid_at, livemode
          from portal.partner_payouts()`,
    );
    const clients = await rows<{
      referral_id: string;
      first_name: string | null;
      last_initial: string | null;
      how: 'link' | 'by_hand';
      referred_at: Date | string;
      first_paid_at: Date | string | null;
      earned_cents: string | number;
    }>(ctx.tx, sql`select * from portal.partner_clients()`);
    // Nothing to accept until the business writes its terms; their link waits on the terms they're shown.
    const accepted =
      settings.termsVersion === 0 || (me.terms_version ?? 0) >= settings.termsVersion;
    return {
      partner: {
        status: me.status,
        rateBp: me.rate_bp ?? settings.rateBp,
        since: iso(me.created_at),
        linkPath:
          accepted && me.status !== 'ended' && calendar?.id
            ? partnerLinkPath(calendar.id, me.code)
            : null,
        terms: {
          text: settings.terms,
          version: settings.termsVersion,
          accepted,
          acceptedAt: isoOrNull(me.terms_accepted_at),
        },
        earnings: {
          earnedCents: Number(earned?.earned_cents ?? 0),
          waitingCents: Number(earned?.waiting_cents ?? 0),
          payableCents: Number(earned?.payable_cents ?? 0),
          heldCents: Number(earned?.held_cents ?? 0),
          payingCents: Number(earned?.paying_cents ?? 0),
          paidCents: Number(earned?.paid_cents ?? 0),
        },
        clients: clients.map((c) => ({
          referralId: c.referral_id,
          name: clientShortName(c.first_name, c.last_initial),
          how: c.how,
          referredAt: iso(c.referred_at),
          firstPaidAt: isoOrNull(c.first_paid_at),
          monthsEndAt: c.first_paid_at
            ? monthsEndAt(new Date(c.first_paid_at)).toISOString()
            : null,
          earnedCents: Number(c.earned_cents),
        })),
        payouts: {
          open: open?.open ?? false,
          smallestPayoutCents: settings.smallestPayoutCents,
          account: account ? payoutAccountOut(account) : null,
          lines: paidLines.map((l) => ({
            lineId: l.line_id,
            month: l.month,
            amountCents: Number(l.amount_cents),
            status: l.status,
            paidAt: isoOrNull(l.paid_at),
            livemode: l.livemode,
          })),
        },
      },
    };
  },
});
