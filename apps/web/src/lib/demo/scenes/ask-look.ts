import { businessOf, fullName, wallTime, type DemoPerson, type DemoWorld } from '../world';
import {
  askScene,
  approveTextCard,
  customer,
  dollars,
  idsFor,
  lastCard,
  pageOf,
  personPage,
  PREPARING,
  ran,
  rangeWords,
  reply,
  textCard,
  textsSent,
} from './ask-kit';
import { clock, daysUntil, myFirstName, shortDay, zoneName } from './kit';
import type { DemoScene } from './types';

/**
 * Ask HandsFreeOS scenes that start with a question about the business (23, 30, 56–59, 66): it looks things up,
 * answers in a few lines with the cards it found, and offers to do the next thing on a card you say yes to.
 */

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const ago = (at: number, minutes: number) => new Date(at - minutes * MIN).toISOString();
const home = (w: DemoWorld, itemId: string) => `/app/w/${w.workspaceId}?item=${itemId}`;

// ---------- 23. “What needs me today?” ----------

const s23 = idsFor(23);
const LINDA = customer(s23(1), 'Linda', 'Park', 2301, 'Katy');
const MARCUS = customer(s23(2), 'Marcus', 'Bell', 2302, 'Sugar Land');
const GINA = customer(s23(3), 'Gina', 'Torres', 2303, 'Pearland');

const lindaDraft = (w: DemoWorld) =>
  approveTextCard(w, s23(0x11), LINDA, {
    theyWrote: 'Our AC is blowing warm air and it’s 88 in the house. Can someone come today?',
    body: `Hi Linda, I’m sorry, that sounds miserable. We have a tech free today at 3:30 PM. Want me to book it? – ${businessOf(w)}`,
  });
const marcusDraft = (w: DemoWorld) =>
  approveTextCard(w, s23(0x12), MARCUS, {
    theyWrote: 'How much is it to replace a 40 gallon water heater?',
    body: `Hi Marcus, a 40-gallon gas water heater, installed with the old one hauled away, usually runs $1,600 to $1,900. We can give you an exact price on a quick visit. Would tomorrow morning work?`,
  });
const ginaText = (w: DemoWorld) =>
  `Hi Gina, it’s ${myFirstName(w)} from ${businessOf(w)}. I’m so sorry for the wait. I’ll call you in 10 minutes to sort out your furnace.`;

