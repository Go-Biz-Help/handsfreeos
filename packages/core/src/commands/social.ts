/**
 * Facebook Messenger and Instagram direct messages (20261025000200): connecting a business's Pages and the Instagram
 * accounts linked to them, what comes in from them, and where the people writing came from.
 *
 * No token ever reaches a browser. The sign-in happens on the worker, which seals every token before a command
 * hears of it, and only the worker's own commands carry the sealed text: a person's commands only ever name a Page
 * and a state. Replies go out through message.send, like every other channel's (sendSocial in message.ts).
 *
 * **Where somebody came from is kept as it came.** A message that starts or picks up a conversation from an ad, or
 * from a link with a ref, is an attribution touch of its own, and nothing here writes over the customer's source.
 * The ad itself is looked up once per business (app.ads), by a job the first touch from it queues.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { rows } from '@hfos/db/client';
import {
  activities,
  ads,
  attributionTouches,
  conversations,
  leads,
  messages,
  metaAccounts,
  metaConnections,
  metaContacts,
  people,
  type MediaRef,
  type SocialExtras,
  type SocialShared,
} from '@hfos/db/schema';
import { textArray, workspaceZone } from '../calendar/load';
import { logChannelActivity } from '../crm/activities';
import { intakeFromChannel, type IntakeResult } from '../crm/intake';
import { fullName } from '../crm/records';
import { HfosError } from '../errors';
import { requireHuman } from '../kernel/actor';
import { defineCommand } from '../kernel/define';
import type { CommandContext } from '../kernel/types';
import {
  channelOfPlatform,
  META_PLATFORM_NAMES,
  metaAccountLabel,
  socialContactName,
  socialCounterpart,
  socialPreview,
  type MetaPlatform,
  type SocialChannel,
} from '../messaging/social';
import { scheduleJob, workspaceMessaging } from '../messaging/store';
import {
  AdResolveInput,
  AdResolveOutput,
  MetaAccountConnectInput,
  MetaAccountConnectOutput,
  MetaAccountDisconnectInput,
  MetaAccountFailInput,
  MetaAccountOutput,
  MetaAccountRecoverInput,
  MetaConnectInput,
  MetaConnectOutput,
  MetaConnectionActivateInput,
  MetaConnectionDisconnectInput,
  MetaConnectionDisconnectOutput,
  MetaConnectionOutput,
  SocialEditInput,
  SocialEditOutput,
  SocialReceiptInput,
  SocialReceiptOutput,
  SocialReceiveInput,
  SocialReceiveOutput,
} from '../schemas/social';
import type { z } from 'zod';

const inWorkspace = (i: { workspaceId: string }) => ({
  kind: 'workspace' as const,
  workspaceId: i.workspaceId,
});
/** A sign-in link lasts ten minutes, the same as every other one here. */
const STATE_TTL_MS = 10 * 60_000;
const sha256Hex = (value: string) => createHash('sha256').update(value).digest('hex');

/** The jobs this file queues for the worker (apps/worker/src/social). */
export const SOCIAL_JOBS = {
  /** Ask Meta's Marketing API what an ad is: its campaign, ad set and creative. */
  resolveAd: 'meta.resolve_ad',
} as const;

/** The same ad or link twice this close together is one visit: Meta sometimes says so twice, in two ways. */
const SAME_VISIT_MS = 10 * 60_000;

/**
 * A Page or account as a person may read it: every column but its sealed token. Named, never `select()`: the token
 * isn't granted to people at all, so asking for every column is refused outright.
 */
export const META_ACCOUNT_COLUMNS = {
  id: metaAccounts.id,
  workspaceId: metaAccounts.workspaceId,
  connectionId: metaAccounts.connectionId,
  platform: metaAccounts.platform,
  externalId: metaAccounts.externalId,
  pageId: metaAccounts.pageId,
  name: metaAccounts.name,
  username: metaAccounts.username,
  status: metaAccounts.status,
  humanAgent: metaAccounts.humanAgent,
  subscribedAt: metaAccounts.subscribedAt,
  failures: metaAccounts.failures,
  lastError: metaAccounts.lastError,
  problem: metaAccounts.problem,
  disconnectedReason: metaAccounts.disconnectedReason,
  connectedAt: metaAccounts.connectedAt,
  disconnectedAt: metaAccounts.disconnectedAt,
  connectedBy: metaAccounts.connectedBy,
  createdAt: metaAccounts.createdAt,
  updatedAt: metaAccounts.updatedAt,
};
export type MetaAccountRead = Omit<typeof metaAccounts.$inferSelect, 'tokenEnc' | 'tokenKeyId'>;
type Account = MetaAccountRead;
type Conversation = typeof conversations.$inferSelect;

const accountLabel = metaAccountLabel;

/** Why a Page or account can't answer right now, and what fixes it. Null when it can. */
export function accountUnavailable(
  a: Pick<Account, 'platform' | 'name' | 'username' | 'status' | 'problem'> | null | undefined,
): string | null {
  if (!a)
    return 'The Facebook Page or Instagram account this conversation was on isn’t connected anymore. Connect it again in Settings → Facebook & Instagram to reply here.';
  const where = `${META_PLATFORM_NAMES[a.platform]} ${a.platform === 'facebook' ? 'Page' : 'account'} ${accountLabel(a)}`;
  if (a.status === 'disconnected')
    return `The ${where} isn’t connected anymore, so replies can’t go out from here. Connect it again in Settings → Facebook & Instagram.`;
  if (a.status === 'needs_attention')
    return a.problem === 'revoked'
      ? `HandsFreeOS was removed from the ${where} on Facebook, so replies can’t go out. Connect it again in Settings → Facebook & Instagram.`
      : a.problem === 'reauth'
        ? `The sign-in for the ${where} stopped working, so replies can’t go out. Connect it again in Settings → Facebook & Instagram.`
        : `Meta keeps refusing replies from the ${where}. Settings → Facebook & Instagram shows what it said; connecting it again usually fixes it.`;
  return null;
}

const clean = (s: string | null | undefined, max: number): string | null => {
  const t = (s ?? '').trim();
  return t ? t.slice(0, max) : null;
};

// ---------------------------------------------------------------------------------------------------- connecting

