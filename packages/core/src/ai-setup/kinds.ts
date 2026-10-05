/**
 * Quick setup's kinds of business (HANDSFREEOS_AI_QUICK_SETUP_IMPLEMENTATION_PLAN.md §3). A kind decides what quick
 * setup picks for a business before it answers: the jobs it ticks on top of the Getting started goal, the yes/no
 * quick facts it asks, the qualifying questions it starts from when the website gives none, how it asks where the
 * business works, and its tone. The kind comes from the workspace's industry, so there is nothing to store.
 * Browser-safe.
 */
import type { QualifyingQuestionInput } from '../ai-team/config';
import { isHomeServices } from '../industries';

export const SETUP_KINDS = [
  'home',
  'salon',
  'office',
  'real_estate',
  'insurance',
  'other',
] as const;
export type SetupKind = (typeof SETUP_KINDS)[number];

/** The jobs on "What should Ava help with?", in the order they're shown. */
export const SETUP_JOBS = ['reply', 'answer', 'book', 'qualify', 'follow_up'] as const;
export type SetupJob = (typeof SETUP_JOBS)[number];

/** How Ava sounds, as the business profile's tone of voice. */
export const SETUP_TONES = ['friendly', 'professional', 'short'] as const;
export type SetupTone = (typeof SETUP_TONES)[number];

/** Seen by appointment, at the business's place. */
const SALON = new Set([
  'hair_salon',
  'barbershop',
  'nail_salon',
  'spa',
  'lashes_brows',
  'massage',
  'tattoo',
  'med_spa',
  'pet_grooming',
]);

/** Offices that see patients: they're asked about new patients and insurance. */
export const HEALTH_OFFICES: ReadonlySet<string> = new Set([
  'dental',
  'medical_practice',
  'chiropractic',
  'physical_therapy',
  'mental_health',
  'eye_care',
  'wellness',
]);

/** Practices and firms that see clients by appointment, in person or online. */
const OFFICE = new Set([
  ...HEALTH_OFFICES,
  'veterinary',
  'accounting',
  'law_firm',
  'financial_advising',
  'mortgage',
  'title_escrow',
  'consulting',
  'marketing_agency',
  'it_services',
  'staffing',
]);

/** The kind of business an industry id is; anything the lists don't name, or none, is `other`. */
export function setupKindOf(industry: string | null | undefined): SetupKind {
  if (!industry) return 'other';
  if (industry === 'real_estate') return 'real_estate';
  if (industry === 'insurance') return 'insurance';
  if (SALON.has(industry)) return 'salon';
  if (OFFICE.has(industry)) return 'office';
  return isHomeServices(industry) ? 'home' : 'other';
}

/**
 * A yes/no question that becomes a fact Ava can use. A No is kept too ("We don’t offer financing."), so Ava never
 * guesses; `no: null` keeps nothing, for a question whose No isn't worth telling customers.
 */
export interface QuickFact {
  /** Stable: answers are kept by it. */
  readonly key: string;
  /** What the owner is asked. */
  readonly question: string;
  /** The knowledge fact's title. Quick setup finds its fact again by it, so it never changes once shipped. */
  readonly title: string;
  readonly yes: string;
  readonly no: string | null;
  /** Only these industries are asked it. */
  readonly onlyFor?: ReadonlySet<string>;
  /** Not these. */
  readonly notFor?: ReadonlySet<string>;
}

const fact = (
  key: string,
  question: string,
  title: string,
  yes: string,
  no: string | null,
  only?: { onlyFor?: ReadonlySet<string>; notFor?: ReadonlySet<string> },
): QuickFact => ({ key, question, title, yes, no, ...only });

const GIFT_CARDS = fact(
  'gift_cards',
  'Do you sell gift cards?',
  'Gift cards',
  'We sell gift cards.',
  'We don’t sell gift cards.',
);
const PAYMENT_PLANS = fact(
  'payment_plans',
  'Do you offer payment plans or financing?',
  'Payment plans',
  'We offer payment plans.',
  'We don’t offer payment plans.',
);
const SPANISH = fact(
  'spanish',
  'Does someone on your team speak Spanish?',
  'Spanish',
  'Someone on our team speaks Spanish.',
  null,
);