const whatNeedsMe = askScene({
  id: 'what-needs-me',
  number: 23,
  title: '“What needs me today?”',
  open: 'Start the day by asking what needs you. Open Ask HandsFreeOS from any page.',
  beats: [
    {
      ask: 'What needs me today?',
      label: 'Ask: what needs me today?',
      voiceover:
        'Ask what needs you today. It reads the Action Center and puts the most important things first: replies your AI teammate is holding for you, an upset customer, and a late invoice.',
      answer: (w, at) => ({
        steps: ran('Checking the Action Center'),
        shows: [
          {
            type: 'attention',
            affected: { cents: 262_000, total: 4, urgent: 2, scope: 'mine' },
            items: [
              {
                title: 'Gina Torres · Furnace repair',
                detail: 'Customer waiting · sounds upset',
                tone: 'danger',
                waitingSince: ago(at, 125),
                href: home(w, s23(0x21)),
                itemId: s23(0x21),
                kind: 'customer_waiting',
                chips: [
                  { code: 'waiting', text: 'waiting 2 h' },
                  { code: 'upset', text: 'sounds upset' },
                ],
              },
              {
                title: 'Linda Park · AC not cooling',
                detail: 'Approval · new customer',
                tone: 'warning',
                waitingSince: ago(at, 25),
                href: home(w, s23(0x22)),
                itemId: s23(0x22),
                kind: 'ai_approval',
                chips: [{ code: 'waiting', text: 'waiting 25 min' }],
              },
              {
                title: 'Marcus Bell · Water heater',
                detail: 'Approval · asked about price',
                tone: 'warning',
                waitingSince: ago(at, 12),
                href: home(w, s23(0x23)),
                itemId: s23(0x23),
                kind: 'ai_approval',
                chips: [{ code: 'waiting', text: 'waiting 12 min' }],
              },
              {
                title: 'Gary Holt · INV-1162',
                detail: 'Invoice overdue · $980',
                tone: 'danger',
                waitingSince: null,
                href: home(w, s23(0x24)),
                itemId: s23(0x24),
                kind: 'invoice_overdue',
                chips: [{ code: 'overdue', text: '34 days overdue' }],
                valueCents: 98_000,
              },
            ],
          },
        ],
        text: `**4 things** need you today. Gina Torres has waited two hours and sounds upset about her furnace. ${w.state.teammate} wrote replies to Linda Park and Marcus Bell and is holding them for your OK. And Gary Holt’s $980 invoice is 34 days late. Want me to send ${w.state.teammate}’s two replies?`,
      }),
    },
    {
      ask: 'Yes, send both replies.',
      label: 'Ask it to send both replies',
      voiceover:
        'Ask it to send both replies. Each one comes up on a card, with what the customer wrote and what your AI teammate wants to say back.',
      answer: (w) => ({
        steps: ran('Getting the draft ready', 'Getting the draft ready'),
        text: `Here they are. Each goes out from ${w.state.teammate}, with your name on it, as soon as you say yes.`,
        cards: [lindaDraft(w), marcusDraft(w)],
      }),
    },
    {
      confirm: 2,
      label: 'Say yes to both',
      voiceover: 'Say yes to both. Two new customers answered, and you never opened the inbox.',
    },
    {
      ask: 'Text Gina that I’ll call her in 10 minutes.',
      label: 'Ask it to text Gina',
      voiceover:
        'Gina is upset, so she should hear from you, not the AI. Ask it to text her that you’ll call in ten minutes. It writes it in your words.',
      answer: (w) => ({
        steps: ran('Searching customers', PREPARING),
        text: 'Here’s a short text from you. It goes from your business number once you say yes.',
        cards: [textCard(s23(0x13), GINA, ginaText(w))],
      }),
    },
    {
      confirm: 1,
      label: 'Say yes to the text',
      voiceover:
        'Say yes. Four things that needed you, handled in under a minute, before your first job.',
      change: (w, at) =>
        textsSent(w, at, [
          { conversation: s23(0x31), message: s23(0x32), person: GINA, body: ginaText(w) },
        ]),
      live: ['conversation'],
    },
  ],
});

// ---------- 30. “Tell me about the Garcias.” ----------

const s30 = idsFor(30);
const MARIA = customer(s30(1), 'Maria', 'Garcia', 3001, 'Bellaire', null);
const mariaText = (w: DemoWorld) =>
  `Hi Maria, it’s ${myFirstName(w)} from ${businessOf(w)}. Just checking in on the estimate for your new AC system. Any questions I can answer before your tune-up on Tuesday?`;
const MARIA_REPLY = s30(0x41);

