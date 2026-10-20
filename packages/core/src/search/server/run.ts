/**
 * Running a search (HANDSFREEOS_SEARCH_IMPLEMENTATION_PLAN.md, "Running a search"): which kinds run, each kind's
 * candidates, close matches when nothing else matched, the facts of the winners, then core's ranking. Server only.
 *
 * **Every statement goes through `step`**, and nothing runs outside it: its own savepoint, a statement timeout cut to
 * what's left of the request's budget (never under 50 ms, since Postgres reads 0 as no limit at all), and its errors
 * turned into a marked group or a scrubbed error. A statement that runs out of time rolls back its savepoint alone and
 * marks its kind `too_slow`; a spent budget marks the kinds not yet run `skipped`; only when every kind tried was slow
 * or skipped is the search refused (`search_took_too_long`). Any other database error is thrown again as
 * `search <kind> failed: <SQLSTATE>`, with no message, cause or parameters: Drizzle puts a statement's parameters in
 * its error, and those hold what was typed, which must never reach a log.
 */
import { sql, type SQL } from 'drizzle-orm';
import { rows, type Tx } from '@hfos/db/client';
import { HfosError } from '../../errors';
import { scopeCan } from '../../kernel/execute';
import { decodeCursor, decodeTimeCursor, encodeCursor, listMovedOn } from '../../kernel/pagination';
import type { QueryContext } from '../../kernel/types';
import { missingPermissionMessage, type WorkspacePermission } from '../../permissions';
import type {
  SearchEverythingInput,
  SearchEverythingOutput,
  SearchGroup,
  SearchHit,
  SearchKindInput,
  SearchKindOutput,
} from '../../schemas/search';
import { closeWorthTrying } from '../close';
import { fold } from '../fold';
import { SERVER_SEARCH_KINDS, searchKindEntry, searcherKeyOf, type SearchKind } from '../kinds';
import { probesOut, searchProbes, type SearchProbes } from '../probes';
import { bestOf, orderGroups, rankHits } from '../rank';
import { SEARCH_WORDS } from '../words';
import { SEARCHERS } from './kinds/index';
import { reachOfAll } from './sql';

/** How long a search may take, and each statement in it (How it works, 6). */
export const SEARCH_BUDGETS = {
  quick: { requestMs: 2_000, statementMs: 1_500 },
  full: { requestMs: 6_000, statementMs: 4_000 },
  kind: { requestMs: 8_000, statementMs: 5_000 },
} as const;
export type SearchBudget = { readonly requestMs: number; readonly statementMs: number };

/** The least a statement is given. Postgres reads a timeout of 0 as none at all, so it is never set below this. */
export const MIN_STATEMENT_MS = 50;

/** Candidate rows a kind reads for the box and the page: enough to count to "100+". */
export const COUNT_ROWS = 101;
/** Candidate rows a kind's own page ranks and pages through. */
export const KIND_ROWS = 500;

/** Why a statement didn't answer: it ran out of time, or the budget was spent before it ran. */
export class SearchStopped extends Error {
  constructor(readonly why: 'too_slow' | 'skipped') {
    super(`search ${why}`);
    this.name = 'SearchStopped';
  }
}

/** A SQLSTATE from an error or anything in its `cause` chain, as `translateDbError` reads codes. */
export function sqlStateOf(e: unknown): string | null {
  let err: unknown = e;
  for (let depth = 0; err && depth < 10; depth++) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code;
    err = (err as { cause?: unknown }).cause;
  }
  return null;
}

/** A search that failed, saying only where and its SQLSTATE: no message, no cause, no parameters. */
export class SearchFailed extends Error {
  constructor(kind: string, code: string | null) {
    super(`search ${kind} failed: ${code ?? 'unknown'}`);
    this.name = 'SearchFailed';
  }
}

/** An error with nothing of the statement in it. */
export function scrubbed(kind: string, e: unknown): SearchFailed {
  return new SearchFailed(kind, sqlStateOf(e));
}

