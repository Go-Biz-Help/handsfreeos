import { companies } from '@hfos/db/schema';
import { logSystemActivity } from '../crm/activities';
import { findMatches } from '../crm/matching';
import { formatPhone } from '../crm/phone';
import { addressPatch, setRecordTags } from '../crm/records';
import { HfosError } from '../errors';
import { userIdOf } from '../kernel/actor';
import { defineCommand } from '../kernel/define';
import { CompanyCreateInput, CompanyCreateOutput } from '../schemas/company';

export const companyCreate = defineCommand({
  name: 'company.create',
  description: 'Add a company. Warns when one with the same email, phone or name already exists.',
  risk: 1,
  input: CompanyCreateInput,
  output: CompanyCreateOutput,
  permission: 'records.write',
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  emits: ['company.created'],
  actors: ['human', 'system'],
  async handler(ctx, input) {
    const workspaceId = ctx.scope.workspaceId!;
    if (!input.ignoreDuplicates) {
      const matches = await findMatches(ctx.tx, workspaceId, 'company', {
        email: input.email,
        phoneE164: input.phone,
        name: input.name,
      });
      if (matches.length > 0)
        throw new HfosError(
          'conflict',
          409,
          `A company like "${matches[0]!.name}" already exists.`,
          { matches },
          'duplicate',
        );
    }
    const [row] = await ctx.tx
      .insert(companies)
      .values({
        workspaceId,
        name: input.name,
        email: input.email ?? null,
        phone: input.phone ? formatPhone(input.phone) : null,
        phoneE164: input.phone ?? null,
        website: input.website ?? null,
        ...addressPatch(input.address),
        notes: input.notes ?? null,
        source: input.source ?? null,
        ownerUserId: input.ownerUserId ?? null,
        createdBy: userIdOf(ctx.actor),
      })
      .returning();
    if (!row) throw HfosError.forbidden();
    if (input.tagIds?.length)
      await setRecordTags(
        ctx.tx,
        workspaceId,
        'company',
        row.id,
        input.tagIds,
        userIdOf(ctx.actor),
      );
    const eventId = await ctx.emit({
      type: 'company.created',
      entityType: 'company',
      entityId: row.id,
      payload: { name: row.name },
      after: {
        name: row.name,
        email: row.email,
        phone: row.phone,
        city: row.city,
        source: row.source,
      },
      broadcast: ctx.actor.type === 'human',
    });
    await logSystemActivity(ctx, { subtype: 'created', companyId: row.id, eventId });
    return { companyId: row.id };
  },
});
