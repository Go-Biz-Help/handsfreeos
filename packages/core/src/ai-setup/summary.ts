/**
 * What quick setup says back (HANDSFREEOS_AI_QUICK_SETUP_IMPLEMENTATION_PLAN.md §4): the summary beside the
 * questions, what a screen still needs before Next, and the questions the test chat starts with. Browser-safe.
 */
import { followUpStepWords, type TeammateConfig } from '../ai-team/config';
import { DISCLOSURE_NAMES, HOURS_MODE_NAMES, notifyText } from '../ai-team/diff';
import { aiSetupSteps, type AiSetupAnswers, type AiSetupStep } from './answers';
import { quickFactsFor, setupFor } from './kinds';
import { planAiSetup } from './plan';
import type { AiSetupState } from './state';

const joinAnd = (items: readonly string[]) =>
  items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function firstMessageWords(minutes: number): string {
  if (minutes === 0) return 'right away';
  if (minutes === 1) return 'within a minute';
  return `within ${minutes} minutes`;
}

function alertWords(alerts: TeammateConfig['handOff']['alerts']): string {
  const ways = [
    ...(alerts.push ? ['on the phone app'] : []),
    ...(alerts.text ? ['by text'] : []),
    ...(alerts.email ? ['by email'] : []),
  ];
  return ways.length ? `, ${joinAnd(ways)}` : '';
}

/**
 * The summary beside the questions, in plain sentences: "Ava replies to new leads within a minute.", "It works all
 * the time and says it’s AI in its first message.". It follows the answers as they change.
 */
export function aiSetupSummary(state: AiSetupState, answers: AiSetupAnswers): string[] {
  const plan = planAiSetup(state, answers);
  const c = plan.teammate;
  const name = c.identity.name;
  const lines: string[] = [];
  const subject = () => (lines.length ? 'It' : name);

  if (c.respond.enabled && c.respond.newLeads.enabled)
    lines.push(
      `${subject()} replies to new leads ${firstMessageWords(c.respond.newLeads.delayMinutes)}.`,
    );
  if (c.answer.enabled)
    lines.push(
      `${subject()} answers questions from what it knows about ${state.businessName}, and ${
        answers.allowPrices ? 'tells customers your prices as written' : 'never quotes prices'
      }.`,
    );
  if (c.book.enabled) {
    const calendars = [
      ...state.calendars.filter((x) => c.book.calendarIds.includes(x.id)).map((x) => x.name),
      ...(plan.booking.calendar ? [plan.booking.calendar] : []),
    ];
    lines.push(
      calendars.length
        ? `${subject()} books appointments on ${joinAnd(calendars)}.`
        : `${subject()} books appointments once you have a calendar customers can book.`,
    );
  }
  if (c.qualify.enabled)
    lines.push(
      `${subject()} asks ${plural(c.qualify.questions.length, 'qualifying question', 'qualifying questions')}, and tells ${notifyText(c.qualify.whenQualified.notify)} when a lead is ready.`,
    );
  if (c.followUp.enabled && c.followUp.ladder.length) {
    const last = c.followUp.ladder.at(-1)!;
    const monthly = c.followUp.monthlyForMonths;
    lines.push(
      `If a lead goes quiet, ${lines.length ? 'it' : name} follows up ${plural(c.followUp.ladder.length, 'time', 'times')} over ${followUpStepWords(last)}${
        monthly ? `, then once a month for ${plural(monthly, 'month', 'months')}` : ''
      }.`,
    );
  }
  lines.push(
    `${subject()} works ${HOURS_MODE_NAMES[c.hours.mode]} and says it’s AI ${DISCLOSURE_NAMES[c.identity.disclosure]}.`,
  );
  lines.push(
    `Anything it can’t answer goes to ${notifyText(c.handOff.notify)}${alertWords(c.handOff.alerts)}.`,
  );
  lines.push(
    state.teammate?.status === 'automatic'
      ? 'It keeps sending messages on its own, as it does now.'
      : `Every message waits for your OK until you’ve approved ${c.autonomy.approvalsNeeded}.`,
  );
  return lines;
}

