/**
 * Partners in the extension (docs/outreach.md, decision 81): how many follow someone, read off the top of their
 * Facebook or LinkedIn profile; the once-a-day read of people who could partner, sent for the AI's partner check with
 * their kind and following; and a partner's steps on the runner's list, after the customers', each message waiting
 * for an OK of its own. On made-up pages and people.
 */
import { describe, expect, it, vi } from 'vitest';
import { workLeft } from '../src/auto/plan';
import type { HfosAsk, TodayListItem } from '../src/hfos/messages';
import type { Hfos, Job, JobTab } from '../src/jobs/job';
import { readPage } from '../src/networks/facebook/page';
import { followerCount } from '../src/networks/linkedin/vocabulary';
import { load } from './load';

// A person's pace is minutes; here, none.
vi.mock('../src/jobs/job', async (original) => ({
  ...(await original<object>()),
  pause: () => Promise.resolve(),
}));

const { checkPartners } = await import('../src/jobs/partners');

const FB = 'https://www.facebook.com';
const DANA = `${FB}/dana.reyes.12`;
const BUSINESS = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const PROFILE_ID = '7b6f5c4d-3e2a-4b1c-8d9e-0f1a2b3c4d5e';

/** Dana's 2026 profile, with "3.4K followers" beside her friends at the top when `followed`. */
function profile(url: string, followed = true): Document {
  const doc = load('profile-2026.html', url);
  if (followed) {
    const friends = doc.querySelector(`a[href="/dana.reyes.12/friends_all/"]`)!;
    friends.insertAdjacentHTML(
      'afterend',
      ` • <a role="link" href="/dana.reyes.12/followers/"><strong>3.4K</strong> followers</a>`,
    );
  }
  return doc;
}

describe('how many follow someone', () => {
  it('reads it off the top of a Facebook profile, and leaves it out when the top doesn’t say', () => {
    expect(readPage(profile(DANA), DANA).profile).toMatchObject({
      name: 'Dana Reyes',
      mutualFriends: 21,
      followers: 3400,
    });
    expect(readPage(profile(DANA, false), DANA).profile).not.toHaveProperty('followers');
  });

  it('reads LinkedIn’s count lines, never their connections', () => {
    expect(followerCount('1,234 followers')).toBe(1234);
    expect(followerCount('12K followers')).toBe(12_000);
    expect(followerCount('500+ connections')).toBeNull();
    expect(followerCount('Followed by Sam and 3 others')).toBeNull();
  });
});

describe('reading people who could partner', () => {
  const tab = (opened: string[]) =>
    ({
      async open(url: string) {
        opened.push(url);
        return 1;
      },
      async loaded() {
        return 1;
      },
      async ask(message: { readonly type: string }) {
        const at = opened.at(-1)!;
        if (message.type === 'hfos-read') return { ok: true, result: readPage(profile(at), at) };
        return { ok: false };
      },
    }) as unknown as JobTab;
  const hfosWith = (people: unknown[], sent: HfosAsk[]) =>
    (async (ask: HfosAsk) => {
      sent.push(ask);
      // No searches today: only the reading (../test/partner-search.test.ts has the searches).
      if (ask.type === 'hfos-partner-searches')
        return { ok: true, value: { searches: [], today: 2, perDay: 2, waiting: 0 } };
      if (ask.type === 'hfos-partners-next')
        return { ok: true, value: { people, today: 0, perDay: 15 } };
      if (ask.type === 'hfos-partner-look')
        return { ok: true, value: { partnerId: PROFILE_ID, fit: 'waiting' } };
      throw new Error(`Not expected: ${ask.type}`);
    }) as unknown as Hfos;
  const jobWith = (t: JobTab, hfos: Hfos): Job => ({
    tab: t,
    hfos,
    businessId: BUSINESS,
    stopped: () => false,
    progress: () => undefined,
    warn: async () => undefined,
  });

  it('sends each one’s profile, kind and following for the AI’s partner check', async () => {
    const opened: string[] = [];
    const sent: HfosAsk[] = [];
    const end = await checkPartners(
      jobWith(
        tab(opened),
        hfosWith([{ profileId: PROFILE_ID, name: 'Dana Reyes', url: DANA, kind: 'creator' }], sent),
      ),
      15,
    );
    expect(opened).toEqual([DANA]);
    const [, next, look] = sent as [
      Extract<HfosAsk, { type: 'hfos-partner-searches' }>,
      Extract<HfosAsk, { type: 'hfos-partners-next' }>,
      Extract<HfosAsk, { type: 'hfos-partner-look' }>,
    ];
    expect(next.input).toEqual({ workspaceId: BUSINESS, most: 15, platform: 'facebook' });
    expect(look.input).toMatchObject({
      workspaceId: BUSINESS,
      profileId: PROFILE_ID,
      kind: 'creator',
      followers: 3400,
      missing: false,
    });
    expect(look.input.lines?.length).toBeGreaterThan(0);
    expect(end).toEqual({
      line: 'Done. Read 1 possible partner for the AI. Good partners show on the Partners list once it has read them.',
      warned: false,
    });
  });

  it('says so when there’s nobody to read', async () => {
    const sent: HfosAsk[] = [];
    const end = await checkPartners(jobWith(tab([]), hfosWith([], sent)), 15);
    expect(end.line).toMatch(/^Nobody to read as a partner today/);
  });
});

