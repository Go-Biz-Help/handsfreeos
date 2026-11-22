/**
 * A caller the phone company couldn't vouch for proves they are the customer whose number they're calling from (AI1,
 * the owner's "Text a code first", 22 Nov 2026). Anyone can fake a caller ID, so on a call that isn't proven
 * (messaging/caller.ts) the AI teammate texts a six-digit code to the phone, or else emails it to the address, on file
 * for the customer the call matched — never to anything the caller says — and a caller who reads it back is that
 * customer for the rest of the call (`calls.caller_verified_at`).
 *
 * The same codes as a website chat's (chat-verify.ts, verify/code.ts): only a hash is kept, bound to the call; a code
 * lasts ten minutes, five wrong tries end it, and a customer gets three an hour from calls, however many calls there
 * are, so a stranger ringing again and again can't flood their phone (a wrong try answers `verified: false`, so it's
 * kept).
 */
import { and, desc, eq, gt, isNull, sql as dsql } from 'drizzle-orm';
import { rows, sql } from '@hfos/db/client';
import { callVerificationCodes, calls } from '@hfos/db/schema';
import { callOfRun, requireAiConversation } from '../ai-team/reach';
import { HfosError } from '../errors';
import { aiEmployeeOf } from '../kernel/actor';
import { defineCommand } from '../kernel/define';
import type { AiEmployeeActor, CommandContext } from '../kernel/types';
import { callerProven } from '../messaging/caller';
import {
  CODE_MINUTES,
  CODE_TRIES,
  CODES_PER_HOUR,
  codeHash,
  codeMatches,
  maskContact,
  newCode,
} from '../verify/code';
import {
  ChatCheckCodeForCustomerInput,
  ChatCheckCodeForCustomerOutput,
  ChatSendCodeForCustomerInput,
  ChatSendCodeForCustomerOutput,
} from '../schemas/ai-team';
import { codeDestination } from './chat-verify';

const inWorkspace = (i: { workspaceId: string }) => ({
  kind: 'workspace' as const,
  workspaceId: i.workspaceId,
});

function aiOf(ctx: CommandContext): AiEmployeeActor {
  const ai = aiEmployeeOf(ctx.actor);
  if (!ai) throw HfosError.forbidden('Only the AI teammate sends a caller’s code.');
  return ai;
}

/** The call the teammate is on, in the conversation it's answering, and the customer the caller's number matched. */
async function callOf(ctx: CommandContext, ai: AiEmployeeActor) {
  const conv = await requireAiConversation(ctx, ai);
  const call = await callOfRun(ctx.tx, ai);
  if (!call)
    throw HfosError.rule(
      'not_a_call',
      409,
      'This isn’t a phone call, so there’s no caller to send a code for. Carry on without one.',
    );
  if (callerProven(call))
    throw HfosError.rule(
      'caller_proven',
      409,
      'This caller’s number is already confirmed, so there’s no code to send. Carry on.',
    );
  if (!conv.personId)
    throw HfosError.rule(
      'no_customer',
      409,
      'This caller’s number isn’t on file for any customer, so there’s nobody to send a code to. Help them as a new caller, or hand off.',
    );
  return { call, personId: conv.personId };
}

export const callSendCodeForCustomer = defineCommand({
  name: 'call.send_code_for_customer',
  description:
    'The AI teammate sends a six-digit code to the phone (or else the email) on file for the customer a call matched, when the phone company couldn’t confirm the caller’s number, so the caller can prove they are them.',
  risk: 1,
  input: ChatSendCodeForCustomerInput,
  output: ChatSendCodeForCustomerOutput,
  permission: null,
  scope: inWorkspace,
  emits: ['call.verification_sent'],
  actors: ['ai_employee'],
  async handler(ctx, input) {
    const ai = aiOf(ctx);
    const ws = ctx.scope.workspaceId!;
    const { call, personId } = await callOf(ctx, ai);
    const [recent] = await rows<{ n: number }>(
      ctx.tx,
      sql`select count(*)::int as n from app.call_verification_codes
          where person_id = ${personId} and created_at > now() - interval '1 hour'`,
    );
    if ((recent?.n ?? 0) >= CODES_PER_HOUR)
      throw HfosError.rule(
        'too_many_codes',
        429,
        'That’s three codes to this customer this hour. Ask them to try again later, or hand off.',
      );
    const { channel, to } = await codeDestination(ctx, personId, input.canText);
    const code = newCode();
    const [row] = await ctx.tx
      .insert(callVerificationCodes)
      .values({
        workspaceId: ws,
        callId: call.id,
        personId,
        codeHash: codeHash(call.id, code),
        channel,
        expiresAt: new Date(Date.now() + CODE_MINUTES * 60_000),
      })
      .returning({ id: callVerificationCodes.id });
    if (!row) throw HfosError.forbidden();
    const sentTo = maskContact(channel, to);
    await ctx.emit({
      type: 'call.verification_sent',
      entityType: 'call',
      entityId: call.id,
      payload: { codeId: row.id, personId, channel, _broadcast: false },
      after: { channel, sentTo },
      broadcast: false,
    });
    return { codeId: row.id, channel, sentTo, code, to };
  },
});

export const callCheckCodeForCustomer = defineCommand({
  name: 'call.check_code_for_customer',
  description:
    'The AI teammate checks the code a caller read back. The right one, in time, makes them the customer the call matched for the rest of the call.',
  risk: 1,
  input: ChatCheckCodeForCustomerInput,
  output: ChatCheckCodeForCustomerOutput,
  permission: null,
  scope: inWorkspace,
  emits: ['call.caller_verified'],
  actors: ['ai_employee'],
  async handler(ctx, input) {
    const ai = aiOf(ctx);
    const { call, personId } = await callOf(ctx, ai);
    const [latest] = await ctx.tx
      .select()
      .from(callVerificationCodes)
      .where(
        and(
          eq(callVerificationCodes.callId, call.id),
          eq(callVerificationCodes.personId, personId),
          isNull(callVerificationCodes.usedAt),
          gt(callVerificationCodes.expiresAt, new Date()),
        ),
      )
      .orderBy(desc(callVerificationCodes.createdAt))
      .limit(1)
      .for('update');
    if (!latest)
      throw HfosError.rule(
        'code_expired',
        409,
        'There’s no code waiting for them: it expired or was used. Send a new one.',
      );
    if (latest.attempts >= CODE_TRIES)
      throw HfosError.rule('too_many_tries', 429, 'Too many wrong tries. Send a new code.');
    if (!codeMatches(latest.codeHash, call.id, input.code)) {
      // Kept, not thrown: a thrown error would roll the counted try back.
      await ctx.tx
        .update(callVerificationCodes)
        .set({ attempts: dsql`${callVerificationCodes.attempts} + 1` })
        .where(eq(callVerificationCodes.id, latest.id));
      return { verified: false, triesLeft: Math.max(0, CODE_TRIES - latest.attempts - 1) };
    }
    await ctx.tx
      .update(callVerificationCodes)
      .set({ usedAt: new Date() })
      .where(eq(callVerificationCodes.id, latest.id));
    await ctx.tx.update(calls).set({ callerVerifiedAt: new Date() }).where(eq(calls.id, call.id));
    await ctx.emit({
      type: 'call.caller_verified',
      entityType: 'call',
      entityId: call.id,
      payload: { personId, _broadcast: false },
      after: { verified: true },
      broadcast: false,
    });
    return { verified: true, triesLeft: 0 };
  },
});
