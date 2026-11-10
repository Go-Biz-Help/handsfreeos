/**
 * AI Social Media Content Creator on the database (docs/socialcontent.md): its tables are mirrored exactly; owners and
 * admins pick whose computer reads; anyone on the team ticks niches and creators; the reading computer, and only it,
 * takes the work one thing at a time, saves who it found and their posts, and the posts that beat their neighbours
 * come out as standouts; the worker queues the weekly read and keeps the AI's notes, the Playbook and the ideas;
 * watching videos waits for an owner to try it or turn it on; and none of it works while the add-on is off.
 */
import { randomUUID } from 'node:crypto';
import { getTableColumns, getTableName } from 'drizzle-orm';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { socialcontentAddon } from '../../src/addons/socialcontent/manifest';
import { socialcontentAddonServer } from '../../src/addons/socialcontent/server';
import { SOCIALCONTENT_TABLES } from '../../src/addons/socialcontent/tables';
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

/** As a person, in the business. */
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
/** As the worker, acting for the add-on. */
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

let owner: TestUser;
let member: TestUser;
let ws: string;
let orgId: string;

/** The reading computer's next thing, or null. */
async function nextWork(): Promise<Any> {
  return (await as(owner, 'socialcontent.work.next', { reads: ['instagram'] })).work;
}

