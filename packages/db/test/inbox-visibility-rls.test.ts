/**
 * 0083 and 0084: a member sees their own threads, when the business asks for it.
 *
 * **Needs the stack up.** The lockstep property this feature turns on — RLS, the stored lists and the sync
 * config all saying the same thing — is checked from three directions, and this is the two that need a
 * database. The third is `packages/db/test/sync-inbox-config.test.ts`, which needs nothing.
 *
 * Every test here ends by asserting `private.sync_inbox_mismatches()` and
 * `private.sync_inbox_access_mismatches()` are empty, because a policy and a list that disagree is the whole
 * failure mode: one way round a member's phone keeps threads the web hides, the other way their phone drops
 * threads the web shows and it looks like data loss.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rows, sql } from '../src/client';
import { workspaceMemberships } from '../src/schema/index';
import {
  as,
  asService,
  bootstrapOrganization,
  closeAll,
  createTestUser,
  dbs,
  type TestUser,
} from './harness';

let owner: TestUser;
let admin: TestUser;
let dale: TestUser;
let marco: TestUser;
let ws: string;
let org: string;
let numberId: string;
/** Dale's, Marco's, on Marco's number, and nobody's. */
let assignedDale: string;
let assignedMarco: string;
let onMarcosNumber: string;
let nobodys: string;

const worker = () => asService({ workspaceId: ws, organizationId: org });
const admin$ = dbs.admin.db;

const randomE164 = (): string =>
  `+1${2 + Math.floor(Math.random() * 8)}${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`;

/** Which of the four threads this person can read, by name. */
async function visibleTo(u: TestUser): Promise<string[]> {
  const seen = await as(u)((tx) =>
    rows<{ id: string }>(tx, sql`select id from app.conversations where workspace_id = ${ws}`),
  );
  const byId = new Map([
    [assignedDale, 'dale'],
    [assignedMarco, 'marco'],
    [onMarcosNumber, 'marcos-number'],
    [nobodys, 'nobodys'],
  ]);
  return seen
    .map((r) => byId.get(r.id))
    .filter((n): n is string => n !== undefined)
    .sort();
}

/** The three sides in step. Empty both ways, or this feature is not safe to be on. */
async function inStep(): Promise<void> {
  expect(await rows(admin$, sql`select * from private.sync_inbox_mismatches(${ws})`)).toEqual([]);
  expect(
    await rows(admin$, sql`select * from private.sync_inbox_access_mismatches(${ws})`),
  ).toEqual([]);
}

/**
 * Flip the switch the way anything other than the command would — a raw settings write.
 *
 * **Merged with `||`, not `jsonb_set`.** A workspace's `settings` starts as `'{}'`, and `jsonb_set` does not
 * create intermediate objects: `jsonb_set('{}', '{inbox,perPerson}', 'true')` returns `'{}'` unchanged. This
 * file used to do exactly that, so the switch was never actually on and all six of these tests were asserting
 * against a business that had never opted in.
 */
const setPerPerson = (on: boolean) =>
  rows(
    admin$,
    sql`update app.workspaces
        set settings = coalesce(settings, '{}'::jsonb) || jsonb_build_object('inbox',
              coalesce(settings -> 'inbox', '{}'::jsonb) || jsonb_build_object('perPerson', ${on}::boolean))
        where id = ${ws}`,
  );

/**
 * Nothing: `workspaces_inbox_switch` repaints inside the write above.
 *
 * Kept as a call site rather than deleted, because "the setting moved and the lists followed, with no command
 * involved" is the property this file exists to prove.
 */
const repaint = async (): Promise<void> => {};

