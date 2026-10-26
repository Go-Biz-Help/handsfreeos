import { randomUUID } from 'node:crypto';
import {
  assistantToolByName,
  createTokenVerifier,
  executeCommand,
  hasWorkspacePermission,
  knowledgeItemCreate,
  knowledgeProfileUpdate,
  organizationCreate,
  personCreate,
  workflowArchive,
  workflowCreate,
  workflowPublish,
  workflowSaveDraft,
  type AssistantCard,
  type AssistantEvent,
  type HumanActor,
} from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import {
  closeTestDbs,
  createTestUser,
  signInTestUser,
  testDbs,
  testEnv,
  type TestUser,
} from '@hfos/db/testing';
import type { FastifyInstance } from 'fastify';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { consentToAssistant } from './assistant-consent';
import { scriptedAi } from '../src/ai/scripted';
import { questionContext, toolsFor } from '../src/assistant/context';
import { contextText, SYSTEM } from '../src/assistant/prompt';
import { scriptedAssistant } from '../src/assistant/scripted';
import { createToolExecutor, executorFor } from '../src/assistant/tools-write';
import { buildHttpServer } from '../src/http/server';
import { testServices } from './helpers';

/**
 * The Assistant's workflow and knowledge tools against the scripted model: looking up, drafting (a proposal
 * only) and searching happen on their own; starting, pausing, resuming, taking someone out, answering an
 * approval and adding to the knowledge base wait for Confirm; members never get the workflows.manage tools;
 * and the context carries the business profile, the grounding rules, the workflows and the approvals.
 */

const env = testEnv();
const actor = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: u.claims,
});
const meta = () => ({ correlationId: randomUUID(), channel: 'test' as const });
const api = () => testDbs().api.db;
const admin = () => testDbs().admin.db;

let owner: TestUser;
let member: TestUser;
let ownerToken: string;
let memberToken: string;
let ws: string;
let mike: string;
let followUp: string;
let followUpVersion: string;
let speed: string;
let financing: string;
let approvalId: string;
let approvalRun: string;
let app: FastifyInstance;

const NEW_TOOLS = {
  list_workflows: 'auto',
  draft_workflow: 'auto',
  search_knowledge: 'auto',
  start_workflow: 'confirm',
  pause_workflow: 'confirm',
  resume_workflow: 'confirm',
  remove_contact_from_workflow: 'confirm',
  answer_workflow_approval: 'confirm',
  add_knowledge_item: 'confirm',
} as const;

async function ask(
  token: string,
  text: string,
  page: { type: string; id: string } | null = null,
): Promise<AssistantEvent[]> {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/assistant/messages',
    headers: { authorization: `Bearer ${token}` },
    payload: { workspaceId: ws, text, page },
  });
  expect(res.statusCode).toBe(200);
  return res.body
    .split('\n\n')
    .filter((chunk) => chunk.startsWith('data: '))
    .map((chunk) => JSON.parse(chunk.slice(6)) as AssistantEvent);
}
const cardsOf = (events: AssistantEvent[]) =>
  events.flatMap((e) => (e.type === 'card' ? [e.card] : []));
const cardOf = <T extends AssistantCard['type']>(events: AssistantEvent[], type: T) =>
  cardsOf(events).find((c) => c.type === type) as Extract<AssistantCard, { type: T }> | undefined;
const textOf = (events: AssistantEvent[]) =>
  events.flatMap((e) => (e.type === 'text' ? [e.delta] : [])).join('');
const confirm = (token: string, id: string) =>
  app.inject({
    method: 'POST',
    url: `/v1/assistant/tool-calls/${id}/confirm`,
    headers: { authorization: `Bearer ${token}` },
    payload: { workspaceId: ws },
  });
const statusOf = async (workflowId: string) =>
  (
    await rows<{ status: string }>(
      admin(),
      sql`select status::text as status from app.workflows where id = ${workflowId}`,
    )
  )[0]!.status;

