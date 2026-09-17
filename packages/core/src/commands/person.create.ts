import { people } from '@hfos/db/schema';
import { AI_TEAMMATE_SOURCE, outsideItsConversation } from '../ai-team/reach';
import { logSystemActivity } from '../crm/activities';
import { insertWithId, madeBefore } from '../crm/client-ids';
import { findMatches } from '../crm/matching';
import { formatPhone } from '../crm/phone';
import { addressPatch, fullName, requireCompany, setRecordTags } from '../crm/records';
import { HfosError } from '../errors';
import { userIdOf } from '../kernel/actor';
import { defineCommand } from '../kernel/define';
import { changeMoment } from '../kernel/moment';
import { PersonCreateInput, PersonCreateOutput } from '../schemas/person';

export const personCreate = defineCommand({
  name: 'person.create',
  description:
    'Add a person. Warns when someone with the same email or phone already exists; from the phone, adds them anyway and flags the likely duplicate.',
  risk: 1,
  input: PersonCreateInput,
  output: PersonCreateOutput,
  permission: 'records.write',
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  emits: ['person.created'],
  actors: ['human', 'system', 'ai_employee'],
  offline: 'anytime',
  async handler(ctx, input) {
    const workspaceId = ctx.scope.workspaceId!;
    if ((input.importId || input.importRow) && ctx.actor.type !== 'system')
      throw HfosError.validation([
        { path: 'importId', message: 'Only an import can set the import row.' },
      ]);
    if (ctx.actor.type === 'ai_employee') {
      // The AI teammate finds someone already here first (and never edits them), and adds no companies.
      if (input.companyId) throw outsideItsConversation();
      const [match] = await findMatches(ctx.tx, workspaceId, 'person', {
        email: input.email,
        phoneE164: input.phone,
      });
      if (match) return { personId: match.id };
    }
    const earlier = await madeBefore(ctx.tx, 'people', input.id, workspaceId);
    if (earlier) return { personId: earlier.id };
    if (input.companyId) await requireCompany(ctx.tx, workspaceId, input.companyId);
    let duplicateOf: string | null = null;
    if (!input.ignoreDuplicates) {
      const matches = await findMatches(ctx.tx, workspaceId, 'person', {
        email: input.email,
        phoneE164: input.phone,
      });
      if (matches.length > 0 && ctx.meta.channel === 'mobile') duplicateOf = matches[0]!.id;
      else if (matches.length > 0)
        throw new HfosError(
          'conflict',
          409,
          `Looks like ${matches[0]!.name} already exists with this ${matches[0]!.matchedOn}.`,
          { matches },
          'duplicate',
        );
    }
    const [row] = await insertWithId('people', input.id, () =>
      ctx.tx
        .insert(people)
        .values({
          ...(input.id ? { id: input.id } : {}),
          workspaceId,
          // Made on the phone and looking like one already here: added anyway, and flagged.
          possibleDuplicateOf: duplicateOf,
          companyId: input.companyId ?? null,
          firstName: input.firstName,
          lastName: input.lastName,
          email: input.email ?? null,
          phone: input.phone ? formatPhone(input.phone) : null,
          phoneE164: input.phone ?? null,
          phoneAlt: input.phoneAlt ? formatPhone(input.phoneAlt) : null,
          ...addressPatch(input.address),
          notes: input.notes ?? null,
          source: input.source ?? (ctx.actor.type === 'ai_employee' ? AI_TEAMMATE_SOURCE : null),
          ownerUserId: input.ownerUserId ?? null,
          createdBy: userIdOf(ctx.actor),
          importId: input.importId ?? null,
          importRow: input.importRow ?? null,
        })
        .returning(),
    );
    if (!row) throw HfosError.forbidden();
    if (input.tagIds?.length)
      await setRecordTags(
        ctx.tx,
        workspaceId,
        'person',
        row.id,
        input.tagIds,
        userIdOf(ctx.actor),
        changeMoment(ctx.meta),
      );
    const name = fullName(row.firstName, row.lastName);
    const eventId = await ctx.emit({
      type: 'person.created',
      entityType: 'person',
      entityId: row.id,
      payload: { name, ...(duplicateOf ? { possibleDuplicateOf: duplicateOf } : {}) },
      after: {
        name,
        email: row.email,
        phone: row.phone,
        city: row.city,
        source: row.source,
        companyId: row.companyId,
      },
      broadcast: ctx.actor.type === 'human',
    });
    await logSystemActivity(ctx, {
      subtype: 'created',
      personId: row.id,
      companyId: row.companyId,
      eventId,
    });
    return { personId: row.id };
  },
});
