/**
 * Which of someone's posts to like before their friend request (docs/outreach.md, decision 33): the AI's pick is
 * checked, a post about grief, illness, trouble, politics or religion is never liked, and without the AI the words
 * alone pick the first post that's safe.
 */
import { describe, expect, it } from 'vitest';
import {
  checkedLikePick,
  fallbackLikePick,
  likedText,
  LikePickInput,
  likePickPrompt,
  neverLike,
} from '../../src/addons/outreach/like-pick';

const posts = LikePickInput.parse({
  profileId: '7b6f5c4d-3e2a-4b1c-8d9e-0f1a2b3c4d5e',
  posts: [
    { text: 'RIP Grandpa, we miss you so much', pictures: [] },
    { text: 'Finally got the new roof on the shop!', pictures: ['May be an image of house'] },
    { text: '', pictures: ['May be an image of 2 people, dog and lake'], when: '3d' },
  ],
}).posts;

describe('which post gets the like', () => {
  it('never likes a post about a death, an illness, politics or religion', () => {
    expect(neverLike(posts[0]!)).toBe(true);
    expect(
      neverLike({
        text: 'Please keep my mom in your prayers, she’s in the hospital',
        pictures: [],
      }),
    ).toBe(true);
    expect(neverLike({ text: 'Vote for our bakery in Best of Austin!', pictures: [] })).toBe(false);
    expect(neverLike(posts[1]!)).toBe(false);
  });

  it('takes the AI’s pick, but never one the words rule out', () => {
    expect(
      checkedLikePick({ pick: 1, about: 'business', why: 'A new roof — on their shop.' }, posts),
    ).toEqual({
      pick: 1,
      about: 'business',
      why: 'A new roof, on their shop.',
      by: 'ai',
      comment: null,
    });
    // The AI chose the RIP post, or a number it wasn't sent: the words pick instead.
    expect(checkedLikePick({ pick: 0, about: 'personal', why: 'x' }, posts).pick).toBe(1);
    expect(checkedLikePick({ pick: 9, about: 'personal', why: 'x' }, posts)).toMatchObject({
      pick: 1,
      by: 'words',
    });
    // None fit: no like.
    expect(checkedLikePick({ pick: null, about: null, why: null }, posts).pick).toBeNull();
  });

  it('keeps a warm-up comment only for a post to do with the business, plain, short and with no link', () => {
    const said = (about: 'business' | 'personal', comment: string) =>
      checkedLikePick({ pick: 1, about, why: 'Their shop', comment }, posts).comment;
    expect(said('business', 'Great work — that roof looks sharp!')).toBe(
      'Great work, that roof looks sharp!',
    );
    expect(said('personal', 'Great work!')).toBeNull();
    expect(said('business', 'Check us out at https://acme.example')).toBeNull();
    expect(said('business', 'Great work! '.repeat(30))).toBeNull();
  });

  it('without the AI, likes the first safe post, or none', () => {
    expect(fallbackLikePick(posts)).toEqual({
      pick: 1,
      about: 'other',
      why: null,
      by: 'words',
      comment: null,
    });
    expect(fallbackLikePick(posts.slice(0, 1)).pick).toBeNull();
  });

  it('asks with the business and each post’s words and pictures, as data', () => {
    const prompt = likePickPrompt({
      business: 'Acme Roofing',
      playbooks: [{ offer: 'Roof repair', audience: 'Homeowners', area: 'Austin' }],
      name: 'Dana Reyes',
      posts,
    });
    expect(prompt).toContain('Offer: Roof repair');
    expect(prompt).toContain('<post number="2">');
    expect(prompt).toContain('Picture: May be an image of 2 people, dog and lake');
    expect(likedText(posts[2]!)).toBe('May be an image of 2 people, dog and lake');
  });
});
