/**
 * Examples to model for each part of the main offer, by line of work (`industries.ts`'s groups). The workbook's own
 * are written for marketing agencies; these are written for the businesses that use HandsFreeOS. They're there to
 * model, never to copy, and the builder says so. Browser-safe.
 *
 * A group's examples cover the six parts' main questions; the follow-ups (how it's measured, why it matters, when the
 * guarantee applies) fit any business and come from `ANY_BUSINESS`. A line of work with no examples of its own ("Other")
 * gets those only, and the builder offers the AI's, marked as the AI's.
 */
import { INDUSTRIES, type IndustryGroupName } from '../industries';

/** The boxes that have examples, as `MainOfferParts` names them. */
export const EXAMPLE_PATHS = [
  'who.work',
  'who.slice',
  'who.size',
  'who.problem',
  'outcome.result',
  'outcome.measure',
  'outcome.why',
  'timeframe.typical',
  'timeframe.why',
  'method.steps',
  'method.different',
  'guarantee.promise',
  'guarantee.when',
  'guarantee.qualifies',
  'price.amount',
  'price.structure',
  'price.value',
  'proof',
] as const;
export type ExamplePath = (typeof EXAMPLE_PATHS)[number];

type Examples = Partial<Record<ExamplePath, readonly string[]>>;

/** The follow-up questions' examples: they fit any business. */
const ANY_BUSINESS: Examples = {
  'who.size': ['1 to 3 locations', 'A team of 2 to 10', '$300k to $2M a year'],
  'outcome.measure': [
    'Booked jobs on the calendar, counted each week',
    'New customers who paid, tracked in HandsFreeOS',
  ],
  'outcome.why': [
    'Steady work means they stop worrying about next month',
    'They get their evenings back and can grow the team',
  ],
  'timeframe.why': [
    'It takes a couple of weeks to set up before the first results',
    'Most people decide within a month of first hearing from us',
  ],
  'method.different': [
    'We’ve done this 200 times in this town, so we know what works',
    'You talk to the owner, not a call center',
  ],
  'guarantee.when': [
    'They follow the plan and keep the appointments',
    'Within 30 days of the work being done',
  ],
  'guarantee.qualifies': [
    'A home built after 1990, in our service area',
    'At least 6 months in business, with time to take on new work',
  ],
  'price.structure': [
    'One flat price, quoted before we start',
    'A setup fee, then a monthly plan',
    'Pay per result, nothing up front',
  ],
  'price.value': ['One new customer pays for the whole month', 'It costs less than one missed job'],
};

