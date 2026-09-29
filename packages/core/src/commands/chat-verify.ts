/**
 * A website chat visitor proves they are the customer the chat matched (M18). Anyone can type someone else's
 * number into a chat, so the AI teammate sends a six-digit code to the phone, or else the email, on file for
 * that customer — never to anything the visitor typed — and a visitor who types it back counts as that customer
 * for twelve hours (`chatVerified`). Only a hash of the code is kept; a code lasts ten minutes, a visitor gets
 * three an hour, and five wrong tries end it (a wrong try answers `verified: false`, so it's kept).
 */
import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import { and, desc, eq, gt, isNull, sql as dsql } from 'drizzle-orm';
import { rows, sql } from '@hfos/db/client';
import { chatVerificationCodes, chatVisitors } from '@hfos/db/schema';
import { requireAiConversation } from '../ai-team/reach';
import { requirePerson } from '../crm/records';
import { HfosError } from '../errors';
import { aiEmployeeOf } from '../kernel/actor';
import { defineCommand } from '../kernel/define';
import type { AiEmployeeActor, CommandContext } from '../kernel/types';
import { isOptedOut } from '../messaging/store';
import {
  ChatCheckCodeForCustomerInput,
  ChatCheckCodeForCustomerOutput,
  ChatSendCodeForCustomerInput,
  ChatSendCodeForCustomerOutput,
} from '../schemas/ai-team';

export const CODE_MINUTES = 10;
export const CODES_PER_HOUR = 3;
export const CODE_TRIES = 5;

const inWorkspace = (i: { workspaceId: string }) => ({
  kind: 'workspace' as const,
  workspaceId: i.workspaceId,
});

const hashOf = (visitorId: string, code: string) =>
  createHash('sha256').update(`${visitorId}:${code}`).digest();

/** "•••• 42" for a phone, "d•••@example.com" for an address. */
export function maskContact(channel: 'sms' | 'email', to: string): string {
  if (channel === 'sms') return `•••• ${to.slice(-2)}`;
  const [name, domain] = to.split('@');
  return `${(name ?? '').slice(0, 1)}•••@${domain ?? ''}`;
}

/** The chat the teammate is answering, its visitor, and the customer it matched. */
async function chatOf(ctx: CommandContext, ai: AiEmployeeActor) {
  const conv = await requireAiConversation(ctx, ai);
  if (conv.channel !== 'chat')
    throw HfosError.rule(
      'not_a_chat',
      409,
      'This conversation isn’t a website chat, so there’s no code to send. Carry on without one.',
    );
  if (!conv.personId)
    throw HfosError.rule(
      'no_customer',
      409,
      'This chat isn’t linked to a customer yet, so there’s nobody to send a code to. Hand off if they need to prove who they are.',
    );
  const [visitor] = await ctx.tx
    .select({ id: chatVisitors.id })
    .from(chatVisitors)
    .where(
      and(
        eq(chatVisitors.conversationId, conv.id),
        eq(chatVisitors.workspaceId, ctx.scope.workspaceId!),
      ),
    );
  if (!visitor)
    throw HfosError.notFound(
      'This chat has no website visitor to send a code to. Hand off if they need to prove who they are.',
    );
  return { conv, personId: conv.personId, visitorId: visitor.id };
}

function aiOf(ctx: CommandContext): AiEmployeeActor {
  const ai = aiEmployeeOf(ctx.actor);
  if (!ai) throw HfosError.forbidden('Only the AI teammate sends chat codes.');
  return ai;
}

