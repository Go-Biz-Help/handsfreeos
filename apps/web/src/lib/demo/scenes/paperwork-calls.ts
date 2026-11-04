import { businessOf, fullName, type DemoWorld } from '../world';
import { beatStep, dollars, idsFor, PREPARING, ran } from './ask-kit';
import { DAY, halfHourBefore, localDate, MIN } from './calendar-kit';
import { myFirstName } from './kit';
import { newPerson, regular } from './teammate-kit';
import type { DemoPlayer, DemoScene } from './types';

/**
 * Paperwork and calls: a contract signed on a phone (33), a recorded call that turns into a task and a follow-up
 * email (37), and a quote right after a HandsFreeOS video call, whose summary and chat stay on the lead (38).
 */

/** "Fri, Dec 4", for a local date, as the money cards write one. */
const dateWords = (date: string) =>
  new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  }).format(new Date(`${date}T12:00:00Z`));

/** The first suggestion still waiting on the call's notes: its first button approves it. */
const NEXT_SUGGESTION = '[data-testid="call-suggestion"][data-status="pending"] button';

// ----------------------------------------------------------------------------------- 33. sign the contract on a phone

const s33 = idsFor(33);
const AGREEMENT = s33(0x21);
const HEATHER = newPerson(
  s33(1),
  'Heather',
  'Malone',
  3301,
  'Bellaire',
  'heather.malone@example.com',
);

function agreementIn(w: DemoWorld) {
  const d = w.documents.find((x) => x.id === AGREEMENT);
  if (!d) throw new Error('The scene’s agreement is missing.');
  return d;
}

export const signOnPhone: DemoScene = {
  id: 'sign-on-phone',
  number: 33,
  title: 'Sign the contract on a phone',
  kind: 'app',
  startsOn: `documents/${AGREEMENT}`,
  // Sent a few minutes ago, by text and email, from the installation agreement template.
  setup: (w, at) => {
    w.documents.push({
      id: AGREEMENT,
      name: 'AC system installation agreement',
      person: HEATHER,
      email: HEATHER.email!,
      pdf: '/demo/install-agreement.pdf',
      pages: [{ width: 612, height: 792 }],
      spots: {
        signature: { x: 0.105, y: 0.696, w: 0.408, h: 0.053 },
        name: { x: 0.105, y: 0.794, w: 0.408, h: 0.02 },
        date: { x: 0.595, y: 0.729, w: 0.301, h: 0.02 },
      },
      sentAt: at - 4 * MIN,
    });
  },
  steps: [
    {
      label: 'Open Heather’s agreement',
      voiceover:
        'A new AC system is a big job, so it gets a signed agreement first. You sent Heather yours a few minutes ago, by text and email.',
      run: (p) => p.point('@document-signer'),
    },
    {
      label: 'Heather opens it on her phone',
      voiceover: 'Heather opens it on her phone. You see the moment she does.',
      change: (w, at) => {
        agreementIn(w).openedAt = at;
      },
      live: ['document'],
      run: async (p) => {
        await p.waitFor('[data-testid="document-steps"] li:nth-child(4)', 15_000);
        await p.point('[data-testid="document-steps"] li:last-child');
      },
    },
    {
      label: 'She signs with her finger',
      voiceover:
        'She reads it, agrees to sign electronically, and signs with her finger. No printer, no scanner, no trip back to her house.',
      change: (w, at) => {
        agreementIn(w).signed = {
          at,
          device: 'iPhone · Safari',
          image: '/demo/signature-heather.svg',
        };
      },
      live: ['document'],
      run: async (p) => {
        await p.waitFor('[data-testid="document-status"]', 15_000);
        await p.waitFor('[data-testid="document-pages"] img[alt^="Signed by"]', 15_000);
        await p.point('[data-testid="document-pages"] img[alt^="Signed by"]');
      },
    },
    {
      label: 'Every step is on the record',
      voiceover:
        'Every step is kept: when it went out, when she opened it, when she agreed and signed, and on what. The signed copy goes on her file, locked, so it can’t be changed.',
      run: (p) => p.point('@document-steps'),
    },
  ],
};

// ------------------------------------------------------------------------------------- 37. a call turns into tasks

const s37 = idsFor(37);
const CONSULT = s37(0x21);
const TASK = s37(0x31);
const FOLLOW_UP = s37(0x32);

function consultNotes(w: DemoWorld) {
  const v = w.visits.find((x) => x.id === CONSULT);
  if (!v?.notes) throw new Error('The scene’s call is missing.');
  return v.notes;
}

