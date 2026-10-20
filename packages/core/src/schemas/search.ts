import { z } from 'zod';
import { isoDateTime, uuid } from './common';
import { ListInput } from './crm';
import { localDate } from './money';

/**
 * Search everything (HANDSFREEOS_SEARCH_IMPLEMENTATION_PLAN.md): `search.everything` for the box and the Search
 * page, `search.kind` for one kind at a time. Both are look-ups only: nothing typed is stored, and what's typed
 * travels in the body, never a path or a query string.
 *
 * The phone's contract only grows: every input field has a default, and kinds and badges are strings, so an older
 * build skips a kind it doesn't know and a badge it can't draw.
 */

/** A kind as the chips and `search.kind` name it: `contacts`, `record.pets`, `realestate.listings`. */
export const SearchKindKey = z.string().regex(/^[a-z][a-z0-9_]{1,30}(\.[a-z0-9_]{1,40})?$/);

const searchText = z.string().trim().max(120, 'Keep a search to 120 characters.');

export const SearchEverythingInput = z.object({
  workspaceId: uuid,
  q: searchText,
  /** The chips; a key the server doesn't know is ignored. */
  kinds: z.array(SearchKindKey).max(30).optional(),
  perKind: z.number().int().min(1).max(5).default(3),
  depth: z.enum(['quick', 'full']).default('quick'),
  includeArchived: z.boolean().default(false),
  onlyMine: z.boolean().default(false),
  /** A setting matched on the device, so close matches aren't looked for. */
  settingsMatched: z.boolean().default(false),
});
export type SearchEverythingInput = z.infer<typeof SearchEverythingInput>;

/** Every field optional: what `hitLines` and the Search page's tables print. */
export const SearchFacts = z
  .object({
    phone: z.string(),
    email: z.string(),
    where: z.string(),
    company: z.string(),
    lastContact: z.object({ kind: z.string(), subtype: z.string().nullable(), at: isoDateTime }),
    openLead: z.object({ title: z.string(), stage: z.string() }),
    people: z.number().int(),
    openLeads: z.number().int(),
    customer: z.string(),
    pipeline: z.string(),
    stage: z.string(),
    owner: z.string(),
    status: z.string(),
    docKind: z.enum(['invoice', 'estimate', 'payment']),
    number: z.string(),
    dueOn: localDate,
    sentAt: isoDateTime,
    openedAt: isoDateTime.nullable(),
    paidAt: isoDateTime,
    invoiceNumber: z.string(),
    startsAt: isoDateTime,
    endsAt: isoDateTime,
    who: z.string(),
    channel: z.string(),
    direction: z.enum(['inbound', 'outbound']),
    matches: z.number().int(),
    messages: z.number().int(),
    on: z.string(),
    dueAt: isoDateTime,
    doneAt: isoDateTime,
    answeredBy: z.string().nullable(),
    question: z.string(),
    /** Where a Deleted bin item stands: deleted when, and gone for good when. */
    deletedAt: isoDateTime,
    purgeAfter: isoDateTime,
    /** When an archived record was archived. */
    archivedAt: isoDateTime,
  })
  .partial();
export type SearchFacts = z.infer<typeof SearchFacts>;

/** A stretch of text with the places that matched, as `[start, end)` ranges. Drawn as text, never as HTML. */
export const SearchSnippet = z.object({
  text: z.string(),
  marks: z.array(z.tuple([z.number().int(), z.number().int()])),
});
export type SearchSnippet = z.infer<typeof SearchSnippet>;

