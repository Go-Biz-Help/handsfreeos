/**
 * The side panel shows progress and activity only (docs/outreach.md, decision 72): what needs the person is one line
 * under Next up, "3 things need you in HandsFreeOS", linking to Needs you there (src/panel/needs.ts); and a step an ask
 * hands them says what to do and to press Carry on in HandsFreeOS → Needs you, with a link, and keeps only Stop
 * (src/panel/status.ts). The background and HandsFreeOS are stood in for.
 */
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ASK_TYPING_WORDS } from '@hfos/core/addons/outreach/asks';
import { freshState } from '../src/auto/plan';
import { ASK_KEY, askKeyOf, type KeptAsk } from '../src/hfos/asks';
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

type Changed = (changes: Record<string, { newValue?: unknown }>, area: string) => void;

interface Panel {
  readonly document: Document;
  /** What the panel asked the background. */
  readonly sent: { readonly type: string; readonly [key: string]: unknown }[];
  /** A change to the extension's storage, as the background writes it. */
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
      for (const [k, v] of Object.entries(values)) store.set(k, v);
      const changes = Object.fromEntries(
        Object.entries(values).map(([k, v]) => [k, { newValue: v }]),
      );
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
