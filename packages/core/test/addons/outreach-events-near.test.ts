/**
 * Events near you on Alignable (docs/outreach.md decision 112, the owner's pick 13a): once a week the person's computer
 * reads the events in their town, up to 5 it hasn't read before, and their hosts and guests are kept as found for the
 * AI to check. It never signs them up. Each person's own.
 */
import { rows, sql } from '@hfos/db/client';
import { workspaceMemberships } from '@hfos/db/schema';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EVENTS_KEPT_MOST, onAlignable } from '../../src/addons/outreach/events-near';
import { findFact } from '../../src/addons/outreach/finds';
import { computerOn, outreachBusiness, refused, runAs } from './outreach-fixture';

const admin = () => testDbs().admin.db;

afterAll(closeTestDbs);

describe('events near you, in words', () => {
  it('says how someone was found at one', () => {
    expect(
      findFact({
        platform: 'alignable',
        how: 'event',
        words: 'Spring Business Mixer',
        place: 'Austin, TX',
      }),
    ).toBe('Hosting or going to the Alignable event “Spring Business Mixer” in Austin, TX');
    expect(findFact({ platform: 'alignable', how: 'event', words: 'Coffee Connect' })).toBe(
      'Hosting or going to the Alignable event “Coffee Connect”',
    );
  });

  it('takes only Alignable’s own addresses for an event', () => {
    expect(onAlignable('https://www.alignable.com/austin-tx/events/123-spring-mixer')).toBe(true);
    expect(onAlignable('https://alignable.com/events/123')).toBe(true);
    expect(onAlignable('http://www.alignable.com/events/123')).toBe(false);
    expect(onAlignable('https://www.alignable.com.evil.test/events/123')).toBe(false);
    expect(onAlignable('not an address')).toBe(false);
  });
});

describe('the events near the person', () => {
  let owner: TestUser;
  let riley: TestUser;
  let ws: string;
  const event = (n: number) => `https://www.alignable.com/austin-tx/events/${n}-austin-mixer`;
  const al = (slug: string) => ({
    id: null,
    username: slug,
    url: `https://www.alignable.com/austin-tx/${slug}`,
  });
  const next = async (u = owner) =>
    (await runAs(u, ws, 'outreach.events.next', {})) as { due: boolean; read: string[] };

  beforeAll(async () => {
    owner = await createTestUser('outev-owner', { fullName: 'Pat Owner' });
    ws = await outreachBusiness(owner, 'Events Near Co');
    await computerOn(owner, ws, '0.104.0');
    riley = await createTestUser('outev-riley', { fullName: 'Riley Member' });
    await admin()
      .insert(workspaceMemberships)
      .values({ workspaceId: ws, userId: riley.id, role: 'member' });
  });

  it('is due the first time, then a week on by the business’s days', async () => {
    expect(await next()).toEqual({ due: true, read: [] });
    const read = await runAs(owner, ws, 'outreach.events.read', {
      urls: [event(1), event(2), event(1)],
    });
    expect(typeof read.readAt).toBe('string');
    expect(await next()).toEqual({ due: false, read: [event(1), event(2)] });
    // Six days on it still waits; seven days on, whatever the hour, it's due.
    const moveBack = (days: number) =>
      admin().execute(
        sql`update addon_outreach.event_reads set read_at = now() - make_interval(days => ${days})
            where workspace_id = ${ws} and user_id = ${owner.id}`,
      );
    await moveBack(6);
    expect((await next()).due).toBe(false);
    await moveBack(7);
    expect((await next()).due).toBe(true);
  });

  it('keeps the newest first, each once, up to the most it keeps', async () => {
    await runAs(owner, ws, 'outreach.events.read', { urls: [event(3), event(2)] });
    expect((await next()).read).toEqual([event(3), event(2), event(1)]);
    // A week with none new still counts as read.
    await runAs(owner, ws, 'outreach.events.read', { urls: [] });
    expect(await next()).toEqual({ due: false, read: [event(3), event(2), event(1)] });
    for (let week = 0; week < 14; week++)
      await runAs(owner, ws, 'outreach.events.read', {
        urls: [0, 1, 2, 3, 4].map((n) => event(100 + week * 5 + n)),
      });
    const { read } = await next();
    expect(read).toHaveLength(EVENTS_KEPT_MOST);
    expect(read[0]).toBe(event(165));
  });

  it('is each person’s own', async () => {
    expect(await next(riley)).toEqual({ due: true, read: [] });
    const [mine] = await rows<{ n: number }>(
      admin(),
      sql`select count(*)::int as n from addon_outreach.event_reads where workspace_id = ${ws}`,
    );
    expect(mine!.n).toBe(1);
  });

  it('refuses an address that isn’t Alignable’s, and more than 5 at once', async () => {
    expect(
      await refused(
        runAs(owner, ws, 'outreach.events.read', { urls: ['https://example.com/events/1'] }),
      ),
    ).toBe('validation');
    expect(
      await refused(
        runAs(owner, ws, 'outreach.events.read', {
          urls: [1, 2, 3, 4, 5, 6].map((n) => event(200 + n)),
        }),
      ),
    ).toBe('validation');
  });

  it('keeps an event’s hosts and guests as found, with its name and town', async () => {
    expect(
      await refused(
        runAs(owner, ws, 'outreach.finds.save', {
          platform: 'alignable',
          how: 'event',
          people: [{ profile: al('pine-painting'), name: 'Jamie Pine' }],
        }),
      ),
    ).toBe('validation');
    const saved = await runAs(owner, ws, 'outreach.finds.save', {
      platform: 'alignable',
      how: 'event',
      words: 'Spring Business Mixer',
      place: 'Austin, TX',
      people: [
        { profile: al('pine-painting'), name: 'Jamie Pine', lines: ['Painter in Austin'] },
        { profile: al('cole-bakery'), name: 'Morgan Cole' },
      ],
    });
    expect(saved.added).toBe(2);
    const kept = await rows<{ username: string; how: string; words: string; place: string }>(
      admin(),
      sql`select p.username, f.how, f.words, f.place from addon_outreach.finds f
          join addon_outreach.profiles p on p.id = f.profile_id
          where f.workspace_id = ${ws} order by p.username`,
    );
    expect(kept).toEqual([
      {
        username: 'cole-bakery',
        how: 'event',
        words: 'Spring Business Mixer',
        place: 'Austin, TX',
      },
      {
        username: 'pine-painting',
        how: 'event',
        words: 'Spring Business Mixer',
        place: 'Austin, TX',
      },
    ]);
  });
});