describe('a partner’s steps on the runner’s list', () => {
  const item = (more: Partial<TodayListItem>): TodayListItem =>
    ({
      kind: 'opener',
      name: 'Dana Reyes',
      profileId: PROFILE_ID,
      profileUrl: DANA,
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
      personId: null,
      demoBooked: false,
      send: null,
      recent: [],
      ...more,
    }) as TodayListItem;
  const gail = (kind: TodayListItem['kind'], more: Partial<TodayListItem> = {}) =>
    item({
      kind,
      name: 'Gail Admin',
      profileId: '00000000-0000-4000-8000-00000000000a',
      profileUrl: `${FB}/gail.admin.1`,
      ...more,
    });
  const messages = [
    'opener',
    'partner_ask',
    'partner_follow_up',
    'partner_details',
    'partner_reply',
  ];

  it('come after the customers’ of each sort, and a message waiting for its OK isn’t worked', () => {
    const list = {
      items: [item({ kind: 'warm_up' }), item({ kind: 'opener', name: 'Sam Lee' })],
      partners: [
        gail('partner_warm_up'),
        gail('partner_ask', {
          name: 'Hal Host',
          profileId: '00000000-0000-4000-8000-00000000000b',
        }),
        gail('partner_follow_up', {
          name: 'Ida Ideas',
          profileId: '00000000-0000-4000-8000-00000000000c',
          send: {
            sendId: '00000000-0000-4000-8000-0000000000d1',
            state: 'waiting',
            text: 'Just checking you saw my note.',
            handedOver: false,
            needsYou: 'it’s a message to a partner',
          },
        }),
      ],
      auto: ['warm_up'],
      messages,
      sending: 'steps',
    } as never;
    expect(workLeft(list, []).map((w) => [w.do, w.item.kind, w.item.name])).toEqual([
      ['step', 'warm_up', 'Dana Reyes'],
      ['step', 'partner_warm_up', 'Gail Admin'],
      ['draft', 'opener', 'Sam Lee'],
      ['draft', 'partner_ask', 'Hal Host'],
    ]);
  });

  it('sends a partner’s message once it’s OK’d, and likes on its own only while it may', () => {
    const okd = gail('partner_details', {
      send: {
        sendId: '00000000-0000-4000-8000-0000000000d2',
        state: 'approved',
        text: 'Great! Here’s the link.',
        handedOver: false,
        needsYou: 'it’s a message to a partner',
      },
    });
    const list = {
      items: [],
      partners: [gail('partner_warm_up'), okd],
      auto: [],
      messages,
      sending: 'steps',
    } as never;
    expect(workLeft(list, []).map((w) => [w.do, w.item.kind])).toEqual([
      ['send', 'partner_details'],
    ]);
  });
});
