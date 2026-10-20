/**
 * Reading the support desk (M13): the queue, one ticket with everything on it, the saved replies, and who
 * answers support. Every one of these is `platform` scope, so it exists only for someone who works here.
 */
import {
  and,
  asc,
  count,
  desc,
  eq,
  ilike,
  inArray,
  isNull,
  lt,
  or,
  sql as dsql,
} from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import {
  cannedReplies,
  staff,
  staffInvitations,
  tickets,
  ticketDrafts,
  ticketEvents,
  ticketMessages,
  users,
  workspaces,
  organizations,
  workspaceMemberships,
} from '@hfos/db/schema';
import { HfosError } from '../errors';
import { requireHuman } from '../kernel/actor';
import { defineQuery } from '../kernel/define';
import { ROLE_PERMISSIONS } from '../permissions';
import {
  CannedReplyListInput,
  CannedReplyListOutput,
  PlatformMeInput,
  PlatformMeOutput,
  QueueSummaryInput,
  QueueSummaryOutput,
  StaffListInput,
  StaffListOutput,
  TicketGetInput,
  TicketGetOutput,
  TicketListInput,
  TicketListOutput,
} from '../schemas/support';

const onPlatform = () => ({ kind: 'platform' as const });
const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);
/** A ticket still on our side of the fence, or waiting for an answer that will bring it back. */
const OPEN_STATUSES = ['new', 'open', 'waiting_on_customer'] as const;

/** One line of a ticket in a list: enough to decide whether to open it. */
function summarize(row: {
  t: typeof tickets.$inferSelect;
  businessName: string | null;
  businessOrg: string | null;
  assigneeName: string | null;
  assigneeEmail: string | null;
  requesterName: string | null;
  preview: string | null;
}) {
  const t = row.t;
  return {
    id: t.id,
    number: Number(t.number),
    subject: t.subject,
    status: t.status,
    priority: t.priority,
    channel: t.channel,
    requester: {
      userId: t.requesterUserId,
      name: t.requesterName || row.requesterName || '',
      email: t.requesterEmail,
    },
    business: t.workspaceId
      ? {
          workspaceId: t.workspaceId,
          name: row.businessName ?? '',
          organizationId: row.businessOrg ?? t.organizationId,
        }
      : null,
    assignee: t.assigneeUserId
      ? { userId: t.assigneeUserId, name: row.assigneeName ?? '', email: row.assigneeEmail ?? '' }
      : null,
    tags: t.tags ?? [],
    preview: (row.preview ?? '').slice(0, 200),
    waitingSince: iso(t.lastCustomerAt ?? t.createdAt),
    snoozeUntil: iso(t.snoozeUntil),
    firstResponseAt: iso(t.firstResponseAt),
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
  };
}

/** The last thing said on a ticket, notes included: it is what a person answering would want to see. */
const previewOf = dsql<string>`(
  select left(coalesce(m.body_text, ''), 200) from platform.ticket_messages m
  where m.ticket_id = ${tickets.id} order by m.created_at desc limit 1
)`;

