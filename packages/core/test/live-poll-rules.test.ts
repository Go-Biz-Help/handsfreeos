/**
 * Live polls' rules (HANDSFREEOS_WEBINARS_IMPLEMENTATION_PLAN.md, part 2), without a database: what a live poll may
 * ask, what each question looks like on screen, the totals, when one closes early, and what the room trusts. Part 4:
 * the poll's slides, a question's slide, and turning them.
 */
import { describe, expect, it } from 'vitest';
import {
  answerProblem,
  applyFormOps,
  closesEarly,
  describeFormOps,
  countAnswers,
  FormDefinition,
  formProblems,
  liveOf,
  pollOnScreen,
  pollTotals,
  readPollMessage,
  readSlideMessage,
  slideAfter,
  totalsShown,
  type FormOp,
  type Question,
} from '../src/index';

const choice = {
  id: 'q_choice00',
  type: 'choice',
  title: 'How do you get leads now?',
  config: {
    choices: [
      { id: 'c_referral', label: 'Referrals' },
      { id: 'c_ads00000', label: 'Ads' },
    ],
  },
};
const button = (config: Record<string, unknown>) => ({
  id: 'q_button00',
  type: 'button',
  title: 'Ready to start?',
  config,
});

const poll = (questions: unknown[], mode = 'poll') =>
  FormDefinition.parse({
    mode,
    title: 'Webinar poll',
    pages: [{ id: 'p_page0000', questions }],
    results: [{ id: 'r_thanks00', name: 'Thanks', headline: 'Thanks' }],
  });

const q = (raw: unknown): Question => poll([raw]).pages[0]!.questions[0]!;

describe('what a live poll may ask', () => {
  it('takes pick one, pick any, yes or no, a rating, a scale, a short answer and buttons', () => {
    const def = poll([
      choice,
      { ...choice, id: 'q_checks00', type: 'checkboxes' },
      { id: 'q_yesno000', type: 'yes_no', title: 'Do you use a CRM?', config: {} },
      { id: 'q_rating00', type: 'rating', title: 'How busy are you?', config: { max: 10 } },
      { id: 'q_scale000', type: 'scale', title: 'How ready?', config: {} },
      { id: 'q_short000', type: 'short_text', title: 'Your trade?', config: {} },
      button({ action: 'talk', label: 'Talk to someone' }),
    ]);
    expect(formProblems(def)).toEqual([]);
  });

  it('refuses a question that can’t pop up, a rule, and an empty poll', () => {
    expect(
      formProblems(poll([{ id: 'q_email000', type: 'email', title: 'Your email', config: {} }])),
    ).toEqual([expect.stringContaining('can’t pop up in a live poll')]);
    expect(formProblems(poll([]))).toContain('A live poll needs a question or a button.');
    const ruled = poll([
      choice,
      {
        id: 'q_yesno000',
        type: 'yes_no',
        title: 'Follow-up',
        config: {},
        showIf: {
          match: 'all',
          conditions: [
            {
              source: { kind: 'question', questionId: 'q_choice00' },
              op: 'is',
              value: 'c_ads00000',
            },
          ],
        },
      },
    ]);
    expect(formProblems(ruled)).toContain(
      'Questions in a live poll pop up when they’re asked, so they can’t have rules. Take the rules off.',
    );
  });

  it('wants somewhere for a button to go, and keeps buttons to live polls', () => {
    expect(formProblems(poll([button({ action: 'link', url: 'javascript:alert(1)' })]))).toEqual([
      '“Ready to start?” needs a web address starting https:// to open.',
    ]);
    expect(formProblems(poll([button({ action: 'book' })]))).toEqual([
      '“Ready to start?” needs a calendar to book on.',
    ]);
    expect(formProblems(poll([button({ action: 'talk' })], 'form'))).toEqual([
      '“Ready to start?” is a button for a live poll. Make this form a Live poll, or take the button out.',
    ]);
  });

  it('gives each question a minute and keeps its totals for the team unless it says otherwise', () => {
    expect(liveOf(q(choice))).toEqual({ seconds: 60, showResults: false, cues: [] });
    expect(liveOf(q({ ...choice, live: { seconds: 30, showResults: true } }))).toEqual({
      seconds: 30,
      showResults: true,
      cues: [],
    });
    expect(() => q({ ...choice, live: { seconds: 5 } })).toThrow();
    expect(totalsShown(q({ ...choice, live: { showResults: true } }))).toBe(true);
    // What people typed is never shown to everyone.
    expect(
      totalsShown(
        q({
          id: 'q_short000',
          type: 'short_text',
          title: 'Trade?',
          config: {},
          live: { showResults: true },
        }),
      ),
    ).toBe(false);
  });

  it('keeps a few short when-to-ask phrases for the AI (part 3)', () => {
    expect(
      liveOf(
        q({ ...choice, live: { cues: ['  how do you get leads  ', 'where do leads come from'] } }),
      ).cues,
    ).toEqual(['how do you get leads', 'where do leads come from']);
    expect(() => q({ ...choice, live: { cues: [''] } })).toThrow();
    expect(() =>
      q({ ...choice, live: { cues: Array.from({ length: 9 }, (_, i) => `cue ${i}`) } }),
    ).toThrow();
    expect(() => q({ ...choice, live: { cues: ['x'.repeat(161)] } })).toThrow();
  });

  it('takes a press as a button’s answer', () => {
    expect(answerProblem(q(button({ action: 'talk' })), true)).toBeNull();
    expect(answerProblem(q(button({ action: 'talk' })), 'yes')).toBe('Press the button.');
  });
});

