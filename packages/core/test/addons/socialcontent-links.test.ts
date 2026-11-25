/**
 * The business's link in its own posts (docs/socialcontent.md, "Your link"; the owner, 24 Nov 2026: posts said there
 * was a link when there wasn't one): set once on the Playbook page with where it goes on each network, carried by a
 * post only when its words point people to it, and never promised by the AI when there's none. No database.
 */
import { describe, expect, it } from 'vitest';
import { postText, stillNeeds, type ReadyCheck } from '../../src/addons/socialcontent/calendar';
import {
  cleanLink,
  DEFAULT_LINK_PLACES,
  linkForAi,
  linkPlacesChanged,
  linkPlacesOf,
  linkRoom,
  mentionsLink,
  postLinkOf,
  repliesWithLink,
  withoutLinkTalk,
} from '../../src/addons/socialcontent/links';
import {
  checkedPost,
  WRITE_SCHEMA,
  WRITE_SYSTEM,
  writePrompt,
  type WriteAnswer,
} from '../../src/addons/socialcontent/posts-ai';
import { SOCIALCONTENT_WORDS as W } from '../../src/addons/socialcontent/words';

const LINK = 'https://gobiz.example/book';

describe('the link as kept', () => {
  it('takes an address typed without https, and refuses what isn’t a web address', () => {
    expect(cleanLink('gobiz.example/book')).toBe('https://gobiz.example/book');
    expect(cleanLink('  http://gobiz.example ')).toBe('http://gobiz.example');
    expect(cleanLink('https://gobiz.example/book?x=1')).toBe('https://gobiz.example/book?x=1');
    for (const bad of [
      '',
      'not a link',
      'gobiz',
      'javascript:alert(1)',
      'ftp://gobiz.example',
      'gobiz.',
    ])
      expect(cleanLink(bad)).toBeNull();
    expect(cleanLink(`gobiz.example/${'a'.repeat(500)}`)).toBeNull();
  });

  it('goes in the bio on Instagram and in the post elsewhere until the business picks', () => {
    expect(linkPlacesOf(null)).toEqual(DEFAULT_LINK_PLACES);
    expect(DEFAULT_LINK_PLACES.instagram).toBe('bio');
    expect(linkPlacesOf({ facebook: 'comment', x: 'nowhere', tiktok: 'post' })).toEqual({
      ...DEFAULT_LINK_PLACES,
      facebook: 'comment',
    });
    expect(
      linkPlacesChanged(DEFAULT_LINK_PLACES, { linkedin: 'comment', instagram: 'junk' }),
    ).toEqual({
      ...DEFAULT_LINK_PLACES,
      linkedin: 'comment',
    });
  });

  it('is carried only with a place and a link', () => {
    expect(postLinkOf(null, LINK)).toBeNull();
    expect(postLinkOf('comment', null)).toBeNull();
    expect(postLinkOf('comment', LINK)).toEqual({ place: 'comment', link: LINK });
    expect(linkRoom('post', LINK)).toBe(LINK.length + 2);
    expect(linkRoom('bio', LINK)).toBe(0);
    expect(repliesWithLink('x')).toBe(true);
    expect(repliesWithLink('facebook')).toBe(false);
  });
});

describe('words that point people to a link', () => {
  it('are a call to go somewhere, not a link the post talks about', () => {
    for (const said of [
      'Link in bio.',
      'The link’s in our bio!',
      'Book with the link below.',
      'Tap the link to save your spot.',
      'Details in the first comment.',
      'Visit www.gobiz.example today.',
      'More at https://gobiz.example',
      'Grab your guide 👇 link below',
    ])
      expect(mentionsLink(said), said).toBe(true);
    for (const said of [
      'Send customers a booking link after every call.',
      'We fixed the broken links on their site.',
      'Comment below with your answer.',
    ])
      expect(mentionsLink(said), said).toBe(false);
  });

  it('are taken out of a post that carries none, keeping its other sentences and paragraphs', () => {
    expect(
      withoutLinkTalk(
        'Missed calls cost you jobs.\n\nWe answer every one in seconds. Book a demo, link in bio.\n\nWhat would you do with an extra hour?',
      ),
    ).toBe(
      'Missed calls cost you jobs.\n\nWe answer every one in seconds.\n\nWhat would you do with an extra hour?',
    );
    expect(withoutLinkTalk('Link in bio.')).toBe('');
    expect(withoutLinkTalk('Just a tip for today.')).toBe('Just a tip for today.');
  });
});

const answer = (over: Partial<WriteAnswer> = {}): WriteAnswer => ({
  title: 'Never miss a call',
  format: 'photo',
  hook: null,
  words: 'Every missed call is a job someone else gets. Book a free demo, link in bio.',
  hashtags: ['smallbusiness'],
  slides: [],
  picture: 'A phone on a truck dashboard.',
  pictureWay: 'design',
  photoPrompt: null,
  angle: null,
  ...over,
});

