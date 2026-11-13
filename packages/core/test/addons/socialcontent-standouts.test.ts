/**
 * AI Social Media Content Creator's pure parts (docs/socialcontent.md): which posts stand out against the posts around
 * them, who has done well enough to suggest, reading a link to someone's page, and checking what the AI says about
 * niches. No database.
 */
import { describe, expect, it } from 'vitest';
import { checkedNiches, cleanSearches } from '../../src/addons/socialcontent/niches-ai';
import {
  CONTENT_NETWORKS,
  creatorFromLink,
  handleShown,
  networkName,
  type ContentNetwork,
} from '../../src/addons/socialcontent/networks';
import {
  doneWell,
  median,
  STANDOUT,
  standoutTimes,
  weighPosts,
  type PostNumbers,
} from '../../src/addons/socialcontent/standouts';

const DAY = 86_400_000;
const NOW = Date.parse('2026-11-08T12:00:00Z');

/** Posts a day apart, the last one 30 days before now, with these likes (and no views or comments). */
function byLikes(likes: readonly number[], views?: readonly (number | null)[]): PostNumbers[] {
  return likes.map((l, i) => ({
    id: `p${String(i).padStart(3, '0')}`,
    postedAt: new Date(NOW - (30 + likes.length - 1 - i) * DAY).toISOString(),
    views: views ? (views[i] ?? null) : null,
    likes: l,
    comments: null,
  }));
}

describe('standout posts', () => {
  it('picks the 100 out of posts with 20 to 50 (the owner’s example)', () => {
    const weighed = weighPosts(byLikes([20, 35, 100, 50, 30]), NOW);
    const hit = weighed[2]!;
    expect(hit.standout).toBe(true);
    expect(hit.on).toBe('engagement');
    // Its neighbours are 20, 35, 50 and 30: their middle is 32.5, so 100 is about 3 times it.
    expect(hit.engagementTimes).toBeCloseTo(100 / 32.5, 2);
    expect(weighed.filter((w) => w.standout)).toHaveLength(1);
  });

  it('weighs a post against its neighbours, not the creator’s best ever', () => {
    // An account that grew: early posts get 20, later ones 400. An early 60 stands out; a later 500, among 400s,
    // doesn't, though it's the most liked of all.
    const early = [20, 22, 18, 60, 21, 19, 20, 23];
    const later = Array.from({ length: 25 }, (_, i) => (i === 15 ? 500 : 400 + (i % 3) * 10));
    const weighed = weighPosts(byLikes([...early, ...later]), NOW);
    expect(weighed[3]!.standout).toBe(true);
    expect(weighed[early.length + 15]!.standout).toBe(false);
  });

  it('uses the middle number, so one other big hit nearby doesn’t hide a standout', () => {
    const weighed = weighPosts(byLikes([30, 30, 900, 30, 120, 30, 30, 30]), NOW);
    expect(weighed[4]!.standout).toBe(true);
    expect(weighed[2]!.standout).toBe(true);
  });

  it('keeps to 10 posts on each side', () => {
    const likes: number[] = Array.from({ length: 41 }, (_, i) => (i < 20 ? 1000 : 20));
    likes[30] = 60;
    const weighed = weighPosts(byLikes(likes), NOW);
    // Post 30's 10 on each side are all 20s, so the 1,000s further back don't count against it.
    expect(weighed[30]!.engagementTimes).toBe(3);
    expect(weighed[30]!.standout).toBe(true);
  });

  it('counts views or likes plus comments, and says which', () => {
    const views = [1000, 1100, 900, 5000, 1000, 950];
    const onViews = weighPosts(byLikes([50, 50, 50, 50, 50, 50], views), NOW)[3]!;
    expect(onViews.on).toBe('views');
    const both = weighPosts(byLikes([50, 50, 50, 200, 50, 50], views), NOW)[3]!;
    expect(both.on).toBe('both');
    expect(standoutTimes(both)).toBe(5);
  });

  it('adds comments to likes', () => {
    const posts = byLikes([10, 10, 10, 10, 10]).map((p, i) => ({
      ...p,
      comments: i === 2 ? 15 : 0,
    }));
    expect(weighPosts(posts, NOW)[2]!.engagementTimes).toBe(2.5);
  });

  it('lets a post under 7 days old wait, and leaves it out of its neighbours’ numbers', () => {
    const posts = byLikes([20, 20, 20, 20, 20]);
    posts.push({
      id: 'fresh',
      postedAt: new Date(NOW - 2 * DAY).toISOString(),
      views: null,
      likes: 5000,
      comments: null,
    });
    const weighed = weighPosts(posts, NOW);
    expect(weighed[5]).toMatchObject({
      standout: false,
      waiting: 'too_new',
      engagementTimes: null,
    });
    expect(weighed[4]!.engagementTimes).toBe(1);
    expect(STANDOUT.waitDays).toBe(7);
  });

  it('waits when there are too few posts around it to judge by', () => {
    const weighed = weighPosts(byLikes([20, 100, 20]), NOW);
    expect(weighed.every((w) => w.waiting === 'too_few' && !w.standout)).toBe(true);
  });

  it('needs a least number, so 3 likes beside posts with 1 isn’t a standout', () => {
    const weighed = weighPosts(byLikes([1, 1, 3, 1, 1]), NOW);
    expect(weighed[2]!.engagementTimes).toBe(3);
    expect(weighed[2]!.standout).toBe(false);
  });

  it('gives back the posts in the order given', () => {
    const posts = byLikes([20, 35, 100, 50, 30]).reverse();
    expect(weighPosts(posts, NOW).map((w) => w.id)).toEqual(posts.map((p) => p.id));
  });

  it('works out a middle number', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });
});

