/**
 * "Try it on your business": the home page's example, told once for each kind of business a visitor can pick.
 *
 * The hero's conversation and the night band's missed lead both read from here, so a cleaner sees a move-out clean
 * and a roofer sees a storm leak instead of everybody seeing an AC repair. Each one is an illustration of what the
 * product does today, and the caption says the people and messages are made up:
 *
 * - Ava says it is the business's assistant, never the owner.
 * - It offers two times and books the one the customer picks, with reminder texts.
 * - It never sends a price on its own at first: the quote waits for the owner's OK. That is why the lawn care
 *   customer who asks "how much?" gets a visit to measure, not a number.
 *
 * `{business}` in a reply is the visitor's business name, or `sample` until they type one. `industry` is the kind of
 * business in packages/core/src/industries.ts, so the app's first setup screen can start on it; keep each one a real
 * id there, or null.
 */

export type TradeId =
  | 'hvac'
  | 'plumbing'
  | 'electrical'
  | 'cleaning'
  | 'lawn'
  | 'roofing'
  | 'pest'
  | 'handyman'
  | 'other';

export interface Trade {
  readonly id: TradeId;
  /** What the picker says. */
  readonly label: string;
  /** The kind of business on core's list, or null for one it can't name. */
  readonly industry: string | null;
  /** The made-up business the example shows until the visitor types their own. */
  readonly sample: string;
  /** The new customer texting in. */
  readonly lead: { readonly name: string; readonly initials: string; readonly first: string };
  readonly ask: string;
  readonly reply: string;
  readonly pick: string;
  /** What the booking card says after "Booked ·". */
  readonly booked: string;
  /** The price that waits for the owner's OK: "a {price} {what} quote", then the draft Ava wrote. */
  readonly quote: { readonly price: string; readonly what: string; readonly draft: string };
  /** The night band's lead, the one nobody answered: their first text and their last. */
  readonly lost: { readonly name: string; readonly ask: string; readonly gone: string };
}

const GONE = 'All good, found someone who can come tonight. Thanks anyway.';

