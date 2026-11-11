import { localDateOf } from '@hfos/core';
import {
  contractorCopyOf,
  type ContractorCopy,
  type ContractorSource,
} from '@hfos/core/addons/contractor/views/phone';
import { useQuery } from '@powersync/react-native';
import * as React from 'react';

/**
 * Contractor Operations' part of the phone's copy (docs/contractor.md, "On the phone"), read for one screen and
 * handed to core's views (`@hfos/core/addons/contractor/views/phone`), which work out what the server's queries
 * answer. The SQL fetches rows and nothing more; core does the rest, so a screen reads the same with no signal as
 * the web does with it.
 *
 * Three reach sizes, so a list doesn't parse every job's time and notes: `lists` (Jobs and More: the jobs, their
 * phases and teams, and each visit's work order, checklist, subcontractors and materials), `job` (one job's every
 * row) and `visit` (the every row of the job a visit is on, found from its work order).
 */

export type CopyReach =
  | { readonly kind: 'lists' }
  | { readonly kind: 'job'; readonly jobId: string }
  | { readonly kind: 'visit'; readonly appointmentId: string };

export const CO_RECORDS_SQL = `
  SELECT r.id, t.key AS kind_key, r.name, r.archived_at
  FROM custom_records r JOIN custom_record_types t ON t.id = r.type_id
  WHERE r.workspace_id = ? AND t.addon_id = 'contractor'`;

export const CO_LIST_ROWS_SQL = `
  SELECT id, source, record_id, data FROM addon_phone_rows
  WHERE workspace_id = ? AND addon_id = 'contractor'
    AND source IN ('jobs', 'phases', 'team', 'crews', 'work_orders', 'work_order_items', 'work_order_subs',
                   'materials')`;

/** Every row of one job, and the business's own (its crews). */
export const CO_JOB_ROWS_SQL = `
  SELECT id, source, record_id, data FROM addon_phone_rows
  WHERE workspace_id = ? AND addon_id = 'contractor' AND (record_id IS NULL OR record_id = ?)`;

/** Every row of the job a visit is on, found from the visit's work order (whose row is named for the visit). */
export const CO_VISIT_ROWS_SQL = `
  SELECT id, source, record_id, data FROM addon_phone_rows
  WHERE workspace_id = ? AND addon_id = 'contractor'
    AND (record_id IS NULL OR record_id = (SELECT w.record_id FROM addon_phone_rows w WHERE w.id = ?))`;

export const CO_LINKS_SQL = `
  SELECT t.addon_key, l.a_person_id, l.a_custom_record_id, l.b_custom_record_id, l.created_at
  FROM relationships l JOIN relationship_types t ON t.id = l.type_id
  WHERE l.workspace_id = ? AND t.addon_id = 'contractor'`;

export const CO_PEOPLE_SQL = `
  SELECT id, first_name, last_name, email, phone_e164, company_id, archived_at FROM people WHERE workspace_id = ?`;
export const CO_COMPANIES_SQL = 'SELECT id, name FROM companies WHERE workspace_id = ?';
export const CO_USERS_SQL = 'SELECT id, full_name, email FROM users';
export const CO_APPOINTMENTS_SQL = `
  SELECT id, title, starts_at, ends_at, status, location, job_id FROM appointments WHERE workspace_id = ?`;
export const CO_STAFF_SQL = `
  SELECT appointment_id, user_id, active, created_at FROM appointment_staff WHERE workspace_id = ?`;
/** Core's job for each visit still going: where its crew has it. */
export const CO_VISIT_JOBS_SQL = 'SELECT id, status FROM jobs WHERE workspace_id = ?';
export const CO_FILES_SQL = `
  SELECT id, name, mime_type, status FROM files WHERE workspace_id = ? AND record_type = 'custom_record'`;
export const CO_ZONE_SQL = 'SELECT timezone FROM workspaces WHERE id = ?';

type Row = Record<string, string | number | null>;

/** The copy for one screen, re-read whenever the rows under it change. */
export function useContractorCopy(workspaceId: string, reach: CopyReach): ContractorCopy {
  const [rowsSql, rowsArgs] =
    reach.kind === 'job'
      ? [CO_JOB_ROWS_SQL, [workspaceId, reach.jobId]]
      : reach.kind === 'visit'
        ? [CO_VISIT_ROWS_SQL, [workspaceId, `work_orders:${reach.appointmentId}`]]
        : [CO_LIST_ROWS_SQL, [workspaceId]];
  const records = useQuery<Row>(CO_RECORDS_SQL, [workspaceId]).data;
  const rows = useQuery<Row>(rowsSql, rowsArgs).data;
  const links = useQuery<Row>(CO_LINKS_SQL, [workspaceId]).data;
  const people = useQuery<Row>(CO_PEOPLE_SQL, [workspaceId]).data;
  const companies = useQuery<Row>(CO_COMPANIES_SQL, [workspaceId]).data;
  const users = useQuery<Row>(CO_USERS_SQL, []).data;
  const appointments = useQuery<Row>(CO_APPOINTMENTS_SQL, [workspaceId]).data;
  const staff = useQuery<Row>(CO_STAFF_SQL, [workspaceId]).data;
  const visitJobs = useQuery<Row>(CO_VISIT_JOBS_SQL, [workspaceId]).data;
  const files = useQuery<Row>(CO_FILES_SQL, [workspaceId]).data;
  return React.useMemo(
    () =>
      contractorCopyOf({
        records,
        rows,
        links,
        people,
        companies,
        users,
        appointments,
        staff,
        visitJobs,
        files,
      } as unknown as ContractorSource),
    [records, rows, links, people, companies, users, appointments, staff, visitJobs, files],
  );
}

/** The business's today, where the business is: a deadline is late once that day is over there. */
export function useBusinessToday(workspaceId: string, fallbackZone: string, now: number): string {
  const zone = useQuery<{ timezone: string | null }>(CO_ZONE_SQL, [workspaceId]).data[0]?.timezone;
  return localDateOf(now, zone || fallbackZone || 'UTC');
}
