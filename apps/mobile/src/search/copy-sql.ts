import {
  CONTACT_LINES,
  copyKindsFor,
  escapeLike,
  lastContactsOf,
  NOTE_LINE_RULE,
  searchProbes,
  type CopyAppointment,
  type CopyCloseRow,
  type CopyCompany,
  type CopyForm,
  type CopyGroup,
  type CopyLead,
  type CopyNote,
  type CopyPerson,
  type CopyRows,
  type CopyTask,
} from '@hfos/core';

import { PHONE_ADDONS } from '@/addons/registry';

/**
 * What the phone's own search reads from its copy with no signal (HANDSFREEOS_SEARCH_IMPLEMENTATION_PLAN.md, "Phone:
 * no signal"): one bounded read a kind, through `getAll` once a search settles, never a live query over every row.
 * The SQL only narrows, and never past what core's `searchCopy` would match (`__tests__/copy-sql.test.ts` runs it on
 * SQLite to hold it to that): each kind's words lower-cased into one text (`hay`), the three longest typed words each
 * in it, or the phone, the digits or the web address typed; at most 200 rows, those whose name holds the words first,
 * then the latest. Core's `searchCopy` then decides which match and ranks them as the server does.
 *
 * Archived rows are left out, and a customer, company or lead that's archived lends no name: a customer in the bin
 * reads as archived on a phone. Notes and tasks are read only on a customer, company or lead in the copy.
 */

/** Just what search asks of the phone's database. */
export interface CopyDb {
  getAll<T>(sql: string, parameters?: unknown[]): Promise<T[]>;
}

/** What a phone add-on's own search is asked (`PhoneAddon.search`). */
export interface PhoneAddonSearch {
  readonly workspaceId: string;
  readonly userId: string;
  readonly q: string;
  readonly now: number;
  readonly timeZone: string;
}

/** Rows a kind reads at most. */
export const COPY_ROWS = 200;
/** Names close matches read at most, a kind. */
export const CLOSE_NAMES = 2000;

/** `?, ?, ?` for a list. */
const marks = (n: number) => Array.from({ length: Math.max(1, n) }, () => '?').join(', ');

/** How what was typed narrows a read (`narrowingOf`). */
export interface CopyNarrowing {
  /** The three longest typed words at most, as `%word%` patterns. */
  readonly likes: readonly string[];
  /** A phone however it was typed, in E.164. */
  readonly phone: string | null;
  /** Typed digits, to be found in a number. */
  readonly digits: string | null;
  /** A web address's domain (`gulfcoastrealty.com`), however much of the address was typed. */
  readonly domain: string | null;
}

/**
 * A pattern's letters outside ASCII each read as any one letter: SQLite's `lower()` and LIKE fold the case of plain
 * letters only, so "émile" would never find a stored "Émile". Read this way the row comes back, and `searchCopy`
 * decides.
 */
const anyLetter = (like: string) => like.replace(/[\u0080-\u{10FFFF}]/gu, '_');

/** How a search narrows what's read: the three longest typed words, the phone, the digits and the domain typed. */
export function narrowingOf(q: string): CopyNarrowing {
  const p = searchProbes(q);
  return {
    likes: [...p.likes]
      .sort((a, b) => b.length - a.length)
      .slice(0, 3)
      .map(anyLetter),
    phone: p.phoneE164,
    digits: p.digits,
    domain: p.domain,
  };
}

/** Whether the three longest typed words are each in `x.<column>`. Its parameters come from `wordsParams`. */
const holds = (column: string) => `(? IS NOT NULL AND x.${column} LIKE ? ESCAPE '\\'
    AND (? IS NULL OR x.${column} LIKE ? ESCAPE '\\')
    AND (? IS NULL OR x.${column} LIKE ? ESCAPE '\\'))`;

const wordsParams = (n: CopyNarrowing): (string | null)[] => {
  const word = (i: number) => n.likes[i] ?? null;
  return [word(0), word(0), word(1), word(1), word(2), word(2)];
};

