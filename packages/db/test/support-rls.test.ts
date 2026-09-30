import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rows, sql } from '../src/client';
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

/**
 * The support desk's read rules (M13). Two questions matter, and both are asked here rather than trusted:
 *
 *   1. Can a business — any business, owner included — see the support desk at all? It must not, ever.
 *   2. Can a support person read a business's actual data? Names and dates yes, customers no.
 *
 * Plus the rules that keep the staff table honest: nobody promotes themselves, and the last admin stays.
 */
let admin: TestUser;
let agent: TestUser;
let suspended: TestUser;
let bizOwner: TestUser;
let wsA: string;
let orgA: string;

const worker = () => asService({});
const code = async (fn: () => Promise<unknown>) => (await expectPgError(fn)).code;

beforeAll(async () => {
  [admin, agent, suspended, bizOwner] = await Promise.all([
    createTestUser('support-admin'),
    createTestUser('support-agent'),
    createTestUser('support-suspended'),
    createTestUser('support-biz-owner'),
  ]);
  const a = await bootstrapOrganization(bizOwner, 'Support Org A', 'Support Business A');
  wsA = a.wsId;
  orgA = a.orgId;
  await dbs.admin.db.execute(
    sql`insert into platform.staff (user_id, role, status) values
      (${admin.id}, 'admin', 'active'),
      (${agent.id}, 'agent', 'active'),
      (${suspended.id}, 'agent', 'suspended')`,
  );
});
afterAll(closeAll);

/** A ticket as the worker files one when mail arrives. */
async function ticket(subject = 'Texts are not going out') {
  const [t] = await worker()((tx) =>
    rows<{ id: string; number: string }>(
      tx,
      sql`insert into platform.tickets (subject, channel, requester_email, workspace_id, organization_id)
          values (${subject}, 'email', 'someone@example.com', ${wsA}, ${orgA})
          returning id, number`,
    ),
  );
  return t!;
}

describe('the support desk is invisible to businesses', () => {
  it('a business owner sees no tickets, however many there are', async () => {
    await ticket();
    const seen = await as(bizOwner)((tx) =>
      rows<{ id: string }>(tx, sql`select id from platform.tickets`),
    );
    expect(seen).toEqual([]);
  });

  it('a business owner cannot write a ticket of their own', async () => {
    expect(
      await code(() =>
        as(bizOwner)((tx) =>
          rows(
            tx,
            sql`insert into platform.tickets (subject, channel, requester_email)
                values ('sneaking in', 'email', 'x@example.com')`,
          ),
        ),
      ),
    ).toBe('42501');
  });

  it('a business owner cannot see who answers support', async () => {
    const seen = await as(bizOwner)((tx) =>
      rows<{ user_id: string }>(tx, sql`select user_id from platform.staff`),
    );
    expect(seen).toEqual([]);
  });
});

describe('a suspended support person is nobody', () => {
  it('sees no tickets', async () => {
    await ticket();
    const seen = await as(suspended)((tx) =>
      rows<{ id: string }>(tx, sql`select id from platform.tickets`),
    );
    expect(seen).toEqual([]);
  });
});

describe('what a support person may read of a business', () => {
  it('sees the business in the directory: its name and when it signed up', async () => {
    const seen = await as(agent)((tx) =>
      rows<{ id: string; name: string }>(
        tx,
        sql`select id, name from app.workspaces where id = ${wsA}`,
      ),
    );
    expect(seen[0]?.name).toBe('Support Business A');
  });

  it('cannot read that business’s customers', async () => {
    await as(bizOwner)((tx) =>
      rows(
        tx,
        sql`insert into app.people (workspace_id, first_name, last_name, created_by)
            values (${wsA}, 'Dana', 'Reed', ${bizOwner.id})`,
      ),
    );
    const seen = await as(agent)((tx) =>
      rows<{ id: string }>(tx, sql`select id from app.people where workspace_id = ${wsA}`),
    );
    expect(seen).toEqual([]);
  });

  // Read rules do not refuse an update; they simply leave nothing for it to change. So the test is what
  // matters — the name afterwards — rather than whether the statement raised.
  it('cannot change anything in that business', async () => {
    await as(agent)((tx) =>
      rows(tx, sql`update app.workspaces set name = 'Renamed by support' where id = ${wsA}`),
    );
    const [after] = await dbs.admin.db.execute<{ name: string }>(
      sql`select name from app.workspaces where id = ${wsA}`,
    );
    expect(after?.name).toBe('Support Business A');
  });
});

