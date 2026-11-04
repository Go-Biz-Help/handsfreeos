import { businessOf, demoId, type DemoWorld } from '../world';
import { conversationIn } from './kit';
import type { DemoScene } from './types';

/**
 * Scene 6: an estimate sits unanswered, so HandsFreeOS sends the customer one friendly reminder on its own. She
 * approves it on her own page by typing her name, and one click turns it into an invoice you send.
 */
const ESTIMATE = demoId(0x60001);
const INVOICE = demoId(0x60002);
const PERSON = demoId(0x60003);
const CONVERSATION = demoId(0x60004);
const SENT_TEXT = demoId(0x60011);
const NUDGE = demoId(0x60012);
const APPROVED = demoId(0x60013);

const DAY = 24 * 3600_000;
const TITLE = 'Water heater replacement';
const LINK = 'https://app.handsfreeos.com/e/7kQm2xLp';
const TOTAL = '$2,450.00';

const CAROL = {
  id: PERSON,
  firstName: 'Carol',
  lastName: 'Diaz',
  phone: '+15125550151',
  city: 'Round Rock',
  tags: [],
  customerSince: null,
};

/** A day `days` from `at`, as `YYYY-MM-DD` where the business is. */
const localDay = (at: number, days: number, timeZone: string) =>
  new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date(at + days * DAY));

/** "Dec 3", for the estimate's last good day. */
const shortDay = (ymd: string) =>
  new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(
    new Date(`${ymd}T12:00:00Z`),
  );

const estimateOf = (w: DemoWorld) => {
  const e = w.estimates.find((x) => x.id === ESTIMATE);
  if (!e) throw new Error('Carol’s estimate is missing.');
  return e;
};

export const quoteToInvoice: DemoScene = {
  id: 'quote-to-invoice',
  number: 6,
  title: 'A quote reminder turns into an invoice',
  kind: 'teammate',
  startsOn: `money/estimates/${ESTIMATE}`,
  // Sent four days ago and opened that evening; nothing since.
  setup: (w, at) => {
    const sentAt = at - 4 * DAY;
    w.estimates.push({
      id: ESTIMATE,
      number: 'EST-1042',
      title: TITLE,
      person: CAROL,
      email: 'carol.diaz@example.com',
      lines: [
        {
          name: '50-gallon gas water heater',
          description: 'Bradford White, 6-year warranty',
          quantity: 1,
          unitPriceCents: 165_000,
        },
        {
          name: 'Installation and haul-away',
          description: 'Take out the old tank, new venting and gas line, and the permit',
          quantity: 1,
          unitPriceCents: 80_000,
        },
      ],
      createdAt: sentAt - 3600_000,
      sentAt,
      viewedAt: sentAt + 5 * 3600_000,
      expiresOn: localDay(sentAt, 30, w.state.timeZone),
    });
  },
  steps: [
    {
      label: 'Open Carol’s estimate',
      voiceover:
        'Last week you quoted Carol for a new water heater. She opened it that evening, then went quiet.',
      run: (p) => p.point('@document-activity'),
    },
    {
      label: 'It reminds her on its own',
      voiceover:
        'You set this up once: when a quote sits for a few days, HandsFreeOS sends one friendly nudge. Nobody has to remember.',
      change: (w, at) => {
        const e = estimateOf(w);
        w.conversations.unshift({
          id: CONVERSATION,
          person: CAROL,
          createdAt: e.sentAt,
          unread: 0,
          messages: [
            {
              id: SENT_TEXT,
              at: e.sentAt,
              direction: 'outbound',
              body: `${businessOf(w)}: Your estimate for a ${TITLE.toLowerCase()} is ready, ${TOTAL}. It’s good through ${shortDay(e.expiresOn)}. Approve it here: ${LINK}`,
            },
            {
              id: NUDGE,
              at,
              direction: 'outbound',
              body: `${businessOf(w)}: Just checking you saw your estimate for a ${TITLE.toLowerCase()}, ${TOTAL}. It’s good through ${shortDay(e.expiresOn)}. Approve it here: ${LINK}`,
            },
          ],
          drafts: [],
          visits: [],
        });
      },
      live: ['conversation', 'message'],
      run: async (p) => {
        await p.go(`inbox/${CONVERSATION}`);
        await p.point(`@message-${NUDGE}`);
      },
    },
    {
      label: 'Carol approves it by typing her name',
      voiceover:
        'Carol opens her estimate, types her name and taps Approve. Then she texts you to ask when you can start.',
      change: (w, at) => {
        estimateOf(w).accepted = { at, name: 'Carol Diaz' };
        const c = conversationIn(w, CONVERSATION);
        c.unread = 1;
        c.messages.push({
          id: APPROVED,
          at: at + 20_000,
          direction: 'inbound',
          body: 'Just approved it! When can you start?',
        });
      },
      live: ['conversation', 'message', 'estimate'],
      run: (p) => p.point(`@message-${APPROVED}`),
    },
    {
      label: 'The estimate keeps her name and the moment',
      voiceover:
        'Her typed name, the moment she approved, and exactly what she saw are all kept with the estimate.',
      run: async (p) => {
        await p.go(`money/estimates/${ESTIMATE}`);
        await p.point('@document-activity');
      },
    },
    {
      label: 'Turn it into an invoice',
      voiceover:
        'Turn it into an invoice. Every line comes across, so there’s nothing to type again.',
      change: (w, at) => {
        w.invoices.push({
          id: INVOICE,
          number: 'INV-1187',
          estimateId: ESTIMATE,
          createdAt: at,
          dueOn: localDay(at, 14, w.state.timeZone),
        });
      },
      run: async (p) => {
        await p.click('@estimate-convert');
        await p.click('@convert-confirm');
        await p.waitFor('@document-send', 15_000);
      },
    },
    {
      label: 'Send it to Carol',
      voiceover:
        'Send it to Carol. From a quiet quote to a sent invoice, and you never chased anyone.',
      change: (w, at) => {
        const inv = w.invoices.find((i) => i.id === INVOICE);
        if (inv) inv.sentAt = at;
      },
      run: async (p) => {
        await p.click('@document-send');
        await p.click('@send-confirm');
        await p.waitFor('@document-activity', 15_000);
      },
    },
  ],
};
