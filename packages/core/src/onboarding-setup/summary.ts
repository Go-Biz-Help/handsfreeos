/**
 * What the onboarding setup says back (HANDSFREEOS_ONBOARDING_QUICK_SETUP_IMPLEMENTATION_PLAN.md §4): the summary
 * beside the questions, and what a screen still needs before Next. Browser-safe.
 */
import { aiSetupStepProblems, aiSetupSummary, type AiSetupProblem } from '../ai-setup/summary';
import { setupFor } from '../ai-setup/kinds';
import { serviceNameKey } from '../ai-setup/plan';
import { formatHours } from '../calendar/format';
import { industryLabel } from '../industries';
import { cityAndState, usTimeZoneLabel, type BusinessAddress } from './address';
import { AI_SCREEN_OF, type OnboardingSetupAnswers, type OnboardingSetupScreen } from './answers';
import type { OnboardingSetupState } from './state';

const PROVIDERS = { stripe: 'Stripe', square: 'Square' } as const;
const count = (n: number) => n.toLocaleString('en-US');
const plural = (n: number, one: string, many: string) => `${count(n)} ${n === 1 ? one : many}`;

/** Area codes that are toll-free, for how long the carriers usually take. */
const TOLL_FREE = new Set(['800', '833', '844', '855', '866', '877', '888']);
const isTollFree = (display: string | null) =>
  !!display && TOLL_FREE.has(display.replace(/\D/g, '').replace(/^1/, '').slice(0, 3));

/** The services are the ones Ava read on the website, as it read them. */
function servicesFromSite(state: OnboardingSetupState, answers: OnboardingSetupAnswers): boolean {
  const read = state.found?.services ?? [];
  const mine = answers.ai.services;
  return (
    mine.length > 0 &&
    mine.length === read.length &&
    mine.every((s, i) => serviceNameKey(s.name) === serviceNameKey(read[i]!.name))
  );
}

/**
 * Where the business number stands, as the summary says it: "Calls to (512) 555-0148 work now. Texting starts once
 * the carriers approve your details." The phone's number stop says it too, under the number.
 */
export function onboardingSetupNumberLine(
  state: Pick<OnboardingSetupState, 'numberSetup'>,
  answers: Pick<OnboardingSetupAnswers, 'hasEin'>,
): string | null {
  const n = state.numberSetup;
  const shown = n.display ?? 'your number';
  switch (n.next) {
    case 'ready':
      return `Calls and texts come from ${shown}.`;
    case 'awaiting_approval':
      return `Texts will come from ${shown} once the carriers approve it, usually in ${
        isTollFree(n.display) ? 'a few days' : '1 to 3 weeks'
      }. Calls work now.`;
    case 'submit_registration':
      return `Calls to ${shown} work now. Texting starts once the carriers approve your details.`;
    case 'rejected':
      return `The carriers turned down texting${n.rejectionReason ? `: ${n.rejectionReason}` : ''}. Fix it in Settings → Texting & calls.`;
    case 'provisioning':
      return 'Your business number is being set up.';
    case 'porting':
      return `${n.display ?? 'Your number'} is moving over from your old carrier, which takes a few weeks.`;
    case 'buy_number':
      if (answers.hasEin === true) return 'You’ll pick a local number near you.';
      if (answers.hasEin === false) return 'You’ll get a toll-free number, approved faster.';
      return null;
    default:
      return null;
  }
}

function customersLine(state: OnboardingSetupState, answers: OnboardingSetupAnswers): string {
  const c = state.customers;
  if (c.running === 'migration')
    return c.count
      ? `${plural(c.count, 'customer', 'customers')} so far, with more moving over from GoHighLevel.`
      : 'Your customers are moving over from GoHighLevel.';
  if (c.running === 'import') return 'Your spreadsheet is coming in.';
  if (c.count) return `${plural(c.count, 'customer', 'customers')}.`;
  switch (answers.customersIn) {
    case 'ghl':
      return 'Your customers move over from GoHighLevel once you paste a token.';
    case 'sheet':
    case 'crm':
      return 'Your customers come in from a spreadsheet.';
    case 'phone':
      return 'You pick customers from your phone’s contacts in the phone app.';
    default:
      return 'New customers add themselves as they come in.';
  }
}

