/**
 * Cancelling a request the person sent, from Sent requests (src/networks/facebook/sent.ts, src/jobs/tidy.ts; the
 * owner's report of 29 Oct 2026, where a profile's Cancel request couldn't be found): on the made-up list View sent
 * requests opens in October 2026, only the Cancel request beside the one ticked is pressed, found by the link to their
 * profile; the box asking to be sure gets its Cancel request, never its Cancel; and the job cancels everyone on the
 * list without opening a profile, opening one only for someone the whole list doesn't show. Plain and boxed.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HfosAsk, Tidy, TidyCandidate } from '../src/hfos/messages';
import type { Hfos, Job, JobTab } from '../src/jobs/job';
import { FRIEND_REQUESTS } from '../src/jobs/people';
import { tidy, tidyOnItsOwn } from '../src/jobs/tidy';
import { doStep, type FetchStep } from '../src/networks/facebook/fetch';
import { readPage } from '../src/networks/facebook/page';
import { cancelSent } from '../src/networks/facebook/sent';
import { boxEverything, load } from './load';

// A person's pace, and Facebook drawing what a press opened, without the waits.
vi.mock('../src/jobs/job', async (original) => ({
  ...(await original<object>()),
  pause: () => Promise.resolve(),
}));

afterEach(() => vi.useRealTimers());

const REQUESTS = 'https://www.facebook.com/friends/requests/';
const DANA = 'https://www.facebook.com/dana.reyes.12';
const drew = { id: '100004000000009', username: null, url: `${REQUESTS}x` };
const taylor = {
  id: null,
  username: 'Taylor.Reed.3',
  url: 'https://www.facebook.com/taylor.reed.3',
};

/** The Cancel request beside someone in the list, by the link to them. */
function cancelOf(doc: Document, href: string): HTMLElement {
  const row = doc.querySelector(`[role="dialog"] a[href="${href}"]`)!.parentElement!;
  return row.querySelector<HTMLElement>('[role="button"][aria-label="Cancel request"]')!;
}

/** Sent requests whose Cancel requests do as Facebook's do: the row offers Add friend after, each press counted. */
function sentList(boxed = false, sure = false) {
  const doc = load('friend-requests-sent-2026.html', REQUESTS);
  const pressed: string[] = [];
  for (const button of doc.querySelectorAll<HTMLElement>(
    '[role="dialog"] [role="button"][aria-label="Cancel request"]',
  )) {
    const cancel = () => {
      button.setAttribute('aria-label', 'Add friend');
      button.querySelector('span span')!.textContent = 'Add friend';
    };
    // Jesse Moore's row links to nobody.
    const whose = button.parentElement!.querySelector('a[href]')?.getAttribute('href') ?? 'nobody';
    button.addEventListener('click', () => {
      pressed.push(whose);
      if (!sure) return cancel();
      const box = doc.createElement('div');
      box.setAttribute('role', 'dialog');
      box.innerHTML =
        '<h2>Cancel request?</h2><div role="button" id="keep"><span>Cancel</span></div><div role="button" id="yes"><span>Cancel request</span></div>';
      box.querySelector('#keep')!.addEventListener('click', () => {
        pressed.push('the box’s Cancel');
        box.remove();
      });
      box.querySelector('#yes')!.addEventListener('click', () => {
        box.remove();
        cancel();
      });
      doc.body.append(box);
    });
  }
  if (boxed) boxEverything(doc);
  return { doc, pressed };
}

/** Who reads as a request sent on the list now. */
const stillSent = (doc: Document) =>
  (readPage(doc, REQUESTS).people ?? []).filter((p) => p.request === 'sent').map((p) => p.name);

