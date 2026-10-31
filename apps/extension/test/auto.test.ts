/**
 * Working on its own (src/auto/plan.ts, src/networks/facebook/auto.ts): what it does next and when, and the buttons it
 * presses. On made-up 2026 pages: a profile whose button behaves like Facebook's (Add friend becomes Cancel request;
 * Respond opens a menu with Confirm), its post's Like, and a group post's box to comment in, never a reply's; and a
 * message's box, only the chat's that is with them: Messenger's, or their chat window's among others left open.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TodayListItem } from '../src/hfos/messages';
import {
  gapAfter,
  GAP_MS,
  itemKey,
  itemsLeft,
  networkDay,
  networkWaitWords,
  nextStart,
  nextWatch,
  STARTED_GAP_MS,
  watchDue,
  workKey,
  workLeft,
} from '../src/auto/plan';
import {
  AUTO_PLANS,
  chatsOpen,
  likeTheirPost,
  readTheirPosts,
  MESSAGE_PATH,
  openMessage,
  sameByKey,
  sameRef,
  theirPosts,
  withTheirName,
  writeComment,
  writeMessage,
  type ChatsBefore,
} from '../src/networks/facebook/auto';
import { doPath, doStep, findStep, type FetchStep } from '../src/networks/facebook/fetch';
import { likeStateOf } from '../src/networks/facebook/posts';
import { readPage } from '../src/networks/facebook/page';
import { boxEverything, load } from './load';

const FB = 'https://www.facebook.com';
const URL = `${FB}/dana.reyes.12`;
const dana = { id: null, username: 'dana.reyes.12', url: URL };

const item = (more: Partial<TodayListItem>): TodayListItem => ({
  recent: [],
  kind: 'friend_request',
  name: 'Dana Reyes',
  profileId: '7b6f5c4d-3e2a-4b1c-8d9e-0f1a2b3c4d5e',
  profileUrl: URL,
  chatId: null,
  threadKey: null,
  postId: null,
  postUrl: null,
  posted: null,
  post: null,
  asking: false,
  why: [],
  summary: null,
  nextStep: null,
  playbookName: null,
  demoLink: null,
  videoLink: null,
  send: null,
  personId: null,
  demoBooked: false,
  ...more,
});

describe('what it does next', () => {
  it('goes in its own order, only the kinds it does for the person, each once a day', () => {
    const post = item({
      kind: 'comment',
      name: 'Sam Carter',
      profileId: '1b6f5c4d-3e2a-4b1c-8d9e-0f1a2b3c4d5e',
      postId: '2b6f5c4d-3e2a-4b1c-8d9e-0f1a2b3c4d5e',
      postUrl: `${FB}/groups/7766554433221100/posts/5555666677778888/`,
    });
    const confirm = item({
      kind: 'confirm',
      name: 'Lee Park',
      profileId: '3b6f5c4d-3e2a-4b1c-8d9e-0f1a2b3c4d5e',
    });
    const like = item({
      kind: 'warm_up',
      name: 'Ana Ruiz',
      profileId: '4b6f5c4d-3e2a-4b1c-8d9e-0f1a2b3c4d5e',
    });
    const request = item({});
    const message = item({
      kind: 'opener',
      name: 'Jo Hill',
      profileId: '5b6f5c4d-3e2a-4b1c-8d9e-0f1a2b3c4d5e',
    });
    const list = [post, message, request, like, confirm];
    const all = ['confirm', 'warm_up', 'friend_request', 'comment'] as const;
    // A friend request before a like (decision 138): one a like made ready goes before the next likes.
    expect(itemsLeft(list, all, []).map((i) => i.name)).toEqual([
      'Lee Park',
      'Dana Reyes',
      'Ana Ruiz',
      'Sam Carter',
    ]);
    // Messages wait for the person; a kind they didn't let it do stays theirs; one tried today isn't tried again.
    expect(
      itemsLeft(list, ['friend_request', 'comment'], [itemKey(request)]).map((i) => i.name),
    ).toEqual(['Sam Carter']);
    expect(itemsLeft([item({ profileUrl: null })], all, [])).toEqual([]);
    // A post asking for what the business offers goes before everything (decision 49).
    const asking = {
      ...post,
      name: 'Kim Ng',
      postId: '6b6f5c4d-3e2a-4b1c-8d9e-0f1a2b3c4d5e',
      asking: true,
    };
    expect(itemsLeft([...list, asking], all, []).map((i) => i.name)).toEqual([
      'Kim Ng',
      'Lee Park',
      'Dana Reyes',
      'Ana Ruiz',
      'Sam Carter',
    ]);
  });

  it('looks at the newest posts every hour or two, at random', () => {
    const now = Date.parse('2026-10-12T15:00:00Z');
    expect(nextWatch(now, 0) - now).toBe(60 * 60_000);
    expect(nextWatch(now, 1) - now).toBe(120 * 60_000);
    // A new day, or a state kept by 0.22, looks now; then not until it's due.
    expect(watchDue({ watchAt: null }, now)).toBe(true);
    expect(watchDue({}, now)).toBe(true);
    expect(watchDue({ watchAt: nextWatch(now, 0.5) }, now + 60 * 60_000)).toBe(false);
    expect(watchDue({ watchAt: nextWatch(now, 0.5) }, now + 90 * 60_000)).toBe(true);
  });

  it('sends messages OK’d first, and drafts the rest after the steps, or before them with Approve all', () => {
    const request = item({});
    const hi = item({
      kind: 'opener',
      name: 'Jo Hill',
      profileId: '5b6f5c4d-3e2a-4b1c-8d9e-0f1a2b3c4d5e',
      profileUrl: `${FB}/jo.hill.2`,
    });
    const ok = item({
      kind: 'follow_up',
      name: 'Kim Lee',
      profileId: '6b6f5c4d-3e2a-4b1c-8d9e-0f1a2b3c4d5e',
      threadKey: '100009000000002',
      profileUrl: null,
      send: {
        sendId: '7b6f5c4d-3e2a-4b1c-8d9e-0f1a2b3c4d5e',
        state: 'approved',
        text: 'Hi Kim',
        handedOver: false,
        needsYou: null,
      },
    });
    const waiting = item({
      kind: 'reply',
      name: 'Max Ford',
      profileId: '8b6f5c4d-3e2a-4b1c-8d9e-0f1a2b3c4d5e',
      send: {
        sendId: '9b6f5c4d-3e2a-4b1c-8d9e-0f1a2b3c4d5e',
        state: 'waiting',
        text: 'Thanks!',
        handedOver: false,
        needsYou: null,
      },
    });
    const nobody = item({ kind: 'opener', name: 'No Link', profileId: null });
    const list = {
      items: [request, hi, ok, waiting, nobody],
      auto: ['friend_request' as const],
      messages: ['opener' as const, 'follow_up' as const, 'reply' as const],
    };
    const what = (work: ReturnType<typeof workLeft>) => work.map((w) => `${w.do}: ${w.item.name}`);
    const steps = workLeft({ ...list, sending: 'steps' }, []);
    expect(what(steps)).toEqual(['send: Kim Lee', 'step: Dana Reyes', 'draft: Jo Hill']);
    expect(what(workLeft({ ...list, sending: 'approve_all' }, []))).toEqual([
      'send: Kim Lee',
      'draft: Jo Hill',
      'step: Dana Reyes',
    ]);
    // Each once a day; nothing while Sending is off.
    expect(what(workLeft({ ...list, sending: 'steps' }, steps.map(workKey)))).toEqual([]);
    expect(workKey(steps[0]!)).toBe('send:7b6f5c4d-3e2a-4b1c-8d9e-0f1a2b3c4d5e');
    expect(workLeft({ ...list, auto: [], messages: [], sending: 'off' }, [])).toEqual([]);
  });

  it('takes turns: each kind of step and the drafts, the one tried least today first (decision 138)', () => {
    const one = (kind: TodayListItem['kind'], name: string, n: number) =>
      item({
        kind,
        name,
        profileId: `${n}d6f5c4d-3e2a-4b1c-8d9e-0f1a2b3c4d5e`,
        profileUrl: `${FB}/p.${n}`,
      });
    const list = {
      items: [
        one('friend_request', 'r1', 1),
        one('friend_request', 'r2', 2),
        one('friend_request', 'r3', 3),
        one('warm_up', 'l1', 4),
        one('warm_up', 'l2', 5),
        one('warm_up', 'l3', 6),
        {
          ...one('comment', 'c1', 7),
          postId: '7e6f5c4d-3e2a-4b1c-8d9e-0f1a2b3c4d5e',
          postUrl: `${FB}/groups/austinsmallbiz/posts/9100000000000007/`,
        },
        one('opener', 'o1', 8),
        one('opener', 'o2', 9),
      ],
      auto: ['confirm', 'warm_up', 'friend_request', 'comment'] as TodayListItem['kind'][],
      messages: ['opener' as const],
    };
    const names = (work: ReturnType<typeof workLeft>) => work.map((w) => w.item.name);
    expect(names(workLeft({ ...list, sending: 'steps' }, []))).toEqual([
      'r1',
      'l1',
      'c1',
      'o1',
      'r2',
      'l2',
      'o2',
      'r3',
      'l3',
    ]);
    // Likes that kept failing today wait till the others have had as many turns: nothing waits on them.
    const failed = [10, 11, 12, 13, 14].map((n) => itemKey(one('warm_up', `x${n}`, n)));
    expect(names(workLeft({ ...list, sending: 'steps' }, failed))).toEqual([
      'r1',
      'c1',
      'o1',
      'r2',
      'o2',
      'r3',
      'l1',
      'l2',
      'l3',
    ]);
    // With Approve all, the drafts have the first turn.
    expect(names(workLeft({ ...list, sending: 'approve_all' }, []))).toEqual([
      'o1',
      'r1',
      'l1',
      'c1',
      'o2',
      'r2',
      'l2',
      'r3',
      'l3',
    ]);
  });

  it('holds what starts or nudges a conversation on a day that isn’t theirs, and does the rest (decision 139)', () => {
    const one = (kind: TodayListItem['kind'], name: string, n: number) =>
      item({
        kind,
        name,
        profileId: `${n}d6f5c4d-3e2a-4b1c-8d9e-0f1a2b3c4d5e`,
        profileUrl: `${FB}/p.${n}`,
      });
    const list: Parameters<typeof workLeft>[0] = {
      items: [
        one('reply', 'answer', 1),
        one('friend_request', 'request', 2),
        one('opener', 'first', 3),
        one('follow_up', 'nudge', 4),
        one('pitch', 'link', 5),
      ],
      auto: ['confirm', 'warm_up', 'friend_request', 'comment'],
      messages: ['reply', 'opener', 'follow_up', 'pitch'],
      sending: 'steps',
    };
    const names = (work: ReturnType<typeof workLeft>) => work.map((w) => w.item.name);
    expect(names(workLeft(list, []))).toEqual(['answer', 'request', 'first', 'nudge', 'link']);
    expect(names(workLeft({ ...list, newMessagesWait: true }, []))).toEqual([
      'answer',
      'request',
      'link',
    ]);
  });

  it('starts on its own on a day off too, unless the person turned that off (decision 139)', () => {
    const weekdays = { start: 10, end: 18, days: [1, 2, 3, 4, 5] };
    const saturday = { date: '2026-10-31', state: 'none', why: null } as const;
    const at = (hours: typeof weekdays & { everyDay?: boolean }) =>
      networkDay({
        day: saturday,
        today: '2026-10-31',
        hours,
        timeZone: 'America/Chicago',
        now: Date.UTC(2026, 9, 31, 17),
        random: 0,
      });
    expect(at(weekdays)).toEqual({ go: true, started: false, until: Date.UTC(2026, 9, 31, 23) });
    expect(at({ ...weekdays, everyDay: false })).toEqual({
      go: false,
      stopped: null,
      next: Date.UTC(2026, 10, 2, 16),
    });
  });

  it('drafts the day’s reply in a group only with its post, and sends it once OK’d (decision 114)', () => {
    const question = item({
      kind: 'group_reply',
      name: 'Lee Hart',
      profileId: '1c6f5c4d-3e2a-4b1c-8d9e-0f1a2b3c4d5e',
      profileUrl: `${FB}/lee.hart.3`,
      postId: '2c6f5c4d-3e2a-4b1c-8d9e-0f1a2b3c4d5e',
      postUrl: `${FB}/groups/austinsmallbiz/posts/9100000000000004/`,
    });
    const noPost = item({ ...question, name: 'No Post', postUrl: null });
    const list = { items: [question, noPost], auto: [], sending: 'steps' as const };
    const what = (work: ReturnType<typeof workLeft>) => work.map((w) => `${w.do}: ${w.item.name}`);
    expect(what(workLeft({ ...list, messages: ['group_reply'] }, []))).toEqual(['draft: Lee Hart']);
    // A build HandsFreeOS gives none to: none drafted.
    expect(workLeft({ ...list, messages: ['comment'] }, [])).toEqual([]);
    const okd = {
      ...question,
      send: {
        sendId: '3c6f5c4d-3e2a-4b1c-8d9e-0f1a2b3c4d5e',
        state: 'approved' as const,
        text: 'It opens at eight!',
        handedOver: false,
        needsYou: null,
      },
    };
    expect(what(workLeft({ ...list, items: [okd], messages: ['group_reply'] }, []))).toEqual([
      'send: Lee Hart',
    ]);
  });

  it('spreads the day’s steps over what’s left of the hours, and goes at a person’s pace after Start my day', () => {
    const now = Date.UTC(2026, 9, 9, 15);
    const hour = 3_600_000;
    // Two hours left and four steps: about half an hour apart, more or less by half.
    expect(gapAfter({ now, until: now + 2 * hour, left: 4, started: false, random: 0.5 })).toBe(
      hour / 2,
    );
    expect(gapAfter({ now, until: now + 2 * hour, left: 4, started: false, random: 0 })).toBe(
      hour / 4,
    );
    expect(gapAfter({ now, until: now + 2 * 60_000, left: 4, started: false, random: 0 })).toBe(
      GAP_MS.least,
    );
    expect(gapAfter({ now, until: now + 20 * hour, left: 1, started: false, random: 1 })).toBe(
      GAP_MS.most,
    );
    for (const random of [0, 0.5, 1]) {
      const gap = gapAfter({ now, until: now + 4 * hour, left: 4, started: true, random });
      expect(gap).toBeGreaterThanOrEqual(STARTED_GAP_MS.least);
      expect(gap).toBeLessThanOrEqual(STARTED_GAP_MS.most);
    }
  });

  it('starts in the next working hours, on the business’s clock, a little after the hour', () => {
    const hours = { start: 9, end: 17, days: [1, 2, 3, 4, 5] };
    // Friday 9 October 2026, 6 PM in Chicago: Saturday at 9 AM there, 14:00 UTC, as it works every day (decision 139);
    // Monday for someone who turned that off.
    const friday = Date.UTC(2026, 9, 9, 23);
    expect(nextStart(hours, 'America/Chicago', friday, 0)).toBe(Date.UTC(2026, 9, 10, 14));
    expect(nextStart({ ...hours, everyDay: false }, 'America/Chicago', friday, 0)).toBe(
      Date.UTC(2026, 9, 12, 14),
    );
    // Before the hours on a working day: the same day.
    const early = Date.UTC(2026, 9, 8, 12);
    const at = nextStart(hours, 'America/Chicago', early, 1)!;
    expect(at - Date.UTC(2026, 9, 8, 14)).toBeGreaterThan(0);
    expect(at - Date.UTC(2026, 9, 8, 14)).toBeLessThanOrEqual(20 * 60_000);
  });

  // Wednesday 28 October 2026 in Chicago, five hours behind UTC, with hours of 10 to 6 on weekdays.
  const hours = { start: 10, end: 18, days: [1, 2, 3, 4, 5] };
  const zone = 'America/Chicago';
  const today = '2026-10-28';
  const early = Date.UTC(2026, 9, 28, 13);
  const noon = Date.UTC(2026, 9, 28, 17);

  it('starts LinkedIn, Instagram and Alignable on their own in the working hours, or now after Start my day', () => {
    const none = { date: today, state: 'none', why: null } as const;
    const at = (now: number, day: Parameters<typeof networkDay>[0]['day'] = none) =>
      networkDay({ day, today, hours, timeZone: zone, now, random: 0 });
    expect(at(early)).toEqual({ go: false, stopped: null, next: Date.UTC(2026, 9, 28, 15) });
    expect(at(noon)).toEqual({ go: true, started: false, until: Date.UTC(2026, 9, 28, 23) });
    // Start my day: now, at a person's pace, hours or not.
    expect(at(early, { date: today, state: 'started', why: 'person' })).toEqual({
      go: true,
      started: true,
      until: null,
    });
    // Stop for today: the rest of today, till tomorrow's hours.
    expect(at(noon, { date: today, state: 'stopped', why: 'person' })).toEqual({
      go: false,
      stopped: 'person',
      next: Date.UTC(2026, 9, 29, 15),
    });
    // A press from another day changes nothing.
    expect(at(noon, { date: '2026-10-27', state: 'stopped', why: 'person' })).toEqual(at(noon));
  });

  it('says when a network starts on its own, at the hours’ start on the business’s clock', () => {
    const press = (name: string) =>
      `To start now, press Start my day for ${name} on Today in HandsFreeOS.`;
    expect(networkWaitWords('LinkedIn', { stopped: null }, hours, zone, early)).toBe(
      `Starts on its own on LinkedIn at 10:00 AM. ${press('LinkedIn')}`,
    );
    // 7 PM: tomorrow's.
    expect(
      networkWaitWords('Instagram', { stopped: null }, hours, zone, Date.UTC(2026, 9, 29)),
    ).toBe(`Starts on its own on Instagram tomorrow at 10:00 AM. ${press('Instagram')}`);
    // Friday at 7 PM: Saturday's, as it works every day (decision 139); Monday's, once the clocks have gone back, for
    // someone who turned that off.
    expect(
      networkWaitWords('Alignable', { stopped: null }, hours, zone, Date.UTC(2026, 9, 31)),
    ).toBe(`Starts on its own on Alignable tomorrow at 10:00 AM. ${press('Alignable')}`);
    expect(
      networkWaitWords(
        'Alignable',
        { stopped: null },
        { ...hours, everyDay: false },
        zone,
        Date.UTC(2026, 9, 31),
      ),
    ).toBe(`Starts on its own on Alignable on Mon, Nov 2 at 10:00 AM. ${press('Alignable')}`);
    expect(networkWaitWords('LinkedIn', { stopped: 'person' }, hours, zone, noon)).toBe(
      'Stopped on LinkedIn for today. It starts again on its own tomorrow at 10:00 AM.',
    );
  });
});

/** The button at the top of the profile that says where the two of you stand. */
const standing = (doc: Document) =>
  doc.querySelector<HTMLElement>('[role="main"] [role="button"][aria-label="Friends"]')!;

