/**
 * The AI's pass over the whole customer list (0107): starting one and stopping it. Setting up tags
 * (`tags.manage`: owners and admins), since it can put a tag on or take one off every customer the business has.
 *
 * Starting it writes down what the person asked for and how many customers it will look at; the worker then goes
 * through them a few at a time (`contact_ai.sweep_started`), each change a command of its own with the AI's reason
 * on its audit row, and each look a row of app.contact_ai_reviews. One runs at a time per business.
 */
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { rows, sql } from '@hfos/db/client';
import { contactAiSweeps, tags } from '@hfos/db/schema';
import { HfosError } from '../errors';
import { requireHuman } from '../kernel/actor';
import { defineCommand } from '../kernel/define';
import {
  ContactAiSweepCancelInput,
  ContactAiSweepCancelOutput,
  ContactAiSweepStartInput,
  ContactAiSweepStartOutput,
} from '../schemas/contact-ai';

const inWorkspace = (i: { workspaceId: string }) => ({
  kind: 'workspace' as const,
  workspaceId: i.workspaceId,
});

export const contactAiStartSweep = defineCommand({
  name: 'contact_ai.start_sweep',
  description:
    'Have the AI go through every customer (or the ones with one tag) and put on or take off tags from what it knows about them: their details, conversations, calls, visits, deals and payments. Optionally it also fills in and corrects contact details. Each change is logged with its reason.',
  risk: 2,
  input: ContactAiSweepStartInput,
  output: ContactAiSweepStartOutput,
  permission: 'tags.manage',
  scope: inWorkspace,
  emits: ['contact_ai.sweep_started'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const ws = ctx.scope.workspaceId!;
    const wanted = [...new Set([...input.tagIds, ...(input.onlyTagId ? [input.onlyTagId] : [])])];
    const found = wanted.length
      ? await ctx.tx
          .select({ id: tags.id, name: tags.name })
          .from(tags)
          .where(and(eq(tags.workspaceId, ws), inArray(tags.id, wanted)))
      : [];
    if (found.length !== wanted.length) throw HfosError.notFound('One of those tags isn’t there.');
    const [any] = await ctx.tx
      .select({ id: tags.id })
      .from(tags)
      .where(eq(tags.workspaceId, ws))
      .limit(1);
    if (!any)
      throw HfosError.conflict(
        'There are no tags yet. Add the tags you want first, then the AI can put them on.',
        'no_tags',
      );
    const [running] = await ctx.tx
      .select({
        id: contactAiSweeps.id,
        reviewed: contactAiSweeps.reviewed,
        total: contactAiSweeps.total,
      })
      .from(contactAiSweeps)
      .where(and(eq(contactAiSweeps.workspaceId, ws), eq(contactAiSweeps.status, 'running')));
    if (running)
      throw HfosError.conflict(
        `The AI is already going through your customers (${running.reviewed} of ${running.total}). Stop it first to start another.`,
        'contact_ai_running',
      );
    const [count] = await rows<{ n: number }>(
      ctx.tx,
      sql`select count(*)::int as n from app.people p
          where p.workspace_id = ${ws} and p.archived_at is null
          ${
            input.onlyTagId
              ? sql`and exists (select 1 from app.record_tags rt where rt.workspace_id = p.workspace_id
                  and rt.record_type = 'person' and rt.record_id = p.id and rt.tag_id = ${input.onlyTagId})`
              : sql``
          }`,
    );
    const total = count?.n ?? 0;
    if (total === 0)
      throw HfosError.conflict(
        input.onlyTagId ? 'Nobody has that tag.' : 'There are no customers yet.',
        'contact_ai_empty',
      );
    const [row] = await ctx.tx
      .insert(contactAiSweeps)
      .values({
        workspaceId: ws,
        requestedBy: me,
        instructions: input.instructions,
        tagIds: input.tagIds,
        onlyTagId: input.onlyTagId,
        fixDetails: input.fixDetails,
        total,
      })
      .returning({ id: contactAiSweeps.id });
    if (!row) throw HfosError.forbidden();
    const names = new Map(found.map((t) => [t.id, t.name]));
    await ctx.emit({
      type: 'contact_ai.sweep_started',
      entityType: 'contact_ai_sweep',
      entityId: row.id,
      payload: { sweepId: row.id, total },
      after: {
        total,
        tags: input.tagIds.map((id) => names.get(id) ?? id),
        onlyTag: input.onlyTagId ? (names.get(input.onlyTagId) ?? null) : null,
        fixDetails: input.fixDetails,
        instructions: input.instructions || null,
      },
    });
    return { sweepId: row.id, total };
  },
});

export const contactAiCancelSweep = defineCommand({
  name: 'contact_ai.cancel_sweep',
  description:
    'Stop the AI’s pass over the customer list. What it already changed stays, each change in the audit log.',
  risk: 1,
  input: ContactAiSweepCancelInput,
  output: ContactAiSweepCancelOutput,
  permission: 'tags.manage',
  scope: inWorkspace,
  emits: ['contact_ai.sweep_cancelled'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const ws = ctx.scope.workspaceId!;
    const [sweep] = await ctx.tx
      .select()
      .from(contactAiSweeps)
      .where(and(eq(contactAiSweeps.workspaceId, ws), eq(contactAiSweeps.id, input.sweepId)))
      .for('update');
    if (!sweep) throw HfosError.notFound('That pass isn’t here.');
    if (sweep.status !== 'running')
      throw HfosError.conflict('It has already stopped.', 'contact_ai_stopped');
    const [done] = await ctx.tx
      .update(contactAiSweeps)
      .set({
        status: 'cancelled',
        cancelledBy: me,
        finishedAt: new Date(),
        note: `Stopped after ${sweep.reviewed} of ${sweep.total}.`,
      })
      .where(and(eq(contactAiSweeps.id, sweep.id), isNull(contactAiSweeps.finishedAt)))
      .returning({ reviewed: contactAiSweeps.reviewed });
    if (!done) throw HfosError.conflict('It has already stopped.', 'contact_ai_stopped');
    await ctx.emit({
      type: 'contact_ai.sweep_cancelled',
      entityType: 'contact_ai_sweep',
      entityId: sweep.id,
      payload: { sweepId: sweep.id },
      before: { status: 'running' },
      after: {
        status: 'cancelled',
        reviewed: sweep.reviewed,
        total: sweep.total,
        changed: sweep.changed,
      },
    });
    return { sweepId: sweep.id, reviewed: done.reviewed };
  },
});

export const contactAiCommands = [contactAiStartSweep, contactAiCancelSweep];
