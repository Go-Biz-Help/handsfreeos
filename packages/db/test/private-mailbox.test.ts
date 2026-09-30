/**
 * A person's own mailbox (M19, step 3), in the database: its threads, messages and files are theirs alone —
 * not the members', not the admins', not the owners' — nobody else can unseal it, link it to a customer or send
 * from its address, and once its person has left, an owner decides what becomes of it.
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
  expectPgError,
  uniq,
  type TestUser,
} from './harness';

let owner: TestUser;
let admin: TestUser;
let member: TestUser;
let chris: TestUser;
let ws: string;
let org: string;
let domain: string;
let chrisAddress: string;
let teamAddress: string;

const worker = () => asService({ workspaceId: ws, organizationId: org });
const token = () =>
  uniq()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');

beforeAll(async () => {
  [owner, admin, member, chris] = await Promise.all([
    createTestUser('own-mail-owner'),
    createTestUser('own-mail-admin'),
    createTestUser('own-mail-member'),
    createTestUser('own-mail-chris'),
  ]);
  const a = await bootstrapOrganization(owner, 'Own Mail Org', 'Own Mail');
  ws = a.wsId;
  org = a.orgId;
  await dbs.admin.db.insert(workspaceMemberships).values([
    { workspaceId: ws, userId: admin.id, role: 'admin' },
    { workspaceId: ws, userId: member.id, role: 'member' },
    { workspaceId: ws, userId: chris.id, role: 'member' },
  ]);
  domain = `${token()}.example.com`;
  const [d] = await as(owner)((tx) =>
    rows<{ id: string }>(
      tx,
      sql`insert into app.email_domains (workspace_id, domain, created_by) values (${ws}, ${domain}, ${owner.id})
          returning id`,
    ),
  );
  await worker()((tx) =>
    rows(
      tx,
      sql`update app.email_domains set status = 'verified', receiving = 'on', ownership_proved_at = now() where id = ${d!.id}`,
    ),
  );
  const [c] = await as(owner)((tx) =>
    rows<{ id: string }>(
      tx,
      sql`insert into app.email_addresses (workspace_id, email_domain_id, local_part, address, display_name,
            created_by, owner_user_id)
          values (${ws}, ${d!.id}, 'chris', '', 'Own Mail', ${owner.id}, ${chris.id}) returning id`,
    ),
  );
  chrisAddress = c!.id;
  teamAddress = (
    await rows<{ id: string }>(
      dbs.admin.db,
      sql`select id from app.email_addresses where workspace_id = ${ws} and is_default`,
    )
  )[0]!.id;
});
afterAll(closeAll);

/** Mail to Chris's address, filed by the worker: his own thread, one message, one attachment. */
async function chrisMail(): Promise<{ conversation: string; message: string; file: string }> {
  const counterpart = `friend-${token()}@example.com`;
  const file = `${ws}/email/${token()}/0-letter.pdf`;
  return worker()(async (tx) => {
    const [c] = await rows<{ id: string }>(
      tx,
      sql`insert into app.conversations (workspace_id, channel, counterpart, email_address_id, private_to)
          values (${ws}, 'email', ${counterpart}, ${chrisAddress}, ${chris.id}) returning id`,
    );
    const [m] = await rows<{ id: string }>(
      tx,
      sql`insert into app.messages (workspace_id, conversation_id, channel, direction, status, email_address_id,
            subject, body_text, media)
          values (${ws}, ${c!.id}, 'email', 'inbound', 'received', ${chrisAddress}, 'Just for Chris', 'Hello Chris',
            ${JSON.stringify([
              {
                bucket: 'telephony',
                objectPath: file,
                contentType: 'application/pdf',
                sizeBytes: 10,
                name: 'letter.pdf',
              },
            ])}::jsonb)
          returning id`,
    );
    return { conversation: c!.id, message: m!.id, file };
  });
}

