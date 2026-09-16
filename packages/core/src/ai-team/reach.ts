/**
 * Server-side: keeps the AI teammate to the customer it's talking to. The worker fills in every person, lead
 * and conversation id from the run (no tool takes one), and these checks make sure nothing else gets through.
 */
import { and, eq } from 'drizzle-orm';
import type { Tx } from '@hfos/db/client';
import { aiTeammateRuns, bookingSites, conversations, leads } from '@hfos/db/schema';
import { calendarCharge } from '../calendar/deposit-load';
import { loadCalendar } from '../calendar/load';
import { HfosError } from '../errors';
import { aiEmployeeOf } from '../kernel/actor';
import type { AiEmployeeActor, CommandContext, QueryContext } from '../kernel/types';
import { loadConversation } from '../messaging/store';
import { money } from '../money/format';
import type { TeammateConfig } from './config';
import { loadTeammate, teammateConfigOf } from './load';

/** The source on customers and leads the AI teammate adds. */
export const AI_TEAMMATE_SOURCE = 'AI teammate';

export const outsideItsConversation = (): HfosError =>
  HfosError.forbidden(
    'The AI teammate works only for the customer it’s talking to.',
    'outside_its_conversation',
  );

export const notHandledByAi = (): HfosError =>
  HfosError.rule(
    'not_handled_by_ai',
    409,
    'A person is handling this conversation, so the AI teammate stays out of it.',
  );

/**
 * A website chat's identity is never verified (anyone can type someone else's number), so in a chat the AI
 * teammate never changes an existing customer or their bookings. New bookings are fine: their confirmation
 * goes to the contact on file.
 */
export const chatIdentityUnverified = (): HfosError =>
  HfosError.forbidden(
    'A website chat can’t change a customer’s details or bookings. Someone on the team can.',
    'chat_identity_unverified',
  );

/** For the AI teammate only (anyone else passes): refuses when the conversation it's answering is a chat. */
export async function refuseInChat(ctx: CommandContext): Promise<void> {
  const ai = aiEmployeeOf(ctx.actor);
  if (!ai?.conversationId) return;
  const [c] = await ctx.tx
    .select({ channel: conversations.channel })
    .from(conversations)
    .where(
      and(eq(conversations.id, ai.conversationId), eq(conversations.workspaceId, ai.workspaceId)),
    );
  if (c?.channel === 'chat') throw chatIdentityUnverified();
}

/** The customer the AI teammate is serving: its conversation's, or for a first message its run's new lead. */
export async function aiCustomerId(ctx: QueryContext, ai: AiEmployeeActor): Promise<string | null> {
  if (ai.conversationId) {
    const [c] = await ctx.tx
      .select({ personId: conversations.personId })
      .from(conversations)
      .where(
        and(eq(conversations.id, ai.conversationId), eq(conversations.workspaceId, ai.workspaceId)),
      );
    return c?.personId ?? null;
  }
  if (!ai.runId) return null;
  const [r] = await ctx.tx
    .select({ personId: aiTeammateRuns.personId })
    .from(aiTeammateRuns)
    .where(and(eq(aiTeammateRuns.id, ai.runId), eq(aiTeammateRuns.teammateId, ai.teammateId)));
  return r?.personId ?? null;
}

/** For the AI teammate only (anyone else passes): what a command touches must be its customer's, never a company. */
export async function assertAiReach(
  ctx: CommandContext,
  ref: {
    readonly personId?: string | null;
    readonly leadId?: string | null;
    readonly companyId?: string | null;
  },
): Promise<void> {
  const ai = aiEmployeeOf(ctx.actor);
  if (!ai) return;
  if (ref.companyId) throw outsideItsConversation();
  // Once a person takes the conversation over, a run already under way changes nothing more.
  if (ai.conversationId) {
    const [c] = await ctx.tx
      .select({ handledBy: conversations.handledBy })
      .from(conversations)
      .where(
        and(eq(conversations.id, ai.conversationId), eq(conversations.workspaceId, ai.workspaceId)),
      );
    if (c?.handledBy === 'person') throw notHandledByAi();
  }
  const customer = await aiCustomerId(ctx, ai);
  if (!customer) throw outsideItsConversation();
  if (ref.personId && ref.personId !== customer) throw outsideItsConversation();
  if (ref.leadId) {
    const [lead] = await ctx.tx
      .select({ personId: leads.personId })
      .from(leads)
      .where(and(eq(leads.id, ref.leadId), eq(leads.workspaceId, ai.workspaceId)));
    if (!lead || lead.personId !== customer) throw outsideItsConversation();
  }
}

/**
 * The AI teammate books, and looks up times, only on the calendars its settings list, read from the database
 * and never from its input. Returns its settings.
 */
export async function assertTeammateCalendar(
  tx: Tx,
  ai: AiEmployeeActor,
  calendarId: string,
): Promise<TeammateConfig> {
  const row = await loadTeammate(tx, ai.workspaceId, { teammateId: ai.teammateId });
  if (!row) throw outsideItsConversation();
  const config = teammateConfigOf(row);
  if (!config.book.enabled || !config.book.calendarIds.includes(calendarId))
    throw HfosError.forbidden(
      'The AI teammate books only on the calendars its settings list.',
      'calendar_not_allowed',
    );
  return config;
}

/**
 * A calendar that asks for money before it will hold a time is **not the AI teammate's to book**. The deposit
 * is taken on the customer's own booking page, where their card is held rather than charged and the time goes
 * back if they never pay — none of which a teammate booking on their behalf can do. So it books nothing, says
 * what the visit takes, and sends them the page.
 *
 * The check is here, beside the one that keeps it to the calendars its settings list, so a model that names a
 * calendar it shouldn't gets the same answer either way.
 */
export async function assertTeammateMayBook(
  tx: Tx,
  ai: AiEmployeeActor,
  calendarId: string,
  serviceId?: string | null,
): Promise<TeammateConfig> {
  const config = await assertTeammateCalendar(tx, ai, calendarId);
  const calendar = await loadCalendar(tx, ai.workspaceId, calendarId);
  const due = await calendarCharge(tx, ai.workspaceId, calendar.config, serviceId);
  if (!due) return config;
  const path = await bookingPathOf(tx, ai.workspaceId, calendar.slug);
  throw new HfosError(
    'rule_violation',
    409,
    `${calendar.name} takes ${money(due.charge.amountCents)}${
      due.charge.mode === 'deposit' ? ' as a deposit' : ''
    } before a time is held, and that is paid on the booking page. Don’t book it yourself: tell them what it takes and send them the page to book on${path ? ` (${path})` : ''}.`,
    { amountCents: due.charge.amountCents, mode: due.charge.mode, bookingPath: path },
    'deposit_required',
  );
}

/** The path a customer books this calendar on, or null when the business's booking page is off. */
export async function bookingPathOf(
  tx: Tx,
  workspaceId: string,
  calendarSlug: string,
): Promise<string | null> {
  const [site] = await tx
    .select({ slug: bookingSites.slug, enabled: bookingSites.enabled })
    .from(bookingSites)
    .where(eq(bookingSites.workspaceId, workspaceId));
  return site?.enabled ? `/book/${site.slug}/${calendarSlug}` : null;
}

/** The conversation the AI teammate is answering, while it's still the one handling it. */
export async function requireAiConversation(ctx: CommandContext, ai: AiEmployeeActor) {
  if (!ai.conversationId) throw outsideItsConversation();
  const conv = await loadConversation(ctx, ai.conversationId);
  if (conv.handledBy !== 'ai' || conv.aiTeammateId !== ai.teammateId) throw notHandledByAi();
  return conv;
}
