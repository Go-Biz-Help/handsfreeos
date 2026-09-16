import { randomUUID } from 'node:crypto';
import {
  addDays,
  ALWAYS_OPEN_HOURS,
  assistantToolByName,
  attentionList,
  attentionSaveSettings,
  createTokenVerifier,
  executeCommand,
  executeQuery,
  hasWorkspacePermission,
  leadCreate,
  localDateOf,
  localInstant,
  organizationCreate,
  personCreate,
  phoneUpdateSettings,
  reconcile,
  taskCreate,
  workspaceUpdate,
  type AssistantCard,
  type AssistantEvent,
  type HumanActor,
} from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import { attentionItems } from '@hfos/db/schema';
import {
  closeTestDbs,
  createTestUser,
  signInTestUser,
  testDbs,
  testEnv,
  type TestUser,
} from '@hfos/db/testing';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { consentToAssistant } from './assistant-consent';
import { questionContext, toolsFor } from '../src/assistant/context';
import { contextText } from '../src/assistant/prompt';
import type { ToolContext } from '../src/assistant/runtime';
import { scriptedAssistant } from '../src/assistant/scripted';
import { money } from '../src/assistant/tools-read';
import { createToolExecutor } from '../src/assistant/tools-write';
import { buildHttpServer } from '../src/http/server';
import { testServices } from './helpers';

/**
 * The Assistant on the Action Center (M8 step 7), against the scripted model: "What needs my attention?" gives
 * attention.list's items in Home's order, in each person's own view; handling one runs Let HandsFreeOS Handle as the
 * person on Confirm (a next action, or HandsFreeOS's own follow-up once an owner has read it); snoozing, dismissing
 * and assigning run their commands as the person; members never see approvals they can't decide, and only roles
 * with records.write get the tools that change items. Items are made the way the worker makes them: facts, then
 * reconcile.
 */

const env = testEnv();
const TZ = 'America/Chicago';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const actor = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: u.claims,
});
const meta = (channel: 'test' | 'worker' = 'test') => ({ correlationId: randomUUID(), channel });
const api = () => testDbs().api.db;
const worker = () => testDbs().worker.db;
const admin = () => testDbs().admin.db;

let owner: TestUser;
let priya: TestUser;
let marco: TestUser;
let ownerToken: string;
let marcoToken: string;
let ws: string;
let orgId: string;
let boLead: string;
let kevinLead: string;
let mariaLead: string;
let approvalItem: string;
let app: FastifyInstance;

type Cmd = Parameters<typeof executeCommand>[1];
const run = <T = Record<string, unknown>>(cmd: Cmd, input: unknown, u: TestUser) =>
  executeCommand(api(), cmd, input, actor(u), meta()).then((r) => r.output as T);
const sys = <T>(cmd: Cmd, input: unknown) =>
  executeCommand(
    worker(),
    cmd,
    input,
    { type: 'system', workspaceId: ws, organizationId: orgId },
    meta('worker'),
  ).then((r) => r.output as T);
/** Home's read: attention.list as the person. */
const list = (u: TestUser, input: Record<string, unknown> = {}) =>
  executeQuery(api(), attentionList, { workspaceId: ws, ...input }, actor(u), meta());
/** What the worker runs as things happen. */
const settle = () =>
  asWorker(worker(), { workspaceId: ws, organizationId: orgId }, (tx) =>
    reconcile(tx, ws, 'all', new Date()),
  );
const itemOf = async (subjectId: string, kind: string) =>
  (
    await admin()
      .select()
      .from(attentionItems)
      .where(
        and(
          eq(attentionItems.workspaceId, ws),
          eq(attentionItems.subjectId, subjectId),
          eq(attentionItems.kind, kind),
        ),
      )
  )[0]!;
const leadRow = async (leadId: string) =>
  (
    await rows<{
      next_action: string | null;
      next_action_at: Date | null;
      assignee_user_id: string | null;
    }>(
      admin(),
      sql`select next_action, next_action_at, assignee_user_id from app.leads where id = ${leadId}`,
    )
  )[0]!;
