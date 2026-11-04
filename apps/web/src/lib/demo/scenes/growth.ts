import { businessOf, fullName, wallTime, type DemoPerson, type DemoWorld } from '../world';
import {
  beatStep,
  customer,
  dueWords,
  idsFor,
  PREPARING,
  ran,
  reply,
  textCard,
  textsSent,
  type Beat,
} from './ask-kit';
import { bookedText, DAY, MIN } from './calendar-kit';
import { conversationIn, myFirstName, openConversation, startConversation } from './kit';
import { customerSays, NEW_MESSAGE, newPerson, regular, teammateSays } from './teammate-kit';
import type { DemoScene } from './types';
import { siteOf } from './website-chat';

/**
 * Growing the business: a website form that texts back in seconds (41), Google reviews answered from Ask HandsFreeOS
 * (42), last fall's customers won back (43), and the AI teammate steering a chat toward this month's offer (45).
 */

/** A teammate past its training, replying on its own. */
const automatic = (w: DemoWorld) => {
  w.teammateAutomatic = true;
};

const BOOKED = ['message', 'conversation', 'appointment', 'activity'] as const;

// ------------------------------------------------------------------------------------ 41. a website form texts back

const s41 = idsFor(41);
const RENEE = newPerson(
  s41(1),
  'Renee',
  'Castillo',
  4101,
  'Sugar Land',
  'renee.castillo@example.com',
);
const RENEE_LEAD = s41(0x21);
const RENEE_CHAT = s41(0x11);
const RENEE_FIRST = s41(0x12);
const RENEE_SAYS = s41(0x13);
const RENEE_OFFER = s41(0x14);
const RENEE_PICKS = s41(0x15);
const RENEE_BOOKED = s41(0x16);
const RENEE_VISIT = s41(0x31);
const SOFTENER = 'Water softener install';
const SOFTENER_CENTS = 189_000;

const formTextsBack: DemoScene = {
  id: 'form-texts-back',
  number: 41,
  title: 'A website form texts back',
  kind: 'teammate',
  startsOn: 'pipeline',
  setup: automatic,
  steps: [
    {
      label: 'Open your pipeline',
      voiceover:
        'This is your pipeline, every job you could win, stage by stage. Watch the first column.',
      run: (p) => p.go('pipeline'),
    },
    {
      label: 'Renee fills in your quote form',
      voiceover:
        'Renee fills in the quote form on your website, asking about a water softener. She’s on your pipeline straight away, marked as from your website form.',
      change: (w, at) => {
        w.leads.push({
          id: RENEE_LEAD,
          title: SOFTENER,
          person: RENEE,
          stage: 'New',
          valueCents: SOFTENER_CENTS,
          source: 'Website form',
          at,
          onBoard: true,
        });
      },
      live: ['lead'],
      run: async (p) => {
        await p.waitFor(`@lead-card-${RENEE_LEAD}`, 15_000);
        await p.point(`@lead-card-${RENEE_LEAD}`);
      },
    },
    {
      label: 'She gets a text in seconds',
      voiceover:
        'Seconds later, she gets a text from your AI teammate. It thanks her and asks the two questions that decide the price.',
      change: (w, at) => {
        w.conversations.unshift({
          id: RENEE_CHAT,
          person: RENEE,
          createdAt: at,
          unread: 0,
          openLead: { id: RENEE_LEAD, title: SOFTENER, stage: 'New', valueCents: SOFTENER_CENTS },
          messages: [
            {
              id: RENEE_FIRST,
              at: at + 8_000,
              direction: 'outbound',
              teammate: true,
              body: `Hi Renee, it’s ${w.state.teammate} with ${businessOf(w)}. Thanks for asking about a water softener on our website! Is it for the whole house, and is your water from the city or a well?`,
            },
          ],
          drafts: [],
          visits: [],
        });
      },
      live: NEW_MESSAGE,
      run: async (p) => {
        await p.go('inbox');
        await openConversation(p, RENEE_CHAT);
        await p.point(`@message-${RENEE_FIRST}`);
      },
    },
    {
      label: 'Renee answers',
      voiceover: 'Renee answers while she’s still thinking about it.',
      change: (w, at) =>
        customerSays(w, RENEE_CHAT, {
          id: RENEE_SAYS,
          at,
          body: 'Whole house, city water. It’s so hard it leaves spots on everything.',
        }),
      live: NEW_MESSAGE,
      run: (p) => p.point(`@message-${RENEE_SAYS}`),
    },
    {
      label: 'It offers a free water test',
      voiceover:
        'It offers a free visit to test her water and measure up, at times you really have open.',
      change: (w, at) =>
        teammateSays(w, RENEE_CHAT, {
          id: RENEE_OFFER,
          at,
          body: 'Hard city water is exactly what a softener fixes. We can test your water and measure up for free. Tomorrow at 10:00 AM or 2:00 PM?',
        }),
      live: NEW_MESSAGE,
      run: (p) => p.point(`@message-${RENEE_OFFER}`),
    },
    {
      label: 'She picks 10, and it books her',
      voiceover:
        'She picks ten o’clock, and it books her. A form on your website turned into a visit on your calendar, and nobody picked up the phone.',
      change: (w, at) => {
        const starts = wallTime(at, w.state.timeZone, 1, 10);
        customerSays(w, RENEE_CHAT, { id: RENEE_PICKS, at, body: '10 works!' });
        const c = conversationIn(w, RENEE_CHAT);
        c.messages.push({
          id: RENEE_BOOKED,
          at: at + 15_000,
          direction: 'outbound',
          body: bookedText(
            w,
            starts,
            'Water test and estimate',
            'https://app.handsfreeos.com/m/3vTn8kWd',
          ),
        });
        c.visits.push({
          id: RENEE_VISIT,
          title: 'Water test and estimate',
          startsAt: starts,
          minutes: 60,
          bookedAt: at + 15_000,
          source: 'ai_teammate',
          address: '1418 Brazos Bend Dr, Sugar Land, TX 77479',
        });
      },
      live: BOOKED,
      run: async (p) => {
        await p.waitFor(`@message-${RENEE_BOOKED}`);
        await p.point('@context-panel');
      },
    },
  ],
};

