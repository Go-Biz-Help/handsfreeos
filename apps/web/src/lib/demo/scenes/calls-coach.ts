import type { Ok } from '../../api/types';
import { businessOf, fullName, wallTime, type DemoCoachCall, type DemoCoachCard } from '../world';
import { idsFor } from './ask-kit';
import { bookedText, REMINDERS } from './calendar-kit';
import { conversationIn, dayName, openConversation } from './kit';
import { newPerson } from './teammate-kit';
import type { DemoScene } from './types';

/**
 * The AI teammate on the phone: it calls a new lead within a minute of their form, asks what decides the job and
 * books the visit (46). The Sales Coach on a live call (47).
 */

// ------------------------------------------------------------------------------ 46. the AI calls a new lead

const s46 = idsFor(46);
const TAMIKA = newPerson(s46(1), 'Tamika', 'Rhodes', 4601, 'Pasadena', 'tamika.rhodes@example.com');
const LEAD = s46(0x21);
const CHAT = s46(0x11);
const CALL = s46(0x12);
const BOOKED = s46(0x13);
const VISIT = s46(0x31);
const FURNACE = 'Furnace replacement';
const FURNACE_CENTS = 640_000;
const ADDRESS = '2907 Spencer Hwy, Pasadena, TX 77503';

const CALL_LIVE = ['conversation', 'message', 'call'] as const;

const aiCallsLead: DemoScene = {
  id: 'ai-calls-lead',
  number: 46,
  title: 'The AI calls a new lead in a minute',
  kind: 'teammate',
  startsOn: 'pipeline',
  setup: (w) => {
    w.teammateAutomatic = true;
  },
  steps: [
    {
      label: 'A quote request while you’re out',
      voiceover:
        'You’re out on a job. Tamika fills in your quote form for a new furnace, and she’s on your pipeline straight away.',
      change: (w, at) => {
        w.leads.push({
          id: LEAD,
          title: FURNACE,
          person: TAMIKA,
          stage: 'New',
          valueCents: FURNACE_CENTS,
          source: 'Website form',
          at,
          onBoard: true,
        });
      },
      live: ['lead'],
      run: async (p) => {
        await p.go('pipeline');
        await p.waitFor(`@lead-card-${LEAD}`, 15_000);
        await p.point(`@lead-card-${LEAD}`);
      },
    },
    {
      label: 'Your AI teammate calls her',
      voiceover:
        'Within a minute your AI teammate calls her. She ticked the box saying it’s OK to call, and it only calls in the calling hours you set.',
      change: (w, at) => {
        w.conversations.unshift({
          id: CHAT,
          person: TAMIKA,
          createdAt: at,
          unread: 0,
          openLead: { id: LEAD, title: FURNACE, stage: 'New', valueCents: FURNACE_CENTS },
          messages: [
            {
              id: CALL,
              at,
              direction: 'outbound',
              teammate: true,
              body: '',
              call: { status: 'ringing', answeredByAi: true, seconds: null, transcript: null },
            },
          ],
          drafts: [],
          visits: [],
        });
      },
      live: CALL_LIVE,
      run: async (p) => {
        await p.go('inbox');
        await openConversation(p, CHAT);
        await p.point(`@call-${CALL}`);
      },
    },
    {
      label: 'She picks up',
      voiceover:
        'She picks up. It says who it is and why it’s calling, then asks what decides the job: how old the furnace is, what it’s doing, and whether she owns the home.',
      change: (w) => {
        conversationIn(w, CHAT).messages[0]!.call!.status = 'in_progress';
      },
      live: CALL_LIVE,
      run: (p) => p.point(`@call-${CALL}`),
    },
    {
      label: 'It books the visit',
      voiceover:
        'It books a free estimate at a time you really have open. Every word of the call is kept on her conversation.',
      change: (w, at) => {
        const c = conversationIn(w, CHAT);
        const starts = wallTime(at, w.state.timeZone, 1, 9);
        const ava = w.state.teammate;
        const call = c.messages[0]!.call!;
        call.status = 'completed';
        call.seconds = 142;
        call.transcript = [
          `${ava}: Hi, is this Tamika? It’s ${ava}, the AI assistant with ${businessOf(w)}. You asked for a furnace quote on our website a minute ago. Is now an okay time?`,
          'Tamika: Oh wow, that was fast. Yes, go ahead.',
          `${ava}: Thanks! About how old is the furnace, and what’s it doing?`,
          'Tamika: It’s about 20 years old. It keeps shutting off, and it’s getting loud.',
          `${ava}: At 20 years it’s worth looking at a new one. Do you own the home?`,
          'Tamika: Yes, we do.',
          `${ava}: Great. A technician can come and give you a free estimate ${dayName(starts, w.state.timeZone)} at 9:00 AM. Does that work?`,
          'Tamika: Perfect.',
          `${ava}: You’re booked. I’ll text you the details now. Thanks, Tamika!`,
        ].join('\n');
        c.visits.push({
          id: VISIT,
          title: 'Furnace replacement estimate',
          startsAt: starts,
          minutes: 60,
          bookedAt: at,
          source: 'ai_teammate',
          address: ADDRESS,
          priceCents: 0,
          reminders: { confirmedAt: at + 20_000, keys: REMINDERS },
        });
      },
      live: [...CALL_LIVE, 'appointment', 'activity'],
      run: async (p) => {
        await p.click('@call-record-toggle');
        await p.point(`@call-${CALL}`);
      },
    },
    {
      label: 'She gets the details by text',
      voiceover:
        'Then she gets the details by text. A brand-new lead is on your calendar for tomorrow morning, and you never picked up the phone.',
      change: (w, at) => {
        const c = conversationIn(w, CHAT);
        c.messages.push({
          id: BOOKED,
          at: at + 20_000,
          direction: 'outbound',
          body: bookedText(
            w,
            c.visits[0]!.startsAt,
            'Furnace replacement estimate',
            'https://app.handsfreeos.com/m/7bQe2vHx',
          ),
        });
      },
      live: ['conversation', 'message'],
      run: async (p) => {
        await p.waitFor(`@message-${BOOKED}`);
        await p.point('@context-panel');
      },
    },
  ],
};