describe('creators who did well', () => {
  it('needs 5,000 followers and a post in the last 30 days', () => {
    const recent = new Date(NOW - 5 * DAY).toISOString();
    expect(doneWell({ followers: 5000, lastPostAt: recent }, NOW)).toBe(true);
    expect(doneWell({ followers: 4999, lastPostAt: recent }, NOW)).toBe(false);
    expect(doneWell({ followers: null, lastPostAt: recent }, NOW)).toBe(false);
    expect(
      doneWell({ followers: 90_000, lastPostAt: new Date(NOW - 31 * DAY).toISOString() }, NOW),
    ).toBe(false);
    expect(doneWell({ followers: 90_000, lastPostAt: null }, NOW)).toBe(false);
  });
});

describe('a network’s name', () => {
  it('names each, and shows one it doesn’t know as sent rather than breaking (the owner’s Calendar, 13 Nov)', () => {
    for (const n of CONTENT_NETWORKS) expect(networkName(n)).toBeTruthy();
    expect(networkName('threads')).toBe('Threads');
    expect(networkName('x')).toBe('X');
    expect(networkName('bluesky' as ContentNetwork)).toBe('bluesky');
  });
});

describe('a link to someone’s page', () => {
  it('reads each network’s pages', () => {
    expect(creatorFromLink('https://www.instagram.com/Some.Creator/?hl=en')).toEqual({
      network: 'instagram',
      handle: 'some.creator',
      link: 'https://www.instagram.com/some.creator/',
    });
    expect(creatorFromLink('instagram.com/maker_jo')?.handle).toBe('maker_jo');
    expect(creatorFromLink('https://m.facebook.com/profile.php?id=100012345678')?.handle).toBe(
      'id:100012345678',
    );
    expect(creatorFromLink('https://www.facebook.com/JoesPlumbing')?.handle).toBe('joesplumbing');
    expect(creatorFromLink('https://www.linkedin.com/in/jane-doe-123/')?.handle).toBe(
      'in/jane-doe-123',
    );
    expect(creatorFromLink('https://www.linkedin.com/company/acme')?.handle).toBe('company/acme');
    expect(creatorFromLink('https://www.tiktok.com/@chef.sam')?.handle).toBe('chef.sam');
    expect(creatorFromLink('https://www.youtube.com/@BuildWithMe')?.handle).toBe('@buildwithme');
    expect(creatorFromLink('https://www.youtube.com/channel/UCabcdefghijklmnop12')?.handle).toBe(
      'channel/UCabcdefghijklmnop12',
    );
  });

  it('reads a bare @name when the network is given', () => {
    expect(creatorFromLink('@Maker_Jo', 'instagram')?.handle).toBe('maker_jo');
    expect(creatorFromLink('@maker_jo')).toBeNull();
  });

  it('turns away pages that aren’t a person or a business', () => {
    expect(creatorFromLink('https://www.instagram.com/p/Cx123abc/')).toBeNull();
    expect(creatorFromLink('https://www.instagram.com/reel/Cx123abc/')).toBeNull();
    expect(creatorFromLink('https://www.facebook.com/groups/12345')).toBeNull();
    expect(creatorFromLink('https://www.linkedin.com/feed/')).toBeNull();
    expect(creatorFromLink('https://example.com/someone')).toBeNull();
    expect(creatorFromLink('   ')).toBeNull();
  });

  it('shows each the way its network does', () => {
    expect(handleShown('instagram', 'maker_jo')).toBe('@maker_jo');
    expect(handleShown('linkedin', 'in/jane-doe')).toBe('jane-doe');
    expect(handleShown('youtube', '@buildwithme')).toBe('@buildwithme');
    expect(handleShown('facebook', 'id:1000123')).toBe('Facebook profile');
  });
});

