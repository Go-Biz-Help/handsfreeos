/**
 * 0058 and 0059: what the phone adds for people.
 *   - app.push_devices: a person's own devices only; a token is live for one person at a time, and signing in as
 *     someone else takes it over; people turn a device off only for themselves, stamped by the database; the worker
 *     reads and turns off the devices of the people in its scope. private.push_on reads the push switches
 *     (settings.push, a key of their own) with their defaults.
 *   - app.user_phones: a person's own cells; verification is the worker's; one verified cell per person.
 *   - possible_duplicate_of stays inside its business.
 *   - private.anonymize_user: scrubs the profile, removes memberships (and so access and money visibility), cells,
 *     devices, receipts and Assistant chats, disconnects the person's calendar, keeps their records, refuses a
 *     business's only owner, and a deleted account can't join a business again.
 */
import { randomUUID } from 'node:crypto';
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
  type TestUser,
} from './harness';

let dale: TestUser;
let marco: TestUser;
let stranger: TestUser;
let A: { ws: string; org: string };
let S: { ws: string; org: string };

const admin$ = dbs.admin.db;
const worker = (b: { ws: string; org: string }) =>
  asService({ workspaceId: b.ws, organizationId: b.org });
const token = () => `ExponentPushToken[${randomUUID().replaceAll('-', '').slice(0, 22)}]`;
const failure = async (fn: () => Promise<unknown>) => {
  const e = await expectPgError(fn);
  return { code: e.code, detail: e.detail };
};

beforeAll(async () => {
  [dale, marco, stranger] = await Promise.all([
    createTestUser('mobile-dale'),
    createTestUser('mobile-marco'),
    createTestUser('mobile-stranger'),
  ]);
  const a = await bootstrapOrganization(dale, 'Mobile Org', 'Mobile A');
  A = { ws: a.wsId, org: a.orgId };
  const s = await bootstrapOrganization(stranger, 'Mobile Other', 'Mobile S');
  S = { ws: s.wsId, org: s.orgId };
  await admin$
    .insert(workspaceMemberships)
    .values({ workspaceId: A.ws, userId: marco.id, role: 'member' });
});
afterAll(closeAll);

const register = (user: TestUser, expoToken: string) =>
  as(user)((tx) =>
    rows<{ id: string }>(
      tx,
      sql`insert into app.push_devices (user_id, platform, expo_push_token, app_version, device_name)
          values (${user.id}, 'ios', ${expoToken}, '1.0.0', 'Phone') returning id`,
    ),
  ).then((r) => r[0]!.id);

