/**
 * Server-side: keeps the AI teammate to the customer it's talking to. The worker fills in every person, lead
 * and conversation id from the run (no tool takes one), and these checks make sure nothing else gets through.
 */
import { and, eq, gt, gte, isNull, ne, or, sql } from 'drizzle-orm';
import { rows, type Tx } from '@hfos/db/client';
import {
  aiTeammateRuns,
  bookingSites,
  calls,
  chatVisitors,
  conversations,
  leads,
  people,
} from '@hfos/db/schema';
import { calendarCharge } from '../calendar/deposit-load';
import { CHAT_PERSON_SOURCE } from '../chat/limits';
import { loadCalendar, uuidArray } from '../calendar/load';
import { HfosError } from '../errors';
import { aiEmployeeOf } from '../kernel/actor';
import type { AiEmployeeActor, CommandContext, QueryContext } from '../kernel/types';
import { callerProven, type CallerFacts } from '../messaging/caller';
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
 * Anyone can type someone else's number into a website chat, so until its visitor proves who they are with a
 * code (M18) the AI teammate never changes an existing customer or their bookings there. New bookings are
 * fine: their confirmation goes to the contact on file.
 */
export const chatIdentityUnverified = (): HfosError =>
  HfosError.forbidden(
    'A website chat can’t change a customer’s details or bookings until the visitor proves who they are with a code. Someone on the team can.',
    'chat_identity_unverified',
  );

/**
 * An email whose sender's domain didn't vouch for it (FDE1: `messages.sender_verified` false). Anyone can write a
 * customer's address in From, so while it answers one the AI teammate changes nothing of theirs, as in a website chat
 * whose visitor hasn't proved who they are. New bookings are fine: their confirmation goes to the contact on file.
 */
export const emailSenderUnverified = (): HfosError =>
  HfosError.forbidden(
    'This email’s sender couldn’t be verified, so the AI teammate can’t change the customer’s details, bookings or deals because of it. Someone on the team can.',
    'email_sender_unverified',
  );

/** The messages the AI teammate's run answers (its batch); none for a run that answers nothing. */
async function answeredBy(tx: Tx, ai: AiEmployeeActor): Promise<string[]> {
  if (!ai.runId) return [];
  const [r] = await tx
    .select({ ids: aiTeammateRuns.messageIds })
    .from(aiTeammateRuns)
    .where(and(eq(aiTeammateRuns.id, ai.runId), eq(aiTeammateRuns.teammateId, ai.teammateId)));
  return r?.ids ?? [];
}

/** When the first of these messages that is an email its sender's domain didn't vouch for was filed; null for none. */
async function firstUnverifiedEmail(tx: Tx, messageIds: readonly string[]): Promise<Date | null> {
  if (!messageIds.length) return null;
  const [r] = await rows<{ first: Date | string | null }>(
    tx,
    sql`select min(created_at) as first from app.messages
        where id = any(${uuidArray(messageIds)}) and channel = 'email' and sender_verified is false`,
  );
  return r?.first ? new Date(r.first) : null;
}

/** Whether any of these messages (a run's batch) is an email whose sender's domain didn't vouch for it. */
export async function answersUnverifiedEmail(
  tx: Tx,
  messageIds: readonly string[],
): Promise<boolean> {
  return (await firstUnverifiedEmail(tx, messageIds)) !== null;
}

/**
 * Whether lead intake made this customer out of the unverified email being answered: they were added as it was
 * filed, so nothing of theirs was anybody else's before it, like a customer a website chat added itself. A customer
 * who was here before is someone else's until they write from a sender that's verified.
 */
export async function unverifiedEmailAddedCustomer(
  tx: Tx,
  messageIds: readonly string[],
  personId: string,
): Promise<boolean> {
  const first = await firstUnverifiedEmail(tx, messageIds);
  if (!first) return false;
  const [p] = await tx
    .select({ id: people.id })
    .from(people)
    .where(and(eq(people.id, personId), gte(people.createdAt, first)));
  return !!p;
}

/**
 * A call whose caller isn't proven to be the one whose number it is (AI1: messaging/caller.ts). Anyone can fake a
 * caller ID, so until the caller reads back a code sent to the contact on file the AI teammate changes nothing of
 * the customer's, as in a website chat whose visitor hasn't proved who they are. New bookings are fine: their
 * confirmation goes to the contact on file.
 */
export const callerUnverified = (): HfosError =>
  HfosError.forbidden(
    'The phone company couldn’t confirm this caller’s number, so the AI teammate can’t change the customer’s details, bookings or deals on this call until they read back a code texted to the number on file. Someone on the team can.',
    'caller_unverified',
  );