export const metaConnectionConnect = defineCommand({
  name: 'meta_connection.connect',
  description:
    'Start connecting the business’s Facebook Pages and Instagram accounts, so their direct messages arrive in the inbox and can be answered from it. Returns a one-time state; the browser signs in to Facebook through the worker.',
  risk: 2,
  input: MetaConnectInput,
  output: MetaConnectOutput,
  permission: 'channels.manage',
  scope: inWorkspace,
  emits: ['meta_connection.connect_started'],
  // The state is a one-time secret: never kept in a stored answer.
  shownOnce: ['state'],
  async handler(ctx) {
    const me = requireHuman(ctx);
    const state = randomBytes(32).toString('base64url');
    const [row] = await ctx.tx
      .insert(metaConnections)
      .values({
        workspaceId: ctx.scope.workspaceId!,
        status: 'pending',
        oauthStateHash: sha256Hex(state),
        oauthStateExpiresAt: new Date(Date.now() + STATE_TTL_MS),
        createdBy: me.userId,
      })
      .returning({ id: metaConnections.id });
    if (!row) throw HfosError.forbidden();
    await ctx.emit({
      type: 'meta_connection.connect_started',
      entityType: 'meta_connection',
      entityId: row.id,
      payload: {},
      broadcast: false,
    });
    return { connectionId: row.id, state };
  },
});

export const metaConnectionActivate = defineCommand({
  name: 'meta_connection.activate',
  description:
    'Worker: somebody signed in to Facebook for the business. Keeps who it was and what they allowed; an earlier sign-in of theirs here steps down, and its Pages move to this one.',
  risk: 1,
  input: MetaConnectionActivateInput,
  output: MetaConnectionOutput,
  permission: 'channels.manage',
  scope: inWorkspace,
  emits: ['meta_connection.connected'],
  actors: ['system'],
  async handler(ctx, input) {
    const workspaceId = ctx.scope.workspaceId!;
    const [c] = await ctx.tx
      .select()
      .from(metaConnections)
      .where(
        and(
          eq(metaConnections.id, input.connectionId),
          eq(metaConnections.workspaceId, workspaceId),
        ),
      );
    if (!c) throw HfosError.notFound('That sign-in isn’t here anymore. Start again from Settings.');
    if (c.status !== 'pending')
      throw HfosError.rule(
        'meta_connection_not_pending',
        409,
        'This sign-in already finished. Start again from Settings → Facebook & Instagram.',
      );
    const now = new Date();
    // The same person signing in again replaces their earlier sign-in here: one token per person per business.
    const older = await ctx.tx
      .update(metaConnections)
      .set({
        status: 'disconnected',
        disconnectedAt: now,
        disconnectedReason: 'replaced',
        tokenEnc: null,
        tokenKeyId: null,
        oauthStateHash: null,
        oauthStateExpiresAt: null,
      })
      .where(
        and(
          eq(metaConnections.workspaceId, workspaceId),
          eq(metaConnections.facebookUserId, input.facebookUserId),
          ne(metaConnections.status, 'disconnected'),
          ne(metaConnections.id, c.id),
        ),
      )
      .returning({ id: metaConnections.id });
    if (older.length)
      await ctx.tx
        .update(metaAccounts)
        .set({ connectionId: c.id })
        .where(
          and(
            eq(metaAccounts.workspaceId, workspaceId),
            inArray(
              metaAccounts.connectionId,
              older.map((o) => o.id),
            ),
          ),
        );
    await ctx.tx
      .update(metaConnections)
      .set({
        status: 'connected',
        facebookUserId: input.facebookUserId,
        facebookUserName: input.facebookUserName,
        scopes: input.scopes,
        tokenEnc: input.tokenEnc,
        tokenKeyId: input.tokenKeyId,
        tokenExpiresAt: input.tokenExpiresAt ? new Date(input.tokenExpiresAt) : null,
        oauthStateHash: null,
        oauthStateExpiresAt: null,
        lastCheckedAt: now,
        lastError: null,
        connectedAt: now,
      })
      .where(eq(metaConnections.id, c.id));
    const readsAds = input.scopes.includes('ads_read');
    // Ads this business's sign-ins couldn't read before may be readable now: look again. Meta says "no such ad"
    // about one in an ad account the person can't see, so those are asked about again too.
    if (readsAds) {
      const waiting = await ctx.tx
        .update(ads)
        .set({ status: 'pending', nextResolveAt: now, attempts: 0 })
        .where(
          and(eq(ads.workspaceId, workspaceId), inArray(ads.status, ['no_access', 'not_found'])),
        )
        .returning({ id: ads.id });
      for (const a of waiting.slice(0, 200))
        await scheduleJob(ctx.tx, {
          kind: SOCIAL_JOBS.resolveAd,
          dedupeKey: `meta-ad:${a.id}`,
          runAt: now,
          payload: { adId: a.id },
          workspaceId,
          organizationId: ctx.scope.organizationId,
        });
    }
    // Never the token: the event names who signed in and what it can do.
    await ctx.emit({
      type: 'meta_connection.connected',
      entityType: 'meta_connection',
      entityId: c.id,
      payload: { facebookUserName: input.facebookUserName, readsAds, replaced: older.length },
    });
    return { connectionId: c.id };
  },
});

export const metaConnectionDisconnect = defineCommand({
  name: 'meta_connection.disconnect',
  description:
    'Disconnect Facebook: HandsFreeOS forgets the sign-in and stops answering every Page and Instagram account it connected. Conversations and their messages stay; nothing changes on Facebook or Instagram.',
  risk: 2,
  input: MetaConnectionDisconnectInput,
  output: MetaConnectionDisconnectOutput,
  permission: 'channels.manage',
  scope: inWorkspace,
  emits: [
    'meta_connection.disconnected',
    'meta_account.disconnected',
    'meta_account.needs_attention',
  ],
  actors: ['human', 'system'],
  async handler(ctx, input) {
    const workspaceId = ctx.scope.workspaceId!;
    if (ctx.actor.type === 'human' && ((input.reason && input.reason !== 'person') || input.forget))
      throw HfosError.validation([
        { path: 'reason', message: 'People disconnect Facebook as themselves.' },
      ]);
    const reason = input.reason ?? 'person';
    const now = new Date();
    // Facebook asked us to forget who signed in: their name and id go with the token.
    const forget = input.forget ? { facebookUserId: null, facebookUserName: null } : {};
    const [c] = await ctx.tx
      .update(metaConnections)
      .set({
        status: 'disconnected',
        disconnectedAt: now,
        disconnectedReason: reason,
        tokenEnc: null,
        tokenKeyId: null,
        oauthStateHash: null,
        oauthStateExpiresAt: null,
        ...forget,
      })
      .where(
        and(
          eq(metaConnections.id, input.connectionId),
          eq(metaConnections.workspaceId, workspaceId),
          ne(metaConnections.status, 'disconnected'),
        ),
      )
      .returning({ id: metaConnections.id, name: metaConnections.facebookUserName });
    if (!c && input.forget) {
      // Already disconnected: only who it was is left to forget.
      const [gone] = await ctx.tx
        .update(metaConnections)
        .set(forget)
        .where(
          and(
            eq(metaConnections.id, input.connectionId),
            eq(metaConnections.workspaceId, workspaceId),
          ),
        )
        .returning({ id: metaConnections.id });
      if (!gone) throw HfosError.notFound('That Facebook sign-in isn’t here anymore.');
      return { connectionId: gone.id, accountIds: [] };
    }
    if (!c)
      throw HfosError.notFound(
        'That Facebook sign-in isn’t connected anymore. Refresh Settings → Facebook & Instagram to see where it stands.',
      );
    const accounts = await ctx.tx
      .select(META_ACCOUNT_COLUMNS)
      .from(metaAccounts)
      .where(
        and(
          eq(metaAccounts.workspaceId, workspaceId),
          eq(metaAccounts.connectionId, c.id),
          ne(metaAccounts.status, 'disconnected'),
        ),
      );
    // A person disconnecting stops every Page with it. Facebook taking the app away (revoked) breaks their tokens
    // too, but the Pages stay listed, asking to be connected again, so nobody wonders where their messages went.
    for (const a of accounts) {
      if (reason === 'person') await stopAccount(ctx, a, 'person', now);
      else await troubleAccount(ctx, a, reason === 'revoked' ? 'revoked' : 'reauth', '');
    }
    await ctx.emit({
      type: 'meta_connection.disconnected',
      entityType: 'meta_connection',
      entityId: c.id,
      payload: { reason, accounts: accounts.length },
      after: { facebookUserName: input.forget ? null : c.name, reason },
    });
    return { connectionId: c.id, accountIds: accounts.map((a) => a.id) };
  },
});

