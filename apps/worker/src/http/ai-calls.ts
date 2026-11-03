/**
 * A call the AI teammate placed was answered (AI outbound calls). The carrier has already told a person from a
 * voicemail box (`AnsweredBy`), because the call was placed with machine detection:
 * - a person (or it couldn't tell): the call streams to the voice agent, with a ticket naming the call it placed,
 *   and it says who it is, that it's an AI, that the call is recorded and why it's calling;
 * - a voicemail box or a fax: what the business chose on Settings → Automations — hang up and text instead,
 *   leave a short message after the beep, or just hang up. A call to a lead with tries left only hangs up, and
 *   rings again tomorrow (ai-calls/index.ts).
 *
 * Only a call this business placed, still ringing, to the number it placed it to, in the last ten minutes: anything
 * else is hung up.
 */
import { automationSettingsOf, loadTeammate } from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { textAfterLastTry, tryAgainTomorrow } from '../ai-calls/index';
import { runtimeConfigOf } from '../ai-team/config';
import {
  agentTwiml,
  HANGUP,
  HANGUP_TWIML,
  say,
  spokenPhone,
  twiml,
  voiceUrls,
} from '../telephony/voice';
import { sealTicket } from '../voice-agent/ticket';
import { verifiedTwilio, type HttpDeps } from './common';

const xml = (reply: FastifyReply, body: string) => reply.type('text/xml').send(body);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** How long after it was placed a call's answer is still believed. */
const PLACED_CALL_MS = 10 * 60_000;

/** What the carrier says answered: a person, or a machine of some kind. */
export const answeredByMachine = (answeredBy: string | undefined): boolean =>
  !!answeredBy && (answeredBy.startsWith('machine') || answeredBy === 'fax');

/** The short message it leaves on a voicemail box, when the business chose that. */
export function voicemailMessage(o: {
  readonly firstName: string | null;
  readonly name: string;
  readonly business: string;
  readonly goal: string;
  readonly number: string;
}): string {
  const hi = o.firstName ? `Hi ${o.firstName}` : 'Hi';
  const why = o.goal.trim().replace(/[.!?]+$/, '');
  return `${hi}, this is ${o.name}, an AI assistant for ${o.business}, calling ${why}. Please call or text us back at ${spokenPhone(o.number)}. Thanks!`;
}

export function registerAiCallRoutes(app: FastifyInstance, deps: HttpDeps): void {
  const urls = voiceUrls(deps.publicUrl);

  app.post('/webhooks/twilio/voice/ai-call', async (req: FastifyRequest, reply) => {
    const v = await verifiedTwilio(deps, req, reply);
    if (!v) return reply;
    const { workspaceId, organizationId } = v.account;
    const aiCallId = (req.query as Record<string, string | undefined>)['aiCall'];
    if (!workspaceId || !organizationId || !aiCallId || !UUID.test(aiCallId))
      return xml(reply, HANGUP_TWIML);
    const scope = { workspaceId, organizationId };
    const callSid = v.params['CallSid'];
    const found = await asWorker(deps.httpDb, scope, async (tx) => {
      const [c] = await rows<{
        id: string;
        status: string;
        to_e164: string;
        goal: string;
        placed_at: Date | null;
        first_name: string | null;
        business: string;
        settings: Record<string, unknown> | null;
      }>(
        tx,
        sql`select c.id, c.status, c.to_e164, c.goal, c.placed_at, p.first_name, w.name as business, w.settings
            from app.ai_calls c join app.people p on p.id = c.person_id join app.workspaces w on w.id = c.workspace_id
            where c.id = ${aiCallId} and c.workspace_id = ${workspaceId}`,
      );
      if (
        !c ||
        c.status !== 'calling' ||
        c.to_e164 !== v.params['To'] ||
        !c.placed_at ||
        Date.now() - new Date(c.placed_at).getTime() > PLACED_CALL_MS
      )
        return null;
      const teammate = await loadTeammate(tx, workspaceId);
      return {
        call: c,
        name: teammate ? runtimeConfigOf(teammate.config).identity.name : 'the assistant',
        voicemail: automationSettingsOf(c.settings).calls.voicemail,
      };
    });
    if (!found || !callSid) {
      deps.log.warn({ aiCallId, workspaceId }, 'refused an answer for a call the AI did not place');
      return xml(reply, HANGUP_TWIML);
    }
    const { call: c } = found;
    if (answeredByMachine(v.params['AnsweredBy'])) {
      // A call to a lead with tries left just hangs up and rings again tomorrow: the voicemail choice is the last
      // try's, so nobody gets three messages.
      const later = await asWorker(deps.httpDb, scope, (tx) =>
        tryAgainTomorrow(tx, scope, c.id, 'voicemail'),
      );
      if (later) return xml(reply, HANGUP_TWIML);
      const choice = found.voicemail;
      await asWorker(deps.httpDb, scope, async (tx) => {
        await tx.execute(
          sql`update app.ai_calls set status = 'done', outcome = 'voicemail', finished_at = now(),
                summary = ${
                  choice === 'message'
                    ? 'A voicemail box answered; it left a short message.'
                    : choice === 'text'
                      ? 'A voicemail box answered; it hung up and texted instead.'
                      : 'A voicemail box answered; it hung up.'
                }
              where id = ${c.id} and status = 'calling'`,
        );
        if (choice === 'text') await textAfterLastTry(tx, scope, c.id);
      });
      if (choice !== 'message') return xml(reply, HANGUP_TWIML);
      return xml(
        reply,
        twiml(
          `${say(
            voicemailMessage({
              firstName: c.first_name?.trim() || null,
              name: found.name,
              business: c.business,
              goal: c.goal,
              number: v.params['From'] ?? '',
            }),
          )}${HANGUP}`,
        ),
      );
    }
    const ticket = sealTicket(deps.sealer, {
      workspaceId,
      organizationId,
      callSid,
      line: v.params['From'] ?? '',
      from: c.to_e164,
      aiCallId: c.id,
    });
    // The stream ending without new instructions (it couldn't start) just hangs up: nobody called us.
    return xml(reply, agentTwiml(ticket, HANGUP, urls));
  });
}
