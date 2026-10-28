/**
 * Reading the affiliate program (20261027014000, HANDSFREEOS_AFFILIATES_IMPLEMENTATION_PLAN.md).
 *
 * Two readers, owed different amounts:
 *
 * - `affiliate.mine` is the signed-in person's own standing, for their page: what they applied with, their link
 *   code, their share, their link's clicks, how many signed up, the businesses that paid by name, and what they've
 *   earned (20261027014200), their codes (20261027014300), their bank at Stripe and payouts (20261027014400), and
 *   whether they agreed to the terms (20261027014500). Read through their own rows' policies and two functions that answer only for them, so it can only ever be theirs.
 * - `platform.affiliates`, `platform.affiliate` and `platform.affiliate_of_business` are staff's, for Admin →
 *   Affiliates and a business's page under Admin → Businesses (`platform.affiliates.manage`).
 */
import { rows, sql, type Tx } from '@hfos/db/client';
import { affiliateBankState, type AffiliatePayoutStatus } from '../affiliates/payouts';
import { affiliateTermsCurrent } from '../affiliates/terms';
import { HfosError } from '../errors';
import { requireHuman } from '../kernel/actor';
import { defineQuery } from '../kernel/define';
import {
  AffiliateMineInput,
  AffiliateMineOutput,
  PlatformAffiliateInput,
  PlatformAffiliateOfBusinessInput,
  PlatformAffiliateOfBusinessOutput,
  PlatformAffiliateOutput,
  PlatformAffiliatesInput,
  PlatformAffiliatesOutput,
  type AffiliateCodeRow,
  type AffiliateCommissionKind,
  type AffiliateReferralHow,
  type AffiliateStatus,
} from '../schemas/affiliates';

const onPlatform = () => ({ kind: 'platform' as const });
const iso = (d: Date | string): string => (d instanceof Date ? d : new Date(d)).toISOString();
const isoOrNull = (d: Date | string | null): string | null => (d === null ? null : iso(d));

/** A turned-down person may apply again this long after (private.affiliate_apply). */
const APPLY_AGAIN_DAYS = 30;

type Row = {
  id: string;
  user_id: string;
  name: string;
  email: string | null;
  code: string;
  status: AffiliateStatus;
  pitch: string;
  links: string;
  own_rate_bp: number | null;
  rate_bp: number;
  own_max_discount_bp: number | null;
  max_discount_bp: number;
  applied_at: Date | string;
  decided_at: Date | string | null;
  decided_by_name: string | null;
  clicks30: number | string;
  clicks_all: number | string;
  businesses: number | string;
  earned: number | string;
  terms_version: string | null;
  terms_accepted_at: Date | string | null;
};

/** Each affiliate with their share, clicks and how many businesses they sent. `where` narrows it. */
const rowsWhere = (tx: Tx, where: ReturnType<typeof sql>, limit = 500) =>
  rows<Row>(
    tx,
    sql`select a.id, a.user_id, a.name, u.email::text as email, a.code, a.status, a.pitch, a.links,
          a.rate_bp as own_rate_bp, coalesce(a.rate_bp, s.rate_bp) as rate_bp,
          a.max_discount_bp as own_max_discount_bp, coalesce(a.max_discount_bp, s.max_discount_bp) as max_discount_bp,
          a.applied_at, a.decided_at, a.terms_version, a.terms_accepted_at,
          coalesce(nullif(btrim(st.display_name), ''), nullif(btrim(du.full_name), ''), du.email::text)
            as decided_by_name,
          coalesce((select sum(c.clicks) from platform.affiliate_clicks c
                    where c.affiliate_id = a.id and c.day > (now() at time zone 'UTC')::date - 30), 0) as clicks30,
          coalesce((select sum(c.clicks) from platform.affiliate_clicks c where c.affiliate_id = a.id), 0)
            as clicks_all,
          (select count(*) from platform.affiliate_referrals r where r.affiliate_id = a.id) as businesses,
          coalesce((select sum(c.amount_cents) from platform.affiliate_commissions c where c.affiliate_id = a.id), 0)
            as earned
        from platform.affiliates a
        cross join platform.affiliate_settings s
        left join app.users u on u.id = a.user_id
        left join app.users du on du.id = a.decided_by
        left join platform.staff st on st.user_id = a.decided_by
        where ${where}
        order by a.applied_at desc
        limit ${limit}`,
  );

