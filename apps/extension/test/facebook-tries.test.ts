/**
 * Check Facebook's tries (src/networks/facebook/tries.ts, docs/outreach.md decision 77): on made-up 2026 pages whose
 * buttons behave like Facebook's, each step is taken up to its last press and says what it found, and the last press
 * (Save, Post, Add friend, Like, Unfriend, Confirm, Cancel request, Join group) is never made.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DOWNLOAD_PAGE } from '../src/networks/facebook/fetch';
import {
  tryBio,
  tryCancel,
  tryComment,
  tryConfirm,
  tryFile,
  tryJoin,
  tryLike,
  tryMessage,
  tryPost,
  tryRequest,
  tryUnfriend,
} from '../src/networks/facebook/tries';
import { load } from './load';

const FB = 'https://www.facebook.com';
const DANA = `${FB}/dana.reyes.12`;
const dana = { id: null, username: 'dana.reyes.12', url: DANA };
const OWN = `${FB}/jordan.owner.1`;
const GROUP = `${FB}/groups/texascontractors/`;
const POST = `${FB}/groups/7766554433221100/posts/5555666677778888/`;
const REQUESTS = `${FB}/friends/requests/`;

afterEach(() => vi.useRealTimers());

/** Runs a try with Facebook's waits skipped. */
async function quickly<T>(going: Promise<T>): Promise<T> {
  await vi.advanceTimersByTimeAsync(30_000);
  return going;
}

/** Counts presses of what's never to be pressed. */
function never(element: Element | null): () => number {
  let pressed = 0;
  element?.addEventListener('click', () => pressed++);
  return () => pressed;
}

/** The button at the top of a profile that says where the two of you stand. */
const standing = (doc: Document) =>
  doc.querySelector<HTMLElement>('[role="main"] [role="button"][aria-label="Friends"]')!;

function relabel(button: HTMLElement, label: string): void {
  button.setAttribute('aria-label', label);
  const words = [...button.querySelectorAll('span')].at(-1);
  if (words) words.textContent = label;
}

/** A button in a box, pressing it doing `then`. */
function buttonOf(doc: Document, label: string, then: () => void = () => undefined): HTMLElement {
  const button = doc.createElement('div');
  button.setAttribute('role', 'button');
  button.setAttribute('aria-label', label);
  button.innerHTML = `<span>${label}</span>`;
  button.addEventListener('click', then);
  return button;
}

describe('trying the bio', () => {
  /** Their profile, where Edit bio opens a box with Save and Cancel, and Cancel closes it. */
  function editable(withCancel = true) {
    const doc = load('own-profile.html', OWN);
    const bio = doc.getElementById('bio')!;
    let save: HTMLElement | null = null;
    bio.querySelector('[role="button"]')!.addEventListener('click', () => {
      const box = doc.createElement('textarea');
      box.value = 'Dad, golfer, coffee';
      save = buttonOf(doc, 'Save');
      const parts: HTMLElement[] = [box, save];
      if (withCancel) parts.push(buttonOf(doc, 'Cancel', () => parts.forEach((p) => p.remove())));
      bio.append(...parts);
    });
    return {
      doc,
      saved: () => (save ? never(save)() : 0),
      box: () => doc.querySelector('textarea'),
    };
  }

  it('opens the box, writes in it and puts their own back, finds Save, and closes it with Cancel', async () => {
    vi.useFakeTimers();
    const { doc } = editable();
    let saves = 0;
    doc.addEventListener(
      'click',
      (e) => {
        if ((e.target as Element).closest('[aria-label="Save"]')) saves++;
      },
      true,
    );
    const tried = await quickly(tryBio(doc));
    expect(tried).toMatchObject({
      step: 'bio',
      tried: true,
      works: true,
      found: { button: true, box: true, save: true, cancel: true, typed: true, closed: true },
      missing: [],
    });
    expect(tried.outline).toBeUndefined();
    expect(saves).toBe(0);
    expect(doc.querySelector('textarea')).toBeNull();
  });

  it('writes nothing in a box it couldn’t close again, and says so', async () => {
    vi.useFakeTimers();
    const { doc, box } = editable(false);
    const tried = await quickly(tryBio(doc));
    expect(tried.works).toBe(false);
    expect(tried.missing).toEqual(['no Cancel by the bio’s box, so nothing was written in it']);
    expect(tried.found).toMatchObject({ typed: false, cancel: false });
    expect((box() as HTMLTextAreaElement).value).toBe('Dad, golfer, coffee');
    expect(tried.outline).toContain('Page: profile');
  });

  it('says when there’s no Edit bio, and names what was there', async () => {
    const doc = load('own-profile.html', OWN);
    doc.getElementById('bio')!.querySelector('[role="button"]')!.remove();
    const tried = await tryBio(doc);
    expect(tried).toMatchObject({
      works: false,
      found: { button: false },
      missing: ['no Edit bio or Add bio on your profile'],
    });
    expect(tried.seen?.length).toBeGreaterThan(0);
  });
});

