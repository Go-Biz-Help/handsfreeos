/**
 * The AI teammate using an add-on (round seven, steps 5–6; Chris 2026-10-05: answer from their deal, ask before
 * acting), with Real Estate Agent on: it looks up what the client's portal shows them, as them, and nothing about
 * anyone else; what it asks for waits for someone on their deal, and runs as them once they OK it; and a reply the fair
 * housing checks flag waits for a person, even though it answers on its own.
 */
import { randomUUID } from 'node:crypto';
import {
  ADDON_SERVER_MODULES,
  aiTeammateDecideDraft,
  aiTeammateDraftList,
  executeCommand,
  executeQuery,
  HfosError,
  type CommandDef,
  type CustomerActor,
  type HumanActor,
  type QueryDef,
} from '@hfos/core/server';
import { asCustomerTeammate, rows, sql } from '@hfos/db/client';
import { createTestUser, testDbs } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { installRealestate } from '../../../packages/core/test/addons/realestate-fixture';
import { scriptedAi, type TeammateRule } from '../src/ai/scripted';
import { REALESTATE_SCRIPTED_TEAMMATE } from '../src/addons/realestate/scripted';
import {
  admin,
  aiReplies,
  api,
  drain,
  draftsOf,
  newCustomer,
  replyNow,
  runsOf,
  saveTeammate,
  teammateRequests,
  teammateWorld,
  textIn,
  toolCallsOf,
  useModel,
  type TeammateWorld,
} from './ai-team-world';

const realestate = ADDON_SERVER_MODULES.find((m) => m.manifest.id === 'realestate')!;
const op = (name: string) =>
  [...realestate.commands!, ...realestate.queries!].find((c) => c.name === name)!;
const meta = () => ({ correlationId: randomUUID(), channel: 'test' as const });
const ownerOf = (w: TeammateWorld): HumanActor => ({
  type: 'human',
  userId: w.owner.id,
  email: w.owner.email,
  claims: w.owner.claims,
});

let w: TeammateWorld;
let dana: { id: string; phone: string };
let danaDeal: string;
let eliDeal: string;

const dealsOf = (t: Parameters<TeammateRule['step']>[0]) =>
  (t.results['realestate_my_deals']?.at(-1)?.['deals'] ?? []) as { dealId: string; name: string }[];

const RULES: TeammateRule[] = [
  {
    when: /where are we/i,
    step: (t) =>
      !t.results['realestate_my_deals']
        ? { calls: [{ name: 'realestate_my_deals', arguments: {} }] }
        : {
            calls: [
              {
                name: 'reply',
                arguments: { message: `Your deal is ${dealsOf(t)[0]?.name ?? 'not here'}.` },
              },
            ],
          },
  },
  {
    when: /other deal/i,
    step: (t) =>
      !t.results['realestate_my_deal']
        ? { calls: [{ name: 'realestate_my_deal', arguments: { dealId: eliDeal } }] }
        : { calls: [{ name: 'reply', arguments: { message: 'I can only see your own deal.' } }] },
  },
  // Real Estate's own lines for the stand-in: asking to add a home, and a reply the fair housing checks hold.
  ...REALESTATE_SCRIPTED_TEAMMATE,
];

beforeAll(async () => {
  w = await teammateWorld('ai-addons', { status: 'automatic', disclosure: 'when_asked' });
  await installRealestate(w.workspaceId);
  useModel(w, scriptedAi([], { teammate: RULES }));
  dana = await newCustomer(w, 'Dana');
  const eli = await newCustomer(w, 'Eli');
  const open = async (name: string, client: string) =>
    (
      (
        await executeCommand(
          api(),
          op('realestate.deal.open') as CommandDef,
          { workspaceId: w.workspaceId, side: 'buyer', name, clientPersonId: client },
          ownerOf(w),
          meta(),
        )
      ).output as { dealId: string }
    ).dealId;
  danaDeal = await open('Dana’s home search', dana.id);
  eliDeal = await open('Eli’s home search', eli.id);
}, 120_000);
afterAll(async () => {
  await w?.app.close();
});

describe('the switch', () => {
  it('is off until an owner turns it on: no add-on tools before', async () => {
    const m = await textIn(w, dana.phone, 'Hi, it’s Dana about the house hunt.');
    await replyNow(w, m.conversationId);
    const req = teammateRequests(w).at(-1)!;
    expect(req.tools?.map((t) => t.name)).not.toContain('realestate_my_deals');
    expect(req.lasting).not.toContain('realestate_');
    await saveTeammate(w, { addons: { realestate: { on: true } } });
  });
});

