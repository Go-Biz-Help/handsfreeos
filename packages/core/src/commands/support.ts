/**
 * The support desk (M13): what a support person does to a ticket, and the one thing a customer does —
 * ask for help from inside HandsFreeOS.
 *
 * Nothing here sends an email itself. A reply is written down and an event is emitted; the worker puts it
 * on the wire, exactly as a business's own messages go out. The AI's draft is the same story in reverse:
 * a person asks for one, the worker writes it, and the draft sits there until a person sends it.
 */
import { and, eq, isNull } from 'drizzle-orm';
import { rows, sql } from '@hfos/db/client';
import {
  tickets,
  ticketDrafts,
  ticketEvents,
  ticketMessages,
  cannedReplies,
  staff,
  workspaces,
} from '@hfos/db/schema';
import { HfosError } from '../errors';
import { requireHuman } from '../kernel/actor';
import { defineCommand } from '../kernel/define';
import type { CommandContext } from '../kernel/types';
import {
  type TicketStatusValue,
  CannedReplyDeleteInput,
  CannedReplyDeleteOutput,
  CannedReplySaveInput,
  CannedReplySaveOutput,
  SupportRequestInput,
  SupportRequestOutput,
  TicketAssignInput,
  TicketLinkBusinessInput,
  TicketMergeInput,
  TicketRefInput,
  TicketReplyInput,
  TicketReplyOutput,
  TicketSetPriorityInput,
  TicketSetStatusInput,
  TicketSnoozeInput,
  TicketWriteOutput,
} from '../schemas/support';

const onPlatform = () => ({ kind: 'platform' as const });

interface TicketRow {
  id: string;
  number: number;
  status: TicketStatusValue;
  subject: string;
  workspaceId: string | null;
  assigneeUserId: string | null;
  firstResponseAt: Date | null;
}

/** The ticket, or a plain "no such thing" — a ticket id nobody here may see does not exist for them. */
async function ticketOr404(ctx: CommandContext, ticketId: string): Promise<TicketRow> {
  const [row] = await ctx.tx
    .select({
      id: tickets.id,
      number: tickets.number,
      status: tickets.status,
      subject: tickets.subject,
      workspaceId: tickets.workspaceId,
      assigneeUserId: tickets.assigneeUserId,
      firstResponseAt: tickets.firstResponseAt,
    })
    .from(tickets)
    .where(eq(tickets.id, ticketId));
  if (!row) throw HfosError.notFound('No ticket with that id.');
  return row as TicketRow;
}

async function note(
  ctx: CommandContext,
  ticketId: string,
  kind: string,
  data: Record<string, unknown> = {},
): Promise<void> {
  await ctx.tx.insert(ticketEvents).values({
    ticketId,
    kind,
    actorUserId: requireHuman(ctx).userId,
    data,
  });
}

// ---------- the customer's way in ----------

export const supportRequestCreate = defineCommand({
  name: 'support.request.create',
  description: 'Ask HandsFreeOS support for help from inside the app. Opens a ticket.',
  risk: 1,
  input: SupportRequestInput,
  output: SupportRequestOutput,
  // Anyone who works in the business may ask for help about it.
  permission: 'workspace.read',
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  emits: ['support_ticket.opened'],
  async handler(ctx, input) {
    // The ticket belongs to no business's data, so it is written by a function that checks the one thing
    // that matters: that the person asking really works in the business they are asking about.
    const [row] = await rows<{ ticket_id: string; ticket_number: string }>(
      ctx.tx,
      sql`select ticket_id, ticket_number from private.open_support_ticket(
        ${input.workspaceId}, ${input.subject}, ${input.body}, ${JSON.stringify(input.context)}::jsonb)`,
    );
    if (!row) throw HfosError.notFound('Workspace not found.');
    await ctx.emit({
      type: 'support_ticket.opened',
      entityType: 'support_ticket',
      entityId: row.ticket_id,
      payload: { number: Number(row.ticket_number), channel: 'in_app' },
    });
    return { ticketId: row.ticket_id, number: Number(row.ticket_number) };
  },
});

// ---------- answering ----------