describe('app.push_devices', () => {
  it('are a person’s own', async () => {
    const t = token();
    const id = await register(marco, t);
    const seen = (user: TestUser) =>
      as(user)((tx) => rows(tx, sql`select id from app.push_devices where id = ${id}`)).then(
        (r) => r.length,
      );
    expect(await seen(marco)).toBe(1);
    expect(await seen(dale)).toBe(0);
    expect(
      (
        await expectPgError(() =>
          as(dale)((tx) =>
            tx.execute(
              sql`insert into app.push_devices (user_id, platform, expo_push_token, app_version) values (${marco.id}, 'ios', ${token()}, '1.0.0')`,
            ),
          ),
        )
      ).code,
    ).toBe('42501');
    expect((await expectPgError(() => register(marco, 'not-a-token'))).code).toBe('23514');
  });

  it('pass a token to whoever signs in on the phone, never to two people at once', async () => {
    const t = token();
    const marcos = await register(marco, t);
    expect((await expectPgError(() => register(stranger, t))).code).toBe('23505');
    const [released] = await as(stranger)((tx) =>
      rows<{ n: number }>(tx, sql`select private.release_push_token(${t}) as n`),
    );
    expect(released!.n).toBe(1);
    await register(stranger, t);
    const [old] = await rows<{ reason: string; off: boolean }>(
      admin$,
      sql`select disabled_reason as reason, disabled_at is not null as off from app.push_devices where id = ${marcos}`,
    );
    expect(old).toEqual({ reason: 'replaced', off: true });
    // Marco can't just turn his row back on while the stranger's is live.
    expect(
      (
        await expectPgError(() =>
          as(marco)((tx) =>
            tx.execute(
              sql`update app.push_devices set disabled_at = null, disabled_reason = null where id = ${marcos}`,
            ),
          ),
        )
      ).code,
    ).toBe('23505');
  });

  it('are turned off by people only for themselves, when the database says', async () => {
    const id = await register(marco, token());
    await as(marco)((tx) =>
      tx.execute(
        sql`update app.push_devices set disabled_at = '2001-01-01', disabled_reason = 'signed_out' where id = ${id}`,
      ),
    );
    const [row] = await rows<{ recent: boolean }>(
      admin$,
      sql`select disabled_at > now() - interval '1 minute' as recent from app.push_devices where id = ${id}`,
    );
    expect(row!.recent).toBe(true);
    const other = await register(marco, token());
    expect(
      await failure(() =>
        as(marco)((tx) =>
          tx.execute(
            sql`update app.push_devices set disabled_at = now(), disabled_reason = 'not_registered' where id = ${other}`,
          ),
        ),
      ),
    ).toEqual({ code: '42501', detail: 'push_device_reason' });
    // Nothing else about a device is theirs to change.
    expect(
      (
        await expectPgError(() =>
          as(marco)((tx) =>
            tx.execute(sql`update app.push_devices set user_id = ${dale.id} where id = ${other}`),
          ),
        )
      ).code,
    ).toBe('42501');
  });

  it('are read and turned off by the worker for the people of the business it is scoped to', async () => {
    const id = await register(marco, token());
    const inScope = await worker(A)((tx) =>
      rows(tx, sql`select id from app.push_devices where id = ${id}`),
    );
    expect(inScope).toHaveLength(1);
    const outOfScope = await worker(S)((tx) =>
      rows(tx, sql`select id from app.push_devices where id = ${id}`),
    );
    expect(outOfScope).toHaveLength(0);
    await worker(A)((tx) =>
      tx.execute(
        sql`update app.push_devices set disabled_at = now(), disabled_reason = 'not_registered' where id = ${id}`,
      ),
    );
    const [row] = await rows<{ reason: string }>(
      admin$,
      sql`select disabled_reason as reason from app.push_devices where id = ${id}`,
    );
    expect(row!.reason).toBe('not_registered');
  });
});

describe('private.push_on', () => {
  const on = async (settings: unknown, key: string) =>
    (
      await rows<{ on: boolean }>(
        admin$,
        sql`select private.push_on(${JSON.stringify(settings)}::jsonb, ${key}) as on`,
      )
    )[0]!.on;

  it('is on unless turned off, except payments, which are off until turned on', async () => {
    for (const key of ['customerWaiting', 'urgent', 'approval', 'booking', 'assigned', 'jobs'])
      expect(await on({}, key), key).toBe(true);
    expect(await on({}, 'payment')).toBe(false);
    const chosen = { push: { payment: true, urgent: false } };
    expect(await on(chosen, 'payment')).toBe(true);
    expect(await on(chosen, 'urgent')).toBe(false);
    expect(await on(chosen, 'booking')).toBe(true);
    expect(await on({ push: { booking: 'no' } }, 'booking')).toBe(true);
  });

  it('reads only the phone’s own key, and refuses a switch it doesn’t know', async () => {
    // The web saves settings.notifications whole, with its six email switches: they never touch these.
    expect(
      await on(
        { notifications: { bookingEmail: false, booking: false, payment: true } },
        'booking',
      ),
    ).toBe(true);
    expect(await on({ notifications: { payment: true } }, 'payment')).toBe(false);
    for (const key of ['bookingPush', 'bookingEmail', ''])
      expect(
        (
          await expectPgError(() =>
            rows(admin$, sql`select private.push_on('{}'::jsonb, ${key}) as on`),
          )
        ).detail,
        key,
      ).toBe('push_switch_unknown');
  });
});

