/**
 * The bell's notifications (20261027012600) on the local database:
 * - **notification.list** gives a person their own, newest first, from every business they're in, a page at a time
 *   (two pushes in the same millisecond are both listed once), with how many are new.
 * - **notification.seen** sees what the bell showed, up to its newest (to the millisecond): one that came in after
 *   stays new.
 * - **notification.read** reads the ones pressed, in the bell (their ids) or as pushes (the pushes' ids), and so sees
 *   them too; never someone else's.
 * - Both are the person's own: no event, and no receipt for a phone's command.
 * - The bell counts what's new, and an add-on's alert still open, once with its push.
 */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { rows, sql } from '@hfos/db/client';
import { commandReceipts } from '@hfos/db/schema';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { bellCount, BELL_WORDS, newestSent } from '../src/bell';
import { HfosError } from '../src/errors';
import { executeCommand, executeQuery } from '../src/kernel/execute';
import type { CommandDef, HumanActor, RequestMeta } from '../src/kernel/types';
import {
  notificationList,
  notificationRead,
  notificationSeen,
  organizationCreate,
} from '../src/server';

const api = () => testDbs().api.db;
const admin = () => testDbs().admin.db;
const human = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: u.claims,
});
const web = (): RequestMeta => ({ correlationId: randomUUID(), channel: 'web' });
const phone = (commandId = randomUUID()): RequestMeta => ({
  correlationId: randomUUID(),
  channel: 'mobile',
  commandId,
  occurredAt: new Date(),
  sentAt: new Date(),
  confirmedAt: null,
  appVersion: '1.0.0',
});
const run = <I extends z.ZodType, O extends z.ZodType>(
  cmd: CommandDef<I, O>,
  input: unknown,
  u: TestUser,
  meta: RequestMeta = web(),
) => executeCommand(api(), cmd, input, human(u), meta).then((r) => r.output);
const list = (u: TestUser, input: Record<string, unknown> = {}) =>
  executeQuery(api(), notificationList, input, human(u), web());

let dale: TestUser;
let marco: TestUser;
let A: string;
let B: string;

const MIN = 60_000;
const base = Date.now() - 10 * MIN;

/** A notification as the worker keeps it, `minutes` after the base time. */
const kept = async (
  u: TestUser,
  minutes: number,
  over: { workspaceId?: string | null; title?: string; refs?: object; at?: string } = {},
) => {
  const pushId = randomUUID();
  const at = over.at ?? new Date(base + minutes * MIN).toISOString();
  const [row] = await rows<{ id: string }>(
    admin(),
    sql`insert into app.notifications (user_id, workspace_id, push_id, collapse_key, category, title, subtitle, body,
          path, refs, sent_at)
        values (${u.id}, ${over.workspaceId === undefined ? A : over.workspaceId}, ${pushId}, ${pushId},
          'customer_message', ${over.title ?? `At ${minutes}`}, 'Text · Bell A', 'Is anyone there?',
          ${`/app/w/${A}/inbox`}, ${JSON.stringify(over.refs ?? {})}::jsonb, ${at}::timestamptz)
        returning id`,
  );
  return { id: row!.id, pushId };
};

