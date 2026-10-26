/**
 * Put these in on Instagram (docs/outreach.md, decision 89): the bio on its Edit profile form (decision 80), then its
 * username and name on Instagram's own Accounts Center, for the account signed in on instagram.com, each by itself on
 * made-up pages whose buttons behave as Instagram's usually do (nobody real: the account casey.owner of
 * test/fixtures/accounts-center-profiles-2026-10.html, its Accounts Center pages in test/center-pages.ts, its own page
 * and form drawn as ./profile-everywhere.test.ts draws them); its links in its phone app, said in words. Each step it
 * can't do is handed to the person, a password is theirs, and only what shows on the account after is said to be in.
 */
import type { AskTask } from '@hfos/core/addons/outreach/asks';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runAsk } from '../src/asks/run';
import { KITS } from '../src/networks';
import type { Hfos, Job, JobTab } from '../src/jobs/job';
import type { ReportNote } from '../src/jobs/report';
import {
  dialogIn,
  IG_CENTER,
  IG_NAME_PAGE,
  IG_USERNAME_PAGE,
  instagramNamePage,
  instagramUsernamePage,
  type InstagramNamePlan,
  type InstagramUsernamePlan,
} from './center-pages';
import { load } from './load';
import { JSDOM } from 'jsdom';

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Runs a job with Instagram's waits skipped. */
async function quickly<T>(going: Promise<T>): Promise<T> {
  let settled = false;
  void going.finally(() => (settled = true)).catch(() => undefined);
  for (let i = 0; i < 2_000 && !settled; i++) await vi.advanceTimersByTimeAsync(500);
  return going;
}

const IG = 'https://www.instagram.com';
const FORM = `${IG}/accounts/edit/`;
const PROFILES = `${IG_CENTER}/profiles`;
const CAL = 'https://cal.com/casey-owner';

const html = (body: string) =>
  `<!doctype html><html><head><title>Instagram</title></head><body>${body}</body></html>`;

const menu = (username: string) => `<div><a href="/" role="link"><span>Home</span></a>
  <a href="/${username}/" role="link"><img alt="${username}'s profile picture" /><span>Profile</span></a></div>`;

/** Their account's own page, as ./profile-everywhere.test.ts draws it: its username, name and bio. */
const accountPage = (username: string, name: string, bio: string) =>
  html(`${menu(username)}<main role="main"><div><header>
  <section><div><div><a role="link" href="#"><h2 dir="auto"><span>${username}</span></h2></a></div>
    <div><span dir="auto"><span>0</span> posts</span>
      <a role="link" href="#"><span dir="auto"><span>87</span> followers</span></a></div></div></section>
  <section><div><div dir="auto">${name}</div><span dir="auto">${bio}</span></div></section>
  <section><div><a role="link" href="/accounts/edit/">Edit profile</a></div></section>
</header></div></main>`);

/** Its Edit profile form: the bio's box, and Submit, off till something changes. */
const formPage = (username: string, bio: string) =>
  html(`${menu(username)}<main role="main"><form>
  <label for="pepBio">Bio</label><textarea id="pepBio">${bio}</textarea>
  <div role="button" aria-disabled="true">Submit</div></form></main>`);

interface Plan {
  /** Accounts Center shows no Instagram profile: it isn't in the Accounts Center there. */
  readonly notLinked?: boolean;
  readonly username?: InstagramUsernamePlan;
  readonly name?: InstagramNamePlan;
  /** The form's Submit never comes on by itself. */
  readonly submitStuck?: boolean;
  /** Instagram's block over the form at Submit, keeping nothing. */
  readonly blockedOnForm?: boolean;
  /** The form shows the bio it had again, whatever was kept. */
  readonly formForgets?: boolean;
  /** The person presses Stop once this page has opened. */
  readonly stopOn?: string;
}

