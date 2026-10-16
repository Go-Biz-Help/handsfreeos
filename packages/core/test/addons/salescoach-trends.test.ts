/**
 * Trends (round four, docs/salescoach.md): the weeks run Monday to Sunday in the business's time zone; the totals
 * average the scores, count talk time only where someone talked, and add up objections and steps; a step counts as
 * skipped only against a playbook of the same shape; and `salescoach.trends` gives a rep their own trend while
 * whoever reviews gets every rep's and the team's.
 */
import { randomUUID } from 'node:crypto';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CallScore } from '../../src/addons/salescoach/coach';
import { salescoachAddon } from '../../src/addons/salescoach/manifest';
import { trends } from '../../src/addons/salescoach/ops/trends';
import {
  mondayOf,
  skippedSteps,
  tallyTrend,
  trendBounds,
  trendWeeks,
  type TrendRecord,
} from '../../src/addons/salescoach/trends';
import {
  executeCommand,
  executeQuery,
  organizationCreate,
  type HumanActor,
} from '../../src/server';

const score = (total: number, over: Partial<CallScore> = {}): CallScore => ({
  total,
  steps: { covered: 2, of: 3 },
  objections: { answered: 1, of: 2 },
  talkShare: 50,
  ...over,
});
const record = (over: Partial<TrendRecord> = {}): TrendRecord => ({
  userId: 'u1',
  at: Date.now(),
  spoken: true,
  score: score(60),
  stepsCovered: ['s1', 's3'],
  playbookId: 'pb',
  won: false,
  ...over,
});

describe('the weeks', () => {
  it('run Monday to Sunday in the business’s time zone, this week last', () => {
    expect(mondayOf('2026-10-18')).toBe('2026-10-12'); // a Sunday
    expect(mondayOf('2026-10-12')).toBe('2026-10-12');
    // Monday 03:00 UTC is still Sunday evening in Chicago.
    const sundayNight = Date.parse('2026-10-19T03:00:00Z');
    expect(trendWeeks(sundayNight, 4, 'America/Chicago')).toEqual([
      '2026-09-21',
      '2026-09-28',
      '2026-10-05',
      '2026-10-12',
    ]);
    expect(trendWeeks(sundayNight, 4, 'UTC').at(-1)).toBe('2026-10-19');
    const { from, previousFrom } = trendBounds(sundayNight, 4, 'America/Chicago');
    expect(new Date(from).toISOString()).toBe('2026-09-21T05:00:00.000Z');
    expect(new Date(previousFrom).toISOString()).toBe('2026-08-24T05:00:00.000Z');
  });
});

describe('the totals', () => {
  it('average the scores, count talk time only where someone talked, and add up the rest', () => {
    expect(
      tallyTrend([
        record({ score: score(80, { talkShare: 40 }), won: true }),
        record({ score: score(61, { talkShare: 71 }) }),
        // A text conversation: its share of the words isn't talk time.
        record({
          spoken: false,
          score: score(40, { talkShare: 95, steps: null, objections: { answered: 0, of: 1 } }),
        }),
      ]),
    ).toEqual({
      coached: 3,
      score: 60,
      talkShare: 56,
      objections: { answered: 2, of: 5 },
      steps: { covered: 4, of: 6 },
      wins: 1,
    });
    expect(tallyTrend([])).toMatchObject({ coached: 0, score: null, talkShare: null });
  });

  it('count a step skipped only against a playbook of the same shape, after enough calls', () => {
    const books = new Map([
      [
        'pb',
        {
          name: 'First call',
          steps: [
            { id: 's1', title: 'Say hello' },
            { id: 's2', title: 'Ask what’s wrong' },
            { id: 's3', title: 'Book the visit' },
          ],
        },
      ],
    ]);
    const three = [record(), record(), record({ stepsCovered: ['s1', 's2'] })];
    expect(skippedSteps(three, books)).toEqual([
      expect.objectContaining({ stepId: 's2', title: 'Ask what’s wrong', skipped: 2, of: 3 }),
      expect.objectContaining({ stepId: 's3', skipped: 1, of: 3 }),
    ]);
    // Two calls aren't enough to say.
    expect(skippedSteps(three.slice(0, 2), books)).toEqual([]);
    // A call from when the playbook had four steps doesn't count against today's three.
    const changed = three.map((r) => ({
      ...r,
      score: score(60, { steps: { covered: 2, of: 4 } }),
    }));
    expect(skippedSteps(changed, books)).toEqual([]);
  });
});

const api = () => testDbs().api.db;
const admin = () => testDbs().admin.db;
const human = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: u.claims,
});
const meta = () => ({ correlationId: randomUUID(), channel: 'test' as const });

let owner: TestUser;
let rep: TestUser;
let other: TestUser;
let ws: string;
let playbookId: string;