describe('on screen', () => {
  const at = {
    pollId: '6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b',
    closesAt: '2026-11-03T19:01:00.000Z',
  };

  it('shows choices by id and label, yes and no as choices, and a scale’s ends', () => {
    expect(pollOnScreen(q(choice), at)).toMatchObject({
      type: 'choice',
      title: 'How do you get leads now?',
      choices: [
        { id: 'c_referral', label: 'Referrals' },
        { id: 'c_ads00000', label: 'Ads' },
      ],
      closesAt: at.closesAt,
    });
    expect(
      pollOnScreen(q({ id: 'q_yesno000', type: 'yes_no', title: 'CRM?', config: {} }), at).choices,
    ).toEqual([
      { id: 'yes', label: 'Yes' },
      { id: 'no', label: 'No' },
    ]);
    expect(
      pollOnScreen(
        q({
          id: 'q_scale000',
          type: 'scale',
          title: 'Ready?',
          config: { min: 1, max: 10, minLabel: 'Not yet', maxLabel: 'Now' },
        }),
        at,
      ),
    ).toMatchObject({ min: 1, max: 10, minLabel: 'Not yet', maxLabel: 'Now' });
  });

  it('sends a link button to its page, a book button to the booking page, and talk nowhere', () => {
    expect(
      pollOnScreen(q(button({ action: 'link', url: 'https://example.com/claim' })), at).button,
    ).toEqual({ label: 'Talk to someone', action: 'link', url: 'https://example.com/claim' });
    expect(
      pollOnScreen(q(button({ action: 'book', calendarId: 'x', label: 'Book a call' })), {
        ...at,
        buttonUrl: 'https://go.example.com/book/acme/demo',
      }).button,
    ).toEqual({
      label: 'Book a call',
      action: 'book',
      url: 'https://go.example.com/book/acme/demo',
    });
    expect(pollOnScreen(q(button({ action: 'talk' })), at).button?.url).toBeNull();
  });
});

describe('the totals', () => {
  it('counts choices, yes and no, and numbers with their average', () => {
    expect(
      pollTotals(q(choice), countAnswers(['c_ads00000', 'c_ads00000', 'c_referral', null])),
    ).toEqual({
      answered: 3,
      bars: [
        { id: 'c_referral', label: 'Referrals', count: 1 },
        { id: 'c_ads00000', label: 'Ads', count: 2 },
      ],
      average: null,
    });
    // Yes and no are kept as true and false, which the database counts as 1 and 0.
    expect(
      pollTotals(q({ id: 'q_yesno000', type: 'yes_no', title: 'CRM?', config: {} }), {
        answered: 3,
        byChoice: {},
        byNumber: { '1': 2, '0': 1 },
      }).bars.map((b) => b.count),
    ).toEqual([2, 1]);
    const rating = pollTotals(
      q({ id: 'q_rating00', type: 'rating', title: 'Busy?', config: { max: 5 } }),
      countAnswers([5, 4, 4]),
    );
    expect(rating.average).toBe(4.3);
    expect(rating.bars.map((b) => b.count)).toEqual([0, 0, 0, 2, 1]);
  });

  it('closes early once nearly everyone watching answered, never with nobody watching', () => {
    expect(closesEarly(9, 10)).toBe(true);
    expect(closesEarly(8, 10)).toBe(false);
    expect(closesEarly(1, 1)).toBe(true);
    expect(closesEarly(3, 0)).toBe(false);
  });
});

