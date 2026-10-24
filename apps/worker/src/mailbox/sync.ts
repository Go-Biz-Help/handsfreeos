/**
 * The mailbox sync job: one per connected mailbox, rescheduling itself. It keeps the sign-in fresh (and the
 * new seal stored), keeps Outlook's change notifications alive, and files mail with known customers through
 * `email.receive`. Everything else in the mailbox stays private: not stored, not even its attachments.
 */
import { createHash, randomBytes } from 'node:crypto';
import { and, eq, inArray, isNull, or, sql as dsql } from 'drizzle-orm';
import { emailReceive, executeCommand, mailboxFail, otherEmailsOf } from '@hfos/core/server';
import { asWorker, sql, type Db, type Tx } from '@hfos/db/client';
import { conversations, mailboxConnections, people } from '@hfos/db/schema';
import { htmlToText, sanitizeInboundHtml } from '../email/render';
import { fileIndeedApplicant } from '../email/indeed';
import type { JobContext, JobHandler } from '../jobs';
import { errorMessage } from '../outbox';
import {
  systemActor,
  tenantOf,
  workerMeta,
  type TenantScope,
  type WorkerServices,
} from '../services';
import {
  MailboxAuthError,
  MailboxError,
  type MailboxProvider,
  type MailboxProviderName,
  type SyncedEmail,
  type TokenSet,
} from './provider';

export type Connection = typeof mailboxConnections.$inferSelect;

export const PROVIDER_NAME: Record<MailboxProviderName, string> = {
  microsoft: 'Outlook',
  google: 'Gmail',
};
/** Outlook subscriptions last three days and renew a day ahead; a disconnected mailbox's lapses on its own. */
const SUBSCRIPTION_MS = 3 * 86_400_000;
const RENEW_AHEAD_MS = 86_400_000;
/** After a failed subscribe (a local worker Graph can't reach), wait before trying again. */
const SUBSCRIBE_RETRY_MS = 6 * 3_600_000;
const REFRESH_AHEAD_MS = 5 * 60_000;
const MAX_PAGES = 20;
/** Failed syncs in a row before the mailbox shows "Not syncing" (it keeps trying). */
const FAILURES_BEFORE_ERROR = 5;

export const sha256Hex = (s: string): string => createHash('sha256').update(s).digest('hex');

interface SyncState {
  provider?: Record<string, unknown>;
  failures?: number;
}

/** Brings a mailbox's next sync forward (a notification, a new connection, Sync now). */
export async function scheduleSync(
  tx: Tx,
  scope: TenantScope,
  connectionId: string,
  at = new Date(),
): Promise<void> {
  await tx.execute(
    sql`insert into app.scheduled_jobs (organization_id, workspace_id, kind, dedupe_key, run_at, payload)
        values (${scope.organizationId}, ${scope.workspaceId}, 'mailbox.sync', ${`mailbox.sync:${connectionId}`},
          ${at.toISOString()}::timestamptz, ${JSON.stringify({ connectionId })}::jsonb)
        on conflict (kind, dedupe_key) where status = 'pending' and dedupe_key is not null
        do update set run_at = least(app.scheduled_jobs.run_at, excluded.run_at)`,
  );
}

export const syncSoon = (db: Db, scope: TenantScope, connectionId: string): Promise<void> =>
  asWorker(db, scope, (tx) => scheduleSync(tx, scope, connectionId));

const openTokens = (s: WorkerServices, sealed: string): TokenSet =>
  JSON.parse(s.sealer.open(sealed)) as TokenSet;

/** A working access token: renewed (and the new seal stored) when it is about to lapse, or when forced. */
export async function freshTokens(
  s: WorkerServices,
  scope: TenantScope,
  m: Connection,
  provider: MailboxProvider,
  force = false,
): Promise<TokenSet> {
  if (!m.tokenEnc) throw new MailboxAuthError('The mailbox has no sign-in.', 'missing');
  const current = openTokens(s, m.tokenEnc);
  if (!force && Date.parse(current.expiresAt) - Date.now() > REFRESH_AHEAD_MS) return current;
  const next = await provider.refresh(current);
  await asWorker(s.db, scope, (tx) =>
    tx
      .update(mailboxConnections)
      .set({
        tokenEnc: s.sealer.seal(JSON.stringify(next)),
        tokenKeyId: s.sealer.keyId,
        tokenExpiresAt: new Date(next.expiresAt),
      })
      .where(eq(mailboxConnections.id, m.id)),
  );
  return next;
}

