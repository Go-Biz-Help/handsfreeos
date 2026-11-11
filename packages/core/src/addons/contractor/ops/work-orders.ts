/**
 * A visit's work order (docs/contractor.md, "Crews and work orders"): its instructions and what to bring, the crew
 * it's given to, its subcontractors, and its checklist of boxes to tick and photos to add. A visit is core's
 * appointment, so who on the team is going is core's too: putting a crew on a visit changes its people through
 * core's own command (`appointment.reassign`), with its warnings.
 *
 * A job can't be marked Done while a required item is left on one of its visits (the owner's decision 8; the check
 * is in ./jobs.ts). Subcontractors are texted the job's details through core's own send (`message.send`), so
 * consent, quiet hours and the conversation are core's.
 *
 * A work order changes only while its job is open and its visit isn't cancelled.
 */
import { and, eq, sql as dsql } from 'drizzle-orm';
import { rows, sql } from '@hfos/db/client';
import { fmtAt } from '../../../calendar/when';
import { appointmentReassign } from '../../../commands/appointment';
import { messageSend } from '../../../commands/message';
import { HfosError } from '../../../errors';
import { userIdOf } from '../../../kernel/actor';
import { executeCommandWithin } from '../../../kernel/execute';
import type { CommandContext } from '../../../kernel/types';
import { defineAddonCommand, defineAddonQuery } from '../../server';
import { checklistProgress } from '../checklists';
import { contractorAddon } from '../manifest';
import { todayIn } from '../progress';
import {
  LIMITS,
  WorkOrder,
  WorkOrderChangeOutput,
  WorkOrderGetInput,
  WorkOrderItemAddInput,
  WorkOrderItemAddOutput,
  WorkOrderItemOutput,
  WorkOrderItemRemoveInput,
  WorkOrderItemSetInput,
  WorkOrderItemUpdateInput,
  WorkOrderSetCrewInput,
  WorkOrderSetCrewOutput,
  WorkOrderStartInput,
  WorkOrderStartOutput,
  WorkOrderSubInput,
  WorkOrderSubSetInput,
  WorkOrderTellSubsInput,
  WorkOrderTellSubsOutput,
  WorkOrderUpdateInput,
} from '../schemas';
import { workOrderItems, workOrderSubs, workOrders } from '../tables';
import { CONTRACTOR_WORDS as W, namesWords, REFUSALS, subTextWords } from '../words';
import { inWorkspace, jobLine, pairsOf, subOut, subsOf, timeZoneOf, type Ctx } from './common';
import { crewMemberIds, loadCrew } from './crews';
import { materialsOf } from './materials';
import { jobsSql, rowOut } from './queries';
import {
  ensureWorkOrder,
  loadVisit,
  stageOf,
  workOrderForChange,
  workOrderOfItem,
  type StartedWorkOrder,
  type Visit,
} from './visits';

/** The most people core puts on one visit. */
const VISIT_PEOPLE = 10;

const visitPath = (appointmentId: string) => `a/contractor/visits/${appointmentId}`;
const pathOf = (io: unknown) =>
  visitPath(String((io as { appointmentId?: unknown }).appointmentId ?? ''));

/** "the visit of Fri, Sep 18 at 10:00 AM", in the business's time zone. */
const visitWords = async (ctx: Ctx, visit: Visit) =>
  `the visit of ${fmtAt(visit.startsAt.getTime(), await timeZoneOf(ctx))}`;

/** Required items still left on a work order. */
async function requiredLeftOn(ctx: Ctx, appointmentId: string): Promise<number> {
  const [{ n } = { n: 0 }] = await rows<{ n: number }>(
    ctx.tx,
    sql`select count(*)::int as n from addon_contractor.work_order_items
        where appointment_id = ${appointmentId} and required and done_at is null and skipped_at is null`,
  );
  return n;
}

/** The people on the business's team on a visit: core's own list. */
async function staffOf(ctx: Ctx, appointmentId: string) {
  const list = await rows<{ user_id: string; name: string }>(
    ctx.tx,
    sql`select s.user_id, coalesce(nullif(btrim(u.full_name), ''), u.email::text) as name
        from app.appointment_staff s join app.users u on u.id = s.user_id
        where s.appointment_id = ${appointmentId} and s.workspace_id = ${ctx.scope.workspaceId!} and s.active
        order by s.created_at, s.user_id`,
  );
  return list.map((s) => ({ userId: s.user_id, name: s.name }));
}

// ------------------------------------------------------------------------------------------------ starting one

