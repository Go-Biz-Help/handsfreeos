/** Email helpers shared by the commands and queries: conversations, the from address, threading, suppressions. */
import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, isNotNull, isNull, or } from 'drizzle-orm';
import type { Tx } from '@hfos/db/client';
import {
  type conversations,
  emailAddresses,
  emailDomains,
  emailSuppressions,
  files,
  mailboxConnections,
  messages,
  people,
  type MediaRef,
} from '@hfos/db/schema';
import { hasEmail, mainEmailFirst } from '../crm/matching';
import { requirePerson } from '../crm/records';
import { HfosError } from '../errors';
import type { CommandContext } from '../kernel/types';
import { findOrCreateConversation, loadConversation, preferredLane } from './store';

/** Mirrors private.shared_mail_domain(). */
export const SHARED_MAIL_DOMAIN = 'mail.handsfreeos.com';
/**
 * A stranger's mail the spam filter scores at this or more goes to Spam (M19). SpamAssassin's own line: 5 is where
 * it calls a message spam.
 */
export const SPAM_SCORE = 5;
/** Postmark takes 10 MB per message, attachments included. */
const EMAIL_ATTACHMENTS_MAX_BYTES = 10 * 1024 * 1024;

type Conversation = typeof conversations.$inferSelect;

/**
 * The customer with this email address: their main one, or one of their others (0103). When several have it, the
 * one whose main address it is, then the most recently touched.
 */
export async function matchPersonByEmail(
  tx: Tx,
  workspaceId: string,
  address: string,
): Promise<string | null> {
  const [p] = await tx
    .select({ id: people.id })
    .from(people)
    .where(
      and(
        eq(people.workspaceId, workspaceId),
        hasEmail(people, address),
        isNull(people.archivedAt),
      ),
    )
    .orderBy(mainEmailFirst(people, address), desc(people.updatedAt))
    .limit(1);
  return p?.id ?? null;
}

/** The address's active suppression (a bounce, a complaint, or stopped by hand), if any. */
export async function activeSuppression(tx: Tx, workspaceId: string, address: string) {
  const [s] = await tx
    .select({
      id: emailSuppressions.id,
      reason: emailSuppressions.reason,
      createdAt: emailSuppressions.createdAt,
    })
    .from(emailSuppressions)
    .where(
      and(
        eq(emailSuppressions.workspaceId, workspaceId),
        eq(emailSuppressions.address, address.toLowerCase()),
        isNull(emailSuppressions.releasedAt),
      ),
    )
    .limit(1);
  return s ?? null;
}

export const suppressionMessage = (reason: string): string =>
  reason === 'spam_complaint'
    ? 'This customer marked an earlier email as spam, so email to them is stopped.'
    : reason === 'hard_bounce'
      ? 'Email to this address bounced, so it’s stopped. Check the address with the customer.'
      : 'Email to this address is stopped. Release it in Settings → Email to send again.';

export interface SendingAddress {
  readonly id: string;
  readonly address: string;
  readonly displayName: string;
  readonly isDefault: boolean;
  /** On the shared subdomain (always usable) rather than a workspace domain. */
  readonly shared: boolean;
  /** Shared, or its domain is verified. */
  readonly usable: boolean;
  readonly domain: string;
}

/** Every address the workspace owns, the default first. */
export async function workspaceAddresses(tx: Tx, workspaceId: string): Promise<SendingAddress[]> {
  const list = await tx
    .select({
      id: emailAddresses.id,
      address: emailAddresses.address,
      displayName: emailAddresses.displayName,
      isDefault: emailAddresses.isDefault,
      domainId: emailAddresses.emailDomainId,
      domainStatus: emailDomains.status,
    })
    .from(emailAddresses)
    .leftJoin(emailDomains, eq(emailDomains.id, emailAddresses.emailDomainId))
    .where(eq(emailAddresses.workspaceId, workspaceId))
    .orderBy(desc(emailAddresses.isDefault), emailAddresses.createdAt);
  return list.map((a) => ({
    id: a.id,
    address: a.address,
    displayName: a.displayName,
    isDefault: a.isDefault,
    shared: !a.domainId,
    usable: !a.domainId || a.domainStatus === 'verified',
    domain: a.address.split('@')[1] ?? SHARED_MAIL_DOMAIN,
  }));
}

/**
 * Where an email goes from: the first usable address among those asked for (the one picked, then the one the
 * conversation used), else the usable default, else the shared-subdomain address (a workspace domain that
 * stopped verifying falls back to it).
 */
export function pickFromAddress(
  list: readonly SendingAddress[],
  wanted: readonly (string | null | undefined)[],
): SendingAddress | null {
  for (const id of wanted) {
    const a = id ? list.find((x) => x.id === id) : undefined;
    if (a?.usable) return a;
  }
  return list.find((a) => a.isDefault && a.usable) ?? list.find((a) => a.shared) ?? null;
}

/** Active mailboxes a person may send through: shared ones and their own. */
export async function sendableMailboxes(tx: Tx, workspaceId: string, userId: string | null) {
  return tx
    .select({
      id: mailboxConnections.id,
      provider: mailboxConnections.provider,
      accountEmail: mailboxConnections.accountEmail,
      displayName: mailboxConnections.displayName,
      userId: mailboxConnections.userId,
      shared: mailboxConnections.shared,
    })
    .from(mailboxConnections)
    .where(
      and(
        eq(mailboxConnections.workspaceId, workspaceId),
        eq(mailboxConnections.status, 'active'),
        userId
          ? or(eq(mailboxConnections.shared, true), eq(mailboxConnections.userId, userId))
          : undefined,
      ),
    );
}

