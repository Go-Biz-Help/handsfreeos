/**
 * The side panel shows progress and activity only (docs/outreach.md, decision 72): what needs the person is one line
 * under Next up, "3 things need you in HandsFreeOS", linking to Needs you there (src/panel/needs.ts); and a step an ask
 * hands them says what to do and to press Carry on in HandsFreeOS → Needs you, with a link, and keeps only Stop
 * (src/panel/status.ts). At its top, this build's version (decision 189, src/panel/version.ts). The background and
 * HandsFreeOS are stood in for.
 */
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ASK_TYPING_WORDS } from '@hfos/core/addons/outreach/asks';
import { EXTENSION_DOWNLOAD_WORDS } from '@hfos/core/extension-download';
import { DAILY_STEPS } from '@hfos/core/addons/outreach/limits';
import { freshState } from '../src/auto/plan';
import { ASK_KEY, askKeyOf, type KeptAsk } from '../src/hfos/asks';
import { SETTINGS_KEY } from '../src/hfos/follow';
import { LIVE_ACTIVE_KEY, LIVE_KEY } from '../src/hfos/live';
import {
  BUSINESS_KEY,
  PLACE_KEY,
  WAITING_FOR_KEY,
  type Account,
  type AutoStatus,
} from '../src/hfos/messages';

const WEB = 'https://app.handsfreeos.com';
const ME = { userId: 'u-dana', businessId: 'b-one' };
/** Needs you, on Today in HandsFreeOS, for the business. */
const NEEDS_YOU = `${WEB}/app/w/b-one/a/outreach?view=today#needs-you`;
const ACCOUNT: Account = {
  signedIn: true,
  email: 'dana@example.com',
  name: 'Dana Reyes',
  businesses: [{ id: 'b-one', name: 'Reyes Roofing' }],
  businessId: 'b-one',
  webUrl: WEB,
};

type Changed = (
  changes: Record<string, { newValue?: unknown; oldValue?: unknown }>,
  area: string,
) => void;

interface Panel {
  readonly document: Document;
  /** What the panel asked the background. */
  readonly sent: { readonly type: string; readonly [key: string]: unknown }[];
  /** A change to the extension's storage, as the background writes it: `undefined` takes a key away. */
  readonly change: (values: Record<string, unknown>) => void;
}

/** A blank panel page, with the extension's storage holding `kept`, and the background answering with `answers`. */
function panel(kept: Record<string, unknown>, answers: Record<string, unknown> = {}): Panel {
  const { window } = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'chrome-extension://hfos-social/panel.html',
  });
  const store = new Map(Object.entries(kept));
  const listeners: Changed[] = [];
  const sent: Panel['sent'] = [];
  vi.resetModules();
  vi.stubGlobal('document', window.document);
  vi.stubGlobal('chrome', {
    runtime: {
      sendMessage: async (message: { type: string }) => {
        sent.push(message);
        return answers[message.type] ?? { ok: true, value: null };
      },
    },
    storage: {
      local: {
        get: async (keys: string | string[]) =>
          Object.fromEntries(
            [keys]
              .flat()
              .filter((k) => store.has(k))
              .map((k) => [k, store.get(k)]),
          ),
      },
      onChanged: { addListener: (fn: Changed) => listeners.push(fn) },
    },
  });
  return {
    document: window.document,
    sent,
    change: (values) => {
      const changes = Object.fromEntries(
        Object.entries(values).map(([k, v]) => [
          k,
          { oldValue: store.get(k), ...(v === undefined ? {} : { newValue: v }) },
        ]),
      );
      for (const [k, v] of Object.entries(values)) {
        if (v === undefined) store.delete(k);
        else store.set(k, v);
      }
      for (const fn of listeners) fn(changes, 'local');
    },
  };
}

/** Lets the panel's asks to the background and reads of its storage answer. */
const settle = async () => {
  for (let i = 0; i < 3; i++) await new Promise((done) => setTimeout(done, 0));
};

