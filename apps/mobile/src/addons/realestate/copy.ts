import { localDateOf } from '@hfos/core';
import {
  realestateCopyOf,
  type RealestateCopy,
  type RealestateSource,
} from '@hfos/core/addons/realestate/views/synced';
import { useQuery } from '@powersync/react-native';
import * as React from 'react';

/**
 * Real Estate's part of the phone's copy (round six), read for one screen and handed to core's views
 * (`@hfos/core/addons/realestate/views/*`), which work out what the server's queries answer. The SQL fetches rows
 * and nothing more; core does the rest, so a screen reads the same with no signal as the web does with it.
 *
 * Three reach sizes, so a list doesn't parse every deal's documents: `lists` (Deals, My duties: the deals, their
 * duties, dates and roles), `deal` (one deal's every row, for its pages) and `all` (Coordinate, which looks across
 * every deal's proof and contingencies).
 */

export type CopyReach =
  | { readonly kind: 'lists' }
  | { readonly kind: 'deal'; readonly dealId: string }
  | { readonly kind: 'all' };

export const RE_DEALS_SQL = `
  SELECT r.id, r.name, r.notes, r.archived_at, r.owner_user_id, r.team_user_ids, r.updated_at
  FROM custom_records r JOIN custom_record_types t ON t.id = r.type_id
  WHERE r.workspace_id = ? AND t.addon_id = 'realestate' AND t.key = 'realestate_deal'`;

/** The rows a list needs, and the business's own (vendors, settings). */
export const RE_LIST_ROWS_SQL = `
  SELECT id, source, record_id, data FROM addon_phone_rows
  WHERE workspace_id = ? AND addon_id = 'realestate'
    AND (record_id IS NULL OR source IN ('deals', 'duties', 'term_entries', 'deal_roles'))`;

/** Every row of one deal, its fellow deals' summaries (for what waits on what), and the business's own. */
export const RE_DEAL_ROWS_SQL = `
  SELECT id, source, record_id, data FROM addon_phone_rows
  WHERE workspace_id = ? AND addon_id = 'realestate'
    AND (record_id IS NULL OR record_id = ? OR source IN ('deals', 'duties', 'term_entries', 'deal_roles'))`;

export const RE_ALL_ROWS_SQL = `
  SELECT id, source, record_id, data FROM addon_phone_rows WHERE workspace_id = ? AND addon_id = 'realestate'`;

export const RE_LINKS_SQL = `
  SELECT l.id, t.addon_id, t.addon_key, t.position, l.a_person_id, l.a_company_id, l.a_custom_record_id,
         l.b_custom_record_id, l.note, l.created_at
  FROM relationships l JOIN relationship_types t ON t.id = l.type_id
  WHERE l.workspace_id = ?`;

export const RE_PEOPLE_SQL =
  'SELECT id, first_name, last_name, email FROM people WHERE workspace_id = ?';
export const RE_COMPANIES_SQL =
  'SELECT id, name, email, phone FROM companies WHERE workspace_id = ?';
export const RE_FILES_SQL = `
  SELECT id, name, locked_at FROM files WHERE workspace_id = ? AND record_type = 'custom_record'`;
export const RE_APPOINTMENTS_SQL =
  'SELECT id, title, starts_at FROM appointments WHERE workspace_id = ?';
export const RE_USERS_SQL = 'SELECT id, full_name, email FROM users';
export const RE_RECORD_NAMES_SQL = 'SELECT id, name FROM custom_records WHERE workspace_id = ?';
export const RE_ZONE_SQL = 'SELECT timezone FROM workspaces WHERE id = ?';

type Row = Record<string, string | number | null>;

/** The copy for one screen, re-read whenever the rows under it change. */
export function useRealestateCopy(workspaceId: string, reach: CopyReach): RealestateCopy {
  const [rowsSql, rowsArgs] =
    reach.kind === 'deal'
      ? [RE_DEAL_ROWS_SQL, [workspaceId, reach.dealId]]
      : reach.kind === 'all'
        ? [RE_ALL_ROWS_SQL, [workspaceId]]
        : [RE_LIST_ROWS_SQL, [workspaceId]];
  const records = useQuery<Row>(RE_DEALS_SQL, [workspaceId]).data;
  const rows = useQuery<Row>(rowsSql, rowsArgs).data;
  const links = useQuery<Row>(RE_LINKS_SQL, [workspaceId]).data;
  const people = useQuery<Row>(RE_PEOPLE_SQL, [workspaceId]).data;
  const companies = useQuery<Row>(RE_COMPANIES_SQL, [workspaceId]).data;
  const files = useQuery<Row>(RE_FILES_SQL, [workspaceId]).data;
  const appointments = useQuery<Row>(RE_APPOINTMENTS_SQL, [workspaceId]).data;
  const users = useQuery<Row>(RE_USERS_SQL, []).data;
  const recordNames = useQuery<Row>(RE_RECORD_NAMES_SQL, [workspaceId]).data;
  return React.useMemo(
    () =>
      realestateCopyOf({
        records,
        rows,
        links,
        people,
        companies,
        files,
        appointments,
        users,
        recordNames,
      } as unknown as RealestateSource),
    [records, rows, links, people, companies, files, appointments, users, recordNames],
  );
}

/** The business's today, where the business is: closing within so many days, and due today, count from it. */
export function useBusinessToday(workspaceId: string, fallbackZone: string, now: number): string {
  const zone = useQuery<{ timezone: string | null }>(RE_ZONE_SQL, [workspaceId]).data[0]?.timezone;
  return localDateOf(now, zone || fallbackZone || 'UTC');
}
