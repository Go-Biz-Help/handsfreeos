/**
 * The 19 actions a step can take.
 *
 * Internal ones run their command as the workflow inside the step's own transaction (executeCommandIn, in a
 * savepoint), so the step's row, the command's writes and its events commit together, and a refusal leaves
 * the transaction usable to record it. Texts and emails go through texting.ts; "Notify the team" and outgoing
 * webhooks leave the transaction (slow work). Templates render first: a variable with no value and no default
 * skips the step as missing_variable. A test run renders everything and executes nothing (Simulate), or only
 * reaches the tester (Send to me).
 */
import {
  activityLog,
  conversationAssign,
  conversationClose,
  executeCommandIn,
  HfosError,
  isWorkspaceUser,
  leadCreate,
  leadMoveStage,
  leadSetNextAction,
  leadUpdate,
  personUpdate,
  recordSetTags,
  render,
  taskComplete,
  taskCreate,
  type ActionStep,
  type AssignTo,
  type CommandDef,
  type NotifyWho,
} from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import type { z } from 'zod';
import { workspaceManagers } from '../handlers/telephony';
import { LIVE_STATUSES, MAX_DEPTH } from './constants';
import { RunData } from './data';
import { versionDefinition } from './defs';
import { notifyTeamEmail } from './emails';
import { enrol } from './enrol';
import { stopRuns } from './runs';
import { sendEmailAction, sendTextAction } from './texting';
import { isRefusal, refusedFrom, type ExecCtx, type Json, type Outcome } from './types';
import { addDuration } from './waits';
import { webhookWork } from './webhooks';

type Ran = { readonly output: Record<string, unknown>; readonly eventIds: readonly string[] };

/** A command as the workflow, in the step's transaction. A refusal comes back; anything else throws. */
async function exec<I extends z.ZodType, O extends z.ZodType>(
  ec: ExecCtx,
  cmd: CommandDef<I, O>,
  input: Record<string, unknown>,
): Promise<Ran | HfosError> {
  try {
    const r = await executeCommandIn(ec.tx, cmd, input, ec.actor, ec.meta);
    return { output: r.output as Record<string, unknown>, eventIds: r.eventIds };
  } catch (e) {
    if (isRefusal(e)) return e;
    throw e;
  }
}

const skipped = (reason: string, input?: Json, output?: Json): Outcome => ({
  kind: 'skipped',
  reason,
  ...(input ? { input } : {}),
  ...(output ? { output } : {}),
});

const simulated = (input: Json, output: Json = {}): Outcome => ({
  kind: 'done',
  input,
  output: { simulated: true, ...output },
});

const done = (r: Ran, input: Json, output: Json, extra: Partial<Outcome> = {}): Outcome =>
  ({ kind: 'done', input, output, eventIds: r.eventIds, ...extra }) as Outcome;

/** A workspace id, or null when a placeholder was never mapped. */
const idOf = (ref: unknown): string | null => (typeof ref === 'string' ? ref : null);

const unmapped = (what: string, input?: Json): Outcome => ({
  kind: 'refused',
  error: {
    message: `This step names a ${what} that isn’t set for this business yet.`,
    rule: 'unmapped_placeholder',
    code: 'rule_violation',
  },
  ...(input ? { input } : {}),
});

/** Renders templates with the records they name; `missing` lists variables with no value and no default. */
async function renderAll(
  ec: ExecCtx,
  fields: Record<string, string | null | undefined>,
): Promise<{ values: Record<string, string>; missing: string[] }> {
  const present = Object.entries(fields).filter(
    (e): e is [string, string] => typeof e[1] === 'string',
  );
  await ec.data.need(RunData.templatePaths(...present.map(([, t]) => t)));
  const values: Record<string, string> = {};
  const missing = new Set<string>();
  for (const [k, t] of present) {
    const r = render(t, (p) => ec.data.value(p), { timeZone: ec.timeZone });
    values[k] = r.text.trim();
    for (const m of r.missing) missing.add(m);
  }
  return { values, missing: [...missing] };
}

const missingVariable = (missing: string[], input: Json): Outcome =>
  skipped('missing_variable', input, { missing });

