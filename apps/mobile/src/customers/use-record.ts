import {
  addressLine,
  balanceCents,
  fileOfSynced,
  leadCardOfSynced,
  personOfSynced,
  companyOfSynced,
  taskOfSynced,
  timelineEntryOfSynced,
  timelineOrder,
  type FileOut,
  type LeadCard,
  type PersonSummary,
  type SyncedCompany,
  type SyncedNames,
  type TaskOut,
  type TimelineEntry,
} from '@hfos/core';
import { useQuery } from '@powersync/react-native';
import * as React from 'react';

import { useBusiness } from '@/components/shell/business-context';
import type { PhotoRow } from '@/changes/photos';
import { sees } from '@/view-as/state';
import { useLens } from '@/view-as/use-lens';

import { useNames } from './names';
import {
  useRecordChanges,
  usePhotoUploads,
  stateOf,
  type RecordChange,
  type RecordState,
} from './outbox';
import {
  COMPANY_PEOPLE_SQL,
  COMPANY_SQL,
  FILES_SQL,
  NEXT_APPOINTMENT_SQL,
  PERSON_SQL,
  RECORD_INVOICES_SQL,
  RECORD_LEADS_SQL,
  RECORD_TASKS_SQL,
  TIMELINE_FOR,
  WORKSPACE_SQL,
} from './queries';

/**
 * One customer, company or lead from the phone's copy: the head, what they owe, their leads, timeline, tasks, files
 * and the next visit — everything the web's record page shows, worked out here rather than asked for.
 *
 * What the phone has to work out for itself: the balance (a generated column never replicates), the open-lead count,
 * and the last thing that happened. Everything else is core's, from the very functions the server's answers go
 * through.
 */

export type RecordKind = 'person' | 'company';

export interface NextVisit {
  readonly id: string;
  readonly title: string | null;
  readonly startsAt: string;
  readonly status: string | null;
  /** A time asked for with no signal, which the server hasn't confirmed: the canvas's "Not booked yet". */
  readonly notBookedYet: boolean;
}

export interface RecordData {
  readonly loading: boolean;
  readonly person:
    | (PersonSummary & {
        readonly notes: string | null;
        readonly possibleDuplicateOf: string | null;
      })
    | null;
  readonly company: SyncedCompany | null;
  readonly companyPeople: readonly {
    readonly id: string;
    readonly fullName: string;
    readonly archived: boolean;
    readonly detail: string | null;
  }[];
  readonly leads: readonly LeadCard[];
  readonly tasks: readonly TaskOut[];
  readonly files: readonly FileOut[];
  /** Photos this phone is still uploading for the record, shown above the files that landed. */
  readonly uploading: readonly PhotoRow[];
  readonly timeline: readonly TimelineEntry[];
  readonly balanceCents: number;
  readonly nextVisit: NextVisit | null;
  readonly names: SyncedNames;
  readonly timeZone: string;
  /** What this phone still has to say about the record: changes waiting, and a refusal to show. */
  readonly state: RecordState;
  /** Every CRM change on this phone, so a row can say "waiting to send" where it was made. */
  readonly changes: readonly RecordChange[];
  readonly address: string;
}

/** The business's time zone, for due dates and appointment times. */
export function useTimeZone(): string {
  const { business } = useBusiness();
  const { data } = useQuery<{ timezone: string | null }>(WORKSPACE_SQL, [business.id]);
  return data[0]?.timezone || business.timezone;
}

