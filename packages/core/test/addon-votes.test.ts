/**
 * Voting on what's next (0109), through the command pipeline: a business's one vote per add-on, cast and taken back
 * by its owners and admins; a week closing with a winner, a tie or nothing voted for; the team choosing; Coming soon
 * and Home's note as the business sees them.
 *
 * Votes and picks are HandsFreeOS-wide and the test database outlives a run, so everything here is over add-ons of
 * its own, with ids made up for the run, and weeks far in the future.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import type { Catalog } from '../src/addons/graph';
import { defineAddon, type AddonManifest, type CatalogStatus } from '../src/addons/manifest';
import { HfosError } from '../src/errors';
import { executeCommand, executeQuery } from '../src/kernel/execute';
import type { CommandDef, HumanActor, QueryDef, RequestMeta } from '../src/kernel/types';
import {
  addonRoadmapCommands,
  addonRoadmapQueries,
  closeAddonVoteWeek,
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
const meta = (): RequestMeta => ({ correlationId: randomUUID(), channel: 'test' });
const run = <I extends z.ZodType, O extends z.ZodType>(
  cmd: CommandDef<I, O>,
  input: unknown,
  u: TestUser,
) => executeCommand(api(), cmd, input, human(u), meta()).then((r) => r.output);
const ask = <I extends z.ZodType, O extends z.ZodType>(
  q: QueryDef<I, O>,
  input: unknown,
  u: TestUser,
) => executeQuery(api(), q, input, human(u), meta());

async function refusal(fn: () => Promise<unknown>): Promise<HfosError> {
  try {
    await fn();
  } catch (e) {
    expect(e).toBeInstanceOf(HfosError);
    return e as HfosError;
  }
  throw new Error('expected a refusal, but the call succeeded');
}

/** Letters only: an add-on id, unique to this run. */
const letters = (n: number) =>
  Array.from(randomBytes(n), (b) => String.fromCharCode(97 + (b % 26))).join('');
const fresh = () => `zv${letters(12)}`;

const planned = (id: string, name: string, status: CatalogStatus = 'planned'): AddonManifest =>
  defineAddon({
    id,
    name,
    summary: `${name} for the test.`,
    description: `${name} for the test.`,
    category: 'operations',
    version: status === 'planned' ? '0.0.0' : '1.0.0',
    dataVersion: 1,
    catalog: { status, keywords: ['test'], groups: ['Testing'] },
    capabilities:
      status === 'planned'
        ? []
        : [{ id: `${id}.use` as `${string}.${string}`, label: `Use ${name}`, description: name }],
    permissions: [],
    billing: { model: 'free' },
  });

const alpha = fresh();
const beta = fresh();
const gamma = fresh();
const delta = fresh();
const built = fresh();
const catalog: Catalog = [
  planned(alpha, 'Alpha Test'),
  planned(beta, 'Beta Test'),
  planned(gamma, 'Gamma Test'),
  planned(delta, 'Delta Test'),
  planned(built, 'Built Test', 'available'),
];
const inRace = [alpha, beta, gamma, delta];
const { vote, unvote, markNewsSeen, choosePick } = addonRoadmapCommands(catalog);
const { roadmap, news, overview } = addonRoadmapQueries(catalog);

/** A week of its own: somewhere in the 2100s, never one another run closed. */
const weekEnd = () =>
  new Date(Date.UTC(2100 + (randomBytes(2).readUInt16BE() % 800), 0, 4, 5)).toISOString();

const closeWeek = (endsAt: string, race: readonly string[] = inRace) =>
  admin().transaction((tx) => closeAddonVoteWeek(tx, new Date(endsAt), race));

let owner: TestUser;
let partner: TestUser;
let helper: TestUser;
let member: TestUser;
let teamAdmin: TestUser;
let teamLead: TestUser;
let wsA: string;
let wsB: string;

