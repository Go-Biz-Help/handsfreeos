/**
 * 0054 and 0055: what a phone that works offline needs from the database before any sync.
 *   - app.command_receipts: a command id is claimed once per person; the answer is stored once, in the
 *     transaction that claimed it (a receipt never commits without one); a repeat, even a simultaneous one,
 *     finds the first answer; a person reads only their own; the worker's daily clean-up removes those older
 *     than 90 days, and nothing younger.
 *   - app.events.occurred_at: every write that doesn't name a time gets the event's own; the kernel may name
 *     the moment a change was really made.
 *   - field_times on people, companies, leads, tasks and appointments: written by the update commands in the same
 *     statement as the change, as the person or the worker, and nothing that guards those tables minds it.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rows, sql, type Tx } from '../src/client';
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
let member: TestUser;
let outsider: TestUser;
let A: { ws: string; org: string };
let B: { ws: string; org: string };

beforeAll(async () => {
  [owner, member, outsider] = await Promise.all([
    createTestUser('receipts-owner'),
    createTestUser('receipts-member'),
    createTestUser('receipts-outsider'),
  ]);
  const a = await bootstrapOrganization(owner, 'Receipts Org A', 'Receipts A');
  A = { ws: a.wsId, org: a.orgId };
  const b = await bootstrapOrganization(outsider, 'Receipts Org B', 'Receipts B');
  B = { ws: b.wsId, org: b.orgId };
  await dbs.admin.db
    .insert(workspaceMemberships)
    .values({ workspaceId: A.ws, userId: member.id, role: 'member' });
});
afterAll(closeAll);

const failure = async (fn: () => Promise<unknown>) => {
  const e = await expectPgError(fn);
  return { code: e.code, detail: e.detail };
};

/** What executeCommand does first: claim the id. Returns whether this call made the receipt. */
async function claim(
  tx: Tx,
  user: TestUser,
  commandId: string,
  opts: { ws?: string | null; command?: string; hash?: string } = {},
): Promise<boolean> {
  const made = await rows<{ id: string }>(
    tx,
    sql`insert into app.command_receipts (user_id, command_id, workspace_id, command, input_hash, outcome, occurred_at)
        values (${user.id}, ${commandId}, ${opts.ws === undefined ? A.ws : opts.ws}, ${opts.command ?? 'person.update'},
          ${opts.hash ?? 'a'.repeat(64)}, 'applied', now() - interval '3 minutes')
        on conflict (user_id, command_id) do nothing
        returning id`,
  );
  return made.length === 1;
}

const answerOf = async (tx: Tx, user: TestUser, commandId: string) => {
  const [r] = await rows<{ answer: unknown; outcome: string; input_hash: string }>(
    tx,
    sql`select answer, outcome::text as outcome, input_hash from app.command_receipts
        where user_id = ${user.id} and command_id = ${commandId}`,
  );
  return r;
};