beforeAll(async () => {
  [owner, member] = await Promise.all([
    createTestUser('content-owner'),
    createTestUser('content-member'),
  ]);
  const made = await executeCommand(
    api(),
    organizationCreate,
    { businessName: 'Pipe Dreams Plumbing' },
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

describe('AI Social Media Content Creator’s tables', () => {
  it('are mirrored in Drizzle exactly, and named in the manifest', async () => {
    for (const table of Object.values(SOCIALCONTENT_TABLES)) {
      const live = await rows<{ column_name: string }>(
        admin(),
        sql`select column_name from information_schema.columns
            where table_schema = 'addon_socialcontent' and table_name = ${getTableName(table)}`,
      );
      expect(
        Object.values(getTableColumns(table))
          .map((c) => c.name)
          .sort(),
        getTableName(table),
      ).toEqual(live.map((c) => c.column_name).sort());
    }
    const tables = await rows<{ name: string }>(
      admin(),
      sql`select c.relname::text as name from pg_class c
          where c.relnamespace = 'addon_socialcontent'::regnamespace and c.relkind = 'r' order by 1`,
    );
    expect(tables.map((t) => t.name)).toEqual([...(socialcontentAddon.tables ?? [])].sort());
  });
});

describe('studying creators', () => {
  let nicheId: string;
  let creatorId: string;

  it('needs a reading computer before it looks for anyone', async () => {
    await as(member, 'socialcontent.niche.add', { name: 'Home plumbing' });
    expect(await refused(as(member, 'socialcontent.find.now'))).toBe('socialcontent_no_reader');
    const shown = await as(member, 'socialcontent.overview');
    expect(shown).toMatchObject({
      mayManage: false,
      readerIsMe: false,
      settings: { networks: ['instagram'], readerUserId: null },
    });
  });

  it('lets owners and admins, not the team, pick whose computer reads', async () => {
    expect(
      await refused(as(member, 'socialcontent.settings.save', { readerUserId: member.id })),
    ).toBe('forbidden');
    // A network the extension doesn't read yet can't be picked.
    expect(
      await refused(
        as(owner, 'socialcontent.settings.save', { networks: ['instagram', 'tiktok'] }),
      ),
    ).toBe('socialcontent_network_not_ready');
    const saved = await as(owner, 'socialcontent.settings.save', { readerUserId: owner.id });
    expect(saved).toMatchObject({ readerUserId: owner.id, networks: ['instagram'] });
    expect((await as(owner, 'socialcontent.overview')).readerIsMe).toBe(true);
  });

  it('keeps one niche of a name, and searches each picked one once at a time', async () => {
    expect(await refused(as(member, 'socialcontent.niche.add', { name: 'home PLUMBING' }))).toBe(
      'socialcontent_niche_taken',
    );
    const { niches } = await as(member, 'socialcontent.niche.list');
    expect(niches).toHaveLength(1);
    expect(niches[0]).toMatchObject({ name: 'Home plumbing', state: 'picked', addedBy: 'person' });
    nicheId = niches[0].id;
    expect(await as(member, 'socialcontent.find.now')).toMatchObject({
      asked: 1,
      networks: ['instagram'],
      niches: 1,
    });
    // The same search is already waiting.
    expect((await as(member, 'socialcontent.find.now')).asked).toBe(0);
  });

  it('gives the work only to the reading computer', async () => {
    expect(await refused(as(member, 'socialcontent.work.next', { reads: ['instagram'] }))).toBe(
      'socialcontent_not_reader',
    );
    expect((await as(owner, 'socialcontent.work.next', { reads: ['tiktok'] })).work).toBeNull();
  });

  it('suggests the creators a search finds who did well, and keeps the rest aside', async () => {
    const work = await nextWork();
    expect(work).toMatchObject({
      kind: 'find',
      network: 'instagram',
      niche: { id: nicheId, name: 'Home plumbing', searches: ['Home plumbing'] },
      known: [],
    });
    // Asked again (Chrome restarted), the same work comes back.
    expect((await nextWork()).id).toBe(work.id);
    const found = await as(owner, 'socialcontent.creators.found', {
      workId: work.id,
      found: [
        { handle: 'PipeQueen', name: 'Pipe Queen', followers: 48_000, lastPostAt: ago(3) },
        { handle: 'tiny_drips', followers: 900, lastPostAt: ago(2) },
        { handle: 'gone_quiet', followers: 80_000, lastPostAt: ago(90) },
      ],
    });
    expect(found).toEqual({ suggested: 1, didntFit: 2 });
    // What it's doing, as it does it: the extension's account, beside HandsFreeOS's own counts.
    await as(owner, 'socialcontent.work.progress', {
      workId: work.id,
      progress: {
        now: 'Searching Instagram for Home plumbing',
        searched: ['Home plumbing'],
        searches: 1,
        accounts: 7,
        profiles: 3,
      },
    });
    expect(
      await refused(
        as(member, 'socialcontent.work.progress', { workId: work.id, progress: { accounts: 1 } }),
      ),
    ).toBe('socialcontent_not_reader');
    const seen = await as(member, 'socialcontent.overview', {});
    expect(seen.settings.readerSeenAt).not.toBeNull();
    expect(seen.work.find((x: Any) => x.id === work.id)?.progress).toEqual({
      now: 'Searching Instagram for Home plumbing',
      searched: ['Home plumbing'],
      searches: 1,
      accounts: 7,
      profiles: 3,
      suggested: 1,
      didntFit: 2,
    });
    await as(owner, 'socialcontent.work.finish', { workId: work.id });
    const { creators } = await as(member, 'socialcontent.creator.list', { state: 'suggested' });
    expect(creators.map((c: Any) => c.handle)).toEqual(['pipequeen']);
    expect(creators[0]).toMatchObject({ shown: '@pipequeen', nicheId, foundBy: 'search' });
    creatorId = creators[0].id;
    expect(await nextWork()).toBeNull();
  });

  it('reads a ticked creator’s posts, and weighs each post against its neighbours', async () => {
    // A search asked for first still waits: reading the creator someone ticks goes before it.
    expect((await as(member, 'socialcontent.find.now')).asked).toBe(1);
    // Where the computer has no room left today for searches, it isn't given one.
    expect(
      (await as(owner, 'socialcontent.work.next', { reads: ['instagram'], searchOn: [] })).work,
    ).toBeNull();
    await as(member, 'socialcontent.creator.decide', { creatorId, study: true });
    // The search read their profile already, so only their posts are asked for.
    const w = await nextWork();
    expect(w).toMatchObject({ kind: 'posts', creator: { id: creatorId, handle: 'pipequeen' } });
    // Read back 12 months the first time.
    expect(Date.parse(w.since)).toBeLessThan(Date.now() - 360 * DAY);
    expect(await refused(as(member, 'socialcontent.posts.save', { creatorId, posts: [] }))).toBe(
      'socialcontent_not_reader',
    );
    // The owner's example: one post with 100 likes among posts with 20 to 50.
    const saved = await as(owner, 'socialcontent.posts.save', {
      creatorId,
      posts: [20, 35, 100, 50, 30].map((likes, i) => ({
        postKey: `C${i}`,
        link: `https://www.instagram.com/p/C${i}/`,
        postedAt: ago(40 - i),
        kind: 'video',
        likes,
        comments: 0,
      })),
    });
    expect(saved).toMatchObject({ saved: 5, standouts: 1 });
    expect(saved.newStandouts).toHaveLength(1);
    await as(owner, 'socialcontent.work.finish', { workId: w.id });
    // Then the search.
    const search = await nextWork();
    expect(search).toMatchObject({ kind: 'find', niche: { id: nicheId } });
    await as(owner, 'socialcontent.work.finish', { workId: search.id });
    expect(await nextWork()).toBeNull();
    await as(owner, 'socialcontent.creator.read', { creatorId, followers: 49_000 });
    const { posts } = await as(member, 'socialcontent.post.list', { standoutsOnly: true });
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({
      postKey: 'C2',
      likes: 100,
      standout: true,
      standoutOn: 'engagement',
      creatorName: 'Pipe Queen',
    });
    expect(posts[0].engagementTimes).toBeGreaterThan(2.5);
    const [studied] = (await as(member, 'socialcontent.creator.list', { state: 'studying' }))
      .creators;
    expect(studied).toMatchObject({ postsCount: 5, standoutsCount: 1, followers: 49_000 });
    expect(studied.postsReadAt).not.toBeNull();
  });

  it('saves a post again with its newer numbers, and weighs them all again', async () => {
    expect(await as(member, 'socialcontent.read.now', { creatorId })).toEqual({ asked: 1 });
    const w = await nextWork();
    expect(w.kind).toBe('posts');
    const saved = await as(owner, 'socialcontent.posts.save', {
      creatorId,
      posts: [
        {
          postKey: 'C4',
          link: 'https://www.instagram.com/p/C4/',
          postedAt: ago(36),
          kind: 'video',
          likes: 300,
          comments: 0,
        },
      ],
    });
    // C4 grew to 300 and stands out now too; C2 still does.
    expect(saved).toMatchObject({ saved: 1, standouts: 2 });
    await as(owner, 'socialcontent.work.finish', { workId: w.id });
    const { posts } = await as(member, 'socialcontent.post.list', { creatorId });
    expect(posts).toHaveLength(5);
  });

  it('studies someone added from a link straight away, whatever their size', async () => {
    expect(
      await refused(as(member, 'socialcontent.creator.add', { link: 'https://example.com/hank' })),
    ).toBe('socialcontent_link_unreadable');
    const added = await as(member, 'socialcontent.creator.add', {
      link: 'instagram.com/Handy_Hank',
    });
    expect(added).toMatchObject({
      shown: '@handy_hank',
      state: 'studying',
      foundBy: 'person',
      reading: true,
    });
    const kinds: string[] = [];
    for (let w = await nextWork(); w; w = await nextWork()) {
      kinds.push(w.kind);
      if (w.kind === 'profile')
        await as(owner, 'socialcontent.creator.read', {
          creatorId: added.id,
          name: 'Handy Hank',
          followers: 1_200,
          lastPostAt: ago(1),
        });
      else await as(owner, 'socialcontent.posts.save', { creatorId: added.id, posts: [] });
      await as(owner, 'socialcontent.work.finish', { workId: w.id });
    }
    expect(kinds.sort()).toEqual(['posts', 'profile']);
    const { creators } = await as(member, 'socialcontent.creator.list', { state: 'studying' });
    expect(creators.find((c: Any) => c.id === added.id)).toMatchObject({
      name: 'Handy Hank',
      followers: 1_200,
      reading: false,
    });
  });

  it('queues the weekly read for every creator studied, and lets anyone stop it', async () => {
    expect(await worker('socialcontent.work.queue', { kind: 'posts', askedFor: 'weekly' })).toEqual(
      { asked: 2 },
    );
    // Queued twice, nothing is asked twice.
    expect(await worker('socialcontent.work.queue', { kind: 'posts', askedFor: 'weekly' })).toEqual(
      { asked: 0 },
    );
    expect((await as(member, 'socialcontent.overview')).counts.waiting).toBe(2);
    for (let w = await nextWork(); w; w = await nextWork()) {
      expect(w.kind).toBe('posts');
      await as(member, 'socialcontent.work.stop', { workId: w.id });
    }
    expect((await as(member, 'socialcontent.overview')).counts.waiting).toBe(0);
  });

  it('keeps the AI’s notes on a standout, then the Playbook and ideas from them', async () => {
    const { posts } = await as(member, 'socialcontent.post.list', { standoutsOnly: true });
    const c2 = posts.find((p: Any) => p.postKey === 'C2');
    expect(c2).toMatchObject({ notes: null, watched: null, watching: false });
    const notes = {
      why: 'It asks the question people have, unlike the posts around it.',
      hook: 'A question',
      format: 'Short how to',
      topic: 'Leaks',
      techniques: ['Open with a question'],
      useIt: 'Answer the question your customers ask most.',
    };
    expect(await refused(as(member, 'socialcontent.post.note', { postId: c2.id, notes }))).toBe(
      'forbidden',
    );
    await worker('socialcontent.post.note', { postId: c2.id, notes });
    const noted = (await as(member, 'socialcontent.post.list', { standoutsOnly: true })).posts;
    expect(noted.find((p: Any) => p.id === c2.id).notes).toEqual(notes);

    const before = await as(member, 'socialcontent.playbook.get');
    expect(before.playbook).toMatchObject({ writtenAt: null, sections: [], noted: 1 });
    await worker('socialcontent.playbook.put', {
      summary: 'Questions work.',
      sections: [
        {
          title: 'Hooks',
          items: [{ do: 'Ask a question.', why: 'People stop.', examples: [c2.id] }],
        },
      ],
      standouts: 1,
    });
    const book = await as(member, 'socialcontent.playbook.get');
    expect(book.playbook).toMatchObject({ summary: 'Questions work.', standouts: 1, noted: 1 });
    expect(book.playbook.writtenAt).not.toBeNull();
    expect(book.examples).toEqual([
      expect.objectContaining({ id: c2.id, creatorShown: '@pipequeen', kind: 'video' }),
    ]);

    const idea = (title: string) => ({
      title,
      hook: 'Got a leak?',
      format: 'Short how to',
      network: 'instagram',
      outline: 'Ask.\nAnswer.',
      why: 'Questions work.',
      basedOn: [c2.id],
    });
    expect(
      await worker('socialcontent.ideas.put', { ideas: [idea('Leak or not?'), idea('One fix')] }),
    ).toEqual({ added: 2 });
    const listed = await as(member, 'socialcontent.idea.list');
    expect(listed.ideas.map((i: Any) => i.state)).toEqual(['new', 'new']);
    expect(listed.examples.map((e: Any) => e.id)).toEqual([c2.id]);
    const first = listed.ideas[0];
    expect(
      await as(member, 'socialcontent.idea.decide', { ideaId: first.id, state: 'saved' }),
    ).toMatchObject({
      id: first.id,
      state: 'saved',
    });
    expect((await as(member, 'socialcontent.idea.list', { state: 'saved' })).ideas).toHaveLength(1);
    await as(member, 'socialcontent.idea.decide', { ideaId: first.id, state: 'new' });
    expect((await as(member, 'socialcontent.idea.list', { state: 'saved' })).ideas).toHaveLength(0);
    expect(
      await refused(
        as(member, 'socialcontent.idea.decide', { ideaId: randomUUID(), state: 'used' }),
      ),
    ).toBe('not_found');
  });

  it('watches standout videos only when an owner tries it or turns it on', async () => {
    expect(await refused(as(member, 'socialcontent.watch.try'))).toBe('forbidden');
    // C2 and C4 are standout videos: both are asked for, once.
    expect(await as(owner, 'socialcontent.watch.try')).toEqual({ asked: 2 });
    expect(await refused(as(owner, 'socialcontent.watch.try'))).toBe('socialcontent_no_videos');
    const { posts } = await as(member, 'socialcontent.post.list', { standoutsOnly: true });
    expect(posts.every((p: Any) => p.watching)).toBe(true);
    const w = await nextWork();
    expect(w).toMatchObject({ kind: 'watch', post: { id: expect.any(String) } });
    const watched = {
      hook: 'A question to camera.',
      seen: 'A plumber under a sink.',
      heard: 'They ask about leaks.',
      pacing: 'Quick cuts.',
      why: 'It asks first.',
      techniques: ['Ask to camera'],
    };
    await worker('socialcontent.post.watched', { postId: w.post.id, watched });
    await as(owner, 'socialcontent.work.finish', { workId: w.id });
    const after = (await as(member, 'socialcontent.post.list', { standoutsOnly: true })).posts;
    expect(after.find((p: Any) => p.id === w.post.id)).toMatchObject({ watched, watching: false });
    const other = await nextWork();
    expect(other.kind).toBe('watch');
    await as(member, 'socialcontent.work.stop', { workId: other.id });

    // Turned on, a new standout video is watched as it's found.
    expect(await refused(as(member, 'socialcontent.settings.save', { watchVideos: true }))).toBe(
      'forbidden',
    );
    expect(await as(owner, 'socialcontent.settings.save', { watchVideos: true })).toMatchObject({
      watchVideos: true,
    });
    const saved = await as(owner, 'socialcontent.posts.save', {
      creatorId,
      posts: [
        {
          postKey: 'C9',
          link: 'https://www.instagram.com/reel/C9/',
          postedAt: ago(37),
          kind: 'video',
          likes: 900,
          comments: 0,
        },
      ],
    });
    expect(saved.newStandouts).toHaveLength(1);
    const next = await nextWork();
    expect(next).toMatchObject({
      kind: 'watch',
      post: { id: saved.newStandouts[0], postKey: 'C9' },
    });
    await as(member, 'socialcontent.work.stop', { workId: next.id });
    await as(owner, 'socialcontent.settings.save', { watchVideos: false });
  });

  it('stops while the add-on is off', async () => {
    await rows(
      admin(),
      sql`update app.addon_installations set state = 'disabled' where workspace_id = ${ws} and addon_id = 'socialcontent'`,
    );
    try {
      expect(await refused(as(member, 'socialcontent.overview'))).toBe('addon_inactive');
      expect(await refused(nextWork())).toBe('addon_inactive');
      expect(
        await refused(worker('socialcontent.work.queue', { kind: 'find', askedFor: 'monthly' })),
      ).toBe('addon_inactive');
    } finally {
      await rows(
        admin(),
        sql`update app.addon_installations set state = 'enabled' where workspace_id = ${ws} and addon_id = 'socialcontent'`,
      );
    }
  });
});

describe('the business’s own niche', () => {
  const niche = (name: string, why: string | null = null) => ({
    name,
    why,
    searches: { instagram: [`#${name.replace(/\W/g, '').toLowerCase()}`] },
  });

  it('keeps the AI’s own niche, and puts a new one in its place once the old one is skipped', async () => {
    // Studying creators above added "Home plumbing" by hand; the AI's own niche is kept, ticked, beside it.
    await worker('socialcontent.niches.put', {
      own: niche('Home services growth'),
      similar: [niche('Local trades marketing', 'Your customers follow it.')],
    });
    let { niches } = await as(member, 'socialcontent.niche.list');
    const old = niches.find((n: Any) => n.own);
    expect(old).toMatchObject({ name: 'Home services growth', state: 'picked' });
    // Suggested again while it's still theirs: it stays their own.
    await worker('socialcontent.niches.put', { own: niche('AI, CRM and automation'), similar: [] });
    ({ niches } = await as(member, 'socialcontent.niche.list'));
    expect(niches.filter((n: Any) => n.own).map((n: Any) => n.name)).toEqual([
      'Home services growth',
    ]);
    // Skipped (the owner: "I really need to grow as my niche"), the next suggestion takes its place.
    await as(member, 'socialcontent.niche.decide', { nicheId: old.id, state: 'skipped' });
    await worker('socialcontent.niches.put', {
      own: niche('AI, CRM and automation'),
      similar: [niche('SaaS growth', 'Software businesses post about the same things.')],
    });
    ({ niches } = await as(member, 'socialcontent.niche.list'));
    expect(niches.find((n: Any) => n.own)).toMatchObject({
      name: 'AI, CRM and automation',
      state: 'picked',
    });
    expect(niches.find((n: Any) => n.id === old.id)).toMatchObject({
      own: false,
      state: 'skipped',
    });
    expect(niches.find((n: Any) => n.name === 'SaaS growth')).toMatchObject({ state: 'suggested' });
    // Skipped again, and the AI names one already kept as its own: that one is theirs now, ticked.
    const second = niches.find((n: Any) => n.own);
    await as(member, 'socialcontent.niche.decide', { nicheId: second.id, state: 'skipped' });
    await worker('socialcontent.niches.put', { own: niche('SaaS growth'), similar: [] });
    ({ niches } = await as(member, 'socialcontent.niche.list'));
    expect(niches.filter((n: Any) => n.own).map((n: Any) => [n.name, n.state])).toEqual([
      ['SaaS growth', 'picked'],
    ]);
    expect(niches.find((n: Any) => n.id === second.id)).toMatchObject({
      own: false,
      state: 'skipped',
    });
  });
});

describe('creators whose profile didn’t say when they last posted', () => {
  /** The next search for creators, passing over (finishing) anything else waiting first. */
  async function findWork(): Promise<Any> {
    for (let i = 0; i < 6; i++) {
      const w = await nextWork();
      if (!w) {
        await as(member, 'socialcontent.find.now');
        continue;
      }
      if (w.kind === 'find') return w;
      await as(owner, 'socialcontent.work.finish', { workId: w.id });
    }
    throw new Error('No search for creators came.');
  }

  it('reads them again on the next search, and suggests them once they did well', async () => {
    const first = await findWork();
    expect(
      await as(owner, 'socialcontent.creators.found', {
        workId: first.id,
        found: [
          { handle: 'no_date_yet', followers: 29_000, lastPostAt: null },
          { handle: 'small_no_date', followers: 900, lastPostAt: null },
        ],
      }),
    ).toEqual({ suggested: 0, didntFit: 2 });
    await as(owner, 'socialcontent.work.finish', { workId: first.id });
    // The next search passes over everyone known, but the one with followers enough whose date wasn't known.
    const again = await findWork();
    expect(again.known).toEqual(expect.arrayContaining(['small_no_date', 'pipequeen']));
    expect(again.known).not.toContain('no_date_yet');
    expect(
      await as(owner, 'socialcontent.creators.found', {
        workId: again.id,
        found: [{ handle: 'no_date_yet', followers: 29_000, lastPostAt: ago(4) }],
      }),
    ).toEqual({ suggested: 1, didntFit: 0 });
    await as(owner, 'socialcontent.work.finish', { workId: again.id });
    const { creators } = await as(member, 'socialcontent.creator.list', { state: 'suggested' });
    expect(creators.map((c: Any) => c.handle)).toContain('no_date_yet');
  });
});

describe('the business’s own posts', () => {
  const written = (over: Record<string, unknown> = {}) => ({
    title: 'Is that drip a leak?',
    format: 'text',
    hook: 'Got a drip?',
    words: 'Here’s how to tell a drip from a leak.',
    hashtags: ['plumbing'],
    slides: [],
    script: null,
    picture: null,
    pictureWay: 'own',
    ...over,
  });
  let linkedinId: string;
  let facebookId: string;

  beforeAll(async () => {
    // Its kind of record, as turning it on makes it (the business above was put in straight).
    for (const k of socialcontentAddon.recordKinds ?? [])
      await rows(
        admin(),
        sql`insert into app.custom_record_types (workspace_id, key, singular, plural, name_label, icon, position,
              addon_id, write_permission)
            values (${ws}, ${k.key}, ${k.singular}, ${k.plural}, ${k.nameLabel ?? 'Name'}, ${k.icon ?? 'box'}, 900,
              'socialcontent', ${k.writePermission})`,
      );
  });

  it('lets owners and admins, not the team, set the plan and the Facebook Page', async () => {
    expect(
      await refused(
        as(member, 'socialcontent.settings.save', {
          plan: { linkedin: { perWeek: 5, time: '08:00' } },
        }),
      ),
    ).toBe('forbidden');
    const saved = await as(owner, 'socialcontent.settings.save', {
      plan: { linkedin: { perWeek: 5, time: '07:30' } },
      facebookPage: 'https://www.facebook.com/pipedreams',
      facebookWhere: ['profile', 'page'],
    });
    expect(saved).toMatchObject({
      plan: { linkedin: { perWeek: 5, time: '07:30' }, instagram: { perWeek: 3 } },
      facebookPage: 'https://www.facebook.com/pipedreams',
      facebookWhere: ['profile', 'page'],
    });
    const cal = await as(member, 'socialcontent.calendar.get');
    expect(cal.plan.linkedin).toEqual({ perWeek: 5, time: '07:30' });
    expect(cal.filledAt).toBeNull();
    // Five a week on LinkedIn is every weekday in the two weeks shown, none of them today.
    const linkedin = cal.open.filter((o: Any) => o.network === 'linkedin');
    expect(linkedin.length).toBeGreaterThanOrEqual(9);
    expect(linkedin.some((o: Any) => o.date === cal.today)).toBe(false);
  });

  it('keeps what the AI writes as a Social post waiting for an OK, on its day, and marks its idea used', async () => {
    const cal = await as(member, 'socialcontent.calendar.get');
    const slot = cal.open.find((o: Any) => o.network === 'linkedin');
    const [idea] = (await as(member, 'socialcontent.idea.list', { state: 'new' })).ideas;
    expect(
      await refused(
        as(member, 'socialcontent.content.put', { network: 'linkedin', post: written() }),
      ),
    ).toBe('forbidden');
    const made = await worker('socialcontent.content.put', {
      network: 'linkedin',
      ideaId: idea.id,
      postAt: new Date(slot.at).toISOString(),
      post: written(),
      askedBy: member.id,
    });
    expect(made).toMatchObject({ created: true });
    linkedinId = made.postId;
    const post = await as(member, 'socialcontent.content.get', { postId: linkedinId });
    expect(post).toMatchObject({
      title: 'Is that drip a leak?',
      network: 'linkedin',
      format: 'text',
      state: 'draft',
      ideaId: idea.id,
      stillNeeds: null,
    });
    const after = await as(member, 'socialcontent.calendar.get');
    expect(after.posts.map((p: Any) => p.id)).toContain(linkedinId);
    expect(after.open).not.toContainEqual(
      expect.objectContaining({ network: 'linkedin', date: slot.date }),
    );
    expect(
      (await as(member, 'socialcontent.idea.list', { state: 'used' })).ideas.map((i: Any) => i.id),
    ).toContain(idea.id);
    // It's a record like any other, of the add-on's kind.
    const [rec] = await rows<{ name: string; key: string }>(
      admin(),
      sql`select r.name, t.key from app.custom_records r join app.custom_record_types t on t.id = r.type_id
          where r.id = ${linkedinId}`,
    );
    expect(rec).toEqual({ name: 'Is that drip a leak?', key: 'socialcontent_post' });
  });

  it('OKs a post with everything it needs, and takes the OK back when it changes', async () => {
    const okd = await as(member, 'socialcontent.content.approve', { postId: linkedinId });
    expect(okd).toMatchObject({ state: 'ready' });
    expect(okd.approvedAt).not.toBeNull();
    const changed = await as(member, 'socialcontent.content.save', {
      postId: linkedinId,
      title: 'Drip or leak?',
      words: 'A drip or a leak? Here’s how to tell.',
    });
    expect(changed).toMatchObject({ title: 'Drip or leak?', state: 'draft', approvedAt: null });
    const [rec] = await rows<{ name: string }>(
      admin(),
      sql`select name from app.custom_records where id = ${linkedinId}`,
    );
    expect(rec!.name).toBe('Drip or leak?');
    // Saving with nothing changed keeps an OK.
    await as(member, 'socialcontent.content.approve', { postId: linkedinId });
    expect(
      await as(member, 'socialcontent.content.save', {
        postId: linkedinId,
        title: 'Drip or leak?',
      }),
    ).toMatchObject({ state: 'ready' });
    expect(
      await as(member, 'socialcontent.content.approve', { postId: linkedinId, ok: false }),
    ).toMatchObject({
      state: 'draft',
    });
  });

  it('won’t OK a post still missing something, and says what', async () => {
    const cal = await as(member, 'socialcontent.calendar.get');
    const slot = cal.open.find((o: Any) => o.network === 'facebook');
    const made = await worker('socialcontent.content.put', {
      network: 'facebook',
      postAt: new Date(slot.at).toISOString(),
      post: written({
        title: 'Winter pipes',
        format: 'photo',
        pictureWay: 'design',
        picture: 'A frozen pipe.',
      }),
    });
    facebookId = made.postId;
    const post = await as(member, 'socialcontent.content.get', { postId: facebookId });
    // Facebook posts go where Settings says, and a picture post waits for its picture.
    expect(post).toMatchObject({ facebookWhere: ['profile', 'page'], pictureState: 'waiting' });
    expect(post.stillNeeds).toMatch(/no picture/);
    expect(await refused(as(member, 'socialcontent.content.approve', { postId: facebookId }))).toBe(
      'socialcontent_post_not_ready',
    );
    // A day that has passed can't be picked to OK it.
    await as(member, 'socialcontent.content.save', { postId: linkedinId, postAt: ago(1) });
    expect(await refused(as(member, 'socialcontent.content.approve', { postId: linkedinId }))).toBe(
      'socialcontent_post_not_ready',
    );
    await as(member, 'socialcontent.content.save', {
      postId: linkedinId,
      postAt: new Date(cal.open.find((o: Any) => o.network === 'linkedin').at).toISOString(),
    });
  });

  it('OKs the week: every post ready to go, and says which still need something', async () => {
    const week = await as(member, 'socialcontent.content.approve_week');
    expect(week.approved).toBe(1);
    expect(week.notReady).toEqual([
      expect.objectContaining({
        postId: facebookId,
        title: 'Winter pipes',
        needs: expect.stringMatching(/no picture/),
      }),
    ]);
    expect((await as(member, 'socialcontent.content.get', { postId: linkedinId })).state).toBe(
      'ready',
    );
  });

  it('skips a post so its day is open again, and brings it back', async () => {
    const before = await as(member, 'socialcontent.content.get', { postId: facebookId });
    const skipped = await as(member, 'socialcontent.content.skip', { postId: facebookId });
    expect(skipped.state).toBe('skipped');
    const day = (await as(member, 'socialcontent.calendar.get')).open.filter(
      (o: Any) => o.network === 'facebook',
    );
    expect(day.map((o: Any) => Date.parse(o.at))).toContain(Date.parse(before.postAt));
    expect(await refused(as(member, 'socialcontent.content.approve', { postId: facebookId }))).toBe(
      'socialcontent_post_not_ready',
    );
    expect(
      (await as(member, 'socialcontent.content.skip', { postId: facebookId, skip: false })).state,
    ).toBe('draft');
  });

  it('notes when the calendar was filled, and when it fills again', async () => {
    await worker('socialcontent.calendar.filled', { written: 2 });
    const cal = await as(member, 'socialcontent.calendar.get');
    expect(cal.filledAt).not.toBeNull();
    expect(Date.parse(cal.nextFillAt) - Date.parse(cal.filledAt)).toBe(7 * DAY);
    const { posts } = await as(member, 'socialcontent.content.list');
    expect(posts.map((p: Any) => p.id)).toEqual(expect.arrayContaining([linkedinId, facebookId]));
  });
});
