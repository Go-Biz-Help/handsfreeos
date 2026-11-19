/**
 * In your hands (messaging/hands.ts): Take over on a customer's page, and Give back to the AI there, on the list and
 * in the Inbox. Anyone who answers the Inbox may do either, as they may take a conversation over or hand it back
 * today (the owner's pick, 19 Nov 2026).
 */
import { and, eq, inArray } from 'drizzle-orm';
import { peopleInHands, people } from '@hfos/db/schema';
import { requirePerson } from '../crm/records';
import { HfosError } from '../errors';
import { requireHuman } from '../kernel/actor';
import { defineCommand } from '../kernel/define';
import { giveBackToAi, takeIntoHands } from '../messaging/hands';
import {
  PersonHandBackInput,
  PersonHandBackOutput,
  PersonTakeOverInput,
  PersonTakeOverOutput,
} from '../schemas/hands';

const inWorkspace = (i: { workspaceId: string }) => ({
  kind: 'workspace' as const,
  workspaceId: i.workspaceId,
});

export const personTakeOver = defineCommand({
  name: 'person.take_over',
  description:
    'Take a customer on yourself: the AI teammate, its follow-ups, funnels and AI calls leave them alone everywhere until someone gives them back, and its replies to them waiting for an OK are dropped.',
  risk: 1,
  input: PersonTakeOverInput,
  output: PersonTakeOverOutput,
  permission: 'inbox.use',
  scope: inWorkspace,
  emits: ['person.taken_over', 'conversation.taken_over'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const person = await requirePerson(ctx.tx, input.workspaceId, input.personId);
    if (person.mergedIntoId)
      throw HfosError.rule(
        'person_merged',
        409,
        'This contact was merged into another one. Take over the one you kept.',
      );
    const { fresh, draftsCancelled } = await takeIntoHands(ctx, {
      personId: person.id,
      userId: me,
      how: 'took_over',
      place: null,
    });
    return { personId: person.id, already: !fresh, draftsCancelled };
  },
});

export const personHandBack = defineCommand({
  name: 'person.hand_back',
  description:
    'Give customers back to the AI: out of anyone’s hands, and their conversations go back to the AI teammate where it answers that channel, so it answers what they’re waiting on. One the AI teammate handed to a person still waits for them. Pass personIds, or all (with mine for only your own).',
  risk: 1,
  input: PersonHandBackInput,
  output: PersonHandBackOutput,
  permission: 'inbox.use',
  scope: inWorkspace,
  emits: ['person.handed_back', 'conversation.handed_to_ai'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    if (!input.all && !input.personIds.length)
      throw HfosError.validation(
        [{ path: 'personIds', message: 'Pick who to give back, or give them all back.' }],
        'Pick who to give back to the AI, or press Give all back.',
      );
    const ids = input.all
      ? (
          await ctx.tx
            .select({ id: peopleInHands.personId })
            .from(peopleInHands)
            .where(
              and(
                eq(peopleInHands.workspaceId, input.workspaceId),
                ...(input.mine ? [eq(peopleInHands.userId, me)] : []),
              ),
            )
        ).map((r) => r.id)
      : [
          ...new Set(
            (
              await ctx.tx
                .select({ id: people.id })
                .from(people)
                .where(
                  and(
                    eq(people.workspaceId, input.workspaceId),
                    inArray(people.id, input.personIds),
                  ),
                )
            ).map((r) => r.id),
          ),
        ];
    let handedBack = 0;
    let toAi = 0;
    for (const id of ids) {
      const got = await giveBackToAi(ctx, id);
      if (got.wasInHands) handedBack++;
      toAi += got.toAi;
    }
    return { handedBack, toAi };
  },
});
