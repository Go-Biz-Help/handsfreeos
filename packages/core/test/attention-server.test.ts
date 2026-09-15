/**
 * M8 step 3 on the local database: reconcile (open, refresh, reopen and resolve by the fingerprint rules, one card
 * per lead, and nothing written when nothing changed), the hot lead (an automatic reply halves its urgency, a
 * person's contact settles it), the item commands and their permissions (assign passes through to the lead;
 * approval items only for the people who can decide them), Let HandsFreeOS Handle, attention.list (ranking,
 * Mine and Everyone, "$ affected" once per lead) and preview_handle.
 */
import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { asWorker, rows, sql } from '@hfos/db/client';
import { attentionItems, auditLogs, events, leads } from '@hfos/db/schema';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import type { AttentionChip } from '../src/attention/index';
import { reconcile, type AttentionItemRow, type AttentionSubjectRef } from '../src/attention/load';
import { ALWAYS_OPEN_HOURS } from '../src/calendar/load';
import { HfosError } from '../src/errors';
import { executeCommand, executeQuery } from '../src/kernel/execute';
import type {
  CommandDef,
  HumanActor,
  QueryDef,
  RequestMeta,
  SystemActor,
  WorkflowActor,
} from '../src/kernel/types';
import {
  activityLog,
  attentionAssign,
  attentionCancelAuto,
  attentionDismiss,
  attentionForRecord,
  attentionLetHandle,
  attentionList,
  attentionPreviewHandle,
  attentionRecordAuto,
  attentionRestore,
  attentionSaveSettings,
  attentionSnooze,
  attentionSummary,
  attentionUnsnooze,
  leadCreate,
  leadSetNextAction,
  leadUpdate,
  messageReceive,
  messageSend,
  organizationCreate,
  personCreate,
  phoneUpdateSettings,
  taskCreate,
  workspaceUpdate,
} from '../src/server';

const api = () => testDbs().api.db;
const worker = () => testDbs().worker.db;
const admin = () => testDbs().admin.db;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const later = (ms: number) => new Date(Date.now() + ms);

const human = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: u.claims,
});
const meta = (
  channel: RequestMeta['channel'] = 'test',
  correlationId = randomUUID(),
): RequestMeta => ({
  correlationId,
  channel,
});
const run = <I extends z.ZodType, O extends z.ZodType>(
  cmd: CommandDef<I, O>,
  input: unknown,
  u: TestUser,
) => executeCommand(api(), cmd, input, human(u), meta()).then((r) => r.output);
const ask = <I extends z.ZodType, O extends z.ZodType>(
  q: QueryDef<I, O>,
  input: unknown,
  u: TestUser,
) => executeQuery(api(), q, input, human(u), meta());

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

interface Biz {
  readonly owner: TestUser;
  readonly admin: TestUser;
  readonly member: TestUser;
  readonly wsId: string;
  readonly orgId: string;
  /** The business number customers text. */
  readonly number: string;
}
let a: Biz;
let b: Biz;

const system = (biz: Biz): SystemActor => ({
  type: 'system',
  workspaceId: biz.wsId,
  organizationId: biz.orgId,
});
const sys = <I extends z.ZodType, O extends z.ZodType>(
  biz: Biz,
  cmd: CommandDef<I, O>,
  input: unknown,
) => executeCommand(worker(), cmd, input, system(biz), meta('worker')).then((r) => r.output);
const flow = (biz: Biz): WorkflowActor => ({
  type: 'workflow',
  workspaceId: biz.wsId,
  organizationId: biz.orgId,
  workflowId: randomUUID(),
  versionId: null,
  runId: randomUUID(),
  stepKey: 'text_1#1',
  depth: 0,
  originRunId: null,
  workflowName: 'Speed to lead',
  test: false,
});
const asFlow = <I extends z.ZodType, O extends z.ZodType>(
  biz: Biz,
  cmd: CommandDef<I, O>,
  input: unknown,
) => executeCommand(worker(), cmd, input, flow(biz), meta('workflow')).then((r) => r.output);

/** The worker's reconcile, bound to the business. */
const settle = (
  biz: Biz,
  subjects: readonly AttentionSubjectRef[] | 'all',
  at: Date = new Date(),
) =>
  asWorker(worker(), { workspaceId: biz.wsId, organizationId: biz.orgId }, (tx) =>
    reconcile(tx, biz.wsId, subjects, at),
  );