describe('the staff table keeps itself honest', () => {
  it('nobody changes their own role', async () => {
    expect(
      await code(() =>
        as(admin)((tx) =>
          rows(tx, sql`update platform.staff set role = 'agent' where user_id = ${admin.id}`),
        ),
      ),
    ).toBe('42501');
  });

  it('an agent cannot promote themselves', async () => {
    await as(agent)((tx) =>
      rows(tx, sql`update platform.staff set role = 'admin' where user_id = ${agent.id}`),
    ).catch(() => undefined);
    const [me] = await dbs.admin.db.execute<{ role: string }>(
      sql`select role::text as role from platform.staff where user_id = ${agent.id}`,
    );
    expect(me?.role).toBe('agent');
  });

  // Inside a transaction that is rolled back: the database this runs against keeps rows between runs, so
  // "the last admin" has to be made true for the length of the check rather than assumed.
  it('the last admin cannot be removed', async () => {
    expect(
      await code(() =>
        dbs.admin.db.transaction(async (tx) => {
          await tx.execute(
            sql`delete from platform.staff where role = 'admin' and user_id <> ${admin.id}`,
          );
          await tx.execute(sql`delete from platform.staff where user_id = ${admin.id}`);
        }),
      ),
    ).toBe('23514');
  });
});

describe('an invitation only works for the person it was sent to', () => {
  it('refuses a token opened by the wrong account', async () => {
    const token = randomBytes(32);
    await dbs.admin.db.execute(
      sql`insert into platform.staff_invitations (email, role, token_hash)
          values (${`newcomer-${randomBytes(4).toString('hex')}@example.com`}, 'agent', ${token})`,
    );
    const [answer] = await as(bizOwner)((tx) =>
      rows<{ accepted: boolean; reason: string | null }>(
        tx,
        sql`select accepted, reason from private.accept_staff_invitation(${token})`,
      ),
    );
    expect(answer).toMatchObject({ accepted: false, reason: 'wrong_address' });
  });
});

describe('asking for help from inside the app', () => {
  it('opens a ticket for the business the person really works in', async () => {
    const [made] = await as(bizOwner)((tx) =>
      rows<{ ticket_id: string; ticket_number: string }>(
        tx,
        sql`select ticket_id, ticket_number from private.open_support_ticket(
          ${wsA}, 'Reminders stopped', 'They went out on Monday and not since.', '{}'::jsonb)`,
      ),
    );
    expect(made?.ticket_id).toBeTruthy();
    const [filed] = await worker()((tx) =>
      rows<{ requester_email: string; workspace_id: string; channel: string }>(
        tx,
        sql`select requester_email::text as requester_email, workspace_id, channel::text as channel
            from platform.tickets where id = ${made!.ticket_id}`,
      ),
    );
    // The address and the business come from the database, never from what the screen sent.
    expect(filed).toMatchObject({
      requester_email: bizOwner.email.toLowerCase(),
      workspace_id: wsA,
      channel: 'in_app',
    });
  });

  it('refuses a business the person does not work in', async () => {
    const other = await createTestUser('support-outsider');
    expect(
      await code(() =>
        as(other)((tx) =>
          rows(
            tx,
            sql`select * from private.open_support_ticket(${wsA}, 'Nosy', 'Let me in', '{}'::jsonb)`,
          ),
        ),
      ),
    ).toBe('42501');
  });
});