describe('trying a post in a group', () => {
  /** The group's page: Write something opens the composer, and its Close closes it. */
  function group() {
    const doc = load('group-compose-2026.html', GROUP);
    const composer = doc.getElementById('composer')!;
    doc
      .getElementById('start')!
      .addEventListener('click', () => composer.removeAttribute('hidden'));
    composer
      .querySelector('[aria-label="Close"]')!
      .addEventListener('click', () => composer.setAttribute('hidden', ''));
    return { doc, posted: never(doc.getElementById('post')) };
  }

  it('opens the composer, finds its box and its Post, and closes it, nothing written', async () => {
    vi.useFakeTimers();
    const { doc, posted } = group();
    const tried = await quickly(tryPost(doc));
    expect(tried).toMatchObject({
      works: true,
      found: { start: true, composer: true, writing: true, post: true, closed: true },
    });
    expect(posted()).toBe(0);
    expect(doc.getElementById('box')!.textContent!.trim()).toBe('');
  });

  it('says when Write something opened nothing, with the outline', async () => {
    vi.useFakeTimers();
    const doc = load('group-compose-2026.html', GROUP);
    const tried = await quickly(tryPost(doc));
    expect(tried).toMatchObject({
      works: false,
      found: { start: true, composer: false },
      missing: ['Write something… opened nothing'],
    });
    expect(tried.outline).toContain('Page: group');
  });
});

describe('trying a comment', () => {
  it('writes a word in the post’s box, finds the button that sends it, never presses it, and takes the word out', async () => {
    vi.useFakeTimers();
    const doc = load('group-post-2026.html', POST);
    const box = doc.querySelector<HTMLElement>('[role="textbox"][aria-label^="Comment as"]')!;
    doc.execCommand = (command: string, _ui?: boolean, text?: string) => {
      box.textContent = command === 'insertText' ? `${box.textContent ?? ''}${text ?? ''}` : '';
      return true;
    };
    const sent = never(doc.querySelector('form [role="button"][aria-label="Comment"]'));
    const tried = await quickly(tryComment(doc));
    expect(tried).toMatchObject({
      works: true,
      found: { box: true, typed: true, send: true, emptied: true },
    });
    expect(sent()).toBe(0);
    expect(box.textContent).toBe('');
  });

  it('leaves a box with the person’s writing in it alone', async () => {
    const doc = load('group-post-2026.html', POST);
    doc.querySelector('[role="textbox"][aria-label^="Comment as"]')!.textContent = 'half written';
    expect(await tryComment(doc)).toMatchObject({
      tried: false,
      missing: ['writing in the comment box already, left alone'],
    });
  });
});

