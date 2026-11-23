/**
 * A Facebook post on its own address, drawn in a box over the page (the owner's page outline of 22 Nov 2026): the post
 * and its comments are in a dialog, and the page behind it is a feed of other people's posts with THEIR comments,
 * hidden. Until 0.151.1 the readers read that feed, so the comment research (docs/outreach.md, decision 172) kept the
 * same few comments under somebody else's post for every post it opened: 44 kept, 6 different. On a made-up page.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LOOK_WANT } from '../src/auto/post-look';
import type { GroupPostAnswer, GroupPostAsk, PostLookAnswer, PostLookAsk } from '../src/messages';
import {
  commentsOnceDrawn,
  postWriter,
  readComments,
  readReactions,
} from '../src/networks/facebook/compose';
import { readPage } from '../src/networks/facebook/page';
import { pagePost, postOver } from '../src/networks/facebook/posts';
import { work } from '../src/networks/facebook/work';
import { FACEBOOK_RESEARCH } from '../src/jobs/facebook-research';
import type { Job, JobTab } from '../src/jobs/job';
import { boxEverything, load } from './load';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const FB = 'https://www.facebook.com';
const POST = `${FB}/dana.reyes.12/posts/pfbid0aaaa1111bbbb2222`;
const page = () => load('post-over-page-2026-11.html', POST);
/** The same page with a bare box around everything, as Facebook wraps it. */
const shapes = () => [page(), boxEverything(page())];

/** A page in the tab, as the tab's own script sees it. */
function inTab(doc: Document) {
  vi.stubGlobal('document', doc);
  vi.stubGlobal('location', new URL(POST));
}

const said = (doc: Document) => readComments(doc, POST).map((c) => [c.name, c.comment]);

describe('a post Facebook opened in a box over the page', () => {
  it('is the post the page shows, never one in the feed behind it', () => {
    for (const doc of shapes()) {
      const over = postOver(doc)!;
      expect(over.getAttribute('role')).toBe('dialog');
      expect(pagePost(doc)).toBe(over);
      const read = readPage(doc, POST);
      expect(read.kind).toBe('post');
      expect(read.posts).toHaveLength(1);
      expect(read.posts![0]).toMatchObject({
        author: { name: 'Dana Reyes', profile: { username: 'dana.reyes.12' } },
        url: `${FB}/dana.reyes.12/posts/pfbid0aaaa1111bbbb2222`,
        text: 'New tiles in the kitchen. Took us three weekends!',
        comments: 6,
      });
      expect(postWriter(doc, POST)).toMatchObject({ username: 'dana.reyes.12' });
    }
  });

  it('reads that post’s comments: emoji put back, Facebook’s mark left out, never the person', () => {
    for (const doc of shapes())
      expect(said(doc)).toEqual([
        ['Sam Lee', 'Looks so good 😍'],
        // The writer's own, marked "by author" for screen readers: the words alone.
        ['Dana Reyes', 'Thank you Sam!'],
        ['Jo Park', 'who did the grout? asking for my own kitchen lol'],
        // Only emoji, which Facebook draws as pictures.
        ['Kit Moss', '🔥🔥'],
      ]);
  });

  it('never reads a comment under another post in the feed behind', () => {
    for (const doc of shapes()) {
      const names = readComments(doc, POST).map((c) => c.name);
      expect(names).not.toContain('Priya Shah');
      expect(names).not.toContain('Leo Grant');
      expect(JSON.stringify(said(doc))).not.toContain('gutter');
    }
  });

  it('leaves Facebook’s mark out when it sits inside the words', () => {
    const doc = page();
    doc.querySelector('[aria-label^="Reply by Dana Reyes"]')!.remove();
    expect(said(doc)).toContainEqual(['Dana Reyes', 'Glad you all like it']);
  });

  it('still reads a post drawn on the page itself, with nothing over it', () => {
    const doc = load(
      'group-post-2026.html',
      `${FB}/groups/7766554433221100/posts/5555666677778888/`,
    );
    expect(postOver(doc)).toBeNull();
    expect(readComments(doc, doc.URL).map((c) => c.name)).toEqual(['Priya Shah', 'Leo Grant']);
  });
});