const itemsFor = (biz: Biz, subjectIds: readonly string[]): Promise<AttentionItemRow[]> =>
  admin()
    .select()
    .from(attentionItems)
    .where(
      and(
        eq(attentionItems.workspaceId, biz.wsId),
        inArray(attentionItems.subjectId, [...subjectIds]),
      ),
    );
const itemOf = async (biz: Biz, subjectId: string, kind: string) =>
  (await itemsFor(biz, [subjectId])).find((r) => r.kind === kind)!;
const codes = (row: { reasons: unknown }) => (row.reasons as AttentionChip[]).map((c) => c.code);

const randomE164 = () =>
  `+1${2 + Math.floor(Math.random() * 8)}${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`;
let phoneSeq = 0;
const nextPhone = () => `+1737555${String(1000 + phoneSeq++).padStart(4, '0')}`;

/** An active toll-free number the carriers approved, so texts can be queued. */
async function readyTexting(wsId: string): Promise<string> {
  const e164 = randomE164();
  const [account] = await rows<{ id: string }>(
    admin(),
    sql`insert into app.telephony_accounts (workspace_id, provider, account_sid, status)
        values (${wsId}, 'fake', ${`ACat${randomUUID().slice(0, 8)}`}, 'active') returning id`,
  );
  const [number] = await rows<{ id: string }>(
    admin(),
    sql`insert into app.phone_numbers (workspace_id, account_id, provider_sid, e164, number_type, status)
        values (${wsId}, ${account!.id}, ${`PNat${randomUUID().slice(0, 8)}`}, ${e164}, 'toll_free', 'active')
        returning id`,
  );
  await rows(
    admin(),
    sql`insert into app.telephony_registrations (workspace_id, account_id, phone_number_id, kind, status, provider_sid, approved_at)
        values (${wsId}, ${account!.id}, ${number!.id}, 'toll_free_verification', 'approved', ${`HHat${randomUUID().slice(0, 8)}`}, now())`,
  );
  return e164;
}

/** A Chicago business open around the clock (so open-hours minutes are plain minutes), texting ready, no quiet hours. */
async function setup(label: string): Promise<Biz> {
  const [owner, adminUser, member] = await Promise.all([
    createTestUser(`attn-${label}-owner`, { fullName: 'Dale Owner' }),
    createTestUser(`attn-${label}-admin`, { fullName: 'Priya Admin' }),
    createTestUser(`attn-${label}-member`, { fullName: 'Marco Member' }),
  ]);
  const org = await run(
    organizationCreate,
    { businessName: `${label} HVAC`, timezone: 'America/Chicago' },
    owner,
  );
  for (const [u, role] of [
    [adminUser, 'admin'],
    [member, 'member'],
  ] as const)
    await rows(
      admin(),
      sql`insert into app.workspace_memberships (workspace_id, user_id, role) values (${org.workspaceId}, ${u.id}, ${role})`,
    );
  const biz: Biz = {
    owner,
    admin: adminUser,
    member,
    wsId: org.workspaceId,
    orgId: org.organizationId,
    number: await readyTexting(org.workspaceId),
  };
  await run(
    phoneUpdateSettings,
    { workspaceId: biz.wsId, quietHours: { enabled: false, start: '20:00', end: '08:00' } },
    owner,
  );
  await run(
    workspaceUpdate,
    { workspaceId: biz.wsId, settings: { openHours: ALWAYS_OPEN_HOURS } },
    owner,
  );
  return biz;
}

