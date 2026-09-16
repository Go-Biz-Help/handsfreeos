import { and, count, eq, isNull } from 'drizzle-orm';
import { leads, people, tasks } from '@hfos/db/schema';
import { logSystemActivity } from '../crm/activities';
import { fullName, requirePerson } from '../crm/records';
import { HfosError } from '../errors';
import { defineCommand } from '../kernel/define';
import { PersonArchiveInput, PersonArchiveOutput } from '../schemas/person';

export const personArchive = defineCommand({
  name: 'person.archive',
  description:
    'Archive a person. Refused while they have open leads or tasks unless forced, which archives the leads too.',
  risk: 3,
  input: PersonArchiveInput,
  output: PersonArchiveOutput,
  permission: 'records.archive',
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  emits: ['person.archived'],
  offline: 'anytime',
  async handler(ctx, input) {
    const current = await requirePerson(ctx.tx, ctx.scope.workspaceId!, input.personId);
    if (current.archivedAt) return { personId: current.id, archivedLeads: 0 };
    const [openLeads] = await ctx.tx
      .select({ n: count() })
      .from(leads)
      .where(
        and(eq(leads.personId, current.id), eq(leads.status, 'open'), isNull(leads.archivedAt)),
      );
    const [openTasks] = await ctx.tx
      .select({ n: count() })
      .from(tasks)
      .where(and(eq(tasks.personId, current.id), isNull(tasks.doneAt)));
    const open = Number(openLeads?.n ?? 0);
    if ((open > 0 || Number(openTasks?.n ?? 0) > 0) && !input.force)
      throw new HfosError(
        'conflict',
        409,
        'This person still has open leads or tasks.',
        { openLeads: open, openTasks: Number(openTasks?.n ?? 0) },
        'has_open_work',
      );
    let archivedLeads = 0;
    if (open > 0) {
      const rows = await ctx.tx
        .update(leads)
        .set({ archivedAt: new Date() })
        .where(
          and(eq(leads.personId, current.id), eq(leads.status, 'open'), isNull(leads.archivedAt)),
        )
        .returning({ id: leads.id });
      archivedLeads = rows.length;
    }
    await ctx.tx.update(people).set({ archivedAt: new Date() }).where(eq(people.id, current.id));
    const name = fullName(current.firstName, current.lastName);
    const eventId = await ctx.emit({
      type: 'person.archived',
      entityType: 'person',
      entityId: current.id,
      payload: { name, archivedLeads },
      before: { name, archived: false },
      after: { name, archived: true },
    });
    await logSystemActivity(ctx, { subtype: 'archived', personId: current.id, eventId });
    return { personId: current.id, archivedLeads };
  },
});