/**
 * Where a search's words go: the three longest typed words each in `x.hay`, or the phone typed, or the digits typed
 * (in `x.hay`, or in order in a number written freely, `x.number`, which `searchCopy` reads digit by digit), or the
 * domain of a web address. Its parameters come from `matchParams`, in this order.
 */
const MATCHES = `
  ${holds('hay')}
  OR (? IS NOT NULL AND x.hay LIKE ?)
  OR (? IS NOT NULL AND (x.hay LIKE ? OR x.number LIKE ?))
  OR (? IS NOT NULL AND x.hay LIKE ? ESCAPE '\\')`;

const matchParams = (n: CopyNarrowing): (string | null)[] => [
  ...wordsParams(n),
  n.phone,
  n.phone ? `%${n.phone}%` : null,
  n.digits,
  n.digits ? `%${n.digits}%` : null,
  n.digits ? `%${[...n.digits].join('%')}%` : null,
  n.domain,
  n.domain ? `%${escapeLike(n.domain)}%` : null,
];

/**
 * A kind's read: its rows (`rows`, each with its `hay`, its name as `named`, and a `number` written freely or null),
 * those the search reaches, at most 200. Those whose name holds the typed words come first, so a name isn't crowded
 * out by rows found by their other words (the server ranks names first too), then the latest by `latest`.
 */
const narrowed = (rows: string, latest: string) => `
  SELECT * FROM (${rows}) x
  WHERE ${MATCHES}
  ORDER BY ${holds('named')} DESC, x.${latest} DESC LIMIT ${COPY_ROWS}`;

export const COPY_PEOPLE_SQL = narrowed(
  `SELECT p.id, p.first_name, p.last_name, p.email, p.phone, p.phone_e164, p.phone_alt, p.address_line1,
          p.address_line2, p.city, p.state, p.postal_code, p.other_emails, p.other_phones, p.other_addresses,
          c.name AS company_name, p.archived_at, p.updated_at,
          lower(coalesce(p.first_name, '') || ' ' || coalesce(p.last_name, '') || ' ' || coalesce(p.email, '') || ' ' ||
            coalesce(p.phone_e164, '') || ' ' || coalesce(p.address_line1, '') || ' ' ||
            coalesce(p.address_line2, '') || ' ' || coalesce(p.city, '') || ' ' || coalesce(p.state, '') || ' ' ||
            coalesce(p.postal_code, '') || ' ' || coalesce(p.other_emails, '') || ' ' ||
            coalesce(p.other_phones, '') || ' ' || coalesce(p.other_addresses, '') || ' ' ||
            coalesce(p.phone_alt, '') || ' ' || coalesce(c.name, '')) AS hay,
          lower(coalesce(p.first_name, '') || ' ' || coalesce(p.last_name, '')) AS named, p.phone_alt AS number
   FROM people p LEFT JOIN companies c ON c.id = p.company_id AND c.archived_at IS NULL
   WHERE p.workspace_id = ? AND p.archived_at IS NULL`,
  'updated_at',
);

export const COPY_COMPANIES_SQL = narrowed(
  `SELECT c.id, c.name, c.email, c.phone, c.phone_e164, c.website, c.address_line1, c.address_line2, c.city,
          c.state, c.postal_code, c.other_emails, c.other_phones, c.other_addresses, c.archived_at, c.updated_at,
          lower(coalesce(c.name, '') || ' ' || coalesce(c.email, '') || ' ' || coalesce(c.phone_e164, '') || ' ' ||
            coalesce(c.website, '') || ' ' || coalesce(c.address_line1, '') || ' ' ||
            coalesce(c.address_line2, '') || ' ' || coalesce(c.city, '') || ' ' || coalesce(c.state, '') || ' ' ||
            coalesce(c.postal_code, '') || ' ' || coalesce(c.other_emails, '') || ' ' ||
            coalesce(c.other_phones, '') || ' ' || coalesce(c.other_addresses, '')) AS hay,
          lower(coalesce(c.name, '')) AS named, c.phone AS number
   FROM companies c
   WHERE c.workspace_id = ? AND c.archived_at IS NULL`,
  'updated_at',
);

