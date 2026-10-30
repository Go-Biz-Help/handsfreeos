/**
 * The "vs" pages: HandsFreeOS beside a tool people are already paying for, one page each (`/vs/<id>`).
 *
 * People shopping compare, and they ask search engines and assistants "X vs Y" before they ask us. So each page
 * answers it plainly, and it has to be a page somebody on the other tool would call fair:
 *
 * - **Their side is only what their own pricing page says,** linked, with the date it was read. Never guess at a
 *   feature they don't list; leave the row out instead. Check every price again with savings.ts's, every three
 *   months.
 * - **Our side is only what HandsFreeOS does today** (content/features.ts). Something still being built is not a row.
 * - **Each page says when the other tool is the better pick.** It is true, and an honest page is believed.
 * - No logos, and no words of theirs but prices and plan names: their names are trademarks of their owners.
 */
import { ours, usd } from './savings';
import { typicalUsage } from './site';

export const comparedOn = '30 October 2026';

export interface CompareRow {
  /** What is being compared, in the owner's words. */
  readonly what: string;
  readonly them: string;
  readonly us: string;
}

export interface Competitor {
  /** The address: `/vs/<id>`. */
  readonly id: string;
  readonly name: string;
  /** The `<title>`, before " · HandsFreeOS": under about 45 characters. */
  readonly title: string;
  /** The meta description: under about 160 characters. */
  readonly description: string;
  readonly h1: string;
  readonly intro: string;
  /** Their public pricing page, where every number of theirs below was read. */
  readonly source: string;
  /** The example business both sides are priced for. */
  readonly example: string;
  readonly rows: readonly CompareRow[];
  /** Their monthly total for the example, and what it is made of. */
  readonly theirTotal: { readonly monthly: number; readonly parts: string };
  /** What is different about HandsFreeOS, as things it does: never a claim about what they lack. */
  readonly different: readonly { readonly title: string; readonly body: string }[];
  /** When they are the better pick. */
  readonly theyFit: readonly string[];
  /** How a business on them moves over. */
  readonly moving: string;
  readonly faqs: readonly { readonly q: string; readonly a: string }[];
}

const oursMonthly = `${usd(ours.low)}–${usd(ours.high)} a month`;
const usage = `about $${typicalUsage.low}–$${typicalUsage.high}`;

