/**
 * The Deals list from a phone's copy (Real Estate round six, step 13): what `realestate.deal.list` answers, worked out
 * from the rows the phone keeps (`records_v1`), so a deal reads the same with no signal.
 *
 * The phone holds tables, not answers: the deal records, Real Estate's rows as JSON (`addon_phone_rows`: deals,
 * duties, terms), the links (a client, a home) and the business's people and members. Every column arrives as text
 * or 0/1 and any may be null. `packages/core/test/addons/realestate-phone-views.test.ts` holds this to the server's
 * answer, row for row, for each of the list's filters.
 *
 * Browser-safe and pure: the time, the person and the business's today come in.
 */
import type { DealListInput, DealListOutput } from '../schemas';
import { OPEN_DUTY_STATUSES, STAGE_LABELS, type DealSide, type DealStage } from '../states';
import type { z } from 'zod';

export type DealListItem = z.infer<typeof DealListOutput>['deals'][number];
export type DealListFilter = Partial<Omit<z.input<typeof DealListInput>, 'workspaceId'>>;

/** Every synced column reads as text, an integer or nothing. */
export type Cell = string | number | null | undefined;

/** A deal record (`custom_records` of the deal kind). */
export interface SyncedDealRecord {
  readonly id: Cell;
  readonly name: Cell;
  readonly archived_at: Cell;
  readonly owner_user_id: Cell;
  readonly team_user_ids: Cell;
  readonly updated_at: Cell;
}

/** One of Real Estate's rows (`addon_phone_rows`): `id` is `<source>:<the row's key>`, `data` its columns as JSON. */
export interface SyncedPhoneRow {
  readonly id: Cell;
  readonly source: Cell;
  readonly record_id: Cell;
  readonly data: Cell;
}

/** A link (`relationships`), with its kind's `addon_key`. */
export interface SyncedLink {
  readonly id: Cell;
  readonly addon_key: Cell;
  readonly a_person_id: Cell;
  readonly a_custom_record_id: Cell;
  readonly b_custom_record_id: Cell;
  readonly created_at: Cell;
}

export interface SyncedPerson {
  readonly id: Cell;
  readonly first_name: Cell;
  readonly last_name: Cell;
  readonly email: Cell;
}

export interface SyncedUser {
  readonly id: Cell;
  readonly full_name: Cell;
  readonly email: Cell;
}

/** A record's name by its id: a home's address. */
export interface SyncedRecordName {
  readonly id: Cell;
  readonly name: Cell;
}

export interface DealListSource {
  readonly records: readonly SyncedDealRecord[];
  readonly rows: readonly SyncedPhoneRow[];
  readonly links: readonly SyncedLink[];
  readonly people: readonly SyncedPerson[];
  readonly users: readonly SyncedUser[];
  /** Records the links point at (homes); deal records may be among them. */
  readonly recordNames: readonly SyncedRecordName[];
}

export interface DealListContext {
  /** Whoever is looking: "mine" is the deals they're on. */
  readonly userId: string | null;
  readonly now: number;
  /** The business's today (YYYY-MM-DD), for closing within so many days. */
  readonly today: string;
}

// ---------- reading cells ----------

