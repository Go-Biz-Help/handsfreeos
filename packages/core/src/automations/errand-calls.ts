/**
 * The AI teammate calls a supplier for someone (the owner, 25 Nov 2026: "would calling suppliers be the AI
 * teammate?" — yes). Someone asks the Assistant ("call ABC Supply and ask if they have 30-year shingles"), OKs the
 * call on a card, and the teammate rings them from the business number with those questions, saying it's an AI
 * calling for the business and that the call is recorded. What they said comes back to the person in the
 * Assistant's chat and on their phone.
 *
 * The same rule as a call to a lead: only someone who agreed in writing to calls, or a number the phone company says
 * is a business landline (asked just before the call, a couple of cents). Never someone who asked not to be called.
 * It never orders, pays, books or agrees to anything: it asks, listens and reports back.
 */
import { z } from 'zod';

export const ERRAND_ASK_MAX = 1000;
export const ERRAND_SAY_MAX = 500;
/** "I'm calling …": the line it says after who it is. */
export const ERRAND_GOAL_MAX = 200;

/** What's kept on the call (`ai_calls.errand`): what to find out, what it may say, and who it's calling for. */
export const ErrandSpec = z.object({
  ask: z.string().trim().min(1).max(ERRAND_ASK_MAX),
  say: z.string().trim().max(ERRAND_SAY_MAX).default(''),
  /** The person who asked, by name: "calling for Dale at Lone Star HVAC". */
  asker: z.string().trim().max(120).default(''),
});
export type ErrandSpec = z.infer<typeof ErrandSpec>;

/** The errand kept on a call, read forgivingly. */
export function errandOf(raw: unknown): ErrandSpec {
  const r = ErrandSpec.safeParse(raw);
  return r.success ? r.data : { ask: '', say: '', asker: '' };
}

/** The errand as facts for the call (the teammate reads them under <call_facts>). */
export function errandFacts(e: ErrandSpec, business: string): string {
  const who = e.asker ? `${e.asker} at ${business}` : business;
  return [
    `Calling for: ${who}. This is a supplier or another business, not a customer of ${business}.`,
    `What to find out: ${e.ask}`,
    e.say
      ? `What you may tell them, and nothing more: ${e.say}`
      : `Tell them nothing about ${business} beyond who you are and what you’re asking.`,
  ].join('\n');
}

/** "to ask if you have 30-year shingles in stock." from what was typed, finishing "I'm calling …". */
export function errandGoal(goal: string): string {
  const g = goal
    .trim()
    .replace(/^I[’']?m calling\s+/i, '')
    .slice(0, ERRAND_GOAL_MAX);
  return /[.!?]$/.test(g) ? g : `${g}.`;
}

/** Why a call for someone didn't go, in words for them. Null when the reason needs no telling. */
export function errandNotCalledWords(reason: string | null, name: string): string {
  switch (reason) {
    case 'not_business_landline':
      return `I didn’t call ${name}: the phone company says their number isn’t a business landline, and the AI teammate only calls a business landline or someone who agreed in writing to calls. If they did agree, mark them OK to call on their page in Contacts, then ask me again.`;
    case 'no_calls':
      return `I didn’t call ${name}: they asked not to be called. Call them yourself if you need to.`;
    case 'deleted':
      return `I didn’t call ${name}: they were deleted from Contacts before the call went.`;
    case 'no_voice':
      return `I didn’t call ${name}: your AI teammate isn’t set up to talk on the phone. Turn on Phone calls in AI teammate → Phone, then ask me again.`;
    case 'balance':
      return `I didn’t call ${name}: the business’s balance ran out. An owner or admin can top it up in Settings → Billing & Usage.`;
    case 'no_number':
      return `I didn’t call ${name}: the business has no phone number to call from. Set one up in Settings → Texting & calls.`;
    case 'no_telephony_account':
      return `I didn’t call ${name}: the business’s phone account isn’t ready. Check Settings → Texting & calls, then ask me again.`;
    case 'no_calling_hours':
      return `I didn’t call ${name}: there were no open hours to call in. Check your open hours in Settings → Business.`;
    case 'switched_off':
    case 'teammate_off':
      return `I didn’t call ${name}: your AI teammate was turned off.`;
    default:
      return `I didn’t reach ${name}: the call couldn’t go through. Try again later, or call them yourself.`;
  }
}

/** A call that rang but nobody talked: what to tell them. */
export function errandUnansweredWords(outcome: string | null, name: string): string {
  switch (outcome) {
    case 'busy':
      return `I called ${name}, but the line was busy. Ask me again later, or call them yourself.`;
    case 'voicemail':
      return `I called ${name}, but a voicemail box answered, so I hung up without leaving a message. Ask me again during their business hours, or call them yourself.`;
    case 'no_answer':
      return `I called ${name}, but nobody answered. Ask me again during their business hours, or call them yourself.`;
    default:
      return `I called ${name}, but the call didn’t go through. Try again later, or call them yourself.`;
  }
}