export const supportTicketList = defineQuery({
  name: 'support.ticket.list',
  description: 'The support queue, newest activity first.',
  input: TicketListInput,
  output: TicketListOutput,
  permission: 'support.read',
  scope: onPlatform,
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const assignee = alias(users, 'assignee');
    const requester = alias(users, 'requester');
    const conditions = [isNull(tickets.mergedInto)];
    if (input.status?.length) conditions.push(inArray(tickets.status, input.status));
    if (input.assignee === 'mine') conditions.push(eq(tickets.assigneeUserId, me));
    else if (input.assignee === 'unassigned') conditions.push(isNull(tickets.assigneeUserId));
    else if (input.assignee !== 'anyone')
      conditions.push(eq(tickets.assigneeUserId, input.assignee));
    if (input.workspaceId) conditions.push(eq(tickets.workspaceId, input.workspaceId));
    if (!input.includeSnoozed)
      conditions.push(or(isNull(tickets.snoozeUntil), lt(tickets.snoozeUntil, new Date()))!);
    if (input.search) {
      const like = `%${input.search}%`;
      // A ticket number is digits, with or without its #. Number() alone would also read "1e5" or "2798e143" (a
      // search for part of an id), and hand the database a number no bigint can hold.
      const digits = /^#?(\d{1,15})$/.exec(input.search.trim())?.[1];
      const asNumber = digits ? Number(digits) : 0;
      conditions.push(
        or(
          ilike(tickets.subject, like),
          ilike(dsql`${tickets.requesterEmail}::text`, like),
          ilike(tickets.requesterName, like),
          ...(asNumber > 0 ? [eq(tickets.number, asNumber)] : []),
        )!,
      );
    }
    // The cursor is the updated_at of the last row shown: the list is only ever read downwards.
    if (input.cursor) conditions.push(lt(tickets.updatedAt, new Date(input.cursor)));
    const list = await ctx.tx
      .select({
        t: tickets,
        businessName: workspaces.name,
        businessOrg: workspaces.organizationId,
        assigneeName: assignee.fullName,
        assigneeEmail: dsql<string>`${assignee.email}::text`,
        requesterName: requester.fullName,
        preview: previewOf,
      })
      .from(tickets)
      .leftJoin(workspaces, eq(workspaces.id, tickets.workspaceId))
      .leftJoin(assignee, eq(assignee.id, tickets.assigneeUserId))
      .leftJoin(requester, eq(requester.id, tickets.requesterUserId))
      .where(and(...conditions))
      .orderBy(desc(tickets.updatedAt))
      .limit(input.limit + 1);
    const page = list.slice(0, input.limit);
    const last = page[page.length - 1];
    return {
      tickets: page.map(summarize),
      nextCursor: list.length > input.limit && last ? last.t.updatedAt.toISOString() : null,
    };
  },
});

