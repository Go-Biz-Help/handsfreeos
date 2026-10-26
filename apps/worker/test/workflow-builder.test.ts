import { randomUUID } from 'node:crypto';
import type { AiContent, AiProvider, AiRequest, AiTurn } from '@hfos/ai';
import {
  applyWorkflowOps,
  createTokenVerifier,
  executeCommand,
  money,
  organizationCreate,
  parseDefinition,
  workflowCreate,
  workflowProposalApply,
  workflowSaveDraft,
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
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { aiBudget } from '../src/ai/budget';
import { scriptedAi } from '../src/ai/scripted';
import { buildHttpServer } from '../src/http/server';
import { BUILDER_ASKS, BUILDER_MAX_REPAIRS, BUILDER_SYSTEM } from '../src/workflows/builder';
import { setAiLimit, testServices, type TestServices } from './helpers';

/**
 * The AI builder (POST /v1/workflows/ai/edit): plain words become checked patch ops, stored as a proposal
 * while the draft stays as it is; a repair round on a check error; unsupported asks; a follow-up that refines
 * its proposal; a new workflow; and the daily limit, the missing model and permissions.
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
let org: string;
let app: FastifyInstance;

/** A model that remembers every request before the inner one answers it. */
function recording(inner: AiProvider) {
  const requests: AiRequest[] = [];
  const provider: AiProvider = {
    id: 'recording',
    model: inner.model,
    stream: (request, options) => {
      requests.push(request);
      return inner.stream(request, options);
    },
  };
  return { provider, requests };
}

/** A model that answers each request with the next of these turns, given the requests so far. */
function scripted(turns: ((requests: readonly AiRequest[]) => AiTurn)[]) {
  const requests: AiRequest[] = [];
  const provider: AiProvider = {
    id: 'turns',
    model: 'turns',
    stream: async (request) => {
      requests.push(request);
      const next = turns[Math.min(requests.length, turns.length) - 1]!;
      return next(requests);
    },
  };
  return { provider, requests };
}
const usage = { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 };
const toolTurn = (calls: { name: string; arguments: Record<string, unknown> }[]): AiTurn => ({
  text: '',
  toolCalls: calls.map((c, i) => ({ id: `call_${randomUUID().slice(0, 8)}_${i}`, ...c })),
  stopReason: 'tool_use',
  usage,
});
const finish = (summary: string, unsupported: string[] = []) => ({
  name: 'finish',
  arguments: { summary, unsupported },
});
/** The tool results and notes the builder sent back last. */
function lastFeedback(request: AiRequest): { results: string[]; notes: string[] } {
  const last = request.messages.at(-1)!;
  const blocks = (typeof last.content === 'string' ? [] : last.content) as AiContent[];
  return {
    results: blocks.flatMap((b) => (b.type === 'tool_result' ? [b.content] : [])),
    notes: blocks.flatMap((b) => (b.type === 'text' ? [b.text] : [])),
  };
}

const model = recording(scriptedAi());

async function build(ai: TestServices['ai']): Promise<FastifyInstance> {
  const s = testServices({ ai });
  return buildHttpServer({
    ...s,
    httpDb: testDbs().worker.db,
    verifyToken: createTokenVerifier({
      jwksUrl: `${env.supabaseUrl}/auth/v1/.well-known/jwks.json`,
      jwtIssuer: `${env.supabaseUrl}/auth/v1`,
    }),
    webOrigins: ['http://localhost:3000'],
    assistant: null,
  });
}

const edit = (server: FastifyInstance, token: string, body: Record<string, unknown>) =>
  server.inject({
    method: 'POST',
    url: '/v1/workflows/ai/edit',
    headers: { authorization: `Bearer ${token}` },
    payload: { workspaceId: ws, ...body },
  });

/** "Speed to lead" from its recipe: text, wait 5 minutes, task, wait 1 day, text. */
async function speedToLead(name = 'Speed to lead') {
  const out = await executeCommand(
    api(),
    workflowCreate,
    { workspaceId: ws, name, from: 'recipe', recipeKey: 'speed_to_lead' },
    actor(owner),
    meta(),
  );
  return { id: out.output.workflowId, revision: out.output.revision };
}

async function draftOf(workflowId: string) {
  const [row] = await rows<{ revision: number; definition: unknown }>(
    admin(),
    sql`select revision, definition from app.workflows where id = ${workflowId}`,
  );
  return { revision: row!.revision, definition: parseDefinition(row!.definition) };
}

beforeAll(async () => {
  [owner, member] = await Promise.all([
    createTestUser('builder-owner'),
    createTestUser('builder-member'),
  ]);
  const { output } = await executeCommand(
    api(),
    organizationCreate,
    { businessName: 'Builder HVAC' },
    actor(owner),
    meta(),
  );
  ws = output.workspaceId;
  org = output.organizationId;
  await rows(
    admin(),
    sql`insert into app.workspace_memberships (workspace_id, user_id, role) values (${ws}, ${member.id}, 'member')`,
  );
  [ownerToken, memberToken] = await Promise.all([signInTestUser(owner), signInTestUser(member)]);
  app = await build({ provider: model.provider });
});
afterAll(async () => {
  await app?.close();
  await closeTestDbs();
});

describe('the AI builder', () => {
  it('turns a request into checked ops, stored as a proposal, and leaves the draft alone', async () => {
    const w = await speedToLead();
    const before = await draftOf(w.id);
    const res = await edit(app, ownerToken, {
      workflowId: w.id,
      baseRevision: w.revision,
      prompt: 'Wait two days instead',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({
      proposalId: expect.any(String),
      workflowId: w.id,
      baseRevision: w.revision,
      ops: [
        {
          op: 'update_step',
          stepId: 's_stlwait2',
          patch: { until: { kind: 'duration', duration: { amount: 2, unit: 'days' } } },
        },
      ],
      summary: ['Change the wait from 1 day to 2 days'],
      reply: 'The wait is now 2 days.',
      unsupported: [],
    });
    // The preview is the draft with the ops applied; the checks are the preview's.
    expect(body.preview).toEqual(applyWorkflowOps(before.definition, body.ops).definition);
    expect(body.issues.filter((i: { severity: string }) => i.severity === 'error')).toEqual([]);
    // Nothing changed the draft; the proposal waits, for the person who asked.
    expect(await draftOf(w.id)).toEqual(before);
    const [row] = await rows<{
      workflow_id: string;
      base_revision: number;
      prompt: string;
      created_by: string;
      applied_at: Date | null;
    }>(
      admin(),
      sql`select workflow_id, base_revision, prompt, created_by, applied_at
          from app.workflow_proposals where id = ${body.proposalId}`,
    );
    expect(row).toEqual({
      workflow_id: w.id,
      base_revision: w.revision,
      prompt: 'Wait two days instead',
      created_by: owner.id,
      applied_at: null,
    });
    // The tokens are the asker's, as builder usage on that workflow.
    expect(
      await rows(
        admin(),
        sql`select source::text as source, user_id, workflow_id from app.ai_usage where workspace_id = ${ws}`,
      ),
    ).toEqual([{ source: 'builder', user_id: owner.id, workflow_id: w.id }]);
    // What the model saw: the fixed instructions, the ten strict tools, the workflow with its ids.
    const request = model.requests.at(-1)!;
    expect(request.system).toBe(BUILDER_SYSTEM);
    expect(request.tools?.map((t) => t.name)).toHaveLength(10);
    expect(request.tools?.every((t) => t.strict === true)).toBe(true);
    expect(request.context).toContain('<workflow>');
    expect(request.context).toContain('- s_stlwait2: Wait 1 day');
    expect(request.context).toContain('No step is selected.');
    expect(request.messages[0]!.content).toBe(
      `<request>\nWait two days instead\n</request>\n${BUILDER_ASKS.edit}`,
    );

    // Applying it is one edit to the draft.
    const applied = await executeCommand(
      api(),
      workflowProposalApply,
      { workspaceId: ws, proposalId: body.proposalId, baseRevision: w.revision },
      actor(owner),
      meta(),
    );
    expect(applied.output).toMatchObject({ revision: w.revision + 1, created: false });
    expect((await draftOf(w.id)).definition).toEqual(body.preview);
  });

  it('sends the selected step along as what “it” means', async () => {
    const w = await speedToLead('Selected step');
    const res = await edit(app, ownerToken, {
      workflowId: w.id,
      baseRevision: w.revision,
      prompt: 'Wait two days instead',
      selectedStepId: 's_stlwait1',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ops).toMatchObject([{ op: 'update_step', stepId: 's_stlwait1' }]);
    expect(res.json().summary).toEqual(['Change the wait from 5 minutes to 2 days']);
    expect(model.requests.at(-1)!.context).toContain(
      'The person has this step selected: s_stlwait1 (Wait 5 minutes).',
    );
  });

  it('refines its proposal with a follow-up, and refuses one made for an older draft', async () => {
    const w = await speedToLead('Follow-ups');
    const first = (
      await edit(app, ownerToken, {
        workflowId: w.id,
        baseRevision: w.revision,
        prompt: 'Wait two days instead',
      })
    ).json();
    const res = await edit(app, ownerToken, {
      workflowId: w.id,
      baseRevision: w.revision,
      prompt: 'Add a text after the first wait',
      proposalId: first.proposalId,
    });
    expect(res.statusCode).toBe(200);
    const next = res.json();
    // A new proposal against the same draft: the earlier ops, then the new ones.
    expect(next.proposalId).not.toBe(first.proposalId);
    expect(next.ops).toHaveLength(2);
    expect(next.ops[0]).toEqual(first.ops[0]);
    expect(next.ops[1]).toMatchObject({
      op: 'add_step',
      parentId: null,
      branchId: null,
      index: 2,
      step: { type: 'action', action: 'send_text' },
    });
    expect(next.summary).toEqual([
      'Change the wait from 1 day to 2 days',
      expect.stringMatching(
        /^Add a step to the main path: Send a text: “Hi \{\{person\.first_name\}\}, just checking in/,
      ),
    ]);
    expect(model.requests.at(-1)!.context).toContain(
      '<earlier_request>Wait two days instead</earlier_request>',
    );
    // The model saw the earlier change already made.
    expect(model.requests.at(-1)!.context).toContain('- s_stlwait2: Wait 2 days');
    const [stored] = await rows<{ prompt: string; ops: unknown[] }>(
      admin(),
      sql`select prompt, ops from app.workflow_proposals where id = ${next.proposalId}`,
    );
    expect(stored!.prompt).toBe('Wait two days instead\nAdd a text after the first wait');
    expect(stored!.ops).toHaveLength(2);

    // Once the draft moves on, the earlier proposal can't be refined, and the old revision is refused.
    const saved = await executeCommand(
      api(),
      workflowSaveDraft,
      {
        workspaceId: ws,
        workflowId: w.id,
        baseRevision: w.revision,
        ops: [{ op: 'delete_step', stepId: 's_stltext2' }],
      },
      actor(owner),
      meta(),
    );
    const old = await edit(app, ownerToken, {
      workflowId: w.id,
      baseRevision: w.revision,
      prompt: 'Stop if they book',
    });
    expect(old.statusCode).toBe(409);
    expect(old.json()).toMatchObject({ error: { rule: 'revision_conflict' } });
    const stale = await edit(app, ownerToken, {
      workflowId: w.id,
      baseRevision: saved.output.revision,
      prompt: 'Stop if they book',
      proposalId: next.proposalId,
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ error: { rule: 'proposal_stale' } });
  });

  it('runs a repair round when the checks find an error the change caused', async () => {
    const w = await speedToLead('Repairs');
    const turns = scripted([
      // An approval nobody can decide: a blocking check.
      () =>
        toolTurn([
          {
            name: 'add_step',
            arguments: {
              ref: 'ok',
              parentId: null,
              branchId: null,
              index: 1,
              type: 'approval',
              action: null,
              onError: null,
              json: JSON.stringify({ approvers: { kind: 'users', userIds: [] } }),
            },
          },
          finish('Adds an approval before the wait.'),
        ]),
      // It reads the new step's id from the result and fixes the approvers.
      (requests) => {
        const { results } = lastFeedback(requests.at(-1)!);
        const id = /The new step’s id is (s_[a-z0-9]{8})/.exec(results.join('\n'))![1]!;
        return toolTurn([
          {
            name: 'update_step',
            arguments: { stepId: id, json: JSON.stringify({ approvers: { kind: 'admins' } }) },
          },
          finish('Adds an approval for owners and admins before the wait.'),
        ]);
      },
    ]);
    const server = await build({ provider: turns.provider });
    try {
      const res = await edit(server, ownerToken, {
        workflowId: w.id,
        baseRevision: w.revision,
        prompt: 'Ask me before the first wait',
      });
      expect(res.statusCode).toBe(200);
      expect(turns.requests).toHaveLength(2);
      const feedback = lastFeedback(turns.requests[1]!);
      expect(feedback.notes.join('\n')).toMatch(/The checks found problems the change causes:/);
      expect(feedback.notes.join('\n')).toMatch(/No one is picked to approve/);
      const body = res.json();
      expect(body.ops.map((o: { op: string }) => o.op)).toEqual(['add_step', 'update_step']);
      expect(body.issues.map((i: { code: string }) => i.code)).not.toContain(
        'approval_no_approvers',
      );
      expect(body.reply).toBe('Adds an approval for owners and admins before the wait.');
      expect(body.unsupported).toEqual([]);
    } finally {
      await server.close();
    }
  });

  it('feeds failed calls back, stops after three repairs, and reports what it couldn’t do', async () => {
    const w = await speedToLead('Stubborn');
    const turns = scripted([
      () =>
        toolTurn([
          { name: 'delete_step', arguments: { stepId: 'nope' } },
          finish('Removes it.', ['Call them automatically']),
        ]),
    ]);
    const server = await build({ provider: turns.provider });
    try {
      const res = await edit(server, ownerToken, {
        workflowId: w.id,
        baseRevision: w.revision,
        prompt: 'Remove the step called nope, and call them automatically',
      });
      expect(res.statusCode).toBe(200);
      // The first try and three repairs.
      expect(turns.requests).toHaveLength(1 + BUILDER_MAX_REPAIRS);
      const feedback = lastFeedback(turns.requests[1]!);
      expect(feedback.results[0]).toMatch(/no step “nope”/);
      expect(feedback.notes[0]).toMatch(/didn’t work/);
      expect(res.json()).toMatchObject({
        ops: [],
        unsupported: [
          'Call them automatically',
          'Part of the change couldn’t be made, so it’s left out. Try saying it another way.',
        ],
      });
    } finally {
      await server.close();
    }
  });

  it('lists what workflows can’t do as unsupported, changing nothing', async () => {
    const w = await speedToLead('Unsupported');
    const res = await edit(app, ownerToken, {
      workflowId: w.id,
      baseRevision: w.revision,
      prompt: 'Book them in for Tuesday',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      ops: [],
      summary: [],
      unsupported: [
        'Workflows can’t book appointments for customers yet. A text with your booking link can go instead.',
      ],
    });
  });

  it('drafts a new workflow from blank, with the trigger the model picks', async () => {
    const res = await edit(app, ownerToken, {
      workflowId: null,
      baseRevision: null,
      prompt: 'A workflow that texts new leads within a minute',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ops[0]).toMatchObject({
      op: 'set_trigger',
      trigger: { kind: 'event', event: 'lead.created' },
    });
    expect(body.preview.trigger).toMatchObject({ kind: 'event', event: 'lead.created' });
    expect(body.preview.steps.map((s: { type: string }) => s.type)).toEqual([
      'action',
      'wait',
      'action',
      'wait',
      'action',
    ]);
    expect(body.preview.settings.stopOn).toEqual(['reply', 'booking']);
    expect(model.requests.at(-1)!.messages[0]!.content).toMatch(
      new RegExp(`${BUILDER_ASKS.create.replace('.', '\\.')}$`),
    );
    const created = await executeCommand(
      api(),
      workflowProposalApply,
      { workspaceId: ws, proposalId: body.proposalId, name: 'New lead text-back' },
      actor(owner),
      meta(),
    );
    expect(created.output.created).toBe(true);
    expect((await draftOf(created.output.workflowId)).definition).toEqual(body.preview);
  });

  it('is for people who manage workflows, and needs a request', async () => {
    const w = await speedToLead('Permissions');
    const res = await edit(app, memberToken, {
      workflowId: w.id,
      baseRevision: w.revision,
      prompt: 'Wait two days instead',
    });
    expect(res.statusCode).toBe(403);
    const empty = await edit(app, ownerToken, {
      workflowId: w.id,
      baseRevision: w.revision,
      prompt: '  ',
    });
    expect(empty.statusCode).toBe(400);
    const half = await edit(app, ownerToken, { workflowId: w.id, prompt: 'Wait two days instead' });
    expect(half.statusCode).toBe(400);
  });

  it('says so when no model is set up, and stops at the daily limit', async () => {
    const w = await speedToLead('Limits');
    const none = await build({ provider: null });
    try {
      const res = await edit(none, ownerToken, {
        workflowId: w.id,
        baseRevision: w.revision,
        prompt: 'Wait two days instead',
      });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toMatchObject({
        error: {
          rule: 'ai_not_configured',
          message:
            'The AI isn’t set up for HandsFreeOS yet, so this can’t run. HandsFreeOS support can switch it on.',
        },
      });
    } finally {
      await none.close();
    }
    const today = await aiBudget.today(testDbs().worker.db, {
      workspaceId: ws,
      organizationId: org,
    });
    expect(today.spentCents).toBeGreaterThan(0);
    // The business sets its daily AI limit at what it has spent: the builder asks the model nothing more.
    const limitCents = Math.floor(today.spentCents);
    const was = await setAiLimit(ws, limitCents);
    const limited = await build({ provider: model.provider });
    const asked = model.requests.length;
    try {
      const res = await edit(limited, ownerToken, {
        workflowId: w.id,
        baseRevision: w.revision,
        prompt: 'Wait two days instead',
      });
      expect(res.statusCode).toBe(429);
      expect(res.json()).toMatchObject({
        error: {
          rule: 'budget_reached',
          message: `This business reached the ${money(limitCents)} daily AI limit, so the AI is paused until midnight. An owner or admin can raise the limit in Settings → Usage & balance.`,
        },
      });
      expect(model.requests.length).toBe(asked);
    } finally {
      await limited.close();
      await setAiLimit(ws, was);
    }
  });
});