const rowOut = (r: Row) => ({
  affiliateId: r.id,
  userId: r.user_id,
  name: r.name,
  email: r.email ?? '',
  code: r.code,
  status: r.status,
  pitch: r.pitch,
  links: r.links,
  ownRateBp: r.own_rate_bp,
  rateBp: r.rate_bp,
  appliedAt: iso(r.applied_at),
  decidedAt: isoOrNull(r.decided_at),
  decidedByName: r.decided_by_name,
  clicks30: Number(r.clicks30),
  clicksAll: Number(r.clicks_all),
  businesses: Number(r.businesses),
  earnedCents: Number(r.earned),
  ownMaxDiscountBp: r.own_max_discount_bp,
  maxDiscountBp: r.max_discount_bp,
  termsVersion: r.terms_version,
  termsAcceptedAt: isoOrNull(r.terms_accepted_at),
});

type CodeRow = {
  id: string;
  affiliate_id: string | null;
  code: string;
  offer_id: string | null;
  percent_off_bp: number | null;
  amount_off_cents: number | null;
  discount_months: number | null;
  trial_days: number | null;
  status: 'on' | 'off';
  off_by_staff: boolean;
  paid_uses: number;
  created_at: Date | string;
};

/** Codes (20261027014300), newest first, read through whatever the reader may see of them. `where` narrows it. */
const codesWhere = async (tx: Tx, where: ReturnType<typeof sql>): Promise<AffiliateCodeRow[]> =>
  (
    await rows<CodeRow>(
      tx,
      sql`select c.id, c.affiliate_id, c.code, c.offer_id, c.percent_off_bp, c.amount_off_cents, c.discount_months,
            c.trial_days, c.status, c.off_by_staff, c.paid_uses, c.created_at
          from platform.affiliate_codes c
          where ${where}
          order by c.created_at desc
          limit 200`,
    )
  ).map((c) => ({
    codeId: c.id,
    affiliateId: c.affiliate_id,
    code: c.code,
    offerId: c.offer_id,
    percentOffBp: c.percent_off_bp,
    amountOffCents: c.amount_off_cents,
    discountMonths: c.discount_months,
    trialDays: c.trial_days,
    status: c.status,
    offByStaff: c.off_by_staff,
    paidUses: Number(c.paid_uses),
    createdAt: iso(c.created_at),
  }));

/** One code, as whoever reads it may see it, or null. */
export async function affiliateCodeRow(tx: Tx, codeId: string) {
  const [found] = await codesWhere(tx, sql`c.id = ${codeId}`);
  return found ?? null;
}

/** The plans a code can be for: those that can be bought, in the order staff set. */
const codePlans = async (tx: Tx) =>
  (
    await rows<{
      id: string;
      name: string;
      price_cents: number;
      billing: 'once' | 'yearly' | 'monthly';
    }>(
      tx,
      sql`select o.id, o.name, o.price_cents,
            case when o.paid_yearly then 'yearly' else o.billing end as billing
          from platform.founding_offers o
          where o.status <> 'draft' and o.price_cents > 0
          order by o.sort, o.id`,
    )
  ).map((o) => ({
    offerId: o.id,
    name: o.name,
    priceCents: Number(o.price_cents),
    billing: o.billing,
  }));

/**
 * What an affiliate has earned, waiting, ready, on its way and paid (20261027014200, 20261027014400), read through
 * whatever the reader may see of their commissions and payouts.
 */
async function earningsOf(tx: Tx, affiliateId: string) {
  const [e] = await rows<{
    earned: string | number;
    waiting: string | number;
    ready: string | number;
    on_its_way: string | number;
    paid: string | number;
  }>(
    tx,
    sql`select coalesce(sum(c.amount_cents), 0) as earned,
          coalesce(sum(c.amount_cents) filter (where c.payout_id is null and c.payable_at > now()), 0) as waiting,
          coalesce(sum(c.amount_cents) filter (where c.payout_id is null and c.payable_at <= now()), 0) as ready,
          coalesce(sum(c.amount_cents) filter (where p.status in ('sending', 'held')), 0) as on_its_way,
          coalesce(sum(c.amount_cents) filter (where p.status = 'paid'), 0) as paid
        from platform.affiliate_commissions c
        left join platform.affiliate_payouts p on p.id = c.payout_id
        where c.affiliate_id = ${affiliateId}`,
  );
  return {
    earnedCents: Number(e?.earned ?? 0),
    waitingCents: Number(e?.waiting ?? 0),
    readyCents: Number(e?.ready ?? 0),
    onItsWayCents: Number(e?.on_its_way ?? 0),
    paidCents: Number(e?.paid ?? 0),
  };
}