function relabel(button: HTMLElement, label: string): void {
  button.setAttribute('aria-label', label);
  const words = [...button.querySelectorAll('span')].at(-1);
  if (words) words.textContent = label;
}

function walk(doc: Document, path: readonly FetchStep[], then: readonly FetchStep[]): void {
  let from = 0;
  for (let tries = 0; from < path.length && tries < 5; tries++) {
    const went = doPath(doc, path, from);
    if (!('at' in went)) throw new Error(`Stuck before: ${path[from]!.says}`);
    from = went.at + 1;
  }
  for (const step of then) doStep(doc, step);
}

describe('pressing on a profile', () => {
  it('sends a friend request, and the profile reads as sent after', () => {
    const doc = load('profile-2026.html', URL);
    const button = standing(doc);
    relabel(button, 'Add friend');
    button.addEventListener('click', () => relabel(button, 'Cancel request'));
    expect(readPage(doc, URL).profile?.friendship).toBe(AUTO_PLANS.friend_request.before);
    walk(doc, AUTO_PLANS.friend_request.path, AUTO_PLANS.friend_request.then);
    expect(readPage(doc, URL).profile?.friendship).toBe(AUTO_PLANS.friend_request.after);
  });

  it('sends one when Add friend’s label has their name after it, never under someone else’s', () => {
    // From October 2026: "Add Friend Dana Reyes" for screen readers, "Add friend" to see.
    const doc = load('profile-2026.html', URL);
    const name = readPage(doc, URL).profile!.name!;
    const button = standing(doc);
    const label = (aria: string, words: string) => {
      button.setAttribute('aria-label', aria);
      [...button.querySelectorAll('span')].at(-1)!.textContent = words;
    };
    label('Add Friend Sam Lee', 'Add friend');
    expect(readPage(doc, URL).profile?.friendship).toBe('unknown');
    label(`Add Friend ${name}`, 'Add friend');
    button.addEventListener('click', () => label(`Cancel request ${name}`, 'Cancel request'));
    expect(readPage(doc, URL).profile?.friendship).toBe(AUTO_PLANS.friend_request.before);
    expect(() => walk(doc, AUTO_PLANS.friend_request.path, [])).toThrow(/Add friend/);
    walk(
      doc,
      withTheirName(AUTO_PLANS.friend_request.path, [name, null]),
      AUTO_PLANS.friend_request.then,
    );
    expect(readPage(doc, URL).profile?.friendship).toBe(AUTO_PLANS.friend_request.after);
  });

  it('takes their name whole or without its nickname, never a name that only holds theirs or is held in it', () => {
    const doc = load('profile-2026.html', URL);
    const button = standing(doc);
    const label = (aria: string) => {
      button.setAttribute('aria-label', aria);
      [...button.querySelectorAll('span')].at(-1)!.textContent = 'Add friend';
    };
    const friendship = () => readPage(doc, URL).profile?.friendship;
    // Dana Reyes's: a relative's, or names inside hers, are someone else's.
    for (const other of ['Dana Reyes Jr.', 'Ana', 'Dana', 'Reyes']) {
      label(`Add Friend ${other}`);
      expect(friendship()).toBe('unknown');
      expect(
        findStep(doc, withTheirName(AUTO_PLANS.friend_request.path, ['Dana Reyes'])[0]!),
      ).toBeNull();
    }
    // Shown with a nickname, and labelled without it.
    doc.title = '(3) Dana Reyes (Dee) | Facebook';
    doc.querySelector('[role="main"] span[dir="auto"] > [role="button"] > span')!.textContent =
      'Dana Reyes (Dee)';
    expect(readPage(doc, URL).profile?.name).toBe('Dana Reyes (Dee)');
    label('Add Friend Dana Reyes');
    expect(friendship()).toBe('not_friends');
    expect(
      findStep(doc, withTheirName(AUTO_PLANS.friend_request.path, ['Dana Reyes (Dee)'])[0]!),
    ).toBe(button);
  });

  it('presses their own Add friend before a plain one under People you may know', () => {
    const doc = load('profile-2026.html', URL);
    const button = standing(doc);
    button.setAttribute('aria-label', 'Add Friend Dana Reyes');
    [...button.querySelectorAll('span')].at(-1)!.textContent = 'Add friend';
    const theirs = doc.createElement('div');
    theirs.setAttribute('role', 'button');
    theirs.textContent = 'Add friend';
    doc.querySelector('[role="main"]')!.append(theirs);
    let pressed = '';
    button.addEventListener('click', () => (pressed = 'hers'));
    theirs.addEventListener('click', () => (pressed = 'someone else’s'));
    expect(
      'at' in doPath(doc, withTheirName(AUTO_PLANS.friend_request.path, ['Dana Reyes']), 0),
    ).toBe(true);
    expect(pressed).toBe('hers');
  });

  it('confirms a request through Respond’s menu, and the profile reads as friends after', () => {
    const doc = load('profile-2026.html', URL);
    const button = standing(doc);
    relabel(button, 'Respond');
    button.addEventListener('click', () => {
      const menu = doc.createElement('div');
      menu.setAttribute('role', 'menu');
      for (const label of ['Confirm', 'Delete request']) {
        const row = doc.createElement('div');
        row.setAttribute('role', 'menuitem');
        row.textContent = label;
        row.addEventListener('click', () => {
          menu.remove();
          if (label === 'Confirm') relabel(button, 'Friends');
        });
        menu.append(row);
      }
      doc.body.append(menu);
    });
    expect(readPage(doc, URL).profile?.friendship).toBe(AUTO_PLANS.confirm.before);
    walk(doc, AUTO_PLANS.confirm.path, AUTO_PLANS.confirm.then);
    expect(readPage(doc, URL).profile?.friendship).toBe(AUTO_PLANS.confirm.after);
  });

  it('knows the same person by number or username', () => {
    expect(sameRef(dana, { id: null, username: 'Dana.Reyes.12', url: URL })).toBe(true);
    expect(sameRef(dana, { id: null, username: 'dana.reyes.13', url: URL })).toBe(false);
    expect(sameRef({ ...dana, id: '1' }, { ...dana, id: '2' })).toBe(false);
  });

  it('says nothing either way of two people linked by different kinds of key', () => {
    const byNumber = {
      id: '100009000000044',
      username: null,
      url: `${FB}/profile.php?id=100009000000044`,
    };
    expect(sameByKey(dana, byNumber)).toBeNull();
    expect(sameByKey(dana, null)).toBeNull();
    expect(sameByKey({ ...dana, id: '100009000000044' }, byNumber)).toBe(true);
    expect(sameByKey(dana, { id: null, username: 'dana.reyes.99', url: URL })).toBe(false);
  });
});

