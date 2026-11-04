import { fmtDateLong } from '@hfos/core';
import { businessOf, wallTime, type DemoPerson, type DemoWorld } from '../world';
import { idsFor } from './ask-kit';
import {
  bookedText,
  calendarPath,
  DAY,
  halfHourBefore,
  localDate,
  MIN,
  openVisit,
  REMINDERS,
} from './calendar-kit';
import { conversationIn, daysUntil, openConversation, startConversation } from './kit';
import { customerSays, NEW_MESSAGE, newPerson, regular, teammateSays } from './teammate-kit';
import type { DemoScene } from './types';

/**
 * Money and the calendar: paid on the spot from the visit (31), a deposit before a big job is booked (32), customers
 * booking themselves (34), the presenter's own Google Calendar counting (35), and tune-ups coming due on their own
 * (36). Each shows the real calendar, the visit's sheet and the invoice page.
 */

const VISIT_CHANGED = ['message', 'conversation', 'appointment', 'activity'] as const;
const MONEY_CHANGED = ['invoice', 'payment', 'appointment'] as const;

/** A teammate past its training, replying on its own. */
const automatic = (w: DemoWorld) => {
  w.teammateAutomatic = true;
};

/** The scene's visit with nobody's conversation behind it. */
function calendarVisit(w: DemoWorld, id: string) {
  const v = w.visits.find((x) => x.id === id);
  if (!v) throw new Error('The scene’s visit is missing.');
  return v;
}

function invoiceIn(w: DemoWorld, id: string) {
  const inv = w.invoices.find((x) => x.id === id);
  if (!inv) throw new Error('The scene’s invoice is missing.');
  return inv;
}

// ------------------------------------------------------------------------- 31. paid before you leave the driveway

const s31 = idsFor(31);
const GARY_VISIT = s31(0x21);
const GARY_INVOICE = s31(0x22);
const GARY_CENTS = 38_500;

export const paidOnTheSpot: DemoScene = {
  id: 'paid-on-the-spot',
  number: 31,
  title: 'Paid before you leave the driveway',
  kind: 'app',
  startsOn: `calendar?view=day&appt=${GARY_VISIT}`,
  // Wes's AC repair started a little over an hour ago, and the work is done.
  setup: (w, at) => {
    w.visits.push({
      id: GARY_VISIT,
      person: regular(newPerson(s31(1), 'Wes', 'Whitfield', 3101, 'Pearland'), at, 4),
      title: 'AC repair',
      startsAt: halfHourBefore(at - 70 * MIN),
      minutes: 60,
      bookedAt: at - 2 * DAY,
      priceCents: GARY_CENTS,
      address: '2418 Shady Bend Dr, Pearland, TX 77584',
      reminders: { confirmedAt: at - 2 * DAY, keys: REMINDERS },
    });
  },
  steps: [
    {
      label: 'Open Wes’s AC repair',
      voiceover:
        'You just finished Wes’s AC repair: a new capacitor and contactor, and his house is cooling again. You’re still in his driveway.',
      run: (p) => p.point('@sheet-title'),
    },
    {
      label: 'Mark the job done',
      voiceover: 'Mark the job done, right from the visit.',
      change: (w) => {
        calendarVisit(w, GARY_VISIT).completed = true;
      },
      live: ['appointment'],
      run: async (p) => {
        await p.click('@sheet-complete');
        await p.waitFor('[data-testid="appointment-sheet"][data-status="completed"]', 15_000);
      },
    },
    {
      label: 'Invoice this visit',
      voiceover:
        'Then Invoice this visit. It writes the bill from the visit itself, at the price you set, so there’s nothing to type.',
      change: (w, at) => {
        const v = calendarVisit(w, GARY_VISIT);
        w.invoices.push({
          id: GARY_INVOICE,
          number: 'INV-1204',
          appointmentId: GARY_VISIT,
          title: v.title,
          person: v.person,
          email: null,
          lines: [
            {
              name: v.title,
              description: fmtDateLong(localDate(v.startsAt, 0, w.state.timeZone)),
              quantity: 1,
              unitPriceCents: GARY_CENTS,
            },
          ],
          createdAt: at,
          dueOn: localDate(at, 0, w.state.timeZone),
        });
      },
      run: async (p) => {
        await p.click('@sheet-invoice-visit');
        await p.waitFor('@document-send', 20_000);
        await p.point('@document-send');
      },
    },
    {
      label: 'Text it to Wes',
      voiceover:
        'Send it to Wes by text. He gets a link to his own page, where he can pay by card in a few taps.',
      change: (w, at) => {
        invoiceIn(w, GARY_INVOICE).sentAt = at;
      },
      run: async (p) => {
        await p.click('@document-send');
        await p.waitFor('@send-dialog');
        await p.click('[data-testid="send-dialog"] label:nth-of-type(2)');
        await p.click('@send-confirm');
        await p.waitFor('@document-activity', 20_000);
      },
    },
    {
      label: 'Wes pays on his phone',
      voiceover:
        'Wes pays from his phone while you pack up the truck. The invoice says Paid, with the card he used.',
      change: (w, at) => {
        invoiceIn(w, GARY_INVOICE).paid = { at, brand: 'visa', last4: '4242' };
      },
      live: MONEY_CHANGED,
      run: async (p) => {
        await p.waitFor('@invoice-payments', 15_000);
        await p.point('@invoice-payments');
      },
    },
    {
      label: 'The visit shows it’s paid',
      voiceover:
        'And the visit shows it’s paid in full. No paper invoice, no chasing a check next week. Paid before you leave the driveway.',
      run: async (p) => {
        await p.go(calendarPath(p, 0, { appt: GARY_VISIT }));
        await p.waitFor('@visit-invoice', 15_000);
        await p.point('@visit-invoice');
      },
    },
  ],
};

