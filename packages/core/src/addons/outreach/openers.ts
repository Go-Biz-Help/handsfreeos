/**
 * Which openers work (docs/outreach.md, decision 23). Each playbook has two or three styles the AI writes first
 * messages in, and the business's own openers, sent as written (`openerStyles`, `ownOpeners` in ./playbooks.ts).
 * Drafts for a first message take turns with them: each one goes to the opener the person has used least
 * (`nextOpener`). Copying a draft notes which opener it was (`outreach.opener.use`), and the results card counts, for
 * each, the first messages sent with it, who wrote back and who booked a demo (`outreach.openers`). Browser-safe: the
 * web and the extension draw them.
 */
import { z } from 'zod';
import { PLAYBOOK_LIMITS, type PlaybookDetails } from './playbooks';

/** An AI style, or one of the business's own openers. */
export const OPENER_KINDS = { style: 'AI style', own: 'Your own' } as const;
export type OpenerKind = keyof typeof OPENER_KINDS;
export const OPENER_KIND_KEYS = Object.keys(OPENER_KINDS) as [OpenerKind, ...OpenerKind[]];

export interface Opener {
  readonly kind: OpenerKind;
  /** The style the AI writes in, or the opener as written. Its words are what it's known by. */
  readonly text: string;
}

/** Where the business's own openers say the person's first name: "Hi {first name}!". */
export const FIRST_NAME = '{first name}';
const FIRST_NAME_AT = /\{\s*first[\s_]*name\s*\}/gi;

/** A playbook's openers in order: its styles, then its own. */
export const openersOf = (d: Pick<PlaybookDetails, 'openerStyles' | 'ownOpeners'>): Opener[] => [
  ...d.openerStyles.map((text) => ({ kind: 'style' as const, text })),
  ...d.ownOpeners.map((text) => ({ kind: 'own' as const, text })),
];

/** What an opener is known by in the counts: its kind and its words, whatever the spaces. */
export const openerKey = (o: Opener) =>
  `${o.kind}:${o.text.trim().replace(/\s+/g, ' ').toLowerCase()}`;

/**
 * The opener a first message takes now: the one the person has used least, the first of those in the playbook's
 * order. Null when the playbook has none, and drafts are written as before.
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

/** One of the business's own openers with their first name in, as it's sent: "Hi Dana! …". */
export function ownOpenerText(text: string, name: string): string {
  const first = name.trim().split(/\s+/)[0] ?? '';
  return text
    .replace(FIRST_NAME_AT, first)
    .replace(/\s+([,.!?])/g, '$1')
    .trim();
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
