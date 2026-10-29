/**
 * Before the person's day, their own lists (src/auto/lists.ts, docs/outreach.md "Lists first"). The owner's decision:
 * first day only. The first time, nothing runs till their friends list and friend requests, got and sent, are saved;
 * after that the requests each morning and the friends list weekly; then, once, Tidy up and a check of their friends.
 */
import { describe, expect, it, vi } from 'vitest';
import { NO_LISTS, type ListsSaved } from '@hfos/core/addons/outreach/lists';
import { freshState, listTurn } from '../src/auto/plan';
import { readPage } from '../src/networks/facebook/page';
import { requestsPage } from '../src/networks/facebook/friends';
import type { HfosAsk } from '../src/hfos/messages';
import type { Hfos, Job, JobTab } from '../src/jobs/job';
import { load } from './load';

vi.mock('../src/jobs/job', async (original) => ({
  ...(await original<object>()),
  pause: () => Promise.resolve(),
}));

const { beforeDay, beforeDayDoing, beforeDayLine, doBeforeDay, holdsTheDay, markOf } =
  await import('../src/auto/lists');
const { checkSent, FRIEND_REQUESTS } = await import('../src/jobs/people');

const BUSINESS = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const TZ = 'America/Chicago';
/** 10 a.m. on Tuesday, October 13 2026, in Chicago. */
const NOW = Date.parse('2026-10-13T15:00:00Z');
const DAY = 86_400_000;
const at = (ms: number) => new Date(ms).toISOString();

const saved = (more: Partial<ListsSaved> = {}): ListsSaved => ({
  friendsAt: at(NOW - 2 * DAY),
  requestsAt: at(NOW - 60_000),
  sentAt: at(NOW - 60_000),
  groupsAt: at(NOW - 2 * DAY),
  groupChecksAt: at(NOW - 2 * DAY),
  tidyAt: at(NOW - 2 * DAY),
  checksAt: at(NOW - 2 * DAY),
  ...more,
});

