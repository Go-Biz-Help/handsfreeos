/**
 * The bell's notifications (20261027012600) on the local database:
 * - **notification.list** gives a person their own in the business on screen, with their own about no business,
 *   newest first, a page at a time (two pushes in the same millisecond are both listed once), with how many are new.
 *   Never another business's: the owner's pick.
 * - **notification.seen** sees what the business's bell showed, up to its newest (to the millisecond): one that came
 *   in after stays new, and so does every other business's.
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
const list = (u: TestUser, input: Record<string, unknown>) =>
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
  it('lists a person’s own in the business on screen, and about none, never another’s, a page at a time', async () => {
    const tie = new Date(base + 5 * MIN).toISOString();
    const a = await kept(dale, 1);
    const b = await kept(dale, 2, { workspaceId: B });
    const c1 = await kept(dale, 5, { at: tie });
    const c2 = await kept(dale, 5, { at: tie });
    const d = await kept(dale, 7, { workspaceId: null });
    await kept(marco, 8);

    const inA = await list(dale, { workspaceId: A });
    expect(inA.notifications.map((n) => n.id)).toEqual([
      d.id,
      ...[c1.id, c2.id].sort().reverse(),
      a.id,
    ]);
    expect(inA.unseen).toBe(4);
    expect(inA.nextCursor).toBeNull();
    expect(inA.notifications[0]).toMatchObject({ workspaceId: null, alertId: null, readAt: null });
    expect(inA.notifications[3]).toMatchObject({ workspaceId: A, subtitle: 'Text · Bell A' });

    // The other business's bell: its own, and the one about no business again.
    const inB = await list(dale, { workspaceId: B });
    expect(inB.notifications.map((n) => n.id)).toEqual([d.id, b.id]);
    expect(inB.unseen).toBe(2);

    // Two a page: the two sent in the same moment are split across pages, each listed once.
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await list(dale, { workspaceId: A, limit: 2, ...(cursor ? { cursor } : {}) });
      seen.push(...page.notifications.map((n) => n.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(seen).toEqual(inA.notifications.map((n) => n.id));

    expect((await list(marco, { workspaceId: A })).notifications).toHaveLength(1);
    await expectHfos(() => list(dale, {}), 'validation');
  });

  it('names the add-on alert a push was about, only when it is one', async () => {
    const owner = await createTestUser('bell-list-alerts');
    const alertId = randomUUID();
    await kept(owner, 1, { workspaceId: null, refs: { alertId } });
    await kept(owner, 2, { workspaceId: null, refs: { alertId: 'not-an-id' } });
    const out = await list(owner, { workspaceId: A });
    expect(out.notifications.map((n) => n.alertId)).toEqual([null, alertId]);
  });
});

describe('notification.seen and notification.read', () => {
  it('see what the business’s bell showed, and leave what came after and other businesses’ new', async () => {
    const u = await createTestUser('bell-seen');
    const elsewhere = await kept(u, 0, { workspaceId: B });
    const older = await kept(u, 1);
    // Kept to the microsecond, as the database keeps a time.
    const shown = await kept(u, 2, {
      workspaceId: null,
      at: new Date(base + 2 * MIN).toISOString().replace('Z', '456Z'),
    });
    const after = await kept(u, 3);
    const first = await list(u, { workspaceId: A });
    // The list's times stop at the millisecond; the bell says it saw up to the second one.
    const upTo = first.notifications.find((n) => n.id === shown.id)!.sentAt;
    const commandId = randomUUID();
    expect(await run(notificationSeen, { workspaceId: A, upTo }, u, phone(commandId))).toEqual({
      seen: 2,
    });
    const next = await list(u, { workspaceId: A });
    expect(next.unseen).toBe(1);
    expect(next.notifications.map((n) => [n.id, n.seenAt !== null])).toEqual([
      [after.id, false],
      [shown.id, true],
      [older.id, true],
    ]);
    // The other business's, older than all of them, is still new there.
    const inB = await list(u, { workspaceId: B });
    expect(inB.notifications.map((n) => [n.id, n.seenAt !== null])).toEqual([
      [shown.id, true],
      [elsewhere.id, false],
    ]);
    expect(inB.unseen).toBe(1);
    // Again: nothing more to see.
    expect(await run(notificationSeen, { workspaceId: A, upTo }, u, phone())).toEqual({ seen: 0 });
    // Without a time, everything in the business.
    expect(await run(notificationSeen, { workspaceId: A }, u)).toEqual({ seen: 1 });
    expect(await run(notificationSeen, { workspaceId: B }, u)).toEqual({ seen: 1 });
    await expectHfos(() => run(notificationSeen, { upTo }, u), 'validation');
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
    const out = await list(u, { workspaceId: A });
    expect(out.notifications.map((n) => [n.id, n.readAt !== null, n.seenAt !== null])).toEqual([
      [untouched.id, false, false],
      [asPush.id, true, true],
      [inBell.id, true, true],
    ]);
    expect(out.unseen).toBe(1);
    expect(
      (await list(marco, { workspaceId: A })).notifications.find((n) => n.id === marcos.id)?.readAt,
    ).toBeNull();

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
