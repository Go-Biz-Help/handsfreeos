/**
 * The script in each tab (src/content.ts), by its network's kit: a tab whose network is off answers nothing but that
 * it's off; a LinkedIn tab reads LinkedIn's page and makes LinkedIn's outline, and does only LinkedIn's own steps
 * (never Facebook's runner's), each only on its own page; a Facebook tab is as it always was; and a step a tab's
 * network doesn't do is answered so, never left hanging.
 */
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

afterEach(() => vi.unstubAllGlobals());

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
    for (const type of ['hfos-fetch-step', 'hfos-scroll-feed', 'hfos-join', 'hfos-write-bio-x'])
      expect(await page.ask({ type, text: 'Hi' })).toEqual({
        ok: false,
        error: 'The extension doesn’t do that on LinkedIn pages.',
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
});
