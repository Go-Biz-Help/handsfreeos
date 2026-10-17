/**
 * Check LinkedIn's tries (src/networks/linkedin/tries.ts; docs/outreach.md, decision 76), on hand-written pages of
 * made-up people, as LinkedIn behaves when a control is pressed: each step taken up to its last press, what it found
 * said, and nothing ever saved, posted, liked, sent, connected or withdrawn.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DATA_PAGE } from '../src/networks/linkedin/data';
import {
  tryComment,
  tryConnect,
  tryFile,
  tryHeadlineStep,
  tryLike,
  tryMessage,
  tryMessagePage,
  tryPost,
  tryWithdraw,
} from '../src/networks/linkedin/tries';
import type { ProfileRef } from '../src/networks/linkedin/types';
import { boxEverything, load } from './load';

const LI = 'https://www.linkedin.com';
const FEED = `${LI}/feed/`;
const DANA = `${LI}/in/dana-reyes-4b2a1c/`;
const ACTIVITY = `${DANA}recent-activity/all/`;
const SENT = `${LI}/mynetwork/invitation-manager/sent/`;
const POST = `${LI}/feed/update/urn:li:activity:7380000000000000101/`;
const dana: ProfileRef = { id: null, username: 'dana-reyes-4b2a1c', url: DANA };

const asWrittenAndBoxed = [
  ['as written', false],
  ['with a bare box around every element', true],
] as const;

const page = (fixture: string, url: string, boxed: boolean) => {
  const doc = load(fixture, url);
  return boxed ? boxEverything(doc) : doc;
};

/** Copies a box from a test page into `doc`, as LinkedIn draws it over the page. */
function copyIn(doc: Document, fixture: string, selector: string, boxed: boolean): Element {
  const from = load(fixture, doc.location.href);
  if (boxed) boxEverything(from);
  const box = doc.importNode(from.querySelector(selector)!, true);
  doc.body.append(box);
  return box;
}

/** Every press on the page, by what the control says: none may be a step's last. */
function presses(doc: Document) {
  const pressed: string[] = [];
  doc.addEventListener(
    'click',
    (event) => {
      const control = (event.target as Element).closest('button, a, [role="button"]');
      if (control)
        pressed.push(control.getAttribute('aria-label') || (control.textContent ?? '').trim());
    },
    true,
  );
  return pressed;
}

afterEach(() => vi.useRealTimers());

describe('posting', () => {
  /** The feed as LinkedIn behaves: Start a post opens the composer, and Dismiss closes it. */
  function feed(boxed: boolean) {
    const doc = page('linkedin-feed-2026-10.html', FEED, boxed);
    const start = doc.querySelector('[aria-label="Start a post"]')!.closest('[role="button"]')!;
    start.addEventListener('click', () => {
      const outlet = copyIn(doc, 'linkedin-share-box.html', '#modal-outlet', boxed);
      outlet
        .querySelector('[aria-label="Dismiss"]')!
        .addEventListener('click', () => outlet.remove());
    });
    return doc;
  }

  it.each(asWrittenAndBoxed)(
    'opens the composer, finds its box and Post, and closes it, writing nothing, %s',
    async (_, boxed) => {
      const doc = feed(boxed);
      const pressed = presses(doc);
      expect(await tryPost(doc)).toEqual({
        step: 'post',
        tried: true,
        works: true,
        found: { start: true, composer: true, writing: true, closed: true },
        missing: [],
      });
      expect(pressed).not.toContain('Post');
      expect(doc.querySelector('#share-post')).toBeNull();
    },
  );

  it('says what Start a post opened when it isn’t the composer', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const doc = page('linkedin-feed-2026-10.html', FEED, false);
    doc
      .querySelector('[aria-label="Start a post"]')!
      .closest('[role="button"]')!
      .addEventListener('click', () =>
        doc.body.insertAdjacentHTML(
          'beforeend',
          '<div role="dialog"><h2>Create a post</h2><button aria-label="Dismiss"></button>' +
            '<button><span>Next</span></button></div>',
        ),
      );
    const trying = tryPost(doc);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await trying).toMatchObject({
      works: false,
      found: { start: true, composer: false, box: true },
      missing: ['the box Start a post opened has no Post, or nowhere to write'],
      // As the outline names them: LinkedIn's words it doesn't know are hidden.
      seen: ['Dismiss', '[1 word]'],
    });
  });

  it('says so when there’s no Start a post', async () => {
    const doc = page('linkedin-profile.html', DANA, false);
    expect(await tryPost(doc)).toMatchObject({
      works: false,
      missing: ['no Start a post on your feed'],
    });
  });
});

