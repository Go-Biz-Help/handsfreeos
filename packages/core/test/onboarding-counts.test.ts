/**
 * Counting Getting started (HANDSFREEOS_ONBOARDING_IMPLEMENTATION_PLAN.md §9, 20261013001500): the admin side's
 * page counts, from the onboarding events, how many businesses answer the quick questions, which steps get skipped
 * and brought back, how many finish, and how many add customers as they go. Staff who read the directory see it;
 * nobody else does, whether they ask the API or the database.
 *
 * `pnpm test` runs every package at once against one database, so the counts here are read before and after and
 * compared as "at least": another test's business can land in the same window.
 */
import { randomUUID } from 'node:crypto';
import { asUser, rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { HfosError } from '../src/errors';
import { executeCommand, executeQuery } from '../src/kernel/execute';
import type { CommandDef, HumanActor, RequestMeta } from '../src/kernel/types';
import { shapeOnboardingCounts } from '../src/onboarding/counts';
import { BUSINESS_STEPS, PERSONAL_STEPS } from '../src/onboarding/steps';
import {
  onboardingAsYouGo,
  onboardingFinish,
  onboardingSaveAnswers,
  onboardingSetEnabled,
  onboardingSetView,
  onboardingSkip,
  organizationCreate,
  platformOnboardingCounts,
} from '../src/server';

const api = () => testDbs().api.db;
const admin = () => testDbs().admin.db;
const human = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: u.claims,
});
const meta = (): RequestMeta => ({ correlationId: randomUUID(), channel: 'test' });
const run = <I extends z.ZodType, O extends z.ZodType>(
  cmd: CommandDef<I, O>,
  input: unknown,
  u: TestUser,
) => executeCommand(api(), cmd, input, human(u), meta()).then((r) => r.output);
const counts = (u: TestUser) =>
  executeQuery(api(), platformOnboardingCounts, { days: 1 }, human(u), meta());
const step = (c: Awaited<ReturnType<typeof counts>>, key: string) =>
  c.steps.find((s) => s.key === key)!;

let agent: TestUser;
let owner: TestUser;
let teammate: TestUser;
let ws: string;

beforeAll(async () => {
  [agent, owner, teammate] = await Promise.all([
    createTestUser('onb-counts-agent'),
    createTestUser('onb-counts-owner'),
    createTestUser('onb-counts-teammate'),
  ]);
  // A support agent: the lowest staff role that reads the directory.
  await admin().execute(
    sql`insert into platform.staff (user_id, role) values (${agent.id}, 'agent')
        on conflict (user_id) do update set role = 'agent', status = 'active'`,
  );
  ws = (await run(organizationCreate, { businessName: 'Counted Plumbing' }, owner)).workspaceId;
  await rows(
    admin(),
    sql`insert into app.workspace_memberships (workspace_id, user_id, role)
        values (${ws}, ${teammate.id}, 'member')`,
  );
});
afterAll(closeTestDbs);

describe('shapeOnboardingCounts', () => {
  it('lists every step, the most skipped first, and reads a missing measure as none', () => {
    const since = new Date('2026-09-01T00:00:00Z');
    const out = shapeOnboardingCounts(
      [
        { measure: 'started', step: null, count: '12' },
        { measure: 'finished', step: null, count: 4 },
        { measure: 'finished_clean', step: null, count: 1 },
        { measure: 'skipped', step: 'payments', count: '5' },
        { measure: 'brought_back', step: 'payments', count: '2' },
        { measure: 'skipped', step: 'sign_in', count: '7' },
      ],
      since,
    );
    expect(out).toMatchObject({
      since: since.toISOString(),
      started: 12,
      asYouGo: 0,
      finished: { businesses: 4, nothingSkipped: 1, teammates: 0 },
      hidden: 0,
      turnedOff: 0,
    });
    expect(out.steps).toHaveLength(BUSINESS_STEPS.length + PERSONAL_STEPS.length);
    expect(out.steps.slice(0, 2)).toEqual([
      { key: 'sign_in', for: 'person', skipped: 7, broughtBack: 0 },
      { key: 'payments', for: 'business', skipped: 5, broughtBack: 2 },
    ]);
    // Nobody skipped the rest: they keep the catalogue's order.
    expect(out.steps.slice(2).map((s) => s.key)).toEqual(
      [...BUSINESS_STEPS, ...PERSONAL_STEPS].filter((k) => k !== 'payments' && k !== 'sign_in'),
    );
  });
});