beforeAll(async () => {
  [owner, admin, dale, marco] = await Promise.all([
    createTestUser('inbox-owner'),
    createTestUser('inbox-admin'),
    createTestUser('inbox-dale'),
    createTestUser('inbox-marco'),
  ]);
  const a = await bootstrapOrganization(owner, 'Inbox Org', 'Inbox');
  ws = a.wsId;
  org = a.orgId;
  await admin$.insert(workspaceMemberships).values([
    { workspaceId: ws, userId: admin.id, role: 'admin' },
    { workspaceId: ws, userId: dale.id, role: 'member' },
    { workspaceId: ws, userId: marco.id, role: 'member' },
  ]);
  numberId = (
    await worker()((tx) =>
      rows<{ id: string }>(
        tx,
        sql`insert into app.phone_numbers (workspace_id, e164, number_type, status, is_default)
            values (${ws}, ${randomE164()}, 'local', 'active', true) returning id`,
      ),
    )
  )[0]!.id;
  await worker()((tx) =>
    rows(
      tx,
      sql`insert into app.phone_number_members (workspace_id, phone_number_id, user_id)
          values (${ws}, ${numberId}, ${marco.id})`,
    ),
  );
  const thread = async (counterpart: string, assignee: string | null, number: string | null) =>
    (
      await worker()((tx) =>
        rows<{ id: string }>(
          tx,
          sql`insert into app.conversations (workspace_id, channel, counterpart, assignee_user_id, phone_number_id)
              values (${ws}, 'sms', ${counterpart}, ${assignee}, ${number}) returning id`,
        ),
      )
    )[0]!.id;
  assignedDale = await thread(randomE164(), dale.id, null);
  assignedMarco = await thread(randomE164(), marco.id, null);
  onMarcosNumber = await thread(randomE164(), null, numberId);
  nobodys = await thread(randomE164(), null, null);
  // One message on each, so the children have something to follow.
  for (const id of [assignedDale, assignedMarco, onMarcosNumber, nobodys])
    await worker()((tx) =>
      rows(
        tx,
        sql`insert into app.messages (workspace_id, conversation_id, channel, direction, status, body_text, occurred_at)
            values (${ws}, ${id}, 'sms', 'inbound', 'received', 'Hello', now())`,
      ),
    );
}, 60_000);

afterAll(closeAll);

describe('off, which is how every business starts', () => {
  it('shows everybody everything, exactly as before', async () => {
    for (const u of [owner, admin, dale, marco])
      expect(await visibleTo(u)).toEqual(['dale', 'marco', 'marcos-number', 'nobodys']);
  });

  it('leaves every list empty and every phone seeing the whole inbox', async () => {
    const lists = await rows<{ member_viewer_ids: string[] }>(
      admin$,
      sql`select member_viewer_ids from app.conversations where workspace_id = ${ws}`,
    );
    expect(lists.every((r) => r.member_viewer_ids.length === 0)).toBe(true);
    const access = await rows<{ sees_whole_inbox: boolean }>(
      admin$,
      sql`select sees_whole_inbox from app.workspace_access where workspace_id = ${ws}`,
    );
    expect(access.every((r) => r.sees_whole_inbox)).toBe(true);
    await inStep();
  });
});