// ------------------------------------------------------------------------------ 47. a sales coach on your call

const s47 = idsFor(47);
const MIN = 60_000;
const CURTIS = newPerson(
  s47(1),
  'Curtis',
  'Langford',
  4701,
  'Cypress',
  'curtis.langford@example.com',
);
const COACHED = s47(0x21);
const MEETING = s47(0x22);

/**
 * The business's playbook for going over an estimate, as an owner writes one under Playbooks: each step names the
 * method's stage it's for, so the stage bar shows. The words are made up for the scene.
 */
const PLAYBOOK: NonNullable<Ok<'/v1/queries/salescoach.live'>['call']>['playbook'] = {
  id: s47(0x23),
  name: 'Going over an estimate',
  details: {
    steps: [
      {
        id: 's1',
        title: 'Say hello and set the plan',
        say: 'Thanks for making the time. I’d like to hear how the house has been, then we’ll go over your options.',
        stage: 'connect',
        tip: '',
      },
      {
        id: 's2',
        title: 'Ask about the home and the system',
        say: 'How old is the system you have now, and how long are you planning to stay in the home?',
        stage: 'situation',
        tip: '',
      },
      {
        id: 's3',
        title: 'Find what bothers them most',
        say: 'What’s been the worst part: the bills, the noise, or rooms that never cool down?',
        stage: 'problem',
        tip: 'Sound curious, not like a salesperson.',
      },
      {
        id: 's4',
        title: 'Ask what happens if nothing changes',
        say: 'If the old unit has to make it through another summer, what do you think that looks like?',
        stage: 'consequence',
        tip: '',
      },
      {
        id: 's5',
        title: 'Show the option that fits',
        say: 'From what you’ve told me, here’s the one I’d put in, and why.',
        stage: 'present',
        tip: '',
      },
      {
        id: 's6',
        title: 'Ask for a yes',
        say: 'Would you like me to get the install on the calendar?',
        stage: 'commit',
        tip: 'Ask, then wait.',
      },
    ],
    objections: [
      {
        id: 'o1',
        objection: 'It’s more than I wanted to spend.',
        answer:
          'Ask what number they had in mind, then set the price beside what the old unit costs them every month in bills and repairs. Mention the monthly payments.',
      },
    ],
    points: [
      {
        id: 'p1',
        topic: 'Financing',
        fact: 'Monthly payments are available on any new system, with approved credit.',
      },
    ],
  },
};

const coachIn = (w: { coach: DemoCoachCall | null }) => w.coach!;

/** A card the coach adds, newest first, as the worker adds one. */
function addCard(w: { coach: DemoCoachCall | null }, card: DemoCoachCard, step: string) {
  const c = coachIn(w);
  c.cards.unshift(card);
  c.step = step;
}

const COACH_LIVE = ['salescoach_call'] as const;