const lastAudit = async (action: string) =>
  (
    await rows<{ actor_id: string; channel: string }>(
      admin(),
      sql`select actor_id, channel from app.audit_logs where workspace_id = ${ws} and action = ${action}
          order by created_at desc limit 1`,
    )
  )[0];
const toolCtx = (u: TestUser): ToolContext => ({
  actor: actor(u),
  workspaceId: ws,
  organizationId: orgId,
  correlationId: randomUUID(),
  timezone: TZ,
});
const tool = (name: string) => assistantToolByName.get(name)!;

async function ask(token: string, text: string): Promise<AssistantEvent[]> {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/assistant/messages',
    headers: { authorization: `Bearer ${token}` },
    payload: { workspaceId: ws, text },
  });
  expect(res.statusCode).toBe(200);
  return res.body
    .split('\n\n')
    .filter((chunk) => chunk.startsWith('data: '))
    .map((chunk) => JSON.parse(chunk.slice(6)) as AssistantEvent);
}
const cardOf = <T extends AssistantCard['type']>(events: AssistantEvent[], type: T) =>
  events.flatMap((e) => (e.type === 'card' && e.card.type === type ? [e.card] : []))[0] as
    Extract<AssistantCard, { type: T }> | undefined;
const textOf = (events: AssistantEvent[]) =>
  events.flatMap((e) => (e.type === 'text' ? [e.delta] : [])).join('');
const decide = (token: string, id: string, action: 'confirm' | 'cancel') =>
  app.inject({
    method: 'POST',
    url: `/v1/assistant/tool-calls/${id}/${action}`,
    headers: { authorization: `Bearer ${token}` },
    payload: { workspaceId: ws },
  });

/** An active toll-free number the carriers approved, so texts could be queued. */
async function readyTexting(): Promise<void> {
  const e164 = `+1737${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`;
  const [account] = await rows<{ id: string }>(
    admin(),
    sql`insert into app.telephony_accounts (workspace_id, provider, account_sid, status)
        values (${ws}, 'fake', ${`ACaa${randomUUID().slice(0, 8)}`}, 'active') returning id`,
  );
  const [number] = await rows<{ id: string }>(
    admin(),
    sql`insert into app.phone_numbers (workspace_id, account_id, provider_sid, e164, number_type, status)
        values (${ws}, ${account!.id}, ${`PNaa${randomUUID().slice(0, 8)}`}, ${e164}, 'toll_free', 'active')
        returning id`,
  );
  await rows(
    admin(),
    sql`insert into app.telephony_registrations (workspace_id, account_id, phone_number_id, kind, status, provider_sid, approved_at)
        values (${ws}, ${account!.id}, ${number!.id}, 'toll_free_verification', 'approved', ${`HHaa${randomUUID().slice(0, 8)}`}, now())`,
  );
}

/** A customer the worker filed (nobody on the team typed them in). */
const customer = async (firstName: string, extra: Record<string, unknown> = {}) =>
  (
    await sys<{ personId: string }>(personCreate, {
      workspaceId: ws,
      firstName,
      lastName: 'Test',
      ignoreDuplicates: true,
      ...extra,
    })
  ).personId;

/** A lead the owner typed in, with a value and no next action: it needs one. */
const typedLead = async (personId: string, title: string, valueCents: number) =>
  (
    await run<{ leadId: string }>(
      leadCreate,
      { workspaceId: ws, title, personId, valueCents },
      owner,
    )
  ).leadId;

