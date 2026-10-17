/**
 * Networks still looked at (src/networks/looking/, docs/outreach.md decision 78): Instagram's and Alignable's addresses,
 * what a read of their pages finds, their outlines with what people wrote hidden, their warnings, and the looks for each
 * step's button, which never press it. On small pages written here by hand from how the sites have long been drawn:
 * Check sends back the real ones, and these are tuned from that.
 */
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { ALIGNABLE } from '../src/networks/alignable/site';
import { INSTAGRAM } from '../src/networks/instagram/site';
import { outlineLooking, readLooking, readWarnings } from '../src/networks/looking/read';
import type { LookingSite } from '../src/networks/looking/site';

const IG = 'https://www.instagram.com';
const AL = 'https://www.alignable.com';
const NOW = new Date('2026-10-17T12:00:00Z');

const page = (url: string, body: string, title = '') =>
  new JSDOM(
    `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`,
    {
      url,
    },
  ).window.document;

/** Instagram's menu, as it draws it beside every page: Profile links to the person's own account. */
const IG_MENU = `<nav role="navigation">
  <a href="/" role="link"><span>Home</span></a>
  <a href="/explore/" role="link"><span>Explore</span></a>
  <a href="/direct/inbox/" role="link"><span>Messages</span></a>
  <a href="/casey.owner/" role="link"><img alt="casey.owner's profile picture" /><span>Profile</span></a>
</nav>`;

const look = async (site: LookingSite, step: keyof LookingSite['looks'], doc: Document) =>
  site.looks[step]!.look(doc, doc.location.href);

describe('Instagram’s addresses', () => {
  const kind = (path: string) => INSTAGRAM.kindOf(INSTAGRAM.url(`${IG}${path}`)!);

  it('tells its pages apart by their address alone', () => {
    expect(kind('/')).toBe('feed');
    expect(kind('/dana.reyes/')).toBe('profile');
    expect(kind('/dana.reyes/followers/')).toBe('followers');
    expect(kind('/p/C9xYz12AbCd/')).toBe('post');
    expect(kind('/dana.reyes/p/C9xYz12AbCd/')).toBe('post');
    expect(kind('/reel/C9xYz12AbCd/')).toBe('post');
    expect(kind('/explore/tags/smallbusiness/')).toBe('tag');
    expect(kind('/explore/search/keyword/?q=small%20business')).toBe('search');
    expect(kind('/explore/people/')).toBe('suggested');
    expect(kind('/direct/inbox/')).toBe('inbox');
    expect(kind('/direct/t/340282366841710300949128123456789/')).toBe('chat');
    expect(kind('/accounts/edit/')).toBe('edit-profile');
    expect(kind('/challenge/')).toBe('check');
    expect(INSTAGRAM.url('https://www.instagram.com.example.com/')).toBeNull();
    expect(INSTAGRAM.url('http://www.instagram.com/')).toBeNull();
    expect(INSTAGRAM.url('https://instagram.com/dana.reyes/')?.hostname).toBe('www.instagram.com');
  });

  it('knows an account and a post by their links, however they’re written', () => {
    const at = (path: string) => INSTAGRAM.url(`${IG}${path}`)!;
    expect(INSTAGRAM.profileOf(at('/dana.reyes/'))).toEqual({
      username: 'dana.reyes',
      url: `${IG}/dana.reyes/`,
    });
    expect(INSTAGRAM.profileOf(at('/dana.reyes/tagged/'))?.username).toBe('dana.reyes');
    for (const notOne of [
      '/explore/',
      '/p/C9xYz12AbCd/',
      '/accounts/edit/',
      '/dana.reyes/followers/',
    ])
      expect(INSTAGRAM.profileOf(at(notOne))).toBeNull();
    expect(INSTAGRAM.postOf(at('/dana.reyes/p/C9xYz12AbCd/'))).toBe(`${IG}/p/C9xYz12AbCd/`);
    expect(INSTAGRAM.postOf(at('/reel/C9xYz12AbCd/?igsh=abc'))).toBe(`${IG}/reel/C9xYz12AbCd/`);
    expect(INSTAGRAM.postOf(at('/dana.reyes/'))).toBeNull();
  });
});

