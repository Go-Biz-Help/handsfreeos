/**
 * M7 step 3 on the local database: the AI teammate as a kernel actor and its allowlist; message.send's rules
 * for it (its own conversations, the quiet-hours reply window, STOP, a person taking over); the records it may
 * change; qualifying answers; booking for the customer in the conversation; handing conversations between it
 * and people; deciding and sending drafts; its settings and status; the inbox boxes; business open hours.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { asWorker, rows, sql } from '@hfos/db/client';
import {
  activities,
  aiTeammateDrafts,
  appointmentAttendees,
  auditLogs,
  conversations,
  events,
  leads,
  messages,
  people,
} from '@hfos/db/schema';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  applyTeammatePatch,
  parseTeammateConfig,
  suggestedQuestions,
  type TeammatePatch,
} from '../src/ai-team/index';
import { HfosError } from '../src/errors';
import { AI_EMPLOYEE_COMMANDS, AI_EMPLOYEE_QUERIES, userIdOf } from '../src/kernel/actor';
import { defineCommand } from '../src/kernel/define';
import { executeCommand, executeCommandIn, executeQuery } from '../src/kernel/execute';
import type {
  AiEmployeeActor,
  CommandDef,
  HumanActor,
  QueryDef,
  RequestMeta,
  SystemActor,
  WorkflowActor,
} from '../src/kernel/types';
import { localMinutes } from '../src/messaging/quiet-hours';
import { DEFAULT_OPEN_HOURS, openHoursOf } from '../src/schemas/workspace';
import {
  activityLog,
  aiTeammateActivity,
  aiTeammateCreate,
  aiTeammateDecideDraft,
  aiTeammateDraftList,
  aiTeammateGet,
  aiTeammateRestore,
  aiTeammateSaveConfig,
  aiTeammateSendDraft,
  aiTeammateSetStatus,
  appointmentBookForCustomer,
  attendeeCancelForCustomer,
  attendeeRescheduleForCustomer,
  calendarAvailability,
  chatIdentify,
  chatReceive,
  chatVisitorStart,
  chatWidgetCreate,
  conversationHandOff,
  conversationHandToAi,
  conversationTakeOver,
  inboxList,
  inboxSummary,
  leadArchive,
  leadCreate,
  leadMoveStage,
  leadRecordAnswers,
  leadUpdate,
  messageReceive,
  messageSend,
  organizationCreate,
  personCreate,
  personUpdate,
  phoneUpdateSettings,
  recordSetTags,
  registry,
  scheduleSet,
  tagCreate,
  taskUpdate,
  workspaceUpdate,
} from '../src/server';
import { isoAt, makeCalendar, nextWeekday, WEEKDAYS, type Team } from './calendar-helpers';

const api = () => testDbs().api.db;
const worker = () => testDbs().worker.db;
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

/** A business with texting ready and an AI teammate named Ava. */
interface Biz {
  readonly owner: TestUser;
  readonly member: TestUser;
  readonly wsId: string;
  readonly orgId: string;
  /** The business number customers text. */
  readonly number: string;
  teammateId: string;
}
let a: Biz;
let b: Biz;

const runFull = <I extends z.ZodType, O extends z.ZodType>(
  cmd: CommandDef<I, O>,
  input: unknown,
  u: TestUser,
) => executeCommand(api(), cmd, input, human(u), meta());
const run = <I extends z.ZodType, O extends z.ZodType>(
  cmd: CommandDef<I, O>,
  input: unknown,
  u: TestUser,
) => runFull(cmd, input, u).then((r) => r.output);
const ask = <I extends z.ZodType, O extends z.ZodType>(
  q: QueryDef<I, O>,
  input: unknown,
  u: TestUser,
) => executeQuery(api(), q, input, human(u), meta());
const system = (biz: Biz): SystemActor => ({
  type: 'system',
  workspaceId: biz.wsId,
  organizationId: biz.orgId,
});
const sys = <I extends z.ZodType, O extends z.ZodType>(
  biz: Biz,
  cmd: CommandDef<I, O>,
  input: unknown,
) => executeCommand(worker(), cmd, input, system(biz), meta('worker'));
const ava = (biz: Biz, over: Partial<AiEmployeeActor> = {}): AiEmployeeActor => ({
  type: 'ai_employee',
  workspaceId: biz.wsId,
  organizationId: biz.orgId,
  teammateId: biz.teammateId,
  teammateName: 'Ava',
  runId: null,
  conversationId: null,
  approvedBy: null,
  origin: null,
  test: false,
  ...over,
});
/** The AI teammate runs a command on the worker's connection, recorded on its own channel. */
const asAva = <I extends z.ZodType, O extends z.ZodType>(
  biz: Biz,
  over: Partial<AiEmployeeActor>,
  cmd: CommandDef<I, O>,
  input: unknown,
) => executeCommand(worker(), cmd, input, ava(biz, over), meta('ai_employee'));
const workflowActor = (biz: Biz): WorkflowActor => ({
  type: 'workflow',
  workspaceId: biz.wsId,
  organizationId: biz.orgId,
  workflowId: randomUUID(),
  versionId: null,
  runId: randomUUID(),
  stepKey: 'step_1#1',
  depth: 0,
  originRunId: null,
  workflowName: 'Night follow-up',
  test: false,
});

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
const reasonOf = (e: HfosError) => (e.details as { reason?: string }).reason;

const hhmm = (m: number) => {
  const x = ((m % 1440) + 1440) % 1440;
  return `${String(Math.floor(x / 60)).padStart(2, '0')}:${String(x % 60).padStart(2, '0')}`;
};
const randomE164 = () =>
  `+1${2 + Math.floor(Math.random() * 8)}${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`;
let phoneSeq = 0;
const nextPhone = () => `+1832555${String(1000 + phoneSeq++).padStart(4, '0')}`;

/** An active toll-free number the carriers approved, so texts can be queued. */
async function readyTexting(wsId: string): Promise<string> {
  const e164 = randomE164();
  const [account] = await rows<{ id: string }>(
    admin(),
    sql`insert into app.telephony_accounts (workspace_id, provider, account_sid, status)
        values (${wsId}, 'fake', ${`ACai${randomUUID().slice(0, 8)}`}, 'active') returning id`,
  );
  const [number] = await rows<{ id: string }>(
    admin(),
    sql`insert into app.phone_numbers (workspace_id, account_id, provider_sid, e164, number_type, status)
        values (${wsId}, ${account!.id}, ${`PNai${randomUUID().slice(0, 8)}`}, ${e164}, 'toll_free', 'active')
        returning id`,
  );
  await rows(
    admin(),
    sql`insert into app.telephony_registrations (workspace_id, account_id, phone_number_id, kind, status, provider_sid, approved_at)
        values (${wsId}, ${account!.id}, ${number!.id}, 'toll_free_verification', 'approved', ${`HHai${randomUUID().slice(0, 8)}`}, now())`,
  );
  return e164;
}

/** A Chicago business with an owner, a member, texting ready, and Ava (a Lead Responder) in training. */
async function setupBusiness(label: string, disclosure: 'first_message' | 'when_asked') {
  const [owner, member] = await Promise.all([
    createTestUser(`ai-${label}-owner`, { fullName: 'Dale Owner' }),
    createTestUser(`ai-${label}-member`, { fullName: 'Marco Member' }),
  ]);
  const org = await run(organizationCreate, { businessName: `${label} HVAC` }, owner);
  await rows(
    admin(),
    sql`insert into app.workspace_memberships (workspace_id, user_id, role) values (${org.workspaceId}, ${member.id}, 'member')`,
  );
  const biz: Biz = {
    owner,
    member,
    wsId: org.workspaceId,
    orgId: org.organizationId,
    number: await readyTexting(org.workspaceId),
    teammateId: '',
  };
  biz.teammateId = (
    await run(
      aiTeammateCreate,
      { workspaceId: biz.wsId, preset: 'lead_responder', name: 'Ava', disclosure },
      owner,
    )
  ).teammateId;
  await run(
    aiTeammateSetStatus,
    { workspaceId: biz.wsId, teammateId: biz.teammateId, status: 'training' },
    owner,
  );
  await setQuietHours(biz, false);
  return biz;
}