export const callToTasks: DemoScene = {
  id: 'call-to-tasks',
  number: 37,
  title: 'A call turns into tasks',
  kind: 'app',
  startsOn: `calendar?view=day&appt=${CONSULT}`,
  // A recorded Zoom call earlier today with a dental office's manager, about the two units on its roof.
  setup: (w, at) => {
    const starts = halfHourBefore(at - 2 * 60 * MIN);
    const me = myFirstName(w);
    w.visits.push({
      id: CONSULT,
      person: newPerson(
        s37(1),
        'Celeste',
        'Reyes',
        3701,
        'Houston',
        'celeste@lonestardental.example.com',
      ),
      title: 'Rooftop units: Lone Star Dental',
      startsAt: starts,
      minutes: 30,
      bookedAt: at - 3 * DAY,
      completed: true,
      source: 'staff',
      video: 'zoom',
      notes: {
        id: s37(0x22),
        at: starts + 34 * MIN,
        summary:
          'Celeste Reyes, office manager at Lone Star Dental, says the two rooftop units over the front office are 14 years old, and the waiting room runs warm by mid-afternoon. She wants options to replace one or both before summer, and needs a written quote for the building’s owner. Next steps: measure both units on the roof, then send her two options in writing.',
        transcript: [
          `${w.state.me.name}: Thanks for making time, Celeste. Tell me what’s going on with the units.`,
          'Celeste Reyes: We have two on the roof over the front office. They’re about 14 years old, and the waiting room gets warm by three o’clock.',
          `${w.state.me.name}: Are both running, or is one struggling more than the other?`,
          'Celeste Reyes: The one over the waiting room. It runs all day and still can’t keep up.',
          `${w.state.me.name}: At that age, replacing it usually costs less than another summer of repairs. I’d like to come measure both, then send you two options: the one unit, or both at once.`,
          'Celeste Reyes: That works. I need something in writing for the owner of the building.',
          `${w.state.me.name}: Easy. I’ll email you today to set up a time to come out.`,
        ].join('\n'),
        suggestions: [
          {
            id: TASK,
            kind: 'task',
            preview: { title: 'Measure both rooftop units at Lone Star Dental' },
            status: 'pending',
          },
          {
            id: FOLLOW_UP,
            kind: 'follow_up',
            preview: {
              subject: 'Next steps on your rooftop units',
              body: `Hi Celeste,\n\nThanks for the call today. As we talked about, I’ll come out to measure both rooftop units, then send you two options in writing: replacing the unit over the waiting room, or both at once.\n\nWhat morning this week works for me to come by?\n\n${me}\n${businessOf(w)}`,
            },
            status: 'pending',
          },
        ],
      },
    });
  },
  steps: [
    {
      label: 'Open today’s call',
      voiceover:
        'Earlier today you had a recorded Zoom call with Celeste, the office manager at a dental office. Once the call ended, the AI went through what was said.',
      run: (p) => p.point('@call-review'),
    },
    {
      label: 'It writes the summary',
      voiceover:
        'It writes the summary for you: what she needs, why, and what happens next. It’s on her record already.',
      run: (p) => p.point('[data-testid="call-review"] > p'),
    },
    {
      label: 'Approve the task',
      voiceover: 'It suggests a task: measure both units. One tap, and it’s on your list.',
      change: (w) => {
        const s = consultNotes(w).suggestions.find((x) => x.id === TASK);
        if (s) s.status = 'approved';
      },
      run: async (p) => {
        await p.click(NEXT_SUGGESTION);
        await p.waitFor('[data-testid="call-suggestion"][data-status="approved"]', 15_000);
      },
    },
    {
      label: 'Send the follow-up email',
      voiceover:
        'And it wrote the follow-up email you promised her, in your words. Read it, then one more tap sends it.',
      change: (w) => {
        const s = consultNotes(w).suggestions.find((x) => x.id === FOLLOW_UP);
        if (s) s.status = 'approved';
      },
      run: async (p) => {
        await p.point('[data-testid="call-suggestion"][data-status="pending"] textarea');
        await p.wait(1_200);
        await p.click(NEXT_SUGGESTION);
        await p.waitFor(
          '[data-testid="call-review"]:not(:has([data-testid="call-suggestion"][data-status="pending"]))',
          15_000,
        );
      },
    },
    {
      label: 'The whole call is kept',
      voiceover:
        'Two taps, and nothing from the call is forgotten. The whole conversation is kept too, word for word, if you ever need it.',
      run: async (p) => {
        await p.click('[data-testid="appointment-transcript"] summary');
        await p.point('[data-testid="appointment-transcript"] p');
      },
    },
  ],
};

