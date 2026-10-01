/**
 * The client's tasks, step 12 (HANDSFREEOS_REAL_ESTATE_IMPLEMENTATION_PLAN.md, "Round two: Buyer core"): what the
 * agent asks the client to do themselves in their portal. Chris decided: the client does their own tasks, upload a
 * preapproval or an ID and sign off.
 *
 * - **A task** is an upload, a sign-off on exact words, or something to do; for one client or every client on the
 *   deal. The usual ones are ready made (`CLIENT_TASK_PRESETS`).
 * - **Done**: a sign-off once every client it's for has signed off, word for word; anything else once one has.
 *   Someone on the team can mark it done for a client, with a note (an ID handed over at the office).
 * - **An upload** of a kind of document becomes one of the deal's documents, so it can prove its duty.
 */
import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { rows, sql } from '@hfos/db/client';
import { HfosError } from '../../../errors';
import { changeMoment } from '../../../kernel/moment';
import type { CommandContext } from '../../../kernel/types';
import { defineAddonCommand, defineAddonQuery } from '../../server';
import {
  CLIENT_TASK_PRESETS,
  taskDone,
  waitingWords,
  withAgent,
  type ClientTaskKind,
} from '../client-words';
import { realestateAddon } from '../manifest';
import {
  ClientTaskAddInput,
  ClientTaskAddOutput,
  ClientTaskCancelInput,
  ClientTaskChangeOutput,
  ClientTaskMarkDoneInput,
  ClientTasksInput,
  ClientTasksOutput,
} from '../schemas';
import { clientTaskCompletions, clientTasks, documents } from '../tables';
import {
  actorKind,
  actorUserId,
  dealLine,
  historyLine,
  inWorkspace,
  loadDeal,
  requireNotArchived,
  requireOpen,
  userNames,
  type Ctx,
  type Deal,
} from './common';
import { documentProof, PROOF_EVENTS } from './proof-hooks';

type Task = typeof clientTasks.$inferSelect;

/** The deal's clients, by id, with their first names. */
export async function dealClients(
  ctx: Ctx,
  dealId: string,
): Promise<{ id: string; firstName: string; name: string; email: string | null }[]> {
  return rows<{ id: string; firstName: string; name: string; email: string | null }>(
    ctx.tx,
    sql`select p.id, p.first_name as "firstName", btrim(concat_ws(' ', p.first_name, p.last_name)) as name,
          p.email::text as email
        from app.relationships rel
        join app.relationship_types rt on rt.id = rel.type_id and rt.addon_key = 'realestate_client'
        join app.people p on p.id = rel.a_person_id
        where rel.b_custom_record_id = ${dealId}
        order by rel.created_at`,
  );
}

export async function loadTask(ctx: Ctx, taskId: string, lock = false): Promise<Task> {
  const q = ctx.tx
    .select()
    .from(clientTasks)
    .where(and(eq(clientTasks.id, taskId), eq(clientTasks.workspaceId, ctx.scope.workspaceId!)));
  const [t] = lock ? await q.for('update') : await q;
  if (!t)
    throw HfosError.notFound('That task isn’t there anymore. Refresh to see the deal’s tasks.');
  return t;
}

/**
 * One client's part of a task: kept, the task done once it is (and an upload of a kind of document made one of the
 * deal's documents). Whoever records it: the client in their portal, or someone on the team for them.
 */