export const workOrderStart = defineAddonCommand(contractorAddon, {
  name: 'contractor.work_order.start',
  description:
    'Start a visit’s work order, with the checklist a new visit starts with. A visit booked on a job gets one on its own; this is for one that has none yet.',
  risk: 0,
  input: WorkOrderStartInput,
  output: WorkOrderStartOutput,
  permission: 'contractor.use',
  // The worker starts one for every visit booked on a job.
  actors: ['human', 'system'],
  scope: inWorkspace,
  ai: {
    tool: 'contractor_start_work_order',
    description:
      'Start the work order of a visit on a job (by the visit’s appointment id), with the business’s starter checklist. A visit booked on a job gets one on its own within moments; this is for one that has none yet. Does nothing when it has one.',
    outcome: (output, input) => ({
      words: (output as { started?: boolean } | null)?.started
        ? 'Its work order is started.'
        : 'It has its work order already.',
      path: pathOf(input),
    }),
  },
  emits: ['contractor.work_order.started'],
  async handler(ctx, input) {
    let order: StartedWorkOrder;
    try {
      order = await ensureWorkOrder(ctx, input.appointmentId);
    } catch (e) {
      // The worker hears of every booking: one that isn't on a job, or has gone already, is none of its business.
      const quiet =
        e instanceof HfosError &&
        (e.rule === 'contractor_visit_not_on_job' || e.code === 'not_found');
      if (ctx.actor.type !== 'human' && quiet) return null;
      throw e;
    }
    return {
      appointmentId: input.appointmentId,
      jobId: order.job.recordId,
      started: order.started,
      items: order.items,
    };
  },
});

// ------------------------------------------------------------------------------------------------ what it says

export const workOrderUpdate = defineAddonCommand(contractorAddon, {
  name: 'contractor.work_order.update',
  description: 'Change a visit’s work order: its instructions, and what to bring.',
  risk: 1,
  input: WorkOrderUpdateInput,
  output: WorkOrderChangeOutput,
  permission: 'contractor.use',
  scope: inWorkspace,
  ai: {
    tool: 'contractor_update_work_order',
    description:
      'Change a visit’s work order (by the visit’s appointment id): its instructions for the crew, and what to bring. Each left out stays as it is; null clears it.',
    outcome: (_o, input) => ({ words: W.workOrder.saved, path: pathOf(input) }),
  },
  emits: ['contractor.work_order.updated', 'contractor.work_order.started'],
  async handler(ctx, input) {
    const order = await workOrderForChange(ctx, input.appointmentId);
    const [now] = await ctx.tx
      .select({ instructions: workOrders.instructions, bring: workOrders.bring })
      .from(workOrders)
      .where(eq(workOrders.appointmentId, input.appointmentId));
    const next = {
      instructions:
        input.instructions === undefined ? (now?.instructions ?? null) : input.instructions || null,
      bring: input.bring === undefined ? (now?.bring ?? null) : input.bring || null,
    };
    const changed = (['instructions', 'bring'] as const).filter(
      (k) => next[k] !== (now?.[k] ?? null),
    );
    if (!changed.length) return { appointmentId: input.appointmentId, changed: false };
    await ctx.tx
      .update(workOrders)
      .set({ ...next, updatedAt: new Date() })
      .where(eq(workOrders.appointmentId, input.appointmentId));
    await ctx.emit({
      type: 'contractor.work_order.updated',
      entityType: 'custom_record',
      entityId: order.job.recordId,
      payload: { appointmentId: input.appointmentId, jobId: order.job.recordId, changed },
      after: { visit: order.visit.title, changed: changed.join(', ') },
    });
    return { appointmentId: input.appointmentId, changed: true };
  },
});

// ------------------------------------------------------------------------------------------------ who's going

/** Subcontractors put on a visit: the ones not on it yet. Refused past the most a visit takes. */
async function addSubs(
  ctx: CommandContext,
  order: StartedWorkOrder,
  personIds: readonly string[],
): Promise<string[]> {
  if (!personIds.length) return [];
  const appointmentId = order.visit.appointmentId;
  const on = await ctx.tx
    .select({ personId: workOrderSubs.personId })
    .from(workOrderSubs)
    .where(eq(workOrderSubs.appointmentId, appointmentId));
  const have = new Set(on.map((s) => s.personId));
  const fresh = [...new Set(personIds)].filter((p) => !have.has(p));
  if (!fresh.length) return [];
  if (have.size + fresh.length > LIMITS.subs)
    throw HfosError.rule('contractor_too_many_subs', 409, REFUSALS.tooManySubs(LIMITS.subs));
  await ctx.tx.insert(workOrderSubs).values(
    fresh.map((personId) => ({
      workspaceId: ctx.scope.workspaceId!,
      appointmentId,
      recordId: order.job.recordId,
      personId,
      addedBy: userIdOf(ctx.actor),
    })),
  );
  return fresh;
}

