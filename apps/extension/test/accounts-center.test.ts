/**
 * Accounts Center, for Put these in (docs/outreach.md, decision 89): the person's own name put in on its name page for
 * their Facebook profile (First name, Middle name and Last name, then Review change and Done) and for their Instagram
 * profile (one Name box, then Done), and their Instagram username on Instagram's own Accounts Center, each by itself on
 * made-up pages whose buttons behave as Meta's usually do (test/center-pages.ts, test/fixtures/accounts-center-*.html,
 * nobody real). It never types a password or a code, never ticks or unticks the other network's name, and presses each
 * button only once Meta allows it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nameWords } from '../src/jobs/accounts-center';
import { instagram, facebook, kitHere, kitOf, KITS } from '../src/networks';
import { writeName } from '../src/networks/accounts-center/name';
import {
  centerAddress,
  centerPageOf,
  centerUrl,
  centerWarnings,
  profileRowOn,
  profilesPage,
} from '../src/networks/accounts-center/pages';
import { writeUsername } from '../src/networks/accounts-center/username';
import { centerWork, type CenterAsk } from '../src/networks/accounts-center/work';
import { readWarnings } from '../src/networks/facebook/warnings';
import {
  dialogIn,
  facebookNamePage,
  FB_CENTER,
  FB_NAME_PAGE,
  FB_PROFILE,
  IG_CENTER,
  IG_NAME_PAGE,
  IG_PROFILE,
  IG_USERNAME_PAGE,
  instagramNamePage,
  instagramUsernamePage,
} from './center-pages';
import { load } from './load';

// A test walks a page's every step, some twice over: about a second here, several on a busy CI machine.
vi.setConfig({ testTimeout: 20_000 });

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Runs a step with Meta's waits skipped. */
async function quickly<T>(going: Promise<T>): Promise<T> {
  let settled = false;
  void going.finally(() => (settled = true)).catch(() => undefined);
  for (let i = 0; i < 600 && !settled; i++) await vi.advanceTimersByTimeAsync(500);
  return going;
}

/** Accounts Center's Profiles on a network's host, with the rows a test leaves. */
function profiles(host: string, keep: (row: Element) => boolean = () => true): Document {
  const doc = load('accounts-center-profiles-2026-10.html', `${host}/profiles`);
  for (const row of [...doc.querySelectorAll('[role="listitem"]')]) if (!keep(row)) row.remove();
  return doc;
}

const says = (row: Element, network: string) => (row.textContent ?? '').includes(network);