const sees = (u: TestUser, mail: { conversation: string; message: string; file: string }) =>
  as(u)(async (tx) => ({
    thread: (await rows(tx, sql`select 1 from app.conversations where id = ${mail.conversation}`))
      .length,
    message: (await rows(tx, sql`select 1 from app.messages where id = ${mail.message}`)).length,
    file: (
      await rows<{ ok: boolean }>(
        tx,
        sql`select private.storage_read_allowed('telephony', ${mail.file}) as ok`,
      )
    )[0]!.ok,
  }));

describe('a person’s own mail', () => {
  it('is theirs alone: its thread, its messages and its files, whoever else runs the business', async () => {
    const mail = await chrisMail();
    expect(await sees(chris, mail)).toEqual({ thread: 1, message: 1, file: true });
    for (const u of [owner, admin, member])
      expect(await sees(u, mail)).toEqual({ thread: 0, message: 0, file: false });
    const [kept] = await rows<{ private_to: string; viewers: string[] }>(
      dbs.admin.db,
      sql`select m.private_to, c.member_viewer_ids as viewers
          from app.messages m join app.conversations c on c.id = m.conversation_id where m.id = ${mail.message}`,
    );
    expect(kept).toEqual({ private_to: chris.id, viewers: [chris.id] });
    // A team file is still the team's.
    const teamFile = `${ws}/email/${token()}/0-quote.pdf`;
    const read = await as(owner)((tx) =>
      rows<{ ok: boolean }>(
        tx,
        sql`select private.storage_read_allowed('telephony', ${teamFile}) as ok`,
      ),
    );
    expect(read[0]!.ok).toBe(true);
    // The stored viewer lists and the policies still agree.
    expect(
      await rows(dbs.admin.db, sql`select * from private.sync_inbox_mismatches(${ws})`),
    ).toEqual([]);
  });

  it('is unsealed by its person alone, and only by sharing it with the team', async () => {
    const mail = await chrisMail();
    // An owner can't reach it to change it, nor start a thread private to someone else.
    const opened = await as(owner)((tx) =>
      rows(
        tx,
        sql`update app.conversations set private_to = null where id = ${mail.conversation} returning id`,
      ),
    );
    expect(opened).toHaveLength(0);
    const planted = await expectPgError(() =>
      as(admin)((tx) =>
        rows(
          tx,
          sql`insert into app.conversations (workspace_id, channel, counterpart, private_to, created_by)
              values (${ws}, 'email', ${`x-${token()}@example.com`}, ${chris.id}, ${admin.id})`,
        ),
      ),
    );
    expect(planted.code).toBe('42501');
    // Its person can't hand it to someone else either — only share it.
    const handed = await expectPgError(() =>
      as(chris)((tx) =>
        rows(
          tx,
          sql`update app.conversations set private_to = ${owner.id} where id = ${mail.conversation}`,
        ),
      ),
    );
    expect(handed.code).toBe('42501');
    await as(chris)((tx) =>
      rows(tx, sql`update app.conversations set private_to = null where id = ${mail.conversation}`),
    );
    expect(await sees(owner, mail)).toEqual({ thread: 1, message: 1, file: true });
    expect(
      await rows(dbs.admin.db, sql`select * from private.sync_inbox_mismatches(${ws})`),
    ).toEqual([]);
  });

  it('is never linked to a customer while it is private', async () => {
    const mail = await chrisMail();
    const [person] = await rows<{ id: string }>(
      dbs.admin.db,
      sql`insert into app.people (workspace_id, first_name) values (${ws}, 'Friend') returning id`,
    );
    const linked = await expectPgError(() =>
      worker()((tx) =>
        rows(
          tx,
          sql`update app.conversations set person_id = ${person!.id} where id = ${mail.conversation}`,
        ),
      ),
    );
    expect(linked.code).toBe('23514');
  });
});

