/**
 * The script in each tab (src/content.ts), by its network's kit: a tab whose network is off answers nothing but that
 * it's off; a LinkedIn tab reads LinkedIn's page and makes LinkedIn's outline, and does only LinkedIn's own steps
 * (never Facebook's runner's), each only on its own page; a Facebook tab is as it always was; and a step a tab's
 * network doesn't do is answered so, never left hanging.
 */
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NETWORKS_KEY, type NetworkStates } from '../src/networks/on';

type Listener = (
  ask: unknown,
  sender: { id: string },
  respond: (answer: unknown) => void,
) => boolean;

interface Tab {
  readonly ask: (message: Record<string, unknown>) => Promise<unknown>;
  readonly change: (states: NetworkStates) => void;
}

/** Loads the script into a hand-written page at `url`, with the networks kept as `states`. */
async function tab(fixture: string, url: string, states: NetworkStates | null): Promise<Tab> {
  const html = readFileSync(new URL(`./fixtures/${fixture}`, import.meta.url), 'utf8');
  const { window } = new JSDOM(html, { url });
  let listener: Listener | null = null;
  const changed: ((changes: Record<string, { newValue?: unknown }>, area: string) => void)[] = [];
  vi.resetModules();
  delete (globalThis as { hfosSocialListening?: boolean }).hfosSocialListening;
  for (const [name, value] of Object.entries({
    document: window.document,
    location: window.location,
    window,
    Node: window.Node,
    Element: window.Element,
    MutationObserver: window.MutationObserver,
    innerWidth: 1440,
    innerHeight: 900,
  }))
    vi.stubGlobal(name, value);
  vi.stubGlobal('chrome', {
    runtime: {
      id: 'hfos-social',
      getManifest: () => ({ version: '0.34.0' }),
      onMessage: { addListener: (fn: Listener) => (listener = fn) },
      sendMessage: async () => undefined,
    },
    storage: {
      local: { get: async () => (states ? { [NETWORKS_KEY]: states } : {}) },
      onChanged: { addListener: (fn: (typeof changed)[number]) => changed.push(fn) },
    },
  });
  await import('../src/content');
  // The kept states are read as the script starts.
  await new Promise((done) => setTimeout(done, 0));
  return {
    ask: (message) =>
      new Promise((done) => {
        const open = listener!(message, { id: 'hfos-social' }, done);
        if (!open) setTimeout(() => done(undefined), 0);
      }),
    change: (next) => {
      for (const fn of changed) fn({ [NETWORKS_KEY]: { newValue: next } }, 'local');
    },
  };
}

// The script looks at its page as it settles, on timers of its own. They run on a clock that moves as time does, and
// end with the test, before its page is taken away, so none fires on a page that's gone.
beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const on: NetworkStates = {
  facebook: { on: true, allowed: true },
  linkedin: { on: true, allowed: true },
};
const LINKEDIN_FEED = 'https://www.linkedin.com/feed/';

