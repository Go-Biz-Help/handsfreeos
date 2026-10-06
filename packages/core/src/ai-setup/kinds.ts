/**
 * Quick setup's kinds of business (HANDSFREEOS_AI_QUICK_SETUP_IMPLEMENTATION_PLAN.md §3). A kind decides what quick
 * setup picks for a business before it answers: the jobs it ticks on top of the Getting started goal, the yes/no
 * quick facts it asks, the qualifying questions it starts from when the website gives none, how it asks where the
 * business works, the test chat's first questions, the booking calendar it makes, and its tone. Nineteen kinds cover
 * every industry in the list (`INDUSTRIES`); an industry that differs from the rest of its kind (childcare among
 * lessons) says how. The kind comes from the workspace's industry, so there is nothing to store. Browser-safe.
 */
import type { QualifyingQuestionInput } from '../ai-team/config';
import { isHomeServices, type IndustryId } from '../industries';

export const SETUP_KINDS = [
  'home',
  'salon',
  'fitness',
  'health',
  'pets',
  'auto',
  'lessons',
  'real_estate',
  'property',
  'insurance',
  'legal_money',
  'professional',
  'events',
  'food',
  'stays',
  'rentals',
  'retail',
  'community',
  'other',
] as const;
export type SetupKind = (typeof SETUP_KINDS)[number];

/** The jobs on "What should Ava help with?", in the order they're shown. */
export const SETUP_JOBS = ['reply', 'answer', 'book', 'qualify', 'follow_up'] as const;
export type SetupJob = (typeof SETUP_JOBS)[number];

/** How Ava sounds, as the business profile's tone of voice. */
export const SETUP_TONES = ['friendly', 'professional', 'short'] as const;
export type SetupTone = (typeof SETUP_TONES)[number];

/**
 * The industries of each kind. Home services are the industry list's Home services group; anything else the lists
 * don't name, or none, is `other`.
 */
const KIND_INDUSTRIES: Readonly<
  Record<Exclude<SetupKind, 'home' | 'other'>, readonly IndustryId[]>
> = {
  salon: [
    'hair_salon',
    'barbershop',
    'nail_salon',
    'spa',
    'lashes_brows',
    'massage',
    'tattoo',
    'med_spa',
  ],
  fitness: ['gym', 'personal_training', 'martial_arts', 'dance_studio'],
  health: [
    'dental',
    'medical_practice',
    'chiropractic',
    'physical_therapy',
    'mental_health',
    'eye_care',
    'home_care',
    'wellness',
  ],
  pets: ['pet_grooming', 'veterinary', 'dog_training', 'pet_sitting', 'pet_boarding'],
  auto: [
    'auto_repair',
    'auto_body',
    'auto_detailing',
    'towing',
    'auto_glass',
    'car_dealership',
    'boat_rv',
  ],
  lessons: ['tutoring', 'childcare', 'music_lessons', 'driving_school', 'school_training'],
  real_estate: ['real_estate'],
  property: ['property_management'],
  insurance: ['insurance'],
  legal_money: ['accounting', 'law_firm', 'financial_advising', 'mortgage', 'title_escrow'],
  professional: [
    'marketing_agency',
    'consulting',
    'it_services',
    'staffing',
    'printing_signs',
    'courier',
    'security_services',
  ],
  events: ['event_planning', 'event_venue', 'photography', 'entertainment', 'florist'],
  food: ['restaurant', 'catering', 'food_truck', 'bakery'],
  stays: ['lodging', 'travel', 'vacation_rentals'],
  rentals: [
    'equipment_rental',
    'party_rentals',
    'dumpster_rental',
    'self_storage',
    'portable_toilets',
  ],
  retail: ['retail_store', 'online_store'],
  community: ['nonprofit', 'church'],
};

const kindOfIndustry = new Map<string, SetupKind>(
  Object.entries(KIND_INDUSTRIES).flatMap(([kind, ids]) =>
    ids.map((id) => [id, kind as SetupKind] as const),
  ),
);

/** The kind of business an industry id is; anything the lists don't name, or none, is `other`. */
export function setupKindOf(industry: string | null | undefined): SetupKind {
  if (!industry) return 'other';
  return kindOfIndustry.get(industry) ?? (isHomeServices(industry) ? 'home' : 'other');
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
  who?: { onlyFor?: ReadonlySet<string>; notFor?: ReadonlySet<string> },
): QuickFact => ({ key, question, title, yes, no, ...who });

/** A set of industries, for `onlyFor` and `notFor`. */
const only = (...ids: IndustryId[]): ReadonlySet<string> => new Set(ids);

const FREE_ESTIMATES = fact(
  'free_estimates',
  'Do you give free estimates?',
  'Free estimates',
  'We give free estimates.',
  'We don’t give free estimates.',
);
const FINANCING = fact(
  'financing',
  'Do you offer financing?',
  'Financing',
  'We offer financing.',
  'We don’t offer financing.',
);
const WARRANTY = fact(
  'warranty',
  'Does your work come with a warranty?',
  'Warranty',
  'Our work comes with a warranty.',
  'Our work doesn’t come with a warranty.',
);
const GUARANTEE = fact(
  'guarantee',
  'Do you guarantee your work?',
  'Guarantee',
  'We guarantee our work.',
  null,
);
const NEW_CLIENTS = fact(
  'new_clients',
  'Are you taking new clients?',
  'New clients',
  'We’re taking new clients.',
  'We’re not taking new clients right now.',
);
const FREE_CONSULTATION = fact(
  'free_consultation',
  'Is the first consultation free?',
  'Free first consultation',
  'The first consultation is free.',
  'We charge for the first consultation.',
);
const VIDEO_MEETINGS = fact(
  'video',
  'Do you meet by video?',
  'Video meetings',
  'We meet by video too.',
  'We meet in person only.',
);
const DELIVERY = fact(
  'delivery',
  'Do you deliver?',
  'Delivery',
  'We deliver.',
  'We don’t deliver.',
);
/** Fair housing: an assistance animal isn't a pet, so a No says they're welcome. */
const PETS = fact(
  'pets',
  'Do you allow pets?',
  'Pets',
  'Pets are allowed.',
  'Pets aren’t allowed. Assistance animals are always welcome.',
);
const PARKING = fact('parking', 'Is there free parking?', 'Parking', 'There’s free parking.', null);
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