export const metaAccountConnect = defineCommand({
  name: 'meta_account.connect',
  description:
    'Worker: a Facebook Page, or an Instagram account linked to one, that somebody picked after signing in. Connected again, it keeps its conversations.',
  risk: 1,
  input: MetaAccountConnectInput,
  output: MetaAccountConnectOutput,
  permission: 'channels.manage',
  scope: inWorkspace,
  emits: ['meta_account.connected'],
  actors: ['system'],
  async handler(ctx, input) {
    const workspaceId = ctx.scope.workspaceId!;
    const [c] = await ctx.tx
      .select()
      .from(metaConnections)
      .where(
        and(
          eq(metaConnections.id, input.connectionId),
          eq(metaConnections.workspaceId, workspaceId),
        ),
      );
    if (!c || c.status !== 'connected')
      throw HfosError.rule(
        'meta_connection_not_connected',
        409,
        'That Facebook sign-in isn’t connected anymore. Sign in again from Settings → Facebook & Instagram.',
      );
    const label =
      input.platform === 'instagram' && input.username ? `@${input.username}` : input.name;
    // Meta sends a Page's messages to one place, so one business answers it at a time.
    const [elsewhere] = await rows<{ workspace_id: string }>(
      ctx.tx,
      sql`select workspace_id from private.meta_account_holders(array[${input.externalId}]::text[])
          where platform = ${input.platform} and workspace_id <> ${workspaceId}`,
    );
    if (elsewhere)
      throw HfosError.rule(
        'meta_account_elsewhere',
        409,
        `${label} already answers its messages in another business on HandsFreeOS. Disconnect it there first, then connect it here.`,
      );
    const now = new Date();
    const [existing] = await ctx.tx
      .select()
      .from(metaAccounts)
      .where(
        and(
          eq(metaAccounts.workspaceId, workspaceId),
          eq(metaAccounts.platform, input.platform),
          eq(metaAccounts.externalId, input.externalId),
        ),
      );
    const values = {
      connectionId: c.id,
      pageId: input.pageId,
      name: input.name,
      username: input.username,
      status: 'active' as const,
      problem: null,
      disconnectedAt: null,
      disconnectedReason: null,
      tokenEnc: input.tokenEnc,
      tokenKeyId: input.tokenKeyId,
      humanAgent: input.humanAgent,
      subscribedAt: input.subscribed ? now : null,
      failures: 0,
      lastError: input.subscribed
        ? null
        : 'Meta didn’t agree to send this account’s messages yet. HandsFreeOS asks again every day.',
      connectedAt: now,
      connectedBy: c.createdBy,
    };
    let accountId: string;
    if (existing) {
      await ctx.tx.update(metaAccounts).set(values).where(eq(metaAccounts.id, existing.id));
      accountId = existing.id;
    } else {
      const [row] = await ctx.tx
        .insert(metaAccounts)
        .values({ workspaceId, platform: input.platform, externalId: input.externalId, ...values })
        .returning({ id: metaAccounts.id });
      if (!row) throw HfosError.forbidden();
      accountId = row.id;
    }
    const reconnected = !!existing && existing.status !== 'active';
    await ctx.emit({
      type: 'meta_account.connected',
      entityType: 'meta_account',
      entityId: accountId,
      payload: {
        platform: input.platform,
        name: input.name,
        username: input.username,
        reconnected,
        subscribed: input.subscribed,
      },
      after: { account: label, platform: input.platform },
    });
    return { accountId, reconnected };
  },
});

/** A Page or account stops answering here. Its token is kept until the worker has told Meta (meta_account.disconnected). */
async function stopAccount(
  ctx: CommandContext,
  a: Account,
  reason: 'person' | 'revoked' | 'failed' | 'moved',
  now: Date,
): Promise<boolean> {
  const [done] = await ctx.tx
    .update(metaAccounts)
    .set({ status: 'disconnected', problem: null, disconnectedAt: now, disconnectedReason: reason })
    .where(and(eq(metaAccounts.id, a.id), ne(metaAccounts.status, 'disconnected')))
    .returning({ id: metaAccounts.id });
  if (!done) return false;
  await ctx.emit({
    type: 'meta_account.disconnected',
    entityType: 'meta_account',
    entityId: a.id,
    payload: { platform: a.platform, pageId: a.pageId, reason },
    after: { account: accountLabel(a), reason },
  });
  return true;
}

/** A Page or account needs somebody. Said once per problem, so a failing day of retries is one alert. */
async function troubleAccount(
  ctx: CommandContext,
  a: Account,
  problem: 'reauth' | 'revoked' | 'failed',
  reason: string,
): Promise<boolean> {
  if (a.status === 'disconnected') return false;
  await ctx.tx
    .update(metaAccounts)
    .set({
      status: 'needs_attention',
      problem,
      lastError: reason ? reason.slice(0, 2000) : a.lastError,
      failures: sql`${metaAccounts.failures} + 1`,
    })
    .where(eq(metaAccounts.id, a.id));
  if (a.status === 'needs_attention' && a.problem === problem) return false;
  await ctx.emit({
    type: 'meta_account.needs_attention',
    entityType: 'meta_account',
    entityId: a.id,
    payload: { platform: a.platform, problem },
    after: { account: accountLabel(a), problem },
  });
  return true;
}

async function requireAccount(ctx: CommandContext, accountId: string): Promise<Account> {
  const [a] = await ctx.tx
    .select(META_ACCOUNT_COLUMNS)
    .from(metaAccounts)
    .where(
      and(eq(metaAccounts.id, accountId), eq(metaAccounts.workspaceId, ctx.scope.workspaceId!)),
    );
  if (!a)
    throw HfosError.notFound(
      'That Page or Instagram account isn’t here anymore. Refresh Settings → Facebook & Instagram.',
    );
  return a;
}