export const supportTicketReply = defineCommand({
  name: 'support.ticket.reply',
  description: 'Answer a support ticket, or leave an internal note on it.',
  risk: 2,
  input: TicketReplyInput,
  output: TicketReplyOutput,
  permission: 'support.reply',
  scope: onPlatform,
  emits: ['support_ticket.replied'],
  async handler(ctx, input) {
    const ticket = await ticketOr404(ctx, input.ticketId);
    if (ticket.status === 'closed' && input.internal === false)
      throw HfosError.conflict(
        'This ticket is closed. Reopen it before answering.',
        'ticket_closed',
      );
    const me = requireHuman(ctx).userId;
    const now = new Date();
    const [message] = await ctx.tx
      .insert(ticketMessages)
      .values({
        ticketId: ticket.id,
        author: 'staff',
        internal: input.internal,
        authorUserId: me,
        bodyText: input.body,
      })
      .returning({ id: ticketMessages.id });
    // A note changes nothing about where the ticket stands; only an answer does.
    const status: TicketStatusValue = input.internal
      ? ticket.status
      : (input.status ?? 'waiting_on_customer');
    if (!input.internal) {
      await ctx.tx
        .update(tickets)
        .set({
          status,
          lastStaffAt: now,
          firstResponseAt: ticket.firstResponseAt ?? now,
          resolvedAt: status === 'solved' || status === 'closed' ? now : null,
          snoozeUntil: null,
          // Answering a ticket nobody had picked up takes it.
          assigneeUserId: ticket.assigneeUserId ?? me,
        })
        .where(eq(tickets.id, ticket.id));
      // The draft answered the message before this one; once a person has replied it is history.
      await ctx.tx.delete(ticketDrafts).where(eq(ticketDrafts.ticketId, ticket.id));
    }
    await ctx.emit({
      type: 'support_ticket.replied',
      entityType: 'support_ticket',
      entityId: ticket.id,
      payload: {
        messageId: message!.id,
        internal: input.internal,
        number: ticket.number,
      },
      after: { status },
    });
    return { messageId: message!.id, status };
  },
});

export const supportTicketSetStatus = defineCommand({
  name: 'support.ticket.set_status',
  description: 'Move a ticket to another status: open, waiting, solved or closed.',
  risk: 1,
  input: TicketSetStatusInput,
  output: TicketWriteOutput,
  permission: 'support.reply',
  scope: onPlatform,
  emits: ['support_ticket.status_changed'],
  async handler(ctx, input) {
    const ticket = await ticketOr404(ctx, input.ticketId);
    if (ticket.status === input.status) return { ticketId: ticket.id };
    const done = input.status === 'solved' || input.status === 'closed';
    await ctx.tx
      .update(tickets)
      .set({ status: input.status, resolvedAt: done ? new Date() : null })
      .where(eq(tickets.id, ticket.id));
    await note(ctx, ticket.id, 'status_changed', { from: ticket.status, to: input.status });
    await ctx.emit({
      type: 'support_ticket.status_changed',
      entityType: 'support_ticket',
      entityId: ticket.id,
      payload: { number: ticket.number },
      before: { status: ticket.status },
      after: { status: input.status },
    });
    return { ticketId: ticket.id };
  },
});

export const supportTicketSetPriority = defineCommand({
  name: 'support.ticket.set_priority',
  description: 'Set how urgent a ticket is.',
  risk: 1,
  input: TicketSetPriorityInput,
  output: TicketWriteOutput,
  permission: 'support.reply',
  scope: onPlatform,
  emits: ['support_ticket.priority_changed'],
  async handler(ctx, input) {
    const ticket = await ticketOr404(ctx, input.ticketId);
    await ctx.tx.update(tickets).set({ priority: input.priority }).where(eq(tickets.id, ticket.id));
    await note(ctx, ticket.id, 'priority_changed', { to: input.priority });
    await ctx.emit({
      type: 'support_ticket.priority_changed',
      entityType: 'support_ticket',
      entityId: ticket.id,
      payload: { number: ticket.number, priority: input.priority },
    });
    return { ticketId: ticket.id };
  },
});

