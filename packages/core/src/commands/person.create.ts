import { people } from '@hfos/db/schema';
import { logSystemActivity } from '../crm/activities';
import { findMatches } from '../crm/matching';
import { formatPhone } from '../crm/phone';
import { addressPatch, fullName, requireCompany, setRecordTags } from '../crm/records';
import { HfosError } from '../errors';
import { userIdOf } from '../kernel/actor';
import { defineCommand } from '../kernel/define';
import { PersonCreateInput, PersonCreateOutput } from '../schemas/person';

export const personCreate = defineCommand({
  name: 'person.create',
  description: 'Add a person. Warns when someone with the same email or phone already exists.',
  risk: 1,
  input: PersonCreateInput,
  output: PersonCreateOutput,
  permission: 'records.write',
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  emits: ['person.created'],
  actors: ['human', 'system'],
  async handler(ctx, input) {
    const workspaceId = ctx.scope.workspaceId!;
    if (input.companyId) await requireCompany(ctx.tx, workspaceId, input.companyId);
    if (!input.ignoreDuplicates) {
      const matches = await findMatches(ctx.tx, workspaceId, 'person', {
        email: input.email,
        phoneE164: input.phone,
      });
      if (matches.length > 0)
        throw new HfosError(
          'conflict',
          409,
          `Looks like ${matches[0]!.name} already exists with this ${matches[0]!.matchedOn}.`,
          { matches },
          'duplicate',
        );
    }
    const [row] = await ctx.tx
      .insert(people)
      .values({
        workspaceId,
        companyId: input.companyId ?? null,
        firstName: input.firstName,
        lastName: input.lastName,
        email: input.email ?? null,
        phone: input.phone ? formatPhone(input.phone) : null,
        phoneE164: input.phone ?? null,
        phoneAlt: input.phoneAlt ? formatPhone(input.phoneAlt) : null,
        ...addressPatch(input.address),
        notes: input.notes ?? null,
        source: input.source ?? null,
        ownerUserId: input.ownerUserId ?? null,
        createdBy: userIdOf(ctx.actor),
      })
      .returning();
    if (!row) throw HfosError.forbidden();
    if (input.tagIds?.length)
      await setRecordTags(ctx.tx, workspaceId, 'person', row.id, input.tagIds, userIdOf(ctx.actor));
    const name = fullName(row.firstName, row.lastName);
    const eventId = await ctx.emit({
      type: 'person.created',
      entityType: 'person',
      entityId: row.id,
      payload: { name },
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