// ------------------------------------------------------------------------------------- 32. a deposit to book a job

const s32 = idsFor(32);
const ERIN = s32(1);
const RACHEL_ASKS = s32(11);
const RACHEL_LINK = s32(12);
const RACHEL_BOOKED = s32(13);
const RACHEL_VISIT = s32(0x21);
const RACHEL_DEPOSIT = s32(0x22);
const INSTALL_CENTS = 245_000;
const DEPOSIT_CENTS = 25_000;
const INSTALL_BOOKING = 'https://app.handsfreeos.com/book/c/installs';
const RACHEL_MANAGE = 'https://app.handsfreeos.com/m/7wQe4rTz';
/** Two days out, first thing. */
const installStart = (at: number, timeZone: string) => wallTime(at, timeZone, 2, 8);

export const depositToBook: DemoScene = {
  id: 'deposit-to-book',
  number: 32,
  title: 'A deposit to book a big job',
  kind: 'teammate',
  startsOn: 'inbox',
  setup: automatic,
  steps: [
    {
      label: 'Open the Inbox',
      voiceover:
        'A big job takes a crew for half a day. If the customer doesn’t show, that’s a day’s pay gone. So big jobs take a deposit to book.',
      run: (p) => p.go('inbox'),
    },
    {
      label: 'Erin asks for a new water heater',
      voiceover: 'Erin texts. Her water heater is leaking, and she wants a new one put in.',
      change: (w, at) =>
        startConversation(w, at, {
          id: ERIN,
          person: newPerson(s32(2), 'Erin', 'Ortiz', 3201, 'Cypress'),
          firstId: RACHEL_ASKS,
          body: 'Hi, our water heater is leaking from the bottom. Can we get a new one put in this week?',
        }),
      live: NEW_MESSAGE,
      run: async (p) => {
        await openConversation(p, ERIN);
        await p.point(`@message-${RACHEL_ASKS}`);
      },
    },
    {
      label: 'It sends the booking link, with the deposit',
      voiceover:
        'Your AI teammate gives her the price and sends your booking link. It tells her up front: installs take a deposit to hold the time, and it comes off the final bill.',
      change: (w, at) =>
        teammateSays(w, ERIN, {
          id: RACHEL_LINK,
          at,
          body: `Sorry to hear that, Erin! A new 50-gallon water heater, installed, is $2,450. Installs take a $250 deposit to hold your time, and it comes off the final bill. Pick a time and pay it here: ${INSTALL_BOOKING}`,
        }),
      live: NEW_MESSAGE,
      run: (p) => p.point(`@message-${RACHEL_LINK}`),
    },
    {
      label: 'Erin books and pays the deposit',
      voiceover:
        'Erin picks a morning and pays the $250 on her phone. Only then is the time hers, and she gets her confirmation.',
      change: (w, at) => {
        const starts = installStart(at, w.state.timeZone);
        const c = conversationIn(w, ERIN);
        c.messages.push({
          id: RACHEL_BOOKED,
          at,
          direction: 'outbound',
          body: bookedText(w, starts, 'Water heater install', RACHEL_MANAGE),
        });
        c.visits.push({
          id: RACHEL_VISIT,
          title: 'Water heater install',
          startsAt: starts,
          minutes: 240,
          bookedAt: at,
          source: 'booking_page',
          priceCents: INSTALL_CENTS,
          address: '15207 Cypress Garden Dr, Cypress, TX 77429',
          reminders: { confirmedAt: at, keys: REMINDERS },
        });
        w.invoices.push({
          id: RACHEL_DEPOSIT,
          number: 'INV-1205',
          appointmentId: RACHEL_VISIT,
          purpose: 'deposit',
          title: 'Deposit: Water heater install',
          person: c.person,
          email: null,
          lines: [
            {
              name: 'Deposit for your water heater install',
              description: 'Comes off the final bill',
              quantity: 1,
              unitPriceCents: DEPOSIT_CENTS,
            },
          ],
          createdAt: at - 2 * MIN,
          sentAt: at - 2 * MIN,
          dueOn: localDate(at, 0, w.state.timeZone),
          paid: { at: at - 30_000, brand: 'mastercard', last4: '5100' },
        });
      },
      live: VISIT_CHANGED,
      run: async (p) => {
        await p.waitFor(`@message-${RACHEL_BOOKED}`);
        await p.point(`@message-${RACHEL_BOOKED}`);
      },
    },
    {
      label: 'The visit shows the deposit paid',
      voiceover:
        'On your calendar, the install shows the deposit paid and what’s left after the job. A booked job you know is real.',
      run: async (p) => {
        await p.go(calendarPath(p, 2, { appt: RACHEL_VISIT }));
        await p.waitFor('@visit-deposit', 15_000);
        await p.point('@visit-deposit');
      },
    },
  ],
};