/** How a searcher reads: each statement through `step`, so a timeout throws `SearchStopped` for its kind alone. */
export interface SearchDb {
  rows<T extends Record<string, unknown>>(query: SQL): Promise<T[]>;
  /** For a read that isn't one `sql` statement (knowledge's own search): still one savepoint and one timeout. */
  run<T>(fn: (sp: Tx) => Promise<T>): Promise<T>;
}

/** What a searcher is asked for. */
export interface SearchPlan {
  readonly ctx: QueryContext;
  readonly workspaceId: string;
  /** Who is searching (the teammate, under a teammate view), for Only mine. */
  readonly me: string | null;
  readonly p: SearchProbes;
  readonly mode: 'everything' | 'kind';
  /** The windows' size: the box's (quick), or the Search page's and a kind's own page's (full). */
  readonly depth: 'quick' | 'full';
  readonly perKind: number;
  /** Candidate rows to read. */
  readonly limit: number;
  readonly sort: 'best' | 'recent' | 'name';
  readonly includeArchived: boolean;
  /** Archived records only, for the Archived kind's own page. */
  readonly archivedOnly: boolean;
  readonly onlyMine: boolean;
  readonly before: string | null;
  /** The group kinds asked for (`record.pets`), or null for all of them. */
  readonly kinds: ReadonlySet<string> | null;
  /** Whether the person holds a permission; true for everything under a staff view-as, where row security decides. */
  readonly can: (permission: WorkspacePermission) => boolean;
}

/** One group of hits a searcher found, every candidate it read. */
export interface FoundGroup {
  readonly kind: string;
  readonly label: string | null;
  readonly icon: string | null;
  readonly hits: SearchHit[];
  /** Whether a windowed kind looked at everything, and how far back. */
  readonly complete?: boolean;
  readonly searchedBack?: string | null;
  /** The searcher read as many as it reads at most (knowledge's 20), so there may be more than it found. */
  readonly capped?: boolean;
}

export interface KindSearcher {
  /** Its entry in `SEARCH_KINDS`, which holds its gate. A searcher carries no gate of its own. */
  readonly key: string;
  /** The candidates, as hits ranked by core: tier, why, title, link. */
  find(db: SearchDb, plan: SearchPlan): Promise<FoundGroup[]>;
  /** The facts of the hits that will be shown, and nothing more. */
  facts?(db: SearchDb, plan: SearchPlan, hits: readonly SearchHit[]): Promise<SearchHit[]>;
}

export interface RunOptions {
  /** Every kind by default; tests pass a slow or failing one. */
  readonly searchers?: readonly KindSearcher[];
  /** The budget, for tests; by default the depth's. */
  readonly budget?: SearchBudget;
  /** Sees each statement's timeout, for tests. */
  readonly onStatement?: (kind: string, timeoutMs: number) => void;
}

/** The guard every statement goes through. */
function stepper(ctx: QueryContext, budget: SearchBudget, opts: RunOptions) {
  const deadline = Date.now() + budget.requestMs;
  const left = () => deadline - Date.now();
  async function step<T>(kind: string, run: (sp: Tx) => Promise<T>): Promise<T> {
    const remaining = left();
    if (remaining < MIN_STATEMENT_MS) throw new SearchStopped('skipped');
    const ms = Math.max(MIN_STATEMENT_MS, Math.min(budget.statementMs, Math.floor(remaining)));
    opts.onStatement?.(kind, ms);
    try {
      return await ctx.tx.transaction(async (sp) => {
        await sp.execute(sql`select set_config('statement_timeout', ${`${ms}ms`}, true)`);
        return run(sp);
      });
    } catch (e) {
      if (e instanceof HfosError || e instanceof SearchStopped || e instanceof SearchFailed)
        throw e;
      if (sqlStateOf(e) === '57014') throw new SearchStopped('too_slow');
      throw scrubbed(kind, e);
    }
  }
  const dbFor = (kind: string): SearchDb => ({
    rows: <T extends Record<string, unknown>>(query: SQL) => step(kind, (sp) => rows<T>(sp, query)),
    run: <T>(fn: (sp: Tx) => Promise<T>) => step(kind, fn),
  });
  return { dbFor, left };
}

