import {
  contractorCopyOf,
  type ContractorCopy,
  type ContractorSource,
} from '@hfos/core/addons/contractor/views/phone';
import * as React from 'react';
import type * as ReactNative from 'react-native';

import { DALE, LONE_STAR, MARIA, type Phone } from '@/changes/__tests__/harness';

import {
  CO_APPOINTMENTS_SQL,
  CO_COMPANIES_SQL,
  CO_FILES_SQL,
  CO_JOB_ROWS_SQL,
  CO_LINKS_SQL,
  CO_LIST_ROWS_SQL,
  CO_PEOPLE_SQL,
  CO_RECORDS_SQL,
  CO_STAFF_SQL,
  CO_USERS_SQL,
  CO_VISIT_JOBS_SQL,
  CO_VISIT_ROWS_SQL,
  type CopyReach,
} from '../copy';

/**
 * What Contractor Operations' phone tests draw with: a stand-in Screen, a small business in the phone's own SQLite
 * (two open jobs and a finished one, today's visit with its work order, materials, time and notes), and the phone's
 * copy read back with the screens' own SQL, so a test sees what a screen would after a change.
 */
export function TestScreen({
  title,
  subtitle,
  children,
  testID,
}: {
  title?: string;
  subtitle?: string;
  children?: React.ReactNode;
  testID?: string;
}) {
  const RN = jest.requireActual<typeof ReactNative>('react-native');
  return (
    <RN.View testID={testID}>
      <RN.Text testID="screen-title">{title}</RN.Text>
      <RN.Text testID="screen-subtitle">{subtitle}</RN.Text>
      {children}
    </RN.View>
  );
}

export const id = (n: number) => `00000000-0000-4000-9000-${String(n).padStart(12, '0')}`;
export const ROSA = '22222222-2222-4222-8222-222222222222';
export const TYPE_JOB = id(1);
export const TYPE_PROPERTY = id(2);
/** A service call in progress, Dale's, with a visit going on now. */
export const JOB_AC = id(11);
/** A project that's late, Rosa's, with Dale on its team. */
export const JOB_KITCHEN = id(12);
export const JOB_DONE = id(13);
export const PROPERTY = id(14);
export const VISIT_NOW = id(21);
export const VISIT_TOMORROW = id(22);
export const CORE_JOB = id(23);
export const CREW = id(24);
export const ITEM_COIL = id(31);
export const ITEM_PHOTO = id(32);
export const ITEM_TIDY = id(33);
export const MATERIAL_FILTER = id(41);
export const MATERIAL_GAS = id(42);
export const PHASE_DEMO = id(51);
export const PHASE_ROUGH = id(52);
export const PHASE_FINISH = id(53);
export const TIME_TRAVEL = id(61);
export const TIME_WORK = id(62);
export const NOTE_GATE = id(71);
export const NOTE_VOICE = id(72);
export const VOICE_FILE = id(73);

/** The harness's day, where the business is: 3:00 PM in Houston. */
export const TODAY = '2026-09-16';
export const ZONE = 'America/Chicago';