// The panel's drawing waits on its asks, on a clock that moves as time does; every timer ends with its test, before
// the page is taken away, so none fires on a page that's gone.
beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('the line under Next up', () => {
  /** What waits, as the background keeps it for the icon's number. */
  const waiting = (count: number, whose = ME) => ({
    ...whose,
    list: { count, items: [], kinds: {} },
    at: Date.now(),
  });

  async function line(count: number, whose = ME): Promise<{ line: HTMLElement; panel: Panel }> {
    const kept = waiting(count, whose);
    const p = panel(
      { [WAITING_FOR_KEY]: kept, [PLACE_KEY]: ME, [BUSINESS_KEY]: ME.businessId },
      { 'hfos-waiting': { ok: true, value: kept.list } },
    );
    const { needsFor, startNeeds } = await import('../src/panel/needs');
    const into = p.document.createElement('p');
    into.hidden = true;
    p.document.body.append(into);
    startNeeds(into);
    needsFor(ACCOUNT);
    await settle();
    return { line: into, panel: p };
  }

  it('shows nothing when nothing waits', async () => {
    const { line: shown, panel: p } = await line(0);
    expect(shown.hidden).toBe(true);
    expect(shown.textContent).toBe('');
    // It asked the background to look again as it opened.
    expect(p.sent).toContainEqual({ type: 'hfos-waiting' });
  });

  it('says one thing needs you, linking to Needs you in HandsFreeOS', async () => {
    const { line: shown } = await line(1);
    expect(shown.hidden).toBe(false);
    expect(shown.textContent).toBe('1 thing needs you in HandsFreeOS');
    const link = shown.querySelector('a')!;
    expect(link.href).toBe(NEEDS_YOU);
    expect(link.target).toBe('_blank');
    // Only the line: nothing waiting is listed or answered in the panel.
    expect(shown.querySelectorAll('button')).toHaveLength(0);
  });

  it('says how many things need you, with the same link', async () => {
    const { line: shown } = await line(3);
    expect(shown.textContent).toBe('3 things need you in HandsFreeOS');
    expect(shown.querySelector('a')!.href).toBe(NEEDS_YOU);
    expect((await line(1200)).line.textContent).toBe('1,200 things need you in HandsFreeOS');
  });

  it('follows the icon’s number as the background keeps it, and goes when none wait', async () => {
    const { line: shown, panel: p } = await line(2);
    p.change({ [WAITING_FOR_KEY]: waiting(5) });
    expect(shown.textContent).toBe('5 things need you in HandsFreeOS');
    p.change({ [WAITING_FOR_KEY]: waiting(0) });
    expect(shown.hidden).toBe(true);
  });

  it('shows nothing of someone else’s, or another business’s', async () => {
    expect((await line(4, { userId: 'u-sam', businessId: 'b-one' })).line.hidden).toBe(true);
    expect((await line(4, { userId: 'u-dana', businessId: 'b-two' })).line.hidden).toBe(true);
    // Signed out: no line.
    const { line: shown } = await line(4);
    const { needsFor } = await import('../src/panel/needs');
    needsFor({ signedIn: false, canSignIn: true, webUrl: WEB });
    expect(shown.hidden).toBe(true);
  });
});