/** A customer the worker filed (a web form, a text): nobody on the team typed them in. */
async function customer(biz: Biz, firstName: string, extra: Record<string, unknown> = {}) {
  const { personId } = await sys(biz, personCreate, {
    workspaceId: biz.wsId,
    firstName,
    lastName: 'Test',
    ignoreDuplicates: true,
    ...extra,
  });
  return personId;
}
/** A lead that came in on its own. */
const inboundLead = async (
  biz: Biz,
  personId: string,
  title: string,
  extra: Record<string, unknown> = {},
) => (await sys(biz, leadCreate, { workspaceId: biz.wsId, title, personId, ...extra })).leadId;
/** A lead someone on the team typed in, ten days ago, with its next action well ahead: stale, nothing else. */
async function staleLead(
  biz: Biz,
  personId: string,
  title: string,
  extra: Record<string, unknown> = {},
) {
  const { leadId } = await run(
    leadCreate,
    {
      workspaceId: biz.wsId,
      title,
      personId,
      nextAction: 'Check in about the quote',
      nextActionAt: later(60 * DAY).toISOString(),
      ...extra,
    },
    biz.owner,
  );
  await rows(
    admin(),
    sql`update app.leads set created_at = now() - interval '10 days', stage_entered_at = now() - interval '10 days'
        where id = ${leadId}`,
  );
  return leadId;
}
const text = (biz: Biz, from: string, body: string) =>
  sys(biz, messageReceive, {
    workspaceId: biz.wsId,
    provider: 'fake',
    providerMessageId: `SMat-${randomUUID()}`,
    from,
    to: biz.number,
    body,
  });

beforeAll(async () => {
  [a, b] = await Promise.all([setup('Alpha'), setup('Bravo')]);
});
afterAll(closeTestDbs);

describe('reconcile', () => {
  it('opens one card per lead, refreshes it quietly, and writes nothing when nothing changed', async () => {
    const maria = await customer(a, 'Maria');
    const leadId = await inboundLead(a, maria, 'AC replacement');
    const at = later(30 * MIN);
    const opened = await settle(a, [{ type: 'lead', id: leadId }], at);
    expect(opened.transitions.map((t) => [t.type, t.kind])).toEqual([
      ['opened', 'unanswered_lead'],
    ]);
    const [card] = await itemsFor(a, [leadId]);
    // The missing next action folded into the card as a chip, with no row of its own.
    expect(card).toMatchObject({ kind: 'unanswered_lead', state: 'open', valueIsEstimate: true });
    expect(codes(card!)).toEqual(expect.arrayContaining(['not_contacted', 'no_next_action']));
    expect(card!.title).toBe('Maria Test · AC replacement');

    const again = await settle(a, [{ type: 'lead', id: leadId }], at);
    expect(again).toMatchObject({ transitions: [], updated: [] });
    const [same] = await itemsFor(a, [leadId]);
    expect(same!.updatedAt.getTime()).toBe(card!.updatedAt.getTime());

    // Under the hot threshold ($5,000), so the lead's value changes quietly.
    await run(leadUpdate, { workspaceId: a.wsId, leadId, valueCents: 250_000 }, a.owner);
    const refreshed = await settle(a, [{ type: 'lead', id: leadId }], at);
    expect(refreshed).toMatchObject({ transitions: [], updated: [card!.id] });
    expect(await itemOf(a, leadId, 'unanswered_lead')).toMatchObject({
      valueCents: 250_000,
      valueIsEstimate: false,
      moneyKey: `lead:${leadId}`,
    });

    // A person calls: nobody's waiting on a first reply now, and the lead's next card opens.
    await run(
      activityLog,
      {
        workspaceId: a.wsId,
        kind: 'call',
        body: 'Called Maria about the quote',
        leadId,
        personId: maria,
      },
      a.owner,
    );
    const called = await settle(a, [{ type: 'lead', id: leadId }], at);
    expect(called.transitions.map((t) => [t.type, t.kind, t.resolution])).toEqual(
      expect.arrayContaining([
        ['resolved', 'unanswered_lead', 'contacted'],
        ['opened', 'missing_next_action', null],
      ]),
    );

    const dueAt = later(2 * DAY).toISOString();
    await run(
      leadSetNextAction,
      { workspaceId: a.wsId, leadId, text: 'Send the quote', dueAt },
      a.owner,
    );
    const set = await settle(a, [{ type: 'lead', id: leadId }], at);
    expect(set.transitions.map((t) => [t.type, t.kind, t.resolution])).toEqual([
      ['resolved', 'missing_next_action', 'next_action_set'],
    ]);
    // It looks again when the follow-up comes due.
    expect(set.rechecks).toContainEqual({ subjectType: 'lead', subjectId: leadId, at: dueAt });
  });

  it('keeps a snooze and a dismissal while the facts hold, and a stale lead comes back once it goes stale again', async () => {
    const ken = await customer(a, 'Ken');
    const leadId = await staleLead(a, ken, 'Duct cleaning');
    const opened = await settle(a, [{ type: 'lead', id: leadId }]);
    expect(opened.transitions).toMatchObject([{ type: 'opened', kind: 'stale_opportunity' }]);
    const itemId = opened.transitions[0]!.itemId;

    await run(
      attentionSnooze,
      { workspaceId: a.wsId, itemId, until: later(2 * HOUR).toISOString() },
      a.member,
    );
    expect((await settle(a, [{ type: 'lead', id: leadId }])).transitions).toEqual([]);
    const woke = await settle(a, [{ type: 'lead', id: leadId }], later(3 * HOUR));
    expect(woke.transitions).toMatchObject([{ type: 'unsnoozed', from: 'snoozed', state: 'open' }]);

    await run(
      attentionDismiss,
      { workspaceId: a.wsId, itemId, reason: 'Waiting on their insurance' },
      a.member,
    );
    expect((await settle(a, [{ type: 'lead', id: leadId }], later(3 * HOUR))).transitions).toEqual(
      [],
    );
    expect(await itemOf(a, leadId, 'stale_opportunity')).toMatchObject({
      state: 'dismissed',
      dismissReason: 'Waiting on their insurance',
      dismissedBy: a.member.id,
    });

    // A visit: not stale any more.
    await run(
      activityLog,
      { workspaceId: a.wsId, kind: 'visit', body: 'Measured the ducts', leadId, personId: ken },
      a.owner,
    );
    const contacted = await settle(a, [{ type: 'lead', id: leadId }]);
    expect(contacted.transitions).toMatchObject([
      { type: 'resolved', from: 'dismissed', resolution: 'contacted' },
    ]);
    // A week on, that contact has gone stale in turn: new facts, so it's back.
    const again = await settle(a, [{ type: 'lead', id: leadId }], later(8 * DAY));
    expect(again.transitions).toMatchObject([
      { type: 'reopened', kind: 'stale_opportunity', from: 'resolved', state: 'open' },
    ]);
  });
});