beforeAll(async () => {
  [owner, member] = await Promise.all([
    createTestUser('assistant-wf-owner'),
    createTestUser('assistant-wf-member'),
  ]);
  await consentToAssistant(owner, member);
  const run = <T>(cmd: Parameters<typeof executeCommand>[1], input: unknown) =>
    executeCommand(api(), cmd, input, actor(owner), meta()).then((r) => r.output as T);
  const org = await run<{ workspaceId: string }>(organizationCreate, {
    businessName: 'Workflow Assistant HVAC',
  });
  ws = org.workspaceId;
  await rows(
    admin(),
    sql`insert into app.workspace_memberships (workspace_id, user_id, role) values (${ws}, ${member.id}, 'member')`,
  );
  mike = (
    await run<{ personId: string }>(personCreate, {
      workspaceId: ws,
      firstName: 'Mike',
      lastName: 'Johnson',
      phone: '(713) 555-0142',
    })
  ).personId;

  // "Follow-up call": started by hand, one task, published.
  const created = await run<{ workflowId: string }>(workflowCreate, {
    workspaceId: ws,
    name: 'Follow-up call',
    from: 'blank',
    trigger: { kind: 'manual' },
  });
  followUp = created.workflowId;
  const saved = await run<{ revision: number }>(workflowSaveDraft, {
    workspaceId: ws,
    workflowId: followUp,
    baseRevision: 1,
    ops: [
      {
        op: 'add_step',
        parentId: null,
        branchId: null,
        index: null,
        step: {
          id: 's_fuptask1',
          type: 'action',
          action: 'create_task',
          config: { title: 'Call them back' },
        },
      },
    ],
  });
  await rows(
    admin(),
    sql`update app.workflows set tested_revision = revision where id = ${followUp}`,
  );
  followUpVersion = (
    await run<{ versionId: string }>(workflowPublish, {
      workspaceId: ws,
      workflowId: followUp,
      baseRevision: saved.revision,
    })
  ).versionId;
  speed = (
    await run<{ workflowId: string }>(workflowCreate, {
      workspaceId: ws,
      name: 'Speed to lead',
      from: 'recipe',
      recipeKey: 'speed_to_lead',
    })
  ).workflowId;

  // The knowledge base: a thin profile and one published FAQ.
  await run(knowledgeProfileUpdate, {
    workspaceId: ws,
    profile: { description: 'Heating and air conditioning in Houston.' },
  });
  financing = (
    await run<{ itemId: string }>(knowledgeItemCreate, {
      workspaceId: ws,
      status: 'published',
      content: {
        kind: 'faq',
        question: 'Do you offer financing?',
        answer: 'Yes, new systems can be financed over 60 months with approved credit.',
        tags: [],
      },
    })
  ).itemId;

  // Mike's run of Follow-up call waits on an approval of an AI-written text.
  const [r] = await rows<{ id: string }>(
    admin(),
    sql`insert into app.workflow_runs (workspace_id, workflow_id, version_id, person_id, dedupe_key, status)
        values (${ws}, ${followUp}, ${followUpVersion}, ${mike}, ${randomUUID()}, 'awaiting_approval')
        returning id`,
  );
  approvalRun = r!.id;
  const [a] = await rows<{ id: string }>(
    admin(),
    sql`insert into app.workflow_approvals (workspace_id, workflow_id, run_id, step_key, approvers, preview)
        values (${ws}, ${followUp}, ${approvalRun}, 's_fupaprv1#1', '{}'::uuid[],
          ${JSON.stringify({
            message: 'Check the text before it goes',
            fields: { message: 'Hi Mike, we can come Tuesday.' },
            channel: 'sms',
            customer: 'Mike Johnson',
          })}::jsonb)
        returning id`,
  );
  approvalId = a!.id;

  [ownerToken, memberToken] = await Promise.all([signInTestUser(owner), signInTestUser(member)]);
  const ai = { provider: scriptedAi() };
  const s = testServices({ ai });
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
      tools: createToolExecutor(httpDb, {
        ai,
        log: pino({ level: 'silent' }),
        wallet: { db: httpDb, log: pino({ level: 'silent' }), mode: 'shadow' as const },
      }),
    },
  });
});
afterAll(async () => {
  await app?.close();
  await closeTestDbs();
});