/**
 * A group with nothing in it, marked with why it didn't answer. Core names its own kinds, `records` (the business's
 * own kinds together) included, so it carries no label.
 */
function unavailableGroup(kind: string, why: 'too_slow' | 'skipped' | 'failed'): SearchGroup {
  return {
    kind,
    label: null,
    icon: null,
    total: 0,
    capped: false,
    complete: false,
    searchedBack: null,
    unavailable: why,
    items: [],
  };
}

const toGroup = (
  f: FoundGroup,
  items: SearchHit[],
  count: number,
  cap: number,
  unavailable: SearchGroup['unavailable'] = null,
): SearchGroup => ({
  kind: f.kind,
  label: f.label,
  icon: f.icon,
  total: Math.min(count, cap - 1),
  capped: count >= cap || !!f.capped,
  complete: f.complete ?? true,
  searchedBack: f.searchedBack ?? null,
  unavailable,
  items,
});

/** Whether the person may search a kind; under a staff view-as row security alone decides. */
const gateOf =
  (ctx: QueryContext) =>
  (permission: WorkspacePermission): boolean =>
    !!ctx.scope.viewAs || scopeCan(ctx.scope, permission);

/** The searchers that answer a search, in kind order, each once. */
function searchersFor(
  all: readonly KindSearcher[],
  allowed: (k: SearchKind) => boolean,
  keys: ReadonlySet<string> | null,
): KindSearcher[] {
  return SERVER_SEARCH_KINDS.filter((k) => allowed(k) && (!keys || keys.has(k.key)))
    .map((k) => all.find((s) => s.key === k.key))
    .filter((s): s is KindSearcher => !!s);
}

/** The facts of the shown hits, by the searcher each came from; a step that fails keeps the hits without them. */
async function withFacts(
  searcher: KindSearcher | undefined,
  db: SearchDb,
  plan: SearchPlan,
  hits: SearchHit[],
): Promise<{ hits: SearchHit[]; unavailable: SearchGroup['unavailable'] }> {
  if (!searcher?.facts || hits.length === 0) return { hits, unavailable: null };
  try {
    return { hits: await searcher.facts(db, plan, hits), unavailable: null };
  } catch (e) {
    if (e instanceof HfosError) throw e;
    return { hits, unavailable: e instanceof SearchStopped ? e.why : 'failed' };
  }
}

const emptyAnswer = (p: SearchProbes): SearchEverythingOutput => ({
  q: p.q,
  tooShort: p.tooShort,
  probes: probesOut(p),
  total: 0,
  capped: false,
  best: null,
  groups: [],
  archived: null,
  bin: null,
  close: false,
  noneActive: false,
});

const tooLong = () => HfosError.rule('search_took_too_long', 503, SEARCH_WORDS.tookTooLong);

const isArchived = (h: SearchHit) => h.badges.includes('archived');

