/** Server-side messaging helpers shared by the commands and queries (numbers, readiness, conversations, jobs). */
import { and, asc, desc, eq, inArray, isNull, ne } from 'drizzle-orm';
import { sql, type Tx } from '@hfos/db/client';
import {
  conversations,
  optOuts,
  people,
  phoneNumbers,
  telephonyRegistrations,
  workspaces,
} from '@hfos/db/schema';
import { HfosError } from '../errors';
import type { CommandContext } from '../kernel/types';
import {
  DEFAULT_TELEPHONY_SETTINGS,
  TelephonySettings,
  type PhoneNextStep,
  type RegistrationFamily,
} from '../schemas/telephony';
import type { RegistrationKind } from '@hfos/db/schema';

export const LIVE_NUMBER_STATUSES = ['provisioning', 'active', 'releasing'] as const;

export const FAMILY_KINDS: Record<RegistrationFamily, readonly RegistrationKind[]> = {
  toll_free_verification: ['toll_free_verification'],
  a2p_10dlc: ['a2p_customer_profile', 'a2p_trust_product', 'a2p_brand', 'a2p_campaign'],
};
export const familyFor = (numberType: string): RegistrationFamily =>
  numberType === 'toll_free' ? 'toll_free_verification' : 'a2p_10dlc';

/** The workspace's live business number (provisioning, active or releasing), if any. */
export async function liveNumber(tx: Tx, workspaceId: string) {
  const [n] = await tx
    .select()
    .from(phoneNumbers)
    .where(
      and(
        eq(phoneNumbers.workspaceId, workspaceId),
        inArray(phoneNumbers.status, [...LIVE_NUMBER_STATUSES]),
      ),
    )
    .orderBy(desc(phoneNumbers.createdAt))
    .limit(1);
  return n ?? null;
}

/** The newest number that is not released (a failed purchase shows its error until someone retries). */
export async function currentNumber(tx: Tx, workspaceId: string) {
  const [n] = await tx
    .select()
    .from(phoneNumbers)
    .where(and(eq(phoneNumbers.workspaceId, workspaceId), ne(phoneNumbers.status, 'released')))
    .orderBy(desc(phoneNumbers.createdAt))
    .limit(1);
  return n ?? null;
}

export async function loadRegistrations(tx: Tx, workspaceId: string) {
  return tx
    .select()
    .from(telephonyRegistrations)
    .where(eq(telephonyRegistrations.workspaceId, workspaceId))
    .orderBy(asc(telephonyRegistrations.createdAt));
}

/** The newest row per registration kind. */
export function latestByKind<T extends { kind: string }>(regs: readonly T[]): Map<string, T> {
  const map = new Map<string, T>();
  for (const r of regs) map.set(r.kind, r);
  return map;
}

export interface Readiness {
  readonly voiceReady: boolean;
  readonly messagingReady: boolean;
  readonly nextStep: PhoneNextStep;
}

/** Voice works once the number is active; texting also needs the carrier registration approved. */
export function readiness(
  number: { status: string; numberType: string } | null,
  regs: readonly { kind: string; status: string }[],
): Readiness {
  if (!number || number.status === 'failed' || number.status === 'released')
    return { voiceReady: false, messagingReady: false, nextStep: 'buy_number' };
  if (number.status === 'provisioning')
    return { voiceReady: false, messagingReady: false, nextStep: 'provisioning' };
  if (number.status === 'releasing')
    return { voiceReady: false, messagingReady: false, nextStep: 'releasing' };
  const kinds = FAMILY_KINDS[familyFor(number.numberType)];
  const latest = latestByKind(regs.filter((r) => (kinds as readonly string[]).includes(r.kind)));
  const chain = kinds.map((k) => latest.get(k)).filter((r) => r !== undefined);
  if (chain.length === 0 || chain.every((r) => r.status === 'draft'))
    return { voiceReady: true, messagingReady: false, nextStep: 'submit_registration' };
  if (chain.some((r) => r.status === 'rejected' || r.status === 'failed'))
    return { voiceReady: true, messagingReady: false, nextStep: 'rejected' };
  if (chain.length === kinds.length && chain.every((r) => r.status === 'approved'))
    return { voiceReady: true, messagingReady: true, nextStep: 'ready' };
  return { voiceReady: true, messagingReady: false, nextStep: 'awaiting_approval' };
}

export interface WorkspaceMessaging {
  readonly name: string;
  readonly timezone: string;
  readonly organizationId: string;
  readonly settings: TelephonySettings;
  readonly rawSettings: Record<string, unknown>;
}

