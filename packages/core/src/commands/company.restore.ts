import { eq } from 'drizzle-orm';
import { companies } from '@hfos/db/schema';
import { logSystemActivity } from '../crm/activities';
import { requireCompany } from '../crm/records';
import { defineCommand } from '../kernel/define';
import { CompanyRestoreInput, CompanyRestoreOutput } from '../schemas/company';

export const companyRestore = defineCommand({
  name: 'company.restore',
  description: 'Bring an archived company back.',
  risk: 2,
  input: CompanyRestoreInput,
  output: CompanyRestoreOutput,
  permission: 'records.archive',
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  emits: ['company.restored'],
  offline: 'anytime',
  async handler(ctx, input) {
    const current = await requireCompany(ctx.tx, ctx.scope.workspaceId!, input.companyId);
    if (!current.archivedAt) return { companyId: current.id };
    await ctx.tx.update(companies).set({ archivedAt: null }).where(eq(companies.id, current.id));
    const eventId = await ctx.emit({
      type: 'company.restored',
      entityType: 'company',
      entityId: current.id,
      payload: { name: current.name },
      before: { name: current.name, archived: true },
      after: { name: current.name, archived: false },
    });
    await logSystemActivity(ctx, { subtype: 'restored', companyId: current.id, eventId });
    return { companyId: current.id };
  },
});