/** An Instagram tab over the made-up pages, each behaving as Instagram does, answering asks as its tab does. */
function instagramTab(plan: Plan = {}) {
  const kit = KITS.instagram;
  let doc: Document | null = null;
  let username = 'casey.owner';
  let name = 'Casey';
  let bio = 'Roofs and coffee in Columbus';
  const opened: string[] = [];
  let usernamePage: ReturnType<typeof instagramUsernamePage> | null = null;
  let namePage: ReturnType<typeof instagramNamePage> | null = null;
  let submit: HTMLElement | null = null;
  /** What Instagram saved since the page was drawn. */
  const savedSince = () => {
    username = usernamePage?.saved() ?? username;
    name = namePage?.saved() ?? name;
  };
  const form = (url: string) => {
    const page = new JSDOM(
      formPage(username, plan.formForgets ? 'Roofs and coffee in Columbus' : bio),
      { url },
    ).window.document;
    const box = page.querySelector('textarea')!;
    const button = page.querySelector<HTMLElement>('form [role="button"]')!;
    submit = button;
    page.execCommand = (command: string, _ui?: boolean, text?: string) => {
      if (command !== 'insertText') return false;
      box.value = text ?? '';
      box.dispatchEvent(new page.defaultView!.Event('input', { bubbles: true }));
      return true;
    };
    box.addEventListener('input', () =>
      setTimeout(() => {
        if (!plan.submitStuck) button.removeAttribute('aria-disabled');
      }, 300),
    );
    button.addEventListener('click', () => {
      if (button.getAttribute('aria-disabled') === 'true') return;
      if (plan.blockedOnForm) {
        dialogIn(
          page,
          '<h2>Action Blocked</h2><span>Try again later.</span><div role="button">OK</div>',
        );
        return;
      }
      bio = box.value;
      button.setAttribute('aria-disabled', 'true');
    });
    return page;
  };
  const show = (url: string): Document => {
    savedSince();
    if (url === `${IG}/`)
      return new JSDOM(html(`${menu(username)}<main role="main"></main>`), { url }).window.document;
    if (url === `${IG}/${username}/`)
      return new JSDOM(accountPage(username, name, bio), { url }).window.document;
    if (url === FORM) return form(url);
    if (url === PROFILES) {
      const page = load('accounts-center-profiles-2026-10.html', url);
      for (const row of page.querySelectorAll('[role="listitem"]')) {
        if (!(row.textContent ?? '').includes('Instagram')) continue;
        if (plan.notLinked) row.remove();
        else row.querySelector('span')!.textContent = username;
      }
      return page;
    }
    if (url === IG_USERNAME_PAGE) {
      usernamePage = instagramUsernamePage({ holds: username, ...plan.username });
      return usernamePage.doc;
    }
    if (url === IG_NAME_PAGE) {
      namePage = instagramNamePage(plan.name);
      namePage.box.value = name;
      return namePage.doc;
    }
    throw new Error(`Not expected: ${url}`);
  };
  const tab = {
    async open(url: string) {
      // Only where Instagram's tab may go: its own pages, and its own Accounts Center.
      expect(kit.workUrl(url)).toBe(url);
      opened.push(url);
      doc = show(url);
      return 1;
    },
    async inFront<T>(work: () => Promise<T>) {
      return work();
    },
    async ask(message: { readonly type: string }) {
      if (!doc) return { ok: false, error: 'closed' };
      const at = doc.location.href;
      if (message.type === 'hfos-read') return { ok: true, result: kit.readPage(doc, at) };
      if (message.type === 'hfos-outline')
        return {
          ok: true,
          result: kit.readPage(doc, at),
          outline: kit.outline(doc, at),
          shown: true,
        };
      vi.stubGlobal('location', new URL(at));
      vi.stubGlobal('document', doc);
      try {
        return (await kit.work!(message)) ?? { ok: false, error: `Not expected: ${message.type}` };
      } finally {
        vi.unstubAllGlobals();
        savedSince();
      }
    },
  } as unknown as JobTab;
  return {
    tab,
    opened,
    now: () => ({ username, name, bio }),
    usernamePage: () => usernamePage,
    namePage: () => namePage,
    /** The person pressed Submit on the form themselves. */
    submitted: () => {
      submit?.removeAttribute('aria-disabled');
      submit?.click();
    },
  };
}

const TASK: Extract<AskTask, { kind: 'profile_edit' }> = {
  kind: 'profile_edit',
  bio: 'Booked inspections for Columbus roofers',
  about: null,
  name: 'Casey | Columbus Roofs',
  username: 'casey.roofs',
  links: [CAL],
};