/** Quiet hours around the current time in the business's zone, or off. */
async function setQuietHours(biz: Biz, on: boolean) {
  const local = localMinutes(new Date(), 'America/Chicago');
  await run(
    phoneUpdateSettings,
    {
      workspaceId: biz.wsId,
      quietHours: on
        ? { enabled: true, start: hhmm(local - 60), end: hhmm(local + 60) }
        : { enabled: false, start: '20:00', end: '08:00' },
    },
    biz.owner,
  );
}

async function customer(biz: Biz, firstName: string, extra: Record<string, unknown> = {}) {
  const phone = nextPhone();
  const { personId } = await run(
    personCreate,
    { workspaceId: biz.wsId, firstName, lastName: 'Test', phone, ignoreDuplicates: true, ...extra },
    biz.owner,
  );
  return { personId, phone };
}

/** A customer's text to the business number, `minutesAgo` minutes ago. */
async function textIn(biz: Biz, from: string, body: string, minutesAgo = 0) {
  const { output } = await sys(biz, messageReceive, {
    workspaceId: biz.wsId,
    provider: 'fake',
    providerMessageId: `SM${randomUUID()}`,
    from,
    to: biz.number,
    body,
    occurredAt: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
    reminderAfterMs: 86_400_000,
  });
  return output;
}

/** A customer who texted in, in a conversation handed to the AI teammate. */
async function aiChat(
  biz: Biz,
  firstName: string,
  minutesAgo = 0,
  extra: Record<string, unknown> = {},
) {
  const c = await customer(biz, firstName, extra);
  const received = await textIn(biz, c.phone, 'Hi, do you do AC tune-ups?', minutesAgo);
  await run(
    conversationHandToAi,
    { workspaceId: biz.wsId, conversationId: received.conversationId },
    biz.owner,
  );
  return { ...c, conversationId: received.conversationId, messageId: received.messageId };
}

/**
 * A website chat whose visitor typed this number: linked to the customer with it (chat.identify) and
 * answered by the AI teammate. Anyone can type anyone's number, so the customer isn't verified.
 */
async function chatAs(biz: Biz, phone: string): Promise<string> {
  const { widgetId } = await run(
    chatWidgetCreate,
    { workspaceId: biz.wsId, allowedOrigins: [`chat-${randomUUID().slice(0, 8)}.example`] },
    biz.owner,
  );
  const { output: visitor } = await sys(biz, chatVisitorStart, {
    workspaceId: biz.wsId,
    widgetId,
    tokenHash: randomBytes(32).toString('hex'),
  });
  const { output: said } = await sys(biz, chatReceive, {
    workspaceId: biz.wsId,
    visitorId: visitor.visitorId,
    body: 'Hi, can I move my visit?',
    clientId: randomUUID(),
    reminderAfterMs: 86_400_000,
  });
  await sys(biz, chatIdentify, { workspaceId: biz.wsId, visitorId: visitor.visitorId, phone });
  await rows(
    admin(),
    sql`update app.conversations set handled_by = 'ai', ai_teammate_id = ${biz.teammateId}
        where id = ${said.conversationId}`,
  );
  return said.conversationId;
}

async function conv(id: string) {
  const [c] = await admin().select().from(conversations).where(eq(conversations.id, id));
  return c!;
}
async function draftRow(id: string) {
  const [d] = await admin().select().from(aiTeammateDrafts).where(eq(aiTeammateDrafts.id, id));
  return d!;
}
async function eventsOf(ids: readonly string[]) {
  return admin()
    .select({
      type: events.eventType,
      entityType: events.entityType,
      entityId: events.entityId,
      payload: events.payload,
    })
    .from(events)
    .where(inArray(events.id, [...ids]));
}

/** A finished run of the teammate (the worker's record), for a conversation or a new lead. */
async function runRow(biz: Biz, opts: { conversationId?: string; personId?: string }) {
  const [r] = await rows<{ id: string }>(
    admin(),
    sql`insert into app.ai_teammate_runs (workspace_id, teammate_id, conversation_id, person_id, triggered_by, status, outcome, ended_at)
        values (${biz.wsId}, ${biz.teammateId}, ${opts.conversationId ?? null}, ${opts.personId ?? null},
          'message.received', 'done', 'drafted', now())
        returning id`,
  );
  return r!.id;
}

/** A pending draft, as the worker makes one. */
async function pendingDraft(
  biz: Biz,
  opts: { conversationId: string; personId: string; kind?: 'reply' | 'approval'; body?: string },
) {
  const preview = {
    message: { channel: 'sms', body: opts.body ?? 'Thanks! We have Tuesday at 10 open.' },
    actions: [],
    ...(opts.kind === 'approval' ? { discount: { percent: 10, reason: 'Repeat customer' } } : {}),
  };
  const [d] = await rows<{ id: string }>(
    admin(),
    sql`insert into app.ai_teammate_drafts (workspace_id, teammate_id, conversation_id, person_id, kind, preview, client_id, expires_at)
        values (${biz.wsId}, ${biz.teammateId}, ${opts.conversationId}, ${opts.personId}, ${opts.kind ?? 'reply'},
          ${JSON.stringify(preview)}::jsonb, ${`ai:${randomUUID()}`}, now() + interval '2 hours')
        returning id`,
  );
  return d!.id;
}

/** Saves a patch over the teammate's current settings. */
async function saveTeammate(biz: Biz, patch: TeammatePatch) {
  const got = await ask(aiTeammateGet, { workspaceId: biz.wsId }, biz.owner);
  return run(
    aiTeammateSaveConfig,
    {
      workspaceId: biz.wsId,
      teammateId: biz.teammateId,
      baseRevision: got.teammate!.revision,
      config: applyTeammatePatch(parseTeammateConfig(got.teammate!.config), patch),
    },
    biz.owner,
  );
}

async function stageOf(biz: Biz, kind: 'open' | 'won', nth = 0) {
  const list = await rows<{ id: string }>(
    admin(),
    sql`select s.id from app.pipeline_stages s join app.pipelines p on p.id = s.pipeline_id
        where p.workspace_id = ${biz.wsId} and s.kind = ${kind} order by p.position, s.position`,
  );
  return list[nth]!.id;
}

beforeAll(async () => {
  a = await setupBusiness('lonestar', 'when_asked');
});
afterAll(closeTestDbs);

