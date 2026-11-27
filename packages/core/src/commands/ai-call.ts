/**
 * AI outbound calls: a customer's written consent to calls. Campaign calls go only to people who agreed in
 * writing, so saying yes needs where it's written ("Signed service agreement"). Saying no stops every AI call to
 * them, whatever it's for; the AI records that itself when someone asks it on a call not to call again.
 */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { rows, sql } from '@hfos/db/client';
import { people } from '@hfos/db/schema';
import { loadTeammate } from '../ai-team/load';
import {
  ERRAND_ASK_MAX,
  ERRAND_GOAL_MAX,
  ERRAND_SAY_MAX,
  errandGoal,
} from '../automations/errand-calls';
import { fullName, requirePerson } from '../crm/records';
import { HfosError } from '../errors';
import { defineCommand } from '../kernel/define';
import { scheduleJob } from '../messaging/store';
import { uuid } from '../schemas/common';
import { PersonSetCallConsentInput, PersonSetCallConsentOutput } from '../schemas/ai-call';

const inWorkspace = (i: { workspaceId: string }) => ({
  kind: 'workspace' as const,
  workspaceId: i.workspaceId,
});

export const personSetCallConsent = defineCommand({
  name: 'person.set_call_consent',
  description:
    'Record that a customer agreed in writing to calls from the business (and where that’s written), or that they don’t want calls. Campaign calls only go to people who agreed; nobody who said no gets an AI call.',
  risk: 1,
  input: PersonSetCallConsentInput,
  output: PersonSetCallConsentOutput,
  permission: 'inbox.use',
  scope: inWorkspace,
  emits: ['person.call_consent_changed'],
  actors: ['human', 'system'],
  async handler(ctx, input) {
    const person = await requirePerson(ctx.tx, ctx.scope.workspaceId!, input.personId);
    const source =
      input.source?.trim() || (ctx.actor.type === 'system' ? 'Asked on a call' : 'Asked the team');
    const at = new Date();
    if (person.callConsent === input.consent && person.callConsentSource === source)
      return {
        personId: person.id,
        consent: input.consent,
        source,
        at: person.callConsentAt?.toISOString() ?? null,
      };
    await ctx.tx
      .update(people)
      .set({ callConsent: input.consent, callConsentAt: at, callConsentSource: source })
      .where(eq(people.id, person.id));
    await ctx.emit({
      type: 'person.call_consent_changed',
      entityType: 'person',
      entityId: person.id,
      payload: { consent: input.consent, source },
      before: { callConsent: person.callConsent },
      after: {
        name: fullName(person.firstName, person.lastName),
        callConsent: input.consent,
        source,
      },
    });
    return { personId: person.id, consent: input.consent, source, at: at.toISOString() };
  },
});

export const AiCallAskErrandInput = z.object({
  workspaceId: uuid,
  personId: uuid,
  /** It finishes "I'm calling …": "to ask if you have 30-year shingles in stock". */
  goal: z.string().trim().min(1).max(ERRAND_GOAL_MAX),
  /** What to find out, in the asker's words. */
  ask: z.string().trim().min(1).max(ERRAND_ASK_MAX),
  /** What it may tell them (an account number, a job's address); nothing more. */
  say: z.string().trim().max(ERRAND_SAY_MAX).optional(),
  /** Who asked: their chat and their phone get the answer. */
  askedBy: uuid,
  askerName: z.string().trim().max(120).optional(),
  /** The Assistant chat it was asked in. */
  threadId: uuid.nullable().optional(),
});
export const AiCallAskErrandOutput = z.object({ aiCallId: uuid, to: z.string() });

/**
 * The AI teammate calls someone in Contacts for a person, with their questions (20261027037000). The worker runs it
 * once the person OKs the Assistant's card, as the system on their behalf (only the worker writes calls). The call
 * waits for the business's open hours, and goes only to someone who agreed in writing to calls or a number the phone
 * company says is a business landline: that's checked just before it rings (ai-calls/index.ts).
 */
export const aiCallAskErrand = defineCommand({
  name: 'ai_call.ask_errand',
  description:
    'Have the AI teammate phone someone in Contacts (a supplier, a store) with a person’s questions, and tell them what was said.',
  risk: 2,
  input: AiCallAskErrandInput,
  output: AiCallAskErrandOutput,
  // Checked by the worker for the person who asked, before it runs this as the system on their behalf.
  permission: 'inbox.use',
  scope: inWorkspace,
  emits: ['ai_call.errand_asked'],
  actors: ['system'],
  async handler(ctx, input) {
    const workspaceId = ctx.scope.workspaceId!;
    const person = await requirePerson(ctx.tx, workspaceId, input.personId);
    const name = fullName(person.firstName, person.lastName) || 'them';
    if (!person.phoneE164)
      throw HfosError.validation(
        [{ path: 'personId', message: 'No phone number.' }],
        `${name} has no phone number in Contacts. Add one on their page, then ask again.`,
      );
    if (person.callConsent === 'opted_out')
      throw HfosError.rule(
        'no_calls',
        409,
        `${name} asked not to be called, so the AI teammate won’t call them. Call them yourself if you need to.`,
      );
    const teammate = await loadTeammate(ctx.tx, workspaceId);
    if (!teammate || teammate.status === 'off')
      throw HfosError.rule(
        'teammate_off',
        409,
        'Your AI teammate is off, so it can’t make calls. Turn it on in AI teammate, then ask again.',
      );
    const [made] = await rows<{ id: string }>(
      ctx.tx,
      sql`insert into app.ai_calls (workspace_id, person_id, purpose, to_e164, goal, status, dedupe_key,
            asked_by, thread_id, errand)
          values (${workspaceId}, ${person.id}, 'errand', ${person.phoneE164}, ${errandGoal(input.goal)},
            'queued', ${`errand:${randomUUID()}`}, ${input.askedBy}, ${input.threadId ?? null},
            ${JSON.stringify({ ask: input.ask, say: input.say ?? '', asker: input.askerName ?? '' })}::jsonb)
          returning id`,
    );
    if (!made) throw HfosError.forbidden();
    await scheduleJob(
      ctx.tx,
      {
        kind: 'ai_calls.place',
        dedupeKey: `ai-call-place:${made.id}`,
        runAt: new Date(),
        payload: { aiCallId: made.id },
        workspaceId,
        organizationId: ctx.scope.organizationId ?? null,
      },
      { pullEarlier: true },
    );
    await ctx.emit({
      type: 'ai_call.errand_asked',
      entityType: 'ai_call',
      entityId: made.id,
      payload: { aiCallId: made.id, personId: person.id, askedBy: input.askedBy },
      after: { name, goal: errandGoal(input.goal).slice(0, 80) },
    });
    return { aiCallId: made.id, to: person.phoneE164 };
  },
});

export const aiCallCommands = [personSetCallConsent, aiCallAskErrand] as const;
