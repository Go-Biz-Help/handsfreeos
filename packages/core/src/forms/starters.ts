/**
 * Forms a business can start from instead of a blank page. Nine of them, each one somebody actually needs
 * on a Tuesday: an enquiry, a quote that prices itself, a review request, a satisfaction survey, a
 * post-job check, a staff safety quiz, a "which service do you need?" quiz, a new-customer sheet and a
 * paid deposit.
 *
 * They are written as plain definitions with made-up ids, and `starterForm` stamps fresh ones as it hands
 * one over — so two businesses starting from the same one never share a question id, and either can change
 * theirs to nothing like the original. Browser-safe.
 */
import { FormDefinition, type FormDefinitionInput, type FormMode } from './definition';
import { newCalculationId, newChoiceId, newPageId, newQuestionId, newResultId } from './ids';
import { mapStrings } from '../workflows/json';

export interface FormStarter {
  readonly key: string;
  readonly name: string;
  readonly mode: FormMode;
  /** One line in the picker: what it is for, not what it contains. */
  readonly blurb: string;
  readonly definition: FormDefinitionInput;
}

/** Placeholder ids inside the starters; every one is replaced when a business takes a copy. */
const q = (n: string) => `q_${n.padEnd(8, '0').slice(0, 8)}`;
const c = (n: string) => `c_${n.padEnd(8, '0').slice(0, 8)}`;
const p = (n: string) => `p_${n.padEnd(8, '0').slice(0, 8)}`;
const r = (n: string) => `r_${n.padEnd(8, '0').slice(0, 8)}`;
const k = (n: string) => `k_${n.padEnd(8, '0').slice(0, 8)}`;

const name = (id = q('name')) => ({
  id,
  type: 'short_text' as const,
  title: 'Your name',
  required: true,
  mapTo: 'person.first_name' as const,
  config: {},
});
const phone = (id = q('phone')) => ({
  id,
  type: 'phone' as const,
  title: 'Best number to reach you',
  required: true,
  mapTo: 'person.phone' as const,
  config: {},
});
const email = (id = q('email')) => ({
  id,
  type: 'email' as const,
  title: 'Your email',
  mapTo: 'person.email' as const,
  config: {},
});
const thanks = (headline: string, body = '') => ({
  id: r('thanks'),
  name: 'Thank you',
  headline,
  body,
});