describe('what comes before the day', () => {
  it('the first time, saves the friends list, then requests got, then sent, before anything else', () => {
    expect(beforeDay(NO_LISTS, {}, NOW, TZ)).toEqual({ do: 'save', list: 'friends', first: true });
    const friends = { ...NO_LISTS, friendsAt: at(NOW) };
    expect(beforeDay(friends, {}, NOW, TZ)).toEqual({ do: 'save', list: 'requests', first: true });
    expect(beforeDay({ ...friends, requestsAt: at(NOW) }, {}, NOW, TZ)).toEqual({
      do: 'save',
      list: 'sent',
      first: true,
    });
  });

  it('the first time, tries a list again till it’s saved, even one that went wrong today', () => {
    expect(beforeDay(NO_LISTS, { friends: 'Facebook showed no friends.' }, NOW, TZ)).toEqual({
      do: 'save',
      list: 'friends',
      first: true,
    });
  });

  it('the first time, saves the groups after the lists, and checks them before anything else', () => {
    const lists = { ...NO_LISTS, friendsAt: at(NOW), requestsAt: at(NOW), sentAt: at(NOW) };
    expect(beforeDay(lists, {}, NOW, TZ)).toEqual({ do: 'save', list: 'groups', first: true });
    const groups = { ...lists, groupsAt: at(NOW) };
    expect(beforeDay(groups, {}, NOW, TZ)).toEqual({ do: 'group_checks' });
    // Like the lists, the first check of the groups is tried again till it's done.
    expect(beforeDay(groups, { group_checks: 'Try again in a minute.' }, NOW, TZ)).toEqual({
      do: 'group_checks',
    });
    expect(beforeDay({ ...groups, groupChecksAt: at(NOW) }, {}, NOW, TZ)).toEqual({ do: 'tidy' });
  });

  it('then the groups again weekly, and a refresh that went wrong never holds the day up', () => {
    expect(beforeDay(saved({ groupsAt: at(NOW - 6 * DAY) }), {}, NOW, TZ)).toBeNull();
    expect(beforeDay(saved({ groupsAt: at(NOW - 7 * DAY) }), {}, NOW, TZ)).toEqual({
      do: 'save',
      list: 'groups',
      first: false,
    });
    expect(
      beforeDay(saved({ groupsAt: at(NOW - 8 * DAY) }), { groups: 'Went wrong.' }, NOW, TZ),
    ).toBeNull();
  });

  it('right after the first full save, works out Tidy up, then checks friends once', () => {
    const lists = {
      ...NO_LISTS,
      friendsAt: at(NOW),
      requestsAt: at(NOW),
      sentAt: at(NOW),
      groupsAt: at(NOW),
      groupChecksAt: at(NOW),
    };
    expect(beforeDay(lists, {}, NOW, TZ)).toEqual({ do: 'tidy' });
    expect(beforeDay({ ...lists, tidyAt: at(NOW) }, {}, NOW, TZ)).toEqual({ do: 'checks' });
    expect(beforeDay({ ...lists, tidyAt: at(NOW), checksAt: at(NOW) }, {}, NOW, TZ)).toBeNull();
    // One that went wrong today waits for tomorrow, so it never holds the day up.
    expect(beforeDay(lists, { tidy: 'Try again in a minute.' }, NOW, TZ)).toBeNull();
  });

  it('after that, saves the requests again each morning, and the friends list once a week', () => {
    expect(beforeDay(saved(), {}, NOW, TZ)).toBeNull();
    const yesterday = at(NOW - DAY);
    expect(beforeDay(saved({ requestsAt: yesterday, sentAt: yesterday }), {}, NOW, TZ)).toEqual({
      do: 'save',
      list: 'requests',
      first: false,
    });
    expect(beforeDay(saved({ sentAt: yesterday }), {}, NOW, TZ)).toEqual({
      do: 'save',
      list: 'sent',
      first: false,
    });
    expect(beforeDay(saved({ friendsAt: at(NOW - 6 * DAY) }), {}, NOW, TZ)).toBeNull();
    expect(beforeDay(saved({ friendsAt: at(NOW - 7 * DAY) }), {}, NOW, TZ)).toEqual({
      do: 'save',
      list: 'friends',
      first: false,
    });
    // A morning's refresh that went wrong isn't tried again today: the day goes on.
    expect(
      beforeDay(saved({ requestsAt: yesterday }), { requests: 'Something went wrong.' }, NOW, TZ),
    ).toBeNull();
  });

  it('says why it waits the first time, and what it’s doing after', () => {
    expect(beforeDayDoing({ do: 'save', list: 'friends', first: true })).toBe(
      'Saving your friends list first…',
    );
    expect(beforeDayDoing({ do: 'save', list: 'requests', first: false })).toBe(
      'Saving your friend requests before your day…',
    );
    expect(
      beforeDayLine({ do: 'save', list: 'sent', first: true }, { line: 'Saved 3.', warned: false }),
    ).toBe('Sent requests: Saved 3.');
  });

  it('takes turns with the list, but for the first save and the first check of the groups (decision 123)', () => {
    // The first save of the lists, and the first check of the groups, hold the whole day (decision 60).
    expect(holdsTheDay({ do: 'save', list: 'friends', first: true })).toBe(true);
    expect(holdsTheDay({ do: 'group_checks' })).toBe(true);
    // The morning's requests, the weekly friends list, Tidy up and the check of friends take turns with the list.
    expect(holdsTheDay({ do: 'save', list: 'requests', first: false })).toBe(false);
    expect(holdsTheDay({ do: 'tidy' })).toBe(false);
    expect(holdsTheDay({ do: 'checks' })).toBe(false);
    expect(holdsTheDay(null)).toBe(false);

    // A day's first go reads; after a part of the reading, a step on the list; after a step, the reading again.
    expect(listTurn(freshState('2026-10-13'), true, false)).toBe(false);
    expect(listTurn({ readLast: true }, true, false)).toBe(true);
    expect(listTurn({ readLast: false }, true, false)).toBe(false);
    // A state kept by 0.111 has none: it reads first.
    expect(listTurn({}, true, false)).toBe(false);
    // A first save holds the day whatever went last, and with no reading left the list goes anyway.
    expect(listTurn({ readLast: true }, true, true)).toBe(false);
    expect(listTurn({ readLast: true }, false, false)).toBe(false);
  });

  it('a fresh day starts with nothing done before it', () => {
    expect(freshState('2026-10-13').before).toEqual({});
  });
});

/** The requests page, and the box View sent requests opens over it once pressed. */
function requestsTab(found: 'done' | 'missing' = 'done') {
  let pressed = false;
  const asked: { readonly type: string; readonly lists?: boolean }[] = [];
  const opened: string[] = [];
  const tab = {
    async open(url: string) {
      opened.push(url);
      pressed = false;
    },
    async ask(message: { readonly type: string; readonly lists?: boolean }) {
      asked.push(message);
      if (message.type === 'hfos-fetch-step') {
        pressed = found === 'done';
        return { ok: true, result: found };
      }
      if (message.type === 'hfos-read') {
        const name = pressed ? 'friend-requests-sent-2026.html' : 'friend-requests-2026.html';
        return { ok: true, result: readPage(load(name, FRIEND_REQUESTS), FRIEND_REQUESTS) };
      }
      return { ok: false };
    },
  } as unknown as JobTab;
  return { tab, asked, opened };
}

function fakeHfos() {
  const sent: HfosAsk[] = [];
  const hfos = (async (ask: HfosAsk) => {
    sent.push(ask);
    switch (ask.type) {
      case 'hfos-save-friends':
        return { ok: true, value: { saved: ask.input.people.length, added: 0, changed: 0 } };
      case 'hfos-lists-saved':
        return { ok: true, value: NO_LISTS };
      case 'hfos-groups-to-check':
        return { ok: true, value: { groups: [], saved: 0 } };
      case 'hfos-tidy':
        return {
          ok: true,
          value: { cancel: [], unfriend: [], totals: { cancel_request: 4, unfriend: 1 } },
        };
      default:
        throw new Error(`Not expected: ${ask.type}`);
    }
  }) as unknown as Hfos;
  return { hfos, sent };
}