async function putIn(
  task: Partial<typeof TASK>,
  plan: Plan = {},
  answer: (says: string, tab: ReturnType<typeof instagramTab>) => 'carry_on' | 'stop' = () =>
    'carry_on',
) {
  const faked = instagramTab(plan);
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
    stopped: () => plan.stopOn !== undefined && faked.opened.includes(plan.stopOn),
    progress: () => undefined,
    warn: async (words) => void warned.push([...words]),
    handOver: async (says, note) => {
      said.push({ says, ...(note ? { note } : {}) });
      return answer(says, faked);
    },
    report: async () => undefined,
  };
  const end = await quickly(runAsk({ ...TASK, ...task }, job, 'instagram'));
  return { end, said, warned, checked, ...faked };
}

describe('Put these in, on Instagram', () => {
  it('puts the bio, the username and the name in itself, says the links are in its app, and reads the account again', async () => {
    const { end, said, opened, now, checked } = await putIn({});
    expect(opened).toEqual([
      FORM,
      `${IG}/`,
      PROFILES,
      IG_USERNAME_PAGE,
      IG_NAME_PAGE,
      `${IG}/`,
      `${IG}/casey.roofs/`,
      FORM,
    ]);
    expect(said.map((s) => s.says)).toEqual([
      `In the Instagram app on your phone, press Edit profile, then Links, then Add external link, and paste each one (${CAL}). Then press Carry on.`,
    ]);
    expect(now()).toEqual({
      username: 'casey.roofs',
      name: 'Casey | Columbus Roofs',
      bio: TASK.bio,
    });
    expect(checked).toEqual([
      expect.objectContaining({ name: 'Casey | Columbus Roofs', bio: TASK.bio }),
    ]);
    expect(end).toEqual({ line: 'Your bio, name, username and links are in.', warned: false });
  });

  it('hands the username and name over, saying why, when Accounts Center shows no Instagram profile', async () => {
    const { end, said, opened } = await putIn({ bio: null, links: [] }, { notLinked: true });
    expect(opened.slice(0, 3)).toEqual([`${IG}/`, PROFILES, `${IG}/`]);
    expect(said.map((s) => s.says)).toEqual([
      'The extension couldn’t tell which profile under Profiles is your Instagram account @casey.owner, so it didn’t change your username. In Accounts Center’s Profiles, press @casey.owner, then Username, put in “casey.roofs” and press Done. Then press Carry on.',
      'The extension couldn’t tell which profile under Profiles is your Instagram account @casey.owner, so it didn’t change your name. In Accounts Center’s Profiles, press @casey.owner, then Name, put in “Casey | Columbus Roofs” and press Done. Instagram lets you change it twice in 14 days. Then press Carry on.',
    ]);
    expect(said[0]!.note).toMatchObject({
      job: 'profile_edit.username',
      note: 'No profile of theirs among Accounts Center’s Profiles, so the username was handed to the person.',
      outline: true,
    });
    // The person carried on without changing them: neither is said to be in.
    expect(end).toEqual({
      line: 'Instagram hasn’t shown your new username on your profile yet. Check it in Accounts Center: press Profiles, then your Instagram profile, then Username, and put “casey.roofs” in if it isn’t there. Instagram hasn’t shown your new name on your profile yet. Check it in Accounts Center: press Profiles, then your Instagram profile, then Name, and put “Casey | Columbus Roofs” in if it isn’t there.',
      warned: false,
      failed: true,
    });
  });

  it('never says a part is in when the person pressed Stop before the account was read again', async () => {
    const { end, now } = await putIn(
      { bio: null, name: null, links: [] },
      { notLinked: true, stopOn: `${IG}/casey.owner/` },
    );
    expect(now().username).toBe('casey.owner');
    expect(end).toEqual({ line: 'Stopped.', warned: false, failed: true });
  });

  it('stops for the day on Instagram’s “Try Again Later” box on the username page, never opening the name’s', async () => {
    const { end, warned, opened, now } = await putIn(
      { bio: null, links: [] },
      { username: { later: true } },
    );
    expect(warned).toEqual([['Try Again Later']]);
    expect(opened).not.toContain(IG_NAME_PAGE);
    expect(now()).toMatchObject({ username: 'casey.owner', name: 'Casey' });
    expect(end).toEqual({
      line: 'Stopped: Instagram says “Try Again Later”. The extension stops on Instagram for today, and your Instagram limits are halved for a week.',
      warned: true,
    });
  });

  it('leaves the name for another day when Instagram says to try the username again later', async () => {
    const { end, opened, warned, now } = await putIn(
      { bio: null, links: [] },
      { username: { refuses: 'You can’t change your username right now. Try again later.' } },
    );
    expect(warned).toEqual([]);
    expect(opened).not.toContain(IG_NAME_PAGE);
    expect(now()).toMatchObject({ username: 'casey.owner', name: 'Casey' });
    expect(end).toEqual({
      line: 'Instagram won’t change your username right now: it says “You can’t change your username right now. Try again later.”. Try again in a few days, or keep the one you have. Instagram lets you change your username twice in 14 days. Instagram said to try again later, so the extension didn’t go on to your name. Press Put these in again tomorrow to put “Casey | Columbus Roofs” in.',
      warned: false,
      failed: true,
    });
  });

  it('hands over a box after Done that offers to change the Facebook username too, never pressing it', async () => {
    const { said, usernamePage } = await putIn(
      { bio: null, name: null, links: [] },
      { username: { sure: { says: 'Also change your Facebook username?', button: 'Confirm' } } },
    );
    expect(said.map((s) => s.says)).toEqual([
      'Instagram offers to change your username on Facebook too, so the extension didn’t press its button. In the Instagram window, change only your Instagram username to “casey.roofs”: untick Facebook there if you can, or press Cancel. Then press Carry on.',
    ]);
    expect(said[0]!.note).toMatchObject({
      job: 'profile_edit.username',
      found: { pressed: true, confirmed: false, sync: true },
    });
    expect(usernamePage()!.sures()).toBe(0);
  });

  it('hands the username and name over, saying how to let it on, while Chrome keeps it off Instagram’s Accounts Center', async () => {
    vi.stubGlobal('chrome', { permissions: { contains: async () => false } });
    const { said, opened, end } = await putIn({ bio: null, links: [] });
    expect(opened).not.toContain(PROFILES);
    expect(said.map((s) => s.says)).toEqual([
      'Chrome is keeping the extension off Instagram’s Accounts Center, so it didn’t change your username. In Accounts Center, press Profiles, then your Instagram, then Username. Put in “casey.roofs”, then Done. Then press Carry on. To let it do this next time, open Chrome’s Extensions, press Details on HandsFreeOS Social, and allow accountscenter.instagram.com under Site access.',
      'Chrome is keeping the extension off Instagram’s Accounts Center, so it didn’t change your name. In Accounts Center, press Profiles, then your Instagram, then Name. Put in “Casey | Columbus Roofs”, then Done. Instagram lets you change it twice in 14 days. Then press Carry on. To let it do this next time, open Chrome’s Extensions, press Details on HandsFreeOS Social, and allow accountscenter.instagram.com under Site access.',
    ]);
    expect(said[0]!.note).toMatchObject({
      job: 'profile_edit.username',
      note: 'Chrome keeps the extension off accountscenter.instagram.com, so the username was handed to the person.',
    });
    // The person carried on without changing them: neither is said to be in.
    expect(end).toMatchObject({ failed: true });
  });

  it('ends with Instagram’s words when it says the username isn’t available, the name still put in', async () => {
    const { end, usernamePage, now } = await putIn(
      { bio: null, links: [] },
      { username: { taken: true } },
    );
    expect(usernamePage()!.pressed()).toBe(0);
    expect(now()).toMatchObject({ username: 'casey.owner', name: 'Casey | Columbus Roofs' });
    expect(end).toEqual({
      line: 'Your name is in. Instagram says “The username casey.roofs is not available.”, so your username stays as it was. Pick another under Username: in Social Outreach, go to Settings → Instagram and press Check your profile. Then press Put these in again.',
      warned: false,
      failed: true,
    });
  });

  it('types nothing on another account’s username page, and says where theirs is', async () => {
    const { said, usernamePage } = await putIn(
      { bio: null, name: null, links: [] },
      { username: { holds: 'someone.else' } },
    );
    expect(said.map((s) => s.says)).toEqual([
      'This page shows another account’s username, not @casey.owner, so the extension typed nothing. Go back to Profiles, press your account @casey.owner, then Username, put in “casey.roofs” and press Done. Then press Carry on.',
    ]);
    expect(said[0]!.note).toMatchObject({
      job: 'profile_edit.username',
      found: { other: true, typed: false },
    });
    expect(usernamePage()!.box.value).toBe('someone.else');
  });

  it('waits for the person to type the password Instagram asks for after the name’s Done, never typing it', async () => {
    const { end, said, now } = await putIn(
      { bio: null, username: null, links: [] },
      { name: { password: true } },
      (_says, tab) => {
        const box = tab.namePage()!.doc.querySelector<HTMLInputElement>('input[type="password"]')!;
        expect(box.value).toBe('');
        tab.namePage()!.continued();
        return 'carry_on';
      },
    );
    expect(said.map((s) => s.says)).toEqual([
      'Instagram wants your password to change your name. Type it in the Instagram window and press its button there (Continue or Done), then press Carry on.',
    ]);
    expect(now().name).toBe('Casey | Columbus Roofs');
    expect(end).toEqual({ line: 'Your name is in.', warned: false });
  });

  it('ends with Instagram’s words when it won’t change the name now, never as an Instagram warning', async () => {
    const { end, warned } = await putIn(
      { bio: null, username: null, links: [] },
      { name: { refuses: 'You’ve changed your name too many times. Try again later.' } },
    );
    expect(warned).toEqual([]);
    expect(end).toEqual({
      line: 'Instagram won’t change your name right now (it says “You’ve changed your name too many times. Try again later.”). Keep the name you have, and press Put these in again once Instagram lets you (it lets you change your name twice in 14 days).',
      warned: false,
      failed: true,
    });
  });
});