/** Trades people call when something breaks: asked about emergency calls. */
const URGENT_TRADES = only(
  'home_services',
  'hvac',
  'plumbing',
  'electrical',
  'roofing',
  'tree_service',
  'garage_doors',
  'locksmith',
  'restoration',
  'appliance_repair',
  'septic',
  'windows_doors',
);
/** Work done on a schedule: asked about regular visits. */
const REGULAR_WORK = only(
  'house_cleaning',
  'commercial_cleaning',
  'window_cleaning',
  'lawn_care',
  'landscaping',
  'pest_control',
  'pool_spa',
);
/** Jobs too small to finance. */
const SMALL_JOBS = only(
  'house_cleaning',
  'commercial_cleaning',
  'carpet_cleaning',
  'window_cleaning',
  'pressure_washing',
  'lawn_care',
  'pest_control',
  'snow_removal',
  'junk_removal',
  'home_inspection',
  'locksmith',
  'chimney',
  'appliance_repair',
  'handyman',
);
/** Work that's guaranteed rather than under warranty. */
const GUARANTEED_WORK = only(
  'house_cleaning',
  'commercial_cleaning',
  'carpet_cleaning',
  'window_cleaning',
  'pressure_washing',
  'lawn_care',
  'pest_control',
  'snow_removal',
  'junk_removal',
  'moving',
  'home_inspection',
  'interior_design',
);
/** Health offices that see patients: they're asked about new patients, the rest of health about new clients. */
const PATIENT_CARE = only(
  'dental',
  'medical_practice',
  'chiropractic',
  'physical_therapy',
  'mental_health',
  'eye_care',
);
const CHILDCARE = only('childcare');
const STORAGE = only('self_storage');

/** The test chat's first questions, in a kind's words. */
export interface SetupKindTests {
  /** Where it works, asked when there's an answer; `{place}` is the first place in it. */
  readonly where: string;
  /** When Ava books. */
  readonly book: string;
  /** When Ava asks qualifying questions and doesn't book. */
  readonly qualify: string;
}

/** What an industry does differently from the rest of its kind: childcare isn't lessons. */
export interface SetupIndustryInfo {
  readonly questions?: readonly QualifyingQuestionInput[];
  readonly area?: SetupKindInfo['area'];
  readonly tests?: Partial<SetupKindTests>;
  readonly calendar?: string;
}

/** What quick setup knows about each kind. */
export interface SetupKindInfo {
  readonly kind: SetupKind;
  /** Ticked on top of the goal's jobs. */
  readonly adds: readonly SetupJob[];
  readonly tone: SetupTone;
  /** Asked in this order, those that fit the industry (`quickFactsFor`); every kind ends with Spanish. */
  readonly facts: readonly QuickFact[];
  /** Where it starts when Ava can't suggest qualifying questions from the website. */
  readonly questions: readonly QualifyingQuestionInput[];
  /** "Where do you work?", in this kind's words, with an example. */
  readonly area: { readonly question: string; readonly example: string };
  readonly tests: SetupKindTests;
  /** The booking calendar quick setup makes when Ava books and there isn't one customers can book. */
  readonly calendar: string;
  /** Topics that always go to a person, on top of the built-in ones. */
  readonly sensitiveTopics: readonly string[];
  /**
   * What its qualifying questions may ask though it's about who someone is (`PROTECTED_WORDS`): a school asks about
   * the child it teaches. The words they may use, and what the model reading the website is told.
   */
  readonly mayAsk?: { readonly words: readonly string[]; readonly note: string };
  readonly industries?: Readonly<Partial<Record<IndustryId, SetupIndustryInfo>>>;
}

// Qualifying questions are read by the model, which writes the texts: no contractions, so no apostrophes reach a
// text and send it in the slower encoding. None asks about who someone is (family, children, schools, safety,
// religion, age, health) unless its kind may (`mayAsk`): `PROTECTED_WORDS` checks.

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

const BUDGET: QualifyingQuestionInput = {
  id: 'budget',
  question: 'Do you have a budget in mind?',
  kind: 'text',
  required: false,
};

const EVENT_QUESTIONS: QualifyingQuestionInput[] = [
  {
    id: 'event',
    question: 'What kind of event is it?',
    kind: 'choice',
    options: ['Wedding', 'Birthday or party', 'Business event', 'Something else'],
  },
  { id: 'date', question: 'What date is the event?', kind: 'text' },
  { id: 'guests', question: 'About how many guests?', kind: 'text' },
  { id: 'where', question: 'Where is it?', kind: 'text', required: false },
  BUDGET,
];

const START: QualifyingQuestionInput = {
  id: 'start',
  question: 'When would you like to start?',
  kind: 'choice',
  options: ['This week', 'In the next few weeks', 'Just looking'],
};

const LOCATED = 'Where are you located?';
const APPOINTMENT = 'Can I book an appointment for next week?';
const CONSULTATION = 'Can I book a consultation for next week?';
const HELP = 'I need some help. Can you help me?';