/** A live call an AI teammate's run is on, as `callerProven` and `unprovenCallAddedCustomer` read it. */
export type RunCall = CallerFacts & { readonly id: string; readonly startedAt: Date };

/** The call the AI teammate's run answers or placed; null for a run on a written conversation. */
export async function callOfRun(tx: Tx, ai: AiEmployeeActor): Promise<RunCall | null> {
  if (!ai.runId) return null;
  const [c] = await tx
    .select({
      id: calls.id,
      direction: calls.direction,
      callerAttestation: calls.callerAttestation,
      callerVerifiedAt: calls.callerVerifiedAt,
      startedAt: calls.startedAt,
    })
    .from(aiTeammateRuns)
    .innerJoin(calls, eq(calls.id, aiTeammateRuns.callId))
    .where(
      and(
        eq(aiTeammateRuns.id, ai.runId),
        eq(aiTeammateRuns.teammateId, ai.teammateId),
        eq(calls.workspaceId, ai.workspaceId),
      ),
    );
  return c ?? null;
}

/** The run's call when its caller isn't proven; null when it's proven, or the run isn't on a call. */
async function unprovenCallOf(tx: Tx, ai: AiEmployeeActor): Promise<RunCall | null> {
  const c = await callOfRun(tx, ai);
  return c && !callerProven(c) ? c : null;
}

/**
 * Whether this customer was added once the unproven call began (lead intake, or the teammate booking a new caller):
 * nothing of theirs was anybody else's before it, like a customer a website chat added itself. Someone who was here
 * before the call is someone else's until the caller proves who they are.
 */
export async function unprovenCallAddedCustomer(
  tx: Tx,
  call: Pick<RunCall, 'startedAt'>,
  personId: string,
): Promise<boolean> {
  const [p] = await tx
    .select({ id: people.id })
    .from(people)
    .where(and(eq(people.id, personId), gte(people.createdAt, call.startedAt)));
  return !!p;
}

/**
 * For the AI teammate: refuses when the customer it answers hasn't proved who they are, whether by an email whose
 * sender's domain didn't vouch for it, on a call whose number nobody vouched for (AI1), or in a website chat without
 * a code (M18).
 */
export async function refuseUnverifiedSender(
  tx: Tx,
  ai: AiEmployeeActor,
  conv: { readonly id: string; readonly channel: string; readonly personId: string | null },
): Promise<void> {
  if (await answersUnverifiedEmail(tx, await answeredBy(tx, ai))) throw emailSenderUnverified();
  if (await unprovenCallOf(tx, ai)) throw callerUnverified();
  if (!(await chatVerified(tx, conv))) throw chatIdentityUnverified();
}

/** How long a chat visitor who typed back their code counts as the customer (M18). */
export const CHAT_VERIFIED_HOURS = 12;

/**
 * M18: a chat whose visitor typed back the code sent to the linked customer's phone or email, in the last
 * twelve hours, is that customer's like a text is. Anything else about a chat stays unverified.
 */
export async function chatVerified(
  tx: Tx,
  conv: { readonly id: string; readonly channel: string; readonly personId: string | null },
): Promise<boolean> {
  if (conv.channel !== 'chat') return true;
  if (!conv.personId) return false;
  const [v] = await tx
    .select({ id: chatVisitors.id })
    .from(chatVisitors)
    .where(
      and(
        eq(chatVisitors.conversationId, conv.id),
        eq(chatVisitors.verifiedPersonId, conv.personId),
        gt(chatVisitors.verifiedAt, new Date(Date.now() - CHAT_VERIFIED_HOURS * 3_600_000)),
      ),
    )
    .limit(1);
  return !!v;
}

/**
 * For the AI teammate only (anyone else passes): refuses when the conversation it's answering is a chat whose
 * visitor hasn't proved they're the customer (M18: a verified chat passes), it's answering an email whose sender's
 * domain didn't vouch for it, or it's on a call whose caller isn't proven (AI1).
 */
export async function refuseInChat(ctx: CommandContext): Promise<void> {
  const ai = aiEmployeeOf(ctx.actor);
  if (!ai?.conversationId) return;
  if (await answersUnverifiedEmail(ctx.tx, await answeredBy(ctx.tx, ai)))
    throw emailSenderUnverified();
  if (await unprovenCallOf(ctx.tx, ai)) throw callerUnverified();
  const [c] = await ctx.tx
    .select({
      id: conversations.id,
      channel: conversations.channel,
      personId: conversations.personId,
    })
    .from(conversations)
    .where(
      and(eq(conversations.id, ai.conversationId), eq(conversations.workspaceId, ai.workspaceId)),
    );
  if (c && !(await chatVerified(ctx.tx, c))) throw chatIdentityUnverified();
}