/** Marks the mailbox as needing a reconnect, or as not syncing; the command emails nobody twice. */
export async function failMailbox(
  db: Db,
  scope: TenantScope,
  m: Connection,
  status: 'reauth_required' | 'error',
  error: string,
): Promise<void> {
  await executeCommand(
    db,
    mailboxFail,
    { workspaceId: scope.workspaceId, connectionId: m.id, status, error: error.slice(0, 2000) },
    systemActor(scope),
    workerMeta(),
  );
}

/** Addresses on this email that belong to customers (a person's address, or an email thread we have). */
async function knownCustomers(
  db: Db,
  scope: TenantScope,
  addresses: readonly string[],
): Promise<Set<string>> {
  const list = [...new Set(addresses)].slice(0, 50);
  if (list.length === 0) return new Set();
  // A customer deleted (in the Deleted bin, or gone with only the name their bills keep) isn't one any more; their
  // threads are out of sight already.
  const notDeleted = [isNull(people.binItemId), isNull(people.erasedAt)];
  return asWorker(db, scope, async (tx) => {
    const byPerson = await tx
      .select({ address: dsql<string>`lower(${people.email})` })
      .from(people)
      .where(
        and(
          eq(people.workspaceId, scope.workspaceId),
          inArray(dsql`lower(${people.email})`, list),
          ...notDeleted,
        ),
      );
    // A customer's other emails count too (0103): one probe of the list's index per address.
    const byOther = await tx
      .select({ others: people.otherEmails })
      .from(people)
      .where(
        and(
          eq(people.workspaceId, scope.workspaceId),
          ...notDeleted,
          or(
            ...list.map(
              (a) =>
                dsql`${people.otherEmails} @> ${JSON.stringify([{ email: a.toLowerCase() }])}::jsonb`,
            ),
          ),
        ),
      );
    const others = byOther
      .flatMap((r) => otherEmailsOf(r.others).map((e) => ({ address: e.email })))
      .filter((r) => list.some((a) => a.toLowerCase() === r.address));
    const byThread = await tx
      .select({ address: conversations.counterpart })
      .from(conversations)
      .where(
        and(
          eq(conversations.workspaceId, scope.workspaceId),
          eq(conversations.channel, 'email'),
          inArray(conversations.counterpart, list),
        ),
      );
    return new Set([...byPerson, ...others, ...byThread].map((r) => r.address));
  });
}