export const competitors: readonly Competitor[] = [
  {
    id: 'jobber',
    name: 'Jobber',
    title: 'HandsFreeOS vs Jobber: price and AI compared',
    description:
      'HandsFreeOS and Jobber side by side for a five-person crew: plan price, per-person charges, AI phone answering and marketing, from Jobber’s own pricing page.',
    h1: 'HandsFreeOS vs Jobber',
    intro:
      'Jobber is a well-known way to run quotes, jobs and invoices. HandsFreeOS does those too, and puts an AI teammate in front of them that answers the calls, texts and chats, books the job and chases the money. Here is what each costs a five-person crew, with Jobber’s numbers from its own pricing page.',
    source: 'https://www.getjobber.com/pricing/',
    example: 'A five-person crew, paying month to month',
    rows: [
      {
        what: 'The plan, for 5 people',
        them: 'Connect, $199 a month',
        us: '$97 a month, plus what you use',
      },
      {
        what: 'Each extra person',
        them: '$29 a month',
        us: 'Nothing',
      },
      {
        what: 'AI that answers the phone',
        them: 'AI Receptionist, $29 a month extra (in the $499 Plus plan)',
        us: 'In the plan; you pay for the calls it takes',
      },
      {
        what: 'Email and text campaigns',
        them: 'Marketing Suite, $99 a month extra (in Plus)',
        us: 'In the plan',
      },
      {
        what: 'Review requests',
        them: 'A Reviews add-on',
        us: 'In the plan',
      },
      {
        what: 'Card payments',
        them: 'Jobber Payments, 2.9% + 30¢',
        us: 'Your own Stripe or Square, at their rates',
      },
    ],
    theirTotal: {
      monthly: 199 + 29 + 99,
      parts: 'Connect for 5 people, AI Receptionist and Marketing Suite',
    },
    different: [
      {
        title: 'The AI does the first reply, not you',
        body: 'Calls, texts, email and website chat are answered in seconds, calls in English or Spanish too, and the job is booked straight onto the calendar. It asks you first until a kind of reply has earned enough of your OKs.',
      },
      {
        title: 'One inbox for everything',
        body: 'Texts, calls, voicemail typed out, email and website chat, one thread per customer, on your own business number.',
      },
      {
        title: 'The tools around it are in the plan',
        body: 'Video calls with the notes written for you, documents to sign, forms, campaigns and review requests, so there is less to buy beside it.',
      },
      {
        title: 'No charge per person',
        body: 'Hire your next tech and the bill stays the same.',
      },
    ],
    theyFit: [
      'You need job costing or inventory. HandsFreeOS doesn’t do either.',
      'Your crew has years of jobs in Jobber and likes it, and the phone is not what you lose work to.',
    ],
    moving:
      'Your customers come in from a spreadsheet in minutes, counted before anything moves and undoable. Tell us you’re on Jobber and we’ll tell you how much more of your history we can bring.',
    faqs: [
      {
        q: 'Is HandsFreeOS cheaper than Jobber?',
        a: `For a five-person crew on monthly billing, Jobber Connect is $199 a month before the AI Receptionist ($29) or Marketing Suite ($99), and each extra person is $29. HandsFreeOS is $97 a month for everyone, plus the texts, calls and AI you use, ${usage} for most businesses: ${oursMonthly} in all.`,
      },
      {
        q: 'Does HandsFreeOS do quotes and invoices like Jobber?',
        a: 'Yes. Customers approve a quote on their phone by typing their name, it becomes an invoice, and the invoice follows itself up until it is paid. Deposits and monthly plans too, paid into your own Stripe or Square.',
      },
      {
        q: 'Can I try it before I leave Jobber?',
        a: 'Yes. Sign up, set it up in an afternoon, and run it beside Jobber for as long as you like. If it isn’t for you within 30 days, you get your plan payment back.',
      },
    ],
  },
  {
    id: 'gohighlevel',
    name: 'GoHighLevel',
    title: 'HandsFreeOS vs GoHighLevel compared',
    description:
      'HandsFreeOS and GoHighLevel side by side: price, users, AI and who each is built for, from GoHighLevel’s own pricing page.',
    h1: 'HandsFreeOS vs GoHighLevel',
    intro:
      'GoHighLevel starts at the same $97 a month, and both have unlimited users. The difference is who each is built for. GoHighLevel is built for agencies running accounts for their clients. HandsFreeOS is built for the owner of one service business, and sets itself up from a few questions.',
    source: 'https://www.gohighlevel.com/pricing',
    example: 'One service business, paying month to month',
    rows: [
      {
        what: 'The plan',
        them: 'Starter, $97 a month, with 3 sub-accounts',
        us: '$97 a month, for your business',
      },
      {
        what: 'People',
        them: 'Unlimited',
        us: 'Unlimited',
      },
      {
        what: 'Texts, calls, email and AI',
        them: 'Billed for what you use',
        us: `Billed for what you use, ${usage} a month for most`,
      },
      {
        what: 'An AI that answers for you',
        them: 'AI Employee, $50 a month per sub-account (or $97 unlimited), plus usage',
        us: 'In the plan; you pay for what it uses',
      },
      {
        what: 'Built for',
        them: 'Agencies, with sub-accounts and rebilling',
        us: 'The owner of one service business',
      },
    ],
    theirTotal: { monthly: 97 + 50, parts: 'Starter and the AI Employee for one sub-account' },
    different: [
      {
        title: 'It sets itself up',
        body: 'Answer questions in plain English and the Assistant sets up your hours, services, prices, reminders and booking page, and reads your website for the rest. No funnels or workflows to build first.',
      },
      {
        title: 'Made for the trades',
        body: 'Quotes customers approve by typing their name, invoices that chase themselves, deposits at booking and monthly plans, paid into your own Stripe or Square.',
      },
      {
        title: 'It asks before it acts',
        body: 'The AI drafts and waits for your tap until a kind of reply has earned enough of your OKs. Prices stay locked until you turn them on.',
      },
      {
        title: 'A phone app that works with no signal',
        body: 'Notes, photos, jobs and invoices save in a basement and send when the bars come back.',
      },
    ],
    theyFit: [
      'You run an agency and resell software to many clients under your own brand.',
      'You want to build your own funnels, websites and workflows from scratch, and have the time to.',
    ],
    moving:
      'Moving from GoHighLevel is the one we built first: contacts, conversations with their real dates, and more, counted before anything moves, the same customer arriving twice joined without guessing, and the whole move undoable. It’s included.',
    faqs: [
      {
        q: 'Is HandsFreeOS like GoHighLevel?',
        a: 'Both put texts, calls, email, booking and AI in one place. GoHighLevel is built for agencies managing many client accounts. HandsFreeOS is built for one service business, with quotes, invoices and a phone app for the crew, and it sets itself up from a few questions.',
      },
      {
        q: 'Which costs less?',
        a: `Both start at $97 a month with usage on top. GoHighLevel’s AI Employee is $50 a month per sub-account on top of that. On HandsFreeOS the AI teammate is in the plan and you pay for what it uses, ${usage} a month for most businesses in all.`,
      },
      {
        q: 'Can I bring my GoHighLevel contacts and conversations?',
        a: 'Yes, and moving is included. Everything is counted before anything moves, old conversations keep the dates they really happened on, and the whole move can be undone.',
      },
    ],
  },
];

export const competitorById = (id: string): Competitor | undefined =>
  competitors.find((c) => c.id === id);