const salesCoach: DemoScene = {
  id: 'sales-coach',
  number: 47,
  title: 'A sales coach on your Zoom call',
  kind: 'app',
  startsOn: 'a/salescoach',
  addons: ['salescoach'],
  answers: {
    'salescoach.live': (w): Ok<'/v1/queries/salescoach.live'> => {
      const c = w.coach;
      if (!c) return { call: null };
      return {
        call: {
          id: c.id,
          callId: null,
          liveMeetingId: c.liveMeetingId,
          state: c.state,
          person: { id: c.person.id, name: fullName(c.person) },
          playbook: PLAYBOOK,
          step: c.step,
          startedAt: new Date(c.startedAt).toISOString(),
          endedAt: c.endedAt === null ? null : new Date(c.endedAt).toISOString(),
          cards: c.cards.map((k) => ({
            id: k.id,
            kind: k.kind,
            title: k.title,
            say: k.say,
            heard: k.heard,
            tip: k.tip,
            objectionId: k.kind === 'objection' ? 'o1' : null,
            createdAt: new Date(k.at).toISOString(),
          })),
        },
      };
    },
    // Got it on a card: nothing to put away, the scene's cards are its own.
    'salescoach.card.dismiss': (_w, body) => ({ cardId: body['cardId'] }),
  },
  steps: [
    {
      label: 'Curtis joins the call',
      voiceover:
        'You’re on a Zoom call with Curtis about a new AC system. AI Sales Coach listens along, and shows where you are in your own script.',
      change: (w, at) => {
        w.coach = {
          id: COACHED,
          person: CURTIS,
          liveMeetingId: MEETING,
          startedAt: at - 2 * MIN,
          state: 'live',
          step: 's2',
          endedAt: null,
          cards: [],
        };
      },
      live: COACH_LIVE,
      run: async (p) => {
        // The add-on's one row in the menu, then where the call is in the script.
        await p.point(`aside a[href="/app/w/${p.workspaceId}/a/salescoach"]`);
        await p.waitFor('@coach-step');
        await p.point('@coach-stage');
      },
    },
    {
      label: 'It says what to ask next',
      voiceover:
        'Curtis says the upstairs never cools down. The coach suggests a question that gets him talking about what that’s really like.',
      change: (w, at) =>
        addCard(
          w,
          {
            id: s47(0x31),
            kind: 'question',
            title: 'Find out what it’s costing him',
            say: 'What’s it like up there on a hot afternoon? Who in the family feels it most?',
            heard:
              'The upstairs never really cools down, and last month’s bill was almost four hundred dollars.',
            tip: 'Sound curious, then let him talk.',
            at,
          },
          's3',
        ),
      live: COACH_LIVE,
      run: async (p) => {
        await p.waitFor('@coach-card');
        await p.point('@coach-card');
      },
    },
    {
      label: 'He pushes back on price',
      voiceover:
        'Then he pushes back on the price. The coach brings up your own answer to that, with a tip on how to say it.',
      change: (w, at) =>
        addCard(
          w,
          {
            id: s47(0x32),
            kind: 'objection',
            title: 'More than he wanted to spend',
            say: 'That’s fair. Can I ask what number you had in mind? Let’s put it next to what the old unit costs you every month in bills and repairs.',
            heard: 'Honestly, that’s more than I wanted to spend.',
            tip: 'Slow down, and don’t drop the price.',
            at,
          },
          's5',
        ),
      live: COACH_LIVE,
      run: async (p) => {
        // The newest card is on top: wait for the second to be drawn, then point at the top one's tip.
        await p.waitFor('[data-testid="coach-card"]:nth-child(2)');
        await p.point('@coach-tip');
      },
    },
    {
      label: 'It flags the moment to close',
      voiceover:
        'When he warms up to the monthly payments, the coach flags the moment to ask for the yes.',
      change: (w, at) =>
        addCard(
          w,
          {
            id: s47(0x33),
            kind: 'step',
            title: 'Ask for the yes',
            say: 'It sounds like the quieter two-stage unit fits. Want me to put the install on the calendar for next week?',
            heard: 'Okay, with the monthly payments that makes sense.',
            tip: 'Ask, then wait for his answer.',
            at,
          },
          's6',
        ),
      live: COACH_LIVE,
      run: async (p) => {
        await p.waitFor('[data-testid="coach-card"]:nth-child(3)');
        await p.point('@coach-stage');
        await p.point('@coach-card');
      },
    },
    {
      label: 'The call is written up',
      voiceover:
        'When the call ends, the coach writes it up with a score, so you can see what worked and what to try next time.',
      change: (w, at) => {
        const c = coachIn(w);
        c.state = 'writing';
        c.endedAt = at;
      },
      live: COACH_LIVE,
      run: (p) => p.point('@coach-live'),
    },
  ],
};

export const CALLS_COACH_SCENES: readonly DemoScene[] = [aiCallsLead, salesCoach];