export const chatSendCodeForCustomer = defineCommand({
  name: 'chat.send_code_for_customer',
  description:
    'The AI teammate sends a six-digit code to the phone (or else the email) on file for the customer a website chat matched, so the visitor can prove they are them.',
  risk: 1,
  input: ChatSendCodeForCustomerInput,
  output: ChatSendCodeForCustomerOutput,
  permission: null,
  scope: inWorkspace,
  emits: ['chat.verification_sent'],
  actors: ['ai_employee'],
  async handler(ctx, input) {
    const ai = aiOf(ctx);
    const ws = ctx.scope.workspaceId!;
    const { personId, visitorId } = await chatOf(ctx, ai);
    const [recent] = await rows<{ n: number }>(
      ctx.tx,
      sql`select count(*)::int as n from app.chat_verification_codes
          where visitor_id = ${visitorId} and created_at > now() - interval '1 hour'`,
    );
    if ((recent?.n ?? 0) >= CODES_PER_HOUR)
      throw HfosError.rule(
        'too_many_codes',
        429,
        'That’s three codes this hour. Ask them to try again later, or hand off.',
      );
    const person = await requirePerson(ctx.tx, ws, personId);
    // The number on file first, unless it said STOP; then the address on file. Never what the visitor typed.
    const phone =
      input.canText &&
      person.phoneE164 &&
      person.smsConsent !== 'opted_out' &&
      !(await isOptedOut(ctx.tx, ws, person.phoneE164))
        ? person.phoneE164
        : null;
    const channel = phone ? ('sms' as const) : person.email ? ('email' as const) : null;
    const to = phone ?? person.email;
    if (!channel || !to)
      throw HfosError.rule(
        'no_contact',
        409,
        'There’s no phone or email on file to send a code to. Hand off, or ask them to use the link in a message we sent.',
      );
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const [row] = await ctx.tx
      .insert(chatVerificationCodes)
      .values({
        workspaceId: ws,
        visitorId,
        personId,
        codeHash: hashOf(visitorId, code),
        channel,
        expiresAt: new Date(Date.now() + CODE_MINUTES * 60_000),
      })
      .returning({ id: chatVerificationCodes.id });
    if (!row) throw HfosError.forbidden();
    const sentTo = maskContact(channel, to);
    await ctx.emit({
      type: 'chat.verification_sent',
      entityType: 'conversation',
      entityId: ai.conversationId!,
      payload: { codeId: row.id, visitorId, personId, channel, _broadcast: false },
      after: { channel, sentTo },
      broadcast: false,
    });
    return { codeId: row.id, channel, sentTo, code, to };
  },
});

export const chatCheckCodeForCustomer = defineCommand({
  name: 'chat.check_code_for_customer',
  description:
    'The AI teammate checks the code a website chat visitor typed. The right one, in time, makes them the customer the chat matched for twelve hours.',
  risk: 1,
  input: ChatCheckCodeForCustomerInput,
  output: ChatCheckCodeForCustomerOutput,
  permission: null,
  scope: inWorkspace,
  emits: ['chat.visitor_verified'],
  actors: ['ai_employee'],
  async handler(ctx, input) {
    const ai = aiOf(ctx);
    const { personId, visitorId } = await chatOf(ctx, ai);
    const [latest] = await ctx.tx
      .select()
      .from(chatVerificationCodes)
      .where(
        and(
          eq(chatVerificationCodes.visitorId, visitorId),
          eq(chatVerificationCodes.personId, personId),
          isNull(chatVerificationCodes.usedAt),
          gt(chatVerificationCodes.expiresAt, new Date()),
        ),
      )
      .orderBy(desc(chatVerificationCodes.createdAt))
      .limit(1)
      .for('update');
    const expired = () =>
      HfosError.rule(
        'code_expired',
        409,
        'There’s no code waiting for them: it expired or was used. Send a new one.',
      );
    if (!latest) throw expired();
    if (latest.attempts >= CODE_TRIES)
      throw HfosError.rule('too_many_tries', 429, 'Too many wrong tries. Send a new code.');
    const right = timingSafeEqual(Buffer.from(latest.codeHash), hashOf(visitorId, input.code));
    if (!right) {
      // Kept, not thrown: a thrown error would roll the counted try back.
      await ctx.tx
        .update(chatVerificationCodes)
        .set({ attempts: dsql`${chatVerificationCodes.attempts} + 1` })
        .where(eq(chatVerificationCodes.id, latest.id));
      return { verified: false, triesLeft: Math.max(0, CODE_TRIES - latest.attempts - 1) };
    }
    await ctx.tx
      .update(chatVerificationCodes)
      .set({ usedAt: new Date() })
      .where(eq(chatVerificationCodes.id, latest.id));
    await ctx.tx
      .update(chatVisitors)
      .set({ verifiedPersonId: personId, verifiedAt: new Date() })
      .where(eq(chatVisitors.id, visitorId));
    await ctx.emit({
      type: 'chat.visitor_verified',
      entityType: 'conversation',
      entityId: ai.conversationId!,
      payload: { visitorId, personId, _broadcast: false },
      after: { verified: true },
      broadcast: false,
    });
    return { verified: true, triesLeft: 0 };
  },
});