// -------------------------------------------------------------------------------- 34. customers book themselves

const s34 = idsFor(34);
const OWEN_VISIT = s34(0x21);

/** Tomorrow's jobs before anyone books online: one in the morning, one after lunch. */
const TOMORROW: readonly (readonly [string, string, string, number, number])[] = [
  ['Bernice', 'Pritchard', 'AC tune-up', 9, 90],
  ['Victor', 'Lam', 'Furnace repair', 13, 120],
];

/** Puts tomorrow's jobs on the calendar: both of them, or only the first `count`. */
function tomorrowsJobs(
  w: DemoWorld,
  at: number,
  ids: (n: number) => string,
  tail: number,
  count = TOMORROW.length,
) {
  const tz = w.state.timeZone;
  TOMORROW.slice(0, count).forEach(([first, last, title, hour, minutes], i) =>
    w.visits.push({
      id: ids(0x31 + i),
      person: regular(newPerson(ids(0x41 + i), first, last, tail + i, 'Houston'), at),
      title,
      startsAt: wallTime(at, tz, 1, hour),
      minutes,
      bookedAt: at - (5 + i) * DAY,
      reminders: { confirmedAt: at - (5 + i) * DAY, keys: REMINDERS },
    }),
  );
}

export const bookThemselves: DemoScene = {
  id: 'book-themselves',
  number: 34,
  title: 'Customers book themselves',
  kind: 'app',
  startsOn: 'calendar',
  setup: (w, at) => tomorrowsJobs(w, at, s34, 3401),
  steps: [
    {
      label: 'Open tomorrow on the calendar',
      voiceover:
        'Here’s tomorrow. A tune-up first thing, a furnace repair after lunch, and open time in between.',
      run: async (p) => {
        await p.go(calendarPath(p, 1));
        await p.point(`@appt-${s34(0x31)}`);
      },
    },
    {
      label: 'Owen books from your website',
      voiceover:
        'While you were busy, Owen found you online. He picked a duct cleaning and a time from your booking page, which only ever offers times you’re really free.',
      change: (w, at) => {
        w.visits.push({
          id: OWEN_VISIT,
          person: newPerson(s34(1), 'Owen', 'Fischer', 3410, 'Spring', 'owen.fischer@example.com'),
          title: 'Duct cleaning',
          startsAt: wallTime(at, w.state.timeZone, 1, 11),
          minutes: 120,
          bookedAt: at,
          source: 'booking_page',
          priceCents: 39_900,
          address: '24019 Birch Hollow Ln, Spring, TX 77389',
          reminders: { confirmedAt: at + 20_000, keys: REMINDERS },
        });
      },
      live: ['appointment'],
      run: async (p) => {
        await p.waitFor(`@appt-${OWEN_VISIT}`, 15_000);
        await p.point(`@appt-${OWEN_VISIT}`);
      },
    },
    {
      label: 'Open Owen’s booking',
      voiceover:
        'It lands on your calendar marked Booked online, with his address and the price. Nobody had to pick up the phone.',
      run: async (p) => {
        await openVisit(p, OWEN_VISIT);
        await p.point('@sheet-title');
      },
    },
    {
      label: 'The reminders are already set',
      voiceover:
        'He got his confirmation the moment he booked, and his reminders are set for the day before and two hours before. Fewer no-shows, and nothing for you to remember.',
      run: (p) => p.point('@sheet-reminder'),
    },
  ],
};