describe('on', () => {
  beforeAll(async () => {
    await setPerPerson(true);
    await repaint();
  });

  it('gives a member their own threads, their number’s, and the ones nobody owns', async () => {
    expect(await visibleTo(dale)).toEqual(['dale', 'nobodys']);
    expect(await visibleTo(marco)).toEqual(['marco', 'marcos-number', 'nobodys']);
  });

  it('still shows the owner and the admin all of it', async () => {
    for (const u of [owner, admin])
      expect(await visibleTo(u)).toEqual(['dale', 'marco', 'marcos-number', 'nobodys']);
  });

  it('never hides a thread nobody has picked up, which is how a new customer would vanish', async () => {
    const fresh = (
      await worker()((tx) =>
        rows<{ id: string }>(
          tx,
          sql`insert into app.conversations (workspace_id, channel, counterpart)
              values (${ws}, 'sms', ${randomE164()}) returning id`,
        ),
      )
    )[0]!.id;
    for (const u of [dale, marco]) {
      const seen = await as(u)((tx) =>
        rows<{ id: string }>(tx, sql`select id from app.conversations where id = ${fresh}`),
      );
      expect(seen).toHaveLength(1);
    }
    await inStep();
  });

  it('carries messages along with their thread', async () => {
    const dalesMessages = await as(dale)((tx) =>
      rows<{ conversation_id: string }>(
        tx,
        sql`select conversation_id from app.messages where workspace_id = ${ws}`,
      ),
    );
    expect(dalesMessages.map((m) => m.conversation_id).sort()).toEqual(
      [assignedDale, nobodys].sort(),
    );
  });

  it('follows a thread when it changes hands', async () => {
    await worker()((tx) =>
      rows(
        tx,
        sql`update app.conversations set assignee_user_id = ${dale.id} where id = ${assignedMarco}`,
      ),
    );
    expect(await visibleTo(dale)).toContain('marco');
    expect(await visibleTo(marco)).not.toContain('marco');
    // And the message on it went with it, or the thread would be hidden and its words would not.
    const stillMarcos = await as(marco)((tx) =>
      rows<{ id: string }>(
        tx,
        sql`select id from app.messages where conversation_id = ${assignedMarco}`,
      ),
    );
    expect(stillMarcos).toHaveLength(0);
    await inStep();
    // Put it back, so the tests after this read the world the others describe.
    await worker()((tx) =>
      rows(
        tx,
        sql`update app.conversations set assignee_user_id = ${marco.id} where id = ${assignedMarco}`,
      ),
    );
  });

  it('follows a number when its people change', async () => {
    await worker()((tx) =>
      rows(
        tx,
        sql`insert into app.phone_number_members (workspace_id, phone_number_id, user_id)
            values (${ws}, ${numberId}, ${dale.id})`,
      ),
    );
    expect(await visibleTo(dale)).toContain('marcos-number');
    await inStep();
    await worker()((tx) =>
      rows(
        tx,
        sql`delete from app.phone_number_members where phone_number_id = ${numberId} and user_id = ${dale.id}`,
      ),
    );
    expect(await visibleTo(dale)).not.toContain('marcos-number');
    await inStep();
  });

  it('tells each phone whether it may have the whole inbox', async () => {
    const access = await rows<{ user_id: string; sees_whole_inbox: boolean }>(
      admin$,
      sql`select user_id, sees_whole_inbox from app.workspace_access where workspace_id = ${ws}`,
    );
    const by = new Map(access.map((r) => [r.user_id, r.sees_whole_inbox]));
    expect(by.get(owner.id)).toBe(true);
    expect(by.get(admin.id)).toBe(true);
    expect(by.get(dale.id)).toBe(false);
    expect(by.get(marco.id)).toBe(false);
    await inStep();
  });

  it('puts a new member on every thread nobody owns, and on none of the others', async () => {
    const jo = await createTestUser('inbox-jo');
    await admin$
      .insert(workspaceMemberships)
      .values([{ workspaceId: ws, userId: jo.id, role: 'member' }]);
    expect(await visibleTo(jo)).toEqual(['nobodys']);
    await inStep();
  });

  it('carries the AI teammate’s drafts and runs, and what was read off a thread, along with it', async () => {
    const one = async <T extends Record<string, unknown>>(q: ReturnType<typeof sql>) =>
      (await rows<T>(admin$, q))[0]!;
    const { id: teammate } = await one<{ id: string }>(
      sql`insert into app.ai_teammates (workspace_id, name) values (${ws}, 'Ava') returning id`,
    );
    const { id: person } = await one<{ id: string }>(
      sql`insert into app.people (workspace_id, first_name) values (${ws}, 'Pat') returning id`,
    );
    const { id: run } = await one<{ id: string }>(
      sql`insert into app.ai_teammate_runs (workspace_id, teammate_id, conversation_id, triggered_by)
          values (${ws}, ${teammate}, ${assignedDale}, 'message.received') returning id`,
    );
    await rows(
      admin$,
      sql`insert into app.ai_teammate_tool_calls (workspace_id, run_id, provider_call_id, tool, arguments)
          values (${ws}, ${run}, 'toolu_01', 'find_times', '{}')`,
    );
    const { id: draft } = await one<{ id: string }>(
      sql`insert into app.ai_teammate_drafts (workspace_id, teammate_id, run_id, conversation_id, kind, client_id)
          values (${ws}, ${teammate}, ${run}, ${assignedDale}, 'reply', 'inbox-visibility') returning id`,
    );
    const { id: message } = await one<{ id: string }>(
      sql`insert into app.messages (workspace_id, conversation_id, channel, direction, status, body_text, occurred_at, media)
          values (${ws}, ${assignedDale}, 'sms', 'inbound', 'received', 'See attached', now(),
            ${JSON.stringify([{ bucket: 'telephony', objectPath: `${ws}/email/abc/0-quote.pdf` }])}::jsonb)
          returning id`,
    );
    await rows(
      admin$,
      sql`insert into app.promises (workspace_id, person_id, conversation_id, message_id, what, due_at)
          values (${ws}, ${person}, ${assignedDale}, ${message}, 'send the quote', now())`,
    );
    await rows(
      admin$,
      sql`insert into app.referrals (workspace_id, referrer_person_id, conversation_id, message_id, quote)
          values (${ws}, ${person}, ${assignedDale}, ${message}, 'My neighbour needs one too')`,
    );
    const reads = (u: TestUser) =>
      as(u)(async (tx) => {
        const n = async (table: string) =>
          (
            await rows<{ n: number }>(
              tx,
              sql`select count(*)::int as n from ${sql.raw(`app.${table}`)} where workspace_id = ${ws}`,
            )
          )[0]!.n;
        const file = async (path: string) =>
          (
            await rows<{ ok: boolean }>(
              tx,
              sql`select private.storage_read_allowed('telephony', ${path}) as ok`,
            )
          )[0]!.ok;
        return {
          drafts: await n('ai_teammate_drafts'),
          runs: await n('ai_teammate_runs'),
          toolCalls: await n('ai_teammate_tool_calls'),
          promises: await n('promises'),
          referrals: await n('referrals'),
          photo: await file(`${ws}/messages/${message}/0.jpg`),
          attachment: await file(`${ws}/email/abc/0-quote.pdf`),
        };
      });
    const all = {
      drafts: 1,
      runs: 1,
      toolCalls: 1,
      promises: 1,
      referrals: 1,
      photo: true,
      attachment: true,
    };
    expect(await reads(dale)).toEqual(all);
    expect(await reads(owner)).toEqual(all);
    expect(await reads(marco)).toEqual({
      drafts: 0,
      runs: 0,
      toolCalls: 0,
      promises: 0,
      referrals: 0,
      photo: false,
      attachment: false,
    });
    // Nor may he decide the draft he cannot see.
    const decided = await as(marco)((tx) =>
      rows(
        tx,
        sql`update app.ai_teammate_drafts set status = 'approved', decided_by = ${marco.id}, decided_at = now(), via = 'web'
            where id = ${draft} returning id`,
      ),
    );
    expect(decided).toHaveLength(0);
    // The draft moves with its thread, like a message.
    await worker()((tx) =>
      rows(
        tx,
        sql`update app.conversations set assignee_user_id = ${marco.id} where id = ${assignedDale}`,
      ),
    );
    expect((await reads(marco)).drafts).toBe(1);
    expect((await reads(dale)).drafts).toBe(0);
    await worker()((tx) =>
      rows(
        tx,
        sql`update app.conversations set assignee_user_id = ${dale.id} where id = ${assignedDale}`,
      ),
    );
    await inStep();
  });

  it('leaves the customer timeline alone, on purpose', async () => {
    // app.activities is deliberately not narrowed: a member who can open a customer still sees that
    // customer's history. 0083's header says so; this is the test that would notice it changing.
    const before = await as(dale)((tx) =>
      rows<{ n: number }>(
        tx,
        sql`select count(*)::int as n from app.activities where workspace_id = ${ws}`,
      ),
    );
    const after = await as(marco)((tx) =>
      rows<{ n: number }>(
        tx,
        sql`select count(*)::int as n from app.activities where workspace_id = ${ws}`,
      ),
    );
    expect(before[0]!.n).toBe(after[0]!.n);
  });
});

describe('off again', () => {
  beforeAll(async () => {
    await setPerPerson(false);
    await repaint();
  });

  it('gives everybody everything back', async () => {
    for (const u of [owner, admin, dale, marco])
      expect(await visibleTo(u)).toEqual(['dale', 'marco', 'marcos-number', 'nobodys']);
  });

  it('empties every list and every phone’s flag again', async () => {
    const lists = await rows<{ member_viewer_ids: string[] }>(
      admin$,
      sql`select member_viewer_ids from app.conversations where workspace_id = ${ws}`,
    );
    expect(lists.every((r) => r.member_viewer_ids.length === 0)).toBe(true);
    const access = await rows<{ sees_whole_inbox: boolean }>(
      admin$,
      sql`select sees_whole_inbox from app.workspace_access where workspace_id = ${ws}`,
    );
    expect(access.every((r) => r.sees_whole_inbox)).toBe(true);
    await inStep();
  });
});
