/**
 * 20261027012600: the notifications under the bell.
 *   - app.notifications: a person's own; they mark when they saw and read each, and change nothing else.
 *   - private.keep_push_notification (the worker's): one row per person per thing (the push's collapse id), kept
 *     once per push, never by an older push, and only for people who can open the business.
 *   - Losing access to a business takes its notifications; deleting an account takes all of them;
 *     private.delete_old_notifications takes those older than 30 days and the support desk's of anyone no longer
 *     on it.
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

const admin$ = dbs.admin.db;
const worker = (b: { ws: string; org: string }) =>
  asService({ workspaceId: b.ws, organizationId: b.org });
const desk = asService({});

interface Push {
  users: readonly string[];
  workspaceId: string | null;
  pushId?: string;
  collapse?: string | null;
  title?: string;
  path?: string;
  sentAt?: Date;
  refs?: Record<string, unknown>;
}

/** The worker keeping a push for the people its phones were handed to; how many rows it wrote. */
const keep = async (p: Push): Promise<number> => {
  const run = p.workspaceId ? worker(A) : desk;
  const [row] = await run((tx) =>
    rows<{ n: number }>(
      tx,
      sql`select private.keep_push_notification(
            array[${sql.join(
              p.users.map((u) => sql`${u}::uuid`),
              sql`, `,
            )}],
            ${p.workspaceId}::uuid, ${p.pushId ?? randomUUID()}::uuid, ${p.collapse ?? null},
            'customer_message', ${p.title ?? 'Mike Johnson'}, 'Text · Mobile A', 'Is anyone there?',
            ${p.path ?? `/app/w/${A.ws}/inbox/${randomUUID()}`}, ${JSON.stringify(p.refs ?? {})}::jsonb,
            ${(p.sentAt ?? new Date()).toISOString()}::timestamptz) as n`,
    ),
  );
  return row!.n;
};

const mine = (user: TestUser, extra = sql``) =>
  as(user)((tx) =>
    rows<{
      id: string;
      push_id: string;
      title: string;
      seen: boolean;
      read: boolean;
    }>(
      tx,
      sql`select id, push_id, title, seen_at is not null as seen, read_at is not null as read
          from app.notifications where true ${extra} order by sent_at desc`,
    ),
  );

beforeAll(async () => {
  [dale, marco, stranger] = await Promise.all([
    createTestUser('bell-dale'),
    createTestUser('bell-marco'),
    createTestUser('bell-stranger'),
  ]);
  const a = await bootstrapOrganization(dale, 'Bell Org', 'Bell A');
  A = { ws: a.wsId, org: a.orgId };
  await bootstrapOrganization(stranger, 'Bell Other', 'Bell S');
  await admin$
    .insert(workspaceMemberships)
    .values({ workspaceId: A.ws, userId: marco.id, role: 'member' });
});
afterAll(closeAll);