/**
 * For the AI teammate only (anyone else passes): in a chat whose visitor hasn't proved they're the customer, it
 * may qualify and move a lead only when the chat itself added that customer, never a lead of someone already on
 * file. Anyone can type a customer's number, and rewriting that lead's answers or stage is changing the customer.
 */
export async function refuseCustomersLeadInChat(
  ctx: CommandContext,
  lead: { readonly personId: string | null },
): Promise<void> {
  const ai = aiEmployeeOf(ctx.actor);
  if (!ai?.conversationId) return;
  // The same for an email whose sender's domain didn't vouch for it: only a customer that email itself added.
  const answered = await answeredBy(ctx.tx, ai);
  if (await answersUnverifiedEmail(ctx.tx, answered)) {
    if (!lead.personId || !(await unverifiedEmailAddedCustomer(ctx.tx, answered, lead.personId)))
      throw emailSenderUnverified();
    return;
  }
  // And on a call whose caller isn't proven (AI1): only a customer added since the call began.
  const call = await unprovenCallOf(ctx.tx, ai);
  if (call) {
    if (!lead.personId || !(await unprovenCallAddedCustomer(ctx.tx, call, lead.personId)))
      throw callerUnverified();
    return;
  }
  const [c] = await ctx.tx
    .select({
      id: conversations.id,
      channel: conversations.channel,
      personId: conversations.personId,
      createdAt: conversations.createdAt,
    })
    .from(conversations)
    .where(
      and(eq(conversations.id, ai.conversationId), eq(conversations.workspaceId, ai.workspaceId)),
    );
  if (!c || (await chatVerified(ctx.tx, c))) return;
  if (!lead.personId || !(await chatAddedCustomer(ctx.tx, c, lead.personId)))
    throw chatIdentityUnverified();
}

/**
 * Whether this website chat added the customer itself: a customer the website chat created once this chat began
 * (its visitor's first visit, else the conversation), and whom no other chat visitor has claimed. Only then are
 * their records the visitor's own; a customer who was here before, or whose number a second visitor typed, is
 * someone else's until the visitor proves who they are. Waiting in an open chat doesn't change that: a lead
 * opened later on a customer from before is still theirs.
 */
export async function chatAddedCustomer(
  tx: Tx,
  conv: { readonly id: string; readonly createdAt: Date },
  personId: string,
): Promise<boolean> {
  const [v] = await tx
    .select({ createdAt: chatVisitors.createdAt })
    .from(chatVisitors)
    .where(eq(chatVisitors.conversationId, conv.id))
    .limit(1);
  const openedAt = v && v.createdAt < conv.createdAt ? v.createdAt : conv.createdAt;
  const [p] = await tx
    .select({ id: people.id })
    .from(people)
    .where(
      and(
        eq(people.id, personId),
        eq(people.source, CHAT_PERSON_SOURCE),
        gte(people.createdAt, openedAt),
      ),
    );
  if (!p) return false;
  const [other] = await tx
    .select({ id: chatVisitors.id })
    .from(chatVisitors)
    .where(
      and(
        eq(chatVisitors.personId, personId),
        or(isNull(chatVisitors.conversationId), ne(chatVisitors.conversationId, conv.id)),
      ),
    )
    .limit(1);
  return !other;
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
    readonly customRecordId?: string | null;
  },
): Promise<void> {
  const ai = aiEmployeeOf(ctx.actor);
  if (!ai) return;
  // A company, or a customer's pet, car or property, is beyond the one conversation it's answering.
  if (ref.companyId || ref.customRecordId) throw outsideItsConversation();
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
  if (!config.book.enabled)
    throw HfosError.forbidden(
      'Booking is turned off for the AI teammate, so it can’t book this. Hand it to someone on the team, or turn on Book on the AI teammate page.',
      'calendar_not_allowed',
    );
  if (!config.book.calendarIds.includes(calendarId))
    throw HfosError.forbidden(
      'The AI teammate may book only on the calendars ticked under Book on the AI teammate page, and this isn’t one of them. Use one of those calendars, or hand this to someone on the team.',
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

/** M18: the teammate's settings let it open and close deals and set what they're worth. */
export async function teammateDealsOn(tx: Tx, ai: AiEmployeeActor): Promise<boolean> {
  const row = await loadTeammate(tx, ai.workspaceId, { teammateId: ai.teammateId });
  return !!row && teammateConfigOf(row).deals.enabled;
}