export const metaAccountDisconnect = defineCommand({
  name: 'meta_account.disconnect',
  description:
    'Stop answering one Facebook Page or Instagram account here. Its conversations and messages stay, and connecting it again picks them up where they were.',
  risk: 2,
  input: MetaAccountDisconnectInput,
  output: MetaAccountOutput,
  permission: 'channels.manage',
  scope: inWorkspace,
  emits: ['meta_account.disconnected'],
  actors: ['human', 'system'],
  async handler(ctx, input) {
    if (ctx.actor.type === 'human' && input.reason && input.reason !== 'person')
      throw HfosError.validation([
        { path: 'reason', message: 'People disconnect a Page as themselves.' },
      ]);
    const a = await requireAccount(ctx, input.accountId);
    if (a.status === 'disconnected') {
      if (ctx.actor.type === 'human')
        throw HfosError.notFound(
          `${accountLabel(a)} isn’t connected anymore. Refresh Settings → Facebook & Instagram to see where it stands.`,
        );
      return { accountId: a.id, changed: false };
    }
    const changed = await stopAccount(ctx, a, input.reason ?? 'person', new Date());
    return { accountId: a.id, changed };
  },
});

export const metaAccountFail = defineCommand({
  name: 'meta_account.fail',
  description:
    'Worker: a Page or Instagram account stopped working — its sign-in expired or changed, HandsFreeOS was removed from it on Facebook, or Meta keeps refusing it. Owners and admins hear once.',
  risk: 1,
  input: MetaAccountFailInput,
  output: MetaAccountOutput,
  permission: 'channels.manage',
  scope: inWorkspace,
  emits: ['meta_account.needs_attention'],
  actors: ['system'],
  async handler(ctx, input) {
    const a = await requireAccount(ctx, input.accountId);
    const changed = await troubleAccount(ctx, a, input.problem, input.reason);
    return { accountId: a.id, changed };
  },
});

export const metaAccountRecover = defineCommand({
  name: 'meta_account.recover',
  description: 'Worker: a Page or Instagram account that needed somebody works again.',
  risk: 1,
  input: MetaAccountRecoverInput,
  output: MetaAccountOutput,
  permission: 'channels.manage',
  scope: inWorkspace,
  emits: ['meta_account.recovered'],
  actors: ['system'],
  async handler(ctx, input) {
    const a = await requireAccount(ctx, input.accountId);
    if (a.status === 'disconnected') return { accountId: a.id, changed: false };
    await ctx.tx
      .update(metaAccounts)
      .set({
        status: 'active',
        problem: null,
        failures: 0,
        lastError: null,
        ...(input.subscribed ? { subscribedAt: new Date() } : {}),
        ...(input.humanAgent !== undefined ? { humanAgent: input.humanAgent } : {}),
      })
      .where(eq(metaAccounts.id, a.id));
    const changed = a.status === 'needs_attention';
    if (changed)
      await ctx.emit({
        type: 'meta_account.recovered',
        entityType: 'meta_account',
        entityId: a.id,
        payload: { platform: a.platform },
        after: { account: accountLabel(a) },
      });
    return { accountId: a.id, changed };
  },
});

// ------------------------------------------------------------------------------------------------------ receiving

type ReceiveInput = z.infer<typeof SocialReceiveInput>;

/** Meta's attachment types that are files we copy into the thread; the rest are things they shared. */
const FILE_TYPES: ReadonlySet<string> = new Set(['image', 'video', 'audio', 'file']);

/** The customer's thread on this Page or account: theirs already, or the one their id names, made when it's new. */
async function socialConversation(
  ctx: CommandContext,
  account: Account,
  channel: SocialChannel,
  counterpart: string,
  contact: typeof metaContacts.$inferSelect,
  make: { personId: string | null } | null,
): Promise<{ conversation: Conversation; created: boolean } | null> {
  const workspaceId = ctx.scope.workspaceId!;
  if (contact.conversationId) {
    const [c] = await ctx.tx
      .select()
      .from(conversations)
      .where(eq(conversations.id, contact.conversationId));
    if (c) return { conversation: c, created: false };
  }
  const find = async () =>
    (
      await ctx.tx
        .select()
        .from(conversations)
        .where(
          and(
            eq(conversations.workspaceId, workspaceId),
            eq(conversations.channel, channel),
            eq(conversations.counterpart, counterpart),
            isNull(conversations.privateTo),
          ),
        )
        .orderBy(desc(conversations.createdAt))
        .limit(1)
    )[0] ?? null;
  const found = await find();
  if (found) return { conversation: found, created: false };
  if (!make) return null;
  const [inserted] = await ctx.tx
    .insert(conversations)
    .values({
      workspaceId,
      channel,
      counterpart,
      personId: make.personId,
      metaAccountId: account.id,
    })
    .onConflictDoNothing()
    .returning();
  if (inserted) return { conversation: inserted, created: true };
  const raced = await find();
  if (!raced) throw HfosError.forbidden();
  return { conversation: raced, created: false };
}

/** The customer's open lead, newest first: what a touch's opportunity credit starts from. */
async function openLeadOf(ctx: CommandContext, personId: string | null): Promise<string | null> {
  if (!personId) return null;
  const [l] = await ctx.tx
    .select({ id: leads.id })
    .from(leads)
    .where(and(eq(leads.personId, personId), eq(leads.status, 'open'), isNull(leads.archivedAt)))
    .orderBy(desc(leads.createdAt))
    .limit(1);
  return l?.id ?? null;
}

/** The ad's row, made the first time anybody comes from it, and its lookup queued then. */
async function adRow(ctx: CommandContext, externalId: string): Promise<string | null> {
  const workspaceId = ctx.scope.workspaceId!;
  const [made] = await ctx.tx
    .insert(ads)
    .values({
      workspaceId,
      network: 'meta',
      externalId,
      status: 'pending',
      nextResolveAt: new Date(),
    })
    .onConflictDoNothing()
    .returning({ id: ads.id });
  if (made) {
    await scheduleJob(ctx.tx, {
      kind: SOCIAL_JOBS.resolveAd,
      dedupeKey: `meta-ad:${made.id}`,
      runAt: new Date(),
      payload: { adId: made.id },
      workspaceId,
      organizationId: ctx.scope.organizationId,
    });
    return made.id;
  }
  const [known] = await ctx.tx
    .select({ id: ads.id })
    .from(ads)
    .where(
      and(
        eq(ads.workspaceId, workspaceId),
        eq(ads.network, 'meta'),
        eq(ads.externalId, externalId),
      ),
    );
  return known?.id ?? null;
}

