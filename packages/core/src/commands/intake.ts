/**
 * What a website form or a connected app sends (M14 slice B). The worker has already checked the key, the
 * site it was posted from and its rate limits; this is the business's own part, and it is the same path a
 * text from a stranger goes through: the daily limit, the matching, the lead, the note on the timeline.
 *
 * The system actor only. A sender that retries gets the answer it got the first time.
 */
import { workspaceZone } from '../calendar/load';
import { intakeSourceById, submitIntake } from '../crm/intake';
import { HfosError } from '../errors';
import { defineCommand } from '../kernel/define';
import { IntakeSubmitInput, IntakeSubmitOutput } from '../schemas/intake';

export const intakeSubmit = defineCommand({
  name: 'intake.submit',
  description:
    'Worker: a lead arrived from a website form or a connected app. Opens the customer and their lead, under the source’s own settings and its limit for the day.',
  risk: 1,
  input: IntakeSubmitInput,
  output: IntakeSubmitOutput,
  permission: 'records.write',
  scope: (i) => ({ kind: 'workspace' as const, workspaceId: i.workspaceId }),
  emits: ['person.created', 'lead.created'],
  actors: ['system'],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const source = await intakeSourceById(ctx.tx, ws, input.sourceId);
    if (!source || (source.kind !== 'website_form' && source.kind !== 'api'))
      throw HfosError.notFound('That form or key isn’t here.');
    const result = await submitIntake(ctx, {
      source,
      payload: input.payload,
      dedupeKey: input.dedupeKey,
      at: input.occurredAt ? new Date(input.occurredAt) : new Date(),
      zone: await workspaceZone(ctx.tx, ws),
    });
    return result;
  },
});