/** `search.everything`: every kind the person may search, a few hits each. */
export async function runSearchEverything(
  ctx: QueryContext,
  input: SearchEverythingInput,
  opts: RunOptions = {},
): Promise<SearchEverythingOutput> {
  const p = searchProbes(input.q);
  if (p.tooShort) return emptyAnswer(p);
  const all = opts.searchers ?? SEARCHERS;
  const can = gateOf(ctx);
  const { dbFor } = stepper(ctx, opts.budget ?? SEARCH_BUDGETS[input.depth], opts);
  const kinds = input.kinds?.length ? new Set(input.kinds) : null;
  const plan: SearchPlan = {
    ctx,
    workspaceId: input.workspaceId,
    me: ctx.actor.type === 'human' ? ctx.actor.userId : null,
    p,
    mode: 'everything',
    depth: input.depth,
    perKind: input.perKind,
    limit: COUNT_ROWS,
    sort: 'best',
    includeArchived: input.includeArchived,
    archivedOnly: false,
    onlyMine: input.onlyMine,
    before: null,
    kinds,
    can,
  };
  const keys = kinds ? new Set([...kinds].map(searcherKeyOf)) : null;
  // Spam only when it's picked by name (decision 9).
  const running = searchersFor(
    all,
    (k) => can(k.needs) && k.key !== 'close' && (!k.picked || !!keys?.has(k.key)),
    keys,
  );

  // 3. Every kind's candidates, in kind order. A kind stopped for time is marked, and the rest still run.
  const found: { searcher: KindSearcher; f: FoundGroup; active: SearchHit[] }[] = [];
  const stoppedGroups: SearchGroup[] = [];
  const archived: SearchHit[] = [];
  let binStopped: SearchGroup | null = null;
  let tried = 0;
  let stopped = 0;
  for (const searcher of running) {
    tried++;
    let groups: FoundGroup[];
    try {
      groups = await searcher.find(dbFor(searcher.key), plan);
    } catch (e) {
      if (!(e instanceof SearchStopped)) throw e;
      stopped++;
      if (searcher.key === 'bin') binStopped = unavailableGroup('bin', e.why);
      else stoppedGroups.push(unavailableGroup(searcher.key, e.why));
      continue;
    }
    for (const f of groups) {
      const ranked = rankHits(f.hits);
      if (!input.includeArchived) archived.push(...ranked.filter(isArchived));
      const active = input.includeArchived ? ranked : ranked.filter((h) => !isArchived(h));
      found.push({ searcher, f, active });
    }
  }

  // 5. Close matches, only when nothing at all matched (the bin and Archived included), every kind answered, no
  // setting matched on the device, and a word is long enough.
  let closeGroup: SearchGroup | null = null;
  const closeSearcher = all.find((s) => s.key === 'close');
  const nothing =
    found.every((x) => x.active.length === 0) &&
    archived.length === 0 &&
    stoppedGroups.length === 0 &&
    !binStopped;
  const closeKind = searchKindEntry('close');
  if (
    nothing &&
    !input.settingsMatched &&
    closeSearcher &&
    closeKind &&
    can(closeKind.needs) &&
    closeWorthTrying(p.folded) &&
    // The box's Close matches chip asks for them by name.
    (!keys || ['contacts', 'companies', 'leads', 'records', 'close'].some((k) => keys.has(k)))
  ) {
    tried++;
    try {
      const [close] = await closeSearcher.find(dbFor('close'), plan);
      if (close && close.hits.length)
        closeGroup = toGroup(
          close,
          close.hits.slice(0, input.perKind),
          close.hits.length,
          COUNT_ROWS,
        );
    } catch (e) {
      if (!(e instanceof SearchStopped)) throw e;
      stopped++;
    }
  }
  if (tried > 0 && stopped === tried) throw tooLong();

  // 6. The facts of the hits that will be shown, last: a step that fails here marks its group, never the request.
  const groups: SearchGroup[] = [...stoppedGroups, ...(closeGroup ? [closeGroup] : [])];
  let bin: SearchGroup | null = binStopped;
  for (const { searcher, f, active } of found) {
    const shown = await withFacts(
      searcher,
      dbFor(searcher.key),
      plan,
      active.slice(0, input.perKind),
    );
    const group = toGroup(f, shown.hits, active.length, COUNT_ROWS, shown.unavailable);
    if (searcher.key === 'bin') bin = group;
    else if (group.items.length || group.unavailable) groups.push(group);
  }

  const ordered = orderGroups(groups);
  const answered = ordered.filter((g) => g.items.length > 0);
  const archivedRanked = rankHits(archived);
  const archivedGroup: SearchGroup | null = archivedRanked.length
    ? {
        kind: 'archived',
        label: null,
        icon: null,
        total: Math.min(archivedRanked.length, COUNT_ROWS - 1),
        capped: archivedRanked.length >= COUNT_ROWS,
        complete: true,
        searchedBack: null,
        unavailable: null,
        items: archivedRanked.slice(0, input.perKind),
      }
    : null;
  const total = answered.reduce((n, g) => n + g.total, 0);
  const close = !!closeGroup;
  // "No one active matches" only when every kind answered: a kind that wasn't searched may hold someone.
  const everyKindAnswered = stoppedGroups.length === 0;
  return {
    q: p.q,
    tooShort: false,
    probes: probesOut(p),
    total,
    capped: answered.some((g) => g.capped),
    best: close ? null : bestOf(answered),
    groups: ordered,
    archived: archivedGroup,
    bin: bin && (bin.items.length || bin.unavailable) ? bin : null,
    close,
    noneActive: total === 0 && everyKindAnswered && !!(archivedGroup || bin?.items.length),
  };
}