// ------------------------------------------------------------------------------------ 35. your own calendar counts

const s35 = idsFor(35);
const PAIGE = s35(1);
const PAIGE_ASKS = s35(11);
const PAIGE_OFFER = s35(12);
const PAIGE_PICKS = s35(13);
const PAIGE_BOOKED = s35(14);
const PAIGE_VISIT = s35(0x21);
const PAIGE_MANAGE = 'https://app.handsfreeos.com/m/5pLk8sVn';

export const ownCalendarCounts: DemoScene = {
  id: 'own-calendar',
  number: 35,
  title: 'Your own calendar counts',
  kind: 'teammate',
  startsOn: 'calendar',
  setup: (w, at) => {
    automatic(w);
    const tz = w.state.timeZone;
    // The dentist, on the presenter's own Google Calendar: HandsFreeOS only knows they're busy.
    w.google.connected = true;
    w.google.busy.push({
      startsAt: wallTime(at, tz, 1, 14),
      endsAt: wallTime(at, tz, 1, 15, 15),
    });
    // Only the morning job, so nothing on the calendar hides the dentist.
    tomorrowsJobs(w, at, s35, 3501, 1);
  },
  steps: [
    {
      label: 'Open tomorrow on the calendar',
      voiceover:
        'Your Google Calendar is connected. Tomorrow afternoon you have a dentist appointment on it. HandsFreeOS doesn’t see what it is, only that you’re busy.',
      run: async (p) => {
        await p.go(calendarPath(p, 1));
        await p.point('@busy-block');
      },
    },
    {
      label: 'Paige asks for tomorrow at 2:00',
      voiceover:
        'Paige texts and asks if someone can come tomorrow around two. Right when you’re at the dentist.',
      change: (w, at) =>
        startConversation(w, at, {
          id: PAIGE,
          person: newPerson(s35(2), 'Paige', 'Holloway', 3510, 'Katy'),
          firstId: PAIGE_ASKS,
          body: 'Hi! Our upstairs AC is blowing warm. Any chance someone could come look at it tomorrow around 2?',
        }),
      live: NEW_MESSAGE,
      run: async (p) => {
        await p.go('inbox');
        await openConversation(p, PAIGE);
        await p.point(`@message-${PAIGE_ASKS}`);
      },
    },
    {
      label: 'It offers times you’re really free',
      voiceover:
        'Your AI teammate knows two o’clock is taken, so it offers the times around it that you’re really free.',
      change: (w, at) =>
        teammateSays(w, PAIGE, {
          id: PAIGE_OFFER,
          at,
          body: 'Hi Paige! 2:00 tomorrow is taken, but I can have someone there at 11:00 AM or 3:30 PM. Which works better?',
        }),
      live: NEW_MESSAGE,
      run: (p) => p.point(`@message-${PAIGE_OFFER}`),
    },
    {
      label: 'Paige picks 3:30, and it books her',
      voiceover: 'She picks three thirty. It books her and sends her confirmation.',
      change: (w, at) => {
        const starts = wallTime(at, w.state.timeZone, 1, 15, 30);
        customerSays(w, PAIGE, { id: PAIGE_PICKS, at, body: '3:30 works, thank you!' });
        const c = conversationIn(w, PAIGE);
        c.messages.push({
          id: PAIGE_BOOKED,
          at: at + 20_000,
          direction: 'outbound',
          body: bookedText(w, starts, 'AC repair', PAIGE_MANAGE),
        });
        c.visits.push({
          id: PAIGE_VISIT,
          title: 'AC repair',
          startsAt: starts,
          minutes: 60,
          bookedAt: at + 20_000,
          address: '2603 Willow Fork Dr, Katy, TX 77494',
          reminders: { confirmedAt: at + 20_000, keys: REMINDERS },
        });
      },
      live: VISIT_CHANGED,
      run: async (p) => {
        await p.waitFor(`@message-${PAIGE_BOOKED}`);
        await p.point(`@message-${PAIGE_BOOKED}`);
      },
    },
    {
      label: 'It fits around the dentist',
      voiceover:
        'Back on your calendar, Paige sits right after your dentist appointment. Your own life and your work, on one calendar, and nobody books over either.',
      run: async (p) => {
        await p.go(calendarPath(p, 1));
        await p.waitFor(`@appt-${PAIGE_VISIT}`, 15_000);
        await p.point(`@appt-${PAIGE_VISIT}`);
      },
    },
  ],
};