/** Time zone, name and texting settings (defaults filled in) for one workspace. */
export async function workspaceMessaging(tx: Tx, workspaceId: string): Promise<WorkspaceMessaging> {
  const [ws] = await tx
    .select({
      name: workspaces.name,
      timezone: workspaces.timezone,
      organizationId: workspaces.organizationId,
      settings: workspaces.settings,
    })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId));
  if (!ws) throw HfosError.notFound('Workspace not found.');
  const raw = (ws.settings ?? {}) as Record<string, unknown>;
  const parsed = TelephonySettings.partial().safeParse(raw['telephony'] ?? {});
  const stored = parsed.success ? parsed.data : {};
  return {
    name: ws.name,
    timezone: ws.timezone,
    organizationId: ws.organizationId,
    rawSettings: raw,
    settings: {
      quietHours: stored.quietHours ?? DEFAULT_TELEPHONY_SETTINGS.quietHours,
      unansweredReminderMinutes:
        stored.unansweredReminderMinutes ?? DEFAULT_TELEPHONY_SETTINGS.unansweredReminderMinutes,
    },
  };
}

export async function isOptedOut(tx: Tx, workspaceId: string, e164: string): Promise<boolean> {
  const [row] = await tx
    .select({ optedOut: optOuts.optedOut })
    .from(optOuts)
    .where(and(eq(optOuts.workspaceId, workspaceId), eq(optOuts.counterpartE164, e164)));
  return row?.optedOut ?? false;
}

/** The customer with this number (the most recently touched one when several share it). */
export async function matchPersonByPhone(
  tx: Tx,
  workspaceId: string,
  e164: string,
): Promise<string | null> {
  const [p] = await tx
    .select({ id: people.id })
    .from(people)
    .where(
      and(
        eq(people.workspaceId, workspaceId),
        eq(people.phoneE164, e164),
        isNull(people.archivedAt),
      ),
    )
    .orderBy(desc(people.updatedAt))
    .limit(1);
  return p?.id ?? null;
}

export async function loadConversation(ctx: CommandContext, conversationId: string) {
  const [c] = await ctx.tx
    .select()
    .from(conversations)
    .where(
      and(
        eq(conversations.id, conversationId),
        eq(conversations.workspaceId, ctx.scope.workspaceId!),
      ),
    );
  if (!c) throw HfosError.notFound('Conversation not found.');
  return c;
}

/** One conversation per customer per channel: returns the existing one or starts it. */
export async function findOrCreateConversation(
  ctx: CommandContext,
  input: {
    channel: 'sms' | 'email';
    counterpart: string;
    personId: string | null;
    phoneNumberId: string | null;
  },
) {
  const workspaceId = ctx.scope.workspaceId!;
  const find = () =>
    ctx.tx
      .select()
      .from(conversations)
      .where(
        and(
          eq(conversations.workspaceId, workspaceId),
          eq(conversations.channel, input.channel),
          eq(conversations.counterpart, input.counterpart),
        ),
      );
  const [existing] = await find();
  if (existing) return { conversation: existing, created: false };
  const inserted = await ctx.tx
    .insert(conversations)
    .values({
      workspaceId,
      channel: input.channel,
      counterpart: input.counterpart,
      personId: input.personId,
      phoneNumberId: input.phoneNumberId,
      createdBy: ctx.actor.type === 'human' ? ctx.actor.userId : null,
    })
    .onConflictDoNothing()
    .returning();
  if (inserted[0]) return { conversation: inserted[0], created: true };
  const [raced] = await find();
  if (!raced) throw HfosError.forbidden();
  return { conversation: raced, created: false };
}

/** Queues delayed work. A pending job with the same kind and key wins (the first reminder time stands). */
export async function scheduleJob(
  tx: Tx,
  job: {
    kind: string;
    dedupeKey: string | null;
    runAt: Date;
    payload: Record<string, unknown>;
    workspaceId: string | null;
    organizationId: string | null;
  },
): Promise<void> {
  await tx.execute(
    sql`insert into app.scheduled_jobs (organization_id, workspace_id, kind, dedupe_key, run_at, payload)
        values (${job.organizationId}, ${job.workspaceId}, ${job.kind}, ${job.dedupeKey}, ${job.runAt.toISOString()}::timestamptz, ${JSON.stringify(job.payload)}::jsonb)
        on conflict (kind, dedupe_key) where status = 'pending' and dedupe_key is not null do nothing`,
  );
}

/** Whether a user can work this workspace (a direct member, or an owner or admin of its organization). */
export async function isWorkspaceUser(
  tx: Tx,
  workspaceId: string,
  userId: string,
): Promise<boolean> {
  const found = await tx.execute(
    sql`select 1 from app.workspace_memberships wm where wm.workspace_id = ${workspaceId} and wm.user_id = ${userId}
        union all
        select 1 from app.organization_memberships om join app.workspaces w on w.organization_id = om.organization_id
        where w.id = ${workspaceId} and om.user_id = ${userId}
        limit 1`,
  );
  return Array.from(found as unknown as Iterable<unknown>).length > 0;
}