describe('Accounts Center’s pages, each network’s own', () => {
  it('knows each network’s name and username pages by the profile’s number, and goes nowhere else to type', () => {
    expect(centerAddress('instagram', IG_PROFILE, 'name')).toBe(IG_NAME_PAGE);
    expect(centerAddress('facebook', FB_PROFILE, 'name')).toBe(FB_NAME_PAGE);
    expect(centerAddress('instagram', 'casey.owner', 'username')).toBeNull();
    expect(centerPageOf(IG_NAME_PAGE, 'instagram', 'name')).toBe(IG_PROFILE);
    expect(centerPageOf(IG_NAME_PAGE, 'instagram', 'username')).toBeNull();
    // Never Facebook's page for Instagram's, or Instagram's for Facebook's.
    expect(centerPageOf(IG_NAME_PAGE, 'facebook', 'name')).toBeNull();
    expect(centerPageOf(FB_NAME_PAGE, 'instagram', 'name')).toBeNull();
    for (const elsewhere of [
      'http://accountscenter.instagram.com/profiles/1/name/',
      'https://accountscenter.instagram.com:8443/profiles/1/name/',
      'https://accountscenter.instagram.com.evil.example/profiles/1/name/',
      'https://user@accountscenter.instagram.com/profiles/1/name/',
    ])
      expect(centerUrl(elsewhere)).toBeNull();
    expect(profilesPage(`${IG_CENTER}/profiles`, 'instagram')).toBe(true);
    expect(profilesPage(`${IG_CENTER}/profiles`, 'facebook')).toBe(false);
  });

  it('lets Instagram’s tab go to Instagram’s own Accounts Center only, and notes nothing done there', () => {
    expect(KITS.instagram.workUrl(IG_NAME_PAGE)).toBe(IG_NAME_PAGE);
    expect(KITS.instagram.workUrl(`${IG_CENTER}/profiles`)).toBe(`${IG_CENTER}/profiles`);
    expect(KITS.instagram.workUrl(FB_NAME_PAGE)).toBeNull();
    expect(KITS.facebook.workUrl(IG_NAME_PAGE)).toBeNull();
    expect(KITS.instagram.hosts).toContain('https://accountscenter.instagram.com/*');
    expect(kitHere(IG_NAME_PAGE)).toBe(instagram);
    expect(kitHere(FB_NAME_PAGE)).toBe(facebook);
    // Not its own pages: the background takes no note from them.
    expect(kitOf(IG_NAME_PAGE)).toBeNull();
  });

  it('picks the Instagram profile that shows the account signed in, never Facebook’s', () => {
    const doc = profiles(IG_CENTER);
    expect(profileRowOn(doc, 'instagram', 'casey.owner')).toBe(IG_PROFILE);
    expect(profileRowOn(doc, 'instagram', 'Casey.Owner')).toBe(IG_PROFILE);
    expect(profileRowOn(doc, 'facebook')).toBe(FB_PROFILE);
    // Never another account's row, even the only Instagram one there: nothing's typed, and the step is handed over.
    expect(profileRowOn(doc, 'instagram', 'someone.else')).toBeNull();
  });

  it('picks none when it can’t tell which, or Instagram isn’t there', () => {
    const notLinked = profiles(IG_CENTER, (row) => !says(row, 'Instagram'));
    expect(profileRowOn(notLinked, 'instagram', 'casey.owner')).toBeNull();
    const two = profiles(IG_CENTER);
    two
      .querySelector('[role="list"]')!
      .insertAdjacentHTML(
        'beforeend',
        '<a role="listitem" href="/profiles/17841400000000002/"><span>casey.roofs.shop</span><span>Instagram</span></a>',
      );
    expect(profileRowOn(two, 'instagram', 'nobody.here')).toBeNull();
    expect(profileRowOn(two, 'instagram', 'casey.roofs.shop')).toBe('17841400000000002');
    // One Instagram row that doesn't show the account signed in: not theirs to type on.
    const notTheirs = profiles(IG_CENTER);
    for (const row of notTheirs.querySelectorAll('[role="listitem"]'))
      if (says(row, 'Instagram')) row.querySelector('span')!.textContent = 'casey.roofs.shop';
    expect(profileRowOn(notTheirs, 'instagram', 'casey.owner')).toBeNull();
  });
});

describe('Meta’s warnings on Accounts Center', () => {
  it('stops on a block, never on Meta’s answer about a name, “Try again later” beside it included', () => {
    const doc = load('accounts-center-instagram-name-2026-10.html', IG_NAME_PAGE);
    dialogIn(
      doc,
      '<span>You’ve changed your name too many times.</span><div role="alert"><span>Try again later.</span></div>',
    );
    dialogIn(doc, '<h2>You can’t change your name right now</h2>');
    expect(centerWarnings(doc, IG_NAME_PAGE, 'instagram')).toEqual([]);
    dialogIn(
      doc,
      '<h2>Action Blocked</h2><span>We restrict certain activity to protect our community.</span>',
    );
    expect(centerWarnings(doc, IG_NAME_PAGE, 'instagram')).toEqual([
      'Action Blocked',
      'We restrict certain activity to protect our community.',
    ]);
    const fb = load('accounts-center-name-2026-10.html', FB_NAME_PAGE);
    dialogIn(fb, '<h2>You’re Temporarily Blocked</h2><div role="button">OK</div>');
    expect(centerWarnings(fb, FB_NAME_PAGE)).toEqual(['You’re Temporarily Blocked']);
  });

  it('takes Instagram’s own “Try Again Later” box, or its lock, for a warning there, as on its own pages', () => {
    const later = load('accounts-center-instagram-username-2026-10.html', IG_USERNAME_PAGE);
    dialogIn(
      later,
      '<h2>Try Again Later</h2><span>Please wait a few minutes before you try again.</span>',
    );
    expect(centerWarnings(later, IG_USERNAME_PAGE, 'instagram')).toEqual(['Try Again Later']);
    const locked = load('accounts-center-instagram-name-2026-10.html', IG_NAME_PAGE);
    dialogIn(locked, '<h2>Your account has been temporarily locked</h2>');
    expect(centerWarnings(locked, IG_NAME_PAGE, 'instagram')).toEqual([
      'Your account has been temporarily locked',
    ]);
  });
});

