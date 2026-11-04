import { businessOf, fullName, phoneDisplay, wallTime, type DemoWorld } from '../world';
import {
  askScene,
  atWords,
  customer,
  dollars,
  dueWords,
  idsFor,
  lastCard,
  nthWeekday,
  pageOf,
  PREPARING,
  ran,
  rangeWords,
  reply,
  textCard,
  textsSent,
  today,
} from './ask-kit';
import { clock, daysUntil, myFirstName, shortDay } from './kit';
import type { DemoScene } from './types';

/**
 * Ask HandsFreeOS scenes that start with something to do (24–29, 60–64): it gets the change ready on a card worded
 * as the worker words it, you say yes, and it's done.
 */

const MIN = 60_000;
const DAY = 24 * 60 * MIN;

/** A local date (`YYYY-MM-DD`) `days` from `at`, where the business is. */
const localDay = (at: number, days: number, timeZone: string) =>
  new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date(at + days * DAY));

/** "Fri, Dec 4", for a local date, as the money cards write one. */
const dateWords = (date: string) =>
  new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  }).format(new Date(`${date}T12:00:00Z`));

// ---------- 24. An estimate from one sentence ----------

const s24 = idsFor(24);
const CAROL = customer(s24(1), 'Carol', 'Jensen', 2401, 'Spring');
const CAROL_EMAIL = 'carol.jensen@example.com';
const ESTIMATE = s24(0x21);
const ESTIMATE_LINES = [
  {
    name: '50-gallon gas water heater',
    description: '6-year warranty',
    quantity: 1,
    unitPriceCents: 145_000,
  },
  {
    name: 'Install, haul-away and parts',
    description: 'New venting, gas line and the old tank taken away',
    quantity: 1,
    unitPriceCents: 48_500,
  },
  { name: 'City permit', description: null, quantity: 1, unitPriceCents: 8_500 },
] as const;
const ESTIMATE_TOTAL = ESTIMATE_LINES.reduce((n, l) => n + l.unitPriceCents * l.quantity, 0);
const ESTIMATE_FOR = '50-gallon water heater, installed';

const estimateSentence = askScene({
  id: 'estimate-sentence',
  number: 24,
  title: 'An estimate from one sentence',
  open: 'You just looked at Carol’s old water heater. Before you leave her driveway, open Ask HandsFreeOS.',
  beats: [
    {
      ask: 'Quote Carol Jensen a 50-gallon water heater, installed.',
      label: 'Ask for the estimate in one sentence',
      voiceover:
        'Say what you’d quote, in one sentence. It writes the estimate with your prices, line by line, and shows it to you on a card.',
      answer: (w, at) => ({
        steps: ran('Searching customers', 'Writing the estimate'),
        text: `Here’s an estimate for Carol: the heater, the install and the permit, **${dollars(ESTIMATE_TOTAL)}** in all, good for 30 days. It stays a draft until you send it.`,
        cards: [
          {
            toolCallId: s24(0x11),
            tool: 'write_estimate',
            title: `Write an estimate for ${fullName(CAROL)}`,
            fields: [
              { label: 'Customer', value: fullName(CAROL) },
              { label: 'For', value: ESTIMATE_FOR },
              ...ESTIMATE_LINES.map((l) => ({
                label: l.name,
                value: `1 each × ${dollars(l.unitPriceCents)}${l.name === 'City permit' ? ' · no tax' : ''}`,
              })),
              { label: 'Total', value: dollars(ESTIMATE_TOTAL) },
              { label: 'Deposit', value: 'None' },
              { label: 'Good until', value: dateWords(localDay(at, 30, w.state.timeZone)) },
            ],
            note: 'It stays a draft. Nothing goes to Carol until you send it.',
            confirmLabel: 'Save the draft',
            outcome: `Draft estimate for ${fullName(CAROL)} saved · ${dollars(ESTIMATE_TOTAL)}`,
          },
        ],
      }),
    },
    {
      confirm: 1,
      label: 'Save the draft',
      voiceover: 'Looks right, so save it.',
    },
    {
      ask: 'Text it to her.',
      label: 'Ask it to text the estimate to Carol',
      voiceover:
        'Ask it to text the estimate to Carol. She can read it and approve it on her phone.',
      answer: () => ({
        steps: ran(PREPARING),
        text: 'Ready to go by text. Sending gives it its number and locks it, so what Carol approves is exactly what you quoted.',
        cards: [
          {
            toolCallId: s24(0x12),
            tool: 'send_estimate',
            title: `Send this estimate to ${fullName(CAROL)}`,
            fields: [
              { label: 'To', value: fullName(CAROL) },
              { label: 'How', value: 'Text' },
              { label: 'Total', value: dollars(ESTIMATE_TOTAL) },
              { label: 'For', value: ESTIMATE_FOR },
            ],
            warnings: [
              {
                kind: 'freezes',
                text: 'Sending takes its number and freezes it. Changing it afterwards means voiding and reissuing.',
              },
            ],
            confirmLabel: 'Send it',
            outcome: 'Sent EST-1048',
            opens: `money/estimates/${ESTIMATE}`,
          },
        ],
      }),
    },
    {
      confirm: 1,
      label: 'Send it',
      voiceover: 'Send it. The quote is in her hands before you’ve started the truck.',
      change: (w, at) => {
        w.estimates.push({
          id: ESTIMATE,
          number: 'EST-1048',
          title: ESTIMATE_FOR,
          person: CAROL,
          email: CAROL_EMAIL,
          lines: ESTIMATE_LINES,
          createdAt: at - 2 * MIN,
          sentAt: at,
          viewedAt: at + 90_000,
          expiresOn: localDay(at, 30, w.state.timeZone),
        });
      },
      live: ['estimate'],
    },
    {
      step: {
        label: 'Carol approves it on her phone',
        voiceover:
          'A few minutes later Carol approves it, right on her phone, by typing her name. Her name and the moment she approved are kept with the estimate.',
        change: (w, at) => {
          const e = w.estimates.find((x) => x.id === ESTIMATE);
          if (e) e.accepted = { at, name: fullName(CAROL) };
        },
        live: ['estimate'],
        run: async (p) => {
          await p.closeAssistant();
          await p.go(`money/estimates/${ESTIMATE}`);
          await p.point('@document-activity');
        },
      },
    },
  ],
});