export const supportTicketAssign = defineCommand({
  name: 'support.ticket.assign',
  description: 'Give a ticket to someone, or put it back in the unassigned queue.',
  risk: 1,
  input: TicketAssignInput,
  output: TicketWriteOutput,
  permission: 'support.assign',
  scope: onPlatform,
  emits: ['support_ticket.assigned'],
  async handler(ctx, input) {
    const ticket = await ticketOr404(ctx, input.ticketId);
    if (input.assigneeUserId) {
      const [who] = await ctx.tx
        .select({ userId: staff.userId })
        .from(staff)
        .where(and(eq(staff.userId, input.assigneeUserId), eq(staff.status, 'active')));
      if (!who) throw HfosError.notFound('That person does not answer support.');
    }
    await ctx.tx
      .update(tickets)
      .set({ assigneeUserId: input.assigneeUserId })
      .where(eq(tickets.id, ticket.id));
    await note(ctx, ticket.id, 'assigned', { to: input.assigneeUserId });
    await ctx.emit({
      type: 'support_ticket.assigned',
      entityType: 'support_ticket',
      entityId: ticket.id,
      payload: { number: ticket.number, assigneeUserId: input.assigneeUserId },
      before: { assigneeUserId: ticket.assigneeUserId },
      after: { assigneeUserId: input.assigneeUserId },
    });
    return { ticketId: ticket.id };
  },
});

export const supportTicketSnooze = defineCommand({
  name: 'support.ticket.snooze',
  description: 'Put a ticket down until a time you choose. It comes back by itself.',
  risk: 1,
  input: TicketSnoozeInput,
  output: TicketWriteOutput,
  permission: 'support.reply',
  scope: onPlatform,
  emits: ['support_ticket.snoozed'],
  async handler(ctx, input) {
    const ticket = await ticketOr404(ctx, input.ticketId);
    const until = input.until ? new Date(input.until) : null;
    if (until && until.getTime() <= Date.now())
      throw HfosError.validation([{ path: 'until', message: 'Pick a time in the future.' }]);
    await ctx.tx.update(tickets).set({ snoozeUntil: until }).where(eq(tickets.id, ticket.id));
    await note(ctx, ticket.id, until ? 'snoozed' : 'unsnoozed', { until: input.until });
    await ctx.emit({
      type: 'support_ticket.snoozed',
      entityType: 'support_ticket',
      entityId: ticket.id,
      payload: { number: ticket.number, until: input.until },
    });
    return { ticketId: ticket.id };
  },
});

export const supportTicketLinkBusiness = defineCommand({
  name: 'support.ticket.link_business',
  description: 'Say which business a ticket is about, so their account is one click away.',
  risk: 1,
  input: TicketLinkBusinessInput,
  output: TicketWriteOutput,
  permission: 'support.reply',
  scope: onPlatform,
  emits: ['support_ticket.linked'],
  async handler(ctx, input) {
    const ticket = await ticketOr404(ctx, input.ticketId);
    let organizationId: string | null = null;
    if (input.workspaceId) {
      const [ws] = await ctx.tx
        .select({ organizationId: workspaces.organizationId })
        .from(workspaces)
        .where(eq(workspaces.id, input.workspaceId));
      if (!ws) throw HfosError.notFound('No business with that id.');
      organizationId = ws.organizationId;
    }
    await ctx.tx
      .update(tickets)
      .set({ workspaceId: input.workspaceId, organizationId })
      .where(eq(tickets.id, ticket.id));
    await note(ctx, ticket.id, 'linked_business', { workspaceId: input.workspaceId });
    await ctx.emit({
      type: 'support_ticket.linked',
      entityType: 'support_ticket',
      entityId: ticket.id,
      payload: { number: ticket.number, workspaceId: input.workspaceId },
    });
    return { ticketId: ticket.id };
  },
});

export const supportTicketMerge = defineCommand({
  name: 'support.ticket.merge',
  description:
    'Fold one ticket into another when the same person wrote twice about the same thing.',
  risk: 2,
  input: TicketMergeInput,
  output: TicketWriteOutput,
  permission: 'support.manage',
  scope: onPlatform,
  emits: ['support_ticket.merged'],
  async handler(ctx, input) {
    if (input.ticketId === input.intoTicketId)
      throw HfosError.validation([{ path: 'intoTicketId', message: 'Pick a different ticket.' }]);
    const ticket = await ticketOr404(ctx, input.ticketId);
    const into = await ticketOr404(ctx, input.intoTicketId);
    // The messages move, so the whole story is in one place; the emptied ticket stays as a signpost.
    await ctx.tx
      .update(ticketMessages)
      .set({ ticketId: into.id })
      .where(eq(ticketMessages.ticketId, ticket.id));
    await ctx.tx
      .update(tickets)
      .set({ status: 'closed', mergedInto: into.id, resolvedAt: new Date() })
      .where(eq(tickets.id, ticket.id));
    await note(ctx, into.id, 'merged_in', { number: ticket.number, ticketId: ticket.id });
    await note(ctx, ticket.id, 'merged_into', { number: into.number, ticketId: into.id });
    await ctx.emit({
      type: 'support_ticket.merged',
      entityType: 'support_ticket',
      entityId: ticket.id,
      payload: { number: ticket.number, intoTicketId: into.id, intoNumber: into.number },
    });
    return { ticketId: into.id };
  },
});

