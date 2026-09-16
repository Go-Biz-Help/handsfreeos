/**
 * What a person who deletes their account would leave without an owner (M10), and how it is handed over.
 *
 * - **A business** keeps an owner through another person who owns it directly, or an owner of its organization. A
 *   business's only owner makes someone else an owner in Members (membership.change_role).
 * - **An organization** keeps an owner only through another owner of the organization, and nothing but creating one
 *   made organization memberships. So:
 *   - one that holds a **single business** is that business's: when its last owner goes, it passes to the business's
 *     other direct owners (private.add_organization_owner, in the same transaction as the deletion request). Making
 *     someone an owner of the business is all it takes, as the web's Delete my account page says;
 *   - an **agency** (several businesses) is handed over on purpose (organization.add_owner), only to someone who already
 *     owns one of its businesses, because its owner reaches every business in it.
 *
 * Who is an only owner is the database's own last-owner rules, tried on each of the person's owner memberships in a
 * savepoint that is always undone: they see every owner, including an agency's the person can't see themselves.
 */
import { rows, sql, type Tx } from '@hfos/db/client';
import { HfosError } from '../errors';

/** The rule a trigger raised (its `detail`), from a driver error. */
export function pgDetail(e: unknown): string | undefined {
  let err: unknown = e;
  while (err instanceof Error && err.cause instanceof Error) err = err.cause;
  return (err as { detail?: string } | null)?.detail;
}

/** "A", "A and B", "A, B and C". */
export function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** Thrown inside a probe's savepoint so it always rolls back. */
const UNDO = Symbol('undo');

/** Runs `fn` in a savepoint that is always rolled back, and returns what it found. */
export async function undone<T>(tx: Tx, fn: (sp: Tx) => Promise<T>): Promise<T> {
  let found: T | undefined;
  try {
    await tx.transaction(async (sp) => {
      found = await fn(sp as unknown as Tx);
      throw UNDO;
    });
  } catch (e) {
    if (e !== UNDO) throw e;
  }
  return found as T;
}

export interface PersonRef {
  readonly userId: string;
  readonly fullName: string;
  readonly email: string;
}

/** An organization holding a single business whose last owner is the person, and that business's other owners. */
export interface SoleBusinessHandOver {
  readonly organizationId: string;
  readonly organizationName: string;
  readonly workspaceId: string;
  /** The business's name: to the people in it, the organization is the business. */
  readonly name: string;
  readonly to: readonly PersonRef[];
}

/** The organizations that pass to their only business's other owners when the person goes (none when nobody else owns it). */
export async function soleBusinessHandOvers(
  tx: Tx,
  userId: string,
): Promise<SoleBusinessHandOver[]> {
  const found = await rows<{
    organization_id: string;
    organization_name: string;
    workspace_id: string;
    name: string;
    to_user_id: string;
    to_name: string;
    to_email: string;
  }>(
    tx,
    sql`select o.id as organization_id, o.name as organization_name, w.id as workspace_id, w.name,
          u.id as to_user_id, u.full_name as to_name, u.email::text as to_email
        from app.organization_memberships om
        join app.organizations o on o.id = om.organization_id
        join app.workspaces w on w.organization_id = o.id
        join app.workspace_memberships wm on wm.workspace_id = w.id and wm.role = 'owner' and wm.user_id <> ${userId}
        join app.users u on u.id = wm.user_id and u.deleted_at is null
        where om.user_id = ${userId} and om.role = 'owner'
          and not exists (select 1 from app.organization_memberships o2
                          where o2.organization_id = o.id and o2.role = 'owner' and o2.user_id <> ${userId})
          and (select count(*) from app.workspaces w2 where w2.organization_id = o.id) = 1
        order by o.name, wm.created_at`,
  );
  const out = new Map<string, SoleBusinessHandOver & { to: PersonRef[] }>();
  for (const r of found) {
    const entry = out.get(r.organization_id) ?? {
      organizationId: r.organization_id,
      organizationName: r.organization_name,
      workspaceId: r.workspace_id,
      name: r.name,
      to: [],
    };
    entry.to.push({ userId: r.to_user_id, fullName: r.to_name, email: r.to_email });
    out.set(r.organization_id, entry);
  }
  return [...out.values()];
}