/** Puts the business on the phone, as the Sync Streams would. */
export function seed(p: Phone): void {
  const db = p.db.sqlite;
  const put = (table: string, row: Record<string, string | number | null>) => {
    const columns = Object.keys(row);
    db.prepare(
      `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
    ).run(...Object.values(row));
  };
  const row = (source: string, key: string, jobId: string | null, data: Record<string, unknown>) =>
    put('addon_phone_rows', {
      id: `${source}:${key}`,
      workspace_id: LONE_STAR,
      addon_id: 'contractor',
      source,
      record_id: jobId,
      data: JSON.stringify(data),
    });

  put('users', { id: DALE, full_name: 'Dale Carter', email: 'dale@lonestar.test' });
  put('users', { id: ROSA, full_name: 'Rosa Delgado', email: 'rosa@lonestar.test' });
  db.prepare(`UPDATE people SET phone_e164 = '+17135550142' WHERE id = ?`).run(MARIA);

  put('custom_record_types', {
    id: TYPE_JOB,
    workspace_id: LONE_STAR,
    key: 'contractor_job',
    addon_id: 'contractor',
  });
  put('custom_record_types', {
    id: TYPE_PROPERTY,
    workspace_id: LONE_STAR,
    key: 'contractor_property',
    addon_id: 'contractor',
  });
  for (const [recordId, typeId, name] of [
    [JOB_AC, TYPE_JOB, 'Lopez AC tune-up'],
    [JOB_KITCHEN, TYPE_JOB, 'Hart kitchen remodel'],
    [JOB_DONE, TYPE_JOB, 'Old roof patch'],
    [PROPERTY, TYPE_PROPERTY, '418 Maple Ave, Houston'],
  ] as const)
    put('custom_records', { id: recordId, workspace_id: LONE_STAR, type_id: typeId, name });
  put('relationship_types', {
    id: id(3),
    workspace_id: LONE_STAR,
    addon_id: 'contractor',
    addon_key: 'contractor_customer',
  });
  put('relationship_types', {
    id: id(4),
    workspace_id: LONE_STAR,
    addon_id: 'contractor',
    addon_key: 'contractor_site',
  });
  put('relationships', {
    id: id(5),
    workspace_id: LONE_STAR,
    type_id: id(3),
    a_person_id: MARIA,
    b_custom_record_id: JOB_AC,
    created_at: '2026-09-10T15:00:00.000Z',
  });
  put('relationships', {
    id: id(6),
    workspace_id: LONE_STAR,
    type_id: id(4),
    a_custom_record_id: JOB_AC,
    b_custom_record_id: PROPERTY,
    created_at: '2026-09-10T15:00:00.000Z',
  });

  row('jobs', JOB_AC, JOB_AC, {
    kind: 'service',
    status: 'in_progress',
    status_at: '2026-09-16T19:05:00.000Z',
    status_reason: null,
    trade: 'hvac',
    details: 'Tune up the upstairs unit.',
    starts_on: '2026-09-16',
    due_on: '2026-09-18',
    done_at: null,
    percent_done: 40,
    lead_user_id: DALE,
    updated_at: '2026-09-16T19:05:00.000Z',
  });
  row('jobs', JOB_KITCHEN, JOB_KITCHEN, {
    kind: 'project',
    status: 'in_progress',
    status_at: '2026-09-01T15:00:00.000Z',
    trade: 'remodeling',
    details: null,
    starts_on: '2026-09-01',
    due_on: '2026-09-10',
    percent_done: 50,
    lead_user_id: ROSA,
    updated_at: '2026-09-15T15:00:00.000Z',
  });
  row('jobs', JOB_DONE, JOB_DONE, {
    kind: 'service',
    status: 'done',
    status_at: '2026-09-02T15:00:00.000Z',
    done_at: '2026-09-02T15:00:00.000Z',
    percent_done: 100,
    lead_user_id: DALE,
    updated_at: '2026-09-02T15:00:00.000Z',
  });
  row('team', `${JOB_KITCHEN}:${DALE}`, JOB_KITCHEN, {
    user_id: DALE,
    created_at: '2026-09-01T15:00:00.000Z',
  });
  const phase = (key: string, position: number, name: string, over: Record<string, unknown>) =>
    row('phases', key, JOB_KITCHEN, {
      position,
      name,
      status: 'not_started',
      percent_done: 0,
      starts_on: null,
      due_on: null,
      done_at: null,
      created_at: '2026-09-01T15:00:00.000Z',
      ...over,
    });
  phase(PHASE_DEMO, 0, 'Demo', {
    status: 'done',
    percent_done: 100,
    done_at: '2026-09-04T20:00:00.000Z',
  });
  phase(PHASE_ROUGH, 1, 'Rough-in', {
    status: 'in_progress',
    percent_done: 50,
    due_on: '2026-09-12',
  });
  phase(PHASE_FINISH, 2, 'Finish', {});

  row('crews', CREW, null, { name: 'Crew A' });
  // Today's visit, 2:00 to 4:00 PM, with Dale on it and started; tomorrow's, 9:00 to noon, with Rosa.
  put('appointments', {
    id: VISIT_NOW,
    workspace_id: LONE_STAR,
    kind: 'booking',
    title: 'AC tune-up',
    starts_at: '2026-09-16T19:00:00.000Z',
    ends_at: '2026-09-16T21:00:00.000Z',
    status: 'scheduled',
    location: '418 Maple Ave, Houston, TX 77002',
    job_id: CORE_JOB,
  });
  put('appointments', {
    id: VISIT_TOMORROW,
    workspace_id: LONE_STAR,
    kind: 'booking',
    title: 'Rough-in walk',
    starts_at: '2026-09-17T14:00:00.000Z',
    ends_at: '2026-09-17T17:00:00.000Z',
    status: 'scheduled',
    location: null,
    job_id: null,
  });
  put('jobs', { id: CORE_JOB, workspace_id: LONE_STAR, status: 'in_progress' });
  put('appointment_staff', {
    id: id(25),
    workspace_id: LONE_STAR,
    appointment_id: VISIT_NOW,
    user_id: DALE,
    active: 1,
    created_at: '2026-09-10T15:00:00.000Z',
  });
  put('appointment_staff', {
    id: id(26),
    workspace_id: LONE_STAR,
    appointment_id: VISIT_TOMORROW,
    user_id: ROSA,
    active: 1,
    created_at: '2026-09-10T15:00:00.000Z',
  });
  row('work_orders', VISIT_NOW, JOB_AC, {
    crew_id: CREW,
    instructions: 'Park on the street.',
    bring: 'A 20x25 filter and the gauges.',
  });
  row('work_orders', VISIT_TOMORROW, JOB_KITCHEN, {
    crew_id: null,
    instructions: null,
    bring: null,
  });
  const item = (key: string, position: number, label: string, over: Record<string, unknown>) =>
    row('work_order_items', key, JOB_AC, {
      appointment_id: VISIT_NOW,
      position,
      label,
      kind: 'check',
      required: true,
      done_at: null,
      done_by: null,
      file_id: null,
      skipped_at: null,
      skipped_by: null,
      skip_reason: null,
      created_at: '2026-09-10T15:00:00.000Z',
      ...over,
    });
  item(ITEM_COIL, 0, 'Clean the condenser coil', {});
  item(ITEM_PHOTO, 1, 'Photo of the data plate', { kind: 'photo' });
  item(ITEM_TIDY, 2, 'Tidy up', { required: false });
  const material = (key: string, position: number, over: Record<string, unknown>) =>
    row('materials', key, JOB_AC, {
      position,
      unit_label: 'each',
      appointment_id: null,
      needed: 0,
      ordered: 0,
      delivered: 0,
      used: 0,
      wasted: 0,
      returned: 0,
      supplier: null,
      expected_on: null,
      note: null,
      created_at: '2026-09-10T15:00:00.000Z',
      ...over,
    });
  material(MATERIAL_FILTER, 0, {
    name: 'Filter 20x25',
    appointment_id: VISIT_NOW,
    needed: 2,
    ordered: 2,
    delivered: 2,
  });
  material(MATERIAL_GAS, 1, {
    name: 'Refrigerant',
    unit_label: 'lb',
    needed: 5,
    ordered: 5,
    delivered: 3,
  });
  // Dale drove from 1:30 to 2:00 PM and has been working since 2:05.
  row('time_entries', TIME_TRAVEL, JOB_AC, {
    appointment_id: VISIT_NOW,
    user_id: DALE,
    kind: 'travel',
    started_at: '2026-09-16T18:30:00.000Z',
    ended_at: '2026-09-16T19:00:00.000Z',
    source: 'status',
    auto_stopped: false,
    fixed_at: null,
  });
  row('time_entries', TIME_WORK, JOB_AC, {
    appointment_id: VISIT_NOW,
    user_id: DALE,
    kind: 'work',
    started_at: '2026-09-16T19:05:00.000Z',
    ended_at: null,
    source: 'status',
    auto_stopped: false,
    fixed_at: null,
  });
  row('notes', NOTE_GATE, JOB_AC, {
    appointment_id: VISIT_NOW,
    body: 'Gate code is 4410.',
    audio_file_id: null,
    transcript: null,
    transcript_state: 'none',
    photo_file_ids: [],
    created_by: ROSA,
    noted_at: '2026-09-16T17:00:00.000Z',
  });
  row('notes', NOTE_VOICE, JOB_AC, {
    appointment_id: null,
    body: null,
    audio_file_id: VOICE_FILE,
    transcript: 'The drain line is clogged.',
    transcript_state: 'done',
    photo_file_ids: [],
    created_by: DALE,
    noted_at: '2026-09-15T17:00:00.000Z',
  });
  put('files', {
    id: VOICE_FILE,
    workspace_id: LONE_STAR,
    record_type: 'custom_record',
    record_id: JOB_AC,
    name: 'Voice note.m4a',
    mime_type: 'audio/mp4',
    status: 'ready',
  });
  db.exec('DELETE FROM ps_crud');
}

/** The phone's copy as a screen reads it: the screens' own SQL, run on the phone's SQLite, into core's reader. */
export function readCopy(p: Phone, reach: CopyReach = { kind: 'lists' }): ContractorCopy {
  const all = (sql: string, args: string[]) => p.db.rows<Record<string, unknown>>(sql, args);
  const rows =
    reach.kind === 'job'
      ? all(CO_JOB_ROWS_SQL, [LONE_STAR, reach.jobId])
      : reach.kind === 'visit'
        ? all(CO_VISIT_ROWS_SQL, [LONE_STAR, `work_orders:${reach.appointmentId}`])
        : all(CO_LIST_ROWS_SQL, [LONE_STAR]);
  return contractorCopyOf({
    records: all(CO_RECORDS_SQL, [LONE_STAR]),
    rows,
    links: all(CO_LINKS_SQL, [LONE_STAR]),
    people: all(CO_PEOPLE_SQL, [LONE_STAR]),
    companies: all(CO_COMPANIES_SQL, [LONE_STAR]),
    users: all(CO_USERS_SQL, []),
    appointments: all(CO_APPOINTMENTS_SQL, [LONE_STAR]),
    staff: all(CO_STAFF_SQL, [LONE_STAR]),
    visitJobs: all(CO_VISIT_JOBS_SQL, [LONE_STAR]),
    files: all(CO_FILES_SQL, [LONE_STAR]),
  } as unknown as ContractorSource);
}