export const workOrderSetCrew = defineAddonCommand(contractorAddon, {
  name: 'contractor.work_order.set_crew',
  description:
    'Put a crew on a visit: everyone on the team in it is booked on the visit, and its subcontractors go on the work order. Or take the crew’s name off.',
  risk: 1,
  input: WorkOrderSetCrewInput,
  output: WorkOrderSetCrewOutput,
  permission: 'contractor.use',
  scope: inWorkspace,
  ai: {
    tool: 'contractor_set_visit_crew',
    description:
      'Put a crew on a visit (by the visit’s appointment id and the crew’s id): the crew’s team members become the people booked on the visit, and its subcontractors are added to the work order. crewId null takes the crew’s name off and leaves the people. When someone in the crew is busy or off then, it says so; acknowledgeWarnings books them anyway. Asks the person first.',
    autonomy: 'confirm',
    what: (input) =>
      (input as { crewId?: string | null }).crewId === null
        ? 'Take the crew off the visit'
        : 'Put the crew on the visit',
    outcome: (output, input) => ({
      words:
        (output as { crewId?: string | null }).crewId === null
          ? W.workOrder.crewCleared
          : 'The crew is on the visit.',
      path: pathOf(input),
    }),
  },
  emits: ['contractor.work_order.crew_set', 'contractor.work_order.started'],
  async handler(ctx, input) {
    const order = await workOrderForChange(ctx, input.appointmentId);
    const { appointmentId } = order.visit;
    const [now] = await ctx.tx
      .select({ crewId: workOrders.crewId })
      .from(workOrders)
      .where(eq(workOrders.appointmentId, appointmentId));
    const staffIds = async () => (await staffOf(ctx, appointmentId)).map((s) => s.userId);
    if (input.crewId === null) {
      if (!now?.crewId)
        return { appointmentId, crewId: null, userIds: await staffIds(), subsAdded: 0 };
      await ctx.tx
        .update(workOrders)
        .set({ crewId: null, updatedAt: new Date() })
        .where(eq(workOrders.appointmentId, appointmentId));
      await ctx.emit({
        type: 'contractor.work_order.crew_set',
        entityType: 'custom_record',
        entityId: order.job.recordId,
        payload: { appointmentId, jobId: order.job.recordId, crewId: null, subsAdded: 0 },
        after: { visit: order.visit.title, crew: null },
      });
      return { appointmentId, crewId: null, userIds: await staffIds(), subsAdded: 0 };
    }
    const crew = await loadCrew(ctx, input.crewId);
    if (crew.archived) throw HfosError.notFound(REFUSALS.crewGone);
    const members = await crewMemberIds(ctx, crew.id);
    if (members.userIds.length > VISIT_PEOPLE)
      throw HfosError.rule(
        'contractor_crew_too_big',
        409,
        REFUSALS.crewTooBigForVisit(crew.name, members.userIds.length, VISIT_PEOPLE),
      );
    // Core books them, with its own checks: someone busy, off or outside their hours is a warning to book over.
    if (members.userIds.length)
      await executeCommandWithin(ctx, appointmentReassign, {
        workspaceId: ctx.scope.workspaceId!,
        appointmentId,
        userIds: members.userIds,
        acknowledgeWarnings: input.acknowledgeWarnings,
        // The customer isn't texted about who's coming every time the crew changes.
        notify: false,
      });
    const added = await addSubs(ctx, order, members.personIds);
    await ctx.tx
      .update(workOrders)
      .set({ crewId: crew.id, updatedAt: new Date() })
      .where(eq(workOrders.appointmentId, appointmentId));
    const eventId = await ctx.emit({
      type: 'contractor.work_order.crew_set',
      entityType: 'custom_record',
      entityId: order.job.recordId,
      payload: {
        appointmentId,
        jobId: order.job.recordId,
        crewId: crew.id,
        people: members.userIds.length,
        subsAdded: added.length,
      },
      after: { visit: order.visit.title, crew: crew.name },
    });
    await jobLine(
      ctx,
      order.job.recordId,
      `put ${crew.name} on ${await visitWords(ctx, order.visit)}`,
      { eventId },
    );
    return { appointmentId, crewId: crew.id, userIds: await staffIds(), subsAdded: added.length };
  },
});

export const workOrderSubAdd = defineAddonCommand(contractorAddon, {
  name: 'contractor.work_order.sub_add',
  description:
    'Put a subcontractor on a visit: a contact who doesn’t sign in, is texted the job’s details, and whose work the office marks.',
  risk: 1,
  input: WorkOrderSubInput,
  output: WorkOrderChangeOutput,
  permission: 'contractor.use',
  scope: inWorkspace,
  ai: {
    tool: 'contractor_add_visit_sub',
    description:
      'Put a subcontractor (a contact, by person id) on a visit’s work order (by the visit’s appointment id). It doesn’t text them: use contractor_text_visit_subs for that.',
    outcome: (_o, input) => ({ words: 'They’re on the visit.', path: pathOf(input) }),
  },
  emits: ['contractor.work_order.sub_added', 'contractor.work_order.started'],
  async handler(ctx, input) {
    const order = await workOrderForChange(ctx, input.appointmentId);
    const sub = (await subsOf(ctx, [input.personId])).get(input.personId);
    if (!sub) throw HfosError.notFound(REFUSALS.subGone);
    const added = await addSubs(ctx, order, [input.personId]);
    if (!added.length) return { appointmentId: input.appointmentId, changed: false };
    const eventId = await ctx.emit({
      type: 'contractor.work_order.sub_added',
      entityType: 'custom_record',
      entityId: order.job.recordId,
      payload: {
        appointmentId: input.appointmentId,
        jobId: order.job.recordId,
        personId: input.personId,
      },
      after: { visit: order.visit.title, subcontractor: sub.name },
    });
    await jobLine(
      ctx,
      order.job.recordId,
      `put ${sub.name}, a subcontractor, on ${await visitWords(ctx, order.visit)}`,
      { eventId },
    );
    return { appointmentId: input.appointmentId, changed: true };
  },
});