describe('Cancel request in Sent requests', () => {
  for (const boxed of [false, true]) {
    it(`presses only the Cancel request beside the one ticked, by their number or their username${boxed ? ', boxed' : ''}`, async () => {
      const { doc, pressed } = sentList(boxed);
      expect(await cancelSent(doc, REQUESTS, drew, 2_000)).toBe('done');
      expect(await cancelSent(doc, REQUESTS, taylor, 2_000)).toBe('done');
      expect(pressed).toEqual(['/profile.php?id=100004000000009', '/taylor.reed.3']);
      expect(stillSent(doc)).toEqual(['Morgan Ellis']);
    });

    it(`presses the box’s Cancel request when Facebook asks to be sure, never its Cancel${boxed ? ', boxed' : ''}`, async () => {
      const { doc, pressed } = sentList(boxed, true);
      expect(await cancelSent(doc, REQUESTS, taylor, 2_000)).toBe('done');
      expect(pressed).toEqual(['/taylor.reed.3']);
      expect(doc.querySelector('#yes')).toBeNull();
      expect(stillSent(doc)).toEqual(['Morgan Ellis', 'Drew Kim']);
    });
  }

  it('presses nothing for someone the list doesn’t show, or with the list shut', async () => {
    const { doc, pressed } = sentList();
    const dana = { id: null, username: 'dana.reyes.12', url: DANA };
    expect(await cancelSent(doc, REQUESTS, dana, 500)).toBe('not_found');
    // Sky Patel is only one of Morgan's mutual friends there: a face on a row isn't a request.
    expect(
      await cancelSent(doc, REQUESTS, { id: null, username: 'sky.patel.8', url: DANA }, 500),
    ).toBe('not_found');
    const shut = load('friend-requests-2026.html', REQUESTS);
    expect(await cancelSent(shut, REQUESTS, taylor, 500)).toBe('not_found');
    expect(pressed).toEqual([]);
  });

  it('says it pressed but couldn’t see it go when the row still says Cancel request', async () => {
    const doc = load('friend-requests-sent-2026.html', REQUESTS);
    let presses = 0;
    cancelOf(doc, '/taylor.reed.3').addEventListener('click', () => presses++);
    expect(await cancelSent(doc, REQUESTS, taylor, 700)).toBe('pressed');
    expect(presses).toBe(1);
  });
});