export const COPY_LEADS_SQL = narrowed(
  `SELECT l.id, l.title, l.status, l.value_cents, l.archived_at, l.updated_at, s.name AS stage_name,
          pl.name AS pipeline_name, p.first_name AS person_first, p.last_name AS person_last,
          c.name AS company_name, coalesce(nullif(u.full_name, ''), u.email) AS owner_name,
          lower(coalesce(l.title, '') || ' ' || coalesce(p.first_name, '') || ' ' || coalesce(p.last_name, '') || ' ' ||
            coalesce(c.name, '')) AS hay,
          lower(coalesce(l.title, '')) AS named, NULL AS number
   FROM leads l
   LEFT JOIN pipeline_stages s ON s.id = l.stage_id
   LEFT JOIN pipelines pl ON pl.id = l.pipeline_id
   LEFT JOIN people p ON p.id = l.person_id AND p.archived_at IS NULL
   LEFT JOIN companies c ON c.id = l.company_id AND c.archived_at IS NULL
   LEFT JOIN users u ON u.id = l.assignee_user_id
   WHERE l.workspace_id = ? AND l.archived_at IS NULL`,
  'updated_at',
);

/** Who a task or a note hangs off, when they show: the customer, the company, the lead. */
const ANCHOR_COLUMNS = `p.id AS on_person_id, p.first_name AS on_person_first, p.last_name AS on_person_last,
          c.id AS on_company_id, c.name AS on_company_name, l.id AS on_lead_id, l.title AS on_lead_title`;
const anchorJoins = (alias: string) => `
   LEFT JOIN people p ON p.id = ${alias}.person_id AND p.archived_at IS NULL
   LEFT JOIN companies c ON c.id = ${alias}.company_id AND c.archived_at IS NULL
   LEFT JOIN leads l ON l.id = ${alias}.lead_id AND l.archived_at IS NULL`;
const ANCHORED = '(p.id IS NOT NULL OR c.id IS NOT NULL OR l.id IS NOT NULL)';

/** Tasks the phone keeps (open, or done in the last 90 days), only on a customer, company or lead in the copy. */
export const COPY_TASKS_SQL = narrowed(
  `SELECT t.id, t.title, t.notes, t.due_at, t.done_at, t.updated_at,
          coalesce(nullif(u.full_name, ''), u.email) AS owner_name, ${ANCHOR_COLUMNS},
          lower(coalesce(t.title, '') || ' ' || coalesce(t.notes, '')) AS hay,
          lower(coalesce(t.title, '')) AS named, NULL AS number
   FROM tasks t LEFT JOIN users u ON u.id = t.assignee_user_id ${anchorJoins('t')}
   WHERE t.workspace_id = ? AND ${ANCHORED}`,
  'updated_at',
);

/**
 * Notes (core's `NOTE_LINE_RULE`, decision 6, its kinds as parameters) from the 12 months the phone keeps, only on a
 * customer, company or lead in the copy: by their words, first, or by who they're on.
 */
export const COPY_NOTES_SQL = narrowed(
  `SELECT a.id, a.kind, a.subtype, a.body, a.occurred_at, ${ANCHOR_COLUMNS},
          lower(coalesce(a.body, '') || ' ' || coalesce(p.first_name, '') || ' ' || coalesce(p.last_name, '') || ' ' ||
            coalesce(c.name, '') || ' ' || coalesce(l.title, '')) AS hay,
          lower(coalesce(a.body, '')) AS named, NULL AS number
   FROM activities a ${anchorJoins('a')}
   WHERE a.workspace_id = ?
     AND (a.kind = ? OR (a.kind IN (${marks(NOTE_LINE_RULE.bareKinds.length)}) AND a.subtype IS NULL))
     AND ${ANCHORED}`,
  'occurred_at',
);