/** Their bank at Stripe (20261027014400), as the page says it. */
async function bankOf(tx: Tx, affiliateId: string) {
  const [a] = await rows<{
    details_submitted: boolean;
    payouts_enabled: boolean;
    transfers_active: boolean;
    due: string[] | null;
    livemode: boolean;
  }>(
    tx,
    sql`select details_submitted, payouts_enabled, transfers_active, due, livemode
        from platform.affiliate_payout_accounts where affiliate_id = ${affiliateId}`,
  );
  const state = affiliateBankState(
    a
      ? {
          detailsSubmitted: a.details_submitted,
          payoutsEnabled: a.payouts_enabled,
          transfersActive: a.transfers_active,
        }
      : null,
  );
  return { state, due: state === 'ready' ? [] : (a?.due ?? []), test: a ? !a.livemode : false };
}

/** Their payouts, newest first: the last two years'. */
async function payoutsOf(tx: Tx, affiliateId: string) {
  return (
    await rows<{
      id: string;
      month: string;
      amount_cents: number;
      status: AffiliatePayoutStatus;
      paid_at: Date | string | null;
      livemode: boolean;
    }>(
      tx,
      sql`select id, month::text as month, amount_cents, status, paid_at, livemode
          from platform.affiliate_payouts where affiliate_id = ${affiliateId}
          order by month desc limit 24`,
    )
  ).map((p) => ({
    payoutId: p.id,
    month: p.month,
    amountCents: Number(p.amount_cents),
    status: p.status,
    paidAt: isoOrNull(p.paid_at),
    test: !p.livemode,
  }));
}

/** One affiliate as staff see them, or null. */
export async function affiliateRow(tx: Tx, affiliateId: string) {
  const [found] = await rowsWhere(tx, sql`a.id = ${affiliateId}`, 1);
  return found ? rowOut(found) : null;
}

type OfBusinessRow = {
  affiliate_id: string;
  name: string;
  code: string;
  status: AffiliateStatus;
  how: AffiliateReferralHow;
  clicked_at: Date | string | null;
  referred_at: Date | string;
};

/** Who a business is credited to, as staff see it, or null. */
export async function affiliateOfBusiness(tx: Tx, organizationId: string) {
  const [found] = await rows<OfBusinessRow>(
    tx,
    sql`select a.id as affiliate_id, a.name, a.code, a.status, r.how, r.clicked_at, r.referred_at
        from platform.affiliate_referrals r join platform.affiliates a on a.id = r.affiliate_id
        where r.organization_id = ${organizationId}`,
  );
  return found
    ? {
        affiliateId: found.affiliate_id,
        name: found.name,
        code: found.code,
        status: found.status,
        how: found.how,
        clickedAt: isoOrNull(found.clicked_at),
        referredAt: iso(found.referred_at),
      }
    : null;
}

async function settingsOf(
  tx: Tx,
): Promise<{ rateBp: number; maxDiscountBp: number; payoutsOn: boolean }> {
  const [s] = await rows<{ rate_bp: number; max_discount_bp: number; payouts_on: boolean }>(
    tx,
    sql`select rate_bp, max_discount_bp, payouts_on from platform.affiliate_settings where id`,
  );
  return {
    rateBp: s?.rate_bp ?? 4000,
    maxDiscountBp: s?.max_discount_bp ?? 5000,
    payoutsOn: s?.payouts_on ?? false,
  };
}