export const workOrderSubRemove = defineAddonCommand(contractorAddon, {
  name: 'contractor.work_order.sub_remove',
  description: 'Take a subcontractor off a visit. They aren’t told.',
  risk: 1,
  input: WorkOrderSubInput,
  output: WorkOrderChangeOutput,
  permission: 'contractor.use',
  scope: inWorkspace,
  ai: {
    tool: 'contractor_remove_visit_sub',
    description:
      'Take a subcontractor (by person id) off a visit’s work order (by the visit’s appointment id). They aren’t told, so tell them yourself if they were already texted. Asks the person first.',
    autonomy: 'confirm',
    what: () => 'Take the subcontractor off the visit',
    outcome: (_o, input) => ({ words: 'They’re off the visit.', path: pathOf(input) }),
  },
  emits: ['contractor.work_order.sub_removed', 'contractor.work_order.started'],
  async handler(ctx, input) {
    const order = await workOrderForChange(ctx, input.appointmentId);
    const gone = await ctx.tx
      .delete(workOrderSubs)
      .where(
        and(
          eq(workOrderSubs.appointmentId, input.appointmentId),
          eq(workOrderSubs.personId, input.personId),
        ),
      )
      .returning({ id: workOrderSubs.id });
    if (!gone.length) return { appointmentId: input.appointmentId, changed: false };
    const sub = (await subsOf(ctx, [input.personId])).get(input.personId);
    await ctx.emit({
      type: 'contractor.work_order.sub_removed',
      entityType: 'custom_record',
      entityId: order.job.recordId,
      payload: {
        appointmentId: input.appointmentId,
        jobId: order.job.recordId,
        personId: input.personId,
      },
      after: { visit: order.visit.title, subcontractor: sub?.name ?? null },
    });
    return { appointmentId: input.appointmentId, changed: true };
  },
});

export const workOrderSubSet = defineAddonCommand(contractorAddon, {
  name: 'contractor.work_order.sub_set',
  description:
    'Mark a subcontractor’s work on a visit done, or not done after all, with an optional note. The office marks it: they don’t sign in.',
  risk: 1,
  input: WorkOrderSubSetInput,
  output: WorkOrderChangeOutput,
  permission: 'contractor.use',
  scope: inWorkspace,
  ai: {
    tool: 'contractor_mark_visit_sub',
    description:
      'Mark a subcontractor’s work on a visit done (done: true) or not done after all (by the visit’s appointment id and the contact’s person id), with an optional note. Asks the person first.',
    autonomy: 'confirm',
    what: (input) =>
      (input as { done?: boolean }).done
        ? 'Mark the subcontractor’s work done'
        : 'Mark the subcontractor’s work not done',
    outcome: (_o, input) => ({
      words: (input as { done?: boolean }).done
        ? 'Their work is marked done.'
        : 'Their work is back to not done.',
      path: pathOf(input),
    }),
  },
  emits: ['contractor.work_order.sub_set', 'contractor.work_order.started'],
  async handler(ctx, input) {
    const order = await workOrderForChange(ctx, input.appointmentId);
    const [row] = await ctx.tx
      .select()
      .from(workOrderSubs)
      .where(
        and(
          eq(workOrderSubs.appointmentId, input.appointmentId),
          eq(workOrderSubs.personId, input.personId),
        ),
      );
    if (!row) throw HfosError.rule('contractor_sub_not_on_visit', 409, REFUSALS.subNotOnVisit);
    const note = input.note === undefined ? row.note : input.note || null;
    if ((row.doneAt !== null) === input.done && note === row.note)
      return { appointmentId: input.appointmentId, changed: false };
    await ctx.tx
      .update(workOrderSubs)
      .set({
        doneAt: input.done ? (row.doneAt ?? dsql`now()`) : null,
        doneBy: input.done ? (row.doneBy ?? userIdOf(ctx.actor)) : null,
        note,
        updatedAt: new Date(),
      })
      .where(eq(workOrderSubs.id, row.id));
    const sub = (await subsOf(ctx, [input.personId])).get(input.personId);
    const name = sub?.name ?? 'The subcontractor';
    const eventId = await ctx.emit({
      type: 'contractor.work_order.sub_set',
      entityType: 'custom_record',
      entityId: order.job.recordId,
      payload: {
        appointmentId: input.appointmentId,
        jobId: order.job.recordId,
        personId: input.personId,
        done: input.done,
      },
      after: { visit: order.visit.title, subcontractor: name, done: input.done },
    });
    if ((row.doneAt !== null) !== input.done)
      await jobLine(
        ctx,
        order.job.recordId,
        input.done
          ? `marked ${name}’s work done on ${await visitWords(ctx, order.visit)}`
          : `marked ${name}’s work not done after all on ${await visitWords(ctx, order.visit)}`,
        { eventId, body: note },
      );
    return { appointmentId: input.appointmentId, changed: true };
  },
});