/** The headers that thread a reply under the conversation's latest email, theirs or ours. */
export async function threadHeaders(
  tx: Tx,
  conversationId: string,
): Promise<{ inReplyTo: string | null; references: string[]; subject: string | null }> {
  const [last] = await tx
    .select({
      header: messages.messageIdHeader,
      refs: messages.referencesHeaders,
      subject: messages.subject,
    })
    .from(messages)
    .where(and(eq(messages.conversationId, conversationId), isNotNull(messages.messageIdHeader)))
    .orderBy(desc(messages.occurredAt), desc(messages.id))
    .limit(1);
  if (!last?.header) return { inReplyTo: null, references: [], subject: last?.subject ?? null };
  return {
    inReplyTo: last.header,
    references: [...last.refs.filter((r) => r !== last.header), last.header].slice(-20),
    subject: last.subject,
  };
}

/** "Re: Your quote" (once, however long the thread): core's browser-safe `replySubject`, which the phone uses too. */
export { replySubject } from '../inbox/composer';

/** Our own Message-ID, so the customer's reply points back at this message. */
export const newMessageIdHeader = (domain: string): string => `<${randomUUID()}@${domain}>`;

/** Replays and the mailbox copy of an email we sent land on the same row. */
export const emailDedupeKey = (header: string): string => `email:${header.trim().toLowerCase()}`;

/** What the inbox list shows for an email: the subject, then the first line of the text. */
export function emailPreview(
  subject: string | null | undefined,
  body: string | null | undefined,
  attachments = 0,
): string {
  const firstLine = (body ?? '').split('\n').find((l) => l.trim()) ?? '';
  const text = firstLine.replace(/\s+/g, ' ').trim();
  const line = [subject?.trim(), text].filter(Boolean).join(' · ');
  if (line) return line.slice(0, 280);
  if (attachments > 0) return attachments === 1 ? 'An attachment' : `${attachments} attachments`;
  return 'An email';
}

/** The conversation an email goes to: the one named, the customer's, or the address's. */
export async function resolveEmailConversation(
  ctx: CommandContext,
  input: {
    conversationId?: string | undefined;
    personId?: string | undefined;
    toEmail?: string | undefined;
  },
): Promise<{ conversation: Conversation; created: boolean }> {
  const workspaceId = ctx.scope.workspaceId!;
  if (input.conversationId) {
    const c = await loadConversation(ctx, input.conversationId);
    if (c.channel !== 'email')
      throw HfosError.rule(
        'channel_mismatch',
        400,
        'This conversation is texts. Open the customer’s email to send an email.',
      );
    return { conversation: c, created: false };
  }
  // Which of the business's addresses this belongs to when the caller named no thread (0089): the one this
  // customer last wrote to or was last written from. Null starts a thread with no address yet, which the
  // send below stamps with whatever it goes out from — the same lazy stamping this path has always done.
  // Without it, writing to a customer who already has a support@ thread would open a second one beside it.
  const lane = async (counterpart: string): Promise<string | null> =>
    (await preferredLane(ctx.tx, workspaceId, 'email', counterpart))?.emailAddressId ?? null;
  if (input.personId) {
    const p = await requirePerson(ctx.tx, workspaceId, input.personId);
    const name = [p.firstName, p.lastName].filter(Boolean).join(' ') || 'This customer';
    if (p.archivedAt)
      throw HfosError.rule(
        'person_archived',
        409,
        `${name} is archived. Use Restore customer in the menu on their page, then email them.`,
      );
    if (!p.email)
      throw HfosError.rule(
        'no_email',
        400,
        `${name} has no email address. Add one on their page, then email them.`,
      );
    const counterpart = p.email.toLowerCase();
    return findOrCreateConversation(ctx, {
      channel: 'email',
      counterpart,
      personId: p.id,
      phoneNumberId: null,
      emailAddressId: await lane(counterpart),
    });
  }
  const to = input.toEmail!.toLowerCase();
  return findOrCreateConversation(ctx, {
    channel: 'email',
    counterpart: to,
    personId: await matchPersonByEmail(ctx.tx, workspaceId, to),
    phoneNumberId: null,
    emailAddressId: await lane(to),
  });
}

/** Customer files sent as attachments: finished uploads, 10 MB in all. */
export async function emailAttachments(
  ctx: CommandContext,
  fileIds: readonly string[],
): Promise<MediaRef[]> {
  if (fileIds.length === 0) return [];
  const unique = [...new Set(fileIds)];
  const list = await ctx.tx
    .select()
    .from(files)
    .where(
      and(
        eq(files.workspaceId, ctx.scope.workspaceId!),
        inArray(files.id, unique),
        isNull(files.deletedAt),
      ),
    );
  if (list.length !== unique.length || list.some((f) => f.status !== 'ready')) {
    const say =
      list.length !== unique.length
        ? 'One of the attachments isn’t there anymore. Remove it and attach the file again.'
        : 'An attachment hasn’t finished uploading. Wait for it to finish, then send.';
    throw HfosError.validation([{ path: 'attachmentFileIds', message: say }], say);
  }
  const total = list.reduce((n, f) => n + (f.sizeBytes ?? 0), 0);
  if (total > EMAIL_ATTACHMENTS_MAX_BYTES)
    throw HfosError.rule(
      'attachment_too_large',
      400,
      `These attachments add up to ${(total / (1024 * 1024)).toFixed(1)} MB, and one email can carry 10 MB. Remove some, or send them over more than one email.`,
    );
  const byId = new Map(list.map((f) => [f.id, f]));
  return unique.map((id) => {
    const f = byId.get(id)!;
    return {
      bucket: f.bucket,
      objectPath: f.objectPath,
      contentType: f.mimeType ?? 'application/octet-stream',
      sizeBytes: f.sizeBytes ?? 0,
      name: f.name,
      fileId: f.id,
    };
  });
}
