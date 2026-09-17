import { and, count, eq, isNull } from 'drizzle-orm';
import { companies, leads, tasks } from '@hfos/db/schema';
import { logSystemActivity } from '../crm/activities';
import { requireCompany } from '../crm/records';
import { HfosError } from '../errors';
import { defineCommand } from '../kernel/define';
import { changeMoment } from '../kernel/moment';
import { CompanyArchiveInput, CompanyArchiveOutput } from '../schemas/company';

export const companyArchive = defineCommand({
  name: 'company.archive',
  description:
    'Archive a company. Refused while it has open leads or tasks unless forced, which archives the leads too.',
  risk: 3,
  input: CompanyArchiveInput,
  output: CompanyArchiveOutput,
  permission: 'records.archive',
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  emits: ['company.archived'],
  offline: 'anytime',
  async handler(ctx, input) {
    const current = await requireCompany(ctx.tx, ctx.scope.workspaceId!, input.companyId);
    if (current.archivedAt) return { companyId: current.id, archivedLeads: 0 };
    const [openLeads] = await ctx.tx
      .select({ n: count() })
      .from(leads)
      .where(
        and(eq(leads.companyId, current.id), eq(leads.status, 'open'), isNull(leads.archivedAt)),
      );
    const [openTasks] = await ctx.tx
      .select({ n: count() })
      .from(tasks)
      .where(and(eq(tasks.companyId, current.id), isNull(tasks.doneAt)));
    const open = Number(openLeads?.n ?? 0);
    if ((open > 0 || Number(openTasks?.n ?? 0) > 0) && !input.force)
      throw new HfosError(
        'conflict',
        409,
        'This company still has open leads or tasks.',
        { openLeads: open, openTasks: Number(openTasks?.n ?? 0) },
        'has_open_work',
      );
    // Archived when the person did it (on a phone, perhaps before it had signal), and its open leads with it.
    const at = changeMoment(ctx.meta);
    let archivedLeads = 0;
    if (open > 0) {
      const rows = await ctx.tx
        .update(leads)
        .set({ archivedAt: at })
        .where(
          and(eq(leads.companyId, current.id), eq(leads.status, 'open'), isNull(leads.archivedAt)),
        )
        .returning({ id: leads.id });
      archivedLeads = rows.length;
    }
    await ctx.tx.update(companies).set({ archivedAt: at }).where(eq(companies.id, current.id));
    const eventId = await ctx.emit({
      type: 'company.archived',
      entityType: 'company',
      entityId: current.id,
      payload: { name: current.name, archivedLeads },
      before: { name: current.name, archived: false },
      after: { name: current.name, archived: true },
    });
    await logSystemActivity(ctx, { subtype: 'archived', companyId: current.id, eventId });
    return { companyId: current.id, archivedLeads };
  },
});