// ---------------------------------------------------------------------------------- 42. answer your Google reviews

const s42 = idsFor(42);
const HOWARD_REVIEW = s42(0x21);
const RHONDA_REVIEW = s42(0x22);
const HOWARD_ANSWER = (w: DemoWorld) =>
  `Thank you, Howard! A cold house is no fun, and we’re glad Dwayne could get your heat back the same day. We’ll pass your kind words on to him. – ${myFirstName(w)} at ${businessOf(w)}`;
const RHONDA_ANSWER = (w: DemoWorld) =>
  `Rhonda, you’re right, and I’m sorry. You should have had a text the moment your technician was running late, not a morning of waiting. We’ve changed how we let customers know, and I’d like to make it up to you on your next visit. Please call me at the office. – ${myFirstName(w)} at ${businessOf(w)}`;

const answerCard = (
  w: DemoWorld,
  toolCallId: string,
  r: { readonly who: string; readonly stars: number; readonly wrote: string; readonly at: number },
  body: string,
) => ({
  toolCallId,
  tool: 'answer_review',
  title: `Answer ${r.who}’s review?`,
  fields: [
    { label: 'Review', value: `${r.stars} stars on Google` },
    { label: 'They wrote', value: r.wrote },
    { label: 'Posted', value: dueWords(r.at, w.state.timeZone) },
  ],
  body,
  warnings: [
    {
      kind: 'caution',
      text: 'Public: anyone who looks the business up on Google reads it, under the business’s name.',
    },
    { kind: 'note', text: 'There’s no changing it from HandsFreeOS once it’s up.' },
  ],
  confirmLabel: 'Post the answer',
  outcome: 'Answered. It goes up on Google in a moment.',
  opens: 'reviews',
});

const HOWARD_WROTE =
  'Called at 8 AM with no heat and they had someone here by noon. Dwayne was friendly, explained everything, and the price was exactly what they quoted. Highly recommend!';
const RHONDA_WROTE =
  'The repair itself was fine, but nobody told me the technician was running two hours late. I waited around all morning.';

