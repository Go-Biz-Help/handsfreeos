import { and, eq } from 'drizzle-orm';
import { rows, sql } from '@hfos/db/client';
import { leads } from '@hfos/db/schema';
import { assertAiReach, teammateDealsOn } from '../ai-team/reach';
import { logSystemActivity } from '../crm/activities';
import { requireCompany, requirePerson, userRef } from '../crm/records';
import { HfosError } from '../errors';
import { aiEmployeeOf } from '../kernel/actor';
import { defineCommand } from '../kernel/define';
import { scopeCan } from '../kernel/execute';
import {
  logNotApplied,
  mergeColumns,
  mergeFields,
  type MergeField,
  type MergeKind,
} from '../kernel/field-merge';
import { LeadUpdateInput, LeadUpdateOutput } from '../schemas/lead';

export const leadUpdate = defineCommand({
  name: 'lead.update',
  description:
    'Change a lead’s title, value, source, people, expected close date, assignee or next action: only what was edited, each with what the editor saw, and the newest change to each wins.',
  risk: 1,
  input: LeadUpdateInput,
  output: LeadUpdateOutput,
  permission: 'records.write',
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  emits: ['lead.updated', 'lead.assigned'],
  actors: ['human', 'workflow', 'ai_employee'],
  offline: 'anytime',
  async handler(ctx, input) {
    const workspaceId = ctx.scope.workspaceId!;
    // The AI teammate changes only the next action on its own customer's lead, and what it's worth when its
    // settings let it handle deals (M18).
    const ai = aiEmployeeOf(ctx.actor);
    if (ai) {
      const deals = input.valueCents !== undefined && (await teammateDealsOn(ctx.tx, ai));
      const other = (
        [
          'title',
          'personId',
          'companyId',
          ...(deals ? [] : ['valueCents' as const]),
          'source',
          'assigneeUserId',
          'expectedCloseOn',
        ] as const
      ).filter((k) => input[k] !== undefined);
      if (other.length)
        throw HfosError.validation(
          other.map((path) => ({
            path,
            message: 'The AI teammate only changes a lead’s next action.',
          })),
        );
      await assertAiReach(ctx, { leadId: input.leadId });
    }
    const [current] = await ctx.tx
      .select()
      .from(leads)
      .where(and(eq(leads.id, input.leadId), eq(leads.workspaceId, workspaceId)))
      .for('update');
    if (!current) throw HfosError.notFound('Lead not found.');
    if (input.personId) await requirePerson(ctx.tx, workspaceId, input.personId);
    if (input.companyId) await requireCompany(ctx.tx, workspaceId, input.companyId);
    const seen: NonNullable<typeof input.base> = input.base ?? {};
    const field = (
      key: keyof typeof seen,
      value: unknown,
      kind: MergeKind,
      label: string,
    ): MergeField => ({ key, column: key, value, base: seen[key], kind, label });
    const merged = mergeFields(
      current,
      [
        field('title', input.title, 'text', 'title'),
        field('personId', input.personId, 'id', 'person'),
        field('companyId', input.companyId, 'id', 'company'),
        field('valueCents', input.valueCents, 'number', 'value'),
        field('source', input.source, 'text', 'source'),
        field('assigneeUserId', input.assigneeUserId, 'id', 'assignee'),
        field('expectedCloseOn', input.expectedCloseOn, 'date', 'expected close date'),
        field('nextAction', input.nextAction, 'text', 'next action'),
        field(
          'nextActionAt',
          input.nextActionAt === undefined
            ? undefined
            : input.nextActionAt
              ? new Date(input.nextActionAt)
              : null,
          'time',
          'next action time',
        ),
      ],
      mergeColumns(leads),
      ctx.meta,
    );
    const { patch } = merged;
    // Being a lead's assignee shows a member its bills. Anybody who works a lead may hand it on to anybody, but
    // putting yourself on it when that shows you bills you can't otherwise see is for owners and admins. The
    // database refuses it too. People only.
    const to = 'assigneeUserId' in patch ? (patch.assigneeUserId as string | null) : null;
    if (
      ctx.actor.type === 'human' &&
      to &&
      to === ctx.actor.userId &&
      to !== current.assigneeUserId &&
      !scopeCan(ctx.scope, 'records.assign')
    ) {
      const [sees] = await rows<{ yes: boolean }>(
        ctx.tx,
        sql`select private.sees_money_as_member(${workspaceId}::uuid, ${to}::uuid) as yes`,
      );
      if (sees?.yes)
        throw HfosError.rule(
          'lead_assign_managers_only',
          403,
          'Only owners and admins can put you on a lead.',
        );
    }
    const nextPerson = 'personId' in patch ? (patch.personId as string | null) : current.personId;
    const nextCompany =
      'companyId' in patch ? (patch.companyId as string | null) : current.companyId;
    if (!nextPerson && !nextCompany)
      throw HfosError.validation([
        { path: 'personId', message: 'A lead needs a person or a company.' },
      ]);
    const notApplied = merged.notApplied.map((n) => n.key);
    await logNotApplied(
      ctx,
      merged.notApplied,
      { type: 'lead', id: current.id },
      { leadId: current.id, personId: current.personId, companyId: current.companyId },
    );
    const updated = [...merged.applied];
    if (updated.length === 0) return { leadId: current.id, updated: [], notApplied };
    await ctx.tx.update(leads).set(patch).where(eq(leads.id, current.id));
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    for (const k of updated) {
      before[k] = (current as Record<string, unknown>)[k];
      after[k] = patch[k];
    }
    const title = (patch.title as string | undefined) ?? current.title;
    await ctx.emit({
      type: 'lead.updated',
      entityType: 'lead',
      entityId: current.id,
      payload: { title, fields: updated },
      before: { title: current.title, ...before },
      after: { title, ...after },
    });
    if ('assigneeUserId' in patch) {
      const assignee = await userRef(ctx.tx, patch.assigneeUserId as string | null);
      const eventId = await ctx.emit({
        type: 'lead.assigned',
        entityType: 'lead',
        entityId: current.id,
        payload: {
          title,
          assigneeUserId: patch.assigneeUserId ?? null,
          assigneeName: assignee?.fullName ?? null,
        },
        before: { assigneeUserId: current.assigneeUserId },
        after: {
          assigneeUserId: patch.assigneeUserId ?? null,
          assigneeName: assignee?.fullName ?? null,
        },
      });
      await logSystemActivity(ctx, {
        subtype: 'assigned',
        leadId: current.id,
        personId: nextPerson,
        companyId: nextCompany,
        body: assignee ? `Assigned to ${assignee.fullName}` : 'Unassigned',
        meta: { assigneeUserId: patch.assigneeUserId ?? null },
        eventId,
      });
    }
    return { leadId: current.id, updated, notApplied };
  },
});