describe('liking their latest post', () => {
  afterEach(() => vi.useRealTimers());
  const view = { scrollBy: () => undefined, innerHeight: 800 };

  it('reads their own posts, with what the pictures show, and likes the one picked', async () => {
    vi.useFakeTimers();
    const doc = load('profile-2026.html', URL);
    const reading = readTheirPosts(doc, URL, dana, view, 6);
    await vi.advanceTimersByTimeAsync(10_000);
    const posts = await reading;
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ liked: true, pictures: ['May be an image of text'] });
    const pick = { index: 0, url: posts[0]!.url };
    const liking = async (to: { index: number; url: string | null }) => {
      const going = likeTheirPost(doc, URL, dana, to);
      await vi.advanceTimersByTimeAsync(20_000);
      return (await going).result;
    };
    expect(await liking(pick)).toBe('already');
    const like = doc.querySelector<HTMLElement>('[aria-label="Remove Like"]')!;
    like.setAttribute('aria-label', 'Like');
    let pressed = 0;
    like.addEventListener('click', () => pressed++);
    const again = readTheirPosts(doc, URL, dana, view, 1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect((await again)[0]!.liked).toBe(false);
    expect(await liking(pick)).toBe('done');
    expect(pressed).toBe(1);
    // A post that's gone from the page isn't liked in its place.
    expect(await liking({ index: 0, url: `${URL}/posts/1` })).toBe('none');
  });

  it('finds the picked post again from the top once Facebook stops drawing it (decision 138)', async () => {
    vi.useFakeTimers();
    const doc = load('profile-2026.html', URL);
    const reading = readTheirPosts(doc, URL, dana, view, 6);
    await vi.advanceTimersByTimeAsync(10_000);
    const [post] = await reading;
    const like = doc.querySelector<HTMLElement>('[aria-label="Remove Like"]')!;
    like.setAttribute('aria-label', 'Like');
    let pressed = 0;
    like.addEventListener('click', () => pressed++);
    // Scrolled past, the post is swapped for an empty stand-in; back at the top, it's drawn again.
    const box = theirPosts(doc, URL, dana)[0]!.box;
    const stand = doc.createElement('div');
    box.replaceWith(stand);
    const scrolled: string[] = [];
    const window = {
      innerHeight: 800,
      scrollBy: () => void scrolled.push('down'),
      scrollTo: () => {
        scrolled.push('top');
        stand.replaceWith(box);
      },
    };
    const going = likeTheirPost(doc, URL, dana, { index: 0, url: post!.url }, window);
    await vi.advanceTimersByTimeAsync(20_000);
    expect((await going).result).toBe('done');
    expect(pressed).toBe(1);
    expect(scrolled).toEqual(['top']);
    // Without a window to scroll, it gives up as before.
    box.replaceWith(stand);
    const without = likeTheirPost(doc, URL, dana, { index: 0, url: post!.url });
    await vi.advanceTimersByTimeAsync(20_000);
    expect((await without).result).toBe('none');
  });

  it('presses a Like that Facebook gives only words, no label (decision 138)', async () => {
    vi.useFakeTimers();
    const doc = load('profile-2026.html', URL);
    const like = doc.querySelector<HTMLElement>('[aria-label="Remove Like"]')!;
    like.removeAttribute('aria-label');
    like.textContent = 'Like';
    let pressed = 0;
    like.addEventListener('click', () => pressed++);
    const reading = readTheirPosts(doc, URL, dana, view, 6);
    await vi.advanceTimersByTimeAsync(10_000);
    const [post] = await reading;
    expect(post!.liked).toBe(false);
    const going = likeTheirPost(doc, URL, dana, { index: 0, url: post!.url });
    await vi.advanceTimersByTimeAsync(20_000);
    expect((await going).result).toBe('done');
    expect(pressed).toBe(1);
  });

  it('reads Facebook’s Like labels of 31 Oct 2026, before and after a like (decision 138)', () => {
    const doc = load('profile-2026.html', URL);
    const button = (label: string) => {
      const b = doc.createElement('div');
      b.setAttribute('role', 'button');
      b.setAttribute('aria-label', label);
      return b;
    };
    expect(likeStateOf(button('React with Like to Dana Reyes’s post'))).toBe('like');
    expect(likeStateOf(button('Remove Like from Dana Reyes’s post'))).toBe('liked');
    expect(likeStateOf(button('Change Like reaction'))).toBe('liked');
    expect(likeStateOf(button('Share'))).toBe('unknown');
  });

  it('reads nobody else’s posts', async () => {
    vi.useFakeTimers();
    const doc = load('profile-2026.html', URL);
    const other = { id: null, username: 'sam.carter', url: `${FB}/sam.carter` };
    const reading = readTheirPosts(doc, URL, other, view, 6);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await reading).toEqual([]);
  });
});

