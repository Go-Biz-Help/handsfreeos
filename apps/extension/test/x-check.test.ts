/**
 * What the owner's first Check X found on 18 Nov 2026 (0.147.9), on pages drawn here in the shape X drew them, of
 * made-up accounts:
 *
 * - The box to reply in under a post sits more than 14 parts below its Reply, so Reply was never found and no comment
 *   could be sent (`sendFor`, ../src/networks/x/spec.ts). It's found however deep now, never in another post's cell.
 * - A page of followers with nobody on it shows X's own "Looking for followers?", which read as a list that didn't
 *   show: the first save of their followers would have failed every time and held X's whole day. It's nobody to save
 *   now, and the day starts.
 * - The outline kept a picture's part named for whose it is (`UserAvatar-Container-<username>`): the name is hidden
 *   now, as a link to them is.
 */
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import { saveFollowers } from '../src/jobs/follows/people';
import type { Hfos, Job, JobTab } from '../src/jobs/job';
import { KITS } from '../src/networks';
import { writeTheirComment } from '../src/networks/follows/auto';
import { readFollow } from '../src/networks/follows/read';
import { outlineLooking } from '../src/networks/looking/read';
import { X } from '../src/networks/x/kit';
import { X_SPEC } from '../src/networks/x/spec';

// A person's pace between looks, skipped.
vi.mock('../src/jobs/job', async (original) => ({
  ...(await original<object>()),
  pause: () => Promise.resolve(),
}));

const XX = 'https://x.com';
const page = (body: string, url: string) =>
  new JSDOM(`<!doctype html><html><body>${body}</body></html>`, { url }).window.document;

const MENU = `<header role="banner"><nav role="navigation"><a role="link" aria-label="Profile" data-testid="AppTabBar_Profile_Link" href="/casey_owner"></a></nav></header>`;

/** Bare parts around what's inside, as X wraps everything: `n` of them. */
const wrapped = (n: number, inside: string) => `${'<div>'.repeat(n)}${inside}${'</div>'.repeat(n)}`;

/** Their post, as X draws it on its own page. */
const TWEET = `<article data-testid="tweet" tabindex="-1">
  <div data-testid="User-Name"><a href="/dana_reyes"><span>Dana Reyes</span></a><a href="/dana_reyes"><span>@dana_reyes</span></a>
    <a href="/dana_reyes/status/111"><time datetime="2026-11-18T03:00:00.000Z">2h</time></a></div>
  <div data-testid="tweetText" lang="en">Who do you use for your leads?</div>
  <div role="group"><button data-testid="reply" aria-label="4 Replies. Reply"></button><button data-testid="like" aria-label="3 Likes. Like"></button></div>
</article>`;

/** The box to reply in under it, with its Reply `depth` bare parts above the box, as the owner's Chrome drew it. */
const INLINE_REPLY = (depth: number) => `<div data-testid="inline_reply_offscreen"><div>
  <div><button role="button">Replying to <span>@dana_reyes</span></button></div>
  <div><div data-testid="UserAvatar-Container-casey_owner"><a role="link" href="/casey_owner"><img alt="Casey Owner"></a></div>
    <div>${wrapped(
      depth,
      `<div data-testid="tweetTextarea_0_label"><div dir="ltr"><div data-testid="tweetTextarea_0RichTextInputContainer"><div>
        <div>Post your reply</div>
        <div role="textbox" aria-label="Post text" contenteditable="true" tabindex="0" data-testid="tweetTextarea_0"></div>
      </div></div></div></div>`,
    )}
      <div><button role="button" aria-label="Everyone can reply"><span>Everyone can reply</span></button>
        <div data-testid="toolBar"><div><div data-testid="countdown-circle"></div>
          <button role="button" data-testid="tweetButtonInline"><span>Reply</span></button></div></div></div>
    </div></div></div></div>`;

/** A post's own page: the post and the box under it in one cell, the next cell after. */
const postPage = (depth: number) =>
  page(
    `${MENU}<main role="main"><div data-testid="primaryColumn"><section role="region">
      <div data-testid="cellInnerDiv">${TWEET}${INLINE_REPLY(depth)}</div>
      <div data-testid="cellInnerDiv"></div></section></div></main>`,
    `${XX}/dana_reyes/status/111`,
  );

const textbox = (doc: Document) =>
  doc.querySelector<HTMLElement>('[data-testid="tweetTextarea_0"]')!;

/** jsdom has no typing: the box takes what's written, and empties, as Chrome's does. */
function typing(doc: Document): void {
  doc.execCommand = (command: string, _u?: boolean, words?: string) => {
    if (command === 'insertText') textbox(doc).textContent = words ?? '';
    if (command === 'delete') textbox(doc).textContent = '';
    return true;
  };
}