beforeAll(async () => {
  [owner, partner, helper, member, teamAdmin, teamLead] = await Promise.all([
    createTestUser('votes-owner', { fullName: 'Olive Owner' }),
    createTestUser('votes-partner', { fullName: 'Pat Partner' }),
    createTestUser('votes-helper', { fullName: 'Hal Helper' }),
    createTestUser('votes-member', { fullName: 'Mo Member' }),
    createTestUser('votes-team-admin', { fullName: 'Chris Admin' }),
    createTestUser('votes-team-lead', { fullName: 'Lee Lead' }),
  ]);
  wsA = (await run(organizationCreate, { businessName: 'Votes HVAC' }, owner)).workspaceId;
  wsB = (await run(organizationCreate, { businessName: 'Votes Roofing' }, partner)).workspaceId;
  await rows(
    admin(),
    sql`insert into app.workspace_memberships (workspace_id, user_id, role)
        values (${wsA}, ${helper.id}, 'admin'), (${wsA}, ${member.id}, 'member')`,
  );
  await rows(
    admin(),
    sql`insert into platform.staff (user_id, role, display_name) values
          (${teamAdmin.id}, 'admin', 'Chris'), (${teamLead.id}, 'lead', 'Lee')
        on conflict (user_id) do update set role = excluded.role, status = 'active'`,
  );
}, 60_000);
afterAll(closeTestDbs);

describe('a business’s vote', () => {
  it('is one per business: its owners and admins cast it, and it counts once', async () => {
    expect(await run(vote, { workspaceId: wsA, addonId: alpha }, owner)).toEqual({
      addonId: alpha,
      voted: true,
      votes: 1,
    });
    // A teammate pressing it too is the same vote.
    expect(await run(vote, { workspaceId: wsA, addonId: alpha }, helper)).toMatchObject({
      votes: 1,
    });
    expect(await run(vote, { workspaceId: wsB, addonId: alpha }, partner)).toMatchObject({
      votes: 2,
    });

    const seen = await ask(roadmap, { workspaceId: wsA }, owner);
    expect(seen.planned.find((a) => a.addonId === alpha)).toMatchObject({
      votes: 2,
      voted: true,
      groups: ['Testing'],
    });
    expect(seen.planned.find((a) => a.addonId === beta)).toMatchObject({ votes: 0, voted: false });
    expect(seen.planned.map((a) => a.addonId)).not.toContain(built);
    expect(Date.parse(seen.nextPickAt)).toBeGreaterThan(Date.now());
  });

  it('is taken back as easily, by any of them', async () => {
    await run(vote, { workspaceId: wsA, addonId: beta }, owner);
    expect(await run(unvote, { workspaceId: wsA, addonId: beta }, helper)).toEqual({
      addonId: beta,
      voted: false,
      votes: 0,
    });
  });

  it('is not a member’s to cast, and is only for what is planned', async () => {
    const e = await refusal(() => run(vote, { workspaceId: wsA, addonId: gamma }, member));
    expect(e.code).toBe('forbidden');
    const other = await refusal(() => run(vote, { workspaceId: wsB, addonId: gamma }, owner));
    expect(['forbidden', 'not_found']).toContain(other.code);
    expect((await refusal(() => run(vote, { workspaceId: wsA, addonId: built }, owner))).rule).toBe(
      'addon_not_votable',
    );
    expect(
      (await refusal(() => run(vote, { workspaceId: wsA, addonId: 'zqnothere' }, owner))).code,
    ).toBe('not_found');
  });

  it('lets nobody write a count or a pick themselves', async () => {
    await expect(
      rows(
        api(),
        sql`update platform.addon_vote_counts set votes = 1000 where addon_id = ${alpha}`,
      ),
    ).rejects.toThrow();
    await expect(
      rows(api(), sql`insert into platform.addon_picks (addon_id, how) values (${gamma}, 'team')`),
    ).rejects.toThrow();
  });
});