describe('writing a comment', () => {
  const url = `${FB}/groups/7766554433221100/posts/5555666677778888/`;

  /** The post page, where typing puts the words where the caret is, as Chrome does, and sending empties the box. */
  function postPage(send: 'button' | 'enter') {
    const doc = load('group-post-2026.html', url);
    const box = doc.querySelector<HTMLElement>('[role="textbox"][aria-label^="Comment as"]')!;
    const reply = doc.querySelector<HTMLElement>('[role="textbox"][aria-label^="Reply to"]')!;
    const button = doc.querySelector<HTMLElement>('form [role="button"][aria-label="Comment"]')!;
    let typedInto: Element | null = null;
    for (const each of [box, reply]) each.addEventListener('click', () => (typedInto = each));
    doc.execCommand = (_command: string, _ui?: boolean, text?: string) => {
      if (typedInto) typedInto.textContent = text ?? '';
      return true;
    };
    const sent: string[] = [];
    const take = () => {
      sent.push(box.textContent ?? '');
      box.textContent = '';
    };
    if (send === 'button') button.addEventListener('click', take);
    else {
      button.remove();
      box.addEventListener('keydown', (event) => {
        if ((event as KeyboardEvent).key === 'Enter') take();
      });
    }
    return { doc, reply, sent };
  }

  for (const send of ['button', 'enter'] as const)
    it(`types into the post’s own box, never a reply’s, and sends it with ${send === 'button' ? 'its button' : 'Enter'}`, async () => {
      const { doc, reply, sent } = postPage(send);
      vi.useFakeTimers();
      const writing = writeComment(doc, 'Love these, see you Saturday.');
      await vi.advanceTimersByTimeAsync(10_000);
      vi.useRealTimers();
      expect(await writing).toBe('done');
      expect(sent).toEqual(['Love these, see you Saturday.']);
      expect(reply.textContent?.trim()).toBe('');
    });

  it('says so when Facebook doesn’t take it', async () => {
    const doc = load('group-post-2026.html', url);
    const box = doc.querySelector<HTMLElement>('[role="textbox"][aria-label^="Comment as"]')!;
    doc.execCommand = (_command: string, _ui?: boolean, text?: string) => {
      box.textContent = text ?? '';
      return true;
    };
    vi.useFakeTimers();
    const writing = writeComment(doc, 'Love these.');
    await vi.advanceTimersByTimeAsync(10_000);
    vi.useRealTimers();
    expect(await writing).toBe('not_sent');
  });
});