/**
 * Meta can say the same visit twice (a referral, then the message it opened), so the same ad or ref for the same
 * person within minutes is one touch: this finds it, for the later of the two to join.
 */
async function sameVisit(
  ctx: CommandContext,
  contactId: string,
  r: NonNullable<ReceiveInput['referral']>,
  at: Date,
): Promise<{ id: string; messageId: string | null } | null> {
  const [same] = await ctx.tx
    .select({ id: attributionTouches.id, messageId: attributionTouches.messageId })
    .from(attributionTouches)
    .where(
      and(
        eq(attributionTouches.workspaceId, ctx.scope.workspaceId!),
        eq(attributionTouches.metaContactId, contactId),
        r.adId ? eq(attributionTouches.adId, r.adId) : isNull(attributionTouches.adId),
        r.ref
          ? eq(attributionTouches.ref, r.ref.trim().slice(0, 500))
          : isNull(attributionTouches.ref),
        sql`abs(extract(epoch from ${attributionTouches.touchedAt} - ${at.toISOString()}::timestamptz)) * 1000 < ${SAME_VISIT_MS}`,
      ),
    )
    .limit(1);
  return same ?? null;
}

/**
 * An ad or a link brought somebody: a touch of its own, never folded into anything. Returns the touch, or the one
 * this visit already made (`sameVisit`), which a message that came with it is then linked to.
 */
async function recordTouch(
  ctx: CommandContext,
  t: {
    readonly id: string;
    readonly account: Account;
    readonly channel: SocialChannel;
    readonly contactId: string;
    readonly conversation: Conversation | null;
    readonly personId: string | null;
    readonly leadId: string | null;
    readonly messageId: string | null;
    readonly started: boolean;
    readonly referral: NonNullable<ReceiveInput['referral']>;
    readonly at: Date;
    readonly dedupeKey: string;
  },
): Promise<string | null> {
  const workspaceId = ctx.scope.workspaceId!;
  const r = t.referral;
  const same = await sameVisit(ctx, t.contactId, r, t.at);
  if (same) {
    if (t.messageId && !same.messageId)
      await ctx.tx
        .update(attributionTouches)
        .set({ messageId: t.messageId })
        .where(eq(attributionTouches.id, same.id));
    return same.id;
  }
  const adRefId = r.adId ? await adRow(ctx, r.adId) : null;
  const [made] = await ctx.tx
    .insert(attributionTouches)
    .values({
      id: t.id,
      workspaceId,
      network: 'meta',
      platform: t.account.platform,
      channel: t.channel,
      touchedAt: t.at,
      kind: t.started ? 'started' : 'returned',
      personId: t.personId,
      metaAccountId: t.account.id,
      metaContactId: t.contactId,
      conversationId: t.conversation?.id ?? null,
      messageId: t.messageId,
      leadId: t.leadId,
      source: clean(r.source, 60),
      referralType: clean(r.type, 60),
      ref: clean(r.ref, 500),
      adId: r.adId,
      adTitle: clean(r.adTitle, 1000),
      adPhotoUrl: clean(r.photoUrl, 2000),
      adVideoUrl: clean(r.videoUrl, 2000),
      postId: clean(r.postId, 200),
      productId: clean(r.productId, 200),
      refererUri: clean(r.refererUri, 2000),
      adRefId,
      raw: r.raw,
      dedupeKey: t.dedupeKey.slice(0, 300),
    })
    .onConflictDoNothing()
    .returning({ id: attributionTouches.id });
  if (!made) {
    // Meta sent this very event again: the touch it made the first time.
    const [kept] = await ctx.tx
      .select({ id: attributionTouches.id })
      .from(attributionTouches)
      .where(
        and(
          eq(attributionTouches.workspaceId, workspaceId),
          eq(attributionTouches.dedupeKey, t.dedupeKey.slice(0, 300)),
        ),
      );
    return kept?.id ?? null;
  }
  await ctx.emit({
    type: 'attribution.touched',
    entityType: 'attribution_touch',
    entityId: made.id,
    payload: {
      conversationId: t.conversation?.id ?? null,
      personId: t.personId,
      leadId: t.leadId,
      platform: t.account.platform,
      channel: t.channel,
      kind: t.started ? 'started' : 'returned',
      source: clean(r.source, 60),
      adId: r.adId,
      ref: clean(r.ref, 500),
    },
    after: {
      from: r.adId
        ? (clean(r.adTitle, 120) ?? 'An ad')
        : (clean(r.ref, 120) ?? clean(r.source, 60)),
      account: accountLabel(t.account),
    },
  });
  return made.id;
}

