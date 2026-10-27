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
  tryLinks,
  tryMessage,
  tryPost,
  tryRequest,
  tryUnfriend,
  tryUsername,
} from '../src/networks/facebook/tries';
import { boxEverything, load } from './load';

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

describe('trying the bio in October 2026’s layout', () => {
  const EDITOR = `${FB}/profile.php?fb_profile_edit_entry_point=7&id=100001234&sk=about`;

  it('says where Edit profile leads, to try it again there, when the profile has no Edit bio', async () => {
    const own = `${FB}/casey.owner.7`;
    const tried = await tryBio(load('own-profile-2026-10.html', own), own);
    expect(tried).toMatchObject({
      works: false,
      found: { button: false, editProfile: true },
      missing: ['no Edit bio or Add bio on your profile'],
      next: EDITOR,
    });
  });

  /** The About tab's editor: the Edit by Bio opens a box with Save and Cancel, and Cancel closes it. */
  function editor(boxed = false) {
    const doc = load('own-profile-about-editor-2026-10.html', EDITOR);
    if (boxed) boxEverything(doc);
    const row = doc.getElementById('bio-row')!;
    let save: HTMLElement | null = null;
    doc.getElementById('bio-edit')!.addEventListener('click', () => {
      // Facebook's box holds the bio the row shows.
      const box = doc.createElement('textarea');
      box.value = (doc.getElementById('bio-shown')!.textContent ?? '').replace(/\s+/g, ' ').trim();
      save = buttonOf(doc, 'Save');
      const parts: HTMLElement[] = [box, save];
      parts.push(buttonOf(doc, 'Cancel', () => parts.forEach((p) => p.remove())));
      row.append(...parts);
    });
    return { doc, saved: () => (save ? never(save)() : 0) };
  }

  it('opens the bio’s box on the editor, writes a word and puts theirs back, never saves, and closes it', async () => {
    vi.useFakeTimers();
    for (const boxed of [false, true]) {
      const { doc } = editor(boxed);
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
        works: true,
        found: {
          button: true,
          editBio: false,
          box: true,
          save: true,
          cancel: true,
          typed: true,
          closed: true,
        },
      });
      // The editor's outline, new to the extension, is kept even when it works.
      expect(tried.outline).toContain('Page: profile');
      expect(tried.next).toBeUndefined();
      expect(saves).toBe(0);
      expect(doc.querySelector('textarea')).toBeNull();
    }
  });

  it('never presses another row’s Edit when the Bio row has none and the titles are plain words', async () => {
    vi.useFakeTimers();
    const doc = load('own-profile-about-editor-2026-10.html', EDITOR);
    for (const heading of [...doc.querySelectorAll('h3')]) {
      const words = doc.createElement('span');
      words.innerHTML = heading.innerHTML;
      heading.replaceWith(words);
    }
    doc.getElementById('bio-edit')!.remove();
    const work = doc.querySelector<HTMLElement>('#work-row [role="button"]')!;
    const pressed = never(work);
    work.addEventListener('click', () => {
      const box = doc.createElement('input');
      box.setAttribute('aria-label', 'Company');
      doc.getElementById('work-row')!.append(box, buttonOf(doc, 'Save'), buttonOf(doc, 'Cancel'));
    });
    const tried = await quickly(tryBio(doc));
    expect(tried).toMatchObject({ works: false, found: { button: false } });
    expect(pressed()).toBe(0);
    expect(doc.querySelector('input[aria-label="Company"]')).toBeNull();
  });

  it('writes nothing in a box the bio’s Edit opened that isn’t the bio’s, and closes it', async () => {
    vi.useFakeTimers();
    const doc = load('own-profile-about-editor-2026-10.html', EDITOR);
    let saves = 0;
    doc.getElementById('bio-edit')!.addEventListener('click', () => {
      const box = doc.createElement('input');
      box.setAttribute('aria-label', 'Company');
      box.value = 'Summit Roof Leads';
      const parts: HTMLElement[] = [box, buttonOf(doc, 'Save', () => saves++)];
      parts.push(buttonOf(doc, 'Cancel', () => parts.forEach((p) => p.remove())));
      doc.getElementById('bio-row')!.append(...parts);
    });
    const tried = await quickly(tryBio(doc));
    expect(tried).toMatchObject({
      works: false,
      found: { button: true, box: true, fits: false, typed: false, closed: true },
      missing: ['the box the bio’s Edit opened isn’t the bio’s, so nothing was written in it'],
    });
    expect(saves).toBe(0);
    expect(doc.querySelector('input[aria-label="Company"]')).toBeNull();
  });
});

