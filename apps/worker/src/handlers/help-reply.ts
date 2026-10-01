/**
 * A customer texted HELP (or INFO): HandsFreeOS answers with the business's name and the number to reach it on.
 *
 * **The carriers check that HELP gets this answer.** A campaign declares what HELP replies with, and the
 * reviewer, or a carrier's audit, texts HELP to see it: the business's name and a way to get help. Twilio's
 * own default answer names neither, so HandsFreeOS sends the one the registration declared (core's
 * `keywordReplies`, the same copy the worker sends to the carriers). Where the business turned on Twilio's
 * Advanced Opt-Out, Twilio has already answered (the text arrives with `OptOutType`), and this stays quiet.
 *
 * It goes whatever the hour, because the customer has just asked, and never to someone who texted STOP (the
 * send refuses): after STOP, only START is answered, and Twilio answers that.
 */
import { formatPhone, HfosError, keywordReplies } from '@hfos/core';
import { executeCommand, messageSend } from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import { clientIdFor } from '../booking/deliver';
import { systemActor, tenantOf, workerMeta } from '../services';
import type { EventHandler } from './types';

type Found = { counterpart: string; e164: string | null; name: string };

/** Why a HELP can't be answered that no retry would change. */
const NOTHING_TO_ANSWER_WITH = new Set([
  'opted_out',
  'no_number',
  'messaging_not_ready',
  'wallet_empty',
]);

export const onHelpKeyword: EventHandler = async (ctx) => {
  const p = (ctx.event.payload ?? {}) as Record<string, unknown>;
  if (p['keyword'] !== 'help' || p['keywordAnswered'] === true) return;
  // RCS has no carrier keywords: a HELP there is just a word, and the team answers it.
  if (p['transport'] === 'rcs') return;
  const conversationId = typeof p['conversationId'] === 'string' ? p['conversationId'] : null;
  if (!conversationId) return;
  const [found] = await rows<Found>(
    ctx.tx,
    sql`select c.counterpart, n.e164, w.name
          from app.conversations c
          join app.workspaces w on w.id = c.workspace_id
          left join app.phone_numbers n on n.id = c.phone_number_id
         where c.id = ${conversationId} and c.workspace_id = ${ctx.scope.workspaceId}
           and c.channel = 'sms'`,
  );
  if (!found?.counterpart) return;
  const reply = keywordReplies(found.name, found.e164 ? formatPhone(found.e164) : '').help;
  const scope = tenantOf(ctx.scope);
  try {
    await executeCommand(
      ctx.db,
      messageSend,
      {
        workspaceId: scope.workspaceId,
        conversationId,
        channel: 'sms',
        body: reply,
        // The event is the customer's text: one answer per HELP, however often this runs.
        clientId: clientIdFor('help-reply', ctx.event.entityId ?? ctx.event.id),
        keepConversationStatus: true,
        keywordReply: true,
      },
      systemActor(scope),
      workerMeta(ctx.event.correlationId, ctx.event.id),
    );
  } catch (e) {
    // Opted out, no number, not approved yet or out of credit: nothing to answer with, and nothing to retry.
    if (e instanceof HfosError && e.rule && NOTHING_TO_ANSWER_WITH.has(e.rule)) return;
    throw e;
  }
};