/** The kinds the Archived page looks in: whatever can be archived. */
const ARCHIVED_KINDS: readonly string[] = [
  'contacts',
  'companies',
  'leads',
  'messages',
  'forms',
  'records',
];

const kindGone = () => HfosError.rule('search_kind_gone', 404, SEARCH_WORDS.kindGone);

/** A cursor's place in hits sorted most recent first, by (at, id). */
const EPOCH = new Date(0).toISOString();
const atOf = (h: SearchHit) => h.at ?? EPOCH;
const nameKey = (h: SearchHit) => fold(h.title);

/** Hits in a kind page's order. */
function sorted(hits: SearchHit[], sort: SearchPlan['sort']): SearchHit[] {
  if (sort === 'best') return rankHits(hits);
  if (sort === 'recent')
    return [...hits].sort((a, b) =>
      atOf(a) === atOf(b) ? b.id.localeCompare(a.id) : Date.parse(atOf(b)) - Date.parse(atOf(a)),
    );
  return [...hits].sort((a, b) =>
    nameKey(a) === nameKey(b) ? a.id.localeCompare(b.id) : nameKey(a) < nameKey(b) ? -1 : 1,
  );
}

/** Where a page starts in the sorted hits, from its cursor. A cursor that doesn't fit is `listMovedOn`. */
function startOf(hits: readonly SearchHit[], sort: SearchPlan['sort'], cursor?: string): number {
  if (!cursor) return 0;
  if (sort === 'best') {
    const c = decodeCursor(cursor);
    if (!c || c.sort !== 'best' || !/^\d{1,3}$/.test(c.id) || Number(c.id) >= KIND_ROWS)
      throw listMovedOn();
    return Number(c.id);
  }
  if (sort === 'recent') {
    const c = decodeTimeCursor(cursor)!;
    const at = Date.parse(c.sort);
    const i = hits.findIndex(
      (h) => Date.parse(atOf(h)) < at || (Date.parse(atOf(h)) === at && h.id < c.id),
    );
    return i < 0 ? hits.length : i;
  }
  const c = decodeCursor(cursor)!;
  const i = hits.findIndex((h) => nameKey(h) > c.sort || (nameKey(h) === c.sort && h.id > c.id));
  return i < 0 ? hits.length : i;
}

/** The cursor for the page after the one ending at `end`. */
function cursorAfter(
  hits: readonly SearchHit[],
  sort: SearchPlan['sort'],
  end: number,
): string | null {
  if (end >= hits.length) return null;
  const last = hits[end - 1];
  if (!last) return null;
  if (sort === 'best') return encodeCursor({ sort: 'best', id: String(end) });
  if (sort === 'recent') return encodeCursor({ sort: atOf(last), id: last.id });
  return encodeCursor({ sort: nameKey(last), id: last.id });
}

