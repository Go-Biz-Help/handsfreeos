/**
 * Social Outreach on the phone (docs/outreach.md, decision 44): each person's messages waiting for their OK reach
 * their phone alone, through records_v1's sealed arm, and leave it once OK'd, skipped or sent. The phone reads them
 * as `outreach.waiting` lists them, OKs and skips them with no signal, and Approve all passes over any handled
 * elsewhere meanwhile. An OK that waited asks "Still send?" after 30 minutes; a skip goes whenever, but never undoes
 * an OK given after it was pressed, and an OK that waited never brings back a message skipped since. A comment
 * waiting (decision 92) is copied as a message is, its words alone.
 */
import { randomUUID } from 'node:crypto';
import { asUser, rows, sql } from '@hfos/db/client';
import { workspaceMemberships } from '@hfos/db/schema';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { manifestIssues, type AddonOfflineTable } from '../../src/addons/manifest';
import { outreachAddon } from '../../src/addons/outreach/manifest';
import {
  approveAllFromPhone,
  waitingOfCopy,
  type PhoneWaiting,
} from '../../src/addons/outreach/views/waiting';
import type { SyncedPhoneRow } from '../../src/addons/phone-rows';
import type { RequestMeta } from '../../src/server';
import { outreachBusiness, refused, runAs, runWith, setOutreach } from './outreach-fixture';
import { cells } from './realestate-phone-fixture';

const admin = () => testDbs().admin.db;
const api = () => testDbs().api.db;
const MIN = 60_000;
const HOUR = 60 * MIN;

let owner: TestUser;
let member: TestUser;
let ws: string;
let dana: string;
let riley: string;