// ----------------------------------------------------------------------------------------- 38. a quote over video

const s38 = idsFor(38);
const LAUREN = newPerson(s38(1), 'Lauren', 'Hayes', 3801, 'Kingwood');
const LAUREN_LEAD = s38(0x21);
const LAUREN_CALL = s38(0x22);
const COIL_ESTIMATE = s38(0x23);
const COIL_LINES = [
  {
    name: 'Evaporator coil, 3-ton',
    description: 'Matched to her system, 10-year parts warranty',
    quantity: 1,
    unitPriceCents: 125_000,
  },
  {
    name: 'Install, refrigerant and parts',
    description: 'Recover and recharge, new drier, leak test',
    quantity: 1,
    unitPriceCents: 60_000,
  },
] as const;
const COIL_TOTAL = COIL_LINES.reduce((n, l) => n + l.unitPriceCents * l.quantity, 0);
const COIL_FOR = 'Evaporator coil replacement';

/** The notes dialog sits over the page: closed before Ask HandsFreeOS opens. */
async function closeDialog(p: DemoPlayer): Promise<void> {
  const close = document.querySelector<HTMLElement>('[role="dialog"] button[aria-label="Close"]');
  if (close) {
    await p.click('[role="dialog"] button[aria-label="Close"]');
    await p.wait(400);
  }
}

const askForQuote = beatStep({
  ask: 'Write Lauren Hayes an estimate for a new evaporator coil, installed, $1,850.',
  label: 'Ask for the quote',
  voiceover:
    'Right after the call, ask for the quote in one sentence. It writes the estimate line by line, at your prices.',
  answer: (w, at) => ({
    steps: ran('Searching customers', 'Writing the estimate'),
    text: `Here’s an estimate for Lauren: the coil and the install, **${dollars(COIL_TOTAL)}** in all, good for 30 days. It stays a draft until you send it.`,
    cards: [
      {
        toolCallId: s38(0x11),
        tool: 'write_estimate',
        title: `Write an estimate for ${fullName(LAUREN)}`,
        fields: [
          { label: 'Customer', value: fullName(LAUREN) },
          { label: 'For', value: COIL_FOR },
          ...COIL_LINES.map((l) => ({
            label: l.name,
            value: `1 each × ${dollars(l.unitPriceCents)}`,
          })),
          { label: 'Total', value: dollars(COIL_TOTAL) },
          { label: 'Deposit', value: 'None' },
          { label: 'Good until', value: dateWords(localDate(at, 30, w.state.timeZone)) },
        ],
        note: 'It stays a draft. Nothing goes to Lauren until you send it.',
        confirmLabel: 'Save the draft',
        outcome: `Draft estimate for ${fullName(LAUREN)} saved · ${dollars(COIL_TOTAL)}`,
      },
    ],
  }),
});

