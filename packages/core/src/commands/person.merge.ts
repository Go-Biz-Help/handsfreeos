import { and, eq, inArray } from 'drizzle-orm';
import { rows, sql } from '@hfos/db/client';
import { people } from '@hfos/db/schema';
import { logSystemActivity } from '../crm/activities';
import { mergedDetails } from '../crm/person-merge';
import { fullName, requireCompany } from '../crm/records';
import { HfosError } from '../errors';
import { defineCommand } from '../kernel/define';
import { mergeColumns, mergeFields, type MergeField, type MergeKind } from '../kernel/field-merge';
import { PersonMergeInput, PersonMergeOutput } from '../schemas/person';

/** How each detail the duplicate can fill in is compared (see kernel/field-merge). */
const KINDS: Readonly<Record<string, MergeKind>> = {
  firstName: 'text',
  lastName: 'text',
  email: 'email',
  phoneE164: 'phone',
  addressLine1: 'text',
  addressLine2: 'text',
  city: 'text',
  state: 'text',
  postalCode: 'text',
  country: 'text',
  otherEmails: 'json',
  otherPhones: 'json',
  otherAddresses: 'json',
  companyId: 'id',
  notes: 'text',
  source: 'text',
};

export const personMerge = defineCommand({
  name: 'person.merge',
  description:
    'Merge a duplicate customer into the one kept: their leads, tasks, timeline, conversations, calls, bookings, bills, quotes, plans, files, tags and relationships move to the one kept, the details it is missing are filled in, and the duplicate is archived.',
  risk: 3,
  input: PersonMergeInput,
  output: PersonMergeOutput,
  permission: 'records.archive',
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  emits: ['person.merged'],
  async handler(ctx, input) {
    const workspaceId = ctx.scope.workspaceId!;
    if (input.personId === input.intoPersonId)
      throw HfosError.validation(
        [{ path: 'intoPersonId', message: 'Pick a different customer to merge with.' }],
        'Pick a different customer to merge with.',
      );
    // Both rows, locked in the same order whichever way round they come, so two merges of the same pair wait.
    const both = await ctx.tx
      .select()
      .from(people)
      .where(
        and(
          eq(people.workspaceId, workspaceId),
          inArray(people.id, [input.personId, input.intoPersonId]),
        ),
      )
      .orderBy(people.id)
      .for('update');
    const dup = both.find((p) => p.id === input.personId);
    const keep = both.find((p) => p.id === input.intoPersonId);
    if (!dup || !keep) throw HfosError.notFound('Person not found.');
    const dupName = fullName(dup.firstName, dup.lastName);
    const keepName = fullName(keep.firstName, keep.lastName);
    if (dup.mergedIntoId)
      throw new HfosError(
        'rule_violation',
        409,
        `${dupName} was already merged into another customer.`,
        { mergedIntoId: dup.mergedIntoId },
        'person_already_merged',
      );
    if (keep.mergedIntoId || keep.archivedAt)
      throw new HfosError(
        'rule_violation',
        409,
        `${keepName} is archived. Bring them back before merging into them.`,
        undefined,
        'person_merge_into_archived',
      );

    // What the record kept is missing, from the duplicate. Written as an ordinary edit, so each detail is stamped.
    const { patch, filled } = mergedDetails(keep, dup);
    if (patch.companyId) await requireCompany(ctx.tx, workspaceId, patch.companyId);
    const fields: MergeField[] = Object.entries(KINDS)
      .filter(([column]) => column in patch)
      .map(([column, kind]) => ({
        key: column,
        column,
        value: patch[column as keyof typeof patch],
        base: undefined,
        kind,
        label: column,
        also: column === 'phoneE164' ? { phone: patch.phone } : undefined,
      }));
    const merged = mergeFields(keep, fields, mergeColumns(people), ctx.meta);
    if (merged.applied.length)
      await ctx.tx.update(people).set(merged.patch).where(eq(people.id, keep.id));

    // Everything that names the duplicate moves to the record kept, and the duplicate is archived and marked.
    const [done] = await rows<{ moved: Record<string, number> | null }>(
      ctx.tx,
      sql`select private.merge_people(${workspaceId}::uuid, ${dup.id}::uuid, ${keep.id}::uuid) as moved`,
    );
    const moved = done?.moved ?? {};
    const name = fullName(
      (patch.firstName ?? keep.firstName) as string,
      (patch.lastName ?? keep.lastName) as string,
    );

    const eventId = await ctx.emit({
      type: 'person.merged',
      entityType: 'person',
      entityId: keep.id,
      payload: { name, mergedPersonId: dup.id, mergedName: dupName, filled, moved },
      before: { name: keepName, mergedName: dupName },
      after: { name, mergedInto: keep.id },
    });
    await logSystemActivity(ctx, {
      subtype: 'merged',
      personId: keep.id,
      eventId,
      meta: { mergedPersonId: dup.id, mergedName: dupName, filled },
    });
    return { personId: keep.id, mergedPersonId: dup.id, filled, moved };
  },
});