const reviewBeats: readonly Beat[] = [
  {
    ask: 'Answer today’s new reviews.',
    label: 'Ask it to answer them',
    voiceover:
      'Ask HandsFreeOS to answer them. It reads each review and writes an answer that fits it: thanks for the five stars, and a real apology for the two.',
    answer: (w) => {
      const howard = w.reviews.find((r) => r.id === HOWARD_REVIEW)!;
      const rhonda = w.reviews.find((r) => r.id === RHONDA_REVIEW)!;
      return {
        steps: ran('Looking at reviews', 'Drafting the answer', 'Drafting the answer'),
        text: 'Here’s an answer for each of today’s two. Rhonda’s says sorry for the wait and how you’ll fix it, without arguing. They go up on Google, under your business’s name, once you say yes.',
        cards: [
          answerCard(
            w,
            s42(0x11),
            { who: 'Howard Bishop', stars: 5, wrote: HOWARD_WROTE, at: howard.postedAt },
            HOWARD_ANSWER(w),
          ),
          answerCard(
            w,
            s42(0x12),
            { who: 'Rhonda Sutton', stars: 2, wrote: RHONDA_WROTE, at: rhonda.postedAt },
            RHONDA_ANSWER(w),
          ),
        ],
      };
    },
  },
  {
    confirm: 2,
    label: 'Say yes to both',
    voiceover:
      'Read them, then say yes to both. Every review answered the same day, which is what people notice when they look you up.',
    change: (w, at) => {
      for (const [id, body] of [
        [HOWARD_REVIEW, HOWARD_ANSWER(w)],
        [RHONDA_REVIEW, RHONDA_ANSWER(w)],
      ] as const) {
        const r = w.reviews.find((x) => x.id === id)!;
        r.reply = { body, at };
      }
    },
    live: ['review'],
    then: async (p) => {
      await p.closeAssistant();
      await p.waitFor(
        `[data-testid="review-${RHONDA_REVIEW}"] [data-testid="review-answer"]`,
        15_000,
      );
      await p.point(`@review-${RHONDA_REVIEW}`);
    },
  },
];

const answerReviews: DemoScene = {
  id: 'answer-reviews',
  number: 42,
  title: 'Answer your Google reviews',
  kind: 'assistant',
  startsOn: 'reviews',
  setup: (w, at) => {
    w.reviewsConnected = true;
    w.reviews.push(
      {
        id: HOWARD_REVIEW,
        author: 'Howard Bishop',
        stars: 5,
        body: HOWARD_WROTE,
        postedAt: halfHour(at - 3 * 60 * MIN),
      },
      {
        id: RHONDA_REVIEW,
        author: 'Rhonda Sutton',
        stars: 2,
        body: RHONDA_WROTE,
        postedAt: halfHour(at - 50 * MIN),
      },
    );
  },
  steps: [
    {
      label: 'Open your reviews',
      voiceover:
        'Two new Google reviews came in today. A five-star, and a two-star you’d rather not leave sitting there.',
      run: async (p) => {
        await p.go('reviews');
        await p.point(`@review-${RHONDA_REVIEW}`);
      },
    },
    ...reviewBeats.map(beatStep),
  ],
};

/** A review's time on the quarter hour, so it reads as when someone posted it. */
const halfHour = (ms: number) => Math.floor(ms / (15 * MIN)) * 15 * MIN;

// --------------------------------------------------------------------------- 43. win back last year's customers

const s43 = idsFor(43);
interface Gone {
  readonly person: DemoPerson;
  readonly job: string;
  readonly text: (w: DemoWorld) => string;
}
const GONE: readonly Gone[] = [
  {
    person: customer(s43(1), 'Leon', 'Pratt', 4301, 'Pearland'),
    job: 'Furnace repair',
    text: (w) =>
      `Hi Leon, it’s ${myFirstName(w)} from ${businessOf(w)}. It’s been a year since we fixed your furnace. Want us to check it over before it gets cold? Just reply and we’ll find a time.`,
  },
  {
    person: customer(s43(2), 'Fiona', 'Castell', 4302, 'Friendswood'),
    job: 'AC tune-up',
    text: (w) =>
      `Hi Fiona, it’s ${myFirstName(w)} from ${businessOf(w)}. Your AC hasn’t had a tune-up since last fall. Want to get one on the calendar? Just reply and we’ll find a time.`,
  },
  {
    person: customer(s43(3), 'Wendell', 'Okoro', 4303, 'Missouri City'),
    job: 'Water heater flush',
    text: (w) =>
      `Hi Wendell, it’s ${myFirstName(w)} from ${businessOf(w)}. It’s been about a year since we flushed your water heater, which is when it’s due again. Want us to come do it? Just reply and we’ll find a time.`,
  },
];

