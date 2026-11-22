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

/** Mail to someone's own address, filed by the worker: their own thread, one message, one attachment. */
async function ownMail(
  address: string,
  to: TestUser,
): Promise<{ conversation: string; message: string; file: string }> {
  const counterpart = `friend-${token()}@example.com`;
  const file = `${ws}/email/${token()}/0-letter.pdf`;
  return worker()(async (tx) => {
    const [c] = await rows<{ id: string }>(
      tx,
      sql`insert into app.conversations (workspace_id, channel, counterpart, email_address_id, private_to)
          values (${ws}, 'email', ${counterpart}, ${address}, ${to.id}) returning id`,
    );
    const [m] = await rows<{ id: string }>(
      tx,
      sql`insert into app.messages (workspace_id, conversation_id, channel, direction, status, email_address_id,
            subject, body_text, media)
          values (${ws}, ${c!.id}, 'email', 'inbound', 'received', ${address}, 'Just for you', 'Hello',
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
/** Mail to Chris's address: his own thread. */
const chrisMail = () => ownMail(chrisAddress, chris);

/** Who the phone's me_v1 stream sends a thread and its message to: their stored viewer lists. */
const listed = async (mail: { conversation: string; message: string }) => {
  const [l] = await rows<{ thread: string[]; message: string[] }>(
    dbs.admin.db,
    sql`select c.member_viewer_ids as thread, m.member_viewer_ids as message
        from app.conversations c join app.messages m on m.conversation_id = c.id
        where c.id = ${mail.conversation} and m.id = ${mail.message}`,
  );
  return l!;
};

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

/**
 * Changing addresses after setup (20261027033500): its own person hands an address back to the team, and one
 * address is removed on its own. Both check for themselves who is asking.
 */
describe('an address handed back, or removed', () => {
  let adminsAddress: string;
  let mail: { conversation: string; message: string; file: string };
  const handBack = (u: TestUser, address: string) =>
    as(u)((tx) => rows(tx, sql`select private.hand_back_email_address(${address}::uuid)`));
  const remove = (u: TestUser, address: string) =>
    as(u)((tx) =>
      rows<{ was: string | null; threads: number }>(
        tx,
        sql`select * from private.remove_email_address(${address}::uuid)`,
      ),
    );

  beforeAll(async () => {
    const [d] = await rows<{ id: string }>(
      dbs.admin.db,
      sql`select id from app.email_domains where domain = ${domain}`,
    );
    const [a] = await as(owner)((tx) =>
      rows<{ id: string }>(
        tx,
        sql`insert into app.email_addresses (workspace_id, email_domain_id, local_part, address, display_name,
              created_by, owner_user_id)
            values (${ws}, ${d!.id}, ${`a${token()}`}, '', 'Own Mail', ${owner.id}, ${admin.id}) returning id`,
      ),
    );
    adminsAddress = a!.id;
    mail = await ownMail(adminsAddress, admin);
  });

  it('goes back to the team only by its own person, whose old mail stays theirs', async () => {
    // Not someone who can't change email settings, not an owner for them, and not anyone outside the business.
    expect((await expectPgError(() => handBack(member, adminsAddress))).code).toBe('42501');
    expect((await expectPgError(() => handBack(owner, adminsAddress))).detail).toBe(
      'email_address_owner_is_theirs',
    );
    const outsider = await createTestUser('own-mail-elsewhere');
    expect((await expectPgError(() => handBack(outsider, adminsAddress))).detail).toBe(
      'no_email_address',
    );

    await handBack(admin, adminsAddress);
    const [after] = await rows<{ owner_user_id: string | null }>(
      dbs.admin.db,
      sql`select owner_user_id from app.email_addresses where id = ${adminsAddress}`,
    );
    expect(after!.owner_user_id).toBeNull();
    // The mail it carried as theirs is still theirs alone.
    expect(await sees(admin, mail)).toEqual({ thread: 1, message: 1, file: true });
    expect(await sees(owner, mail)).toEqual({ thread: 0, message: 0, file: false });
    // It's the team's now, so there is nothing left to hand back.
    expect((await expectPgError(() => handBack(admin, adminsAddress))).detail).toBe(
      'email_address_not_owned',
    );
  });

  it('is removed with its mail left where it is, and never the default or another person’s own', async () => {
    expect((await expectPgError(() => remove(member, adminsAddress))).code).toBe('42501');
    expect((await expectPgError(() => remove(owner, teamAddress))).detail).toBe(
      'email_default_required',
    );
    // Chris still works here, so his address is his to remove, and he can't change email settings.
    expect((await expectPgError(() => remove(owner, chrisAddress))).detail).toBe(
      'email_address_owner_is_theirs',
    );

    const [out] = await remove(owner, adminsAddress);
    expect(out).toEqual({ was: null, threads: 1 });
    expect(
      await rows(dbs.admin.db, sql`select 1 from app.email_addresses where id = ${adminsAddress}`),
    ).toEqual([]);
    // The thread and its message stay, still their person's alone, with no address on them.
    const [kept] = await rows<{ private_to: string | null; email_address_id: string | null }>(
      dbs.admin.db,
      sql`select private_to, email_address_id from app.conversations where id = ${mail.conversation}`,
    );
    expect(kept).toEqual({ private_to: admin.id, email_address_id: null });
    expect(await sees(admin, mail)).toEqual({ thread: 1, message: 1, file: true });
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
    // And no phone is sent it: me_v1 reads the lists alone, past RLS, so Chris is off them (CS2).
    expect(await listed(mail)).toEqual({ thread: [], message: [] });
    expect(
      await rows(dbs.admin.db, sql`select * from private.sync_inbox_mismatches(${ws})`),
    ).toEqual([]);
    expect((await expectPgError(() => reassign(admin, null, false))).detail).toBe(
      'email_address_reassign_owner',
    );
    // To another person: the mail goes with it.
    const [given] = await reassign(owner, member.id, false);
    expect(given).toMatchObject({ was: chris.id, threads: expect.any(Number) });
    expect(await sees(member, mail)).toEqual({ thread: 1, message: 1, file: true });
    expect(await sees(owner, mail)).toEqual({ thread: 0, message: 0, file: false });
    expect(await listed(mail)).toEqual({ thread: [member.id], message: [member.id] });
  });

  it('their mail stops reaching their phone, and comes back to them if they do', async () => {
    const dana = await createTestUser('own-mail-dana');
    await dbs.admin.db
      .insert(workspaceMemberships)
      .values({ workspaceId: ws, userId: dana.id, role: 'member' });
    const [d] = await rows<{ id: string }>(
      dbs.admin.db,
      sql`select id from app.email_domains where domain = ${domain}`,
    );
    const [a] = await as(owner)((tx) =>
      rows<{ id: string }>(
        tx,
        sql`insert into app.email_addresses (workspace_id, email_domain_id, local_part, address, display_name,
              created_by, owner_user_id)
            values (${ws}, ${d!.id}, ${`dana${token()}`}, '', 'Own Mail', ${owner.id}, ${dana.id}) returning id`,
      ),
    );
    const mail = await ownMail(a!.id, dana);
    expect(await listed(mail)).toEqual({ thread: [dana.id], message: [dana.id] });

    await dbs.admin.db.execute(
      sql`delete from app.workspace_memberships where workspace_id = ${ws} and user_id = ${dana.id}`,
    );
    expect(await listed(mail)).toEqual({ thread: [], message: [] });
    for (const u of [dana, owner])
      expect(await sees(u, mail)).toEqual({ thread: 0, message: 0, file: false });
    // Mail on the thread meanwhile is listed for nobody too.
    const [late] = await worker()((tx) =>
      rows<{ member_viewer_ids: string[] }>(
        tx,
        sql`insert into app.messages (workspace_id, conversation_id, channel, direction, status, email_address_id,
              subject, body_text)
            values (${ws}, ${mail.conversation}, 'email', 'inbound', 'received', ${a!.id}, 'Re', 'Still there?')
            returning member_viewer_ids`,
      ),
    );
    expect(late!.member_viewer_ids).toEqual([]);
    expect(
      await rows(dbs.admin.db, sql`select * from private.sync_inbox_mismatches(${ws})`),
    ).toEqual([]);

    // Back before an owner gave the address away: it is still theirs, and so is its mail.
    await dbs.admin.db
      .insert(workspaceMemberships)
      .values({ workspaceId: ws, userId: dana.id, role: 'member' });
    expect(await listed(mail)).toEqual({ thread: [dana.id], message: [dana.id] });
    expect(await sees(dana, mail)).toEqual({ thread: 1, message: 1, file: true });
    expect(await sees(owner, mail)).toEqual({ thread: 0, message: 0, file: false });
  });
});
