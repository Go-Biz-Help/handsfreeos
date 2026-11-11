/**
 * AI Social Media Content Creator learning from the business's own posts (docs/socialcontent.md, "Its own posts'
 * numbers"; part 11): when each read is due, which places it reads, weighing one against the business's own others in
 * the same place, and the lines the web and the phone show. No database.
 */
import { describe, expect, it } from 'vitest';
import type { PostedTo } from '../../src/addons/socialcontent/calendar';
import {
  checkDue,
  daysUp,
  nextCheckAt,
  OWN,
  ownDoneWell,
  type OwnNumbers,
  type OwnPostNumbers,
} from '../../src/addons/socialcontent/own';
import { numbersLine, numbersLines } from '../../src/addons/socialcontent/words';

const DAY = 86_400_000;
const UP = '2026-11-01T15:00:00.000Z';
const at = (days: number) => new Date(Date.parse(UP) + days * DAY);
const read = (days: number, likes: number, views: number | null = null) => ({
  at: at(days).toISOString(),
  days,
  views,
  likes,
  comments: 2,
  shares: null,
});

const both: PostedTo[] = [
  { place: 'profile', link: 'https://www.facebook.com/me/posts/1', at: UP },
  { place: 'page', link: 'https://www.facebook.com/page/posts/2', at: UP },
];

describe('when its numbers are read', () => {
  it('is 2 days after it first went up, then 7, then never', () => {
    expect(nextCheckAt(both, {})).toEqual(at(OWN.firstDays));
    const d2: OwnNumbers = { profile: { d2: read(2, 10) }, page: { d2: read(2, 3) } };
    expect(nextCheckAt(both, d2)).toEqual(at(OWN.secondDays));
    const d7: OwnNumbers = {
      profile: { d2: read(2, 10), d7: read(7, 20) },
      page: { d2: read(2, 3), d7: read(7, 5) },
    };
    expect(nextCheckAt(both, d7)).toBeNull();
  });

  it('waits for every place before moving on, and skips places with no link', () => {
    const one: OwnNumbers = { profile: { d2: read(2, 10) } };
    expect(nextCheckAt(both, one)).toEqual(at(OWN.firstDays));
    const noLink: PostedTo[] = [both[0]!, { place: 'page', link: null, at: UP }];
    expect(nextCheckAt(noLink, one)).toEqual(at(OWN.secondDays));
    expect(nextCheckAt([{ place: 'feed', link: null, at: UP }], {})).toBeNull();
  });
});

describe('the read due now', () => {
  it('is none before 2 days, the 2-day read until 7, then the 7-day', () => {
    expect(checkDue(both, {}, at(1.9))).toBeNull();
    expect(checkDue(both, {}, at(2))).toEqual({
      read: 'd2',
      places: both.map((p) => ({ place: p.place, link: p.link })),
    });
    // A 2-day read missed until the 7th day: the 7-day one takes its place.
    expect(checkDue(both, {}, at(7.5))?.read).toBe('d7');
  });

  it('reads only the places not read yet', () => {
    const one: OwnNumbers = { profile: { d2: read(2, 10) } };
    expect(checkDue(both, one, at(3))?.places.map((p) => p.place)).toEqual(['page']);
    const done: OwnNumbers = { profile: { d2: read(2, 10) }, page: { d2: read(2, 3) } };
    expect(checkDue(both, done, at(3))).toBeNull();
  });

  it('counts whole days up', () => {
    expect(daysUp(UP, at(2.2))).toBe(2);
    expect(daysUp(UP, at(6.6))).toBe(7);
    expect(daysUp(UP, at(-1))).toBe(0);
  });
});

describe('doing well against its own others', () => {
  const others = (n: number, likes: number): OwnPostNumbers[] =>
    Array.from({ length: n }, (_, i) => ({
      id: `other-${i}`,
      place: 'profile',
      at: at(-30 + i).toISOString(),
      views: null,
      likes,
      comments: 0,
    }));
  const mine = (likes: number): OwnPostNumbers => ({
    id: 'mine',
    place: 'profile',
    at: UP,
    views: null,
    likes,
    comments: 0,
  });

  it('did well at 2 times their middle, on likes and comments', () => {
    const well = ownDoneWell(mine(40), others(6, 10), at(7));
    expect(well).toEqual({ place: 'profile', on: 'engagement', times: 4, at: at(7).toISOString() });
  });

  it('not when it’s close to their middle, or there are too few to tell', () => {
    expect(ownDoneWell(mine(15), others(6, 10), at(7))).toBeNull();
    expect(ownDoneWell(mine(40), others(3, 10), at(7))).toBeNull();
  });

  it('weighs only posts in the same place', () => {
    const elsewhere = others(6, 10).map((o) => ({ ...o, place: 'page' as const }));
    expect(ownDoneWell(mine(40), elsewhere, at(7))).toBeNull();
  });
});

describe('the lines a post shows', () => {
  const name = (n: string) => (n === 'facebook' ? 'Facebook' : n);

  it('reads only the numbers the network showed', () => {
    expect(numbersLine(read(2, 1240, 9800))).toBe('9,800 views · 1,240 likes · 2 comments');
    expect(
      numbersLine({ at: UP, days: 2, views: null, likes: null, comments: null, shares: null }),
    ).toBe('no numbers shown');
    expect(numbersLine({ at: UP, days: 2, failure: 'Facebook didn’t show it.' })).toBe(
      'couldn’t read its numbers. Facebook didn’t show it.',
    );
  });

  it('says when they’re read before the first read, and nothing before it went up', () => {
    const post = { network: 'facebook', postedTo: [both[0]!], numbers: {}, doneWell: null };
    expect(numbersLines(post, name)).toEqual([
      { text: 'Its numbers are read 2 and 7 days after it went up.', well: false },
    ]);
    expect(numbersLines({ ...post, postedTo: [] }, name)).toEqual([]);
  });

  it('names each place when it went up in several, and says when it did well', () => {
    const lines = numbersLines(
      {
        network: 'facebook',
        postedTo: both,
        numbers: { profile: { d2: read(2, 10), d7: read(7, 40) }, page: { d2: read(2, 3) } },
        doneWell: { place: 'profile', on: 'engagement', times: 4, at: at(7).toISOString() },
      },
      name,
    );
    expect(lines.map((l) => l.text)).toEqual([
      'On your profile, after 2 days: 10 likes · 2 comments',
      'On your profile, after 7 days: 40 likes · 2 comments',
      'On your Page, after 2 days: 3 likes · 2 comments',
      'It did well: 4 times your usual likes and comments on your profile. It goes into the Playbook.',
    ]);
    expect(lines.at(-1)?.well).toBe(true);
  });
});
