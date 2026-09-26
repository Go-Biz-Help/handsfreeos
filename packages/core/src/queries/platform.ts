/**
 * The admin side (M13): the businesses on HandsFreeOS, what has gone wrong lately, and whether this person
 * is currently looking at a business.
 *
 * A support person sees the directory — names, dates, who works where — and counts of everything else. The
 * data itself is reached only by looking at a business, which says so in that business's own audit log.
 */
import { and, asc, desc, eq, ilike, isNull, lt, or, sql as dsql } from 'drizzle-orm';
import { rows, sql } from '@hfos/db/client';
import {
  organizations,
  tickets,
  users,
  viewAsSessions,
  workspaceMemberships,
  workspaces,
} from '@hfos/db/schema';
import { PHONE_MODELS } from '../ai-team/config';
import { HfosError } from '../errors';
import {
  isUsageKey,
  SEED_CARD,
  unitPriceCents,
  type RateCard,
  type UsageKey,
  type UsageRate,
} from '../money/index';
import { requireHuman } from '../kernel/actor';
import { defineQuery } from '../kernel/define';
import {
  AdminWalletGetInput,
  AdminWalletGetOutput,
  BusinessGetInput,
  BusinessGetOutput,
  BusinessListInput,
  BusinessListOutput,
  RateCardGetInput,
  RateCardGetOutput,
  HealthSummaryInput,
  HealthSummaryOutput,
  ViewAsCurrentInput,
  ViewAsCurrentOutput,
  WalletStageValue,
} from '../schemas/support';
const onPlatform = () => ({ kind: 'platform' as const });

const lastActive = dsql<string | null>`private.admin_last_active(${workspaces.id})`;
const openTickets = dsql<number>`(
  select count(*)::int from platform.tickets t
  where t.workspace_id = ${workspaces.id} and t.status in ('new', 'open', 'waiting_on_customer')
)`;
const memberCount = dsql<number>`(
  select count(*)::int from app.workspace_memberships m where m.workspace_id = ${workspaces.id}
)`;

export const platformBusinessList = defineQuery({
  name: 'platform.business.list',
  description:
    'Every business on HandsFreeOS: when they signed up, who is in them, how busy they are.',
  input: BusinessListInput,
  output: BusinessListOutput,
  permission: 'platform.businesses.read',
  scope: onPlatform,
  async handler(ctx, input) {
    const conditions = [];
    if (input.search) {
      const like = `%${input.search}%`;
      conditions.push(or(ilike(workspaces.name, like), ilike(organizations.name, like))!);
    }
    // Only 'newest' pages, because it is the only order that cannot change under the reader's feet.
    if (input.cursor && input.sort === 'newest')
      conditions.push(lt(workspaces.createdAt, new Date(input.cursor)));
    const order =
      input.sort === 'name'
        ? [asc(workspaces.name)]
        : input.sort === 'busiest'
          ? [desc(lastActive)]
          : input.sort === 'quietest'
            ? [asc(lastActive)]
            : [desc(workspaces.createdAt)];
    const list = await ctx.tx
      .select({
        w: workspaces,
        organizationName: organizations.name,
        members: memberCount,
        open: openTickets,
        lastActiveAt: lastActive,
      })
      .from(workspaces)
      .leftJoin(organizations, eq(organizations.id, workspaces.organizationId))
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(...order)
      .limit(input.limit + 1);
    const page = list.slice(0, input.limit);
    const last = page[page.length - 1];
    const [totals] = await rows<{
      businesses: string;
      new_this_week: string;
      active_this_week: string;
    }>(ctx.tx, sql`select * from private.admin_business_totals()`);
    return {
      businesses: page.map(({ w, organizationName, members, open, lastActiveAt }) => ({
        workspaceId: w.id,
        name: w.name,
        organizationId: w.organizationId,
        organizationName: organizationName ?? '',
        industry: w.industry,
        timezone: w.timezone,
        memberCount: members,
        lastActiveAt: lastActiveAt ? new Date(lastActiveAt).toISOString() : null,
        openTicketCount: open,
        createdAt: w.createdAt.toISOString(),
      })),
      nextCursor:
        list.length > input.limit && last && input.sort === 'newest'
          ? last.w.createdAt.toISOString()
          : null,
      totals: {
        businesses: Number(totals?.businesses ?? 0),
        newThisWeek: Number(totals?.new_this_week ?? 0),
        activeThisWeek: Number(totals?.active_this_week ?? 0),
      },
    };
  },
});