describe('the hot lead', () => {
  it('folds the rest into one card; an automatic reply takes the edge off; a person’s contact settles it', async () => {
    const phone = nextPhone();
    const rosa = await customer(a, 'Rosa', { phone });
    const leadId = await inboundLead(a, rosa, 'No cooling');
    const at = later(3 * DAY);
    const person = [{ type: 'person' as const, id: rosa }];
    expect((await settle(a, person, at)).transitions.map((t) => t.kind)).toEqual([
      'unanswered_lead',
    ]);

    // She writes, ready to book: hot. The unanswered card and her waiting text fold into it.
    const { conversationId } = await text(a, phone, 'Can someone come out today? The AC quit.');
    const hot = await settle(a, person, at);
    expect(hot.transitions.map((t) => [t.type, t.kind, t.resolution])).toEqual(
      expect.arrayContaining([
        ['opened', 'hot_lead', null],
        ['resolved', 'unanswered_lead', 'folded'],
      ]),
    );
    const rows1 = await itemsFor(a, [leadId, conversationId]);
    expect(rows1.filter((r) => r.state === 'open').map((r) => r.kind)).toEqual(['hot_lead']);
    expect(rows1.some((r) => r.kind === 'customer_waiting')).toBe(false);
    const card = rows1.find((r) => r.kind === 'hot_lead')!;
    expect(card.conversationId).toBe(conversationId);
    expect(card.urgentFrom).not.toBeNull();
    expect(codes(card)).toEqual(
      expect.arrayContaining(['ready_to_book', 'not_contacted', 'waiting']),
    );
    const listed = await ask(attentionList, { workspaceId: a.wsId, scope: 'everyone' }, a.owner);
    const before = listed.items.find((i) => i.id === card.id)!;
    expect(before.urgency).toBeGreaterThanOrEqual(2);

    // A workflow answers for the business: still hot (no person yet), not urgent, half the urgency.
    await asFlow(a, messageSend, {
      workspaceId: a.wsId,
      conversationId,
      body: 'Thanks Rosa! Someone will call you shortly.',
    });
    const auto = await settle(a, person, at);
    expect(auto.transitions).toEqual([]);
    expect(auto.updated).toEqual([card.id]);
    const softened = await itemOf(a, leadId, 'hot_lead');
    expect(softened).toMatchObject({ state: 'open', urgentFrom: null });
    expect(codes(softened)).toContain('auto_replied');
    expect(codes(softened)).not.toContain('not_contacted');
    const after = (
      await ask(attentionList, { workspaceId: a.wsId, scope: 'everyone' }, a.owner)
    ).items.find((i) => i.id === card.id)!;
    expect(after.urgent).toBe(false);
    expect(after.urgency).toBeCloseTo(before.urgency / 2, 1);

    // A person reaches her: settled.
    await run(
      messageSend,
      { workspaceId: a.wsId, conversationId, body: 'Hi Rosa, Dale here. I can be there at 3.' },
      a.owner,
    );
    const settled = await settle(a, person, at);
    expect(settled.transitions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'resolved', kind: 'hot_lead', resolution: 'contacted' }),
      ]),
    );
  });
});