describe('a person’s own address', () => {
  it('sends only for its person: not a teammate, and not HandsFreeOS itself', async () => {
    const [team] = await worker()((tx) =>
      rows<{ id: string }>(
        tx,
        sql`insert into app.conversations (workspace_id, channel, counterpart, email_address_id)
            values (${ws}, 'email', ${`team-${token()}@example.com`}, ${teamAddress}) returning id`,
      ),
    );
    const send = (u: TestUser, conversation: string) =>
      as(u)((tx) =>
        rows(
          tx,
          sql`insert into app.messages (workspace_id, conversation_id, channel, direction, status, email_address_id,
                subject, body_text, sent_by)
              values (${ws}, ${conversation}, 'email', 'outbound', 'queued', ${chrisAddress}, 'Hi', 'Hi', ${u.id})`,
        ),
      );
    expect((await expectPgError(() => send(member, team!.id))).detail).toBe(
      'email_address_private',
    );
    const asSystem = await expectPgError(() =>
      worker()((tx) =>
        rows(
          tx,
          sql`insert into app.messages (workspace_id, conversation_id, channel, direction, status, email_address_id,
                subject, body_text)
              values (${ws}, ${team!.id}, 'email', 'outbound', 'queued', ${chrisAddress}, 'Hi', 'Hi')`,
        ),
      ),
    );
    expect(asSystem.detail).toBe('email_address_private');
    const mail = await chrisMail();
    await send(chris, mail.conversation);
  });

  it('is given by an admin, but taken from its person by no one while they work here', async () => {
    const guarded = await expectPgError(() =>
      as(admin)((tx) =>
        rows(
          tx,
          sql`update app.email_addresses set owner_user_id = ${admin.id} where id = ${chrisAddress}`,
        ),
      ),
    );
    expect(guarded.detail).toBe('email_address_owner_is_theirs');
    const outsider = await createTestUser('own-mail-outsider');
    const [d] = await rows<{ id: string }>(
      dbs.admin.db,
      sql`select id from app.email_domains where domain = ${domain}`,
    );
    const stranger = await expectPgError(() =>
      as(admin)((tx) =>
        rows(
          tx,
          sql`insert into app.email_addresses (workspace_id, email_domain_id, local_part, address, display_name,
                created_by, owner_user_id)
              values (${ws}, ${d!.id}, ${`x${token()}`}, '', 'Own Mail', ${admin.id}, ${outsider.id})`,
        ),
      ),
    );
    expect(stranger.detail).toBe('email_address_owner_not_here');
    // Never the default: the business's default is the team's.
    const asDefault = await expectPgError(() =>
      dbs.admin.db.execute(
        sql`update app.email_addresses set is_default = true where id = ${chrisAddress}`,
      ),
    );
    expect(asDefault.code).toBe('23514');
  });
});

describe('when its person leaves', () => {
  it('mail to their address goes to the team, and an owner decides what becomes of it', async () => {
    const mail = await chrisMail();
    const route = () =>
      asService({})((tx) =>
        rows<{ email_address_id: string }>(
          tx,
          sql`select email_address_id from private.email_receiving_route(${`chris@${domain}`})`,
        ),
      );
    expect((await route())[0]!.email_address_id).toBe(chrisAddress);
    const reassign = (u: TestUser, to: string | null, remove: boolean) =>
      as(u)((tx) =>
        rows<{ was: string; threads: number; media: unknown[] }>(
          tx,
          sql`select * from private.reassign_email_address(${chrisAddress}::uuid, ${to}::uuid, ${remove})`,
        ),
      );
    expect((await expectPgError(() => reassign(owner, null, false))).detail).toBe(
      'email_address_owner_still_here',
    );

    await dbs.admin.db.execute(
      sql`delete from app.workspace_memberships where workspace_id = ${ws} and user_id = ${chris.id}`,
    );
    expect((await route())[0]!.email_address_id).toBe(teamAddress);
    // Nobody reads it meanwhile, not even an owner.
    expect(await sees(owner, mail)).toEqual({ thread: 0, message: 0, file: false });
    expect((await expectPgError(() => reassign(admin, null, false))).detail).toBe(
      'email_address_reassign_owner',
    );
    // To another person: the mail goes with it.
    const [given] = await reassign(owner, member.id, false);
    expect(given).toMatchObject({ was: chris.id, threads: expect.any(Number) });
    expect(await sees(member, mail)).toEqual({ thread: 1, message: 1, file: true });
    expect(await sees(owner, mail)).toEqual({ thread: 0, message: 0, file: false });
  });
});