describe('look-ups, as the client', () => {
  it('see the client’s own deal, as their portal shows it', async () => {
    const m = await textIn(w, dana.phone, 'Where are we now?');
    await replyNow(w, m.conversationId);
    const req = teammateRequests(w).at(-1)!;
    expect(req.tools?.map((t) => t.name)).toEqual(
      expect.arrayContaining(['realestate_my_deals', 'realestate_ask_add_home']),
    );
    expect(req.lasting).toMatch(/Real Estate Agent \(realestate_…\): their deal with you/);
    const [run] = (await runsOf(m.conversationId)).slice(-1);
    const calls = await toolCallsOf(run!.id);
    const lookup = calls.find((c) => c.tool === 'realestate_my_deals')!;
    expect(lookup.status).toBe('done');
    expect(lookup.command).toBe('realestate.portal.deals');
    const deals = (lookup.result?.['content'] as { deals: { name: string }[] }).deals;
    expect(deals.map((d) => d.name)).toEqual(['Dana’s home search']);
    // A text goes out with plain apostrophes.
    expect((await aiReplies(m.conversationId)).at(-1)?.body_text).toBe(
      "Your deal is Dana's home search.",
    );
  });

  it('never reach another client’s deal', async () => {
    const m = await textIn(w, dana.phone, 'What about my other deal?');
    await replyNow(w, m.conversationId);
    const [run] = (await runsOf(m.conversationId)).slice(-1);
    const call = (await toolCallsOf(run!.id)).find((c) => c.tool === 'realestate_my_deal')!;
    expect(call.status).toBe('refused');
    expect(JSON.stringify(call.result)).not.toContain('Eli');
  });
});

describe('asks', () => {
  let draftId: string;

  it('change nothing: they wait for someone on the client’s deal', async () => {
    const m = await textIn(w, dana.phone, 'Can you add 412 Oak St to my list?');
    await replyNow(w, m.conversationId);
    const asks = (await draftsOf(m.conversationId)).filter((d) => d.kind === 'ask');
    expect(asks).toHaveLength(1);
    draftId = asks[0]!.id;
    expect(asks[0]!.status).toBe('pending');
    const [row] = await rows<{ custom_record_id: string; preview: Record<string, unknown> }>(
      admin(),
      sql`select custom_record_id, preview from app.ai_teammate_drafts where id = ${asks[0]!.id}`,
    );
    expect(row!.custom_record_id).toBe(danaDeal);
    expect(row!.preview['ask']).toMatchObject({
      operation: 'realestate.home.add',
      summary: 'Add 412 Oak St to Dana’s homes',
      recordId: danaDeal,
    });
    expect(await homesOn(danaDeal)).toEqual([]);
    // The reply itself goes out: it says it asked.
    expect((await aiReplies(m.conversationId)).at(-1)?.body_text).toBe(
      "I've asked your agent to add it.",
    );
  });

  it('are decided only by someone who works the deal', async () => {
    const member = await createTestUser('ai-addons-member', { fullName: 'Mo Member' });
    await rows(
      admin(),
      sql`insert into app.workspace_memberships (workspace_id, user_id, role)
          values (${w.workspaceId}, ${member.id}, 'member')`,
    );
    const err = await executeCommand(
      api(),
      aiTeammateDecideDraft,
      { workspaceId: w.workspaceId, draftId, decision: 'approve' },
      { type: 'human', userId: member.id, email: member.email, claims: member.claims },
      meta(),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HfosError);
    expect((err as HfosError).rule).toBe('not_on_record');
    expect(await homesOn(danaDeal)).toEqual([]);
    // The Inbox and Approvals list it for both, but only someone on the deal sees its name and may decide it.
    const listed = (actor: HumanActor) =>
      executeQuery(
        api(),
        aiTeammateDraftList,
        { workspaceId: w.workspaceId, status: 'pending', kind: 'ask' },
        actor,
        meta(),
      ).then((r) => r.items.find((d) => d.id === draftId)!);
    expect(await listed(ownerOf(w))).toMatchObject({
      kind: 'ask',
      canDecide: true,
      record: { id: danaDeal, name: 'Dana’s home search' },
      preview: { ask: { summary: 'Add 412 Oak St to Dana’s homes' } },
    });
    expect(
      await listed({
        type: 'human',
        userId: member.id,
        email: member.email,
        claims: member.claims,
      }),
    ).toMatchObject({ kind: 'ask', canDecide: false, record: { id: danaDeal, name: null } });
  });

  it('run as the person who approves, then the client hears it’s done', async () => {
    await executeCommand(
      api(),
      aiTeammateDecideDraft,
      { workspaceId: w.workspaceId, draftId, decision: 'approve' },
      ownerOf(w),
      meta(),
    );
    expect(await homesOn(danaDeal)).toEqual(['412 Oak St']);
    const [added] = await rows<{ actor_id: string | null; actor_type: string }>(
      admin(),
      sql`select actor_id, actor_type from app.events
          where workspace_id = ${w.workspaceId} and event_type = 'realestate.home.added'
          order by created_at desc limit 1`,
    );
    expect(added).toMatchObject({ actor_type: 'human', actor_id: w.owner.id });
    await drain(w);
    const [conv] = await rows<{ id: string }>(
      admin(),
      sql`select conversation_id as id from app.ai_teammate_drafts where id = ${draftId}`,
    );
    expect((await aiReplies(conv!.id)).at(-1)?.body_text).toBe('412 Oak St is on your list now.');
  });
});