describe('putting the name in on Facebook', () => {
  it('splits it into First name and Last name, Middle name empty, presses Review change and Done once each, and sees it saved', async () => {
    for (const boxed of [false, true]) {
      const page = facebookNamePage({ boxed });
      const wrote = await quickly(writeName(page.doc, 'Casey Lee'));
      expect(wrote.result).toBe('done');
      expect(wrote.steps).toMatchObject({
        asking: null,
        firstBoxes: 1,
        middleBoxes: 1,
        lastBoxes: 1,
        sync: false,
        typed: true,
        reviews: 1,
        reviewed: true,
        order: 'kept',
        dones: 1,
        doneOn: true,
        answer: 'none',
        pressed: true,
        confirmed: false,
        over: false,
        saved: true,
      });
      expect(page.saved()).toBe('Casey Lee');
      expect(page.pressed()).toEqual({ review: 1, done: 1, sure: 0 });
    }
  });

  it('puts every word after the first in Last name, and empties Middle name, so the name is the one picked', async () => {
    const page = facebookNamePage({ leaves: true });
    page.boxes.middle.value = 'Jo';
    const wrote = await quickly(writeName(page.doc, '  Casey   Ann Lee '));
    expect(wrote.result).toBe('done');
    expect(page.saved()).toBe('Casey Ann Lee');
    const { first, middle, last } = page.boxes;
    expect([first.value, middle.value, last.value]).toEqual(['Casey', '', 'Ann Lee']);
  });

  it('says it’s their name already, and presses nothing', async () => {
    const page = facebookNamePage();
    page.boxes.last.value = 'Lee';
    expect((await quickly(writeName(page.doc, 'Casey Lee'))).result).toBe('already');
    expect(page.pressed()).toEqual({ review: 0, done: 0, sure: 0 });
  });

  it('presses Facebook’s Change name once when it asks to be sure', async () => {
    const page = facebookNamePage({ sure: { button: 'Change name' } });
    const wrote = await quickly(writeName(page.doc, 'Casey Lee'));
    expect(wrote.result).toBe('done');
    expect(wrote.steps.confirmed).toBe(true);
    expect(page.pressed().sure).toBe(1);
    expect(page.saved()).toBe('Casey Lee');
  });

  it('waits for the person on the password Facebook asks for by Review change’s Done, never typing it or pressing Done', async () => {
    const page = facebookNamePage({ password: 'review' });
    const wrote = await quickly(writeName(page.doc, 'Casey Lee'));
    expect(wrote.result).toBe('waiting');
    expect(wrote.steps).toMatchObject({ asking: 'password', reviewed: true, pressed: false });
    expect(page.passwordBox()!.value).toBe('');
    expect(page.pressed().done).toBe(0);
  });

  it('waits for the person on a password before anything’s typed, or “Confirm it’s you”', async () => {
    const before = facebookNamePage({ password: 'before' });
    const first = await quickly(writeName(before.doc, 'Casey Lee'));
    expect(first.result).toBe('waiting');
    expect(first.steps).toMatchObject({ asking: 'password', typed: false });
    expect(before.boxes.last.value).toBe('Owner');

    const confirm = facebookNamePage({ confirmFirst: true });
    const second = await quickly(writeName(confirm.doc, 'Casey Lee'));
    expect(second.result).toBe('waiting');
    expect(second.steps).toMatchObject({ asking: 'confirm', typed: false });
  });

  it('waits for the person on a code Facebook asks for after Done, typing nothing in it', async () => {
    const page = facebookNamePage({ code: true });
    const wrote = await quickly(writeName(page.doc, 'Casey Lee'));
    expect(wrote.result).toBe('waiting');
    expect(wrote.steps).toMatchObject({ asking: 'code', pressed: true });
    expect(page.doc.querySelector<HTMLInputElement>('input[type="tel"]')!.value).toBe('');
  });

  it('ends with Facebook’s words when it won’t take the name, Done never pressed', async () => {
    const page = facebookNamePage({
      refuses: { on: 'review', says: 'This name doesn’t follow our Name Standards.' },
    });
    const wrote = await quickly(writeName(page.doc, 'Casey Lee'));
    expect(wrote).toMatchObject({
      result: 'invalid',
      said: 'This name doesn’t follow our Name Standards.',
    });
    expect(wrote.steps.answer).toBe('invalid');
    expect(page.pressed().done).toBe(0);
    expect(page.saved()).toBeNull();
  });

  it('ends with Facebook’s words when it won’t change the name now: before typing, on Review change, or after Done', async () => {
    const first = facebookNamePage({ saysFirst: 'You can’t change your name right now.' });
    const now = await quickly(writeName(first.doc, 'Casey Lee'));
    expect(now).toMatchObject({ result: 'limit', said: 'You can’t change your name right now.' });
    expect(first.boxes.last.value).toBe('Owner');
    expect(first.pressed().review).toBe(0);

    const recent = facebookNamePage({
      refuses: {
        on: 'review',
        says: 'You changed your name recently. You can change it again on 12 December.',
      },
    });
    expect((await quickly(writeName(recent.doc, 'Casey Lee'))).result).toBe('limit');

    const after = facebookNamePage({
      refuses: { on: 'done', says: 'You can only change your name once every 60 days.' },
    });
    const late = await quickly(writeName(after.doc, 'Casey Lee'));
    expect(late).toMatchObject({ result: 'limit', steps: { pressed: true } });
    expect(after.saved()).toBeNull();
  });

  it('types nothing in boxes Facebook holds', async () => {
    const page = facebookNamePage({ held: true });
    expect((await quickly(writeName(page.doc, 'Casey Lee'))).result).toBe('limit');
    expect(page.boxes.last.value).toBe('Owner');
  });

  it('never takes the page’s own help for an answer: its 60 days and its advice on names', async () => {
    const page = facebookNamePage();
    const wrote = await quickly(writeName(page.doc, 'Casey Lee'));
    expect(wrote).toMatchObject({ result: 'done', said: null });
  });

  it('says a name Facebook looks at first is under review, never saved', async () => {
    const page = facebookNamePage({ reviewing: true });
    const wrote = await quickly(writeName(page.doc, 'Casey Lee'));
    expect(wrote.result).toBe('review');
    expect(wrote.steps).toMatchObject({ answer: 'review', pressed: true, saved: false });
  });

  it('never takes a box after Done it doesn’t know for saved', async () => {
    const page = facebookNamePage({ sure: { button: 'Yes, change it' } });
    const wrote = await quickly(writeName(page.doc, 'Casey Lee'));
    expect(wrote.result).toBe('not_saved');
    expect(wrote.steps).toMatchObject({
      pressed: true,
      confirmed: false,
      over: true,
      saved: false,
    });
    expect(page.saved()).toBeNull();
  });

  it('never presses a box after Done that offers to change Instagram’s name too, and hands it over', async () => {
    const page = facebookNamePage({
      sure: { says: 'Also change your name on Instagram to Casey Lee?', button: 'Confirm' },
    });
    const wrote = await quickly(writeName(page.doc, 'Casey Lee'));
    expect(wrote.result).toBe('not_saved');
    expect(wrote.steps).toMatchObject({ pressed: true, confirmed: false, sync: true });
    expect(page.pressed().sure).toBe(0);
    expect(page.saved()).toBeNull();
    expect(nameWords('facebook', 'Casey Lee', wrote)).toBe(
      'Facebook offers to change your name on Instagram too, so the extension didn’t press its button. In the Facebook window, change only your Facebook name to “Casey Lee”: untick Instagram there if you can, or press Cancel. Then press Carry on.',
    );
  });

  it('stops before Done when the step after Review change offers Instagram’s name too, and says so', async () => {
    const page = facebookNamePage({ syncOnReview: true });
    const wrote = await quickly(writeName(page.doc, 'Casey Lee'));
    expect(wrote.result).toBe('none');
    expect(wrote.steps).toMatchObject({ sync: true, typed: true, reviewed: true, pressed: false });
    expect(page.pressed().done).toBe(0);
    expect(nameWords('facebook', 'Casey Lee', wrote)).toBe(
      'Accounts Center offers to change your name on Instagram too, so the extension stopped before saving. On this page, untick Instagram so only your Facebook name changes, check it reads “Casey Lee”, and press Done. Then press Carry on.',
    );
  });

  it('never ticks or unticks Instagram’s name: with its offer on, nothing’s typed', async () => {
    const page = facebookNamePage({ sync: true });
    const tick = page.doc.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    const wrote = await quickly(writeName(page.doc, 'Casey Lee'));
    expect(wrote.result).toBe('none');
    expect(wrote.steps).toMatchObject({ sync: true, typed: false });
    expect([tick.checked, page.boxes.last.value]).toEqual([true, 'Owner']);
  });

  it('never picks how the name is shown: with none picked, Done waits for the person', async () => {
    const page = facebookNamePage({ order: 'unpicked' });
    const wrote = await quickly(writeName(page.doc, 'Casey Lee'));
    expect(wrote.result).toBe('none');
    expect(wrote.steps).toMatchObject({ reviewed: true, order: 'unpicked', pressed: false });
    expect(page.pressed().done).toBe(0);
    expect(
      [...page.doc.querySelectorAll<HTMLInputElement>('input[type="radio"]')].some(
        (r) => r.checked,
      ),
    ).toBe(false);
  });

  it('refuses a name Facebook wouldn’t take before typing it', async () => {
    const page = facebookNamePage();
    const wrote = await quickly(writeName(page.doc, 'Casey Owner | Roofs'));
    expect(wrote.result).toBe('invalid');
    expect(page.boxes.last.value).toBe('Owner');
  });

  it('stops on a Facebook block over the page, nothing typed', async () => {
    const page = facebookNamePage({ blocked: true });
    const wrote = await quickly(writeName(page.doc, 'Casey Lee'));
    expect(wrote.result).toBe('warned');
    expect(wrote.warnings).toContain('You’re temporarily blocked');
    expect(page.boxes.last.value).toBe('Owner');
  });

  it('types in no box when there are two named First name', async () => {
    const page = facebookNamePage();
    page.doc
      .getElementById('name-form')!
      .insertAdjacentHTML(
        'beforeend',
        '<label for="n4">First name</label><input id="n4" type="text" />',
      );
    const wrote = await quickly(writeName(page.doc, 'Casey Lee'));
    expect(wrote.result).toBe('none');
    expect(wrote.steps.firstBoxes).toBe(2);
    expect(page.boxes.last.value).toBe('Owner');
  });
});