/** Visits from the 90 days back the phone keeps: the title, the place, the notes and who's coming. */
export const COPY_APPOINTMENTS_SQL = narrowed(
  `SELECT a.id, a.title, a.status, a.starts_at, a.ends_at, a.location, a.notes, w.attendees, w.who,
          lower(coalesce(a.title, '') || ' ' || coalesce(json_extract(a.location, '$.address'), '') || ' ' ||
            coalesce(json_extract(a.location, '$.postalCode'), '') || ' ' || coalesce(a.notes, '') || ' ' ||
            coalesce(w.attendees, '')) AS hay,
          lower(coalesce(a.title, '')) AS named, NULL AS number
   FROM appointments a
   LEFT JOIN (
     SELECT t.appointment_id,
            group_concat(trim(coalesce(p.first_name, '') || ' ' || coalesce(p.last_name, '') || ' ' ||
              coalesce(t.contact_phone_e164, '') || ' ' || coalesce(t.contact_email, '')), ' ') AS attendees,
            group_concat(nullif(trim(coalesce(p.first_name, '') || ' ' || coalesce(p.last_name, '')), ''), ', ')
              AS who
     FROM appointment_attendees t LEFT JOIN people p ON p.id = t.person_id AND p.archived_at IS NULL
     WHERE t.workspace_id = ?
     GROUP BY t.appointment_id
   ) w ON w.appointment_id = a.id
   WHERE a.workspace_id = ?`,
  'starts_at',
);

/** Live forms by name (the only ones the phone keeps); their answers wait for signal. */
export const COPY_FORMS_SQL = narrowed(
  `SELECT f.id, f.name, f.updated_at, lower(coalesce(f.name, '')) AS hay, lower(coalesce(f.name, '')) AS named,
          NULL AS number
   FROM forms f WHERE f.workspace_id = ?`,
  'updated_at',
);

/** The names close matches may offer, the latest changed first. */
export const CLOSE_PEOPLE_SQL = `
  SELECT 'contacts' AS kind, p.id, trim(coalesce(p.first_name, '') || ' ' || coalesce(p.last_name, '')) AS name,
         p.updated_at
  FROM people p WHERE p.workspace_id = ? AND p.archived_at IS NULL
  ORDER BY p.updated_at DESC LIMIT ${CLOSE_NAMES}`;
export const CLOSE_COMPANIES_SQL = `
  SELECT 'companies' AS kind, c.id, c.name, c.updated_at
  FROM companies c WHERE c.workspace_id = ? AND c.archived_at IS NULL
  ORDER BY c.updated_at DESC LIMIT ${CLOSE_NAMES}`;
export const CLOSE_LEADS_SQL = `
  SELECT 'leads' AS kind, l.id, l.title AS name, l.updated_at
  FROM leads l WHERE l.workspace_id = ? AND l.archived_at IS NULL
  ORDER BY l.updated_at DESC LIMIT ${CLOSE_NAMES}`;

/** The timeline lines that count as being in touch (decision 35), for the contacts read. */
const lastContactSql = (people: number) => `
  SELECT a.person_id, a.kind, a.subtype, a.occurred_at FROM activities a
  WHERE a.workspace_id = ? AND a.person_id IN (${marks(people)})
    AND (a.kind IN (${marks(CONTACT_LINES.kinds.length)})
      OR (a.kind = 'system' AND a.subtype IN (${marks(CONTACT_LINES.bookedSubtypes.length)})))
  ORDER BY a.occurred_at DESC`;

/** A company's people and its open leads, for the companies read. */
const companyPeopleSql = (companies: number) => `
  SELECT x.company_id, count(*) AS n FROM people x
  WHERE x.workspace_id = ? AND x.archived_at IS NULL AND x.company_id IN (${marks(companies)})
  GROUP BY x.company_id`;
const companyLeadsSql = (companies: number) => `
  SELECT l.company_id, count(*) AS n FROM leads l
  WHERE l.workspace_id = ? AND l.status = 'open' AND l.archived_at IS NULL AND l.company_id IN (${marks(companies)})
  GROUP BY l.company_id`;

export interface CopyAsk extends PhoneAddonSearch {
  /** The person's permissions here: only the kinds they may search are read. */
  readonly permissions: readonly string[];
  /** The chips picked; none is every kind. */
  readonly kinds?: readonly string[] | null;
}