describe('waiting for a post’s comments to be drawn', () => {
  /** The page as Facebook has it at first: the post drawn, its comments not yet. */
  function early() {
    const doc = page();
    const comments = [...postOver(doc)!.querySelectorAll('[role="article"]')];
    const place = comments[0]!.parentElement!;
    for (const comment of comments) comment.remove();
    return { doc, draw: () => place.append(...comments) };
  }

  it('reads them once they’re there', async () => {
    vi.useFakeTimers();
    const { doc, draw } = early();
    expect(readComments(doc, POST)).toEqual([]);
    const reading = commentsOnceDrawn(doc, POST);
    setTimeout(draw, 1_000);
    await vi.advanceTimersByTimeAsync(1_500);
    expect((await reading).map((c) => c.name)).toEqual([
      'Sam Lee',
      'Dana Reyes',
      'Jo Park',
      'Kit Moss',
    ]);
  });

  it('gives up after a few seconds, and doesn’t wait on a post that says it has none', async () => {
    vi.useFakeTimers();
    const { doc } = early();
    const reading = commentsOnceDrawn(doc, POST);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await reading).toEqual([]);
    // Its Comment button says 0: nothing to wait for.
    const none = early().doc;
    none.querySelector('[role="dialog"] [aria-label="Leave a comment"] span')!.textContent = '0';
    expect(await commentsOnceDrawn(none, POST)).toEqual([]);
  });
});

describe('the tab’s answers on a post over the page', () => {
  it('gives the comment research the comments and who wrote the post, pressing nothing', async () => {
    const doc = page();
    let pressed = 0;
    doc.addEventListener('click', () => pressed++);
    inTab(doc);
    const ask: GroupPostAsk = { type: 'hfos-engaged', reactions: false };
    const answer = (await work(ask)) as GroupPostAnswer;
    expect(answer).toMatchObject({
      ok: true,
      reactions: [],
      writer: { username: 'dana.reyes.12' },
    });
    expect('comments' in answer && answer.comments.map((c) => c.name)).toEqual([
      'Sam Lee',
      'Dana Reyes',
      'Jo Park',
      'Kit Moss',
    ]);
    expect(pressed).toBe(0);
  });

  it('reads who reacted from the box it opens, never taking the post’s own box for it', async () => {
    const doc = page();
    // A post closed to new comments has no box to write in, as the box of who reacted hasn't.
    doc.querySelector('[role="textbox"]')!.closest('form')!.remove();
    const reacted = postOver(doc)!.querySelector(
      '[aria-label="See who reacted to this"] [role="button"]',
    )!;
    reacted.addEventListener('click', () => {
      const box = doc.createElement('div');
      box.setAttribute('role', 'dialog');
      box.innerHTML = `
        <a href="/sam.lee.77">Sam Lee</a>
        <a href="/robin.hale.77">Robin Hale</a>
        <a href="/ivy.cho.2">Ivy Cho</a>
        <div role="button" aria-label="Close"></div>`;
      box.querySelector('[aria-label="Close"]')!.addEventListener('click', () => box.remove());
      doc.body.append(box);
    });
    vi.useFakeTimers({ shouldAdvanceTime: true, advanceTimeDelta: 50 });
    expect((await readReactions(doc, POST)).map((r) => r.name)).toEqual(['Sam Lee', 'Ivy Cho']);
    // The box of who reacted is closed after; the post's stays.
    expect(postOver(doc)).not.toBeNull();
    expect(doc.querySelectorAll('[role="dialog"]')).toHaveLength(2);
  });

  it('sees the post’s own photo before a comment is drafted, when the post is theirs', async () => {
    inTab(page());
    const look = (username: string) => {
      const ask: PostLookAsk = {
        type: 'hfos-post-look',
        profile: { id: null, username, url: `${FB}/${username}` },
        postUrl: POST,
        want: LOOK_WANT,
      };
      return work(ask) as Promise<PostLookAnswer & { ok: true }>;
    };
    expect((await look('dana.reyes.12')).seen).toEqual({
      kind: 'photo',
      url: 'https://scontent.example-fbcdn.net/v/t39/kitchen-tiles.jpg',
    });
    // The feed behind is Owen Pratt's post: never his, here.
    expect((await look('owen.pratt.3')).seen).toBeNull();
  });
});

describe('the comment research on a post over the page', () => {
  it('keeps what other people commented, never the post’s writer', async () => {
    const doc = page();
    const tab = {
      async open() {},
      async ask(message: { readonly type: string }) {
        if (message.type === 'hfos-read') return { ok: true, result: readPage(doc, POST) };
        inTab(doc);
        return work(message);
      },
    } as unknown as JobTab;
    const job = { tab, stopped: () => false, warn: async () => undefined } as unknown as Job;
    expect(await FACEBOOK_RESEARCH.comments(job, POST)).toEqual([
      'Looks so good 😍',
      'who did the grout? asking for my own kitchen lol',
      '🔥🔥',
    ]);
  });
});
