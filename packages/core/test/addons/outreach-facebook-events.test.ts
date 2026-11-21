/**
 * Events near you on Facebook, and Today's list of them (docs/outreach.md decision 188, the owner's pick 7a of 20 Nov
 * 2026): read once a week like Alignable's from Facebook's event search for the person's town, each event's hosts and
 * people going checked by the AI like friends with nothing pressed, the good fits on Today for a friend request, and a
 * Today card listing the events coming up so they can go in person. Each person's own.
 */
import { rows, sql } from '@hfos/db/client';
import { workspaceMemberships } from '@hfos/db/schema';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  EVENT_NAME_MOST,
  EventSeen,
  eventFact,
  eventSearches,
  eventWhy,
  onFacebookEvent,
} from '../../src/addons/outreach/events-near';
import { PLAYBOOK_TEMPLATES } from '../../src/addons/outreach/playbooks';
import { checkedAs, outreachBusiness, refused, runAs } from './outreach-fixture';

const admin = () => testDbs().admin.db;
const crm = PLAYBOOK_TEMPLATES.crm_demos.details;
const DAY = 86_400_000;

afterAll(closeTestDbs);

describe('events near you on Facebook, in words', () => {
  it('searches for networking, then business, in the person’s town', () => {
    expect(eventSearches('Boise, ID')).toEqual(['networking Boise, ID', 'business Boise, ID']);
    expect(eventSearches('  Boise,   ID ')).toEqual(['networking Boise, ID', 'business Boise, ID']);
    expect(eventSearches(null)).toEqual([]);
  });

  it('takes only an event’s own page on Facebook', () => {
    expect(onFacebookEvent('https://www.facebook.com/events/1234567890/')).toBe(true);
    expect(onFacebookEvent('https://facebook.com/events/1234567890?ref=search')).toBe(true);
    expect(onFacebookEvent('https://www.facebook.com/events/birthdays/')).toBe(false);
    expect(onFacebookEvent('http://www.facebook.com/events/1234567890/')).toBe(false);
    expect(onFacebookEvent('https://www.facebook.com.evil.test/events/1234567890/')).toBe(false);
  });

  it('says why someone at one is on Today, and what the AI is told', () => {
    expect(eventWhy('Boise Business Mixer', false)).toBe(
      'Going to “Boise Business Mixer” near you',
    );
    expect(eventWhy('Boise Business Mixer', true)).toBe('Hosting “Boise Business Mixer” near you');
    expect(eventFact('Boise Business Mixer', 'Boise Centre', false)).toBe(
      'Going to the Facebook event “Boise Business Mixer” (Boise Centre) near the owner, though they aren’t friends',
    );
  });

  it('keeps what an event’s page showed tidy', () => {
    const seen = EventSeen.parse({
      url: 'https://www.facebook.com/events/1234567890/',
      name: `  Boise   ${'x'.repeat(300)}`,
      when: '  Thursday,  December 4 at 7:30 AM  ',
      place: '',
    });
    expect(seen.name).toHaveLength(EVENT_NAME_MOST);
    expect(seen.name.endsWith('…')).toBe(true);
    expect(seen.when).toBe('Thursday, December 4 at 7:30 AM');
    expect(seen.place).toBeNull();
    expect(seen).toMatchObject({ startsAt: null, hosts: [], guests: [] });
  });
});