describe('a step an ask hands the person', () => {
  const status = {
    automation: null,
    trouble: null,
    businessId: 'b-one',
    noting: true,
    state: freshState('2026-10-16'),
    webUrl: WEB,
    live: null,
    warned: null,
    pastLimit: null,
  } satisfies AutoStatus;

  const askUnder = (more: Partial<KeptAsk>): KeptAsk => ({
    ...ME,
    askId: '4c3b2a1d-0e9f-4a8b-8c7d-6e5f4a3b2c1d',
    platform: 'facebook',
    kind: 'file_download',
    about: null,
    state: 'working',
    line: 'Opening your Facebook file’s page…',
    at: Date.now(),
    ...more,
  });

  async function nextUp(
    asks: Record<string, KeptAsk>,
  ): Promise<{ box: HTMLElement; panel: Panel; buttons: () => string[] }> {
    const p = panel(asks, { 'hfos-auto': { ok: true, value: status } });
    const { startStatus } = await import('../src/panel/status');
    const box = p.document.createElement('section');
    p.document.body.append(box);
    startStatus(box);
    await settle();
    return {
      box,
      panel: p,
      buttons: () => [...box.querySelectorAll('button')].map((b) => b.textContent ?? ''),
    };
  }

  it('says what to do, and to press Carry on in HandsFreeOS → Needs you, with a link there; only Stop is here', async () => {
    const handed =
      'Couldn’t find that step on the page. Press Download beside your file. Then press Carry on.';
    const {
      box,
      panel: p,
      buttons,
    } = await nextUp({
      [ASK_KEY]: askUnder({ state: 'stuck', line: handed }),
    });
    const text = box.textContent ?? '';
    expect(text).toContain('Asked from HandsFreeOS: Download your Facebook file');
    expect(text).toContain(handed);
    expect(text).toContain('When you’ve done it, press Carry on in HandsFreeOS → Needs you.');
    expect(buttons()).toEqual(['Stop']);
    const link = [...box.querySelectorAll('a')].find((a) => a.textContent === 'Open Needs you')!;
    expect(link.href).toBe(NEEDS_YOU);
    expect(link.target).toBe('_blank');
    // Stop still stops it, from here.
    box.querySelector('button')!.click();
    await settle();
    expect(p.sent).toContainEqual({
      type: 'hfos-ask-stop',
      askId: '4c3b2a1d-0e9f-4a8b-8c7d-6e5f4a3b2c1d',
    });
    expect(p.sent.some((m) => m.type === 'hfos-ask-reply')).toBe(false);
  });

  it('names Skip there too, for someone ticked, on any network', async () => {
    const { box, buttons } = await nextUp({
      [askKeyOf('linkedin')]: askUnder({
        platform: 'linkedin',
        kind: 'cancel',
        about: 'Sam Lee',
        state: 'stuck',
        line: 'Couldn’t withdraw the invitation to Sam Lee. Then press Carry on, or Skip.',
      }),
    });
    expect(box.textContent).toContain('Asked from HandsFreeOS, on LinkedIn: ');
    expect(box.textContent).toContain(
      'When you’ve done it, press Carry on in HandsFreeOS → Needs you, or Skip to leave this person.',
    );
    expect(buttons()).toEqual(['Stop']);
    expect(box.querySelector('a')!.href).toBe(NEEDS_YOU);
  });

  it('while it works, or waits for a password, says what it’s doing, with Stop and nothing to carry on', async () => {
    for (const under of [askUnder({}), askUnder({ state: 'typing', line: ASK_TYPING_WORDS })]) {
      const { box, buttons } = await nextUp({ [ASK_KEY]: under });
      expect(box.textContent).toContain(under.line!);
      expect(box.textContent).not.toContain('Carry on');
      expect(box.querySelector('a')).toBeNull();
      expect(buttons()).toEqual(['Stop']);
    }
  });
});

