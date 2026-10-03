/**
 * Real Estate's part of a phone's copy (round six, step 13), read once into what its screens work from.
 *
 * The phone holds tables, not answers: the deal records, Real Estate's rows as JSON (`addon_phone_rows`: deals,
 * duties, terms and the rest), the links (a client, a home), and the business's people and members. Every column
 * arrives as text or 0/1 and any may be null; a JSON column's times are Postgres's, a table's PowerSync's.
 * `realestateCopyOf` reads them once; each screen's view (`deal-list.ts`, `duty-list.ts`) works from the result, and
 * `packages/core/test/addons/realestate-phone-views.test.ts` holds each to the server's answer.
 *
 * Browser-safe and pure.
 */

/** Every synced column reads as text, an integer or nothing. */
export type Cell = string | number | null | undefined;

/** A deal record (`custom_records` of the deal kind). */
export interface SyncedDealRecord {
  readonly id: Cell;
  readonly name: Cell;
  readonly notes?: Cell;
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

/** A link (`relationships`), with its kind's `addon_id`, `addon_key` and `position`. */
export interface SyncedLink {
  readonly id: Cell;
  readonly addon_id?: Cell;
  readonly addon_key: Cell;
  readonly position?: Cell;
  readonly a_person_id: Cell;
  readonly a_company_id?: Cell;
  readonly a_custom_record_id: Cell;
  readonly b_custom_record_id: Cell;
  readonly note?: Cell;
  readonly created_at: Cell;
}

export interface SyncedCompany {
  readonly id: Cell;
  readonly name: Cell;
  readonly email?: Cell;
  readonly phone?: Cell;
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

/** What the phone's SQL hands over. */
export interface RealestateSource {
  readonly records: readonly SyncedDealRecord[];
  readonly rows: readonly SyncedPhoneRow[];
  readonly links: readonly SyncedLink[];
  readonly people: readonly SyncedPerson[];
  readonly companies?: readonly SyncedCompany[];
  /** The deal's files and appointments (`files.name`, `appointments.title`), for what a duty's proof points at. */
  readonly files?: readonly {
    readonly id: Cell;
    readonly name: Cell;
    readonly locked_at?: Cell;
  }[];
  readonly appointments?: readonly {
    readonly id: Cell;
    readonly title: Cell;
    readonly starts_at?: Cell;
  }[];
  readonly users: readonly SyncedUser[];
  /** Records the links point at (homes); deal records may be among them. */
  readonly recordNames: readonly SyncedRecordName[];
  /** The business's booking site (records_v1): its name in public links. */
  readonly bookingSites?: readonly { readonly slug: Cell; readonly enabled?: Cell }[];
  /** Who holds each add-on here and as what (records_v1, to whoever sees every record: Team workload). */
  readonly team?: readonly {
    readonly user_id: Cell;
    readonly addon_id: Cell;
    readonly role: Cell;
  }[];
  /** Who has the portal (records_v1; never a link's reference). */
  readonly portalAccess?: readonly {
    readonly person_id: Cell;
    readonly given_at: Cell;
    readonly revoked_at: Cell;
    readonly last_used_at: Cell;
  }[];
}

// ---------- reading cells ----------

export const text = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  const s = String(v);
  return s === '' ? null : s;
};
/** A time as milliseconds: PowerSync's "2026-10-03 14:31:03.785Z", Postgres's "…+00", or JSON's "…T…+00:00". */
export const ms = (v: unknown): number | null => {
  const s = text(v);
  if (!s) return null;
  const t = Date.parse(s.replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00'));
  return Number.isNaN(t) ? null : t;
};
export const iso = (t: number) => new Date(t).toISOString();
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
const isSet = (v: unknown) => v !== null && v !== undefined;
export const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
/** Names in reading order, the same on the server and every phone (English rules, not the device's). */
export const byName = (a: string, b: string) => a.localeCompare(b, 'en');

// ---------- what the screens work from ----------

export interface CopyDeal {
  readonly id: string;
  readonly name: string;
  readonly notes: string | null;
  readonly archived: boolean;
  readonly ownerUserId: string | null;
  readonly teamUserIds: readonly string[];
  /** The record's own last change. */
  readonly recordUpdatedAt: number;
  /** The deal's row (`addon_realestate.deals`), as JSON. */
  readonly data: Readonly<Record<string, unknown>>;
}

export interface CopyDuty {
  readonly id: string;
  readonly dealId: string;
  readonly key: string;
  readonly title: string;
  readonly status: string;
  readonly materiality: string;
  readonly accountableUserId: string | null;
  readonly dueAt: number | null;
  readonly dueState: string;
  /** When it's next chased, or its blocker looked at again. */
  readonly nextLook: number | null;
  /** Who it waits on, or whose the blocker is. */
  readonly who: string | null;
  readonly createdAt: number;
}

export interface CopyTerm {
  readonly id: string;
  readonly key: string;
  readonly date: string | null;
  readonly enteredAt: number;
  readonly confirmed: boolean;
  /** Not replaced and not rejected. */
  readonly live: boolean;
}

/** One of Real Estate's rows: its own key and its columns. */
export interface CopyRow {
  readonly id: string;
  readonly data: Readonly<Record<string, unknown>>;
}

/** A link to a deal, as the deal page lists its people. */
export interface CopyLink {
  readonly id: string;
  readonly addonId: string | null;
  readonly addonKey: string | null;
  readonly position: number;
  readonly personId: string | null;
  readonly companyId: string | null;
  readonly dealId: string;
  readonly note: string | null;
  readonly at: number;
}

export interface RealestateCopy {
  /** The business's settings phones keep (the manifest's `offline.settings`: its closed days). */
  readonly settings: Readonly<Record<string, unknown>>;
  readonly deals: ReadonlyMap<string, CopyDeal>;
  readonly duties: ReadonlyMap<string, readonly CopyDuty[]>;
  readonly terms: ReadonlyMap<string, readonly CopyTerm[]>;
  /** A deal's first client: the person. */
  readonly clients: ReadonlyMap<string, string>;
  /** A deal's latest home: its record. */
  readonly homes: ReadonlyMap<string, string>;
  /** The links whose far end is the deal (its clients and the rest of its people), in no order. */
  readonly linksTo: ReadonlyMap<string, readonly CopyLink[]>;
  /** Any of Real Estate's rows for a deal, by source ('deal_roles', 'documents', …). */
  rows(source: string, dealId: string): readonly CopyRow[];
  /** The business's own rows of a source, on no deal ('vendors'). */
  businessRows(source: string): readonly CopyRow[];
  /** A member's name, as the server's queries give it (their name, else their email). */
  user(id: string): string | null;
  /** A customer's name, as the server's queries give it ("Customer" when there's nothing). */
  person(id: string): string | null;
  /** A customer's name as a deal's people list gives it: their name, else their email, else nothing. */
  personPlain(id: string): string | null;
  company(id: string): string | null;
  /** How to reach a company: its email and phone, as kept. */
  companyContact(id: string): { readonly email: string | null; readonly phone: string | null };
  record(id: string): string | null;
  /** Who holds Real Estate here and as what: only on the phones of whoever sees every deal. */
  readonly team: readonly { readonly userId: string; readonly role: string }[];
  /** The business's booking site's name in links, or null when it has none. */
  readonly bookingSlug: string | null;
  /** A customer's portal access, as kept: when it was given, revoked and last used (ISO), or null. */
  portalAccess(personId: string): {
    readonly givenAt: string | null;
    readonly revokedAt: string | null;
    readonly lastUsedAt: string | null;
  } | null;
  file(id: string): string | null;
  /** Whether a file is locked (signed and kept as it is), or null when the phone doesn't hold it. */
  fileLocked(id: string): boolean | null;
  appointment(id: string): string | null;
  appointmentStart(id: string): string | null;
}

export function realestateCopyOf(source: RealestateSource): RealestateCopy {
  const users = new Map(
    source.users.map((u) => [text(u.id) ?? '', text(u.full_name) ?? text(u.email)]),
  );
  const people = new Map(
    source.people.map((p) => [
      text(p.id) ?? '',
      joined(p.first_name, p.last_name) ?? text(p.email),
    ]),
  );
  const companies = new Map((source.companies ?? []).map((c) => [text(c.id) ?? '', text(c.name)]));
  const contacts = new Map(
    (source.companies ?? []).map((c) => [
      text(c.id) ?? '',
      { email: text(c.email), phone: text(c.phone) },
    ]),
  );
  const portal = new Map(
    (source.portalAccess ?? []).map((p) => {
      const at = (v: Cell) => {
        const t = ms(v);
        return t === null ? null : iso(t);
      };
      return [
        text(p.person_id) ?? '',
        { givenAt: at(p.given_at), revokedAt: at(p.revoked_at), lastUsedAt: at(p.last_used_at) },
      ];
    }),
  );
  const starts = new Map(
    (source.appointments ?? []).map((a) => [text(a.id) ?? '', ms(a.starts_at)]),
  );
  const files = new Map((source.files ?? []).map((f) => [text(f.id) ?? '', text(f.name)]));
  const locked = new Map(
    (source.files ?? []).map((f) => [text(f.id) ?? '', text(f.locked_at) !== null]),
  );
  const appointments = new Map(
    (source.appointments ?? []).map((a) => [text(a.id) ?? '', text(a.title)]),
  );
  const bySource = new Map<string, Map<string, CopyRow[]>>();
  const recordNames = new Map(source.recordNames.map((r) => [text(r.id) ?? '', text(r.name)]));

  const dealData = new Map<string, Record<string, unknown>>();
  const duties = new Map<string, CopyDuty[]>();
  const terms = new Map<string, CopyTerm[]>();
  let settings: Record<string, unknown> = {};
  for (const row of source.rows) {
    if (text(row.source) === '_settings') {
      settings = obj(row.data);
      continue;
    }
    const record = text(row.record_id);
    const d = obj(row.data);
    const src = text(row.source) ?? '';
    const forSource = bySource.get(src) ?? new Map<string, CopyRow[]>();
    bySource.set(src, forSource);
    // The business's own rows sit under '' (no deal).
    forSource.set(record ?? '', [
      ...(forSource.get(record ?? '') ?? []),
      { id: keyOf(row.id), data: d },
    ]);
    if (!record) continue;
    switch (src) {
      case 'deals':
        dealData.set(record, d);
        break;
      case 'duties': {
        const list = duties.get(record) ?? [];
        list.push({
          id: keyOf(row.id),
          dealId: record,
          key: text(d.duty_key) ?? '',
          title: text(d.title) ?? '',
          status: text(d.status) ?? '',
          materiality: text(d.materiality) ?? '',
          accountableUserId: text(d.accountable_user_id),
          dueAt: ms(d.due_at),
          dueState: text(d.due_state) ?? 'none',
          nextLook: ms(d.chase_at) ?? ms(d.blocker_review_at),
          who: text(d.waiting_on) ?? text(d.blocker_owner) ?? text(d.blocker),
          createdAt: ms(d.created_at) ?? 0,
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
          confirmed: isSet(d.confirmed_at),
          live: !isSet(d.superseded_at) && !isSet(d.rejected_at),
        });
        terms.set(record, list);
        break;
      }
    }
  }

  const deals = new Map<string, CopyDeal>();
  for (const r of source.records) {
    const id = text(r.id);
    const data = id ? dealData.get(id) : undefined;
    if (!id || !data) continue;
    deals.set(id, {
      id,
      name: text(r.name) ?? '',
      notes: text(r.notes),
      archived: text(r.archived_at) !== null,
      ownerUserId: text(r.owner_user_id),
      teamUserIds: ids(r.team_user_ids),
      recordUpdatedAt: ms(r.updated_at) ?? 0,
      data,
    });
  }

  // A deal's first client and its latest home, as the server's queries pick them.
  const clients = new Map<string, { person: string; at: number; id: string }>();
  const homes = new Map<string, { home: string; at: number; id: string }>();
  const linksTo = new Map<string, CopyLink[]>();
  for (const l of source.links) {
    const key = text(l.addon_key);
    const id = text(l.id) ?? '';
    const at = ms(l.created_at) ?? 0;
    const to = text(l.b_custom_record_id);
    if (to)
      linksTo.set(to, [
        ...(linksTo.get(to) ?? []),
        {
          id,
          addonId: text(l.addon_id),
          addonKey: key,
          position: Number(l.position ?? 0) || 0,
          personId: text(l.a_person_id),
          companyId: text(l.a_company_id),
          dealId: to,
          note: text(l.note),
          at,
        },
      ]);
    if (key === 'realestate_client') {
      const deal = text(l.b_custom_record_id);
      const person = text(l.a_person_id);
      if (!deal || !person) continue;
      const was = clients.get(deal);
      if (!was || at < was.at || (at === was.at && byText(id, was.id) < 0))
        clients.set(deal, { person, at, id });
    } else if (key === 'realestate_property_of') {
      const deal = text(l.a_custom_record_id);
      const home = text(l.b_custom_record_id);
      if (!deal || !home) continue;
      const was = homes.get(deal);
      if (!was || at > was.at || (at === was.at && byText(id, was.id) > 0))
        homes.set(deal, { home, at, id });
    }
  }

  return {
    settings,
    deals,
    duties,
    terms,
    clients: new Map([...clients].map(([deal, c]) => [deal, c.person])),
    homes: new Map([...homes].map(([deal, h]) => [deal, h.home])),
    linksTo,
    rows: (src, dealId) => (dealId ? (bySource.get(src)?.get(dealId) ?? []) : []),
    businessRows: (src) => bySource.get(src)?.get('') ?? [],
    user: (id) => users.get(id) ?? null,
    person: (id) => (people.has(id) ? (people.get(id) ?? 'Customer') : null),
    personPlain: (id) => people.get(id) ?? null,
    company: (id) => companies.get(id) ?? null,
    companyContact: (id) => contacts.get(id) ?? { email: null, phone: null },
    record: (id) => recordNames.get(id) ?? null,
    team: (source.team ?? []).flatMap((t) =>
      text(t.addon_id) === 'realestate' && text(t.user_id)
        ? [{ userId: text(t.user_id)!, role: text(t.role) ?? 'member' }]
        : [],
    ),
    bookingSlug: text(source.bookingSites?.[0]?.slug),
    portalAccess: (id) => portal.get(id) ?? null,
    file: (id) => files.get(id) ?? null,
    fileLocked: (id) => locked.get(id) ?? null,
    appointment: (id) => appointments.get(id) ?? null,
    appointmentStart: (id) => {
      const t = starts.get(id);
      return t === null || t === undefined ? null : iso(t);
    },
  };
}