describe('app.notifications', () => {
  it('are a person’s own: they mark when they saw and read each, and change nothing else', async () => {
    const pushId = randomUUID();
    expect(await keep({ users: [dale.id, marco.id], workspaceId: A.ws, pushId })).toBe(2);
    const where = sql`and push_id = ${pushId}`;
    const [daleOwn] = await mine(dale, where);
    expect(daleOwn).toMatchObject({ seen: false, read: false });
    expect(await mine(marco, where)).toHaveLength(1);
    expect(await mine(stranger, where)).toHaveLength(0);
    // Dale can't see Marco's, so can't change it either.
    const [marcoOwn] = await mine(marco, where);
    const touched = await as(dale)((tx) =>
      rows(
        tx,
        sql`update app.notifications set read_at = now() where id = ${marcoOwn!.id} returning id`,
      ),
    );
    expect(touched).toHaveLength(0);

    await as(dale)((tx) =>
      tx.execute(
        sql`update app.notifications set seen_at = now(), read_at = now() where id = ${daleOwn!.id}`,
      ),
    );
    expect((await mine(dale, where))[0]).toMatchObject({ seen: true, read: true });
    expect(
      (
        await expectPgError(() =>
          as(dale)((tx) =>
            tx.execute(
              sql`update app.notifications set title = 'Changed' where id = ${daleOwn!.id}`,
            ),
          ),
        )
      ).code,
    ).toBe('42501');
    expect(
      (
        await expectPgError(() =>
          as(dale)((tx) =>
            tx.execute(sql`delete from app.notifications where id = ${daleOwn!.id}`),
          ),
        )
      ).code,
    ).toBe('42501');
    expect(
      (
        await expectPgError(() =>
          as(dale)((tx) =>
            tx.execute(
              sql`insert into app.notifications (user_id, workspace_id, push_id, collapse_key, category, title, body, path, sent_at)
                  values (${dale.id}, ${A.ws}, ${randomUUID()}, 'mine', 'payment', 'Paid', 'Paid', ${`/app/w/${A.ws}`}, now())`,
            ),
          ),
        )
      ).code,
    ).toBe('42501');
  });

  it('are one per thing, kept once per push, and never replaced by an older push', async () => {
    const collapse = `conversation-${randomUUID()}`;
    const t0 = new Date(Date.now() - 60_000);
    const first = randomUUID();
    expect(
      await keep({ users: [dale.id], workspaceId: A.ws, pushId: first, collapse, sentAt: t0 }),
    ).toBe(1);
    const where = sql`and collapse_key = ${collapse}`;
    const [row] = await mine(dale, where);
    await as(dale)((tx) =>
      tx.execute(
        sql`update app.notifications set seen_at = now(), read_at = now() where id = ${row!.id}`,
      ),
    );
    // The same push again (a send retried): nothing changes.
    expect(
      await keep({ users: [dale.id], workspaceId: A.ws, pushId: first, collapse, sentAt: t0 }),
    ).toBe(0);
    expect((await mine(dale, where))[0]).toMatchObject({ id: row!.id, seen: true, read: true });

    // The conversation's next message: the same line, new again, at the top.
    const next = randomUUID();
    expect(
      await keep({
        users: [dale.id],
        workspaceId: A.ws,
        pushId: next,
        collapse,
        title: 'Customer waiting · Mike Johnson',
      }),
    ).toBe(1);
    expect(await mine(dale, where)).toEqual([
      {
        id: row!.id,
        push_id: next,
        title: 'Customer waiting · Mike Johnson',
        seen: false,
        read: false,
      },
    ]);

    // An older push that went out late replaces nothing.
    expect(
      await keep({
        users: [dale.id],
        workspaceId: A.ws,
        collapse,
        title: 'Mike Johnson',
        sentAt: new Date(Date.now() - 120_000),
      }),
    ).toBe(0);
    expect((await mine(dale, where))[0]!.push_id).toBe(next);

    // A push that replaces nothing on the phone is a line of its own.
    const own = randomUUID();
    expect(await keep({ users: [dale.id], workspaceId: A.ws, pushId: own })).toBe(1);
    expect(await mine(dale, sql`and collapse_key = ${own}`)).toHaveLength(1);
  });

  it('are kept only for people who can open the business', async () => {
    const pushId = randomUUID();
    expect(await keep({ users: [dale.id, stranger.id], workspaceId: A.ws, pushId })).toBe(1);
    expect(await mine(stranger, sql`and push_id = ${pushId}`)).toHaveLength(0);
  });

  it('go with access to their business, and only that business’s', async () => {
    const leaver = await createTestUser('bell-leaver');
    await admin$
      .insert(workspaceMemberships)
      .values({ workspaceId: A.ws, userId: leaver.id, role: 'member' });
    await keep({ users: [leaver.id, dale.id], workspaceId: A.ws });
    // A push about no business: a sign-in to the browser extension.
    await keep({
      users: [leaver.id],
      workspaceId: null,
      path: `/app/extension-sign-in/${randomUUID()}`,
    });
    expect(await mine(leaver)).toHaveLength(2);
    const before = (await mine(dale)).length;

    await admin$.execute(
      sql`delete from app.workspace_memberships where workspace_id = ${A.ws} and user_id = ${leaver.id}`,
    );
    const left = await rows<{ workspace_id: string | null }>(
      admin$,
      sql`select workspace_id from app.notifications where user_id = ${leaver.id}`,
    );
    expect(left).toEqual([{ workspace_id: null }]);
    expect(await mine(dale)).toHaveLength(before);
  });

  it('go after 30 days, and the support desk’s go with the desk', async () => {
    const staff = await createTestUser('bell-staff');
    await admin$.execute(
      sql`insert into platform.staff (user_id, role, status) values (${staff.id}, 'agent', 'active')`,
    );
    const old = randomUUID();
    await keep({
      users: [dale.id],
      workspaceId: A.ws,
      pushId: old,
      sentAt: new Date(Date.now() - 31 * 24 * 60 * 60_000),
    });
    const recent = randomUUID();
    await keep({ users: [dale.id], workspaceId: A.ws, pushId: recent });
    const ticket = `/admin/tickets/${randomUUID()}`;
    const ticketPush = randomUUID();
    await keep({
      users: [staff.id, marco.id],
      workspaceId: null,
      pushId: ticketPush,
      path: ticket,
    });

    await desk((tx) => tx.execute(sql`select private.delete_old_notifications(10000)`));

    const kept = await rows<{ user_id: string; push_id: string }>(
      admin$,
      sql`select user_id, push_id from app.notifications
          where push_id in (${old}, ${recent}, ${ticketPush}) order by user_id`,
    );
    expect(kept).toEqual(
      expect.arrayContaining([
        { user_id: dale.id, push_id: recent },
        { user_id: staff.id, push_id: ticketPush },
      ]),
    );
    expect(kept).toHaveLength(2);
  });

  it('go when an account is deleted', async () => {
    const leaver = await createTestUser('bell-gone');
    await admin$
      .insert(workspaceMemberships)
      .values({ workspaceId: A.ws, userId: leaver.id, role: 'member' });
    await keep({ users: [leaver.id], workspaceId: A.ws });
    await keep({
      users: [leaver.id],
      workspaceId: null,
      path: `/app/extension-sign-in/${randomUUID()}`,
    });
    await worker(A)((tx) => tx.execute(sql`select private.anonymize_user(${leaver.id})`));
    const [left] = await rows<{ n: number }>(
      admin$,
      sql`select count(*)::int as n from app.notifications where user_id = ${leaver.id}`,
    );
    expect(left!.n).toBe(0);
  });

  it('are only the worker’s to keep and clear', async () => {
    for (const statement of [
      sql`select private.keep_push_notification(array[${dale.id}::uuid], ${A.ws}::uuid, ${randomUUID()}::uuid,
            null, 'payment', 'Paid', null, 'Paid', ${`/app/w/${A.ws}`}, '{}'::jsonb, now())`,
      sql`select private.delete_old_notifications(1)`,
    ])
      expect((await expectPgError(() => as(dale)((tx) => tx.execute(statement)))).code).toBe(
        '42501',
      );
  });
});