describe('app.user_phones', () => {
  it('are a person’s own, and verified only by HandsFreeOS, one at a time', async () => {
    const [cell] = await as(marco)((tx) =>
      rows<{ id: string }>(
        tx,
        sql`insert into app.user_phones (user_id, e164) values (${marco.id}, '+15125550199') returning id`,
      ),
    );
    expect(
      await failure(() =>
        as(marco)((tx) =>
          tx.execute(
            sql`insert into app.user_phones (user_id, e164, verified_at) values (${marco.id}, '+15125550198', now())`,
          ),
        ),
      ),
    ).toEqual({ code: '42501', detail: 'user_phone_verification_protected' });
    expect(
      (
        await expectPgError(() =>
          as(marco)((tx) =>
            tx.execute(sql`update app.user_phones set verified_at = now() where id = ${cell!.id}`),
          ),
        )
      ).code,
    ).toBe('42501');
    expect(
      await as(dale)((tx) => rows(tx, sql`select id from app.user_phones where id = ${cell!.id}`)),
    ).toHaveLength(0);

    await worker(A)((tx) =>
      tx.execute(
        sql`update app.user_phones set verification_count = verification_count + 1, last_verification_at = now(), verified_at = now()
            where id = ${cell!.id}`,
      ),
    );
    const [second] = await as(marco)((tx) =>
      rows<{ id: string }>(
        tx,
        sql`insert into app.user_phones (user_id, e164) values (${marco.id}, '+15125550197') returning id`,
      ),
    );
    expect(
      (
        await expectPgError(() =>
          worker(A)((tx) =>
            tx.execute(
              sql`update app.user_phones set verified_at = now() where id = ${second!.id}`,
            ),
          ),
        )
      ).code,
    ).toBe('23505');
    await as(marco)((tx) => tx.execute(sql`delete from app.user_phones where id = ${second!.id}`));
  });
});

describe('possible_duplicate_of', () => {
  it('points at a record of the same business, never itself', async () => {
    const person = async (
      b: { ws: string; org: string },
      name: string,
      duplicateOf: string | null = null,
    ) =>
      (
        await worker(b)((tx) =>
          rows<{ id: string }>(
            tx,
            sql`insert into app.people (workspace_id, first_name, possible_duplicate_of) values (${b.ws}, ${name}, ${duplicateOf}) returning id`,
          ),
        )
      )[0]!.id;
    const maria = await person(A, 'Maria');
    const again = await person(A, 'Maria L', maria);
    expect(again).toBeTruthy();
    expect((await failure(() => person(S, 'Maria', maria))).detail).toBe(
      'record_workspace_mismatch',
    );
    expect(
      (
        await expectPgError(() =>
          worker(A)((tx) =>
            tx.execute(sql`update app.people set possible_duplicate_of = id where id = ${maria}`),
          ),
        )
      ).code,
    ).toBe('23514');
    const [company] = await worker(A)((tx) =>
      rows<{ id: string }>(
        tx,
        sql`insert into app.companies (workspace_id, name) values (${A.ws}, 'Lopez Dental') returning id`,
      ),
    );
    expect(
      (
        await failure(() =>
          worker(S)((tx) =>
            tx.execute(
              sql`insert into app.companies (workspace_id, name, possible_duplicate_of) values (${S.ws}, 'Lopez', ${company!.id})`,
            ),
          ),
        )
      ).detail,
    ).toBe('record_workspace_mismatch');
  });
});