export const trades: readonly Trade[] = [
  {
    id: 'hvac',
    label: 'Heating & air',
    industry: 'hvac',
    sample: 'Lone Star Heating & Air',
    lead: { name: 'Marisol R.', initials: 'MR', first: 'Marisol' },
    ask: 'Hi — my AC is blowing warm air. Can anyone come out today?',
    reply:
      'Hi Marisol, it’s Ava at {business}. Sorry about that, warm air in this heat is no fun. I can get a tech to you tomorrow between 8 and 10 AM, or today between 5 and 7 PM. Which suits you?',
    pick: 'Tomorrow 8–10 please',
    booked: 'Tue 8:00–10:00 AM · Dale · Diagnostic visit',
    quote: {
      price: '$189',
      what: 'diagnostic',
      draft: 'Your quote for tomorrow’s visit: $189. Look it over and accept it here.',
    },
    lost: {
      name: 'Kevin M.',
      ask: 'Hi, our AC just stopped and it’s 84 in the house. Is anyone free tonight?',
      gone: GONE,
    },
  },
  {
    id: 'plumbing',
    label: 'Plumbing',
    industry: 'plumbing',
    sample: 'Lone Star Plumbing',
    lead: { name: 'Tasha W.', initials: 'TW', first: 'Tasha' },
    ask: 'Hi, our water heater is leaking all over the garage. Can someone come today?',
    reply:
      'Hi Tasha, it’s Ava at {business}. Sorry, that can’t wait. I can get a plumber to you today between 4 and 6 PM, or tomorrow between 8 and 10 AM. Which works?',
    pick: 'Today 4–6 please',
    booked: 'Today 4:00–6:00 PM · Luis · Water heater repair',
    quote: {
      price: '$149',
      what: 'service call',
      draft: 'Your quote for today’s visit: $149. Look it over and accept it here.',
    },
    lost: {
      name: 'Kevin M.',
      ask: 'Hi, is anyone free to look at a leaking water heater today?',
      gone: GONE,
    },
  },
  {
    id: 'electrical',
    label: 'Electrical',
    industry: 'electrical',
    sample: 'Lone Star Electric',
    lead: { name: 'Priya S.', initials: 'PS', first: 'Priya' },
    ask: 'Hi, a breaker in our kitchen keeps tripping. Can someone look at it this week?',
    reply:
      'Hi Priya, it’s Ava at {business}. Thanks for letting us know. I can get an electrician to you Thursday between 9 and 11 AM, or Friday between 1 and 3 PM. Which suits you?',
    pick: 'Thursday morning works',
    booked: 'Thu 9:00–11:00 AM · Marcus · Breaker check',
    quote: {
      price: '$129',
      what: 'service call',
      draft: 'Your quote for Thursday’s visit: $129. Look it over and accept it here.',
    },
    lost: {
      name: 'Kevin M.',
      ask: 'Hi, half our outlets just stopped working. Can anyone come out tonight?',
      gone: GONE,
    },
  },
  {
    id: 'cleaning',
    label: 'House cleaning',
    industry: 'house_cleaning',
    sample: 'Lone Star Cleaning',
    lead: { name: 'Jenna L.', initials: 'JL', first: 'Jenna' },
    ask: 'Hi! Do you do move-out cleans? We hand the keys back Friday.',
    reply:
      'Hi Jenna, it’s Ava at {business}. We do, and congrats on the move! I can send a team Thursday from 9 AM to 1 PM, or Friday from 8 AM to noon. Which is better?',
    pick: 'Thursday please',
    booked: 'Thu 9:00 AM–1:00 PM · Rosa’s team · Move-out clean',
    quote: {
      price: '$320',
      what: 'move-out clean',
      draft: 'Your quote for Thursday’s move-out clean: $320. Look it over and accept it here.',
    },
    lost: {
      name: 'Kevin M.',
      ask: 'Hi, could someone do a deep clean before our party on Saturday?',
      gone: 'All good, found someone who can fit us in. Thanks anyway.',
    },
  },
  {
    id: 'lawn',
    label: 'Lawn care',
    industry: 'lawn_care',
    sample: 'Lone Star Lawn Care',
    lead: { name: 'Greg T.', initials: 'GT', first: 'Greg' },
    ask: 'Hey, how much for weekly mowing? We’re the corner lot on Elm.',
    reply:
      'Hi Greg, it’s Ava at {business}. Happy to get you a price. Someone can stop by to measure Wednesday between 10 and noon, or Thursday between 2 and 4 PM. Which works?',
    pick: 'Wednesday works',
    booked: 'Wed 10:00 AM–12:00 PM · Andre · Measure for weekly mowing',
    quote: {
      price: '$45',
      what: 'weekly mowing',
      draft: 'Your quote for weekly mowing: $45 a visit. Look it over and accept it here.',
    },
    lost: {
      name: 'Kevin M.',
      ask: 'Hi, are you taking new lawns? Ours is getting out of hand.',
      gone: 'All good, found someone who can start this week. Thanks anyway.',
    },
  },
  {
    id: 'roofing',
    label: 'Roofing',
    industry: 'roofing',
    sample: 'Lone Star Roofing',
    lead: { name: 'Dana K.', initials: 'DK', first: 'Dana' },
    ask: 'Hi, there’s a leak in our ceiling since last night’s storm. Can someone check the roof?',
    reply:
      'Hi Dana, it’s Ava at {business}. Sorry about the leak. I can get someone out to look today between 3 and 5 PM, or tomorrow between 8 and 10 AM. Which suits you?',
    pick: 'Today 3–5 please',
    booked: 'Today 3:00–5:00 PM · Ray · Roof inspection',
    quote: {
      price: '$275',
      what: 'leak repair',
      draft: 'Your quote for the leak repair: $275. Look it over and accept it here.',
    },
    lost: {
      name: 'Kevin M.',
      ask: 'Hi, the wind took some shingles off. Can anyone look at it tomorrow?',
      gone: 'All good, found someone who can come first thing. Thanks anyway.',
    },
  },
  {
    id: 'pest',
    label: 'Pest control',
    industry: 'pest_control',
    sample: 'Lone Star Pest Control',
    lead: { name: 'Carlos M.', initials: 'CM', first: 'Carlos' },
    ask: 'Hi, we’re seeing ants all over the kitchen. Can you come out this week?',
    reply:
      'Hi Carlos, it’s Ava at {business}. Sorry, nobody wants ants in the kitchen. I can get a tech to you Tuesday between 8 and 10 AM, or Wednesday between 1 and 3 PM. Which works?',
    pick: 'Tuesday morning please',
    booked: 'Tue 8:00–10:00 AM · Dale · Ant treatment',
    quote: {
      price: '$129',
      what: 'ant treatment',
      draft: 'Your quote for Tuesday’s treatment: $129. Look it over and accept it here.',
    },
    lost: {
      name: 'Kevin M.',
      ask: 'Hi, I think we have mice in the attic. Can someone come out?',
      gone: 'All good, found someone who can come tomorrow. Thanks anyway.',
    },
  },
  {
    id: 'handyman',
    label: 'Handyman',
    industry: 'handyman',
    sample: 'Lone Star Handyman',
    lead: { name: 'Linda P.', initials: 'LP', first: 'Linda' },
    ask: 'Hi, can someone hang a TV and fix a sticking door this week?',
    reply:
      'Hi Linda, it’s Ava at {business}. Happy to help. I can book Sam for Friday between 9 and 11 AM, or Saturday between 10 and noon. Which suits you?',
    pick: 'Saturday please',
    booked: 'Sat 10:00 AM–12:00 PM · Sam · TV mount and door fix',
    quote: {
      price: '$165',
      what: 'two-hour visit',
      draft: 'Your quote for Saturday’s visit: $165. Look it over and accept it here.',
    },
    lost: {
      name: 'Kevin M.',
      ask: 'Hi, do you do small jobs? A few things around the house need fixing.',
      gone: 'All good, found someone who can come this week. Thanks anyway.',
    },
  },
  {
    id: 'other',
    label: 'Something else',
    industry: null,
    sample: 'Lone Star Services',
    lead: { name: 'Jordan B.', initials: 'JB', first: 'Jordan' },
    ask: 'Hi, are you taking new customers? I’d like to book something this week.',
    reply:
      'Hi Jordan, it’s Ava at {business}. We are, thanks for reaching out! I have Thursday at 10 AM or Friday at 2 PM open. Which suits you?',
    pick: 'Thursday at 10',
    booked: 'Thu 10:00 AM · Alex · First visit',
    quote: {
      price: '$150',
      what: 'first visit',
      draft: 'Your quote for Thursday’s visit: $150. Look it over and accept it here.',
    },
    lost: {
      name: 'Kevin M.',
      ask: 'Hi, do you have anything open this week?',
      gone: 'All good, found someone who can fit me in. Thanks anyway.',
    },
  },
];

/** The example the page opens on: the one it has always shown. */
export const firstTrade: Trade = trades[0]!;

export const tradeById = (id: string | null | undefined): Trade | undefined =>
  trades.find((t) => t.id === id);