beforeAll(async () => {
  [owner, priya, marco] = await Promise.all([
    createTestUser('assistant-attn-owner', { fullName: 'Dale Owner' }),
    createTestUser('assistant-attn-admin', { fullName: 'Priya Admin' }),
    createTestUser('assistant-attn-member', { fullName: 'Marco Member' }),
  ]);
  await consentToAssistant(owner, priya, marco);
  const org = await run<{ workspaceId: string; organizationId: string }>(
    organizationCreate,
    { businessName: 'Attention Assistant HVAC', timezone: TZ },
    owner,
  );
  ws = org.workspaceId;
  orgId = org.organizationId;
  for (const [u, role] of [
    [priya, 'admin'],
    [marco, 'member'],
  ] as const)
    await rows(
      admin(),
      sql`insert into app.workspace_memberships (workspace_id, user_id, role) values (${ws}, ${u.id}, ${role})`,
    );
  await readyTexting();
  // Quiet hours set plainly (off), and open around the clock, so no clock in these tests waits for the morning.
  await run(
    phoneUpdateSettings,
    { workspaceId: ws, quietHours: { enabled: false, start: '20:00', end: '08:00' } },
    owner,
  );
  await run(
    workspaceUpdate,
    { workspaceId: ws, settings: { openHours: ALWAYS_OPEN_HOURS } },
    owner,
  );

  boLead = await typedLead(await customer('Bo'), 'Whole-house system', 4_000_000);
  mariaLead = await typedLead(await customer('Maria'), 'Filter change', 90_000);
  // Kevin's lead went quiet: typed in ten days ago, with its next action two months out.
  const kevin = await customer('Kevin', { email: 'kevin@example.com' });
  kevinLead = (
    await run<{ leadId: string }>(
      leadCreate,
      {
        workspaceId: ws,
        title: 'Duct cleaning',
        personId: kevin,
        valueCents: 240_000,
        nextAction: 'Check in about the quote',
        nextActionAt: new Date(Date.now() + 60 * DAY).toISOString(),
      },
      owner,
    )
  ).leadId;
  await rows(
    admin(),
    sql`update app.leads set created_at = now() - interval '10 days', stage_entered_at = now() - interval '10 days'
        where id = ${kevinLead}`,
  );
  // Marco's overdue task.
  await run(
    taskCreate,
    {
      workspaceId: ws,
      title: 'Order the condenser',
      dueAt: new Date(Date.now() - 2 * HOUR).toISOString(),
      allDay: false,
      assigneeUserId: marco.id,
    },
    owner,
  );
  // A workflow's approval that names only Priya (owners and admins may decide it too; Marco may not).
  const lee = await customer('Lee');
  const [wf] = await rows<{ id: string }>(
    admin(),
    sql`insert into app.workflows (workspace_id, name) values (${ws}, 'Quote follow-up') returning id`,
  );
  const [version] = await rows<{ id: string }>(
    admin(),
    sql`insert into app.workflow_versions (workspace_id, workflow_id, version, definition, definition_version, revision)
        values (${ws}, ${wf!.id}, 1, '{}'::jsonb, 1, 1) returning id`,
  );
  const [wfRun] = await rows<{ id: string }>(
    admin(),
    sql`insert into app.workflow_runs (workspace_id, workflow_id, version_id, person_id, status, dedupe_key)
        values (${ws}, ${wf!.id}, ${version!.id}, ${lee}, 'awaiting_approval', ${randomUUID()}) returning id`,
  );
  const [approval] = await rows<{ id: string }>(
    admin(),
    sql`insert into app.workflow_approvals (workspace_id, workflow_id, run_id, step_key, approvers, preview)
        values (${ws}, ${wf!.id}, ${wfRun!.id}, 'approve_1#1', array[${priya.id}]::uuid[],
          '{"summary":"Send Lee the 10% discount"}'::jsonb)
        returning id`,
  );
  await settle();
  approvalItem = (await itemOf(approval!.id, 'ai_approval')).id;

  [ownerToken, marcoToken] = await Promise.all([signInTestUser(owner), signInTestUser(marco)]);
  const s = testServices();
  const httpDb = testDbs().worker.db;
  app = await buildHttpServer({
    ...s,
    httpDb,
    verifyToken: createTokenVerifier({
      jwksUrl: `${env.supabaseUrl}/auth/v1/.well-known/jwks.json`,
      jwtIssuer: `${env.supabaseUrl}/auth/v1`,
    }),
    webOrigins: ['http://localhost:3000'],
    assistant: {
      provider: scriptedAssistant(),
      tools: createToolExecutor(httpDb),
      dailyTokens: 5_000_000,
    },
  });
});
afterAll(async () => {
  await app?.close();
  await closeTestDbs();
});