describe('commenting', () => {
  /** A box to write in that takes typing as Chrome does; its form's button would send it. */
  function typing(doc: Document) {
    let into: Element | null = null;
    for (const box of doc.querySelectorAll('[role="textbox"]'))
      box.addEventListener('click', () => (into = box));
    const commands: string[] = [];
    doc.execCommand = (command: string, _ui?: boolean, text?: string) => {
      commands.push(command);
      if (into) into.textContent = command === 'insertText' ? (text ?? '') : '';
      return true;
    };
    return commands;
  }

  it.each(asWrittenAndBoxed)(
    'writes a word in the post’s own box, finds its Comment, and takes the word out, pressing nothing, %s',
    async (_, boxed) => {
      vi.useFakeTimers({ toFake: ['setTimeout'] });
      const doc = page('linkedin-post-commenting.html', POST, boxed);
      const commands = typing(doc);
      const pressed = presses(doc);
      const reply = doc.querySelector('[aria-placeholder="Add a reply…"]')!;
      const before = reply.textContent;
      const trying = tryComment(doc);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(await trying).toEqual({
        step: 'comment',
        tried: true,
        works: true,
        found: { open: true, opener: false, box: true, typed: true, send: true, emptied: true },
        missing: [],
      });
      expect(commands).toEqual(['insertText', 'selectAll', 'delete']);
      expect(pressed).not.toContain('Comment');
      expect(doc.querySelector('[aria-placeholder="Add a comment…"]')!.textContent).toBe('');
      expect(reply.textContent).toBe(before);
    },
  );

  it('says when writing in the box doesn’t take', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const doc = page('linkedin-post-commenting.html', POST, false);
    doc.execCommand = () => false;
    const trying = tryComment(doc);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await trying).toMatchObject({
      works: false,
      found: { box: true, typed: false, send: false },
      missing: ['writing in the comment box didn’t take'],
    });
  });

  it('leaves a box with writing in it alone', async () => {
    const doc = page('linkedin-post-commenting.html', POST, false);
    typing(doc);
    doc.querySelector('[aria-placeholder="Add a comment…"]')!.textContent = 'Half a thought';
    expect(await tryComment(doc)).toMatchObject({
      tried: false,
      missing: ['writing in the comment box already, left alone'],
    });
  });
});

describe('connecting', () => {
  it.each(asWrittenAndBoxed)(
    'finds Connect in the top card, never pressed, %s',
    async (_, boxed) => {
      const doc = page('linkedin-profile.html', DANA, boxed);
      const pressed = presses(doc);
      expect(await tryConnect(doc, DANA)).toEqual({
        step: 'connect',
        tried: true,
        works: true,
        found: { connect: true, direct: true, underMore: false, more: false },
        missing: [],
      });
      expect(pressed).toEqual([]);
    },
  );

  it('finds Connect under More when Follow comes first, and closes More again', async () => {
    const url = `${LI}/in/sam-lee-77/`;
    const doc = page('linkedin-profile-follow.html', url, false);
    const more = doc.querySelector('[aria-label="More actions"]')!;
    more.addEventListener('click', () => {
      const open = more.getAttribute('aria-expanded') !== 'true';
      more.setAttribute('aria-expanded', String(open));
      for (const menu of doc.querySelectorAll('main [aria-hidden]'))
        if (menu.querySelector('[aria-label="Invite Sam Lee to connect"]'))
          menu.setAttribute('aria-hidden', String(!open));
    });
    const pressed = presses(doc);
    expect(await tryConnect(doc, url)).toMatchObject({
      works: true,
      found: { connect: true, direct: false, underMore: true, more: true },
    });
    expect(pressed).toEqual(['More actions', 'More actions']);
    expect(more.getAttribute('aria-expanded')).toBe('false');
  });

  it('finds Connect when the top card says 1st beside the real 2nd, as LinkedIn’s newer one can', async () => {
    // The owner's Check LinkedIn of 17 Oct 2026: someone from the search, with Connect, read as a connection.
    const doc = page('linkedin-profile.html', DANA, false);
    const second = [...doc.querySelectorAll('main span[aria-hidden="true"]')].find(
      (span) => span.textContent === '· 2nd',
    )!;
    second.insertAdjacentHTML('beforebegin', '<p>· 1st</p>');
    expect(await tryConnect(doc, DANA)).toMatchObject({
      tried: true,
      works: true,
      found: { connect: true, direct: true },
    });
  });

  it('has nothing to try on someone you’re connected with', async () => {
    const doc = page('linkedin-profile.html', DANA, false);
    for (const degree of doc.querySelectorAll('main span[aria-hidden="true"]'))
      if (degree.textContent === '· 2nd') degree.textContent = '· 1st';
    doc.querySelector('[aria-label="Invite Dana Reyes to connect"]')!.remove();
    expect(await tryConnect(doc, DANA)).toMatchObject({
      tried: false,
      missing: ['you’re connected with them already'],
    });
  });
});