export const metaMessageReceive = defineCommand({
  name: 'meta_message.receive',
  description:
    'Worker: somebody wrote to one of the business’s Facebook Pages or Instagram accounts, tapped a button there, or came back to it from an ad or a link; or the business answered them in Facebook’s or Instagram’s own inbox. Files it in their conversation, makes a stranger a customer and a lead, and keeps every ad or link that brought them as a touch of its own.',
  risk: 1,
  input: SocialReceiveInput,
  output: SocialReceiveOutput,
  permission: 'inbox.use',
  scope: inWorkspace,
  emits: [
    'message.received',
    // The business wrote it, somewhere other than HandsFreeOS: kept in the thread, never a reply to answer.
    'message.imported',
    'conversation.linked',
    'person.created',
    'lead.created',
    'attribution.touched',
  ],
  actors: ['system'],
  async handler(ctx, input) {
    const workspaceId = ctx.scope.workspaceId!;
    const none = {
      messageId: null,
      conversationId: null,
      personId: null,
      contactId: null,
      touchId: null,
    };
    const account = await requireAccount(ctx, input.accountId).catch(() => null);
    // Meta keeps sending for a while after a Page is let go: nothing here answers it any more.
    if (!account || account.status === 'disconnected')
      return { outcome: 'ignored' as const, ...none };
    const channel = channelOfPlatform(account.platform);
    const counterpart = socialCounterpart(channel, account.externalId, input.scopedId);
    const at = new Date(input.occurredAt);

    // Meta sends a message again until it hears back, and an echo of our own reply carries a part's id.
    if (input.mid) {
      const [dup] = await rows<{ id: string; conversation_id: string }>(
        ctx.tx,
        sql`select id, conversation_id from app.messages
            where workspace_id = ${workspaceId}
              and (dedupe_key = ${input.mid} or provider_message_id = ${input.mid}
                or provider_part_ids @> array[${input.mid}]::text[])
            limit 1`,
      );
      if (dup)
        return {
          outcome: 'duplicate' as const,
          ...none,
          messageId: dup.id,
          conversationId: dup.conversation_id,
        };
    }
    if (input.kind === 'referral') {
      const [dup] = await ctx.tx
        .select({ id: attributionTouches.id })
        .from(attributionTouches)
        .where(
          and(
            eq(attributionTouches.workspaceId, workspaceId),
            eq(attributionTouches.dedupeKey, input.eventKey.slice(0, 300)),
          ),
        );
      if (dup) return { outcome: 'duplicate' as const, ...none, touchId: dup.id };
      if (!input.referral) return { outcome: 'ignored' as const, ...none };
    }

    // Who they are to this Page: their name and @handle when Meta shares them, kept as the newest it said.
    const name = clean(input.profile?.name, 200);
    const username = clean(input.profile?.username?.replace(/^@/, ''), 100);
    const [contact] = await ctx.tx
      .insert(metaContacts)
      .values({
        workspaceId,
        accountId: account.id,
        platform: account.platform,
        scopedId: input.scopedId,
        name,
        username,
        profileCheckedAt: input.profile ? new Date() : null,
      })
      .onConflictDoUpdate({
        target: [metaContacts.accountId, metaContacts.scopedId],
        set: {
          name: sql`coalesce(excluded.name, ${metaContacts.name})`,
          username: sql`coalesce(excluded.username, ${metaContacts.username})`,
          profileCheckedAt: sql`coalesce(excluded.profile_checked_at, ${metaContacts.profileCheckedAt})`,
        },
      })
      .returning();
    if (!contact) throw HfosError.forbidden();
    const who = socialContactName(channel, contact);

    const echo = input.kind === 'echo';
    const fromCustomer = input.kind === 'message' || input.kind === 'postback';
    const existing = await socialConversation(ctx, account, channel, counterpart, contact, null);
    // A stranger who writes, or taps Get Started, becomes a customer and a lead (M14), unless the business turned
    // that channel off. Coming back from an ad without writing yet isn't a lead; what they write next is.
    let intake: IntakeResult | null = null;
    const adSaid = !!input.referral?.adId;
    if (fromCustomer && !existing?.conversation.personId)
      intake = await intakeFromChannel(
        ctx,
        {
          kind: channel,
          name: contact.name ?? (contact.username ? `@${contact.username}` : who),
          how: adSaid
            ? `${META_PLATFORM_NAMES[account.platform]} ad`
            : `messaged on ${META_PLATFORM_NAMES[account.platform]}`,
          at,
        },
        await workspaceZone(ctx.tx, workspaceId),
      );
    const found =
      existing ??
      (input.kind === 'referral'
        ? null
        : await socialConversation(ctx, account, channel, counterpart, contact, {
            personId: intake?.personId ?? null,
          }));
    const conv = found?.conversation ?? null;
    const created = found?.created ?? false;
    const autoLink = !!conv && !created && !conv.personId && !!intake?.personId;
    const personId = conv?.personId ?? intake?.personId ?? null;

    if (conv) {
      if (contact.conversationId !== conv.id)
        await ctx.tx
          .update(metaContacts)
          .set({ conversationId: conv.id })
          .where(eq(metaContacts.id, contact.id));
      // Touches that came before the thread did (an ad clicked, nothing written yet) join it now.
      await ctx.tx
        .update(attributionTouches)
        .set({ conversationId: conv.id, personId })
        .where(
          and(
            eq(attributionTouches.workspaceId, workspaceId),
            eq(attributionTouches.metaContactId, contact.id),
            isNull(attributionTouches.conversationId),
          ),
        );
    }

    // Coming back from an ad or a link without writing: a touch, and nothing in the thread to answer.
    if (input.kind === 'referral') {
      const touchId = await recordTouch(ctx, {
        id: randomUUID(),
        account,
        channel,
        contactId: contact.id,
        conversation: conv,
        personId,
        leadId: await openLeadOf(ctx, personId),
        messageId: null,
        started: !conv?.lastInboundAt,
        referral: input.referral!,
        at,
        dedupeKey: input.eventKey,
      });
      return {
        outcome: 'recorded' as const,
        ...none,
        conversationId: conv?.id ?? null,
        personId,
        contactId: contact.id,
        touchId,
      };
    }
    if (!conv) throw HfosError.internal();

    // What it carried: files the worker copies in next, and things shared that aren't files we keep.
    const files = input.attachments.filter((a) => FILE_TYPES.has(a.type)).map((a) => a.type);
    // A story they answered is the reply's own line (replyTo), not something they shared.
    const shared: SocialShared[] = input.attachments
      .filter((a) => !FILE_TYPES.has(a.type) && a.type !== 'story')
      .map((a) => ({ type: a.type, url: a.url, title: a.title }));
    const text =
      clean(input.text, 10000) ??
      (input.kind === 'postback' ? clean(input.postbackTitle, 500) : null);
    const kinds = [...files, ...shared.map((s) => s.type)];
    const preview = socialPreview(text, kinds) || 'Sent a message';
    // The touch this message came with: the one its visit already made (a referral just before it), or a new one.
    const visit =
      !echo && input.referral ? await sameVisit(ctx, contact.id, input.referral, at) : null;
    const touchId = !echo && input.referral ? (visit?.id ?? randomUUID()) : null;
    const social: SocialExtras = {
      ...(shared.length ? { shared } : {}),
      ...(files.length ? { files } : {}),
      ...(echo ? { elsewhere: true } : {}),
      ...(input.replyToMid || input.storyReply
        ? {
            replyTo: {
              mid: input.replyToMid,
              story: input.storyReply,
              storyUrl: input.storyReply
                ? (input.attachments.find((a) => a.type === 'story')?.url ?? null)
                : null,
            },
          }
        : {}),
      ...(input.kind === 'postback'
        ? { postback: { title: clean(input.postbackTitle, 500) } }
        : {}),
      ...(touchId ? { touchId } : {}),
    };
    // Webhooks arrive out of order when Meta retries: only the newest message is the conversation's latest.
    const latest = !conv.lastMessageAt || conv.lastMessageAt.getTime() <= at.getTime();
    const messageId = randomUUID();
    const media: MediaRef[] = [];

    if (echo) {
      const eventId = await ctx.emit({
        type: 'message.imported',
        entityType: 'message',
        entityId: messageId,
        payload: {
          conversationId: conv.id,
          personId,
          channel,
          direction: 'outbound',
          elsewhere: true,
        },
        after: { to: who, preview: preview.slice(0, 80), channel },
      });
      const activityId = await logChannelActivity(ctx, {
        kind: channel,
        subtype: 'outbound',
        personId,
        body: text ?? preview,
        occurredAt: at,
        eventId,
        meta: {
          direction: 'outbound',
          messageId,
          conversationId: conv.id,
          status: 'sent',
          elsewhere: true,
        },
      });
      await ctx.tx.insert(messages).values({
        id: messageId,
        workspaceId,
        conversationId: conv.id,
        channel,
        direction: 'outbound',
        status: 'sent',
        fromAddress: account.externalId,
        toAddresses: [counterpart],
        bodyText: text,
        media,
        provider: 'meta',
        providerMessageId: input.mid,
        dedupeKey: input.mid ?? input.eventKey,
        providerPartIds: input.mid ? [input.mid] : [],
        occurredAt: at,
        sentAt: at,
        activityId,
        social,
      });
      // Answered, on Facebook or Instagram: nobody here needs to answer it again.
      await ctx.tx
        .update(conversations)
        .set({
          ...(latest
            ? { lastMessageAt: at, lastPreview: preview, lastDirection: 'outbound' as const }
            : {}),
          lastOutboundAt: sql`greatest(${conversations.lastOutboundAt}, ${at.toISOString()}::timestamptz)`,
          awaitingReplySince: null,
          unreadCount: 0,
          ...(conv.metaAccountId ? {} : { metaAccountId: account.id }),
        })
        .where(eq(conversations.id, conv.id));
      return {
        outcome: 'recorded' as const,
        messageId,
        conversationId: conv.id,
        personId,
        contactId: contact.id,
        touchId: null,
      };
    }

    const eventId = await ctx.emit({
      type: 'message.received',
      entityType: 'message',
      entityId: messageId,
      payload: {
        conversationId: conv.id,
        personId,
        channel,
        mediaCount: files.length,
        reopened: conv.status !== 'open',
        ...(input.kind === 'postback' ? { postback: true } : {}),
        ...(touchId ? { touchId, adId: input.referral?.adId ?? null } : {}),
      },
      after: { from: who, preview: preview.slice(0, 80), channel },
    });
    const activityId = await logChannelActivity(ctx, {
      kind: channel,
      subtype: 'inbound',
      personId,
      body: text ?? preview,
      occurredAt: at,
      eventId,
      meta: {
        direction: 'inbound',
        messageId,
        conversationId: conv.id,
        mediaCount: files.length,
        ...(input.referral
          ? {
              referral: {
                source: clean(input.referral.source, 60),
                adId: input.referral.adId,
                adTitle: clean(input.referral.adTitle, 200),
                ref: clean(input.referral.ref, 200),
              },
            }
          : {}),
      },
    });
    await ctx.tx.insert(messages).values({
      id: messageId,
      workspaceId,
      conversationId: conv.id,
      channel,
      direction: 'inbound',
      status: 'received',
      fromAddress: counterpart,
      toAddresses: [account.externalId],
      bodyText: text,
      media,
      provider: 'meta',
      providerMessageId: input.mid,
      dedupeKey: input.mid ?? input.eventKey,
      occurredAt: at,
      activityId,
      social,
    });
    await ctx.tx
      .update(conversations)
      .set({
        ...(latest
          ? { lastMessageAt: at, lastPreview: preview, lastDirection: 'inbound' as const }
          : {}),
        lastInboundAt: sql`greatest(${conversations.lastInboundAt}, ${at.toISOString()}::timestamptz)`,
        unreadCount: sql`${conversations.unreadCount} + 1`,
        status: 'open' as const,
        snoozedUntil: null,
        closedAt: null,
        closedBy: null,
        awaitingReplySince: sql`coalesce(${conversations.awaitingReplySince}, ${at.toISOString()}::timestamptz)`,
        ...(autoLink ? { personId } : {}),
        ...(conv.metaAccountId ? {} : { metaAccountId: account.id }),
      })
      .where(eq(conversations.id, conv.id));
    if (autoLink && personId) {
      const [p] = await ctx.tx
        .select({ firstName: people.firstName, lastName: people.lastName })
        .from(people)
        .where(eq(people.id, personId));
      await ctx.emit({
        type: 'conversation.linked',
        entityType: 'conversation',
        entityId: conv.id,
        payload: { personId, previousPersonId: null, phoneAdded: false, auto: true },
        before: { person: null },
        after: { person: p ? fullName(p.firstName, p.lastName) : null, with: who },
      });
    }
    let recordedTouch: string | null = visit?.id ?? null;
    if (visit && !visit.messageId)
      await ctx.tx
        .update(attributionTouches)
        .set({ messageId })
        .where(eq(attributionTouches.id, visit.id));
    else if (touchId && input.referral && !visit)
      recordedTouch = await recordTouch(ctx, {
        id: touchId,
        account,
        channel,
        contactId: contact.id,
        conversation: conv,
        personId,
        leadId: intake?.leadId ?? (await openLeadOf(ctx, personId)),
        messageId,
        started: created || !conv.lastInboundAt,
        referral: input.referral,
        at,
        dedupeKey: input.mid ?? input.eventKey,
      });
    const m = await workspaceMessaging(ctx.tx, workspaceId);
    const reminderMs = m.settings.unansweredReminderMinutes * 60_000;
    if (reminderMs > 0)
      await scheduleJob(ctx.tx, {
        kind: 'conversation.unanswered_check',
        dedupeKey: `unanswered:${conv.id}`,
        runAt: new Date(at.getTime() + reminderMs),
        payload: { conversationId: conv.id },
        workspaceId,
        organizationId: m.organizationId,
      });
    return {
      outcome: 'recorded' as const,
      messageId,
      conversationId: conv.id,
      personId,
      contactId: contact.id,
      touchId: recordedTouch,
    };
  },
});

