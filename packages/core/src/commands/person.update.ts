import { and, eq, isNull } from 'drizzle-orm';
import { leads, people } from '@hfos/db/schema';
import { formatPhone } from '../crm/phone';
import { addressPatch, fullName, requireCompany, requirePerson } from '../crm/records';
import { HfosError } from '../errors';
import { defineCommand } from '../kernel/define';
import { PersonUpdateInput, PersonUpdateOutput } from '../schemas/person';

export const personUpdate = defineCommand({
  name: 'person.update',
  description: 'Change a person’s details. Changing the company also moves their open leads to it.',
  risk: 1,
  input: PersonUpdateInput,
  output: PersonUpdateOutput,
  permission: 'records.write',
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  emits: ['person.updated'],
  actors: ['human', 'system'],
  async handler(ctx, input) {
    const workspaceId = ctx.scope.workspaceId!;
    const current = await requirePerson(ctx.tx, workspaceId, input.personId);
    if (input.companyId) await requireCompany(ctx.tx, workspaceId, input.companyId);
    const patch: Record<string, unknown> = {};
    const set = (key: keyof typeof current, value: unknown) => {
      if (value !== undefined && value !== current[key]) patch[key] = value;
    };
    set('firstName', input.firstName);
    set('lastName', input.lastName);
    set('email', input.email);
    if (input.phone !== undefined) {
      set('phoneE164', input.phone);
      set('phone', input.phone ? formatPhone(input.phone) : null);
    }
    if (input.phoneAlt !== undefined)
      set('phoneAlt', input.phoneAlt ? formatPhone(input.phoneAlt) : null);
    set('companyId', input.companyId);
    set('notes', input.notes);
    set('source', input.source);
    set('ownerUserId', input.ownerUserId);
    for (const [k, v] of Object.entries(addressPatch(input.address)))
      set(k as keyof typeof current, v);
    const nextFirst = (patch.firstName as string | undefined) ?? current.firstName;
    const nextLast = (patch.lastName as string | undefined) ?? current.lastName;
    if (!(nextFirst + nextLast).trim())
      throw HfosError.validation([{ path: 'firstName', message: 'Enter a first or last name.' }]);
    const updated = Object.keys(patch).filter((k) => k !== 'phone');
    if (Object.keys(patch).length === 0) return { personId: current.id, updated: [] };
    const [row] = await ctx.tx
      .update(people)
      .set(patch)
      .where(eq(people.id, current.id))
      .returning({ id: people.id });
    if (!row) throw HfosError.forbidden();
    if ('companyId' in patch) {
      await ctx.tx
        .update(leads)
        .set({ companyId: (patch.companyId as string | null) ?? null })
        .where(
          and(eq(leads.personId, current.id), eq(leads.status, 'open'), isNull(leads.archivedAt)),
        );
    }
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    for (const k of updated) {
      before[k] = (current as Record<string, unknown>)[k];
      after[k] = patch[k];
    }
    const name = fullName(nextFirst, nextLast);
    await ctx.emit({
      type: 'person.updated',
      entityType: 'person',
      entityId: current.id,
      payload: { name, fields: updated },
      before: { name: fullName(current.firstName, current.lastName), ...before },
      after: { name, ...after },
      broadcast: ctx.actor.type === 'human',
    });
    return { personId: current.id, updated };
  },
});
