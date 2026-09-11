import { eq } from 'drizzle-orm';
import { companies } from '@hfos/db/schema';
import { formatPhone } from '../crm/phone';
import { addressPatch, requireCompany } from '../crm/records';
import { HfosError } from '../errors';
import { defineCommand } from '../kernel/define';
import { CompanyUpdateInput, CompanyUpdateOutput } from '../schemas/company';

export const companyUpdate = defineCommand({
  name: 'company.update',
  description: 'Change a company’s details.',
  risk: 1,
  input: CompanyUpdateInput,
  output: CompanyUpdateOutput,
  permission: 'records.write',
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  emits: ['company.updated'],
  actors: ['human', 'system'],
  async handler(ctx, input) {
    const current = await requireCompany(ctx.tx, ctx.scope.workspaceId!, input.companyId);
    const patch: Record<string, unknown> = {};
    const set = (key: keyof typeof current, value: unknown) => {
      if (value !== undefined && value !== current[key]) patch[key] = value;
    };
    set('name', input.name);
    set('email', input.email);
    if (input.phone !== undefined) {
      set('phoneE164', input.phone);
      set('phone', input.phone ? formatPhone(input.phone) : null);
    }
    set('website', input.website);
    set('notes', input.notes);
    set('source', input.source);
    set('ownerUserId', input.ownerUserId);
    for (const [k, v] of Object.entries(addressPatch(input.address)))
      set(k as keyof typeof current, v);
    const updated = Object.keys(patch).filter((k) => k !== 'phone');
    if (Object.keys(patch).length === 0) return { companyId: current.id, updated: [] };
    const [row] = await ctx.tx
      .update(companies)
      .set(patch)
      .where(eq(companies.id, current.id))
      .returning({ id: companies.id });
    if (!row) throw HfosError.forbidden();
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    for (const k of updated) {
      before[k] = (current as Record<string, unknown>)[k];
      after[k] = patch[k];
    }
    await ctx.emit({
      type: 'company.updated',
      entityType: 'company',
      entityId: current.id,
      payload: { name: (patch.name as string | undefined) ?? current.name, fields: updated },
      before: { name: current.name, ...before },
      after: { name: (patch.name as string | undefined) ?? current.name, ...after },
      broadcast: ctx.actor.type === 'human',
    });
    return { companyId: current.id, updated };
  },
});
