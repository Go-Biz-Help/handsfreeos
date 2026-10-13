/**
 * Working on its own (src/auto/plan.ts, src/facebook/auto.ts): what it does next and when, and the buttons it
 * presses. On made-up 2026 pages: a profile whose button behaves like Facebook's (Add friend becomes Cancel request;
 * Respond opens a menu with Confirm), its post's Like, and a group post's box to comment in, never a reply's.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TodayListItem } from '../src/hfos/messages';
import {
  gapAfter,
  GAP_MS,
  itemKey,
  itemsLeft,
  nextStart,
  nextWatch,
  STARTED_GAP_MS,
  watchDue,
  workKey,
  workLeft,
} from '../src/auto/plan';
import {
  AUTO_PLANS,
  likeTheirPost,
  readTheirPosts,
  MESSAGE_PATH,
  sameRef,
  writeComment,
  writeMessage,
} from '../src/facebook/auto';
import { doPath, doStep, type FetchStep } from '../src/facebook/fetch';
import { readPage } from '../src/facebook/page';
import { load } from './load';

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
    expect(itemsLeft(list, all, []).map((i) => i.name)).toEqual([
      'Lee Park',
      'Ana Ruiz',
      'Dana Reyes',
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
      'Ana Ruiz',
      'Dana Reyes',
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
    // Friday 9 October 2026, 6 PM in Chicago: Monday at 9 AM there, 14:00 UTC.
    const friday = Date.UTC(2026, 9, 9, 23);
    expect(nextStart(hours, 'America/Chicago', friday, 0)).toBe(Date.UTC(2026, 9, 12, 14));
    // Before the hours on a working day: the same day.
    const early = Date.UTC(2026, 9, 8, 12);
    const at = nextStart(hours, 'America/Chicago', early, 1)!;
    expect(at - Date.UTC(2026, 9, 8, 14)).toBeGreaterThan(0);
    expect(at - Date.UTC(2026, 9, 8, 14)).toBeLessThanOrEqual(20 * 60_000);
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
    expect((await likeTheirPost(doc, URL, dana, pick)).result).toBe('already');
    const like = doc.querySelector<HTMLElement>('[aria-label="Remove Like"]')!;
    like.setAttribute('aria-label', 'Like');
    let pressed = 0;
    like.addEventListener('click', () => pressed++);
    expect((await readTheirPosts(doc, URL, dana, view, 1))[0]!.liked).toBe(false);
    expect((await likeTheirPost(doc, URL, dana, pick)).result).toBe('done');
    expect(pressed).toBe(1);
    // A post that's gone from the page isn't liked in its place.
    expect((await likeTheirPost(doc, URL, dana, { index: 0, url: `${URL}/posts/1` })).result).toBe(
      'none',
    );
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
  /** A chat whose box takes typing as Chrome does; sending empties it. */
  function chatPage(file: string, page: string, label: string, send: 'button' | 'enter') {
    const doc = load(file, page);
    const box = doc.querySelector<HTMLElement>(`[role="textbox"][aria-label="${label}"]`)!;
    doc.execCommand = (_command: string, _ui?: boolean, text?: string) => {
      box.textContent = text ?? '';
      return true;
    };
    const sent: string[] = [];
    const take = () => {
      sent.push(box.textContent ?? '');
      box.textContent = '';
    };
    const button = doc.querySelector<HTMLElement>(
      '[role="button"][aria-label="Press enter to send"]',
    );
    if (send === 'button') button!.addEventListener('click', take);
    else {
      button?.remove();
      box.addEventListener('keydown', (event) => {
        if ((event as KeyboardEvent).key === 'Enter') take();
      });
    }
    return { doc, sent };
  }

  it('types into the open chat’s box in Messenger, and sends it with Enter', async () => {
    const { doc, sent } = chatPage(
      'chat-2026.html',
      `${FB}/messages/t/100009000000002/`,
      'Message Dana Reyes',
      'enter',
    );
    vi.useFakeTimers();
    const writing = writeMessage(doc, 'Hi Dana, how did Saturday go?');
    await vi.advanceTimersByTimeAsync(10_000);
    vi.useRealTimers();
    expect(await writing).toBe('done');
    expect(sent).toEqual(['Hi Dana, how did Saturday go?']);
  });

  it('types into a chat window over the page, and sends it with its button', async () => {
    const { doc, sent } = chatPage(
      'chat-window-2026.html',
      `${FB}/friends/requests/`,
      'Write to Riley Quinn',
      'button',
    );
    vi.useFakeTimers();
    const writing = writeMessage(doc, 'Here are three times that work.');
    await vi.advanceTimersByTimeAsync(10_000);
    vi.useRealTimers();
    expect(await writing).toBe('done');
    expect(sent).toEqual(['Here are three times that work.']);
  });

  it('leaves a box the person is writing in alone, and says when there’s none', async () => {
    const page = `${FB}/messages/t/100009000000002/`;
    const doc = load('chat-2026.html', page);
    doc.querySelector('[role="textbox"][aria-label="Message Dana Reyes"]')!.textContent =
      'half written';
    expect(await writeMessage(doc, 'Hi Dana')).toBe('not_sent');
    const profile = load('profile-2026.html', URL);
    vi.useFakeTimers();
    const writing = writeMessage(profile, 'Hi Dana');
    await vi.advanceTimersByTimeAsync(10_000);
    vi.useRealTimers();
    expect(await writing).toBe('none');
  });

  it('opens a chat from their profile’s Message', () => {
    const doc = load('profile-2026.html', URL);
    let pressed = 0;
    doc
      .querySelector('[role="button"][aria-label="Message"]')!
      .addEventListener('click', () => pressed++);
    walk(doc, MESSAGE_PATH, []);
    expect(pressed).toBe(1);
  });
});
