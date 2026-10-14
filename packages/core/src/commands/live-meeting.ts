/**
 * Live meetings: a person in a Zoom meeting asks HandsFreeOS to hear it as it happens, for the add-ons that listen
 * (`liveCalls` in a manifest, like Sales Coach). HANDSFREEOS_SALES_COACH_IMPLEMENTATION_PLAN.md, round three.
 *
 * HandsFreeOS's app inside Zoom asks Zoom to start the meeting's stream; Zoom then tells the worker, naming only the
 * meeting. So the app first claims the meeting here (`live_meeting.claim`): whose it is, in which business, and the
 * customer it's with, found from the appointment the meeting was made for, or picked. The worker takes the waiting
 * claim when the stream starts (`.started`) and closes it when it stops (`.ended`); what was said is the add-ons'.
 *
 * It needs the person's Zoom linked here through the coaching Zoom app (a **live meeting account**, apart from the
 * Zoom connection that makes meeting links, so a slow Zoom review of one never holds up the other): added from
 * Zoom's Marketplace, or with Connect in HandsFreeOS, then confirmed signed in here. That's how the worker knows the
 * stream came from them. It also needs an add-on that listens, running in the business, whose permission they hold.
 * The worker links the account (`live_meeting_account.link`) once both sign-ins agree; the person may disconnect it,
 * and removing the app in Zoom disconnects it everywhere (`.revoke`).
 */
import { and, eq, inArray, or } from 'drizzle-orm';
import { liveMeetingAccounts, liveMeetings, people } from '@hfos/db/schema';
import { rows, sql } from '@hfos/db/client';
import { z } from 'zod';
import { ADDON_CATALOG } from '../addons/catalog';
import { HfosError } from '../errors';
import { requireHuman } from '../kernel/actor';
import { defineCommand, defineQuery } from '../kernel/define';
import type { CommandContext } from '../kernel/types';
import { isoDateTime, uuid } from '../schemas/common';

export const LiveMeetingProvider = z.enum(['zoom']);
export const LIVE_MEETING_STATES = ['waiting', 'live', 'ended'] as const;

const inWorkspace = (i: { workspaceId: string }) => ({
  kind: 'workspace' as const,
  workspaceId: i.workspaceId,
});

const ClaimInput = z.object({
  workspaceId: uuid,
  provider: LiveMeetingProvider.default('zoom'),
  /** Zoom's id for this meeting instance (the Zoom Apps SDK's `getMeetingUUID`). */
  meetingUuid: z.string().trim().min(1).max(200),
  /** The number people join with (`getMeetingContext`), which finds the appointment it was made for. */
  meetingNumber: z
    .string()
    .trim()
    .regex(/^[0-9]{6,20}$/)
    .nullable()
    .default(null),
  /** The person's name in the meeting (`getUserContext`), so their words are told from the customer's. */
  screenName: z.string().trim().max(200).nullable().default(null),
  /** The customer it's with, when the person picked them; otherwise the appointment's. */
  personId: uuid.nullable().optional(),
});

const ClaimOutput = z.object({
  liveMeetingId: uuid,
  state: z.enum(LIVE_MEETING_STATES),
  appointmentId: uuid.nullable(),
  person: z.object({ id: uuid, name: z.string() }).nullable(),
});

const fullName = (first: string | null, last: string | null) =>
  [first, last].filter(Boolean).join(' ').trim() || 'Unnamed customer';

/** The add-ons that would hear this person's meeting: running here, listening, and theirs to use. */
async function listeningAddons(ctx: CommandContext): Promise<string[]> {
  const out: string[] = [];
  for (const m of ADDON_CATALOG) {
    const permission = m.liveCalls?.permission;
    if (!permission || m.catalog.status === 'planned') continue;
    const [on] = await rows<{ ok: boolean }>(
      ctx.tx,
      sql`select private.addon_in_use(${ctx.scope.workspaceId!}::uuid, ${m.id}, false)
                 and private.has_permission(${ctx.scope.workspaceId!}::uuid, ${permission}) as ok`,
    );
    if (on?.ok) out.push(m.id);
  }
  return out;
}

