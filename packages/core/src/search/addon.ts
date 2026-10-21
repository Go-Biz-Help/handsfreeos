/**
 * Add-ons answer searches (HANDSFREEOS_SEARCH_IMPLEMENTATION_PLAN.md, "Add-ons answer searches"), browser-safe: what
 * an add-on's search query takes and answers, its kinds as the chips and the kinds list show them, and which of its
 * links core lets through. An add-on gets core's probes rather than the text to read its own way, escapes with
 * `escapeLike`, and ranks and marks with `tierOf`, `marksIn` and `snippetOf`, so its groups sit on the one scale
 * core's do.
 *
 * Core runs the query (`search/server/addons.ts`): inside `search.everything` and `search.kind`, through the kernel,
 * under their rate limit and slot gate, with a failure kept to the add-on's own groups.
 */
import { z } from 'zod';
import type { AddonManifest } from '../addons/manifest';
import type { WorkspacePermission } from '../permissions';
import { isoDateTime, uuid } from '../schemas/common';
import type { SearchKind } from './kinds';

/** Core's probes (`searchProbes`), as an add-on's search query takes them: everything but what was typed. */
export const AddonSearchProbes = z.object({
  tooShort: z.boolean(),
  looksLike: z.enum(['phone', 'email', 'domain', 'number', 'amount', 'words']),
  words: z.array(z.string()).max(60),
  folded: z.array(z.string()).max(60),
  likes: z.array(z.string()).max(60),
  folds: z.array(z.string()).max(60),
  starts: z.array(z.string()).max(60),
  phoneE164: z.string().nullable(),
  email: z.string().nullable(),
  domain: z.string().nullable(),
  digits: z.string().nullable(),
  number: z
    .object({ text: z.string(), prefix: z.string(), counter: z.string().nullable() })
    .nullable(),
  amount: z.number().int().nullable(),
  card4: z.string().nullable(),
  firstWord: z.string().nullable(),
  tsq: z.string().max(4000).nullable(),
});

/**
 * What core asks an add-on's search query. Its `input` must be this very object (`addonSearchIssues`), so every
 * add-on is asked the same way.
 */
export const AddonSearchInput = z.object({
  workspaceId: uuid,
  probes: AddonSearchProbes,
  /** Its kinds asked for (`listings`, as its manifest names them); every one when left out. */
  kinds: z.array(z.string().max(31)).max(30).optional(),
  /** The hits a kind shows. One more says there are more. */
  perKind: z.number().int().min(1).max(100),
  includeArchived: z.boolean(),
  onlyMine: z.boolean(),
  /** The box's (quick), or the Search page's and a kind's own page's (full). */
  depth: z.enum(['quick', 'full']),
  /** A kind's own page: its order, and where its page starts (the add-on's own `nextCursor`). */
  sort: z.enum(['best', 'recent', 'name']).optional(),
  /** Up to 400 characters, as `search.kind` takes it back. */
  cursor: z.string().max(400).optional(),
});
export type AddonSearchInput = z.infer<typeof AddonSearchInput>;

/** A snippet as `snippetOf` cuts one, about 200 characters: a row never carries a whole body. */
const AddonSearchSnippet = z.object({
  text: z.string().max(300),
  marks: z.array(z.tuple([z.number().int(), z.number().int()])).max(300),
});

/** One hit, ranked with core's tiers. */
export const AddonSearchHit = z.object({
  /** Its own id: the row it found (a listing). */
  id: uuid,
  title: z.string().min(1).max(200),
  subtitle: z.string().max(300).nullable(),
  /** As core's hits carry them: `archived` (only with `includeArchived`), `won`, `lost`… */
  badges: z.array(z.string().max(40)).max(10),
  why: z.object({
    /** Its own chip ("MLS number"); none for a plain name match. */
    label: z.string().max(40).nullable(),
    snippet: AddonSearchSnippet.nullable(),
  }),
  exact: z.boolean(),
  tier: z.number().int().min(0).max(5),
  at: isoDateTime.nullable(),
  /**
   * Where it opens, under the business: one of its own pages (`/a/<id>/…`), or the page of the record it's about
   * (`/customers/records/<recordId>`). Core drops a hit with any other link.
   */
  href: z.string().max(500),
  /** The record of its own kinds the hit is about, when there is one. */
  recordId: uuid.nullable(),
});
export type AddonSearchHit = z.infer<typeof AddonSearchHit>;

/** What an add-on's search query answers: a group for each of its kinds that found something. Its `output` too. */
export const AddonSearchOutput = z.object({
  groups: z
    .array(
      z.object({
        /** One of its kinds (`listings`). */
        kind: z.string().max(31),
        total: z.number().int().min(0),
        capped: z.boolean(),
        /** A kind's own page: where the next page starts, or null. Up to 400 characters, as `cursor`. */
        nextCursor: z.string().max(400).nullable(),
        items: z.array(AddonSearchHit).max(101),
      }),
    )
    .max(20),
});
export type AddonSearchOutput = z.infer<typeof AddonSearchOutput>;

/** An add-on's group kind, as the chips and `search.kind` name it: `realestate.listings`. */
export const addonSearchKindKey = (addonId: string, key: string): string => `${addonId}.${key}`;

/** An add-on's search kind, as `searchKindsFor` lists it beside core's. */
export interface AddonSearchKind extends SearchKind {
  readonly addon: { readonly id: string; readonly name: string };
  readonly icon: string;
}

/** The kinds an add-on's search adds, in its manifest's order. None when it doesn't answer searches. */
export function addonSearchKinds(
  m: Pick<AddonManifest, 'id' | 'name' | 'search'>,
): AddonSearchKind[] {
  const s = m.search;
  if (!s) return [];
  return s.kinds.map((k) => ({
    key: addonSearchKindKey(m.id, k.key),
    label: k.plural,
    // One of its own permissions, which the kernel checks as it checks core's.
    needs: s.permission as WorkspacePermission,
    offline: false,
    windowed: false,
    where: 'server',
    chip: true,
    picked: false,
    addon: { id: m.id, name: m.name },
    icon: k.icon,
  }));
}

const RECORD_PAGE =
  /^\/customers\/records\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:[?#]|$)/i;

/**
 * Whether a part of a link's path leaves its place as a browser reads it, which takes "%2e%2e" for "..": `.`, `..`,
 * or a slash or a backslash once decoded, and a part that doesn't decode.
 */
function leavesItsPlace(part: string): boolean {
  try {
    const read = decodeURIComponent(part);
    return read === '.' || read === '..' || /[/\\]/.test(read);
  } catch {
    return true;
  }
}

/**
 * Whether core lets a hit's link through (as alerts are held to their add-on's own pages): one of the add-on's own
 * pages, or the page of the record the hit is about. Never a way out of the business's pages (`..` however it's
 * written, a backslash, spaces), and never another add-on's.
 */
export function addonHrefOk(
  addonId: string,
  hit: Pick<AddonSearchHit, 'href' | 'recordId'>,
): boolean {
  const { href } = hit;
  const path = href.split(/[?#]/, 1)[0]!;
  if (/[\s\\]/.test(href) || path.split('/').some(leavesItsPlace)) return false;
  if (path === `/a/${addonId}` || path.startsWith(`/a/${addonId}/`)) return true;
  const record = RECORD_PAGE.exec(href);
  return !!record && !!hit.recordId && record[1]!.toLowerCase() === hit.recordId.toLowerCase();
}