// ------------------------------------------------------------------------------- 36. tune-ups come due on their own

const s36 = idsFor(36);
const TUNE_UP_LINK = 'https://app.handsfreeos.com/b/4kRt9xQm';
const DUE: readonly {
  readonly id: number;
  readonly first: string;
  readonly last: string;
  readonly city: string;
  readonly tail: number;
  readonly years: number;
}[] = [
  { id: 1, first: 'Darlene', last: 'Marsh', city: 'Bellaire', tail: 3601, years: 3 },
  { id: 2, first: 'Curtis', last: 'Becker', city: 'Sugar Land', tail: 3602, years: 2 },
  { id: 3, first: 'Imelda', last: 'Navarro', city: 'Pasadena', tail: 3603, years: 5 },
];
const conversationOf = (n: number) => s36(0x10 + n);
const textOf = (n: number) => s36(0x20 + n);
const visitOf = (n: number) => s36(0x30 + n);
const TOM_ASKS = s36(0x41);
const TOM_BOOKED = s36(0x42);
const LINDA_BOOKED = s36(0x43);
const ROSA_BOOKED = s36(0x44);

/** The coming week's Monday, plus `days`, at `hour`. */
const nextWeek = (at: number, timeZone: string, days: number, hour: number) =>
  wallTime(at, timeZone, daysUntil(at, timeZone, 1) + days, hour);

function dueText(w: DemoWorld, p: DemoPerson): string {
  // The default Maintenance due wording (packages/core/src/automations/maintenance.ts), straight apostrophes and all.
  return `Hi ${p.firstName}, it's ${businessOf(w)}. Your AC tune-up is due soon. Book a time that suits you here: ${TUNE_UP_LINK}`;
}

/** Booked from the reminder's link: the confirmation, and the visit next week. */
function bookedFromLink(
  w: DemoWorld,
  at: number,
  n: number,
  id: string,
  starts: number,
  link: string,
) {
  const c = conversationIn(w, conversationOf(n));
  c.messages.push({
    id,
    at,
    direction: 'outbound',
    body: bookedText(w, starts, 'AC tune-up', link),
  });
  c.visits.push({
    id: visitOf(n),
    title: 'AC tune-up',
    startsAt: starts,
    minutes: 60,
    bookedAt: at,
    source: 'booking_page',
    reminders: { confirmedAt: at, keys: REMINDERS },
  });
  w.conversations.splice(w.conversations.indexOf(c), 1);
  w.conversations.unshift(c);
}