export const liveMeetingClaim = defineCommand({
  name: 'live_meeting.claim',
  description:
    'From HandsFreeOS’s app inside Zoom: this meeting is yours, so the add-ons that listen hear it once Zoom starts its stream. Finds the customer from the appointment the meeting was made for, unless you pick one. Asking again finds the same claim.',
  risk: 1,
  input: ClaimInput,
  output: ClaimOutput,
  // The add-on that listens decides who may be heard (its `liveCalls` permission), checked below.
  permission: null,
  scope: inWorkspace,
  emits: ['live_meeting.claimed'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const ws = ctx.scope.workspaceId!;
    if ((await listeningAddons(ctx)).length === 0)
      throw HfosError.rule(
        'live_meeting_nobody_listens',
        409,
        'Nothing in this business listens to meetings for you yet. An owner can turn on an add-on that does (like AI Sales Coach) under Settings → Add-ons, and give you its permission.',
      );
    const [linked] = await ctx.tx
      .select({ id: liveMeetingAccounts.id })
      .from(liveMeetingAccounts)
      .where(
        and(
          eq(liveMeetingAccounts.workspaceId, ws),
          eq(liveMeetingAccounts.userId, me),
          eq(liveMeetingAccounts.provider, input.provider),
          eq(liveMeetingAccounts.status, 'active'),
        ),
      )
      .limit(1);
    if (!linked)
      throw HfosError.rule(
        'live_meeting_not_connected',
        409,
        'Connect your Zoom to HandsFreeOS first: press Connect Zoom below (or add the HandsFreeOS Sales Coach app from Zoom’s App Marketplace), sign in, and pick this business. Then come back to this meeting.',
      );

    // The appointment HandsFreeOS made this meeting for, and its customer.
    const [appt] = input.meetingNumber
      ? await rows<{ id: string; person_id: string | null }>(
          ctx.tx,
          // Its first booked attendee is the customer.
          sql`select a.id,
                     (select at.person_id from app.appointment_attendees at
                       where at.appointment_id = a.id and at.status <> 'cancelled'
                       order by at.created_at limit 1) as person_id
                from app.appointments a
               where a.workspace_id = ${ws} and a.location ->> 'meetingId' = ${input.meetingNumber}
                 and a.location ->> 'video' = ${input.provider}
               order by a.starts_at desc limit 1`,
        )
      : [];
    if (input.personId) {
      const [p] = await ctx.tx
        .select({ id: people.id })
        .from(people)
        .where(and(eq(people.id, input.personId), eq(people.workspaceId, ws)));
      if (!p)
        throw HfosError.notFound(
          'That customer isn’t in this business anymore, or isn’t one you can see. Pick them again.',
        );
    }
    const personId = input.personId !== undefined ? input.personId : (appt?.person_id ?? null);

    const open = await ctx.tx
      .select()
      .from(liveMeetings)
      .where(
        and(
          eq(liveMeetings.workspaceId, ws),
          eq(liveMeetings.userId, me),
          eq(liveMeetings.provider, input.provider),
          eq(liveMeetings.meetingUuid, input.meetingUuid),
          inArray(liveMeetings.state, ['waiting', 'live']),
        ),
      );
    let row = open[0];
    if (row?.state === 'waiting') {
      [row] = await ctx.tx
        .update(liveMeetings)
        .set({
          meetingNumber: input.meetingNumber ?? row.meetingNumber,
          appointmentId: appt?.id ?? row.appointmentId,
          personId,
          screenName: input.screenName ?? row.screenName,
        })
        .where(eq(liveMeetings.id, row.id))
        .returning();
    } else if (!row) {
      [row] = await ctx.tx
        .insert(liveMeetings)
        .values({
          workspaceId: ws,
          userId: me,
          provider: input.provider,
          meetingUuid: input.meetingUuid,
          meetingNumber: input.meetingNumber,
          appointmentId: appt?.id ?? null,
          personId,
          screenName: input.screenName,
        })
        .returning();
      await ctx.emit({
        type: 'live_meeting.claimed',
        entityType: 'live_meeting',
        entityId: row!.id,
        payload: { provider: input.provider, appointmentId: row!.appointmentId, personId },
      });
    }
    const c = row!;
    const [person] = c.personId
      ? await ctx.tx
          .select({ id: people.id, first: people.firstName, last: people.lastName })
          .from(people)
          .where(eq(people.id, c.personId))
      : [];
    return {
      liveMeetingId: c.id,
      state: c.state as (typeof LIVE_MEETING_STATES)[number],
      appointmentId: c.appointmentId,
      person: person ? { id: person.id, name: fullName(person.first, person.last) } : null,
    };
  },
});

