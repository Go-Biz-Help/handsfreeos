/**
 * The words for In your hands (messaging/hands.ts), once, for the web and the phone: Take over, Give back to the AI,
 * the list, and where someone last reached a customer by hand. Browser-safe.
 */
import type { InHandsRow } from '../schemas/hands';

export const HANDS_WORDS = {
  title: 'In your hands',
  /** The list's line under its title. */
  about:
    'People someone on your team messaged or called themselves. The AI leaves them alone until you give them back.',
  empty: 'Nobody’s in your hands. When you message or call someone yourself, they show here.',
  takeOver: 'Take over',
  takeOverHint: 'The AI stops messaging them anywhere until you give them back.',
  giveBack: 'Give back to the AI',
  giveBackHint: 'The AI answers them again, starting with anything they’re waiting on.',
  giveAllBack: 'Give all back',
  mine: 'Only mine',
  everyone: 'Everyone’s',
  tookOverToast: (name: string) =>
    `${name} is in your hands. The AI won’t message them until you give them back.`,
  gaveBackToast: (count: number) =>
    count === 1
      ? 'Given back to the AI. It answers anything they’re waiting on.'
      : `${count} people given back to the AI. It answers anything they’re waiting on.`,
  waiting: 'Waiting on a reply',
  /** What the AI does while they're in someone's hands, under who has them. */
  held: 'The AI leaves them alone until someone gives them back.',
  /** Where the AI answers them, as their page says it. */
  aiAnswers: 'The AI answers them',
} as const;

/** What a person did, by where they last reached a customer by hand, as a list row says it. */
const PLACE_WORDS: Readonly<Record<string, string>> = {
  sms: 'texted them',
  email: 'emailed them',
  chat: 'answered their website chat',
  portal: 'wrote in their portal',
  messenger: 'messaged them on Messenger',
  instagram: 'messaged them on Instagram',
  call: 'called them',
  facebook: 'messaged them on Facebook',
  linkedin: 'messaged them on LinkedIn',
  alignable: 'messaged them on Alignable',
  threads: 'messaged them on Threads',
  x: 'messaged them on X',
};

/** "You texted them", "Sam took over", "Someone on your team messaged them on Messenger". */
export function handsLine(
  row: Pick<InHandsRow, 'how' | 'place' | 'user'>,
  me: string | null,
): string {
  const who = row.user ? (row.user.id === me ? 'You' : row.user.fullName) : 'Someone on your team';
  if (row.how === 'took_over') return `${who} took over`;
  if (row.how === 'called') return `${who} called them`;
  return `${who} ${(row.place && PLACE_WORDS[row.place]) || 'wrote to them'}`;
}
