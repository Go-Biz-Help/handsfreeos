import {
  businessOf,
  demoId,
  type DemoConfirmCard,
  type DemoPerson,
  type DemoRecipient,
} from '../world';
import type { DemoScene } from './types';

/**
 * Scene 7: you ask Ask HandsFreeOS to text past customers about a fall tune-up. It sets up the campaign on a Confirm
 * card, writes a text for each person about the job you last did for them, you take one person off, and approve.
 */
const CAMPAIGN = demoId(0x70001);
const TOOL_CALL = demoId(0x70002);
const QUESTION = 'Text our past customers about a fall tune-up, $89 this month.';

/** Who it picks: first name, last name, the job you last did for them. */
const PICKED: readonly (readonly [string, string, string])[] = [
  ['Linda', 'Park', 'cleared the kitchen sink drain'],
  ['Marcus', 'Bell', 'fixed the leak under your bathroom sink'],
  ['Gary', 'Holt', 'put in your new water heater last month'],
  ['Priya', 'Shah', 'replaced your shower valve'],
  ['Tom', 'Reyes', 'cleared your main sewer line'],
  ['Angela', 'Brooks', 'installed your garbage disposal'],
  ['Kevin', 'Nguyen', 'fixed the toilet that kept running'],
  ['Rachel', 'Stone', 'snaked your laundry drain'],
  ['Luis', 'Ortega', 'replaced the hose bib out back'],
  ['Brenda', 'Fox', 'fixed your water heater pilot light'],
  ['Sam', 'Patel', 'put in your new kitchen faucet'],
  ['Carol', 'Jenkins', 'cleared the tub drain'],
  ['Derek', 'Lane', 'repaired the pipe under the slab'],
  ['Monica', 'Ruiz', 'swapped out your sump pump'],
  ['Jason', 'Webb', 'fixed the low water pressure upstairs'],
  ['Tina', 'Marsh', 'replaced your toilet fill valve'],
  ['Robert', 'King', 'flushed your tankless heater'],
  ['Helen', 'Cho', 'cleared the backed-up floor drain'],
];
/** Left out from the start. */
const LEFT_OUT: readonly (readonly [string, string, string])[] = [
  ['Frank', 'Dill', 'not_opted_in'],
  ['Nora', 'Quinn', 'not_opted_in'],
  ['Walt', 'Becker', 'booked_soon'],
];
const GARY = demoId(0x70100 + 2);

function person(i: number, first: string, last: string, at: number): DemoPerson {
  return {
    id: demoId(0x70200 + i),
    firstName: first,
    lastName: last,
    phone: `+1512555${String(2100 + i * 7).padStart(4, '0')}`,
    city: 'Austin',
    tags: ['Past customer'],
    customerSince: at - (90 + i * 23) * 24 * 3600_000,
  };
}

/** Three ways of saying it, so the texts read as written one by one. */
function textFor(first: string, job: string, business: string, i: number): string {
  if (job.endsWith('last month'))
    return `Hi ${first}, it’s ${business}. Hope the new water heater we put in last month is treating you well! This month our fall tune-up is $89: we flush the heater and check every drain before the cold sets in. Want us to find you a time?`;
  switch (i % 3) {
    case 0:
      return `Hi ${first}, it’s ${business}. It’s been a while since we ${job}. This month our fall tune-up is $89: we flush your water heater and check every drain before the cold sets in. Want us to find you a time?`;
    case 1:
      return `Hi ${first}! ${business} here, we ${job} a while back. Before it gets cold, our fall tune-up is just $89 this month: water heater flush plus a check of every drain. Should we get you on the calendar?`;
    default:
      return `Hey ${first}, this is ${business}. We ${job}, and it’s a good time for a checkup. Our fall tune-up is $89 this month and covers your water heater and drains. Reply and we’ll find a time that works.`;
  }
}

const card = (business: string): DemoConfirmCard => ({
  toolCallId: TOOL_CALL,
  tool: 'start_campaign',
  title: `Start “Fall tune-up”: texts to ${PICKED.length} people?`,
  fields: [
    { label: 'Send as', value: 'Texts, one written for each person' },
    {
      label: 'What it’s for',
      value: 'A fall tune-up for $89 this month: a water heater flush and a check of every drain',
    },
    { label: 'Who it picks', value: 'Everyone tagged Past customer' },
    { label: 'Reaches', value: `${PICKED.length} people` },
    {
      label: 'Left out',
      value: '3 people: 2 haven’t agreed to texts, 1 is booked in the next 30 days',
    },
    { label: 'Pace', value: '20 texts an hour, while you’re open and never in quiet hours' },
  ],
  confirmLabel: 'Write the texts',
  note: `Nothing goes out yet. The AI writes each text first, then you read them and approve before any go. They come from ${business}’s number.`,
  outcome: `Started “Fall tune-up” for ${PICKED.length} people. The AI is writing the texts; nothing goes until you approve.`,
  opens: `campaigns/${CAMPAIGN}`,
});