const tellMeAbout = askScene({
  id: 'tell-me-about',
  number: 30,
  title: '“Tell me about the Garcias.”',
  open: 'A customer calls and you can’t remember the last job. Open Ask HandsFreeOS.',
  beats: [
    {
      ask: 'Tell me about the Garcias.',
      label: 'Ask: tell me about the Garcias',
      voiceover:
        'Ask it to tell you about the Garcias. Every job, invoice, message and note for one family, in one answer.',
      answer: (w, at) => {
        const tz = w.state.timeZone;
        const tuesday = wallTime(at, tz, daysUntil(at, tz, 2), 9);
        return {
          steps: ran('Searching customers', 'Looking at the customer', 'Looking at their money'),
          shows: [
            {
              type: 'customer',
              personId: MARIA.id,
              fullName: fullName(MARIA),
              detail: '(713) 555-3001 · 4410 Bellaire Blvd',
              href: personPage(w, MARIA),
              lead: { title: 'New AC system', stageName: 'Quoted', valueCents: 1_180_000 },
              waitingSince: null,
            },
            {
              type: 'appointment',
              appointmentId: s30(0x21),
              what: 'AC tune-up',
              customer: fullName(MARIA),
              when: rangeWords(tuesday, 60, tz),
              with: w.state.me.name,
              status: 'scheduled',
              href: pageOf(w, 'calendar'),
            },
            {
              type: 'money',
              title: fullName(MARIA),
              value: '$0',
              detail: 'nothing owed',
              tone: 'accent',
              stats: [
                { value: '$4,215', label: 'paid so far' },
                { value: '$11,800', label: 'quoted and waiting' },
              ],
              items: [
                {
                  title: 'EST-1042 · New AC system',
                  detail: `$11,800 · sent ${shortDay(at - 5 * DAY, tz)}`,
                  status: 'Viewed',
                  tone: 'accent',
                  href: null,
                },
              ],
              href: personPage(w, MARIA),
            },
          ],
          text: `**Maria and Hector Garcia** have been customers since 2023. You’ve done 6 jobs for them, most recently a furnace repair in February, and they’ve paid $4,215, every invoice on time.\n\nOpen now: an estimate for a new AC system, **$11,800**, sent 5 days ago and opened twice. Their next visit is an AC tune-up on Tuesday at 9:00 AM. The notes say there’s a dog in the backyard, and the gate code is 2580.`,
        };
      },
    },
    {
      ask: 'Text Maria to see if she has questions about the estimate.',
      label: 'Ask it to check in about the estimate',
      voiceover:
        'They opened the estimate twice but haven’t said yes. Ask it to check in. It knows about Tuesday’s visit, so the text does too.',
      answer: (w) => ({
        steps: ran(PREPARING),
        text: 'Here’s a friendly check-in that mentions Tuesday’s visit. It goes from your business number once you say yes.',
        cards: [textCard(s30(0x11), MARIA, mariaText(w))],
      }),
    },
    {
      confirm: 1,
      label: 'Say yes to the text',
      voiceover: 'Say yes, and it goes.',
      change: (w, at) =>
        textsSent(w, at, [
          { conversation: s30(0x31), message: s30(0x32), person: MARIA, body: mariaText(w) },
        ]),
      live: ['conversation'],
    },
    reply({
      label: 'Maria texts back',
      voiceover:
        'Maria texts back. An eleven-thousand-dollar job moving again, from one question and one tap.',
      conversation: s30(0x31),
      message: MARIA_REPLY,
      body: 'Yes! Hector and I want to go over the two options. Can we do that when you come Tuesday?',
    }),
  ],
});

// ---------- 56. “What happened while I was on the job?” ----------

const s56 = idsFor(56);
const TOM = customer(s56(1), 'Tom', 'Becker', 5601, 'Cypress');
const TOM_ASKED = 'If I do both units at once, can you knock something off?';
const TOM_BODY =
  'Hi Tom, good news: doing both units in one visit saves us a trip, so we can take 10% off the pair. Want me to put you down for Thursday morning?';

const whileOnTheJob = askScene({
  id: 'while-on-the-job',
  number: 56,
  title: '“What happened while I was on the job?”',
  open: 'You’ve been in an attic all afternoon. Back in the truck, open Ask HandsFreeOS.',
  beats: [
    {
      ask: 'What happened while I was on the job?',
      label: 'Ask: what happened while I was on the job?',
      voiceover:
        'Ask what happened while you were on the job. A short rundown: new leads, what your AI teammate booked, and the one thing that needs you.',
      answer: (w) => ({
        steps: ran('Counting', 'Checking the inbox', 'Looking at what the AI teammate wrote'),
        shows: [
          {
            type: 'numbers',
            label: 'New leads',
            value: '3',
            delta: null,
            stats: [
              { value: '1 won', label: '$2,450' },
              { value: '11', label: 'Messages in' },
              { value: '1', label: 'Missed calls' },
            ],
            href: pageOf(w, 'pipeline'),
          },
          {
            type: 'list',
            title: '1 draft waiting',
            items: [
              {
                title: `${w.state.teammate} asks: 10% off for ${fullName(TOM)}`,
                detail: TOM_BODY,
                tone: 'warning',
                href: null,
              },
            ],
          },
        ],
        text: `Since noon: **3 new leads**, 11 messages and 1 missed call. ${w.state.teammate} answered all three leads and booked two: a furnace check for the Nguyens tomorrow at 10:00 AM, and a duct cleaning for Sara Kim on Monday. The missed call was Sara, and ${w.state.teammate} texted her right back. The Hendersons also said yes to their $2,450 ductwork quote.\n\nOne thing waits on you: Tom Becker asked for a deal on doing both of his units, and ${w.state.teammate} won’t give a discount without your OK.`,
      }),
    },
    {
      ask: 'Approve Tom’s discount.',
      label: 'Ask it to approve Tom’s discount',
      voiceover:
        'Your AI teammate never gives money away on its own. Ask it to approve Tom’s discount, and the card shows exactly what goes out.',
      answer: (w) => ({
        steps: ran('Getting the draft ready'),
        text: `Here’s ${w.state.teammate}’s reply with the 10% off. It goes to Tom as soon as you say yes.`,
        cards: [
          approveTextCard(w, s56(0x11), TOM, {
            theyWrote: TOM_ASKED,
            body: TOM_BODY,
            discount: '10% off: both units in one visit',
          }),
        ],
      }),
    },
    {
      confirm: 1,
      label: 'Say yes to the discount',
      voiceover: 'Say yes. The reply goes out with your OK on it.',
      change: (w, at) => {
        w.conversations.unshift({
          id: s56(0x31),
          person: TOM,
          createdAt: at - 40 * MIN,
          unread: 0,
          messages: [
            { id: s56(0x32), at: at - 40 * MIN, direction: 'inbound', body: TOM_ASKED },
            {
              id: s56(0x33),
              at,
              direction: 'outbound',
              body: TOM_BODY,
              teammate: true,
              approved: true,
            },
          ],
          drafts: [],
          visits: [],
        });
      },
      live: ['conversation'],
    },
    reply({
      label: 'Tom says yes',
      voiceover: 'Tom says yes. Two units sold while you were still in the truck.',
      conversation: s56(0x31),
      message: s56(0x34),
      body: 'Deal. Thursday morning works. Thanks!',
    }),
  ],
});

