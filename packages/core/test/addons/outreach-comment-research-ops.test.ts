/**
 * The comment research on the database (docs/outreach.md, decision 166): HandsFreeOS's own, so only its staff who may
 * change what the AI is told start one, read one or use what it found, and the database holds the same; only the
 * browser of whoever started it reads for it; what's kept of a comment is its words alone; and its guide goes in every
 * business's comments only once staff press Use it.
 */
import { asUser, rows, sql } from '@hfos/db/client';
import { workspaceMemberships } from '@hfos/db/schema';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  checkedFindings,
  commentStats,
  RESEARCH_DAYS,
  RESEARCH_POSTS_A_TAG,
  RESEARCH_TAGS,
  RESEARCH_TARGET,
  type CommentResearchOutput,
  type CommentSample,
} from '../../src/addons/outreach/comment-research';
import { outreachBusiness, refused, runAs, runAsSystem } from './outreach-fixture';

const api = () => testDbs().api.db;
const admin = () => testDbs().admin.db;
const as =
  (u: TestUser) =>
  <T>(q: ReturnType<typeof sql>) =>
    asUser(api(), u.claims, (tx) => rows<T & Record<string, unknown>>(tx, q));
async function refusal(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    const cause = (e as { cause?: { code?: string } }).cause;
    return cause?.code || (e as { code?: string }).code || String(e);
  }
  throw new Error('It was allowed.');
}

/** HandsFreeOS staff who may change what the AI is told, and the business's owner. */
let staff: TestUser;
/** HandsFreeOS staff who may not (a lead), an admin of the business. */
let lead: TestUser;
/** A member of the business, not staff. */
let member: TestUser;
let ws: string;

const get = (u: TestUser): Promise<CommentResearchOutput> =>
  runAs(u, ws, 'outreach.comment_research.get', {});
const next = (u: TestUser) => runAs(u, ws, 'outreach.comment_research.next', {});

beforeAll(async () => {
  [staff, lead, member] = await Promise.all([
    createTestUser('cres-staff'),
    createTestUser('cres-lead'),
    createTestUser('cres-member'),
  ]);
  ws = await outreachBusiness(staff, 'Comment Research Co');
  await admin()
    .insert(workspaceMemberships)
    .values([
      { workspaceId: ws, userId: lead.id, role: 'admin' },
      { workspaceId: ws, userId: member.id, role: 'member' },
    ]);
  await rows(
    admin(),
    sql`insert into platform.staff (user_id, role, display_name) values
          (${staff.id}, 'admin', 'Chris'), (${lead.id}, 'lead', 'Lee')
        on conflict (user_id) do update set role = excluded.role, status = 'active'`,
  );
}, 60_000);

afterAll(async () => {
  // No guide stays in use for the tests after this one.
  await rows(
    admin(),
    sql`update platform.comment_guides set stopped_at = now() where stopped_at is null`,
  );
  await closeTestDbs();
});