describe('messaging', () => {
  const COMPOSE = `${LI}/messaging/compose/?profileUrn=urn%3Ali%3Afsd_profile%3AACoAAFakeDanaReyes123&recipient=ACoAAFakeDanaReyes123&screenContext=NON_SELF_PROFILE_VIEW`;

  /**
   * Their profile as LinkedIn behaves: Message opens the conversation over the page, and its close closes it. With
   * `into`, it opens in LinkedIn's interop box at the foot of the page, out of reach of the page's look-ups, as the
   * owner's newer pages may draw it: open, or kept closed (then opened as Chrome lets a content script).
   */
  function profile(boxed: boolean, opens = true, into?: 'open' | 'closed') {
    const doc = page('linkedin-profile.html', DANA, boxed);
    const host = doc.createElement('div');
    host.setAttribute('data-testid', 'interop-shadowdom');
    doc.body.append(host);
    const inside = into ? host.attachShadow({ mode: into }) : null;
    if (into === 'closed')
      vi.stubGlobal('chrome', {
        dom: { openOrClosedShadowRoot: (element: Element) => (element === host ? inside : null) },
      });
    doc.querySelector('[aria-label="Message Dana Reyes"]')!.addEventListener('click', (event) => {
      event.preventDefault();
      if (!opens) return;
      const window = copyIn(
        doc,
        'linkedin-chat-window.html',
        'aside[aria-label="Messaging"]',
        boxed,
      );
      inside?.append(window);
      window
        .querySelector('[aria-label="Close your conversation with Dana Reyes"]')!
        .addEventListener('click', () => window.remove());
    });
    const typed: string[] = [];
    doc.execCommand = (command: string) => (typed.push(command), true);
    return { doc, typed };
  }

  it.each(asWrittenAndBoxed)(
    'opens the conversation, finds its box and Send, and closes it, writing nothing, %s',
    async (_, boxed) => {
      const { doc, typed } = profile(boxed);
      const pressed = presses(doc);
      expect(await tryMessage(doc, DANA, dana)).toEqual({
        step: 'message',
        tried: true,
        works: true,
        found: {
          message: true,
          link: true,
          places: 0,
          opened: true,
          inside: false,
          box: true,
          sends: 1,
          closed: true,
        },
        missing: [],
      });
      expect(typed).toEqual([]);
      expect(pressed).toEqual(['Message Dana Reyes', 'Close your conversation with Dana Reyes']);
      expect(
        doc.querySelector('[aria-label="Close your conversation with Dana Reyes"]'),
      ).toBeNull();
    },
  );

  it.each([['open'], ['closed']] as const)(
    'finds the conversation in LinkedIn’s interop box, kept %s',
    async (into) => {
      const { doc, typed } = profile(false, true, into);
      expect(await tryMessage(doc, DANA, dana)).toMatchObject({
        works: true,
        found: { places: 1, opened: true, inside: true, box: true, sends: 1, closed: true },
      });
      expect(typed).toEqual([]);
      vi.unstubAllGlobals();
    },
  );

  it('says so when Message opens no conversation, with the page it leads to and the outline as it was', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const { doc } = profile(false, false);
    const trying = tryMessage(doc, DANA, dana);
    await vi.advanceTimersByTimeAsync(10_000);
    const tried = await trying;
    expect(tried).toMatchObject({
      works: false,
      found: { message: true, link: true, opened: false, box: false },
      missing: ['Message opened no conversation to write in'],
      next: COMPOSE,
    });
    expect(tried.outline).toMatch(
      /^HandsFreeOS Social .*page outline\nPage: unknown \/in\/\{1\}\//,
    );
  });

  it('finds the box and Send on the page Message leads to, and that it’s with them, writing nothing', () => {
    const doc = page('linkedin-chat.html', COMPOSE, false);
    const typed: string[] = [];
    doc.execCommand = (command: string) => (typed.push(command), true);
    // Its header links to Dana by her member id, as the profile's Message does.
    const byId: ProfileRef = {
      id: 'ACoAAFakeDanaReyes123',
      username: null,
      url: `${LI}/in/ACoAAFakeDanaReyes123/`,
    };
    expect(tryMessagePage(doc, COMPOSE, byId)).toEqual({
      step: 'message',
      tried: true,
      works: true,
      found: { page: true, boxes: 1, sends: 1, them: true, named: true },
      missing: [],
    });
    // By her name on LinkedIn, nothing on the page says it's someone else's.
    expect(tryMessagePage(doc, COMPOSE, dana)).toMatchObject({
      works: true,
      found: { them: false },
    });
    const someoneElse: ProfileRef = {
      id: 'ACoAAFakeSomeoneElse999',
      username: null,
      url: `${LI}/in/ACoAAFakeSomeoneElse999/`,
    };
    expect(tryMessagePage(doc, COMPOSE, someoneElse)).toMatchObject({
      works: false,
      missing: ['the page Message leads to is with someone else'],
    });
    expect(typed).toEqual([]);
  });
});