describe('cancelling the requests picked (the job)', () => {
  const candidate = (
    name: string,
    platformId: string | null,
    username: string | null,
    url: string,
  ): TidyCandidate =>
    ({
      profileId: `0000000${name.length}-1111-4222-8333-44445555666${name.length % 10}`,
      platformId,
      username,
      url,
      name,
      since: '2026-10-20T15:00:00.000Z',
      lastContact: null,
      fit: 'skip',
      going: false,
    }) as unknown as TidyCandidate;
  const DREW = candidate(
    'Drew Kim',
    '100004000000009',
    null,
    'https://www.facebook.com/profile.php?id=100004000000009',
  );
  const TAYLOR = candidate(
    'Taylor Reed',
    null,
    'taylor.reed.3',
    'https://www.facebook.com/taylor.reed.3',
  );
  const DANA_REYES = candidate('Dana Reyes', null, 'dana.reyes.12', DANA);

  /** Facebook in a tab: the friend requests, then Sent requests once View sent requests is pressed; profiles by address. */
  function facebookTab(list: ReturnType<typeof sentList>) {
    let doc = load('friend-requests-2026.html', REQUESTS);
    let at = REQUESTS;
    const opened: string[] = [];
    const asked: string[] = [];
    const tab = {
      async open(url: string) {
        opened.push(url);
        at = url === FRIEND_REQUESTS ? REQUESTS : url;
        doc =
          url === FRIEND_REQUESTS
            ? load('friend-requests-2026.html', REQUESTS)
            : load('profile-2026.html', url);
        return 1;
      },
      async ask(message: Record<string, unknown> & { readonly type: string }) {
        asked.push(message.type);
        if (message.type === 'hfos-read') return { ok: true, result: readPage(doc, at) };
        if (message.type === 'hfos-fetch-step') {
          const result = doStep(doc, message.step as FetchStep);
          if (message.lists && result === 'done') doc = list.doc;
          return { ok: true, result };
        }
        if (message.type === 'hfos-scroll-list') return { ok: false };
        if (message.type === 'hfos-cancel-sent')
          return {
            ok: true,
            result: await cancelSent(doc, at, message.profile as typeof drew, 1_000),
          };
        throw new Error(`Not expected: ${message.type}`);
      },
    } as unknown as JobTab;
    /** The person shuts Sent requests: the friend requests behind it are left. */
    const shut = () => {
      doc = load('friend-requests-2026.html', REQUESTS);
    };
    return { tab, opened, asked, shut };
  }

  function jobWith(tab: JobTab, cancel: readonly TidyCandidate[], handOver?: Job['handOver']) {
    const lists = {
      cancel,
      unfriend: [],
      limits: {
        cancel_request: { done: 0, most: 30 },
        unfriend: { done: 0, most: 20 },
        decline: { done: 0, most: 30 },
      },
      own: { mode: 'cancel', cancel, unfriend: [], decline: [] },
    } as unknown as Tidy;
    const sent: HfosAsk[] = [];
    const hfos = (async (ask: HfosAsk) => {
      sent.push(ask);
      if (ask.type === 'hfos-tidy') return { ok: true, value: lists };
      if (ask.type === 'hfos-friend-end')
        return { ok: true, value: { profileId: 'x', counted: !ask.input.already, doneToday: 1 } };
      throw new Error(`Not expected: ${ask.type}`);
    }) as unknown as Hfos;
    const job: Job = {
      tab,
      hfos,
      businessId: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d',
      stopped: () => false,
      progress: () => undefined,
      warn: async () => undefined,
      ...(handOver ? { handOver } : {}),
    };
    return { job, sent };
  }

  const ended = (sent: readonly HfosAsk[]) =>
    sent.flatMap((a) =>
      a.type === 'hfos-friend-end' ? [[a.input.name, a.input.kind, a.input.already]] : [],
    );

  it('cancels each one beside their name in Sent requests, without opening a profile', async () => {
    const list = sentList();
    const { tab, opened } = facebookTab(list);
    const { job, sent } = jobWith(tab, [TAYLOR, DREW]);
    const end = await tidy(job, 'cancel_request', [TAYLOR.profileId, DREW.profileId]);
    expect(end).toEqual({ line: 'Done. Requests cancelled: 2 people.', warned: false });
    expect(opened).toEqual([FRIEND_REQUESTS]);
    expect(list.pressed).toEqual(['/taylor.reed.3', '/profile.php?id=100004000000009']);
    expect(ended(sent)).toEqual([
      ['Taylor Reed', 'cancel_request', false],
      ['Drew Kim', 'cancel_request', false],
    ]);
  });

  it('on its own too, and opens the profile only of someone the whole list doesn’t show', async () => {
    const list = sentList();
    const { tab, opened } = facebookTab(list);
    const { job, sent } = jobWith(tab, [DANA_REYES, DREW]);
    const end = await tidyOnItsOwn(job);
    // Dana's profile says you're friends now: left as it is.
    expect(end.line).toBe('Done. Requests cancelled: 1 person. Skipped: 1.');
    expect(opened).toEqual([FRIEND_REQUESTS, DANA]);
    expect(list.pressed).toEqual(['/profile.php?id=100004000000009']);
    expect(ended(sent)).toEqual([['Drew Kim', 'cancel_request', false]]);
  });

  it('hands one it couldn’t cancel to the person, saying where to press', async () => {
    const list = sentList();
    // Taylor's Cancel request does nothing.
    const stuck = load('friend-requests-sent-2026.html', REQUESTS);
    list.doc = stuck;
    const { tab } = facebookTab(list);
    const handOver = vi.fn(async () => 'skip' as const);
    const { job, sent } = jobWith(tab, [TAYLOR], handOver);
    const end = await tidy(job, 'cancel_request', [TAYLOR.profileId]);
    expect(handOver).toHaveBeenCalledWith(
      'Couldn’t cancel the request to Taylor Reed. Under Sent requests, press “Cancel request” beside their name. Then press Carry on, or Skip.',
    );
    expect(end.line).toBe('Done. Requests cancelled: 0 people. Skipped: 1.');
    expect(ended(sent)).toEqual([]);
  });

  it('opens Sent requests again when the person shut it', async () => {
    const list = sentList();
    const { tab, opened, shut } = facebookTab(list);
    const { job, sent } = jobWith(tab, [TAYLOR, DREW]);
    const hfos = job.hfos;
    const first = {
      ...job,
      hfos: (async (ask: HfosAsk) => {
        const answer = await hfos(ask);
        if (ask.type === 'hfos-friend-end') shut();
        return answer;
      }) as Hfos,
    };
    const end = await tidy(first, 'cancel_request', [TAYLOR.profileId, DREW.profileId]);
    expect(end.line).toBe('Done. Requests cancelled: 2 people.');
    expect(opened).toEqual([FRIEND_REQUESTS, FRIEND_REQUESTS]);
    expect(list.pressed).toEqual(['/taylor.reed.3', '/profile.php?id=100004000000009']);
    expect(ended(sent)).toHaveLength(2);
  });
});