describe('Get ready, with your profile as advice (decision 90)', () => {
  /** Get ready's items: the profile's state and what's left of it, and the rest done or not. */
  const ready = (profile: 'done' | 'todo', rest: 'done' | 'todo', more: { ready: boolean }) => ({
    ready: more.ready,
    items: [
      { item: 'offer' as const, state: rest, left: null },
      { item: 'playbook' as const, state: 'done' as const, left: null },
      {
        item: 'profile' as const,
        state: profile,
        left: profile === 'done' ? null : '2 things left to change on your Facebook profile',
      },
      { item: 'messages' as const, state: 'done' as const, left: null },
      { item: 'numbers' as const, state: 'done' as const, left: null },
    ],
  });

  async function drawn(shown: ReturnType<typeof ready>): Promise<HTMLElement> {
    const status = {
      automation: { settings: { sending: 'steps' } } as unknown as AutoStatus['automation'],
      trouble: null,
      businessId: 'b-one',
      noting: true,
      state: freshState('2026-10-26'),
      webUrl: WEB,
      live: null,
      warned: null,
      pastLimit: null,
      ready: shown,
    } satisfies AutoStatus;
    const p = panel({}, { 'hfos-auto': { ok: true, value: status } });
    const { startStatus } = await import('../src/panel/status');
    const box = p.document.createElement('section');
    p.document.body.append(box);
    startStatus(box);
    await settle();
    return box;
  }

  const TODAY = `${WEB}/app/w/b-one/a/outreach?view=today`;

  it('counts only what holds the day, and says under the profile that the day doesn’t wait on it', async () => {
    const box = await drawn(ready('todo', 'todo', { ready: false }));
    expect(box.textContent).toContain('1 thing to do before the extension reaches anyone for you.');
    const profile = box.querySelector('[data-testid="panel-ready-profile"]')!;
    expect(profile.className).toBe('next advice');
    expect(profile.textContent).toContain('2 things left to change on your Facebook profile');
    expect(profile.textContent).toContain(
      'Your day doesn’t wait on this one: finish it before or after you start.',
    );
    expect(box.querySelector('[data-testid="panel-ready-offer"]')!.className).toBe('next');
    expect(box.querySelector('[data-testid="panel-advice"]')).toBeNull();
  });

  it('shows the profile left beside Start once nothing else holds the day, with where to finish it', async () => {
    const box = await drawn(ready('todo', 'done', { ready: true }));
    expect(box.querySelector('[data-testid="panel-ready"]')).toBeNull();
    expect([...box.querySelectorAll('button')].map((b) => b.textContent)).toContain('Start my day');
    const advice = box.querySelector('[data-testid="panel-advice"]')!;
    expect(advice.textContent).toContain(
      'Your profile · 2 things left to change on your Facebook profile',
    );
    expect(advice.textContent).toContain('You can start now and finish it later.');
    const link = advice.querySelector('a')!;
    expect([link.textContent, link.href, link.target]).toEqual([
      'Check your profile',
      TODAY,
      '_blank',
    ]);
  });

  it('shows no advice once the profile’s done too', async () => {
    const box = await drawn(ready('done', 'done', { ready: true }));
    expect(box.querySelector('[data-testid="panel-advice"]')).toBeNull();
  });
});

describe('the day’s buttons (decision 95)', () => {
  /** 10 AM to 10 PM on weekdays, on Chicago's clock. */
  const automation = {
    settings: { sending: 'steps', hours: { start: 10, end: 22, days: [1, 2, 3, 4, 5] } },
    timezone: 'America/Chicago',
  } as unknown as AutoStatus['automation'];

  /** The panel's buttons at `now`, with the day as the runner keeps it. */
  async function buttons(now: number, state = freshState('2026-10-28')): Promise<string[]> {
    vi.setSystemTime(now);
    const status = {
      automation,
      trouble: null,
      businessId: 'b-one',
      noting: true,
      state,
      webUrl: WEB,
      live: null,
      warned: null,
      pastLimit: null,
    } satisfies AutoStatus;
    const p = panel({}, { 'hfos-auto': { ok: true, value: status } });
    const { startStatus } = await import('../src/panel/status');
    const box = p.document.createElement('section');
    p.document.body.append(box);
    startStatus(box);
    await settle();
    return [...box.querySelectorAll('button')].map((b) => b.textContent ?? '');
  }

  // Wednesday 28 Oct 2026: 4:50 PM in Chicago, in the hours; 8 AM, before them.
  const inHours = Date.UTC(2026, 9, 28, 21, 50);
  const early = Date.UTC(2026, 9, 28, 13);

  it('has only Stop for today while the day goes on its own in the working hours', async () => {
    expect(await buttons(inHours)).toEqual(['Stop for today']);
  });

  it('has Start my day before the hours, and only Stop for today once started', async () => {
    expect(await buttons(early)).toEqual(['Start my day', 'Stop for today']);
    expect(await buttons(early, { ...freshState('2026-10-28'), started: true })).toEqual([
      'Stop for today',
    ]);
  });

  it('has only Start my day once stopped for today, in the hours too', async () => {
    expect(await buttons(inHours, { ...freshState('2026-10-28'), stopped: 'person' })).toEqual([
      'Start my day',
    ]);
  });
});