describe('trying the steps on someone’s profile', () => {
  it('finds Add friend for someone they aren’t friends with, and never presses it', () => {
    const doc = load('profile-2026.html', DANA);
    const button = standing(doc);
    relabel(button, 'Add friend');
    const added = never(button);
    expect(tryRequest(doc, DANA)).toMatchObject({
      works: true,
      found: { addFriend: true, standingKnown: true },
    });
    expect(added()).toBe(0);
  });

  it('tries no friend request on a friend', () => {
    const doc = load('profile-2026.html', DANA);
    expect(tryRequest(doc, DANA)).toMatchObject({
      tried: false,
      missing: ['you’re friends with them already'],
    });
  });

  it('finds Cancel request for someone they sent one to, and never presses it', () => {
    const doc = load('profile-2026.html', DANA);
    const button = standing(doc);
    relabel(button, 'Cancel request');
    const cancelled = never(button);
    expect(tryCancel(doc, DANA)).toMatchObject({ works: true, found: { cancel: true } });
    expect(cancelled()).toBe(0);
    relabel(button, 'Friends');
    expect(tryCancel(doc, DANA)).toMatchObject({
      tried: false,
      missing: ['they’ve accepted your friend request since'],
    });
  });

  it('opens Friends’ menu, finds Unfriend, never presses it, and closes the menu again', async () => {
    vi.useFakeTimers();
    const doc = load('profile-2026.html', DANA);
    const friends = standing(doc);
    let menu: HTMLElement | null = null;
    let unfriended = 0;
    friends.addEventListener('click', () => {
      // Friends opens its menu, and closes it when pressed again.
      if (menu) {
        menu.remove();
        menu = null;
        return;
      }
      menu = doc.createElement('div');
      menu.setAttribute('role', 'menu');
      for (const label of ['Favorites', 'Unfollow', 'Unfriend']) {
        const row = doc.createElement('div');
        row.setAttribute('role', 'menuitem');
        row.innerHTML = `<span>${label}</span>`;
        if (label === 'Unfriend') row.addEventListener('click', () => unfriended++);
        menu.append(row);
      }
      doc.body.append(menu);
    });
    const tried = await quickly(tryUnfriend(doc, DANA));
    expect(tried).toMatchObject({
      works: true,
      found: { friends: true, menu: true, unfriend: true, closed: true },
    });
    expect(unfriended).toBe(0);
    expect(doc.querySelector('[role="menu"]')).toBeNull();
  });

  it('finds one of their posts and its Like, and never presses it', async () => {
    const doc = load('profile-2026.html', DANA);
    const liked = never(doc.querySelector('[aria-label="Remove Like"]'));
    const view = { scrollBy: () => undefined, innerHeight: 800 };
    expect(await tryLike(doc, DANA, dana, view)).toMatchObject({
      works: true,
      found: { posts: 1, liked: 1, like: true },
    });
    expect(liked()).toBe(0);
  });

  it('opens the chat Message opens over the page, finds its box, writes nothing, and closes it', async () => {
    vi.useFakeTimers();
    const doc = load('profile-2026.html', DANA);
    let typed = 0;
    doc.querySelector('[role="button"][aria-label="Message"]')!.addEventListener('click', () => {
      const chat = doc.createElement('div');
      const box = doc.createElement('div');
      box.setAttribute('role', 'textbox');
      box.setAttribute('contenteditable', 'true');
      box.setAttribute('aria-label', 'Message');
      box.addEventListener('input', () => typed++);
      chat.append(
        buttonOf(doc, 'Close chat', () => chat.remove()),
        box,
      );
      doc.body.append(chat);
    });
    const tried = await quickly(tryMessage(doc, DANA));
    expect(tried).toMatchObject({
      works: true,
      found: { message: true, box: true, page: false, window: true, closed: true },
    });
    expect(typed).toBe(0);
    expect(doc.querySelector('[aria-label="Close chat"]')).toBeNull();
  });

  it('says when Message opened no chat, with the outline, counting no window open before it', async () => {
    vi.useFakeTimers();
    const doc = load('profile-2026.html', DANA);
    // A chat with someone else, open before: not the one Message opens.
    const before = doc.createElement('div');
    before.innerHTML = '<div role="textbox" contenteditable="true" aria-label="Message"></div>';
    doc.body.append(before);
    const tried = await quickly(tryMessage(doc, DANA));
    expect(tried).toMatchObject({
      works: false,
      found: { message: true, box: false },
      missing: ['Message opened no chat to write in'],
    });
    expect(tried.outline).toContain('Page: profile');
  });
});

describe('trying the steps on their lists, a group and the file', () => {
  it('finds Confirm by the requests they’ve got, and never presses it', () => {
    const doc = load('friend-requests-2026.html', REQUESTS);
    const confirmed = never(doc.querySelector('[role="button"][aria-label="Confirm"]'));
    const tried = tryConfirm(doc, REQUESTS);
    expect(tried.works).toBe(true);
    expect(tried.found.requests).toBeGreaterThan(0);
    expect(tried.found.confirm).toBeGreaterThan(0);
    expect(confirmed()).toBe(0);
  });

  it('finds Join group on a group they aren’t in, never pressed; and none to try on one they’re in', () => {
    const doc = load('group-join-2026.html', GROUP);
    const joined = never(doc.getElementById('join'));
    expect(tryJoin(doc)).toMatchObject({ works: true, found: { join: true } });
    expect(joined()).toBe(0);
    doc.getElementById('join')!.setAttribute('aria-label', 'Joined');
    expect(tryJoin(doc)).toMatchObject({ tried: false, missing: ['you’re in this group already'] });
  });

  it('finds the file’s first step, or says why its steps don’t show', () => {
    // A page at Download your information's address, its words written here.
    const doc = load('notifications.html', DOWNLOAD_PAGE);
    doc.body.innerHTML =
      '<div role="main"><div role="button" aria-label="Create export">Create export</div></div>';
    const pressed = never(doc.querySelector('[role="button"]'));
    expect(tryFile(doc)).toMatchObject({ works: true, found: { first: true } });
    expect(pressed()).toBe(0);
    doc.body.innerHTML = '<div role="main">Your information is being prepared</div>';
    expect(tryFile(doc)).toMatchObject({ tried: false, found: { preparing: true } });
    doc.body.innerHTML = '<div role="main"><input type="password" /></div>';
    expect(tryFile(doc)).toMatchObject({ tried: false, found: { password: true } });
    doc.body.innerHTML = '<div role="main"><div role="button" aria-label="Help">Help</div></div>';
    expect(tryFile(doc)).toMatchObject({
      works: false,
      missing: ['nothing saying “Create export”'],
      seen: ['Help'],
    });
  });
});