const text = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  const s = String(v);
  return s === '' ? null : s;
};
const ms = (v: unknown): number | null => {
  const s = text(v);
  if (!s) return null;
  // PowerSync's "2026-10-03 14:31:03.785Z", Postgres's "…+00", or JSON's "…T…+00:00".
  const t = Date.parse(s.replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00'));
  return Number.isNaN(t) ? null : t;
};
const iso = (t: number) => new Date(t).toISOString();
const json = (v: Cell): unknown => {
  const s = text(v);
  if (!s) return null;
  try {
    return JSON.parse(s) as unknown;
  } catch {
    return null;
  }
};
const obj = (v: Cell): Record<string, unknown> => {
  const parsed = json(v);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
};
const ids = (v: Cell): string[] => {
  const parsed = json(v);
  return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
};
/** The row's own key, after `<source>:`. */
const keyOf = (id: Cell) => {
  const s = text(id) ?? '';
  return s.slice(s.indexOf(':') + 1);
};
/** Postgres's `a || ' ' || b`, trimmed: nothing when either is missing. */
const joined = (a: Cell, b: Cell) => {
  if (a === null || a === undefined || b === null || b === undefined) return null;
  return text(`${String(a)} ${String(b)}`.trim());
};
const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

const OPEN = new Set<string>(OPEN_DUTY_STATUSES);
const WAITING = {
  outside: ['waiting_external'],
  blocked: ['blocked'],
  either: ['waiting_external', 'blocked'],
};

interface Duty {
  id: string;
  title: string;
  status: string;
  dueAt: number | null;
  /** When it's next chased or its blocker looked at again. */
  nextLook: number | null;
  who: string | null;
}

interface Term {
  id: string;
  key: string;
  date: string | null;
  enteredAt: number;
  confirmed: boolean;
  live: boolean;
}

/** Every deal the phone holds, as the list shows them; then `filterDeals` for a filter. */
export function dealListOfSynced(
  source: DealListSource,
  filter: DealListFilter,
  ctx: DealListContext,
): DealListItem[] {
  const users = new Map(
    source.users.map((u) => [text(u.id) ?? '', text(u.full_name) ?? text(u.email)]),
  );
  const people = new Map(
    source.people.map((p) => [
      text(p.id) ?? '',
      joined(p.first_name, p.last_name) ?? text(p.email) ?? 'Customer',
    ]),
  );
  const recordNames = new Map(source.recordNames.map((r) => [text(r.id) ?? '', text(r.name)]));

  const dealData = new Map<string, Record<string, unknown>>();
  const duties = new Map<string, Duty[]>();
  const terms = new Map<string, Term[]>();
  for (const row of source.rows) {
    const record = text(row.record_id);
    if (!record) continue;
    const d = obj(row.data);
    switch (text(row.source)) {
      case 'deals':
        dealData.set(record, d);
        break;
      case 'duties': {
        const list = duties.get(record) ?? [];
        list.push({
          id: keyOf(row.id),
          title: text(d.title) ?? '',
          status: text(d.status) ?? '',
          dueAt: ms(d.due_at),
          nextLook: ms(d.chase_at) ?? ms(d.blocker_review_at),
          who: text(d.waiting_on) ?? text(d.blocker_owner) ?? text(d.blocker),
        });
        duties.set(record, list);
        break;
      }
      case 'term_entries': {
        const list = terms.get(record) ?? [];
        list.push({
          id: keyOf(row.id),
          key: text(d.key) ?? '',
          date: text(d.value_date),
          enteredAt: ms(d.entered_at) ?? 0,
          confirmed: d.confirmed_at !== null && d.confirmed_at !== undefined,
          live:
            (d.superseded_at === null || d.superseded_at === undefined) &&
            (d.rejected_at === null || d.rejected_at === undefined),
        });
        terms.set(record, list);
        break;
      }
    }
  }

  // A deal's first client, and its latest home.
  const clients = new Map<string, { personId: string; at: number; id: string }>();
  const homes = new Map<string, { propertyId: string; at: number; id: string }>();
  for (const l of source.links) {
    const key = text(l.addon_key);
    const id = text(l.id) ?? '';
    const at = ms(l.created_at) ?? 0;
    if (key === 'realestate_client') {
      const deal = text(l.b_custom_record_id);
      const person = text(l.a_person_id);
      if (!deal || !person) continue;
      const was = clients.get(deal);
      if (!was || at < was.at || (at === was.at && byText(id, was.id) < 0))
        clients.set(deal, { personId: person, at, id });
    } else if (key === 'realestate_property_of') {
      const deal = text(l.a_custom_record_id);
      const home = text(l.b_custom_record_id);
      if (!deal || !home) continue;
      const was = homes.get(deal);
      if (!was || at > was.at || (at === was.at && byText(id, was.id) > 0))
        homes.set(deal, { propertyId: home, at, id });
    }
  }

  const all: (DealListItem & { open: boolean; at: number })[] = [];
  for (const r of source.records) {
    const id = text(r.id);
    const d = id ? dealData.get(id) : undefined;
    if (!id || !d) continue;
    const owner = text(r.owner_user_id);
    const team = ids(r.team_user_ids);
    const its = duties.get(id) ?? [];
    const open = its.filter((t) => OPEN.has(t.status));
    const next = open
      .filter((t) => t.dueAt !== null)
      .sort((a, b) => a.dueAt! - b.dueAt! || byText(a.id, b.id))[0];
    const waiting = its
      .filter((t) => t.status === 'waiting_external' || t.status === 'blocked')
      .sort((a, b) => (a.nextLook ?? Infinity) - (b.nextLook ?? Infinity) || byText(a.id, b.id))[0];
    const live = (terms.get(id) ?? []).filter((e) => e.live);
    const closing = live
      .filter((e) => e.key === 'closing')
      .sort((a, b) => b.enteredAt - a.enteredAt || byText(b.id, a.id))[0];
    const reasons = Array.isArray(d.health_reasons) ? (d.health_reasons as unknown[]) : [];
    const first = reasons[0] as { words?: unknown } | undefined;
    const client = clients.get(id);
    const home = homes.get(id);
    const archived = text(r.archived_at) !== null;
    const outcome = text(d.outcome);
    const at = Math.max(ms(d.updated_at) ?? 0, ms(r.updated_at) ?? 0);
    const stage = text(d.stage) ?? '';
    all.push({
      dealId: id,
      name: text(r.name) ?? '',
      side: (text(d.side) ?? 'buyer') as DealSide,
      stage,
      stageLabel: STAGE_LABELS[stage as DealStage] ?? stage,
      outcome,
      archived,
      health: (text(d.health) ?? 'green') as DealListItem['health'],
      mainAgent: owner ? { userId: owner, name: users.get(owner) ?? 'Former member' } : null,
      client: client
        ? { personId: client.personId, name: people.get(client.personId) ?? 'Customer' }
        : null,
      property: home
        ? { propertyId: home.propertyId, address: recordNames.get(home.propertyId) ?? '' }
        : null,
      openDuties: open.length,
      overdueDuties: open.filter((t) => t.dueAt !== null && t.dueAt <= ctx.now).length,
      nextDue: next ? { dutyId: next.id, title: next.title, dueAt: iso(next.dueAt!) } : null,
      closing: closing?.date ?? null,
      headline: first && typeof first.words === 'string' ? first.words : null,
      mine: ctx.userId !== null && (owner === ctx.userId || team.includes(ctx.userId)),
      datesToConfirm: new Set(live.filter((e) => !e.confirmed).map((e) => e.key)).size,
      updatedAt: iso(at),
      waiting: waiting ? { title: waiting.title, who: waiting.who ?? '' } : null,
      open: !archived && outcome === null,
      at,
    });
  }

  const wanted = all.filter((x) => matches(x, filter, ctx, terms, duties));
  wanted.sort(
    (a, b) => Number(b.open) - Number(a.open) || b.at - a.at || byText(a.dealId, b.dealId),
  );
  return wanted.slice(0, filter.limit ?? 100).map(({ open: _open, at: _at, ...item }) => item);
}

const addDays = (day: string, n: number) => {
  const t = Date.parse(`${day}T00:00:00Z`) + n * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
};

function matches(
  x: DealListItem,
  f: DealListFilter,
  ctx: DealListContext,
  terms: ReadonlyMap<string, Term[]>,
  duties: ReadonlyMap<string, Duty[]>,
): boolean {
  const status = f.status ?? 'open';
  if (status === 'open' && (x.archived || x.outcome !== null)) return false;
  if (status === 'closed' && (x.archived || x.outcome !== 'closed')) return false;
  if (
    status === 'ended' &&
    (x.archived || !['lost', 'ended', 'terminated'].includes(x.outcome ?? ''))
  )
    return false;
  if (status === 'archived' && !x.archived) return false;
  if (f.side && x.side !== f.side) return false;
  if (f.mine && !x.mine) return false;
  if (f.agentUserId && x.mainAgent?.userId !== f.agentUserId) return false;
  if (f.stage && x.stage !== f.stage) return false;
  if (f.closingWithinDays !== undefined) {
    const last = addDays(ctx.today, f.closingWithinDays);
    const closing = (terms.get(x.dealId) ?? []).filter(
      (e) =>
        e.live && e.key === 'closing' && e.date !== null && e.date >= ctx.today && e.date <= last,
    );
    if (closing.length === 0) return false;
  }
  if (f.waitingOn) {
    const on: readonly string[] = WAITING[f.waitingOn];
    if (!(duties.get(x.dealId) ?? []).some((t) => on.includes(t.status))) return false;
  }
  if (f.search) {
    const q = f.search.trim().toLowerCase();
    const hit = [x.name, x.client?.name, x.property?.address].some((s) =>
      (s ?? '').toLowerCase().includes(q),
    );
    if (!hit) return false;
  }
  return true;
}