// ---------- the worker's ----------

export const liveMeetingStarted = defineCommand({
  name: 'live_meeting.started',
  description:
    'Worker: Zoom started the stream of a meeting someone claimed, and the add-ons that listen are hearing it.',
  risk: 0,
  input: z.object({
    workspaceId: uuid,
    liveMeetingId: uuid,
    streamId: z.string().trim().min(1).max(200),
  }),
  output: z.object({ started: z.boolean() }),
  permission: null,
  actors: ['system'],
  scope: inWorkspace,
  emits: ['live_meeting.started'],
  async handler(ctx, input) {
    const [row] = await ctx.tx
      .update(liveMeetings)
      .set({ state: 'live', streamId: input.streamId, startedAt: new Date() })
      .where(
        and(
          eq(liveMeetings.id, input.liveMeetingId),
          eq(liveMeetings.workspaceId, ctx.scope.workspaceId!),
          eq(liveMeetings.state, 'waiting'),
        ),
      )
      .returning({ id: liveMeetings.id, userId: liveMeetings.userId });
    if (!row) return { started: false };
    await ctx.emit({
      type: 'live_meeting.started',
      entityType: 'live_meeting',
      entityId: row.id,
      payload: { userId: row.userId },
    });
    return { started: true };
  },
});

export const liveMeetingEnded = defineCommand({
  name: 'live_meeting.ended',
  description:
    'Worker: the stream of a live meeting stopped (the meeting ended, or someone stopped it).',
  risk: 0,
  input: z.object({ workspaceId: uuid, liveMeetingId: uuid, endedAt: isoDateTime.optional() }),
  output: z.object({ ended: z.boolean() }),
  permission: null,
  actors: ['system'],
  scope: inWorkspace,
  emits: ['live_meeting.ended'],
  async handler(ctx, input) {
    const [row] = await ctx.tx
      .update(liveMeetings)
      .set({ state: 'ended', endedAt: input.endedAt ? new Date(input.endedAt) : new Date() })
      .where(
        and(
          eq(liveMeetings.id, input.liveMeetingId),
          eq(liveMeetings.workspaceId, ctx.scope.workspaceId!),
          inArray(liveMeetings.state, ['waiting', 'live']),
        ),
      )
      .returning({ id: liveMeetings.id });
    if (!row) return { ended: false };
    await ctx.emit({
      type: 'live_meeting.ended',
      entityType: 'live_meeting',
      entityId: row.id,
      payload: {},
    });
    return { ended: true };
  },
});

// ---------- the coaching Zoom app's link to a person ----------

const AccountOut = z.object({
  id: uuid,
  provider: LiveMeetingProvider,
  accountEmail: z.string().nullable(),
  connectedAt: isoDateTime,
});

export const liveMeetingAccountLink = defineCommand({
  name: 'live_meeting_account.link',
  description:
    'Worker: someone added the coaching Zoom app (or pressed Connect Zoom) and confirmed, signed in here, that this Zoom user is them in this business. Replaces their earlier link here, and that Zoom user’s link to anyone else here.',
  risk: 1,
  input: z.object({
    workspaceId: uuid,
    userId: uuid,
    provider: LiveMeetingProvider.default('zoom'),
    externalUserId: z.string().trim().min(1).max(200),
    accountEmail: z.email().max(320).nullable(),
  }),
  output: z.object({ accountId: uuid }),
  permission: null,
  actors: ['system'],
  scope: inWorkspace,
  emits: ['live_meeting_account.linked'],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    // One link per person, and one person per Zoom user, in a business.
    await ctx.tx
      .update(liveMeetingAccounts)
      .set({ status: 'disconnected', disconnectedAt: new Date() })
      .where(
        and(
          eq(liveMeetingAccounts.workspaceId, ws),
          eq(liveMeetingAccounts.provider, input.provider),
          eq(liveMeetingAccounts.status, 'active'),
          or(
            eq(liveMeetingAccounts.userId, input.userId),
            eq(liveMeetingAccounts.externalUserId, input.externalUserId),
          ),
        ),
      );
    const [row] = await ctx.tx
      .insert(liveMeetingAccounts)
      .values({
        workspaceId: ws,
        userId: input.userId,
        provider: input.provider,
        externalUserId: input.externalUserId,
        accountEmail: input.accountEmail?.toLowerCase() ?? null,
      })
      .returning({ id: liveMeetingAccounts.id });
    await ctx.emit({
      type: 'live_meeting_account.linked',
      entityType: 'live_meeting_account',
      entityId: row!.id,
      payload: { userId: input.userId, provider: input.provider },
    });
    return { accountId: row!.id };
  },
});