export const FORM_STARTERS: readonly FormStarter[] = [
  {
    key: 'enquiry',
    name: 'Get in touch',
    mode: 'form',
    blurb: 'The everyday enquiry form: who they are, what they need, when suits.',
    definition: {
      mode: 'form',
      title: 'How can we help?',
      intro: 'Tell us what you need and we’ll come back to you today.',
      pages: [
        {
          id: p('about'),
          questions: [
            name(),
            phone(),
            email(),
            {
              id: q('what'),
              type: 'long_text',
              title: 'What do you need doing?',
              required: true,
              config: {},
            },
            {
              id: q('when'),
              type: 'choice',
              title: 'How soon?',
              config: {
                choices: [
                  { id: c('emergency'), label: 'It’s an emergency' },
                  { id: c('week'), label: 'This week' },
                  { id: c('month'), label: 'This month' },
                  { id: c('planning'), label: 'Just planning ahead' },
                ],
              },
            },
          ],
        },
      ],
      results: [thanks('Thanks — we’ve got that.', 'We’ll be in touch shortly.')],
    },
  },
  {
    key: 'quote',
    name: 'Quote request',
    mode: 'form',
    blurb: 'Asks the size of the job and prices it on the spot.',
    definition: {
      mode: 'form',
      title: 'Get a quote',
      intro: 'Two minutes, and you’ll see a price before you send it.',
      pages: [
        {
          id: p('about'),
          questions: [
            name(),
            phone(),
            {
              id: q('sqft'),
              type: 'number',
              title: 'Roughly how many square feet?',
              required: true,
              config: { unit: 'sq ft', min: 100, max: 100000 },
            },
            {
              id: q('address'),
              type: 'address',
              title: 'Where is it?',
              mapTo: 'person.address',
              config: {},
            },
          ],
        },
      ],
      calculations: [
        {
          id: k('quote'),
          name: 'Your estimate',
          terms: [
            {
              factors: [
                { kind: 'question', questionId: q('sqft') },
                { kind: 'number', value: 0.15 },
              ],
            },
            { factors: [{ kind: 'number', value: 75 }] },
          ],
          format: 'money',
          round: 'nearest',
        },
      ],
      results: [
        thanks(
          'Thanks — your estimate is on its way.',
          'This is a guide from what you told us. We’ll confirm it when we see the job.',
        ),
      ],
    },
  },
  {
    key: 'review',
    name: 'Review request',
    mode: 'survey',
    blurb: 'Asks how it went, then sends the happy ones to leave a review.',
    definition: {
      mode: 'survey',
      title: 'How did we do?',
      pages: [
        {
          id: p('about'),
          questions: [
            {
              id: q('rating'),
              type: 'rating',
              title: 'How would you rate the work?',
              required: true,
              config: { max: 5, icon: 'star' },
            },
            {
              id: q('why'),
              type: 'long_text',
              title: 'Anything you’d like us to know?',
              config: {},
            },
          ],
        },
      ],
      results: [
        {
          id: r('happy'),
          name: 'Happy',
          headline: 'Thank you — that means a lot.',
          body: 'If you have a moment, a public review helps other people find us.',
          showIf: {
            match: 'all',
            conditions: [
              { source: { kind: 'question', questionId: q('rating') }, op: 'gte', value: 4 },
            ],
          },
        },
        thanks('Thank you for telling us.', 'Somebody will call you about this today.'),
      ],
      settings: { identity: 'optional' },
    },
  },
  {
    key: 'satisfaction',
    name: 'Customer satisfaction',
    mode: 'survey',
    blurb: 'The one-question survey, answered honestly because it is anonymous.',
    definition: {
      mode: 'survey',
      title: 'How are we doing?',
      intro: 'Anonymous — nothing here says who you are.',
      pages: [
        {
          id: p('about'),
          questions: [
            {
              id: q('nps'),
              type: 'scale',
              title: 'How likely are you to recommend us?',
              required: true,
              config: { min: 0, max: 10, minLabel: 'Not likely', maxLabel: 'Very likely' },
            },
            { id: q('why'), type: 'long_text', title: 'What’s behind that?', config: {} },
          ],
        },
      ],
      results: [thanks('Thank you.', 'We read every one of these.')],
      settings: { identity: 'anonymous', saveAndResume: false },
    },
  },
  {
    key: 'after_job',
    name: 'After the job',
    mode: 'form',
    blurb: 'The check-in a day later: did it hold, anything outstanding.',
    definition: {
      mode: 'form',
      title: 'Just checking in',
      pages: [
        {
          id: p('about'),
          questions: [
            name(),
            phone(),
            {
              id: q('sorted'),
              type: 'yes_no',
              title: 'Is everything working as it should?',
              required: true,
              config: {},
            },
            {
              id: q('what'),
              type: 'long_text',
              title: 'What’s not right?',
              config: {},
              showIf: {
                match: 'all',
                conditions: [
                  { source: { kind: 'question', questionId: q('sorted') }, op: 'is', value: 'no' },
                ],
              },
            },
          ],
        },
      ],
      results: [thanks('Thanks for letting us know.')],
    },
  },
  {
    key: 'safety_quiz',
    name: 'Safety quiz',
    mode: 'quiz',
    blurb: 'For the crew: the few things nobody may get wrong.',
    definition: {
      mode: 'quiz',
      title: 'Safety check',
      intro: 'Four questions. You need them all right.',
      pages: [
        {
          id: p('quiz'),
          questions: [
            name(),
            {
              id: q('shutoff'),
              type: 'choice',
              title: 'Before you work on a unit, what happens first?',
              required: true,
              config: {
                choices: [
                  {
                    id: c('isolate'),
                    label: 'Isolate the power at the breaker',
                    correct: true,
                    points: 1,
                  },
                  { id: c('switch'), label: 'Switch it off at the thermostat' },
                  { id: c('nothing'), label: 'Nothing, if it’s a quick job' },
                ],
              },
            },
            {
              id: q('ladder'),
              type: 'yes_no',
              title: 'May a ladder rest against a gutter?',
              required: true,
              config: { correct: 'no', points: 1 },
            },
          ],
        },
      ],
      scoring: { enabled: true, passPercent: 100, showScore: true, showAnswers: 'after' },
      results: [
        {
          id: r('passed'),
          name: 'Passed',
          headline: 'All right — you’re good to go.',
          showIf: {
            match: 'all',
            conditions: [{ source: { kind: 'percent' }, op: 'gte', value: 100 }],
          },
        },
        thanks('Not this time.', 'Have another look and try again.'),
      ],
      settings: { identity: 'optional' },
    },
  },
  {
    key: 'which_service',
    name: 'Which service do you need?',
    mode: 'quiz',
    blurb: 'A few questions that end in a recommendation, and a lead.',
    definition: {
      mode: 'quiz',
      title: 'Which service do you need?',
      pages: [
        {
          id: p('about'),
          questions: [
            {
              id: q('problem'),
              type: 'choice',
              title: 'What’s happening?',
              required: true,
              config: {
                choices: [
                  { id: c('nothing'), label: 'Nothing is coming on at all', resultId: r('repair') },
                  { id: c('weak'), label: 'It runs but it’s weak', resultId: r('service') },
                  {
                    id: c('old'),
                    label: 'It’s old and I’m thinking ahead',
                    resultId: r('replace'),
                  },
                ],
              },
            },
            name(),
            phone(),
          ],
        },
      ],
      results: [
        {
          id: r('repair'),
          name: 'Repair',
          headline: 'Sounds like a repair call.',
          body: 'We’ll get somebody out to look.',
        },
        {
          id: r('service'),
          name: 'Service',
          headline: 'A service should sort that.',
          body: 'We’ll book you in.',
        },
        {
          id: r('replace'),
          name: 'Replacement',
          headline: 'Worth pricing a replacement.',
          body: 'We’ll bring options.',
        },
        thanks('Thanks — we’ll be in touch.'),
      ],
    },
  },
  {
    key: 'new_customer',
    name: 'New customer details',
    mode: 'form',
    blurb: 'Everything you need on file before the first visit.',
    definition: {
      mode: 'form',
      title: 'Before your first visit',
      pages: [
        {
          id: p('about'),
          questions: [
            name(),
            {
              id: q('last'),
              type: 'short_text',
              title: 'Your surname',
              mapTo: 'person.last_name',
              config: {},
            },
            phone(),
            email(),
            {
              id: q('address'),
              type: 'address',
              title: 'Where are we coming to?',
              required: true,
              mapTo: 'person.address',
              config: {},
            },
            {
              id: q('access'),
              type: 'short_text',
              title: 'Anything we need to get in? (gate code, dog, parking)',
              config: {},
            },
          ],
        },
      ],
      results: [thanks('Thank you — that’s everything.', 'See you at the visit.')],
    },
  },
  {
    key: 'deposit',
    name: 'Book with a deposit',
    mode: 'form',
    blurb: 'Takes the details and a deposit in one go.',
    definition: {
      mode: 'form',
      title: 'Book your slot',
      intro: 'A deposit holds the date; the rest is due on the day.',
      pages: [
        {
          id: p('about'),
          questions: [
            name(),
            phone(),
            {
              id: q('when'),
              type: 'date',
              title: 'Which day suits?',
              required: true,
              config: { range: 'future' },
            },
            {
              id: q('deposit'),
              type: 'payment',
              title: 'Deposit',
              config: { amount: { kind: 'fixed', cents: 5000 }, description: 'Booking deposit' },
            },
          ],
        },
      ],
      results: [thanks('You’re booked in.', 'We’ll confirm the time by text.')],
    },
  },
];

export const starterByKey = (key: string): FormStarter | undefined =>
  FORM_STARTERS.find((s) => s.key === key);

/**
 * A starter as a form of this business's own: every id made fresh, so nothing is shared with the starter
 * or with anybody else who used it.
 */
export function starterForm(key: string, title?: string): FormDefinition {
  const starter = starterByKey(key);
  if (!starter) throw new Error(`There is no starter “${key}”.`);
  const fresh = new Map<string, string>();
  const idFor = (value: string): string => {
    const made = value.startsWith('q_')
      ? newQuestionId()
      : value.startsWith('p_')
        ? newPageId()
        : value.startsWith('c_')
          ? newChoiceId()
          : value.startsWith('r_')
            ? newResultId()
            : value.startsWith('k_')
              ? newCalculationId()
              : value;
    if (!fresh.has(value)) fresh.set(value, made);
    return fresh.get(value)!;
  };
  const stamped = mapStrings(starter.definition, (text) =>
    /^[qpcrk]_[a-z0-9]{8}$/.test(text) ? idFor(text) : text,
  );
  return FormDefinition.parse({ ...stamped, ...(title ? { title } : {}) });
}