/**
 * The founder's own kind of session (20261013002100): it works in the business as its owner, so who may hold
 * one is asked here. What it does for the founder is in core's support-view-as.test.ts, the one suite that
 * marks anyone the founder (there can only be one, and the suites share a database).
 */
describe('the founder', () => {
  it('no request makes anyone the founder, an admin included', async () => {
    expect(
      await code(() =>
        as(admin)((tx) =>
          rows(tx, sql`update platform.staff set founder = true where user_id = ${admin.id}`),
        ),
      ),
    ).toBe('42501');
    expect(
      await code(() =>
        worker()((tx) =>
          rows(tx, sql`update platform.staff set founder = true where user_id = ${agent.id}`),
        ),
      ),
    ).toBe('42501');
  });

  it('only the founder opens a session that works in a business', async () => {
    expect(
      await code(() =>
        as(agent)((tx) =>
          rows(
            tx,
            sql`insert into platform.view_as_sessions (staff_user_id, workspace_id, organization_id, acts)
                values (${agent.id}, ${wsA}, ${orgA}, true)`,
          ),
        ),
      ),
    ).toBe('42501');
  });

  it('a look still needs a reason and still ends', async () => {
    expect(
      await code(() =>
        worker()((tx) =>
          rows(
            tx,
            sql`insert into platform.view_as_sessions (staff_user_id, workspace_id, organization_id, reason)
                values (${agent.id}, ${wsA}, ${orgA}, 'No end date')`,
          ),
        ),
      ),
    ).toBe('23514');
    expect(
      await code(() =>
        worker()((tx) =>
          rows(
            tx,
            sql`insert into platform.view_as_sessions (staff_user_id, workspace_id, organization_id, expires_at)
                values (${agent.id}, ${wsA}, ${orgA}, now() + interval '10 minutes')`,
          ),
        ),
      ),
    ).toBe('23514');
  });

  it('a session marked as working, held by someone who is not the founder, grants nothing', async () => {
    // Written past the rules, as a bug or a hand at the console might: the founder check at use still holds.
    const [session] = await dbs.admin.db.execute<{ id: string }>(
      sql`insert into platform.view_as_sessions (staff_user_id, workspace_id, organization_id, acts)
          values (${agent.id}, ${wsA}, ${orgA}, true) returning id`,
    );
    try {
      const [answer] = await as(agent)((tx) =>
        rows<{ writes: boolean; role: string | null; sees: boolean }>(
          tx,
          sql`select private.has_permission(${wsA}, 'records.write') as writes,
                     private.my_workspace_role(${wsA}) as role,
                     ${wsA}::uuid in (select private.accessible_workspace_ids()) as sees`,
        ),
      );
      expect(answer).toEqual({ writes: false, role: null, sees: false });
    } finally {
      await dbs.admin.db.execute(
        sql`delete from platform.view_as_sessions where id = ${session!.id}`,
      );
    }
  });
});

describe('looking at a business', () => {
  it('is found by the API only while it is open and unexpired', async () => {
    const [session] = await worker()((tx) =>
      rows<{ id: string }>(
        tx,
        sql`insert into platform.view_as_sessions
              (staff_user_id, workspace_id, organization_id, reason, expires_at)
            values (${agent.id}, ${wsA}, ${orgA}, 'Checking their reminders', now() + interval '10 minutes')
            returning id`,
      ),
    );
    const open = await worker()((tx) =>
      rows<{ session_id: string }>(
        tx,
        sql`select session_id from private.active_view_as(${agent.id}, ${wsA})`,
      ),
    );
    expect(open).toHaveLength(1);

    await worker()((tx) =>
      rows(
        tx,
        sql`update platform.view_as_sessions set ended_at = now() where id = ${session!.id}`,
      ),
    );
    const closed = await worker()((tx) =>
      rows<{ session_id: string }>(
        tx,
        sql`select session_id from private.active_view_as(${agent.id}, ${wsA})`,
      ),
    );
    expect(closed).toEqual([]);
  });
});