export const workOrderTellSubs = defineAddonCommand(contractorAddon, {
  name: 'contractor.work_order.tell_subs',
  description:
    'Text a visit’s subcontractors the job’s details: the job, where, when, what to do and what to bring. It says who was texted and who couldn’t be, and why.',
  // It reaches people outside the business.
  risk: 2,
  input: WorkOrderTellSubsInput,
  output: WorkOrderTellSubsOutput,
  permission: 'contractor.use',
  scope: inWorkspace,
  ai: {
    tool: 'contractor_text_visit_subs',
    description:
      'Text a visit’s subcontractors (all of them, or personIds) the job’s details: the job’s name, the property’s address, when, the instructions and what to bring, with an optional note of your own. Answers who was texted and who couldn’t be, and why. In the business’s quiet hours it’s refused until the person says to send anyway (acknowledgeQuietHours). Asks the person first.',
    autonomy: 'confirm',
    what: () => 'Text the subcontractors the job’s details',
    keywords: ['subcontractor', 'text the subs', 'tell the crew'],
    outcome: (output, input) => {
      const o = output as { told?: { name: string }[]; notTold?: { name: string }[] };
      const told = (o.told ?? []).map((t) => t.name);
      const missed = (o.notTold ?? []).map((t) => t.name);
      return {
        words: [
          told.length ? W.workOrder.told(namesWords(told)) : null,
          missed.length ? `Couldn’t text ${namesWords(missed)}.` : null,
        ]
          .filter(Boolean)
          .join(' '),
        path: pathOf(input),
      };
    },
  },
  emits: ['contractor.work_order.subs_told', 'contractor.work_order.started'],
  async handler(ctx, input) {
    const order = await workOrderForChange(ctx, input.appointmentId);
    const { appointmentId } = order.visit;
    const ws = ctx.scope.workspaceId!;
    const on = await ctx.tx
      .select({ id: workOrderSubs.id, personId: workOrderSubs.personId })
      .from(workOrderSubs)
      .where(eq(workOrderSubs.appointmentId, appointmentId))
      .orderBy(workOrderSubs.createdAt, workOrderSubs.id);
    if (input.personIds?.some((p) => !on.some((s) => s.personId === p)))
      throw HfosError.rule('contractor_sub_not_on_visit', 409, REFUSALS.subNotOnVisit);
    const asked = input.personIds ? on.filter((s) => input.personIds!.includes(s.personId)) : on;
    if (!asked.length) throw HfosError.rule('contractor_no_subs', 409, REFUSALS.noSubs);

    const [order_] = await ctx.tx
      .select({ instructions: workOrders.instructions, bring: workOrders.bring })
      .from(workOrders)
      .where(eq(workOrders.appointmentId, appointmentId));
    const [business] = await rows<{ name: string }>(
      ctx.tx,
      sql`select name from app.workspaces where id = ${ws}`,
    );
    const site = (await pairsOf(ctx, order.job.recordId)).site;
    const [property] = site
      ? await rows<{ name: string }>(
          ctx.tx,
          sql`select name from app.custom_records where id = ${site.propertyId} and workspace_id = ${ws}`,
        )
      : [];
    const when = fmtAt(order.visit.startsAt.getTime(), await timeZoneOf(ctx));
    const people = await subsOf(
      ctx,
      asked.map((s) => s.personId),
    );

    const told: { personId: string; name: string }[] = [];
    const notTold: { personId: string; name: string; why: string }[] = [];
    for (const s of asked) {
      const sub = people.get(s.personId);
      if (!sub) {
        notTold.push({ personId: s.personId, name: 'A contact', why: REFUSALS.subGone });
        continue;
      }
      if (!sub.canText) {
        notTold.push({
          personId: s.personId,
          name: sub.name,
          why: REFUSALS.subNoMobile(sub.name),
        });
        continue;
      }
      try {
        // Core's own send, in a savepoint of its own: its refusal (no consent, texting not set up) is said for
        // that one person, and the others still go.
        await executeCommandWithin(ctx, messageSend, {
          workspaceId: ws,
          personId: s.personId,
          channel: 'sms',
          body: subTextWords({
            firstName: sub.firstName,
            business: business?.name ?? 'We',
            job: order.job.name,
            address: property?.name ?? null,
            when,
            instructions: order_?.instructions ?? order.job.details,
            bring: order_?.bring ?? null,
            note: input.note ?? null,
          }),
          acknowledgeQuietHours: input.acknowledgeQuietHours,
        });
      } catch (e) {
        if (!(e instanceof HfosError)) throw e;
        // Quiet hours are the business's, so they hold everyone's text alike: the person is asked once, for all.
        if (e.rule === 'quiet_hours') throw e;
        notTold.push({ personId: s.personId, name: sub.name, why: e.message });
        continue;
      }
      await ctx.tx
        .update(workOrderSubs)
        .set({ toldAt: dsql`now()`, toldBy: userIdOf(ctx.actor), updatedAt: new Date() })
        .where(eq(workOrderSubs.id, s.id));
      told.push({ personId: s.personId, name: sub.name });
    }
    if (told.length) {
      const eventId = await ctx.emit({
        type: 'contractor.work_order.subs_told',
        entityType: 'custom_record',
        entityId: order.job.recordId,
        payload: {
          appointmentId,
          jobId: order.job.recordId,
          told: told.map((t) => t.personId),
          notTold: notTold.length,
        },
        after: { visit: order.visit.title, texted: namesWords(told.map((t) => t.name)) },
      });
      await jobLine(
        ctx,
        order.job.recordId,
        `texted the job’s details to ${namesWords(told.map((t) => t.name))}`,
        { eventId },
      );
    }
    return { appointmentId, told, notTold };
  },
});

// ------------------------------------------------------------------------------------------------ its checklist

