import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { asUser, asWorker, rows, sql } from '@hfos/db/client';
import { activities, auditLogs, conversations, events, tasks } from '@hfos/db/schema';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { HfosError } from '../src/errors';
import { defineQuery } from '../src/kernel/define';
import { executeCommand, executeCommandIn, executeQuery } from '../src/kernel/execute';
import type {
  CommandDef,
  HumanActor,
  RequestMeta,
  SystemActor,
  WorkflowActor,
} from '../src/kernel/types';
import { localMinutes } from '../src/messaging/quiet-hours';
import {
  activityLog,
  conversationAssign,
  conversationClose,
  conversationHandOff,
  conversationHandToAi,
  conversationSnooze,
  knowledgeItemCreate,
  knowledgeItemRecordUse,
  knowledgeSuggestionPropose,
  leadArchive,
  leadCreate,
  leadMoveStage,
  leadSetNextAction,
  leadUpdate,
  messageReceive,
  messageSend,
  organizationCreate,
  personCreate,
  personUpdate,
  phoneUpdateSettings,
  pipelineList,
  recordSetTags,
  registry,
  tagCreate,
  taskComplete,
  taskCreate,
  taskUpdate,
} from '../src/server';

const apiDb = () => testDbs().api.db;
const workerDb = () => testDbs().worker.db;
const admin = () => testDbs().admin.db;
const human = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: u.claims,
});
const meta = (channel: RequestMeta['channel'] = 'test'): RequestMeta => ({
  correlationId: randomUUID(),
  channel,
});

let owner: TestUser;
let outsider: TestUser;
let orgId: string;
let wsId: string;
let otherOrgId: string;
let otherWsId: string;
let mikeId: string;
let rosaId: string;
let patId: string;
let hot: string;
let estimate: string;
let vip: string;
let stages: { id: string; name: string }[];
let mikeConversation: string;

const workflowId = randomUUID();
const versionId = randomUUID();
const runId = randomUUID();
const workflow = (): WorkflowActor => ({
  type: 'workflow',
  workspaceId: wsId,
  organizationId: orgId,
  workflowId,
  versionId,
  runId,
  stepKey: 'text_1#1',
  depth: 1,
  originRunId: null,
  workflowName: 'Speed to lead',
  test: false,
});
const system = (): SystemActor => ({ type: 'system', workspaceId: wsId, organizationId: orgId });

const run = <I extends z.ZodType, O extends z.ZodType>(
  cmd: CommandDef<I, O>,
  input: unknown,
  u: TestUser,
) => executeCommand(apiDb(), cmd, input, human(u), meta()).then((r) => r.output);
/** A workflow step's action: the worker's connection, recorded on the workflow channel. */
const step = <I extends z.ZodType, O extends z.ZodType>(cmd: CommandDef<I, O>, input: unknown) =>
  executeCommand(workerDb(), cmd, input, workflow(), meta('workflow'));
const stage = (name: string) => stages.find((s) => s.name === name)!.id;

async function expectHfos(fn: () => Promise<unknown>, code: HfosError['code'], rule?: string) {
  try {
    await fn();
  } catch (e) {
    expect(e).toBeInstanceOf(HfosError);
    const err = e as HfosError;
    expect({ code: err.code, rule: err.rule }).toMatchObject({ code, ...(rule ? { rule } : {}) });
    return err;
  }
  throw new Error(`expected ${code}${rule ? ` (${rule})` : ''}, but the call succeeded`);
}

const hhmm = (m: number) => {
  const x = ((m % 1440) + 1440) % 1440;
  return `${String(Math.floor(x / 60)).padStart(2, '0')}:${String(x % 60).padStart(2, '0')}`;
};
const randomE164 = () =>
  `+1${2 + Math.floor(Math.random() * 8)}${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`;