describe('workflows and knowledge in the Assistant', () => {
  it('runs lookups and drafts on their own, asks first for the rest, and keeps members to their role', () => {
    for (const [name, autonomy] of Object.entries(NEW_TOOLS)) {
      expect(executorFor(name), name).toBeTruthy();
      expect(assistantToolByName.get(name)?.autonomy, name).toBe(autonomy);
    }
    const memberTools = toolsFor((p) => hasWorkspacePermission('member', p)).map((t) => t.name);
    expect(memberTools).toEqual(
      expect.arrayContaining([
        'list_workflows',
        'search_knowledge',
        'start_workflow',
        'remove_contact_from_workflow',
        'answer_workflow_approval',
      ]),
    );
    for (const name of [
      'draft_workflow',
      'pause_workflow',
      'resume_workflow',
      'add_knowledge_item',
    ])
      expect(memberTools).not.toContain(name);
  });

  it('answers from the business profile and the grounding rules, and knows the workflows and approvals', async () => {
    const context = await questionContext(
      testDbs().worker.db,
      actor(owner),
      ws,
      { type: 'workflow', id: followUp },
      randomUUID(),
    );
    const text = contextText(context.prompt);
    expect(text).toContain('<business_profile>');
    expect(text).toContain('What they do: Heating and air conditioning in Houston.');
    expect(text).toContain('Rules for what you say about the business:');
    expect(text).toContain('State only facts found in the business profile');
    expect(text).toContain(
      `- Follow-up call [active] (workflow id ${followUp}): When someone starts it`,
    );
    expect(text).toContain(`- Speed to lead [draft] (workflow id ${speed})`);
    expect(text).toContain(
      `- Mike Johnson · a text, from Follow-up call (approval id ${approvalId})`,
    );
    expect(text).toContain(`On screen now: the workflow Follow-up call (workflow id ${followUp})`);
    expect(SYSTEM).toMatch(
      /answer only from the business profile in the context and what search_knowledge finds/,
    );

    // A run's page names its workflow and customer.
    const onRun = await questionContext(
      testDbs().worker.db,
      actor(owner),
      ws,
      { type: 'workflow_run', id: approvalRun },
      randomUUID(),
    );
    expect(contextText(onRun.prompt)).toContain(
      `It belongs to Follow-up call (workflow id ${followUp}) and is for Mike Johnson (person id ${mike}).`,
    );
  });

  it('lists workflows, and drafts a new one as a proposal only', async () => {
    let events = await ask(ownerToken, 'Show my workflows');
    const list = cardOf(events, 'list')!;
    expect(list.items.map((i) => i.title).sort()).toEqual(['Follow-up call', 'Speed to lead']);
    expect(list.items.find((i) => i.title === 'Follow-up call')).toMatchObject({
      detail: 'On · When someone starts it',
      href: `/app/w/${ws}/workflows/${followUp}`,
    });

    const workflowCount = async () =>
      (
        await rows<{ n: number }>(
          admin(),
          sql`select count(*)::int as n from app.workflows where workspace_id = ${ws}`,
        )
      )[0]!.n;
    const before = await workflowCount();
    events = await ask(ownerToken, 'Build a workflow that texts new leads within a minute');
    const card = cardOf(events, 'workflow')!;
    expect(card).toMatchObject({
      workflowId: null,
      status: 'proposal',
      name: 'New lead text-back',
      trigger: 'When a new lead comes in',
      more: 0,
      changes: [],
      issues: 0,
      unsupported: [],
    });
    expect(card.steps).toHaveLength(5);
    expect(card.steps[1]).toBe('Wait 5 minutes');
    expect(card.href).toBe(
      `/app/w/${ws}/workflows/new?proposal=${card.proposalId}&name=New_lead_text-back`,
    );
    expect(textOf(events)).toBe(
      'Here’s a draft. Nothing runs until you open it, test it and publish it.',
    );
    // A proposal only: no workflow was made, and the tool ran on its own.
    expect(await workflowCount()).toBe(before);
    expect(
      await rows(
        admin(),
        sql`select workflow_id, created_by from app.workflow_proposals where id = ${card.proposalId}`,
      ),
    ).toEqual([{ workflow_id: null, created_by: owner.id }]);
    expect(
      await rows(
        admin(),
        sql`select status::text as status, autonomy::text as autonomy from app.assistant_tool_calls
            where workspace_id = ${ws} and tool = 'draft_workflow'`,
      ),
    ).toEqual([{ status: 'done', autonomy: 'auto' }]);
  });

  it('drafts a change to the workflow on screen, leaving its draft alone', async () => {
    const events = await ask(ownerToken, 'Change this workflow to wait two days instead', {
      type: 'workflow',
      id: speed,
    });
    const card = cardOf(events, 'workflow')!;
    expect(card).toMatchObject({
      workflowId: speed,
      status: 'proposal',
      name: 'Speed to lead',
      changes: ['Change the wait from 1 day to 2 days'],
      href: `/app/w/${ws}/workflows/${speed}?mode=describe&proposal=${card.proposalId}`,
    });
    expect(
      await rows(admin(), sql`select revision from app.workflows where id = ${speed}`),
    ).toEqual([{ revision: 1 }]);
  });

  it('starts a customer on a workflow only after Confirm', async () => {
    const events = await ask(ownerToken, 'Put him in Follow-up call', { type: 'person', id: mike });
    const card = cardOf(events, 'confirm')!;
    expect(card).toMatchObject({
      tool: 'start_workflow',
      title: 'Start “Follow-up call” for Mike Johnson?',
      personId: mike,
      confirmLabel: 'Start',
      warnings: [],
    });
    expect(card.fields[0]).toMatchObject({
      label: 'Starts with',
      value: expect.stringMatching(/^Step 1, create a task “Call them back”/),
    });
    const enrolled = () =>
      rows<{ payload: { personId: string } }>(
        admin(),
        sql`select payload from app.events where event_type = 'workflow.enrol_requested' and entity_id = ${followUp}`,
      );
    expect(await enrolled()).toEqual([]);
    const res = await confirm(ownerToken, card.toolCallId);
    expect(res.json()).toMatchObject({
      status: 'confirmed',
      outcome: 'Started “Follow-up call” for Mike Johnson.',
      href: `/app/w/${ws}/workflows/runs?workflow=${followUp}`,
    });
    expect((await enrolled()).map((e) => e.payload.personId)).toEqual([mike]);
    expect(
      await rows(
        admin(),
        sql`select channel from app.audit_logs where action = 'workflow.enrol' and entity_id = ${followUp}`,
      ),
    ).toEqual([{ channel: 'assistant' }]);
  });

  it('won’t start a workflow that starts on its own, and says why', async () => {
    const run = <T>(cmd: Parameters<typeof executeCommand>[1], input: unknown) =>
      executeCommand(api(), cmd, input, actor(owner), meta()).then((r) => r.output as T);
    const { workflowId } = await run<{ workflowId: string }>(workflowCreate, {
      workspaceId: ws,
      name: 'New lead text',
      from: 'blank',
      trigger: { kind: 'event', event: 'lead.created' },
    });
    const saved = await run<{ revision: number }>(workflowSaveDraft, {
      workspaceId: ws,
      workflowId,
      baseRevision: 1,
      ops: [
        {
          op: 'add_step',
          parentId: null,
          branchId: null,
          index: null,
          step: {
            id: 's_nltask01',
            type: 'action',
            action: 'create_task',
            config: { title: 'Call the new lead' },
          },
        },
      ],
    });
    await rows(
      admin(),
      sql`update app.workflows set tested_revision = revision where id = ${workflowId}`,
    );
    await run(workflowPublish, { workspaceId: ws, workflowId, baseRevision: saved.revision });
    try {
      const events = await ask(ownerToken, 'Put him in New lead text', {
        type: 'person',
        id: mike,
      });
      const card = cardOf(events, 'confirm')!;
      const why =
        '“New lead text” starts on its own (when a new lead comes in), so it can’t be started for someone by hand.';
      expect(card).toMatchObject({
        tool: 'start_workflow',
        confirmLabel: '',
        warnings: [{ kind: 'blocked', text: why }],
      });
      // Confirming anyway (an old card, a crafted request) is refused, and no run is asked for.
      expect((await confirm(ownerToken, card.toolCallId)).json()).toMatchObject({
        status: 'failed',
        error: why,
      });
      expect(
        await rows(
          admin(),
          sql`select 1 from app.events where event_type = 'workflow.enrol_requested' and entity_id = ${workflowId}`,
        ),
      ).toEqual([]);
    } finally {
      await run(workflowArchive, { workspaceId: ws, workflowId });
    }
  });

  it('pauses and resumes after Confirm, saying what happens to runs', async () => {
    let events = await ask(ownerToken, 'Pause Follow-up call');
    let card = cardOf(events, 'confirm')!;
    expect(card).toMatchObject({
      tool: 'pause_workflow',
      title: 'Pause “Follow-up call”?',
      confirmLabel: 'Pause',
    });
    expect(card.fields.map((f) => f.label)).toEqual(['New starts', 'Runs now', 'Resume']);
    expect(await statusOf(followUp)).toBe('active');
    let res = await confirm(ownerToken, card.toolCallId);
    expect(res.json()).toMatchObject({
      status: 'confirmed',
      outcome: expect.stringMatching(/^Paused “Follow-up call”\./),
    });
    expect(await statusOf(followUp)).toBe('paused');

    events = await ask(ownerToken, 'Resume Follow-up call');
    card = cardOf(events, 'confirm')!;
    expect(card).toMatchObject({ tool: 'resume_workflow', confirmLabel: 'Resume' });
    res = await confirm(ownerToken, card.toolCallId);
    expect(res.json()).toMatchObject({
      status: 'confirmed',
      outcome: 'Resumed “Follow-up call”. It starts again for anything new.',
    });
    expect(await statusOf(followUp)).toBe('active');
  });

  it('answers an approval in the person’s own words, after Confirm', async () => {
    const events = await ask(ownerToken, 'Approve it with: Hi Mike, Tuesday at 9 works.');
    const card = cardOf(events, 'confirm')!;
    expect(card).toMatchObject({
      tool: 'answer_workflow_approval',
      title: 'Approve the text to Mike Johnson?',
      body: 'Hi Mike, Tuesday at 9 works.',
      confirmLabel: 'Approve and send',
    });
    expect(card.fields).toContainEqual({
      label: 'Edited',
      value: 'Your words go instead of the AI’s',
    });
    const res = await confirm(ownerToken, card.toolCallId);
    expect(res.json()).toMatchObject({
      status: 'confirmed',
      outcome: 'Approved. The text goes to Mike Johnson.',
      href: `/app/w/${ws}/workflows/runs/${approvalRun}`,
    });
    expect(
      await rows(
        admin(),
        sql`select status::text as status, via, edits, decided_by from app.workflow_approvals where id = ${approvalId}`,
      ),
    ).toEqual([
      {
        status: 'approved',
        via: 'assistant',
        edits: { message: 'Hi Mike, Tuesday at 9 works.' },
        decided_by: owner.id,
      },
    ]);
  });

  it('takes a customer out of a workflow after Confirm', async () => {
    await rows(
      admin(),
      sql`insert into app.workflow_runs (workspace_id, workflow_id, version_id, person_id, dedupe_key, status)
          values (${ws}, ${followUp}, ${followUpVersion}, ${mike}, ${randomUUID()}, 'waiting')`,
    );
    const events = await ask(ownerToken, 'Take him out of Follow-up call', {
      type: 'person',
      id: mike,
    });
    const card = cardOf(events, 'confirm')!;
    expect(card).toMatchObject({
      tool: 'remove_contact_from_workflow',
      title: 'Take Mike Johnson out of “Follow-up call”?',
      confirmLabel: 'Take them out',
    });
    const res = await confirm(ownerToken, card.toolCallId);
    expect(res.json()).toMatchObject({
      status: 'confirmed',
      outcome: 'Took Mike Johnson out of “Follow-up call”.',
    });
    expect(
      await rows(
        admin(),
        sql`select 1 from app.workflow_runs where workflow_id = ${followUp} and person_id = ${mike}
            and status in ('running', 'waiting', 'awaiting_approval', 'held')`,
      ),
    ).toEqual([]);
  });

  it('searches the knowledge base on its own, and adds to it only after Confirm', async () => {
    let events = await ask(ownerToken, 'Do we offer financing?');
    expect(cardOf(events, 'knowledge')).toMatchObject({
      items: [
        {
          id: financing,
          kind: 'faq',
          title: 'Do you offer financing?',
          href: `/app/w/${ws}/knowledge/items/${financing}`,
        },
      ],
      href: `/app/w/${ws}/knowledge`,
    });
    expect(textOf(events)).toBe(
      'From your knowledge base: Yes, new systems can be financed over 60 months with approved credit.',
    );

    // A question it can't answer says so, and waits in Suggestions.
    events = await ask(ownerToken, 'Do you service swimming pool heaters?');
    expect(cardOf(events, 'knowledge')).toBeUndefined();
    expect(textOf(events)).toMatch(/doesn’t say/);
    expect(
      await rows(
        admin(),
        sql`select reason::text as reason, source ->> 'via' as via from app.knowledge_suggestions
            where workspace_id = ${ws} and reason = 'gap'`,
      ),
    ).toEqual([{ reason: 'gap', via: 'assistant' }]);

    events = await ask(
      ownerToken,
      'Add an FAQ: Do you work weekends? — Yes, Saturdays from 9 to 1.',
    );
    const card = cardOf(events, 'confirm')!;
    expect(card).toMatchObject({
      tool: 'add_knowledge_item',
      title: 'Add this FAQ to your knowledge base?',
      body: 'Yes, Saturdays from 9 to 1.',
      confirmLabel: 'Save draft',
    });
    const res = await confirm(ownerToken, card.toolCallId);
    expect(res.json()).toMatchObject({
      status: 'confirmed',
      outcome: 'Added “Do you work weekends?” as a draft.',
    });
    expect(
      await rows(
        admin(),
        sql`select status::text as status, body from app.knowledge_items
            where workspace_id = ${ws} and title = 'Do you work weekends?'`,
      ),
    ).toEqual([{ status: 'draft', body: 'Yes, Saturdays from 9 to 1.' }]);
  });

  it('never lets a member reach a workflows.manage tool', async () => {
    let events = await ask(memberToken, 'Pause Follow-up call');
    expect(cardOf(events, 'confirm')).toBeUndefined();
    expect(textOf(events)).toBe('That didn’t work: That is not something you can do here.');
    events = await ask(memberToken, 'Build a workflow that texts new leads within a minute');
    expect(cardOf(events, 'workflow')).toBeUndefined();
    expect(await statusOf(followUp)).toBe('active');
    // What they may do still works: looking up workflows.
    events = await ask(memberToken, 'Show my workflows');
    expect(cardOf(events, 'list')?.items).toHaveLength(2);
  });
});