export const workOrderItemAdd = defineAddonCommand(contractorAddon, {
  name: 'contractor.work_order.item_add',
  description:
    'Add an item to a visit’s checklist: a box to tick or a photo to add, required or not.',
  risk: 1,
  input: WorkOrderItemAddInput,
  output: WorkOrderItemAddOutput,
  permission: 'contractor.use',
  scope: inWorkspace,
  ai: {
    tool: 'contractor_add_checklist_item',
    description:
      'Add an item to a visit’s checklist (by the visit’s appointment id): its label, kind (check, a box to tick, or photo, a photo to add) and whether it’s required. A job can’t be marked done while a required item is left.',
    outcome: (_o, input) => ({ words: 'It’s on the checklist.', path: pathOf(input) }),
  },
  emits: ['contractor.work_order.item_added', 'contractor.work_order.started'],
  async handler(ctx, input) {
    const order = await workOrderForChange(ctx, input.appointmentId);
    const [at] = await rows<{ n: number; next: number }>(
      ctx.tx,
      sql`select count(*)::int as n, coalesce(max(position) + 1, 0)::int as next
          from addon_contractor.work_order_items where appointment_id = ${input.appointmentId}`,
    );
    if ((at?.n ?? 0) >= LIMITS.checklist)
      throw HfosError.rule(
        'contractor_too_many_items',
        409,
        REFUSALS.tooManyItems(LIMITS.checklist),
      );
    const [made] = await ctx.tx
      .insert(workOrderItems)
      .values({
        workspaceId: ctx.scope.workspaceId!,
        appointmentId: input.appointmentId,
        recordId: order.job.recordId,
        position: at?.next ?? 0,
        label: input.label,
        kind: input.kind,
        required: input.required,
        createdBy: userIdOf(ctx.actor),
      })
      .returning({ id: workOrderItems.id });
    await ctx.emit({
      type: 'contractor.work_order.item_added',
      entityType: 'custom_record',
      entityId: order.job.recordId,
      payload: {
        appointmentId: input.appointmentId,
        jobId: order.job.recordId,
        itemId: made!.id,
        kind: input.kind,
        required: input.required,
      },
      after: { visit: order.visit.title, item: input.label, required: input.required },
    });
    return { itemId: made!.id, appointmentId: input.appointmentId };
  },
});

export const workOrderItemUpdate = defineAddonCommand(contractorAddon, {
  name: 'contractor.work_order.item_update',
  description:
    'Change a checklist item: what it says, whether it’s a box to tick or a photo, and whether it’s required.',
  risk: 1,
  input: WorkOrderItemUpdateInput,
  output: WorkOrderItemOutput,
  permission: 'contractor.use',
  scope: inWorkspace,
  ai: {
    tool: 'contractor_update_checklist_item',
    description:
      'Change a checklist item (by its item id): its label, its kind (check or photo) and whether it’s required. Changing its kind marks it not done. Making it optional lets the job be marked done without it, so it asks the person first.',
    autonomy: 'confirm',
    what: () => 'Change the checklist item',
    outcome: (output) => ({ words: W.workOrder.saved, path: pathOf(output) }),
  },
  emits: ['contractor.work_order.item_updated', 'contractor.work_order.started'],
  async handler(ctx, input) {
    const { item, job, visit } = await workOrderOfItem(ctx, input.itemId);
    const next = {
      label: input.label ?? item.label,
      kind: input.kind ?? item.kind,
      required: input.required ?? item.required,
    };
    const kindChanged = next.kind !== item.kind;
    const changed = next.label !== item.label || kindChanged || next.required !== item.required;
    if (changed) {
      await ctx.tx
        .update(workOrderItems)
        .set({
          ...next,
          // A box that was ticked isn't a photo that was added, and the other way round.
          ...(kindChanged ? { doneAt: null, doneBy: null, fileId: null } : {}),
          updatedAt: new Date(),
        })
        .where(eq(workOrderItems.id, item.id));
      await ctx.emit({
        type: 'contractor.work_order.item_updated',
        entityType: 'custom_record',
        entityId: job.recordId,
        payload: {
          appointmentId: item.appointmentId,
          jobId: job.recordId,
          itemId: item.id,
          kind: next.kind,
          required: next.required,
        },
        before: { item: item.label, required: item.required },
        after: { visit: visit.title, item: next.label, required: next.required },
      });
    }
    return {
      itemId: item.id,
      appointmentId: item.appointmentId,
      jobId: job.recordId,
      done: kindChanged ? false : item.doneAt !== null,
      requiredLeft: await requiredLeftOn(ctx, item.appointmentId),
    };
  },
});

