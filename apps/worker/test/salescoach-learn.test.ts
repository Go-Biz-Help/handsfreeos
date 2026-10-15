/**
 * AI Sales Coach learning from wins (round four, docs/salescoach.md), in the worker against the stand-in model: a booked
 * job marks the customer's coached call of the week before as won; the weekly look turns the reps' winning answers
 * into a better answer for the playbook's objection, with its numbers, and what kept coming up in wins into a new one;
 * and nothing is learned from too few wins.
 */
import { randomUUID } from 'node:crypto';
import { salescoachAddon } from '@hfos/core/addons/salescoach/manifest';
import { playbookSave } from '@hfos/core/addons/salescoach/ops/playbooks';
import {
  catalogAddon,
  executeCommand,
  organizationCreate,
  personCreate,
  type HumanActor,
} from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addonScope } from '../src/addons/context';
import { learn, onWin } from '../src/addons/salescoach/learn';
import type { EventRow } from '../src/handlers/types';
import { scriptedAi } from '../src/ai/scripted';
import { workerMeta } from '../src/services';
import { testServices, type TestServices } from './helpers';

const admin = () => testDbs().admin.db;
const meta = () => ({ correlationId: randomUUID(), channel: 'test' as const });
const human = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: u.claims,
});

let owner: TestUser;
let ws: string;
let org: string;
let personId: string;
let playbookId: string;
let s: TestServices;

const ctx = () =>
  addonScope(
    s,
    catalogAddon('salescoach'),
    { workspaceId: ws, organizationId: org },
    1,
    workerMeta(),
  );

/** A coached call written up `daysAgo`, won or not, with the customer's price worry answered as `answer`. */
async function coached(
  daysAgo: number,
  won: boolean,
  answer: string,
  said = 'Too expensive',
): Promise<string> {
  const [call] = await rows<{ id: string }>(
    admin(),
    sql`insert into app.calls (workspace_id, direction, status, person_id) values (${ws}, 'outbound', 'completed', ${personId})
        returning id`,
  );
  const at = new Date(Date.now() - daysAgo * 24 * 60 * 60_000).toISOString();
  const result = {
    summary: 'A call.',
    notes: [],
    promises: [],
    followUp: '',
    objections: [
      { said, answered: true, answer, objectionId: said === 'Too expensive' ? 'o1' : null },
    ],
    stepsCovered: [],
    tips: [],
    score: { total: 70, steps: null, objections: { answered: 1, of: 1 }, talkShare: 40 },
  };
  const [c] = await rows<{ id: string }>(
    admin(),
    sql`insert into addon_salescoach.calls (workspace_id, call_id, user_id, person_id, playbook_id, state, result,
                                            started_at, ended_at, won_at, won_how)
        values (${ws}, ${call!.id}, ${owner.id}, ${personId}, ${playbookId}, 'done', ${JSON.stringify(result)}::jsonb,
                ${at}, ${at}, ${won ? at : null}, ${won ? 'paid' : null})
        returning id`,
  );
  return c!.id;
}

const openLessons = () =>
  rows<{
    kind: string;
    objection_id: string | null;
    objection: string;
    answer: string;
    wins: number;
    of_count: number;
  }>(
    admin(),
    sql`select kind, objection_id, objection, answer, wins, of_count from addon_salescoach.lessons
        where workspace_id = ${ws} and state = 'open' order by kind`,
  );

beforeAll(async () => {
  owner = await createTestUser('coach-learn-owner');
  const made = (
    await executeCommand(
      testDbs().api.db,
      organizationCreate,
      { businessName: 'Learning HVAC' },
      human(owner),
      meta(),
    )
  ).output;
  ws = made.workspaceId;
  org = made.organizationId;
  await rows(
    admin(),
    sql`insert into app.addon_installations (workspace_id, addon_id, state, installed_version)
        values (${ws}, 'salescoach', 'enabled', ${salescoachAddon.version})`,
  );
  personId = (
    await executeCommand(
      testDbs().api.db,
      personCreate,
      { workspaceId: ws, firstName: 'Ana', lastName: 'Lopez', phone: '(713) 555-0177' },
      human(owner),
      meta(),
    )
  ).output.personId;
  playbookId = (
    await executeCommand(
      testDbs().api.db,
      playbookSave,
      {
        workspaceId: ws,
        name: 'First call',
        details: {
          steps: [],
          objections: [{ id: 'o1', objection: 'It’s too expensive', answer: 'It’s worth it.' }],
          points: [],
        },
      },
      human(owner),
      meta(),
    )
  ).output.id;
  s = testServices({ ai: { provider: scriptedAi(), dailyTokens: 5_000_000 } });
}, 60_000);
afterAll(closeTestDbs);

describe('learning from wins', () => {
  it('learns nothing from too few wins', async () => {
    await coached(3, true, 'The fee goes toward the repair.');
    await coached(4, false, 'It’s worth it.');
    expect(await learn(ctx())).toBe(0);
    expect(await openLessons()).toEqual([]);
  });

  it('marks a win from a booked job, and turns winning answers into lessons with their numbers', async () => {
    // Not yet won: a job booked for Ana marks it.
    const pending = await coached(2, false, 'The fee goes toward the repair.');
    await onWin('booked')({
      ...ctx(),
      event: {
        payload: { personIds: [personId] },
        entityId: randomUUID(),
        createdAt: new Date(),
      } as unknown as EventRow,
      attempt: 1,
    });
    const [won] = await rows<{ won_how: string | null }>(
      admin(),
      sql`select won_how from addon_salescoach.calls where id = ${pending}`,
    );
    expect(won!.won_how).toBe('booked');
    await coached(5, true, 'The fee goes toward the repair.');
    // Something the playbook doesn't have, in two wins.
    await coached(6, true, 'We can start Monday.', 'How soon can you start?');
    await coached(7, true, 'We can start Monday.', 'How soon can you start?');

    expect(await learn(ctx())).toBe(2);
    const got = await openLessons();
    expect(got).toEqual([
      expect.objectContaining({
        kind: 'better_answer',
        objection_id: 'o1',
        answer: 'The fee goes toward the repair.',
        // Four records with the price worry; the booked job won both of Ana's from this week that hadn't yet.
        of_count: 4,
        wins: 4,
      }),
      expect.objectContaining({
        kind: 'new_objection',
        objection: 'How soon can you start?',
        answer: 'We can start Monday.',
        wins: 2,
      }),
    ]);
  });
});