/**
 * Makes someone an owner of an organization (private.add_organization_owner: the caller must own it, and the person
 * must already own one of its businesses or be an admin of it). The role they had before.
 */
export async function addOrganizationOwner(
  tx: Tx,
  organizationId: string,
  userId: string,
): Promise<'none' | 'admin' | 'owner'> {
  const [row] = await rows<{ previous: string }>(
    tx,
    sql`select private.add_organization_owner(${organizationId}, ${userId}) as previous`,
  );
  const previous = row?.previous;
  return previous === 'admin' || previous === 'owner' ? previous : 'none';
}

interface OwnerMembership {
  readonly kind: 'organization' | 'workspace';
  readonly id: string;
  readonly name: string;
  readonly membership_id: string;
  /** For an organization: how many businesses it holds. */
  readonly businesses: number;
  /** For an organization holding one business: that business. */
  readonly workspace_id: string | null;
  readonly workspace_name: string | null;
}

/** Each of the person's owner memberships whose removal the last-owner rules refuse (probed and undone). */
async function onlyOwnerMemberships(tx: Tx, userId: string): Promise<OwnerMembership[]> {
  const owned = await rows<OwnerMembership & Record<string, unknown>>(
    tx,
    sql`select 'workspace' as kind, w.id, w.name, m.id as membership_id, 0 as businesses,
            null::uuid as workspace_id, null::text as workspace_name
          from app.workspace_memberships m join app.workspaces w on w.id = m.workspace_id
          where m.user_id = ${userId} and m.role = 'owner'
        union all
        select 'organization', o.id, o.name, m.id,
            (select count(*) from app.workspaces w where w.organization_id = o.id)::int,
            (select w.id from app.workspaces w where w.organization_id = o.id order by w.created_at limit 1),
            (select w.name from app.workspaces w where w.organization_id = o.id order by w.created_at limit 1)
          from app.organization_memberships m join app.organizations o on o.id = m.organization_id
          where m.user_id = ${userId} and m.role = 'owner'
        order by 1 desc, 3`,
  );
  const only: OwnerMembership[] = [];
  for (const o of owned) {
    try {
      await undone(tx, (sp) =>
        sp.execute(
          o.kind === 'organization'
            ? sql`delete from app.organization_memberships where id = ${o.membership_id}`
            : sql`delete from app.workspace_memberships where id = ${o.membership_id}`,
        ),
      );
    } catch (e) {
      if (pgDetail(e) === 'last_owner') only.push(o);
      else throw e;
    }
  }
  return only;
}

/** Where the person is the only owner, as people see it: businesses (an organization of one is its business) and agencies. */
export interface OnlyOwnerPlaces {
  readonly businesses: readonly { readonly workspaceId: string; readonly name: string }[];
  readonly agencies: readonly {
    readonly organizationId: string;
    readonly name: string;
    readonly businessCount: number;
  }[];
}

export const nothingOwnedAlone = (p: OnlyOwnerPlaces): boolean =>
  p.businesses.length === 0 && p.agencies.length === 0;

/** The places the person is the only owner of now, in `tx` as it stands. */
export async function onlyOwnerPlaces(tx: Tx, userId: string): Promise<OnlyOwnerPlaces> {
  const only = await onlyOwnerMemberships(tx, userId);
  const businesses: { workspaceId: string; name: string }[] = [];
  const agencies: { organizationId: string; name: string; businessCount: number }[] = [];
  const addBusiness = (workspaceId: string, name: string) => {
    if (!businesses.some((b) => b.workspaceId === workspaceId))
      businesses.push({ workspaceId, name });
  };
  for (const o of only) {
    if (o.kind === 'workspace') addBusiness(o.id, o.name);
    else if (o.businesses === 1 && o.workspace_id)
      addBusiness(o.workspace_id, o.workspace_name ?? o.name);
    else agencies.push({ organizationId: o.id, name: o.name, businessCount: o.businesses });
  }
  return { businesses, agencies };
}

