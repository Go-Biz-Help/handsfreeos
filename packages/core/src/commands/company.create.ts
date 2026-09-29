import { companies } from '@hfos/db/schema';
import { logSystemActivity } from '../crm/activities';
import { insertWithId, madeBefore } from '../crm/client-ids';
import { tidyOtherAddresses, tidyOtherEmails, tidyOtherPhones } from '../crm/contact-points';
import { findMatches } from '../crm/matching';
import { formatPhone } from '../crm/phone';
import { addressPatch, setRecordTags } from '../crm/records';
import { HfosError } from '../errors';
import { userIdOf } from '../kernel/actor';
import { defineCommand } from '../kernel/define';
import { changeMoment } from '../kernel/moment';
import { CompanyCreateInput, CompanyCreateOutput } from '../schemas/company';

/** What a likely duplicate shares with the new company, in the refusal's words. */
const MATCHED_ON_WORDS = { email: 'email', phone: 'phone number', name: 'name' } as const;

export const companyCreate = defineCommand({
  name: 'company.create',
  description:
    'Add a company. Warns when one with the same email, phone or name already exists; from the phone, adds it anyway and flags the likely duplicate.',
  risk: 1,
  input: CompanyCreateInput,
  output: CompanyCreateOutput,
  permission: 'records.write',
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  emits: ['company.created'],
  actors: ['human', 'system'],
  offline: 'anytime',
  async handler(ctx, input) {
    const workspaceId = ctx.scope.workspaceId!;
    if ((input.importId || input.importRow) && ctx.actor.type !== 'system')
      throw HfosError.validation([
        { path: 'importId', message: 'Only an import can set the import row.' },
      ]);
    const earlier = await madeBefore(ctx.tx, 'companies', input.id, workspaceId);
    if (earlier) return { companyId: earlier.id };
    let duplicateOf: string | null = null;
    if (!input.ignoreDuplicates) {
      const matches = await findMatches(ctx.tx, workspaceId, 'company', {
        email: input.email,
        phoneE164: input.phone,
        name: input.name,
      });
      if (matches.length > 0 && ctx.meta.channel === 'mobile') duplicateOf = matches[0]!.id;
      else if (matches.length > 0)
        throw new HfosError(
          'conflict',
          409,
          `${matches[0]!.name} is already here with the same ${MATCHED_ON_WORDS[matches[0]!.matchedOn]}. Open that company instead, or add this one anyway.`,
          { matches },
          'duplicate',
        );
    }
    const [row] = await insertWithId('companies', input.id, () =>
      ctx.tx
        .insert(companies)
        .values({
          ...(input.id ? { id: input.id } : {}),
          workspaceId,
          // Made on the phone and looking like one already here: added anyway, and flagged.
          possibleDuplicateOf: duplicateOf,
          name: input.name,
          email: input.email ?? null,
          phone: input.phone ? formatPhone(input.phone) : null,
          phoneE164: input.phone ?? null,
          website: input.website ?? null,
          ...addressPatch(input.address),
          otherEmails: tidyOtherEmails(input.otherEmails ?? [], input.email),
          otherPhones: tidyOtherPhones(input.otherPhones ?? [], input.phone),
          otherAddresses: tidyOtherAddresses(input.otherAddresses ?? [], input.address),
          notes: input.notes ?? null,
          source: input.source ?? null,
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
        'company',
        row.id,
        input.tagIds,
        userIdOf(ctx.actor),
        changeMoment(ctx.meta),
      );
    const eventId = await ctx.emit({
      type: 'company.created',
      entityType: 'company',
      entityId: row.id,
      payload: { name: row.name, ...(duplicateOf ? { possibleDuplicateOf: duplicateOf } : {}) },
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
