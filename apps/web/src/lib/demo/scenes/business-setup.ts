import { businessOf, demoId, type DemoConfirmCard, type DemoService } from '../world';
import { answered, confirmEach } from './kit';
import type { DemoScene } from './types';

/**
 * Scene 8: you tell Ask HandsFreeOS your hours, services and prices in one sentence. It turns them into a card for
 * each change, you say yes to each, and the services are there to book.
 */
const HOURS = demoId(0x80001);
const QUESTION =
  'We’re open 7 to 6 on weekdays and 8 to noon on Saturdays. Drain cleaning is $149, a water heater flush is $129, and leak repairs start at $189. Add them so people can book online.';

const SERVICES: readonly (DemoService & { readonly card: string })[] = [
  {
    id: demoId(0x80011),
    card: demoId(0x80002),
    name: 'Drain cleaning',
    minutes: 60,
    priceCents: 14_900,
  },
  {
    id: demoId(0x80012),
    card: demoId(0x80003),
    name: 'Water heater flush',
    minutes: 60,
    priceCents: 12_900,
  },
  {
    id: demoId(0x80013),
    card: demoId(0x80004),
    name: 'Leak repair',
    minutes: 90,
    priceCents: 18_900,
  },
];

const dollars = (cents: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);

/** The cards, worded as the Assistant words them for update_business and manage_service. */
const cards = (business: string): DemoConfirmCard[] => [
  {
    toolCallId: HOURS,
    tool: 'update_business',
    title: `Change ${business}`,
    fields: [
      {
        label: 'Open hours',
        value:
          'Mon 07:00–18:00, Tue 07:00–18:00, Wed 07:00–18:00, Thu 07:00–18:00, Fri 07:00–18:00, Sat 08:00–12:00',
      },
    ],
    confirmLabel: 'Save the change',
    outcome: 'Saved',
  },
  ...SERVICES.map((s) => ({
    toolCallId: s.card,
    tool: 'manage_service',
    title: `Add ${s.name}`,
    fields: [
      { label: 'Service', value: s.name },
      { label: 'How long', value: `${s.minutes} min` },
      { label: 'Price', value: dollars(s.priceCents) },
    ],
    confirmLabel: 'Add it',
    outcome: `${s.name} is ready to book`,
    opens: 'settings/calendars/services',
  })),
];

export const businessSetup: DemoScene = {
  id: 'business-setup',
  number: 8,
  title: 'Set up hours and services from a chat',
  kind: 'assistant',
  startsOn: '',
  steps: [
    {
      label: 'Open Ask HandsFreeOS (⌘J)',
      say: 'Onboarding set up the basics on day one. When something changes, you just say it.',
      run: (p) => p.openAssistant(),
    },
    {
      label: 'Say your hours, services and prices',
      say: 'One sentence. No settings pages to dig through.',
      change: (w, at) => {
        const all = cards(businessOf(w));
        for (const c of all) w.cards[c.toolCallId] = c;
        w.answer = {
          steps: [
            { id: 'business', label: 'Changing the business' },
            { id: 'services', label: 'Setting up the service' },
          ],
          text: 'Here’s what I’ll change: your open hours, and three new services with their prices. Each one waits for your OK, and each service is ready to book once it’s added.',
          cards: all,
        };
        w.chat.push({ question: QUESTION, answer: w.answer, at });
      },
      run: async (p) => {
        await p.ask(QUESTION);
        await answered(p);
        await p.point('@assistant-card-confirm');
      },
    },
    {
      label: 'Say yes to each one',
      say: 'Nothing changes until you say so. Then it’s live.',
      change: (w) => {
        w.answer = null;
        w.confirmed.push(HOURS, ...SERVICES.map((s) => s.card));
        w.services.push(
          ...SERVICES.map(({ id, name, minutes, priceCents }) => ({
            id,
            name,
            minutes,
            priceCents,
          })),
        );
      },
      run: (p) => confirmEach(p, 1 + SERVICES.length),
    },
    {
      label: 'Open your services',
      run: async (p) => {
        await p.click(
          '[data-testid="assistant-card-confirm"] a[href*="/settings/calendars/services"]',
        );
        await p.waitFor('[data-testid="service-row-Leak repair"]', 15_000);
        await p.closeAssistant();
        await p.point('@services');
      },
    },
    {
      label: 'Open Leak repair: 90 minutes, $189',
      say: 'Everything it set up is right here, the same as if you’d typed it in yourself.',
      run: async (p) => {
        await p.click('[data-testid="service-row-Leak repair"]');
        await p.point('@service-editor');
      },
    },
  ],
};