describe('putting the name in on Instagram', () => {
  it('types it in its one Name box, presses Done once Instagram allows it, and sees it saved', async () => {
    const page = instagramNamePage();
    const wrote = await quickly(writeName(page.doc, 'Casey Lee', 'instagram'));
    expect(wrote.result).toBe('done');
    expect(wrote.steps).toMatchObject({
      nameBoxes: 1,
      firstBoxes: 0,
      typed: true,
      reviewed: false,
      pressed: true,
      saved: true,
    });
    expect([page.saved(), page.pressed()]).toEqual(['Casey Lee', 1]);
  });

  it('takes a name that says what the person does, as Instagram’s does', async () => {
    const page = instagramNamePage();
    expect((await quickly(writeName(page.doc, 'Casey | Columbus Roofs', 'instagram'))).result).toBe(
      'done',
    );
    expect(page.saved()).toBe('Casey | Columbus Roofs');
  });

  it('ends with Instagram’s words when it won’t change the name, never as a warning', async () => {
    const page = instagramNamePage({
      refuses: 'You’ve changed your name too many times. Try again later.',
    });
    const wrote = await quickly(writeName(page.doc, 'Casey Lee', 'instagram'));
    expect(wrote).toMatchObject({
      result: 'limit',
      said: 'You’ve changed your name too many times. Try again later.',
    });
    expect(wrote.warnings).toBeUndefined();
  });

  it('presses Instagram’s Confirm after Done once, but never one offering Facebook’s name too', async () => {
    const plain = instagramNamePage({ sure: { button: 'Confirm' } });
    expect((await quickly(writeName(plain.doc, 'Casey Lee', 'instagram'))).result).toBe('done');
    expect([plain.sures(), plain.saved()]).toEqual([1, 'Casey Lee']);

    const both = instagramNamePage({
      sure: { says: 'Change your name on Facebook too?', button: 'Confirm' },
    });
    const wrote = await quickly(writeName(both.doc, 'Casey Lee', 'instagram'));
    expect(wrote).toMatchObject({ result: 'not_saved', steps: { sync: true, confirmed: false } });
    expect([both.sures(), both.saved()]).toEqual([0, null]);
  });

  it('never changes Facebook’s name with it: with that offer on, nothing’s typed', async () => {
    const page = instagramNamePage({ sync: true });
    const wrote = await quickly(writeName(page.doc, 'Casey Lee', 'instagram'));
    expect(wrote.steps).toMatchObject({ sync: true, typed: false });
    expect(page.box.value).toBe('Casey');
  });
});