export const SETUP_KIND_INFO: Readonly<Record<SetupKind, SetupKindInfo>> = {
  home: {
    kind: 'home',
    adds: [],
    tone: 'friendly',
    facts: [
      FREE_ESTIMATES,
      { ...FINANCING, notFor: SMALL_JOBS },
      fact(
        'emergency',
        'Do you take emergency calls?',
        'Emergency service',
        'We take emergency calls.',
        'We don’t take emergency calls.',
        { onlyFor: URGENT_TRADES },
      ),
      fact(
        'regular_visits',
        'Do you offer regular visits, like weekly or monthly?',
        'Regular visits',
        'We offer regular weekly or monthly visits.',
        null,
        { onlyFor: REGULAR_WORK },
      ),
      { ...WARRANTY, notFor: GUARANTEED_WORK },
      { ...GUARANTEE, onlyFor: GUARANTEED_WORK },
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
    tests: {
      where: 'Do you serve {place}?',
      book: 'Can someone come out next week?',
      qualify: HELP,
    },
    calendar: 'Service calls',
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
      PARKING,
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
    tests: { where: LOCATED, book: APPOINTMENT, qualify: HELP },
    calendar: 'Appointments',
    sensitiveTopics: [],
  },
  fitness: {
    kind: 'fitness',
    adds: ['book'],
    tone: 'friendly',
    facts: [
      fact(
        'free_trial',
        'Is the first class or session free?',
        'Free first class',
        'The first class or session is free.',
        'We don’t offer a free first class.',
      ),
      fact(
        'drop_ins',
        'Can people drop in without a membership?',
        'Drop-ins',
        'You can drop in without a membership.',
        'Classes are for members only.',
        { notFor: only('personal_training') },
      ),
      fact(
        'no_contract',
        'Can people join without a long contract?',
        'No long contract',
        'You can join without a long contract.',
        null,
      ),
      fact(
        'personal_training',
        'Do you offer personal training?',
        'Personal training',
        'We offer personal training.',
        'We don’t offer personal training.',
        { notFor: only('personal_training') },
      ),
      fact(
        'kids_classes',
        'Do you have classes for kids?',
        'Classes for kids',
        'We have classes for kids.',
        'We don’t have classes for kids.',
      ),
      fact('open_24', 'Are you open 24 hours?', 'Open 24 hours', 'We’re open 24 hours.', null, {
        onlyFor: only('gym'),
      }),
      SPANISH,
    ],
    questions: [
      { id: 'goal', question: 'What would you like to work on?', kind: 'text' },
      { id: 'before', question: 'Have you trained with us before?', kind: 'yes_no' },
      {
        id: 'times',
        question: 'What times work best for you?',
        kind: 'choice',
        options: ['Mornings', 'Afternoons', 'Evenings', 'Weekends'],
      },
      START,
    ],
    area: { question: 'Where do customers find you?', example: '400 Elm St, Round Rock' },
    tests: {
      where: LOCATED,
      book: 'Can I book a class next week?',
      qualify: 'I’d like to get in shape. Can you help?',
    },
    calendar: 'Sessions',
    sensitiveTopics: [],
  },
  health: {
    kind: 'health',
    adds: ['book'],
    tone: 'professional',
    facts: [
      fact(
        'new_patients',
        'Are you taking new patients?',
        'New patients',
        'We’re taking new patients.',
        'We’re not taking new patients right now.',
        { onlyFor: PATIENT_CARE },
      ),
      { ...NEW_CLIENTS, notFor: PATIENT_CARE },
      fact(
        'takes_insurance',
        'Do you take insurance?',
        'Insurance',
        'We take insurance.',
        'We don’t take insurance.',
      ),
      fact(
        'video',
        'Do you offer video visits?',
        'Video visits',
        'We offer video visits.',
        'We see people in person only.',
        { notFor: only('dental', 'home_care') },
      ),
      PAYMENT_PLANS,
      fact(
        'seen_soon',
        'Can new patients usually be seen within a week?',
        'Seen within a week',
        'New patients can usually be seen within a week.',
        null,
        { onlyFor: PATIENT_CARE },
      ),
      fact(
        'emergencies',
        'Do you see emergencies the same day?',
        'Same-day emergencies',
        'We see emergencies the same day.',
        'We don’t see emergencies the same day.',
        { onlyFor: only('dental', 'eye_care') },
      ),
      fact(
        'assessment',
        'Do you offer a free in-home assessment?',
        'Free in-home assessment',
        'We offer a free in-home assessment.',
        'We don’t offer a free in-home assessment.',
        { onlyFor: only('home_care') },
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
      question: 'Where are you, or do you see people online?',
      example: '500 Oak Ave, Suite 2, Plano',
    },
    tests: { where: LOCATED, book: APPOINTMENT, qualify: HELP },
    calendar: 'Appointments',
    // What a medication does, and what a test showed, are for a clinician to answer.
    sensitiveTopics: ['Medication questions', 'Test results'],
    industries: {
      home_care: {
        questions: [
          {
            id: 'care',
            question: 'What kind of care are you looking for?',
            kind: 'choice',
            options: ['Help around the home', 'Personal care', 'Companionship', 'Something else'],
          },
          {
            id: 'start',
            question: 'When would care need to start?',
            kind: 'choice',
            options: ['Right away', 'In the next few weeks', 'Just planning'],
          },
          {
            id: 'hours',
            question: 'About how many hours a week?',
            kind: 'text',
            required: false,
          },
        ],
        area: { question: 'Which areas do you cover?', example: 'Plano, Allen and McKinney' },
        tests: {
          where: 'Do you cover {place}?',
          book: 'Can someone visit next week?',
          qualify: 'I’m looking for care at home. Can you help?',
        },
      },
    },
  },
  pets: {
    kind: 'pets',
    adds: ['book'],
    tone: 'friendly',
    facts: [
      NEW_CLIENTS,
      fact(
        'cats',
        'Do you work with cats too?',
        'Cats',
        'We work with cats too.',
        'We work with dogs only.',
        { notFor: only('dog_training') },
      ),
      fact(
        'vaccinations',
        'Do pets need to be up to date on their vaccinations?',
        'Vaccinations',
        'Pets need to be up to date on their vaccinations.',
        null,
        { notFor: only('veterinary') },
      ),
      fact(
        'pickup',
        'Do you offer pick-up and drop-off?',
        'Pick-up and drop-off',
        'We offer pick-up and drop-off.',
        'We don’t offer pick-up and drop-off.',
        { notFor: only('pet_sitting', 'veterinary') },
      ),
      fact(
        'comes_to_you',
        'Do you come to the customer?',
        'We come to you',
        'We come to you.',
        'Customers come to us.',
        { onlyFor: only('pet_grooming', 'dog_training') },
      ),
      fact(
        'meet_greet',
        'Do you offer a free meet-and-greet?',
        'Free meet-and-greet',
        'We offer a free meet-and-greet.',
        'We don’t offer a free meet-and-greet.',
        { onlyFor: only('pet_sitting', 'pet_boarding', 'dog_training') },
      ),
      fact(
        'emergencies',
        'Do you see emergencies?',
        'Emergencies',
        'We see emergencies.',
        'We don’t see emergencies. Call your nearest emergency vet.',
        { onlyFor: only('veterinary') },
      ),
      SPANISH,
    ],
    questions: [
      {
        id: 'pet',
        question: 'What kind of pet do you have?',
        kind: 'choice',
        options: ['Dog', 'Cat', 'Something else'],
      },
      {
        id: 'breed',
        question: 'What breed and size is your pet?',
        kind: 'text',
        required: false,
      },
      { id: 'service', question: 'Which service are you interested in?', kind: 'text' },
      {
        id: 'when',
        question: 'When do you need us?',
        kind: 'choice',
        options: ['This week', 'Next week', 'Later on', 'Just asking'],
      },
    ],
    area: {
      question: 'Where are you, or which areas do you cover?',
      example: '210 Pine St, Frisco, and nearby',
    },
    tests: {
      where: LOCATED,
      book: APPOINTMENT,
      qualify: 'I need help with my dog. Can you help?',
    },
    calendar: 'Appointments',
    sensitiveTopics: [],
  },
  auto: {
    kind: 'auto',
    adds: [],
    tone: 'friendly',
    facts: [
      { ...FREE_ESTIMATES, notFor: only('car_dealership', 'towing') },
      fact(
        'insurance_claims',
        'Do you work with insurance claims?',
        'Insurance claims',
        'We work with insurance claims.',
        'We don’t work with insurance claims.',
        { onlyFor: only('auto_body', 'auto_glass') },
      ),
      fact(
        'comes_to_you',
        'Do you come to the customer?',
        'We come to you',
        'We come to you.',
        'Customers come to us.',
        { onlyFor: only('auto_detailing', 'auto_glass', 'boat_rv') },
      ),
      fact(
        'loaners',
        'Do you offer rides or loaner cars?',
        'Rides and loaners',
        'We offer rides and loaner cars.',
        'We don’t offer rides or loaner cars.',
        { onlyFor: only('auto_repair', 'auto_body') },
      ),
      { ...WARRANTY, notFor: only('towing') },
      { ...FINANCING, onlyFor: only('car_dealership', 'auto_repair', 'auto_body') },
      fact(
        'around_the_clock',
        'Do you tow around the clock?',
        'Around-the-clock towing',
        'We tow around the clock.',
        'We don’t tow around the clock.',
        { onlyFor: only('towing') },
      ),
      fact(
        'roadside',
        'Do you help with jump-starts, flat tires and lockouts?',
        'Roadside help',
        'We help with jump-starts, flat tires and lockouts.',
        'We tow only.',
        { onlyFor: only('towing') },
      ),
      fact(
        'trade_ins',
        'Do you take trade-ins?',
        'Trade-ins',
        'We take trade-ins.',
        'We don’t take trade-ins.',
        { onlyFor: only('car_dealership') },
      ),
      SPANISH,
    ],
    questions: [
      { id: 'vehicle', question: 'What is the year, make and model?', kind: 'text' },
      { id: 'need', question: 'What do you need help with?', kind: 'text' },
      {
        id: 'when',
        question: 'When do you need it?',
        kind: 'choice',
        options: ['Today', 'This week', 'Just planning'],
      },
    ],
    area: {
      question: 'Where are you, or which areas do you cover?',
      example: '88 Commerce Dr, Mesa',
    },
    tests: {
      where: LOCATED,
      book: 'Can I bring my car in next week?',
      qualify: 'My car needs some work. Can you help?',
    },
    calendar: 'Appointments',
    sensitiveTopics: [],
  },
  lessons: {
    kind: 'lessons',
    adds: ['book'],
    tone: 'friendly',
    facts: [
      fact(
        'free_lesson',
        'Is the first lesson free?',
        'Free first lesson',
        'The first lesson is free.',
        'We don’t offer a free first lesson.',
        { notFor: CHILDCARE },
      ),
      fact(
        'online',
        'Do you teach online too?',
        'Online lessons',
        'We teach online too.',
        'We teach in person only.',
        { notFor: only('childcare', 'driving_school') },
      ),
      fact(
        'groups',
        'Do you offer group lessons?',
        'Group lessons',
        'We offer group lessons.',
        'We teach one on one.',
        { notFor: CHILDCARE },
      ),
      fact(
        'beginners',
        'Are beginners welcome?',
        'Beginners welcome',
        'Beginners are welcome.',
        null,
        {
          notFor: CHILDCARE,
        },
      ),
      fact(
        'openings',
        'Do you have openings now?',
        'Openings',
        'We have openings now.',
        'We have a waiting list right now.',
        { onlyFor: CHILDCARE },
      ),
      fact(
        'state_licensed',
        'Are you state licensed?',
        'State licensed',
        'We’re state licensed.',
        null,
        {
          onlyFor: CHILDCARE,
        },
      ),
      fact(
        'meals',
        'Are meals and snacks included?',
        'Meals',
        'Meals and snacks are included.',
        'Families bring meals and snacks.',
        { onlyFor: CHILDCARE },
      ),
      fact(
        'part_time',
        'Do you offer part-time care?',
        'Part-time care',
        'We offer part-time care.',
        'We offer full-time care only.',
        { onlyFor: CHILDCARE },
      ),
      SPANISH,
    ],
    questions: [
      { id: 'learn', question: 'What would you like to learn?', kind: 'text' },
      {
        id: 'student',
        question: 'Who are the lessons for?',
        kind: 'choice',
        options: ['Me', 'My child', 'Someone else'],
      },
      {
        id: 'times',
        question: 'What days and times work best?',
        kind: 'choice',
        options: ['Weekday mornings', 'Weekday afternoons', 'Weekday evenings', 'Weekends'],
      },
      START,
    ],
    area: {
      question: 'Where do you teach, or do you teach online?',
      example: 'Online, and at 12 Lake Rd, Naperville',
    },
    tests: {
      where: LOCATED,
      book: 'Can I book a lesson next week?',
      qualify: 'I’d like to start lessons. Can you help?',
    },
    calendar: 'Lessons',
    sensitiveTopics: [],
    mayAsk: {
      words: ['baby', 'children', 'kids', 'school', 'schools'],
      note: 'It teaches or cares for children, so its questions may ask a child’s age, grade or school.',
    },
    industries: {
      childcare: {
        questions: [
          { id: 'age', question: 'How old is your child?', kind: 'text' },
          {
            id: 'days',
            question: 'Which days do you need care?',
            kind: 'choice',
            options: ['Full time', 'Part time', 'Before and after school', 'A few days a week'],
          },
          {
            id: 'start',
            question: 'When would you like care to start?',
            kind: 'choice',
            options: ['Right away', 'In the next few months', 'Just planning'],
          },
        ],
        area: { question: 'Where are you?', example: '12 Lake Rd, Naperville' },
        tests: {
          book: 'Can we come for a tour next week?',
          qualify: 'I’m looking for childcare. Can you help?',
        },
        calendar: 'Tours',
      },
    },
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
    tests: {
      where: 'Do you serve {place}?',
      book: 'Can we meet next week?',
      qualify: 'I’m thinking about buying a home. Can you help?',
    },
    calendar: 'Appointments',
    sensitiveTopics: [],
  },
  property: {
    kind: 'property',
    adds: ['qualify'],
    tone: 'professional',
    facts: [
      PETS,
      fact(
        'application_fee',
        'Do you charge an application fee?',
        'Application fee',
        'We charge an application fee.',
        'We don’t charge an application fee.',
      ),
      fact(
        'utilities',
        'Are utilities included in the rent?',
        'Utilities',
        'Utilities are included in the rent.',
        'Utilities aren’t included in the rent.',
      ),
      fact(
        'online_rent',
        'Can tenants pay rent online?',
        'Pay rent online',
        'Tenants can pay rent online.',
        null,
      ),
      fact(
        'emergency_repairs',
        'Do you handle emergency repairs around the clock?',
        'Emergency repairs',
        'We handle emergency repairs around the clock.',
        null,
      ),
      fact(
        'short_term',
        'Do you offer short-term leases?',
        'Short-term leases',
        'We offer short-term leases.',
        'We don’t offer short-term leases.',
      ),
      SPANISH,
    ],
    questions: [
      {
        id: 'looking',
        question: 'What kind of place are you looking for?',
        kind: 'choice',
        options: ['Apartment', 'House', 'Townhome or condo', 'Something else'],
      },
      {
        id: 'move_in',
        question: 'When do you want to move in?',
        kind: 'choice',
        options: ['In the next month', 'In 1 to 3 months', 'Later on', 'Just looking'],
      },
      {
        id: 'lease',
        question: 'How long a lease are you looking for?',
        kind: 'choice',
        options: ['Under 6 months', '6 to 12 months', 'A year or more'],
      },
      {
        id: 'budget',
        question: 'What monthly rent are you hoping for?',
        kind: 'text',
        required: false,
      },
    ],
    area: {
      question: 'Which areas are your properties in?',
      example: 'Tempe, Chandler and Gilbert',
    },
    tests: {
      where: 'Do you have rentals in {place}?',
      book: 'Can I see a place next week?',
      qualify: 'I’m looking for a place to rent. Can you help?',
    },
    calendar: 'Showings',
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
    tests: {
      where: 'Can you insure me in {place}?',
      book: 'Can we talk next week?',
      qualify: 'I need a quote. Can you help?',
    },
    calendar: 'Appointments',
    // Whether something is covered, and claims, are for a licensed agent to answer.
    sensitiveTopics: ['Insurance claims', 'What a policy covers'],
  },
  legal_money: {
    kind: 'legal_money',
    adds: ['book'],
    tone: 'professional',
    facts: [
      NEW_CLIENTS,
      { ...FREE_CONSULTATION, notFor: only('title_escrow') },
      VIDEO_MEETINGS,
      { ...PAYMENT_PLANS, onlyFor: only('law_firm', 'accounting') },
      fact(
        'flat_fees',
        'Do you offer flat fees for some work?',
        'Flat fees',
        'We offer flat fees for some work.',
        'We don’t offer flat fees.',
        { onlyFor: only('law_firm', 'accounting') },
      ),
      fact(
        'fha_va',
        'Do you offer FHA and VA loans?',
        'FHA and VA loans',
        'We offer FHA and VA loans.',
        'We don’t offer FHA or VA loans.',
        { onlyFor: only('mortgage') },
      ),
      fact(
        'mobile_closings',
        'Do you offer mobile closings?',
        'Mobile closings',
        'We offer mobile closings.',
        'Closings are at our office.',
        { onlyFor: only('title_escrow') },
      ),
      SPANISH,
    ],
    questions: [
      { id: 'need', question: 'What can we help you with?', kind: 'text' },
      { id: 'returning', question: 'Have you worked with us before?', kind: 'yes_no' },
      {
        id: 'when',
        question: 'When do you need help?',
        kind: 'choice',
        options: ['Right away', 'In the next few weeks', 'Just planning'],
      },
    ],
    area: {
      question: 'Where are you, and which states do you work in?',
      example: 'Plano, with clients across Texas',
    },
    tests: { where: LOCATED, book: CONSULTATION, qualify: 'I need some advice. Can you help?' },
    calendar: 'Consultations',
    sensitiveTopics: [],
    industries: {
      mortgage: {
        questions: [
          {
            id: 'goal',
            question: 'Are you buying or refinancing?',
            kind: 'choice',
            options: ['Buying', 'Refinancing', 'Not sure yet'],
          },
          {
            id: 'close',
            question: 'When are you hoping to close?',
            kind: 'choice',
            options: ['In the next month', 'In 1 to 3 months', 'Later on', 'Just looking'],
          },
          {
            id: 'agent',
            question: 'Are you working with a real estate agent?',
            kind: 'yes_no',
            required: false,
          },
        ],
        tests: {
          book: 'Can we talk next week?',
          qualify: 'I’d like to get pre-approved. Can you help?',
        },
      },
    },
  },
  professional: {
    kind: 'professional',
    adds: ['book'],
    tone: 'professional',
    facts: [
      NEW_CLIENTS,
      FREE_CONSULTATION,
      VIDEO_MEETINGS,
      fact(
        'month_to_month',
        'Do you work month to month, without a long contract?',
        'Month to month',
        'We work month to month, without a long contract.',
        'We work on longer contracts.',
        { notFor: only('printing_signs', 'courier') },
      ),
      fact(
        'rush',
        'Do you take rush jobs?',
        'Rush jobs',
        'We take rush jobs.',
        'We don’t take rush jobs.',
        {
          onlyFor: only('printing_signs', 'courier'),
        },
      ),
      fact(
        'around_the_clock',
        'Do you offer around-the-clock support?',
        'Around-the-clock support',
        'We offer around-the-clock support.',
        'We don’t offer around-the-clock support.',
        { onlyFor: only('it_services', 'security_services') },
      ),
      SPANISH,
    ],
    questions: [
      { id: 'need', question: 'What does your business need help with?', kind: 'text' },
      {
        id: 'start',
        question: 'When do you want to start?',
        kind: 'choice',
        options: ['Right away', 'In the next month', 'Just looking'],
      },
      BUDGET,
    ],
    area: {
      question: 'Where are you, or do you work remotely?',
      example: 'Denver, and remote across the US',
    },
    tests: {
      where: LOCATED,
      book: CONSULTATION,
      qualify: 'My business needs some help. Can you help?',
    },
    calendar: 'Consultations',
    sensitiveTopics: [],
  },
  events: {
    kind: 'events',
    adds: ['qualify'],
    tone: 'friendly',
    facts: [
      fact(
        'deposit_date',
        'Do you take a deposit to hold a date?',
        'Deposit to hold a date',
        'We take a deposit to hold a date.',
        'We don’t take a deposit to hold a date.',
      ),
      fact('packages', 'Do you offer packages?', 'Packages', 'We offer packages.', null),
      fact(
        'weddings',
        'Do you do weddings?',
        'Weddings',
        'We do weddings.',
        'We don’t do weddings.',
      ),
      fact(
        'business_events',
        'Do you do business events?',
        'Business events',
        'We do business events.',
        'We don’t do business events.',
      ),
      PAYMENT_PLANS,
      fact(
        'travels',
        'Do you travel to events out of town?',
        'Events out of town',
        'We travel to events out of town.',
        'We work locally only.',
        { notFor: only('event_venue') },
      ),
      fact(
        'outside_catering',
        'Can people bring their own caterer?',
        'Outside catering',
        'You can bring your own caterer.',
        'We don’t allow outside catering.',
        { onlyFor: only('event_venue') },
      ),
      { ...DELIVERY, onlyFor: only('florist') },
      SPANISH,
    ],
    questions: EVENT_QUESTIONS,
    area: { question: 'Which areas do you work in?', example: 'Nashville and two hours around' },
    tests: {
      where: 'Do you work events in {place}?',
      book: CONSULTATION,
      qualify: 'I’m planning an event. Can you help?',
    },
    calendar: 'Consultations',
    sensitiveTopics: [],
    industries: {
      event_venue: {
        questions: EVENT_QUESTIONS.filter((q) => q.id !== 'where'),
        area: { question: 'Where is your venue?', example: '700 River Rd, Franklin' },
        tests: { where: LOCATED, book: 'Can I come see the venue next week?' },
        calendar: 'Tours',
      },
    },
  },
  food: {
    kind: 'food',
    adds: [],
    tone: 'friendly',
    facts: [
      fact(
        'takeout',
        'Do you offer takeout?',
        'Takeout',
        'We offer takeout.',
        'We don’t offer takeout.',
        {
          notFor: only('catering', 'food_truck'),
        },
      ),
      DELIVERY,
      fact(
        'gluten_free',
        'Do you have gluten-free options?',
        'Gluten-free options',
        'We have gluten-free options.',
        'We don’t have gluten-free options.',
      ),
      fact(
        'vegetarian',
        'Do you have vegetarian options?',
        'Vegetarian options',
        'We have vegetarian options.',
        'We don’t have vegetarian options.',
      ),
      GIFT_CARDS,
      fact(
        'reservations',
        'Do you take reservations?',
        'Reservations',
        'We take reservations.',
        'We don’t take reservations. Walk right in.',
        { onlyFor: only('restaurant') },
      ),
      fact(
        'private_events',
        'Do you host private events?',
        'Private events',
        'We host private events.',
        'We don’t host private events.',
        { onlyFor: only('restaurant') },
      ),
      fact(
        'catering',
        'Do you cater events?',
        'Catering',
        'We cater events.',
        'We don’t cater events.',
        {
          notFor: only('catering'),
        },
      ),
      fact(
        'custom_orders',
        'Do you take custom orders?',
        'Custom orders',
        'We take custom orders.',
        'We don’t take custom orders.',
        { onlyFor: only('bakery', 'catering') },
      ),
      SPANISH,
    ],
    questions: EVENT_QUESTIONS,
    area: {
      question: 'Where can customers find you, or where do you deliver?',
      example: '9 Main St, Boise, and delivery across town',
    },
    tests: {
      where: LOCATED,
      book: 'Can we talk about my event next week?',
      qualify: 'I’m planning an event and need food. Can you help?',
    },
    calendar: 'Appointments',
    sensitiveTopics: [],
    industries: {
      restaurant: { tests: { book: 'Can I book a table for Friday?' }, calendar: 'Reservations' },
    },
  },
  stays: {
    kind: 'stays',
    adds: [],
    tone: 'friendly',
    facts: [
      fact(
        'free_cancellation',
        'Do you offer free cancellation?',
        'Free cancellation',
        'We offer free cancellation.',
        'We don’t offer free cancellation.',
        { notFor: only('travel') },
      ),
      fact(
        'groups',
        'Do you take group bookings?',
        'Group bookings',
        'We take group bookings.',
        'We don’t take group bookings.',
      ),
      { ...PETS, onlyFor: only('lodging', 'vacation_rentals') },
      { ...PARKING, onlyFor: only('lodging', 'vacation_rentals') },
      fact(
        'breakfast',
        'Is breakfast included?',
        'Breakfast',
        'Breakfast is included.',
        'Breakfast isn’t included.',
        { onlyFor: only('lodging') },
      ),
      fact(
        'cruises',
        'Do you book cruises?',
        'Cruises',
        'We book cruises.',
        'We don’t book cruises.',
        {
          onlyFor: only('travel'),
        },
      ),
      fact(
        'free_planning',
        'Is planning a trip with you free?',
        'Free trip planning',
        'Planning a trip with us is free.',
        'We charge a planning fee.',
        { onlyFor: only('travel') },
      ),
      SPANISH,
    ],
    questions: [
      { id: 'where', question: 'Where would you like to go or stay?', kind: 'text' },
      { id: 'dates', question: 'What dates are you thinking of?', kind: 'text' },
      { id: 'people', question: 'How many people are traveling?', kind: 'text' },
      BUDGET,
    ],
    area: {
      question: 'Where are you, or where do you plan trips to?',
      example: 'On Lake Travis, near Austin',
    },
    tests: {
      where: LOCATED,
      book: 'Can I book a time to talk next week?',
      qualify: 'I’m planning a trip. Can you help?',
    },
    calendar: 'Appointments',
    sensitiveTopics: [],
  },
  rentals: {
    kind: 'rentals',
    adds: ['qualify'],
    tone: 'friendly',
    facts: [
      fact(
        'deposit',
        'Do you take a deposit?',
        'Deposit',
        'We take a deposit.',
        'We don’t take a deposit.',
      ),
      fact(
        'delivery_pickup',
        'Do you deliver and pick up?',
        'Delivery and pick-up',
        'We deliver and pick up.',
        'Customers pick up and return.',
        { notFor: STORAGE },
      ),
      fact(
        'same_day_delivery',
        'Can you often deliver the same day?',
        'Same-day delivery',
        'We can often deliver the same day.',
        'We usually can’t deliver the same day.',
        { notFor: STORAGE },
      ),
      fact(
        'setup',
        'Do you set up and take down?',
        'Set up and take down',
        'We set up and take down.',
        'We drop off and pick up only.',
        { onlyFor: only('party_rentals') },
      ),
      fact(
        'climate',
        'Do you have climate-controlled units?',
        'Climate-controlled units',
        'We have climate-controlled units.',
        'We don’t have climate-controlled units.',
        { onlyFor: STORAGE },
      ),
      fact(
        'access_24',
        'Can renters get to their unit 24 hours a day?',
        '24-hour access',
        'Renters can get to their unit 24 hours a day.',
        null,
        { onlyFor: STORAGE },
      ),
      SPANISH,
    ],
    questions: [
      { id: 'what', question: 'What would you like to rent?', kind: 'text' },
      { id: 'dates', question: 'Which dates do you need it?', kind: 'text' },
      { id: 'where', question: 'Where should it go?', kind: 'text' },
      { id: 'how_long', question: 'How long do you need it?', kind: 'text', required: false },
    ],
    area: {
      question: 'Which areas do you deliver to?',
      example: 'Tampa, Clearwater and St. Petersburg',
    },
    tests: {
      where: 'Do you deliver to {place}?',
      book: 'Can I book a delivery for next Saturday?',
      qualify: 'I’d like to rent something next weekend. Can you help?',
    },
    calendar: 'Appointments',
    sensitiveTopics: [],
    industries: {
      self_storage: {
        questions: [
          {
            id: 'size',
            question: 'What size unit do you need?',
            kind: 'choice',
            options: ['Small', 'Medium', 'Large', 'Not sure'],
          },
          {
            id: 'when',
            question: 'When do you need it?',
            kind: 'choice',
            options: ['This week', 'This month', 'Just looking'],
          },
          {
            id: 'how_long',
            question: 'How long do you need it?',
            kind: 'choice',
            options: ['A month or two', 'Up to 6 months', 'Longer'],
          },
        ],
        area: { question: 'Where are you?', example: '1500 Highway 6, Sugar Land' },
        tests: {
          where: LOCATED,
          book: 'Can I see a unit next week?',
          qualify: 'I need a storage unit. Can you help?',
        },
      },
    },
  },
  retail: {
    kind: 'retail',
    adds: [],
    tone: 'friendly',
    facts: [
      fact('ships', 'Do you ship orders?', 'Shipping', 'We ship orders.', 'We don’t ship orders.', {
        onlyFor: only('retail_store'),
      }),
      fact(
        'free_shipping',
        'Do you offer free shipping?',
        'Free shipping',
        'We offer free shipping.',
        'We don’t offer free shipping.',
      ),
      fact(
        'returns',
        'Do you take returns?',
        'Returns',
        'We take returns.',
        'All sales are final.',
      ),
      fact(
        'pickup',
        'Can customers pick up orders in the store?',
        'In-store pickup',
        'You can pick up orders in the store.',
        null,
        { onlyFor: only('retail_store') },
      ),
      GIFT_CARDS,
      fact(
        'price_match',
        'Do you match prices?',
        'Price match',
        'We match prices.',
        'We don’t match prices.',
      ),
      SPANISH,
    ],
    questions: [
      { id: 'looking', question: 'What are you looking for?', kind: 'text' },
      { id: 'by_when', question: 'When do you need it by?', kind: 'text', required: false },
    ],
    area: {
      question: 'Where is your shop, or where do you ship?',
      example: '45 Market St, Savannah, and we ship across the US',
    },
    tests: { where: LOCATED, book: APPOINTMENT, qualify: 'I’m looking for a gift. Can you help?' },
    calendar: 'Appointments',
    sensitiveTopics: [],
    industries: {
      online_store: {
        area: { question: 'Where do you ship?', example: 'Across the US and Canada' },
        tests: { where: 'Do you ship to {place}?' },
      },
    },
  },
  community: {
    kind: 'community',
    adds: [],
    tone: 'friendly',
    facts: [
      fact(
        'volunteers',
        'Are you looking for volunteers?',
        'Volunteers',
        'We’re looking for volunteers.',
        null,
      ),
      fact('give_online', 'Can people give online?', 'Give online', 'You can give online.', null),
      fact(
        'open_events',
        'Are your events open to everyone?',
        'Events open to everyone',
        'Our events are open to everyone.',
        null,
      ),
      PARKING,
      SPANISH,
    ],
    questions: [
      { id: 'help', question: 'How can we help you?', kind: 'text' },
      {
        id: 'involved',
        question: 'How would you like to get involved?',
        kind: 'choice',
        options: ['Volunteer', 'Give', 'Come to an event', 'Just learning more'],
      },
      { id: 'heard', question: 'How did you hear about us?', kind: 'text', required: false },
    ],
    area: { question: 'Where are you?', example: '300 Grace Ave, Macon' },
    tests: {
      where: LOCATED,
      book: 'Can we meet next week?',
      qualify: 'I’d like to get involved. Can you help?',
    },
    calendar: 'Appointments',
    // Praying with someone is for a person.
    sensitiveTopics: ['Prayer requests'],
    mayAsk: {
      words: ['church'],
      note: 'It may be a church or ministry, so its questions may say church.',
    },
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
      GUARANTEE,
      GIFT_CARDS,
      SPANISH,
    ],
    questions: GENERAL_QUESTIONS,
    area: {
      question: 'Where do you work, or where can customers find you?',
      example: 'Dallas and nearby',
    },
    tests: { where: 'Do you serve {place}?', book: APPOINTMENT, qualify: HELP },
    calendar: 'Appointments',
    sensitiveTopics: [],
  },
};

/** What quick setup picks for one industry: its kind's picks, with what the industry does differently. */
export type IndustrySetup = Omit<SetupKindInfo, 'industries'>;

/** What quick setup picks for an industry, with only the quick facts it's asked. */
export function setupFor(industry: string | null | undefined): IndustrySetup {
  const { industries, ...info } = SETUP_KIND_INFO[setupKindOf(industry)];
  const id = industry ?? '';
  const own: SetupIndustryInfo = industries?.[id as IndustryId] ?? {};
  return {
    ...info,
    facts: info.facts.filter((f) => (!f.onlyFor || f.onlyFor.has(id)) && !f.notFor?.has(id)),
    questions: own.questions ?? info.questions,
    area: own.area ?? info.area,
    tests: { ...info.tests, ...own.tests },
    calendar: own.calendar ?? info.calendar,
  };
}

/** The quick facts an industry is asked, in order. */
export function quickFactsFor(industry: string | null | undefined): QuickFact[] {
  return [...setupFor(industry).facts];
}

/**
 * Words a qualifying question must never use: asking about who someone is, rather than what they need, can break
 * fair housing and fair lending rules, and isn't a business's to ask. Checked on the starter questions and on the
 * ones Ava suggests from a website. Whole words, any case. A kind may use some of them (`mayAsk`).
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

const wordsPattern = (words: readonly string[]) =>
  new RegExp(`\\b(${words.map((w) => w.replace(/ /g, '\\s+')).join('|')})\\b`, 'i');

const protectedPattern = wordsPattern(PROTECTED_WORDS);
const kindPatterns = new Map<SetupKind, RegExp>(
  SETUP_KINDS.flatMap((kind) => {
    const may = SETUP_KIND_INFO[kind].mayAsk?.words;
    return may
      ? [[kind, wordsPattern(PROTECTED_WORDS.filter((w) => !may.includes(w)))] as const]
      : [];
  }),
);

/** Whether a question asks about who someone is (see `PROTECTED_WORDS`), for a business of this industry. */
export function asksAboutWhoSomeoneIs(text: string, industry?: string | null): boolean {
  return (kindPatterns.get(setupKindOf(industry)) ?? protectedPattern).test(text);
}