/**
 * The rows a search reads from the copy, each kind the person may search, and add-ons' groups. What was typed narrows
 * each read (`narrowingOf`); a test passes its own narrowing to read every row.
 */
export async function readCopy(
  db: CopyDb,
  ask: CopyAsk,
  narrowing: CopyNarrowing = narrowingOf(ask.q),
): Promise<CopyRows> {
  const keys = new Set(copyKindsFor(ask.permissions, ask.kinds).map((k) => k.key));
  const narrowingParams = [...matchParams(narrowing), ...wordsParams(narrowing)];
  const ws = ask.workspaceId;
  const read = <T>(key: string, sql: string, first: unknown[] = [ws]): Promise<T[]> =>
    keys.has(key) ? db.getAll<T>(sql, [...first, ...narrowingParams]) : Promise.resolve([]);
  const people = await read<CopyPerson>('contacts', COPY_PEOPLE_SQL);
  const companies = await read<CopyCompany>('companies', COPY_COMPANIES_SQL);
  const leads = await read<CopyLead>('leads', COPY_LEADS_SQL);
  const appointments = await read<CopyAppointment>('calendar', COPY_APPOINTMENTS_SQL, [ws, ws]);
  const tasks = await read<CopyTask>('tasks', COPY_TASKS_SQL);
  const notes = await read<CopyNote>('notes', COPY_NOTES_SQL, [
    ws,
    NOTE_LINE_RULE.kind,
    ...NOTE_LINE_RULE.bareKinds,
  ]);
  const forms = await read<CopyForm>('forms', COPY_FORMS_SQL);

  // The details search shows for the contacts and companies read: last contact, people and open leads.
  const lines = people.length
    ? await db.getAll<{
        person_id: string;
        kind: string;
        subtype: string | null;
        occurred_at: string;
      }>(lastContactSql(people.length), [
        ws,
        ...people.map((r) => r.id),
        ...CONTACT_LINES.kinds,
        ...CONTACT_LINES.bookedSubtypes,
      ])
    : [];
  const counted = async (sql: (n: number) => string) =>
    new Map(
      (
        await db.getAll<{ company_id: string; n: number }>(sql(companies.length), [
          ws,
          ...companies.map((r) => r.id),
        ])
      ).map((r) => [r.company_id, Number(r.n)]),
    );
  const peopleAt = companies.length ? await counted(companyPeopleSql) : new Map<string, number>();
  const openLeads = companies.length ? await counted(companyLeadsSql) : new Map<string, number>();

  const addons: CopyGroup[] = [];
  for (const a of PHONE_ADDONS) {
    if (!a.search || !ask.permissions.includes(a.permission)) continue;
    const groups = await a.search(db, ask);
    addons.push(...groups.filter((g) => !ask.kinds?.length || ask.kinds.includes(g.kind)));
  }

  return {
    people,
    companies,
    leads,
    appointments,
    tasks,
    notes,
    forms,
    addons,
    facts: {
      lastContact: lastContactsOf(lines),
      companies: new Map(
        companies.map((c) => [
          c.id,
          { people: peopleAt.get(c.id) ?? 0, openLeads: openLeads.get(c.id) ?? 0 },
        ]),
      ),
    },
  };
}

/** The names close matches may offer, for the kinds asked, read only when nothing else matched. */
export async function readCloseNames(db: CopyDb, ask: CopyAsk): Promise<CopyCloseRow[]> {
  const keys = new Set(copyKindsFor(ask.permissions, ask.kinds).map((k) => k.key));
  const out: CopyCloseRow[] = [];
  for (const [key, sql] of [
    ['contacts', CLOSE_PEOPLE_SQL],
    ['companies', CLOSE_COMPANIES_SQL],
    ['leads', CLOSE_LEADS_SQL],
  ] as const)
    if (keys.has(key)) out.push(...(await db.getAll<CopyCloseRow>(sql, [ask.workspaceId])));
  return out.sort((a, b) => String(b.updated_at ?? '').localeCompare(String(a.updated_at ?? '')));
}