describe('trying a link', () => {
  const CONTACT = `${FB}/casey.owner.7/about_contact?fb_profile_edit_entry_point=9`;

  /** Contact and basic info: Add a website opens a box with Save and Cancel, and Cancel closes it. */
  function contact() {
    const doc = load('own-profile-contact-2026-10.html', CONTACT);
    let saves = 0;
    doc.getElementById('add-website')!.addEventListener('click', () => {
      const box = doc.createElement('input');
      box.setAttribute('aria-label', 'Website');
      const parts: HTMLElement[] = [box];
      parts.push(buttonOf(doc, 'Save', () => saves++));
      parts.push(buttonOf(doc, 'Cancel', () => parts.forEach((p) => p.remove())));
      doc.getElementById('links')!.append(...parts);
    });
    return { doc, saves: () => saves };
  }

  it('opens Add a website’s box, writes a word and takes it out, never saves, and closes it', async () => {
    vi.useFakeTimers();
    const { doc, saves } = contact();
    const social = never(doc.getElementById('add-social'));
    const tried = await quickly(tryLinks(doc));
    expect(tried).toMatchObject({
      step: 'links',
      works: true,
      found: { add: true, box: true, save: true, cancel: true, typed: true, closed: true },
    });
    expect(tried.outline).toContain('Add a website');
    expect([saves(), social()]).toEqual([0, 0]);
    expect(doc.querySelector('input[aria-label="Website"]')).toBeNull();
  });

  it('says when there’s no Add a website, with the outline', async () => {
    vi.useFakeTimers();
    const { doc } = contact();
    doc.getElementById('add-website')!.remove();
    const tried = await quickly(tryLinks(doc));
    expect(tried).toMatchObject({
      works: false,
      found: { add: false },
      missing: ['no Add a website on Contact and basic info'],
    });
    expect(tried.seen).toContain('Add a social link');
  });
});

describe('trying the username', () => {
  const PAGE = 'https://accountscenter.facebook.com/profiles/100001234/username/';

  /** Accounts Center's username page: typing says whether a username is free, and turns Done on or off. */
  function usernamePage() {
    const doc = load('accounts-center-username-2026-10.html', PAGE);
    const box = doc.getElementById('u1') as HTMLInputElement;
    const done = doc.getElementById('done')!;
    box.addEventListener('input', () => {
      setTimeout(() => {
        const theirs = box.value === 'casey.owner.7';
        doc.getElementById('said')!.textContent = theirs
          ? ''
          : 'This username isn’t available. Try another.';
        if (theirs) done.setAttribute('aria-disabled', 'true');
      }, 300);
    });
    return { doc, box, done: never(done) };
  }

  it('writes a word in Username to see what Facebook says, puts theirs back, and never presses Done', async () => {
    vi.useFakeTimers();
    const { doc, box, done } = usernamePage();
    const tried = await quickly(tryUsername(doc));
    expect(tried).toMatchObject({
      step: 'username',
      works: true,
      found: { boxes: 1, dones: 1, typed: true, answered: true, taken: true, restored: true },
    });
    // Facebook's words kept, the username hidden.
    expect(tried.outline).toContain('Username');
    expect(tried.outline).not.toContain('casey.owner.7');
    expect(tried.outline).not.toContain('100001234');
    expect(done()).toBe(0);
    expect(box.value).toBe('casey.owner.7');
  });

  it('writes nothing while Facebook asks for the password first', async () => {
    vi.useFakeTimers();
    const { doc, box, done } = usernamePage();
    const ask = doc.createElement('div');
    ask.setAttribute('role', 'dialog');
    ask.innerHTML = '<h2>Re-enter your password</h2><input type="password" />';
    doc.body.append(ask);
    const tried = await quickly(tryUsername(doc));
    expect(tried).toMatchObject({ tried: false, found: { password: true } });
    expect(tried.outline).toContain('Re-enter your password');
    expect(box.value).toBe('casey.owner.7');
    expect(done()).toBe(0);
  });

  it('takes Facebook’s “Confirm it’s you” with ways to pick as asking the person, never a warning, drawn a moment after', async () => {
    vi.useFakeTimers();
    const { doc, box, done } = usernamePage();
    doc.getElementById('u1')!.closest('form')!.remove();
    setTimeout(() => {
      const ask = doc.createElement('div');
      ask.setAttribute('role', 'dialog');
      ask.innerHTML =
        '<h2>Confirm it’s you</h2><label><input type="radio" name="how" /> Enter your password</label>' +
        '<label><input type="radio" name="how" /> Get a code by email</label><div role="button">Continue</div>';
      doc.body.append(ask);
    }, 1_000);
    const tried = await quickly(tryUsername(doc));
    expect(tried).toMatchObject({
      tried: false,
      found: { confirm: true },
      missing: ['Facebook asks you to confirm it’s you first, so the Username box doesn’t show'],
    });
    expect(box.value).toBe('casey.owner.7');
    expect(done()).toBe(0);
  });

  it('says so when Facebook shows a warning on the page, nothing written', async () => {
    vi.useFakeTimers();
    const { doc, box } = usernamePage();
    const warning = doc.createElement('div');
    warning.setAttribute('role', 'dialog');
    warning.innerHTML =
      '<h2>You’re temporarily blocked</h2><span>It looks like you were going too fast. Try again later.</span>';
    doc.body.append(warning);
    const tried = await quickly(tryUsername(doc));
    expect(tried).toMatchObject({ tried: false, found: { warning: true } });
    expect(box.value).toBe('casey.owner.7');
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

  it('finds Add friend and Cancel request when their labels have the person’s name after them', () => {
    const doc = load('profile-2026.html', DANA);
    const button = standing(doc);
    const label = (words: string) => {
      button.setAttribute('aria-label', `${words} Dana Reyes`);
      [...button.querySelectorAll('span')].at(-1)!.textContent = words;
    };
    label('Add Friend');
    expect(tryRequest(doc, DANA)).toMatchObject({
      works: true,
      found: { addFriend: true, standingKnown: true },
    });
    label('Cancel request');
    expect(tryCancel(doc, DANA)).toMatchObject({
      works: true,
      found: { cancel: true, standingKnown: true },
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