describe('the bio, on Instagram’s form', () => {
  it('waits for Submit to come on, presses it once, and reads the form again to be sure it’s kept', async () => {
    const { end, now, opened } = await putIn({ name: null, username: null, links: [] });
    expect(now().bio).toBe(TASK.bio);
    expect(opened).toEqual([FORM, `${IG}/`, `${IG}/casey.owner/`, FORM]);
    expect(end).toEqual({ line: `Your bio now says “${TASK.bio}”.`, warned: false });
  });

  it('hands over the step it stopped at when Submit never comes on, with a note of which', async () => {
    const { end, said } = await putIn(
      { name: null, username: null, links: [] },
      { submitStuck: true },
      (_says, tab) => {
        tab.submitted();
        return 'carry_on';
      },
    );
    expect(said.map((s) => s.says)).toEqual([
      'Your new bio is in its box on this page. Press Submit once Instagram turns it on, then press Carry on.',
    ]);
    expect(said[0]!.note).toMatchObject({
      job: 'profile_edit.bio',
      note: 'Not done: Submit stayed off.',
      found: { box: true, typed: true, submits: 1, submitOn: false, pressed: false },
      outline: true,
    });
    expect(end).toEqual({ line: `Your bio now says “${TASK.bio}”.`, warned: false });
  });

  it('stops for the day on Instagram’s block at Submit, handing nothing over', async () => {
    const { end, said, warned } = await putIn(
      { name: null, username: null, links: [] },
      { blockedOnForm: true },
    );
    expect(said).toEqual([]);
    expect(warned).toEqual([['Action Blocked', 'Try again later.']]);
    expect(end).toMatchObject({ warned: true });
  });

  it('never says the bio is in when the form doesn’t show it after', async () => {
    const { end } = await putIn({ name: null, username: null, links: [] }, { formForgets: true });
    expect(end).toEqual({
      line: `Instagram hasn’t shown your new bio on your profile yet. Check it there, and if it isn’t, press Edit profile, write “${TASK.bio}” under Bio, and press Submit.`,
      warned: false,
      failed: true,
    });
  });
});