export async function completeTask(
  ctx: CommandContext,
  deal: Deal,
  task: Task,
  personId: string,
  part: { fileId?: string | null; signedWords?: string | null; note?: string | null },
): Promise<'open' | 'done'> {
  const at = changeMoment(ctx.meta);
  await ctx.tx
    .insert(clientTaskCompletions)
    .values({
      workspaceId: task.workspaceId,
      dealRecordId: task.dealRecordId,
      taskId: task.id,
      personId,
      fileId: part.fileId ?? null,
      signedWords: part.signedWords ?? null,
      recordedBy: actorKind(ctx) === 'client' ? null : actorUserId(ctx),
      note: part.note ?? null,
      at,
    })
    .onConflictDoUpdate({
      target: [clientTaskCompletions.taskId, clientTaskCompletions.personId],
      set: {
        fileId: part.fileId ?? null,
        signedWords: part.signedWords ?? null,
        note: part.note ?? null,
        at,
      },
    });
  if (task.kind === 'upload' && task.documentKind && part.fileId) {
    const [file] = await rows<{ name: string }>(
      ctx.tx,
      sql`select name from app.files where id = ${part.fileId}`,
    );
    const [doc] = await ctx.tx
      .insert(documents)
      .values({
        workspaceId: task.workspaceId,
        dealRecordId: task.dealRecordId,
        fileId: part.fileId,
        kind: task.documentKind,
        title: file?.name ?? task.title,
        lineageId: randomUUID(),
      })
      .returning({ id: documents.id });
    // The preapproval letter is B-02's proof, the signed agreement X-01's.
    await documentProof(ctx, deal, doc!.id);
  }
  const done = await ctx.tx
    .select({ personId: clientTaskCompletions.personId })
    .from(clientTaskCompletions)
    .where(eq(clientTaskCompletions.taskId, task.id));
  const clients = await dealClients(ctx, deal.recordId);
  const finished = taskDone(
    task,
    clients.map((c) => c.id),
    done.map((d) => d.personId),
  );
  const who = clients.find((c) => c.id === personId);
  await historyLine(ctx, deal, 'client_task_part', {
    after: { title: task.title, name: who?.firstName ?? 'The client', kind: task.kind },
  });
  if (finished && task.status === 'open') {
    await ctx.tx
      .update(clientTasks)
      .set({ status: 'done', doneAt: at, updatedAt: new Date() })
      .where(eq(clientTasks.id, task.id));
    const eventId = await ctx.emit({
      type: 'realestate.client_task.done',
      entityType: 'realestate_deal',
      entityId: deal.recordId,
      payload: {
        taskId: task.id,
        kind: task.kind,
        documentKind: task.documentKind,
        by: actorKind(ctx),
      },
      after: { title: task.title },
    });
    await dealLine(ctx, deal, `finished “${task.title}”`.slice(0, 300), { eventId, personId });
  }
  return finished ? 'done' : 'open';
}

// ---------- the team's commands ----------

export const clientTaskAdd = defineAddonCommand(realestateAddon, {
  name: 'realestate.client_task.add',
  description:
    'Give a deal’s client something to do in their portal: upload a document (a preapproval letter, an ID), sign off on words, or do something; for one client or all of them.',
  risk: 1,
  input: ClientTaskAddInput,
  output: ClientTaskAddOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  ai: {
    tool: 'realestate_add_client_task',
    description:
      'Give a buyer something to do in their portal: upload a document, sign off, or do something.',
  },
  emits: ['realestate.client_task.added'],
  async handler(ctx, input) {
    const deal = await loadDeal(ctx, input.dealId, { lock: true });
    requireOpen(deal);
    const clients = await dealClients(ctx, deal.recordId);
    if (!clients.length)
      throw HfosError.rule(
        'realestate_no_client',
        409,
        `${deal.name} has no client yet. Add the client on the deal first, then give them a task.`,
      );
    if (input.forPersonId && !clients.some((c) => c.id === input.forPersonId))
      throw HfosError.rule(
        'realestate_not_client',
        409,
        `That person isn’t a client on ${deal.name}. Add them as a client on the deal first.`,
      );
    const names = await userNames(ctx, [deal.ownerUserId]);
    const agent = (names.get(deal.ownerUserId ?? '') ?? 'your agent').split(/\s+/)[0]!;
    const preset = input.preset ? CLIENT_TASK_PRESETS[input.preset] : null;
    const kind = (input.kind ?? preset?.kind) as ClientTaskKind;
    const signOff =
      input.signOffWords ??
      (preset && 'signOffWords' in preset ? withAgent(preset.signOffWords, agent) : null);
    if (kind === 'sign_off' && !signOff)
      throw HfosError.validation(
        [{ path: 'signOffWords', message: 'Write the words the client signs off on.' }],
        'Write the words the client signs off on.',
      );
    const [row] = await ctx.tx
      .insert(clientTasks)
      .values({
        workspaceId: deal.workspaceId,
        dealRecordId: deal.recordId,
        kind,
        title: input.title ?? preset!.title,
        detail: input.detail ?? (preset ? withAgent(preset.detail, agent) : null),
        signOffWords: kind === 'sign_off' ? signOff : null,
        forPersonId: input.forPersonId ?? null,
        dueOn: input.dueOn ?? null,
        documentKind:
          kind === 'upload' ? (input.documentKind ?? preset?.documentKind ?? null) : null,
        createdBy: actorUserId(ctx),
      })
      .returning({ id: clientTasks.id, title: clientTasks.title });
    await historyLine(ctx, deal, 'client_task_added', { after: { title: row!.title } });
    await ctx.emit({
      type: 'realestate.client_task.added',
      entityType: 'realestate_deal',
      entityId: deal.recordId,
      payload: { taskId: row!.id, kind, forPersonId: input.forPersonId ?? null },
    });
    return { taskId: row!.id };
  },
});

