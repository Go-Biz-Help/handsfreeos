/**
 * The person's own steps on Instagram, noticed as they take them (src/networks/instagram/actions.ts; the Instagram and
 * Alignable plan's part 11), on pages drawn as the owner's Check Instagram outlined them (0.62.0) and Instagram's usual
 * markup: Follow (or Follow Back) on a profile or a list's row, Like on a post, a comment sent from a post's box, and a
 * message sent in a chat. And that each is a save HandsFreeOS takes.
 */
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { touchSave } from '../src/hfos/saves';
import {
  instagramNoticer,
  noticedFromClick,
  stepFromClick,
} from '../src/networks/instagram/actions';
import { instagram } from '../src/networks/instagram/kit';

const IG = 'https://www.instagram.com';
const WS = '00000000-0000-4000-8000-000000000001';
const page = (path: string, body: string) =>
  new JSDOM(`<!doctype html><html><body>${body}</body></html>`, { url: `${IG}${path}` }).window
    .document;
const click = (doc: Document, selector: string) =>
  stepFromClick(doc.querySelector(selector)!, doc, doc.location.href);
const noticed = (doc: Document, selector: string) =>
  noticedFromClick(doc.querySelector(selector)!, doc, doc.location.href);

/** The menu down the side, with the person's own Profile (me.owner). */
const MENU = `<div><a role="link" href="/"><span>Home</span></a>
  <a role="link" href="/me.owner/"><span dir="auto"><span>Profile</span></span></a></div>`;

/** Someone's profile, its header as the owner's Check outlined it, with Follow or what it says now. */
const profile = (button: string) =>
  page(
    '/dana.reyes/',
    `${MENU}<main role="main"><div><header><div>
      <section><a role="link" href="/dana.reyes/"><img alt=""></a></section>
      <section><div><a role="link" href="#"><h2 dir="auto"><span>dana.reyes</span></h2></a>
        <span dir="auto">Dana Reyes</span></div></section></div>
      <section><div><button id="follow"><div dir="auto">${button}</div></button><div role="button">Message</div></div></section>
    </header></div></main>`,
  );

describe('noting a follow on Instagram', () => {
  it('notes Follow on someone’s profile as a request to them, once it says Following', () => {
    const doc = profile('Follow');
    const seen = noticed(doc, '#follow div');
    expect(seen).toMatchObject({
      kind: 'maybe',
      step: {
        kind: 'friend_request',
        to: {
          name: 'Dana Reyes',
          profile: { id: null, username: 'dana.reyes', url: `${IG}/dana.reyes/` },
        },
        group: null,
        postUrl: null,
        thread: null,
      },
    });
    if (seen?.kind !== 'maybe') throw new Error('expected a maybe');
    // Instagram blocked it: still Follow, nothing noted.
    expect(seen.went()).toBe(false);
    doc.querySelector('#follow div')!.textContent = 'Following';
    expect(seen.went()).toBe(true);
    // A private account's: Requested.
    doc.querySelector('#follow div')!.textContent = 'Requested';
    expect(seen.went()).toBe(true);
  });

  it('notes Follow Back too, and nothing for Following or Message', () => {
    expect(noticed(profile('Follow Back'), '#follow')).toMatchObject({
      kind: 'maybe',
      step: { kind: 'friend_request', to: { profile: { username: 'dana.reyes' } } },
    });
    expect(noticed(profile('Following'), '#follow')).toBeNull();
    expect(noticed(profile('Follow'), '[role="button"]')).toBeNull();
  });

  it('notes Follow on a list’s row as a request to that row’s account', () => {
    const row = (username: string, name: string) =>
      `<div><a role="link" href="/${username}/"><img alt=""></a>
        <div><a role="link" href="/${username}/"><span dir="auto">${username}</span></a><span dir="auto">${name}</span></div>
        <button id="${username.replace('.', '-')}"><div dir="auto">Follow</div></button></div>`;
    const doc = page(
      '/explore/people/',
      `${MENU}<main><h4>Suggested</h4><div>${row('sam.lee', 'Sam Lee')}${row('kim_bakes', 'Kim Bakes')}</div></main>`,
    );
    expect(noticed(doc, '#sam-lee div')).toMatchObject({
      step: {
        kind: 'friend_request',
        to: { name: 'Sam Lee', profile: { username: 'sam.lee', url: `${IG}/sam.lee/` } },
      },
    });
    expect(noticed(doc, '#kim_bakes')).toMatchObject({
      step: { to: { name: 'Kim Bakes', profile: { username: 'kim_bakes' } } },
    });
  });

  it('notes nothing for a Follow it can’t tie to one account', () => {
    const doc = page(
      '/explore/people/',
      `${MENU}<main><div><a href="/sam.lee/">sam.lee</a><a href="/kim_bakes/">kim_bakes</a>
        <button id="follow">Follow</button></div></main>`,
    );
    expect(noticed(doc, '#follow')).toBeNull();
  });
});

