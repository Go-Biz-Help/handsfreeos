/**
 * Groups, theirs first, then new ones (docs/outreach.md, decision 48), in the extension: what a group's About tab says
 * and its rules, read off a made-up 2026 page; Join group pressed and its questions answered on a made-up page with
 * its questions box; and the jobs that check groups and ask to join them, against made-up pages and HandsFreeOS.
 */
import { describe, expect, it, vi } from 'vitest';
import { readPage } from '../src/networks/facebook/page';
import { answerJoin, pressJoin } from '../src/networks/facebook/join';
import type { HfosAsk } from '../src/hfos/messages';
import type { Hfos, Job, JobTab } from '../src/jobs/job';
import { load } from './load';

// A person's pace is minutes; here, none.
vi.mock('../src/jobs/job', async (original) => ({
  ...(await original<object>()),
  pause: () => Promise.resolve(),
}));
// The page's own waits, the same.
vi.useFakeTimers({ shouldAdvanceTime: true, advanceTimeDelta: 50 });

const { checkGroups, aboutUrl } = await import('../src/jobs/groups-check');
const { joinGroups } = await import('../src/jobs/join');

const FB = 'https://www.facebook.com';
const BUSINESS = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const GROUP = '1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d';

describe('a group’s About tab', () => {
  it('reads what the group is for and its rules, without its name, counts or tabs', () => {
    const url = `${FB}/groups/texascontractors/about/`;
    const page = readPage(load('group-about-2026.html', url), url);
    expect(page.kind).toBe('group');
    expect(page.about?.about).toEqual([
      'A place for licensed contractors across Texas to share jobs, ask for advice and find good subs. Plumbers, electricians, HVAC and roofers welcome.',
      "Only members can see who's in the group and what they post.",
      'Anyone can find this group.',
      'Texas',
      'Group created on March 3, 2019.',
    ]);
    expect(page.about?.rules).toEqual([
      "Be kind and courteous: We're all in this together. Treat everyone with respect.",
      'No promotions or spam: Self-promotion is only allowed in the Monday thread.',
    ]);
    expect(page.group).toMatchObject({ privacy: 'private', joined: false, asked: false });
    // Its feed reads posts instead.
    expect(
      readPage(
        load('group-about-2026.html', `${FB}/groups/texascontractors/`),
        `${FB}/groups/texascontractors/`,
      ).about,
    ).toBeUndefined();
  });
});

describe('asking to join', () => {
  const opened = () => {
    const doc = load('group-join-2026.html', `${FB}/groups/texascontractors/`);
    // Facebook opens the questions when Join group is pressed, and closes them on Submit.
    doc
      .getElementById('join')!
      .addEventListener('click', () => doc.getElementById('questions')!.removeAttribute('hidden'));
    doc
      .getElementById('submit')!
      .addEventListener('click', () => doc.getElementById('questions')!.setAttribute('hidden', ''));
    doc
      .getElementById('agree')!
      .addEventListener('click', (e) =>
        (e.currentTarget as Element).setAttribute('aria-checked', 'true'),
      );
    return doc;
  };

  it('presses Join group and reads the questions Facebook asks first', async () => {
    const doc = opened();
    expect(await pressJoin(doc)).toEqual({
      result: 'questions',
      questions: ['What trade are you in?', 'Where in Texas do you work?'],
    });
  });

  it('writes the answers, agrees to the rules and submits', async () => {
    const doc = opened();
    await pressJoin(doc);
    expect(await answerJoin(doc, ['I run a bakery.', 'Austin.'])).toBe('done');
    expect((doc.getElementById('a1') as HTMLTextAreaElement).value).toBe('I run a bakery.');
    expect((doc.getElementById('a2') as HTMLTextAreaElement).value).toBe('Austin.');
    expect(doc.getElementById('agree')!.getAttribute('aria-checked')).toBe('true');
  });

  it('says when the person is in it or asked already, and when there’s nothing to press', async () => {
    const joined = load('group-join-2026.html', `${FB}/groups/texascontractors/`);
    joined.getElementById('join')!.setAttribute('aria-label', 'Joined');
    expect(await pressJoin(joined)).toEqual({ result: 'already', joined: true });
    const asked = load('group-join-2026.html', `${FB}/groups/texascontractors/`);
    asked.getElementById('join')!.setAttribute('aria-label', 'Cancel request');
    expect(await pressJoin(asked)).toEqual({ result: 'already', joined: false });
    const none = load('group-join-2026.html', `${FB}/groups/texascontractors/`);
    none.getElementById('join')!.remove();
    expect(await pressJoin(none)).toEqual({ result: 'none' });
  });
});

/** A tab that opens made-up pages by address and answers join asks with `join`. */
function fakeTab(pages: (url: string) => string, join: (message: { type: string }) => unknown) {
  let at = '';
  const opened: string[] = [];
  const tab = {
    async open(url: string) {
      at = url;
      opened.push(url);
    },
    async ask(message: { readonly type: string }) {
      if (message.type === 'hfos-read')
        return { ok: true, result: readPage(load(pages(at), at), at) };
      if (message.type === 'hfos-join' || message.type === 'hfos-join-answer') return join(message);
      return { ok: false };
    },
  } as unknown as JobTab;
  return { tab, opened };
}