describe('the AI employee actor', () => {
  it('is recorded as the teammate on its events, audit rows and timeline entries', async () => {
    const mike = await aiChat(a, 'Mike');
    const runId = await runRow(a, { conversationId: mike.conversationId, personId: mike.personId });
    const note = {
      workspaceId: a.wsId,
      kind: 'note',
      body: 'Wants a morning visit.',
      personId: mike.personId,
    };
    const plain = await asAva(a, { conversationId: mike.conversationId, runId }, activityLog, note);
    const origin = { runId: randomUUID(), workflowId: randomUUID(), depth: 1, originRunId: null };
    const chained = await asAva(
      a,
      { conversationId: mike.conversationId, runId, approvedBy: a.owner.id, origin },
      activityLog,
      note,
    );
    const recorded = await admin()
      .select({
        id: events.id,
        actorType: events.actorType,
        actorId: events.actorId,
        payload: events.payload,
        role: auditLogs.actorRole,
        channel: auditLogs.channel,
      })
      .from(events)
      .innerJoin(auditLogs, eq(auditLogs.eventId, events.id))
      .where(inArray(events.id, [...plain.eventIds, ...chained.eventIds]));
    expect(recorded).toHaveLength(2);
    for (const r of recorded)
      expect(r).toMatchObject({
        actorType: 'ai_employee',
        actorId: a.teammateId,
        role: 'ai_employee',
        channel: 'ai_employee',
      });
    const payload = (id: string) =>
      recorded.find((r) => r.id === id)!.payload as Record<string, unknown>;
    expect(payload(plain.eventIds[0]!)._ai).toEqual({
      teammateId: a.teammateId,
      runId,
      approvedBy: null,
    });
    expect(payload(plain.eventIds[0]!)._workflow).toBeUndefined();
    expect(payload(chained.eventIds[0]!)._ai).toEqual({
      teammateId: a.teammateId,
      runId,
      approvedBy: a.owner.id,
    });
    // A workflow handed it the conversation: that run's loop guard rides along.
    expect(payload(chained.eventIds[0]!)._workflow).toEqual(origin);
    const [entry] = await admin()
      .select({
        actorType: activities.actorType,
        authorUserId: activities.authorUserId,
        meta: activities.meta,
      })
      .from(activities)
      .where(eq(activities.id, plain.output.activityId));
    expect(entry).toEqual({
      actorType: 'ai_employee',
      authorUserId: null,
      meta: { aiTeammate: { id: a.teammateId, name: 'Ava', runId, approvedBy: null } },
    });
    expect(userIdOf(ava(a))).toBeNull();
  });

  it('runs only the commands on its allowlist, whatever a command’s actors say', async () => {
    const opened = registry.commands.filter((c) => c.actors?.includes('ai_employee'));
    expect(opened.map((c) => c.name).sort()).toEqual([...AI_EMPLOYEE_COMMANDS].sort());
    for (const c of opened) {
      expect(c.risk, c.name).toBeLessThanOrEqual(2);
      expect(c.name).not.toMatch(/archive|delete|remove|restore/);
    }
    expect(
      registry.queries
        .filter((q) => q.actors?.includes('ai_employee'))
        .map((q) => q.name)
        .sort(),
    ).toEqual([...AI_EMPLOYEE_QUERIES].sort());
    const sneaky = defineCommand({
      name: 'test.ai_sneaks_in',
      description: 'Test only: lists the AI teammate but isn’t on its allowlist.',
      risk: 1,
      input: z.object({ workspaceId: z.uuid() }),
      output: z.object({}),
      permission: null,
      scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
      emits: [],
      actors: ['ai_employee'],
      async handler() {
        return {};
      },
    });
    for (const cmd of [
      sneaky,
      taskUpdate,
      leadArchive,
      conversationTakeOver,
      aiTeammateSendDraft,
    ] as CommandDef[]) {
      const err = await expectHfos(() => asAva(a, {}, cmd, { workspaceId: a.wsId }), 'forbidden');
      expect(err.message).toBe(`${cmd.name} cannot be run by a ai_employee actor.`);
    }
  });
});

describe('message.send as the AI teammate', () => {
  it('needs a clientId, and writes only in the conversation it handles', async () => {
    const lee = await aiChat(a, 'Lee');
    const nia = await aiChat(a, 'Nia');
    const runId = await runRow(a, { conversationId: lee.conversationId, personId: lee.personId });
    const me = { conversationId: lee.conversationId, runId };
    const to = (conversationId: string, clientId?: string) => ({
      workspaceId: a.wsId,
      conversationId,
      body: 'Yes, we do tune-ups!',
      ...(clientId ? { clientId } : {}),
    });
    await expectHfos(() => asAva(a, me, messageSend, to(lee.conversationId)), 'validation');
    await expectHfos(
      () => asAva(a, me, messageSend, to(nia.conversationId, randomUUID())),
      'forbidden',
      'outside_its_conversation',
    );
    const clientId = `ai:${runId}`;
    const sent = await asAva(a, me, messageSend, to(lee.conversationId, clientId));
    const [m] = await admin().select().from(messages).where(eq(messages.id, sent.output.messageId));
    expect(m).toMatchObject({
      sentBy: null,
      sentByTeammateId: a.teammateId,
      aiRunId: runId,
      approvedBy: null,
      status: 'queued',
    });
    const again = await asAva(a, me, messageSend, to(lee.conversationId, clientId));
    expect(again.output).toMatchObject({ messageId: m!.id, duplicate: true });
    // Once a person has it, the teammate stays out of it.
    await run(
      conversationTakeOver,
      { workspaceId: a.wsId, conversationId: nia.conversationId },
      a.owner,
    );
    await expectHfos(
      () =>
        asAva(
          a,
          { conversationId: nia.conversationId },
          messageSend,
          to(nia.conversationId, randomUUID()),
        ),
      'rule_violation',
      'not_handled_by_ai',
    );
  });

  it('answers a text in quiet hours 14 minutes after it came in, but not 16', async () => {
    const early = await aiChat(a, 'Quinn', 14);
    const late = await aiChat(a, 'Rae', 16);
    const reply = (c: { conversationId: string; messageId: string }) =>
      asAva(a, { conversationId: c.conversationId }, messageSend, {
        workspaceId: a.wsId,
        conversationId: c.conversationId,
        body: 'Yes, we can help with that.',
        clientId: randomUUID(),
        inReplyToMessageId: c.messageId,
      });
    await setQuietHours(a, true);
    try {
      const ok = await reply(early);
      const [queued] = await eventsOf(ok.eventIds);
      expect(queued).toMatchObject({
        type: 'message.queued',
        payload: expect.objectContaining({ quietHours: 'reply_window' }),
      });
      const err = await expectHfos(() => reply(late), 'rule_violation', 'quiet_hours');
      expect(reasonOf(err)).toBe('reply_window_passed');
    } finally {
      await setQuietHours(a, false);
    }
  });

  it('sends at most 3 replies in a quiet period, never a first text, and workflows still wait', async () => {
    const sam = await aiChat(a, 'Sam', 1);
    const tia = await customer(a, 'Tia');
    const outreach = await runRow(a, { personId: tia.personId });
    const reply = (inReplyToMessageId?: string) =>
      asAva(a, { conversationId: sam.conversationId }, messageSend, {
        workspaceId: a.wsId,
        conversationId: sam.conversationId,
        body: 'Happy to help tonight.',
        clientId: randomUUID(),
        ...(inReplyToMessageId ? { inReplyToMessageId } : {}),
      });
    await setQuietHours(a, true);
    try {
      for (let i = 0; i < 3; i++) await reply(sam.messageId);
      const fourth = await expectHfos(() => reply(sam.messageId), 'rule_violation', 'quiet_hours');
      expect(reasonOf(fourth)).toBe('reply_limit');
      // A text that answers nothing in particular is a first text.
      expect(reasonOf(await expectHfos(() => reply(), 'rule_violation', 'quiet_hours'))).toBe(
        'first_text',
      );
      const first = await expectHfos(
        () =>
          asAva(a, { runId: outreach }, messageSend, {
            workspaceId: a.wsId,
            personId: tia.personId,
            body: 'Hi Tia, thanks for reaching out!',
            clientId: randomUUID(),
          }),
        'rule_violation',
        'quiet_hours',
      );
      expect(reasonOf(first)).toBe('first_text');
      expect(
        await admin()
          .select({ id: conversations.id })
          .from(conversations)
          .where(eq(conversations.personId, tia.personId)),
      ).toEqual([]);
      // Workflows and the system never text in quiet hours, as before.
      await expectHfos(
        () =>
          executeCommand(
            worker(),
            messageSend,
            { workspaceId: a.wsId, conversationId: sam.conversationId, body: 'Following up' },
            workflowActor(a),
            meta('workflow'),
          ),
        'rule_violation',
        'quiet_hours',
      );
      await expectHfos(
        () =>
          sys(a, messageSend, {
            workspaceId: a.wsId,
            conversationId: sam.conversationId,
            body: 'Reminder',
            acknowledgeQuietHours: true,
          }),
        'rule_violation',
        'quiet_hours',
      );
    } finally {
      await setQuietHours(a, false);
    }
  });

  it('never texts someone who said STOP, even inside the reply window', async () => {
    const uma = await aiChat(a, 'Uma', 1);
    const stop = await textIn(a, uma.phone, 'STOP');
    const reply = () =>
      asAva(a, { conversationId: uma.conversationId }, messageSend, {
        workspaceId: a.wsId,
        conversationId: uma.conversationId,
        body: 'Sorry to see you go.',
        clientId: randomUUID(),
        inReplyToMessageId: stop.messageId,
      });
    await setQuietHours(a, true);
    try {
      await expectHfos(reply, 'rule_violation', 'opted_out');
    } finally {
      await setQuietHours(a, false);
    }
    await expectHfos(reply, 'rule_violation', 'opted_out');
  });

  it('starts a conversation with its run’s own new lead, and takes it on', async () => {
    const val = await customer(a, 'Val');
    const wes = await customer(a, 'Wes');
    const runId = await runRow(a, { personId: val.personId });
    const first = (personId: string) =>
      asAva(a, { runId }, messageSend, {
        workspaceId: a.wsId,
        personId,
        body: 'Hi, thanks for reaching out to Lone Star HVAC!',
        clientId: `ai:${runId}`,
      });
    await expectHfos(() => first(wes.personId), 'forbidden', 'outside_its_conversation');
    const sent = await first(val.personId);
    expect(await conv(sent.output.conversationId)).toMatchObject({
      handledBy: 'ai',
      aiTeammateId: a.teammateId,
    });
  });

  it('gives the conversation to a person who writes in it, dropping its draft', async () => {
    const xia = await aiChat(a, 'Xia');
    const before = await conv(xia.conversationId);
    const draftId = await pendingDraft(a, {
      conversationId: xia.conversationId,
      personId: xia.personId,
    });
    const sent = await runFull(
      messageSend,
      { workspaceId: a.wsId, conversationId: xia.conversationId, body: 'Hi Xia, Marco here.' },
      a.member,
    );
    expect(await conv(xia.conversationId)).toMatchObject({
      handledBy: 'person',
      takenOverBy: a.member.id,
      aiEpoch: before.aiEpoch + 1,
      needsPersonSince: null,
    });
    expect(await draftRow(draftId)).toMatchObject({
      status: 'cancelled',
      decidedBy: a.member.id,
      via: 'web',
    });
    expect((await eventsOf(sent.eventIds)).map((e) => e.type)).toContain('conversation.taken_over');
  });
});