describe('app.command_receipts', () => {
  it('claims a command id, stores its answer at the end, and gives a repeat that answer', async () => {
    const commandId = randomUUID();
    await as(member)(async (tx) => {
      expect(await claim(tx, member, commandId)).toBe(true);
      await tx.execute(
        sql`update app.command_receipts set answer = ${JSON.stringify({ personId: 'p-1' })}::jsonb
            where user_id = ${member.id} and command_id = ${commandId}`,
      );
    });
    const repeat = await as(member)(async (tx) => {
      expect(await claim(tx, member, commandId)).toBe(false);
      return answerOf(tx, member, commandId);
    });
    expect(repeat).toEqual({
      answer: { personId: 'p-1' },
      outcome: 'applied',
      input_hash: 'a'.repeat(64),
    });
  });

  it('keeps a final refusal, recorded in its own transaction, with its body', async () => {
    const commandId = randomUUID();
    const body = {
      code: 'validation',
      disposition: 'final',
      message: 'That email doesn’t look right.',
    };
    await as(member)((tx) =>
      tx.execute(
        sql`insert into app.command_receipts (user_id, command_id, workspace_id, command, input_hash, outcome, answer, occurred_at)
            values (${member.id}, ${commandId}, ${A.ws}, 'person.create', ${'b'.repeat(64)}, 'refused',
              ${JSON.stringify(body)}::jsonb, now())`,
      ),
    );
    expect(await as(member)((tx) => answerOf(tx, member, commandId))).toMatchObject({
      outcome: 'refused',
      answer: body,
    });
  });

  it('never commits a receipt without its answer', async () => {
    const commandId = randomUUID();
    expect(await failure(() => as(member)((tx) => claim(tx, member, commandId)))).toEqual({
      code: '23514',
      detail: 'command_receipt_unanswered',
    });
    // Nothing was kept: the id is still free.
    expect(await as(member)((tx) => answerOf(tx, member, commandId))).toBeUndefined();
  });

  it('stores an answer once', async () => {
    const commandId = randomUUID();
    await as(member)(async (tx) => {
      await claim(tx, member, commandId);
      await tx.execute(
        sql`update app.command_receipts set answer = '{"n": 1}' where user_id = ${member.id} and command_id = ${commandId}`,
      );
    });
    expect(
      await failure(() =>
        as(member)((tx) =>
          tx.execute(
            sql`update app.command_receipts set answer = '{"n": 2}' where user_id = ${member.id} and command_id = ${commandId}`,
          ),
        ),
      ),
    ).toEqual({ code: '42501', detail: 'command_receipt_answered' });
    // And nothing else about a receipt is people's to change.
    expect(
      (
        await expectPgError(() =>
          as(member)((tx) =>
            tx.execute(
              sql`update app.command_receipts set outcome = 'refused' where user_id = ${member.id} and command_id = ${commandId}`,
            ),
          ),
        )
      ).code,
    ).toBe('42501');
  });

  it('gives a simultaneous repeat the first answer once the first commits', async () => {
    const commandId = randomUUID();
    let releaseFirst!: () => void;
    const firstMayFinish = new Promise<void>((r) => (releaseFirst = r));
    let firstClaimed!: () => void;
    const claimedOnce = new Promise<void>((r) => (firstClaimed = r));

    const first = as(member)(async (tx) => {
      const made = await claim(tx, member, commandId);
      firstClaimed();
      await firstMayFinish;
      await tx.execute(
        sql`update app.command_receipts set answer = '{"sent": true}' where user_id = ${member.id} and command_id = ${commandId}`,
      );
      return made;
    });
    await claimedOnce;
    // The repeat's claim waits on the unique key until the first transaction ends.
    const second = as(member)(async (tx) => {
      const made = await claim(tx, member, commandId);
      return { made, receipt: await answerOf(tx, member, commandId) };
    });
    await new Promise((r) => setTimeout(r, 300));
    releaseFirst();
    expect(await first).toBe(true);
    const repeat = await second;
    expect(repeat.made).toBe(false);
    expect(repeat.receipt?.answer).toEqual({ sent: true });
  });

  it('lets a person read only their own receipts', async () => {
    const commandId = randomUUID();
    await as(member)(async (tx) => {
      await claim(tx, member, commandId);
      await tx.execute(
        sql`update app.command_receipts set answer = '{}' where user_id = ${member.id} and command_id = ${commandId}`,
      );
    });
    const [seen] = await as(owner)((tx) =>
      rows<{ n: number }>(
        tx,
        sql`select count(*)::int as n from app.command_receipts where command_id = ${commandId}`,
      ),
    );
    expect(seen!.n).toBe(0);
    // The worker can't read them at all: it only ever deletes them, through the clean-up.
    expect(
      (
        await expectPgError(() =>
          asService({ workspaceId: A.ws, organizationId: A.org })((tx) =>
            rows(tx, sql`select count(*) from app.command_receipts`),
          ),
        )
      ).code,
    ).toBe('42501');
  });

  it('refuses a receipt in someone else’s name, or in a business the person doesn’t work in', async () => {
    expect(
      (await expectPgError(() => as(member)((tx) => claim(tx, owner, randomUUID())))).code,
    ).toBe('42501');
    // A business they don't work in is refused before the policy is asked.
    expect(
      await failure(() => as(member)((tx) => claim(tx, member, randomUUID(), { ws: B.ws }))),
    ).toEqual({ code: '23514', detail: 'record_workspace_mismatch' });
    // Written past RLS, the reference check still holds.
    expect(
      await failure(() =>
        dbs.admin.db.transaction(async (tx) => {
          await claim(tx, member, randomUUID(), { ws: B.ws });
          await tx.execute(
            sql`update app.command_receipts set answer = '{}' where workspace_id = ${B.ws}`,
          );
        }),
      ),
    ).toEqual({ code: '23514', detail: 'record_workspace_mismatch' });
  });

  it('takes a command about the person’s own account with no business', async () => {
    const commandId = randomUUID();
    await as(outsider)(async (tx) => {
      expect(
        await claim(tx, outsider, commandId, { ws: null, command: 'push_device.register' }),
      ).toBe(true);
      await tx.execute(
        sql`update app.command_receipts set answer = '{}' where user_id = ${outsider.id} and command_id = ${commandId}`,
      );
    });
    expect((await as(outsider)((tx) => answerOf(tx, outsider, commandId)))?.outcome).toBe(
      'applied',
    );
  });

  it('refuses a name that isn’t a command’s, or a hash that isn’t one', async () => {
    expect(
      (
        await expectPgError(() =>
          as(member)((tx) => claim(tx, member, randomUUID(), { command: 'Person Update' })),
        )
      ).code,
    ).toBe('23514');
    expect(
      (
        await expectPgError(() =>
          as(member)((tx) => claim(tx, member, randomUUID(), { hash: 'short' })),
        )
      ).code,
    ).toBe('23514');
  });

  it('cleans up receipts older than 90 days, a batch at a time, for the worker only', async () => {
    const old: string[] = [randomUUID(), randomUUID(), randomUUID()];
    const recent: string = randomUUID();
    await dbs.admin.db.transaction(async (tx) => {
      for (const [i, commandId] of old.entries())
        await tx.execute(
          sql`insert into app.command_receipts (user_id, command_id, workspace_id, command, input_hash, outcome, answer, occurred_at, received_at)
              values (${owner.id}, ${commandId}, ${A.ws}, 'task.create', ${'c'.repeat(64)}, 'applied', '{}',
                now() - make_interval(days => ${91 + i}), now() - make_interval(days => ${91 + i}))`,
        );
      await tx.execute(
        sql`insert into app.command_receipts (user_id, command_id, workspace_id, command, input_hash, outcome, answer, occurred_at, received_at)
            values (${owner.id}, ${recent}, ${A.ws}, 'task.create', ${'c'.repeat(64)}, 'applied', '{}',
              now() - interval '89 days', now() - interval '89 days')`,
      );
    });
    const left = async () =>
      (
        await rows<{ command_id: string }>(
          dbs.admin.db,
          sql`select command_id from app.command_receipts where command_id in (${sql.join(
            [...old, recent].map((x) => sql`${x}::uuid`),
            sql`, `,
          )})`,
        )
      ).map((r) => r.command_id);

    // People can't run it.
    expect(
      (
        await expectPgError(() =>
          as(owner)((tx) => tx.execute(sql`select private.delete_expired_command_receipts(10)`)),
        )
      ).code,
    ).toBe('42501');

    const clean = (limit: number) =>
      asService({ workspaceId: null, organizationId: null })(async (tx) => {
        const [r] = await rows<{ n: number }>(
          tx,
          sql`select private.delete_expired_command_receipts(${limit}) as n`,
        );
        return r!.n;
      });
    // Other suites' old receipts may exist too, so drain until the three are gone, oldest first.
    const first = await clean(1);
    expect(first).toBe(1);
    for (let i = 0; i < 20 && (await left()).some((x) => old.includes(x)); i++) await clean(500);
    expect(await left()).toEqual([recent]);
  });
});