export const platformBusinessGet = defineQuery({
  name: 'platform.business.get',
  description: 'One business: its people, how much of each thing it holds, and what it has set up.',
  input: BusinessGetInput,
  output: BusinessGetOutput,
  permission: 'platform.businesses.read',
  scope: onPlatform,
  async handler(ctx, input) {
    const [row] = await ctx.tx
      .select({
        w: workspaces,
        organizationName: organizations.name,
        members: memberCount,
        open: openTickets,
        lastActiveAt: lastActive,
      })
      .from(workspaces)
      .leftJoin(organizations, eq(organizations.id, workspaces.organizationId))
      .where(eq(workspaces.id, input.workspaceId));
    if (!row) throw HfosError.notFound('No business with that id.');
    const [counts] = await rows<{
      people: string;
      leads: string;
      conversations: string;
      appointments: string;
      invoices: string;
      has_phone: boolean;
      has_email: boolean;
      has_payments: boolean;
      has_calendar: boolean;
      has_ai: boolean;
      last_active_at: string | null;
    }>(ctx.tx, sql`select * from private.admin_business_counts(${input.workspaceId})`);
    const people = await ctx.tx
      .select({
        userId: users.id,
        fullName: users.fullName,
        email: dsql<string>`${users.email}::text`,
        role: workspaceMemberships.role,
        lastActiveAt: dsql<string | null>`(
          select max(e.created_at)::text from app.events e
          where e.workspace_id = ${input.workspaceId} and e.actor_id = ${users.id}
        )`,
      })
      .from(workspaceMemberships)
      .innerJoin(users, eq(users.id, workspaceMemberships.userId))
      .where(eq(workspaceMemberships.workspaceId, input.workspaceId))
      .orderBy(asc(users.fullName))
      .limit(100);
    const theirTickets = await ctx.tx
      .select({
        id: tickets.id,
        number: tickets.number,
        subject: tickets.subject,
        status: tickets.status,
        createdAt: tickets.createdAt,
      })
      .from(tickets)
      .where(and(eq(tickets.workspaceId, input.workspaceId), isNull(tickets.mergedInto)))
      .orderBy(desc(tickets.createdAt))
      .limit(20);
    return {
      phoneModel: PHONE_MODELS.find((m) => m === row.w.phoneModel) ?? null,
      business: {
        workspaceId: row.w.id,
        name: row.w.name,
        organizationId: row.w.organizationId,
        organizationName: row.organizationName ?? '',
        industry: row.w.industry,
        timezone: row.w.timezone,
        memberCount: row.members,
        lastActiveAt: row.lastActiveAt ? new Date(row.lastActiveAt).toISOString() : null,
        openTicketCount: row.open,
        createdAt: row.w.createdAt.toISOString(),
      },
      people: people.map((p) => ({
        userId: p.userId,
        fullName: p.fullName,
        email: p.email,
        role: p.role,
        lastActiveAt: p.lastActiveAt ? new Date(p.lastActiveAt).toISOString() : null,
      })),
      counts: {
        people: Number(counts?.people ?? 0),
        leads: Number(counts?.leads ?? 0),
        conversations: Number(counts?.conversations ?? 0),
        appointments: Number(counts?.appointments ?? 0),
        invoices: Number(counts?.invoices ?? 0),
      },
      tickets: theirTickets.map((t) => ({
        id: t.id,
        number: Number(t.number),
        subject: t.subject,
        status: t.status,
        createdAt: t.createdAt.toISOString(),
      })),
      setup: {
        phone: Boolean(counts?.has_phone),
        email: Boolean(counts?.has_email),
        payments: Boolean(counts?.has_payments),
        calendar: Boolean(counts?.has_calendar),
        aiTeammate: Boolean(counts?.has_ai),
      },
    };
  },
});

