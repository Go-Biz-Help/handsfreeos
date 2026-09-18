import type { SyncedNames } from '@hfos/core';
import { useQuery } from '@powersync/react-native';
import * as React from 'react';

import { useBusiness } from '@/components/shell/business-context';

import { MEMBERS_SQL, RECORD_TAGS_SQL } from './queries';

/**
 * The name book core's `crm/synced.ts` asks for: who a row's person, company, lead, owner or assignee is, and which
 * tags a record wears. It is filled from the phone's copy, so a card names a customer the moment they sync, with no
 * round trip.
 *
 * People, companies and leads are read as light rows (id and name only) rather than whole records: a business with
 * three thousand customers would otherwise carry its whole address book in memory for one card's sub-line.
 */

interface NameRow {
  readonly id: string;
  readonly a: string | null;
  readonly b: string | null;
  readonly archived: string | null;
}

const PEOPLE_NAMES_SQL =
  'SELECT id, first_name AS a, last_name AS b, archived_at AS archived FROM people WHERE workspace_id = ?';
const COMPANY_NAMES_SQL =
  'SELECT id, name AS a, NULL AS b, archived_at AS archived FROM companies WHERE workspace_id = ?';
const LEAD_NAMES_SQL =
  'SELECT id, title AS a, NULL AS b, archived_at AS archived FROM leads WHERE workspace_id = ?';

export interface MemberRef {
  readonly id: string;
  readonly fullName: string;
}

/** Everyone who works here, by name. */
export function useMembers(): readonly MemberRef[] {
  const { business } = useBusiness();
  const { data } = useQuery<{ id: string; full_name: string | null }>(MEMBERS_SQL, [
    business.id,
    business.id,
  ]);
  return React.useMemo(() => data.map((m) => ({ id: m.id, fullName: m.full_name ?? '' })), [data]);
}

export function useNames(): SyncedNames {
  const { business } = useBusiness();
  const { data: people } = useQuery<NameRow>(PEOPLE_NAMES_SQL, [business.id]);
  const { data: companies } = useQuery<NameRow>(COMPANY_NAMES_SQL, [business.id]);
  const { data: leads } = useQuery<NameRow>(LEAD_NAMES_SQL, [business.id]);
  const { data: tagRows } = useQuery<{
    record_id: string;
    id: string;
    name: string;
    color: string;
  }>(RECORD_TAGS_SQL, [business.id]);
  const members = useMembers();

  return React.useMemo(() => {
    const peopleBy = new Map(
      people.map((r) => [
        r.id,
        { fullName: `${r.a ?? ''} ${r.b ?? ''}`.trim(), archived: !!r.archived },
      ]),
    );
    const companiesBy = new Map(
      companies.map((r) => [r.id, { name: r.a ?? '', archived: !!r.archived }]),
    );
    const leadsBy = new Map(leads.map((r) => [r.id, { title: r.a ?? '' }]));
    const usersBy = new Map(members.map((m) => [m.id, m.fullName]));
    const tagsBy = new Map<string, { id: string; name: string; color: string }[]>();
    for (const row of tagRows) {
      const list = tagsBy.get(row.record_id) ?? [];
      list.push({ id: row.id, name: row.name, color: row.color });
      tagsBy.set(row.record_id, list);
    }
    return {
      person: (id) => (id ? (peopleBy.get(id) ?? null) : null),
      company: (id) => (id ? (companiesBy.get(id) ?? null) : null),
      lead: (id) => (id ? (leadsBy.get(id) ?? null) : null),
      user: (id) => (id ? (usersBy.get(id) ?? null) : null),
      tags: (recordId) => tagsBy.get(recordId) ?? [],
    };
  }, [people, companies, leads, tagRows, members]);
}
