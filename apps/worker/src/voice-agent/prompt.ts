/**
 * What the AI teammate reads on a live phone call (M18 step 5), on top of everything it reads for a text
 * (ai-team/prompt.ts): the same fixed rules and context, with the channel's line swapped for how to talk on the
 * phone, and one message per turn holding the call so far and what the caller just said. The caller's words are
 * quoted as data, like a customer's text; the scripted stand-in reads them from the same tag.
 */
import { disclosesAi, quoteData, type TeammateConfig } from '@hfos/core/server';
import { historyBlock } from '../ai-team/prompt';
import type { RunContext } from '../ai-team/context';
import type { OfferedTime } from '../ai-team/tools';

/** Tokens per model call on a call: a spoken reply is a sentence or three. */
export const PHONE_MAX_TOKENS = 600;

export const PHONE_ASK =
  'Answer what the caller just said, out loud. End your turn with reply, end_call or hand_off.';

/** Said before ringing the team, in the caller's language. */
export const CONNECTING: Readonly<Record<'en' | 'es', string>> = {
  en: 'One moment, I’ll connect you with the team.',
  es: 'Un momento, le comunico con el equipo.',
};

/** Said when the teammate can't go on (a failure, a limit) and hands the call to the team. */
export const CANT_GO_ON: Readonly<Record<'en' | 'es', string>> = {
  en: 'Sorry, let me get someone from the team for you.',
  es: 'Disculpe, le comunico con alguien del equipo.',
};

export const STILL_THERE: Readonly<Record<'en' | 'es', string>> = {
  en: 'Are you still there?',
  es: '¿Sigue ahí?',
};

export const GOODBYE: Readonly<Record<'en' | 'es', string>> = {
  en: 'I’ll let you go. Call back anytime. Goodbye!',
  es: 'Lo dejo ir. Llame cuando quiera. ¡Adiós!',
};

export const tongue = (language: string | null): 'en' | 'es' =>
  language?.toLowerCase().startsWith('es') ? 'es' : 'en';

/** In the rewrite's feedback when the start of the reply was already said out loud. */
export function alreadySaid(said: string): string {
  return `The caller already heard you say “${quoteData(said)}”, so don’t say it again: write only what comes after it.`;
}

/** Who said what on the call so far. */
export interface CallLine {
  readonly who: 'caller' | 'teammate';
  readonly text: string;
}

/** How to talk on a call, in place of the text channel's line. */
export function phoneChannelLines(o: {
  readonly training: boolean;
  readonly personHasIt: boolean;
  /** AI outbound calls: it placed this call, and why. */
  readonly outbound?: OutboundWhy | null;
}): string[] {
  return [
    ...(o.outbound ? outboundLines(o.outbound) : []),
    'Channel: a live phone call. What you reply is spoken aloud, so talk the way people do on the phone: one to three short sentences, no lists, no links, no emoji, nothing that only makes sense written down. Say times the way people say them (“Tuesday at two thirty”).',
    'Ask one question at a time. The caller’s words come from speech recognition and may be a little off: when something that matters is unclear (a name, a time, an address), ask them to say it again.',
    'Every tool step keeps the caller waiting in silence: when the business profile or the knowledge in this context already answers them, reply straight away without looking anything up.',
    'Your reply starts being said while you write it, so put the answer first.',
    'Never read out a link, an email address or a long number, and never promise to send one yourself: when something needs a link or a payment, say the team will text it to them.',
    'When they’re done (they say goodbye, or that’s all they needed), say a short goodbye with end_call.',
    'hand_off connects them to the team on this same call: they’ll hear you’re connecting them, so don’t say goodbye first.',
    ...(o.training
      ? [
          'On this call your changes wait for the team’s OK: after you book, move or cancel something, say the team will confirm it by text shortly, never that it’s done.',
        ]
      : []),
    ...(o.personHasIt
      ? [
          'Someone on the team looks after this customer: answer questions from the business profile and the knowledge, and for anything else, hand off so they’re connected to the team.',
        ]
      : []),
  ];
}

/** Why it placed a call: the reason, the words that finish "I'm calling …", and a quote's or campaign's facts. */
export interface OutboundWhy {
  readonly purpose: string;
  readonly goal: string;
  readonly brief?: string | null;
}