describe('item commands', () => {
  it('assign changes the lead’s owner as the person, and Undo puts it back', async () => {
    const pat = await customer(a, 'Pat');
    const leadId = await staleLead(a, pat, 'Furnace tune-up');
    const itemId = (await settle(a, [{ type: 'lead', id: leadId }])).transitions[0]!.itemId;
    const correlationId = randomUUID();
    await executeCommand(
      api(),
      attentionAssign,
      { workspaceId: a.wsId, itemId, assigneeUserId: a.admin.id },
      human(a.member),
      meta('test', correlationId),
    );
    const [lead] = await admin()
      .select({ assignee: leads.assigneeUserId })
      .from(leads)
      .where(eq(leads.id, leadId));
    expect(lead!.assignee).toBe(a.admin.id);
    expect(await itemOf(a, leadId, 'stale_opportunity')).toMatchObject({
      assigneeUserId: a.admin.id,
    });
    const audit = await admin()
      .select({ action: auditLogs.action, actorId: auditLogs.actorId })
      .from(auditLogs)
      .where(eq(auditLogs.correlationId, correlationId));
    expect(audit.map((x) => x.action).sort()).toEqual([
      'attention.assign',
      'lead.update',
      'lead.update',
    ]);
    expect(new Set(audit.map((x) => x.actorId))).toEqual(new Set([a.member.id]));
    const types = await admin()
      .select({ type: events.eventType })
      .from(events)
      .where(eq(events.correlationId, correlationId));
    expect(types.map((x) => x.type).sort()).toEqual([
      'attention.assigned',
      'lead.assigned',
      'lead.updated',
    ]);

    const undo = await run(
      attentionAssign,
      { workspaceId: a.wsId, itemId, assigneeUserId: null },
      a.member,
    );
    expect(undo).toMatchObject({
      passedTo: 'lead',
      previousAssigneeUserId: a.admin.id,
      changed: true,
    });
    const [back] = await admin()
      .select({ assignee: leads.assigneeUserId })
      .from(leads)
      .where(eq(leads.id, leadId));
    expect(back!.assignee).toBeNull();
    await expectHfos(
      () =>
        run(attentionAssign, { workspaceId: a.wsId, itemId, assigneeUserId: b.owner.id }, a.member),
      'validation',
    );
  });

  it('snoozes, dismisses and restores; cancels a waiting automatic action; records what HandsFreeOS sent', async () => {
    const jo = await customer(a, 'Jo');
    const leadId = await staleLead(a, jo, 'Water heater');
    const itemId = (await settle(a, [{ type: 'lead', id: leadId }])).transitions[0]!.itemId;
    const ref = { workspaceId: a.wsId, itemId };
    await expectHfos(
      () => run(attentionSnooze, { ...ref, until: later(31 * DAY).toISOString() }, a.member),
      'validation',
    );
    expect(
      await run(attentionSnooze, { ...ref, until: later(DAY).toISOString() }, a.member),
    ).toMatchObject({
      state: 'snoozed',
      changed: true,
    });
    expect(await run(attentionUnsnooze, ref, a.member)).toMatchObject({
      state: 'open',
      changed: true,
    });
    await run(attentionDismiss, ref, a.member);
    expect(await run(attentionRestore, ref, a.member)).toMatchObject({
      state: 'open',
      changed: true,
    });
    expect(await run(attentionRestore, ref, a.member)).toMatchObject({ changed: false });

    // The worker schedules a nudge; a person stops it.
    const fingerprint = (await itemOf(a, leadId, 'stale_opportunity')).fingerprint;
    await sys(a, attentionRecordAuto, {
      ...ref,
      action: 'nudge',
      outcome: 'scheduled',
      fingerprint,
      scheduledFor: later(HOUR).toISOString(),
    });
    const list = await ask(attentionList, { workspaceId: a.wsId, scope: 'everyone' }, a.member);
    expect(list.scheduled).toContainEqual(expect.objectContaining({ itemId, action: 'nudge' }));
    expect(await run(attentionCancelAuto, ref, a.member)).toMatchObject({
      autoState: 'cancelled',
      changed: true,
    });
    expect(await run(attentionCancelAuto, ref, a.member)).toMatchObject({ changed: false });
    await expectHfos(
      () =>
        sys(a, attentionRecordAuto, {
          ...ref,
          action: 'nudge',
          outcome: 'scheduled',
          fingerprint: 'stale|v1|x',
          scheduledFor: later(HOUR).toISOString(),
        }),
      'rule_violation',
      'attention_facts_changed',
    );

    // Sent at a person's request: handled through Let HandsFreeOS Handle, in the Handled section.
    await sys(a, attentionRecordAuto, {
      ...ref,
      action: 'nudge',
      outcome: 'sent',
      channel: 'email',
      requestedBy: a.owner.id,
    });
    expect(await itemOf(a, leadId, 'stale_opportunity')).toMatchObject({
      state: 'handled',
      handledVia: 'let_handle',
      handledBy: a.owner.id,
      autoState: 'sent',
    });
    const handled = await ask(
      attentionList,
      { workspaceId: a.wsId, scope: 'everyone', includeHandled: true },
      a.owner,
    );
    expect(handled.handled.map((i) => i.id)).toContain(itemId);
    expect(handled.handledToday).toBeGreaterThanOrEqual(1);
    await expectHfos(
      () => run(attentionSnooze, { ...ref, until: later(DAY).toISOString() }, a.member),
      'rule_violation',
      'attention_not_open',
    );
  });

  it('keeps an approval to the people who can decide it', async () => {
    const lee = await customer(a, 'Lee');
    const [wf] = await rows<{ id: string }>(
      admin(),
      sql`insert into app.workflows (workspace_id, name) values (${a.wsId}, 'Quote follow-up') returning id`,
    );
    const [version] = await rows<{ id: string }>(
      admin(),
      sql`insert into app.workflow_versions (workspace_id, workflow_id, version, definition, definition_version, revision)
          values (${a.wsId}, ${wf!.id}, 1, '{}'::jsonb, 1, 1) returning id`,
    );
    const [wfRun] = await rows<{ id: string }>(
      admin(),
      sql`insert into app.workflow_runs (workspace_id, workflow_id, version_id, person_id, status, dedupe_key)
          values (${a.wsId}, ${wf!.id}, ${version!.id}, ${lee}, 'awaiting_approval', ${randomUUID()}) returning id`,
    );
    const [approval] = await rows<{ id: string }>(
      admin(),
      sql`insert into app.workflow_approvals (workspace_id, workflow_id, run_id, step_key, approvers, preview)
          values (${a.wsId}, ${wf!.id}, ${wfRun!.id}, 'approve_1#1', array[${a.admin.id}]::uuid[],
            '{"summary":"Send Lee the 10% discount"}'::jsonb)
          returning id`,
    );
    const opened = await settle(a, [{ type: 'approval', id: approval!.id }]);
    expect(opened.transitions).toMatchObject([
      { type: 'opened', kind: 'ai_approval', assigneeUserId: a.admin.id },
    ]);
    const itemId = opened.transitions[0]!.itemId;

    const forMember = await ask(
      attentionList,
      { workspaceId: a.wsId, scope: 'everyone' },
      a.member,
    );
    expect(forMember.items.map((i) => i.id)).not.toContain(itemId);
    await expectHfos(
      () => run(attentionDismiss, { workspaceId: a.wsId, itemId }, a.member),
      'forbidden',
      'not_an_approver',
    );
    await expectHfos(
      () => ask(attentionPreviewHandle, { workspaceId: a.wsId, itemId }, a.member),
      'not_found',
    );

    for (const u of [a.admin, a.owner]) {
      const list = await ask(attentionList, { workspaceId: a.wsId, scope: 'everyone' }, u);
      expect(list.items.find((i) => i.id === itemId)).toMatchObject({
        kind: 'ai_approval',
        title: 'Lee Test · Workflow: Quote follow-up',
        detail: 'Send Lee the 10% discount',
        letHandleMode: 'none',
        actions: { handle: true, letHandle: false, dismiss: true },
      });
    }
    const preview = await ask(attentionPreviewHandle, { workspaceId: a.wsId, itemId }, a.admin);
    expect(preview).toMatchObject({ mode: 'none', auto: null, options: [] });
  });

  it('Let HandsFreeOS Handle replies as the person, and queues a nudge only once the message was read', async () => {
    const phone = nextPhone();
    const val = await customer(a, 'Val', { phone });
    const hotLead = await inboundLead(a, val, 'Heat pump quote');
    await text(a, phone, 'How soon could you install a heat pump?');
    const hot = (await settle(a, [{ type: 'person', id: val }])).transitions.find(
      (t) => t.kind === 'hot_lead',
    )!;
    const preview = await ask(
      attentionPreviewHandle,
      { workspaceId: a.wsId, itemId: hot.itemId },
      a.owner,
    );
    expect(preview.mode).toBe('ask');
    expect(preview.options).toEqual([
      expect.objectContaining({
        action: 'hand_to_ai',
        available: false,
        reason: 'Set up your AI teammate first.',
      }),
      expect.objectContaining({
        action: 'reply',
        available: true,
        channel: 'sms',
        label: 'Text them',
      }),
    ]);
    await expectHfos(
      () => run(attentionLetHandle, { workspaceId: a.wsId, itemId: hot.itemId }, a.owner),
      'validation',
    );
    const replied = await run(
      attentionLetHandle,
      {
        workspaceId: a.wsId,
        itemId: hot.itemId,
        action: 'reply',
        body: 'Hi Val, we can come Thursday.',
      },
      a.owner,
    );
    expect(replied).toMatchObject({
      mode: 'ask',
      action: 'reply',
      status: 'done',
      state: 'handled',
    });
    expect(replied.messageId).toBeTruthy();
    expect(await itemOf(a, hotLead, 'hot_lead')).toMatchObject({
      state: 'handled',
      handledVia: 'let_handle',
      handledBy: a.owner.id,
    });

    // A stale lead's nudge waits for an owner to read the message once; then it goes by email to someone who
    // never agreed to texts.
    const sam = await customer(a, 'Sam', { phone: nextPhone(), email: 'sam@example.com' });
    const staleId = await staleLead(a, sam, 'Attic insulation');
    const stale = (await settle(a, [{ type: 'lead', id: staleId }])).transitions[0]!;
    const blocked = await ask(
      attentionPreviewHandle,
      { workspaceId: a.wsId, itemId: stale.itemId },
      a.owner,
    );
    expect(blocked).toMatchObject({
      mode: 'auto',
      auto: { action: 'nudge', blocked: { code: 'nudge_not_reviewed' } },
    });
    await expectHfos(
      () => run(attentionLetHandle, { workspaceId: a.wsId, itemId: stale.itemId }, a.owner),
      'rule_violation',
      'nudge_not_reviewed',
    );
    await expectHfos(
      () =>
        run(
          attentionSaveSettings,
          {
            workspaceId: a.wsId,
            settings: {
              nudge: {
                template:
                  'Hi {firstName}, 20% off this week only: $99. Book at https://deals.example.com',
              },
            },
          },
          a.owner,
        ),
      'validation',
    );
    await expectHfos(
      () =>
        run(
          attentionSaveSettings,
          {
            workspaceId: a.wsId,
            settings: { auto: { nudges: true, nudgeReviewedAt: new Date().toISOString() } },
          },
          a.member,
        ),
      'forbidden',
    );
    const saved = await run(
      attentionSaveSettings,
      {
        workspaceId: a.wsId,
        settings: { auto: { nudges: true, nudgeReviewedAt: '2020-01-01T00:00:00.000Z' } },
      },
      a.owner,
    );
    // The server's clock records the review, not the caller's.
    expect(Date.parse(saved.settings.auto.nudgeReviewedAt!)).toBeGreaterThan(Date.now() - HOUR);
    const ready = await ask(
      attentionPreviewHandle,
      { workspaceId: a.wsId, itemId: stale.itemId },
      a.owner,
    );
    expect(ready.auto).toMatchObject({
      action: 'nudge',
      channel: 'email',
      to: 'sam@example.com',
      blocked: null,
    });
    expect(ready.auto!.text).toContain('Hi Sam');
    expect(ready.auto!.notes).toContain('They haven’t agreed to texts, so this goes by email.');
    const queued = await run(
      attentionLetHandle,
      { workspaceId: a.wsId, itemId: stale.itemId },
      a.owner,
    );
    expect(queued).toMatchObject({ mode: 'auto', action: 'nudge', status: 'requested' });
    const [requested] = await rows<{ payload: Record<string, unknown> }>(
      admin(),
      sql`select payload from app.events where entity_id = ${stale.itemId} and event_type = 'attention.handle_requested'`,
    );
    expect(requested!.payload).toMatchObject({
      action: 'nudge',
      requestedBy: a.owner.id,
      channel: 'email',
    });
  });
});