describe('app.events.occurred_at', () => {
  it('is the event’s own time unless the write names the moment the change was made', async () => {
    const correlation = randomUUID();
    const [plain, named] = await as(owner)(async (tx) => {
      const insert = (occurredAt: string | null) =>
        rows<{ created_at: string; occurred_at: string | null }>(
          tx,
          occurredAt === null
            ? sql`insert into app.events (organization_id, workspace_id, event_type, actor_type, actor_id, entity_type, correlation_id)
                  values (${A.org}, ${A.ws}, 'test.happened', 'human', ${owner.id}, 'test', ${correlation})
                  returning created_at, occurred_at`
            : sql`insert into app.events (organization_id, workspace_id, event_type, actor_type, actor_id, entity_type, correlation_id, occurred_at)
                  values (${A.org}, ${A.ws}, 'test.happened', 'human', ${owner.id}, 'test', ${correlation}, ${occurredAt}::timestamptz)
                  returning created_at, occurred_at`,
        );
      const [p] = await insert(null);
      const [n] = await insert('2026-09-21T09:15:00Z');
      return [p!, n!];
    });
    const iso = (t: string | null) => (t === null ? null : new Date(t).toISOString());
    expect(iso(plain.occurred_at)).toBe(iso(plain.created_at));
    expect(iso(named.occurred_at)).toBe('2026-09-21T09:15:00.000Z');
  });
});