/** A post's own page: its header, a comment with its own Like, its bar, and its box to comment in. */
const post = (author = 'dana.reyes', written = '') => {
  const doc = page(
    '/p/C3xyzabcd/',
    `${MENU}<main role="main"><div>
      <div><div><span dir="auto"><a role="link" href="/${author}/"><span dir="auto">${author}</span></a></span>
        <div role="button">Following</div></div>
        <div role="button"><svg role="img" aria-label="More options"></svg></div></div>
      <hr>
      <div><div><div><a role="link" href="/sam.lee/"><img alt=""></a>
        <div><div><div><div><span dir="auto"><a role="link" href="/sam.lee/"><span dir="auto">sam.lee</span></a></span>
          <span dir="auto"><a role="link" href="/p/C3xyzabcd/c/17900000000000001/"><time>2w</time></a></span></div>
          <span dir="auto">Great work!</span></div>
          <div><div role="button"><span dir="auto"><span>Reply</span></span></div></div></div>
          <div role="button" id="comment-like"><svg role="img" aria-label="Like"></svg></div></div></div></div></div></div>
      <div><section><div>
        <div role="button" id="like"><svg role="img" aria-label="Like"></svg></div>
        <div role="button"><svg role="img" aria-label="Comment"></svg></div>
        <div role="button"><svg role="img" aria-label="Share"></svg></div></div></section>
        <div dir="auto"><a role="link" href="/${author}/p/C3xyzabcd/"><time>October 1</time></a></div></div>
      <section><form><textarea aria-label="Add a comment…" placeholder="Add a comment…"></textarea>
        <div role="button" id="post">Post</div></form></section>
    </div></main>`,
  );
  doc.querySelector('textarea')!.value = written;
  return doc;
};

describe('noting a like on Instagram', () => {
  it('notes Like on a post to whoever posted it, with its link', () => {
    expect(click(post(), '#like svg')).toEqual({
      kind: 'like',
      to: {
        name: 'dana.reyes',
        profile: { id: null, username: 'dana.reyes', url: `${IG}/dana.reyes/` },
      },
      group: null,
      postUrl: `${IG}/p/C3xyzabcd/`,
      thread: null,
      replying: null,
    });
  });

  it('notes nothing for a comment’s Like, for Unlike, or on your own post', () => {
    expect(click(post(), '#comment-like')).toBeNull();
    const liked = post();
    liked.querySelector('#like svg')!.setAttribute('aria-label', 'Unlike');
    expect(click(liked, '#like')).toBeNull();
    expect(click(post('me.owner'), '#like')).toBeNull();
  });

  it('notes Like on a post in the feed, by its article’s own link', () => {
    const doc = page(
      '/',
      `${MENU}<main><article><div><a href="/sam.lee/"><span>sam.lee</span></a>
        <div role="button"><svg aria-label="More options"></svg></div></div>
        <section><div role="button" id="like"><svg aria-label="Like"></svg></div><div role="button"><svg aria-label="Comment"></svg></div></section>
        <a href="/sam.lee/p/C7feedpost/"><time>1h</time></a></article></main>`,
    );
    expect(click(doc, '#like')).toMatchObject({
      kind: 'like',
      to: { profile: { username: 'sam.lee' } },
      postUrl: `${IG}/p/C7feedpost/`,
    });
  });
});