describe('a read of an Instagram page', () => {
  const feed = () =>
    page(
      `${IG}/`,
      `${IG_MENU}<main role="main">
        <article>
          <a href="/dana.reyes/"><span>dana.reyes</span></a>
          <a href="/p/C9xYz12AbCd/"><time>3h</time></a>
          <span>Big week at the shop, thank you all</span>
          <div role="button"><svg aria-label="Like"></svg></div>
        </article>
        <article>
          <a href="/sam.carter/"><span>sam.carter</span></a>
          <a href="/sam.carter/p/D1aBc34DeFg/"><time>1d</time></a>
        </article>
      </main>`,
      'Instagram',
    );

  it('finds the accounts and posts it links to, its menu’s places, and the person’s own account', () => {
    const read = readLooking(feed(), `${IG}/`, INSTAGRAM, NOW);
    expect(read).toMatchObject({
      platform: 'instagram',
      kind: 'feed',
      people: [{ url: `${IG}/dana.reyes/` }, { url: `${IG}/sam.carter/` }],
      posts: [{ url: `${IG}/p/C9xYz12AbCd/` }, { url: `${IG}/p/D1aBc34DeFg/` }],
      own: `${IG}/casey.owner/`,
      warnings: [],
      signedOut: false,
    });
    expect(read.places.map((p) => p.name)).toEqual(['Explore', 'Messages', 'Profile']);
  });

  it('never takes an account’s own header for a menu, nor counts the account as someone it links to', () => {
    const doc = page(
      `${IG}/dana.reyes/`,
      `${IG_MENU}<main role="main"><header>
        <h2>dana.reyes</h2><span>Plumbing in Austin, with <a href="/sam.carter/">@sam.carter</a></span>
      </header>
      <div role="tablist"><a href="/dana.reyes/">Posts</a><a href="/dana.reyes/tagged/">Tagged</a></div>
      <a href="/dana.reyes/p/C9xYz12AbCd/">a post</a></main>`,
    );
    const read = readLooking(doc, doc.location.href, INSTAGRAM, NOW);
    expect(read.people).toEqual([{ url: `${IG}/sam.carter/` }]);
    expect(read.places.map((p) => p.name)).toEqual(['Home', 'Explore', 'Messages', 'Profile']);
  });

  it('says when Instagram asks the person to sign in', () => {
    const doc = page(
      `${IG}/accounts/login/`,
      `<main><form><input name="username" /><input type="password" name="password" /></form></main>`,
    );
    expect(readLooking(doc, doc.location.href, INSTAGRAM, NOW).signedOut).toBe(true);
  });

  it('outlines it with names, words and accounts hidden, and Instagram’s own words kept', () => {
    const outline = outlineLooking(feed(), `${IG}/`, INSTAGRAM, {
      version: '0.58.0',
      found: readLooking(feed(), `${IG}/`, INSTAGRAM, NOW),
    });
    expect(outline).toContain('Page: feed /');
    expect(outline).toContain('"Messages"');
    expect(outline).toContain('aria-label="Like"');
    expect(outline).toContain('"3h"');
    for (const hidden of ['dana.reyes', 'sam.carter', 'casey.owner', 'Big week'])
      expect(outline).not.toContain(hidden);
    expect(outline).toContain('"[8 words]"');
  });

  it('reads a warning in a box over the page, never in a post', () => {
    const doc = page(
      `${IG}/dana.reyes/`,
      `<main><article><h2>Try again later, they said</h2></article></main>
       <div role="dialog"><h3>Try Again Later</h3><span>We restrict certain activity to protect our community.</span></div>`,
    );
    expect(readWarnings(doc, doc.location.href, INSTAGRAM)).toEqual([
      'Try Again Later',
      'We restrict certain activity to protect our community.',
    ]);
    expect(readWarnings(page(`${IG}/challenge/`, ''), `${IG}/challenge/`, INSTAGRAM)).toEqual([
      'Instagram is asking you to confirm it’s you before you go on.',
    ]);
  });
});