describe('private.anonymize_user', () => {
  it('scrubs the person and what is theirs alone, keeps their records, and bars them from coming back', async () => {
    const leaver = await createTestUser('mobile-leaver', { fullName: 'Pat Leaver' });
    await admin$
      .insert(workspaceMemberships)
      .values({ workspaceId: A.ws, userId: leaver.id, role: 'member' });
    await register(leaver, token());
    await as(leaver)((tx) =>
      tx.execute(
        sql`insert into app.user_phones (user_id, e164) values (${leaver.id}, '+15125550191')`,
      ),
    );
    const commandId = randomUUID();
    await as(leaver)(async (tx) => {
      await tx.execute(
        sql`insert into app.command_receipts (user_id, command_id, workspace_id, command, input_hash, outcome, answer, occurred_at)
            values (${leaver.id}, ${commandId}, ${A.ws}, 'task.create', ${'d'.repeat(64)}, 'applied', '{}', now())`,
      );
    });
    const [task] = await as(leaver)((tx) =>
      rows<{ id: string }>(
        tx,
        sql`insert into app.tasks (workspace_id, title, created_by) values (${A.ws}, 'Order filters', ${leaver.id}) returning id`,
      ),
    );
    const connectionId = await worker(A)(async (tx) => {
      const [thread] = await rows<{ id: string }>(
        tx,
        sql`insert into app.assistant_threads (workspace_id, user_id, title) values (${A.ws}, ${leaver.id}, 'Private') returning id`,
      );
      expect(thread).toBeTruthy();
      const [c] = await rows<{ id: string }>(
        tx,
        sql`insert into app.calendar_connections (workspace_id, user_id, provider, status, token_enc, token_key_id, connected_at)
            values (${A.ws}, ${leaver.id}, 'google', 'active', 'sealed', 'k1', now()) returning id`,
      );
      await tx.execute(
        sql`insert into app.calendar_busy_blocks (workspace_id, connection_id, user_id, starts_at, ends_at)
            values (${A.ws}, ${c!.id}, ${leaver.id}, now() + interval '1 day', now() + interval '1 day 1 hour')`,
      );
      return c!.id;
    });

    await worker(A)((tx) => tx.execute(sql`select private.anonymize_user(${leaver.id})`));

    const [profile] = await rows<{
      full_name: string;
      email: string;
      avatar_url: string | null;
      settings: unknown;
      deleted: boolean;
      lists: string[];
    }>(
      admin$,
      sql`select full_name, email::text as email, avatar_url, settings, deleted_at is not null as deleted, member_workspace_ids::text[] as lists
          from app.users where id = ${leaver.id}`,
    );
    expect(profile).toMatchObject({
      full_name: 'Former teammate',
      avatar_url: null,
      settings: {},
      deleted: true,
      lists: [],
    });
    expect(profile!.email).toMatch(/^deleted-[0-9a-f]{32}@deleted\.handsfreeos\.invalid$/);
    const counts = await rows<Record<string, number>>(
      admin$,
      sql`select
            (select count(*)::int from app.workspace_memberships where user_id = ${leaver.id}) as memberships,
            (select count(*)::int from app.workspace_access where user_id = ${leaver.id}) as access,
            (select count(*)::int from app.push_devices where user_id = ${leaver.id}) as devices,
            (select count(*)::int from app.user_phones where user_id = ${leaver.id}) as cells,
            (select count(*)::int from app.command_receipts where user_id = ${leaver.id}) as receipts,
            (select count(*)::int from app.assistant_threads where user_id = ${leaver.id}) as chats,
            (select count(*)::int from app.calendar_busy_blocks where user_id = ${leaver.id}) as busy,
            (select count(*)::int from app.tasks where id = ${task!.id} and created_by = ${leaver.id}) as records`,
    );
    expect(counts[0]).toEqual({
      memberships: 0,
      access: 0,
      devices: 0,
      cells: 0,
      receipts: 0,
      chats: 0,
      busy: 0,
      records: 1,
    });
    const [connection] = await rows<{ status: string; token: string | null }>(
      admin$,
      sql`select status::text as status, token_enc as token from app.calendar_connections where id = ${connectionId}`,
    );
    expect(connection).toEqual({ status: 'disconnected', token: null });

    expect(
      await failure(() =>
        admin$
          .insert(workspaceMemberships)
          .values({ workspaceId: A.ws, userId: leaver.id, role: 'member' }),
      ),
    ).toEqual({ code: '42501', detail: 'account_deleted' });
    // Only the worker may run it.
    expect(
      (
        await expectPgError(() =>
          as(dale)((tx) => tx.execute(sql`select private.anonymize_user(${marco.id})`)),
        )
      ).code,
    ).toBe('42501');
  });

  it('refuses a business’s only owner, and changes nothing', async () => {
    const soleOwner = await createTestUser('mobile-sole-owner', { fullName: 'Sole Owner' });
    const own = await bootstrapOrganization(soleOwner, 'Sole Org', 'Sole Biz');
    const e = await expectPgError(() =>
      worker({ ws: own.wsId, org: own.orgId })((tx) =>
        tx.execute(sql`select private.anonymize_user(${soleOwner.id})`),
      ),
    );
    expect({ code: e.code, detail: e.detail }).toEqual({ code: '23514', detail: 'last_owner' });
    const [profile] = await rows<{ full_name: string; deleted: boolean; access: number }>(
      admin$,
      sql`select u.full_name, u.deleted_at is not null as deleted,
            (select count(*)::int from app.workspace_access a where a.user_id = u.id) as access
          from app.users u where u.id = ${soleOwner.id}`,
    );
    expect(profile).toEqual({ full_name: 'Sole Owner', deleted: false, access: 1 });
  });
});