// ---------- 57. “Which leads haven’t heard back from us?” ----------

const s57 = idsFor(57);
interface Quiet {
  readonly person: DemoPerson;
  readonly lead: string;
  readonly stage: string;
  readonly cents: number;
  readonly days: number;
  readonly text: (w: DemoWorld) => string;
}
const QUIET: readonly Quiet[] = [
  {
    person: customer(s57(1), 'Nora', 'Alvarez', 5701, 'Spring'),
    lead: 'Attic insulation',
    stage: 'New',
    cents: 320_000,
    days: 4,
    text: (w) =>
      `Hi Nora, it’s ${myFirstName(w)} from ${businessOf(w)}. Sorry for the slow reply! Are you still thinking about attic insulation? I can come take a look this week.`,
  },
  {
    person: customer(s57(2), 'Paul', 'Greene', 5702, 'Bellaire'),
    lead: 'Thermostat upgrade',
    stage: 'Quoted',
    cents: 68_000,
    days: 3,
    text: (w) =>
      `Hi Paul, it’s ${myFirstName(w)} from ${businessOf(w)}. Any questions on the smart thermostat quote? Happy to walk you through it, or book the install whenever suits you.`,
  },
  {
    person: customer(s57(3), 'Deb', 'Walsh', 5703, 'Katy'),
    lead: 'Second AC unit',
    stage: 'New',
    cents: 790_000,
    days: 2,
    text: (w) =>
      `Hi Deb, it’s ${myFirstName(w)} from ${businessOf(w)}. Following up on the second AC unit for your upstairs. Would a free visit to measure up help?`,
  },
];

const leadsWaiting = askScene({
  id: 'leads-waiting',
  number: 57,
  title: '“Which leads haven’t heard back from us?”',
  open: 'Leads go cold when nobody follows up. Open Ask HandsFreeOS.',
  beats: [
    {
      ask: 'Which leads haven’t heard back from us?',
      label: 'Ask which leads haven’t heard back',
      voiceover:
        'Ask which leads haven’t heard back from you. It finds the ones with nothing from you in over two days, and what they’re worth.',
      answer: (w) => ({
        steps: ran('Looking at leads'),
        shows: [
          {
            type: 'list',
            title: `${QUIET.length} leads`,
            items: QUIET.map((q, i) => ({
              title: `${q.lead} · ${fullName(q.person)}`,
              detail: `${q.stage} · ${dollars(q.cents)} · no next action`,
              tone: 'warning',
              href: pageOf(w, `leads/${s57(0x21 + i)}`),
            })),
          },
        ],
        text: `${QUIET.length} leads haven’t heard from you in over two days, worth **${dollars(QUIET.reduce((n, q) => n + q.cents, 0))}** together. Nora Alvarez has waited longest: 4 days, about attic insulation. Want me to text each of them?`,
      }),
    },
    {
      ask: 'Yes, text each of them.',
      label: 'Ask it to text each one',
      voiceover:
        'Ask it to text each one. Every text is written for that person and that job, not a mass message.',
      answer: (w) => ({
        steps: ran(...QUIET.map(() => PREPARING)),
        text: 'Here’s a text for each, written for their job. They go from your business number once you say yes.',
        cards: QUIET.map((q, i) => textCard(s57(0x11 + i), q.person, q.text(w))),
      }),
    },
    {
      confirm: QUIET.length,
      label: 'Say yes to each text',
      voiceover: 'Say yes to each. Three follow-ups that would have slipped through the cracks.',
      change: (w, at) =>
        textsSent(
          w,
          at,
          QUIET.map((q, i) => ({
            conversation: s57(0x31 + i),
            message: s57(0x41 + i),
            person: q.person,
            body: q.text(w),
          })),
        ),
      live: ['conversation'],
    },
    reply({
      label: 'Nora texts back',
      voiceover: 'Nora texts back within minutes. A cold lead, warm again.',
      conversation: s57(0x31),
      message: s57(0x51),
      body: 'Yes, still want it done before it gets cold! Can you come look Thursday?',
    }),
  ],
});

