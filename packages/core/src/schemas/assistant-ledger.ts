/**
 * The Assistant's checklist (assistant/ledger): every item on every screen, every level down, marked with how Ask
 * HandsFreeOS covers it, the audit's gaps, and the screens no area has checked yet. Read on Admin → Assistant
 * coverage, a filtered page at a time, like a table.
 */
import { z } from 'zod';

/** How the Assistant covers an item: a tool sees or does exactly this, some of it, none yet, never by a rule, or only
 * the person can (signing in, paying on a provider's page). */
export const LEDGER_COVERED = ['yes', 'partly', 'no', 'never', 'person'] as const;
export type LedgerCovered = (typeof LEDGER_COVERED)[number];

/** What the table lists: the items, the audit's gaps, or screen files to check (new ones, and ones gone). */
export const LEDGER_VIEWS = ['items', 'gaps', 'screens'] as const;
export type LedgerView = (typeof LEDGER_VIEWS)[number];

/** Which items: what isn't marked off (not yet, partly, or changed since its check), one kind, or every one. */
export const LEDGER_ITEM_STATES = ['unmarked', 'changed', ...LEDGER_COVERED, 'all'] as const;
export type LedgerItemState = (typeof LEDGER_ITEM_STATES)[number];

export const LEDGER_GAP_STATES = ['open', 'fixed', 'never', 'all'] as const;
export type LedgerGapState = (typeof LEDGER_GAP_STATES)[number];
export const LEDGER_SEVERITIES = ['high', 'medium', 'low'] as const;

export const AssistantLedgerInput = z.object({
  view: z.enum(LEDGER_VIEWS).default('items'),
  /** One area ("money"), or every one. */
  area: z
    .string()
    .regex(/^[a-z][a-z0-9-]{0,39}$/)
    .nullable()
    .default(null),
  itemState: z.enum(LEDGER_ITEM_STATES).default('unmarked'),
  gapState: z.enum(LEDGER_GAP_STATES).default('open'),
  /** Words to find in an item's place, how it's covered or its file. */
  q: z.string().trim().max(100).default(''),
  offset: z.number().int().min(0).max(100_000).default(0),
  limit: z.number().int().min(1).max(500).default(50),
});
export type AssistantLedgerInput = z.infer<typeof AssistantLedgerInput>;

const Counts = z.object({
  items: z.number().int(),
  yes: z.number().int(),
  partly: z.number().int(),
  no: z.number().int(),
  never: z.number().int(),
  person: z.number().int(),
  /** Items whose screen file changed since they were checked. */
  changed: z.number().int(),
  /** Not yet, partly, or changed since checked: what the next check looks at. */
  unmarked: z.number().int(),
  gapsOpen: z.number().int(),
  gapsFixed: z.number().int(),
});

export const LedgerItemShape = z.object({
  area: z.string(),
  /** Where it is, in the screen's own words: "Money → an invoice → Copy link". */
  path: z.string(),
  kind: z.enum(['see', 'do']),
  /** The file and line it lives in. */
  file: z.string(),
  covered: z.enum(LEDGER_COVERED),
  /** The tool and field that covers it, or why nothing does. */
  by: z.string(),
  changed: z.boolean(),
});
export type LedgerItem = z.infer<typeof LedgerItemShape>;

export const LedgerGapShape = z.object({
  area: z.string(),
  id: z.string(),
  severity: z.enum(LEDGER_SEVERITIES),
  kind: z.string(),
  where: z.string(),
  gap: z.string(),
  fix: z.string(),
  status: z.enum(['open', 'fixed', 'never']),
  /** The pull request that fixed it, once one did. */
  pr: z.number().int().nullable(),
});
export type LedgerGap = z.infer<typeof LedgerGapShape>;

export const AssistantLedgerOutput = z.object({
  totals: Counts.extend({
    /** Screen files no area has checked yet. */
    newScreens: z.number().int(),
    /** Files an area checked that are gone (moved or removed), so their items need a new home. */
    goneFiles: z.number().int(),
  }),
  areas: z.array(
    Counts.extend({ key: z.string(), title: z.string(), checkedOn: z.string().nullable() }),
  ),
  /** How many match the filter; the page below is `offset` to `offset + limit` of them. */
  total: z.number().int(),
  items: z.array(LedgerItemShape),
  gaps: z.array(LedgerGapShape),
  screens: z.array(
    z.object({ file: z.string(), state: z.enum(['new', 'gone']), area: z.string().nullable() }),
  ),
});
export type AssistantLedgerOutput = z.infer<typeof AssistantLedgerOutput>;
