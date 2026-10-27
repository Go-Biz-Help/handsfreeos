/**
 * Cancelling old requests and unfriending (src/networks/facebook/tidy.ts): on a made-up 2026 profile whose buttons behave like
 * Facebook's (Friends opens a menu with Unfriend, which asks to be sure), the extension presses only the profile's
 * button, never its Friends tab; presses in the box on top, never behind it; and the profile reads as not friends
 * after. Plain and with a bare box around everything.
 */
import { describe, expect, it } from 'vitest';
import { doPath, doStep, type FetchStep } from '../src/networks/facebook/fetch';
import { readPage } from '../src/networks/facebook/page';
import { withTheirName } from '../src/networks/facebook/auto';
import { sameProfile, TIDY_PLANS, tidyPage } from '../src/networks/facebook/tidy';
import { boxEverything, load } from './load';

const URL = 'https://www.facebook.com/dana.reyes.12';

/** The button at the top of the profile that says where the two of you stand. */
const standing = (doc: Document) =>
  doc.querySelector<HTMLElement>('[role="main"] [role="button"][aria-label="Friends"]') ??
  doc.querySelector<HTMLElement>('[role="main"] [role="button"][data-standing]');

function relabel(button: HTMLElement, label: string): void {
  button.setAttribute('aria-label', label);
  button.setAttribute('data-standing', '');
  const words = [...button.querySelectorAll('span')].at(-1);
  if (words) words.textContent = label;
}

/** Facebook's box over the page: a menu or a dialog with buttons, each doing `then` when pressed. */
function overlay(
  doc: Document,
  role: 'menu' | 'dialog',
  items: Record<string, () => void>,
): HTMLElement {
  const box = doc.createElement('div');
  box.setAttribute('role', role);
  for (const [label, then] of Object.entries(items)) {
    const item = doc.createElement('div');
    item.setAttribute('role', role === 'menu' ? 'menuitem' : 'button');
    item.tabIndex = 0;
    item.innerHTML = `<span>${label}</span>`;
    item.addEventListener('click', () => {
      box.remove();
      then();
    });
    box.append(item);
  }
  doc.body.append(box);
  return box;
}

/** A friend's profile whose Friends button unfriends, through a menu and a box asking to be sure. */
function friendProfile(boxed = false): { doc: Document; tabClicks: () => number } {
  const doc = load('profile-2026.html', URL);
  if (boxed) boxEverything(doc);
  let tabClicks = 0;
  for (const tab of doc.querySelectorAll('a[href$="/friends"], a[href*="/friends/"]'))
    tab.addEventListener('click', (e) => {
      e.preventDefault();
      tabClicks++;
    });
  const button = standing(doc)!;
  button.addEventListener('click', () =>
    overlay(doc, 'menu', {
      Favorites: () => undefined,
      Unfollow: () => undefined,
      Unfriend: () =>
        overlay(doc, 'dialog', {
          Cancel: () => undefined,
          Confirm: () => relabel(button, 'Add friend'),
        }),
    }),
  );
  return { doc, tabClicks: () => tabClicks };
}

/** Walks a plan as the panel does: the path, then the box asking to be sure. */
function walk(doc: Document, path: readonly FetchStep[], then: readonly FetchStep[]): void {
  let from = 0;
  for (let tries = 0; from < path.length && tries < 5; tries++) {
    const went = doPath(doc, path, from);
    if (!('at' in went)) throw new Error(`Stuck before: ${path[from]!.says}`);
    from = went.at + 1;
  }
  for (const step of then) doStep(doc, step);
}

describe('unfriending', () => {
  for (const boxed of [false, true])
    it(`presses Friends, Unfriend and Confirm, and the profile reads as not friends after${boxed ? ', boxed' : ''}`, () => {
      const { doc, tabClicks } = friendProfile(boxed);
      expect(readPage(doc, URL).profile?.friendship).toBe(TIDY_PLANS.unfriend.before);
      walk(doc, TIDY_PLANS.unfriend.path, TIDY_PLANS.unfriend.then);
      expect(readPage(doc, URL).profile?.friendship).toBe('not_friends');
      expect(tabClicks()).toBe(0);
    });

  it('never presses the Friends tab, and never Confirm on the page itself', () => {
    const doc = load('profile-2026.html', URL);
    standing(doc)!.remove();
    const [friendsStep] = TIDY_PLANS.unfriend.path;
    expect(doStep(doc, friendsStep!)).toBe('missing');
    const pageConfirm = doc.createElement('div');
    pageConfirm.setAttribute('role', 'button');
    pageConfirm.textContent = 'Confirm';
    let pressed = false;
    pageConfirm.addEventListener('click', () => (pressed = true));
    doc.querySelector('[role="main"]')!.append(pageConfirm);
    expect(doStep(doc, TIDY_PLANS.unfriend.then[0]!)).toBe('missing');
    expect(pressed).toBe(false);
  });
});

describe('cancelling a request', () => {
  it('presses Cancel request, and the profile reads as not friends after', () => {
    const doc = load('profile-2026.html', URL);
    const button = standing(doc)!;
    relabel(button, 'Cancel request');
    button.addEventListener('click', () => relabel(button, 'Add friend'));
    expect(readPage(doc, URL).profile?.friendship).toBe(TIDY_PLANS.cancel_request.before);
    walk(doc, TIDY_PLANS.cancel_request.path, TIDY_PLANS.cancel_request.then);
    expect(readPage(doc, URL).profile?.friendship).toBe('not_friends');
  });

  it('presses Cancel request when its label has their name after it', () => {
    // From October 2026: "Cancel request Dana Reyes" for screen readers, "Cancel request" to see.
    const doc = load('profile-2026.html', URL);
    const button = standing(doc)!;
    const label = (words: string) => {
      button.setAttribute('aria-label', `${words} Dana Reyes`);
      [...button.querySelectorAll('span')].at(-1)!.textContent = words;
    };
    label('Cancel request');
    button.addEventListener('click', () => label('Add Friend'));
    expect(readPage(doc, URL).profile?.friendship).toBe(TIDY_PLANS.cancel_request.before);
    expect(() =>
      walk(doc, TIDY_PLANS.cancel_request.path, TIDY_PLANS.cancel_request.then),
    ).toThrow();
    walk(
      doc,
      withTheirName(TIDY_PLANS.cancel_request.path, ['Dana Reyes']),
      TIDY_PLANS.cancel_request.then,
    );
    expect(readPage(doc, URL).profile?.friendship).toBe('not_friends');
  });

  it('works only on profiles, and only on the one ticked', () => {
    expect(tidyPage(URL)).toBe(true);
    expect(tidyPage('https://www.facebook.com/profile.php?id=100001234567890')).toBe(true);
    expect(tidyPage('https://www.facebook.com/friends/requests')).toBe(false);
    expect(tidyPage('https://www.facebook.com/groups/223456789/')).toBe(false);
    const shown = { id: null, username: 'Dana.Reyes.12', url: URL };
    expect(sameProfile(shown, { platformId: null, username: 'dana.reyes.12' })).toBe(true);
    expect(sameProfile(shown, { platformId: '100001234567890', username: null })).toBe(false);
    expect(sameProfile(null, { platformId: null, username: 'dana.reyes.12' })).toBe(false);
  });
});