export const SearchHit = z.object({
  kind: z.string(),
  id: uuid,
  title: z.string(),
  /** Add-on and record rows only; core's own kinds print their facts through `hitLines`. */
  subtitle: z.string().nullable(),
  /**
   * lead, client, archived, done, won, lost, cancelled, void, late, due, paid, draft, other_mail, spam, my_mail,
   * voicemail, anonymous, automated (a campaign or automated send).
   */
  badges: z.array(z.string()),
  why: z.object({
    field: z.string(),
    /** An add-on's own chip, or a custom field's name. */
    label: z.string().nullable(),
    snippet: SearchSnippet.nullable(),
    /** A PDF's page or an Excel sheet. */
    page: z.number().int().nullable(),
  }),
  tier: z.number().int().min(0).max(5),
  exact: z.boolean(),
  at: isoDateTime.nullable(),
  /** A web path under /app/w/<business>/; the phone opens it through its route map. */
  href: z.string(),
  contact: z
    .object({
      personId: uuid.nullable(),
      phoneE164: z.string().nullable(),
      email: z.string().nullable(),
    })
    .nullable(),
  amount: z.object({ cents: z.number().int(), currency: z.string() }).nullable(),
  facts: SearchFacts,
  /** "Same number, maybe the same person". */
  duplicateOf: z.object({ id: uuid, name: z.string() }).nullable(),
});
export type SearchHit = z.infer<typeof SearchHit>;

export const SearchGroup = z.object({
  /** 'contacts', 'record.pets', 'realestate.listings', 'archived', 'bin', 'close', 'spam'. */
  kind: z.string(),
  /** Only for kinds core doesn't name: a business's own kinds and add-on kinds. */
  label: z.string().nullable(),
  icon: z.string().nullable(),
  total: z.number().int(),
  capped: z.boolean(),
  /** Whether a windowed kind looked at everything. */
  complete: z.boolean(),
  /** How far back a windowed kind looked. */
  searchedBack: isoDateTime.nullable(),
  unavailable: z.enum(['too_slow', 'skipped', 'failed']).nullable(),
  items: z.array(SearchHit),
});
export type SearchGroup = z.infer<typeof SearchGroup>;

export const SearchProbesOut = z.object({
  looksLike: z.enum(['phone', 'email', 'domain', 'number', 'amount', 'words']),
  phoneE164: z.string().nullable(),
  email: z.string().nullable(),
  number: z.string().nullable(),
});

export const SearchEverythingOutput = z.object({
  q: z.string(),
  tooShort: z.boolean(),
  probes: SearchProbesOut,
  /** The server's groups only; the client adds its Settings group. */
  total: z.number().int(),
  capped: z.boolean(),
  /** Also left in its group; the dropdown takes it out. */
  best: SearchHit.nullable(),
  groups: z.array(SearchGroup),
  archived: SearchGroup.nullable(),
  bin: SearchGroup.nullable(),
  /** The groups are close matches (never when a setting matched). */
  close: z.boolean(),
  /** Only Archived or the bin found something; the client checks Settings too. */
  noneActive: z.boolean(),
});
export type SearchEverythingOutput = z.infer<typeof SearchEverythingOutput>;

export const SearchKindInput = ListInput.extend({
  workspaceId: uuid,
  q: searchText,
  /** Any group kind, and 'archived', 'bin' and 'spam'. */
  kind: SearchKindKey,
  includeArchived: z.boolean().default(false),
  onlyMine: z.boolean().default(false),
  sort: z.enum(['best', 'recent', 'name']).default('best'),
  /** Contacts only: leads or clients. */
  standing: z.enum(['lead', 'client']).optional(),
  /** Windowed kinds: Look further back. */
  before: isoDateTime.optional(),
});
export type SearchKindInput = z.infer<typeof SearchKindInput>;

export const SearchKindOutput = z.object({
  /** This page's items. */
  group: SearchGroup,
  nextCursor: z.string().nullable(),
  standingCounts: z.object({ leads: z.number().int(), clients: z.number().int() }).nullable(),
  duplicates: z.array(
    z.object({
      ids: z.tuple([uuid, uuid]),
      on: z.enum(['phone', 'email']),
      value: z.string(),
      name: z.string(),
    }),
  ),
});
export type SearchKindOutput = z.infer<typeof SearchKindOutput>;