// ---------- 25. Sign someone up for the maintenance plan ----------

const s25 = idsFor(25);
const RACHEL = customer(s25(1), 'Rachel', 'Moore', 2501, 'The Woodlands');
const PLAN = 'Yearly maintenance';

const maintenancePlan = askScene({
  id: 'maintenance-plan',
  number: 25,
  title: 'Sign someone up for the maintenance plan',
  open: 'Rachel loved her tune-up and asked about your plan. Open Ask HandsFreeOS.',
  beats: [
    {
      ask: 'Put Rachel Moore on the yearly maintenance plan and text her the card link.',
      label: 'Ask it to put Rachel on the plan',
      voiceover:
        'Ask it to put Rachel on your yearly plan and text her the link for her card. One card shows the plan, the price and what it includes.',
      answer: () => ({
        steps: ran('Searching customers', 'Getting their plan ready'),
        text: `Here’s Rachel on ${PLAN}, $189 a year. She gets a text with a link to add her card, and nothing is billed until she does.`,
        cards: [
          {
            toolCallId: s25(0x11),
            tool: 'manage_customer_plan',
            title: `Put ${fullName(RACHEL)} on ${PLAN}`,
            fields: [
              { label: 'Customer', value: fullName(RACHEL) },
              { label: 'Plan', value: PLAN },
              { label: 'Price', value: '$189 a year' },
              {
                label: 'Includes',
                value: 'Two tune-ups a year; 15% off repairs; No overtime charges',
              },
              { label: 'Bills through', value: 'Stripe' },
              { label: 'Card link', value: `Text · ${phoneDisplay(RACHEL.phone)}` },
            ],
            note: `Nothing is billed until Rachel puts a card on it on their own page. It keeps what it costs today, whatever the plan costs later.`,
            warnings: [
              {
                kind: 'caution',
                text: 'Texts Rachel the link to add a card as soon as it starts.',
              },
            ],
            confirmLabel: 'Start the plan',
            outcome: `${fullName(RACHEL)} is on ${PLAN} — the card link is on its way`,
          },
        ],
      }),
    },
    {
      confirm: 1,
      label: 'Start the plan',
      voiceover: 'Start the plan. Money every year, and two visits on the calendar.',
    },
    {
      ask: 'Who else had a tune-up this year but isn’t on the plan?',
      label: 'Ask who else could join the plan',
      voiceover:
        'Now ask who else had a tune-up this year but isn’t on the plan. Your next plan sign-ups, in one list.',
      answer: (w, at) => {
        const tz = w.state.timeZone;
        const people: readonly (readonly [string, number])[] = [
          ['Walt Fisher', 32],
          ['Joan Riley', 47],
          ['Sam Patel', 63],
          ['Carla Mendes', 88],
          ['Hector Garcia', 121],
        ];
        return {
          steps: ran('Looking at appointments', 'Looking at plans'),
          shows: [
            {
              type: 'list',
              title: `${people.length} customers`,
              items: people.map(([who, days]) => ({
                title: who,
                detail: `Tune-up ${shortDay(at - days * DAY, tz)} · not on a plan`,
                tone: 'accent' as const,
                href: null,
              })),
            },
          ],
          text: `**${people.length} customers** had a tune-up this year and aren’t on a plan. At $189 a year each, that’s **$945** a year if they all join. Want me to text them about it?`,
        };
      },
    },
  ],
});