/** The customer's thread on this Page or account, by their id there. */
async function threadOf(
  ctx: CommandContext,
  account: Account,
  scopedId: string,
): Promise<string | null> {
  const [c] = await ctx.tx
    .select({ conversationId: metaContacts.conversationId })
    .from(metaContacts)
    .where(and(eq(metaContacts.accountId, account.id), eq(metaContacts.scopedId, scopedId)));
  return c?.conversationId ?? null;
}

export const metaMessageReceipt = defineCommand({
  name: 'meta_message.receipt',
  description:
    'Worker: Messenger delivered, or the customer read, the business’s messages up to a moment; or Instagram says they saw one.',
  risk: 1,
  input: SocialReceiptInput,
  output: SocialReceiptOutput,
  permission: 'inbox.use',
  scope: inWorkspace,
  emits: ['message.delivered', 'message.read'],
  actors: ['system'],
  async handler(ctx, input) {
    const account = await requireAccount(ctx, input.accountId).catch(() => null);
    if (!account || account.status === 'disconnected') return { updated: 0 };
    const conversationId = await threadOf(ctx, account, input.scopedId);
    if (!conversationId) return { updated: 0 };
    // Up to the watermark, or up to the newest of the messages named (Instagram's "Seen" names one).
    let upTo: string | null = input.watermark;
    if (!upTo && input.mids.length) {
      const [m] = await rows<{ at: string }>(
        ctx.tx,
        sql`select max(occurred_at)::text as at from app.messages
            where conversation_id = ${conversationId} and direction = 'outbound'
              and (provider_message_id = any(${textArray(input.mids)})
                or provider_part_ids && ${textArray(input.mids)})`,
      );
      upTo = m?.at ?? null;
    }
    if (!upTo) return { updated: 0 };
    const read = input.kind === 'read';
    const changed = await rows<{ id: string; status: string }>(
      ctx.tx,
      sql`update app.messages set
            status = ${read ? 'read' : 'delivered'}::app.message_status,
            sent_at = coalesce(sent_at, occurred_at),
            delivered_at = coalesce(delivered_at, now())
            ${read ? sql`, read_at = coalesce(read_at, now())` : sql``}
          where conversation_id = ${conversationId} and direction = 'outbound'
            and occurred_at <= ${upTo}::timestamptz
            and status in (${read ? sql`'sent', 'delivered'` : sql`'sent'`})
          returning id, status::text as status`,
    );
    // Screens refresh on the newest few; a long thread read at once doesn't need an event per message.
    for (const m of changed.slice(-10))
      await ctx.emit({
        type: read ? 'message.read' : 'message.delivered',
        entityType: 'message',
        entityId: m.id,
        payload: { conversationId, status: m.status, errorCode: null },
        after: { status: m.status, channel: channelOfPlatform(account.platform) },
      });
    return { updated: changed.length };
  },
});