/** "October 2025": the month, a year and a bit ago, where the business is. */
const lastFall = (at: number, timeZone: string) =>
  new Intl.DateTimeFormat('en-US', { timeZone, month: 'long', year: 'numeric' }).format(
    new Date(at - 380 * DAY),
  );

const winBack: DemoScene = {
  id: 'win-back',
  number: 43,
  title: 'Win back last year’s customers',
  kind: 'assistant',
  startsOn: '',
  steps: [
    {
      label: 'Open Ask HandsFreeOS (⌘J)',
      voiceover:
        'Some of last year’s customers never came back. Not because they were unhappy. Nobody asked. Open Ask HandsFreeOS.',
      run: (p) => p.openAssistant(),
    },
    ...(
      [
        {
          ask: 'Who did we see last fall that we haven’t seen since?',
          label: 'Ask who hasn’t been back',
          voiceover:
            'Ask who you saw last fall and haven’t seen since. It looks through last year’s visits, then checks each of those customers for anything since.',
          answer: (w) => {
            const month = lastFall(w.state.startedAt, w.state.timeZone);
            return {
              steps: ran(...GONE.map(() => 'Looking at appointments'), 'Looking at appointments'),
              shows: [
                {
                  type: 'list',
                  title: `${GONE.length} customers`,
                  items: GONE.map((g) => ({
                    title: `${fullName(g.person)} · ${g.job}`,
                    detail: `Last visit ${month} · nothing since`,
                    tone: 'warning',
                    href: `/app/w/${w.workspaceId}/customers/people/${g.person.id}`,
                  })),
                },
              ],
              text: `${GONE.length} customers you saw around ${month} haven’t booked anything since. Each of them is due for the same job again about now. Want me to text each one?`,
            };
          },
        },
        {
          ask: 'Yes, text each of them a friendly check-in.',
          label: 'Ask it to text each one',
          voiceover:
            'Ask it to text each one. Every text names their own job, so it reads like you remembered them, because you did.',
          answer: (w) => ({
            steps: ran(...GONE.map(() => PREPARING)),
            text: 'Here’s a check-in for each, about their own job. They go from your business number once you say yes.',
            cards: GONE.map((g, i) => textCard(s43(0x11 + i), g.person, g.text(w))),
          }),
        },
        {
          confirm: GONE.length,
          label: 'Say yes to each text',
          voiceover: 'Say yes to each one.',
          change: (w, at) =>
            textsSent(
              w,
              at,
              GONE.map((g, i) => ({
                conversation: s43(0x31 + i),
                message: s43(0x41 + i),
                person: regular(g.person, at),
                body: g.text(w),
              })),
            ),
          live: ['conversation', 'message'],
        },
        reply({
          label: 'Leon texts back',
          voiceover:
            'Within the hour, Leon texts back. A customer you’d lost is a job on your calendar again, from one question.',
          conversation: s43(0x31),
          message: s43(0x51),
          body: 'Good timing! The furnace has been making a rattling noise again. Can someone come look this week?',
        }),
      ] satisfies readonly Beat[]
    ).map(beatStep),
  ],
};

// ----------------------------------------------------------------------- 45. steer chats toward your best offer

const s45 = idsFor(45);
const TUNE_UP_OFFER = s45(0x21);
const KENDRA_CHAT = s45(0x11);
const KENDRA_ASKS = s45(0x12);
const KENDRA_ANSWER = s45(0x13);
const KENDRA_YES = s45(0x14);
const KENDRA_BOOKED = s45(0x15);
const KENDRA_VISIT = s45(0x31);
const KENDRA: DemoPerson = newPerson(s45(1), 'Kendra', 'Lowe', 4501, 'Cypress');

/** This month's first and last days, `YYYY-MM-DD`, where the business is. */
function thisMonth(at: number, timeZone: string): { startsOn: string; endsOn: string } {
  const [y, m] = new Intl.DateTimeFormat('en-CA', { timeZone })
    .format(new Date(at))
    .split('-')
    .map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const mm = String(m).padStart(2, '0');
  return { startsOn: `${y}-${mm}-01`, endsOn: `${y}-${mm}-${String(last).padStart(2, '0')}` };
}

