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

/** Who said what on the call so far. */
export interface CallLine {
  readonly who: 'caller' | 'teammate';
  readonly text: string;
}

/** How to talk on a call, in place of the text channel's line. */
export function phoneChannelLines(o: {
  readonly training: boolean;
  readonly personHasIt: boolean;
}): string[] {
  return [
    'Channel: a live phone call. What you reply is spoken aloud, so talk the way people do on the phone: one to three short sentences, no lists, no links, no emoji, nothing that only makes sense written down. Say times the way people say them (“Tuesday at two thirty”).',
    'Ask one question at a time. The caller’s words come from speech recognition and may be a little off: when something that matters is unclear (a name, a time, an address), ask them to say it again.',
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
  const lines = call.lines.map(
    (l) => `${l.who === 'caller' ? 'Caller' : `You (${quoteData(name)})`}: ${quoteData(l.text)}`,
  );
  return [
    ...historyBlock(rc),
    'This phone call so far, oldest first:',
    '<call_transcript>',
    ...(lines.length ? lines : ['(it just started)']),
    '</call_transcript>',
    ...(call.offered.length
      ? [
          'Times you’ve offered on this call (book only one of these):',
          ...call.offered.map(
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
