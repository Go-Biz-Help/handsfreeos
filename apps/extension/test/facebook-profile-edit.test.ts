/**
 * Put these in on Facebook (docs/outreach.md, decision 89): the bio by the About tab's editor, each new link on Contact
 * and basic info, and the username on Accounts Center's username page, each put in by itself on made-up pages whose
 * buttons behave as Facebook's usually do (test/fixtures/*-2026-10.html, nobody real), and each step it can't find
 * handed to the person. It never types a password or a code, and presses Done only once Facebook allows it.
 */
import type { AskTask } from '@hfos/core/addons/outreach/asks';
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
} from '../src/networks/facebook/username';
import type { Hfos, Job, JobTab } from '../src/jobs/job';
import type { ReportNote } from '../src/jobs/report';
import { boxEverything, load } from './load';

/** Facebook's own way, or the hand-over of builds before 0.93.0 (decision 84), when a test asks for it. */
const how = vi.hoisted(() => ({ handedOver: false }));
vi.mock('@hfos/core/addons/outreach/profile-parts', async (original) => {
  const real = await original<typeof Parts>();
  return {
    ...real,
    partHowOn: (...args: Parameters<typeof real.partHowOn>) =>
      how.handedOver && args[0] === 'facebook' && (args[1] === 'links' || args[1] === 'username')
        ? 'steps'
        : real.partHowOn(...args),
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
  how.handedOver = false;
});

/** Runs a step with Facebook's waits skipped. */
async function quickly<T>(going: Promise<T>): Promise<T> {
  let settled = false;
  void going.finally(() => (settled = true)).catch(() => undefined);
  for (let i = 0; i < 600 && !settled; i++) await vi.advanceTimersByTimeAsync(500);
  return going;
}

const clean = (text: string | null | undefined) => (text ?? '').replace(/\s+/g, ' ').trim();

/** A box over the page, with these insides. */
function dialogIn(doc: Document, html: string): HTMLElement {
  const box = doc.createElement('div');
  box.setAttribute('role', 'dialog');
  box.innerHTML = html;
  doc.body.append(box);
  return box;
}

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
      row.innerHTML = `<a role="link" href="https://l.facebook.com/l.php?u=${encodeURIComponent(value)}"><span>${value.replace(/^https:\/\//, '')}</span></a>`;
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
  readonly password?: 'after';
  /** A Facebook warning on the About tab's editor. */
  readonly warnedOnEditor?: boolean;
  /** No Edit by Bio on the editor. */
  readonly noBioEdit?: boolean;
}

/** A Facebook tab over the made-up pages, each behaving as Facebook does, answering asks as the tab would. */
function fakeTab(plan: Plan = {}) {
  let doc: Document | null = null;
  let at = '';
  let username = 'casey.owner.7';
  let bio = 'Dad, golfer, coffee. I help Columbus roofers book more inspections.';
  const added: string[] = [];
  const opened: string[] = [];
  const asked: string[] = [];
  let usernamePage_: ReturnType<typeof usernamePageDoc> | null = null;

  const show = (url: string) => {
    // What Facebook saved since the last page was drawn.
    username = usernamePage_?.saved() ?? username;
    if (url === `${FB}/me`) {
      at = `${FB}/${username}`;
      doc = load(plan.own ?? 'own-profile-2026-10.html', at);
      const line = [...doc.querySelectorAll('span[dir="auto"]')].find((s) =>
        clean(s.textContent).startsWith('Dad, golfer'),
      );
      if (line) line.textContent = bio;
      for (const link of added) {
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
      });
      doc = usernamePage_.doc;
    } else if (url === ACCOUNTS_PROFILES) {
      at = url;
      doc = load('accounts-center-profiles-2026-10.html', at);
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
      // What Facebook saved since the page was drawn.
      const savedName = usernamePage_?.saved();
      if (savedName) username = savedName;
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
        case 'hfos-write-username': {
          if (!usernamePage(at))
            return { ok: false, error: 'Facebook didn’t open Accounts Center’s username page.' };
          const wrote = await writeUsername(page, message.username as string);
          const name = usernamePage_?.saved();
          if (name) username = name;
          return { ok: true, ...wrote };
        }
        case 'hfos-username-page':
          return profilesPage(at)
            ? { ok: true, url: facebookProfileOn(page), warnings: [], asking: null }
            : { ok: false, error: 'Facebook didn’t open Accounts Center’s Profiles.' };
        default:
          return { ok: false, error: `Not expected: ${message.type}` };
      }
    },
  } as unknown as JobTab;
  return {
    tab,
    opened,
    asked,
    now: () => ({ username, bio, added: [...added] }),
    passwordPage: () => usernamePage_,
  };
}

const TASK: Extract<AskTask, { kind: 'profile_edit' }> = {
  kind: 'profile_edit',
  bio: 'I help Columbus roofers fill their calendars.',
  about: null,
  name: 'Casey Owner | Roofs',
  username: 'casey.roofs',
  links: [CAL],
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
  it('puts the bio, the link and the username in itself, and hands over only the name', async () => {
    const { end, said, opened, now, checked } = await putIn({});
    expect(opened).toEqual([
      `${FB}/me`,
      EDITOR,
      CONTACT,
      USERNAME_PAGE,
      ACCOUNTS_PROFILES,
      `${FB}/me`,
    ]);
    expect(said).toHaveLength(1);
    expect(said[0]!.says).toContain('Name. Put in “Casey Owner | Roofs”');
    expect(now()).toEqual({ username: 'casey.roofs', bio: TASK.bio, added: [CAL] });
    expect(checked).toHaveLength(1);
    expect(end).toEqual({ line: 'Your bio, name, username and links are in.', warned: false });
  });

  it('ends saying so when Facebook says the username is taken, the rest in', async () => {
    const { end, now, passwordPage } = await putIn({ name: null }, { taken: true });
    expect(passwordPage()!.pressed()).toBe(0);
    expect(now().username).toBe('casey.owner.7');
    expect(end).toEqual({
      line: 'Your bio and links are in. Facebook says “This username isn’t available. Try another.”, so your username stays as it was. Pick another under Username in Get ready, then put it in again.',
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

  it('says so when Facebook hasn’t shown the new username on the profile after', async () => {
    const { end } = await putIn(
      { bio: null, name: null, links: [] },
      { password: 'after' },
      () => 'carry_on',
    );
    expect(end).toEqual({
      line: 'Your username is in. Facebook hasn’t shown your new username on your profile yet. Check it in Accounts Center: press Profiles, then your Facebook profile.',
      warned: false,
    });
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
      { name: null, username: null, links: [] },
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

  it('hands the username and links over as before where core says they’re the person’s (builds before 0.93.0)', async () => {
    how.handedOver = true;
    const { said, opened, now } = await putIn({ bio: null, name: null });
    expect(opened).toEqual([`${FB}/me`, ACCOUNTS_PROFILES, `${FB}/me`, `${FB}/me`]);
    expect(said.map((s) => s.says)).toEqual([
      expect.stringContaining('Username. Put in “casey.roofs”'),
      expect.stringContaining('press Edit links on the Links card'),
    ]);
    expect(now()).toMatchObject({ username: 'casey.owner.7', added: [] });
  });
});
