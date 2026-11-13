/**
 * AI Social Media Content Creator setting itself up, on the database (docs/socialcontent.md, "Setting up on its own";
 * decisions 28 to 33): the steps it took keep their first times; it ticks its own niche and the 2 closest; creators'
 * latest likes and comments are kept from their profiles; the AI's match is kept; it picks only suggested creators,
 * swaps out only its own picks, and never touches one a person ticked, added or skipped; owners and admins turn
 * picking on its own off; and the Creators page reads how it all stands.
 */
import { randomUUID } from 'node:crypto';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { socialcontentAddon } from '../../src/addons/socialcontent/manifest';
import { aiPicked, creatorsToWeigh, studyingOn } from '../../src/addons/socialcontent/ops/setup';
import { socialcontentAddonServer } from '../../src/addons/socialcontent/server';
import {
  addonRef,
  executeCommand,
  executeQuery,
  organizationCreate,
  type CommandDef,
  type HumanActor,
  type QueryDef,
  type SystemActor,
} from '../../src/server';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const DAY = 86_400_000;
const api = () => testDbs().api.db;
const admin = () => testDbs().admin.db;
const human = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: u.claims,
});
const meta = () => ({ correlationId: randomUUID(), channel: 'test' as const });
const ops = [
  ...(socialcontentAddonServer.commands ?? []),
  ...(socialcontentAddonServer.queries ?? []),
];
const op = (name: string) => {
  const found = ops.find((o) => o.name === name);
  if (!found) throw new Error(`no ${name}`);
  return found;
};

function as(u: TestUser, name: string, input: Record<string, unknown> = {}): Promise<Any> {
  const found = op(name);
  return found.kind === 'command'
    ? executeCommand(
        api(),
        found as CommandDef,
        { workspaceId: ws, ...input },
        human(u),
        meta(),
      ).then((r) => r.output)
    : executeQuery(api(), found as QueryDef, { workspaceId: ws, ...input }, human(u), meta());
}
function worker(name: string, input: Record<string, unknown>): Promise<Any> {
  const actor: SystemActor = {
    type: 'system',
    workspaceId: ws,
    organizationId: orgId,
    addon: addonRef(socialcontentAddon),
  };
  return executeCommand(
    testDbs().worker.db,
    op(name) as CommandDef<z.ZodType, z.ZodType>,
    { workspaceId: ws, ...input },
    actor,
    meta(),
  ).then((r) => r.output);
}
const refused = (p: Promise<unknown>) =>
  p.then(
    () => 'went through',
    (e: { rule?: string; code?: string }) => e.rule ?? e.code,
  );
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();
const niche = (name: string, why: string | null = null) => ({
  name,
  why,
  searches: { instagram: [`#${name.replace(/\W/g, '').toLowerCase()}`] },
});
/** Latest posts with these likes, no comments. */
const recent = (...likes: number[]) =>
  likes.map((l, i) => ({ likes: l, comments: 0, caption: `Tip ${i + 1}` }));

let owner: TestUser;
let member: TestUser;
let ws: string;
let orgId: string;

/** A creator by handle, as the Creators page lists them. */
async function creator(handle: string): Promise<Any> {
  const { creators } = await as(member, 'socialcontent.creator.list');
  const c = creators.find((x: Any) => x.handle === handle);
  if (!c) throw new Error(`no ${handle}`);
  return c;
}
/** The work waiting for one creator. */
const workFor = (creatorId: string) =>
  rows<{ kind: string; state: string; asked_for: string }>(
    admin(),
    sql`select kind, state, asked_for::text from addon_socialcontent.work
        where creator_id = ${creatorId}::uuid order by created_at`,
  );