export const workOrderItemRemove = defineAddonCommand(contractorAddon, {
  name: 'contractor.work_order.item_remove',
  description: 'Remove an item from a visit’s checklist. The rest of the work order stays.',
  risk: 2,
  input: WorkOrderItemRemoveInput,
  output: WorkOrderItemOutput,
  permission: 'contractor.use',
  scope: inWorkspace,
  ai: {
    tool: 'contractor_remove_checklist_item',
    description:
      'Remove an item from a visit’s checklist (by its item id). A photo it had stays in the job’s files. Asks the person first.',
    autonomy: 'confirm',
    what: () => 'Remove the checklist item',
    outcome: (output) => ({ words: 'It’s off the checklist.', path: pathOf(output) }),
  },
  emits: ['contractor.work_order.item_removed', 'contractor.work_order.started'],
  async handler(ctx, input) {
    const { item, job, visit } = await workOrderOfItem(ctx, input.itemId);
    await ctx.tx.delete(workOrderItems).where(eq(workOrderItems.id, item.id));
    await ctx.emit({
      type: 'contractor.work_order.item_removed',
      entityType: 'custom_record',
      entityId: job.recordId,
      payload: {
        appointmentId: item.appointmentId,
        jobId: job.recordId,
        itemId: item.id,
        required: item.required,
      },
      before: { visit: visit.title, item: item.label, required: item.required },
    });
    return {
      itemId: item.id,
      appointmentId: item.appointmentId,
      jobId: job.recordId,
      done: false,
      requiredLeft: await requiredLeftOn(ctx, item.appointmentId),
    };
  },
});

export const workOrderItemSet = defineAddonCommand(contractorAddon, {
  name: 'contractor.work_order.item_set',
  description:
    'Mark a checklist item done, or not done after all. A photo item is done by its photo: one of the job’s files.',
  risk: 1,
  input: WorkOrderItemSetInput,
  output: WorkOrderItemOutput,
  permission: 'contractor.use',
  scope: inWorkspace,
  ai: {
    tool: 'contractor_set_checklist_item',
    description:
      'Mark a checklist item (by its item id) done or not done. A photo item needs fileId: a picture already in the job’s files. Asks the person first, since a ticked box says the work was checked.',
    autonomy: 'confirm',
    what: (input) =>
      (input as { done?: boolean }).done
        ? 'Mark the checklist item done'
        : 'Mark the checklist item not done',
    outcome: (output) => {
      const o = output as { done?: boolean; requiredLeft?: number };
      return {
        words: `${o.done ? 'Marked done.' : 'Marked not done.'} ${
          o.requiredLeft ? W.workOrder.left(o.requiredLeft) : W.workOrder.ready
        }`,
        path: pathOf(output),
      };
    },
  },
  emits: ['contractor.work_order.item_set', 'contractor.work_order.started'],
  async handler(ctx, input) {
    const { item, job, visit } = await workOrderOfItem(ctx, input.itemId);
    const out = async (done: boolean) => ({
      itemId: item.id,
      appointmentId: item.appointmentId,
      jobId: job.recordId,
      done,
      requiredLeft: await requiredLeftOn(ctx, item.appointmentId),
    });
    let fileId: string | null = null;
    if (input.done && item.kind === 'photo') {
      fileId = input.fileId ?? item.fileId;
      if (!fileId)
        throw HfosError.rule('contractor_photo_needed', 409, REFUSALS.photoNeeded(item.label));
      const [file] = await rows<{ mime_type: string | null }>(
        ctx.tx,
        sql`select mime_type from app.files
            where id = ${fileId} and workspace_id = ${ctx.scope.workspaceId!}
              and record_type = 'custom_record' and record_id = ${job.recordId}
              and status = 'ready' and deleted_at is null`,
      );
      if (!file)
        throw HfosError.rule('contractor_photo_not_on_job', 409, REFUSALS.photoNotOnJob(job.name));
      if (!(file.mime_type ?? '').startsWith('image/'))
        throw HfosError.rule('contractor_not_a_photo', 400, REFUSALS.notAPhoto);
    }
    const wasDone = item.doneAt !== null;
    if (wasDone === input.done && fileId === (input.done ? item.fileId : null) && !item.skippedAt)
      return out(wasDone);
    await ctx.tx
      .update(workOrderItems)
      .set({
        doneAt: input.done ? (item.doneAt ?? dsql`now()`) : null,
        doneBy: input.done ? (item.doneBy ?? userIdOf(ctx.actor)) : null,
        fileId,
        // Done for real now, so it's no longer something that was passed over.
        ...(input.done ? { skippedAt: null, skippedBy: null, skipReason: null } : {}),
        updatedAt: new Date(),
      })
      .where(eq(workOrderItems.id, item.id));
    await ctx.emit({
      type: 'contractor.work_order.item_set',
      entityType: 'custom_record',
      entityId: job.recordId,
      payload: {
        appointmentId: item.appointmentId,
        jobId: job.recordId,
        itemId: item.id,
        done: input.done,
        required: item.required,
      },
      after: { visit: visit.title, item: item.label, done: input.done },
    });
    return out(input.done);
  },
});

// ------------------------------------------------------------------------------------------------ reading one

