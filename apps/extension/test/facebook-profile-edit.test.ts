/**
 * Put these in on Facebook (docs/outreach.md, decision 89): the bio by the About tab's editor, each new link on Contact
 * and basic info, and the username and the name on Accounts Center's username and name pages, each put in by itself on
 * made-up pages whose buttons behave as Facebook's usually do (test/fixtures/*-2026-10.html, test/center-pages.ts,
 * nobody real), and each step it can't find handed to the person. It never types a password or a code, and presses
 * Review change and Done only once Facebook allows it. The name's own page is tested in ./accounts-center.test.ts.
 */
import type { AskTask } from '@hfos/core/addons/outreach/asks';
import { JSDOM } from 'jsdom';
import type * as Parts from '@hfos/core/addons/outreach/profile-parts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runAsk } from '../src/asks/run';
import { linksPage, linkShown, sameLink, writeLink } from '../src/networks/facebook/links';
import { outlinePage } from '../src/networks/facebook/outline';
import { ownEditorsOf, readOwnProfile, writeBioSteps } from '../src/networks/facebook/own-profile';
import { readPage } from '../src/networks/facebook/page';
import { classifyUrl } from '../src/networks/facebook/urls';
import {
  ACCOUNTS_PROFILES,
  facebookProfileOn,
  profilesPage,
  usernameAddress,
  usernamePage,
  writeUsername,
} from '../src/networks/accounts-center/username';
import { centerWork, type CenterAsk } from '../src/networks/accounts-center/work';
import { readWarnings } from '../src/networks/facebook/warnings';
import type { Hfos, Job, JobTab } from '../src/jobs/job';
import type { ReportNote } from '../src/jobs/report';
import {
  dialogIn,
  facebookNamePage,
  FB_CENTER,
  FB_NAME_PAGE,
  type FacebookNamePlan,
} from './center-pages';
import { boxEverything, load } from './load';

/**
 * The newest build's way, or an older build's own copy of core when a test names one (decisions 84 and 89): what that
 * build didn't yet put in by itself it hands over, as core says for its computer (`partHowFor`).
 */
const how = vi.hoisted(() => ({ build: null as string | null }));
vi.mock('@hfos/core/addons/outreach/profile-parts', async (original) => {
  const real = await original<typeof Parts>();
  return {
    ...real,
    partHowOn: (...args: Parameters<typeof real.partHowOn>) =>
      how.build ? real.partHowFor(...args, how.build) : real.partHowOn(...args),
  };
});

const FB = 'https://www.facebook.com';
const OWN = `${FB}/casey.owner.7`;
const EDITOR = `${FB}/profile.php?fb_profile_edit_entry_point=7&id=100001234&sk=about`;
const CONTACT = `${FB}/casey.owner.7/about_contact?fb_profile_edit_entry_point=9`;
const USERNAME_PAGE = 'https://accountscenter.facebook.com/profiles/100001234/username/';
const SITE = 'https://summitroofleads.com/';
const CAL = 'https://cal.com/casey-owner';

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  how.build = null;
});

/** Runs a step with Facebook's waits skipped. */
async function quickly<T>(going: Promise<T>): Promise<T> {
  let settled = false;
  void going.finally(() => (settled = true)).catch(() => undefined);
  for (let i = 0; i < 600 && !settled; i++) await vi.advanceTimersByTimeAsync(500);
  return going;
}

const clean = (text: string | null | undefined) => (text ?? '').replace(/\s+/g, ' ').trim();

describe('the pages each part is changed on', () => {
  it('knows Accounts Center’s username page, and goes nowhere else to type', () => {
    expect(usernameAddress('100001234')).toBe(USERNAME_PAGE);
    expect(usernameAddress('casey.owner.7')).toBeNull();
    expect(usernameAddress(null)).toBeNull();
    expect(usernamePage(USERNAME_PAGE)).toBe(true);
    expect(usernamePage(`${USERNAME_PAGE}?entrypoint=fb_account_center`)).toBe(true);
    expect(usernamePage('https://accountscenter.facebook.com/profiles/100001234/name/')).toBe(
      false,
    );
    expect(usernamePage('https://accountscenter.facebook.com/password_and_security')).toBe(false);
    expect(usernamePage('http://accountscenter.facebook.com/profiles/100001234/username/')).toBe(
      false,
    );
    expect(
      usernamePage('https://accountscenter.facebook.com.evil.example/profiles/1/username/'),
    ).toBe(false);
    expect(usernamePage('https://accountscenter.facebook.com/profiles/casey/username/')).toBe(
      false,
    );
    expect(profilesPage(ACCOUNTS_PROFILES)).toBe(true);
    expect(profilesPage(`${ACCOUNTS_PROFILES}/100001234/`)).toBe(true);
    expect(profilesPage(USERNAME_PAGE)).toBe(false);
  });

  it('knows where your links are changed: your profile’s About tab', () => {
    expect(linksPage(CONTACT)).toBe(true);
    expect(linksPage(`${FB}/profile.php?id=100001234&sk=about_contact`)).toBe(true);
    expect(linksPage(OWN)).toBe(false);
    expect(linksPage(`${FB}/casey.owner.7/photos`)).toBe(false);
    expect(linksPage(`${FB}/groups/texascontractors/about`)).toBe(false);
  });

  it('takes a link the same however Facebook wrote it', () => {
    expect(
      sameLink('https://l.facebook.com/l.php?u=https%3A%2F%2Fsummitroofleads.com%2F&h=AT0', SITE),
    ).toBe(true);
    expect(sameLink('summitroofleads.com', SITE)).toBe(true);
    expect(sameLink('http://www.SummitRoofLeads.com?fbclid=IwAR0', SITE)).toBe(true);
    expect(sameLink('https://summitroofleads.com/book', SITE)).toBe(false);
    expect(sameLink(`${FB}/casey.owner.7`, `${FB}/casey.owner.7`)).toBe(false);
    expect(sameLink('Websites and social links', SITE)).toBe(false);
  });

  it('picks the Facebook profile among Accounts Center’s, never Instagram’s or the logo', () => {
    const doc = load('accounts-center-profiles-2026-10.html', ACCOUNTS_PROFILES);
    expect(facebookProfileOn(doc)).toBe(USERNAME_PAGE);
    expect(
      facebookProfileOn(
        boxEverything(load('accounts-center-profiles-2026-10.html', ACCOUNTS_PROFILES)),
      ),
    ).toBe(USERNAME_PAGE);
  });
});