// ---------- 58. “What did the AI teammate do today?” ----------

const s58 = idsFor(58);
const BEN = customer(s58(1), 'Ben', 'Ortiz', 5801, 'Pasadena');
const BEN_ASKED = 'Do you guys service tankless water heaters?';
const BEN_BODY =
  'Hi Ben, yes we do! We service and repair all the major tankless brands. Is yours acting up, or is it time for its yearly flush?';

const teammateToday = askScene({
  id: 'teammate-today',
  number: 58,
  title: '“What did the AI teammate do today?”',
  open: 'Your AI teammate works all day. At the end of it, open Ask HandsFreeOS and check in.',
  beats: [
    {
      ask: 'What did the AI teammate do today?',
      label: 'Ask what the AI teammate did today',
      voiceover:
        'Ask what your AI teammate did today. Who it talked to, what it booked, and what it handed to you.',
      answer: (w) => {
        const tm = w.state.teammate;
        return {
          steps: ran(
            'Checking the inbox',
            'Looking at what the AI teammate wrote',
            'Looking at appointments',
          ),
          shows: [
            {
              type: 'list',
              title: '6 conversations',
              items: [
                ['Sara Kim', 'Booked: duct cleaning, Monday 9:00 AM'],
                ['Hai Nguyen', 'Booked: furnace check, tomorrow 10:00 AM'],
                ['Carla Mendes', 'Answered: a tune-up is $89, with a link to book'],
                ['Gina Torres', 'Handed to you: a repeat furnace problem'],
                ['Ben Ortiz', 'Reply waiting for your OK'],
                ['Joe Price', 'Confirmed tomorrow’s 8:00 AM visit'],
              ].map(([who, what]) => ({
                title: who!,
                detail: what!,
                tone: who === 'Gina Torres' || who === 'Ben Ortiz' ? 'warning' : 'muted',
                href: null,
              })),
            },
          ],
          text: `${tm} had **6 conversations** today. It answered 3 new people within a minute and booked 2 visits: Sara Kim’s duct cleaning on Monday and the Nguyens’ furnace check tomorrow. It answered Carla Mendes’s price question from your price list, and confirmed Joe Price for tomorrow morning.\n\nIt handed one to you: Gina Torres has the same furnace problem again, so ${tm} let a person take it. And one reply, to Ben Ortiz, is waiting for your OK.`,
        };
      },
    },
    {
      ask: 'Send the one that’s waiting.',
      label: 'Ask it to send the waiting reply',
      voiceover:
        'While it’s learning your business, your AI teammate asks before it sends. Ask it to send the one that’s waiting.',
      answer: (w) => ({
        steps: ran('Getting the draft ready'),
        text: `Here’s ${w.state.teammate}’s reply to Ben. It goes as soon as you say yes.`,
        cards: [approveTextCard(w, s58(0x11), BEN, { theyWrote: BEN_ASKED, body: BEN_BODY })],
      }),
    },
    {
      confirm: 1,
      label: 'Say yes to the reply',
      voiceover:
        'Say yes. Every OK teaches it, and once it has earned your trust it can reply on its own.',
    },
  ],
});

// ---------- 59. “What’s open on Friday?” ----------

