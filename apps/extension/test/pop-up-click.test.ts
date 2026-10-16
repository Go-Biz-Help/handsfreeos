/**
 * A click on one of the extension's pop-ups about what waits (src/hfos/waiting.ts), or on its button, opens Needs you
 * in HandsFreeOS in a tab, never the side panel, which shows progress only (docs/outreach.md, decision 72). A step an
 * ask hands the person pops up the same way, and its Carry on is there too.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const WEB = 'https://app.handsfreeos.com';
const ME = { userId: 'u-dana', businessId: 'b-one' };

/** Who's signed in here, and to which business: null when nobody is. */
const signed = vi.hoisted(() => ({
  place: null as { userId: string; businessId: string } | null,
}));

vi.mock('../src/hfos/config', () => ({
  config: { apiUrl: '', workerUrl: '', webUrl: 'https://app.handsfreeos.com' },
}));
vi.mock('../src/hfos/session', () => ({
  Refused: class extends Error {},
  savingTo: async () => signed.place,
  answerWith: async () => ({ ok: true, value: null }),
  api: () => ({}),
  call: async () => null,
}));
vi.mock('../src/hfos/live', () => ({ keptFor: async () => null, samePlace: () => true }));

const { openWaiting, POPUP_ID } = await import('../src/hfos/waiting');

const opened: string[] = [];
const cleared: string[] = [];
const panels: unknown[] = [];

beforeEach(() => {
  signed.place = { ...ME };
  opened.length = 0;
  cleared.length = 0;
  panels.length = 0;
  vi.stubGlobal('chrome', {
    notifications: { clear: async (id: string) => (cleared.push(id), true) },
    tabs: { create: async ({ url }: { url: string }) => (opened.push(url), { id: 1 }) },
    sidePanel: { open: async (options: unknown) => void panels.push(options) },
    windows: { getLastFocused: async () => ({ id: 3 }) },
  });
});
afterEach(() => vi.unstubAllGlobals());

const until = async (ok: () => boolean) => {
  for (let i = 0; i < 100 && !ok(); i++) await new Promise((done) => setTimeout(done, 1));
  expect(ok()).toBe(true);
};

describe('a pop-up clicked', () => {
  it('opens Needs you in HandsFreeOS in a tab, never the side panel', async () => {
    openWaiting(POPUP_ID);
    await until(() => opened.length > 0);
    expect(opened).toEqual([`${WEB}/app/w/b-one/a/outreach?view=today#needs-you`]);
    expect(cleared).toEqual([POPUP_ID]);
    expect(panels).toEqual([]);
  });

  it('does the same for a message’s own pop-up, and for a step an ask handed over', async () => {
    for (const id of [`${POPUP_ID}-c0c0c0c0`, `${POPUP_ID}-ask-4c3b2a1d`]) openWaiting(id);
    await until(() => opened.length === 2);
    expect(opened).toEqual([
      `${WEB}/app/w/b-one/a/outreach?view=today#needs-you`,
      `${WEB}/app/w/b-one/a/outreach?view=today#needs-you`,
    ]);
    expect(panels).toEqual([]);
  });

  it('opens HandsFreeOS itself when nobody is signed in, and leaves other pop-ups alone', async () => {
    signed.place = null;
    openWaiting('someone-elses');
    openWaiting(POPUP_ID);
    await until(() => opened.length > 0);
    expect(opened).toEqual([WEB]);
    expect(cleared).toEqual([POPUP_ID]);
  });
});