/**
 * The refusal, naming each place and how to hand it over. `details` keeps step 6b's shape (businesses, and
 * organizations with `agency`), which the phone app reads.
 */
export function onlyOwnerRefusal(places: OnlyOwnerPlaces): HfosError {
  const { businesses, agencies } = places;
  const names = [...businesses.map((b) => b.name), ...agencies.map((a) => `the agency ${a.name}`)];
  let message: string;
  if (names.length > 1)
    message = `You’re the only owner of ${joinNames(names)}. Make someone else an owner of each first, on the web, so none of them is left without one.`;
  else if (agencies[0])
    message = `You’re the only owner of the agency ${agencies[0].name}. Make someone who owns one of its businesses an owner of the agency first, from Delete my account on the web, so it isn’t left without one.`;
  else
    message = `You’re the only owner of ${names[0]}. Make someone else an owner first, in Members on the web, so the business isn’t left without one.`;
  return new HfosError(
    'rule_violation',
    409,
    message,
    {
      businesses: businesses.map((b) => ({ workspaceId: b.workspaceId, name: b.name })),
      organizations: agencies.map((a) => ({
        organizationId: a.organizationId,
        name: a.name,
        agency: true,
      })),
    },
    'only_owner',
  );
}

/** A teammate to suggest for each business: an admin first, then a member (never the person). */
export async function ownerSuggestion(
  tx: Tx,
  workspaceId: string,
  userId: string,
): Promise<PersonRef | null> {
  const [r] = await rows<{ user_id: string; full_name: string; email: string }>(
    tx,
    sql`select u.id as user_id, u.full_name, u.email::text as email
        from app.workspace_memberships wm join app.users u on u.id = wm.user_id
        where wm.workspace_id = ${workspaceId} and wm.user_id <> ${userId} and u.deleted_at is null
        order by case wm.role when 'owner' then 0 when 'admin' then 1 else 2 end, wm.created_at
        limit 1`,
  );
  return r ? { userId: r.user_id, fullName: r.full_name, email: r.email } : null;
}

/** Who an agency can be handed to: people who own one of its businesses (with their names), and its admins. */
export async function agencyCandidates(
  tx: Tx,
  organizationId: string,
  userId: string,
): Promise<(PersonRef & { owns: string[] })[]> {
  const found = await rows<{ user_id: string; full_name: string; email: string; owns: string[] }>(
    tx,
    sql`select u.id as user_id, u.full_name, u.email::text as email,
          coalesce(array_agg(w.name order by w.name) filter (where w.id is not null), '{}') as owns
        from app.users u
        left join app.workspace_memberships wm on wm.user_id = u.id and wm.role = 'owner'
        left join app.workspaces w on w.id = wm.workspace_id and w.organization_id = ${organizationId}
        where u.id <> ${userId} and u.deleted_at is null
          and (exists (select 1 from app.organization_memberships om
                       where om.organization_id = ${organizationId} and om.user_id = u.id and om.role = 'admin')
            or exists (select 1 from app.workspace_memberships wm2 join app.workspaces w2 on w2.id = wm2.workspace_id
                       where w2.organization_id = ${organizationId} and wm2.user_id = u.id and wm2.role = 'owner'))
        group by u.id, u.full_name, u.email
        order by lower(u.full_name), u.email`,
  );
  return found.map((r) => ({
    userId: r.user_id,
    fullName: r.full_name,
    email: r.email,
    owns: r.owns,
  }));
}