const s59 = idsFor(59);
const DEB = customer(s59(1), 'Deb', 'Walsh', 5901, 'Katy');
const FRIDAY_JOBS: readonly (readonly [
  hour: number,
  minute: number,
  minutes: number,
  what: string,
  who: string,
])[] = [
  [8, 0, 60, 'AC tune-up', 'Jim'],
  [9, 30, 60, 'Thermostat install', 'Paul'],
  [13, 0, 120, 'Duct cleaning', 'Hendersons'],
  [15, 30, 60, 'Filter change', 'Tina'],
];
const OPEN_TIMES: readonly (readonly [hour: number, minute: number])[] = [
  [10, 30],
  [11, 0],
  [11, 30],
  [12, 0],
];
const fridayOf = (at: number, tz: string) => daysUntil(at, tz, 5);
const debText = (w: DemoWorld) =>
  `Hi Deb, it’s ${myFirstName(w)} from ${businessOf(w)}. I had a spot open up: I can come measure for your second AC unit this Friday at 10:30 AM. Does that work?`;

const openFriday = askScene({
  id: 'open-friday',
  number: 59,
  title: '“What’s open on Friday?”',
  open: 'Planning the week? Open Ask HandsFreeOS instead of the calendar.',
  beats: [
    {
      ask: 'What’s open on Friday?',
      label: 'Ask: what’s open on Friday?',
      voiceover: 'Ask what’s open on Friday. Friday’s jobs, and the gaps you could still fill.',
      answer: (w, at) => {
        const tz = w.state.timeZone;
        const days = fridayOf(at, tz);
        const friday = wallTime(at, tz, days, 12);
        const date = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date(friday));
        return {
          steps: ran('Looking at appointments', 'Checking open times'),
          shows: [
            {
              type: 'list',
              title: 'Appointments',
              aside: `${shortDay(friday, tz)} · ${zoneName(tz, friday)}`,
              items: FRIDAY_JOBS.map(([h, m, , what, who]) => {
                const start = wallTime(at, tz, days, h, m);
                return {
                  title: `${clock(start, tz)} · ${what} · ${who}`,
                  detail: `${shortDay(start, tz)} · Scheduled`,
                  tone: 'accent' as const,
                  href: null,
                };
              }),
            },
            {
              type: 'slots',
              title: 'Service calls',
              zone: zoneName(tz, friday),
              timezone: tz,
              calendar: { id: s59(0x21), name: 'Service calls' },
              service: null,
              person: null,
              durationMinutes: 60,
              days: [
                {
                  date,
                  label: shortDay(friday, tz),
                  times: OPEN_TIMES.map(([h, m]) => {
                    const t = wallTime(at, tz, days, h, m);
                    return { startsAt: new Date(t).toISOString(), label: clock(t, tz) };
                  }),
                },
              ],
              href: pageOf(w, 'calendar'),
            },
          ],
          text: `Friday has **4 jobs**: an AC tune-up at 8:00, a thermostat install at 9:30, the Hendersons’ duct cleaning at 1:00 and a filter change at 3:30. You’re open from **10:30 AM to 1:00 PM**, room for one or two hour-long visits.`,
        };
      },
    },
    {
      ask: 'Text Deb Walsh that we can measure for her second unit Friday at 10:30.',
      label: 'Ask it to offer Deb the 10:30',
      voiceover:
        'Deb Walsh wants a quote on a second AC unit. Ask it to offer her the 10:30. A gap in your day becomes a sales visit.',
      answer: (w) => ({
        steps: ran('Searching customers', PREPARING),
        text: 'Here’s a text offering Deb the 10:30 on Friday. It goes from your business number once you say yes.',
        cards: [textCard(s59(0x11), DEB, debText(w))],
      }),
    },
    {
      confirm: 1,
      label: 'Say yes to the text',
      voiceover: 'Say yes, and it goes.',
      change: (w, at) =>
        textsSent(w, at, [
          { conversation: s59(0x31), message: s59(0x32), person: DEB, body: debText(w) },
        ]),
      live: ['conversation'],
    },
    reply({
      label: 'Deb takes the spot',
      voiceover: 'Deb takes the spot. Friday is fuller, and you never opened the calendar.',
      conversation: s59(0x31),
      message: s59(0x33),
      body: 'Perfect, 10:30 Friday works. See you then!',
    }),
  ],
});

// ---------- 66. “What should I do next?” ----------