export const affiliateMine = defineQuery({
  name: 'affiliate.mine',
  description:
    'Your own place in the HandsFreeOS affiliate program: whether you’ve applied and where it stands, your link code, your share, your link’s clicks, how many signed up, the businesses that pay, what you’ve earned, waiting, ready, on its way and paid, your discount and trial codes with the most they may take off, whether your bank is set up with Stripe for payouts, your monthly payouts, and whether you’ve agreed to the affiliate terms that count now.',
  input: AffiliateMineInput,
  output: AffiliateMineOutput,
  permission: null,
  scope: () => ({ kind: 'account' as const }),
  async handler(ctx) {
    const me = requireHuman(ctx).userId;
    const [mine] = await rows<
      Omit<
        Row,
        'email' | 'decided_by_name' | 'businesses' | 'earned' | 'user_id' | 'own_max_discount_bp'
      > & {
        user_id: string;
      }
    >(
      ctx.tx,
      sql`select a.id, a.user_id, a.name, a.code, a.status, a.pitch, a.links,
            a.rate_bp as own_rate_bp, coalesce(a.rate_bp, s.rate_bp) as rate_bp,
            coalesce(a.max_discount_bp, s.max_discount_bp) as max_discount_bp, a.applied_at, a.decided_at,
            a.terms_version, a.terms_accepted_at,
            coalesce((select sum(c.clicks) from platform.affiliate_clicks c
                      where c.affiliate_id = a.id and c.day > (now() at time zone 'UTC')::date - 30), 0)
              as clicks30,
            coalesce((select sum(c.clicks) from platform.affiliate_clicks c where c.affiliate_id = a.id), 0)
              as clicks_all
          from platform.affiliates a cross join platform.affiliate_settings s
          where a.user_id = ${me}`,
    );
    const { rateBp: defaultRateBp, payoutsOn } = await settingsOf(ctx.tx);
    const plans = await codePlans(ctx.tx);
    if (!mine) return { affiliate: null, defaultRateBp, payoutsOn, plans };
    const decidedAt = isoOrNull(mine.decided_at);
    const [signUps] = await rows<{ n: number }>(
      ctx.tx,
      sql`select private.affiliate_my_signups() as n`,
    );
    const paying = await rows<{
      name: string | null;
      first_paid_at: Date | string | null;
      earned_cents: string | number;
    }>(
      ctx.tx,
      sql`select name, first_paid_at, earned_cents from private.affiliate_my_businesses()`,
    );
    return {
      affiliate: {
        affiliateId: mine.id,
        status: mine.status,
        name: mine.name,
        code: mine.code,
        pitch: mine.pitch,
        links: mine.links,
        rateBp: mine.rate_bp,
        appliedAt: iso(mine.applied_at),
        decidedAt,
        applyAgainFrom:
          mine.status === 'turned_down' && decidedAt
            ? new Date(Date.parse(decidedAt) + APPLY_AGAIN_DAYS * 86_400_000).toISOString()
            : null,
        clicks30: Number(mine.clicks30),
        clicksAll: Number(mine.clicks_all),
        codes: await codesWhere(ctx.tx, sql`c.affiliate_id = ${mine.id}`),
        maxDiscountBp: mine.max_discount_bp,
        signUps: Number(signUps?.n ?? 0),
        payingBusinesses: paying.map((b) => ({
          name: b.name,
          firstPaidAt: isoOrNull(b.first_paid_at),
          earnedCents: Number(b.earned_cents),
        })),
        earnings: await earningsOf(ctx.tx, mine.id),
        bank: await bankOf(ctx.tx, mine.id),
        payouts: await payoutsOf(ctx.tx, mine.id),
        termsAccepted: affiliateTermsCurrent(mine.terms_version),
        termsAcceptedAt: isoOrNull(mine.terms_accepted_at),
      },
      defaultRateBp,
      payoutsOn,
      plans,
    };
  },
});

export const platformAffiliates = defineQuery({
  name: 'platform.affiliates',
  description:
    'The affiliate program for Admin → Affiliates: the share everyone earns and the most a code takes off, the house codes, the applications waiting, and every affiliate with their clicks, the businesses they sent and what they’ve earned.',
  input: PlatformAffiliatesInput,
  output: PlatformAffiliatesOutput,
  permission: 'platform.affiliates.manage',
  scope: onPlatform,
  async handler(ctx, input) {
    const all = (await rowsWhere(ctx.tx, sql`true`, input.limit)).map(rowOut);
    return {
      settings: await settingsOf(ctx.tx),
      houseCodes: await codesWhere(ctx.tx, sql`c.affiliate_id is null`),
      plans: await codePlans(ctx.tx),
      applications: all.filter((a) => a.status === 'applied').reverse(),
      affiliates: all.filter((a) => a.status !== 'applied'),
    };
  },
});

type BusinessRow = {
  organization_id: string;
  workspace_id: string | null;
  name: string;
  how: AffiliateReferralHow;
  clicked_at: Date | string | null;
  referred_at: Date | string;
  marked_by_name: string | null;
  earned: string | number;
};

type CommissionRow = {
  id: string;
  kind: AffiliateCommissionKind;
  business_name: string | null;
  base_cents: string | number;
  rate_bp: number;
  amount_cents: string | number;
  earned_at: Date | string;
  payable_at: Date | string;
};

