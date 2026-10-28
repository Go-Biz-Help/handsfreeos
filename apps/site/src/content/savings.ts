/**
 * What a business pays today for the separate tools HandsFreeOS replaces: the home page's bill.
 *
 * Every price is another company's public list price, read off its own pricing page on the date below, and the
 * page links each one so a visitor can check it. Never round a price in our favour, never add a tool HandsFreeOS
 * does not replace today, and check them all again every three months: a stale price is a claim we can no longer
 * stand behind. A tool whose HandsFreeOS side is still being built stays on the list with `live: false`, shown as
 * coming and left out of the total, until it ships.
 *
 * The example business has five people on the phone, inbox and email tools, and two on video, notes and signing.
 */
import { foundingSpots, typicalUsage } from './site';

export const pricesCheckedOn = '28 October 2026';

export type StackTool = {
  readonly id: string;
  /** Who sells it, for the sources line. */
  readonly company: string;
  /** What the job is, in the owner's words. */
  readonly job: string;
  /** The product somebody would buy for it, and the plan. */
  readonly product: string;
  /** Monthly cost for the example business, in dollars. */
  readonly monthly: number;
  readonly source: string;
  /** False while HandsFreeOS's own version is being built. */
  readonly live: boolean;
};

export const stack: readonly StackTool[] = [
  {
    id: 'phone',
    company: 'Quo',
    job: 'Business phone and texting',
    product: 'Quo Business, 5 people',
    monthly: 165,
    source: 'https://www.quo.com/pricing',
    live: true,
  },
  {
    id: 'crm',
    company: 'Jobber',
    job: 'CRM, quotes and invoices',
    product: 'Jobber Connect, 5 people',
    monthly: 199,
    source: 'https://www.getjobber.com/pricing/',
    live: true,
  },
  {
    id: 'receptionist',
    company: 'Jobber',
    job: 'AI that answers the phone',
    product: 'Jobber AI Receptionist',
    monthly: 29,
    source: 'https://www.getjobber.com/pricing/',
    live: true,
  },
  {
    id: 'chat',
    company: 'Tidio',
    job: 'Website chat with AI',
    product: 'Tidio Starter and Lyro',
    monthly: 56.67,
    source: 'https://www.tidio.com/pricing/',
    live: true,
  },
  {
    id: 'video',
    company: 'Zoom',
    job: 'Video calls',
    product: 'Zoom Workplace Pro, 2 people',
    monthly: 33.98,
    source: 'https://zoom.us/pricing',
    live: true,
  },
  {
    id: 'notes',
    company: 'Otter',
    job: 'AI notes from calls',
    product: 'Otter Business, 2 people',
    monthly: 60,
    source: 'https://otter.ai/pricing',
    live: true,
  },
  {
    id: 'forms',
    company: 'Jotform',
    job: 'Forms, surveys and quizzes',
    product: 'Jotform Bronze',
    monthly: 39,
    source: 'https://www.jotform.com/pricing/',
    live: true,
  },
  {
    id: 'campaigns',
    company: 'Mailchimp',
    job: 'Email campaigns',
    product: 'Mailchimp Standard',
    monthly: 20,
    source: 'https://mailchimp.com/pricing/marketing/',
    live: true,
  },
  {
    id: 'reviews',
    company: 'NiceJob',
    job: 'Review requests',
    product: 'NiceJob Starter',
    monthly: 75,
    source: 'https://get.nicejob.com/pricing',
    live: true,
  },
  {
    id: 'email',
    company: 'Google Workspace',
    job: 'Business email',
    product: 'Google Workspace Starter, 5 people',
    monthly: 42,
    source: 'https://workspace.google.com/pricing',
    live: true,
  },
  {
    id: 'esign',
    company: 'DocuSign',
    job: 'E-signatures',
    product: 'DocuSign Standard, 2 people',
    monthly: 60,
    source: 'https://ecom.docusign.com/plans-and-pricing/esignature',
    live: false,
  },
];

/** Each company once, with its pricing page, for the sources line under the bill. */
export const stackSources = [...new Map(stack.map((t) => [t.source, t.company])).entries()].map(
  ([source, company]) => ({ company, source }),
);

/** What the example business pays a month for the tools HandsFreeOS replaces today. */
export const stackTotal = stack.filter((t) => t.live).reduce((sum, t) => sum + t.monthly, 0);

const monthly = foundingSpots.find((s) => s.plan === 'monthly')?.price ?? 0;

/** HandsFreeOS for the same business a month: the monthly plan plus the usual usage. */
export const ours = { low: monthly + typicalUsage.low, high: monthly + typicalUsage.high } as const;

/** What comes back a year, from the worst case to the best. */
export const yearlySavings = {
  low: (stackTotal - ours.high) * 12,
  high: (stackTotal - ours.low) * 12,
} as const;

/** "$720", rounded to whole dollars. */
export const usd = (value: number): string => `$${Math.round(value).toLocaleString('en-US')}`;

/** "$6,800", rounded to the nearest hundred: a yearly figure is an estimate, and it says so by its roundness. */
export const roughUsd = (value: number): string =>
  `$${(Math.round(value / 100) * 100).toLocaleString('en-US')}`;

/** Setup fees elsewhere, for "up and running this week". */
export const setupFees = [
  {
    name: 'HubSpot Sales Hub Professional',
    fee: '$1,500 setup fee',
    source: 'https://www.hubspot.com/pricing/sales/starter',
  },
  { name: 'Keap', fee: 'a required paid setup package', source: 'https://keap.com/pricing' },
] as const;