export function useRecord(kind: RecordKind, recordId: string): RecordData {
  const { business } = useBusiness();
  const names = useNames();
  const timeZone = useTimeZone();
  const changes = useRecordChanges();
  const photos = usePhotoUploads();

  const isPerson = kind === 'person';
  const isCompany = kind === 'company';
  const { data: personRows, isLoading: personLoading } = useQuery<Record<string, string | null>>(
    PERSON_SQL,
    [isPerson ? recordId : ''],
  );
  const { data: companyRows, isLoading: companyLoading } = useQuery<Record<string, string | null>>(
    COMPANY_SQL,
    [isCompany ? recordId : ''],
  );
  const { data: companyPeopleRows } = useQuery<{
    id: string;
    first_name: string | null;
    last_name: string | null;
    email: string | null;
    phone: string | null;
    archived_at: string | null;
  }>(COMPANY_PEOPLE_SQL, [isCompany ? recordId : '']);
  const { data: leadRows } = useQuery<Record<string, string | null>>(RECORD_LEADS_SQL, [
    business.id,
    isPerson ? recordId : '',
    isCompany ? recordId : '',
  ]);
  const { data: taskRows } = useQuery<Record<string, string | null>>(RECORD_TASKS_SQL, [
    business.id,
    isPerson ? recordId : '',
    isCompany ? recordId : '',
    '',
  ]);
  const { data: fileRows } = useQuery<Record<string, string | null>>(FILES_SQL, [
    business.id,
    kind,
    recordId,
  ]);
  const { data: timelineRows } = useQuery<Record<string, string | null>>(
    TIMELINE_FOR(isPerson ? 'person_id' : 'company_id'),
    [business.id, recordId],
  );
  const { data: allInvoiceRows } = useQuery<{
    id: string;
    total_cents: number | null;
    amount_paid_cents: number | null;
    amount_refunded_cents: number | null;
  }>(RECORD_INVOICES_SQL, [business.id, isPerson ? recordId : '']);
  // Viewing as a teammate (20261018000100): what they're owed is from the bills they see.
  const lens = useLens();
  const invoiceRows = React.useMemo(
    () => allInvoiceRows.filter((r) => sees(lens?.invoices, r.id)),
    [allInvoiceRows, lens],
  );
  const nowIso = React.useMemo(() => new Date().toISOString(), []);
  const { data: apptRows } = useQuery<{
    id: string;
    title: string | null;
    starts_at: string | null;
    status: string | null;
  }>(NEXT_APPOINTMENT_SQL, [business.id, isPerson ? recordId : '', nowIso]);

  return React.useMemo(() => {
    const personRow = personRows[0];
    const companyRow = companyRows[0];
    const person =
      isPerson && personRow
        ? personOfSynced(personRow as never, names, {
            openLeads: leadRows.filter((l) => l.status === 'open' && !l.archived_at).length,
            lastActivityAt: (timelineRows[0]?.occurred_at as string | undefined) ?? null,
          })
        : null;
    const company = isCompany && companyRow ? companyOfSynced(companyRow as never, names) : null;
    const leads = leadRows.map((row) =>
      leadCardOfSynced(
        row as never,
        {
          id: (row.stage_id as string) ?? '',
          pipeline_id: row.stage_pipeline_id,
          name: row.stage_name,
          kind: row.stage_kind,
          position: Number(row.stage_position ?? 0),
        },
        names,
      ),
    );
    const appt = apptRows[0];
    const address = person
      ? addressLine(person.address)
      : company
        ? addressLine(company.address)
        : '';
    return {
      loading: (isPerson && personLoading) || (isCompany && companyLoading),
      person,
      company,
      companyPeople: companyPeopleRows.map((p) => ({
        id: p.id,
        fullName: `${p.first_name ?? ''} ${p.last_name ?? ''}`.trim(),
        archived: !!p.archived_at,
        detail: p.phone ?? p.email ?? null,
      })),
      leads,
      tasks: taskRows.map((row) => taskOfSynced(row as never, names, timeZone)),
      files: fileRows.map((row) => fileOfSynced(row as never, names)),
      uploading: photos.filter((p) => p.record_id === recordId),
      timeline: timelineOrder(
        timelineRows.map((row) => timelineEntryOfSynced(row as never, names)),
      ),
      balanceCents: invoiceRows.reduce(
        (a, i) =>
          a +
          Math.max(
            0,
            balanceCents(
              Number(i.total_cents ?? 0),
              Number(i.amount_paid_cents ?? 0),
              Number(i.amount_refunded_cents ?? 0),
            ),
          ),
        0,
      ),
      nextVisit: appt?.starts_at
        ? {
            id: appt.id,
            title: appt.title,
            startsAt: appt.starts_at,
            status: appt.status,
            notBookedYet: appt.status === 'requested' || appt.status === 'pending',
          }
        : null,
      names,
      timeZone,
      state: stateOf(changes, recordId),
      changes,
      address,
    };
  }, [
    personRows,
    companyRows,
    companyPeopleRows,
    leadRows,
    taskRows,
    fileRows,
    timelineRows,
    invoiceRows,
    apptRows,
    photos,
    names,
    timeZone,
    changes,
    recordId,
    isPerson,
    isCompany,
    personLoading,
    companyLoading,
  ]);
}