describe('the comment research', () => {
  let id: string;

  it('is for HandsFreeOS staff who may change what the AI is told, and nobody else', async () => {
    for (const u of [member, lead]) {
      expect(await refused(get(u))).toBe('outreach_research_staff');
      expect(await refused(runAs(u, ws, 'outreach.comment_research.start', {}))).toBe(
        'outreach_research_staff',
      );
      // Their browser is told there's none, and does nothing.
      expect(await next(u)).toEqual({ research: null });
    }
    expect((await get(staff)).research).toBeNull();
    expect(await next(staff)).toEqual({ research: null });
  });

  it('starts one at a time, read only by the browser of whoever started it', async () => {
    const started: CommentResearchOutput = await runAs(
      staff,
      ws,
      'outreach.comment_research.start',
      {},
    );
    expect(started.research).toMatchObject({
      state: 'reading',
      platform: 'instagram',
      mine: true,
      target: RESEARCH_TARGET,
      days: RESEARCH_DAYS,
      kept: 0,
      dropped: 0,
      posts: 0,
      findings: null,
      guide: null,
    });
    id = started.research!.id;
    expect(await refused(runAs(staff, ws, 'outreach.comment_research.start', {}))).toBe(
      'outreach_research_running',
    );
    expect(await next(staff)).toEqual({
      research: {
        id,
        tags: RESEARCH_TAGS.slice(0, 2),
        postsEach: RESEARCH_POSTS_A_TAG,
        kept: 0,
        target: RESEARCH_TARGET,
      },
    });
    expect(await next(lead)).toEqual({ research: null });
    expect(await next(member)).toEqual({ research: null });
  });

  it('is kept from everyone but that staff in the database itself', async () => {
    const mine = sql`select id from addon_outreach.comment_research where workspace_id = ${ws}`;
    expect(await as(staff)<{ id: string }>(mine)).toEqual([{ id }]);
    expect(await as(lead)(mine)).toEqual([]);
    expect(await as(member)(mine)).toEqual([]);
    // Nobody signed in reads or writes the guide's table: only its definers do.
    expect(await refusal(as(staff)(sql`select id from platform.comment_guides`))).toBe('42501');
    expect(
      await refusal(
        as(member)(sql`select private.use_comment_guide('instagram', 'Be brief.', 1, null)`),
      ),
    ).toBe('42501');
  });

  it('keeps a comment’s words alone, once, and leaves out a bot’s', async () => {
    const tag = RESEARCH_TAGS[0]!;
    const saved = await runAs(staff, ws, 'outreach.comment_research.save', {
      id,
      tag,
      posts: [
        // The browser left one out already; HandsFreeOS sorts what came again.
        {
          comments: ['Love this', '@promo_page DM me for promo', 'so good 😍 @jane.doe'],
          dropped: 1,
        },
        { comments: ['love this', 'need the recipe https://example.com/r'] },
      ],
    });
    expect(saved).toEqual({ kept: 4, dropped: 2, total: 4, reading: true });
    const kept = await rows<{ words: string; topic: string; seen: number }>(
      admin(),
      sql`select words, topic, seen from addon_outreach.comment_samples
          where research_id = ${id} order by words`,
    );
    expect(kept).toEqual([
      { words: 'Love this', topic: 'food', seen: 2 },
      { words: 'need the recipe', topic: 'food', seen: 1 },
      { words: 'so good 😍', topic: 'food', seen: 1 },
    ]);
    const card = (await get(staff)).research!;
    expect(card).toMatchObject({ kept: 4, dropped: 2, posts: 2, state: 'reading' });
    // The hashtag read isn't read again.
    expect((await next(staff)).research.tags).toEqual(RESEARCH_TAGS.slice(1, 3));
    // A hashtag that isn't the research's is refused; someone who didn't start it adds nothing.
    expect(
      await refused(
        runAs(staff, ws, 'outreach.comment_research.save', { id, tag: 'crypto', posts: [] }),
      ),
    ).toBe('outreach_research_tag');
    expect(
      await runAs(member, ws, 'outreach.comment_research.save', {
        id,
        tag,
        posts: [{ comments: ['nice one'] }],
      }),
    ).toEqual({ kept: 0, dropped: 0, total: 0, reading: false });
    expect((await get(staff)).research).toMatchObject({ kept: 4, posts: 2 });
  });

  it('stopped with too few to learn from is only stopped, and another can start', async () => {
    expect(await refused(runAs(lead, ws, 'outreach.comment_research.stop', { id }))).toBe(
      'outreach_research_staff',
    );
    const stopped: CommentResearchOutput = await runAs(
      staff,
      ws,
      'outreach.comment_research.stop',
      { id },
    );
    expect(stopped.research).toMatchObject({ id, state: 'stopped', findings: null });
    expect(await next(staff)).toEqual({ research: null });
    const again: CommentResearchOutput = await runAs(
      staff,
      ws,
      'outreach.comment_research.start',
      {},
    );
    expect(again.research!.id).not.toBe(id);
    id = again.research!.id;
  });

  it('never keeps more than it set out to, and is summed up once it’s full', async () => {
    await rows(
      admin(),
      sql`update addon_outreach.comment_research set kept = ${RESEARCH_TARGET - 1} where id = ${id}`,
    );
    const saved = await runAs(staff, ws, 'outreach.comment_research.save', {
      id,
      tag: RESEARCH_TAGS[1]!,
      posts: [{ comments: ['clean build', 'that paint though', 'so sick'] }],
    });
    expect(saved).toEqual({ kept: 1, dropped: 0, total: RESEARCH_TARGET, reading: false });
    expect((await get(staff)).research).toMatchObject({ state: 'summing', kept: RESEARCH_TARGET });
    expect(await next(staff)).toEqual({ research: null });
    // Nothing to use until it's summed up.
    expect(
      await refused(runAs(staff, ws, 'outreach.comment_research.use', { id, use: true })),
    ).toBe('outreach_research_not_done');
  });

  it('keeps what the worker found, with the guide made from it', async () => {
    const samples: CommentSample[] = [
      { words: 'clean build', topic: 'cars', seen: 3 },
      { words: 'need this', topic: 'food', seen: 2 },
    ];
    const findings = checkedFindings(
      commentStats(samples),
      {
        patterns: ['Most are two or three plain words.'],
        kinds: [{ topic: 'cars', how: 'Short praise.', examples: ['clean build'] }],
      },
      samples,
    );
    expect(await runAsSystem(ws, 'outreach.comment_research.sum', { id, findings })).toEqual({
      id,
      state: 'done',
    });
    const card = (await get(staff)).research!;
    expect(card.state).toBe('done');
    expect(card.findings).toEqual(findings);
    expect(card.guide).toContain('From 5 real comments under public Instagram posts');
    expect(card.guide).toContain('- Most are two or three plain words.');
    // Summed up once: a second answer changes nothing.
    expect(await runAsSystem(ws, 'outreach.comment_research.sum', { id, findings: null })).toEqual({
      id,
      state: 'done',
    });
  });

  it('goes in every business’s comments only once staff say so, and comes out again', async () => {
    expect(await refused(runAs(lead, ws, 'outreach.comment_research.use', { id, use: true }))).toBe(
      'outreach_research_staff',
    );
    const used: CommentResearchOutput = await runAs(staff, ws, 'outreach.comment_research.use', {
      id,
      use: true,
    });
    expect(used.inUse).toMatchObject({ platform: 'instagram', comments: 5, thisOne: true });
    expect(used.inUse!.guide).toBe(used.research!.guide);
    const [live] = await rows<{ guide: string; research_id: string; used_by: string }>(
      admin(),
      sql`select guide, research_id, used_by from platform.comment_guides
          where platform = 'instagram' and stopped_at is null`,
    );
    expect(live).toEqual({ guide: used.research!.guide, research_id: id, used_by: staff.id });
    // Used again, it takes its own place: one in use a network.
    await runAs(staff, ws, 'outreach.comment_research.use', { id, use: true });
    const [inUse] = await rows<{ n: number }>(
      admin(),
      sql`select count(*)::int as n from platform.comment_guides
          where platform = 'instagram' and stopped_at is null`,
    );
    expect(inUse!.n).toBe(1);
    const out: CommentResearchOutput = await runAs(staff, ws, 'outreach.comment_research.use', {
      id,
      use: false,
    });
    expect(out.inUse).toBeNull();
  });
});