describe('fair housing on its replies', () => {
  it('holds a flagged reply for a person, though it answers on its own', async () => {
    const m = await textIn(w, dana.phone, 'What’s the area like around Oak St?');
    await replyNow(w, m.conversationId);
    const replies = (await draftsOf(m.conversationId)).filter(
      (d) => d.kind === 'reply' && d.status === 'pending',
    );
    expect(replies).toHaveLength(1);
    const preview = replies[0]!.preview as unknown as {
      message: { body: string };
      flags: { addonName: string; message: string }[];
    };
    expect(preview.message.body).toContain('good schools');
    expect(preview.flags[0]).toMatchObject({ addonName: 'Real Estate Agent' });
    expect(preview.flags[0]!.message).toMatch(/^Fair housing: “good schools”/);
    expect((await aiReplies(m.conversationId)).map((r) => r.body_text)).not.toContain(
      preview.message.body,
    );
  });
});

describe('the kernel', () => {
  const asTeammate = (runId: string): CustomerActor => ({
    type: 'customer',
    workspaceId: w.workspaceId,
    organizationId: w.organizationId,
    personId: dana.id,
    sessionId: null,
    teammateRunId: runId,
  });

  it('refuses the teammate reading as a client any change', async () => {
    const err = await executeCommand(
      testDbs().worker.db,
      op('realestate.portal.home.add') as CommandDef,
      { workspaceId: w.workspaceId, dealId: danaDeal, address: '9 Elm St' },
      asTeammate(randomUUID()),
      meta(),
    ).catch((e: unknown) => e);
    expect((err as HfosError).rule).toBe('customer_teammate_reads_only');
  });

  it('reads nothing once the run stopped answering', async () => {
    const [done] = (await runsOf((await latestConversation()).id)).slice(-1);
    expect(done!.status).toBe('done');
    const err = await executeQuery(
      testDbs().worker.db,
      op('realestate.portal.deals') as QueryDef,
      { workspaceId: w.workspaceId },
      asTeammate(done!.id),
      meta(),
    ).catch((e: unknown) => e);
    expect((err as HfosError).rule).toBe('customer_teammate_done');
    // The database agrees, and a device's session always comes first.
    const [who] = await asCustomerTeammate(testDbs().worker.db, done!.id, (tx) =>
      rows<{ p: string | null }>(tx, sql`select portal.person() as p`),
    );
    expect(who!.p).toBeNull();
  });
});

async function homesOn(dealId: string): Promise<string[]> {
  const found = await rows<{ address: string }>(
    admin(),
    sql`select address from addon_realestate.homes where deal_record_id = ${dealId} order by created_at`,
  );
  return found.map((h) => h.address);
}

async function latestConversation(): Promise<{ id: string }> {
  const [c] = await rows<{ id: string }>(
    admin(),
    sql`select id from app.conversations where workspace_id = ${w.workspaceId} and person_id = ${dana.id}
        order by created_at desc limit 1`,
  );
  return c!;
}
