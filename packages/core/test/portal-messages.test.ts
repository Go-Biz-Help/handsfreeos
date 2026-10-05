/**
 * Messages in a client's portal (Real Estate round two, step 5): a client writes about their deal, and the thread
 * lands in the Inbox assigned to the deal's main person, sealed with the deal, so only the people on it, owners and
 * whoever sees every deal read it. Someone on the deal replies; the client reads it under their own rules and it
 * counts as seen. Nobody hands it to the AI teammate or links it to someone else, and a client writes only about a
 * deal of theirs.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { rows, sql } from '@hfos/db/client';
import { workspaceMemberships } from '@hfos/db/schema';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  conversationGet,
  conversationLinkPerson,
  executeCommand,
  executeQuery,
  inboxList,
  messageSend,
  personCreate,
  portalAccessGive,
  portalCheckCode,
  portalMarkRead,
  portalMessages,
  portalMessageSend,
  portalSendCode,
  type CustomerActor,
  type RequestMeta,
} from '../src/server';
import { realestateBusiness } from './addons/realestate-fixture';
import { admin, ask, expectHfos, run, runSystem, type Scope } from './calendar-helpers';

let owner: TestUser;
let agent: TestUser;
let member: TestUser;
let scope: Scope;
let linh: CustomerActor;
let deal: string;
let omarsDeal: string;
let conversationId: string;
let replyId: string;

const worker = () => testDbs().worker.db;
const portal = (): RequestMeta => ({ correlationId: randomUUID(), channel: 'portal' });
const asLinh = <T>(op: Parameters<typeof executeQuery>[1], input: unknown) =>
  executeQuery(worker(), op, input, linh, portal()) as Promise<T>;
const linhDoes = <T>(op: Parameters<typeof executeCommand>[1], input: unknown) =>
  executeCommand(worker(), op, input, linh, portal()).then((r) => r.output as T);

async function dealFor(personId: string, name: string, ownerId: string): Promise<string> {
  const [r] = await rows<{ id: string }>(
    admin(),
    sql`insert into app.custom_records (workspace_id, type_id, name, created_by, owner_user_id)
        select ${scope.workspaceId}, t.id, ${name}, ${ownerId}, ${ownerId} from app.custom_record_types t
        where t.workspace_id = ${scope.workspaceId} and t.key = 'realestate_deal' returning id`,
  );
  await rows(
    admin(),
    sql`insert into app.relationships (workspace_id, type_id, a_person_id, b_custom_record_id)
        select ${scope.workspaceId}, t.id, ${personId}, ${r!.id} from app.relationship_types t
        where t.workspace_id = ${scope.workspaceId} and t.addon_key = 'realestate_client'`,
  );
  return r!.id;
}

const seenBy = async (u: TestUser) =>
  (await ask(inboxList, { workspaceId: scope.workspaceId, box: 'all' }, u)).items
    .filter((c) => c.channel === 'portal')
    .map((c) => c.id);

beforeAll(async () => {
  [owner, agent, member] = await Promise.all([
    createTestUser('portal-msg-owner', { fullName: 'Dana Reyes' }),
    createTestUser('portal-msg-agent', { fullName: 'Marco Diaz' }),
    createTestUser('portal-msg-member', { fullName: 'Priya Shah' }),
  ]);
  const workspaceId = await realestateBusiness(owner, 'Portal Messages Realty');
  const [w] = await rows<{ organization_id: string }>(
    admin(),
    sql`select organization_id from app.workspaces where id = ${workspaceId}`,
  );
  scope = { workspaceId, organizationId: w!.organization_id };
  await testDbs()
    .admin.db.insert(workspaceMemberships)
    .values([
      { workspaceId, userId: agent.id, role: 'member' },
      { workspaceId, userId: member.id, role: 'member' },
    ]);
  const linhId = (
    await run(
      personCreate,
      { workspaceId, firstName: 'Linh', lastName: 'Nguyen', email: 'linh.msg@example.com' },
      owner,
    )
  ).personId;
  const omarId = (
    await run(personCreate, { workspaceId, firstName: 'Omar', lastName: 'Haddad' }, owner)
  ).personId;
  // Marco's deal: he is its main person.
  deal = await dealFor(linhId, 'Nguyen purchase', agent.id);
  omarsDeal = await dealFor(omarId, 'Haddad purchase', owner.id);
  const { accessId } = await run(portalAccessGive, { workspaceId, personId: linhId }, owner);
  const sent = await runSystem(portalSendCode, { workspaceId, accessId }, scope);
  const hit = await runSystem(
    portalCheckCode,
    {
      workspaceId,
      accessId,
      code: sent.code,
      tokenHash: createHash('sha256').update(randomBytes(32)).digest('hex'),
    },
    scope,
  );
  linh = { type: 'customer', ...scope, personId: linhId, sessionId: hit.sessionId! };
});
afterAll(closeTestDbs);

describe('a client writing from their portal', () => {
  it('starts a thread about their deal, assigned to its main person and sealed with it', async () => {
    const out = await linhDoes<{ conversationId: string; duplicate: boolean }>(portalMessageSend, {
      workspaceId: scope.workspaceId,
      recordId: deal,
      body: 'Can we see the Maple Ave house on Saturday?',
      clientId: 'portal-msg-0001',
    });
    conversationId = out.conversationId;
    const [c] = await rows<{
      channel: string;
      counterpart: string;
      assignee_user_id: string;
      custom_record_id: string;
      sealed: boolean;
      unread_count: number;
    }>(
      admin(),
      sql`select channel::text, counterpart, assignee_user_id, custom_record_id, sealed, unread_count
          from app.conversations where id = ${conversationId}`,
    );
    expect(c).toEqual({
      channel: 'portal',
      counterpart: `portal:${linh.personId}:${deal}`,
      assignee_user_id: agent.id,
      custom_record_id: deal,
      sealed: true,
      unread_count: 1,
    });
    // The same message twice is filed once.
    const again = await linhDoes<{ duplicate: boolean }>(portalMessageSend, {
      workspaceId: scope.workspaceId,
      recordId: deal,
      body: 'Can we see the Maple Ave house on Saturday?',
      clientId: 'portal-msg-0001',
    });
    expect(again.duplicate).toBe(true);
    // Its timeline line is the deal's, sealed with it.
    const [line] = await rows<{ kind: string; sealed: boolean; actor_type: string }>(
      admin(),
      sql`select kind::text, sealed, actor_type::text from app.activities
          where custom_record_id = ${deal} and kind = 'portal'`,
    );
    expect(line).toEqual({ kind: 'portal', sealed: true, actor_type: 'customer' });
  });

  it('is seen by the people on the deal and owners, and by nobody else', async () => {
    expect(await seenBy(agent)).toEqual([conversationId]);
    expect(await seenBy(owner)).toEqual([conversationId]);
    expect(await seenBy(member)).toEqual([]);
    await expectHfos(
      () => ask(conversationGet, { workspaceId: scope.workspaceId, conversationId }, member),
      'not_found',
    );
    const got = await ask(
      conversationGet,
      { workspaceId: scope.workspaceId, conversationId },
      agent,
    );
    expect(got.conversation).toMatchObject({
      channel: 'portal',
      counterpartDisplay: 'Linh Nguyen',
      record: { id: deal, name: 'Nguyen purchase' },
    });
    expect(got.canText).toEqual({ ok: false, reason: 'portal_channel' });
  });

  it('writes only about a deal of theirs', async () => {
    await expectHfos(
      () =>
        linhDoes(portalMessageSend, {
          workspaceId: scope.workspaceId,
          recordId: omarsDeal,
          body: 'Hello?',
          clientId: 'portal-msg-0002',
        }),
      'not_found',
    );
  });
});

describe('the team replying', () => {
  it('replies in the portal, and the client reads it with who wrote it', async () => {
    const sent = await run(
      messageSend,
      {
        workspaceId: scope.workspaceId,
        conversationId,
        channel: 'portal',
        body: 'Saturday at 10 works. See you there!',
      },
      agent,
    );
    expect(sent.status).toBe('queued');
    replyId = sent.messageId;
    const thread = await asLinh<{
      conversationId: string;
      messages: {
        id: string;
        fromYou: boolean;
        body: string;
        from: string | null;
        seen: boolean;
      }[];
      unread: number;
    }>(portalMessages, { workspaceId: scope.workspaceId, recordId: deal });
    expect(thread.conversationId).toBe(conversationId);
    expect(thread.messages.map((m) => [m.fromYou, m.body, m.from, m.seen])).toEqual([
      [true, 'Can we see the Maple Ave house on Saturday?', null, true],
      [false, 'Saturday at 10 works. See you there!', 'Marco Diaz', false],
    ]);
    expect(thread.unread).toBe(1);
  });

  it('counts as seen once their portal showed it', async () => {
    const out = await linhDoes<{ marked: number }>(portalMarkRead, {
      workspaceId: scope.workspaceId,
      conversationId,
      throughMessageId: replyId,
    });
    expect(out.marked).toBe(1);
    const thread = await asLinh<{ unread: number }>(portalMessages, {
      workspaceId: scope.workspaceId,
      recordId: deal,
    });
    expect(thread.unread).toBe(0);
  });

  it('is never a text, and never someone else’s', async () => {
    await expectHfos(
      () =>
        run(
          messageSend,
          { workspaceId: scope.workspaceId, conversationId, channel: 'sms', body: 'Hi' },
          agent,
        ),
      'channel_mismatch',
    );
    const omar = await run(
      personCreate,
      { workspaceId: scope.workspaceId, firstName: 'Ana', lastName: 'Lopez' },
      owner,
    );
    await expectHfos(
      () =>
        run(
          conversationLinkPerson,
          { workspaceId: scope.workspaceId, conversationId, personId: omar.personId },
          agent,
        ),
      'conversation_portal',
    );
  });

  it('isn’t answered by someone off the deal', async () => {
    await expectHfos(
      () =>
        run(
          messageSend,
          { workspaceId: scope.workspaceId, conversationId, channel: 'portal', body: 'Hi' },
          member,
        ),
      'not_found',
    );
  });
});