describe('what the AI teammate may change', () => {
  it('fills in only its own customer’s blank details, and finds people before adding them', async () => {
    const yan = await aiChat(a, 'Yan');
    const me = { conversationId: yan.conversationId };
    const filled = await asAva(a, me, personUpdate, {
      workspaceId: a.wsId,
      personId: yan.personId,
      firstName: 'Yannick',
      email: 'yan@example.com',
    });
    expect(filled.output.updated).toEqual(['email']);
    const [p] = await admin()
      .select({ firstName: people.firstName, email: people.email })
      .from(people)
      .where(eq(people.id, yan.personId));
    expect(p).toEqual({ firstName: 'Yan', email: 'yan@example.com' });
    await expectHfos(
      () =>
        asAva(a, me, personUpdate, { workspaceId: a.wsId, personId: yan.personId, notes: 'VIP' }),
      'validation',
    );
    const zed = await customer(a, 'Zed');
    await expectHfos(
      () =>
        asAva(a, me, personUpdate, {
          workspaceId: a.wsId,
          personId: zed.personId,
          email: 'zed@example.com',
        }),
      'forbidden',
      'outside_its_conversation',
    );
    const found = await asAva(a, me, personCreate, {
      workspaceId: a.wsId,
      firstName: 'Yan',
      lastName: 'Again',
      phone: yan.phone,
    });
    expect(found.output.personId).toBe(yan.personId);
    expect(found.eventIds).toEqual([]);
  });

  it('moves its customer’s lead between open stages, and changes only its next action', async () => {
    const cy = await aiChat(a, 'Cy');
    const me = { conversationId: cy.conversationId };
    const { leadId } = (
      await asAva(a, me, leadCreate, {
        workspaceId: a.wsId,
        title: 'AC tune-up',
        personId: cy.personId,
      })
    ).output;
    const [lead] = await admin()
      .select({ source: leads.source })
      .from(leads)
      .where(eq(leads.id, leadId));
    expect(lead!.source).toBe('AI teammate');
    await asAva(a, me, leadMoveStage, {
      workspaceId: a.wsId,
      leadId,
      stageId: await stageOf(a, 'open', 1),
    });
    const won = await stageOf(a, 'won');
    await expectHfos(
      () => asAva(a, me, leadMoveStage, { workspaceId: a.wsId, leadId, stageId: won }),
      'rule_violation',
      'stage_not_open',
    );
    const next = await asAva(a, me, leadUpdate, {
      workspaceId: a.wsId,
      leadId,
      nextAction: 'Call Cy back',
      nextActionAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    expect(next.output.updated).toEqual(['nextAction', 'nextActionAt']);
    await expectHfos(
      () => asAva(a, me, leadUpdate, { workspaceId: a.wsId, leadId, valueCents: 10_000 }),
      'validation',
    );
    const { tagId } = await run(
      tagCreate,
      { workspaceId: a.wsId, name: `Hot ${randomUUID().slice(0, 4)}` },
      a.owner,
    );
    const tags = { workspaceId: a.wsId, recordType: 'lead', recordId: leadId, tagIds: [tagId] };
    await expectHfos(() => asAva(a, me, recordSetTags, tags), 'validation');
    const tagged = await asAva(a, me, recordSetTags, { ...tags, mode: 'add' });
    expect(tagged.output.tags.map((t) => t.id)).toEqual([tagId]);
  });
});

describe('qualifying answers', () => {
  beforeAll(async () => {
    await saveTeammate(a, {
      qualify: { enabled: true, questions: suggestedQuestions('home_services') },
    });
  });

  it('are stored with their questions, and lead.qualified goes out once', async () => {
    const dee = await aiChat(a, 'Dee');
    const me = { conversationId: dee.conversationId };
    const { leadId } = (
      await asAva(a, me, leadCreate, {
        workspaceId: a.wsId,
        title: 'New system',
        personId: dee.personId,
      })
    ).output;
    const answer = (answers: { questionId: string; answer: string }[]) =>
      asAva(a, me, leadRecordAnswers, { workspaceId: a.wsId, leadId, answers });
    const first = await answer([{ questionId: 'need', answer: 'New installation' }]);
    expect(first.output).toMatchObject({
      status: 'incomplete',
      qualified: false,
      missing: ['timeline', 'owner', 'zip'],
    });
    const rest = await answer([
      { questionId: 'timeline', answer: 'This week' },
      { questionId: 'owner', answer: 'Yes, we own it' },
      { questionId: 'zip', answer: '77027' },
    ]);
    expect(rest.output).toMatchObject({ status: 'qualified', qualified: true, missing: [] });
    const qualified = (await eventsOf(rest.eventIds)).find((e) => e.type === 'lead.qualified');
    expect(qualified).toMatchObject({
      entityType: 'lead',
      entityId: leadId,
      payload: expect.objectContaining({ leadId, personId: dee.personId }),
    });
    const [row] = await admin()
      .select({ q: leads.qualification })
      .from(leads)
      .where(eq(leads.id, leadId));
    const stored = row!.q as {
      status: string;
      answers: Record<string, { question: string; answer: string; by: string }>;
    };
    expect(stored.status).toBe('qualified');
    expect(stored.answers['need']).toMatchObject({
      question: 'What do you need help with?',
      answer: 'New installation',
      by: 'ai',
    });
    // A person may fill in answers too; the lead doesn't qualify twice.
    const again = await runFull(
      leadRecordAnswers,
      { workspaceId: a.wsId, leadId, answers: [{ questionId: 'zip', answer: '77030' }] },
      a.member,
    );
    expect(again.output.qualified).toBe(false);
    expect((await eventsOf(again.eventIds)).map((e) => e.type)).toEqual(['lead.answers_recorded']);
    await expectHfos(() => answer([{ questionId: 'budget', answer: '$5k' }]), 'validation');
  });
});

describe('booking for the customer in the conversation', () => {
  let visits: { id: string };
  let office: { id: string };
  const day = nextWeekday(2);

  beforeAll(async () => {
    const t = { owner: a.owner, wsId: a.wsId } as unknown as Team;
    await run(scheduleSet, { workspaceId: a.wsId, ownerId: a.owner.id, weekly: WEEKDAYS }, a.owner);
    const [first] = await rows<{ id: string; pipeline_id: string }>(
      admin(),
      sql`select s.id, s.pipeline_id from app.pipeline_stages s join app.pipelines p on p.id = s.pipeline_id
          where p.workspace_id = ${a.wsId} and s.kind = 'open' order by p.position, s.position limit 1`,
    );
    const team = { members: [{ userId: a.owner.id }], assignment: 'round_robin' as const };
    visits = await makeCalendar(t, 'Visits', {
      public: true,
      team,
      crm: { createLead: { pipelineId: first!.pipeline_id, stageId: first!.id } },
    });
    office = await makeCalendar(t, 'Office', { public: true, team });
    await saveTeammate(a, { book: { enabled: true, calendarIds: [visits.id] } });
  });

  it('books only on its calendars, at a time they offer, once per clientId', async () => {
    const bo = await aiChat(a, 'Bo');
    const me = { conversationId: bo.conversationId };
    const book = (calendarId: string, startsAt: string, clientId = randomUUID()) =>
      asAva(a, me, appointmentBookForCustomer, {
        workspaceId: a.wsId,
        calendarId,
        startsAt,
        clientId,
      });
    await expectHfos(
      () => book(office.id, isoAt(day, '10:00')),
      'forbidden',
      'calendar_not_allowed',
    );
    await expectHfos(() => book(visits.id, isoAt(day, '03:00')), 'conflict', 'slot_taken');
    const clientId = randomUUID();
    const booked = await book(visits.id, isoAt(day, '10:00'), clientId);
    expect(booked.output).toMatchObject({
      personId: bo.personId,
      personCreated: false,
      duplicate: false,
    });
    const again = await book(visits.id, isoAt(day, '10:00'), clientId);
    expect(again.output).toMatchObject({
      appointmentId: booked.output.appointmentId,
      duplicate: true,
    });
    expect(
      await admin()
        .select({ id: appointmentAttendees.id })
        .from(appointmentAttendees)
        .where(eq(appointmentAttendees.appointmentId, booked.output.appointmentId)),
    ).toHaveLength(1);
    // The new lead says where it came from, and the customer's consent is left as it was.
    const [lead] = await admin()
      .select({ source: leads.source })
      .from(leads)
      .where(eq(leads.id, booked.output.leadId!));
    expect(lead!.source).toBe('AI teammate');
    const [p] = await admin()
      .select({ consent: people.smsConsent })
      .from(people)
      .where(eq(people.id, bo.personId));
    expect(p!.consent).toBe('unknown');
    // It looks up times on its own calendars only.
    const range = { workspaceId: a.wsId, from: isoAt(day, '00:00'), to: isoAt(day, '23:59') };
    const times = (calendarId: string) =>
      executeQuery(
        worker(),
        calendarAvailability,
        { ...range, calendarId },
        ava(a, me),
        meta('ai_employee'),
      );
    await expectHfos(() => times(office.id), 'forbidden', 'calendar_not_allowed');
    expect((await times(visits.id)).slots.length).toBeGreaterThan(0);
  });

  it('moves and cancels only its own customer’s bookings, and retires older links', async () => {
    const rosa = await aiChat(a, 'Rosa');
    const cal = await aiChat(a, 'Cal');
    const bookFor = async (c: { conversationId: string }, clock: string) =>
      (
        await asAva(a, { conversationId: c.conversationId }, appointmentBookForCustomer, {
          workspaceId: a.wsId,
          calendarId: visits.id,
          startsAt: isoAt(day, clock),
          clientId: randomUUID(),
        })
      ).output;
    const rosas = await bookFor(rosa, '13:00');
    const cals = await bookFor(cal, '14:00');
    const asCal = { conversationId: cal.conversationId };
    await expectHfos(
      () =>
        asAva(a, asCal, attendeeRescheduleForCustomer, {
          workspaceId: a.wsId,
          appointmentId: rosas.appointmentId,
          startsAt: isoAt(day, '15:00'),
        }),
      'forbidden',
      'not_this_customer',
    );
    await expectHfos(
      () =>
        asAva(a, asCal, attendeeCancelForCustomer, {
          workspaceId: a.wsId,
          appointmentId: rosas.appointmentId,
        }),
      'forbidden',
      'not_this_customer',
    );
    const moved = await asAva(a, asCal, attendeeRescheduleForCustomer, {
      workspaceId: a.wsId,
      appointmentId: cals.appointmentId,
      startsAt: isoAt(day, '15:00'),
    });
    expect(moved.output.startsAt).toBe(isoAt(day, '15:00'));
    const [att] = await admin()
      .select({ version: appointmentAttendees.manageVersion })
      .from(appointmentAttendees)
      .where(eq(appointmentAttendees.id, moved.output.attendeeId));
    expect(att!.version).toBe(cals.manageVersion + 1);
    const cancelled = await asAva(a, asCal, attendeeCancelForCustomer, {
      workspaceId: a.wsId,
      appointmentId: cals.appointmentId,
      reason: 'Found another time',
    });
    expect(cancelled.output.appointmentCancelled).toBe(true);
  });

  it('files its bookings as the AI teammate’s, and in a website chat never moves, cancels or fills in the customer (F1)', async () => {
    const vi = await aiChat(a, 'Vi');
    const booked = (
      await asAva(a, { conversationId: vi.conversationId }, appointmentBookForCustomer, {
        workspaceId: a.wsId,
        calendarId: visits.id,
        startsAt: isoAt(day, '09:00'),
        clientId: randomUUID(),
      })
    ).output;
    const [source] = await rows<{ appointment: string; attendee: string }>(
      admin(),
      sql`select p.source::text as appointment, a.source::text as attendee
          from app.appointment_attendees a join app.appointments p on p.id = a.appointment_id
          where a.id = ${booked.attendeeId}`,
    );
    expect(source).toEqual({ appointment: 'ai_teammate', attendee: 'ai_teammate' });
    // Someone types Vi's number into the website chat, so the chat is linked to her.
    const inChat = { conversationId: await chatAs(a, vi.phone) };
    await expectHfos(
      () =>
        asAva(a, inChat, attendeeRescheduleForCustomer, {
          workspaceId: a.wsId,
          appointmentId: booked.appointmentId,
          startsAt: isoAt(day, '16:00'),
        }),
      'forbidden',
      'chat_identity_unverified',
    );
    await expectHfos(
      () =>
        asAva(a, inChat, attendeeCancelForCustomer, {
          workspaceId: a.wsId,
          appointmentId: booked.appointmentId,
        }),
      'forbidden',
      'chat_identity_unverified',
    );
    await expectHfos(
      () =>
        asAva(a, inChat, personUpdate, {
          workspaceId: a.wsId,
          personId: vi.personId,
          email: 'someone@else.example',
        }),
      'forbidden',
      'chat_identity_unverified',
    );
    const [p] = await admin()
      .select({ email: people.email })
      .from(people)
      .where(eq(people.id, vi.personId));
    expect(p!.email).toBeNull();
    const [att] = await admin()
      .select({ status: appointmentAttendees.status })
      .from(appointmentAttendees)
      .where(eq(appointmentAttendees.id, booked.attendeeId));
    expect(att!.status).toBe('booked');
    // A new booking from the chat is fine: its confirmation goes to the contact on file.
    const fresh = await asAva(a, inChat, appointmentBookForCustomer, {
      workspaceId: a.wsId,
      calendarId: visits.id,
      startsAt: isoAt(day, '11:00'),
      clientId: randomUUID(),
    });
    expect(fresh.output).toMatchObject({ personId: vi.personId, duplicate: false });
  });

  it('carries out a draft that only cancels once, however often it’s delivered (F2)', async () => {
    const jules = await aiChat(a, 'Jules');
    const booked = (
      await asAva(a, { conversationId: jules.conversationId }, appointmentBookForCustomer, {
        workspaceId: a.wsId,
        calendarId: visits.id,
        startsAt: isoAt(day, '16:00'),
        clientId: randomUUID(),
      })
    ).output;
    const preview = {
      message: null,
      actions: [
        {
          kind: 'cancel',
          appointmentId: booked.appointmentId,
          reason: 'They asked to cancel',
          summary: 'Cancel the 4 PM visit',
        },
      ],
      discount: null,
    };
    const [d] = await rows<{ id: string }>(
      admin(),
      sql`insert into app.ai_teammate_drafts (workspace_id, teammate_id, conversation_id, person_id, kind, status,
            preview, client_id, decided_by, decided_at, via)
          values (${a.wsId}, ${a.teammateId}, ${jules.conversationId}, ${jules.personId}, 'reply', 'approved',
            ${JSON.stringify(preview)}::jsonb, ${`ai:${randomUUID()}`}, ${a.owner.id}, now(), 'web')
          returning id`,
    );
    const deliver = () => sys(a, aiTeammateSendDraft, { workspaceId: a.wsId, draftId: d!.id });
    const first = await deliver();
    expect(first.output).toMatchObject({
      duplicate: false,
      messageId: null,
      actions: [{ kind: 'cancel', appointmentId: booked.appointmentId }],
    });
    const again = await deliver();
    expect(again.output).toMatchObject({ duplicate: true, messageId: null, actions: [] });
    expect(again.eventIds).toEqual([]);
    expect((await draftRow(d!.id)).sentAt).not.toBeNull();
    const [cancels] = await rows<{ n: number }>(
      admin(),
      sql`select count(*)::int as n from app.events
          where entity_id = ${booked.appointmentId} and event_type in ('appointment.cancelled', 'attendee.cancelled')`,
    );
    expect(cancels!.n).toBe(1);
  });
});

describe('handing conversations between the teammate and people', () => {
  it('takes over, hands back and hands off, raising the epoch and dropping drafts', async () => {
    const dot = await aiChat(a, 'Dot');
    await run(
      leadCreate,
      {
        workspaceId: a.wsId,
        title: 'Water heater',
        personId: dot.personId,
        assigneeUserId: a.member.id,
      },
      a.owner,
    );
    const ref = { workspaceId: a.wsId, conversationId: dot.conversationId };
    const epoch = (await conv(dot.conversationId)).aiEpoch;
    const d1 = await pendingDraft(a, {
      conversationId: dot.conversationId,
      personId: dot.personId,
    });
    expect(await run(conversationTakeOver, ref, a.member)).toMatchObject({ draftCancelled: true });
    expect(await conv(dot.conversationId)).toMatchObject({
      handledBy: 'person',
      takenOverBy: a.member.id,
      aiEpoch: epoch + 1,
    });
    expect((await draftRow(d1)).status).toBe('cancelled');
    const back = await runFull(conversationHandToAi, ref, a.member);
    expect((await eventsOf(back.eventIds)).map((e) => e.type)).toEqual([
      'conversation.handed_to_ai',
    ]);
    expect(await conv(dot.conversationId)).toMatchObject({
      handledBy: 'ai',
      aiTeammateId: a.teammateId,
      takenOverBy: null,
      aiEpoch: epoch + 2,
    });
    const d2 = await pendingDraft(a, {
      conversationId: dot.conversationId,
      personId: dot.personId,
    });
    const me = { conversationId: dot.conversationId };
    const off = await asAva(a, me, conversationHandOff, {
      ...ref,
      reason: 'frustrated',
      note: 'Upset that the tech was late.',
    });
    expect(off.output.assigneeUserId).toBe(a.member.id);
    const after = await conv(dot.conversationId);
    expect(after).toMatchObject({
      handledBy: 'person',
      handoffReason: 'frustrated',
      handoffNote: 'Upset that the tech was late.',
      assigneeUserId: a.member.id,
      aiEpoch: epoch + 3,
    });
    expect(after.needsPersonSince).not.toBeNull();
    expect(await draftRow(d2)).toMatchObject({
      status: 'cancelled',
      via: 'system',
      decidedBy: null,
    });
    const emitted = await eventsOf(off.eventIds);
    expect(emitted.map((e) => e.type).sort()).toEqual([
      'ai_teammate.handed_off',
      'conversation.handed_off',
    ]);
    expect(emitted.find((e) => e.type === 'ai_teammate.handed_off')!.payload).toMatchObject({
      personId: dot.personId,
      conversationId: dot.conversationId,
      reason: 'frustrated',
    });
    // It's a person's now: the teammate can't hand it off again.
    await expectHfos(
      () => asAva(a, me, conversationHandOff, { ...ref, reason: 'other' }),
      'rule_violation',
      'not_handled_by_ai',
    );
  });

  it('goes to the customer’s owner when the lead has no assignee, else to nobody in particular', async () => {
    const eve = await aiChat(a, 'Eve', 0, { ownerUserId: a.owner.id });
    const toOwner = await asAva(a, { conversationId: eve.conversationId }, conversationHandOff, {
      workspaceId: a.wsId,
      conversationId: eve.conversationId,
      reason: 'asked_for_person',
    });
    expect(toOwner.output.assigneeUserId).toBe(a.owner.id);
    // A workflow may hand a conversation off too.
    const fay = await aiChat(a, 'Fay');
    const toNobody = await executeCommand(
      worker(),
      conversationHandOff,
      { workspaceId: a.wsId, conversationId: fay.conversationId, reason: 'other' },
      workflowActor(a),
      meta('workflow'),
    );
    expect(toNobody.output.assigneeUserId).toBeNull();
  });
});

describe('deciding the teammate’s drafts (three approvals turn it automatic)', () => {
  let gus: { draftId: string; conversationId: string };
  let jo: { draftId: string };
  const decide = (draftId: string, u: TestUser, extra: Record<string, unknown> = {}) =>
    run(aiTeammateDecideDraft, { workspaceId: b.wsId, draftId, decision: 'approve', ...extra }, u);
  const drafted = async (name: string, kind: 'reply' | 'approval' = 'reply', body?: string) => {
    const c = await aiChat(b, name);
    const draftId = await pendingDraft(b, { ...c, kind, body });
    return { ...c, draftId };
  };

  beforeAll(async () => {
    b = await setupBusiness('threshold', 'first_message');
    // Core keeps the setting at 5 or more; the database counts to whatever the settings say.
    await rows(
      admin(),
      sql`update app.ai_teammates set config = jsonb_set(config, '{autonomy,approvalsNeeded}', '3')
          where id = ${b.teammateId}`,
    );
  });

  it('claims each draft once, and counts it toward training', async () => {
    const g = await drafted('Gus', 'reply', 'Hi Gus, we have Tuesday at 10.');
    gus = g;
    expect(await decide(g.draftId, b.member)).toMatchObject({
      status: 'approved',
      progress: {
        status: 'training',
        approvedCount: 1,
        approvalsNeeded: 3,
        remaining: 2,
        becameAutomatic: false,
      },
    });
    await expectHfos(() => decide(g.draftId, b.owner), 'conflict', 'draft_decided');
    const hal = await drafted('Hal');
    const no = await decide(hal.draftId, b.member, { decision: 'reject', reason: 'Too pushy' });
    expect(no).toMatchObject({
      status: 'rejected',
      progress: { approvedCount: 1, rejectedCount: 1 },
    });
  });

  it('refuses a draft once the customer has written again', async () => {
    const ida = await drafted('Ida');
    await textIn(b, ida.phone, 'Actually, can you come Wednesday instead?');
    await expectHfos(() => decide(ida.draftId, b.member), 'rule_violation', 'customer_wrote_again');
    expect((await draftRow(ida.draftId)).status).toBe('pending');
  });

  it('turns automatic at the third approval', async () => {
    const j = await drafted('Jo');
    jo = j;
    const edited = await decide(j.draftId, b.owner, {
      edits: { body: 'Hi Jo! Tuesday at 10 works.' },
    });
    expect(edited.progress).toMatchObject({ status: 'training', approvedCount: 2, editedCount: 1 });
    const kai = await drafted('Kai');
    const last = await runFull(
      aiTeammateDecideDraft,
      { workspaceId: b.wsId, draftId: kai.draftId, decision: 'approve' },
      b.member,
    );
    expect(last.output.progress).toMatchObject({
      status: 'automatic',
      automaticVia: 'threshold',
      approvedCount: 3,
      remaining: 0,
      becameAutomatic: true,
    });
    expect((await eventsOf(last.eventIds)).map((e) => e.type)).toEqual(
      expect.arrayContaining(['ai_teammate.draft_decided', 'ai_teammate.status_changed']),
    );
  });

  it('asks owners and admins to decide approval drafts, which don’t count toward training', async () => {
    const lu = await drafted('Lu', 'approval');
    await expectHfos(() => decide(lu.draftId, b.member), 'forbidden', 'not_an_approver');
    expect((await decide(lu.draftId, b.owner)).progress).toMatchObject({
      approvedCount: 3,
      rejectedCount: 1,
    });
  });

  it('sends an approved draft as the teammate, with the approver’s name on it, once', async () => {
    const sent = await sys(b, aiTeammateSendDraft, { workspaceId: b.wsId, draftId: gus.draftId });
    expect(sent.output).toMatchObject({ conversationId: gus.conversationId, duplicate: false });
    const [m] = await admin()
      .select()
      .from(messages)
      .where(eq(messages.id, sent.output.messageId!));
    expect(m).toMatchObject({
      sentBy: null,
      sentByTeammateId: b.teammateId,
      approvedBy: b.member.id,
      aiDraftId: gus.draftId,
      bodyText: 'Hi Gus, we have Tuesday at 10.',
    });
    const [queued] = await admin()
      .select({ actorType: events.actorType, payload: events.payload, channel: auditLogs.channel })
      .from(events)
      .innerJoin(auditLogs, eq(auditLogs.eventId, events.id))
      .where(and(eq(events.entityId, m!.id), eq(events.eventType, 'message.queued')));
    expect(queued).toMatchObject({
      actorType: 'ai_employee',
      channel: 'ai_employee',
      payload: expect.objectContaining({
        _ai: { teammateId: b.teammateId, runId: null, approvedBy: b.member.id },
      }),
    });
    const again = await sys(b, aiTeammateSendDraft, { workspaceId: b.wsId, draftId: gus.draftId });
    expect(again.output).toMatchObject({ messageId: m!.id, duplicate: true });
    // The approver's edits are what goes out.
    const edited = await sys(b, aiTeammateSendDraft, { workspaceId: b.wsId, draftId: jo.draftId });
    const [e] = await admin()
      .select({ body: messages.bodyText, approvedBy: messages.approvedBy })
      .from(messages)
      .where(eq(messages.id, edited.output.messageId!));
    expect(e).toEqual({ body: 'Hi Jo! Tuesday at 10 works.', approvedBy: b.owner.id });
    // A draft nobody approved never goes out.
    const mo = await drafted('Mo');
    await expectHfos(
      () => sys(b, aiTeammateSendDraft, { workspaceId: b.wsId, draftId: mo.draftId }),
      'rule_violation',
      'draft_not_approved',
    );
  });

  it('lists drafts for Approvals: waiting ones oldest first, with who may decide', async () => {
    const waiting = await ask(aiTeammateDraftList, { workspaceId: b.wsId }, b.member);
    expect(waiting.items.length).toBeGreaterThanOrEqual(2);
    expect(waiting.items.every((d) => d.status === 'pending' && d.canDecide)).toBe(true);
    const created = waiting.items.map((d) => d.createdAt);
    expect(created).toEqual([...created].sort());
    const decided = await ask(
      aiTeammateDraftList,
      { workspaceId: b.wsId, status: 'decided' },
      b.member,
    );
    expect(decided.items.find((d) => d.kind === 'approval')).toMatchObject({
      status: 'approved',
      canDecide: false,
    });
    expect(decided.items.find((d) => d.id === jo.draftId)).toMatchObject({
      edits: { body: 'Hi Jo! Tuesday at 10 works.' },
      decidedBy: { id: b.owner.id },
      preview: { message: expect.objectContaining({ channel: 'sms' }) },
    });
  });

  it('restores an old revision without touching the counts, and “Back to training” resets them', async () => {
    const got = await ask(aiTeammateGet, { workspaceId: b.wsId }, b.owner);
    const restored = await run(
      aiTeammateRestore,
      {
        workspaceId: b.wsId,
        teammateId: b.teammateId,
        revision: 1,
        baseRevision: got.teammate!.revision,
      },
      b.owner,
    );
    expect(restored.revision).toBe(got.teammate!.revision + 1);
    expect(restored.changes[0]).toBe('Restored revision 1');
    expect((await ask(aiTeammateGet, { workspaceId: b.wsId }, b.owner)).progress).toMatchObject({
      status: 'automatic',
      approvedCount: 3,
      editedCount: 1,
      rejectedCount: 1,
    });
    const back = await run(
      aiTeammateSetStatus,
      { workspaceId: b.wsId, teammateId: b.teammateId, status: 'training' },
      b.owner,
    );
    expect(back.progress).toMatchObject({
      status: 'training',
      approvedCount: 0,
      editedCount: 0,
      rejectedCount: 0,
      automaticVia: null,
    });
  });
});

describe('the teammate’s settings and status', () => {
  it('saves over the revision it started from, and keeps each save', async () => {
    const got = await ask(aiTeammateGet, { workspaceId: a.wsId }, a.owner);
    const base = got.teammate!.revision;
    const next = applyTeammatePatch(parseTeammateConfig(got.teammate!.config), {
      identity: { toneNote: 'Warm and brief.' },
    });
    const save = (baseRevision: number, config: unknown, u = a.owner) =>
      run(
        aiTeammateSaveConfig,
        { workspaceId: a.wsId, teammateId: a.teammateId, baseRevision, config },
        u,
      );
    const saved = await save(base, next);
    expect(saved).toMatchObject({ revision: base + 1, changes: ['Tone note changed'] });
    const stale = await expectHfos(() => save(base, next), 'conflict', 'revision_conflict');
    expect(stale.details).toEqual({ revision: base + 1 });
    expect(await save(base + 1, next)).toMatchObject({ revision: base + 1, changes: [] });
    await expectHfos(() => save(base + 1, next, a.member), 'forbidden');
    await expectHfos(
      () => save(base + 1, { ...next, autonomy: { approvalsNeeded: 2 } }),
      'validation',
    );
    const seen = await ask(aiTeammateGet, { workspaceId: a.wsId }, a.member);
    expect(seen.canManage).toBe(false);
    expect(seen.revisions[0]).toMatchObject({
      revision: base + 1,
      diffSummary: ['Tone note changed'],
      changedBy: { id: a.owner.id },
    });
    expect(seen.issues.map((i) => i.code)).toContain('thin_knowledge');
    expect(seen.catalogs.calendars.map((c) => c.name).sort()).toEqual(['Office', 'Visits']);
  });

  it('won’t turn on with conflicting settings, and moves between training and automatic', async () => {
    const status = (to: 'off' | 'training' | 'automatic') =>
      run(
        aiTeammateSetStatus,
        { workspaceId: a.wsId, teammateId: a.teammateId, status: to },
        a.owner,
      );
    expect((await status('off')).progress.status).toBe('off');
    // Hand back is refused while it's off.
    const hy = await customer(a, 'Hy');
    const hello = await textIn(a, hy.phone, 'Hello?');
    await expectHfos(
      () =>
        run(
          conversationHandToAi,
          { workspaceId: a.wsId, conversationId: hello.conversationId },
          a.owner,
        ),
      'rule_violation',
      'teammate_off',
    );
    const got = await ask(aiTeammateGet, { workspaceId: a.wsId }, a.owner);
    const good = got.teammate!.revision;
    // Saving is never blocked by a conflict; turning it on is.
    const broken = await saveTeammate(a, { book: { enabled: true, calendarIds: [] } });
    const refused = await expectHfos(() => status('training'), 'rule_violation', 'teammate_issues');
    expect(refused.status).toBe(422);
    expect((refused.details as { issues: { code: string }[] }).issues.map((i) => i.code)).toContain(
      'booking_needs_calendar',
    );
    await run(
      aiTeammateRestore,
      {
        workspaceId: a.wsId,
        teammateId: a.teammateId,
        revision: good,
        baseRevision: broken.revision,
      },
      a.owner,
    );
    expect((await status('training')).progress.status).toBe('training');
    expect((await status('automatic')).progress).toMatchObject({
      status: 'automatic',
      automaticVia: 'override',
    });
    expect((await status('training')).progress).toMatchObject({
      status: 'training',
      automaticVia: null,
      approvedCount: 0,
    });
  });
});

describe('the inbox boxes and Activity', () => {
  it('lists conversations waiting for a person oldest first, and the teammate’s own', async () => {
    const needsPerson = await rows<{ id: string }>(
      admin(),
      sql`select id from app.conversations
          where workspace_id = ${a.wsId} and status = 'open' and needs_person_since is not null and last_message_at is not null
          order by needs_person_since, id`,
    );
    const handledByAi = await rows<{ id: string }>(
      admin(),
      sql`select id from app.conversations
          where workspace_id = ${a.wsId} and status = 'open' and handled_by = 'ai' and last_message_at is not null`,
    );
    expect(needsPerson.length).toBeGreaterThan(1);
    expect(handledByAi.length).toBeGreaterThan(1);
    const box = (name: 'needs_person' | 'ai') =>
      ask(inboxList, { workspaceId: a.wsId, box: name, limit: 100 }, a.owner);
    expect((await box('needs_person')).items.map((c) => c.id)).toEqual(
      needsPerson.map((r) => r.id),
    );
    expect(new Set((await box('ai')).items.map((c) => c.id))).toEqual(
      new Set(handledByAi.map((r) => r.id)),
    );
    expect(await ask(inboxSummary, { workspaceId: a.wsId }, a.owner)).toMatchObject({
      needsPerson: needsPerson.length,
      ai: handledByAi.length,
    });
  });

  it('counts today’s runs and lists them newest first', async () => {
    const [n] = await rows<{ n: number }>(
      admin(),
      sql`select count(*)::int as n from app.ai_teammate_runs where workspace_id = ${a.wsId} and not is_test`,
    );
    const activity = await ask(aiTeammateActivity, { workspaceId: a.wsId }, a.member);
    expect(activity.counters).toMatchObject({ runsToday: n!.n, draftedToday: n!.n });
    expect(activity.counters.needsPerson).toBeGreaterThan(0);
    expect(activity.runs.length).toBe(n!.n);
    const started = activity.runs.map((r) => r.startedAt);
    expect(started).toEqual([...started].sort().reverse());
  });
});

describe('business open hours', () => {
  it('are checked when saved, and are weekdays 8 to 5 until someone sets them', async () => {
    expect(DEFAULT_OPEN_HOURS).toEqual(
      [1, 2, 3, 4, 5].map((day) => ({ day, start: '08:00', end: '17:00' })),
    );
    expect(openHoursOf({})).toEqual(DEFAULT_OPEN_HOURS);
    const update = (openHours: unknown) =>
      run(workspaceUpdate, { workspaceId: a.wsId, settings: { openHours } }, a.owner);
    const backwards = await expectHfos(
      () => update([{ day: 1, start: '17:00', end: '08:00' }]),
      'validation',
    );
    expect(backwards.details).toEqual([
      { path: 'settings.openHours.0.end', message: 'End after the start.' },
    ]);
    const overlap = await expectHfos(
      () =>
        update([
          { day: 2, start: '08:00', end: '12:00' },
          { day: 2, start: '11:00', end: '17:00' },
        ]),
      'validation',
    );
    expect(overlap.details).toEqual([
      { path: 'settings.openHours', message: 'These hours overlap.' },
    ]);
    const hours = [
      { day: 1, start: '07:00', end: '12:00' },
      { day: 1, start: '13:00', end: '19:00' },
      { day: 6, start: '09:00', end: '13:00' },
    ];
    expect((await update(hours)).updated).toEqual(['settings']);
    const businessHours = async () =>
      (await ask(aiTeammateGet, { workspaceId: a.wsId }, a.owner)).catalogs.businessHours;
    expect(await businessHours()).toEqual(hours);
    await update(null);
    expect(await businessHours()).toEqual(DEFAULT_OPEN_HOURS);
  });
});

describe('fixes from the step 3 security review', () => {
  it('sends to its customer alone: nobody copied in, no attachments, never a mailbox (F3)', async () => {
    const email = `flo-${randomUUID().slice(0, 6)}@example.com`;
    const flo = await customer(a, 'Flo', { email });
    const [c] = await rows<{ id: string }>(
      admin(),
      sql`insert into app.conversations (workspace_id, channel, counterpart, person_id, handled_by, ai_teammate_id)
          values (${a.wsId}, 'email', ${email}, ${flo.personId}, 'ai', ${a.teammateId}) returning id`,
    );
    const mail = {
      workspaceId: a.wsId,
      conversationId: c!.id,
      channel: 'email',
      subject: 'Your visit',
      body: 'See you Tuesday at 10.',
      clientId: randomUUID(),
    };
    const extras: [Record<string, unknown>, string][] = [
      [{ cc: ['boss@example.com'] }, 'cc'],
      [{ attachmentFileIds: [randomUUID()] }, 'attachmentFileIds'],
      [{ mailboxConnectionId: randomUUID() }, 'mailboxConnectionId'],
    ];
    for (const [extra, path] of extras) {
      const err = await expectHfos(
        () => asAva(a, { conversationId: c!.id }, messageSend, { ...mail, ...extra }),
        'validation',
      );
      expect(err.details).toEqual([expect.objectContaining({ path })]);
    }
  });

  it('opens only a plain lead, in an open stage (F4)', async () => {
    const lou = await aiChat(a, 'Lou');
    const me = { conversationId: lou.conversationId };
    const lead = { workspaceId: a.wsId, title: 'New system', personId: lou.personId };
    const won = await stageOf(a, 'won');
    await expectHfos(
      () => asAva(a, me, leadCreate, { ...lead, stageId: won }),
      'rule_violation',
      'stage_not_open',
    );
    const { tagId } = await run(
      tagCreate,
      { workspaceId: a.wsId, name: `Warm ${randomUUID().slice(0, 4)}` },
      a.owner,
    );
    const extras: [Record<string, unknown>, string][] = [
      [{ assigneeUserId: a.owner.id }, 'assigneeUserId'],
      [{ valueCents: 500_000 }, 'valueCents'],
      [{ tagIds: [tagId] }, 'tagIds'],
    ];
    for (const [extra, path] of extras) {
      const err = await expectHfos(
        () => asAva(a, me, leadCreate, { ...lead, ...extra }),
        'validation',
      );
      expect(err.details).toEqual([expect.objectContaining({ path })]);
    }
    expect((await asAva(a, me, leadCreate, lead)).output.leadId).toBeTruthy();
  });

  it('refuses every command from the test console, however it’s called (F5)', async () => {
    const tee = await aiChat(a, 'Tee');
    const trial = { conversationId: tee.conversationId, test: true };
    const note = { workspaceId: a.wsId, kind: 'note', body: 'Test only.', personId: tee.personId };
    await expectHfos(() => asAva(a, trial, activityLog, note), 'forbidden', 'test_run_read_only');
    await expectHfos(
      () =>
        asAva(a, trial, messageSend, {
          workspaceId: a.wsId,
          conversationId: tee.conversationId,
          body: 'Hi Tee!',
          clientId: randomUUID(),
        }),
      'forbidden',
      'test_run_read_only',
    );
    await expectHfos(
      () =>
        asWorker(worker(), { workspaceId: a.wsId, organizationId: a.orgId }, (tx) =>
          executeCommandIn(tx, activityLog, note, ava(a, trial), meta('ai_employee')),
        ),
      'forbidden',
      'test_run_read_only',
    );
    // The same note outside the console goes through.
    expect(
      (await asAva(a, { conversationId: tee.conversationId }, activityLog, note)).output.activityId,
    ).toBeTruthy();
  });

  it('stops a run already under way once a person takes over, and works while nobody has (F6)', async () => {
    const pat = await aiChat(a, 'Pat');
    const me = { conversationId: pat.conversationId };
    const note = {
      workspaceId: a.wsId,
      kind: 'note',
      body: 'Wants mornings.',
      personId: pat.personId,
    };
    await run(
      conversationTakeOver,
      { workspaceId: a.wsId, conversationId: pat.conversationId },
      a.owner,
    );
    await expectHfos(() => asAva(a, me, activityLog, note), 'rule_violation', 'not_handled_by_ai');
    await expectHfos(
      () => asAva(a, me, leadCreate, { workspaceId: a.wsId, title: 'AC', personId: pat.personId }),
      'rule_violation',
      'not_handled_by_ai',
    );
    await expectHfos(
      () =>
        asAva(a, me, personUpdate, {
          workspaceId: a.wsId,
          personId: pat.personId,
          email: 'pat@example.com',
        }),
      'rule_violation',
      'not_handled_by_ai',
    );
    // Nobody in particular handles it now: the AI may note things for its customer again.
    await rows(
      admin(),
      sql`update app.conversations set handled_by = 'none', taken_over_by = null
          where id = ${pat.conversationId}`,
    );
    expect((await asAva(a, me, activityLog, note)).output.activityId).toBeTruthy();
  });
});