const bestOffer: DemoScene = {
  id: 'best-offer',
  number: 45,
  title: 'Steer chats toward your best offer',
  kind: 'teammate',
  startsOn: 'knowledge/offers',
  setup: (w, at) => {
    automatic(w);
    w.offers.push({
      id: TUNE_UP_OFFER,
      name: '$89 AC tune-up',
      details:
        'A full AC tune-up for $89 instead of $129, this month only. It covers heat pumps too. Book online or by text.',
      ...thisMonth(at, w.state.timeZone),
      at: at - 6 * DAY,
    });
  },
  steps: [
    {
      label: 'Open your offers',
      voiceover:
        'This month your best offer is an eighty-nine dollar AC tune-up. It’s in what your AI teammate knows, so it can bring it up.',
      run: async (p) => {
        await p.go('knowledge/offers');
        await p.point(`@offer-${TUNE_UP_OFFER}`);
      },
    },
    {
      label: 'A visitor asks something else',
      voiceover: 'A visitor on your website asks about something else: heat pumps.',
      change: (w, at) =>
        startConversation(w, at, {
          id: KENDRA_CHAT,
          channel: 'chat',
          known: false,
          visitor: {
            id: s45(2),
            name: 'Kendra',
            site: siteOf(businessOf(w)),
            pagePath: '/services/heat-pumps',
          },
          person: KENDRA,
          firstId: KENDRA_ASKS,
          body: 'Do you guys work on heat pumps too? Ours is about 8 years old.',
        }),
      live: NEW_MESSAGE,
      run: async (p) => {
        await p.go('inbox');
        await openConversation(p, KENDRA_CHAT);
        await p.point(`@message-${KENDRA_ASKS}`);
      },
    },
    {
      label: 'It answers, then mentions the offer',
      voiceover:
        'It answers her question first. Then it points her to the tune-up, because an eight-year-old heat pump is exactly who it’s for.',
      change: (w, at) => {
        conversationIn(w, KENDRA_CHAT).unread = 0;
        teammateSays(w, KENDRA_CHAT, {
          id: KENDRA_ANSWER,
          at,
          body: 'We do! We service and repair all the major heat pump brands. And good timing: this month our AC tune-up is $89 instead of $129, and it covers heat pumps. At 8 years old it’s a good time for one. Want me to book it?',
        });
      },
      live: NEW_MESSAGE,
      run: (p) => p.point(`@message-${KENDRA_ANSWER}`),
    },
    {
      label: 'Kendra takes it',
      voiceover: 'She takes it, and gives her name and number.',
      change: (w, at) => {
        const c = conversationIn(w, KENDRA_CHAT);
        c.known = true;
        customerSays(w, KENDRA_CHAT, {
          id: KENDRA_YES,
          at,
          body: 'Yes please! Kendra Lowe, 832-555-4501. Tomorrow morning if you can.',
        });
      },
      live: [...NEW_MESSAGE, 'person'],
      run: (p) => p.point(`@message-${KENDRA_YES}`),
    },
    {
      label: 'It books the tune-up',
      voiceover:
        'It books her for tomorrow morning. A question about heat pumps became this month’s offer, booked, without you in the chat.',
      change: (w, at) => {
        const starts = wallTime(at, w.state.timeZone, 1, 9);
        const c = conversationIn(w, KENDRA_CHAT);
        c.messages.push({
          id: KENDRA_BOOKED,
          at,
          direction: 'outbound',
          teammate: true,
          body: `You’re booked for tomorrow at 9:00 AM, Kendra, for the $89 tune-up. We’ll text 832-555-4501 when your technician is on the way.`,
        });
        c.visits.push({
          id: KENDRA_VISIT,
          title: 'AC tune-up',
          startsAt: starts,
          minutes: 60,
          bookedAt: at,
          source: 'ai_teammate',
          priceCents: 8_900,
        });
      },
      live: BOOKED,
      run: async (p) => {
        await p.waitFor(`@message-${KENDRA_BOOKED}`);
        await p.point('@context-panel');
      },
    },
  ],
};

export const GROWTH_SCENES: readonly DemoScene[] = [
  formTextsBack,
  answerReviews,
  winBack,
  bestOffer,
];

/** For the browser test: the made-up reviews' ids. */
export const DEMO_REVIEWS = { HOWARD_REVIEW, RHONDA_REVIEW } as const;
