/**
 * What a person asks the Assistant to do on its own (20261027036600, the owner, 25 Nov 2026), on the local database:
 * - **The words** every list and card says: when a question is asked, what an alert watches for, how a push starts.
 * - **assistant_routine.create** makes a question with its first time in the business's time zone, or an alert for a
 *   customer the person can see; the wrong mix is refused by rule. The event says only which and what kind.
 * - **Theirs alone:** someone else in the business lists none of them and can't pause or delete one.
 * - **Pause and turn on again** clears and sets the next time; **delete** takes it away.
 */
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { assistantRoutines, events, people, workspaceMemberships } from '@hfos/db/schema';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  answerPreview,
  cadenceWords,
  nextRoutineRun,
  routineStatusWords,
  watchWords,
  type RoutineCadence,
} from '../src/assistant/routines';
import { HfosError } from '../src/errors';
import { executeCommand, executeQuery } from '../src/kernel/execute';
import type { CommandDef, HumanActor, QueryDef, RequestMeta } from '../src/kernel/types';
import {
  assistantRoutineCreate,
  assistantRoutineDelete,
  assistantRoutineList,
  assistantRoutineUpdate,
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
const meta = (): RequestMeta => ({ correlationId: randomUUID(), channel: 'web' });
const run = <I extends z.ZodType, O extends z.ZodType>(
  cmd: CommandDef<I, O>,
  input: unknown,
  u: TestUser,
) => executeCommand(api(), cmd, input, human(u), meta()).then((r) => r.output as z.infer<O>);
const ask = <I extends z.ZodType, O extends z.ZodType>(
  q: QueryDef<I, O>,
  input: unknown,
  u: TestUser,
) => executeQuery(api(), q, input, human(u), meta()) as Promise<z.infer<O>>;

async function refused(fn: () => Promise<unknown>, rule: string) {
  try {
    await fn();
  } catch (e) {
    expect(e).toBeInstanceOf(HfosError);
    expect((e as HfosError).rule).toBe(rule);
    return;
  }
  throw new Error(`expected ${rule}, but the call succeeded`);
}

const MONDAY_8: RoutineCadence = { every: 'weekly', days: [1], at: '08:00' };

describe('the words', () => {
  it('says when a question is asked', () => {
    expect(cadenceWords(MONDAY_8)).toBe('Every Monday at 8:00 AM');
    expect(cadenceWords({ every: 'weekly', days: [5, 1, 3], at: '17:30' })).toBe(
      'Every Monday, Wednesday and Friday at 5:30 PM',
    );
    expect(cadenceWords({ every: 'weekly', days: [1, 2, 3, 4, 5], at: '07:00' })).toBe(
      'Every weekday at 7:00 AM',
    );
    expect(cadenceWords({ every: 'monthly', day: 1, at: '09:00' })).toBe(
      'On the 1st of each month at 9:00 AM',
    );
    expect(cadenceWords({ every: 'monthly', day: 'last', at: '09:00' })).toBe(
      'On the last day of each month at 9:00 AM',
    );
  });

  it('works out the next time in the business’s own time zone', () => {
    // Tuesday 25 Nov 2026, 10 AM in Texas: next Monday at 8 AM there, 2 PM in UTC.
    const after = Date.parse('2026-11-25T16:00:00Z');
    expect(new Date(nextRoutineRun(MONDAY_8, after, 'America/Chicago')).toISOString()).toBe(
      '2026-11-30T14:00:00.000Z',
    );
  });

  it('says what an alert watches for, by name', () => {
    const personId = randomUUID();
    expect(watchWords({ on: 'reply', personId }, 'Bob Ortiz')).toBe('When Bob Ortiz writes');
    expect(watchWords({ on: 'booking', personId }, null)).toBe('When that customer books');
    expect(watchWords({ on: 'review', atMost: 1 }, null)).toBe('When a 1-star review comes in');
    expect(watchWords({ on: 'review', atMost: 3 }, null)).toBe(
      'When a review of 3 stars or less comes in',
    );
    expect(watchWords({ on: 'payment', atLeastCents: 100_000 }, null)).toBe(
      'When an invoice of $1,000 or more is paid',
    );
  });

  it('starts a push with the start of the answer, on one line', () => {
    expect(answerPreview('**3 customers** owe you:\n- Bob: $120\n- Ana: $80')).toBe(
      '3 customers owe you: Bob: $120 Ana: $80',
    );
    expect(answerPreview('x'.repeat(300)).length).toBe(180);
  });

  it('says how each one stands', () => {
    const at = (iso: string) => iso.slice(0, 10);
    const base = { nextRunAt: '2026-11-30T14:00:00.000Z', firedCount: 0 };
    expect(routineStatusWords({ ...base, kind: 'question', paused: false, once: false }, at)).toBe(
      'Next: 2026-11-30',
    );
    expect(routineStatusWords({ ...base, kind: 'alert', paused: false, once: true }, at)).toBe(
      'Tells you once, then stops',
    );
    expect(
      routineStatusWords({ ...base, kind: 'alert', paused: true, once: true, firedCount: 1 }, at),
    ).toBe('Told you once, then stopped');
  });
});

describe('a person’s own questions and alerts', () => {
  let owner: TestUser;
  let member: TestUser;
  let ws: string;
  let bob: string;

  beforeAll(async () => {
    [owner, member] = await Promise.all([
      createTestUser('routine-owner'),
      createTestUser('routine-member'),
    ]);
    const made = await executeCommand(
      api(),
      organizationCreate,
      { businessName: 'Lone Star HVAC & Roofing', timezone: 'America/Chicago' },
      human(owner),
      meta(),
    );
    ws = made.output.workspaceId;
    await admin()
      .insert(workspaceMemberships)
      .values({ workspaceId: ws, userId: member.id, role: 'member' });
    const [p] = await admin()
      .insert(people)
      .values({ workspaceId: ws, firstName: 'Bob', lastName: 'Ortiz' })
      .returning({ id: people.id });
    bob = p!.id;
  });

  afterAll(closeTestDbs);

  it('makes a question with its first time, and lists it in words', async () => {
    const made = await run(
      assistantRoutineCreate,
      {
        workspaceId: ws,
        kind: 'question',
        question: 'Who owes me money?',
        cadence: MONDAY_8,
        email: true,
      },
      owner,
    );
    expect(made.nextRunAt).not.toBeNull();
    // A Monday at 8 AM in Texas.
    const next = new Date(made.nextRunAt!);
    expect(next.getUTCDay()).toBe(1);
    expect([13, 14]).toContain(next.getUTCHours());
    const { items } = await ask(assistantRoutineList, { workspaceId: ws }, owner);
    expect(items.find((r) => r.id === made.routineId)).toMatchObject({
      kind: 'question',
      when: 'Every Monday at 8:00 AM',
      question: 'Who owes me money?',
      email: true,
      paused: false,
    });
    // The event says which and what kind, never the question.
    const [e] = await admin()
      .select()
      .from(events)
      .where(
        and(eq(events.entityId, made.routineId), eq(events.eventType, 'assistant_routine.changed')),
      );
    expect(e?.payload).toEqual({ kind: 'question' });
  });

  it('makes an alert for a customer, named in the list, telling once unless said', async () => {
    const made = await run(
      assistantRoutineCreate,
      { workspaceId: ws, kind: 'alert', watch: { on: 'reply', personId: bob } },
      owner,
    );
    expect(made.nextRunAt).toBeNull();
    const { items } = await ask(assistantRoutineList, { workspaceId: ws }, owner);
    expect(items.find((r) => r.id === made.routineId)).toMatchObject({
      kind: 'alert',
      when: 'When Bob Ortiz writes',
      once: true,
    });
    const paid = await run(
      assistantRoutineCreate,
      { workspaceId: ws, kind: 'alert', watch: { on: 'payment', atLeastCents: 100_000 } },
      owner,
    );
    const [row] = await admin()
      .select()
      .from(assistantRoutines)
      .where(eq(assistantRoutines.id, paid.routineId));
    expect(row?.once).toBe(false);
  });

  it('refuses the wrong mix, and one with a part missing', async () => {
    await refused(
      () =>
        run(
          assistantRoutineCreate,
          {
            workspaceId: ws,
            kind: 'alert',
            question: 'Who wrote?',
            watch: { on: 'review', atMost: 1 },
          },
          owner,
        ),
      'routine_kind_mismatch',
    );
    await refused(
      () =>
        run(
          assistantRoutineCreate,
          { workspaceId: ws, kind: 'question', question: 'Who owes me?' },
          owner,
        ),
      'routine_incomplete',
    );
    await refused(
      () => run(assistantRoutineCreate, { workspaceId: ws, kind: 'alert' }, owner),
      'routine_incomplete',
    );
  });

  it('is theirs alone: nobody else lists, pauses or deletes it', async () => {
    const made = await run(
      assistantRoutineCreate,
      { workspaceId: ws, kind: 'alert', watch: { on: 'review', atMost: 2 } },
      owner,
    );
    const { items } = await ask(assistantRoutineList, { workspaceId: ws }, member);
    expect(items).toEqual([]);
    await expect(
      run(
        assistantRoutineUpdate,
        { workspaceId: ws, routineId: made.routineId, paused: true },
        member,
      ),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      run(assistantRoutineDelete, { workspaceId: ws, routineId: made.routineId }, member),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('pauses and turns on again, and deletes', async () => {
    const made = await run(
      assistantRoutineCreate,
      {
        workspaceId: ws,
        kind: 'question',
        question: 'How many jobs this week?',
        cadence: MONDAY_8,
      },
      owner,
    );
    const paused = await run(
      assistantRoutineUpdate,
      { workspaceId: ws, routineId: made.routineId, paused: true },
      owner,
    );
    expect(paused.nextRunAt).toBeNull();
    const again = await run(
      assistantRoutineUpdate,
      { workspaceId: ws, routineId: made.routineId, paused: false },
      owner,
    );
    expect(again.nextRunAt).not.toBeNull();
    await refused(
      () =>
        run(
          assistantRoutineUpdate,
          { workspaceId: ws, routineId: made.routineId, watch: { on: 'review', atMost: 1 } },
          owner,
        ),
      'routine_kind_mismatch',
    );
    await run(assistantRoutineDelete, { workspaceId: ws, routineId: made.routineId }, owner);
    const { items } = await ask(assistantRoutineList, { workspaceId: ws }, owner);
    expect(items.some((r) => r.id === made.routineId)).toBe(false);
  });
});
