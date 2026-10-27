/**
 * Reading the affiliate program (20261027014000, HANDSFREEOS_AFFILIATES_IMPLEMENTATION_PLAN.md).
 *
 * Two readers, owed different amounts:
 *
 * - `affiliate.mine` is the signed-in person's own standing, for their page: what they applied with, their link
 *   code, their share and their link's clicks. Read through their own row's policy, so it can only ever be theirs.
 * - `platform.affiliates`, `platform.affiliate` and `platform.affiliate_of_business` are staff's, for Admin →
 *   Affiliates and a business's page under Admin → Businesses (`platform.affiliates.manage`).
 */
import { rows, sql, type Tx } from '@hfos/db/client';
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
  applied_at: Date | string;
  decided_at: Date | string | null;
  decided_by_name: string | null;
  clicks30: number | string;
  clicks_all: number | string;
  businesses: number | string;
};

/** Each affiliate with their share, clicks and how many businesses they sent. `where` narrows it. */
const rowsWhere = (tx: Tx, where: ReturnType<typeof sql>, limit = 500) =>
  rows<Row>(
    tx,
    sql`select a.id, a.user_id, a.name, u.email::text as email, a.code, a.status, a.pitch, a.links,
          a.rate_bp as own_rate_bp, coalesce(a.rate_bp, s.rate_bp) as rate_bp,
          a.applied_at, a.decided_at,
          coalesce(nullif(btrim(st.display_name), ''), nullif(btrim(du.full_name), ''), du.email::text)
            as decided_by_name,
          coalesce((select sum(c.clicks) from platform.affiliate_clicks c
                    where c.affiliate_id = a.id and c.day > (now() at time zone 'UTC')::date - 30), 0) as clicks30,
          coalesce((select sum(c.clicks) from platform.affiliate_clicks c where c.affiliate_id = a.id), 0)
            as clicks_all,
          (select count(*) from platform.affiliate_referrals r where r.affiliate_id = a.id) as businesses
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
});

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

async function defaultRate(tx: Tx): Promise<number> {
  const [s] = await rows<{ rate_bp: number }>(
    tx,
    sql`select rate_bp from platform.affiliate_settings where id`,
  );
  return s?.rate_bp ?? 4000;
}

export const affiliateMine = defineQuery({
  name: 'affiliate.mine',
  description:
    'Your own place in the HandsFreeOS affiliate program: whether you’ve applied and where it stands, your link code, your share, and your link’s clicks.',
  input: AffiliateMineInput,
  output: AffiliateMineOutput,
  permission: null,
  scope: () => ({ kind: 'account' as const }),
  async handler(ctx) {
    const me = requireHuman(ctx).userId;
    const [mine] = await rows<
      Omit<Row, 'email' | 'decided_by_name' | 'businesses' | 'user_id'> & { user_id: string }
    >(
      ctx.tx,
      sql`select a.id, a.user_id, a.name, a.code, a.status, a.pitch, a.links,
            a.rate_bp as own_rate_bp, coalesce(a.rate_bp, s.rate_bp) as rate_bp, a.applied_at, a.decided_at,
            coalesce((select sum(c.clicks) from platform.affiliate_clicks c
                      where c.affiliate_id = a.id and c.day > (now() at time zone 'UTC')::date - 30), 0)
              as clicks30,
            coalesce((select sum(c.clicks) from platform.affiliate_clicks c where c.affiliate_id = a.id), 0)
              as clicks_all
          from platform.affiliates a cross join platform.affiliate_settings s
          where a.user_id = ${me}`,
    );
    const defaultRateBp = await defaultRate(ctx.tx);
    if (!mine) return { affiliate: null, defaultRateBp };
    const decidedAt = isoOrNull(mine.decided_at);
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
      },
      defaultRateBp,
    };
  },
});

export const platformAffiliates = defineQuery({
  name: 'platform.affiliates',
  description:
    'The affiliate program for Admin → Affiliates: the share everyone earns, the applications waiting, and every affiliate with their clicks and the businesses they sent.',
  input: PlatformAffiliatesInput,
  output: PlatformAffiliatesOutput,
  permission: 'platform.affiliates.manage',
  scope: onPlatform,
  async handler(ctx, input) {
    const all = (await rowsWhere(ctx.tx, sql`true`, input.limit)).map(rowOut);
    return {
      settings: { rateBp: await defaultRate(ctx.tx) },
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
};

export const platformAffiliate = defineQuery({
  name: 'platform.affiliate',
  description:
    'One affiliate for Admin → Affiliates: what they applied with, their share, the businesses they sent and their link’s clicks a day.',
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
              as marked_by_name
          from platform.affiliate_referrals r
          join app.organizations o on o.id = r.organization_id
          left join app.users mu on mu.id = r.marked_by
          left join platform.staff st on st.user_id = r.marked_by
          where r.affiliate_id = ${input.affiliateId}
          order by r.referred_at desc`,
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
      })),
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