export interface AiSetupProblem {
  /** The answer it's about, as a path into the answers ("questions"), or "" for the screen. */
  readonly path: string;
  readonly message: string;
}

/** What a screen still needs before Next, beyond what the answers' own checks catch. */
export function aiSetupStepProblems(
  step: AiSetupStep,
  answers: AiSetupAnswers,
  state: AiSetupState,
): AiSetupProblem[] {
  const name = answers.name.trim() || 'Ava';
  const out: AiSetupProblem[] = [];
  switch (step) {
    case 'jobs':
      if (!answers.jobs.length)
        out.push({ path: 'jobs', message: `Tick at least one thing for ${name} to do.` });
      break;
    case 'about':
      if (!answers.description.trim())
        out.push({
          path: 'description',
          message: `Say what your business does in a sentence or two, so ${name} can tell customers.`,
        });
      if (
        answers.jobs.includes('book') &&
        !state.calendars.length &&
        !state.teammate?.config.book.calendarIds.length &&
        !state.services.length &&
        !answers.services.length
      )
        out.push({
          path: 'services',
          message: `Add the services customers book, so ${name} can book them.`,
        });
      break;
    case 'hours':
      if (answers.answerWhen === 'custom' && !answers.customHours.length)
        out.push({ path: 'customHours', message: `Add the hours ${name} answers.` });
      if (answers.answerWhen === 'after_hours' && !answers.openHours.length)
        out.push({
          path: 'openHours',
          message: `Add your open hours, so ${name} knows when you’re closed.`,
        });
      break;
    case 'qualify':
      if (answers.jobs.includes('qualify') && !answers.questions.length)
        out.push({
          path: 'questions',
          message: 'Add at least one question, or untick “Ask qualifying questions”.',
        });
      break;
    default:
      break;
  }
  return out;
}

/** Everything Save checks: each screen this business goes through. */
export function aiSetupProblems(answers: AiSetupAnswers, state: AiSetupState): AiSetupProblem[] {
  const facts = { website: !!state.website, chat: !!state.chat };
  return aiSetupSteps(answers, facts).flatMap((s) => aiSetupStepProblems(s, answers, state));
}

const lowerFirst = (s: string) => (/^[A-Z][a-z]/.test(s) ? s[0]!.toLowerCase() + s.slice(1) : s);

/** The first place in an answer to "Where do you work?": "Katy" from "Katy, Cypress, 77494". */
function firstPlace(area: string): string | null {
  const first = area
    .split(/[,;\n]|\band\b/i)
    .map((p) => p.trim())
    .find(Boolean);
  return first && first.length <= 60 ? first : null;
}

/**
 * The questions the test chat starts with, made from the answers: where it works, a quick fact, a price, booking,
 * the hours, and whether it's a real person. Each tests something the setup just told it.
 */
export function aiSetupTestQuestions(state: AiSetupState, answers: AiSetupAnswers): string[] {
  const out: string[] = [];
  const { tests } = setupFor(state.industry);
  const place = firstPlace(answers.area);
  if (place) out.push(tests.where.replaceAll('{place}', place));
  const fact = quickFactsFor(state.industry).find(
    (f) => f.key !== 'spanish' && answers.facts[f.key],
  );
  if (fact) out.push(fact.question);
  const service = answers.services[0];
  if (service) out.push(`How much does ${lowerFirst(service.name)} cost?`);
  if (answers.jobs.includes('book')) out.push(tests.book);
  else if (answers.jobs.includes('qualify')) out.push(tests.qualify);
  if (answers.openHours.length) out.push('Are you open on Saturday?');
  out.push('Are you a real person?');
  return out.slice(0, 6);
}