function paymentsLine(state: OnboardingSetupState, answers: OnboardingSetupAnswers): string {
  const p = state.payments;
  const name = p.provider ? PROVIDERS[p.provider] : null;
  if (p.active && name)
    return p.checking
      ? `${name} is checking your account. Payments start once it’s done.`
      : `Customers pay by card through ${name}.`;
  if (p.broken && name) return `${name} needs you to sign in again, in Settings → Payments.`;
  if (answers.payWith !== 'later') return `Connect ${PROVIDERS[answers.payWith]} to take payments.`;
  return 'Payments can wait for Settings → Payments.';
}

/**
 * The summary's first line, "Lone Star HVAC: HVAC in Austin, Texas, on Central time.", also for the first screen
 * before the business is made.
 */
export function onboardingSetupBusinessLine(
  b: Pick<OnboardingSetupState, 'businessName' | 'industry' | 'timeZone'> & {
    readonly address: Pick<BusinessAddress, 'city' | 'state'> | null;
  },
): string {
  const kind = b.industry ? industryLabel(b.industry) : null;
  const place = b.address ? ` in ${cityAndState(b.address)}` : '';
  return `${b.businessName}${kind ? `: ${kind}` : ''}${place}, on ${usTimeZoneLabel(b.timeZone)} time.`;
}

/**
 * The summary beside the questions, in plain sentences: "Lone Star HVAC: HVAC in Austin, Texas, on Central time.",
 * "Open Mon–Fri 7:00 AM–6:00 PM.", "Ava replies to new leads within a minute, with training wheels.". It follows the
 * answers as they change; on the phone it's a "See the summary" sheet.
 */
export function onboardingSetupSummary(
  state: OnboardingSetupState,
  answers: OnboardingSetupAnswers,
): string[] {
  const lines: string[] = [onboardingSetupBusinessLine(state)];

  const hours = answers.ai.openHours;
  lines.push(hours.length ? `Open ${formatHours(hours)}.` : 'No open hours yet.');

  const services = answers.ai.services.length;
  if (services)
    lines.push(
      `${plural(services, 'service', 'services')}${servicesFromSite(state, answers) ? ', from your website' : ''}.`,
    );
  if (answers.booksTime) {
    const calendar = state.calendars[0]?.name ?? setupFor(state.industry).calendar;
    lines.push(
      state.booking.on
        ? `Customers book ${calendar} on your booking page.`
        : `Customers will book ${calendar} on your booking page.`,
    );
  }
  if (state.team.invited.length)
    lines.push(`${plural(state.team.invited.length, 'invitation', 'invitations')} sent.`);

  lines.push(customersLine(state, answers));
  const number = onboardingSetupNumberLine(state, answers);
  if (number) lines.push(number);
  lines.push(paymentsLine(state, answers));
  if (answers.reviewLink.trim()) lines.push('Thank-you texts ask for a Google review.');

  const ai = aiSetupSummary(state, answers.ai)[0];
  if (ai)
    lines.push(
      state.teammate?.status === 'automatic' ? ai : ai.replace(/\.$/, ', with training wheels.'),
    );
  return lines;
}

/** What a screen still needs before Next, beyond what the answers' own checks catch. */
export function onboardingSetupScreenProblems(
  screen: OnboardingSetupScreen,
  answers: OnboardingSetupAnswers,
  state: OnboardingSetupState,
): AiSetupProblem[] {
  const out: AiSetupProblem[] = [];
  if (
    screen === 'about' &&
    answers.booksTime &&
    !answers.ai.services.length &&
    !state.services.length
  )
    out.push({
      path: 'ai.services',
      message: 'Add what customers book, so your booking page has something to book.',
    });
  // The AI part's own checks, at its own paths under `ai`.
  const ai = AI_SCREEN_OF[screen];
  if (ai)
    for (const p of aiSetupStepProblems(ai, answers.ai, state))
      if (!out.some((o) => o.path === `ai.${p.path}`))
        out.push({ path: p.path ? `ai.${p.path}` : '', message: p.message });
  return out;
}
