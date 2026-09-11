import { and, eq } from 'drizzle-orm';
import { companies, people, tags, recordTags, users, workspaces } from '@hfos/db/schema';
import type { Tx } from '@hfos/db/client';
import { HfosError } from '../errors';
import { formatPhone } from './phone';

export const fullName = (first: string, last: string): string => `${first} ${last}`.trim();

export interface AddressRow {
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  country: string;
}
export const addressOut = (r: AddressRow) => ({
  line1: r.addressLine1,
  line2: r.addressLine2,
  city: r.city,
  state: r.state,
  postalCode: r.postalCode,
  country: r.country,
});
export const addressPatch = (
  a:
    | {
        line1?: string | null;
        line2?: string | null;
        city?: string | null;
        state?: string | null;
        postalCode?: string | null;
        country?: string;
      }
    | undefined,
) =>
  a === undefined
    ? {}
    : {
        ...(a.line1 !== undefined ? { addressLine1: a.line1 } : {}),
        ...(a.line2 !== undefined ? { addressLine2: a.line2 } : {}),
        ...(a.city !== undefined ? { city: a.city } : {}),
        ...(a.state !== undefined ? { state: a.state } : {}),
        ...(a.postalCode !== undefined ? { postalCode: a.postalCode } : {}),
        ...(a.country !== undefined ? { country: a.country } : {}),
      };

export const phoneOut = (e164: string | null) => (e164 ? formatPhone(e164) : null);

export async function workspaceTimezone(tx: Tx, workspaceId: string): Promise<string> {
  const [ws] = await tx
    .select({ timezone: workspaces.timezone })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId));
  return ws?.timezone ?? 'America/Chicago';
}

export async function userRef(
  tx: Tx,
  userId: string | null,
): Promise<{ id: string; fullName: string } | null> {
  if (!userId) return null;
  const [u] = await tx
    .select({ id: users.id, fullName: users.fullName, email: users.email })
    .from(users)
    .where(eq(users.id, userId));
  return u ? { id: u.id, fullName: u.fullName || u.email } : null;
}

export async function requirePerson(tx: Tx, workspaceId: string, personId: string) {
  const [p] = await tx
    .select()
    .from(people)
    .where(and(eq(people.id, personId), eq(people.workspaceId, workspaceId)));
  if (!p) throw HfosError.notFound('Person not found.');
  return p;
}
export async function requireCompany(tx: Tx, workspaceId: string, companyId: string) {
  const [c] = await tx
    .select()
    .from(companies)
    .where(and(eq(companies.id, companyId), eq(companies.workspaceId, workspaceId)));
  if (!c) throw HfosError.notFound('Company not found.');
  return c;
}

/** Tags attached to one record, in name order. */
export async function tagsOf(
  tx: Tx,
  workspaceId: string,
  recordType: 'person' | 'company' | 'lead',
  recordId: string,
) {
  const list = await tx
    .select({ id: tags.id, name: tags.name, color: tags.color })
    .from(recordTags)
    .innerJoin(tags, eq(tags.id, recordTags.tagId))
    .where(
      and(
        eq(recordTags.workspaceId, workspaceId),
        eq(recordTags.recordType, recordType),
        eq(recordTags.recordId, recordId),
      ),
    )
    .orderBy(tags.name);
  return list;
}

/** Tags for many records at once: recordId → tags. */
export async function tagsByRecord(
  tx: Tx,
  workspaceId: string,
  recordType: 'person' | 'company' | 'lead',
  recordIds: string[],
) {
  const map = new Map<string, { id: string; name: string; color: string }[]>();
  if (recordIds.length === 0) return map;
  const list = await tx
    .select({ recordId: recordTags.recordId, id: tags.id, name: tags.name, color: tags.color })
    .from(recordTags)
    .innerJoin(tags, eq(tags.id, recordTags.tagId))
    .where(and(eq(recordTags.workspaceId, workspaceId), eq(recordTags.recordType, recordType)))
    .orderBy(tags.name);
  const wanted = new Set(recordIds);
  for (const row of list) {
    if (!wanted.has(row.recordId)) continue;
    const arr = map.get(row.recordId) ?? [];
    arr.push({ id: row.id, name: row.name, color: row.color });
    map.set(row.recordId, arr);
  }
  return map;
}

/** Replaces a record's tags with the given set; tags must belong to the workspace (RLS enforces it too). */
export async function setRecordTags(
  tx: Tx,
  workspaceId: string,
  recordType: 'person' | 'company' | 'lead',
  recordId: string,
  tagIds: string[],
  createdBy: string | null,
) {
  await tx
    .delete(recordTags)
    .where(
      and(
        eq(recordTags.workspaceId, workspaceId),
        eq(recordTags.recordType, recordType),
        eq(recordTags.recordId, recordId),
      ),
    );
  const unique = [...new Set(tagIds)];
  if (unique.length > 0) {
    await tx
      .insert(recordTags)
      .values(unique.map((tagId) => ({ workspaceId, tagId, recordType, recordId, createdBy })));
  }
  return tagsOf(tx, workspaceId, recordType, recordId);
}

/** A safe object name segment: keeps letters, digits, dots, dashes and underscores. */
export function safeFileName(name: string): string {
  const cleaned = name
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
  return cleaned || 'file';
}