// ---------- the AI's draft ----------

export const supportDraftRequest = defineCommand({
  name: 'support.ticket.request_draft',
  description: 'Ask the AI for a suggested answer to this ticket. It never sends anything itself.',
  risk: 1,
  input: TicketRefInput,
  output: TicketWriteOutput,
  permission: 'support.reply',
  scope: onPlatform,
  emits: ['support_ticket.draft_requested'],
  async handler(ctx, input) {
    const ticket = await ticketOr404(ctx, input.ticketId);
    await ctx.emit({
      type: 'support_ticket.draft_requested',
      entityType: 'support_ticket',
      entityId: ticket.id,
      payload: { number: ticket.number },
    });
    return { ticketId: ticket.id };
  },
});

export const supportDraftDismiss = defineCommand({
  name: 'support.ticket.dismiss_draft',
  description: 'Throw away the AI’s suggested answer for this ticket.',
  risk: 0,
  input: TicketRefInput,
  output: TicketWriteOutput,
  permission: 'support.reply',
  scope: onPlatform,
  emits: ['support_ticket.draft_dismissed'],
  async handler(ctx, input) {
    const ticket = await ticketOr404(ctx, input.ticketId);
    await ctx.tx
      .update(ticketDrafts)
      .set({ dismissedAt: new Date() })
      .where(and(eq(ticketDrafts.ticketId, ticket.id), isNull(ticketDrafts.dismissedAt)));
    await ctx.emit({
      type: 'support_ticket.draft_dismissed',
      entityType: 'support_ticket',
      entityId: ticket.id,
      payload: { number: ticket.number },
    });
    return { ticketId: ticket.id };
  },
});

// ---------- saved replies ----------

export const supportCannedReplySave = defineCommand({
  name: 'support.canned_reply.save',
  description: 'Write or change a saved reply everyone answering support can use.',
  risk: 1,
  input: CannedReplySaveInput,
  output: CannedReplySaveOutput,
  permission: 'support.manage',
  scope: onPlatform,
  emits: ['support_canned_reply.saved'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    let id = input.id ?? null;
    if (id) {
      const [updated] = await ctx.tx
        .update(cannedReplies)
        .set({ title: input.title, bodyText: input.bodyText })
        .where(eq(cannedReplies.id, id))
        .returning({ id: cannedReplies.id });
      if (!updated) throw HfosError.notFound('No saved reply with that id.');
    } else {
      const [created] = await ctx.tx
        .insert(cannedReplies)
        .values({ title: input.title, bodyText: input.bodyText, createdBy: me })
        .returning({ id: cannedReplies.id });
      id = created!.id;
    }
    await ctx.emit({
      type: 'support_canned_reply.saved',
      entityType: 'support_canned_reply',
      entityId: id,
      payload: { title: input.title },
    });
    return { id };
  },
});

export const supportCannedReplyDelete = defineCommand({
  name: 'support.canned_reply.delete',
  description: 'Remove a saved reply.',
  risk: 1,
  input: CannedReplyDeleteInput,
  output: CannedReplyDeleteOutput,
  permission: 'support.manage',
  scope: onPlatform,
  emits: ['support_canned_reply.deleted'],
  async handler(ctx, input) {
    const [gone] = await ctx.tx
      .delete(cannedReplies)
      .where(eq(cannedReplies.id, input.id))
      .returning({ id: cannedReplies.id, title: cannedReplies.title });
    if (!gone) throw HfosError.notFound('No saved reply with that id.');
    await ctx.emit({
      type: 'support_canned_reply.deleted',
      entityType: 'support_canned_reply',
      entityId: gone.id,
      payload: { title: gone.title },
    });
    return { id: gone.id };
  },
});

/** Everything the desk does to a ticket, in one list for the registry. */
export const supportTicketCommands = [
  supportRequestCreate,
  supportTicketReply,
  supportTicketSetStatus,
  supportTicketSetPriority,
  supportTicketAssign,
  supportTicketSnooze,
  supportTicketLinkBusiness,
  supportTicketMerge,
  supportDraftRequest,
  supportDraftDismiss,
  supportCannedReplySave,
  supportCannedReplyDelete,
];