export const platformAffiliate = defineQuery({
  name: 'platform.affiliate',
  description:
    'One affiliate for Admin → Affiliates: what they applied with, their share, their codes and the most those take off, the businesses they sent and what each earned them, what they’ve earned, waiting, ready, on its way and paid, each share earned or taken back, their bank at Stripe and their payouts, and their link’s clicks a day.',
  input: PlatformAffiliateInput,
  output: PlatformAffiliateOutput,
  permission: 'platform.affiliates.manage',
  scope: onPlatform,
  async handler(ctx, input) {
    const affiliate = await affiliateRow(ctx.tx, input.affiliateId);
    if (!affiliate)
      throw HfosError.notFound(
        'That affiliate isn’t there anymore. Refresh Admin → Affiliates and try again.',
      );
    const businesses = await rows<BusinessRow>(
      ctx.tx,
      sql`select r.organization_id,
            (select w.id from app.workspaces w where w.organization_id = r.organization_id
             order by w.created_at limit 1) as workspace_id,
            o.name, r.how, r.clicked_at, r.referred_at,
            coalesce(nullif(btrim(st.display_name), ''), nullif(btrim(mu.full_name), ''), mu.email::text)
              as marked_by_name,
            coalesce((select sum(c.amount_cents) from platform.affiliate_commissions c
                      where c.affiliate_id = r.affiliate_id and c.organization_id = r.organization_id), 0)
              as earned
          from platform.affiliate_referrals r
          join app.organizations o on o.id = r.organization_id
          left join app.users mu on mu.id = r.marked_by
          left join platform.staff st on st.user_id = r.marked_by
          where r.affiliate_id = ${input.affiliateId}
          order by r.referred_at desc`,
    );
    const commissions = await rows<CommissionRow>(
      ctx.tx,
      sql`select c.id, c.kind, o.name as business_name, c.base_cents, c.rate_bp, c.amount_cents, c.earned_at,
            c.payable_at
          from platform.affiliate_commissions c
          left join app.organizations o on o.id = c.organization_id
          where c.affiliate_id = ${input.affiliateId}
          order by c.created_at desc
          limit 100`,
    );
    const clicks = await rows<{ day: string; clicks: number }>(
      ctx.tx,
      sql`select to_char(day, 'YYYY-MM-DD') as day, clicks from platform.affiliate_clicks
          where affiliate_id = ${input.affiliateId} order by day desc limit 30`,
    );
    return {
      affiliate,
      businesses: businesses.map((b) => ({
        organizationId: b.organization_id,
        workspaceId: b.workspace_id,
        name: b.name,
        how: b.how,
        clickedAt: isoOrNull(b.clicked_at),
        referredAt: iso(b.referred_at),
        markedByName: b.marked_by_name,
        earnedCents: Number(b.earned),
      })),
      earnings: await earningsOf(ctx.tx, input.affiliateId),
      commissions: commissions.map((c) => ({
        commissionId: c.id,
        kind: c.kind,
        businessName: c.business_name,
        baseCents: Number(c.base_cents),
        rateBp: c.rate_bp,
        amountCents: Number(c.amount_cents),
        earnedAt: iso(c.earned_at),
        payableAt: iso(c.payable_at),
      })),
      codes: await codesWhere(ctx.tx, sql`c.affiliate_id = ${input.affiliateId}`),
      plans: await codePlans(ctx.tx),
      bank: await bankOf(ctx.tx, input.affiliateId),
      payouts: await payoutsOf(ctx.tx, input.affiliateId),
      clicks: clicks.map((c) => ({ day: c.day, clicks: Number(c.clicks) })),
    };
  },
});

export const platformAffiliateOfBusiness = defineQuery({
  name: 'platform.affiliate_of_business',
  description:
    'Which affiliate a business is credited to, for its page under Admin → Businesses, with the approved affiliates it could be credited to instead.',
  input: PlatformAffiliateOfBusinessInput,
  output: PlatformAffiliateOfBusinessOutput,
  permission: 'platform.affiliates.manage',
  scope: onPlatform,
  async handler(ctx, input) {
    const [ws] = await rows<{ organization_id: string }>(
      ctx.tx,
      sql`select organization_id from app.workspaces where id = ${input.workspaceId}`,
    );
    if (!ws)
      throw HfosError.notFound(
        'That business isn’t there anymore. Refresh Admin → Businesses and try again.',
      );
    const choices = await rows<{ id: string; name: string; code: string }>(
      ctx.tx,
      sql`select id, name, code from platform.affiliates where status = 'approved' order by lower(name), code`,
    );
    return {
      organizationId: ws.organization_id,
      affiliate: await affiliateOfBusiness(ctx.tx, ws.organization_id),
      choices: choices.map((c) => ({ affiliateId: c.id, name: c.name, code: c.code })),
    };
  },
});

export const affiliateQueries = [
  affiliateMine,
  platformAffiliates,
  platformAffiliate,
  platformAffiliateOfBusiness,
];