describe('a tab’s script, by its network', () => {
  it('on LinkedIn while it’s on: reads LinkedIn’s page and makes LinkedIn’s outline', async () => {
    const page = await tab('linkedin-feed.html', LINKEDIN_FEED, on);
    expect(await page.ask({ type: 'hfos-read' })).toMatchObject({
      ok: true,
      result: { platform: 'linkedin', kind: 'feed' },
    });
    const outlined = (await page.ask({ type: 'hfos-outline' })) as { outline: string };
    expect(outlined.outline).toContain("(LinkedIn's top bar, left out)");
    expect(outlined.outline).not.toContain('Dana');
  });

  it('on LinkedIn, never does Facebook’s steps, and its own only on their own pages', async () => {
    const page = await tab('linkedin-feed.html', LINKEDIN_FEED, on);
    for (const type of ['hfos-scroll-feed', 'hfos-join', 'hfos-write-bio-x'])
      expect(await page.ask({ type, text: 'Hi' })).toEqual({
        ok: false,
        error: 'The extension doesn’t do that on LinkedIn pages.',
      });
    // The file's steps, only on Get a copy of your data.
    expect(
      await page.ask({
        type: 'hfos-fetch-step',
        step: { action: 'press', words: ['Request archive'], says: 'Press it.' },
        waitMs: 0,
      }),
    ).toEqual({ ok: false, error: 'LinkedIn didn’t open its Get a copy of your data page.' });
    // Who engaged, only on a post's own page.
    expect(await page.ask({ type: 'hfos-engaged' })).toEqual({
      ok: false,
      error: 'LinkedIn didn’t open the post.',
    });
    // LinkedIn's runner's own steps, each only on its own page.
    expect(await page.ask({ type: 'hfos-like-post', index: 0, url: null })).toEqual({
      ok: false,
      error: 'LinkedIn didn’t open their posts.',
    });
    expect(await page.ask({ type: 'hfos-connect' })).toEqual({
      ok: false,
      error: 'LinkedIn didn’t open their profile.',
    });
    expect(await page.ask({ type: 'hfos-message', text: 'Hi' })).toEqual({
      ok: false,
      error: 'LinkedIn didn’t open a conversation with them.',
    });
    expect(await page.ask({ type: 'hfos-own-profile' })).toEqual({
      ok: false,
      error: 'LinkedIn didn’t open your profile.',
    });
    expect(await page.ask({ type: 'hfos-write-bio', bio: 'Hi' })).toEqual({
      ok: false,
      error: 'LinkedIn didn’t open your profile.',
    });
    expect(
      await page.ask({
        type: 'hfos-withdraw',
        profile: {
          id: null,
          username: 'morgan-ellis-3',
          url: 'https://www.linkedin.com/in/morgan-ellis-3/',
        },
      }),
    ).toEqual({ ok: false, error: 'LinkedIn didn’t open the invitations you’ve sent.' });
    // A conversation opens only from messaging's list.
    expect(
      await page.ask({ type: 'hfos-open-chat', threadId: '2-MadeUpThreadDana0001==' }),
    ).toEqual({ ok: false });
  });

  it('puts a helpful post up only on LinkedIn’s feed', async () => {
    const page = await tab('linkedin-own-profile.html', 'https://www.linkedin.com/in/me/', on);
    expect(await page.ask({ type: 'hfos-feed-post', text: 'Hi' })).toEqual({
      ok: false,
      error: 'LinkedIn didn’t open your feed.',
    });
  });

  it('on LinkedIn’s Get a copy of your data: does the file’s steps there', async () => {
    const page = await tab(
      'linkedin-data.html',
      'https://www.linkedin.com/mypreferences/d/download-my-data',
      on,
    );
    expect(
      await page.ask({
        type: 'hfos-fetch-step',
        step: {
          action: 'pick',
          words: ['Want something in particular'],
          anywhere: true,
          says: 'Pick it.',
        },
        waitMs: 0,
      }),
    ).toMatchObject({ ok: true, result: 'done' });
    expect(
      await page.ask({
        type: 'hfos-fetch-step',
        step: { action: 'stopIf', words: ['being prepared'], says: 'Already asked.' },
        waitMs: 0,
      }),
    ).toMatchObject({ ok: true, result: 'missing' });
  });

  it('on LinkedIn’s own profile: reads it for the AI’s check, as LinkedIn’s', async () => {
    const page = await tab('linkedin-own-profile.html', 'https://www.linkedin.com/in/me/', on);
    expect(await page.ask({ type: 'hfos-own-profile' })).toMatchObject({
      ok: true,
      read: {
        platform: 'linkedin',
        name: 'Chris Gee',
        bio: 'Helping home service businesses answer every lead | Founder, Gee Consulting',
      },
    });
  });

  it('on LinkedIn while it’s off, or Chrome hasn’t allowed it: answers only that it’s off', async () => {
    const off = 'LinkedIn is off for you, so the extension does nothing on it.';
    for (const states of [
      null,
      { ...on, linkedin: { on: false, allowed: true } },
      { ...on, linkedin: { on: true, allowed: false } },
    ]) {
      const page = await tab('linkedin-feed.html', LINKEDIN_FEED, states);
      expect(await page.ask({ type: 'hfos-read' })).toMatchObject({
        ok: false,
        error: expect.stringContaining(off),
      });
    }
    // Turned off while the tab is open: it stops at once.
    const page = await tab('linkedin-feed.html', LINKEDIN_FEED, on);
    page.change({ ...on, linkedin: { on: false, allowed: true } });
    expect(await page.ask({ type: 'hfos-outline' })).toMatchObject({ ok: false });
  });

  it('on Facebook: as it always was, on from the start', async () => {
    const url = 'https://www.facebook.com/jane.doe.5';
    const page = await tab('profile.html', url, null);
    expect(await page.ask({ type: 'hfos-read' })).toMatchObject({
      ok: true,
      result: { kind: 'profile', profile: { name: 'Jane Doe' } },
    });
    // Facebook's own work goes to its kit: off a download page, a download step says so.
    expect(await page.ask({ type: 'hfos-fetch-step', step: {}, waitMs: 0 })).toEqual({
      ok: false,
      error: 'This isn’t one of Facebook’s download pages.',
    });
    // Anything else it doesn't know, it says so.
    expect(await page.ask({ type: 'hfos-nothing' })).toEqual({
      ok: false,
      error: 'The extension doesn’t do that on Facebook pages.',
    });
  });

  it('on Facebook, puts the person’s links and username in only on the pages where they’re changed', async () => {
    // Someone else's profile: not theirs, not where links go, and not Accounts Center.
    const profile = await tab('profile.html', 'https://www.facebook.com/jane.doe.5', null);
    expect(await profile.ask({ type: 'hfos-own-editors' })).toEqual({
      ok: false,
      error: 'Facebook didn’t open your profile.',
    });
    expect(
      await profile.ask({ type: 'hfos-write-link', link: 'https://summitroofleads.com' }),
    ).toEqual({ ok: false, error: 'Facebook didn’t open where your links are changed.' });
    expect(
      await profile.ask({ type: 'hfos-write-username', username: 'casey.roofs', profile: '1' }),
    ).toEqual({
      ok: false,
      error: 'Facebook didn’t open Accounts Center’s username page.',
    });
    expect(await profile.ask({ type: 'hfos-username-page' })).toEqual({
      ok: false,
      error: 'Facebook didn’t open Accounts Center’s Profiles.',
    });

    // Accounts Center's Profiles: the Facebook profile's username page, and nothing written there.
    const profiles = await tab(
      'accounts-center-profiles-2026-10.html',
      'https://accountscenter.facebook.com/profiles',
      null,
    );
    expect(await profiles.ask({ type: 'hfos-username-page' })).toEqual({
      ok: true,
      url: 'https://accountscenter.facebook.com/profiles/100001234/username/',
      profile: '100001234',
      warnings: [],
      asking: null,
    });
    expect(
      await profiles.ask({
        type: 'hfos-write-username',
        username: 'casey.roofs',
        profile: '100001234',
      }),
    ).toEqual({
      ok: false,
      error: 'Facebook didn’t open Accounts Center’s username page.',
    });

    // Its username page: the username goes in there, and no link does.
    const username = await tab(
      'accounts-center-username-2026-10.html',
      'https://accountscenter.facebook.com/profiles/100001234/username/?entrypoint=fb_account_center',
      null,
    );
    expect(
      await username.ask({ type: 'hfos-write-link', link: 'https://summitroofleads.com' }),
    ).toEqual({ ok: false, error: 'Facebook didn’t open where your links are changed.' });
    // Another profile's username page (an Instagram one, say): nothing typed there.
    expect(
      await username.ask({
        type: 'hfos-write-username',
        username: 'casey.owner.7',
        profile: '100009999',
      }),
    ).toEqual({ ok: false, error: 'Facebook didn’t open Accounts Center’s username page.' });
    // The one it has already: nothing typed, nothing pressed.
    expect(
      await username.ask({
        type: 'hfos-write-username',
        username: 'casey.owner.7',
        profile: '100001234',
      }),
    ).toMatchObject({ ok: true, result: 'already', steps: { boxes: 1, typed: true } });
    // Check Facebook's try goes only by their own profile's number too.
    expect(await username.ask({ type: 'hfos-try', step: 'username' })).toEqual({
      ok: false,
      error: 'Facebook didn’t open Accounts Center’s username page.',
    });
    // Its warnings, read as Facebook asks the person for nothing there: none.
    expect(await username.ask({ type: 'hfos-account-warnings' })).toEqual({
      ok: true,
      warnings: [],
      asking: null,
    });
  });

  it('on Instagram, works on its own Accounts Center for the username and name, never Facebook’s', async () => {
    const instagramOn: NetworkStates = { ...on, instagram: { on: true, allowed: true } };
    const profiles = await tab(
      'accounts-center-profiles-2026-10.html',
      'https://accountscenter.instagram.com/profiles',
      instagramOn,
    );
    expect(await profiles.ask({ type: 'hfos-username-page', username: 'casey.owner' })).toEqual({
      ok: true,
      url: 'https://accountscenter.instagram.com/profiles/17841400000000001/username/',
      profile: '17841400000000001',
      warnings: [],
      asking: null,
    });
    // Only on the page of the profile the ask names: Facebook's number is never typed on here.
    expect(
      await profiles.ask({
        type: 'hfos-write-center-name',
        name: 'Casey Lee',
        profile: '100001234',
      }),
    ).toEqual({ ok: false, error: 'Instagram didn’t open Accounts Center’s name page.' });
    const name = await tab(
      'accounts-center-instagram-name-2026-10.html',
      'https://accountscenter.instagram.com/profiles/17841400000000001/name/',
      instagramOn,
    );
    // Its name already: nothing typed, nothing pressed.
    expect(
      await name.ask({
        type: 'hfos-write-center-name',
        name: 'Casey',
        profile: '17841400000000001',
      }),
    ).toMatchObject({ ok: true, result: 'already', steps: { nameBoxes: 1, typed: true } });
    // Its help ("twice within 14 days") is no warning.
    expect(await name.ask({ type: 'hfos-account-warnings' })).toEqual({
      ok: true,
      warnings: [],
      asking: null,
    });
  });

  it('on Facebook, adds links only on the person’s own profile’s About tab', async () => {
    const theirs = await tab(
      'profile-2026.html',
      'https://www.facebook.com/jane.doe.5/about_contact',
      null,
    );
    expect(
      await theirs.ask({ type: 'hfos-write-link', link: 'https://summitroofleads.com' }),
    ).toEqual({ ok: false, error: 'Facebook didn’t open where your links are changed.' });
    expect(await theirs.ask({ type: 'hfos-write-bio', bio: 'Roofs.' })).toEqual({
      ok: false,
      error: 'Facebook didn’t open your profile.',
    });
    const own = await tab(
      'own-profile-contact-2026-10.html',
      'https://www.facebook.com/casey.owner.7/about_contact?fb_profile_edit_entry_point=9',
      null,
    );
    expect(await own.ask({ type: 'hfos-write-link', link: 'https://summitroofleads.com' })).toEqual(
      { ok: true, result: 'already', steps: expect.objectContaining({ control: false }) },
    );
  });
});
