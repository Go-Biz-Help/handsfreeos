/**
 * A post's comments on its own page in LinkedIn's newer layout, as the owner's page outlines of 31 Oct and 4 Nov 2026
 * drew it (test/fixtures/linkedin-post-2026-11.html, a hand-written page of made-up people): the comments are boxes
 * BESIDE the post's box, not in it. Reading only inside the post found none of them: a comment research read 109
 * LinkedIn posts and kept no comment (22 Nov 2026). Each as written and again with a bare box around every element.
 * In a feed, a post's comments are still only its own.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LINKEDIN_RESEARCH } from '../src/jobs/linkedin/comment-research';
import type { Job, JobTab } from '../src/jobs/job';
import {
  commentsOnceDrawn,
  readComments,
  readCommenters,
  theirCommentOn,
} from '../src/networks/linkedin/compose';
import { postOnPage } from '../src/networks/linkedin/auto';
import { mainOf } from '../src/networks/linkedin/dom';
import { readPage } from '../src/networks/linkedin/page';
import { commentsPlaceOf, newerComments, postBoxes } from '../src/networks/linkedin/posts';
import type { ProfileRef } from '../src/networks/linkedin/types';
import { work } from '../src/networks/linkedin/work';
import { boxEverything, load } from './load';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const LI = 'https://www.linkedin.com';
const POST = `${LI}/feed/update/urn:li:activity:7380000000000000777/`;
const byName = (username: string): ProfileRef => ({
  id: null,
  username,
  url: `${LI}/in/${username}/`,
});
const PRIYA = byName('priya-dalton-hvac');
const JADE = byName('jade-moreno-events');

const SHAPES = [
  ['as written', false],
  ['with a bare box around every element', true],
] as const;

function page(boxed: boolean): Document {
  const doc = load('linkedin-post-2026-11.html', POST);
  if (boxed) boxEverything(doc);
  return doc;
}

describe.each(SHAPES)('a post’s own page with its comments beside it, %s', (_shape, boxed) => {
  it('is one post, and its comments aren’t in its box', () => {
    const doc = page(boxed);
    const posts = postBoxes(mainOf(doc));
    expect(posts).toHaveLength(1);
    expect(posts[0]!.querySelector('[aria-label="Reply"]')).toBeNull();
    expect(doc.querySelectorAll('main [aria-label="Reply"]').length).toBeGreaterThan(3);
  });

  it('reads who commented and what each said, never the person', () => {
    const said = readComments(page(boxed), POST);
    expect(said.map((c) => c.profile.username)).toEqual([
      'hector-ruiz-pm',
      'priya-dalton-hvac',
      'sam-lee-77',
      'jade-moreno-events',
    ]);
    expect(said[0]!.comment).toBe('Following. We need the same for our units on Hopkins Street.');
    for (const one of said) expect(one.comment).toBeTruthy();
    // The person's own card beside the post is nobody's comment.
    expect(said.some((c) => c.profile.username === 'chris-gee-12')).toBe(false);
  });

  it('leaves out the post’s writer when asked, and a 1st-degree connection among a good post’s people', () => {
    const doc = page(boxed);
    expect(readComments(doc, POST, { skip: [PRIYA] }).map((c) => c.profile.username)).toEqual([
      'hector-ruiz-pm',
      'sam-lee-77',
      'jade-moreno-events',
    ]);
    expect(readCommenters(doc, POST, { skip: [PRIYA] }).map((c) => c.profile.username)).toEqual([
      'hector-ruiz-pm',
      'jade-moreno-events',
    ]);
  });

  it('finds their comment with its own Like', () => {
    const theirs = theirCommentOn(page(boxed), POST, JADE);
    expect(theirs?.text).toBeTruthy();
    expect(theirs?.like).not.toBeNull();
  });

  it('looks no further than the part of the page that holds the post alone', () => {
    const doc = page(boxed);
    const post = postOnPage(doc)!;
    const place = commentsPlaceOf(post);
    expect(place).not.toBe(post);
    expect(place.contains(post)).toBe(true);
    expect(place.closest('main')).not.toBeNull();
    expect(place.matches('main')).toBe(false);
    expect(newerComments(post).length).toBeGreaterThanOrEqual(4);
  });
});

describe.each(SHAPES)('a feed’s posts, %s', (_shape, boxed) => {
  it('keeps each post’s comments its own', () => {
    const doc = load('linkedin-feed-2026-10.html', `${LI}/feed/`);
    if (boxed) boxEverything(doc);
    const posts = postBoxes(mainOf(doc));
    expect(posts.length).toBeGreaterThan(1);
    for (const post of posts) {
      // Its own box, or a bare box around it alone: never a part of the page another post is in.
      const place = commentsPlaceOf(post);
      expect(posts.filter((other) => place.contains(other))).toEqual([post]);
      for (const comment of newerComments(post)) expect(post.contains(comment)).toBe(true);
    }
  });
});

describe('the comment research on a post with its comments beside it', () => {
  const NAMES = ['hector-ruiz-pm', 'priya-dalton-hvac', 'sam-lee-77', 'jade-moreno-events'];
  /** The page as LinkedIn has it at first: the post drawn, its comments not yet. */
  function early() {
    const doc = page(false);
    const post = postOnPage(doc)!;
    const drawn = newerComments(post).filter(
      (comment, _i, all) => !all.some((other) => other !== comment && other.contains(comment)),
    );
    // Each comment taken out, with a mark left where it was to put it back.
    const marks = drawn.map((comment) => {
      const mark = doc.createComment('a comment, not drawn yet');
      comment.replaceWith(mark);
      return { comment, mark };
    });
    return { doc, draw: () => marks.forEach(({ comment, mark }) => mark.replaceWith(comment)) };
  }

  it('waits a few seconds for a post that says it has comments to draw them', async () => {
    vi.useFakeTimers();
    const { doc, draw } = early();
    expect(readComments(doc, POST)).toEqual([]);
    const reading = commentsOnceDrawn(doc, POST);
    setTimeout(draw, 1_000);
    await vi.advanceTimersByTimeAsync(1_500);
    expect((await reading).map((c) => c.profile.username)).toEqual(NAMES);
    // One that never draws any is given up on.
    const never = commentsOnceDrawn(early().doc, POST);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(await never).toEqual([]);
  });

  it('keeps what other people commented there, never the post’s writer', async () => {
    const doc = page(false);
    const tab = {
      async open() {},
      async ask(message: { readonly type: string }) {
        if (message.type === 'hfos-read') return { ok: true, result: readPage(doc, POST) };
        vi.stubGlobal('document', doc);
        vi.stubGlobal('location', new URL(POST));
        return work(message);
      },
    } as unknown as JobTab;
    const job = { tab, stopped: () => false, warn: async () => undefined } as unknown as Job;
    const words = await LINKEDIN_RESEARCH.comments(job, POST);
    const all = readComments(doc, POST);
    const writer = readPage(doc, POST).posts![0]!.author!.profile!.username;
    expect(all.length).toBe(4);
    expect(words).toEqual(all.filter((c) => c.profile.username !== writer).map((c) => c.comment));
    expect((words as string[]).length).toBeGreaterThanOrEqual(3);
  });
});