export const metaMessageEdit = defineCommand({
  name: 'meta_message.edit',
  description:
    'Worker: the customer changed what they wrote on Messenger or Instagram, or took it back. An edit keeps the newest words; a message taken back keeps nothing of what it said.',
  risk: 1,
  input: SocialEditInput,
  output: SocialEditOutput,
  permission: 'inbox.use',
  scope: inWorkspace,
  emits: ['message.edited'],
  actors: ['system'],
  async handler(ctx, input) {
    const account = await requireAccount(ctx, input.accountId).catch(() => null);
    if (!account || account.status === 'disconnected') return { messageId: null };
    const [m] = await ctx.tx
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.workspaceId, ctx.scope.workspaceId!),
          eq(messages.dedupeKey, input.mid),
          eq(messages.direction, 'inbound'),
        ),
      )
      .limit(1);
    if (!m || m.unsentAt) return { messageId: m?.id ?? null };
    const at = new Date(input.occurredAt);
    if (!input.unsent && m.editedAt && m.editedAt.getTime() >= at.getTime())
      return { messageId: m.id };
    const text = input.unsent ? null : clean(input.text, 10000);
    const { shared: _shared, files: _files, ...rest } = m.social ?? {};
    await ctx.tx
      .update(messages)
      .set(
        input.unsent
          ? { bodyText: null, media: [], social: rest, unsentAt: at }
          : { bodyText: text, editedAt: at },
      )
      .where(eq(messages.id, m.id));
    // The timeline keeps what the thread keeps: the newest words, or only that there was a message.
    if (m.activityId)
      await ctx.tx
        .update(activities)
        .set({
          body: input.unsent ? null : (text ?? null),
          meta: sql`${activities.meta} || ${JSON.stringify(input.unsent ? { unsent: true } : { edited: true })}::jsonb`,
        })
        .where(eq(activities.id, m.activityId));
    const preview = input.unsent
      ? 'Took back a message'
      : socialPreview(text, [
          ...(m.social?.files ?? []),
          ...(m.social?.shared ?? []).map((s) => s.type),
        ]);
    // The conversation's list shows the newest words when this is its latest message.
    await ctx.tx
      .update(conversations)
      .set({ lastPreview: preview })
      .where(
        and(
          eq(conversations.id, m.conversationId),
          eq(conversations.lastDirection, 'inbound'),
          sql`${conversations.lastMessageAt} = ${m.occurredAt.toISOString()}::timestamptz`,
        ),
      );
    await ctx.emit({
      type: 'message.edited',
      entityType: 'message',
      entityId: m.id,
      payload: {
        conversationId: m.conversationId,
        unsent: input.unsent,
        // The copies of what it carried, for the worker to delete when it was taken back.
        mediaPaths: input.unsent ? m.media.map((x) => x.objectPath) : [],
      },
    });
    return { messageId: m.id };
  },
});

// ------------------------------------------------------------------------------------------------------------ ads

export const adResolve = defineCommand({
  name: 'ad.resolve',
  description:
    'Worker: what Meta’s Marketing API said about an ad somebody came from — its campaign, ad set and creative — or why it couldn’t say.',
  risk: 1,
  input: AdResolveInput,
  output: AdResolveOutput,
  permission: 'inbox.use',
  scope: inWorkspace,
  emits: ['ad.resolved'],
  actors: ['system'],
  async handler(ctx, input) {
    const [a] = await ctx.tx
      .select()
      .from(ads)
      .where(and(eq(ads.id, input.adId), eq(ads.workspaceId, ctx.scope.workspaceId!)));
    if (!a) throw HfosError.notFound('That ad isn’t here anymore.');
    const d = input.details;
    const resolved = input.outcome === 'resolved' && !!d;
    await ctx.tx
      .update(ads)
      .set({
        status: input.outcome,
        attempts: sql`least(${ads.attempts} + 1, 1000)`,
        nextResolveAt: input.retryAt ? new Date(input.retryAt) : null,
        lastError: input.error ? input.error.slice(0, 2000) : null,
        ...(resolved
          ? {
              name: d.name,
              adAccountId: d.adAccountId,
              adsetId: d.adsetId,
              adsetName: d.adsetName,
              campaignId: d.campaignId,
              campaignName: d.campaignName,
              campaignObjective: d.campaignObjective,
              creativeId: d.creativeId,
              creativeName: d.creativeName,
              creativeTitle: d.creativeTitle,
              creativeBody: d.creativeBody,
              creativeThumbnailUrl: d.creativeThumbnailUrl,
              creativeLink: d.creativeLink,
              callToAction: d.callToAction,
              effectiveStatus: d.effectiveStatus,
              platforms: d.platforms,
              details: d.raw as Record<string, never>,
              resolvedAt: new Date(),
            }
          : {}),
      })
      .where(eq(ads.id, a.id));
    if (resolved || a.status !== input.outcome)
      await ctx.emit({
        type: 'ad.resolved',
        entityType: 'ad',
        entityId: a.id,
        payload: { externalId: a.externalId, status: input.outcome },
        after: resolved ? { ad: d.name, campaign: d.campaignName } : { status: input.outcome },
      });
    return { adId: a.id, status: input.outcome };
  },
});

/** The platform's words for where a touch landed: "Facebook Page", "Instagram account". */
export const accountKindWords = (platform: MetaPlatform): string =>
  platform === 'facebook' ? 'Facebook Page' : 'Instagram account';

export const socialCommands = [
  metaConnectionConnect,
  metaConnectionActivate,
  metaConnectionDisconnect,
  metaAccountConnect,
  metaAccountDisconnect,
  metaAccountFail,
  metaAccountRecover,
  metaMessageReceive,
  metaMessageReceipt,
  metaMessageEdit,
  adResolve,
];
