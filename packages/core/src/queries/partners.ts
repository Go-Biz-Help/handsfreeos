/**
 * Partners in core (HANDSFREEOS_PARTNERS_IMPLEMENTATION_PLAN.md, stage 2), for whoever holds `partners.manage`: the
 * partner settings, the partners with their clients and what they earned, one partner's clients and commissions, and
 * a customer's partner side (whether they're a partner, and who sent them). What's earned leaves out payments taken
 * in a provider's test mode, which are shown on their own lines but never paid out.
 */
import { rows, sql } from '@hfos/db/client';
import { defineQuery } from '../kernel/define';
import type { QueryContext } from '../kernel/types';
import { loadPartnerSettings, partnersInUse, PERSON_NAME } from '../commands/partners';
import { monthsEndAt, partnerLinkPath } from '../partners/rules';
import type { PartnerSettings } from '../partners/settings';
import {
  PartnerGetInput,
  PartnerGetOutput,
  PartnerListInput,
  PartnerListOutput,
  PartnerOfPersonInput,
  PartnerOfPersonOutput,
  PartnersSettingsInput,
  PartnersSettingsOutput,
  type PartnerEarnings,
  type PartnerOut,
} from '../schemas/partners';
import { HfosError } from '../errors';

const inWorkspace = (i: { workspaceId: string }) => ({
  kind: 'workspace' as const,
  workspaceId: i.workspaceId,
});

const iso = (v: Date | string) => new Date(v).toISOString();
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
          coalesce(e.earned, 0) as earned, coalesce(e.waiting, 0) as waiting, coalesce(e.payable, 0) as payable
        from app.partners pa
        join app.people pp on pp.id = pa.person_id
        left join lateral (
          select sum(c.amount_cents) as earned,
            sum(c.amount_cents) filter (where c.payable_at > now()) as waiting,
            sum(c.amount_cents) filter (where c.payable_at <= now()) as payable
          from app.partner_commissions c where c.partner_id = pa.id and not c.test
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
      client: string | null;
      number: string | null;
    }>(
      ctx.tx,
      sql`select c.id, c.kind, c.amount_cents, c.base_cents, c.rate_bp, c.earned_at, c.payable_at, c.test,
            case when pp.id is null then null else ${PERSON_NAME} end as client, i.number
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
        clientName: c.client ?? deleted,
        invoiceNumber: c.number,
      })),
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