describe('what the AI says about niches', () => {
  const searches = { instagram: ['#plumbingtips', '# plumbing tips', 'plumber', 'Plumber', 'x'] };

  it('keeps clean searches for the networks read', () => {
    expect(
      cleanSearches({
        ...searches,
        linkedin: ['plumbing coach'],
        x: ['plumbing tips', '#plumbing'],
        tiktok: ['#plumbing'],
      }),
    ).toEqual({
      instagram: ['#plumbingtips', 'plumber'],
      facebook: [],
      linkedin: ['plumbing coach'],
      threads: [],
      x: ['plumbing tips', '#plumbing'],
    });
  });

  it('keeps the business’s own niche only when it has none, and no repeats', () => {
    const answer = {
      own: { name: '#Home plumbing', searches },
      similar: [
        { name: 'Home Plumbing', why: 'Same thing.', searches },
        { name: 'HVAC tips', why: '  Homeowners  who fix things. ', searches },
        { name: 'Handyman', why: '', searches },
        { name: 'Already here', why: 'x', searches },
      ],
    };
    const first = checkedNiches(answer, ['already here'], false);
    expect(first.own?.name).toBe('Home plumbing');
    expect(first.similar.map((s) => s.name)).toEqual(['HVAC tips', 'Handyman']);
    expect(first.similar[0]!.why).toBe('Homeowners who fix things.');
    expect(first.similar[1]!.why).toBeNull();
    expect(checkedNiches(answer, [], true).own).toBeNull();
    // Its own niche is one already kept: still named, so that one becomes its own.
    const kept = checkedNiches(
      { ...answer, own: { name: 'Already here', searches } },
      ['already here'],
      false,
    );
    expect(kept.own?.name).toBe('Already here');
    expect(kept.similar.map((s) => s.name)).toEqual(['Home Plumbing', 'HVAC tips', 'Handyman']);
  });

  it('keeps at most 5 similar niches', () => {
    const answer = {
      own: { name: 'Bakery', searches: {} },
      similar: Array.from({ length: 8 }, (_, i) => ({ name: `Niche ${i}`, why: '', searches: {} })),
    };
    expect(checkedNiches(answer, [], false).similar).toHaveLength(5);
  });
});