beforeAll(async () => {
  [owner, member] = await Promise.all([
    createTestUser('outp-owner', { fullName: 'Morgan Owner' }),
    createTestUser('outp-member', { fullName: 'Riley Member' }),
  ]);
  ws = await outreachBusiness(owner, 'Outreach Phone Co');
  await admin()
    .insert(workspaceMemberships)
    .values({ workspaceId: ws, userId: member.id, role: 'member' });
  const profile = async (username: string, name: string) =>
    (
      await rows<{ id: string }>(
        admin(),
        sql`insert into addon_outreach.profiles (workspace_id, platform, username, url, name)
            values (${ws}, 'facebook', ${username}, ${`https://www.facebook.com/${username}`}, ${name})
            returning id`,
      )
    )[0]!.id;
  dana = await profile('dana.reyes.7', 'Dana Reyes');
  riley = await profile('sam.lee.3', 'Sam Lee');
}, 60_000);
afterAll(closeTestDbs);

/** A message the extension drafted for `u`, waiting for their OK, made `ago` ms before now. */
async function drafted(
  u: TestUser,
  profileId: string,
  text: string,
  over: {
    ago?: number;
    handedOver?: boolean;
    needsYou?: string | null;
    kind?: string;
    postId?: string;
  } = {},
): Promise<string> {
  const at = new Date(Date.now() - (over.ago ?? 0));
  const [row] = await rows<{ id: string }>(
    admin(),
    sql`insert into addon_outreach.sends
          (workspace_id, user_id, profile_id, kind, post_id, text, drafted, handed_over, needs_you, created_at,
           updated_at)
        values (${ws}, ${u.id}, ${profileId}, ${over.kind ?? 'opener'}, ${over.postId ?? null}, ${text}, ${text},
                ${over.handedOver ?? false}, ${over.needsYou ?? null}, ${at.toISOString()}::timestamptz,
                ${at.toISOString()}::timestamptz)
        returning id`,
  );
  return row!.id;
}

/**
 * The rows of Social Outreach records_v1 sends `u` (apps/sync/sync-config.yaml), by their keys and the seals as
 * PowerSync filters them: the open arm, the `all` arm and the sealed arm.
 */
async function phoneRows(u: TestUser): Promise<SyncedPhoneRow[]> {
  const keys = await rows<{ kind: string; key: string }>(
    admin(),
    sql`select kind, key from app.sync_keys where user_id = ${u.id} and workspace_id = ${ws}`,
  );
  const list = (kind: string) =>
    `{${keys
      .filter((k) => k.kind === kind)
      .map((k) => `"${k.key}"`)
      .join(',')}}`;
  return cells(
    await rows(
      admin(),
      sql`select p.id, p.source, p.record_id, p.data from app.addon_phone_rows p
          where p.workspace_id = ${ws} and p.addon_id = 'outreach'
            and ((p.seal_scope = any(${list('use')}::text[]) and p.seal_open)
              or p.seal_all = any(${list('all')}::text[])
              or (p.seal_scope = any(${list('use')}::text[]) and ${u.id}::uuid = any(p.seal_viewer_ids)))
            and p.sync_window`,
    ),
  ) as unknown as SyncedPhoneRow[];
}
const phoneWaiting = async (u: TestUser): Promise<PhoneWaiting> =>
  waitingOfCopy(await phoneRows(u), u.id);
const ids = (w: PhoneWaiting) => [...w.replies, ...w.messages].map((s) => s.sendId);

/** A change made on the phone at `occurredAt`, sent now, as the phone's queue sends it. */
const phone = (
  u: TestUser,
  name: string,
  input: Record<string, unknown>,
  occurredAt = new Date(),
  confirmedAt: Date | null = null,
) =>
  runWith(u, ws, name, input, {
    channel: 'mobile',
    commandId: randomUUID(),
    occurredAt,
    sentAt: new Date(),
    confirmedAt,
    appVersion: '1.0.0',
  } as Partial<RequestMeta> & Pick<RequestMeta, 'channel'>);

const stateOf = async (sendId: string) =>
  (
    await rows<{ state: string }>(
      admin(),
      sql`select state from addon_outreach.sends where id = ${sendId}`,
    )
  )[0]!.state;

describe('Social Outreach on the phone', () => {
  it('keeps on phones exactly what the manifest’s offline says', async () => {
    expect(manifestIssues(outreachAddon)).toEqual([]);
    const [addon] = await rows<{ permission: string }>(
      admin(),
      sql`select permission from app.addon_phone_addons where addon_id = 'outreach'`,
    );
    expect(addon?.permission).toBe(outreachAddon.offline?.permission);
    const registered = await rows(
      admin(),
      sql`select source, key_column, record_column, columns, reach, owner_column, keep_column, keep_values
          from app.addon_phone_tables where addon_id = 'outreach' order by source collate "C"`,
    );
    expect(registered).toEqual(
      ((outreachAddon.offline?.tables ?? []) as readonly AddonOfflineTable[]).map((t) => ({
        source: t.table,
        key_column: t.key ?? 'id',
        record_column: t.record ?? null,
        columns: [...t.columns],
        reach: t.reach ?? 'team',
        owner_column: t.owner ?? null,
        keep_column: t.keep?.column ?? null,
        keep_values: t.keep ? [...t.keep.values] : null,
      })),
    );
    const [open] = await rows<{ n: number }>(
      admin(),
      sql`select count(*)::int as n from app.addon_phone_rows where addon_id = 'outreach' and seal_open`,
    );
    expect(open!.n).toBe(0);
  });

  it('sends each person’s waiting messages to their phone alone, as Waiting for you lists them', async () => {
    const a = await drafted(owner, dana, 'Hi Dana! How do you keep track of customers?', {
      ago: 3 * HOUR,
    });
    const b = await drafted(owner, riley, 'Hi Sam!', { ago: 2 * HOUR });
    const reply = await drafted(owner, riley, 'Sorry to hear that, Sam.', {
      ago: HOUR,
      kind: 'reply',
      handedOver: true,
      needsYou: 'they sound upset',
    });
    const theirs = await drafted(member, dana, 'Hi Dana, it’s Riley.');

    const mine = await phoneWaiting(owner);
    expect(ids(mine)).toEqual([reply, a, b]);
    expect(mine.messages[0]).toMatchObject({
      name: 'Dana Reyes',
      profileUrl: 'https://www.facebook.com/dana.reyes.7',
      text: 'Hi Dana! How do you keep track of customers?',
    });
    expect(ids(await phoneWaiting(member))).toEqual([theirs]);
    // Not even an owner's phone holds someone else's.
    expect((await phoneRows(owner)).map((r) => r.id)).not.toContain(`sends:${theirs}`);

    // The phone reads what the server's list says of the messages.
    const server = await runAs(owner, ws, 'outreach.waiting', {});
    const listed = (server.items as { kind: string; send?: { sendId: string } }[])
      .filter((i) => i.kind === 'reply' || i.kind === 'message')
      .map((i) => i.send!.sendId);
    expect(ids(mine)).toEqual(listed);
    expect(mine.kinds.reply.count).toBe(server.kinds.reply.count);
    expect(mine.kinds.message.count).toBe(server.kinds.message.count);
    expect(approveAllFromPhone(mine)).toEqual([{ sendId: a }, { sendId: b }]);

    // Row security agrees: the member can't read the owner's row of the copy.
    const seen = await asUser(api(), member.claims, (tx) =>
      rows<{ id: string }>(
        tx,
        sql`select id from app.addon_phone_rows where workspace_id = ${ws} and addon_id = 'outreach'`,
      ),
    );
    expect(seen.map((r) => r.id)).toEqual([`sends:${theirs}`]);

    // Who it's to follows a rename.
    await rows(
      admin(),
      sql`update addon_outreach.profiles set name = 'Dana R. Reyes' where id = ${dana}`,
    );
    expect((await phoneWaiting(owner)).messages[0]!.name).toBe('Dana R. Reyes');
    await rows(
      admin(),
      sql`update addon_outreach.profiles set name = 'Dana Reyes' where id = ${dana}`,
    );

    // OK'd, skipped or sent, it leaves the phone.
    await phone(owner, 'outreach.send.approve', { sends: [{ sendId: a }] });
    await phone(owner, 'outreach.send.skip', { sendId: b });
    expect(ids(await phoneWaiting(owner))).toEqual([reply]);
    await runAs(owner, ws, 'outreach.send.done', { sendId: a, sent: true });
    const left = await rows(
      admin(),
      sql`select id from app.addon_phone_rows where id in (${`sends:${a}`}, ${`sends:${b}`})`,
    );
    expect(left).toEqual([]);
    await phone(owner, 'outreach.send.skip', { sendId: reply });
    await phone(member, 'outreach.send.skip', { sendId: theirs });
  });

  it('copies a comment waiting as a message, its words alone, and skipping it there sets its post aside', async () => {
    // A good post of Dana's the person's computer found (decision 92), and the comment drafted for it.
    const [post] = await rows<{ id: string }>(
      admin(),
      sql`insert into addon_outreach.posts (workspace_id, user_id, profile_id, url, body, found, check_state, seen_at)
          values (${ws}, ${owner.id}, ${dana}, 'https://www.facebook.com/groups/1/posts/2/',
                  'Can anyone recommend a simple CRM?', 'search', 'good', now())
          returning id`,
    );
    const message = await drafted(owner, riley, 'Hi Sam!', { ago: HOUR });
    const comment = await drafted(owner, dana, 'We keep every call in one shared list.', {
      kind: 'comment',
      postId: post!.id,
    });
    const mine = await phoneWaiting(owner);
    expect(ids(mine)).toEqual([message, comment]);
    expect(mine.messages[1]).toMatchObject({
      kind: 'comment',
      name: 'Dana Reyes',
      text: 'We keep every call in one shared list.',
    });
    // The server lists it with its post, as a message to OK; the phone counts it the same.
    const server = await runAs(owner, ws, 'outreach.waiting', {});
    const listed = (
      server.items as { kind: string; send?: { sendId: string; post: string | null } }[]
    ).filter((i) => i.kind === 'message');
    expect(listed.map((i) => i.send!.sendId)).toEqual(ids(mine));
    expect(listed[1]!.send!.post).toBe('Can anyone recommend a simple CRM?');
    expect(mine.kinds.message.count).toBe(server.kinds.message.count);
    expect(approveAllFromPhone(mine)).toEqual([{ sendId: message }, { sendId: comment }]);
    // Skipped on the phone: it leaves, and its post isn't drafted again.
    await phone(owner, 'outreach.send.skip', { sendId: comment });
    expect(ids(await phoneWaiting(owner))).toEqual([message]);
    const [aside] = await rows<{ aside: boolean }>(
      admin(),
      sql`select skipped_at is not null as aside from addon_outreach.posts where id = ${post!.id}`,
    );
    expect(aside!.aside).toBe(true);
    await phone(owner, 'outreach.send.skip', { sendId: message });
  });

  it('passes over, with Approve all from the phone, a message handled elsewhere meanwhile', async () => {
    const a = await drafted(owner, dana, 'Hi Dana!');
    const b = await drafted(owner, riley, 'Hi Sam!');
    const shown = approveAllFromPhone(await phoneWaiting(owner));
    expect(shown).toEqual([{ sendId: a }, { sendId: b }]);
    // Skipped on the web before the phone's Approve all got there.
    await runAs(owner, ws, 'outreach.send.skip', { sendId: b });
    expect(await refused(phone(owner, 'outreach.send.approve', { sends: shown }))).toBe(
      'not_found',
    );
    const ok = await phone(owner, 'outreach.send.approve', { sends: shown, partial: true });
    expect(ok.approved).toEqual([a]);
    expect(await stateOf(b)).toBe('skipped');
    await runAs(owner, ws, 'outreach.send.done', { sendId: a, sent: true });
  });

  it('asks “Still send?” of an OK that waited past 30 minutes, and a skip goes whenever', async () => {
    const a = await drafted(owner, dana, 'Hi Dana!');
    const b = await drafted(owner, riley, 'Hi Sam!');
    const pressed = new Date(Date.now() - 45 * MIN);
    expect(
      await refused(phone(owner, 'outreach.send.approve', { sends: [{ sendId: a }] }, pressed)),
    ).toBe('stale_action');
    expect(await stateOf(a)).toBe('waiting');
    const ok = await phone(
      owner,
      'outreach.send.approve',
      { sends: [{ sendId: a }] },
      pressed,
      new Date(),
    );
    expect(ok.approved).toEqual([a]);
    // A skip reaches nobody: three hours late, it still goes.
    await phone(owner, 'outreach.send.skip', { sendId: b }, new Date(Date.now() - 3 * HOUR));
    expect(await stateOf(b)).toBe('skipped');
    await runAs(owner, ws, 'outreach.send.done', { sendId: a, sent: true });
  });

  it('never lets a skip that waited undo a newer OK, nor an OK that waited bring back a skip', async () => {
    // Skipped on the phone at T with no signal; OK'd on the web an hour later; the skip arrives two hours after T.
    const a = await drafted(owner, dana, 'Hi Dana!', { ago: 3 * HOUR });
    const skippedAt = new Date(Date.now() - 2 * HOUR);
    await runAs(owner, ws, 'outreach.send.approve', { sends: [{ sendId: a }] });
    expect(await refused(phone(owner, 'outreach.send.skip', { sendId: a }, skippedAt))).toBe(
      'outreach_send_okd_since',
    );
    expect(await stateOf(a)).toBe('approved');
    // A skip pressed after the OK still takes it back before it goes.
    await phone(owner, 'outreach.send.skip', { sendId: a });
    expect(await stateOf(a)).toBe('skipped');

    // OK'd on the phone with no signal; skipped on the web meanwhile: the OK finds nothing waiting.
    const b = await drafted(owner, riley, 'Hi Sam!');
    const okdAt = new Date(Date.now() - 10 * MIN);
    await runAs(owner, ws, 'outreach.send.skip', { sendId: b });
    expect(
      await refused(phone(owner, 'outreach.send.approve', { sends: [{ sendId: b }] }, okdAt)),
    ).toBe('not_found');
    const partial = await phone(
      owner,
      'outreach.send.approve',
      { sends: [{ sendId: b }], partial: true },
      okdAt,
    );
    expect(partial.approved).toEqual([]);
    expect(await stateOf(b)).toBe('skipped');
  });

  it('leaves the phone when the add-on is turned off', async () => {
    const a = await drafted(owner, dana, 'Hi Dana!');
    expect(ids(await phoneWaiting(owner))).toContain(a);
    await setOutreach(ws, 'disabled');
    try {
      expect(ids(await phoneWaiting(owner))).toEqual([]);
    } finally {
      await setOutreach(ws, 'enabled');
    }
    expect(ids(await phoneWaiting(owner))).toContain(a);
    await runAs(owner, ws, 'outreach.send.skip', { sendId: a });
  });

  it('leaves nothing for the database’s own check to find', async () => {
    await drafted(owner, dana, 'Hi Dana!');
    expect(await rows(admin(), sql`select * from private.addon_phone_mismatches(${ws})`)).toEqual(
      [],
    );
  });
});