// ---------- 26. “Remind me to call Tom back Friday.” ----------

const s26 = idsFor(26);
const TOM = customer(s26(1), 'Tom', 'Reyes', 2601, 'Humble');
const tomText = (w: DemoWorld) =>
  `Hi Tom, it’s ${myFirstName(w)} from ${businessOf(w)}. Sorry I missed you! I’ll give you a call Friday morning to talk through the furnace options.`;

const remindMe = askScene({
  id: 'remind-me',
  number: 26,
  title: '“Remind me to call Tom back Friday.”',
  open: 'You’re under a sink when Tom calls. Later, open Ask HandsFreeOS.',
  beats: [
    {
      ask: 'Remind me to call Tom Reyes back Friday morning.',
      label: 'Ask it to remind you to call Tom',
      voiceover:
        'Ask it to remind you to call Tom back on Friday. It makes the task with the right day and time, on Tom’s record, so nothing lives on a sticky note.',
      answer: (w, at) => {
        const tz = w.state.timeZone;
        const due = wallTime(at, tz, daysUntil(at, tz, 5), 9);
        return {
          steps: ran('Searching customers', 'Adding the task'),
          shows: [
            {
              type: 'done',
              toolCallId: s26(0x11),
              kind: 'task',
              title: 'Call Tom Reyes back',
              detail: `You · ${dueWords(due, tz)}`,
              href: pageOf(w, 'tasks'),
              undoable: true,
            },
          ],
          text: `Done. **Call Tom Reyes back** is on your tasks for Friday at 9:00 AM, and on Tom’s page, so anyone who opens his record sees it.`,
        };
      },
    },
    {
      ask: 'And text him that I’ll call Friday morning.',
      label: 'Ask it to let Tom know',
      voiceover: 'Ask it to let Tom know. He won’t wonder whether you got his message.',
      answer: (w) => ({
        steps: ran(PREPARING),
        text: 'Here’s a quick text so Tom knows you got his message.',
        cards: [textCard(s26(0x12), TOM, tomText(w))],
      }),
    },
    {
      confirm: 1,
      label: 'Say yes to the text',
      voiceover: 'Say yes. Tom is looked after, and Friday morning it reminds you.',
      change: (w, at) =>
        textsSent(w, at, [
          { conversation: s26(0x31), message: s26(0x32), person: TOM, body: tomText(w) },
        ]),
      live: ['conversation'],
    },
  ],
});

// ---------- 27. Build an automation by asking ----------

const s27 = idsFor(27);
const THANKS = 'Thank-you after a job';
/** A step's line as the workflow card writes a text: the words in curly quotes, cut at 60 letters. */
const sendLine = (body: string) =>
  `Send a text: “${body.length > 60 ? `${body.slice(0, 59)}…` : body}”`;
const THANKS_TEXT =
  'Hi {{person.first_name}}, thanks for having us out today! If we did a good job, would you leave us a quick review?';
const workflowCard = (w: DemoWorld, wait: string) => ({
  type: 'workflow' as const,
  workflowId: null,
  proposalId: s27(0x21),
  name: THANKS,
  status: 'proposal' as const,
  trigger: 'When an appointment is completed',
  steps: [wait, sendLine(THANKS_TEXT)],
  more: 0,
  changes: [],
  issues: 0,
  issueNote: null,
  unsupported: [],
  href: pageOf(w, `workflows/new?proposal=${s27(0x21)}&name=thank-you-after-a-job`),
});

