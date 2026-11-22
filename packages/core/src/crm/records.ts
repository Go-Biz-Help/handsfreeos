import { and, eq, inArray, isNull, notInArray } from 'drizzle-orm';
import { companies, people, tags, recordTags, users, workspaces } from '@hfos/db/schema';
import { rows, sql, type Tx } from '@hfos/db/client';
import { HfosError } from '../errors';
import { formatPhone } from './phone';

export const fullName = (first: string, last: string): string => `${first} ${last}`.trim();

/**
 * Whether a customer's name is only the stand-in they were saved under before they said (`intakeName`): their
 * number, or the part of their email before the @, with no last name. It counts as blank, so the name they give the
 * AI teammate or type into a form replaces it, first and last together. Treated as a real name, the first stayed the
 * number and only the last was filled in: "(512) 555-0100 Rivera".
 */
export function isStandInName(person: {
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly phoneE164?: string | null;
  readonly email?: string | null;
}): boolean {
  const first = (person.firstName ?? '').trim();
  if (!first || (person.lastName ?? '').trim()) return false;
  if (person.phoneE164 && first === formatPhone(person.phoneE164).slice(0, 80)) return true;
  const local = person.email?.split('@')[0];
  return !!local && first === local.slice(0, 80);
}

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

/**
 * The person, when they are one of this business’s own people; null when they aren’t. The founder working in a
 * business as its owner (20261013002100) is never on its team, so what they make there isn’t theirs to look after:
 * a new calendar, invoice or estimate is left with nobody rather than with someone who will leave.
 */
export async function ownPersonOrNull(
  tx: Tx,
  workspaceId: string,
  userId: string | null,
): Promise<string | null> {
  if (!userId) return null;
  const [r] = await rows<{ ok: boolean }>(
    tx,
    sql`select private.workspace_has_user(${workspaceId}::uuid, ${userId}::uuid) as ok`,
  );
  return r?.ok ? userId : null;
}

export async function requirePerson(tx: Tx, workspaceId: string, personId: string) {
  const [p] = await tx
    .select()
    .from(people)
    .where(
      and(
        eq(people.id, personId),
        eq(people.workspaceId, workspaceId),
        isNull(people.binItemId),
        isNull(people.erasedAt),
      ),
    );
  if (!p) throw await personGone(tx, workspaceId, personId);
  return p;
}

/**
 * Why a customer isn't there: in the Deleted bin (20261027000400), where an owner can bring them back; deleted for
 * good, with only the name their bills keep; or not there at all. Their row stays readable for their bills.
 */
export async function personGone(
  tx: Tx,
  workspaceId: string,
  personId: string,
): Promise<HfosError> {
  const [p] = await tx
    .select({
      firstName: people.firstName,
      lastName: people.lastName,
      binItemId: people.binItemId,
      erasedAt: people.erasedAt,
    })
    .from(people)
    .where(and(eq(people.id, personId), eq(people.workspaceId, workspaceId)));
  if (p?.binItemId)
    return HfosError.rule(
      'person_in_bin',
      404,
      `${fullName(p.firstName, p.lastName) || 'This customer'} was deleted. An owner can bring them back from Settings → Deleted bin.`,
    );
  if (p?.erasedAt)
    return HfosError.rule(
      'person_deleted',
      404,
      'This customer was deleted for good. Only their name is kept, on their bills.',
    );
  return HfosError.notFound(
    'That customer isn’t there anymore. It may have been deleted. Refresh and try again.',
  );
}
export async function requireCompany(tx: Tx, workspaceId: string, companyId: string) {
  const [c] = await tx
    .select()
    .from(companies)
    .where(and(eq(companies.id, companyId), eq(companies.workspaceId, workspaceId)));
  if (!c)
    throw HfosError.notFound(
      'That company isn’t there anymore. It may have been deleted. Refresh and try again.',
    );
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
    .where(
      and(
        eq(recordTags.workspaceId, workspaceId),
        eq(recordTags.recordType, recordType),
        inArray(recordTags.recordId, recordIds),
      ),
    )
    .orderBy(tags.name);
  for (const row of list) {
    const arr = map.get(row.recordId) ?? [];
    arr.push({ id: row.id, name: row.name, color: row.color });
    map.set(row.recordId, arr);
  }
  return map;
}

/**
 * Replaces a record's tags with the given set; tags must belong to the workspace (RLS enforces it too). `at` is when
 * they were put on (the change's moment), now when left out. A tag it keeps keeps its row, and so when it went on; one
 * it takes off is remembered as taken off then (0063).
 */
export async function setRecordTags(
  tx: Tx,
  workspaceId: string,
  recordType: 'person' | 'company' | 'lead',
  recordId: string,
  tagIds: string[],
  createdBy: string | null,
  at?: Date,
) {
  const unique = [...new Set(tagIds)];
  await tx
    .delete(recordTags)
    .where(
      and(
        eq(recordTags.workspaceId, workspaceId),
        eq(recordTags.recordType, recordType),
        eq(recordTags.recordId, recordId),
        ...(unique.length > 0 ? [notInArray(recordTags.tagId, unique)] : []),
      ),
    );
  if (unique.length > 0) {
    await tx
      .insert(recordTags)
      .values(
        unique.map((tagId) => ({
          workspaceId,
          tagId,
          recordType,
          recordId,
          createdBy,
          ...(at ? { createdAt: at } : {}),
        })),
      )
      .onConflictDoNothing();
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
