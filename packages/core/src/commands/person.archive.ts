import { and, count, eq, isNull } from 'drizzle-orm';
import { leads, people, tasks } from '@hfos/db/schema';
import { logSystemActivity } from '../crm/activities';
import { fullName, requirePerson } from '../crm/records';
import { countOf } from '../calendar/format';
import { HfosError } from '../errors';
import { defineCommand } from '../kernel/define';
import { changeMoment } from '../kernel/moment';
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
    const openTaskCount = Number(openTasks?.n ?? 0);
    if ((open > 0 || openTaskCount > 0) && !input.force) {
      const who = fullName(current.firstName, current.lastName) || 'This customer';
      const work = [
        ...(open > 0 ? [countOf(open, 'open lead', 'open leads')] : []),
        ...(openTaskCount > 0 ? [countOf(openTaskCount, 'open task', 'open tasks')] : []),
      ].join(' and ');
      throw new HfosError(
        'conflict',
        409,
        `${who} still has ${work}. Finish ${open + openTaskCount === 1 ? 'it' : 'them'} first, or archive anyway${open > 0 ? ' and their open leads are archived too' : ''}.`,
        { openLeads: open, openTasks: openTaskCount },
        'has_open_work',
      );
    }
    // Archived when the person did it (on a phone, perhaps before it had signal), and their open leads with them.
    const at = changeMoment(ctx.meta);
    let archivedLeads = 0;
    if (open > 0) {
      const rows = await ctx.tx
        .update(leads)
        .set({ archivedAt: at })
        .where(
          and(eq(leads.personId, current.id), eq(leads.status, 'open'), isNull(leads.archivedAt)),
        )
        .returning({ id: leads.id });
      archivedLeads = rows.length;
    }
    await ctx.tx.update(people).set({ archivedAt: at }).where(eq(people.id, current.id));
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