describe('the Assistant on the Action Center', () => {
  it('answers from attention.list, in Home’s order, in each person’s own view', async () => {
    const home = await list(owner, { includeHandled: true });
    expect(home.scope).toBe('everyone');
    expect(home.items.map((i) => i.id)).toContain(approvalItem);

    const events = await ask(ownerToken, 'What needs my attention?');
    expect(events.some((e) => e.type === 'step' && e.label === 'Checking the Action Center')).toBe(
      true,
    );
    const card = cardOf(events, 'attention')!;
    expect(card.items.map((i) => i.itemId)).toEqual(home.items.slice(0, 8).map((i) => i.id));
    expect(card.affected).toEqual({
      cents: home.affectedCents,
      total: home.counts.total,
      urgent: home.counts.urgent,
      scope: 'everyone',
    });
    const bo = card.items.find((i) => i.title === 'Bo Test · Whole-house system')!;
    expect(bo).toMatchObject({
      kind: 'missing_next_action',
      valueCents: 4_000_000,
      href: `/app/w/${ws}?item=${bo.itemId}`,
    });
    expect(bo.detail).toMatch(/^No next action · \$40,000/);
    expect(textOf(events)).toBe(
      `${home.counts.total} things need attention, ${money(home.affectedCents)} affected. First up: ${home.items[0]!.title}.`,
    );

    // What the model reads: the counts, "$ affected" and each item's id, kind, title, chips and value; a kind
    // filter reads the same query with the same filter.
    const out = await createToolExecutor(worker()).run(
      tool('what_needs_attention'),
      { scope: 'everyone', kind: 'missing_next_action' },
      toolCtx(owner),
    );
    const filtered = await list(owner, { scope: 'everyone', kinds: ['missing_next_action'] });
    expect(out.result).toMatchObject({
      scope: 'everyone',
      affectedCents: filtered.affectedCents,
      counts: filtered.counts,
      items: filtered.items.map((i) =>
        expect.objectContaining({
          id: i.id,
          kind: 'missing_next_action',
          title: i.title,
          chips: i.reasons.map((r) => r.text),
        }),
      ),
    });

    // Marco sees his own view: his task and what nobody has, never the approval he can't decide.
    const mine = await list(marco);
    expect(mine.scope).toBe('mine');
    const theirs = cardOf(await ask(marcoToken, 'What needs my attention?'), 'attention')!;
    expect(theirs.affected?.scope).toBe('mine');
    expect(theirs.items.map((i) => i.itemId)).toEqual(mine.items.slice(0, 8).map((i) => i.id));
    expect(theirs.items.map((i) => i.title)).toContain('Order the condenser');
    expect(theirs.items.map((i) => i.itemId)).not.toContain(approvalItem);

    // The context lists the same items with their ids, for "the first one" and names.
    const said = contextText(
      (await questionContext(worker(), actor(owner), ws, null, randomUUID())).prompt,
    );
    expect(said).toContain(`1. ${home.items[0]!.title} [`);
    expect(said).toContain(`(attention item id ${approvalItem})`);
    const toMarco = contextText(
      (await questionContext(worker(), actor(marco), ws, null, randomUUID())).prompt,
    );
    expect(toMarco).toContain('Needs attention (Mine: their own items and unassigned ones)');
    expect(toMarco).not.toContain(approvalItem);
  });

  it('handles an item only on Confirm, as the person: “the first one”, then Bo’s next action', async () => {
    const first = (await list(owner)).items[0]!;
    let events = await ask(ownerToken, 'Handle the first one');
    const firstCard = cardOf(events, 'confirm')!;
    expect(firstCard.tool).toBe('handle_attention_item');
    const [called] = await rows<{ arguments: Record<string, unknown> }>(
      admin(),
      sql`select arguments from app.assistant_tool_calls where id = ${firstCard.toolCallId}`,
    );
    expect(called!.arguments).toEqual({ itemId: first.id });
    expect((await decide(ownerToken, firstCard.toolCallId, 'cancel')).json()).toMatchObject({
      status: 'cancelled',
    });

    events = await ask(ownerToken, "Handle Bo's lead");
    const card = cardOf(events, 'confirm')!;
    expect(card).toMatchObject({
      tool: 'handle_attention_item',
      title: 'Set a next action for Bo Test?',
      confirmLabel: 'Set next action',
    });
    expect(card.fields).toEqual(
      expect.arrayContaining([
        { label: 'Lead', value: 'Bo Test · Whole-house system' },
        { label: 'Next', value: 'Follow up with Bo' },
      ]),
    );
    expect(textOf(events)).toBe('Here’s what would happen. Nothing happens until you OK it.');
    expect((await leadRow(boLead)).next_action).toBeNull();

    const ok = await decide(ownerToken, card.toolCallId, 'confirm');
    expect(ok.json()).toMatchObject({
      status: 'confirmed',
      outcome: expect.stringMatching(/^Next action set: Follow up with Bo, .+\.$/),
      href: `/app/w/${ws}/leads/${boLead}`,
    });
    const lead = await leadRow(boLead);
    expect(lead.next_action).toBe('Follow up with Bo');
    expect(lead.next_action_at).not.toBeNull();
    expect(await itemOf(boLead, 'missing_next_action')).toMatchObject({
      state: 'handled',
      handledVia: 'let_handle',
      handledBy: owner.id,
    });
    expect(await lastAudit('attention.let_handle')).toEqual({
      actor_id: owner.id,
      channel: 'assistant',
    });
    expect((await decide(ownerToken, card.toolCallId, 'confirm')).statusCode).toBe(409);
  });

  it('queues HandsFreeOS’s own follow-up on Confirm, once an owner has read the message', async () => {
    let events = await ask(ownerToken, 'Handle the Kevin one');
    let card = cardOf(events, 'confirm')!;
    expect(card).toMatchObject({ tool: 'handle_attention_item', confirmLabel: '' });
    expect(card.warnings[0]).toMatchObject({
      kind: 'blocked',
      text: expect.stringMatching(/read the follow-up message/),
    });
    expect(textOf(events)).toMatch(/read the follow-up message/);
    await decide(ownerToken, card.toolCallId, 'cancel');

    await run(
      attentionSaveSettings,
      {
        workspaceId: ws,
        settings: { auto: { nudges: true, nudgeReviewedAt: new Date().toISOString() } },
      },
      owner,
    );
    events = await ask(ownerToken, 'Handle the Kevin one');
    card = cardOf(events, 'confirm')!;
    expect(card).toMatchObject({
      title: 'Follow up with Kevin?',
      confirmLabel: expect.stringMatching(/^Send at \d{1,2}:\d{2} [AP]M$/),
    });
    expect(card.fields).toEqual(
      expect.arrayContaining([
        { label: 'To', value: 'Kevin Test · kevin@example.com' },
        { label: 'By', value: 'Email' },
      ]),
    );
    expect(card.body).toContain('Hi Kevin');
    // Kevin gave an email and no mobile number.
    expect(card.warnings).toContainEqual({
      kind: 'note',
      text: 'There’s no mobile number, so this goes by email.',
    });

    const ok = await decide(ownerToken, card.toolCallId, 'confirm');
    expect(ok.json()).toMatchObject({
      status: 'confirmed',
      outcome: expect.stringMatching(
        /^HandsFreeOS follows up with Kevin at .+\. You can cancel it on Home until then\.$/,
      ),
    });
    const itemId = (await itemOf(kevinLead, 'stale_opportunity')).id;
    const [requested] = await rows<{ payload: Record<string, unknown>; actor_id: string }>(
      admin(),
      sql`select payload, actor_id from app.events where entity_id = ${itemId} and event_type = 'attention.handle_requested'`,
    );
    expect(requested!.payload).toMatchObject({
      action: 'nudge',
      requestedBy: owner.id,
      channel: 'email',
    });
  });

  it('snoozes, assigns and dismisses on Confirm, as the person', async () => {
    let events = await ask(ownerToken, "Snooze Maria's lead until tomorrow");
    let card = cardOf(events, 'confirm')!;
    expect(card).toMatchObject({
      tool: 'update_attention_item',
      title: expect.stringMatching(/^Snooze Maria Test until .+ at 8:00 AM\?$/),
      confirmLabel: 'Snooze',
    });
    expect((await decide(ownerToken, card.toolCallId, 'confirm')).json()).toMatchObject({
      status: 'confirmed',
      outcome: expect.stringMatching(/^Snoozed until .+ at 8:00 AM\.$/),
      href: `/app/w/${ws}`,
    });
    const snoozed = await itemOf(mariaLead, 'missing_next_action');
    expect(snoozed).toMatchObject({ state: 'snoozed', snoozedBy: owner.id });
    expect(snoozed.snoozedUntil?.getTime()).toBe(
      localInstant(addDays(localDateOf(Date.now(), TZ), 1), '08:00', TZ),
    );
    expect(await lastAudit('attention.snooze')).toEqual({
      actor_id: owner.id,
      channel: 'assistant',
    });

    // Snoozed, it's off the list, so "the Maria one" means nothing now.
    events = await ask(ownerToken, 'Dismiss the Maria one');
    expect(cardOf(events, 'confirm')).toBeUndefined();
    expect(textOf(events)).toBe('I can’t find that one on your list.');

    events = await ask(ownerToken, 'Give the Kevin one to Priya');
    card = cardOf(events, 'confirm')!;
    expect(card).toMatchObject({ title: 'Assign Kevin Test to Priya?', confirmLabel: 'Assign' });
    expect(card.fields).toContainEqual({ label: 'Changes', value: 'Who owns the lead, too' });
    expect((await decide(ownerToken, card.toolCallId, 'confirm')).json()).toMatchObject({
      status: 'confirmed',
      outcome: 'Assigned to Priya Admin.',
    });
    expect((await leadRow(kevinLead)).assignee_user_id).toBe(priya.id);
    expect((await itemOf(kevinLead, 'stale_opportunity')).assigneeUserId).toBe(priya.id);

    events = await ask(ownerToken, 'Dismiss the Kevin one, already handled');
    card = cardOf(events, 'confirm')!;
    expect(card).toMatchObject({ title: 'Dismiss Kevin Test?', confirmLabel: 'Dismiss' });
    expect(card.fields).toContainEqual({ label: 'Reason', value: 'Already handled' });
    expect((await decide(ownerToken, card.toolCallId, 'confirm')).json()).toMatchObject({
      status: 'confirmed',
      outcome: 'Dismissed. It comes back only if something changes.',
    });
    expect(await itemOf(kevinLead, 'stale_opportunity')).toMatchObject({
      state: 'dismissed',
      dismissReason: 'Already handled',
      dismissedBy: owner.id,
    });
    expect(await lastAudit('attention.dismiss')).toEqual({
      actor_id: owner.id,
      channel: 'assistant',
    });
  });

  it('keeps approvals to the people who can decide them, and the tools to the roles that may use them', async () => {
    const tools = createToolExecutor(worker());
    const update = tool('update_attention_item');
    const args = { itemId: approvalItem, action: 'dismiss' };
    await expect(tools.prepare(update, args, toolCtx(marco), randomUUID())).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(
      tools.commit(update, args, toolCtx(marco), { toolCallId: randomUUID() }),
    ).rejects.toMatchObject({ code: 'forbidden', rule: 'not_an_approver' });
    const forPriya = await tools.prepare(update, args, toolCtx(priya), randomUUID());
    expect(forPriya.card).toMatchObject({ type: 'confirm', confirmLabel: 'Dismiss' });
    // Handling an approval means deciding it, so the card says so and offers nothing to confirm.
    const handle = await tools.prepare(
      tool('handle_attention_item'),
      { itemId: approvalItem },
      toolCtx(priya),
      randomUUID(),
    );
    expect(handle.card).toMatchObject({
      confirmLabel: '',
      warnings: [{ kind: 'blocked', text: expect.stringMatching(/^Approvals always wait/) }],
    });

    const forMembers = toolsFor((p) => hasWorkspacePermission('member', p)).map((t) => t.name);
    expect(forMembers).toEqual(
      expect.arrayContaining([
        'what_needs_attention',
        'handle_attention_item',
        'update_attention_item',
      ]),
    );
    const readOnly = toolsFor(
      (p) => hasWorkspacePermission('member', p) && p !== 'records.write',
    ).map((t) => t.name);
    expect(readOnly).toContain('what_needs_attention');
    expect(readOnly).not.toContain('handle_attention_item');
    expect(readOnly).not.toContain('update_attention_item');
  });
});