describe('the events near the person on Facebook', () => {
  let owner: TestUser;
  let riley: TestUser;
  let ws: string;
  let playbookId: string;
  const fb = (username: string) => ({
    id: null,
    username,
    url: `https://www.facebook.com/${username}`,
  });
  const person = (username: string, name: string) => ({ profile: fb(username), name });
  const event = (n: number) => `https://www.facebook.com/events/${1_000_000 + n}/`;
  const soon = (days: number) => new Date(Date.now() + days * DAY).toISOString();
  const next = async (u = owner) =>
    (await runAs(u, ws, 'outreach.events.next', { platform: 'facebook' })) as {
      due: boolean;
      read: string[];
      searches: string[];
    };
  const idOf = async (username: string) =>
    (
      await rows<{ id: string }>(
        admin(),
        sql`select id from addon_outreach.profiles where workspace_id = ${ws} and username = ${username}`,
      )
    )[0]!.id;
  const checksNext = async (u = owner) =>
    (
      (await runAs(u, ws, 'outreach.checks.next', {})) as {
        people: { name: string; reason: string }[];
      }
    ).people.map((p) => [p.name, p.reason]);
  const todayOf = async (u = owner, platform = 'facebook') =>
    (await runAs(u, ws, 'outreach.today', { platform })) as {
      items: { kind: string; name: string; why: string[] }[];
      events: {
        id: string;
        url: string;
        name: string;
        when: string | null;
        startsAt: string | null;
        place: string | null;
        hosts: string[];
        people: number;
      }[];
    };
  const requests = async (u = owner) =>
    (await todayOf(u)).items.filter((i) => i.kind === 'friend_request' || i.kind === 'warm_up');

  beforeAll(async () => {
    owner = await createTestUser('outfbev-owner', { fullName: 'Pat Owner' });
    ws = await outreachBusiness(owner, 'Facebook Events Co');
    riley = await createTestUser('outfbev-riley', { fullName: 'Riley Member' });
    await admin()
      .insert(workspaceMemberships)
      .values({ workspaceId: ws, userId: riley.id, role: 'member' });
    playbookId = (
      await runAs(owner, ws, 'outreach.playbook.save', {
        name: 'CRM demos',
        template: 'crm_demos',
        details: crm,
      })
    ).id;
    // A friend already, who's going to the mixer too.
    await runAs(owner, ws, 'outreach.friends.save', {
      list: 'friends',
      people: [{ profile: fb('kate.nguyen.9'), name: 'Kate Nguyen', mutualFriends: null }],
    });
  }, 60_000);

  it('searches the person’s own town, once a week', async () => {
    // No town known yet: nothing to search for.
    expect(await next()).toEqual({ due: true, read: [], searches: [] });
    await runAs(owner, ws, 'outreach.location.set', { area: 'Boise, ID' });
    expect(await next()).toEqual({
      due: true,
      read: [],
      searches: ['networking Boise, ID', 'business Boise, ID'],
    });
  });

  it('keeps each event read for Today, and who hosts it and is going', async () => {
    const read = (await runAs(owner, ws, 'outreach.events.read', {
      platform: 'facebook',
      urls: [event(1), event(2)],
      events: [
        {
          url: event(1),
          name: 'Boise Business Mixer',
          when: 'Thursday, December 4 at 7:30 AM',
          startsAt: soon(5),
          place: 'Boise Centre',
          hosts: [person('boise.chamber.host', 'Morgan Hale')],
          guests: [
            person('dana.reyes.31', 'Dana Reyes'),
            person('kate.nguyen.9', 'Kate Nguyen'),
            person('boise.chamber.host', 'Morgan Hale'),
          ],
        },
        {
          url: event(2),
          name: 'Small Business Coffee',
          when: 'Every Tuesday',
          hosts: [],
          guests: [person('milo.park.2', 'Milo Park')],
        },
      ],
    })) as { readAt: string; added: number };
    // Morgan (hosting and going), Dana and Milo are new and not friends; Kate's a friend.
    expect(read.added).toBe(3);
    expect(await next()).toMatchObject({ due: false, read: [event(1), event(2)] });
    const kept = await rows<{ username: string; host: boolean }>(
      admin(),
      sql`select p.username, ep.host from addon_outreach.event_people ep
          join addon_outreach.profiles p on p.id = ep.profile_id
          where ep.workspace_id = ${ws} order by p.username`,
    );
    expect(kept).toEqual([
      { username: 'boise.chamber.host', host: true },
      { username: 'dana.reyes.31', host: false },
      { username: 'kate.nguyen.9', host: false },
      { username: 'milo.park.2', host: false },
    ]);
    // Nobody went into Contacts.
    const [contacts] = await rows<{ n: number }>(
      admin(),
      sql`select count(person_id)::int as n from addon_outreach.profiles where workspace_id = ${ws}`,
    );
    expect(contacts!.n).toBe(0);
  });

  it('lists the events coming up on Today, the soonest first', async () => {
    const { events } = await todayOf();
    expect(events.map((e) => [e.name, e.when, e.place, e.hosts])).toEqual([
      ['Boise Business Mixer', 'Thursday, December 4 at 7:30 AM', 'Boise Centre', ['Morgan Hale']],
      ['Small Business Coffee', 'Every Tuesday', null, []],
    ]);
    expect(events[0]!.url).toBe(event(1));
    // Morgan, Dana and Kate there, none checked yet.
    expect(events[0]!.people).toBe(3);
    // Another network's list, and a teammate's, have none of them.
    expect((await todayOf(owner, 'alignable')).events).toEqual([]);
    expect((await todayOf(riley)).events).toEqual([]);
  });

  it('checks the people there who aren’t friends like friends, after the followers', async () => {
    const next = await checksNext();
    expect(next[0]).toEqual(['Kate Nguyen', 'friend']);
    // Then everyone at the event, kept in one go: in the order friends go, which one read leaves even.
    expect(next.slice(1).sort()).toEqual([
      ['Dana Reyes', 'event'],
      ['Milo Park', 'event'],
      ['Morgan Hale', 'event'],
    ]);
    expect(await checksNext(riley)).toEqual([]);
  });

  it('says a check is of someone at an event, and puts a good fit on Today', async () => {
    const morgan = await idOf('boise.chamber.host');
    await checkedAs(owner, ws, morgan, { fit: 'good', why: ['Runs the chamber'], playbookId });
    const [check] = await rows<{ via: string }>(
      admin(),
      sql`select via from addon_outreach.checks where profile_id = ${morgan} and user_id = ${owner.id}`,
    );
    expect(check!.via).toBe('event');
    expect(await requests()).toEqual([
      expect.objectContaining({
        kind: 'warm_up',
        name: 'Morgan Hale',
        why: [
          eventWhy('Boise Business Mixer', true),
          'Runs the chamber',
          'Their friend request comes a day after',
        ],
      }),
    ]);
    await rows(
      admin(),
      sql`insert into addon_outreach.touches (workspace_id, profile_id, user_id, kind, at)
          values (${ws}, ${morgan}, ${owner.id}, 'like', now() - interval '2 days')`,
    );
    expect(await requests()).toEqual([
      expect.objectContaining({
        kind: 'friend_request',
        name: 'Morgan Hale',
        why: [
          eventWhy('Boise Business Mixer', true),
          'Runs the chamber',
          'You liked a post of theirs',
        ],
      }),
    ]);
    expect(await requests(riley)).toEqual([]);
  });

  it('takes an event off Today with Not going', async () => {
    const { events } = await todayOf();
    expect(await runAs(owner, ws, 'outreach.event.skip', { eventId: events[1]!.id })).toEqual({
      skipped: true,
    });
    expect((await todayOf()).events.map((e) => e.name)).toEqual(['Boise Business Mixer']);
    // Someone else's event isn't theirs to put aside.
    expect(await refused(runAs(riley, ws, 'outreach.event.skip', { eventId: events[0]!.id }))).toBe(
      'not_found',
    );
  });

  it('leaves an event that’s over, or one far off, off Today', async () => {
    await admin().execute(
      sql`update addon_outreach.events set starts_at = now() - interval '1 day'
          where workspace_id = ${ws} and url = ${event(1)}`,
    );
    expect((await todayOf()).events).toEqual([]);
    await admin().execute(
      sql`update addon_outreach.events set starts_at = now() + interval '90 days'
          where workspace_id = ${ws} and url = ${event(1)}`,
    );
    expect((await todayOf()).events).toEqual([]);
  });

  it('lists Alignable’s events on Alignable’s Today, its people found as before', async () => {
    await runAs(owner, ws, 'outreach.events.read', {
      platform: 'alignable',
      urls: ['https://www.alignable.com/boise-id/events/9-boise-mixer'],
      events: [
        {
          url: 'https://www.alignable.com/boise-id/events/9-boise-mixer',
          name: 'Boise Alignable Mixer',
          startsAt: soon(3),
          hosts: [
            {
              profile: {
                id: null,
                username: 'pine-painting',
                url: 'https://www.alignable.com/boise-id/pine-painting',
              },
              name: 'Jamie Pine',
            },
          ],
        },
      ],
    });
    const { events } = await todayOf(owner, 'alignable');
    expect(events.map((e) => [e.name, e.hosts, e.people])).toEqual([
      ['Boise Alignable Mixer', ['Jamie Pine'], 0],
    ]);
    // Its hosts aren't kept as Facebook's event people: Alignable's are found people.
    const [n] = await rows<{ n: number }>(
      admin(),
      sql`select count(*)::int as n from addon_outreach.event_people where workspace_id = ${ws}`,
    );
    expect(n!.n).toBe(4);
  });

  it('refuses another network’s address for an event', async () => {
    expect(
      await refused(
        runAs(owner, ws, 'outreach.events.read', {
          platform: 'facebook',
          urls: ['https://www.alignable.com/boise-id/events/9-boise-mixer'],
        }),
      ),
    ).toBe('validation');
    expect(
      await refused(
        runAs(owner, ws, 'outreach.events.read', {
          platform: 'facebook',
          events: [{ url: 'https://example.com/events/1', name: 'Elsewhere' }],
        }),
      ),
    ).toBe('validation');
  });

  it('isn’t someone to check once they were seen at an event over a month ago', async () => {
    await admin().execute(
      sql`update addon_outreach.event_people set seen_at = now() - interval '31 days'
          where workspace_id = ${ws}`,
    );
    expect(await checksNext()).toEqual([['Kate Nguyen', 'friend']]);
  });
});