describe('writing a message', () => {
  const CHAT = `${FB}/messages/t/100009000000002/`;
  const RILEY = { id: null, username: 'riley.quinn.7', url: `${FB}/riley.quinn.7` };
  const rileyChat = { name: 'Riley Quinn', href: '/riley.quinn.7/' };
  const danaChat = { name: 'Dana Reyes', href: '/dana.reyes.12/' };
  /** Dana as Messenger's chat with her links to her: by number. */
  const danaByNumber = { id: '100009000000002', username: null, url: `${FB}/100009000000002` };
  /** The small chat window a box is in, on a page `profileWithChats` drew. */
  const windowOf = (box: Element) => box.closest('[role="none"]')!;

  type Typing = (command: string, ui?: boolean, text?: string) => boolean;
  type Sent = { readonly to: string; readonly text: string };
  type Person = { readonly name: string; readonly href: string | null };

  /**
   * Chrome's typing on a test page: `insertText` writes in the box the focus is in, and Delete takes out what's
   * selected there.
   */
  function typing(doc: Document): Typing {
    const type: Typing = (command, _ui, text) => {
      const box = doc.activeElement?.closest('[role="textbox"]');
      if (!box) return false;
      const selection = doc.getSelection();
      if (command === 'insertText') box.textContent = text ?? '';
      else if (selection && !selection.isCollapsed) selection.deleteFromDocument();
      else box.textContent = '';
      return true;
    };
    doc.execCommand = type;
    return type;
  }

  /**
   * Each chat's own sending, as Facebook's: its button, or Enter, sends what's in its own box, to who it's with (as
   * its label says, or a test's `data-who` where two say the same).
   */
  function sending(root: ParentNode, sent: Sent[], send: 'button' | 'enter' = 'button'): void {
    for (const box of root.querySelectorAll<HTMLElement>('[role="textbox"]')) {
      const take = () => {
        const to = box.getAttribute('data-who') ?? box.getAttribute('aria-label')!;
        sent.push({ to, text: box.textContent ?? '' });
        box.textContent = '';
      };
      const button = box
        .closest('[role="region"], [role="main"]')
        ?.querySelector<HTMLElement>('[role="button"][aria-label="Press enter to send"]');
      if (send === 'button' && button) button.addEventListener('click', take);
      else {
        button?.remove();
        box.addEventListener('keydown', (event) => {
          if ((event as KeyboardEvent).key === 'Enter') take();
        });
      }
    }
  }

  /** A page whose boxes take typing as Chrome does, and whose chats each send their own. */
  function chatPage(file: string, page: string, send: 'button' | 'enter') {
    const doc = load(file, page);
    typing(doc);
    const sent: Sent[] = [];
    sending(doc, sent, send);
    return { doc, sent };
  }

  /**
   * Dana's profile with small chat windows over it, as Facebook keeps them open from page to page: each a copy of the
   * test page's window with Riley, with someone else, its header linking to `href` (or to nobody). `open` draws one
   * more, after the others or before them. `press` presses Message on her profile as the runner's tab does, noting
   * the chats open before it, and it draws hers (or nothing) with the cursor in its box, as Facebook does; or, with
   * `cursor` false, as a window that pops up for a message coming in does, without it.
   */
  function profileWithChats(...people: readonly Person[]) {
    const doc = load('profile-2026.html', URL);
    const window = load('chat-window-2026.html', `${FB}/friends/requests/`)
      .querySelector('[aria-label="Close chat"]')!
      .closest('[role="none"]')!;
    const layer = doc.createElement('div');
    doc.body.append(layer);
    const type = typing(doc);
    const sent: Sent[] = [];
    const open = (person: Person, where = 'after') => {
      const chat = doc.importNode(window, true);
      chat.innerHTML = chat.innerHTML
        .replaceAll('Riley Quinn', person.name)
        .replaceAll('Riley', person.name.split(' ')[0]!)
        .replaceAll('/riley.quinn.7/', person.href ?? '');
      if (!person.href) chat.querySelector('a[href=""]')!.remove();
      if (where === 'before') layer.prepend(chat);
      else layer.append(chat);
      sending(chat, sent);
      return chat;
    };
    for (const person of people) open(person);
    const boxOf = (name: string) =>
      doc.querySelector<HTMLElement>(`[role="textbox"][aria-label="Write to ${name}"]`)!;
    const press = async (person?: Person, where = 'after', cursor = true) => {
      doc.querySelector('[role="button"][aria-label="Message"]')!.addEventListener(
        'click',
        () => {
          const chat = person && open(person, where);
          if (chat && cursor) chat.querySelector<HTMLElement>('[role="textbox"]')!.focus();
        },
        { once: true },
      );
      const opened = await openMessage(doc);
      expect(opened.pressed).toBe(true);
      return opened.before;
    };
    return { doc, sent, boxOf, open, press, type };
  }

  /** Writes it with Facebook's waits passed, and says how it went. */
  async function written(...args: Parameters<typeof writeMessage>) {
    vi.useFakeTimers();
    const writing = writeMessage(...args);
    await vi.advanceTimersByTimeAsync(10_000);
    vi.useRealTimers();
    return writing;
  }

  /** Writes it with Facebook's waits passed, and says what came of it. */
  const write = async (...args: Parameters<typeof writeMessage>) => (await written(...args)).result;

  /** Writes it while `then` draws something a few seconds in, as Facebook may. */
  async function writeWhile(
    then: () => void,
    after: number,
    ...args: Parameters<typeof writeMessage>
  ) {
    vi.useFakeTimers();
    const writing = writeMessage(...args);
    await vi.advanceTimersByTimeAsync(after);
    then();
    await vi.advanceTimersByTimeAsync(10_000);
    vi.useRealTimers();
    return (await writing).result;
  }

  it('types into the open chat’s box in Messenger, and sends it with Enter', async () => {
    const { doc, sent } = chatPage('chat-2026.html', CHAT, 'enter');
    expect(
      await write(doc, CHAT, 'Hi Dana, how did Saturday go?', danaByNumber, ['Dana Reyes']),
    ).toBe('done');
    expect(sent).toEqual([{ to: 'Message Dana Reyes', text: 'Hi Dana, how did Saturday go?' }]);
  });

  it('types into a chat window over the page, and sends it with its button', async () => {
    const page = `${FB}/friends/requests/`;
    const { doc, sent } = chatPage('chat-window-2026.html', page, 'button');
    expect(await write(doc, page, 'Here are three times that work.', RILEY, ['Riley Quinn'])).toBe(
      'done',
    );
    expect(sent).toEqual([{ to: 'Write to Riley Quinn', text: 'Here are three times that work.' }]);
  });

  it('leaves a box the person is writing in alone, and says when there’s none', async () => {
    const doc = load('chat-2026.html', CHAT);
    doc.querySelector('[role="textbox"][aria-label="Message Dana Reyes"]')!.textContent =
      'half written';
    expect((await writeMessage(doc, CHAT, 'Hi Dana', danaByNumber, ['Dana Reyes'])).result).toBe(
      'not_sent',
    );
    const profile = load('profile-2026.html', URL);
    expect(await write(profile, URL, 'Hi Dana', dana, ['Dana Reyes'])).toBe('none');
  });

  // 0.94.0 typed each message into the chat window left open from the person messaged before.
  for (const [order, boxed] of [
    ['after', false],
    ['before', false],
    ['after', true],
    ['before', true],
  ] as const)
    it(`types only into their chat window, the last person’s still open (theirs ${order} it${boxed ? ', in more boxes' : ''})`, async () => {
      const { doc, sent, boxOf } = profileWithChats(
        ...(order === 'after' ? [rileyChat, danaChat] : [danaChat, rileyChat]),
      );
      if (boxed) boxEverything(doc);
      expect(await write(doc, URL, 'Hi Dana, thanks for the add.', dana, ['Dana Reyes'])).toBe(
        'done',
      );
      expect(sent).toEqual([{ to: 'Write to Dana Reyes', text: 'Hi Dana, thanks for the add.' }]);
      expect(boxOf('Riley Quinn').textContent?.trim()).toBe('');
    });

  it('types nothing while only the last person’s chat window is open', async () => {
    const { doc, sent, boxOf } = profileWithChats(rileyChat);
    expect(await write(doc, URL, 'Hi Dana', dana, ['Dana Reyes'])).toBe('none');
    expect(sent).toEqual([]);
    expect(boxOf('Riley Quinn').textContent?.trim()).toBe('');
  });

  it('waits for their chat window to draw, never writing in the one open before it', async () => {
    const { doc, sent, open } = profileWithChats(rileyChat);
    expect(
      await writeWhile(() => open(danaChat, 'before'), 1_200, doc, URL, 'Hi Dana', dana, [
        'Dana Reyes',
      ]),
    ).toBe('done');
    expect(sent).toEqual([{ to: 'Write to Dana Reyes', text: 'Hi Dana' }]);
  });

  it('knows their chat window by its link to their username or number, else, once it opened on their Message, by its heading or its label', async () => {
    const both = { id: '100009000000077', username: 'dana.reyes.12', url: URL };
    // A name HandsFreeOS has that the window doesn't show: its link to them decides.
    for (const href of ['/dana.reyes.12/', '/profile.php?id=100009000000077']) {
      const { doc, sent } = profileWithChats({ name: 'Dana Reyes', href });
      expect(await write(doc, URL, 'Hi', both, ['D. Reyes'])).toBe('done');
      expect(sent).toEqual([{ to: 'Write to Dana Reyes', text: 'Hi' }]);
    }
    // No link in its header: its heading names them, else the label on its messages does, beside Riley's.
    const unlinked = profileWithChats(rileyChat);
    const before = await unlinked.press({ name: 'Dana Reyes', href: null });
    expect(await write(unlinked.doc, URL, 'Hi', dana, ['Dana Reyes (Dee)'], before)).toBe('done');
    windowOf(unlinked.boxOf('Dana Reyes'))
      .querySelector('[aria-label="Chat settings"] h2')!
      .remove();
    expect(await write(unlinked.doc, URL, 'Hi again', dana, ['Dana Reyes'], before)).toBe('done');
    expect(unlinked.sent.map((s) => s.text)).toEqual(['Hi', 'Hi again']);
    // Without knowing it opened on their Message, a name proves nothing.
    expect(await write(unlinked.doc, URL, 'Hi there', dana, ['Dana Reyes'])).toBe('none');
    expect(unlinked.sent.map((s) => s.text)).toEqual(['Hi', 'Hi again']);
  });

  it('never writes in a chat window linking to someone else, or a Messenger chat with someone else', async () => {
    // Someone else with the same name: their own profile.
    const namesake = profileWithChats({ name: 'Dana Reyes', href: '/dana.reyes.99/' });
    expect(await write(namesake.doc, URL, 'Hi Dana', dana, ['Dana Reyes'])).toBe('none');
    expect(namesake.sent).toEqual([]);
    expect(namesake.boxOf('Dana Reyes').textContent?.trim()).toBe('');
    // Messenger's chat with Dana, for Riley: by name, and by a number that isn't hers.
    const { doc, sent } = chatPage('chat-2026.html', CHAT, 'enter');
    for (const them of [RILEY, { id: '100009000000077', username: null, url: RILEY.url }])
      expect(await write(doc, CHAT, 'Hi Riley', them, ['Riley Quinn'])).toBe('none');
    expect(sent).toEqual([]);
    expect(doc.querySelector('[aria-label="Message Dana Reyes"]')!.textContent?.trim()).toBe('');
  });

  it('never takes a chat open before their Message, linking by the other kind of key, for theirs, whatever its name', async () => {
    // The last person, another Dana Reyes, has no username: their window links by number. This Dana is kept by hers.
    const byNumber = profileWithChats({
      name: 'Dana Reyes',
      href: '/profile.php?id=100009000000044',
    });
    const before = await byNumber.press();
    expect(await write(byNumber.doc, URL, 'Hi Dana', dana, ['Dana Reyes'], before)).toBe('none');
    expect(byNumber.sent).toEqual([]);
    expect(byNumber.boxOf('Dana Reyes').textContent?.trim()).toBe('');
    // And the other way: this Dana is kept by number, the window open before links to a username.
    const byUsername = profileWithChats(danaChat);
    const numbered = {
      id: '100009000000055',
      username: null,
      url: `${FB}/profile.php?id=100009000000055`,
    };
    const opened = await byUsername.press();
    expect(await write(byUsername.doc, URL, 'Hi Dana', numbered, ['Dana Reyes'], opened)).toBe(
      'none',
    );
    expect(byUsername.sent).toEqual([]);
    // Messenger's chat links by number: for someone kept by username only, its name proves nothing.
    const { doc, sent } = chatPage('chat-2026.html', CHAT, 'enter');
    expect(await write(doc, CHAT, 'Hi Dana', dana, ['Dana Reyes'])).toBe('none');
    expect(sent).toEqual([]);
  });

  it('writes in the window their Message opened, linking by the other kind of key, by the name on its link', async () => {
    // Kept by number from a group, and Facebook left her profile at its number: her window links by username.
    const numbered = {
      id: '100009000000055',
      username: null,
      url: `${FB}/profile.php?id=100009000000055`,
    };
    const { doc, sent, boxOf, press } = profileWithChats(rileyChat);
    const before = await press(danaChat);
    expect(await write(doc, URL, 'Hi Dana', numbered, ['Dana Reyes'], before)).toBe('done');
    expect(sent).toEqual([{ to: 'Write to Dana Reyes', text: 'Hi Dana' }]);
    expect(boxOf('Riley Quinn').textContent?.trim()).toBe('');
    // Not when the name on it is someone else's.
    const other = profileWithChats(rileyChat);
    const opened = await other.press({ name: 'Dana Reyes', href: '/sam.lee.4/' });
    other.doc.querySelector('a[href="/sam.lee.4/"]')!.setAttribute('aria-label', 'Sam Lee');
    expect(await write(other.doc, URL, 'Hi Dana', numbered, ['Dana Reyes'], opened)).toBe('none');
    expect(other.sent).toEqual([]);
  });

  /** Another Dana Reyes's chat window, as it may be left open: its header's link drawn without an address, etc. */
  const NAMESAKES: readonly [string, (chat: Element) => void][] = [
    [
      'its header’s link drawn without an address',
      (chat) => {
        const link = chat.querySelector('a[href]')!;
        const drawn = chat.ownerDocument.createElement('div');
        for (const { name, value } of [...link.attributes])
          if (name !== 'href') drawn.setAttribute(name, value);
        drawn.append(...link.childNodes);
        link.replaceWith(drawn);
      },
    ],
    ['no link in its header', (chat) => chat.querySelector('a[href]')!.remove()],
    [
      'shown with a nickname, and no link',
      (chat) => {
        chat.querySelector('a[href]')!.remove();
        chat.querySelector('[aria-label="Chat settings"] h2')!.textContent = 'Dana Reyes (Dee)';
      },
    ],
    [
      'its header’s parts straight in the window, linking to them',
      (chat) => {
        const header = chat.querySelector('[aria-label="Close chat"]')!.parentElement!
          .parentElement!;
        header.replaceWith(...header.children);
      },
    ],
  ];

  for (const [shape, made] of NAMESAKES)
    for (const boxed of [false, true])
      it(`never writes in another Dana Reyes’s window left open, ${shape}${boxed ? ', in more boxes' : ''}`, async () => {
        const { doc, sent, open, press, boxOf } = profileWithChats(rileyChat);
        const namesake = open({ name: 'Dana Reyes', href: '/dana.reyes.99/' });
        namesake.querySelector('[role="textbox"]')!.setAttribute('data-who', 'the other Dana');
        made(namesake);
        if (boxed) boxEverything(doc);
        // Her own window doesn't open: nothing is sent.
        const before = await press();
        expect(await write(doc, URL, 'Hi Dana', dana, ['Dana Reyes'], before)).toBe('none');
        expect(sent).toEqual([]);
        expect(boxOf('Dana Reyes').textContent?.trim()).toBe('');
        // Hers draws 3 seconds after: it goes there only.
        expect(
          await writeWhile(
            () => open(danaChat),
            3_000,
            doc,
            URL,
            'Hi Dana',
            dana,
            ['Dana Reyes'],
            before,
          ),
        ).toBe('done');
        expect(sent).toEqual([{ to: 'Write to Dana Reyes', text: 'Hi Dana' }]);
        expect(
          [...doc.querySelectorAll('[aria-label="Write to Dana Reyes"]')].map((box) =>
            box.textContent?.trim(),
          ),
        ).toEqual(['', '']);
      });

  it('waits the whole time for a window that links to them before taking one by name', async () => {
    // Another Dana Reyes's window, linking to nobody, pops up as Message is pressed; hers draws 3 seconds after.
    const { doc, sent, open, press } = profileWithChats(rileyChat);
    const before = await press({ name: 'Dana Reyes', href: null }, 'after', false);
    doc
      .querySelector('[aria-label="Write to Dana Reyes"]')!
      .setAttribute('data-who', 'the other Dana');
    expect(
      await writeWhile(
        () => open(danaChat),
        3_000,
        doc,
        URL,
        'Hi Dana',
        dana,
        ['Dana Reyes'],
        before,
      ),
    ).toBe('done');
    expect(sent).toEqual([{ to: 'Write to Dana Reyes', text: 'Hi Dana' }]);
  });

  it('takes no window by name that popped up as Message was pressed without the cursor, though hers draws late or never', async () => {
    // Another Dana Reyes writes in just as Message is pressed: her window pops up, linking to nobody, and never takes
    // the cursor. Dana's own, linking to her username, draws 9 seconds after, or never.
    for (const hersAt of [9_000, null]) {
      const { doc, sent, open, press } = profileWithChats(rileyChat);
      const before = await press({ name: 'Dana Reyes', href: null }, 'after', false);
      const namesake = doc.querySelector('[aria-label="Write to Dana Reyes"]')!;
      namesake.setAttribute('data-who', 'the other Dana');
      expect(
        await writeWhile(
          () => hersAt && open(danaChat),
          hersAt ?? 9_000,
          doc,
          URL,
          'Hi Dana',
          dana,
          ['Dana Reyes'],
          before,
        ),
      ).toBe('none');
      expect(sent).toEqual([]);
      expect(namesake.textContent?.trim()).toBe('');
    }
  });

  it('takes the window their Message opened by name, where the cursor went, though another Dana Reyes’s pops up beside it', async () => {
    // Hers links to her by number, which HandsFreeOS doesn't keep; the other's, popping up as Message is pressed, to
    // nobody, and never takes the cursor. With its window behind another, Chrome may not say the cursor moved.
    for (const behind of [false, true]) {
      const { doc, sent, open, press } = profileWithChats(rileyChat);
      if (behind)
        doc.defaultView!.addEventListener('focusin', (event) => event.stopImmediatePropagation(), {
          capture: true,
        });
      doc
        .querySelector('[role="button"][aria-label="Message"]')!
        .addEventListener('click', () =>
          open({ name: 'Dana Reyes', href: null })
            .querySelector('[role="textbox"]')!
            .setAttribute('data-who', 'the other Dana'),
        );
      const before = await press({ name: 'Dana Reyes', href: '/profile.php?id=100009000000002' });
      expect(await write(doc, URL, 'Hi Dana', dana, ['Dana Reyes'], before)).toBe('done');
      expect(sent).toEqual([{ to: 'Write to Dana Reyes', text: 'Hi Dana' }]);
    }
  });

  it('notes the chats open as Message is pressed, not before Facebook has drawn it', async () => {
    // Message draws late; meanwhile the dock brings back another Dana Reyes's window, linking by number. Message then
    // opens nothing, and Facebook puts the cursor back in the window drawn last: hers.
    const { doc, sent, open } = profileWithChats();
    const message = doc.querySelector<HTMLElement>('[role="button"][aria-label="Message"]')!;
    const spot = message.parentElement!;
    message.remove();
    let namesake: Element | null = null;
    message.addEventListener('click', () =>
      namesake!.querySelector<HTMLElement>('[role="textbox"]')!.focus(),
    );
    vi.useFakeTimers();
    try {
      const opening = openMessage(doc);
      await vi.advanceTimersByTimeAsync(600);
      namesake = open({ name: 'Dana Reyes', href: '/profile.php?id=100009000000044' });
      namesake.querySelector('[role="textbox"]')!.setAttribute('data-who', 'the other Dana');
      await vi.advanceTimersByTimeAsync(600);
      spot.append(message);
      await vi.advanceTimersByTimeAsync(600);
      const opened = await opening;
      expect(opened.pressed).toBe(true);
      expect(opened.before.names).toContain('Dana Reyes');
      vi.useRealTimers();
      expect(await write(doc, URL, 'Hi Dana', dana, ['Dana Reyes'], opened.before)).toBe('none');
    } finally {
      vi.useRealTimers();
    }
    expect(sent).toEqual([]);
  });

  it('sends a later text only into the window the one before went into, straight away', async () => {
    // Kept by number, and Facebook left her profile at its number: her window links by username, so it's hers by name.
    const numbered = {
      id: '100009000000055',
      username: null,
      url: `${FB}/profile.php?id=100009000000055`,
    };
    const { doc, sent, open, press, boxOf } = profileWithChats(rileyChat);
    const before = await press(danaChat);
    expect(await write(doc, URL, 'Part one', numbered, ['Dana Reyes'], before)).toBe('done');
    // The next goes into the same window without waiting for one linking to her by number.
    vi.useFakeTimers();
    try {
      let wrote: string | null = null;
      void writeMessage(doc, URL, 'Part two', numbered, ['Dana Reyes'], before).then(
        (w) => (wrote = w.result),
      );
      await vi.advanceTimersByTimeAsync(2_500);
      expect(wrote).toBe('done');
    } finally {
      vi.useRealTimers();
    }
    // Another Dana Reyes writes in before the third, linking to nobody, and hers is put away: nothing goes.
    open({ name: 'Dana Reyes', href: null })
      .querySelector('[role="textbox"]')!
      .setAttribute('data-who', 'the other Dana');
    windowOf(boxOf('Dana Reyes')).setAttribute('hidden', '');
    expect(await write(doc, URL, 'Part three', numbered, ['Dana Reyes'], before)).toBe('none');
    expect(sent).toEqual([
      { to: 'Write to Dana Reyes', text: 'Part one' },
      { to: 'Write to Dana Reyes', text: 'Part two' },
    ]);
  });

  it('takes no window by name once one open before their Message showed their name', async () => {
    // Another Dana Reyes's window is open, linking to nobody; hers opens on Message, linking to nobody too.
    const { doc, sent, open, press } = profileWithChats();
    open({ name: 'Dana Reyes', href: null });
    const before = await press({ name: 'Dana Reyes', href: null });
    expect(await write(doc, URL, 'Hi Dana', dana, ['Dana Reyes'], before)).toBe('none');
    expect(sent).toEqual([]);
  });

  it('types nothing in the window their Message opened, linking by number, without the cursor, and says who it links to', async () => {
    // As Facebook's windows do: hers links to her by number, which HandsFreeOS doesn't keep, and the runner's window
    // is behind the person's, so Facebook puts no cursor in it (the owner's report of 30 Oct 2026).
    const hers = { name: 'Dana Reyes', href: '/100009000000031/' };
    const { doc, sent, boxOf, press } = profileWithChats(rileyChat);
    const before = await press(hers, 'before', false);
    expect(await written(doc, URL, 'Hi Dana', dana, ['Dana Reyes'], before)).toEqual({
      result: 'none',
      linksTo: {
        id: '100009000000031',
        username: null,
        url: `${FB}/profile.php?id=100009000000031`,
      },
    });
    expect(sent).toEqual([]);
    expect(boxOf('Dana Reyes').textContent?.trim()).toBe('');
    // Once the runner has seen on Facebook that the number is hers, it goes there by it.
    const numbered = { ...dana, id: '100009000000031' };
    expect(await write(doc, URL, 'Hi Dana', numbered, ['Dana Reyes'])).toBe('done');
    expect(sent).toEqual([{ to: 'Write to Dana Reyes', text: 'Hi Dana' }]);
  });

  it('says who a window links to only for the one window that opened on their Message with their name', async () => {
    const hers = { name: 'Dana Reyes', href: '/100009000000031/' };
    const linksTo = async (made: ReturnType<typeof profileWithChats>, before: ChatsBefore) =>
      (await written(made.doc, URL, 'Hi Dana', dana, ['Dana Reyes'], before)).linksTo;
    // Not when a window open before showed her name: someone else may have it.
    const namesake = profileWithChats(rileyChat, { name: 'Dana Reyes', href: null });
    expect(await linksTo(namesake, await namesake.press(hers, 'after', false))).toBeUndefined();
    // Not when another window with her name popped up beside it.
    const two = profileWithChats(rileyChat);
    two.doc
      .querySelector('[role="button"][aria-label="Message"]')!
      .addEventListener('click', () => two.open({ name: 'Dana Reyes', href: '/100009000000032/' }));
    expect(await linksTo(two, await two.press(hers, 'after', false))).toBeUndefined();
    // Not for one with someone else's name, nor one linking to someone else by her kind of key.
    const sam = profileWithChats(rileyChat);
    expect(
      await linksTo(
        sam,
        await sam.press({ name: 'Sam Lee', href: '/100009000000033/' }, 'after', false),
      ),
    ).toBeUndefined();
    const other = profileWithChats(rileyChat);
    expect(
      await linksTo(
        other,
        await other.press({ name: 'Dana Reyes', href: '/dana.reyes.99/' }, 'after', false),
      ),
    ).toBeUndefined();
    // Not without Message pressed on this page.
    const unpressed = profileWithChats(rileyChat);
    unpressed.open(hers);
    expect(await linksTo(unpressed, chatsOpen(unpressed.doc))).toBeUndefined();
  });

  it('never takes a window that opened on their Message by name when it links to someone else elsewhere in it', async () => {
    // Another Dana Reyes's message comes in just then: her window's header parts sit straight in it, linking to her.
    const { doc, sent, press } = profileWithChats(rileyChat);
    const before = await press({ name: 'Dana Reyes', href: '/dana.reyes.99/' });
    const header = doc
      .querySelector('a[href="/dana.reyes.99/"]')!
      .closest('[role="none"]')!
      .querySelector('[aria-label="Close chat"]')!.parentElement!.parentElement!;
    header.replaceWith(...header.children);
    expect(await write(doc, URL, 'Hi Dana', dana, ['Dana Reyes'], before)).toBe('none');
    expect(sent).toEqual([]);
  });

  it('never takes a link that leads nowhere for the profile the tab is on', async () => {
    for (const href of ['#', '']) {
      const { doc, sent, open, boxOf } = profileWithChats();
      const riley = open(rileyChat);
      riley.querySelector('a[href]')!.setAttribute('href', href);
      expect(await write(doc, URL, 'Hi Dana', dana, ['Dana Reyes'])).toBe('none');
      expect(sent).toEqual([]);
      expect(boxOf('Riley Quinn').textContent?.trim()).toBe('');
      // Hers draws 3 seconds after: it goes there only.
      expect(
        await writeWhile(() => open(danaChat), 3_000, doc, URL, 'Hi Dana', dana, ['Dana Reyes']),
      ).toBe('done');
      expect(sent).toEqual([{ to: 'Write to Dana Reyes', text: 'Hi Dana' }]);
    }
  });

  it('never takes a box whose own label names someone else, whatever header it seems to sit under', async () => {
    // Riley's window, without a Close chat of its own, beside Dana's, whose header has drawn but not yet its box.
    const { doc, sent, open, boxOf } = profileWithChats();
    const riley = open(rileyChat);
    riley.querySelector('[aria-label="Close chat"]')!.remove();
    const hers = open(danaChat);
    hers.querySelector('[role="log"]')!.remove();
    hers.querySelector('[role="region"]')!.remove();
    expect(await write(doc, URL, 'Hi Dana', dana, ['Dana Reyes'])).toBe('none');
    expect(sent).toEqual([]);
    expect(boxOf('Riley Quinn').textContent?.trim()).toBe('');
  });

  it('goes by a chat window’s own header, never a link in its body or beside it', async () => {
    // Riley's new chat, with no messages yet, introduces a mutual friend: Dana, whose own window isn't open.
    const intro = profileWithChats(rileyChat);
    const riley = windowOf(intro.boxOf('Riley Quinn'));
    riley.querySelector('[role="log"]')!.remove();
    riley
      .querySelector('[role="region"]')!
      .insertAdjacentHTML(
        'beforebegin',
        '<div><a href="/dana.reyes.12/" aria-label="Dana Reyes">Dana Reyes</a><span>Mutual friend</span></div>',
      );
    expect(await write(intro.doc, URL, 'Hi Dana', dana, ['Dana Reyes'])).toBe('none');
    expect(intro.sent).toEqual([]);
    expect(intro.boxOf('Riley Quinn').textContent?.trim()).toBe('');
    // Riley's window links to nobody, and a link to Dana sits beside it.
    const beside = profileWithChats({ name: 'Riley Quinn', href: null });
    windowOf(beside.boxOf('Riley Quinn')).insertAdjacentHTML(
      'afterend',
      '<a href="/dana.reyes.12/" aria-label="Dana Reyes">Dana Reyes</a>',
    );
    expect(await write(beside.doc, URL, 'Hi Dana', dana, ['Dana Reyes'])).toBe('none');
    expect(beside.sent).toEqual([]);
    // A window without its own Close chat is nobody's.
    const unclosable = profileWithChats(danaChat);
    windowOf(unclosable.boxOf('Dana Reyes')).querySelector('[aria-label="Close chat"]')!.remove();
    expect(await write(unclosable.doc, URL, 'Hi Dana', dana, ['Dana Reyes'])).toBe('none');
    expect(unclosable.sent).toEqual([]);
  });

  it('writes in their window though its body or the box links to others: a new chat’s introduction, a link typed', async () => {
    const { doc, sent, boxOf, type } = profileWithChats(rileyChat, danaChat);
    const theirs = windowOf(boxOf('Dana Reyes'));
    theirs.querySelector('[role="log"]')!.remove();
    theirs
      .querySelector('[role="region"]')!
      .insertAdjacentHTML(
        'beforebegin',
        '<div><a href="/dana.reyes.12/" aria-label="Dana Reyes">Dana Reyes</a><a href="/morgan.hale.3/" aria-label="Morgan Hale">Morgan Hale</a></div>',
      );
    // Facebook draws a link typed as a link, in the box.
    doc.execCommand = (command: string, ui?: boolean, text?: string) => {
      const typed = type(command, ui, text);
      if (command === 'insertText')
        boxOf('Dana Reyes').insertAdjacentHTML(
          'beforeend',
          '<a href="https://www.facebook.com/acmeplumbing"></a>',
        );
      return typed;
    };
    expect(await write(doc, URL, 'See facebook.com/acmeplumbing', dana, ['Dana Reyes'])).toBe(
      'done',
    );
    expect(sent).toEqual([{ to: 'Write to Dana Reyes', text: 'See facebook.com/acmeplumbing' }]);
  });

  it('sends in a window theirs by name though Facebook draws a preview of a link typed beside its box', async () => {
    // Hers links to her by number, which HandsFreeOS doesn't keep; the message links to the business's own Page.
    const { doc, sent, boxOf, press, type } = profileWithChats(rileyChat);
    const before = await press({ name: 'Dana Reyes', href: '/profile.php?id=100009000000002' });
    doc.execCommand = (command: string, ui?: boolean, text?: string) => {
      const typed = type(command, ui, text);
      if (command === 'insertText')
        windowOf(boxOf('Dana Reyes'))
          .querySelector('[role="region"]')!
          .insertAdjacentHTML(
            'afterbegin',
            '<div><a href="https://www.facebook.com/acmeplumbing" aria-label="Acme Plumbing">Acme Plumbing</a></div>',
          );
      return typed;
    };
    expect(
      await write(doc, URL, 'See facebook.com/acmeplumbing', dana, ['Dana Reyes'], before),
    ).toBe('done');
    expect(sent).toEqual([{ to: 'Write to Dana Reyes', text: 'See facebook.com/acmeplumbing' }]);
  });

  it('never wipes what the person wrote in a chat window drawn while it typed', async () => {
    // Sam's window comes back as it types, with what the person wrote him before: hers is sent, his kept.
    const { doc, sent, boxOf, open, type } = profileWithChats(rileyChat, danaChat);
    const sam = { name: 'Sam Lee', href: '/sam.lee.4/' };
    doc.execCommand = (command: string, ui?: boolean, text?: string) => {
      const typed = type(command, ui, text);
      if (command === 'insertText' && !doc.querySelector('[aria-label="Write to Sam Lee"]'))
        open(sam).querySelector('[role="textbox"]')!.textContent = 'Draft the person wrote to Sam';
      return typed;
    };
    expect(await written(doc, URL, 'Hi Dana', dana, ['Dana Reyes'])).toEqual({ result: 'done' });
    expect(sent).toEqual([{ to: 'Write to Dana Reyes', text: 'Hi Dana' }]);
    expect(boxOf('Sam Lee').textContent).toBe('Draft the person wrote to Sam');
    // One drawn holding what it typed after the person's own: nothing is sent, and theirs isn't wiped, but said.
    const again = profileWithChats(rileyChat, danaChat);
    again.doc.execCommand = (command: string, ui?: boolean, text?: string) => {
      const typed = again.type(command, ui, text);
      if (command === 'insertText')
        again.open(sam).querySelector('[role="textbox"]')!.textContent = `See you Tuesday ${text}`;
      return typed;
    };
    expect(await written(again.doc, URL, 'Hi Dana', dana, ['Dana Reyes'])).toEqual({
      result: 'not_theirs',
      left: { with: 'Sam Lee' },
    });
    expect(again.sent).toEqual([]);
    expect(again.boxOf('Sam Lee').textContent).toBe('See you Tuesday Hi Dana');
    expect(again.boxOf('Dana Reyes').textContent?.trim()).toBe('');
  });

  it('types nothing when the focus lands anywhere but their box', async () => {
    const { doc, sent, boxOf } = profileWithChats(rileyChat, danaChat);
    boxOf('Dana Reyes').focus = () => boxOf('Riley Quinn').focus();
    expect(await write(doc, URL, 'Hi Dana', dana, ['Dana Reyes'])).toBe('not_theirs');
    expect(sent).toEqual([]);
    for (const name of ['Riley Quinn', 'Dana Reyes'])
      expect(boxOf(name).textContent?.trim()).toBe('');
  });

  it('sends nothing, and takes the writing out, when their chat isn’t theirs once it’s typed', async () => {
    const { doc, sent, boxOf, type } = profileWithChats(rileyChat, danaChat);
    const header = windowOf(boxOf('Dana Reyes')).querySelector('a[href]')!;
    // Their window's header turns to someone else's as it's typed.
    doc.execCommand = (command: string, ui?: boolean, text?: string) => {
      const typed = type(command, ui, text);
      if (command === 'insertText') {
        header.setAttribute('href', '/morgan.hale.3/');
        header.setAttribute('aria-label', 'Morgan Hale');
      }
      return typed;
    };
    expect(await write(doc, URL, 'Hi Dana', dana, ['Dana Reyes'])).toBe('not_theirs');
    expect(sent).toEqual([]);
    expect(boxOf('Dana Reyes').textContent?.trim()).toBe('');
  });

  it('sends nothing, and takes the writing out of every box, when another box took it', async () => {
    // Into Riley's box as well as Dana's, and into Riley's alone.
    for (const both of [true, false]) {
      const { doc, sent, boxOf, type } = profileWithChats(rileyChat, danaChat);
      doc.execCommand = (command: string, ui?: boolean, text?: string) => {
        if (command !== 'insertText') return type(command, ui, text);
        boxOf('Riley Quinn').textContent = text ?? '';
        return both ? type(command, ui, text) : true;
      };
      expect(await written(doc, URL, 'Hi Dana', dana, ['Dana Reyes'])).toEqual({
        result: 'not_theirs',
      });
      expect(sent).toEqual([]);
      for (const name of ['Riley Quinn', 'Dana Reyes'])
        expect(boxOf(name).textContent?.trim()).toBe('');
    }
  });

  it('takes its writing out of a box with the person’s own in it, leaving theirs, and says where it couldn’t', async () => {
    // Riley's box has the person's own half-written message; the typing goes in after it, or over it.
    for (const over of [false, true]) {
      const { doc, sent, boxOf, type } = profileWithChats(rileyChat, danaChat);
      const riley = boxOf('Riley Quinn');
      riley.textContent = 'See you Tuesday';
      doc.execCommand = (command: string, ui?: boolean, text?: string) => {
        if (command !== 'insertText') return type(command, ui, text);
        if (over) riley.textContent = text ?? '';
        else riley.append(doc.createTextNode(` ${text}`));
        return type(command, ui, text);
      };
      const wrote = await written(doc, URL, 'Hi Dana, here is my price list', dana, ['Dana Reyes']);
      expect(sent).toEqual([]);
      expect(boxOf('Dana Reyes').textContent?.trim()).toBe('');
      if (over) expect(wrote).toEqual({ result: 'not_theirs', left: { with: 'Riley Quinn' } });
      else {
        expect(wrote).toEqual({ result: 'not_theirs' });
        expect(riley.textContent).toBe('See you Tuesday');
      }
    }
  });

  it('opens a chat from their profile’s Message, noting the chats open before it', async () => {
    const doc = load('profile-2026.html', URL);
    let pressed = 0;
    doc
      .querySelector('[role="button"][aria-label="Message"]')!
      .addEventListener('click', () => pressed++);
    walk(doc, MESSAGE_PATH, []);
    expect(pressed).toBe(1);
    const { press } = profileWithChats(rileyChat);
    const before = await press();
    expect(before.names).toContain('Riley Quinn');
    expect(before.boxes.size).toBeGreaterThan(0);
  });
});