const s66 = idsFor(66);
const ROSA = customer(s66(1), 'Rosa', 'Jimenez', 6601, 'Sugar Land');
const GARY = customer(s66(2), 'Gary', 'Holt', 6602, 'Houston');
const rosaText = (w: DemoWorld) =>
  `Hi Rosa, it’s ${myFirstName(w)} from ${businessOf(w)}. Thanks for reaching out about a new AC system! I can come take a look tomorrow at 9:00 AM or 2:00 PM. Which works better?`;
const garyText = (w: DemoWorld) =>
  `Hi Gary, it’s ${myFirstName(w)} from ${businessOf(w)}. Just a friendly nudge on invoice INV-1162 for $980, for your water heater install. You can pay it from the link in your invoice email, or reply here and I’ll send it again.`;

const doNext = askScene({
  id: 'do-next',
  number: 66,
  title: '“What should I do next?”',
  open: 'Got ten minutes between jobs? Open Ask HandsFreeOS and let it pick.',
  beats: [
    {
      ask: 'What should I do next?',
      label: 'Ask: what should I do next?',
      voiceover:
        'Ask what you should do next. It picks the most urgent thing waiting on you, says why, and offers to handle it.',
      answer: (w, at) => ({
        steps: ran('Checking the Action Center', PREPARING),
        shows: [
          {
            type: 'attention',
            affected: { cents: 1_180_000 + 98_000 + 4_200 * 2, total: 3, urgent: 1, scope: 'mine' },
            items: [
              {
                title: 'Rosa Jimenez · New AC system',
                detail: 'Hot lead · $11,800 · asked for a quote',
                tone: 'danger',
                waitingSince: ago(at, 40),
                href: home(w, s66(0x21)),
                itemId: s66(0x21),
                kind: 'hot_lead',
                chips: [
                  { code: 'waiting', text: 'waiting 40 min' },
                  { code: 'value', text: '$11,800' },
                ],
                valueCents: 1_180_000,
              },
              {
                title: 'Gary Holt · INV-1162',
                detail: 'Invoice overdue · $980',
                tone: 'warning',
                waitingSince: null,
                href: home(w, s66(0x22)),
                itemId: s66(0x22),
                kind: 'invoice_overdue',
                chips: [{ code: 'overdue', text: '34 days overdue' }],
                valueCents: 98_000,
              },
              {
                title: 'Order the 20x25x4 filters for Walt Fisher',
                detail: 'Overdue task',
                tone: 'muted',
                waitingSince: null,
                href: home(w, s66(0x23)),
                itemId: s66(0x23),
                kind: 'overdue_task',
                chips: [{ code: 'overdue', text: '1 day overdue' }],
              },
            ],
          },
        ],
        text: `Start with **Rosa Jimenez**. She asked about a new AC system 40 minutes ago and nobody has answered yet. At $11,800 it’s the biggest job waiting on you, and a lead like that goes cold fast. I wrote her a text offering two times to come look. Want me to send it?`,
        cards: [textCard(s66(0x11), ROSA, rosaText(w))],
      }),
    },
    {
      confirm: 1,
      label: 'Say yes to the text',
      voiceover: 'Say yes. Your biggest lead hears from you while she’s still shopping around.',
      change: (w, at) =>
        textsSent(w, at, [
          { conversation: s66(0x31), message: s66(0x32), person: ROSA, body: rosaText(w) },
        ]),
      live: ['conversation'],
    },
    {
      ask: 'What’s next after that?',
      label: 'Ask: what’s next after that?',
      voiceover: 'Ask what’s next. It moves down the list, and offers to handle that one too.',
      answer: (w) => ({
        steps: ran('Checking the Action Center', PREPARING),
        text: 'Next is **Gary Holt’s invoice**: $980, 34 days late, and his automatic reminders haven’t worked. A short personal note from you usually does. Here’s one.',
        cards: [textCard(s66(0x12), GARY, garyText(w))],
      }),
      point: lastCard('confirm'),
    },
    {
      confirm: 1,
      label: 'Say yes to the nudge',
      voiceover:
        'Say yes. Ten minutes between jobs, and the two things that mattered most are done.',
      change: (w, at) =>
        textsSent(w, at, [
          { conversation: s66(0x33), message: s66(0x34), person: GARY, body: garyText(w) },
        ]),
      live: ['conversation'],
    },
  ],
});

export const ASK_LOOK_SCENES: readonly DemoScene[] = [
  whatNeedsMe,
  tellMeAbout,
  whileOnTheJob,
  leadsWaiting,
  teammateToday,
  openFriday,
  doNext,
];
