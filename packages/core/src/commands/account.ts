/**
 * A person's own account (M10): deleting it, and their OK for the Assistant.
 *
 * **Delete my account.** The person types their email to confirm. A business's or agency's only owner is refused in
 * plain words, naming each place, so nothing is left without an owner; the check is the database's own last-owner
 * rule, tried on each of their owner memberships and undone at once. Otherwise the request is recorded in every
 * business the person can reach (`account.deletion_requested`, one each) and the worker's job finishes it within
 * moments: it takes them off calendar teams and service staff lists through the calendars' own commands,
 * disconnects the mailboxes they connected, anonymizes the profile (private.anonymize_user, which also removes their
 * memberships, cells, devices, receipts and Assistant chats), ends every sign-in session and blocks sign-in. What they
 * worked on stays with each business, credited to "Former teammate".
 *
 * **The Assistant's consent.** The OK is kept in the person's settings with the wording version and the time;
 * `account.me` says whether it is still needed, and the worker's Assistant route refuses without it.
 */
import { eq } from 'drizzle-orm';
import { rows, sql, type Tx } from '@hfos/db/client';
import { users } from '@hfos/db/schema';
import { ASSISTANT_CONSENT_KEY, assistantConsentOf } from '../assistant/consent';
import { HfosError } from '../errors';
import { requireHuman } from '../kernel/actor';
import { defineCommand } from '../kernel/define';
import {
  AccountDeleteInput,
  AccountDeleteOutput,
  AccountNoteDeletedInput,
  AccountNoteDeletedOutput,
  AssistantConsentInput,
  AssistantConsentOutput,
} from '../schemas/user';

/** The Postgres error behind a driver error, and its rule (the `detail` our triggers raise). */
function pgDetail(e: unknown): string | undefined {
  let err: unknown = e;
  while (err instanceof Error && err.cause instanceof Error) err = err.cause;
  return (err as { detail?: string } | null)?.detail;
}

/** "A", "A and B", "A, B and C". */
function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

interface Owned {
  readonly kind: 'organization' | 'workspace';
  readonly id: string;
  readonly name: string;
  readonly membership_id: string;
  /** For an organization: how many businesses it holds (more than one makes it an agency). */
  readonly businesses: number;
}

/** Thrown inside a probe's savepoint so it always rolls back. */
const UNDO = Symbol('undo');

/**
 * Where the person is the only owner: each of their owner memberships removed in a savepoint that is always rolled
 * back. The last-owner triggers see every owner, including an agency's that the person can't see themselves.
 */
async function onlyOwnerOf(tx: Tx, userId: string): Promise<Owned[]> {
  const owned = await rows<Owned & Record<string, unknown>>(
    tx,
    sql`select 'workspace' as kind, w.id, w.name, m.id as membership_id, 0 as businesses
          from app.workspace_memberships m join app.workspaces w on w.id = m.workspace_id
          where m.user_id = ${userId} and m.role = 'owner'
        union all
        select 'organization', o.id, o.name, m.id,
            (select count(*) from app.workspaces w where w.organization_id = o.id)::int
          from app.organization_memberships m join app.organizations o on o.id = m.organization_id
          where m.user_id = ${userId} and m.role = 'owner'
        order by 1 desc, 3`,
  );
  const only: Owned[] = [];
  for (const o of owned) {
    try {
      await tx.transaction(async (sp) => {
        await sp.execute(
          o.kind === 'organization'
            ? sql`delete from app.organization_memberships where id = ${o.membership_id}`
            : sql`delete from app.workspace_memberships where id = ${o.membership_id}`,
        );
        throw UNDO;
      });
    } catch (e) {
      if (e === UNDO) continue;
      if (pgDetail(e) === 'last_owner') only.push(o);
      else throw e;
    }
  }
  return only;
}

/**
 * The refusal, naming each business. Every business sits in an organization (named after it unless an agency name
 * was given), and its owner's organization membership is what the last-owner rule keeps. Nothing in the app adds a
 * second organization owner yet, so this can't be handed over from here: the words say so, and point to support.
 */
function onlyOwnerRefusal(only: readonly Owned[]): HfosError {
  const businesses = only.filter((o) => o.kind === 'workspace');
  const organizations = only.filter((o) => o.kind === 'organization');
  const names: string[] = businesses.map((b) => b.name);
  let agency = false;
  for (const o of organizations) {
    if (o.businesses > 1) {
      agency = true;
      names.push(`the agency ${o.name}`);
    } else if (!names.includes(o.name)) names.push(o.name);
  }
  const one = names.length === 1;
  const message = `You’re the owner of ${joinNames(names)}, and ${one ? 'it' : 'they'} can’t be handed to someone else from the app yet. Ask HandsFreeOS support to delete your account, so ${one ? (agency ? 'the agency isn’t' : 'the business isn’t') : 'none of them is'} left without an owner.`;
  return new HfosError(
    'rule_violation',
    409,
    message,
    {
      businesses: businesses.map((b) => ({ workspaceId: b.id, name: b.name })),
      organizations: organizations.map((o) => ({
        organizationId: o.id,
        name: o.name,
        agency: o.businesses > 1,
      })),
    },
    'only_owner',
  );
}

