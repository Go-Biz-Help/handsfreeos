import { eq } from 'drizzle-orm';
import { people } from '@hfos/db/schema';
import { logSystemActivity } from '../crm/activities';
import { fullName, requirePerson } from '../crm/records';
import { defineCommand } from '../kernel/define';
import { PersonRestoreInput, PersonRestoreOutput } from '../schemas/person';

export const personRestore = defineCommand({
  name: 'person.restore',
  description: 'Bring an archived person back.',
  risk: 2,
  input: PersonRestoreInput,
  output: PersonRestoreOutput,
  permission: 'records.archive',
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  emits: ['person.restored'],
  async handler(ctx, input) {
    const current = await requirePerson(ctx.tx, ctx.scope.workspaceId!, input.personId);
    if (!current.archivedAt) return { personId: current.id };
    await ctx.tx.update(people).set({ archivedAt: null }).where(eq(people.id, current.id));
    const name = fullName(current.firstName, current.lastName);
    const eventId = await ctx.emit({
      type: 'person.restored',
      entityType: 'person',
      entityId: current.id,
      payload: { name },
      before: { name, archived: true },
      after: { name, archived: false },
    });
    await logSystemActivity(ctx, { subtype: 'restored', personId: current.id, eventId });
    return { personId: current.id };
  },
});