describe('the message', () => {
  it('reads the worker’s messages and nothing else', () => {
    const open = {
      t: 'open',
      poll: pollOnScreen(q(choice), {
        pollId: '6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b',
        closesAt: '2026-11-03T19:01:00.000Z',
      }),
    };
    expect(readPollMessage(new TextEncoder().encode(JSON.stringify(open)))).toEqual(open);
    expect(readPollMessage('not json')).toBeNull();
    // The AI's "Ask now?" for the team (part 3).
    const suggest = {
      t: 'suggest',
      questionId: 'q_choice00',
      title: 'How do you get leads now?',
      why: 'They just asked where leads come from.',
      until: '2026-11-03T19:01:30.000Z',
    };
    expect(readPollMessage(JSON.stringify(suggest))).toEqual(suggest);
    expect(readPollMessage(JSON.stringify({ t: 'open', poll: { title: 'Fake' } }))).toBeNull();
  });
});

describe('the slides (part 4)', () => {
  const slides = {
    fileId: '2b9d6c1e-7f3a-4e5b-9c8d-0a1b2c3d4e5f',
    name: 'Demo deck.pdf',
    pages: 6,
  };
  const withSlides = (questions: unknown[], over: Record<string, unknown> = {}) =>
    FormDefinition.parse({
      mode: 'poll',
      title: 'Webinar poll',
      slides,
      pages: [{ id: 'p_page0000', questions }],
      results: [{ id: 'r_thanks00', name: 'Thanks', headline: 'Thanks' }],
      ...over,
    });

  it('holds a question’s slide, and wants it to be one the slides have', () => {
    const def = withSlides([{ ...choice, live: { slide: 4 } }]);
    expect(liveOf(def.pages[0]!.questions[0]!).slide).toBe(4);
    expect(formProblems(def)).toEqual([]);
    expect(formProblems(withSlides([{ ...choice, live: { slide: 9 } }]))).toContain(
      '“How do you get leads now?” goes with slide 9, but the slides have 6. Pick another slide, or none.',
    );
    expect(formProblems(poll([{ ...choice, live: { slide: 2 } }]))).toContain(
      '“How do you get leads now?” goes with slide 2, but this poll has no slides. Add them, or pick no slide.',
    );
    // Only a live poll has slides.
    expect(formProblems(withSlides([{ ...choice }], { mode: 'survey' }))).toContain(
      'Only a live poll has slides. Take them off, or make this a Live poll.',
    );
  });

  it('adds and takes off the slides as an edit, and undoing it puts things back', () => {
    const before = poll([choice]);
    const add: FormOp = { op: 'set_form', patch: { slides } };
    const added = applyFormOps(before, [add]);
    expect(added.definition.slides).toEqual(slides);
    expect(describeFormOps([add], before)).toEqual(['Added the slides “Demo deck.pdf”']);
    // Undone, the poll has none again.
    expect(applyFormOps(added.definition, added.inverse).definition.slides ?? null).toBeNull();
    const off: FormOp = { op: 'set_form', patch: { slides: null } };
    expect(applyFormOps(added.definition, [off]).definition.slides).toBeNull();
    expect(describeFormOps([off], added.definition)).toEqual(['Took the slides off']);
  });

  it('turns them on, back, to the start and to the end, never past either', () => {
    expect(slideAfter(null, 6, 'next')).toBe(1);
    expect(slideAfter(2, 6, 'next')).toBe(3);
    expect(slideAfter(6, 6, 'next')).toBeNull();
    expect(slideAfter(1, 6, 'previous')).toBeNull();
    expect(slideAfter(3, 6, 'previous')).toBe(2);
    expect(slideAfter(3, 6, 'first')).toBe(1);
    expect(slideAfter(3, 6, 'last')).toBe(6);
    expect(slideAfter(6, 6, 'last')).toBeNull();
    expect(slideAfter(null, 0, 'next')).toBeNull();
  });

  it('reads the worker’s slide messages and nothing else', () => {
    const m = {
      t: 'slide',
      slide: 2,
      of: 6,
      picture: 'https://storage.example.com/2.png?token=x',
      next: 'https://storage.example.com/3.png?token=x',
      at: '2026-11-03T19:00:00.000Z',
    };
    expect(readSlideMessage(JSON.stringify(m))).toEqual(m);
    expect(
      readSlideMessage(JSON.stringify({ ...m, slide: null, picture: null, next: null })),
    ).toMatchObject({ slide: null });
    expect(readSlideMessage(JSON.stringify({ ...m, picture: 'javascript:alert(1)' }))).toBeNull();
    expect(readSlideMessage('not json')).toBeNull();
    expect(readSlideMessage(JSON.stringify({ t: 'open' }))).toBeNull();
  });
});
