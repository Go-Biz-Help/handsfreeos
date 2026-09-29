import {
  addressLine,
  companyOfSynced,
  leadCardOfSynced,
  personOfSynced,
  type PersonSummary,
  type SyncedCompany,
} from '@hfos/core';
import { useQuery } from '@powersync/react-native';
import * as React from 'react';

import { useBusiness } from '@/components/shell/business-context';
import { companySearchText, leadSearchText, matchesSearch, personSearchText } from '@/sync/compute';

import { useNames } from './names';
import { CLIENT_MARKS_SQL, COMPANIES_SQL, LEADS_SQL, NOTES_SQL, PEOPLE_SQL } from './queries';

/**
 * Customers, companies and leads from the phone's copy, and the search across all three.
 *
 * `search_text` is a generated column, so it never reaches a phone: `sync/compute.ts` works out the same text from
 * the columns that do (name, email, number, city, street). The phone looks in **one more place than the web does** —
 * the notes written about a customer — because in a truck what you remember is "the one with the dog", not their
 * surname. That's the only difference; a search that matches on the web matches here.
 */

export type CustomerTab = 'people' | 'companies';

/** Everyone, only the leads, or only the clients: the web's filter on Contacts. */
export type Standing = 'all' | 'lead' | 'client';

export interface PersonRow extends PersonSummary {
  readonly notes: string | null;
  /** The line under the name: their company, or where they live. */
  readonly detail: string;
  readonly openLeads: number;
  /** Someone the business works or worked for, or was paid by (the database's mark); otherwise a lead. */
  readonly client: boolean;
}

export interface CompanyRow extends SyncedCompany {
  readonly peopleCount: number;
  readonly openLeads: number;
  readonly detail: string;
  readonly client: boolean;
}

/** The rows a standing keeps: everyone, or only the leads or the clients. */
export function withStanding<T extends { readonly client: boolean }>(
  rows: readonly T[],
  standing: Standing,
): readonly T[] {
  return standing === 'all' ? rows : rows.filter((r) => r.client === (standing === 'client'));
}

export interface SearchHit {
  readonly kind: 'person' | 'company' | 'lead';
  readonly id: string;
  readonly title: string;
  readonly detail: string;
  /** Matched on a word someone wrote in a note, not on the name or number. */
  readonly inNote: boolean;
}

const byName = (a: { fullName?: string; name?: string }, b: { fullName?: string; name?: string }) =>
  (a.fullName ?? a.name ?? '').localeCompare(b.fullName ?? b.name ?? '');

export function useCustomers(opts: { readonly archived?: boolean } = {}) {
  const { business } = useBusiness();
  const names = useNames();
  const { data: peopleRows, isLoading } = useQuery<Record<string, string | null>>(PEOPLE_SQL, [
    business.id,
  ]);
  const { data: companyRows } = useQuery<Record<string, string | null>>(COMPANIES_SQL, [
    business.id,
  ]);
  const { data: leadRows } = useQuery<Record<string, string | null>>(LEADS_SQL, [business.id]);
  const { data: markRows } = useQuery<{ id: string }>(CLIENT_MARKS_SQL, [business.id]);
  const archived = opts.archived ?? false;

  return React.useMemo(() => {
    const clients = new Set(markRows.map((m) => m.id));
    const openLeadsBy = new Map<string, number>();
    for (const l of leadRows) {
      if (l.status !== 'open' || l.archived_at) continue;
      for (const key of [l.person_id, l.company_id]) {
        if (key) openLeadsBy.set(key, (openLeadsBy.get(key) ?? 0) + 1);
      }
    }
    const peopleBy = new Map<string, number>();
    for (const p of peopleRows)
      if (p.company_id) peopleBy.set(p.company_id, (peopleBy.get(p.company_id) ?? 0) + 1);

    const people: PersonRow[] = peopleRows
      .filter((r) => !!r.archived_at === archived)
      .map((row) => {
        const person = personOfSynced(row as never, names, {
          openLeads: openLeadsBy.get(row.id as string) ?? 0,
        });
        return {
          ...person,
          detail: person.company?.name || addressLine(person.address) || person.phone || '',
          openLeads: openLeadsBy.get(person.id) ?? 0,
          client: clients.has(person.id),
        };
      })
      .sort(byName);

    const companies: CompanyRow[] = companyRows
      .filter((r) => !!r.archived_at === archived)
      .map((row) => {
        const company = companyOfSynced(row as never, names);
        return {
          ...company,
          peopleCount: peopleBy.get(company.id) ?? 0,
          openLeads: openLeadsBy.get(company.id) ?? 0,
          detail: addressLine(company.address) || company.phone || company.email || '',
          client: clients.has(company.id),
        };
      })
      .sort(byName);

    return { people, companies, loading: isLoading };
  }, [peopleRows, companyRows, leadRows, markRows, names, archived, isLoading]);
}