/** What quick setup knows about each kind. */
export interface SetupKindInfo {
  readonly kind: SetupKind;
  /** Ticked on top of the goal's jobs. */
  readonly adds: readonly SetupJob[];
  readonly tone: SetupTone;
  /** Asked in this order; every kind ends with Spanish. */
  readonly facts: readonly QuickFact[];
  /** Where it starts when Ava can't suggest qualifying questions from the website. */
  readonly questions: readonly QualifyingQuestionInput[];
  /** "Where do you work?", in this kind's words, with an example. */
  readonly area: { readonly question: string; readonly example: string };
  /** Topics that always go to a person, on top of the built-in ones. */
  readonly sensitiveTopics: readonly string[];
}

// Qualifying questions are read by the model, which writes the texts: no contractions, so no apostrophes reach a
// text and send it in the slower encoding. None asks about who someone is (family, children, schools, safety,
// religion, age, health): `PROTECTED_WORDS` checks.

const HOME_QUESTIONS: QualifyingQuestionInput[] = [
  {
    id: 'need',
    question: 'What do you need help with?',
    kind: 'choice',
    options: ['Repair', 'Maintenance', 'New installation', 'Something else'],
  },
  {
    id: 'timeline',
    question: 'How soon do you need it done?',
    kind: 'choice',
    options: ['Today or tomorrow', 'This week', 'This month', 'Just planning'],
  },
  { id: 'owner', question: 'Do you own the home?', kind: 'yes_no' },
  { id: 'zip', question: 'What ZIP code is the job in?', kind: 'text' },
];

const GENERAL_QUESTIONS: QualifyingQuestionInput[] = [
  { id: 'need', question: 'What can we help you with?', kind: 'text' },
  {
    id: 'timeline',
    question: 'When are you hoping to get started?',
    kind: 'choice',
    options: ['As soon as possible', 'In the next month', 'Just looking'],
  },
  { id: 'budget', question: 'Do you have a budget in mind?', kind: 'text', required: false },
];