describe('field_times', () => {
  const stamp = { email: '2026-09-21T14:03:11.402Z' };

  it('is written with a change, by people and by the worker, on all five tables', async () => {
    const ids = await asService({ workspaceId: A.ws, organizationId: A.org })(async (tx) => {
      const [person] = await rows<{ id: string }>(
        tx,
        sql`insert into app.people (workspace_id, first_name, last_name) values (${A.ws}, 'Maria', 'Lopez') returning id`,
      );
      const [company] = await rows<{ id: string }>(
        tx,
        sql`insert into app.companies (workspace_id, name) values (${A.ws}, 'Lopez Dental') returning id`,
      );
      const [stage] = await rows<{ id: string; pipeline_id: string }>(
        tx,
        sql`select id, pipeline_id from app.pipeline_stages where workspace_id = ${A.ws} and kind = 'open' order by position limit 1`,
      );
      const [lead] = await rows<{ id: string }>(
        tx,
        sql`insert into app.leads (workspace_id, pipeline_id, stage_id, person_id, title)
            values (${A.ws}, ${stage!.pipeline_id}, ${stage!.id}, ${person!.id}, 'New AC') returning id`,
      );
      const [task] = await rows<{ id: string }>(
        tx,
        sql`insert into app.tasks (workspace_id, title) values (${A.ws}, 'Call Maria') returning id`,
      );
      const [calendar] = await rows<{ id: string }>(
        tx,
        sql`insert into app.calendars (workspace_id, name, slug, status)
            values (${A.ws}, 'Visits', ${`visits-${uniq().toLowerCase()}`}, 'active') returning id`,
      );
      const [appointment] = await rows<{ id: string }>(
        tx,
        sql`insert into app.appointments (workspace_id, calendar_id, calendar_revision, title, starts_at, ends_at, source)
            values (${A.ws}, ${calendar!.id}, 1, 'Tune-up', now() + interval '1 day', now() + interval '1 day 1 hour', 'staff')
            returning id`,
      );
      return {
        people: person!.id,
        companies: company!.id,
        leads: lead!.id,
        tasks: task!.id,
        appointments: appointment!.id,
      };
    });

    const changes: Record<keyof typeof ids, ReturnType<typeof sql>> = {
      people: sql`email = 'maria@example.test'`,
      companies: sql`email = 'office@example.test'`,
      leads: sql`title = 'New AC system'`,
      tasks: sql`title = 'Call Maria back'`,
      appointments: sql`title = 'Tune-up and filter'`,
    };
    for (const table of Object.keys(ids) as (keyof typeof ids)[]) {
      // As a member, through the grants people have.
      const [row] = await as(member)((tx) =>
        rows<{ field_times: Record<string, string>; updated: boolean }>(
          tx,
          sql`update ${sql.identifier('app')}.${sql.identifier(table)}
              set ${changes[table]}, field_times = field_times || ${JSON.stringify(stamp)}::jsonb
              where id = ${ids[table]}
              returning field_times, updated_at > created_at as updated`,
        ),
      );
      expect(row, table).toEqual({ field_times: stamp, updated: true });
      // And as the worker.
      const [again] = await asService({ workspaceId: A.ws, organizationId: A.org })((tx) =>
        rows<{ field_times: Record<string, string> }>(
          tx,
          sql`update ${sql.identifier('app')}.${sql.identifier(table)}
              set field_times = field_times || '{"notes": "2026-09-21T14:05:00.000Z"}'::jsonb
              where id = ${ids[table]}
              returning field_times`,
        ),
      );
      expect(again?.field_times, table).toEqual({ ...stamp, notes: '2026-09-21T14:05:00.000Z' });
    }
  });

  it('is an object, and starts empty', async () => {
    const [p] = await asService({ workspaceId: A.ws, organizationId: A.org })((tx) =>
      rows<{ id: string; field_times: unknown }>(
        tx,
        sql`insert into app.people (workspace_id, first_name) values (${A.ws}, 'Sam') returning id, field_times`,
      ),
    );
    expect(p!.field_times).toEqual({});
    expect(
      (
        await expectPgError(() =>
          as(member)((tx) =>
            tx.execute(sql`update app.people set field_times = '["email"]' where id = ${p!.id}`),
          ),
        )
      ).code,
    ).toBe('23514');
  });
});