describe('noting a comment on Instagram', () => {
  it('notes Post with something written as a comment to whoever posted it, with its link', () => {
    expect(click(post('dana.reyes', 'Nice fix!'), '#post')).toMatchObject({
      kind: 'comment',
      to: { profile: { username: 'dana.reyes' } },
      postUrl: `${IG}/p/C3xyzabcd/`,
    });
  });

  it('notes an answer to a comment as to whoever wrote it, by the name it starts with', () => {
    expect(click(post('dana.reyes', '@sam.lee thank you!'), '#post')).toMatchObject({
      kind: 'comment',
      to: { profile: { username: 'sam.lee' } },
    });
  });

  it('notes nothing with nothing written, and Enter only once the box empties', () => {
    expect(click(post(), '#post')).toBeNull();
    const doc = post('dana.reyes', 'Nice fix!');
    const box = doc.querySelector('textarea')!;
    const seen = instagramNoticer().enter(box, doc, doc.location.href);
    expect(seen).toMatchObject({ kind: 'maybe', step: { kind: 'comment' } });
    if (seen?.kind !== 'maybe') throw new Error('expected a maybe');
    expect(seen.went()).toBe(false);
    box.value = '';
    expect(seen.went()).toBe(true);
  });
});

/** A chat on its own page, with what's written in its box. */
const chat = (
  written: string,
  people = '<a role="link" href="/dana.reyes/"><span title="Dana Reyes">Dana Reyes</span></a>',
) =>
  page(
    '/direct/t/340282366841710300/',
    `${MENU}<main><div>${people}</div>
      <div aria-label="Messages in conversation with Dana Reyes"><div role="grid"></div></div>
      <div><div role="textbox" contenteditable="true" aria-label="Message">${written}</div>
        <div role="button" id="send">Send</div></div></main>`,
  );

describe('noting a message on Instagram', () => {
  it('notes Send in a chat to who it’s with, with the chat’s id', () => {
    expect(click(chat('Hi Dana, are you taking new clients?'), '#send')).toEqual({
      kind: 'message',
      to: {
        name: 'Dana Reyes',
        profile: { id: null, username: 'dana.reyes', url: `${IG}/dana.reyes/` },
      },
      group: null,
      postUrl: null,
      thread: {
        id: '340282366841710300',
        encrypted: false,
        url: `${IG}/direct/t/340282366841710300/`,
      },
      replying: null,
    });
  });

  it('notes nothing with nothing written, or in a chat with more than one other person', () => {
    expect(click(chat(''), '#send')).toBeNull();
    expect(
      click(
        chat('Hi all', '<a href="/dana.reyes/">dana.reyes</a><a href="/sam.lee/">sam.lee</a>'),
        '#send',
      ),
    ).toBeNull();
  });

  it('notes Enter in its box only once the box empties', () => {
    const doc = chat('Hi Dana');
    const box = doc.querySelector('[role="textbox"]')!;
    const seen = instagramNoticer().enter(box, doc, doc.location.href);
    expect(seen).toMatchObject({ kind: 'maybe', step: { kind: 'message' } });
    if (seen?.kind !== 'maybe') throw new Error('expected a maybe');
    expect(seen.went()).toBe(false);
    box.textContent = '';
    expect(seen.went()).toBe(true);
  });
});

describe('what’s noted on Instagram, as HandsFreeOS takes it', () => {
  it('is a save on Instagram, by the account’s name in its address', () => {
    const follow = noticed(profile('Follow'), '#follow');
    if (follow?.kind !== 'maybe') throw new Error('expected a maybe');
    expect(touchSave(follow.step, WS, null, 'instagram')).toEqual({
      ok: true,
      input: {
        workspaceId: WS,
        platform: 'instagram',
        kind: 'friend_request',
        profile: { id: null, username: 'dana.reyes', url: `${IG}/dana.reyes/` },
        name: 'Dana Reyes',
        group: null,
        postUrl: null,
        threadKey: null,
        replying: null,
        auto: false,
      },
    });
    expect(touchSave(click(post(), '#like')!, WS, null, 'instagram')).toMatchObject({
      ok: true,
      input: { kind: 'like', platform: 'instagram', postUrl: `${IG}/p/C3xyzabcd/` },
    });
    expect(touchSave(click(chat('Hi'), '#send')!, WS, null, 'instagram')).toMatchObject({
      ok: true,
      input: { kind: 'message', platform: 'instagram', threadKey: '340282366841710300' },
    });
    // Instagram's kit notes them now.
    const doc = post();
    expect(
      instagram.noticer().click(doc.querySelector('#like')!, doc, doc.location.href),
    ).toMatchObject({ kind: 'step', step: { kind: 'like' } });
  });
});