export const platformHealthSummary = defineQuery({
  name: 'platform.health.summary',
  description:
    'What has failed lately across every business, so it is found before a customer writes in.',
  input: HealthSummaryInput,
  output: HealthSummaryOutput,
  permission: 'platform.health.read',
  scope: onPlatform,
  async handler(ctx, input) {
    const since = new Date(Date.now() - input.hours * 60 * 60_000);
    const [c] = await rows<{
      failed_jobs: string;
      failed_deliveries: string;
      email_bounces: string;
      failed_texts: string;
      payment_failures: string;
      lost_transcripts: string;
      outbox_backlog: string;
      oldest_pending_minutes: number | null;
    }>(ctx.tx, sql`select * from private.admin_health_counts(${since.toISOString()}::timestamptz)`);
    const [w] = await rows<{
      suspended: string;
      declines: string;
      drifting: string;
      negative: string;
      unreconciled_days: string;
    }>(ctx.tx, sql`select * from private.admin_wallet_health(${since.toISOString()}::timestamptz)`);
    const recent = await rows<{
      kind: string;
      at: string;
      business: string | null;
      detail: string;
    }>(
      ctx.tx,
      sql`select * from private.admin_health_recent(${since.toISOString()}::timestamptz, 25)`,
    );
    const number = (v: string | undefined) => Number(v ?? 0);
    const one = (label: string, value: string | undefined) => ({
      label,
      count: number(value),
      worstBusiness:
        recent.find((r) => r.kind.toLowerCase().startsWith(label.toLowerCase().slice(0, 5)))
          ?.business ?? null,
    });
    return {
      since: since.toISOString(),
      failedJobs: one('Background job', c?.failed_jobs),
      failedDeliveries: one('Webhook', c?.failed_deliveries),
      emailBounces: one('Email bounced', c?.email_bounces),
      failedTexts: one('Text message', c?.failed_texts),
      paymentFailures: one('Payment', c?.payment_failures),
      lostTranscripts: one('Transcript', c?.lost_transcripts),
      wallets: {
        suspended: number(w?.suspended),
        declines: number(w?.declines),
        drifting: number(w?.drifting),
        negative: number(w?.negative),
        unreconciledDays: number(w?.unreconciled_days),
      },
      outboxBacklog: number(c?.outbox_backlog),
      oldestPendingMinutes: c?.oldest_pending_minutes ?? null,
      recent: recent.map((r) => ({
        kind: r.kind,
        at: new Date(r.at).toISOString(),
        business: r.business,
        detail: r.detail,
      })),
    };
  },
});

/**
 * One business's balance, for the support desk (M16).
 *
 * This is the page a "my texts stopped" ticket is answered from, so it is the one view of a wallet that shows
 * **cost beside price**. A business is shown what it was charged, because that is the number it decides on;
 * staff are shown both, because the question they get asked is why.
 *
 * `private.admin_wallet_for` is `security definer` and checks `platform.businesses.read` for itself, so the
 * permission is enforced twice on purpose — here, where it is readable, and there, where it is true.
 */
export const platformWalletGet = defineQuery({
  name: 'platform.wallet.get',
  description:
    'One business’s usage balance, its card, and what 30 days of it cost against what it was charged.',
  input: AdminWalletGetInput,
  output: AdminWalletGetOutput,
  permission: 'platform.businesses.read',
  scope: onPlatform,
  async handler(ctx, input) {
    const [w] = await rows<{
      stage: string;
      balance_cents: string;
      auto_topup: boolean;
      floor_cents: string;
      topup_cents: string;
      has_card: boolean;
      card_brand: string | null;
      card_last4: string | null;
      suspended_at: Date | null;
      suspended_reason: string | null;
      declines_in_row: number;
      escalation_step: number;
      spent_30d_cents: string;
      cost_30d_cents: string;
      topped_up_30d_cents: string;
    }>(ctx.tx, sql`select * from private.admin_wallet_for(${input.workspaceId}::uuid)`);
    // No row is a business that has never spent anything and has never been moved along — not an error, and
    // not a zero balance either. The page says "nothing yet".
    if (!w)
      return {
        opened: false,
        stage: 'off' as const,
        balanceCents: 0,
        autoTopup: true,
        floorCents: 1000,
        topupCents: 2500,
        hasCard: false,
        cardBrand: null,
        cardLast4: null,
        suspendedAt: null,
        suspendedReason: null,
        declinesInRow: 0,
        escalationStep: 0,
        spent30dCents: 0,
        cost30dCents: 0,
        toppedUp30dCents: 0,
      };
    const stage = WalletStageValue.options.find((s) => s === w.stage) ?? 'off';
    return {
      opened: true,
      stage,
      balanceCents: Number(w.balance_cents),
      autoTopup: w.auto_topup,
      floorCents: Number(w.floor_cents),
      topupCents: Number(w.topup_cents),
      hasCard: w.has_card,
      cardBrand: w.card_brand,
      cardLast4: w.card_last4,
      suspendedAt: w.suspended_at ? w.suspended_at.toISOString() : null,
      suspendedReason: w.suspended_reason,
      declinesInRow: Number(w.declines_in_row),
      escalationStep: Number(w.escalation_step),
      spent30dCents: Number(w.spent_30d_cents),
      cost30dCents: Number(w.cost_30d_cents),
      toppedUp30dCents: Number(w.topped_up_30d_cents),
    };
  },
});