/** A coached call written up some days ago. */
async function coached(
  by: TestUser,
  daysAgo: number,
  total: number,
  over: { state?: string; won?: boolean; stepsCovered?: string[] } = {},
) {
  const result = {
    summary: 'Talked about the AC.',
    notes: [],
    promises: [],
    followUp: '',
    objections: [],
    stepsCovered: over.stepsCovered ?? ['s1', 's3'],
    tips: [],
    score: score(total),
  };
  // A text conversation's write-up would need a conversation: these are calls the coach heard on a cell.
  const [call] = await rows<{ id: string }>(
    admin(),
    sql`insert into app.calls (workspace_id, direction, status, placed_by, to_e164, provider_sid)
        values (${ws}, 'outbound', 'completed', ${by.id}, '+17135550142', ${`CA${randomUUID().slice(0, 12)}`})
        returning id`,
  );
  await rows(
    admin(),
    sql`insert into addon_salescoach.calls
          (workspace_id, call_id, user_id, playbook_id, playbook_name, state, result, started_at, ended_at, won_at, won_how)
        values (${ws}, ${call!.id}, ${by.id}, ${playbookId}, 'First call', ${over.state ?? 'done'},
                ${JSON.stringify(result)}::jsonb, now() - make_interval(days => ${daysAgo}),
                now() - make_interval(days => ${daysAgo}),
                ${over.won ? sql`now()` : sql`null`}, ${over.won ? 'booked' : null})`,
  );
}

const ask = (u: TestUser, input: Record<string, unknown> = {}) =>
  executeQuery(api(), trends, { workspaceId: ws, weeks: 4, ...input } as never, human(u), meta());

beforeAll(async () => {
  [owner, rep, other] = await Promise.all([
    createTestUser('trends-owner'),
    createTestUser('trends-rep'),
    createTestUser('trends-other'),
  ]);
  const made = (
    await executeCommand(
      api(),
      organizationCreate,
      { businessName: 'Trending Cooling Co' },
      human(owner),
      meta(),
    )
  ).output;
  ws = made.workspaceId;
  await rows(
    admin(),
    sql`insert into app.workspace_memberships (workspace_id, user_id, role)
        values (${ws}, ${rep.id}, 'member'), (${ws}, ${other.id}, 'member')`,
  );
  await rows(
    admin(),
    sql`insert into app.addon_installations (workspace_id, addon_id, state, installed_version)
        values (${ws}, 'salescoach', 'enabled', ${salescoachAddon.version})`,
  );
  const details = {
    steps: [
      { id: 's1', title: 'Say hello', say: '' },
      { id: 's2', title: 'Ask what’s going on with the AC', say: '' },
      { id: 's3', title: 'Book the visit', say: '' },
    ],
    objections: [],
    points: [],
  };
  const [pb] = await rows<{ id: string }>(
    admin(),
    sql`insert into addon_salescoach.playbooks (workspace_id, name, is_default, details)
        values (${ws}, 'First call', true, ${JSON.stringify(details)}::jsonb) returning id`,
  );
  playbookId = pb!.id;
  await coached(rep, 1, 80, { won: true });
  await coached(rep, 2, 70);
  await coached(rep, 3, 60);
  await coached(rep, 40, 40); // the weeks before
  await coached(rep, 2, 99, { state: 'failed' }); // no write-up: left out
  await coached(other, 2, 50, { stepsCovered: ['s1', 's2', 's3'] });
}, 60_000);
afterAll(closeTestDbs);

describe('salescoach.trends', () => {
  it('gives a rep their own trend, against the weeks before, with the steps they skip', async () => {
    const mine = await ask(rep);
    expect(mine.weeks).toHaveLength(4);
    expect(mine.reps.map((r: { rep: { id: string } }) => r.rep.id)).toEqual([rep.id]);
    const r = mine.reps[0]!;
    expect(r.totals).toMatchObject({ coached: 3, score: 70, wins: 1 });
    expect(r.previous).toMatchObject({ coached: 1, score: 40 });
    expect(r.series.reduce((t: number, w: { coached: number }) => t + w.coached, 0)).toBe(3);
    expect(r.skippedSteps).toEqual([
      expect.objectContaining({ stepId: 's2', skipped: 3, of: 3, playbookName: 'First call' }),
    ]);
    // Another rep's calls are theirs.
    expect((await ask(rep, { userId: other.id })).reps).toEqual([]);
  });

  it('gives whoever reviews every rep and the team', async () => {
    const all = await ask(owner);
    expect(all.reps.map((r: { rep: { id: string } }) => r.rep.id)).toEqual([rep.id, other.id]);
    expect(all.team.totals).toMatchObject({ coached: 4, score: 65, wins: 1 });
    expect(all.team.previous.coached).toBe(1);
    const one = await ask(owner, { userId: other.id });
    expect(one.reps).toHaveLength(1);
    expect(one.reps[0]!.totals).toMatchObject({ coached: 1, score: 50 });
  });
});