const safeName = (name: string): string =>
  name
    .replace(/[\\/:*?"<>|\r\n]+/g, '_')
    .trim()
    .slice(0, 120) || 'attachment';

/**
 * Files one email with a customer: attachments to storage, the body sanitized, then `email.receive`. Indeed telling
 * the business somebody applied is read first, though it's from nobody the business knows (email/indeed.ts).
 */
async function fileEmail(ctx: JobContext, scope: TenantScope, m: Connection, e: SyncedEmail) {
  if (e.direction === 'inbound')
    await fileIndeedApplicant(ctx, scope, {
      from: e.from,
      subject: e.subject,
      text: e.text?.trim() || (e.html ? htmlToText(e.html) : '') || null,
      key: e.messageIdHeader ?? `${m.provider}:${e.providerMessageId}`,
      occurredAt: e.occurredAt,
      ours: m.accountEmail ? [m.accountEmail] : [],
    });
  if (e.automatic) return;
  const others = (e.direction === 'inbound' ? [e.from] : [...e.to, ...e.cc])
    .map((p) => p.address)
    .filter((a) => a !== m.accountEmail);
  if ((await knownCustomers(ctx.db, scope, others)).size === 0) return;
  const media: {
    bucket: string;
    objectPath: string;
    contentType: string;
    sizeBytes: number;
    name: string;
  }[] = [];
  const cids = new Map<string, number>();
  if (e.hasAttachments) {
    const folder = sha256Hex(`${m.id}:${e.providerMessageId}`).slice(0, 24);
    for (const [i, file] of (await e.attachments()).slice(0, 20).entries()) {
      const name = safeName(file.name);
      const objectPath = `${scope.workspaceId}/email/${folder}/${i}-${name}`;
      await ctx.store.upload('telephony', objectPath, file.content, file.contentType, {
        upsert: true,
      });
      if (file.contentId) cids.set(file.contentId, media.length);
      media.push({
        bucket: 'telephony',
        objectPath,
        contentType: file.contentType,
        sizeBytes: file.content.length,
        name,
      });
    }
  }
  const text = e.text?.trim() || (e.html ? htmlToText(e.html) : '');
  await executeCommand(
    ctx.db,
    emailReceive,
    {
      workspaceId: scope.workspaceId,
      provider: m.provider,
      providerMessageId: e.providerMessageId.slice(0, 300),
      direction: e.direction,
      messageIdHeader: e.messageIdHeader?.slice(0, 998) ?? null,
      inReplyTo: e.inReplyTo?.slice(0, 998) ?? null,
      references: e.references.slice(-50).map((r) => r.slice(0, 998)),
      from: e.from,
      to: [...e.to],
      cc: [...e.cc],
      subject: e.subject?.slice(0, 998) || null,
      bodyText: text.slice(0, 100_000) || null,
      bodyHtml: e.html ? sanitizeInboundHtml(e.html, cids).slice(0, 1_000_000) : null,
      media,
      mailboxConnectionId: m.id,
      providerThreadId: e.threadId?.slice(0, 300) ?? null,
      occurredAt: e.occurredAt,
      knownOnly: true,
      ...(ctx.reminderOverrideMs ? { reminderAfterMs: ctx.reminderOverrideMs } : {}),
    },
    systemActor(scope),
    workerMeta(),
  );
}

/** Outlook's change notifications: made, renewed a day ahead, remade when Graph dropped them. */
async function keepSubscribed(
  ctx: JobContext,
  scope: TenantScope,
  m: Connection,
  provider: MailboxProvider,
  call: <T>(fn: (accessToken: string) => Promise<T>) => Promise<T>,
): Promise<void> {
  const n = provider.notifications;
  if (!n) return;
  const expires = m.subscriptionExpiresAt?.getTime() ?? 0;
  if (expires - Date.now() > RENEW_AHEAD_MS) return;
  const save = (set: Partial<typeof mailboxConnections.$inferInsert>) =>
    asWorker(ctx.db, scope, (tx) =>
      tx.update(mailboxConnections).set(set).where(eq(mailboxConnections.id, m.id)),
    );
  const until = new Date(Date.now() + SUBSCRIPTION_MS);
  if (m.subscriptionId && expires > Date.now()) {
    try {
      const s = await call((t) => n.renew(t, m.subscriptionId!, until));
      await save({ subscriptionExpiresAt: new Date(s.expiresAt) });
      return;
    } catch (e) {
      if (e instanceof MailboxAuthError) throw e;
      // Gone or refused: make a new one.
    }
  }
  const clientState = randomBytes(24).toString('base64url');
  try {
    const s = await call((t) =>
      n.subscribe(t, {
        notificationUrl: `${ctx.publicUrl}/webhooks/graph/notifications`,
        lifecycleUrl: `${ctx.publicUrl}/webhooks/graph/lifecycle`,
        clientState,
        expiresAt: until,
      }),
    );
    await save({
      subscriptionId: s.id,
      subscriptionExpiresAt: new Date(s.expiresAt),
      subscriptionClientStateHash: sha256Hex(clientState),
    });
  } catch (e) {
    if (e instanceof MailboxAuthError) throw e;
    // Notifications only speed things up: the regular sync still runs. Graph must reach our public URL,
    // which a local worker without a tunnel can't offer, so wait a while before asking again.
    ctx.log.warn({ connectionId: m.id, err: errorMessage(e) }, 'no Outlook notifications for now');
    await save({
      subscriptionId: null,
      subscriptionExpiresAt: new Date(Date.now() + RENEW_AHEAD_MS + SUBSCRIBE_RETRY_MS),
    });
  }
}

export const mailboxSync: JobHandler = async (ctx) => {
  const scope = tenantOf(ctx.scope);
  const connectionId = String(ctx.job.payload['connectionId'] ?? '');
  const [m] = await asWorker(ctx.db, scope, (tx) =>
    tx.select().from(mailboxConnections).where(eq(mailboxConnections.id, connectionId)),
  );
  // Disconnected, waiting on a reconnect, or never signed in: nothing to do until that changes.
  if (!m || (m.status !== 'active' && m.status !== 'error') || !m.tokenEnc) return;
  const provider = ctx.mailboxes.providers[m.provider];
  const every = ctx.mailboxes.syncEveryMs[m.provider];
  const state = (m.syncCursor ?? {}) as SyncState;
  // Where this run has got to, and the failures in a row before it: a page filed starts the count over.
  let cursor: Record<string, unknown> = state.provider ?? {};
  let failuresBefore = state.failures ?? 0;
  try {
    let tokens = await freshTokens(ctx, scope, m, provider);
    const call = async <T>(fn: (accessToken: string) => Promise<T>): Promise<T> => {
      try {
        return await fn(tokens.accessToken);
      } catch (e) {
        // A token that stopped working early: renew it once and try again.
        if (!(e instanceof MailboxError && e.status === 401)) throw e;
        tokens = await freshTokens(ctx, scope, m, provider, true);
        return fn(tokens.accessToken);
      }
    };
    await keepSubscribed(ctx, scope, m, provider, call);
    const since = new Date(
      (m.connectedAt ?? new Date()).getTime() - ctx.mailboxes.backfillDays * 86_400_000,
    );
    let more = false;
    for (let pages = 0; pages < MAX_PAGES; pages++) {
      const page = await call((t) => provider.sync(t, cursor, since));
      for (const e of page.emails) await fileEmail(ctx, scope, m, e);
      cursor = { ...page.cursor };
      more = page.more;
      // The cursor moves only after the page is filed, so a crash replays it (replays land on existing rows).
      await asWorker(ctx.db, scope, (tx) =>
        tx
          .update(mailboxConnections)
          .set({
            syncCursor: { provider: cursor, failures: 0 },
            lastSyncedAt: new Date(),
            lastError: null,
            ...(m.status === 'error' ? { status: 'active' as const } : {}),
          })
          .where(eq(mailboxConnections.id, m.id)),
      );
      failuresBefore = 0;
      if (!more) break;
    }
    return { rescheduleAt: new Date(Date.now() + (more ? 1_000 : every)) };
  } catch (e) {
    if (e instanceof MailboxAuthError) {
      await failMailbox(
        ctx.db,
        scope,
        m,
        'reauth_required',
        `${PROVIDER_NAME[m.provider]} stopped accepting HandsFreeOS’s sign-in for ${m.accountEmail ?? 'this mailbox'}.`,
      );
      return;
    }
    const failures = failuresBefore + 1;
    const message = errorMessage(e);
    ctx.log.warn({ connectionId: m.id, failures, err: message }, 'mailbox sync failed');
    // Keep the pages already filed: the next try carries on from there instead of starting over.
    await asWorker(ctx.db, scope, (tx) =>
      tx
        .update(mailboxConnections)
        .set({ syncCursor: { provider: cursor, failures }, lastError: message.slice(0, 2000) })
        .where(eq(mailboxConnections.id, m.id)),
    );
    if (failures >= FAILURES_BEFORE_ERROR) await failMailbox(ctx.db, scope, m, 'error', message);
    const wait =
      e instanceof MailboxError && e.retryAfterMs
        ? e.retryAfterMs
        : Math.min(30 * 60_000, every * 2 ** Math.min(failures, 5));
    return { rescheduleAt: new Date(Date.now() + wait) };
  }
};