describe('putting the username in on Instagram', () => {
  it('types it on the page of the account signed in, presses Done once Instagram allows it, and sees it saved', async () => {
    const page = instagramUsernamePage();
    const wrote = await quickly(
      writeUsername(page.doc, 'casey.roofs', { network: 'instagram', was: 'casey.owner' }),
    );
    expect(wrote.result).toBe('done');
    expect(wrote.steps).toMatchObject({ boxes: 1, other: false, typed: true, pressed: true });
    expect([page.saved(), page.pressed()]).toEqual(['casey.roofs', 1]);
  });

  it('types nothing on another account’s username page', async () => {
    const page = instagramUsernamePage({ holds: 'someone.else' });
    const wrote = await quickly(
      writeUsername(page.doc, 'casey.roofs', { network: 'instagram', was: 'casey.owner' }),
    );
    expect(wrote.result).toBe('none');
    expect(wrote.steps).toMatchObject({ other: true, typed: false });
    expect(page.box.value).toBe('someone.else');
  });

  it('never presses Done on a username Instagram says isn’t available', async () => {
    const page = instagramUsernamePage({ taken: true });
    const wrote = await quickly(
      writeUsername(page.doc, 'casey.roofs', { network: 'instagram', was: 'casey.owner' }),
    );
    expect(wrote).toMatchObject({
      result: 'taken',
      said: 'The username casey.roofs is not available.',
    });
    expect(page.pressed()).toBe(0);
  });

  it('stops on Instagram’s own “Try Again Later” box once something’s typed, Done never pressed', async () => {
    const page = instagramUsernamePage({ later: true });
    const wrote = await quickly(
      writeUsername(page.doc, 'casey.roofs', { network: 'instagram', was: 'casey.owner' }),
    );
    expect(wrote).toMatchObject({ result: 'warned', warnings: ['Try Again Later'] });
    expect(page.pressed()).toBe(0);
  });

  it('never presses a box after Done that offers to change Facebook’s username too', async () => {
    const page = instagramUsernamePage({
      sure: { says: 'Also use casey.roofs as your Facebook username?', button: 'Confirm' },
    });
    const wrote = await quickly(
      writeUsername(page.doc, 'casey.roofs', { network: 'instagram', was: 'casey.owner' }),
    );
    expect(wrote).toMatchObject({
      result: 'not_saved',
      steps: { pressed: true, confirmed: false, sync: true },
    });
    expect([page.sures(), page.saved()]).toEqual([0, null]);
  });

  it('waits for the person on the password Instagram asks for after Done', async () => {
    const page = instagramUsernamePage({ password: true });
    const wrote = await quickly(
      writeUsername(page.doc, 'casey.roofs', { network: 'instagram', was: 'casey.owner' }),
    );
    expect(wrote.result).toBe('waiting');
    expect(wrote.steps).toMatchObject({ asking: 'password', pressed: true });
  });
});

