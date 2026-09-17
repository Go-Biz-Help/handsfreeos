import { and, eq } from 'drizzle-orm';
import { leads } from '@hfos/db/schema';
import { logSystemActivity } from '../crm/activities';
import { HfosError } from '../errors';
import { defineCommand } from '../kernel/define';
import { changeMoment } from '../kernel/moment';
import { LeadArchiveInput, LeadArchiveOutput } from '../schemas/lead';

export const leadArchive = defineCommand({
  name: 'lead.archive',
  description: 'Archive a lead so it leaves the pipeline without losing its history.',
  risk: 2,
  input: LeadArchiveInput,
  output: LeadArchiveOutput,
  permission: 'records.archive',
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  emits: ['lead.archived'],
  offline: 'anytime',
  async handler(ctx, input) {
    const [current] = await ctx.tx
      .select()
      .from(leads)
      .where(and(eq(leads.id, input.leadId), eq(leads.workspaceId, ctx.scope.workspaceId!)));
    if (!current) throw HfosError.notFound('Lead not found.');
    if (current.archivedAt) return { leadId: current.id };
    await ctx.tx
      .update(leads)
      .set({ archivedAt: changeMoment(ctx.meta) })
      .where(eq(leads.id, current.id));
    const eventId = await ctx.emit({
      type: 'lead.archived',
      entityType: 'lead',
      entityId: current.id,
      payload: { title: current.title },
      before: { title: current.title, archived: false },
      after: { title: current.title, archived: true },
    });
    await logSystemActivity(ctx, {
      subtype: 'archived',
      leadId: current.id,
      personId: current.personId,
      companyId: current.companyId,
      body: current.title,
      eventId,
    });
    return { leadId: current.id };
  },
});

export const leadRestore = defineCommand({
  name: 'lead.restore',
  description: 'Bring an archived lead back to its stage.',
  risk: 2,
  input: LeadArchiveInput,
  output: LeadArchiveOutput,
  permission: 'records.archive',
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  emits: ['lead.restored'],
  offline: 'anytime',
  async handler(ctx, input) {
    const [current] = await ctx.tx
      .select()
      .from(leads)
      .where(and(eq(leads.id, input.leadId), eq(leads.workspaceId, ctx.scope.workspaceId!)));
    if (!current) throw HfosError.notFound('Lead not found.');
    if (!current.archivedAt) return { leadId: current.id };
    await ctx.tx.update(leads).set({ archivedAt: null }).where(eq(leads.id, current.id));
    const eventId = await ctx.emit({
      type: 'lead.restored',
      entityType: 'lead',
      entityId: current.id,
      payload: { title: current.title },
      before: { title: current.title, archived: true },
      after: { title: current.title, archived: false },
    });
    await logSystemActivity(ctx, {
      subtype: 'restored',
      leadId: current.id,
      personId: current.personId,
      companyId: current.companyId,
      body: current.title,
      eventId,
    });
    return { leadId: current.id };
  },
});