async function assignee(ec: ExecCtx, a: AssignTo): Promise<{ userId: string | null } | null> {
  switch (a.kind) {
    case 'user': {
      const id = idOf(a.userId);
      return id ? { userId: id } : null;
    }
    case 'lead_assignee':
      return { userId: (await ec.data.lead())?.assignee_user_id ?? null };
    case 'person_owner':
      return { userId: (await ec.data.person())?.owner_user_id ?? null };
    case 'nobody':
      return { userId: null };
  }
}

async function usersById(ec: ExecCtx, ids: readonly string[]) {
  const list: { id: string; email: string; name: string }[] = [];
  for (const id of new Set(ids)) {
    if (!(await isWorkspaceUser(ec.tx, ec.scope.workspaceId, id))) continue;
    const [u] = await rows<{ id: string; email: string; name: string }>(
      ec.tx,
      sql`select id, email::text as email, coalesce(nullif(full_name, ''), email::text) as name
          from app.users where id = ${id}`,
    );
    if (u) list.push(u);
  }
  return list;
}

/** The people "Notify the team" reaches. */
async function recipients(ec: ExecCtx, who: NotifyWho) {
  switch (who.kind) {
    case 'admins':
      return (await workspaceManagers(ec.tx, ec.scope.workspaceId)).map((u) => ({
        id: u.id,
        email: u.email,
        name: u.full_name || u.email,
      }));
    case 'users':
      return usersById(
        ec,
        who.userIds.map(idOf).filter((v): v is string => v !== null),
      );
    case 'lead_assignee': {
      const id = (await ec.data.lead())?.assignee_user_id;
      return id ? usersById(ec, [id]) : [];
    }
    case 'person_owner': {
      const id = (await ec.data.person())?.owner_user_id;
      return id ? usersById(ec, [id]) : [];
    }
  }
}

/** The customer's conversation on a channel ('latest': whichever they used last), the run's own first. */
async function conversationFor(
  ec: ExecCtx,
  channel: 'sms' | 'email' | 'latest',
): Promise<string | null> {
  if (!ec.run.personId) return ec.run.conversationId;
  const [c] = await rows<{ id: string }>(
    ec.tx,
    sql`select id from app.conversations
        where workspace_id = ${ec.scope.workspaceId} and person_id = ${ec.run.personId}
          ${channel === 'latest' ? sql`` : sql`and channel = ${channel}`}
        order by (id = ${ec.run.conversationId ?? '00000000-0000-0000-0000-000000000000'}::uuid) desc,
          last_message_at desc nulls last
        limit 1`,
  );
  return c?.id ?? null;
}

function tasksOf(context: Json): Record<string, string> {
  const t = context['tasks'];
  if (typeof t !== 'object' || t === null || Array.isArray(t)) return {};
  return Object.fromEntries(
    Object.entries(t).filter((e): e is [string, string] => typeof e[1] === 'string'),
  );
}