describe('what the AI writes about the link', () => {
  it('is told whether this post may carry it, and where it goes', () => {
    expect(linkForAi('instagram', null)).toMatch(/never mention a link/);
    const bio = linkForAi('instagram', { url: LINK, place: 'bio' });
    expect(bio).toContain(LINK);
    expect(bio).toMatch(/Link in bio/);
    expect(linkForAi('facebook', { url: LINK, place: 'comment' })).toMatch(/first comment/);
    expect(linkForAi('x', { url: LINK, place: 'comment' })).toMatch(/reply below/);
    expect(linkForAi('linkedin', { url: LINK, place: 'post' })).toMatch(/link below/);
    expect(WRITE_SYSTEM).toMatch(/Only mention a link/);
    expect(WRITE_SCHEMA.required).toContain('link');
  });

  it('carries the link where the business keeps it when its words point to it', () => {
    const post = checkedPost(answer(), 'instagram', null, null, { url: LINK, place: 'bio' })!;
    expect(post.linkPlace).toBe('bio');
    expect(post.words).toMatch(/link in bio/);
    // Said with `link` alone, it's carried all the same.
    expect(
      checkedPost(
        answer({ words: 'Book a free demo today.', link: true }),
        'facebook',
        null,
        null,
        {
          url: LINK,
          place: 'comment',
        },
      )!.linkPlace,
    ).toBe('comment');
    // Nothing points to it: carried by nothing.
    expect(
      checkedPost(answer({ words: 'A tip for today.' }), 'facebook', null, null, {
        url: LINK,
        place: 'post',
      })!.linkPlace,
    ).toBeNull();
  });

  it('never promises a link when the business has none', () => {
    const post = checkedPost(
      answer({ hook: 'Tap the link below!', chain: ['Link in the reply below.'] }),
      'instagram',
    )!;
    expect(post.linkPlace).toBeNull();
    expect(post.words).toBe('Every missed call is a job someone else gets.');
    expect(post.hook).toBeNull();
    expect(post.chain).toEqual([]);
  });
});

describe('the link as the post goes up', () => {
  it('goes on its own line after the words and before the tags, when it goes in the post', () => {
    expect(
      postText('facebook', 'Book a demo at the link below.', ['crm'], {
        place: 'post',
        link: LINK,
      }),
    ).toBe(`Book a demo at the link below.\n\n${LINK}\n\n#crm`);
    // Not twice when the words hold it, and not at all when it goes in the bio or a comment.
    expect(postText('facebook', `Book at ${LINK}`, [], { place: 'post', link: LINK })).toBe(
      `Book at ${LINK}`,
    );
    expect(postText('facebook', 'Link in bio.', [], { place: 'bio', link: LINK })).toBe(
      'Link in bio.',
    );
  });

  it('is never cut off on a short network: the words make room for it', () => {
    const long = `${'Missed calls cost you work. '.repeat(12)}Book at the link below.`;
    const text = postText('x', long, ['crm'], { place: 'post', link: LINK });
    expect(text.length).toBeLessThanOrEqual(280);
    expect(text).toContain(`\n\n${LINK}\n\n#crm`);
  });
});

describe('what a post still needs, for its link', () => {
  const ready: ReadyCheck = {
    network: 'facebook',
    format: 'text',
    words: 'Book a free demo, link in the first comment.',
    slides: [],
    fileIds: [],
    videos: 0,
    postAt: '2026-11-25T15:00:00Z',
    facebookWhere: ['profile'],
  };

  it('asks for the business’s link before a post that carries one can be OK’d', () => {
    expect(stillNeeds({ ...ready, linkPlace: 'comment', link: null })).toMatch(/no link yet/);
    expect(stillNeeds({ ...ready, linkPlace: 'comment', link: LINK })).toBeNull();
  });

  it('asks where the link goes when the words point to one the post doesn’t carry', () => {
    expect(stillNeeds({ ...ready, linkPlace: null, link: LINK })).toMatch(/carries none/);
    expect(stillNeeds({ ...ready, linkPlace: null, link: null })).toMatch(
      /no link yet\. Add yours on the Playbook page, or take that out of its words/,
    );
    expect(
      stillNeeds({ ...ready, words: 'A tip for today.', linkPlace: null, link: LINK }),
    ).toBeNull();
    // Asked without the link (an older caller): not checked.
    expect(stillNeeds(ready)).toBeNull();
  });

  it('says on the post sheet whether the first comment went', () => {
    expect(W.link.commentWent).toBeTruthy();
    expect(W.link.commentFailed).toMatch(/didn’t go up\. Add it yourself/);
  });
});

describe('the prompt', () => {
  it('names the link as data', () => {
    expect(WRITE_SYSTEM).toMatch(/<link>/);
    expect(typeof writePrompt).toBe('function');
  });
});