export const liveMeetingAccountDisconnect = defineCommand({
  name: 'live_meeting_account.disconnect',
  description:
    'Disconnect your Zoom from HandsFreeOS’s coaching app in this business. Meetings aren’t coached until you connect again.',
  risk: 1,
  input: z.object({ workspaceId: uuid, accountId: uuid }),
  output: z.object({ accountId: uuid }),
  permission: null,
  scope: inWorkspace,
  emits: ['live_meeting_account.disconnected'],
  async handler(ctx, input) {
    requireHuman(ctx);
    // Row security keeps this to your own; the guard lets you only disconnect.
    const [row] = await ctx.tx
      .update(liveMeetingAccounts)
      .set({ status: 'disconnected' })
      .where(
        and(
          eq(liveMeetingAccounts.id, input.accountId),
          eq(liveMeetingAccounts.workspaceId, ctx.scope.workspaceId!),
          eq(liveMeetingAccounts.status, 'active'),
        ),
      )
      .returning({ id: liveMeetingAccounts.id });
    if (!row)
      throw HfosError.notFound(
        'That Zoom account isn’t connected anymore. Refresh the page to see where things are.',
      );
    await ctx.emit({
      type: 'live_meeting_account.disconnected',
      entityType: 'live_meeting_account',
      entityId: row.id,
      payload: { by: 'person' },
    });
    return { accountId: row.id };
  },
});

export const liveMeetingAccountRevoke = defineCommand({
  name: 'live_meeting_account.revoke',
  description: 'Worker: the person removed the coaching app in Zoom, so its link here ends.',
  risk: 0,
  input: z.object({ workspaceId: uuid, accountId: uuid }),
  output: z.object({ changed: z.boolean() }),
  permission: null,
  actors: ['system'],
  scope: inWorkspace,
  emits: ['live_meeting_account.disconnected'],
  async handler(ctx, input) {
    const [row] = await ctx.tx
      .update(liveMeetingAccounts)
      .set({ status: 'disconnected', disconnectedAt: new Date() })
      .where(
        and(
          eq(liveMeetingAccounts.id, input.accountId),
          eq(liveMeetingAccounts.workspaceId, ctx.scope.workspaceId!),
          eq(liveMeetingAccounts.status, 'active'),
        ),
      )
      .returning({ id: liveMeetingAccounts.id });
    if (!row) return { changed: false };
    await ctx.emit({
      type: 'live_meeting_account.disconnected',
      entityType: 'live_meeting_account',
      entityId: row.id,
      payload: { by: 'zoom' },
    });
    return { changed: true };
  },
});

export const liveMeetingAccountMine = defineQuery({
  name: 'live_meeting_account.mine',
  description: 'Your Zoom linked to HandsFreeOS’s coaching app in this business, if it is.',
  input: z.object({ workspaceId: uuid }),
  output: z.object({ account: AccountOut.nullable() }),
  permission: null,
  scope: inWorkspace,
  async handler(ctx) {
    const me = requireHuman(ctx).userId;
    const [a] = await ctx.tx
      .select()
      .from(liveMeetingAccounts)
      .where(
        and(
          eq(liveMeetingAccounts.workspaceId, ctx.scope.workspaceId!),
          eq(liveMeetingAccounts.userId, me),
          eq(liveMeetingAccounts.status, 'active'),
        ),
      )
      .limit(1);
    return {
      account: a
        ? {
            id: a.id,
            provider: 'zoom' as const,
            accountEmail: a.accountEmail,
            connectedAt: a.connectedAt.toISOString(),
          }
        : null,
    };
  },
});

export const liveMeetingCommands = [
  liveMeetingClaim,
  liveMeetingStarted,
  liveMeetingEnded,
  liveMeetingAccountLink,
  liveMeetingAccountDisconnect,
  liveMeetingAccountRevoke,
] as const;