export const accountDelete = defineCommand({
  name: 'account.delete',
  description:
    'Delete your own account. Your sign-in and your name are removed and you are signed out everywhere; the customers, messages and jobs you worked on stay with each business, shown as from a former teammate. A business’s only owner makes someone else an owner first.',
  risk: 4,
  input: AccountDeleteInput,
  output: AccountDeleteOutput,
  permission: null,
  scope: () => ({ kind: 'account' }),
  emits: ['account.deletion_requested'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const [user] = await ctx.tx.select().from(users).where(eq(users.id, me));
    if (!user) throw HfosError.notFound('Profile not found.');
    if (user.deletedAt) return { userId: me, requestedAt: user.deletedAt.toISOString() };
    if (input.confirmEmail !== user.email.toLowerCase())
      throw HfosError.validation([
        {
          path: 'confirmEmail',
          message: 'Type your email address exactly as it is on your account.',
        },
      ]);
    const only = await onlyOwnerOf(ctx.tx, me);
    if (only.length) throw onlyOwnerRefusal(only);
    // Every business the person can reach, directly or through an agency. The request is recorded in each (the
    // worker reads a business's events, and no business sees the others), and the worker's job takes them off each
    // one's calendars and mailboxes before the profile goes.
    const reach = await rows<{ id: string; organization_id: string }>(
      ctx.tx,
      sql`select id, organization_id from app.workspaces order by id`,
    );
    if (!reach.length)
      throw HfosError.rule(
        'no_business',
        409,
        'This account isn’t part of any business, so it can’t be deleted from the app. Ask HandsFreeOS support to delete it.',
      );
    const requestedAt = new Date();
    for (const w of reach)
      await ctx.emit({
        type: 'account.deletion_requested',
        entityType: 'user',
        entityId: me,
        organizationId: w.organization_id,
        workspaceId: w.id,
        payload: { userId: me },
        after: { requested: true },
      });
    return { userId: me, requestedAt: requestedAt.toISOString() };
  },
});

export const assistantConsent = defineCommand({
  name: 'assistant.consent',
  description:
    'Say OK to what the Assistant does with your questions: what you ask about is sent to Anthropic’s Claude to answer you. One OK covers the web and the phone.',
  risk: 1,
  input: AssistantConsentInput,
  output: AssistantConsentOutput,
  permission: null,
  scope: () => ({ kind: 'account' }),
  emits: ['assistant.consented'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const [user] = await ctx.tx
      .select({ settings: users.settings })
      .from(users)
      .where(eq(users.id, me));
    if (!user) throw HfosError.notFound('Profile not found.');
    const current = assistantConsentOf(user.settings);
    if (current.consentedVersion !== null && current.consentedVersion >= input.version)
      return {
        version: current.consentedVersion,
        consentedAt: current.consentedAt!,
        changed: false,
      };
    const at = (ctx.meta.occurredAt ?? new Date()).toISOString();
    const kept = { [ASSISTANT_CONSENT_KEY]: { version: input.version, at } };
    await ctx.tx
      .update(users)
      .set({ settings: sql`${users.settings} || ${JSON.stringify(kept)}::jsonb` })
      .where(eq(users.id, me));
    await ctx.emit({
      type: 'assistant.consented',
      entityType: 'user',
      entityId: me,
      organizationId: null,
      workspaceId: null,
      payload: { version: input.version },
      before: current.consentedVersion ? { version: current.consentedVersion } : null,
      after: { version: input.version },
    });
    return { version: input.version, consentedAt: at, changed: true };
  },
});

export const accountNoteDeleted = defineCommand({
  name: 'account.note_deleted',
  description:
    'Worker: someone deleted their account. Recorded in each business they were part of, so the team can see why they are gone.',
  risk: 0,
  input: AccountNoteDeletedInput,
  output: AccountNoteDeletedOutput,
  permission: 'workspace.read',
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  emits: ['account.deleted'],
  actors: ['system'],
  async handler(ctx, input) {
    await ctx.emit({
      type: 'account.deleted',
      entityType: 'user',
      entityId: input.userId,
      payload: { userId: input.userId },
    });
    return { userId: input.userId };
  },
});