/** Quiet hours around the current time in the business's zone, or off. */
async function setQuietHours(on: boolean) {
  const local = localMinutes(new Date(), 'America/Chicago');
  await run(
    phoneUpdateSettings,
    {
      workspaceId: wsId,
      quietHours: on
        ? { enabled: true, start: hhmm(local - 60), end: hhmm(local + 60) }
        : { enabled: false, start: '20:00', end: '08:00' },
    },
    owner,
  );
}

/** An active toll-free number the carriers approved, so texts can be queued. */
async function readyTexting() {
  const [account] = await rows<{ id: string }>(
    admin(),
    sql`insert into app.telephony_accounts (workspace_id, provider, account_sid, status)
        values (${wsId}, 'fake', ${`ACwf${randomUUID().slice(0, 8)}`}, 'active') returning id`,
  );
  const [number] = await rows<{ id: string }>(
    admin(),
    sql`insert into app.phone_numbers (workspace_id, account_id, provider_sid, e164, number_type, status)
        values (${wsId}, ${account!.id}, ${`PNwf${randomUUID().slice(0, 8)}`}, ${randomE164()}, 'toll_free', 'active')
        returning id`,
  );
  await rows(
    admin(),
    sql`insert into app.telephony_registrations (workspace_id, account_id, phone_number_id, kind, status, provider_sid, approved_at)
        values (${wsId}, ${account!.id}, ${number!.id}, 'toll_free_verification', 'approved', ${`HHwf${randomUUID().slice(0, 8)}`}, now())`,
  );
}

/**
 * Every action M6 opens to workflow steps (the run itself below), plus M7's hand-offs: to a person, and to the
 * AI teammate (the "Hand to the AI teammate" step).
 */
const HAND_OFF = [conversationHandOff, conversationHandToAi];
/** Every action M6 opens to workflow steps. */
const OPENED = [
  messageSend,
  personUpdate,
  recordSetTags,
  leadCreate,
  leadUpdate,
  leadMoveStage,
  leadSetNextAction,
  taskCreate,
  taskComplete,
  activityLog,
  conversationAssign,
  conversationClose,
  knowledgeSuggestionPropose,
  knowledgeItemRecordUse,
];

beforeAll(async () => {
  [owner, outsider] = await Promise.all([
    createTestUser('wf-owner'),
    createTestUser('wf-outsider'),
  ]);
  const org = await run(organizationCreate, { businessName: 'Workflow Actor Co' }, owner);
  orgId = org.organizationId;
  wsId = org.workspaceId;
  const other = await run(organizationCreate, { businessName: 'Another Business' }, outsider);
  otherOrgId = other.organizationId;
  otherWsId = other.workspaceId;
  const person = async (firstName: string, phone?: string) =>
    (
      await run(
        personCreate,
        { workspaceId: wsId, firstName, lastName: 'Rivera', ...(phone ? { phone } : {}) },
        owner,
      )
    ).personId;
  mikeId = await person('Mike', '(713) 555-0142');
  rosaId = await person('Rosa', '(713) 555-0177');
  patId = await person('Pat');
  const tag = async (name: string) =>
    (await run(tagCreate, { workspaceId: wsId, name }, owner)).tagId;
  hot = await tag('Hot');
  estimate = await tag('Estimate');
  vip = await tag('VIP');
  stages = (await executeQuery(apiDb(), pipelineList, { workspaceId: wsId }, human(owner), meta()))
    .pipelines[0]!.stages;
  await readyTexting();
  await setQuietHours(false);
});
afterAll(closeTestDbs);