export const clientTaskCancel = defineAddonCommand(realestateAddon, {
  name: 'realestate.client_task.cancel',
  description: 'Take back a task given to the client, with the reason. It leaves their portal.',
  risk: 1,
  input: ClientTaskCancelInput,
  output: ClientTaskChangeOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  emits: ['realestate.client_task.changed'],
  async handler(ctx, input) {
    const task = await loadTask(ctx, input.taskId, true);
    const deal = await loadDeal(ctx, task.dealRecordId);
    requireNotArchived(deal);
    if (task.status !== 'open')
      throw HfosError.rule(
        'realestate_task_settled',
        409,
        task.status === 'done'
          ? `“${task.title}” is already done.`
          : `“${task.title}” was already taken back.`,
      );
    await ctx.tx
      .update(clientTasks)
      .set({ status: 'canceled', canceledReason: input.reason, updatedAt: new Date() })
      .where(eq(clientTasks.id, task.id));
    await historyLine(ctx, deal, 'client_task_canceled', {
      after: { title: task.title },
      note: input.reason,
    });
    await ctx.emit({
      type: 'realestate.client_task.changed',
      entityType: 'realestate_deal',
      entityId: deal.recordId,
      payload: { taskId: task.id, status: 'canceled' },
    });
    return { taskId: task.id, status: 'canceled' as const };
  },
});

export const clientTaskMarkDone = defineAddonCommand(realestateAddon, {
  name: 'realestate.client_task.mark_done',
  description:
    'Mark a client’s part of a task done for them, with a note (an ID handed over at the office). A sign-off is the client’s own, in their portal.',
  risk: 1,
  input: ClientTaskMarkDoneInput,
  output: ClientTaskChangeOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  emits: ['realestate.client_task.done', ...PROOF_EVENTS],
  async handler(ctx, input) {
    if (actorKind(ctx) !== 'person')
      throw HfosError.forbidden(
        'Only a person marks a client’s task done for them, from the deal’s page.',
      );
    const task = await loadTask(ctx, input.taskId, true);
    const deal = await loadDeal(ctx, task.dealRecordId, { lock: true });
    requireOpen(deal);
    if (task.status !== 'open')
      throw HfosError.rule('realestate_task_settled', 409, `“${task.title}” isn’t open any more.`);
    if (task.kind === 'sign_off')
      throw HfosError.rule(
        'realestate_sign_off_own',
        409,
        'A sign-off is the client’s own: they agree to its words in their portal. Invite them to the portal if they aren’t in it.',
      );
    const clients = await dealClients(ctx, deal.recordId);
    if (
      !clients.some((c) => c.id === input.personId) ||
      (task.forPersonId && task.forPersonId !== input.personId)
    )
      throw HfosError.rule(
        'realestate_not_client',
        409,
        `That task isn’t for that person on ${deal.name}.`,
      );
    if (input.fileId) {
      const [f] = await rows<{ id: string }>(
        ctx.tx,
        sql`select id from app.files where id = ${input.fileId} and record_type = 'custom_record'
              and record_id = ${deal.recordId} and status = 'ready'`,
      );
      if (!f)
        throw HfosError.notFound(
          `That file isn’t on ${deal.name}. Upload it to the deal, then pick it.`,
        );
    }
    const status = await completeTask(ctx, deal, task, input.personId, {
      fileId: input.fileId ?? null,
      note: input.note,
    });
    return { taskId: task.id, status };
  },
});

