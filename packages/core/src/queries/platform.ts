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
import { HfosError } from '../errors';
import { requireHuman } from '../kernel/actor';
import { defineQuery } from '../kernel/define';
import {
  BusinessGetInput,
  BusinessGetOutput,
  BusinessListInput,
  BusinessListOutput,
  HealthSummaryInput,
  HealthSummaryOutput,
  ViewAsCurrentInput,
  ViewAsCurrentOutput,
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

export const platformQueries = [
  platformBusinessList,
  platformBusinessGet,
  platformHealthSummary,
  platformViewAsCurrent,
];