describe('attention.list', () => {
  it('ranks, splits Mine from Everyone, and counts each lead’s value once', async () => {
    const phone = nextPhone();
    const ana = await customer(b, 'Ana', { phone });
    const big = await inboundLead(b, ana, 'Whole-house system', { valueCents: 4_000_000 });
    await text(b, phone, 'Can I book an appointment for today?');
    await run(
      taskCreate,
      {
        workspaceId: b.wsId,
        title: 'Order the condenser',
        dueAt: later(-2 * HOUR).toISOString(),
        allDay: false,
        assigneeUserId: b.member.id,
        leadId: big,
      },
      b.owner,
    );
    const bo = await customer(b, 'Bo');
    await staleLead(b, bo, 'Filter change', { valueCents: 50_000, assigneeUserId: b.admin.id });
    await settle(b, 'all');

    const everyone = await ask(attentionList, { workspaceId: b.wsId }, b.owner);
    expect(everyone.scope).toBe('everyone');
    expect(everyone.items.map((i) => i.kind)).toEqual([
      'hot_lead',
      expect.any(String),
      expect.any(String),
    ]);
    expect(new Set(everyone.items.map((i) => i.kind))).toEqual(
      new Set(['hot_lead', 'overdue_task', 'stale_opportunity']),
    );
    // The hot lead and the task are the same $40,000 lead: counted once, with the stale lead's $500.
    expect(everyone.affectedCents).toBe(4_050_000);
    // Mine is the viewer's: the owner's is the unassigned hot lead.
    expect(everyone.counts).toMatchObject({ total: 3, mine: 1, everyone: 3 });
    expect(everyone.items[0]!.reasons.map((r) => r.code)).toEqual(
      expect.arrayContaining(['value', 'ready_to_book']),
    );
    expect(everyone.items[0]!.actions).toMatchObject({
      handle: true,
      letHandle: true,
      assign: true,
    });

    const mine = await ask(attentionList, { workspaceId: b.wsId }, b.member);
    expect(mine.scope).toBe('mine');
    expect(new Set(mine.items.map((i) => i.kind))).toEqual(new Set(['hot_lead', 'overdue_task']));
    expect(mine.affectedCents).toBe(4_000_000);
    const badge = await ask(attentionSummary, { workspaceId: b.wsId }, b.member);
    expect(badge).toMatchObject({
      scope: 'mine',
      total: 2,
      mine: { total: 2 },
      everyone: { total: 3 },
    });
    const banner = await ask(
      attentionForRecord,
      { workspaceId: b.wsId, recordType: 'lead', recordId: big },
      b.member,
    );
    expect(new Set(banner.items.map((i) => i.kind))).toEqual(new Set(['hot_lead', 'overdue_task']));

    // The sweep again: nothing changed, nothing written.
    expect(await settle(b, 'all')).toMatchObject({ transitions: [], updated: [] });
  });
});