const automationByAsking = askScene({
  id: 'automation-by-asking',
  number: 27,
  title: 'Build an automation by asking',
  open: 'Automations used to mean an afternoon with a flowchart. Open Ask HandsFreeOS instead.',
  beats: [
    {
      ask: 'Every time a job is marked done, text a thank-you with our review link.',
      label: 'Describe the automation in a sentence',
      voiceover:
        'Say what you want to happen, in a sentence. It builds the automation: what starts it, and each step after.',
      answer: (w) => ({
        steps: ran('Drafting the workflow'),
        shows: [workflowCard(w, 'Wait 2 hours')],
        text: `Here’s a draft: **${THANKS}**. When an appointment is marked done, it waits two hours, then texts a thank-you with your Google review link. Nothing runs yet. Open it to read the whole text, test it on yourself, and turn it on.`,
      }),
    },
    {
      ask: 'Make it wait until 10 the next morning instead.',
      label: 'Change it by asking',
      voiceover:
        'Change it the same way. It shows you the new version, and still nothing runs until you open it, test it and turn it on.',
      answer: (w) => ({
        steps: ran('Drafting the workflow'),
        shows: [workflowCard(w, 'Wait until 10:00 AM')],
        text: 'Changed: it now waits until 10:00 AM, so a job finished late in the day gets its thank-you the next morning, never at night.',
      }),
      point: lastCard('workflow'),
    },
  ],
});

// ---------- 28. Teach the teammate something new ----------

const s28 = idsFor(28);
/** The Friday after Thanksgiving (the fourth Thursday of November), this year's or next year's if it's gone. */
function blackFriday(at: number, timeZone: string): string {
  const { y, m, d } = today(at, timeZone);
  const thanksgiving = nthWeekday(y, 11, 4, 4);
  const passed = m > 11 || (m === 11 && d > Number(thanksgiving.slice(-2)) + 1);
  const t = passed ? nthWeekday(y + 1, 11, 4, 4) : thanksgiving;
  const friday = new Date(`${t}T12:00:00Z`);
  friday.setUTCDate(friday.getUTCDate() + 1);
  return friday.toISOString().slice(0, 10);
}
const monthDay = (date: string) =>
  new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' }).format(
    new Date(`${date}T12:00:00Z`),
  );
const longDay = (date: string) =>
  new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  }).format(new Date(`${date}T12:00:00Z`));
const HOLIDAY_ASK = 'Are you open the day after Thanksgiving? Our heat is acting up again.';

const teachTeammate = askScene({
  id: 'teach-teammate',
  number: 28,
  title: 'Teach the teammate something new',
  open: 'Your AI teammate should know when you’re closed. Open Ask HandsFreeOS and just tell it.',
  beats: [
    {
      ask: 'We’re closed the Friday after Thanksgiving.',
      label: 'Tell it you’re closed that day',
      voiceover:
        'Tell it you’re closed the Friday after Thanksgiving. It updates what your AI teammate knows, and blocks the day on your calendar so nobody books it.',
      answer: (w, at) => {
        const day = blackFriday(at, w.state.timeZone);
        return {
          steps: ran('Changing what your AI knows', 'Changing your hours'),
          text: `Two changes: your AI teammate will know you’re closed on ${longDay(day)}, so a customer who asks hears it right, and the day comes off your calendar so nobody can book it.`,
          cards: [
            {
              toolCallId: s28(0x11),
              tool: 'update_knowledge_profile',
              title: 'Change what your AI knows about the business',
              fields: [
                {
                  label: 'Hours',
                  value: `Mon–Fri 7 AM–6 PM, Sat 8 AM–noon. Closed Thanksgiving Day and the Friday after (${monthDay(day)}).`,
                },
              ],
              confirmLabel: 'Save the change',
              outcome: 'Saved',
              opens: 'knowledge/profile',
            },
            {
              toolCallId: s28(0x12),
              tool: 'update_my_hours',
              title: 'Put time off in your calendar',
              fields: [
                { label: 'When', value: monthDay(day) },
                { label: 'What it is', value: 'Closed the Friday after Thanksgiving' },
              ],
              note: 'Nobody can book you then. Visits already booked stay.',
              confirmLabel: 'Book the time off',
              outcome: 'Time off is in your calendar',
              opens: 'settings/my-calendar',
            },
          ],
        };
      },
    },
    {
      confirm: 2,
      label: 'Say yes to both',
      voiceover: 'Say yes to both. You told it once, in plain words.',
    },
    {
      step: {
        label: 'A customer asks about that day',
        voiceover:
          'Later, a customer asks if you’re open that day. Your AI teammate gets it right, and offers the next open day instead.',
        change: (w, at) => {
          const day = blackFriday(at, w.state.timeZone);
          w.teammateAutomatic = true;
          w.conversations.unshift({
            id: s28(0x31),
            person: customer(s28(1), 'Joan', 'Riley', 2801, 'Kingwood'),
            createdAt: at,
            unread: 1,
            messages: [
              { id: s28(0x32), at, direction: 'inbound', body: HOLIDAY_ASK },
              {
                id: s28(0x33),
                at: at + 40_000,
                direction: 'outbound',
                body: `Hi Joan, we’re closed on ${longDay(day)} for the holiday, sorry! We’re back the next morning. Want me to book you the first visit then so we can look at your heat?`,
                teammate: true,
              },
            ],
            drafts: [],
            visits: [],
          });
        },
        live: ['conversation', 'message'],
        run: async (p) => {
          await p.closeAssistant();
          await p.go('inbox');
          await p.click(`@conversation-row-${s28(0x31)}`);
          await p.waitFor('@conversation');
          await p.point(`@message-${s28(0x33)}`);
        },
      },
    },
  ],
});