export const SETUP_KIND_INFO: Readonly<Record<SetupKind, SetupKindInfo>> = {
  home: {
    kind: 'home',
    adds: [],
    tone: 'friendly',
    facts: [
      fact(
        'free_estimates',
        'Do you give free estimates?',
        'Free estimates',
        'We give free estimates.',
        'We don’t give free estimates.',
      ),
      fact(
        'financing',
        'Do you offer financing?',
        'Financing',
        'We offer financing.',
        'We don’t offer financing.',
      ),
      fact(
        'emergency',
        'Do you take emergency calls?',
        'Emergency service',
        'We take emergency calls.',
        'We don’t take emergency calls.',
      ),
      fact(
        'warranty',
        'Does your work come with a warranty?',
        'Warranty',
        'Our work comes with a warranty.',
        'Our work doesn’t come with a warranty.',
      ),
      fact(
        'licensed',
        'Are you licensed and insured?',
        'Licensed and insured',
        'We’re licensed and insured.',
        null,
      ),
      fact(
        'same_day',
        'Can you often come the same day?',
        'Same-day service',
        'We can often come the same day.',
        'We usually can’t come the same day.',
      ),
      SPANISH,
    ],
    questions: HOME_QUESTIONS,
    area: {
      question: 'Which cities or ZIP codes do you serve?',
      example: 'Katy, Cypress, 77494, 77433',
    },
    sensitiveTopics: [],
  },
  salon: {
    kind: 'salon',
    adds: ['book'],
    tone: 'friendly',
    facts: [
      fact(
        'walk_ins',
        'Do you take walk-ins?',
        'Walk-ins',
        'We take walk-ins.',
        'We’re by appointment only.',
      ),
      fact(
        'deposit',
        'Do you take a deposit to book?',
        'Booking deposit',
        'We take a deposit to book.',
        'We don’t take a deposit to book.',
      ),
      fact(
        'late_cancel',
        'Do you charge for late cancellations or no-shows?',
        'Late cancellations',
        'We charge for late cancellations and no-shows.',
        'We don’t charge for late cancellations.',
      ),
      GIFT_CARDS,
      fact(
        'free_consultations',
        'Do you offer free consultations?',
        'Free consultations',
        'We offer free consultations.',
        'We don’t offer free consultations.',
      ),
      fact('parking', 'Is there free parking?', 'Parking', 'There’s free parking.', null),
      SPANISH,
    ],
    questions: [
      { id: 'service', question: 'Which service are you interested in?', kind: 'text' },
      {
        id: 'when',
        question: 'What day and time work best for you?',
        kind: 'choice',
        options: ['Weekday morning', 'Weekday afternoon', 'Weekday evening', 'Weekend'],
      },
      { id: 'first_visit', question: 'Is this your first visit with us?', kind: 'yes_no' },
      {
        id: 'who',
        question: 'Is there someone on our team you would like to see?',
        kind: 'text',
        required: false,
      },
    ],
    area: { question: 'Where do customers find you?', example: '123 Main St, Austin' },
    sensitiveTopics: [],
  },
  office: {
    kind: 'office',
    adds: ['book'],
    tone: 'professional',
    facts: [
      fact(
        'new_patients',
        'Are you taking new patients?',
        'New patients',
        'We’re taking new patients.',
        'We’re not taking new patients right now.',
        { onlyFor: HEALTH_OFFICES },
      ),
      fact(
        'new_clients',
        'Are you taking new clients?',
        'New clients',
        'We’re taking new clients.',
        'We’re not taking new clients right now.',
        { notFor: HEALTH_OFFICES },
      ),
      fact(
        'free_consultation',
        'Is the first consultation free?',
        'Free first consultation',
        'The first consultation is free.',
        'We charge for the first consultation.',
      ),
      fact(
        'video',
        'Do you offer video appointments?',
        'Video appointments',
        'We offer video appointments.',
        'We meet in person only.',
      ),
      PAYMENT_PLANS,
      fact(
        'takes_insurance',
        'Do you take insurance?',
        'Insurance',
        'We take insurance.',
        'We don’t take insurance.',
        { onlyFor: HEALTH_OFFICES },
      ),
      SPANISH,
    ],
    questions: [
      { id: 'need', question: 'What can we help you with?', kind: 'text' },
      { id: 'returning', question: 'Have you been to us before?', kind: 'yes_no' },
      {
        id: 'when',
        question: 'When would you like to come in?',
        kind: 'choice',
        options: ['This week', 'Next week', 'Later on', 'Just asking'],
      },
    ],
    area: {
      question: 'Where are you, or do you meet online?',
      example: '500 Oak Ave, Suite 2, Plano',
    },
    sensitiveTopics: [],
  },
  real_estate: {
    kind: 'real_estate',
    adds: ['qualify'],
    tone: 'professional',
    facts: [
      fact(
        'buyers',
        'Do you help buyers?',
        'Buyers',
        'We help buyers.',
        'We don’t work with buyers.',
      ),
      fact(
        'sellers',
        'Do you help sellers?',
        'Sellers',
        'We help sellers.',
        'We don’t work with sellers.',
      ),
      fact(
        'home_value',
        'Do you give free home value estimates?',
        'Home value estimates',
        'We give free home value estimates.',
        'We don’t give free home value estimates.',
      ),
      fact(
        'rentals',
        'Do you help with rentals?',
        'Rentals',
        'We help people rent homes.',
        'We don’t handle rentals.',
      ),
      fact(
        'first_time',
        'Do you work with first-time buyers?',
        'First-time buyers',
        'We work with first-time buyers.',
        null,
      ),
      fact(
        'investors',
        'Do you work with investors?',
        'Investors',
        'We work with investors.',
        null,
      ),
      fact(
        'relocation',
        'Do you help people moving from out of town?',
        'Moving from out of town',
        'We help people moving from out of town.',
        null,
      ),
      SPANISH,
    ],
    questions: [
      {
        id: 'goal',
        question: 'Are you looking to buy, sell or rent?',
        kind: 'choice',
        options: ['Buy', 'Sell', 'Buy and sell', 'Rent'],
      },
      {
        id: 'timeline',
        question: 'When are you hoping to move?',
        kind: 'choice',
        options: ['In the next 3 months', 'In 3 to 6 months', 'In 6 to 12 months', 'Just looking'],
      },
      { id: 'area', question: 'Which area are you interested in?', kind: 'text' },
      {
        id: 'price',
        question: 'What price range are you thinking about?',
        kind: 'text',
        required: false,
      },
      {
        id: 'preapproved',
        question: 'If you are buying, are you pre-approved for a mortgage?',
        kind: 'yes_no',
        required: false,
      },
      {
        id: 'agent',
        question: 'Are you already working with a real estate agent?',
        kind: 'yes_no',
      },
    ],
    area: {
      question: 'Which areas do you cover?',
      example: 'North Austin, Round Rock, Cedar Park',
    },
    sensitiveTopics: [],
  },
  insurance: {
    kind: 'insurance',
    adds: ['qualify'],
    tone: 'professional',
    facts: [
      fact(
        'auto',
        'Do you sell auto insurance?',
        'Auto insurance',
        'We sell auto insurance.',
        'We don’t sell auto insurance.',
      ),
      fact(
        'home',
        'Do you sell home insurance?',
        'Home insurance',
        'We sell home insurance.',
        'We don’t sell home insurance.',
      ),
      fact(
        'life',
        'Do you sell life insurance?',
        'Life insurance',
        'We sell life insurance.',
        'We don’t sell life insurance.',
      ),
      fact(
        'business',
        'Do you sell business insurance?',
        'Business insurance',
        'We sell business insurance.',
        'We don’t sell business insurance.',
      ),
      fact(
        'several_companies',
        'Do you compare quotes from several insurance companies?',
        'Insurance companies',
        'We compare quotes from several insurance companies.',
        'We work with one insurance company.',
      ),
      fact('free_quotes', 'Are your quotes free?', 'Free quotes', 'Our quotes are free.', null),
      SPANISH,
    ],
    questions: [
      {
        id: 'type',
        question: 'Which kind of insurance are you looking for?',
        kind: 'choice',
        options: ['Auto', 'Home or renters', 'Life', 'Business', 'Something else'],
      },
      { id: 'current', question: 'Who insures you now?', kind: 'text', required: false },
      {
        id: 'renewal',
        question: 'When does your current policy renew?',
        kind: 'text',
        required: false,
      },
      { id: 'zip', question: 'What is your ZIP code?', kind: 'text' },
    ],
    area: { question: 'Which states are you licensed in?', example: 'Texas and Oklahoma' },
    // Whether something is covered, and claims, are for a licensed agent to answer.
    sensitiveTopics: ['Insurance claims', 'What a policy covers'],
  },
  other: {
    kind: 'other',
    adds: [],
    tone: 'friendly',
    facts: [
      fact(
        'free_quotes',
        'Are your quotes free?',
        'Free quotes',
        'Our quotes are free.',
        'We charge for quotes.',
      ),
      PAYMENT_PLANS,
      fact('guarantee', 'Do you guarantee your work?', 'Guarantee', 'We guarantee our work.', null),
      GIFT_CARDS,
      SPANISH,
    ],
    questions: GENERAL_QUESTIONS,
    area: {
      question: 'Where do you work, or where can customers find you?',
      example: 'Dallas and nearby',
    },
    sensitiveTopics: [],
  },
};