/** Contacts sharing a phone or an email on one page: the banner's pairs. */
function duplicatesOf(hits: readonly SearchHit[]): SearchKindOutput['duplicates'] {
  const out: SearchKindOutput['duplicates'] = [];
  const seen = new Set<string>();
  for (const on of ['phone', 'email'] as const) {
    const first = new Map<string, SearchHit>();
    for (const h of hits) {
      if (h.kind !== 'contacts' || !h.contact) continue;
      const value = on === 'phone' ? h.contact.phoneE164 : h.contact.email?.toLowerCase();
      if (!value) continue;
      const before = first.get(value);
      if (!before) {
        first.set(value, h);
        continue;
      }
      const pair = [before.id, h.id].sort().join(':');
      if (seen.has(pair)) continue;
      seen.add(pair);
      out.push({
        ids: [before.id, h.id],
        on,
        value: on === 'phone' ? (h.facts.phone ?? value) : value,
        name: before.title,
      });
    }
  }
  return out;
}

/** `search.kind`: one kind, a page at a time. */
export async function runSearchKind(
  ctx: QueryContext,
  input: SearchKindInput,
  opts: RunOptions = {},
): Promise<SearchKindOutput> {
  const all = opts.searchers ?? SEARCHERS;
  const can = gateOf(ctx);
  const archivedPage = input.kind === 'archived';
  const key = archivedPage ? null : searcherKeyOf(input.kind);
  const entry = key ? searchKindEntry(key) : null;
  if (!archivedPage && (!entry || entry.where !== 'server')) throw kindGone();
  if (entry && !can(entry.needs))
    throw HfosError.forbidden(
      missingPermissionMessage(entry.needs, ctx.scope.workspaceRole),
      'search_kind_not_allowed',
    );
  const running = archivedPage
    ? searchersFor(all, (k) => ARCHIVED_KINDS.includes(k.key) && can(k.needs), null)
    : all.filter((s) => s.key === key);
  if (!running.length) throw kindGone();

  const p = searchProbes(input.q);
  const label = archivedPage ? null : (entry?.label ?? null);
  const empty = (group: Partial<SearchGroup> = {}): SearchKindOutput => ({
    group: {
      kind: input.kind,
      label,
      icon: null,
      total: 0,
      capped: false,
      complete: true,
      searchedBack: null,
      unavailable: null,
      items: [],
      ...group,
    },
    nextCursor: null,
    standingCounts: input.kind === 'contacts' ? { leads: 0, clients: 0 } : null,
    duplicates: [],
  });
  if (p.tooShort) return empty();

  const { dbFor } = stepper(ctx, opts.budget ?? SEARCH_BUDGETS.kind, opts);
  const plan: SearchPlan = {
    ctx,
    workspaceId: input.workspaceId,
    me: ctx.actor.type === 'human' ? ctx.actor.userId : null,
    p,
    mode: 'kind',
    depth: 'full',
    perKind: input.limit,
    limit: KIND_ROWS + 1,
    sort: input.sort,
    includeArchived: archivedPage || input.includeArchived,
    archivedOnly: archivedPage,
    onlyMine: input.onlyMine,
    before: input.before ?? null,
    kinds: archivedPage ? null : new Set([input.kind]),
    can,
  };

  let found: FoundGroup[] = [];
  let stopped = 0;
  // On the Archived page, a kind that ran out of time leaves the page marked, rather than quietly short.
  let firstStopped: SearchStopped['why'] | null = null;
  const from = new Map<SearchHit, KindSearcher>();
  for (const searcher of running) {
    try {
      const groups = await searcher.find(dbFor(searcher.key), plan);
      for (const g of groups) for (const h of g.hits) from.set(h, searcher);
      found = found.concat(groups);
    } catch (e) {
      if (!(e instanceof SearchStopped)) throw e;
      stopped++;
      firstStopped = firstStopped ?? e.why;
    }
  }
  if (stopped === running.length) throw tooLong();
  const mine = archivedPage ? null : found.find((g) => g.kind === input.kind);
  // A kind of record that's gone, or hidden with its add-on, answers no group at all.
  if (!archivedPage && !mine) throw kindGone();

  // The Archived page's windowed kinds (threads) say how far back they looked, as a kind's page does; Look further
  // back reads on only in those, since the rest showed everything the first time.
  const archivedFrom = archivedPage
    ? found.filter((g) => !plan.before || g.complete !== undefined)
    : [];
  const archivedReach = archivedPage
    ? reachOfAll(
        archivedFrom.map((g) => ({
          complete: g.complete ?? true,
          searchedBack: g.searchedBack ?? null,
        })),
      )
    : null;
  let hits = archivedPage ? archivedFrom.flatMap((g) => g.hits).filter(isArchived) : mine!.hits;
  let standingCounts: SearchKindOutput['standingCounts'] = null;
  if (input.kind === 'contacts') {
    const counts = standingOf(hits);
    standingCounts = counts;
    if (input.standing)
      hits = hits.filter((h) => h.badges.includes(input.standing === 'client' ? 'client' : 'lead'));
  }
  // Close matches come in their own best order, names close on every word first (decision 26), which ranking by tier
  // and time would undo: every one is tier 5.
  const ordered = input.kind === 'close' && input.sort === 'best' ? hits : sorted(hits, input.sort);
  const start = startOf(ordered, input.sort, input.cursor);
  const end = Math.min(ordered.length, start + input.limit, KIND_ROWS);
  const pageHits = ordered.slice(start, end);

  // Facts for this page only, from the searcher each hit came from.
  const filled: SearchHit[] = [];
  let unavailable: SearchGroup['unavailable'] = firstStopped;
  for (const searcher of running) {
    const own = pageHits.filter((h) => from.get(h) === searcher);
    const done = await withFacts(searcher, dbFor(searcher.key), plan, own);
    unavailable = unavailable ?? done.unavailable;
    filled.push(...done.hits);
  }
  const byId = new Map(filled.map((h) => [`${h.kind}:${h.id}`, h]));
  const items = pageHits.map((h) => byId.get(`${h.kind}:${h.id}`) ?? h);

  return {
    group: {
      kind: input.kind,
      label: mine?.label ?? label,
      icon: mine?.icon ?? null,
      total: Math.min(ordered.length, KIND_ROWS),
      capped: ordered.length > KIND_ROWS || !!mine?.capped,
      complete: firstStopped ? false : (archivedReach?.complete ?? mine?.complete ?? true),
      searchedBack: archivedReach ? archivedReach.searchedBack : (mine?.searchedBack ?? null),
      unavailable,
      items,
    },
    nextCursor:
      end < Math.min(ordered.length, KIND_ROWS) ? cursorAfter(ordered, input.sort, end) : null,
    standingCounts,
    duplicates: input.kind === 'contacts' ? duplicatesOf(items) : [],
  };
}

/** Leads and clients among the contacts found: the contacts searcher marks each with its badge. */
function standingOf(hits: readonly SearchHit[]): { leads: number; clients: number } {
  const clients = hits.filter((h) => h.badges.includes('client')).length;
  return { leads: hits.length - clients, clients };
}

/** Runs a search: everything, or one kind when the input names one. */
export function runSearch(
  ctx: QueryContext,
  input: SearchEverythingInput,
  opts?: RunOptions,
): Promise<SearchEverythingOutput>;
export function runSearch(
  ctx: QueryContext,
  input: SearchKindInput,
  opts?: RunOptions,
): Promise<SearchKindOutput>;
export function runSearch(
  ctx: QueryContext,
  input: SearchEverythingInput | SearchKindInput,
  opts: RunOptions = {},
): Promise<SearchEverythingOutput | SearchKindOutput> {
  return 'kind' in input ? runSearchKind(ctx, input, opts) : runSearchEverything(ctx, input, opts);
}