// ---------- 29. Add a teammate ----------

const s29 = idsFor(29);
const MIKE_EMAIL = 'mike.torres@example.com';

const addTeammate = askScene({
  id: 'add-teammate',
  number: 29,
  title: 'Add a teammate',
  open: 'You just hired a technician. Skip the settings pages and open Ask HandsFreeOS.',
  beats: [
    {
      ask: `Add Mike Torres as a technician. His email is ${MIKE_EMAIL}.`,
      label: 'Ask it to add Mike',
      voiceover:
        'Ask it to add Mike as a technician. It picks the right access for the job and shows you before it sends the invite.',
      answer: (w) => ({
        steps: ran('Setting up the team'),
        text: 'I’ll invite Mike as a **Member**: he can work customers, leads and the inbox, but can’t change how the business is set up.',
        cards: [
          {
            toolCallId: s29(0x11),
            tool: 'manage_team',
            title: `Invite ${MIKE_EMAIL}`,
            fields: [
              { label: 'Email', value: MIKE_EMAIL },
              { label: 'Role', value: 'Member — works customers, leads and the inbox' },
              { label: 'Business', value: w.state.business },
            ],
            note: 'They get an email from HandsFreeOS inviting them in.',
            confirmLabel: 'Send the invitation',
            outcome: `Invitation sent to ${MIKE_EMAIL}`,
            opens: 'members',
          },
        ],
      }),
    },
    {
      confirm: 1,
      label: 'Send the invitation',
      voiceover: 'Send the invitation. That’s the whole setup.',
    },
    {
      ask: 'What happens when Mike says yes?',
      label: 'Ask what happens next',
      voiceover:
        'Ask what happens next. Mike signs in on the web or the phone app, and works the same customers and inbox as you.',
      answer: () => ({
        steps: [],
        text: 'Mike gets an email from HandsFreeOS. Once he accepts, he can sign in on the web or the HandsFreeOS phone app and work customers, leads and the inbox. Owners and admins still decide how the business is set up, and you can put him on the calendar for his jobs.',
      }),
    },
  ],
});

// ---------- 60. “Rain tomorrow. Move my outdoor jobs to next week.” ----------

const s60 = idsFor(60);
interface Outdoor {
  readonly first: string;
  readonly last: string;
  readonly what: string;
  readonly hour: number;
  readonly minute: number;
  readonly minutes: number;
  /** Where it goes next week: which weekday (1 Monday) and hour. */
  readonly to: readonly [weekday: number, hour: number, minute: number];
}
const OUTDOOR: readonly Outdoor[] = [
  {
    first: 'Jim',
    last: 'Carter',
    what: 'condenser cleaning',
    hour: 9,
    minute: 0,
    minutes: 60,
    to: [1, 9, 0],
  },
  {
    first: 'Alma',
    last: 'Ruiz',
    what: 'outdoor unit install',
    hour: 10,
    minute: 30,
    minutes: 180,
    to: [2, 8, 0],
  },
  {
    first: 'Ken',
    last: 'Brooks',
    what: 'rooftop unit service',
    hour: 14,
    minute: 0,
    minutes: 90,
    to: [1, 13, 0],
  },
];
/** Days from `at` to a weekday of the week after tomorrow's. */
function nextWeek(at: number, timeZone: string, weekday: number): number {
  const monday = 1 + daysUntil(at + DAY, timeZone, 1);
  return monday + (weekday - 1);
}