describe('X’s box to reply in, under a post', () => {
  it('finds its Reply however deep X wraps the box, never pressing it in Check', async () => {
    const doc = postPage(20);
    typing(doc);
    let pressed = 0;
    doc
      .querySelector('[data-testid="tweetButtonInline"]')!
      .addEventListener('click', () => pressed++);
    const tried = await X.looks.comment!.look(doc, doc.location.href);
    expect(tried).toMatchObject({ step: 'comment', tried: true, works: true });
    expect(tried.found).toMatchObject({ box: true, typed: true, send: 1, emptied: true });
    expect(pressed).toBe(0);
    expect(textbox(doc).textContent).toBe('');
  });

  it('sends the comment with that Reply', async () => {
    const doc = postPage(20);
    typing(doc);
    const sent: string[] = [];
    doc.querySelector('[data-testid="tweetButtonInline"]')!.addEventListener('click', () => {
      sent.push(textbox(doc).textContent ?? '');
      textbox(doc).textContent = '';
    });
    const text = 'We text every new lead back in a minute. Happy to show you how.';
    expect(
      await writeTheirComment(X_SPEC)(doc, doc.location.href, text, {
        profile: { id: null, username: 'dana_reyes', url: `${XX}/dana_reyes` },
        postUrl: `${XX}/dana_reyes/status/111`,
      }),
    ).toBe('done');
    expect(sent).toEqual([text]);
  });

  it('never takes another cell’s Reply for the box’s', () => {
    const doc = page(
      `<main role="main"><div data-testid="primaryColumn">
        <div data-testid="cellInnerDiv">${wrapped(20, '<div role="textbox" contenteditable="true" data-testid="tweetTextarea_0"></div>')}</div>
        <div data-testid="cellInnerDiv"><button data-testid="tweetButtonInline">Reply</button></div></div></main>`,
      `${XX}/dana_reyes/status/111`,
    );
    expect(X_SPEC.sendFor(textbox(doc))).toBeNull();
  });
});

/** Their page of followers with nobody on it, as the owner's Chrome drew it on 18 Nov 2026. */
const noFollowers = () =>
  page(
    `${MENU}<main role="main"><div data-testid="primaryColumn"><div aria-label="Home timeline">
      <nav role="navigation"><div role="tablist" data-testid="ScrollSnap-List">
        <a role="tab" aria-selected="false" href="/casey_owner/verified_followers"><span>Verified Followers</span></a>
        <a role="tab" aria-selected="true" href="/casey_owner/followers"><span>Followers</span></a>
        <a role="tab" aria-selected="false" href="/casey_owner/following"><span>Following</span></a></div></nav>
      <div data-testid="emptyState"><div><div dir="ltr" data-testid="empty_state_header_text"><span>Looking for followers?</span></div>
        <div dir="ltr" data-testid="empty_state_body_text"><span>When someone follows this account, they’ll show up here. Posting and interacting with others helps boost followers.</span></div></div></div>
    </div></div>
    <div data-testid="sidebarColumn"><aside role="complementary" aria-label="Who to follow"><ul role="list">
      <li role="listitem" data-testid="UserCell"><div data-testid="UserAvatar-Container-big_account"><a role="link" href="/big_account"><img alt=""></a></div>
        <a role="link" href="/big_account"><span>Big Account</span></a><button data-testid="99999-follow">Follow</button></li></ul></aside></div></main>`,
    `${XX}/casey_owner/followers`,
  );

/** A tab on X that opens the pages above by their address, reading and working as its tab does. */
function xTab(pages: Record<string, () => Document>): JobTab {
  const kit = KITS.x;
  let doc: Document | null = null;
  return {
    async open(url: string) {
      const make = pages[new URL(url).pathname];
      if (!make) throw new Error(`Not expected: ${url}`);
      doc = make();
      return 1;
    },
    async inFront<T>(work: () => Promise<T>) {
      return work();
    },
    async close() {},
    async ask(message: { readonly type: string }) {
      const at = doc!.location.href;
      if (message.type === 'hfos-read') return { ok: true, result: kit.readPage(doc!, at) };
      return { ok: false, error: `Not expected: ${message.type}` };
    },
  } as unknown as JobTab;
}

function xJob(tab: JobTab): Job {
  return {
    tab,
    hfos: (async () => ({ ok: true, value: { added: 0, changed: 0 } })) as unknown as Hfos,
    businessId: 'b',
    stopped: () => false,
    progress: () => undefined,
    warn: async () => undefined,
  };
}

const home = () =>
  page(`${MENU}<main role="main"><div data-testid="primaryColumn"></div></main>`, `${XX}/home`);

describe('Your newest followers on X', () => {
  it('reads X’s “Looking for followers?” as nobody following them yet, never the side’s Who to follow', () => {
    const doc = noFollowers();
    const found = readFollow(doc, doc.location.href, X_SPEC);
    expect(found.people).toEqual([]);
    expect(found.listEmpty).toBe(true);
  });

  it('starts the day with nobody to save when nobody follows them yet', async () => {
    const tab = xTab({ '/home': home, '/casey_owner/followers': noFollowers });
    expect(await saveFollowers(xJob(tab), 'x')).toMatchObject({
      line: 'No followers on X yet, so nobody to save.',
      warned: false,
      whole: true,
    });
  });

  it('still says nobody showed when the page shows neither followers nor that it has none', async () => {
    const blank = () =>
      page(
        `${MENU}<main role="main"><div data-testid="primaryColumn"><div role="progressbar"></div></div></main>`,
        `${XX}/casey_owner/followers`,
      );
    const tab = xTab({ '/home': home, '/casey_owner/followers': blank });
    expect(await saveFollowers(xJob(tab), 'x')).toMatchObject({
      line: 'X showed nobody on your page of followers.',
      failed: true,
    });
  });
});

describe('X’s outline', () => {
  it('hides the username a picture’s part is named for, as the link to them is', () => {
    const doc = noFollowers();
    const outline = outlineLooking(doc, doc.location.href, X);
    expect(outline).not.toMatch(/big_account|casey_owner/i);
    const token = /data-testid="UserAvatar-Container-(\{\d+\})"/.exec(outline)?.[1];
    expect(token).toBeDefined();
    expect(outline).toContain(`href="/${token}"`);
    // X's own test ids are kept as they are, and long numbers hidden.
    expect(outline).toContain('data-testid="emptyState"');
    expect(outline).not.toContain('99999');
  });
});