describe('a week closing', () => {
  it('picks the one with the most votes, closes its vote, and tells the business on Home', async () => {
    // alpha: 2 votes (both businesses); gamma: 1.
    await run(vote, { workspaceId: wsA, addonId: gamma }, owner);
    const endsAt = weekEnd();
    const week = await closeWeek(endsAt);
    expect(week).toMatchObject({ outcome: 'votes', addonId: alpha, topVotes: 2 });
    // Closing it again is the same answer, and picks nothing more.
    expect((await closeWeek(endsAt)).id).toBe(week.id);

    const seen = await ask(roadmap, { workspaceId: wsA }, owner);
    expect(seen.comingSoon.find((c) => c.addonId === alpha)).toMatchObject({
      how: 'votes',
      votes: 2,
      voted: true,
    });
    expect(seen.planned.map((a) => a.addonId)).not.toContain(alpha);

    const closed = await refusal(() => run(unvote, { workspaceId: wsA, addonId: alpha }, owner));
    expect(closed.rule).toBe('addon_vote_closed');

    // Home's note, for the people who could vote, until they set it aside.
    expect((await ask(news, { workspaceId: wsA }, helper)).news).toMatchObject({
      addonId: alpha,
      kind: 'picked',
    });
    expect((await ask(news, { workspaceId: wsA }, member)).news).toBeNull();
    await run(markNewsSeen, { workspaceId: wsA, addonId: alpha, kind: 'picked' }, helper);
    expect((await ask(news, { workspaceId: wsA }, helper)).news).toBeNull();
    expect((await ask(news, { workspaceId: wsA }, owner)).news).toMatchObject({ addonId: alpha });
  });

  it('tells a business its pick is ready to add once it ships', async () => {
    const shipped: Catalog = catalog.map((m) =>
      m.id === alpha ? planned(alpha, 'Alpha Test', 'available') : m,
    );
    await rows(
      admin(),
      sql`update platform.addon_picks set shipped_at = now() where addon_id = ${alpha}`,
    );
    const later = addonRoadmapQueries(shipped);
    expect((await ask(later.news, { workspaceId: wsB }, partner)).news).toMatchObject({
      addonId: alpha,
      kind: 'shipped',
    });
    expect(
      (await ask(later.roadmap, { workspaceId: wsB }, partner)).comingSoon.map((c) => c.addonId),
    ).not.toContain(alpha);
  });

  it('waits for the team on a tie, who choose among the tied ones', async () => {
    // beta and delta: one vote each, the most left in the race.
    await run(vote, { workspaceId: wsB, addonId: beta }, partner);
    await run(vote, { workspaceId: wsB, addonId: delta }, partner);
    await run(unvote, { workspaceId: wsA, addonId: gamma }, owner);
    const week = await closeWeek(weekEnd());
    expect(week).toMatchObject({ outcome: 'tie', addonId: null, topVotes: 1 });
    expect([...week.tied].sort()).toEqual([beta, delta].sort());

    const view = await ask(overview, {}, teamAdmin);
    expect(view.waiting.find((w) => w.weekId === week.id)).toMatchObject({ outcome: 'tie' });

    // Only staff who manage add-ons choose; a lead doesn't.
    expect(
      (await refusal(() => run(choosePick, { weekId: week.id, addonId: beta }, teamLead))).code,
    ).toBe('forbidden');
    expect(
      (await refusal(() => run(choosePick, { weekId: week.id, addonId: gamma }, teamAdmin))).rule,
    ).toBe('addon_not_tied');
    expect(await run(choosePick, { weekId: week.id, addonId: delta }, teamAdmin)).toEqual({
      weekId: week.id,
      addonId: delta,
    });
    expect(
      (await refusal(() => run(choosePick, { weekId: week.id, addonId: beta }, teamAdmin))).rule,
    ).toBe('addon_week_decided');
    const after = await ask(overview, {}, teamAdmin);
    expect(after.waiting.map((w) => w.weekId)).not.toContain(week.id);
    expect(after.weeks.find((w) => w.weekId === week.id)).toMatchObject({
      addonId: delta,
      name: 'Delta Test',
      decidedBy: 'Chris',
    });
    expect(after.comingSoon.find((c) => c.addonId === delta)).toMatchObject({ how: 'team' });
  });

  it('waits for the team when nothing was voted for, who choose anything still planned', async () => {
    const week = await closeWeek(weekEnd(), [gamma]);
    expect(week).toMatchObject({ outcome: 'no_votes', addonId: null, tied: [] });
    await run(choosePick, { weekId: week.id, addonId: gamma }, teamAdmin);
    const seen = await ask(roadmap, { workspaceId: wsA }, owner);
    expect(seen.comingSoon.find((c) => c.addonId === gamma)).toMatchObject({ how: 'team' });
  });

  it('keeps how weeks closed from businesses', async () => {
    // Somebody who isn't on the team is told there's nothing here.
    const e = await refusal(() => ask(overview, {}, owner));
    expect(['forbidden', 'not_found']).toContain(e.code);
  });
});