const rainDay = askScene({
  id: 'rain-day',
  number: 60,
  title: '“Rain tomorrow. Move my outdoor jobs to next week.”',
  open: 'The forecast says rain all day tomorrow. Open Ask HandsFreeOS.',
  beats: [
    {
      ask: 'Rain tomorrow. Move my outdoor jobs to next week.',
      label: 'Ask it to move tomorrow’s outdoor jobs',
      voiceover:
        'Tell it it’s going to rain and to move your outdoor jobs to next week. It finds them, checks next week is free, and puts each move on a card.',
      answer: (w, at) => {
        const tz = w.state.timeZone;
        return {
          steps: ran(
            'Looking at appointments',
            'Checking open times',
            ...OUTDOOR.map(() => PREPARING),
          ),
          text: `Tomorrow has **${OUTDOOR.length} outdoor jobs**. Here’s each one moved to a free time next week. Every customer gets a text with their new time once you say yes.`,
          cards: OUTDOOR.map((o, i) => {
            const was = wallTime(at, tz, 1, o.hour, o.minute);
            const now = wallTime(at, tz, nextWeek(at, tz, o.to[0]), o.to[1], o.to[2]);
            return {
              toolCallId: s60(0x11 + i),
              tool: 'reschedule_appointment',
              title: `Move ${o.first}’s ${o.what}?`,
              fields: [
                { label: 'Was', value: rangeWords(was, o.minutes, tz) },
                { label: 'Now', value: rangeWords(now, o.minutes, tz) },
                { label: 'With', value: w.state.me.name },
                { label: `Tell ${o.first}`, value: 'A text with the new time' },
              ],
              confirmLabel: 'Move',
              outcome: `Moved to ${atWords(now, tz)}.`,
              opens: 'calendar',
            };
          }),
        };
      },
    },
    {
      confirm: OUTDOOR.length,
      label: 'Say yes to each move',
      voiceover:
        'Say yes to each. Three jobs moved and three customers told, in the time it takes to check the weather.',
    },
  ],
});

// ---------- 61. “Tell Linda we’re running 20 minutes late.” ----------

const s61 = idsFor(61);
const LINDA = customer(s61(1), 'Linda', 'Chen', 6101, 'Bellaire');
const HALF_HOUR = 30 * MIN;
/** Her visit: the next half hour at least 45 minutes away. */
const visitAt = (at: number) => Math.ceil((at + 45 * MIN) / HALF_HOUR) * HALF_HOUR;
const lateText = (w: DemoWorld, at: number) => {
  const tz = w.state.timeZone;
  const start = visitAt(at);
  return `Hi Linda, it’s ${myFirstName(w)} from ${businessOf(w)}. I’m running about 20 minutes behind, so I’ll be there around ${clock(start + 20 * MIN, tz)} instead of ${clock(start, tz)}. Sorry about that!`;
};

const runningLate = askScene({
  id: 'running-late',
  number: 61,
  title: '“Tell Linda we’re running 20 minutes late.”',
  open: 'The last job ran long, and your next customer is waiting. Open Ask HandsFreeOS.',
  beats: [
    {
      ask: 'Tell Linda we’re running 20 minutes late.',
      label: 'Ask it to tell Linda you’re late',
      voiceover:
        'Ask it to tell Linda you’re running twenty minutes late. It knows which Linda from today’s schedule, and works out the new time for you.',
      answer: (w, at) => {
        const tz = w.state.timeZone;
        const start = visitAt(at);
        return {
          steps: ran('Looking at today', PREPARING),
          shows: [
            {
              type: 'appointment',
              appointmentId: s61(0x21),
              what: 'AC repair',
              customer: fullName(LINDA),
              when: rangeWords(start, 60, tz),
              with: w.state.me.name,
              status: 'scheduled',
              href: pageOf(w, 'calendar'),
            },
          ],
          text: `Your ${clock(start, tz)} is Linda Chen’s AC repair. Here’s a text letting her know you’ll be there about ${clock(start + 20 * MIN, tz)}.`,
          cards: [textCard(s61(0x11), LINDA, lateText(w, at))],
        };
      },
    },
    {
      confirm: 1,
      label: 'Say yes to the text',
      voiceover: 'Say yes. No calls while driving, and Linda isn’t left wondering.',
      change: (w, at) =>
        textsSent(w, at, [
          { conversation: s61(0x31), message: s61(0x32), person: LINDA, body: lateText(w, at) },
        ]),
      live: ['conversation'],
    },
    reply({
      label: 'Linda writes back',
      voiceover:
        'Linda writes back. A small thing that makes you look like the most organized company in town.',
      conversation: s61(0x31),
      message: s61(0x33),
      body: 'No problem at all, thanks for the heads up! The side gate is open.',
    }),
  ],
});

// ---------- 62. “Tag everyone who had a water heater put in this year.” ----------