/** What it says about a call it placed (AI outbound calls): why it called, and how to finish. */
function outboundLines(o: OutboundWhy): string[] {
  return [
    `You placed this call; they didn’t call you. You already said who you are, that you’re an AI and that the call is recorded, and that you’re calling ${quoteData(o.goal)}. Stay on that, answer what they ask, and keep it short.`,
    ...(o.purpose === 'confirm_visit'
      ? [
          'When they say the visit still works, use confirm_visit, thank them and end_call. If it doesn’t, offer to move it (find_times, then reschedule) or cancel it, as they want.',
        ]
      : []),
    ...(o.purpose === 'missed_call'
      ? ['Find out what they called about and help, like any call.']
      : []),
    ...(o.brief ? ['<call_facts>', quoteData(o.brief), '</call_facts>'] : []),
    ...(o.purpose === 'quote'
      ? [
          'Answer their questions about the quote from the facts above and what the business knows. Never change a price, a discount or the terms, and never promise one. If they want to go ahead, say they can accept it from the link in the text they got, and that the team can text it again. If they want changes, or have questions you can’t answer, say the team will follow up (or hand_off).',
        ]
      : []),
    ...(o.purpose === 'campaign'
      ? [
          'This is a marketing call they agreed to in writing. Tell them about it in a sentence or two from the facts above, never more than the facts say, and ask if they’d like to book or hear more. If they’re not interested, thank them and end_call; don’t push.',
        ]
      : []),
    ...(o.purpose === 'workflow'
      ? [
          'The business’s workflow placed this call, and they agreed to calls in writing. Work from the playbook in the facts above: ask what it says to find out, one question at a time; offer only what it says, never more; and book as it says. If they’re not interested, thank them and end_call; don’t push.',
        ]
      : []),
    'If they ask not to be called again, use no_more_calls, say sorry for the trouble and end_call. If it’s a bad time, offer that they can call back or text, and end_call.',
  ];
}

/**
 * What it says when the customer picks up a call it placed (AI outbound calls): who it is, for which business,
 * that it's an AI and that the call is recorded (always, whatever the disclosure setting says), and why it's
 * calling. The goal finishes "I'm calling …".
 */
export function outboundGreetingOf(
  config: TeammateConfig,
  business: string,
  firstName: string | null,
  goal: string,
  purpose: string,
): string {
  const hi = firstName ? `Hi ${firstName}` : 'Hi';
  const why = /[.!?]$/.test(goal.trim()) ? goal.trim() : `${goal.trim()}.`;
  return `${hi}, this is ${config.identity.name}, an AI assistant for ${business}. This call is recorded. I’m calling ${why} ${CALL_QUESTION[purpose] ?? ''}`.trim();
}

/** What it asks right after saying why it's calling. */
export const CALL_QUESTION: Readonly<Record<string, string>> = {
  confirm_visit: 'Does that still work for you?',
  missed_call: 'How can I help?',
  quote: 'Do you have any questions about it?',
  campaign: 'Is now a good time?',
  workflow: 'Is now a good time?',
};

/**
 * What it says when it picks up: the owner's greeting, or "Thanks for calling …". When its settings say it
 * tells people it's an AI in its first message, the greeting does, whatever the owner wrote.
 */
export function greetingOf(config: TeammateConfig, business: string): string {
  const name = config.identity.name;
  const discloses = config.identity.disclosure === 'first_message';
  const own = config.phone.greeting.trim();
  if (own) return discloses && !disclosesAi(own) ? `${own} I’m an AI assistant.` : own;
  return discloses
    ? `Thanks for calling ${business}. This is ${name}, the AI assistant. How can I help?`
    : `Thanks for calling ${business}, this is ${name}. How can I help?`;
}

/** One turn's message: the conversation before the call, the call so far, the times offered, what they said. */
export function phoneTurn(
  rc: RunContext,
  call: { readonly lines: readonly CallLine[]; readonly offered: readonly OfferedTime[] },
  said: string,
): string {
  const name = rc.config.identity.name;
  // The times read at pickup are in the call's context already; these are the ones it offered since.
  const offered = call.offered.filter((o) => !o.preloaded);
  const lines = call.lines.map(
    (l) => `${l.who === 'caller' ? 'Caller' : `You (${quoteData(name)})`}: ${quoteData(l.text)}`,
  );
  return [
    ...historyBlock(rc),
    'This phone call so far, oldest first:',
    '<call_transcript>',
    ...(lines.length ? lines : ['(it just started)']),
    '</call_transcript>',
    ...(offered.length
      ? [
          'Times you’ve offered on this call (book only one of these):',
          ...offered.map(
            (o) => `- ${o.label} (calendar id ${o.calendarId}, startsAt ${o.startsAt})`,
          ),
        ]
      : []),
    'What the caller just said:',
    '<customer_message>',
    quoteData(said),
    '</customer_message>',
    PHONE_ASK,
  ].join('\n');
}