export const textCampaign: DemoScene = {
  id: 'text-campaign',
  number: 7,
  title: 'Ask HandsFreeOS builds a text campaign',
  kind: 'assistant',
  startsOn: '',
  steps: [
    {
      label: 'Open Ask HandsFreeOS (⌘J)',
      voiceover:
        'This is the other AI. The AI teammate talks to your customers. Ask HandsFreeOS works for you, from anywhere in the app.',
      run: (p) => p.openAssistant(),
    },
    {
      label: 'Ask: text past customers about a fall tune-up',
      voiceover:
        'Ask in plain English: text past customers about a fall tune-up. It finds everyone tagged Past customer, and tells you who it can reach and who it’s leaving out.',
      change: (w, at) => {
        const c = card(businessOf(w));
        w.cards[c.toolCallId] = c;
        w.answer = {
          steps: [
            { id: 'look', label: 'Checking your tags and customers' },
            { id: 'start', label: 'Setting up the campaign' },
          ],
          text: `Everyone tagged Past customer fits: ${PICKED.length + LEFT_OUT.length} people. ${PICKED.length} of them can get a text, and 3 are left out. I’ll write a text for each person about the job you last did for them. Nothing goes out until you approve.`,
          cards: [c],
        };
        w.chat.push({ question: QUESTION, answer: w.answer, at });
      },
      run: async (p) => {
        await p.ask(QUESTION);
        await p.waitFor('@assistant-confirm', 20_000);
        await p.point('@assistant-confirm');
      },
    },
    {
      label: 'Confirm: it writes a text for each person',
      voiceover:
        'It asks first. Anything that reaches a customer waits for your OK. Confirm, and it writes a text for each person.',
      change: (w, at) => {
        w.answer = null;
        w.confirmed.push(TOOL_CALL);
        const recipients: DemoRecipient[] = [
          ...PICKED.map(([first, last, job], i) => ({
            id: demoId(0x70100 + i),
            person: person(i, first, last, at),
            draft: textFor(first, job, businessOf(w), i),
          })),
          ...LEFT_OUT.map(([first, last, why], i) => ({
            id: demoId(0x70180 + i),
            person: person(50 + i, first, last, at),
            draft: '',
            skipReason: why,
          })),
        ];
        w.campaigns.push({
          id: CAMPAIGN,
          name: 'Fall tune-up',
          goal: 'A fall tune-up for $89 this month: a water heater flush and a check of every drain',
          createdAt: at,
          perHour: 20,
          writingMs: 9_000,
          recipients,
        });
      },
      live: ['campaign'],
      run: async (p) => {
        await p.click('@assistant-confirm');
        await p.waitFor('[data-testid="assistant-card-confirm"] a[href*="/campaigns/"]');
      },
    },
    {
      label: 'Open the campaign',
      voiceover:
        'Open the campaign and watch it write them. Each text mentions the job you last did for that person.',
      run: async (p) => {
        await p.click('[data-testid="assistant-card-confirm"] a[href*="/campaigns/"]');
        await p.waitFor('@campaign-view');
      },
    },
    {
      label: 'Read the texts once they’re written',
      voiceover: 'Read them over before anything goes out.',
      run: async (p) => {
        await p.waitFor('[data-testid="campaign-view"][data-status="review"]', 30_000);
        await p.point(`@recipient-draft-${demoId(0x70100)}`);
      },
    },
    {
      label: 'Take Gary off: his heater went in last month',
      voiceover:
        'Gary had his water heater put in last month, so take him off. You can change any text, or take anyone off, before it goes.',
      change: (w) => {
        const r = w.campaigns.find((c) => c.id === CAMPAIGN)?.recipients.find((x) => x.id === GARY);
        if (r) r.removed = true;
      },
      run: (p) => p.click(`@recipient-remove-${GARY}`),
    },
    {
      label: 'Approve all and send',
      voiceover:
        'Approve them all. They go out twenty an hour, only while you’re open, and never during quiet hours.',
      change: (w, at) => {
        const c = w.campaigns.find((x) => x.id === CAMPAIGN);
        if (c) c.approvedAt = at;
      },
      run: (p) => p.click('@campaign-approve'),
    },
  ],
};