const s62 = idsFor(62);
const INSTALLS: readonly (readonly [first: string, last: string, daysAgo: number])[] = [
  ['Gary', 'Holt', 12],
  ['Carol', 'Jensen', 19],
  ['Sam', 'Patel', 33],
  ['Monica', 'Ruiz', 41],
  ['Walt', 'Fisher', 58],
  ['Joan', 'Riley', 74],
  ['Derek', 'Lane', 90],
  ['Hector', 'Garcia', 103],
  ['Tina', 'Shaw', 131],
  ['Paul', 'Greene', 150],
  ['Rosa', 'Jimenez', 177],
  ['Ben', 'Ortiz', 204],
  ['Alma', 'Ruiz', 233],
  ['Ken', 'Brooks', 262],
];

const tagWaterHeaters = askScene({
  id: 'tag-water-heaters',
  number: 62,
  title: '“Tag everyone who had a water heater put in this year.”',
  open: 'Winter’s coming, and water heaters need a flush. Open Ask HandsFreeOS.',
  beats: [
    {
      ask: 'Tag everyone who had a water heater put in this year.',
      label: 'Ask it to tag this year’s water heater installs',
      voiceover:
        'Ask it to tag everyone who had a water heater put in this year. It finds the jobs and the customers behind them, and tags them all on one card.',
      answer: (w, at) => {
        const tz = w.state.timeZone;
        const tag = `Water heater ${today(at, tz).y}`;
        const names = INSTALLS.map(([f, l]) => `${f} ${l}`);
        return {
          steps: ran('Looking at appointments', PREPARING),
          shows: [
            {
              type: 'list',
              title: 'Appointments',
              items: INSTALLS.slice(0, 12).map(([first, , days]) => ({
                title: `${shortDay(at - days * DAY, tz)} · Water heater install · ${first}`,
                detail: 'Completed',
                tone: 'muted' as const,
                href: null,
              })),
            },
          ],
          text: `**${INSTALLS.length} customers** had a water heater put in this year. Here’s a new tag for all of them, ready for a campaign.`,
          cards: [
            {
              toolCallId: s62(0x11),
              tool: 'tag_customers',
              title: `Change the tags on ${INSTALLS.length} customers?`,
              fields: [
                {
                  label: 'Customers',
                  value: `${names.slice(0, 3).join(', ')}, ${INSTALLS.length - 3} more people`,
                },
                { label: 'Put on', value: tag },
                { label: 'New tags', value: tag },
                { label: 'Why', value: 'Had a water heater put in this year' },
              ],
              note: `Adds a new tag: ${tag}.`,
              confirmLabel: 'Change tags',
              outcome: `Tags changed on ${INSTALLS.length} of ${INSTALLS.length}`,
              opens: 'customers',
            },
          ],
        };
      },
    },
    {
      confirm: 1,
      label: 'Say yes to the tags',
      voiceover: 'Say yes. Fourteen customers tagged, without opening a single record.',
    },
    {
      ask: 'How many of them are on a maintenance plan?',
      label: 'Ask how many are on a plan',
      voiceover:
        'Ask how many are on a maintenance plan. Now you know who to offer a winter flush, and who to offer the plan.',
      answer: () => ({
        steps: ran('Looking at plans'),
        text: '**4 of the 14** are on a plan, so their flush is already covered. The other **10** are a good list for a winter flush offer, or the plan itself.',
      }),
    },
  ],
});

// ---------- 63. “Keep the AI teammate quiet after 9 at night.” ----------

const s63 = idsFor(63);

const quietHours = askScene({
  id: 'quiet-hours',
  number: 63,
  title: '“Keep the AI teammate quiet after 9 at night.”',
  open: 'Nobody wants a text from a business at 10 at night. Open Ask HandsFreeOS.',
  beats: [
    {
      ask: 'Keep the AI teammate quiet after 9 at night.',
      label: 'Ask for quiet hours after 9',
      voiceover:
        'Ask it to keep things quiet after nine at night. One card changes your quiet hours.',
      answer: () => ({
        steps: ran('Changing texting and calls'),
        text: 'Quiet hours will run from **9:00 PM to 8:00 AM**.',
        cards: [
          {
            toolCallId: s63(0x11),
            tool: 'update_texting_settings',
            title: 'Change texting and calls',
            fields: [{ label: 'Quiet hours', value: '21:00–08:00' }],
            confirmLabel: 'Save the change',
            outcome: 'Saved',
            opens: 'settings/texting',
          },
        ],
      }),
    },
    {
      confirm: 1,
      label: 'Save the change',
      voiceover: 'Save it.',
    },
    {
      ask: 'What if a customer texts at 10 PM?',
      label: 'Ask what happens if someone texts late',
      voiceover:
        'Ask what happens if a customer texts at ten. Nothing goes out on its own at night, but a customer who writes in still gets an answer.',
      answer: () => ({
        steps: [],
        text: 'From 9:00 PM to 8:00 AM, nothing goes out on its own: follow-ups, reminders and campaign texts wait until morning. If a customer texts in during that time, your AI teammate still answers their text soon after it comes in, so nobody is left hanging.',
      }),
    },
  ],
});