export const supportTicketGet = defineQuery({
  name: 'support.ticket.get',
  description: 'One ticket: the whole conversation, what happened to it, and who it is from.',
  input: TicketGetInput,
  output: TicketGetOutput,
  permission: 'support.read',
  scope: onPlatform,
  async handler(ctx, input) {
    const assignee = alias(users, 'assignee');
    const requester = alias(users, 'requester');
    const [row] = await ctx.tx
      .select({
        t: tickets,
        businessName: workspaces.name,
        businessOrg: workspaces.organizationId,
        assigneeName: assignee.fullName,
        assigneeEmail: dsql<string>`${assignee.email}::text`,
        requesterName: requester.fullName,
        preview: previewOf,
      })
      .from(tickets)
      .leftJoin(workspaces, eq(workspaces.id, tickets.workspaceId))
      .leftJoin(assignee, eq(assignee.id, tickets.assigneeUserId))
      .leftJoin(requester, eq(requester.id, tickets.requesterUserId))
      .where(eq(tickets.id, input.ticketId));
    if (!row)
      throw HfosError.notFound('That ticket isn’t there anymore. Refresh the list and try again.');
    const ticket = summarize(row);

    const author = alias(users, 'author');
    const messages = await ctx.tx
      .select({ m: ticketMessages, authorName: author.fullName, staffName: staff.displayName })
      .from(ticketMessages)
      .leftJoin(author, eq(author.id, ticketMessages.authorUserId))
      .leftJoin(staff, eq(staff.userId, ticketMessages.authorUserId))
      .where(eq(ticketMessages.ticketId, input.ticketId))
      .orderBy(asc(ticketMessages.createdAt))
      .limit(200);

    const actor = alias(users, 'actor');
    const history = await ctx.tx
      .select({ e: ticketEvents, actorName: actor.fullName })
      .from(ticketEvents)
      .leftJoin(actor, eq(actor.id, ticketEvents.actorUserId))
      .where(eq(ticketEvents.ticketId, input.ticketId))
      .orderBy(desc(ticketEvents.createdAt))
      .limit(50);

    const [draft] = await ctx.tx
      .select()
      .from(ticketDrafts)
      .where(and(eq(ticketDrafts.ticketId, input.ticketId), isNull(ticketDrafts.dismissedAt)));
    const lastCustomerMessage = [...messages].reverse().find((m) => m.m.author === 'customer');

    let business: TicketGetOutput['business'] = null;
    if (row.t.workspaceId) {
      const [b] = await ctx.tx
        .select({
          id: workspaces.id,
          name: workspaces.name,
          createdAt: workspaces.createdAt,
          organizationName: organizations.name,
        })
        .from(workspaces)
        .leftJoin(organizations, eq(organizations.id, workspaces.organizationId))
        .where(eq(workspaces.id, row.t.workspaceId));
      if (b) {
        const [members] = await ctx.tx
          .select({ n: count() })
          .from(workspaceMemberships)
          .where(eq(workspaceMemberships.workspaceId, b.id));
        const [open] = await ctx.tx
          .select({ n: count() })
          .from(tickets)
          .where(and(eq(tickets.workspaceId, b.id), inArray(tickets.status, [...OPEN_STATUSES])));
        business = {
          workspaceId: b.id,
          name: b.name,
          organizationName: b.organizationName ?? '',
          createdAt: b.createdAt.toISOString(),
          memberCount: members?.n ?? 0,
          openTicketCount: open?.n ?? 0,
        };
      }
    }

    const alsoFrom = await ctx.tx
      .select({
        id: tickets.id,
        number: tickets.number,
        subject: tickets.subject,
        status: tickets.status,
      })
      .from(tickets)
      .where(
        and(
          eq(tickets.requesterEmail, row.t.requesterEmail),
          dsql`${tickets.id} <> ${input.ticketId}`,
        ),
      )
      .orderBy(desc(tickets.createdAt))
      .limit(5);

    return {
      ticket,
      messages: messages.map(({ m, authorName, staffName }) => ({
        id: m.id,
        author: m.author,
        internal: m.internal,
        authorName:
          m.author === 'staff'
            ? staffName || authorName || 'HandsFreeOS'
            : m.author === 'customer'
              ? authorName || ticket.requester.name || ticket.requester.email
              : m.author === 'ai'
                ? 'AI draft'
                : 'HandsFreeOS',
        bodyText: m.bodyText,
        bodyHtml: m.bodyHtml,
        attachments:
          (m.attachments as { name: string; contentType: string; sizeBytes: number }[]) ?? [],
        createdAt: m.createdAt.toISOString(),
      })),
      events: history.map(({ e, actorName }) => ({
        id: e.id,
        kind: e.kind,
        actorName: actorName ?? 'HandsFreeOS',
        data: e.data,
        createdAt: e.createdAt.toISOString(),
      })),
      draft: draft
        ? {
            bodyText: draft.bodyText,
            sources: (draft.sources as { kind: string; title: string; id: string | null }[]) ?? [],
            model: draft.model,
            createdAt: draft.createdAt.toISOString(),
            // Written for an earlier message: still useful, but say so rather than pretend.
            stale: Boolean(
              lastCustomerMessage && draft.answersMessageId !== lastCustomerMessage.m.id,
            ),
          }
        : null,
      business,
      alsoFrom: alsoFrom.map((t) => ({
        id: t.id,
        number: Number(t.number),
        subject: t.subject,
        status: t.status,
      })),
    };
  },
});

export const supportQueueSummary = defineQuery({
  name: 'support.queue.summary',
  description: 'The numbers at the top of the support desk.',
  input: QueueSummaryInput,
  output: QueueSummaryOutput,
  permission: 'support.read',
  scope: onPlatform,
  async handler(ctx) {
    const me = requireHuman(ctx).userId;
    const [row] = await ctx.tx
      .select({
        unanswered: dsql<number>`count(*) filter (where ${tickets.status} in ('new', 'open'))::int`,
        mine: dsql<number>`count(*) filter (where ${tickets.assigneeUserId} = ${me} and ${tickets.status} in ('new', 'open', 'waiting_on_customer'))::int`,
        unassigned: dsql<number>`count(*) filter (where ${tickets.assigneeUserId} is null and ${tickets.status} in ('new', 'open'))::int`,
        waiting: dsql<number>`count(*) filter (where ${tickets.status} = 'waiting_on_customer')::int`,
        solvedToday: dsql<number>`count(*) filter (where ${tickets.resolvedAt} > now() - interval '24 hours')::int`,
        oldest: dsql<
          number | null
        >`(select (extract(epoch from (now() - min(t2.created_at))) / 60)::int from platform.tickets t2 where t2.status in ('new', 'open') and t2.merged_into is null)`,
      })
      .from(tickets)
      .where(isNull(tickets.mergedInto));
    return {
      unanswered: row?.unanswered ?? 0,
      mine: row?.mine ?? 0,
      unassigned: row?.unassigned ?? 0,
      waitingOnCustomer: row?.waiting ?? 0,
      solvedToday: row?.solvedToday ?? 0,
      oldestWaitingMinutes: row?.oldest ?? null,
    };
  },
});