export const workOrderGet = defineAddonQuery(contractorAddon, {
  name: 'contractor.work_order.get',
  description:
    'A visit’s work order: when it is and where it stands, its job, customer and property, the crew and people going, its subcontractors, its instructions, what to bring, its checklist, and the job’s materials it needs.',
  input: WorkOrderGetInput,
  output: WorkOrder,
  permission: 'contractor.use',
  scope: inWorkspace,
  ai: {
    tool: 'contractor_get_work_order',
    description:
      'A visit’s work order (by the visit’s appointment id, from a job’s visits or dispatch): when it is, where it stands (scheduled, on the way, started, done), its job with its customer and property, its crew, the team members going, its subcontractors (texted or not, work done or not), its instructions, what to bring, its checklist (item ids, kind, required, done, photo, passed over) with how many required items are left, and the job’s materials this visit needs (material ids, how much is needed, delivered and used, and what’s still short).',
    keywords: ['work order', 'checklist', 'visit'],
  },
  async handler(ctx, input) {
    const visit = await loadVisit(ctx, input.appointmentId);
    if (!visit.jobId) throw HfosError.notFound(REFUSALS.visitNotOnJob);
    const today = todayIn(await timeZoneOf(ctx));
    const [jobRow] = await jobsSql(ctx, sql`j.record_id = ${visit.jobId}`, 1);
    if (!jobRow || jobRow.archived) throw HfosError.notFound(REFUSALS.jobGone);
    const job = rowOut(jobRow, today);
    const [core] = await rows<{ stage: string | null }>(
      ctx.tx,
      sql`select cj.status::text as stage from app.appointments a left join app.jobs cj on cj.id = a.job_id
          where a.id = ${input.appointmentId}`,
    );
    const [order] = await rows<{
      crew_id: string | null;
      crew_name: string | null;
      instructions: string | null;
      bring: string | null;
    }>(
      ctx.tx,
      sql`select w.crew_id, c.name as crew_name, w.instructions, w.bring
          from addon_contractor.work_orders w left join addon_contractor.crews c on c.id = w.crew_id
          where w.appointment_id = ${input.appointmentId}`,
    );
    const [items, subRows, people, visitMaterials] = await Promise.all([
      rows<{
        id: string;
        position: number;
        label: string;
        kind: 'check' | 'photo';
        required: boolean;
        done_at: string | null;
        done_by: string | null;
        file_id: string | null;
        file_name: string | null;
        skipped_at: string | null;
        skipped_by: string | null;
        skip_reason: string | null;
      }>(
        ctx.tx,
        sql`select i.id, i.position, i.label, i.kind, i.required, i.done_at::text,
              coalesce(nullif(btrim(du.full_name), ''), du.email::text) as done_by,
              f.id as file_id, f.name as file_name, i.skipped_at::text,
              coalesce(nullif(btrim(su.full_name), ''), su.email::text) as skipped_by, i.skip_reason
            from addon_contractor.work_order_items i
            left join app.users du on du.id = i.done_by
            left join app.users su on su.id = i.skipped_by
            left join app.files f on f.id = i.file_id and f.deleted_at is null
            where i.appointment_id = ${input.appointmentId}
            order by i.position, i.created_at`,
      ),
      rows<{
        person_id: string;
        told_at: string | null;
        done_at: string | null;
        done_by: string | null;
        note: string | null;
      }>(
        ctx.tx,
        sql`select s.person_id, s.told_at::text, s.done_at::text,
              coalesce(nullif(btrim(du.full_name), ''), du.email::text) as done_by, s.note
            from addon_contractor.work_order_subs s
            left join app.users du on du.id = s.done_by
            where s.appointment_id = ${input.appointmentId}
            order by s.created_at, s.id`,
      ),
      staffOf(ctx, input.appointmentId),
      materialsOf(ctx, visit.jobId, input.appointmentId),
    ]);
    const subs = await subsOf(
      ctx,
      subRows.map((s) => s.person_id),
    );
    const iso = (at: string | null) => (at ? new Date(at).toISOString() : null);
    return {
      appointmentId: input.appointmentId,
      started: !!order,
      visit: {
        title: visit.title,
        startsAt: visit.startsAt.toISOString(),
        endsAt: visit.endsAt.toISOString(),
        status: visit.status,
        stage: stageOf({ status: visit.status, stage: core?.stage ?? null }),
      },
      job: {
        id: job.id,
        name: job.name,
        kind: job.kind,
        status: job.status,
        trade: job.trade,
        details: jobRow.details,
        customer: job.customer,
        property: job.property,
      },
      crew: order?.crew_id ? { id: order.crew_id, name: order.crew_name ?? 'Crew' } : null,
      people,
      subs: subRows.flatMap((s) => {
        const sub = subs.get(s.person_id);
        return sub
          ? [
              {
                ...subOut(sub),
                toldAt: iso(s.told_at),
                done: s.done_at !== null,
                doneAt: iso(s.done_at),
                doneBy: s.done_by,
                note: s.note,
              },
            ]
          : [];
      }),
      instructions: order?.instructions ?? null,
      bring: order?.bring ?? null,
      items: items.map((i) => ({
        id: i.id,
        position: i.position,
        label: i.label,
        kind: i.kind,
        required: i.required,
        done: i.done_at !== null,
        doneAt: iso(i.done_at),
        doneBy: i.done_by,
        file: i.file_id ? { id: i.file_id, name: i.file_name ?? 'Photo' } : null,
        skipped:
          i.skipped_at && i.skip_reason
            ? { by: i.skipped_by, at: iso(i.skipped_at)!, reason: i.skip_reason }
            : null,
      })),
      progress: checklistProgress(
        items.map((i) => ({
          required: i.required,
          done: i.done_at !== null,
          skipped: i.skipped_at !== null,
        })),
      ),
      materials: visitMaterials,
    };
  },
});