/**
 * Search across customers, companies and leads, in the phone's copy: name, number, email, city and street the way
 * `sync/compute.ts` builds them, and then a word in a note.
 */
export function useCustomerSearch(typed: string): readonly SearchHit[] {
  const { business } = useBusiness();
  const names = useNames();
  const { data: peopleRows } = useQuery<Record<string, string | null>>(PEOPLE_SQL, [business.id]);
  const { data: companyRows } = useQuery<Record<string, string | null>>(COMPANIES_SQL, [
    business.id,
  ]);
  const { data: leadRows } = useQuery<Record<string, string | null>>(LEADS_SQL, [business.id]);
  const { data: noteRows } = useQuery<{
    id: string;
    person_id: string | null;
    company_id: string | null;
    lead_id: string | null;
    body: string | null;
  }>(NOTES_SQL, [business.id]);

  return React.useMemo(() => {
    const q = typed.trim();
    if (q.length < 2) return [];
    const hits: SearchHit[] = [];
    const seen = new Set<string>();
    const add = (hit: SearchHit) => {
      if (seen.has(`${hit.kind}:${hit.id}`)) return;
      seen.add(`${hit.kind}:${hit.id}`);
      hits.push(hit);
    };

    for (const row of peopleRows) {
      if (row.archived_at) continue;
      if (!matchesSearch(personSearchText(row as never), q)) continue;
      const person = personOfSynced(row as never, names);
      add({
        kind: 'person',
        id: person.id,
        title: person.fullName,
        detail: person.phone ?? person.email ?? addressLine(person.address),
        inNote: false,
      });
    }
    for (const row of companyRows) {
      if (row.archived_at) continue;
      if (!matchesSearch(companySearchText(row as never), q)) continue;
      const company = companyOfSynced(row as never, names);
      add({
        kind: 'company',
        id: company.id,
        title: company.name,
        detail: company.phone ?? company.email ?? addressLine(company.address),
        inNote: false,
      });
    }
    for (const row of leadRows) {
      if (row.archived_at) continue;
      if (!matchesSearch(leadSearchText(row as never), q)) continue;
      const lead = leadCardOfSynced(row as never, null, names);
      add({
        kind: 'lead',
        id: lead.id,
        title: lead.title,
        detail: lead.person?.fullName ?? lead.company?.name ?? '',
        inNote: false,
      });
    }

    // Then a word someone wrote in a note. The record it belongs to is named, so the hit reads like the others.
    const lower = q.toLowerCase();
    for (const note of noteRows) {
      if (!note.body || !note.body.toLowerCase().includes(lower)) continue;
      if (note.person_id) {
        const found = names.person(note.person_id);
        if (found)
          add({
            kind: 'person',
            id: note.person_id,
            title: found.fullName,
            detail: noteExcerpt(note.body, lower),
            inNote: true,
          });
      } else if (note.company_id) {
        const found = names.company(note.company_id);
        if (found)
          add({
            kind: 'company',
            id: note.company_id,
            title: found.name,
            detail: noteExcerpt(note.body, lower),
            inNote: true,
          });
      } else if (note.lead_id) {
        const found = names.lead(note.lead_id);
        if (found)
          add({
            kind: 'lead',
            id: note.lead_id,
            title: found.title,
            detail: noteExcerpt(note.body, lower),
            inNote: true,
          });
      }
    }
    return hits;
  }, [typed, peopleRows, companyRows, leadRows, noteRows, names]);
}

/** The few words around the match in a note, so the row says why it matched. */
function noteExcerpt(body: string, lower: string): string {
  const at = body.toLowerCase().indexOf(lower);
  const from = Math.max(0, at - 24);
  const text = body
    .slice(from, from + 72)
    .replace(/\s+/g, ' ')
    .trim();
  return `${from > 0 ? '…' : ''}${text}${from + 72 < body.length ? '…' : ''}`;
}
