/**
 * A page for each trade (`/<slug>`): the home page's story told for one trade from the first line, for the owner
 * who searched for software for their trade or came from an ad for it.
 *
 * Its example conversation and lost lead are the trade's own in trades.ts, so the two never drift. What is written
 * here is the rest: the headline, the pains in that trade's words, and the jobs HandsFreeOS takes off that owner.
 * Every job named is something the product does today (content/features.ts); a trade's pain is never a number,
 * since there are none we can stand behind.
 */
import type { TradeId } from './trades';

export interface TradePage {
  readonly trade: Exclude<TradeId, 'other'>;
  /** The address, without the slash. */
  readonly slug: string;
  /** Who it is for, in the eyebrow and the footer: "Heating and air companies". */
  readonly who: string;
  /** The `<title>`, before " · HandsFreeOS": under about 45 characters. */
  readonly title: string;
  /** The meta description: under about 160 characters. */
  readonly description: string;
  readonly h1: string;
  readonly sub: string;
  /** The night band's heading and the three costs under it. */
  readonly night: string;
  readonly pains: readonly { readonly title: string; readonly body: string }[];
  /** What it handles for this trade, each a thing the product does. */
  readonly jobs: readonly { readonly title: string; readonly body: string }[];
}

export const tradePages: readonly TradePage[] = [
  {
    trade: 'hvac',
    slug: 'hvac',
    who: 'Heating and air companies',
    title: 'HVAC software that answers every call',
    description:
      'HandsFreeOS answers your HVAC calls and texts in seconds, books the visit, chases the quote and bills maintenance plans every month. One plan, your whole crew.',
    h1: 'The no-cool call at 7pm gets answered, and booked.',
    sub: 'HandsFreeOS picks up your calls, answers texts and website chats, books the visit and chases the quote and the invoice. You step in only when it matters.',
    night: 'When it’s 95 out, they call whoever answers first.',
    pains: [
      {
        title: 'The emergency nobody picked up',
        body: 'No heat or no cooling, so they texted three companies at once. The first to reply got the job, and the replacement after it.',
      },
      {
        title: 'Tune-ups nobody reminded',
        body: 'Every customer due a spring or fall service is a booked day waiting for somebody to text them.',
      },
      {
        title: 'The replacement quote that went quiet',
        body: 'A big quote sent on Monday and never followed up is somebody else’s install by Friday.',
      },
    ],
    jobs: [
      {
        title: 'Every call and text answered',
        body: 'The AI asks what’s wrong and books the diagnostic, by text, chat or phone. Calls in Spanish too.',
      },
      {
        title: 'Maintenance plans that bill themselves',
        body: 'Monthly plans charge every month on their own, into your own Stripe or Square.',
      },
      {
        title: 'Service reminders sent for you',
        body: '“Text everyone whose service is due” and it writes each customer their own message, for your OK.',
      },
      {
        title: 'Quotes that follow themselves up',
        body: 'They approve on their phone by typing their name, and a quiet quote gets a reminder, then a call when you OK it.',
      },
    ],
  },
  {
    trade: 'plumbing',
    slug: 'plumbing',
    who: 'Plumbing companies',
    title: 'Plumbing software that answers every call',
    description:
      'HandsFreeOS answers your plumbing calls and texts in seconds, books the job, takes the deposit and chases the invoice. One plan, your whole crew.',
    h1: 'The burst pipe at 9pm gets answered, and booked.',
    sub: 'HandsFreeOS picks up your calls, answers texts and website chats, books the job and chases the quote and the invoice. You step in only when it matters.',
    night: 'A leak can’t wait, so they won’t wait for you.',
    pains: [
      {
        title: 'The call you missed under a sink',
        body: 'Your hands were full. They called the next plumber on the list, and that plumber picked up.',
      },
      {
        title: 'The water heater quote nobody chased',
        body: 'They wanted to think about it. Nobody asked again, and they found someone who did.',
      },
      {
        title: 'Invoices you meant to follow up',
        body: 'The work is done and paid for in your head. The money is still in their account.',
      },
    ],
    jobs: [
      {
        title: 'Every call and text answered',
        body: 'The AI picks up, gets the address and what’s leaking, and books the visit, by text, chat or phone.',
      },
      {
        title: 'Missed calls texted back',
        body: 'A call you couldn’t take gets a text back within a minute, before they dial the next plumber.',
      },
      {
        title: 'Deposits taken at booking',
        body: 'Ask for a deposit when they book, paid into your own Stripe or Square.',
      },
      {
        title: 'Invoices that chase themselves',
        body: 'Politely and on schedule, so you never have to be the bill collector.',
      },
    ],
  },
  {
    trade: 'electrical',
    slug: 'electrical',
    who: 'Electricians',
    title: 'Software for electricians that answers',
    description:
      'HandsFreeOS answers your calls and texts in seconds, books the job, gets quotes approved on the customer’s phone and chases the invoice. One plan, your whole crew.',
    h1: 'Every “is anyone free this week?” answered in seconds.',
    sub: 'HandsFreeOS picks up your calls, answers texts and website chats, books the job and chases the quote and the invoice. You step in only when it matters.',
    night: 'You can’t answer the phone from inside a panel.',
    pains: [
      {
        title: 'The lead that texted while you were on a ladder',
        body: 'By the time you climbed down, they had booked someone else.',
      },
      {
        title: 'Quotes written at the kitchen table',
        body: 'The panel upgrade quote you meant to send tonight is still a note on your phone.',
      },
      {
        title: 'Documents to sign, in another app',
        body: 'Contracts and change orders going out through yet another subscription.',
      },
    ],
    jobs: [
      {
        title: 'Every call and text answered',
        body: 'The AI picks up, asks what the job is and books the visit, by text, chat or phone.',
      },
      {
        title: 'Quotes approved on their phone',
        body: 'Send it from the truck. They accept by typing their name, and it becomes an invoice.',
      },
      {
        title: 'Contracts signed without another app',
        body: 'Send a document to sign, in the order you choose, or have them sign on your phone on site.',
      },
      {
        title: 'Check-ins for anyone working alone',
        body: 'If a tech doesn’t check out on time, someone is told. “I’m OK” works from the lock screen.',
      },
    ],
  },
  {
    trade: 'cleaning',
    slug: 'cleaning',
    who: 'House cleaning companies',
    title: 'House cleaning software that answers',
    description:
      'HandsFreeOS answers your cleaning leads in seconds, books the visit, books repeat cleans and asks for the review. One plan, your whole team.',
    h1: 'Every “how soon can you come?” answered, and booked.',
    sub: 'HandsFreeOS answers your texts, calls and website chats, books the clean, books the repeat visits and asks for the review. You step in only when it matters.',
    night: 'They asked three cleaners. The first to answer got the house.',
    pains: [
      {
        title: 'Leads that came in while you were cleaning',
        body: 'Gloves on, phone in the car. They booked the cleaner who wrote back.',
      },
      {
        title: 'Repeat cleans booked by hand',
        body: 'Every weekly and every other week visit is a text you have to send and a calendar you have to keep.',
      },
      {
        title: 'Reviews you never asked for',
        body: 'Happy customers would say so. Nobody asked them at the right time.',
      },
    ],
    jobs: [
      {
        title: 'Every lead answered',
        body: 'The AI answers by text, chat or phone, checks you cover their address and books the clean.',
      },
      {
        title: 'Repeat visits booked for you',
        body: 'It books the weekly or every other week clean in the same conversation, with reminders before each one.',
      },
      {
        title: 'Review requests after a good clean',
        body: 'A happy customer is asked for a review. An unhappy one is brought to you instead.',
      },
      {
        title: 'A waitlist for a full week',
        body: 'When the calendar is full, it adds them to the waitlist rather than letting them go.',
      },
    ],
  },
  {
    trade: 'lawn',
    slug: 'lawn-care',
    who: 'Lawn care companies',
    title: 'Lawn care software that answers every lead',
    description:
      'HandsFreeOS answers your lawn care leads in seconds, books the visit, bills plans every month and chases the invoice. One plan, your whole crew.',
    h1: 'Every “how much for my yard?” answered while you mow.',
    sub: 'HandsFreeOS answers your texts, calls and website chats, books the visit to measure, bills the plan every month and chases the invoice. You step in only when it matters.',
    night: 'You can’t hear the phone over a mower.',
    pains: [
      {
        title: 'Spring leads you couldn’t get to',
        body: 'Everybody wants a quote the same two weeks. The ones you answered late went to someone else.',
      },
      {
        title: 'Plans billed by hand',
        body: 'Every monthly customer is an invoice somebody has to send, every month.',
      },
      {
        title: 'Addresses you don’t cover',
        body: 'Time spent on leads far outside the area you mow.',
      },
    ],
    jobs: [
      {
        title: 'Every lead answered',
        body: 'The AI answers by text, chat or phone, checks you cover their address and books a visit to measure.',
      },
      {
        title: 'Plans that bill themselves',
        body: 'Monthly plans charge every month on their own, into your own Stripe or Square.',
      },
      {
        title: 'Seasonal campaigns written for you',
        body: 'Say what it’s for in a line, and the AI writes each customer their own text, for your OK.',
      },
      {
        title: 'Notes and photos with no signal',
        body: 'On the phone app, everything saves out at the property and sends when the bars come back.',
      },
    ],
  },
  {
    trade: 'roofing',
    slug: 'roofing',
    who: 'Roofing companies',
    title: 'Roofing software that answers every lead',
    description:
      'HandsFreeOS answers your roofing leads in seconds, books the inspection, gets contracts signed and chases the quote. One plan, your whole crew.',
    h1: 'After the storm, every leak gets an answer first.',
    sub: 'HandsFreeOS answers your calls, texts and website chats, books the inspection, gets the contract signed and chases the quote. You step in only when it matters.',
    night: 'After a storm, the phone rings while you’re on a roof.',
    pains: [
      {
        title: 'The storm rush you couldn’t answer',
        body: 'Everybody calls the same day, and the ones you got to tomorrow had already booked.',
      },
      {
        title: 'Big quotes that went quiet',
        body: 'A full replacement quote with no follow-up is a job somebody else is doing.',
      },
      {
        title: 'Contracts in another app',
        body: 'Signing through a separate subscription, and chasing the ones nobody signed.',
      },
    ],
    jobs: [
      {
        title: 'Every call and text answered',
        body: 'The AI picks up, asks about the leak and books the inspection, by text, chat or phone.',
      },
      {
        title: 'Contracts signed on their phone',
        body: 'Send it to sign with reminders until it’s done, or have them sign on your phone at the kitchen table.',
      },
      {
        title: 'Quotes that follow themselves up',
        body: 'A quiet quote gets a reminder, then a call when you OK it.',
      },
      {
        title: 'Video calls with the notes written',
        body: 'Walk a customer through the photos on a call, and the summary waits on their record afterwards.',
      },
    ],
  },
  {
    trade: 'pest',
    slug: 'pest-control',
    who: 'Pest control companies',
    title: 'Pest control software that answers',
    description:
      'HandsFreeOS answers your pest control calls and texts in seconds, books the treatment, books the follow-ups and bills plans every month. One plan, your whole crew.',
    h1: 'Every “we just saw one” answered, and booked.',
    sub: 'HandsFreeOS answers your calls, texts and website chats, books the treatment and the follow-ups, and bills the plan every month. You step in only when it matters.',
    night: 'Nobody waits until morning with something in the kitchen.',
    pains: [
      {
        title: 'The call that came in after hours',
        body: 'They wanted someone tomorrow. They booked whoever answered tonight.',
      },
      {
        title: 'Follow-up treatments booked by hand',
        body: 'Every second visit and every quarterly service is a text and a calendar slot somebody has to remember.',
      },
      {
        title: 'Plans billed one by one',
        body: 'Monthly and quarterly customers, invoiced by hand.',
      },
    ],
    jobs: [
      {
        title: 'Every call and text answered',
        body: 'The AI picks up, asks what they’re seeing and books the treatment, by text, chat or phone.',
      },
      {
        title: 'Follow-up visits booked for you',
        body: 'It books the repeat visits in the same conversation, with reminders before each one.',
      },
      {
        title: 'Plans that bill themselves',
        body: 'Recurring plans charge on their own, into your own Stripe or Square.',
      },
      {
        title: 'Tomorrow’s visits confirmed',
        body: 'It can call to confirm tomorrow’s visit, and always says it’s an AI.',
      },
    ],
  },
  {
    trade: 'handyman',
    slug: 'handyman',
    who: 'Handyman businesses',
    title: 'Handyman software that answers every lead',
    description:
      'HandsFreeOS answers your handyman leads in seconds, books the job, sends the quote and chases the invoice. One plan, everyone who works with you.',
    h1: 'Every “can you fix this?” answered while you fix something else.',
    sub: 'HandsFreeOS answers your calls, texts and website chats, books the job, gets the quote approved and chases the invoice. You step in only when it matters.',
    night: 'You’re the one doing the work, and the one answering the phone.',
    pains: [
      {
        title: 'Small jobs you never called back',
        body: 'Lots of little requests, and the ones you missed added up to whole days of work.',
      },
      {
        title: 'Quotes written at night',
        body: 'Pricing the list from the visit after dinner, then forgetting to send it.',
      },
      {
        title: 'Getting paid on the spot',
        body: 'Chasing a check for a two-hour job.',
      },
    ],
    jobs: [
      {
        title: 'Every lead answered',
        body: 'The AI answers by text, chat or phone, asks about the job and books a time.',
      },
      {
        title: 'Quotes approved on their phone',
        body: 'They accept by typing their name, and it becomes an invoice.',
      },
      {
        title: 'Paid before you leave',
        body: 'Card payments into your own Stripe or Square, and invoices that chase themselves if they don’t.',
      },
      {
        title: 'Ask it anything',
        body: '“Who hasn’t paid me?” “Book Dale for Thursday morning.” It answers from your real data.',
      },
    ],
  },
];

export const tradePageBySlug = (slug: string): TradePage | undefined =>
  tradePages.find((p) => p.slug === slug);