export const videoQuote: DemoScene = {
  id: 'video-quote',
  number: 38,
  title: 'A quote over video',
  kind: 'assistant',
  startsOn: `leads/${LAUREN_LEAD}`,
  // Twenty minutes ago Lauren showed the unit in her attic on a HandsFreeOS video call from her texts.
  setup: (w, at) => {
    const ended = at - 20 * MIN;
    const me = w.state.me.name;
    w.leads.push({
      id: LAUREN_LEAD,
      title: 'AC not cooling',
      person: regular(LAUREN, at, 3),
      stage: 'New',
      valueCents: COIL_TOTAL,
      source: 'Text message',
      at: at - 2 * 60 * MIN,
      videoCall: {
        id: LAUREN_CALL,
        at: ended,
        seconds: 724,
        notes: {
          id: s38(0x24),
          at: ended + MIN,
          summary:
            'Lauren showed the indoor unit in her attic on video. The evaporator coil is iced over and there’s oily residue at the line set joint, which points to a leaking coil. The system is 9 years old and the outdoor unit looked fine. She’d like a price to replace the coil this week, and typed the model number in the chat.',
          transcript: [
            `${me}: Can you point the camera at the top of the unit, where the copper lines go in?`,
            'Lauren Hayes: Here? There’s frost all over it.',
            `${me}: That’s the coil. See the oily spot by the joint? That usually means it’s leaking refrigerant.`,
            'Lauren Hayes: Is that a big repair?',
            `${me}: It’s a coil replacement, a few hours. The rest of your system looks good, so you don’t need a whole new one. I’ll send you a price today.`,
            'Lauren Hayes (in the chat): Model number from the sticker: GSXN403610',
          ].join('\n'),
          suggestions: [
            {
              id: s38(0x31),
              kind: 'task',
              preview: { title: 'Send Lauren a quote for a new evaporator coil' },
              status: 'pending',
            },
          ],
        },
        chat: [
          {
            id: s38(0x41),
            at: ended - 6 * MIN,
            side: 'customer',
            name: fullName(LAUREN),
            body: 'Model number from the sticker: GSXN403610',
          },
          {
            id: s38(0x42),
            at: ended - 5 * MIN,
            side: 'team',
            name: me,
            body: 'Perfect, thank you. That’s all I need for the price.',
          },
          {
            id: s38(0x43),
            at: ended - MIN,
            side: 'customer',
            name: fullName(LAUREN),
            body: 'Great. Mornings are best for us this week.',
          },
        ],
      },
    });
  },
  steps: [
    {
      label: 'Open Lauren’s lead',
      voiceover:
        'Lauren texted that her AC stopped cooling. Instead of driving out to look, you started a HandsFreeOS video call, and she showed you the unit in her attic.',
      run: (p) => p.point('@timeline-video-call-notes'),
    },
    {
      label: 'Open the notes from the call',
      voiceover:
        'The call is on her timeline, with the AI’s summary of what you saw and what she wants next.',
      run: async (p) => {
        await p.click('@timeline-video-call-notes');
        await p.waitFor('@video-call-notes', 15_000);
        await p.point('@call-review');
      },
    },
    {
      label: 'What she typed is kept too',
      voiceover:
        'And the call’s chat is kept with it: the model number she typed off the sticker is right there when you write the quote.',
      run: async (p) => {
        await p.click('[data-testid="call-chat-log"] summary');
        await p.point('[data-testid="call-chat-log-message"]');
      },
    },
    {
      ...askForQuote,
      run: async (p) => {
        await closeDialog(p);
        await askForQuote.run?.(p);
      },
    },
    beatStep({ confirm: 1, label: 'Save the draft', voiceover: 'Looks right, so save it.' }),
    beatStep({
      ask: 'Text it to her.',
      label: 'Ask it to text the estimate to Lauren',
      voiceover: 'Then text it to her, so she can approve it on her phone.',
      answer: () => ({
        steps: ran(PREPARING),
        text: 'Ready to go by text. Sending gives it its number and locks it, so what Lauren approves is exactly what you quoted.',
        cards: [
          {
            toolCallId: s38(0x12),
            tool: 'send_estimate',
            title: `Send this estimate to ${fullName(LAUREN)}`,
            fields: [
              { label: 'To', value: fullName(LAUREN) },
              { label: 'How', value: 'Text' },
              { label: 'Total', value: dollars(COIL_TOTAL) },
              { label: 'For', value: COIL_FOR },
            ],
            warnings: [
              {
                kind: 'freezes',
                text: 'Sending takes its number and freezes it. Changing it afterwards means voiding and reissuing.',
              },
            ],
            confirmLabel: 'Send it',
            outcome: 'Sent EST-1061',
            opens: `money/estimates/${COIL_ESTIMATE}`,
          },
        ],
      }),
    }),
    beatStep({
      confirm: 1,
      label: 'Send it',
      voiceover:
        'Send it. She saw the problem with you, and has the price before the call’s been over half an hour. You never got in the truck.',
      change: (w, at) => {
        w.estimates.push({
          id: COIL_ESTIMATE,
          number: 'EST-1061',
          title: COIL_FOR,
          person: LAUREN,
          email: 'lauren.hayes@example.com',
          lines: COIL_LINES,
          createdAt: at - 2 * MIN,
          sentAt: at,
          viewedAt: at + 90_000,
          expiresOn: localDate(at, 30, w.state.timeZone),
        });
      },
      live: ['estimate'],
      then: async (p) => {
        await p.closeAssistant();
        await p.go(`money/estimates/${COIL_ESTIMATE}`);
        await p.point('@document-activity');
      },
    }),
  ],
};

export const PAPERWORK_CALL_SCENES: readonly DemoScene[] = [signOnPhone, callToTasks, videoQuote];
