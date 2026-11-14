/**
 * Which first messages work (docs/outreach.md, decisions 23 and 164). A playbook's first message has up to three
 * versions in the business's own words (`script.first`, ./script.ts). Drafts for a first message take turns with
 * them: each one goes to the version the person has used least (`nextOpener`), and the AI keeps close to its words,
 * fitted to the person. Copying a draft notes which version it was (`outreach.opener.use`), and the results card
 * counts, for each, the first messages sent with it, who wrote back and who booked a demo (`outreach.openers`).
 * Browser-safe: the web and the extension draw them.
 *
 * Before decision 164 a playbook had styles the AI worded its question in (`style`) and the business's own openers,
 * sent as written (`own`). Their numbers stay on the card as ones not in the playbook now.
 */
import { z } from 'zod';
import { PLAYBOOK_LIMITS, type PlaybookDetails } from './playbooks';
import { scriptOf } from './script';

/** One of the playbook's first messages (`own`), or an AI style from before decision 164, kept for its numbers. */
export const OPENER_KINDS = { style: 'AI style', own: 'Your message' } as const;
export type OpenerKind = keyof typeof OPENER_KINDS;
export const OPENER_KIND_KEYS = Object.keys(OPENER_KINDS) as [OpenerKind, ...OpenerKind[]];

export interface Opener {
  readonly kind: OpenerKind;
  /** The first message as the playbook has it, or an old style. Its words are what it's known by. */
  readonly text: string;
}

/** A playbook's first messages, in its order: the versions drafts take turns with. */
export const openersOf = (d: Pick<PlaybookDetails, 'goal' | 'script'>): Opener[] =>
  scriptOf(d).first.map((text) => ({ kind: 'own' as const, text }));

/** What an opener is known by in the counts: its kind and its words, whatever the spaces. */
export const openerKey = (o: Opener) =>
  `${o.kind}:${o.text.trim().replace(/\s+/g, ' ').toLowerCase()}`;

/**
 * The first message a draft takes now: the version the person has used least, the first of those in the playbook's
 * order.
 */
export function nextOpener(
  openers: readonly Opener[],
  used: ReadonlyMap<string, number>,
): Opener | null {
  let best: Opener | null = null;
  let fewest = Infinity;
  for (const o of openers) {
    const n = used.get(openerKey(o)) ?? 0;
    if (n < fewest) [best, fewest] = [o, n];
  }
  return best;
}

/** A long opener cut short for a list: its first line, up to `most` characters. */
export function openerShort(text: string, most = 90): string {
  const one = text.trim().replace(/\s+/g, ' ');
  return one.length <= most ? one : `${one.slice(0, most - 1).trimEnd()}…`;
}

/** The opener a draft was written with, as the drafts come back and as copying one notes it. */
export const DraftOpener = z.object({
  playbookId: z.uuid(),
  kind: z.enum(OPENER_KIND_KEYS),
  text: z.string().trim().min(1).max(PLAYBOOK_LIMITS.ownOpeners.line),
});
export type DraftOpener = z.output<typeof DraftOpener>;

/** Copying a first message's draft: which opener it was, for whom. */
export const OpenerUseInput = z.object({
  workspaceId: z.uuid(),
  profileId: z.uuid(),
  opener: DraftOpener,
});
export type OpenerUseInput = z.input<typeof OpenerUseInput>;

export const OpenerUseOutput = z.object({
  /** False when a first message to them was noted already: the opener they got stays the one it was. */
  noted: z.boolean(),
});

/** The stretches the results can cover: a week or a month (as the activity panel's), or all of it. */
export const OPENER_PERIOD_KEYS = ['all', 'week', 'month'] as const;
export type OpenerPeriod = (typeof OPENER_PERIOD_KEYS)[number];

export const OpenersInput = z.object({
  workspaceId: z.uuid(),
  /** Everyone's, for owners and admins; else the person's own. */
  everyone: z.boolean().default(false),
  /** Only first messages copied in the last week or month, to the business's midnight; left out, all of them. */
  period: z.enum(OPENER_PERIOD_KEYS).default('all'),
});
export type OpenersInput = z.input<typeof OpenersInput>;

const n = z.number().int().min(0);

export const OpenerResult = z.object({
  kind: z.enum(OPENER_KIND_KEYS),
  text: z.string(),
  /** Still one of the playbook's openers; false for one taken out, kept for its numbers. */
  current: z.boolean(),
  /** First messages sent with it, as the extension noted them. */
  sent: n,
  /** Of those, who wrote back. */
  replies: n,
  /** Of those, who booked a demo: through the demo link, or marked by the person. */
  demos: n,
});
export type OpenerResult = z.output<typeof OpenerResult>;

export const OpenersOutput = z.object({
  everyone: z.boolean(),
  playbooks: z.array(
    z.object({
      playbookId: z.uuid(),
      name: z.string(),
      openers: z.array(OpenerResult),
    }),
  ),
});
export type OpenersOutput = z.output<typeof OpenersOutput>;

/** "4 of 12 wrote back (33%)". */
export function rateWords(part: number, of: number, what: string): string {
  if (!of) return 'None sent yet';
  return `${part.toLocaleString()} of ${of.toLocaleString()} ${what} (${Math.round((part / of) * 100)}%)`;
}

/** A sent count needs to be this big before one opener's reply rate is called the best. */
export const FAIR_TRY = 5;

/** The opener with the most replies for what was sent, once each has had a fair try; null before then. */
export function bestOpenerOf(list: readonly OpenerResult[]): OpenerResult | null {
  const tried = list.filter((o) => o.current && o.sent >= FAIR_TRY);
  if (tried.length < 2) return null;
  const rate = (o: OpenerResult) => o.replies / o.sent;
  const best = tried.reduce((a, b) => (rate(b) > rate(a) ? b : a));
  return rate(best) > 0 ? best : null;
}

/** Which openers work, on Results (decision 129) on the web and the phone. */
export const OPENER_RESULT_WORDS = {
  title: 'Which first messages work',
  about: (everyone: boolean) =>
    `${everyone ? 'Everyone’s first messages' : 'Your first messages'} from Today’s drafts, by the version in your playbook. Drafts take turns with each.`,
  notNow: 'Not in the playbook now',
  best: 'Works best so far',
  replies: (o: OpenerResult) => rateWords(o.replies, o.sent, 'wrote back'),
  demos: (n: number) => (n === 1 ? '1 demo booked' : `${n.toLocaleString()} demos booked`),
} as const;
