/**
 * What a new document starts with when it was opened from somewhere: `?person=` fills the customer in and
 * `?lead=` fills in the customer, the job it is for and who owns it. Anything unrecognised is ignored.
 */
import type { ApiClient } from '@hfos/api-client';
import { allowed } from './load';
import { unwrapPage } from '@/lib/api/server';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface DocumentSeed {
  person?: { id: string; fullName: string; email: string | null; phone: string | null };
  leadId?: string | null;
  title?: string;
  assigneeUserId?: string | null;
}

const one = (v: string | string[] | undefined): string =>
  (Array.isArray(v) ? (v[0] ?? '') : (v ?? '')).trim();

export async function seedFrom(
  api: ApiClient,
  workspaceId: string,
  sp: Record<string, string | string[] | undefined>,
): Promise<DocumentSeed> {
  const leadId = one(sp.lead);
  const lead = UUID.test(leadId)
    ? await allowed(
        api
          .POST('/v1/queries/lead.get', { body: { workspaceId, leadId } })
          .then((r) => unwrapPage(r)),
      )
    : null;
  // The lead's own summary carries a name but no address or mobile, and sending needs one of those.
  const personId = lead?.lead.person?.id ?? one(sp.person);
  const person = UUID.test(personId)
    ? await allowed(
        api
          .POST('/v1/queries/person.get', { body: { workspaceId, personId } })
          .then((r) => unwrapPage(r)),
      )
    : null;
  if (!person) return {};
  return {
    person: {
      id: person.person.id,
      fullName: person.person.fullName,
      email: person.person.email,
      phone: person.person.phone,
    },
    leadId: lead?.lead.id ?? null,
    title: lead?.lead.title,
    assigneeUserId: lead?.lead.assignee?.id ?? null,
  };
}