export const supportCannedReplyList = defineQuery({
  name: 'support.canned_reply.list',
  description: 'The saved replies everyone answering support can use.',
  input: CannedReplyListInput,
  output: CannedReplyListOutput,
  permission: 'support.read',
  scope: onPlatform,
  async handler(ctx) {
    const list = await ctx.tx.select().from(cannedReplies).orderBy(asc(cannedReplies.title));
    return {
      replies: list.map((r) => ({
        id: r.id,
        title: r.title,
        bodyText: r.bodyText,
        updatedAt: r.updatedAt.toISOString(),
      })),
    };
  },
});

export const supportStaffList = defineQuery({
  name: 'support.staff.list',
  description: 'Who answers HandsFreeOS support, and who has been invited.',
  input: StaffListInput,
  output: StaffListOutput,
  permission: 'support.read',
  scope: onPlatform,
  async handler(ctx) {
    const people = await ctx.tx
      .select({
        s: staff,
        fullName: users.fullName,
        email: dsql<string>`${users.email}::text`,
        open: dsql<number>`(
          select count(*)::int from platform.tickets t
          where t.assignee_user_id = ${staff.userId} and t.status in ('new', 'open', 'waiting_on_customer')
        )`,
      })
      .from(staff)
      .innerJoin(users, eq(users.id, staff.userId))
      .orderBy(asc(staff.createdAt));
    const inviter = alias(users, 'inviter');
    // Named columns on purpose: the token's hash is not readable by anyone, so asking for the whole row
    // would be refused outright.
    const waiting = await ctx.tx
      .select({
        id: staffInvitations.id,
        role: staffInvitations.role,
        sentAt: staffInvitations.sentAt,
        expiresAt: staffInvitations.expiresAt,
        createdAt: staffInvitations.createdAt,
        email: dsql<string>`${staffInvitations.email}::text`,
        invitedByName: inviter.fullName,
      })
      .from(staffInvitations)
      .leftJoin(inviter, eq(inviter.id, staffInvitations.invitedBy))
      .where(and(isNull(staffInvitations.acceptedAt), isNull(staffInvitations.revokedAt)))
      .orderBy(desc(staffInvitations.createdAt));
    return {
      staff: people.map(({ s, fullName, email, open }) => ({
        userId: s.userId,
        fullName,
        email,
        displayName: s.displayName,
        role: s.role,
        status: s.status,
        openTicketCount: open,
        createdAt: s.createdAt.toISOString(),
      })),
      invitations: waiting.map((i) => ({
        id: i.id,
        email: i.email,
        role: i.role,
        invitedByName: i.invitedByName ?? '',
        sentAt: iso(i.sentAt),
        expiresAt: i.expiresAt.toISOString(),
        createdAt: i.createdAt.toISOString(),
      })),
    };
  },
});

/**
 * Am I staff, and what may I do? Asked by the app shell on every admin page, so it answers for everyone —
 * a plain `null` for the thousands of people who do not work here, rather than a refusal.
 */
export const platformMe = defineQuery({
  name: 'platform.me',
  description: 'Whether the signed-in person answers HandsFreeOS support, and what they may do.',
  input: PlatformMeInput,
  output: PlatformMeOutput,
  permission: null,
  scope: () => ({ kind: 'none' }),
  async handler(ctx) {
    const me = requireHuman(ctx).userId;
    const [row] = await ctx.tx
      .select()
      .from(staff)
      .where(and(eq(staff.userId, me), eq(staff.status, 'active')));
    if (!row) return { staff: null };
    return {
      staff: {
        userId: row.userId,
        role: row.role,
        displayName: row.displayName,
        signature: row.signature,
        permissions: [...ROLE_PERMISSIONS[`staff_${row.role}`]],
        founder: row.founder,
      },
    };
  },
});

export const supportQueries = [
  supportTicketList,
  supportTicketGet,
  supportQueueSummary,
  supportCannedReplyList,
  supportStaffList,
  platformMe,
];