function fakeHfos(answers: Partial<Record<HfosAsk['type'], (ask: HfosAsk) => unknown>>) {
  const sent: HfosAsk[] = [];
  const hfos = (async (ask: HfosAsk) => {
    sent.push(ask);
    const answer = answers[ask.type];
    if (!answer) throw new Error(`Not expected: ${ask.type}`);
    return { ok: true, value: answer(ask) };
  }) as unknown as Hfos;
  return { hfos, sent };
}

const jobWith = (tab: JobTab, hfos: Hfos): Job => ({
  tab,
  hfos,
  businessId: BUSINESS,
  stopped: () => false,
  progress: () => undefined,
  warn: async () => undefined,
});

describe('checking groups', () => {
  it('reads each group’s posts, then its About tab, and sends them for the AI', async () => {
    const url = `${FB}/groups/texascontractors/`;
    const { tab, opened } = fakeTab(
      (at) => (at.endsWith('/about/') ? 'group-about-2026.html' : 'group-feed.html'),
      () => ({ ok: false }),
    );
    const { hfos, sent } = fakeHfos({
      'hfos-groups-to-check': () => ({
        groups: [{ groupId: GROUP, name: 'Texas Contractors Network', url, joined: null }],
      }),
      'hfos-group-look': () => ({ groupId: GROUP, checkState: 'waiting' }),
    });
    const end = await checkGroups(jobWith(tab, hfos), 4);
    expect(opened).toEqual([url, aboutUrl(url)]);
    const look = sent.find((a) => a.type === 'hfos-group-look') as Extract<
      HfosAsk,
      { type: 'hfos-group-look' }
    >;
    expect(look.input.groupId).toBe(GROUP);
    expect(look.input.posts?.[0]).toMatch(/^Looking for recommendations on scheduling software/);
    expect(look.input.rules).toHaveLength(2);
    expect(look.input.joined).toBe(false);
    expect(end.line).toBe(
      'Checked 1 group. The Groups tab says which have your people once the AI has read them.',
    );
  });
});

describe('joining groups', () => {
  const next = (over: Record<string, unknown> = {}) => ({
    groups: [
      { groupId: GROUP, name: 'Texas Contractors Network', url: `${FB}/groups/texascontractors/` },
    ],
    today: 0,
    perDay: 3,
    prospects: { left: 40, perDay: 20, days: 2, low: true },
    words: 'contractors',
    onItsOwn: true,
    ...over,
  });

  it('asks to join, answers the questions with the AI’s answers, and notes it', async () => {
    const joins: string[] = [];
    const { tab } = fakeTab(
      () => 'group-about-2026.html',
      (message) => {
        joins.push(message.type);
        return message.type === 'hfos-join'
          ? { ok: true, step: { result: 'questions', questions: ['What trade are you in?'] } }
          : { ok: true, result: 'done' };
      },
    );
    const { hfos, sent } = fakeHfos({
      'hfos-joins-next': () => next(),
      'hfos-join-answers': () => ({ answers: ['I run a bakery.'] }),
      'hfos-join-note': () => ({ groupId: GROUP, state: 'asked' }),
    });
    const end = await joinGroups(jobWith(tab, hfos), null);
    expect(joins).toEqual(['hfos-join', 'hfos-join-answer']);
    const note = sent.find((a) => a.type === 'hfos-join-note') as Extract<
      HfosAsk,
      { type: 'hfos-join-note' }
    >;
    expect(note.input).toMatchObject({
      groupId: GROUP,
      state: 'asked',
      answers: [{ question: 'What trade are you in?', answer: 'I run a bakery.' }],
    });
    expect(end.line).toBe('Asked to join 1 group; the admins say yes or no.');
  });

  it('once a day, joins only when the person lets it and people left run low', async () => {
    const { tab, opened } = fakeTab(
      () => 'group-about-2026.html',
      () => ({ ok: false }),
    );
    const off = fakeHfos({ 'hfos-joins-next': () => next({ onItsOwn: false }) });
    expect((await joinGroups(jobWith(tab, off.hfos), null, true)).line).toBe(
      'Joining groups on its own is off in your settings.',
    );
    const plenty = fakeHfos({
      'hfos-joins-next': () => next({ prospects: { left: 400, perDay: 20, days: 20, low: false } }),
    });
    expect((await joinGroups(jobWith(tab, plenty.hfos), null, true)).line).toBe(
      'Your groups have 400 people left to reach: no need to join more yet.',
    );
    expect(opened).toEqual([]);
  });

  it('leaves a group that asks questions to pick from a list to the person', async () => {
    const { tab } = fakeTab(
      () => 'group-about-2026.html',
      () => ({ ok: true, step: { result: 'choices' } }),
    );
    const { hfos, sent } = fakeHfos({
      'hfos-joins-next': () => next(),
      'hfos-join-note': () => ({ groupId: GROUP, state: 'failed' }),
    });
    const end = await joinGroups(jobWith(tab, hfos), [GROUP]);
    expect(sent.find((a) => a.type === 'hfos-join-note')).toMatchObject({
      input: {
        state: 'failed',
        why: 'It asks questions to pick from a list. Join it yourself on Facebook.',
      },
    });
    expect(end.failed).toBe(true);
  });
});