describe('the tab’s asks on Accounts Center', () => {
  /** Answers an ask as the tab would, on this page at this address. */
  async function inTab(
    network: 'facebook' | 'instagram',
    doc: Document,
    ask: CenterAsk,
  ): Promise<unknown> {
    vi.stubGlobal('location', new URL(doc.location.href));
    vi.stubGlobal('document', doc);
    return quickly(centerWork(network, ask, readWarnings));
  }

  it('types only on the page of the profile whose number the ask carries', async () => {
    const other = facebookNamePage({}, `${FB_CENTER}/profiles/100009999/name/`);
    expect(
      await inTab('facebook', other.doc, {
        type: 'hfos-write-center-name',
        name: 'Casey Lee',
        profile: FB_PROFILE,
      }),
    ).toEqual({ ok: false, error: 'Facebook didn’t open Accounts Center’s name page.' });
    expect(other.boxes.last.value).toBe('Owner');
  });

  it('never answers on the other network’s Accounts Center', async () => {
    const fb = facebookNamePage();
    expect(
      await inTab('instagram', fb.doc, {
        type: 'hfos-write-center-name',
        name: 'Casey Lee',
        profile: FB_PROFILE,
      }),
    ).toEqual({ ok: false, error: 'Instagram didn’t open Accounts Center’s name page.' });
    expect(fb.boxes.last.value).toBe('Owner');
  });

  it('finds the Instagram profile signed in among Profiles, or says there’s none', async () => {
    expect(
      await inTab('instagram', profiles(IG_CENTER), {
        type: 'hfos-username-page',
        username: 'casey.owner',
      }),
    ).toEqual({
      ok: true,
      url: IG_USERNAME_PAGE,
      profile: IG_PROFILE,
      warnings: [],
      asking: null,
    });
    expect(
      await inTab(
        'instagram',
        profiles(IG_CENTER, (row) => !says(row, 'Instagram')),
        { type: 'hfos-username-page', username: 'casey.owner' },
      ),
    ).toMatchObject({ ok: true, url: null, profile: null });
  });

  it('answers through Instagram’s tab, on its own Accounts Center', async () => {
    const page = instagramNamePage();
    vi.stubGlobal('location', new URL(IG_NAME_PAGE));
    vi.stubGlobal('document', page.doc);
    const ask: CenterAsk = {
      type: 'hfos-write-center-name',
      name: 'Casey Lee',
      profile: IG_PROFILE,
    };
    const answer = await quickly(KITS.instagram.work!(ask)!);
    expect(answer).toMatchObject({ ok: true, result: 'done' });
    expect(page.saved()).toBe('Casey Lee');
  });
});