export const platformViewAsCurrent = defineQuery({
  name: 'platform.view_as.current',
  description:
    'The business this person is looking at, if any. Answers for everyone, staff or not.',
  input: ViewAsCurrentInput,
  output: ViewAsCurrentOutput,
  permission: null,
  // Asked by the app shell on ordinary pages too, so it must not refuse anyone.
  scope: () => ({ kind: 'none' }),
  async handler(ctx) {
    const me = requireHuman(ctx).userId;
    const [row] = await ctx.tx
      .select({ v: viewAsSessions, businessName: workspaces.name })
      .from(viewAsSessions)
      .leftJoin(workspaces, eq(workspaces.id, viewAsSessions.workspaceId))
      .where(
        and(
          eq(viewAsSessions.staffUserId, me),
          isNull(viewAsSessions.endedAt),
          dsql`${viewAsSessions.expiresAt} > now()`,
        ),
      )
      .orderBy(desc(viewAsSessions.startedAt))
      .limit(1);
    if (!row) return { session: null };
    return {
      session: {
        id: row.v.id,
        workspaceId: row.v.workspaceId,
        businessName: row.businessName ?? '',
        reason: row.v.reason,
        startedAt: row.v.startedAt.toISOString(),
        expiresAt: row.v.expiresAt.toISOString(),
      },
    };
  },
});

/**
 * The rate card, with what each line actually realised (M16, step 8).
 *
 * The margin column is the point of this page. The seeded prices are guesses until a real week measures them,
 * and a guess that is wrong loses money quietly for a month — a line whose realised markup is under 1.2× is
 * one somebody has to look at today. Everything here is staff-only: `costMicros` is what **we** pay, which a
 * business never sees.
 */
export const platformRateCard = defineQuery({
  name: 'platform.rates',
  description:
    'The live usage rate card, and what each line actually charged against what it actually cost over a period.',
  input: RateCardGetInput,
  output: RateCardGetOutput,
  permission: 'platform.rates.manage',
  scope: onPlatform,
  async handler(ctx, input) {
    const since = new Date(Date.now() - input.days * 86_400_000);
    const [lines, margins] = await Promise.all([
      rows<{
        key: string;
        unit: string;
        cost_micros: string;
        markup_bp: number;
        min_charge_cents: number;
        round_up_to: string;
        version: number;
        notes: string;
      }>(
        ctx.tx,
        sql`select key, unit::text as unit, cost_micros, markup_bp, min_charge_cents,
              round_up_to::text as round_up_to, version, notes
            from platform.usage_rates_live order by key`,
      ),
      rows<{
        rate_key: string;
        events: string;
        charged_cents: string;
        cost_cents: string;
        realised: string | null;
      }>(
        ctx.tx,
        sql`select rate_key, events, charged_cents, cost_cents, realised
            from private.admin_usage_margin(${since.toISOString()}::timestamptz)`,
      ),
    ]);
    const byKey = new Map(margins.map((m) => [m.rate_key, m]));
    const card: RateCard = {
      version: lines[0]?.version ?? SEED_CARD.version,
      rates: Object.fromEntries(
        lines
          .filter((l) => isUsageKey(l.key))
          .map((l) => [
            l.key,
            {
              key: l.key as UsageKey,
              unit: l.unit as UsageRate['unit'],
              costMicros: Number(l.cost_micros),
              markupBp: l.markup_bp,
              minChargeCents: l.min_charge_cents,
              roundUpTo: l.round_up_to as UsageRate['roundUpTo'],
            },
          ]),
      ) as RateCard['rates'],
    };
    return {
      version: card.version,
      since: since.toISOString(),
      lines: lines.map((l) => {
        const m = byKey.get(l.key);
        return {
          key: l.key,
          unit: l.unit,
          costMicros: Number(l.cost_micros),
          markupBp: l.markup_bp,
          minChargeCents: l.min_charge_cents,
          roundUpTo: l.round_up_to,
          unitPriceCents: isUsageKey(l.key) ? unitPriceCents(card, l.key) : 0,
          notes: l.notes,
          realised:
            m && m.realised !== null
              ? {
                  events: Number(m.events),
                  chargedCents: Number(m.charged_cents),
                  costCents: Number(m.cost_cents),
                  markup: Number(m.realised),
                }
              : null,
        };
      }),
    };
  },
});

export const platformQueries = [
  platformBusinessList,
  platformBusinessGet,
  platformHealthSummary,
  platformViewAsCurrent,
  platformRateCard,
  platformWalletGet,
];