beforeAll(async () => {
  [owner, member] = await Promise.all([
    createTestUser('content-setup-owner'),
    createTestUser('content-setup-member'),
  ]);
  const made = await executeCommand(
    api(),
    organizationCreate,
    { businessName: 'Leaky Faucet Co' },
    human(owner),
    meta(),
  );
  ws = made.output.workspaceId;
  orgId = made.output.organizationId;
  await rows(
    admin(),
    sql`insert into app.workspace_memberships (workspace_id, user_id, role) values (${ws}, ${member.id}, 'member')`,
  );
  await rows(
    admin(),
    sql`insert into app.addon_installations (workspace_id, addon_id, state, installed_version)
        values (${ws}, 'socialcontent', 'enabled', ${socialcontentAddon.version})`,
  );
}, 60_000);
afterAll(closeTestDbs);

describe('setting up on its own', () => {
  it('shows nothing done yet, picking and filling on their own, before a reading computer is picked', async () => {
    const { setup, settings } = await as(member, 'socialcontent.overview');
    expect(settings.autoPick).toBe(true);
    expect(setup).toMatchObject({
      autoPick: true,
      autoFill: true,
      marks: {},
      readerSet: false,
      nichesPicked: 0,
      findsLeft: 0,
      networks: [{ network: 'instagram', studying: 0, byAi: 0, pickable: 0 }],
      offerLive: false,
      listsFilled: 0,
      listsAll: 11,
    });
  });

  it('lets owners and admins, not the team, turn picking on its own off and on', async () => {
    expect(await refused(as(member, 'socialcontent.settings.save', { autoPick: false }))).toBe(
      'forbidden',
    );
    expect(await as(owner, 'socialcontent.settings.save', { autoPick: false })).toMatchObject({
      autoPick: false,
    });
    expect((await as(member, 'socialcontent.overview')).setup.autoPick).toBe(false);
    // Saving something else leaves it off.
    expect((await as(owner, 'socialcontent.settings.save', { plan: {} })).autoPick).toBe(false);
    await as(owner, 'socialcontent.settings.save', { autoPick: true });
    // Picking a reading computer, and turning picking back on, tell the worker setting up may go on.
    await as(owner, 'socialcontent.settings.save', { readerUserId: owner.id });
    const saved = await rows<{ payload: Any }>(
      admin(),
      sql`select payload from app.events
          where workspace_id = ${ws} and event_type = 'socialcontent.settings.saved'
          order by occurred_at`,
    );
    expect(saved.at(-2)?.payload).toMatchObject({ pickTurnedOn: true });
    expect(saved.at(-1)?.payload).toMatchObject({ readerPicked: true, pickTurnedOn: false });
    expect((await as(member, 'socialcontent.overview')).setup.readerSet).toBe(true);
  });

  it('keeps the first time of each step it takes', async () => {
    const first = ago(2);
    await worker('socialcontent.setup.mark', { marks: { startedAt: first } });
    const { marks } = await worker('socialcontent.setup.mark', {
      marks: { startedAt: ago(0), nichesAt: ago(0) },
    });
    expect(marks.startedAt).toBe(first);
    expect(marks.nichesAt).toBeDefined();
    expect((await as(member, 'socialcontent.overview')).setup.marks.startedAt).toBe(first);
  });

  it('ticks its own niche and the 2 closest, never one about its customers’ world (decision 29)', async () => {
    const { added } = await worker('socialcontent.niches.put', {
      own: niche('Home plumbing'),
      similar: [
        niche('Homeowners', 'Your customers follow it.'),
        niche('Drain cleaning', 'The same jobs.'),
        niche('HVAC tips', 'Next door to plumbing.'),
        niche('Home improvement', 'Further out.'),
      ],
      pickClosest: 2,
    });
    expect(added).toBe(5);
    const { niches } = await as(member, 'socialcontent.niche.list');
    expect(Object.fromEntries(niches.map((n: Any) => [n.name, n.state]))).toEqual({
      'Home plumbing': 'picked',
      Homeowners: 'suggested',
      'Drain cleaning': 'picked',
      'HVAC tips': 'picked',
      'Home improvement': 'suggested',
    });
    expect((await as(member, 'socialcontent.overview')).setup.nichesPicked).toBe(3);
  });

  it('keeps each creator’s latest posts from the search, and how they do for their followers', async () => {
    await as(member, 'socialcontent.find.now');
    expect((await as(member, 'socialcontent.overview')).setup.findsLeft).toBe(3);
    const { work } = await as(owner, 'socialcontent.work.next', { reads: ['instagram'] });
    expect(work.kind).toBe('find');
    await as(owner, 'socialcontent.creators.found', {
      workId: work.id,
      found: [
        // 2%, 3% and 4% of 10,000: the middle is 3%.
        {
          handle: 'drain_doc',
          followers: 10_000,
          lastPostAt: ago(2),
          recent: recent(200, 300, 400),
        },
        { handle: 'pipe_pro', followers: 30_000, lastPostAt: ago(1), recent: recent(150, 300) },
        { handle: 'sink_sam', followers: 8_000, lastPostAt: ago(3) },
        { handle: 'tap_tess', followers: 12_000, lastPostAt: ago(5) },
        { handle: 'person_skipped', followers: 50_000, lastPostAt: ago(1) },
      ],
    });
    await as(owner, 'socialcontent.work.finish', { workId: work.id });
    expect((await creator('drain_doc')).engagement).toBe(0.03);
    // Under 3 posts with numbers says nothing yet; their posts are kept for the AI all the same.
    expect((await creator('pipe_pro')).engagement).toBeNull();
    const [kept] = await rows<{ recent: Any }>(
      admin(),
      sql`select recent from addon_socialcontent.creators where workspace_id = ${ws} and handle = 'pipe_pro'`,
    );
    expect(kept?.recent).toEqual([
      { likes: 150, comments: 0, views: null, caption: 'Tip 1' },
      { likes: 300, comments: 0, views: null, caption: 'Tip 2' },
    ]);
    // Read again from their profile with a third post, it's worked out.
    await as(owner, 'socialcontent.creator.read', {
      creatorId: (await creator('pipe_pro')).id,
      followers: 30_000,
      recent: recent(150, 300, 600),
    });
    expect((await creator('pipe_pro')).engagement).toBe(0.01);
    // Read by an older extension that doesn't send them, what was known is kept.
    await as(owner, 'socialcontent.creator.read', {
      creatorId: (await creator('pipe_pro')).id,
      followers: 31_000,
    });
    expect((await creator('pipe_pro')).engagement).toBe(0.01);
  });

  it('keeps how close the AI says each creator is, and why', async () => {
    const ids = await Promise.all(
      ['drain_doc', 'pipe_pro', 'sink_sam', 'tap_tess', 'person_skipped'].map(
        async (h) => (await creator(h)).id,
      ),
    );
    expect(
      await worker('socialcontent.creators.matched', {
        matches: ids.map((creatorId, i) => ({ creatorId, match: 9 - i, why: `Reason ${i + 1}.` })),
      }),
    ).toEqual({ kept: 5 });
    expect(await creator('drain_doc')).toMatchObject({ match: 9, matchWhy: 'Reason 1.' });
    expect(await creator('tap_tess')).toMatchObject({ match: 6 });
  });

  it('picks only suggested creators, and reads the profiles it asks for first (decision 30)', async () => {
    const skipped = await creator('person_skipped');
    await as(member, 'socialcontent.creator.decide', { creatorId: skipped.id, study: false });
    const drain = await creator('drain_doc');
    const pipe = await creator('pipe_pro');
    const tess = await creator('tap_tess');
    expect(
      await worker('socialcontent.creators.pick', {
        pick: [drain.id, pipe.id, skipped.id],
        read: [tess.id, skipped.id],
      }),
    ).toEqual({ picked: 2, swapped: 0, asked: 3 });
    expect(await creator('drain_doc')).toMatchObject({ state: 'studying', pickedBy: 'ai' });
    // One a person skipped stays skipped, and isn't read.
    expect(await creator('person_skipped')).toMatchObject({ state: 'skipped', pickedBy: 'person' });
    expect(await workFor(skipped.id)).toEqual([]);
    // The search read their profile, so their posts are read back 12 months.
    expect(await workFor(drain.id)).toEqual([
      { kind: 'posts', state: 'waiting', asked_for: 'studying' },
    ]);
    expect(await workFor(tess.id)).toEqual([
      { kind: 'profile', state: 'waiting', asked_for: 'person' },
    ]);
    const { setup } = await as(member, 'socialcontent.overview');
    expect(setup.networks).toEqual([{ network: 'instagram', studying: 2, byAi: 2, pickable: 2 }]);
    expect(setup.readsLeft).toBe(1);
  });

  it('weighs the suggested creators, not one whose profile wouldn’t read lately, and knows who it picked', async () => {
    const tess = await creator('tap_tess');
    let weigh = await creatorsToWeigh(admin(), ws, ['instagram']);
    expect(weigh.map((c) => c.shown)).toEqual(['@tap_tess', '@sink_sam']);
    expect(weigh[0]).toMatchObject({ match: 6, recentRead: false, recent: null });
    await rows(
      admin(),
      sql`update addon_socialcontent.work set state = 'failed', finished_at = now() where creator_id = ${tess.id}::uuid`,
    );
    weigh = await creatorsToWeigh(admin(), ws, ['instagram']);
    expect(weigh.map((c) => c.shown)).toEqual(['@sink_sam']);
    expect(await creatorsToWeigh(admin(), ws, [])).toEqual([]);
    expect(await studyingOn(admin(), ws)).toEqual({ instagram: 2 });
    expect((await aiPicked(admin(), ws)).map((c) => c.id).sort()).toEqual(
      [(await creator('drain_doc')).id, (await creator('pipe_pro')).id].sort(),
    );
  });

  it('swaps out only the creators it picked, stopping their reads, never one a person ticked or added (decision 31)', async () => {
    const drain = await creator('drain_doc');
    const pipe = await creator('pipe_pro');
    // Ticked by a person after the AI picked them: theirs now.
    await as(member, 'socialcontent.creator.decide', { creatorId: pipe.id, study: true });
    expect(await creator('pipe_pro')).toMatchObject({ state: 'studying', pickedBy: 'person' });
    await as(member, 'socialcontent.creator.add', {
      link: 'https://www.instagram.com/added_by_hand/',
    });
    const added = await creator('added_by_hand');
    expect(added).toMatchObject({ state: 'studying', pickedBy: 'person' });
    const why = 'Swapped out by the AI: no posts in 50 days.';
    expect(
      await worker('socialcontent.creators.pick', {
        swap: [drain.id, pipe.id, added.id].map((creatorId) => ({ creatorId, why })),
      }),
    ).toMatchObject({ picked: 0, swapped: 1 });
    expect(await creator('drain_doc')).toMatchObject({ state: 'skipped', why });
    expect(await creator('pipe_pro')).toMatchObject({ state: 'studying' });
    expect(await creator('added_by_hand')).toMatchObject({ state: 'studying' });
    expect(await workFor(drain.id)).toEqual([
      { kind: 'posts', state: 'stopped', asked_for: 'studying' },
    ]);
    // It never picks one it swapped out again.
    expect((await worker('socialcontent.creators.pick', { pick: [drain.id] })).picked).toBe(0);
  });

  it('stops while the add-on is off', async () => {
    await rows(
      admin(),
      sql`update app.addon_installations set state = 'disabled' where workspace_id = ${ws} and addon_id = 'socialcontent'`,
    );
    expect(
      await refused(worker('socialcontent.setup.mark', { marks: { writeAt: ago(0) } })),
    ).not.toBe('went through');
    await rows(
      admin(),
      sql`update app.addon_installations set state = 'enabled' where workspace_id = ${ws} and addon_id = 'socialcontent'`,
    );
  });
});