const BY_GROUP: Record<IndustryGroupName, Examples | null> = {
  'Home services & trades': {
    'who.work': ['Homeowners in the north suburbs', 'Property managers with 20+ rental homes'],
    'who.slice': ['with homes over 15 years old', 'who just bought a house and want it done right'],
    'who.problem': [
      'Their AC keeps breaking in the worst heat, and nobody shows up on time',
      'They’ve been burned by a contractor who took the money and vanished',
    ],
    'outcome.result': [
      'A new roof that passes inspection, with no surprise costs',
      'A cooler house and a power bill 20% lower',
    ],
    'timeframe.typical': ['Done in 1 day', 'Within 2 weeks of saying yes'],
    'method.steps': [
      'Free inspection, Written quote the same day, Install in one day, Clean up and walk-through',
      'Check the whole system, Fix what’s urgent first, Yearly tune-up plan',
    ],
    'guarantee.promise': [
      'If it leaks in the next 10 years, we fix it free',
      'On time or the service call is free',
    ],
    'price.amount': ['From $9,500, or $150 a month with financing', '$89 tune-up'],
    proof: [
      'Replaced the Garcias’ roof in one day after the March hail storm',
      'Cut a 3-bed home’s summer bill from $410 to $290',
    ],
  },
  'Real estate & property': {
    'who.work': ['First-time home buyers', 'Owners of 1 to 5 rental homes'],
    'who.slice': ['renting now and tired of it', 'who live out of state'],
    'who.problem': [
      'They think they can’t afford to buy and don’t know where to start',
      'Late rent and repair calls take over their weekends',
    ],
    'outcome.result': [
      'The keys to their first home',
      'Rent in on time every month, with no calls to them',
    ],
    'timeframe.typical': ['Within 90 days', 'Starting next month'],
    'method.steps': [
      'Plan the budget, Get pre-approved, Tour the best fits, Win the offer',
      'Find the tenant, Collect rent, Handle repairs, Send a monthly report',
    ],
    'guarantee.promise': [
      'If you don’t love the home in the first year, we sell it free',
      'If the tenant doesn’t pay, you don’t pay us',
    ],
    'price.amount': ['Nothing to the buyer, the seller pays', '8% of the rent collected'],
    proof: [
      'Helped the Nguyens buy their first home in 47 days',
      'Kept 12 rentals full for 2 years straight',
    ],
  },
  'Health & care': {
    'who.work': ['Busy parents', 'Office workers'],
    'who.slice': ['with back pain that keeps coming back', 'who haven’t seen a dentist in years'],
    'who.problem': [
      'Pain wakes them up at night and pills aren’t helping',
      'They’re embarrassed about their teeth and stopped smiling in photos',
    ],
    'outcome.result': ['Sleeping through the night without pain', 'A smile they’re proud of'],
    'timeframe.typical': ['In 6 weeks', 'After 3 visits'],
    'method.steps': [
      'Full exam, A plan made for them, Weekly visits, Home exercises',
      'Free consult, Cleaning and X-rays, Treatment in one visit',
    ],
    'guarantee.promise': [
      'If you don’t feel better after 3 visits, the rest are free',
      'Love your smile or we redo it free',
    ],
    'price.amount': ['$49 first visit', 'Most insurance taken, $99 without'],
    proof: [
      'Dana walked her daughter to school without pain after 5 weeks',
      'Helped 140 patients get back to work last year',
    ],
  },
  'Beauty & fitness': {
    'who.work': ['Women over 40', 'Brides'],
    'who.slice': ['who want to get strong, not skinny', 'getting married in the next 6 months'],
    'who.problem': [
      'They’ve tried every app and gym and quit after a month',
      'They’re stressed about looking good in the photos forever',
    ],
    'outcome.result': ['10 pounds down and real strength', 'Flawless hair and makeup on the day'],
    'timeframe.typical': ['In 12 weeks', 'On the day'],
    'method.steps': [
      'Goal session, Plan made for you, 3 coached sessions a week, Weekly check-in',
      'Trial run, Final look picked, Done on the day at your venue',
    ],
    'guarantee.promise': [
      'If you don’t hit your goal, the next month is free',
      'If you don’t love the trial, you pay nothing',
    ],
    'price.amount': ['$199 a month', '$450 for the bride, trial included'],
    proof: [
      'Maria lost 14 pounds and deadlifted her body weight in 12 weeks',
      'Did hair and makeup for 60 weddings last year, 5 stars every time',
    ],
  },
  Pets: {
    'who.work': ['New puppy owners', 'Dog owners who work long days'],
    'who.slice': ['with a puppy under 6 months', 'with a dog that pulls on the leash'],
    'who.problem': [
      'The puppy chews everything and won’t stop biting',
      'Walks are a fight and they’ve stopped going',
    ],
    'outcome.result': ['A calm dog that walks without pulling', 'A tired, happy dog every evening'],
    'timeframe.typical': ['In 4 weeks', 'From day one'],
    'method.steps': [
      'Meet at home, Training plan, 4 weekly lessons, Practice notes for you',
      'Meet and greet, Daily walks, Photo updates, Monthly check-in',
    ],
    'guarantee.promise': [
      'If the pulling isn’t better in 4 weeks, more lessons are free',
      'Happy pup or your money back',
    ],
    'price.amount': ['$399 for 4 lessons', '$25 a walk'],
    proof: [
      'Bear went from dragging Sam down the street to heeling in 3 weeks',
      'Walk 40 dogs a week, the same walker every time',
    ],
  },
  'Auto & vehicles': {
    'who.work': ['Commuters', 'Small businesses with work trucks'],
    'who.slice': ['with cars over 100,000 miles', 'with 3 to 20 vehicles'],
    'who.problem': [
      'They don’t trust shops after being overcharged',
      'A truck down means a day of lost jobs',
    ],
    'outcome.result': [
      'A car that runs right, at a fair price',
      'Trucks back on the road the same day',
    ],
    'timeframe.typical': ['Same day', 'Within 24 hours'],
    'method.steps': [
      'Free check, Photos of what’s wrong, Fix only what you OK, Text when ready',
      'Pick up the truck, Fix it, Drop it back, Monthly fleet report',
    ],
    'guarantee.promise': [
      '2 years or 24,000 miles on parts and labor',
      'Back the same day or the labor is free',
    ],
    'price.amount': ['$59 oil change', '$99 a truck a month'],
    proof: [
      'Kept a 12-truck plumbing fleet on the road for a year with zero lost days',
      'Fixed Rosa’s check engine light for $140 after another shop quoted $1,100',
    ],
  },
  'Finance, legal & insurance': {
    'who.work': ['Small business owners', 'Families'],
    'who.slice': ['doing their own books at night', 'with young kids and no will'],
    'who.problem': [
      'Tax time is a scramble and they’re scared of a mistake',
      'They know they need a plan but keep putting it off',
    ],
    'outcome.result': [
      'Clean books every month and no tax surprises',
      'A will and plan done, so the kids are covered',
    ],
    'timeframe.typical': ['In 30 days', 'In one meeting'],
    'method.steps': [
      'Free review, Clean up the books, Monthly close, Tax filing',
      'Short call, Simple plan, Sign in one meeting',
    ],
    'guarantee.promise': [
      'If we make a mistake, we pay the penalty',
      'If it’s not done in 30 days, it’s free',
    ],
    'price.amount': ['$350 a month', '$799 flat'],
    proof: [
      'Found $14,000 in missed deductions for a 6-person contractor',
      'Helped 90 families finish their wills last year',
    ],
  },
  'Education & childcare': {
    'who.work': ['Parents of kids in grades 6 to 12', 'Working parents'],
    'who.slice': ['whose kid is falling behind in math', 'who need care until 6 pm'],
    'who.problem': [
      'Homework is a nightly fight and grades keep dropping',
      'They’re late to pick up and stressed every day',
    ],
    'outcome.result': ['A full letter grade up', 'A safe, fun place until 6 pm'],
    'timeframe.typical': ['By the end of the term', 'Starting next week'],
    'method.steps': [
      'Free assessment, A plan for the gaps, 2 sessions a week, Notes to parents',
      'Tour, Same-week start, Daily updates with photos',
    ],
    'guarantee.promise': [
      'Up a grade or the next month is free',
      'If your child isn’t happy in the first month, you pay nothing',
    ],
    'price.amount': ['$240 a month', '$180 a week'],
    proof: [
      'Took Ethan from a D to a B in algebra in one term',
      'Families stay with us an average of 3 years',
    ],
  },
  'Events, food & hospitality': {
    'who.work': ['Couples planning a wedding', 'Office managers'],
    'who.slice': ['with 100 to 150 guests', 'planning the holiday party'],
    'who.problem': [
      'They’re overwhelmed and worried something will go wrong on the day',
      'Last year’s party was boring and the food was cold',
    ],
    'outcome.result': [
      'A day they don’t have to think about',
      'A party people talk about all year',
    ],
    'timeframe.typical': ['Booked in one call', 'On the day'],
    'method.steps': [
      'Tasting, Plan the menu, Set up, Serve, Clean up',
      'Planning call, Timeline, Run the day from start to end',
    ],
    'guarantee.promise': [
      'If the food isn’t hot when it’s served, that course is free',
      'If we’re late, you get 20% back',
    ],
    'price.amount': ['From $45 a guest', '$2,500 for the day'],
    proof: [
      'Fed 140 guests in 25 minutes at the Patel wedding',
      'Booked by the same 30 offices every December',
    ],
  },
  'Rentals & equipment': {
    'who.work': ['Contractors', 'People planning a party'],
    'who.slice': ['running 2 or more jobs at once', 'with 50 to 200 guests'],
    'who.problem': [
      'The rental shows up late and the crew stands around',
      'They don’t know what they need or how much',
    ],
    'outcome.result': [
      'Equipment on site when the crew arrives',
      'Everything set up before guests come',
    ],
    'timeframe.typical': ['Next-day delivery', 'Set up the day before'],
    'method.steps': [
      'Tell us the job, We pick what you need, Deliver, Pick up',
      'Plan the space, Deliver, Set up, Take down',
    ],
    'guarantee.promise': [
      'Late delivery means the day is free',
      'If anything’s missing, it’s on us',
    ],
    'price.amount': ['From $150 a day', '$12 a chair, set up included'],
    proof: [
      'Delivered to 300 job sites last year, 98% on time',
      'Set up 40 backyard parties this summer',
    ],
  },
  'Professional services': {
    'who.work': ['Marketing agencies', 'Small businesses with 5 to 50 staff'],
    'who.slice': ['stuck growing from referrals', 'where the owner still does all the sales'],
    'who.problem': [
      'No steady way to find new clients, so some months are empty',
      'The owner is the bottleneck and can’t step away',
    ],
    'outcome.result': ['10 to 20 booked sales calls a month', '3 new clients in 90 days'],
    'timeframe.typical': ['Within 60 days', 'First results in 30 days'],
    'method.steps': [
      'Pick the niche, Build the offer, Set up outreach, Send daily, Train on the calls',
      'Audit what you have, Build the system, Hire and train help, Improve every week',
    ],
    'guarantee.promise': [
      'We work free until you get 5 booked calls a month',
      'Pay nothing until your first client signs',
    ],
    'price.amount': ['$2,000 a month', '$1,500 a month plus $200 a booked call'],
    proof: [
      'Booked a 12-person agency 31 calls in its first 60 days',
      'Took an IT firm from 2 to 9 new clients a quarter',
    ],
  },
  Retail: {
    'who.work': ['Local shoppers', 'Online shoppers'],
    'who.slice': ['looking for a gift under $50', 'who care where things are made'],
    'who.problem': [
      'They don’t know what to buy and run out of time',
      'Everything online feels the same and cheap',
    ],
    'outcome.result': ['A gift they’re proud to give', 'Something made to last'],
    'timeframe.typical': ['Ready the same day', 'At your door in 3 days'],
    'method.steps': [
      'Tell us who it’s for, We pick 3, Wrapped and ready',
      'Order online, Made by hand, Shipped in 3 days',
    ],
    'guarantee.promise': ['Free returns for 60 days', 'Love it or swap it free'],
    'price.amount': ['From $25', '$49 with free shipping'],
    proof: ['Wrapped 1,200 gifts last December', '4.9 stars from 800 reviews'],
  },
  Community: {
    'who.work': ['Families new to town', 'Local business owners'],
    'who.slice': ['looking for a place to belong', 'who want to give back'],
    'who.problem': [
      'They don’t know anyone here yet',
      'They want to help but don’t know where it counts',
    ],
    'outcome.result': ['Real friends in a month', '100 kids fed every week'],
    'timeframe.typical': ['From the first visit', 'Every week'],
    'method.steps': [
      'Come once, Meet a small group, Join a team',
      'Give once, See where it went, Get a monthly update',
    ],
    'guarantee.promise': [
      'If it’s not for you, no pressure, ever',
      'Every dollar goes to the kids, and we show you how',
    ],
    'price.amount': ['Free', '$25 a month feeds a child'],
    proof: ['40 new families joined last year', '12,000 meals served in 2025'],
  },
  'Something else': null,
};

export interface OfferExamples {
  /** What each box offers to model, for this line of work, then for any business. */
  readonly examples: Readonly<Partial<Record<ExamplePath, readonly string[]>>>;
  /** Whether they're written for the business's own line of work; false offers the AI's too. */
  readonly ownLineOfWork: boolean;
  /** The group they're from ("Home services & trades"), or null. */
  readonly group: IndustryGroupName | null;
}

/** The examples for a business, from its line of work (`workspaces.industry`). */
export function offerExamples(industry: string | null | undefined): OfferExamples {
  const group = INDUSTRIES.find((i) => i.id === industry)?.group ?? null;
  const own = group ? BY_GROUP[group] : null;
  const examples: Partial<Record<ExamplePath, readonly string[]>> = {};
  for (const path of EXAMPLE_PATHS) {
    const list = own?.[path] ?? ANY_BUSINESS[path];
    if (list?.length) examples[path] = list;
  }
  return { examples, ownLineOfWork: own !== null, group: own ? group : null };
}