// ---------- the query ----------

export const clientTasksList = defineAddonQuery(realestateAddon, {
  name: 'realestate.client_tasks',
  description:
    'What a deal’s clients do themselves in their portal: each task, who it’s waiting on, what each client did; and whether each client has the portal.',
  input: ClientTasksInput,
  output: ClientTasksOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  ai: {
    tool: 'realestate_client_tasks',
    description: 'What a deal’s clients still have to do in their portal, and what they’ve done.',
  },
  async handler(ctx, input) {
    const deal = await loadDeal(ctx, input.dealId);
    const list = await ctx.tx
      .select()
      .from(clientTasks)
      .where(
        and(
          eq(clientTasks.dealRecordId, deal.recordId),
          ...(input.includeCanceled ? [] : [inArray(clientTasks.status, ['open', 'done'])]),
        ),
      )
      .orderBy(asc(clientTasks.createdAt));
    const parts = list.length
      ? await ctx.tx
          .select()
          .from(clientTaskCompletions)
          .where(
            inArray(
              clientTaskCompletions.taskId,
              list.map((t) => t.id),
            ),
          )
      : [];
    const fileIds = parts.map((p) => p.fileId).filter((x): x is string => !!x);
    const filesById = new Map(
      (fileIds.length
        ? await rows<{ id: string; name: string }>(
            ctx.tx,
            sql`select id, name from app.files where id = any(${`{${fileIds.join(',')}}`}::uuid[])`,
          )
        : []
      ).map((f) => [f.id, f.name]),
    );
    const clients = await dealClients(ctx, deal.recordId);
    const names = await userNames(
      ctx,
      parts.map((p) => p.recordedBy),
    );
    const access = clients.length
      ? await rows<{ person_id: string; revoked: boolean; used: boolean; given_at: Date }>(
          ctx.tx,
          sql`select person_id, revoked_at is not null as revoked, last_used_at is not null as used, given_at
              from app.portal_access where workspace_id = ${deal.workspaceId}
                and person_id = any(${`{${clients.map((c) => c.id).join(',')}}`}::uuid[])`,
        )
      : [];
    return {
      tasks: list.map((t) => {
        const mine = parts.filter((p) => p.taskId === t.id);
        return {
          id: t.id,
          kind: t.kind,
          title: t.title,
          detail: t.detail,
          signOffWords: t.signOffWords,
          forPersonId: t.forPersonId,
          dueOn: t.dueOn,
          status: t.status,
          doneAt: t.doneAt?.toISOString() ?? null,
          waiting:
            t.status === 'open'
              ? waitingWords(
                  t,
                  clients,
                  mine.map((p) => p.personId),
                )
              : null,
          completions: mine.map((p) => ({
            personId: p.personId,
            name: clients.find((c) => c.id === p.personId)?.name ?? 'A client',
            at: p.at.toISOString(),
            file: p.fileId ? { id: p.fileId, name: filesById.get(p.fileId) ?? 'File' } : null,
            signedWords: p.signedWords,
            recordedBy: p.recordedBy
              ? { id: p.recordedBy, fullName: names.get(p.recordedBy) ?? 'Former member' }
              : null,
            note: p.note,
          })),
        };
      }),
      clients: clients.map((c) => {
        const a = access.find((x) => x.person_id === c.id);
        return {
          personId: c.id,
          name: c.name,
          email: c.email,
          portal: !a
            ? ('none' as const)
            : a.revoked
              ? ('revoked' as const)
              : a.used
                ? ('signed_in' as const)
                : ('invited' as const),
          portalSince: a && !a.revoked ? new Date(a.given_at).toISOString() : null,
        };
      }),
    };
  },
});

export const clientTaskCommands = [clientTaskAdd, clientTaskCancel, clientTaskMarkDone] as const;
export const clientTaskQueries = [clientTasksList] as const;