describe('Instagram’s looks, which never press a step’s last button', () => {
  /** An account's header, as the owner's Check read it: Following is its word beside an arrow with a title. */
  const profile = (button: string) =>
    page(
      `${IG}/dana.reyes/`,
      `${IG_MENU}<main role="main"><header><section><h2>dana.reyes</h2>
        <div role="button"><svg aria-label="Options"><title>Options</title></svg></div></section>
        <section><button type="button"><div><div dir="auto">${button}</div>
          <svg aria-label="Down chevron icon" role="img"><title>Down chevron icon</title></svg></div></button>
        <div role="button">Message</div>
        <div role="button"><svg aria-label="Similar accounts"><title>Similar accounts</title></svg></div></section>
      </header></main>`,
    );

  /** Pressing Message on the account opens a chat over the page, with its own Close. */
  const withChat = (doc: Document) => {
    const message = [...doc.querySelectorAll('[role="button"]')].find(
      (b) => b.textContent === 'Message',
    )!;
    message.addEventListener('click', () => {
      const chat = doc.createElement('div');
      chat.innerHTML = `<div role="button" aria-label="Close"><svg></svg></div>
        <div role="textbox" contenteditable="true" aria-label="Message"></div>`;
      chat.querySelector('[aria-label="Close"]')!.addEventListener('click', () => chat.remove());
      doc.body.append(chat);
    });
    return doc;
  };

  it('finds Follow without pressing it, and tries none on someone they follow already', async () => {
    let pressed = 0;
    const doc = profile('Follow');
    doc
      .querySelectorAll('button, [role="button"]')
      .forEach((b) => b.addEventListener('click', () => pressed++));
    expect(await look(INSTAGRAM, 'follow', doc)).toMatchObject({
      works: true,
      found: { found: 1 },
    });
    expect(pressed).toBe(0);
    // Following, beside its arrow: once read as the arrow's "Down chevron icon", so Follow was missing.
    expect(await look(INSTAGRAM, 'follow', profile('Following'))).toMatchObject({
      tried: false,
      missing: ['you follow them already, or asked to'],
    });
    const none = await look(INSTAGRAM, 'follow', profile('Edit profile'));
    expect(none).toMatchObject({ works: false, missing: ['no Follow on the page'] });
    expect(none.seen).toContain('Edit profile');
  });

  it('opens Message’s chat to find its box, writes nothing in it, and closes it again', async () => {
    const doc = withChat(profile('Following'));
    const tried = await look(INSTAGRAM, 'message', doc);
    expect(tried).toMatchObject({
      works: true,
      found: { message: true, box: true, chatPage: false, closed: true },
    });
    expect(doc.querySelector('[role="textbox"]')).toBeNull();
    const nothing = await look(INSTAGRAM, 'message', profile('Following'));
    expect(nothing).toMatchObject({
      works: false,
      missing: ['Message opened no chat to write in'],
    });
    expect(nothing.outline).toContain('Page: profile');
  }, 15_000);

  it('finds a post’s Like, and its Post once a word is written, then empties the box again', async () => {
    const doc = page(
      `${IG}/p/C9xYz12AbCd/`,
      `<main role="main"><article>
        <div role="button"><svg aria-label="Like"><title>Like</title></svg></div>
        <form><div role="button"><svg aria-label="Emoji"></svg></div>
          <textarea aria-label="Add a comment…" placeholder="Add a comment…"></textarea></form>
      </article></main>`,
    );
    // As Instagram draws it: Post shows only while something's written in the box.
    const box = doc.querySelector('textarea')!;
    let posted = 0;
    box.addEventListener('input', () => {
      doc.querySelector('form [data-post]')?.remove();
      if (!box.value) return;
      const post = doc.createElement('div');
      post.setAttribute('role', 'button');
      post.setAttribute('data-post', '');
      post.textContent = 'Post';
      post.addEventListener('click', () => posted++);
      box.after(post);
    });
    expect(await look(INSTAGRAM, 'like', doc)).toMatchObject({
      works: true,
      found: { like: 1, liked: false },
    });
    expect(await look(INSTAGRAM, 'comment', doc)).toMatchObject({
      works: true,
      found: { box: true, typed: true, post: 1, emptied: true },
    });
    expect(box.value).toBe('');
    expect(posted).toBe(0);
    // With nothing drawn after a word's written, it says so.
    const still = page(
      `${IG}/p/C9xYz12AbCd/`,
      `<main role="main"><form><textarea aria-label="Add a comment…"></textarea></form></main>`,
    );
    expect(await look(INSTAGRAM, 'comment', still)).toMatchObject({
      works: false,
      missing: ['no Post by the box to comment in, with a word written in it'],
    });
    expect(still.querySelector('textarea')!.value).toBe('');
  }, 15_000);

  it('finds the bio’s box and Submit on their own profile’s form', async () => {
    const doc = page(
      `${IG}/accounts/edit/`,
      `<main><form><label for="pepBio">Bio</label><textarea id="pepBio"></textarea>
        <button type="submit">Submit</button></form></main>`,
    );
    expect(await look(INSTAGRAM, 'bio', doc)).toMatchObject({
      works: true,
      found: { box: true, submit: 1 },
    });
  });
});