/** Runs the step's action. */
export async function runAction(ec: ExecCtx): Promise<Outcome> {
  const step = ec.step as ActionStep;
  const ws = ec.scope.workspaceId;
  const test = ec.testMode !== null;
  const run = ec.run;

  switch (step.action) {
    case 'send_text': {
      ec.data.useBookingCalendar(idOf(step.config.bookingCalendarId));
      const r = await renderAll(ec, { body: step.config.body });
      if (r.missing.length) return missingVariable(r.missing, { body: r.values['body'] });
      return sendTextAction(ec, r.values['body']!);
    }

    case 'send_email': {
      ec.data.useBookingCalendar(idOf(step.config.bookingCalendarId));
      const r = await renderAll(ec, { subject: step.config.subject, body: step.config.body });
      if (r.missing.length) return missingVariable(r.missing, r.values);
      return sendEmailAction(ec, r.values['subject']!, r.values['body']!);
    }

    case 'update_person': {
      const r = await renderAll(
        ec,
        Object.fromEntries(step.config.fields.map((f) => [f.field, f.value])),
      );
      if (r.missing.length) return missingVariable(r.missing, r.values);
      if (!run.personId) return skipped('no_person', r.values);
      if (test) return simulated({ action: 'update_person', fields: r.values });
      const orNull = (v: string) => (v.trim() ? v.trim() : null);
      const input: Record<string, unknown> = { workspaceId: ws, personId: run.personId };
      for (const [field, value] of Object.entries(r.values)) {
        if (field === 'first_name') input['firstName'] = value;
        else if (field === 'last_name') input['lastName'] = value;
        else if (field === 'email') input['email'] = orNull(value);
        else if (field === 'phone') input['phone'] = orNull(value);
        else if (field === 'city') input['address'] = { city: orNull(value) };
        else if (field === 'source') input['source'] = orNull(value);
        else if (field === 'notes') input['notes'] = orNull(value);
      }
      const res = await exec(ec, personUpdate, input);
      if (res instanceof HfosError) return refusedFrom(res, r.values);
      return done(res, r.values, { updated: res.output['updated'] ?? [] });
    }

    case 'add_tag':
    case 'remove_tag': {
      const tagId = idOf(step.config.tagId);
      if (!tagId) return unmapped('tag');
      const target = step.config.target;
      const recordId = target === 'lead' ? run.leadId : run.personId;
      const input = { tagId, target, mode: step.action === 'add_tag' ? 'add' : 'remove' };
      if (!recordId) return skipped(target === 'lead' ? 'no_lead' : 'no_person', input);
      if (test) return simulated(input);
      const res = await exec(ec, recordSetTags, {
        workspaceId: ws,
        recordType: target,
        recordId,
        tagIds: [tagId],
        mode: input.mode,
      });
      if (res instanceof HfosError) return refusedFrom(res, input);
      const tags = (res.output['tags'] as { id: string }[] | undefined) ?? [];
      return done(res, input, { tagIds: tags.map((t) => t.id) });
    }

    case 'create_lead': {
      const pipelineId = idOf(step.config.pipelineId);
      const stageId = idOf(step.config.stageId);
      if (!pipelineId || !stageId) return unmapped('pipeline stage');
      const r = await renderAll(ec, { title: step.config.title });
      if (r.missing.length) return missingVariable(r.missing, r.values);
      if (!run.personId) return skipped('no_person', r.values);
      const who = await assignee(ec, step.config.assignTo);
      if (!who) return unmapped('person to assign');
      const input = { title: r.values['title'], pipelineId, stageId, assigneeUserId: who.userId };
      if (test) return simulated(input);
      const res = await exec(ec, leadCreate, {
        workspaceId: ws,
        title: r.values['title'],
        personId: run.personId,
        pipelineId,
        stageId,
        valueCents: step.config.value === null ? 0 : Math.round(step.config.value * 100),
        assigneeUserId: who.userId,
      });
      if (res instanceof HfosError) return refusedFrom(res, input);
      const leadId = String(res.output['leadId']);
      return done(
        res,
        input,
        { leadId },
        {
          context: { leads: { [step.id]: leadId } },
          ...(run.leadId ? {} : { refs: { leadId } }),
        },
      );
    }

    case 'move_lead_stage': {
      const stageId = idOf(step.config.stageId);
      if (!stageId) return unmapped('stage');
      const input = { stageId, lostReason: step.config.lostReason };
      if (!run.leadId) return skipped('no_lead', input);
      if (test) return simulated(input);
      const res = await exec(ec, leadMoveStage, {
        workspaceId: ws,
        leadId: run.leadId,
        stageId,
        ...(step.config.lostReason ? { lostReason: step.config.lostReason } : {}),
      });
      if (res instanceof HfosError) return refusedFrom(res, input);
      return done(res, input, { stageId, status: res.output['status'] });
    }

    case 'assign_lead': {
      const who = await assignee(ec, step.config.assignTo);
      if (!who) return unmapped('person to assign');
      const input = { assigneeUserId: who.userId };
      if (!run.leadId) return skipped('no_lead', input);
      if (test) return simulated(input);
      const res = await exec(ec, leadUpdate, {
        workspaceId: ws,
        leadId: run.leadId,
        assigneeUserId: who.userId,
      });
      if (res instanceof HfosError) return refusedFrom(res, input);
      return done(res, input, { updated: res.output['updated'] ?? [] });
    }

    case 'set_next_action': {
      const r = await renderAll(ec, { text: step.config.text });
      if (r.missing.length) return missingVariable(r.missing, r.values);
      const dueAt = step.config.due
        ? new Date(addDuration(ec.now, step.config.due, ec.timeZone)).toISOString()
        : null;
      const input = { text: r.values['text'], dueAt };
      if (!run.leadId) return skipped('no_lead', input);
      if (test) return simulated(input);
      const res = await exec(ec, leadSetNextAction, {
        workspaceId: ws,
        leadId: run.leadId,
        text: r.values['text'],
        dueAt,
      });
      if (res instanceof HfosError) return refusedFrom(res, input);
      return done(res, input, { nextAction: r.values['text'], dueAt });
    }

    case 'create_task': {
      const r = await renderAll(ec, { title: step.config.title, notes: step.config.notes });
      if (r.missing.length) return missingVariable(r.missing, r.values);
      const who = await assignee(ec, step.config.assignTo);
      if (!who) return unmapped('person to assign');
      const dueAt = step.config.due
        ? new Date(addDuration(ec.now, step.config.due, ec.timeZone)).toISOString()
        : null;
      const input = { ...r.values, dueAt, assigneeUserId: who.userId };
      if (test) return simulated(input);
      const res = await exec(ec, taskCreate, {
        workspaceId: ws,
        title: r.values['title'],
        ...(r.values['notes'] ? { notes: r.values['notes'] } : {}),
        dueAt,
        allDay: dueAt === null,
        assigneeUserId: who.userId,
        personId: run.personId,
        leadId: run.leadId,
      });
      if (res instanceof HfosError) return refusedFrom(res, input);
      const taskId = String(res.output['taskId']);
      return done(res, input, { taskId }, { context: { tasks: { [step.id]: taskId } } });
    }

    case 'complete_task': {
      const tasks = tasksOf(ec.context);
      const wanted = step.config.taskStepId
        ? [tasks[step.config.taskStepId]]
        : Object.values(tasks);
      const ids = wanted.filter((v): v is string => !!v);
      const input = { taskStepId: step.config.taskStepId, taskIds: ids };
      if (!ids.length) return skipped('no_task', input);
      if (test) return simulated(input);
      const eventIds: string[] = [];
      const completed: string[] = [];
      for (const taskId of ids) {
        const res = await exec(ec, taskComplete, { workspaceId: ws, taskId });
        if (res instanceof HfosError) {
          if (res.code === 'not_found') continue;
          return refusedFrom(res, input);
        }
        eventIds.push(...res.eventIds);
        completed.push(taskId);
      }
      return { kind: 'done', input, output: { completed }, eventIds };
    }

    case 'add_note': {
      const r = await renderAll(ec, { body: step.config.body });
      if (r.missing.length) return missingVariable(r.missing, r.values);
      if (!run.personId && !run.leadId) return skipped('no_person', r.values);
      if (test) return simulated(r.values);
      const res = await exec(ec, activityLog, {
        workspaceId: ws,
        kind: 'note',
        body: r.values['body'],
        personId: run.personId,
        leadId: run.leadId,
      });
      if (res instanceof HfosError) return refusedFrom(res, r.values);
      return done(res, r.values, { activityId: res.output['activityId'] });
    }

    case 'assign_conversation':
    case 'close_conversation': {
      const who =
        step.action === 'assign_conversation' ? await assignee(ec, step.config.assignTo) : null;
      if (step.action === 'assign_conversation' && !who) return unmapped('person to assign');
      const conversationId = await conversationFor(ec, step.config.channel);
      const input = {
        channel: step.config.channel,
        conversationId,
        ...(who ? { assigneeUserId: who.userId } : {}),
      };
      if (!conversationId) return skipped('no_conversation', input);
      if (test) return simulated(input);
      const res =
        step.action === 'assign_conversation'
          ? await exec(ec, conversationAssign, {
              workspaceId: ws,
              conversationId,
              assigneeUserId: who!.userId,
            })
          : await exec(ec, conversationClose, { workspaceId: ws, conversationId });
      if (res instanceof HfosError) return refusedFrom(res, input);
      return done(res, input, { conversationId });
    }

    case 'notify_team': {
      const r = await renderAll(ec, { message: step.config.message });
      if (r.missing.length) return missingVariable(r.missing, r.values);
      const people = await recipients(ec, step.config.who);
      const input = { message: r.values['message'], to: people.map((p) => p.email) };
      if (test) return simulated(input, { would: step.config.email ? 'email' : 'nothing' });
      if (!people.length) return skipped('no_recipients', input);
      if (!step.config.email) return { kind: 'done', input, output: { email: false } };
      await ec.data.need(['business.name']);
      const mail = notifyTeamEmail({
        workflow: ec.workflow.name,
        business: String(ec.data.value('business.name') ?? ''),
        message: r.values['message']!,
        link: `${ec.s.webUrl}/app/w/${ws}/workflows/runs/${run.id}`,
      });
      return {
        kind: 'slow',
        input,
        work: {
          kind: 'mail',
          messages: people.map((p) => ({ to: p.email, ...mail })),
          output: { emailed: people.map((p) => p.email) },
        },
      };
    }

    case 'webhook_out':
      return webhookWork(ec, step.config);

    case 'enrol_workflow': {
      const target = idOf(step.config.workflowId);
      if (!target) return unmapped('workflow');
      const input = { workflowId: target };
      if (target === run.workflowId) return skipped('same_workflow', input);
      if (!run.personId) return skipped('no_person', input);
      const depth = run.depth + 1;
      if (depth > MAX_DEPTH) return skipped('depth_limit', input);
      if (test) return simulated(input);
      const [wf] = await rows<{ id: string; name: string; status: string; version: string | null }>(
        ec.tx,
        sql`select id, name, status::text as status, active_version_id as version from app.workflows
            where id = ${target} and workspace_id = ${ws}`,
      );
      if (!wf || wf.status !== 'active' || !wf.version)
        return skipped('workflow_not_active', input);
      const res = await enrol(ec.tx, {
        scope: ec.scope,
        workflow: { id: wf.id, name: wf.name },
        versionId: wf.version,
        def: await versionDefinition(ec.tx, wf.version),
        personId: run.personId,
        leadId: run.leadId,
        appointmentId: run.appointmentId,
        conversationId: run.conversationId,
        dedupeKey: `run:${run.id}:${ec.stepKey}`,
        depth,
        originRunId: run.originRunId ?? run.id,
        context: {
          trigger: { event: 'workflow', fromWorkflowId: run.workflowId, fromRunId: run.id },
        },
        log: ec.log,
      });
      if ('runId' in res) return { kind: 'done', input, output: { runId: res.runId } };
      return res.skipped === 'already'
        ? { kind: 'done', input, output: { already: true } }
        : skipped(res.skipped, input);
    }

    case 'remove_from_workflow': {
      const target = idOf(step.config.workflowId);
      if (!target) return unmapped('workflow');
      const input = { workflowId: target };
      if (!run.personId) return skipped('no_person', input);
      if (test) return simulated(input);
      const live = await rows<{ id: string }>(
        ec.tx,
        sql`select id from app.workflow_runs
            where workspace_id = ${ws} and workflow_id = ${target} and person_id = ${run.personId}
              and id <> ${run.id} and not is_test
              and status in (${sql.join(
                LIVE_STATUSES.map((s) => sql`${s}::app.workflow_run_status`),
                sql`, `,
              )})`,
      );
      const stopped = await stopRuns(
        ec.tx,
        ec.scope,
        live.map((r) => r.id),
        'removed_by_workflow',
      );
      return { kind: 'done', input, output: { stopped } };
    }

    case 'hand_to_ai_teammate':
      // A placeholder until the teammate's runtime lands (M7 step 7): the step is skipped, never failed.
      return skipped('ai_teammate_not_ready', {
        goal: step.config.goal,
        firstMessage: step.config.firstMessage,
        channel: step.config.channel,
      });
  }
}