describe('asking HandsFreeOS for the day again (0.152.0)', () => {
  const day = {
    date: '2026-11-23',
    state: 'started',
    why: null,
    via: 'web',
    at: '2026-11-23T15:00:00.000Z',
  };
  /** A beat's answer as the background keeps it: only when it was kept moves, unless `more` says so. */
  const answer = (more: Record<string, unknown> = {}) => ({
    computerId: '00000000-0000-4000-8000-000000000001',
    name: 'Chrome on Windows',
    working: true,
    workingName: null,
    day,
    days: {},
    stepsKept: [],
    asks: 0,
    watched: false,
    ...ME,
    at: Date.now(),
    ...more,
  });
  /** What the background answers: the day's steps and Get ready, as HandsFreeOS last said. */
  const shown = (more: Partial<AutoStatus> = {}): AutoStatus => ({
    automation: {
      settings: { sending: 'steps', hours: { start: 10, end: 22, days: [1, 2, 3, 4, 5] } },
      timezone: 'America/Chicago',
    } as unknown as AutoStatus['automation'],
    trouble: null,
    businessId: 'b-one',
    noting: true,
    state: freshState('2026-11-23'),
    webUrl: WEB,
    live: { working: true, workingName: null },
    warned: null,
    pastLimit: null,
    today: {
      limits: Object.fromEntries(
        DAILY_STEPS.map((step) => [step, { done: 1, most: 10 }]),
      ) as unknown as NonNullable<AutoStatus['today']>['limits'],
      steps: [],
    },
    ready: { ready: true, items: [] },
    ...more,
  });
  const askUnder: KeptAsk = {
    ...ME,
    askId: '4c3b2a1d-0e9f-4a8b-8c7d-6e5f4a3b2c1d',
    platform: 'facebook',
    kind: 'file_download',
    about: null,
    state: 'working',
    line: 'Opening your Facebook file’s page…',
    at: Date.now(),
  };

  /** The panel open on `status`, with the last beat's answer kept: how often it asked, and a new answer kept. */
  async function open(
    status: unknown = { ok: true, value: shown() },
    kept: Record<string, unknown> = {},
  ) {
    const p = panel({ [LIVE_KEY]: answer(), ...kept }, { 'hfos-auto': status });
    const { startStatus, STATUS_FOR_MS, STATUS_SOON_MS } = await import('../src/panel/status');
    const box = p.document.createElement('section');
    p.document.body.append(box);
    startStatus(box);
    await settle();
    return {
      panel: p,
      asked: () => p.sent.filter((m) => m.type === 'hfos-auto').length,
      beat: async (more: Record<string, unknown> = {}) => {
        p.change({ [LIVE_KEY]: answer(more) });
        await settle();
      },
      STATUS_FOR_MS,
      STATUS_SOON_MS,
    };
  }

  it('asks as it opens, and nothing for a beat’s answer that says nothing new', async () => {
    const { asked, beat } = await open();
    expect(asked()).toBe(1);
    for (let i = 0; i < 3; i++) await beat();
    expect(asked()).toBe(1);
  });

  it('asks when an answer took a step, says another computer works, or the day moved', async () => {
    const { asked, beat } = await open();
    await beat({ stepsKept: ['7d0c4b9e-1f2a-4c3b-8d5e-6f7a8b9c0d1e'] });
    expect(asked()).toBe(2);
    // The next one took none: nothing moved, though its list isn't the last one's.
    await beat();
    expect(asked()).toBe(2);
    const standing = { working: false, workingName: 'Chrome on Mac' };
    await beat(standing);
    expect(asked()).toBe(3);
    await beat(standing);
    expect(asked()).toBe(3);
    await beat({ ...standing, day: { ...day, state: 'stopped', why: 'person' } });
    expect(asked()).toBe(4);
  });

  it('asks after the person used this computer: a step of their own counts against the limits', async () => {
    const { asked, beat, panel: p } = await open();
    p.change({ [LIVE_ACTIVE_KEY]: { ...ME, at: Date.now() } });
    await settle();
    // Nothing yet: the beat that tells HandsFreeOS so hasn't been answered.
    expect(asked()).toBe(1);
    p.change({ [LIVE_ACTIVE_KEY]: undefined });
    await beat();
    expect(asked()).toBe(2);
    await beat();
    expect(asked()).toBe(2);
  });

  it('asks again once the last look is five minutes old', async () => {
    const { asked, beat, STATUS_FOR_MS } = await open();
    const from = Date.now();
    vi.setSystemTime(from + STATUS_FOR_MS - 30_000);
    await beat();
    expect(asked()).toBe(1);
    vi.setSystemTime(from + STATUS_FOR_MS + 1_000);
    await beat();
    expect(asked()).toBe(2);
    // And not again for the next five.
    await beat();
    expect(asked()).toBe(2);
  });

  it('asks with the minute’s beat while Get ready holds the day, or an ask is under way here', async () => {
    const holding = shown({
      ready: { ready: false, items: [{ item: 'offer', state: 'todo', left: null }] },
    });
    // One panel at a time: each open takes the page and the background's stand-in for itself.
    for (const opening of [
      () => open({ ok: true, value: holding }),
      () => open(undefined, { [ASK_KEY]: askUnder }),
    ]) {
      const opened = await opening();
      const from = Date.now();
      vi.setSystemTime(from + 10_000);
      await opened.beat();
      expect(opened.asked()).toBe(1);
      vi.setSystemTime(from + opened.STATUS_SOON_MS + 1_000);
      await opened.beat();
      expect(opened.asked()).toBe(2);
    }
  });

  it('asks when an ask under way here ends, and not for its line', async () => {
    const { asked, panel: p } = await open(undefined, { [ASK_KEY]: askUnder });
    p.change({ [ASK_KEY]: { ...askUnder, line: 'Waiting for Facebook to make your file…' } });
    await settle();
    expect(asked()).toBe(1);
    p.change({ [ASK_KEY]: undefined });
    await settle();
    expect(asked()).toBe(2);
  });

  it('asks on every answer while the last look failed, or HandsFreeOS couldn’t say', async () => {
    const failed = await open({
      ok: false,
      problem: { message: 'Couldn’t reach HandsFreeOS.', rule: null, status: null, recheck: false },
    });
    await failed.beat();
    await failed.beat();
    expect(failed.asked()).toBe(3);
    // A new panel, once the first is done with.
    const unsaid = await open({ ok: true, value: shown({ today: null }) });
    await unsaid.beat();
    expect(unsaid.asked()).toBe(2);
  });

  it('asks nothing while nobody can see the panel, whatever changed', async () => {
    const { asked, beat, panel: p } = await open();
    Object.defineProperty(p.document, 'visibilityState', { value: 'hidden', configurable: true });
    await beat({ stepsKept: ['7d0c4b9e-1f2a-4c3b-8d5e-6f7a8b9c0d1e'] });
    p.change({ [SETTINGS_KEY]: { settings: { sending: 'off' } } });
    await settle();
    expect(asked()).toBe(1);
    // Shown again: the next answer with something new asks (and the panel's own page asks at once: panel.ts).
    Object.defineProperty(p.document, 'visibilityState', { value: 'visible', configurable: true });
    await beat({ asks: 1 });
    expect(asked()).toBe(2);
  });
});

describe('the version at the top', () => {
  it('says this build’s version in the top bar, in the words beside the download in HandsFreeOS', async () => {
    // The panel's own page: its script isn't run here, only its top bar read.
    const { window } = new JSDOM(
      readFileSync(new URL('../public/panel.html', import.meta.url), 'utf8'),
    );
    vi.stubGlobal('chrome', { runtime: { getManifest: () => ({ version: '0.151.0' }) } });
    const { showVersion } = await import('../src/panel/version');
    const into = window.document.querySelector<HTMLElement>('header.top #version')!;
    expect(into.textContent).toBe('');
    showVersion(into);
    expect(into.textContent).toBe('Version 0.151.0');
    expect(EXTENSION_DOWNLOAD_WORDS.about('0.151.0', null, null)).toBe(
      'Version 0.151.0 · for Chrome on a computer',
    );
    // The business it works for stays beside it, hidden until someone's signed in.
    const where = window.document.querySelector<HTMLElement>('header.top #where')!;
    expect(where.hidden).toBe(true);
    expect(where.nextElementSibling).toBe(into);
  });
});