async function expectHfos(fn: () => Promise<unknown>, code: HfosError['code']) {
  try {
    await fn();
  } catch (e) {
    expect(e).toBeInstanceOf(HfosError);
    expect((e as HfosError).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}, but the call succeeded`);
}

beforeAll(async () => {
  [dale, marco] = await Promise.all([
    createTestUser('bell-list-dale', { fullName: 'Dale Owner' }),
    createTestUser('bell-list-marco', { fullName: 'Marco Tech' }),
  ]);
  A = ((await run(organizationCreate, { businessName: 'Bell A' }, dale)) as { workspaceId: string })
    .workspaceId;
  B = ((await run(organizationCreate, { businessName: 'Bell B' }, dale)) as { workspaceId: string })
    .workspaceId;
}, 60_000);
afterAll(closeTestDbs);

describe('notification.list', () => {
  it('lists a person’s own, newest first, from every business, a page at a time', async () => {
    const tie = new Date(base + 5 * MIN).toISOString();
    const a = await kept(dale, 1);
    const b = await kept(dale, 2, { workspaceId: B });
    const c1 = await kept(dale, 5, { at: tie });
    const c2 = await kept(dale, 5, { at: tie });
    const d = await kept(dale, 7, { workspaceId: null });
    await kept(marco, 8);

    const all = await list(dale);
    expect(all.notifications.map((n) => n.id)).toEqual([
      d.id,
      ...[c1.id, c2.id].sort().reverse(),
      b.id,
      a.id,
    ]);
    expect(all.unseen).toBe(5);
    expect(all.nextCursor).toBeNull();
    expect(all.notifications[0]).toMatchObject({ workspaceId: null, alertId: null, readAt: null });
    expect(all.notifications[3]).toMatchObject({ workspaceId: B, subtitle: 'Text · Bell A' });

    // Two a page: the two sent in the same moment are split across pages, each listed once.
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await list(dale, { limit: 2, ...(cursor ? { cursor } : {}) });
      seen.push(...page.notifications.map((n) => n.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(seen).toEqual(all.notifications.map((n) => n.id));

    expect((await list(marco)).notifications).toHaveLength(1);
  });

  it('names the add-on alert a push was about, only when it is one', async () => {
    const owner = await createTestUser('bell-list-alerts');
    const alertId = randomUUID();
    await kept(owner, 1, { workspaceId: null, refs: { alertId } });
    await kept(owner, 2, { workspaceId: null, refs: { alertId: 'not-an-id' } });
    const out = await list(owner);
    expect(out.notifications.map((n) => n.alertId)).toEqual([null, alertId]);
  });
});

describe('notification.seen and notification.read', () => {
  it('see what the bell showed, and leave what came after new', async () => {
    const u = await createTestUser('bell-seen');
    const older = await kept(u, 1, { workspaceId: null });
    // Kept to the microsecond, as the database keeps a time.
    const shown = await kept(u, 2, {
      workspaceId: null,
      at: new Date(base + 2 * MIN).toISOString().replace('Z', '456Z'),
    });
    const after = await kept(u, 3, { workspaceId: null });
    const first = await list(u);
    // The list's times stop at the millisecond; the bell says it saw up to the second one.
    const upTo = first.notifications.find((n) => n.id === shown.id)!.sentAt;
    const commandId = randomUUID();
    expect(await run(notificationSeen, { upTo }, u, phone(commandId))).toEqual({ seen: 2 });
    const next = await list(u);
    expect(next.unseen).toBe(1);
    expect(next.notifications.map((n) => [n.id, n.seenAt !== null])).toEqual([
      [after.id, false],
      [shown.id, true],
      [older.id, true],
    ]);
    // Again: nothing more to see.
    expect(await run(notificationSeen, { upTo }, u, phone())).toEqual({ seen: 0 });
    // Without a time, everything.
    expect(await run(notificationSeen, {}, u)).toEqual({ seen: 1 });
    // The person's own: no event, and no receipt for the phone's command.
    const receipts = await admin()
      .select()
      .from(commandReceipts)
      .where(eq(commandReceipts.commandId, commandId));
    expect(receipts).toHaveLength(0);
    const [made] = await rows<{ n: number }>(
      admin(),
      sql`select count(*)::int as n from app.events where actor_id = ${u.id}`,
    );
    expect(made!.n).toBe(0);
  });

  it('read the ones pressed, by id or by push, and never someone else’s', async () => {
    const u = await createTestUser('bell-read');
    const inBell = await kept(u, 1, { workspaceId: null });
    const asPush = await kept(u, 2, { workspaceId: null });
    const untouched = await kept(u, 3, { workspaceId: null });
    const marcos = await kept(marco, 4);

    expect(await run(notificationRead, { ids: [inBell.id, marcos.id] }, u)).toEqual({ read: 1 });
    expect(await run(notificationRead, { pushIds: [asPush.pushId] }, u, phone())).toEqual({
      read: 1,
    });
    expect(await run(notificationRead, { pushIds: [asPush.pushId] }, u)).toEqual({ read: 0 });
    const out = await list(u);
    expect(out.notifications.map((n) => [n.id, n.readAt !== null, n.seenAt !== null])).toEqual([
      [untouched.id, false, false],
      [asPush.id, true, true],
      [inBell.id, true, true],
    ]);
    expect(out.unseen).toBe(1);
    expect((await list(marco)).notifications.find((n) => n.id === marcos.id)?.readAt).toBeNull();

    await expectHfos(() => run(notificationRead, {}, u), 'validation');
  });
});

describe('the bell’s count', () => {
  it('counts what’s new, and an open alert once with its push', () => {
    const alertId = randomUUID();
    expect(bellCount([], [])).toBe(0);
    expect(bellCount([{ seenAt: null }, { seenAt: '2026-10-26T10:00:00.000Z' }], [])).toBe(1);
    expect(bellCount([{ seenAt: null, alertId }], [alertId])).toBe(1);
    expect(bellCount([{ seenAt: '2026-10-26T10:00:00.000Z', alertId }], [alertId])).toBe(1);
    expect(bellCount([{ seenAt: null }], [alertId, randomUUID()])).toBe(3);
    expect(newestSent([])).toBeNull();
    expect(
      newestSent([
        { sentAt: '2026-10-26T10:00:00.000Z' },
        { sentAt: '2026-10-26T11:00:00.000Z' },
        { sentAt: '2026-10-25T23:00:00.000Z' },
      ]),
    ).toBe('2026-10-26T11:00:00.000Z');
    expect([BELL_WORDS.label(0), BELL_WORDS.label(1), BELL_WORDS.label(4)]).toEqual([
      'Notifications',
      'Notifications: 1 new',
      'Notifications: 4 new',
    ]);
  });
});