const jobOf = (tab: JobTab, hfos: Hfos, stopped = () => false): Job => ({
  tab,
  hfos,
  businessId: BUSINESS,
  stopped,
  progress: () => undefined,
  warn: async () => undefined,
});

describe('saving the requests you’ve sent', () => {
  it('presses View sent requests on your own requests page, and saves who’s in the box', async () => {
    const { tab, asked, opened } = requestsTab();
    const { hfos, sent } = fakeHfos();
    const end = await checkSent(jobOf(tab, hfos));
    expect(opened).toEqual([FRIEND_REQUESTS]);
    expect(asked.find((a) => a.type === 'hfos-fetch-step')).toMatchObject({ lists: true });
    const saves = sent.filter((a) => a.type === 'hfos-save-friends');
    expect(saves[0]).toMatchObject({ input: { list: 'sent' } });
    expect(
      (saves[0] as Extract<HfosAsk, { type: 'hfos-save-friends' }>).input.people.map((p) => p.name),
    ).toEqual(['Morgan Ellis', 'Drew Kim', 'Taylor Reed']);
    expect(end).toEqual({ line: 'Saved 3 sent requests.', warned: false, whole: true });
  });

  it('says what to check when View sent requests isn’t there, and saves nothing', async () => {
    const { tab } = requestsTab('missing');
    const { hfos, sent } = fakeHfos();
    const end = await checkSent(jobOf(tab, hfos));
    expect(end.failed).toBe(true);
    expect(end.line).toContain('signed in to Facebook');
    expect(sent).toEqual([]);
  });

  it('presses only on your own friend requests page', () => {
    expect(requestsPage('https://www.facebook.com/friends/requests/')).toBe(true);
    expect(requestsPage('https://www.facebook.com/friends/list')).toBe(false);
    expect(requestsPage('https://www.facebook.com/dana.reyes')).toBe(false);
  });
});

describe('doing what comes before the day', () => {
  it('notes a list saved to its end in HandsFreeOS', async () => {
    const { tab } = requestsTab();
    const { hfos, sent } = fakeHfos();
    await doBeforeDay({ do: 'save', list: 'sent', first: true }, jobOf(tab, hfos));
    expect(sent.at(-1)).toEqual({
      type: 'hfos-lists-saved',
      workspaceId: BUSINESS,
      list: 'sent',
      platform: 'facebook',
    });
  });

  it('doesn’t note one that went wrong, or the person stopped part way', async () => {
    const missing = fakeHfos();
    await doBeforeDay(
      { do: 'save', list: 'sent', first: true },
      jobOf(requestsTab('missing').tab, missing.hfos),
    );
    expect(missing.sent.some((a) => a.type === 'hfos-lists-saved')).toBe(false);
    const stopped = fakeHfos();
    await doBeforeDay(
      { do: 'save', list: 'requests', first: true },
      jobOf(requestsTab().tab, stopped.hfos, () => true),
    );
    expect(stopped.sent.some((a) => a.type === 'hfos-lists-saved')).toBe(false);
  });

  it('works out Tidy up once, and says where to tick them', async () => {
    const { hfos, sent } = fakeHfos();
    const end = await doBeforeDay({ do: 'tidy' }, jobOf(requestsTab().tab, hfos));
    expect(sent.map((a) => a.type)).toEqual(['hfos-tidy', 'hfos-lists-saved']);
    expect(end.line).toBe(
      'Suggested 4 old requests to cancel and 1 friend to unfriend. Tick the ones to go under Friends → Tidy up in HandsFreeOS.',
    );
  });

  it('checks the groups once, and notes it, even with none saved yet', async () => {
    const { hfos, sent } = fakeHfos();
    const end = await doBeforeDay({ do: 'group_checks' }, jobOf(requestsTab().tab, hfos));
    expect(sent.map((a) => a.type)).toEqual(['hfos-groups-to-check', 'hfos-lists-saved']);
    expect(sent.at(-1)).toEqual({
      type: 'hfos-lists-saved',
      workspaceId: BUSINESS,
      list: 'group_checks',
      platform: 'facebook',
    });
    expect(beforeDayLine({ do: 'group_checks' }, end)).toMatch(/^Check my groups: /);
    expect(beforeDayDoing({ do: 'group_checks' })).toBe('Checking your groups first…');
  });

  it('names the step it notes, for the live checklist', () => {
    expect(markOf({ do: 'save', list: 'groups', first: true })).toBe('groups');
    expect(markOf({ do: 'group_checks' })).toBe('group_checks');
    expect(markOf({ do: 'checks' })).toBe('checks');
  });
});