describe('platform.onboarding.counts', () => {
  it('counts a business that answers, skips, brings one back, finishes, then turns it off', async () => {
    const before = await counts(agent);

    await run(
      onboardingSaveAnswers,
      { workspaceId: ws, goal: 'booked', customersIn: 'none', teamSize: 'small' },
      owner,
    );
    await run(onboardingAsYouGo, { workspaceId: ws, asYouGo: true }, owner);
    for (const key of [...BUSINESS_STEPS, 'app', 'sign_in'])
      await run(onboardingSkip, { workspaceId: ws, step: key, skipped: true }, owner);
    await run(onboardingSkip, { workspaceId: ws, step: 'payments', skipped: false }, owner);
    await run(onboardingSkip, { workspaceId: ws, step: 'payments', skipped: true }, owner);
    await run(onboardingFinish, { workspaceId: ws }, owner);
    for (const key of PERSONAL_STEPS)
      await run(onboardingSkip, { workspaceId: ws, step: key, skipped: true }, teammate);
    await run(onboardingFinish, { workspaceId: ws }, teammate);
    await run(onboardingSetView, { workspaceId: ws, hidden: true }, teammate);
    await run(onboardingSetEnabled, { workspaceId: ws, enabled: false }, owner);

    const after = await counts(agent);
    expect(after.started - before.started).toBeGreaterThanOrEqual(1);
    expect(after.asYouGo - before.asYouGo).toBeGreaterThanOrEqual(1);
    expect(after.finished.businesses - before.finished.businesses).toBeGreaterThanOrEqual(1);
    expect(after.finished.teammates - before.finished.teammates).toBeGreaterThanOrEqual(1);
    expect(after.hidden - before.hidden).toBeGreaterThanOrEqual(1);
    expect(after.turnedOff - before.turnedOff).toBeGreaterThanOrEqual(1);
    // Payments was skipped twice and brought back once: one business each way.
    expect(
      step(after, 'payments').skipped - step(before, 'payments').skipped,
    ).toBeGreaterThanOrEqual(1);
    expect(
      step(after, 'payments').broughtBack - step(before, 'payments').broughtBack,
    ).toBeGreaterThanOrEqual(1);
    // Sign in faster is on the owner's list and the teammate's: two people.
    expect(step(after, 'sign_in').skipped - step(before, 'sign_in').skipped).toBeGreaterThanOrEqual(
      2,
    );
    expect(step(after, 'sign_in').for).toBe('person');
  });

  it('counts a business once however many times it skips the same step', async () => {
    const [row] = await rows<{ skips: number; subjects: number }>(
      admin(),
      sql`select count(*)::int as skips, count(distinct workspace_id)::int as subjects from app.events
          where event_type = 'onboarding.step_skipped' and workspace_id = ${ws}
            and payload ->> 'step' = 'payments' and (payload ->> 'skipped')::boolean`,
    );
    expect(row).toEqual({ skips: 2, subjects: 1 });
    const counted = await asUser(api(), agent.claims, (tx) =>
      rows<{ count: string }>(
        tx,
        sql`select count from private.admin_onboarding_counts(now() - interval '1 day')
            where measure = 'skipped' and step = 'payments'`,
      ),
    );
    expect(Number(counted[0]?.count)).toBeGreaterThanOrEqual(1);
  });

  it('is only for staff: an owner is told there’s nothing there, and the database answers them nothing', async () => {
    try {
      await counts(owner);
      throw new Error('expected a refusal');
    } catch (e) {
      expect(e).toBeInstanceOf(HfosError);
      // As for the rest of the admin side: no sign that there is anything here to find.
      expect((e as HfosError).code).toBe('not_found');
    }
    const direct = await asUser(api(), owner.claims, (tx) =>
      rows(tx, sql`select * from private.admin_onboarding_counts(now() - interval '1 day')`),
    );
    expect(direct).toEqual([]);
  });
});