export const tuneUpsDue: DemoScene = {
  id: 'tune-ups-due',
  number: 36,
  title: 'Tune-ups come due on their own',
  kind: 'teammate',
  startsOn: 'inbox',
  setup: automatic,
  steps: [
    {
      label: 'Open the Inbox',
      voiceover:
        'Most of your customers should get their AC looked at every spring. Most of them forget, and so do you.',
      run: (p) => p.go('inbox'),
    },
    {
      label: 'Customers due for a tune-up get a text',
      voiceover:
        'HandsFreeOS keeps track of when each customer had their last tune-up. When one comes due, it texts them a link to book. This morning, three of them.',
      change: (w, at) =>
        DUE.forEach((d, i) => {
          const person = regular(
            newPerson(s36(d.id), d.first, d.last, d.tail, d.city),
            at,
            d.years,
          );
          w.conversations.unshift({
            id: conversationOf(d.id),
            person,
            createdAt: at - (3 - i) * 60_000,
            unread: 0,
            messages: [
              {
                id: textOf(d.id),
                at: at - (3 - i) * 60_000,
                direction: 'outbound',
                body: dueText(w, person),
              },
            ],
            drafts: [],
            visits: [],
          });
        }),
      live: NEW_MESSAGE,
      run: async (p) => {
        await openConversation(p, conversationOf(1));
        await p.point(`@message-${textOf(1)}`);
      },
    },
    {
      label: 'Darlene books from the link',
      voiceover:
        'Darlene taps the link and books a morning next week. She gets her confirmation straight away.',
      change: (w, at) =>
        bookedFromLink(
          w,
          at,
          1,
          LINDA_BOOKED,
          nextWeek(at, w.state.timeZone, 1, 9),
          'https://app.handsfreeos.com/m/2dHs6wKp',
        ),
      live: VISIT_CHANGED,
      run: async (p) => {
        await p.waitFor(`@message-${LINDA_BOOKED}`);
        await p.point(`@message-${LINDA_BOOKED}`);
      },
    },
    {
      label: 'Curtis texts back instead',
      voiceover: 'Curtis would rather just text back. That’s fine too.',
      change: (w, at) => {
        const c = conversationIn(w, conversationOf(2));
        c.unread = 1;
        c.messages.push({
          id: TOM_ASKS,
          at,
          direction: 'inbound',
          body: 'Yes please, it’s been a while. Any morning next week works for us.',
        });
        w.conversations.splice(w.conversations.indexOf(c), 1);
        w.conversations.unshift(c);
      },
      live: NEW_MESSAGE,
      run: async (p) => {
        await openConversation(p, conversationOf(2));
        await p.point(`@message-${TOM_ASKS}`);
      },
    },
    {
      label: 'It books Curtis',
      voiceover: 'Your AI teammate finds him a morning and books it, while you’re out on a job.',
      change: (w, at) => {
        const tz = w.state.timeZone;
        const starts = nextWeek(at, tz, 2, 10);
        const c = conversationIn(w, conversationOf(2));
        c.unread = 0;
        teammateSays(w, conversationOf(2), {
          id: TOM_BOOKED,
          at,
          body: `You’re all set, Curtis! Your AC tune-up is booked for ${new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric' }).format(new Date(starts))} at 10:00 AM. We’ll text you a reminder the day before.`,
        });
        c.visits.push({
          id: visitOf(2),
          title: 'AC tune-up',
          startsAt: starts,
          minutes: 60,
          bookedAt: at,
          reminders: { confirmedAt: at, keys: REMINDERS },
        });
      },
      live: VISIT_CHANGED,
      run: (p) => p.point(`@message-${TOM_BOOKED}`),
    },
    {
      label: 'Imelda books too',
      voiceover: 'And Imelda books from her link as well.',
      change: (w, at) =>
        bookedFromLink(
          w,
          at,
          3,
          ROSA_BOOKED,
          nextWeek(at, w.state.timeZone, 3, 13),
          'https://app.handsfreeos.com/m/9fJw3cYb',
        ),
      live: VISIT_CHANGED,
      run: async (p) => {
        await openConversation(p, conversationOf(3));
        await p.point(`@message-${ROSA_BOOKED}`);
      },
    },
    {
      label: 'Next week fills itself',
      voiceover:
        'Three tune-ups on next week’s calendar, and you never made a call. That’s work that comes back every year, on its own.',
      run: async (p) => {
        const monday = daysUntil(Date.now(), p.timeZone, 1);
        await p.go(calendarPath(p, monday + 1, { view: 'week' }));
        await p.waitFor(`@appt-${visitOf(1)}`, 15_000);
        await p.point(`@appt-${visitOf(2)}`);
      },
    },
  ],
};

export const CALENDAR_MONEY_SCENES: readonly DemoScene[] = [
  paidOnTheSpot,
  depositToBook,
  bookThemselves,
  ownCalendarCounts,
  tuneUpsDue,
];