/** Contact and basic info as Facebook behaves: Add a website opens a box with Save and Cancel; Save lists the link. */
function contactPage(more: { boxed?: boolean; saves?: boolean } = {}) {
  const doc = load('own-profile-contact-2026-10.html', CONTACT);
  if (more.boxed) boxEverything(doc);
  const list = doc.getElementById('link-list')!;
  let saves = 0;
  doc.getElementById('add-website')!.addEventListener('click', () => {
    const form = doc.createElement('div');
    form.innerHTML =
      '<label for="site">Website</label><input id="site" type="text" />' +
      '<div role="button">Save</div><div role="button">Cancel</div>';
    const [save, cancel] = [...form.querySelectorAll('[role="button"]')];
    save!.addEventListener('click', () => {
      saves++;
      if (more.saves === false) return;
      const value = (form.querySelector('input') as HTMLInputElement).value;
      const row = doc.createElement('div');
      row.setAttribute('role', 'listitem');
      const link = doc.createElement('a');
      link.setAttribute('role', 'link');
      link.setAttribute('href', `https://l.facebook.com/l.php?u=${encodeURIComponent(value)}`);
      const words = doc.createElement('span');
      words.textContent = value.replace(/^https:\/\//, '');
      link.append(words);
      row.append(link);
      list.append(row);
      form.remove();
    });
    cancel!.addEventListener('click', () => form.remove());
    doc.getElementById('links')!.append(form);
  });
  return { doc, saves: () => saves };
}

describe('adding a link', () => {
  it('presses Add a website, writes the link in its box, saves, and sees it listed', async () => {
    for (const boxed of [false, true]) {
      const { doc } = contactPage({ boxed });
      const { result, steps } = await quickly(writeLink(doc, CAL));
      expect(result).toBe('done');
      expect(steps).toMatchObject({ control: true, boxes: 1, typed: true, saves: 1, saved: true });
      expect(linkShown(doc, CAL)).toBe(true);
    }
  });

  it('leaves a link that’s there already, however Facebook wrote it', async () => {
    const { doc, saves } = contactPage();
    expect((await writeLink(doc, 'https://www.summitroofleads.com')).result).toBe('already');
    expect(doc.querySelector('input#site')).toBeNull();
    expect(saves()).toBe(0);
  });

  it('never presses Add a social link: with only that, the person adds it', async () => {
    const { doc, saves } = contactPage();
    doc.getElementById('add-website')!.remove();
    let social = 0;
    doc.getElementById('add-social')!.addEventListener('click', () => social++);
    const { result, steps } = await writeLink(doc, CAL);
    expect(result).toBe('none');
    expect(steps.control).toBe(false);
    expect(steps.names).toContain('Add a social link');
    expect([social, saves()]).toEqual([0, 0]);
  });

  it('says so when Save didn’t list it', async () => {
    const { doc } = contactPage({ saves: false });
    expect((await quickly(writeLink(doc, CAL))).result).toBe('not_saved');
  });
});

/**
 * Accounts Center's username page as Facebook behaves: typing turns Done off, then says whether the username is
 * available (Done on) or taken; Done saves it, or first asks for the password or to be sure.
 */
function usernamePageDoc(
  more: {
    boxed?: boolean;
    taken?: boolean;
    silent?: boolean;
    limit?: boolean;
    password?: 'before' | 'after';
    confirm?: boolean;
    /** Facebook's box to be sure says this, and its button this; the page under it hidden from screen readers. */
    sure?: { readonly says?: string; readonly button: string; readonly hidesPage?: boolean };
    /** Facebook asks for a code after Done, in a box for a phone's keypad. */
    code?: boolean;
    /** Facebook asks how to confirm it's them first: ways to pick and Continue, no box yet. */
    confirmFirst?: boolean;
    /** Facebook's block over the page. */
    blocked?: boolean;
  } = {},
) {
  const doc = load('accounts-center-username-2026-10.html', USERNAME_PAGE);
  if (more.boxed) boxEverything(doc);
  const box = doc.getElementById('u1') as HTMLInputElement;
  const done = doc.getElementById('done')!;
  const said = doc.getElementById('said')!;
  const where = doc.getElementById('where')!;
  let pressed = 0;
  let saved: string | null = null;
  const password = () =>
    dialogIn(
      doc,
      '<h2>Re-enter your password</h2><input type="password" aria-label="Password" /><div role="button">Continue</div>',
    );
  const save = () => {
    saved = box.value;
    said.textContent = 'Username updated';
    done.setAttribute('aria-disabled', 'true');
  };
  if (more.limit) said.textContent = 'You can’t change your username right now. Try again later.';
  if (more.password === 'before') password();
  if (more.confirmFirst)
    dialogIn(
      doc,
      '<h2>Confirm it’s you</h2><label><input type="radio" name="how" /> Enter your password</label>' +
        '<label><input type="radio" name="how" /> Get a code by email</label><div role="button">Continue</div>',
    );
  if (more.blocked)
    dialogIn(
      doc,
      '<h2>You’re temporarily blocked</h2><span>It looks like you were going too fast. Try again later.</span><div role="button">OK</div>',
    );
  box.addEventListener('input', () => {
    done.setAttribute('aria-disabled', 'true');
    said.textContent = '';
    setTimeout(() => {
      if (more.silent) return;
      if (more.taken) {
        said.textContent = 'This username isn’t available. Try another.';
        box.setAttribute('aria-invalid', 'true');
        return;
      }
      said.textContent = `${box.value} is available`;
      where.textContent = `www.facebook.com/${box.value}`;
      done.removeAttribute('aria-disabled');
    }, 300);
  });
  done.addEventListener('click', () => {
    pressed++;
    if (done.getAttribute('aria-disabled') === 'true') return;
    if (more.password === 'after') return void password();
    if (more.code)
      return void dialogIn(
        doc,
        '<h2>Enter the code we sent</h2><input type="tel" /><div role="button">Confirm</div>',
      );
    if (more.sure) {
      const { says = 'Change username?', button, hidesPage } = more.sure;
      const main = doc.querySelector('[role="main"]')!;
      if (hidesPage) main.setAttribute('aria-hidden', 'true');
      const sure = dialogIn(
        doc,
        `<h2>${says}</h2><div role="button">Cancel</div><div role="button">${button}</div>`,
      );
      sure.querySelectorAll('[role="button"]')[1]!.addEventListener('click', () => {
        sure.remove();
        main.removeAttribute('aria-hidden');
        save();
      });
      return;
    }
    if (more.confirm) {
      const sure = dialogIn(
        doc,
        '<h2>Change username?</h2><div role="button">Cancel</div><div role="button">Change username</div>',
      );
      sure.querySelectorAll('[role="button"]')[1]!.addEventListener('click', () => {
        sure.remove();
        save();
      });
      return;
    }
    save();
  });
  return {
    doc,
    box,
    pressed: () => pressed,
    saved: () => saved,
    passwordBox: () => doc.querySelector<HTMLInputElement>('input[type="password"]'),
    /** The person typed their password and pressed Continue: Facebook saves the username. */
    continued: () => {
      doc.querySelector('input[type="password"]')?.closest('[role="dialog"]')?.remove();
      save();
    },
  };
}

describe('putting your username in', () => {
  it('types it in Username, waits for Facebook to say it’s available, presses Done once, and sees it saved', async () => {
    for (const boxed of [false, true]) {
      const page = usernamePageDoc({ boxed });
      const wrote = await quickly(writeUsername(page.doc, 'casey.roofs'));
      expect(wrote.result).toBe('done');
      expect(wrote.steps).toMatchObject({
        boxes: 1,
        dones: 1,
        typed: true,
        answer: 'free',
        pressed: true,
        saved: true,
      });
      expect(page.pressed()).toBe(1);
      expect(page.saved()).toBe('casey.roofs');
    }
  });

  it('presses Facebook’s Change username when it asks to be sure', async () => {
    const page = usernamePageDoc({ confirm: true });
    const wrote = await quickly(writeUsername(page.doc, 'casey.roofs'));
    expect(wrote.result).toBe('done');
    expect(wrote.steps.confirmed).toBe(true);
    expect(page.saved()).toBe('casey.roofs');
  });

  it('never presses Done on a username Facebook says is taken, and keeps its words', async () => {
    const page = usernamePageDoc({ taken: true });
    const wrote = await quickly(writeUsername(page.doc, 'casey.roofs'));
    expect(wrote).toMatchObject({
      result: 'taken',
      said: 'This username isn’t available. Try another.',
    });
    expect(page.pressed()).toBe(0);
  });

  it('types nothing when Facebook says it can’t change now', async () => {
    const page = usernamePageDoc({ limit: true });
    const wrote = await quickly(writeUsername(page.doc, 'casey.roofs'));
    expect(wrote.result).toBe('limit');
    expect(wrote.said).toContain('can’t change your username');
    expect(page.box.value).toBe('casey.owner.7');
  });

  it('never presses Done that stays off with no word from Facebook', async () => {
    const page = usernamePageDoc({ silent: true });
    const wrote = await quickly(writeUsername(page.doc, 'casey.roofs'));
    expect(wrote.result).toBe('none');
    expect(wrote.steps).toMatchObject({
      typed: true,
      answer: 'none',
      doneOn: false,
      pressed: false,
    });
    expect(page.pressed()).toBe(0);
  });

  it('waits for the person while Facebook asks for the password, before it types or after Done, and never types it', async () => {
    const before = usernamePageDoc({ password: 'before' });
    const first = await quickly(writeUsername(before.doc, 'casey.roofs'));
    expect(first.result).toBe('waiting');
    expect(first.steps).toMatchObject({ asking: 'password', typed: false, pressed: false });
    expect(before.box.value).toBe('casey.owner.7');
    expect(before.passwordBox()!.value).toBe('');

    const after = usernamePageDoc({ password: 'after' });
    const second = await quickly(writeUsername(after.doc, 'casey.roofs'));
    expect(second.result).toBe('waiting');
    expect(second.steps).toMatchObject({ asking: 'password', pressed: true });
    expect(after.passwordBox()!.value).toBe('');
    expect(after.pressed()).toBe(1);
  });

  it('says it’s there already, and types nothing', async () => {
    const page = usernamePageDoc();
    page.box.value = 'casey.roofs';
    expect((await quickly(writeUsername(page.doc, 'Casey.Roofs'))).result).toBe('already');
    expect(page.pressed()).toBe(0);
  });

  it('types in no box when there are two named Username, or none', async () => {
    const page = usernamePageDoc();
    const other = page.doc.createElement('input');
    other.setAttribute('aria-label', 'Username');
    page.doc.getElementById('username-form')!.append(other);
    const two = await quickly(writeUsername(page.doc, 'casey.roofs'));
    expect(two.result).toBe('none');
    expect(two.steps.boxes).toBe(2);
    expect([page.box.value, other.value]).toEqual(['casey.owner.7', '']);

    const none = usernamePageDoc();
    none.doc.querySelector('label[for="u1"]')!.textContent = 'Name';
    const missing = await quickly(writeUsername(none.doc, 'casey.roofs'));
    expect(missing.result).toBe('none');
    expect(missing.steps.boxes).toBe(0);
    expect(missing.steps.names).toEqual(expect.arrayContaining(['Done']));
  });

  it('stops on a Facebook warning with no password box, nothing typed', async () => {
    const page = usernamePageDoc();
    dialogIn(page.doc, '<h2>You’re Temporarily Blocked</h2><div role="button">OK</div>');
    const wrote = await quickly(writeUsername(page.doc, 'casey.roofs'));
    expect(wrote.result).toBe('warned');
    expect(wrote.warnings).toEqual(['You’re Temporarily Blocked']);
    expect(page.box.value).toBe('casey.owner.7');
  });

  it('takes Facebook’s block saying “Try again later” for a warning, never a username it won’t change', async () => {
    const page = usernamePageDoc({ blocked: true });
    const wrote = await quickly(writeUsername(page.doc, 'casey.roofs'));
    expect(wrote.result).toBe('warned');
    expect(wrote.warnings).toContain('You’re temporarily blocked');
    expect([page.box.value, page.pressed()]).toEqual(['casey.owner.7', 0]);
  });

  it('presses Facebook’s Change username even when its box says how long till the next change', async () => {
    const page = usernamePageDoc({
      sure: {
        says: 'You can’t change your username again for 14 days',
        button: 'Change username',
      },
    });
    const wrote = await quickly(writeUsername(page.doc, 'casey.roofs'));
    expect(wrote.result).toBe('done');
    expect(wrote.steps.confirmed).toBe(true);
    expect(page.saved()).toBe('casey.roofs');
  });

  it('never ticks or unticks Instagram’s username: with its offer on, nothing’s typed or pressed', async () => {
    const page = usernamePageDoc();
    page.doc
      .getElementById('username-form')!
      .insertAdjacentHTML(
        'beforeend',
        '<label><input type="checkbox" checked /> Also change your username on Instagram</label>',
      );
    const wrote = await quickly(writeUsername(page.doc, 'casey.roofs'));
    expect(wrote).toMatchObject({ result: 'none', steps: { sync: true, typed: false } });
    expect([page.box.value, page.pressed()]).toEqual(['casey.owner.7', 0]);
  });

  it('never presses Change username in a box that offers to change Instagram’s too', async () => {
    const page = usernamePageDoc({
      sure: { says: 'Change your username on Instagram too?', button: 'Change username' },
    });
    const wrote = await quickly(writeUsername(page.doc, 'casey.roofs'));
    expect(wrote.result).toBe('not_saved');
    expect(wrote.steps).toMatchObject({ pressed: true, confirmed: false, sync: true, over: false });
    expect(page.saved()).toBeNull();
  });

  it('never takes a box after Done it doesn’t know for saved, the page under it hidden or not', async () => {
    for (const hidesPage of [false, true]) {
      const page = usernamePageDoc({ sure: { button: 'Yes, change it', hidesPage } });
      const wrote = await quickly(writeUsername(page.doc, 'casey.roofs'));
      expect(wrote.result).toBe('not_saved');
      expect(wrote.steps).toMatchObject({
        pressed: true,
        confirmed: false,
        over: true,
        saved: false,
      });
      // Its buttons as the outline shows them: Facebook's own words, others counted.
      expect(wrote.steps.names).toEqual(['Cancel', '[3 words]']);
      expect(page.saved()).toBeNull();
    }
  });

  it('waits for the person when Facebook asks for a code after Done, in a box for a phone’s keypad, pressing nothing', async () => {
    const page = usernamePageDoc({ code: true });
    let pressed = 0;
    page.doc.addEventListener(
      'click',
      (e) => {
        if ((e.target as Element).textContent === 'Confirm') pressed++;
      },
      true,
    );
    const wrote = await quickly(writeUsername(page.doc, 'casey.roofs'));
    expect(wrote.result).toBe('waiting');
    expect(wrote.steps).toMatchObject({ asking: 'code', pressed: true, confirmed: false });
    expect(pressed).toBe(0);
    expect(page.doc.querySelector<HTMLInputElement>('input[type="tel"]')!.value).toBe('');
  });

  it('waits for the person when Facebook asks how to confirm it’s them, before any box, never a warning', async () => {
    const page = usernamePageDoc({ confirmFirst: true });
    const wrote = await quickly(writeUsername(page.doc, 'casey.roofs'));
    expect(wrote.result).toBe('waiting');
    expect(wrote.steps).toMatchObject({ asking: 'confirm', typed: false, pressed: false });
    expect(page.box.value).toBe('casey.owner.7');
  });

  it('never reads Facebook’s “Confirm it’s you” over a password box as a warning', async () => {
    const page = usernamePageDoc();
    dialogIn(
      page.doc,
      '<h2>Confirm it’s you</h2><input type="password" /><div role="button">Continue</div>',
    );
    expect((await quickly(writeUsername(page.doc, 'casey.roofs'))).result).toBe('waiting');
  });
});

// ------------------------------------------------------------------------------------------------ the whole job

interface Plan {
  /** The profile /me opens: October 2026's, or the older one with no Edit profile link. */
  readonly own?: 'own-profile-2026-10.html' | 'own-profile.html';
  readonly taken?: boolean;
  /** Facebook says nothing of the username typed, and keeps Done off. */
  readonly silent?: boolean;
  readonly password?: 'before' | 'after';
  /** A box after Done it doesn't know. */
  readonly sure?: { readonly button: string };
  /** Facebook's block over the username page. */
  readonly blocked?: boolean;
  /** Accounts Center's Profiles asks for the password first, till the person types it. */
  readonly profilesPassword?: boolean;
  /** /me keeps showing the bio and links it had, whatever was saved. */
  readonly stale?: boolean;
  /** A Facebook warning on the About tab's editor. */
  readonly warnedOnEditor?: boolean;
  /** No Edit by Bio on the editor. */
  readonly noBioEdit?: boolean;
  /** How Facebook behaves on the name's page. */
  readonly name?: FacebookNamePlan;
  /** Facebook opens another profile's name page in its place. */
  readonly nameElsewhere?: boolean;
}

/**
 * The name and username Facebook shows on the made-up profile, put in place of the ones it had: its links to itself go
 * by its username, as Facebook's do.
 */
function showOwn(doc: Document, name: string, username: string): void {
  for (const link of doc.querySelectorAll('a[href]')) {
    const href = link.getAttribute('href')!;
    if (/^(https:\/\/www\.facebook\.com)?\/casey\.owner\.7(\/|\?|$)/.test(href))
      link.setAttribute('href', href.replace('casey.owner.7', username));
  }
  if (name === 'Casey Owner') return;
  const walker = doc.createTreeWalker(doc.body, 4 /* NodeFilter.SHOW_TEXT */);
  for (let node = walker.nextNode(); node; node = walker.nextNode())
    if (node.nodeValue?.includes('Casey Owner'))
      node.nodeValue = node.nodeValue.replaceAll('Casey Owner', name);
  for (const labelled of doc.querySelectorAll('[aria-label*="Casey Owner"]'))
    labelled.setAttribute(
      'aria-label',
      labelled.getAttribute('aria-label')!.replaceAll('Casey Owner', name),
    );
  doc.title = doc.title.replaceAll('Casey Owner', name);
}

/** A Facebook tab over the made-up pages, each behaving as Facebook does, answering asks as the tab would. */
function fakeTab(plan: Plan = {}) {
  let doc: Document | null = null;
  let at = '';
  let username = 'casey.owner.7';
  let name = 'Casey Owner';
  let bio = 'Dad, golfer, coffee. I help Columbus roofers book more inspections.';
  const added: string[] = [];
  const opened: string[] = [];
  const asked: string[] = [];
  let usernamePage_: ReturnType<typeof usernamePageDoc> | null = null;
  let namePage: ReturnType<typeof facebookNamePage> | null = null;
  /** What Facebook saved since the last page was drawn. */
  const savedSince = () => {
    username = usernamePage_?.saved() ?? username;
    name = namePage?.saved() ?? name;
  };

  let profilesAsked = plan.profilesPassword ?? false;
  const show = (url: string) => {
    savedSince();
    if (url === `${FB}/me`) {
      at = `${FB}/${username}`;
      doc = load(plan.own ?? 'own-profile-2026-10.html', at);
      showOwn(doc, name, username);
      const line = [...doc.querySelectorAll('span[dir="auto"]')].find((s) =>
        clean(s.textContent).startsWith('Dad, golfer'),
      );
      if (line && !plan.stale) line.textContent = bio;
      for (const link of plan.stale ? [] : added) {
        const list = doc.querySelectorAll('[role="list"]')[2];
        list?.insertAdjacentHTML(
          'beforeend',
          `<div role="listitem"><a href="https://l.facebook.com/l.php?u=${encodeURIComponent(link)}">${link}</a></div>`,
        );
      }
    } else if (url === EDITOR) {
      at = url;
      doc = load('own-profile-about-editor-2026-10.html', at);
      const page = doc;
      const shownBio = page.getElementById('bio-shown')!;
      if (plan.noBioEdit) page.getElementById('bio-edit')!.remove();
      else
        page.getElementById('bio-edit')!.addEventListener('click', () => {
          const box = page.createElement('textarea');
          box.value = bio;
          const save = page.createElement('div');
          save.setAttribute('role', 'button');
          save.textContent = 'Save';
          save.addEventListener('click', () => {
            bio = box.value;
            shownBio.textContent = bio;
            box.remove();
            save.remove();
          });
          page.getElementById('bio-row')!.append(box, save);
        });
      if (plan.warnedOnEditor)
        dialogIn(page, '<h2>You’re Temporarily Blocked</h2><div role="button">OK</div>');
    } else if (url === CONTACT) {
      at = url;
      const page = contactPage();
      doc = page.doc;
      const list = doc.getElementById('link-list')!;
      new doc.defaultView!.MutationObserver(() => {
        for (const a of list.querySelectorAll('a[href]')) {
          const inner = new URL(a.getAttribute('href')!).searchParams.get('u');
          if (inner && !inner.includes('summitroofleads') && !added.includes(inner))
            added.push(inner);
        }
      }).observe(list, { childList: true, subtree: true });
    } else if (url === USERNAME_PAGE) {
      at = url;
      usernamePage_ = usernamePageDoc({
        taken: plan.taken,
        silent: plan.silent,
        password: plan.password,
        sure: plan.sure,
        blocked: plan.blocked,
      });
      doc = usernamePage_.doc;
    } else if (url === FB_NAME_PAGE) {
      // Facebook may open another profile's name page in its place: the tab types nothing there.
      at = plan.nameElsewhere ? `${FB_CENTER}/profiles/100009999/name/` : url;
      namePage = facebookNamePage(plan.name, at);
      doc = namePage.doc;
    } else if (url === ACCOUNTS_PROFILES) {
      at = url;
      doc = load('accounts-center-profiles-2026-10.html', at);
      if (profilesAsked)
        dialogIn(
          doc,
          '<h2>Re-enter your password</h2><input type="password" aria-label="Password" /><div role="button">Continue</div>',
        );
    } else throw new Error(`Not expected: ${url}`);
  };

  const tab = {
    async open(url: string) {
      opened.push(url);
      show(url);
      return 1;
    },
    async focus() {},
    async ask(message: Record<string, unknown> & { readonly type: string }) {
      asked.push(message.type);
      const page = doc!;
      savedSince();
      switch (message.type) {
        case 'hfos-read':
          return { ok: true, result: readPage(page, at) };
        case 'hfos-outline':
          return {
            ok: true,
            result: readPage(page, at),
            outline: outlinePage(page, at),
            shown: true,
          };
        case 'hfos-own-profile':
          return { ok: true, read: readOwnProfile(page, at, classifyUrl(at)) };
        case 'hfos-own-editors':
          return classifyUrl(at).kind === 'profile'
            ? { ok: true, editors: ownEditorsOf(page, at) }
            : { ok: false, error: 'Facebook didn’t open your profile.' };
        case 'hfos-write-bio': {
          const { result, steps } = await writeBioSteps(page, message.bio as string);
          return { ok: true, result, bioSteps: steps };
        }
        case 'hfos-write-link':
          return linksPage(at)
            ? { ok: true, ...(await writeLink(page, message.link as string)) }
            : { ok: false, error: 'Facebook didn’t open where your links are changed.' };
        case 'hfos-write-username':
        case 'hfos-write-center-name':
        case 'hfos-username-page':
        case 'hfos-account-warnings': {
          // As the tab answers them, on the page at its address.
          vi.stubGlobal('location', new URL(at));
          vi.stubGlobal('document', page);
          try {
            return await centerWork('facebook', message as unknown as CenterAsk, readWarnings);
          } finally {
            vi.unstubAllGlobals();
            savedSince();
          }
        }
        default:
          return { ok: false, error: `Not expected: ${message.type}` };
      }
    },
  } as unknown as JobTab;
  return {
    tab,
    opened,
    asked,
    now: () => ({ username, name, bio, added: [...added] }),
    passwordPage: () => usernamePage_,
    namePage: () => namePage,
    /** Facebook sends the tab to one of its checkpoints. */
    checkpoint: () => {
      at = `${FB}/checkpoint/`;
      doc = new JSDOM('<!doctype html><html><body><div role="main"></div></body></html>', {
        url: at,
      }).window.document;
    },
    /** The person typed their password on Profiles: it shows its profiles now. */
    profilesAnswered: () => {
      profilesAsked = false;
      doc?.querySelector('input[type="password"]')?.closest('[role="dialog"]')?.remove();
    },
  };
}

const TASK: Extract<AskTask, { kind: 'profile_edit' }> = {
  kind: 'profile_edit',
  bio: 'I help Columbus roofers fill their calendars.',
  about: null,
  name: 'Casey Lee',
  username: 'casey.roofs',
  links: [CAL],
  work: null,
  featured: null,
  ideal: null,
  services: [],
  linkChanges: [],
};

async function putIn(
  task: Partial<typeof TASK>,
  plan: Plan = {},
  answer: (says: string, tab: ReturnType<typeof fakeTab>) => 'carry_on' | 'stop' = () => 'carry_on',
) {
  const faked = fakeTab(plan);
  const said: { says: string; note?: ReportNote }[] = [];
  const warned: string[][] = [];
  const checked: unknown[] = [];
  const job: Job = {
    tab: faked.tab,
    hfos: (async (ask: { readonly type: string; readonly input?: unknown }) => {
      if (ask.type === 'hfos-profile-check') checked.push(ask.input);
      return { ok: true, value: {} };
    }) as unknown as Hfos,
    businessId: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d',
    stopped: () => false,
    progress: () => undefined,
    warn: async (words) => void warned.push([...words]),
    handOver: async (says, note) => {
      said.push({ says, ...(note ? { note } : {}) });
      return answer(says, faked);
    },
    report: async () => undefined,
  };
  const end = await quickly(runAsk({ ...TASK, ...task }, job, 'facebook'));
  return { end, said, warned, checked, ...faked };
}

describe('Put these in, on Facebook', () => {
  it('puts the bio, the link, the username and the name in itself, handing nothing over', async () => {
    const { end, said, opened, now, checked } = await putIn({});
    expect(opened).toEqual([`${FB}/me`, EDITOR, CONTACT, USERNAME_PAGE, FB_NAME_PAGE, `${FB}/me`]);
    expect(said).toEqual([]);
    expect(now()).toEqual({
      username: 'casey.roofs',
      name: 'Casey Lee',
      bio: TASK.bio,
      added: [CAL],
    });
    expect(checked).toEqual([expect.objectContaining({ name: 'Casey Lee' })]);
    expect(end).toEqual({ line: 'Your bio, name, username and links are in.', warned: false });
  });

  it('ends saying so when Facebook says the username is taken, the rest in', async () => {
    const { end, now, passwordPage } = await putIn({ name: null }, { taken: true });
    expect(passwordPage()!.pressed()).toBe(0);
    expect(now().username).toBe('casey.owner.7');
    expect(end).toEqual({
      line: 'Your bio and links are in. Facebook says “This username isn’t available. Try another.”, so your username stays as it was. Pick another under Username: in Social Outreach, go to Settings → Facebook and press Check your profile. Then press Put these in again.',
      warned: false,
      failed: true,
    });
  });

  it('waits for the person to type the password Facebook asks for, never typing it', async () => {
    const { end, said, now } = await putIn(
      { bio: null, name: null, links: [] },
      { password: 'after' },
      (says, tab) => {
        // The extension typed nothing in it: the person types it and presses Continue, and Facebook saves.
        const page = tab.passwordPage()!;
        expect(page.passwordBox()!.value).toBe('');
        page.continued();
        return says.includes('password') ? 'carry_on' : 'stop';
      },
    );
    expect(said.map((s) => s.says)).toEqual([
      'Facebook wants your password to change your username. Type it in the Facebook window and press Continue there, then press Carry on.',
    ]);
    expect(said[0]!.note).toMatchObject({
      job: 'profile_edit.username',
      found: { password: true, pressed: true },
    });
    expect(now().username).toBe('casey.roofs');
    expect(end).toEqual({ line: 'Your username is in.', warned: false });
  });

  it('never says the username is in when Facebook hasn’t shown it on the profile after', async () => {
    // The person pressed Carry on without typing the password: nothing saved.
    const { end } = await putIn(
      { bio: null, name: null, links: [] },
      { password: 'after' },
      () => 'carry_on',
    );
    expect(end).toEqual({
      line: 'Facebook hasn’t shown your new username on your profile yet. Check it in Accounts Center: press Profiles, then your Facebook profile, then Username, and put “casey.roofs” in if it isn’t there.',
      warned: false,
      failed: true,
    });
  });

  it('says only what shows on the profile after is in, and where to check the rest', async () => {
    const { end } = await putIn({ name: null }, { stale: true });
    expect(end).toEqual({
      line: `Your username is in. Facebook hasn’t shown your new bio on your profile yet. Check it there, and if it isn’t, press Edit bio (or Edit profile, then Bio), write “${TASK.bio}”, and press Save. Facebook hasn’t shown your new link on your profile yet. Check your About tab under Contact and basic info, and if it isn’t there, press Add a website, paste “${CAL}”, and press Save.`,
      warned: false,
    });
  });

  it('stops for the day on a Facebook block over the username page', async () => {
    const { end, warned, passwordPage } = await putIn(
      { bio: null, name: null, links: [] },
      { blocked: true },
    );
    expect(warned).toEqual([
      ['You’re temporarily blocked', 'It looks like you were going too fast. Try again later.'],
    ]);
    expect(end).toMatchObject({ warned: true });
    expect(passwordPage()!.pressed()).toBe(0);
  });

  it('hands over a box Facebook opened after Done that it doesn’t know, never saying the username is in', async () => {
    const { said, end } = await putIn(
      { bio: null, name: null, links: [] },
      { sure: { button: 'Yes, change it' } },
    );
    expect(said.map((s) => s.says)).toEqual([
      'Facebook opened a box after Done. In the Facebook window, press its button to change your username to “casey.roofs”, then press Carry on.',
    ]);
    expect(said[0]!.note).toMatchObject({
      job: 'profile_edit.username',
      found: { pressed: true, over: true, saved: false },
    });
    expect(end).toMatchObject({ failed: true });
    expect(end.line).not.toContain('Your username is in');
  });

  it('ends saying so when Facebook keeps asking for the password, never typing it', async () => {
    const { said, end, passwordPage } = await putIn(
      { bio: null, name: null, links: [] },
      { password: 'before' },
    );
    expect(said.map((s) => s.says)).toEqual(
      Array(3).fill(
        'Facebook wants your password to change your username. Type it in the Facebook window and press Continue there, then press Carry on.',
      ),
    );
    expect(passwordPage()!.passwordBox()!.value).toBe('');
    expect(end).toEqual({
      line: 'Facebook kept asking for your password, so your username stays as it was. Change it in Accounts Center (press Profiles, then your Facebook profile, then Username), or press Put these in again.',
      warned: false,
      failed: true,
    });
  });

  it('stops for the day when Facebook sends the tab to a checkpoint after the person carried on', async () => {
    const { said, warned, end } = await putIn(
      { bio: null, name: null, links: [] },
      { password: 'before' },
      (_says, tab) => {
        tab.checkpoint();
        return 'carry_on';
      },
    );
    expect(said).toHaveLength(1);
    expect(warned).toEqual([['Facebook is asking you to check your account before you go on.']]);
    expect(end).toMatchObject({ warned: true });
  });

  it('waits for the password on Accounts Center’s Profiles, then finds the Facebook profile there', async () => {
    const { said, opened, end } = await putIn(
      { bio: null, name: null, links: [] },
      { own: 'own-profile.html', profilesPassword: true },
      (_says, tab) => {
        tab.profilesAnswered();
        return 'carry_on';
      },
    );
    expect(said.map((s) => s.says)).toEqual([
      'Facebook wants your password to change your username. Type it in the Facebook window and press Continue there, then press Carry on.',
    ]);
    expect(said[0]!.note).toMatchObject({
      job: 'profile_edit.username',
      note: 'Facebook asked for the password on Accounts Center’s Profiles.',
    });
    expect(opened).toEqual([`${FB}/me`, ACCOUNTS_PROFILES, USERNAME_PAGE, `${FB}/me`]);
    expect(end).toEqual({ line: 'Your username is in.', warned: false });
  });

  it('hands the username over on its page when Facebook keeps Done off, its note saying which step', async () => {
    const { said, passwordPage } = await putIn(
      { bio: null, name: null, links: [] },
      { silent: true },
    );
    expect(said.map((s) => s.says)).toEqual([
      'Change your username: on this page, put “casey.roofs” in Username, and press Done once Facebook says it’s available. Then press Carry on.',
    ]);
    expect(said[0]!.note).toMatchObject({
      job: 'profile_edit.username',
      note: 'Not done: Facebook said nothing about whether it’s available, and Done stayed off.',
      outline: true,
    });
    expect(passwordPage()!.pressed()).toBe(0);
  });

  it('finds the Facebook profile among Accounts Center’s when the profile has no number', async () => {
    const { opened, end } = await putIn(
      { bio: null, name: null, links: [] },
      { own: 'own-profile.html' },
    );
    expect(opened).toEqual([`${FB}/me`, ACCOUNTS_PROFILES, USERNAME_PAGE, `${FB}/me`]);
    expect(end).toEqual({ line: 'Your username is in.', warned: false });
  });

  it('stops on a warning on the About tab’s editor, nothing written', async () => {
    const { end, warned, now, said, opened } = await putIn(
      { name: null },
      { warnedOnEditor: true },
    );
    expect(end).toMatchObject({ warned: true });
    expect(warned).toEqual([['You’re Temporarily Blocked']]);
    expect(said).toEqual([]);
    expect(opened).toEqual([`${FB}/me`, EDITOR]);
    expect(now()).toMatchObject({
      bio: expect.stringContaining('Dad, golfer'),
      username: 'casey.owner.7',
    });
  });

  it('hands the bio over on the editor, saying where to press, when its Edit isn’t there', async () => {
    const { said, opened } = await putIn(
      {
        name: null,
        username: null,
        links: [],
        work: null,
        featured: null,
        ideal: null,
        services: [],
        linkChanges: [],
      },
      { noBioEdit: true },
    );
    expect(opened.slice(0, 2)).toEqual([`${FB}/me`, EDITOR]);
    expect(said).toHaveLength(1);
    expect(said[0]!.says).toBe(
      `Put your new bio in: on this page, press Edit by Bio (or Add bio), write “${TASK.bio}”, and press Save. Then press Carry on.`,
    );
    expect(said[0]!.note).toMatchObject({
      job: 'profile_edit.bio',
      note: 'Not done: no Edit bio, Add bio or Edit by Bio on the page.',
      outline: true,
    });
  });

  it('puts the name in by itself on its own profile’s name page, and sees it on the profile after', async () => {
    const { end, said, opened, namePage } = await putIn({ bio: null, username: null, links: [] });
    expect(opened).toEqual([`${FB}/me`, FB_NAME_PAGE, `${FB}/me`]);
    expect(said).toEqual([]);
    expect(namePage()!.pressed()).toEqual({ review: 1, done: 1, sure: 0 });
    expect(end).toEqual({ line: 'Your name is in.', warned: false });
  });

  it('sees the name in, whichever order Facebook shows it on the profile', async () => {
    const { end, now } = await putIn(
      { bio: null, username: null, links: [] },
      { name: { lastFirst: true } },
    );
    expect(now().name).toBe('Lee Casey');
    expect(end).toEqual({ line: 'Your name is in.', warned: false });
  });

  it('finds the Facebook profile among Accounts Center’s once, for the username and the name both', async () => {
    const { opened, end } = await putIn(
      { bio: null, links: [] },
      { own: 'own-profile.html', name: { leaves: true } },
    );
    expect(opened).toEqual([
      `${FB}/me`,
      ACCOUNTS_PROFILES,
      USERNAME_PAGE,
      FB_NAME_PAGE,
      `${FB}/me`,
    ]);
    expect(end).toEqual({ line: 'Your name and username are in.', warned: false });
  });

  it('waits for the person to type the password Facebook asks for by Review change’s Done, never typing it', async () => {
    const { end, said, now } = await putIn(
      { bio: null, username: null, links: [] },
      { name: { password: 'review' } },
      (_says, tab) => {
        const page = tab.namePage()!;
        expect(page.passwordBox()!.value).toBe('');
        // The person types it and presses Done there: Facebook saves the name.
        page.continued();
        return 'carry_on';
      },
    );
    expect(said.map((s) => s.says)).toEqual([
      'Facebook wants your password to change your name. Type it in the Facebook window and press its button there (Continue or Done), then press Carry on.',
    ]);
    expect(said[0]!.note).toMatchObject({
      job: 'profile_edit.name',
      found: { password: true, reviewed: true, pressed: false },
      note: 'Facebook asked for the password before the name changed.',
    });
    expect(now().name).toBe('Casey Lee');
    expect(end).toEqual({ line: 'Your name is in.', warned: false });
  });

  it('sees the name in once the person saves it after the password, while Facebook then holds the next change', async () => {
    const { end, said, now } = await putIn(
      { bio: null, username: null, links: [] },
      { name: { password: 'review', holdsAfter: 'You can’t change your name right now.' } },
      (_says, tab) => {
        tab.namePage()!.continued();
        return 'carry_on';
      },
    );
    expect(said).toHaveLength(1);
    expect(now().name).toBe('Casey Lee');
    expect(end).toEqual({ line: 'Your name is in.', warned: false });
  });

  it('ends with Facebook’s words when it won’t change the name now, nothing typed', async () => {
    const { end, said, namePage } = await putIn(
      { bio: null, username: null, links: [] },
      { name: { saysFirst: 'You can’t change your name right now.' } },
    );
    expect(said).toEqual([]);
    expect(namePage()!.boxes.last.value).toBe('Owner');
    expect(end).toEqual({
      line: 'Facebook won’t change your name right now (it says “You can’t change your name right now.”). Keep the name you have, and press Put these in again once Facebook lets you (it lets you change your name once in 60 days).',
      warned: false,
      failed: true,
    });
  });

  it('ends with Facebook’s words when its name standards won’t take the name, Done never pressed', async () => {
    const { end, namePage } = await putIn(
      { bio: null, username: null, links: [] },
      { name: { refuses: { on: 'review', says: 'This name doesn’t follow our Name Standards.' } } },
    );
    expect(namePage()!.pressed().done).toBe(0);
    expect(end).toEqual({
      line: 'Facebook won’t take “Casey Lee” as your name (it says “This name doesn’t follow our Name Standards.”). Use your real first and last name, in letters only. Pick another under Name: in Social Outreach, go to Settings → Facebook and press Check your profile. Then press Put these in again.',
      warned: false,
      failed: true,
    });
  });

  it('refuses a name Facebook wouldn’t take before opening its page', async () => {
    const { end, opened } = await putIn({
      bio: null,
      username: null,
      links: [],
      name: 'Casey Owner | Roofs',
    });
    expect(opened).toEqual([`${FB}/me`, `${FB}/me`]);
    expect(end).toEqual({
      line: 'Facebook names use letters only, so take out “|” from “Casey Owner | Roofs”. Pick another under Name with Show me more on the web, then put it in.',
      warned: false,
      failed: true,
    });
  });

  it('says a name Facebook looks at first is under review, never that it’s in', async () => {
    const { end, now } = await putIn({ username: null, links: [] }, { name: { reviewing: true } });
    expect(now().name).toBe('Casey Owner');
    expect(end).toEqual({
      line: `Your bio now says “${TASK.bio}”. Facebook is looking at your new name, “Casey Lee”, before it shows on your profile. There’s nothing to do now: check your profile again in a day or two.`,
      warned: false,
    });
  });

  it('hands over a box Facebook opened after the name’s Done that it doesn’t know, never saying the name is in', async () => {
    const { said, end } = await putIn(
      { bio: null, username: null, links: [] },
      { name: { sure: { button: 'Yes, change it' } } },
    );
    expect(said.map((s) => s.says)).toEqual([
      'Facebook opened a box after Done. In the Facebook window, press its button to change your name to “Casey Lee”, then press Carry on.',
    ]);
    expect(said[0]!.note).toMatchObject({
      job: 'profile_edit.name',
      found: { pressed: true, over: true, saved: false },
    });
    expect(end).toEqual({
      line: 'Facebook hasn’t shown your new name on your profile yet, and it may look at a new name first. Check it in Accounts Center: press Profiles, then your Facebook profile, then Name, and put “Casey Lee” in if it isn’t there.',
      warned: false,
      failed: true,
    });
  });

  it('hands the name over, typing nothing, when Facebook opens another profile’s name page', async () => {
    const { said, end, namePage } = await putIn(
      { bio: null, username: null, links: [] },
      { nameElsewhere: true },
    );
    expect(said.map((s) => s.says)).toEqual([
      'In Accounts Center, press Profiles, then your Facebook profile, then Name. Put “Casey” in First name and “Lee” in Last name, leave Middle name empty, then press Review change, then Done (or Save changes). Facebook lets you change your name once in 60 days, and may look at a new one before it shows. Then press Carry on.',
    ]);
    expect(said[0]!.note).toMatchObject({
      job: 'profile_edit.name',
      note: 'Accounts Center’s name page didn’t open, so the name was handed to the person.',
    });
    expect(namePage()!.boxes.last.value).toBe('Owner');
    expect(end).toMatchObject({ failed: true });
  });

  it('stops for the day on a Facebook block over the name page, nothing typed', async () => {
    const { end, warned, namePage } = await putIn(
      { bio: null, username: null, links: [] },
      { name: { blocked: true } },
    );
    expect(warned).toEqual([
      ['You’re temporarily blocked', 'It looks like you were going too fast. Try again later.'],
    ]);
    expect(end).toMatchObject({ warned: true });
    expect(namePage()!.boxes.last.value).toBe('Owner');
  });

  it('hands the username and links over as before where core says they’re the person’s (builds before 0.93.0)', async () => {
    how.build = '0.92.0';
    const { said, opened, now } = await putIn({ bio: null, name: null });
    expect(opened).toEqual([`${FB}/me`, ACCOUNTS_PROFILES, `${FB}/me`, `${FB}/me`]);
    expect(said.map((s) => s.says)).toEqual([
      expect.stringContaining('Username. Put in “casey.roofs”'),
      expect.stringContaining('press Edit links on the Links card'),
    ]);
    expect(now()).toMatchObject({ username: 'casey.owner.7', added: [] });
  });

  it('puts the username and links in and hands the name over, as 0.93.0 did (builds before 0.94.0)', async () => {
    how.build = '0.93.0';
    const { said, opened, now, end } = await putIn({ bio: null });
    expect(opened).toEqual([`${FB}/me`, CONTACT, USERNAME_PAGE, ACCOUNTS_PROFILES, `${FB}/me`]);
    expect(said.map((s) => s.says)).toEqual([
      expect.stringContaining('Name. Put “Casey” in First name and “Lee” in Last name'),
    ]);
    // The person carried on without changing it: only what shows is said to be in.
    expect(now()).toMatchObject({ username: 'casey.roofs', name: 'Casey Owner', added: [CAL] });
    expect(end.line).toMatch(
      /^Your username and links are in\. Facebook hasn’t shown your new name/,
    );
    // 0.94.0 puts the name in itself too.
    how.build = '0.94.0';
    const newer = await putIn({ bio: null });
    expect(newer.said).toEqual([]);
    expect(newer.now()).toMatchObject({ username: 'casey.roofs', name: 'Casey Lee', added: [CAL] });
  });
});
