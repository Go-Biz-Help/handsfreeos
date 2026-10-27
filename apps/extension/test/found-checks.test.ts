/**
 * Checking the people found by topic (src/jobs/found-checks.ts; docs/outreach.md, decision 92): HandsFreeOS says who's
 * next and how many today has room for, each one's page is read by the network's own reader, and the lines go for the
 * AI's found check; someone the network didn't show goes as missing, a warning stops the day, and the person is told
 * why when nobody waits. On made-up people.
 */
import { describe, expect, it, vi } from 'vitest';
import type { HfosAsk } from '../src/hfos/messages';
import type { ReadThem, Who } from '../src/jobs/checks';
import type { Hfos, Job, JobTab } from '../src/jobs/job';

// A person's pace between people, skipped.
const paused: number[] = [];
vi.mock('../src/jobs/job', async (original) => ({
  ...(await original<object>()),
  pause: (ms: number) => {
    paused.push(ms);
    return Promise.resolve();
  },
}));

const { checkFound, foundMost } = await import('../src/jobs/found-checks');

const BUSINESS = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const IG = 'https://www.instagram.com';

let n = 0;
const person = (name: string, url: string) => ({
  profileId: `d0d0d0d0-0000-4000-8000-${String(++n).padStart(12, '0')}`,
  name,
  url,
  how: 'liked' as const,
  words: 'sourdough',
  postUrl: `${IG}/p/C0ffee12345/`,
});

const KIM = person('Kim Baker', `${IG}/kim_bakes/`);
const LEO = person('Leo Park', `${IG}/leo.parks/`);
const ANA = person('Ana Moss', `${IG}/ana_moss_cakes/`);

/** HandsFreeOS: who's next, and each look taken. */
function hfosWith(next: { people: unknown[]; today?: number; perDay?: number }, sent: HfosAsk[]) {
  return (async (ask: HfosAsk) => {
    sent.push(ask);
    if (ask.type === 'hfos-finds-next')
      return { ok: true, value: { today: 0, perDay: 30, ...next } };
    if (ask.type === 'hfos-check-look')
      return { ok: true, value: { profileId: ask.input.profileId, fit: 'waiting' } };
    throw new Error(`Not expected: ${ask.type}`);
  }) as unknown as Hfos;
}

function jobWith(hfos: Hfos, stopAfter = Infinity): Job {
  let asked = 0;
  return {
    tab: {} as JobTab,
    hfos,
    businessId: BUSINESS,
    stopped: () => asked++ >= stopAfter,
    progress: () => undefined,
    warn: async () => undefined,
  };
}

/** A network's reader: lines for each, missing for whom it didn't show, a warning's end where one stops the day. */
const reader =
  (read: Record<string, ReadThem | Error>) =>
  async (_job: Job, who: Who): Promise<ReadThem> => {
    const got = read[who.url];
    if (!got) throw new Error(`Not expected: ${who.url}`);
    if (got instanceof Error) throw got;
    return got;
  };

const lines = (name: string): ReadThem => ({
  lines: [`${name}`, 'Home baker in Springfield'],
  missing: false,
  followers: null,
});

const looks = (sent: HfosAsk[]) =>
  sent
    .filter((a): a is Extract<HfosAsk, { type: 'hfos-check-look' }> => a.type === 'hfos-check-look')
    .map((a) => a.input);

describe('checking the people found by topic', () => {
  it('asks for today’s room on the network, at most what one ask takes', () => {
    expect(foundMost('instagram')).toBe(30);
    expect(foundMost('alignable')).toBe(30);
    expect(foundMost('linkedin')).toBe(30);
  });

  it('reads each one by the network’s reader and sends the lines for the AI’s found check', async () => {
    paused.length = 0;
    const sent: HfosAsk[] = [];
    const end = await checkFound(jobWith(hfosWith({ people: [KIM, LEO, ANA] }, sent)), {
      platform: 'instagram',
      read: reader({
        [KIM.url]: lines('Kim Baker'),
        [LEO.url]: { lines: [], missing: true, followers: null },
        // The network went elsewhere: tried again in a week, as missing.
        [ANA.url]: new Error('Went elsewhere'),
      }),
    });
    expect(sent[0]).toEqual({
      type: 'hfos-finds-next',
      input: { workspaceId: BUSINESS, platform: 'instagram', most: 30 },
    });
    expect(looks(sent)).toEqual([
      {
        workspaceId: BUSINESS,
        profileId: KIM.profileId,
        lines: ['Kim Baker', 'Home baker in Springfield'],
        missing: false,
      },
      { workspaceId: BUSINESS, profileId: LEO.profileId, lines: [], missing: true },
      { workspaceId: BUSINESS, profileId: ANA.profileId, lines: [], missing: true },
    ]);
    // A person's pace between them, none after the last.
    expect(paused).toHaveLength(2);
    for (const ms of paused) {
      expect(ms).toBeGreaterThanOrEqual(15_000);
      expect(ms).toBeLessThanOrEqual(30_000);
    }
    expect(end).toEqual({
      line: 'Done. Checked 1 person found by topic for the AI. Instagram didn’t show 2 accounts. The good fits come onto Today once it has read them.',
      warned: false,
    });
  });

  it('asks for no more than it was told, and never none', async () => {
    const sent: HfosAsk[] = [];
    await checkFound(
      jobWith(hfosWith({ people: [] }, sent)),
      { platform: 'alignable', read: reader({}) },
      0,
    );
    expect(sent[0]).toMatchObject({ input: { platform: 'alignable', most: 1 } });
  });

  it('stops for the day on a warning, saying what it checked first', async () => {
    const sent: HfosAsk[] = [];
    const end = await checkFound(jobWith(hfosWith({ people: [KIM, LEO, ANA] }, sent)), {
      platform: 'instagram',
      read: reader({
        [KIM.url]: lines('Kim Baker'),
        [LEO.url]: { end: { line: 'Instagram warned you: stopped for today.', warned: true } },
      }),
    });
    expect(looks(sent).map((l) => l.profileId)).toEqual([KIM.profileId]);
    expect(end).toEqual({
      line: 'Instagram warned you: stopped for today. Checked 1 person found by topic for the AI. The good fits come onto Today once it has read them.',
      warned: true,
    });
  });

  it('stops when the person stops it, saying what it checked', async () => {
    const sent: HfosAsk[] = [];
    const end = await checkFound(jobWith(hfosWith({ people: [KIM, LEO] }, sent), 1), {
      platform: 'linkedin',
      read: reader({ [KIM.url]: lines('Kim Baker'), [LEO.url]: lines('Leo Park') }),
    });
    expect(looks(sent)).toHaveLength(1);
    expect(end.line).toBe(
      'Stopped. Checked 1 person found by topic for the AI. The good fits come onto Today once it has read them.',
    );
  });

  it('says why when nobody’s listed: today’s all checked, or nobody waits', async () => {
    const full = await checkFound(jobWith(hfosWith({ people: [], today: 30, perDay: 30 }, [])), {
      platform: 'instagram',
      read: reader({}),
    });
    expect(full).toEqual({
      line: 'That’s today’s 30 people found on Instagram. It carries on tomorrow.',
      warned: false,
    });
    const none = await checkFound(jobWith(hfosWith({ people: [], today: 4, perDay: 30 }, [])), {
      platform: 'alignable',
      read: reader({}),
    });
    expect(none.line).toBe(
      'Nobody found on Alignable waits for a check, or the good fits found wait for their likes first.',
    );
  });
});