describe('the workflow actor', () => {
  it('is let into exactly the actions M6 opens to workflows, and M7’s hand-offs both ways', () => {
    expect(
      registry.commands
        .filter((c) => c.actors?.includes('workflow'))
        .map((c) => c.name)
        .sort(),
    ).toEqual([...OPENED, ...HAND_OFF].map((c) => c.name).sort());
  });

  it('runs every opened action, recorded as the workflow on each event and audit row', async () => {
    const ids: string[] = [];
    const go = async <I extends z.ZodType, O extends z.ZodType>(
      cmd: CommandDef<I, O>,
      input: unknown,
    ) => {
      const r = await step(cmd, input);
      expect(r.eventIds.length, cmd.name).toBeGreaterThan(0);
      ids.push(...r.eventIds);
      return r.output;
    };
    await go(personUpdate, { workspaceId: wsId, personId: mikeId, notes: 'Asked about a tune-up' });
    await go(recordSetTags, {
      workspaceId: wsId,
      recordType: 'person',
      recordId: mikeId,
      tagIds: [hot],
      mode: 'add',
    });
    const { leadId } = await go(leadCreate, {
      workspaceId: wsId,
      title: 'AC tune-up',
      personId: mikeId,
    });
    await go(leadUpdate, {
      workspaceId: wsId,
      leadId,
      valueCents: 25_000,
      assigneeUserId: owner.id,
    });
    await go(leadSetNextAction, {
      workspaceId: wsId,
      leadId,
      text: 'Call Mike back',
      dueAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    await go(leadMoveStage, { workspaceId: wsId, leadId, stageId: stage('Contacted') });
    const { taskId } = await go(taskCreate, {
      workspaceId: wsId,
      title: 'Call Mike back',
      personId: mikeId,
      leadId,
      assigneeUserId: owner.id,
    });
    await go(taskComplete, { workspaceId: wsId, taskId });
    await go(activityLog, {
      workspaceId: wsId,
      kind: 'note',
      body: 'Mike asked for a morning visit.',
      personId: mikeId,
    });
    const sent = await go(messageSend, {
      workspaceId: wsId,
      personId: mikeId,
      body: 'Hi Mike, thanks for reaching out to Workflow Actor Co!',
    });
    mikeConversation = sent.conversationId;
    await go(conversationAssign, {
      workspaceId: wsId,
      conversationId: mikeConversation,
      assigneeUserId: owner.id,
    });
    await go(conversationClose, { workspaceId: wsId, conversationId: mikeConversation });
    // An AI step records the knowledge it used, and a question it couldn't answer.
    const { itemId } = await run(
      knowledgeItemCreate,
      {
        workspaceId: wsId,
        content: {
          kind: 'faq',
          question: 'Do you offer financing?',
          answer: 'Yes, through our lending partner.',
        },
        status: 'published',
      },
      owner,
    );
    await go(knowledgeItemRecordUse, { workspaceId: wsId, itemIds: [itemId] });
    await go(knowledgeSuggestionPropose, {
      workspaceId: wsId,
      suggestions: [
        {
          reason: 'gap',
          question: 'Do you service boilers?',
          source: { runId, stepKey: 'text_1#1' },
        },
      ],
    });

    const recorded = await admin()
      .select({
        action: auditLogs.action,
        eventActorType: events.actorType,
        eventActorId: events.actorId,
        payload: events.payload,
        auditActorType: auditLogs.actorType,
        auditActorId: auditLogs.actorId,
        actorRole: auditLogs.actorRole,
        channel: auditLogs.channel,
      })
      .from(events)
      .innerJoin(auditLogs, eq(auditLogs.eventId, events.id))
      .where(inArray(events.id, ids));
    expect(recorded).toHaveLength(ids.length);
    expect(new Set(recorded.map((r) => r.action))).toEqual(new Set(OPENED.map((c) => c.name)));
    for (const r of recorded) {
      expect(r, r.action).toMatchObject({
        eventActorType: 'workflow',
        eventActorId: workflowId,
        auditActorType: 'workflow',
        auditActorId: workflowId,
        actorRole: 'workflow',
        channel: 'workflow',
      });
      expect((r.payload as Record<string, unknown>)._workflow, r.action).toEqual({
        runId,
        workflowId,
        versionId,
        depth: 1,
        originRunId: null,
      });
    }

    // Nobody signed in: the rows a person would be credited on stay empty.
    const [task] = await admin()
      .select({ doneAt: tasks.doneAt, doneBy: tasks.doneBy, createdBy: tasks.createdBy })
      .from(tasks)
      .where(eq(tasks.id, taskId));
    expect(task).toMatchObject({ doneBy: null, createdBy: null });
    expect(task!.doneAt).not.toBeNull();
    const [conv] = await admin()
      .select({
        status: conversations.status,
        closedBy: conversations.closedBy,
        assigneeUserId: conversations.assigneeUserId,
      })
      .from(conversations)
      .where(eq(conversations.id, mikeConversation));
    expect(conv).toEqual({ status: 'closed', closedBy: null, assigneeUserId: owner.id });

    // Mike's timeline says which workflow did it, and links to the run.
    const byWorkflow = (
      await admin()
        .select({
          kind: activities.kind,
          subtype: activities.subtype,
          actorType: activities.actorType,
          authorUserId: activities.authorUserId,
          meta: activities.meta,
        })
        .from(activities)
        .where(eq(activities.personId, mikeId))
    ).filter((a) => a.actorType === 'workflow');
    expect(byWorkflow.map((a) => `${a.kind}:${a.subtype ?? ''}`)).toEqual(
      expect.arrayContaining([
        'note:',
        'sms:outbound',
        'system:lead_created',
        'system:assigned',
        'system:next_action',
        'system:stage_changed',
        'system:task_done',
      ]),
    );
    for (const a of byWorkflow) {
      expect(a.authorUserId).toBeNull();
      expect(a.meta).toMatchObject({ workflow: { id: workflowId, name: 'Speed to lead', runId } });
    }
  });

  it('is refused by people-only and worker-only commands', async () => {
    const { leadId } = (
      await step(leadCreate, { workspaceId: wsId, title: 'Refusals', personId: patId })
    ).output;
    const { taskId } = (await step(taskCreate, { workspaceId: wsId, title: 'Refusals' })).output;
    const refused = async (name: string, fn: () => Promise<unknown>) => {
      const err = await expectHfos(fn, 'forbidden');
      expect(err.message).toBe(`${name} cannot be run by a workflow actor.`);
    };
    await refused('task.update', () =>
      step(taskUpdate, { workspaceId: wsId, taskId, title: 'Renamed by a workflow' }),
    );
    await refused('lead.archive', () => step(leadArchive, { workspaceId: wsId, leadId }));
    await refused('conversation.snooze', () =>
      step(conversationSnooze, {
        workspaceId: wsId,
        conversationId: mikeConversation,
        until: new Date(Date.now() + 86_400_000).toISOString(),
      }),
    );
    await refused('message.receive', () => step(messageReceive, { workspaceId: wsId }));
  });

  it('never texts in quiet hours, even when it says it may', async () => {
    await setQuietHours(true);
    try {
      for (const acknowledgeQuietHours of [false, true])
        await expectHfos(
          () =>
            step(messageSend, {
              workspaceId: wsId,
              personId: mikeId,
              body: 'Late follow-up',
              acknowledgeQuietHours,
            }),
          'rule_violation',
          'quiet_hours',
        );
      // Nor can the system. A person still can, by confirming.
      await expectHfos(
        () =>
          executeCommand(
            workerDb(),
            messageSend,
            { workspaceId: wsId, personId: mikeId, body: 'Reminder', acknowledgeQuietHours: true },
            system(),
            meta('worker'),
          ),
        'rule_violation',
        'quiet_hours',
      );
      const ok = await run(
        messageSend,
        { workspaceId: wsId, personId: mikeId, body: 'Late note', acknowledgeQuietHours: true },
        owner,
      );
      expect(ok.status).toBe('queued');
    } finally {
      await setQuietHours(false);
    }
  });

  it('may send without reopening the conversation; people may not', async () => {
    await expectHfos(
      () =>
        run(
          messageSend,
          {
            workspaceId: wsId,
            conversationId: mikeConversation,
            body: 'Quietly',
            keepConversationStatus: true,
          },
          owner,
        ),
      'validation',
    );
    await step(conversationClose, { workspaceId: wsId, conversationId: mikeConversation });
    const sent = await step(messageSend, {
      workspaceId: wsId,
      conversationId: mikeConversation,
      body: 'Just checking in.',
      keepConversationStatus: true,
    });
    expect(sent.output.status).toBe('queued');
    const [conv] = await admin()
      .select({ status: conversations.status })
      .from(conversations)
      .where(eq(conversations.id, mikeConversation));
    expect(conv!.status).toBe('closed');
  });

  it('adds and removes single tags without replacing the rest', async () => {
    const names = (tags: { name: string }[]) => tags.map((t) => t.name);
    const on = { workspaceId: wsId, recordType: 'person', recordId: patId };
    // No mode is a replace, as before.
    expect(names((await run(recordSetTags, { ...on, tagIds: [hot, vip] }, owner)).tags)).toEqual([
      'Hot',
      'VIP',
    ]);
    const added = await step(recordSetTags, { ...on, tagIds: [estimate], mode: 'add' });
    expect(names(added.output.tags)).toEqual(['Estimate', 'Hot', 'VIP']);
    const again = await step(recordSetTags, { ...on, tagIds: [estimate], mode: 'add' });
    expect(again.eventIds).toEqual([]);
    expect(names(again.output.tags)).toEqual(['Estimate', 'Hot', 'VIP']);
    const removed = await step(recordSetTags, { ...on, tagIds: [hot], mode: 'remove' });
    expect(names(removed.output.tags)).toEqual(['Estimate', 'VIP']);
    expect((await step(recordSetTags, { ...on, tagIds: [hot], mode: 'remove' })).eventIds).toEqual(
      [],
    );
    const payloads = new Map(
      (
        await admin()
          .select({ id: events.id, payload: events.payload })
          .from(events)
          .where(inArray(events.id, [...added.eventIds, ...removed.eventIds]))
      ).map((e) => [e.id, e.payload]),
    );
    expect(payloads.get(added.eventIds[0]!)).toMatchObject({
      mode: 'add',
      added: [estimate],
      removed: [],
    });
    expect(payloads.get(removed.eventIds[0]!)).toMatchObject({
      mode: 'remove',
      added: [],
      removed: [hot],
    });
    expect(
      names((await run(recordSetTags, { ...on, tagIds: [hot], mode: 'replace' }, owner)).tags),
    ).toEqual(['Hot']);
  });

  it('runs queries that opt in to workflows as the service actor, in its own workspace only', async () => {
    const whoReads = defineQuery({
      name: 'test.workflow_reads',
      description: 'Test only: the database role a workflow’s query runs as.',
      input: z.object({ workspaceId: z.string() }),
      output: z.object({ role: z.string() }),
      permission: 'records.read',
      actors: ['workflow'],
      scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
      async handler(ctx) {
        const [r] = await rows<{ role: string }>(ctx.tx, sql`select current_user::text as role`);
        return r!;
      },
    });
    expect(
      await executeQuery(workerDb(), whoReads, { workspaceId: wsId }, workflow(), meta('workflow')),
    ).toEqual({ role: 'service_actor' });
    await expectHfos(
      () =>
        executeQuery(
          workerDb(),
          whoReads,
          { workspaceId: otherWsId },
          workflow(),
          meta('workflow'),
        ),
      'not_found',
    );
    await expectHfos(
      () => executeQuery(apiDb(), whoReads, { workspaceId: wsId }, human(owner), meta()),
      'forbidden',
    );
  });
});

describe('executeCommandIn', () => {
  const scope = () => ({ workspaceId: wsId, organizationId: orgId });
  const taskIn = (tx: Parameters<Parameters<typeof asWorker>[2]>[0], title: string) =>
    executeCommandIn(tx, taskCreate, { workspaceId: wsId, title }, workflow(), meta('workflow'));

  it('commits with the caller’s transaction', async () => {
    const result = await asWorker(workerDb(), scope(), (tx) =>
      taskIn(tx, 'Committed with the step'),
    );
    expect(
      await admin().select({ id: tasks.id }).from(tasks).where(eq(tasks.id, result.output.taskId)),
    ).toHaveLength(1);
    const [event] = await admin()
      .select({ actorType: events.actorType, actorId: events.actorId })
      .from(events)
      .where(eq(events.id, result.eventIds[0]!));
    expect(event).toEqual({ actorType: 'workflow', actorId: workflowId });
  });

  it('rolls back with the caller’s transaction', async () => {
    const seen: { taskId?: string; eventIds?: readonly string[] } = {};
    await expect(
      asWorker(workerDb(), scope(), async (tx) => {
        const r = await taskIn(tx, 'Rolled back with the step');
        seen.taskId = r.output.taskId;
        seen.eventIds = r.eventIds;
        throw new Error('the step failed after its action');
      }),
    ).rejects.toThrow('the step failed after its action');
    expect(seen.taskId).toBeDefined();
    expect(
      await admin().select({ id: tasks.id }).from(tasks).where(eq(tasks.id, seen.taskId!)),
    ).toEqual([]);
    expect(
      await admin()
        .select({ id: events.id })
        .from(events)
        .where(inArray(events.id, [...seen.eventIds!])),
    ).toEqual([]);
  });

  it('undoes only a command that fails, so the step goes on in the same transaction', async () => {
    await setQuietHours(true);
    try {
      const taskId = await asWorker(workerDb(), scope(), async (tx) => {
        // Rosa has no conversation yet: message.send starts one, then quiet hours refuse the text.
        await expect(
          executeCommandIn(
            tx,
            messageSend,
            { workspaceId: wsId, personId: rosaId, body: 'Hi Rosa' },
            workflow(),
            meta('workflow'),
          ),
        ).rejects.toMatchObject({ code: 'rule_violation', rule: 'quiet_hours' });
        // A database error (an assignee who doesn't exist) is undone the same way.
        await expect(
          executeCommandIn(
            tx,
            taskCreate,
            { workspaceId: wsId, title: 'Bad assignee', assigneeUserId: randomUUID() },
            workflow(),
            meta('workflow'),
          ),
        ).rejects.toBeTruthy();
        return (await taskIn(tx, 'Text Rosa after quiet hours')).output.taskId;
      });
      expect(
        await admin()
          .select({ id: conversations.id })
          .from(conversations)
          .where(and(eq(conversations.workspaceId, wsId), eq(conversations.personId, rosaId))),
      ).toEqual([]);
      expect(
        await admin().select({ id: tasks.id }).from(tasks).where(eq(tasks.id, taskId)),
      ).toHaveLength(1);
      expect(
        await admin()
          .select({ id: tasks.id })
          .from(tasks)
          .where(and(eq(tasks.workspaceId, wsId), eq(tasks.title, 'Bad assignee'))),
      ).toEqual([]);
    } finally {
      await setQuietHours(false);
    }
  });

  it('needs the actor’s own worker transaction, and keeps the command’s rules', async () => {
    await expect(
      asWorker(workerDb(), { workspaceId: otherWsId, organizationId: otherOrgId }, (tx) =>
        taskIn(tx, 'Wrong tenant'),
      ),
    ).rejects.toThrow(/asWorker/);
    await expect(asUser(apiDb(), owner.claims, (tx) => taskIn(tx, 'As a person'))).rejects.toThrow(
      /asWorker/,
    );
    await asWorker(workerDb(), scope(), async (tx) => {
      await expect(
        executeCommandIn(
          tx,
          taskUpdate,
          { workspaceId: wsId, taskId: randomUUID(), title: 'Renamed' },
          workflow(),
          meta('workflow'),
        ),
      ).rejects.toMatchObject({ code: 'forbidden' });
      await expect(
        executeCommandIn(
          tx,
          taskCreate,
          { workspaceId: otherWsId, title: 'Somewhere else' },
          workflow(),
          meta('workflow'),
        ),
      ).rejects.toMatchObject({ code: 'not_found' });
    });
  });
});