describe('Alignable, as far as its public pages show it', () => {
  const kind = (path: string) => ALIGNABLE.kindOf(ALIGNABLE.url(`${AL}${path}`)!);

  it('knows its places by the first word of their address, and a business in its town', () => {
    // Its public home page, signed in or not (the owner's Check, 17 Oct 2026); its signed-in pages are under /biz.
    expect(kind('/')).toBe('front');
    expect(kind('/biz')).toBe('home');
    expect(kind('/biz/inbox')).toBe('inbox');
    expect(kind('/biz/whatever')).toBe('app');
    expect(kind('/dashboard')).toBe('home');
    expect(kind('/inbox')).toBe('inbox');
    expect(kind('/forum')).toBe('forum');
    expect(kind('/austin-tx/acme-plumbing')).toBe('business');
    expect(kind('/austin-tx')).toBe('town');
    expect(kind('/whatever')).toBe('other');
    expect(ALIGNABLE.profileOf(ALIGNABLE.url(`${AL}/austin-tx/acme-plumbing/dana-reyes`)!)).toEqual(
      {
        username: 'austin-tx-acme-plumbing-dana-reyes',
        url: `${AL}/austin-tx/acme-plumbing/dana-reyes`,
      },
    );
    expect(ALIGNABLE.profileOf(ALIGNABLE.url(`${AL}/forum`)!)).toBeNull();
  });

  it('reads its menu’s places by their words, and looks for each step on a page', async () => {
    const doc = page(
      `${AL}/biz`,
      `<header><nav>
        <a href="/">Alignable</a><a href="/biz/network">My Network</a><a href="/inbox">Messages</a>
        <a href="/forum">Forum</a><a href="/me">My Profile</a><a href="/about">About Us</a>
        <a href="/pricing">Wonders</a><a href="/logout">Log Out</a><a href="/plus">Alignable Plus</a>
      </nav></header>
      <main>
        <div><a href="/austin-tx/acme-plumbing/dana-reyes">Dana Reyes</a><button>Connect</button></div>
        <div><button>Like</button><button>Comment</button><textarea placeholder="Write a comment..."></textarea></div>
      </main>`,
    );
    const read = readLooking(doc, `${AL}/biz`, ALIGNABLE, NOW);
    // Decided on their real words in the tab: never its public home page, its company pages, signing out or paying.
    expect(read.places.map((p) => [p.name, p.worth])).toEqual([
      ['My Network', true],
      ['Messages', true],
      ['Forum', true],
      ['My Profile', true],
    ]);
    expect(read.own).toBe(`${AL}/me`);
    expect(read.people).toEqual([{ url: `${AL}/austin-tx/acme-plumbing/dana-reyes` }]);
    expect(await look(ALIGNABLE, 'connect', doc)).toMatchObject({ works: true });
    expect(await look(ALIGNABLE, 'like', doc)).toMatchObject({ works: true });
    expect(await look(ALIGNABLE, 'comment', doc)).toMatchObject({
      works: true,
      found: { boxes: 1, comment: 1 },
    });
    const recommend = await look(ALIGNABLE, 'recommend', doc);
    expect(recommend).toMatchObject({ works: false, missing: ['no Recommend on the page'] });
    expect(recommend.seen).toEqual(expect.arrayContaining(['Connect', 'Like', 'Comment']));
    // A name on the page is never among what it says it saw.
    expect(recommend.seen).not.toContain('Dana Reyes');
  });
});