/** The quick facts an industry is asked, in order. */
export function quickFactsFor(industry: string | null | undefined): QuickFact[] {
  const id = industry ?? '';
  return SETUP_KIND_INFO[setupKindOf(industry)].facts.filter(
    (f) => (!f.onlyFor || f.onlyFor.has(id)) && !f.notFor?.has(id),
  );
}

/**
 * Words a qualifying question must never use: asking about who someone is, rather than what they need, can break
 * fair housing and fair lending rules, and isn't a business's to ask. Checked on the starter questions and on the
 * ones Ava suggests from a website. Whole words, any case.
 */
export const PROTECTED_WORDS = [
  'baby',
  'children',
  'church',
  'disability',
  'disabled',
  'ethnicity',
  'family',
  'gender',
  'handicap',
  'how old are you',
  'kids',
  'married',
  'national origin',
  'neighborhood safety',
  'pregnant',
  'race',
  'religion',
  'religious',
  'safe area',
  'safe neighborhood',
  'safety',
  'school',
  'schools',
  'sex',
  'wheelchair',
  'your age',
] as const;

const protectedPattern = new RegExp(
  `\\b(${PROTECTED_WORDS.map((w) => w.replace(/ /g, '\\s+')).join('|')})\\b`,
  'i',
);

/** Whether a question asks about who someone is (see `PROTECTED_WORDS`). */
export function asksAboutWhoSomeoneIs(text: string): boolean {
  return protectedPattern.test(text);
}
