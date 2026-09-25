/**
 * AI outbound calls: a customer's written consent to calls. Campaign calls go only to people who agreed in
 * writing, so saying yes needs where it's written ("Signed service agreement"). Saying no stops every AI call to
 * them, whatever it's for; the AI records that itself when someone asks it on a call not to call again.
 */
import { eq } from 'drizzle-orm';
import { people } from '@hfos/db/schema';
import { fullName, requirePerson } from '../crm/records';
import { defineCommand } from '../kernel/define';
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

export const aiCallCommands = [personSetCallConsent] as const;