// ---------- 64. “Kevin said yes. Mark it won and send the invoice.” ----------

const s64 = idsFor(64);
const KEVIN = customer(s64(1), 'Kevin', 'Nguyen', 6401, 'Pearland');
const KEVIN_CENTS = 685_000;
const invoiceText = (w: DemoWorld, due: string) =>
  `${businessOf(w)}: Here’s your invoice INV-1191 for ${dollars(KEVIN_CENTS)}, for your furnace replacement, due ${due}. You can pay it here: https://app.handsfreeos.com/i/1191kN4p`;

const wonAndInvoice = askScene({
  id: 'won-and-invoice',
  number: 64,
  title: '“Kevin said yes. Mark it won and send the invoice.”',
  open: 'Kevin just said yes on the phone. Open Ask HandsFreeOS before you forget.',
  beats: [
    {
      ask: 'Kevin Nguyen said yes. Mark it won and send the invoice.',
      label: 'Ask it to mark it won and send the invoice',
      voiceover:
        'Say Kevin said yes. It moves his job to Won and gets the invoice ready to send, each on its own card.',
      answer: (w, at) => {
        const due = dateWords(localDay(at, 14, w.state.timeZone));
        return {
          steps: ran(
            'Searching customers',
            'Looking at the lead',
            PREPARING,
            'Getting the invoice ready',
          ),
          text: `Kevin’s furnace replacement moves from Quoted to **Won**, and the invoice from his estimate goes to him by text: **${dollars(KEVIN_CENTS)}**, due ${due}.`,
          cards: [
            {
              toolCallId: s64(0x11),
              tool: 'move_lead',
              title: 'Mark this lead as won?',
              fields: [
                {
                  label: 'Lead',
                  value: `Furnace replacement · ${fullName(KEVIN)} · ${dollars(KEVIN_CENTS)}`,
                },
              ],
              stageFrom: 'Quoted',
              stageTo: 'Won',
              confirmLabel: 'Move lead',
              outcome: 'Moved to Won',
            },
            {
              toolCallId: s64(0x12),
              tool: 'manage_invoice',
              title: `Send an invoice to ${fullName(KEVIN)}`,
              fields: [
                { label: 'To', value: fullName(KEVIN) },
                { label: 'How', value: `Text · ${phoneDisplay(KEVIN.phone)}` },
                { label: 'Total', value: dollars(KEVIN_CENTS) },
                { label: 'For', value: 'Furnace replacement' },
                { label: 'Due', value: due },
                { label: 'Number', value: 'INV-1191' },
                { label: 'Paid into', value: 'Stripe' },
              ],
              warnings: [
                {
                  kind: 'caution',
                  text: 'It goes to Kevin now and is frozen: a mistake afterwards means voiding and writing a new one.',
                },
              ],
              confirmLabel: 'Send it',
              outcome: `Sent INV-1191 to ${fullName(KEVIN)}`,
            },
          ],
        };
      },
    },
    {
      confirm: 2,
      label: 'Say yes to both',
      voiceover: 'Say yes to both. Your pipeline is right, and the invoice is on Kevin’s phone.',
      change: (w, at) =>
        textsSent(w, at, [
          {
            conversation: s64(0x31),
            message: s64(0x32),
            person: KEVIN,
            body: invoiceText(w, dateWords(localDay(at, 14, w.state.timeZone))),
          },
        ]),
      live: ['conversation'],
    },
    reply({
      label: 'Kevin pays and says thanks',
      voiceover:
        'Kevin pays from the link that night. Said yes, invoiced and paid, in one evening.',
      conversation: s64(0x31),
      message: s64(0x33),
      body: 'Just paid it. Thanks for getting us warm again!',
    }),
  ],
});

export const ASK_DO_SCENES: readonly DemoScene[] = [
  estimateSentence,
  maintenancePlan,
  remindMe,
  automationByAsking,
  teachTeammate,
  addTeammate,
  rainDay,
  runningLate,
  tagWaterHeaters,
  quietHours,
  wonAndInvoice,
];