describe('liking, withdrawing and the data file', () => {
  it.each(asWrittenAndBoxed)(
    'finds a post of theirs and its Like, never pressed, %s',
    (_, boxed) => {
      const doc = page('linkedin-activity.html', ACTIVITY, boxed);
      const pressed = presses(doc);
      expect(tryLike(doc, ACTIVITY, dana)).toEqual({
        step: 'like',
        tried: true,
        works: true,
        found: { posts: 3, liked: 0, like: true },
        missing: [],
      });
      expect(pressed).toEqual([]);
    },
  );

  it('has nothing to try on when none of the posts are theirs', () => {
    const doc = page('linkedin-activity.html', ACTIVITY, false);
    const nobody: ProfileRef = { id: null, username: 'nobody-here', url: `${LI}/in/nobody-here/` };
    expect(tryLike(doc, ACTIVITY, nobody)).toMatchObject({
      tried: false,
      found: { posts: 0 },
      missing: ['none of their posts on their activity'],
    });
  });

  it.each(asWrittenAndBoxed)(
    'finds each invitation you sent and its Withdraw, never pressed, %s',
    (_, boxed) => {
      const doc = page('linkedin-invitations-sent.html', SENT, boxed);
      const pressed = presses(doc);
      expect(tryWithdraw(doc, SENT)).toMatchObject({
        tried: true,
        works: true,
        found: { withdraw: 3 },
      });
      expect(tryWithdraw(doc, SENT).found.invitations).toBeGreaterThan(0);
      expect(pressed).toEqual([]);
    },
  );

  it('has nothing to try on with no invitations sent', () => {
    const doc = page('linkedin-invitations-sent.html', SENT, false);
    for (const row of doc.querySelectorAll('main li')) row.remove();
    expect(tryWithdraw(doc, SENT)).toMatchObject({ tried: false, found: { invitations: 0 } });
  });

  it('finds what each of the file’s steps looks for, ticking nothing', () => {
    const doc = page('linkedin-data.html', DATA_PAGE, false);
    const pressed = presses(doc);
    expect(tryFile(doc)).toEqual({
      step: 'file',
      tried: true,
      works: true,
      found: { steps: 5, found: 5 },
      missing: [],
    });
    expect(pressed).toEqual([]);
    expect(doc.querySelector<HTMLInputElement>('#arc-all')!.checked).toBe(true);
  });

  it('says which of the file’s words LinkedIn no longer shows', () => {
    const doc = page('linkedin-data.html', DATA_PAGE, false);
    doc.getElementById('request')!.textContent = 'Ask for a copy';
    expect(tryFile(doc)).toMatchObject({
      works: false,
      found: { steps: 5, found: 4 },
      missing: ['nothing saying “Request archive”'],
    });
  });
});

describe('the headline', () => {
  it('says when there’s no pencil to start from', async () => {
    const doc = page('linkedin-profile.html', DANA, false);
    expect(await tryHeadlineStep(doc)).toMatchObject({
      step: 'headline',
      tried: true,
      works: false,
      found: { pencil: false },
      missing: ['no pencil by your name'],
    });
  });
});
