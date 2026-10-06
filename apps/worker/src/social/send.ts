/**
 * A Messenger or Instagram reply going out (20261025000200). message.send queues it like a text; this sends it
 * through the business's Page, its photos and files first, each a message of its own, then its words.
 *
 * Meta's window is looked at again as it goes, since a queued reply can wait: within a day of the customer's last
 * message anybody may answer; after that, up to seven days, only a person, with the Human Agent tag Meta approves
 * for the app. A Page whose sign-in stopped working is marked so as the reply fails, and its owners hear once.
 *
 * A part that went can't be taken back. So when one fails after others went, the reply keeps the ids of the parts
 * that went and says only part of it reached them, and sending it again (message.retry) sends only the rest.
 */
import {
  accountUnavailable,
  executeCommand,
  messageUpdateStatus,
  metaAccountFail,
  SOCIAL_CHANNEL_NAMES,
  socialAttachmentKind,
  socialCounterpartParts,
  socialFailureHelp,
  socialReplyWindow,
  type SocialChannel,
} from '@hfos/core/server';
import { conversations, type messages } from '@hfos/db/schema';
import { eq } from 'drizzle-orm';
import type { HandlerContext } from '../handlers/types';
import { errorMessage } from '../outbox';
import { systemActor, tenantOf, workerMeta } from '../services';
import { loadMetaAccount } from './accounts';
import { MetaError, type MetaOutbound } from './graph';

type MessageRow = typeof messages.$inferSelect;

/** How long Meta has to fetch a photo or file from us: it does so as the part is sent. */
const FILE_LINK_SECONDS = 3600;

/** What went wrong, as the message keeps it: the words come from socialFailureHelp in core. */
type FailureCode =
  | 'window_closed'
  | 'human_agent'
  | 'account'
  | 'unavailable'
  | 'rate_limit'
  | 'attachment'
  | 'too_long'
  | 'partial'
  | 'unreachable'
  | 'refused';

/** A part of the reply, made into what Meta takes only when it's its turn. */
type Part = { readonly file: MessageRow['media'][number] } | { readonly text: string };

export async function sendSocialReply(ctx: HandlerContext, m: MessageRow): Promise<void> {
  const scope = tenantOf(ctx.scope);
  const channel = m.channel as SocialChannel;
  const metaOf = workerMeta(ctx.event.correlationId, ctx.event.id);
  // The parts an earlier try sent, in order: these don't go again.
  const before = [...m.providerPartIds];
  const went: string[] = [];

  const record = (
    status: 'sent' | 'failed',
    error: { code: FailureCode; message: string } | null,
  ) => {
    const parts = [...before, ...went];
    return executeCommand(
      ctx.db,
      messageUpdateStatus,
      {
        workspaceId: scope.workspaceId,
        messageId: m.id,
        status,
        ...(parts.length ? { providerMessageId: parts[0]!, providerPartIds: parts } : {}),
        ...(parts.length && m.providerMessageId
          ? { replacesProviderMessageId: m.providerMessageId }
          : {}),
        errorCode: error?.code ?? null,
        errorMessage: error?.message ?? null,
      },
      systemActor(scope),
      metaOf,
    );
  };
  const fail = (code: FailureCode, message?: string) =>
    record('failed', {
      code,
      message: message ?? socialFailureHelp({ errorCode: code, errorMessage: null, channel }),
    });

  const [conv] = await ctx.tx
    .select()
    .from(conversations)
    .where(eq(conversations.id, m.conversationId));
  const loaded = conv?.metaAccountId
    ? await loadMetaAccount(ctx.tx, ctx.sealer, scope.workspaceId, conv.metaAccountId)
    : null;
  const unavailable = accountUnavailable(loaded?.account ?? null);
  if (!conv || !loaded || unavailable || !loaded.pageToken) {
    await fail('account', unavailable ?? undefined);
    return;
  }
  const { account, pageToken } = loaded;
  const who = socialCounterpartParts(conv.counterpart);
  if (!who) {
    await fail('refused');
    return;
  }

  // Anybody within a day; a person, with the Human Agent tag, for six days after.
  const window = socialReplyWindow(conv.lastInboundAt, account.humanAgent);
  const byPerson = ctx.event.actorType === 'human';
  if (!window.open && !(window.peopleOnly && byPerson)) {
    await fail('window_closed');
    return;
  }
  const tag = window.open ? null : ('HUMAN_AGENT' as const);

  const parts: Part[] = [
    ...m.media.map((file) => ({ file })),
    ...(m.bodyText?.trim() ? [{ text: m.bodyText }] : []),
  ];
  if (parts.length === 0) {
    await fail(
      'refused',
      `This reply has nothing in it to send on ${SOCIAL_CHANNEL_NAMES[channel]}.`,
    );
    return;
  }
  const outbound = async (part: Part): Promise<MetaOutbound> => {
    if ('text' in part) return { text: part.text };
    return {
      attachment: {
        type: socialAttachmentKind(channel, part.file.contentType) ?? 'file',
        url: await ctx.store.signedUrl(part.file.bucket, part.file.objectPath, FILE_LINK_SECONDS),
      },
    };
  };

  for (let i = before.length; i < parts.length; i++) {
    try {
      const sent = await ctx.social.graph.send({
        pageId: account.pageId,
        pageToken,
        platform: account.platform,
        recipientId: who.scopedId,
        tag,
        message: await outbound(parts[i]!),
      });
      went.push(sent.messageId);
    } catch (e) {
      await refused(e);
      return;
    }
  }
  await record('sent', null);

  /**
   * What Meta said no with decides what the reply says. Trouble worth another try goes back to the outbox while
   * nothing new went, until its last try; once a part went, another try would send it twice, so the reply stops
   * there and a person sends the rest.
   */
  async function refused(e: unknown): Promise<void> {
    const err = e instanceof MetaError ? e : null;
    ctx.log.warn(
      { err: errorMessage(e), code: err?.code, subcode: err?.subcode, kind: err?.kind },
      'Meta refused a Messenger or Instagram reply',
    );
    const retryable = !err || err.retryable;
    if (retryable && went.length === 0 && ctx.attempt < ctx.maxAttempts) throw e;
    const partly = went.length > 0 || before.length > 0;
    switch (err?.kind) {
      case 'auth':
        // The Page's sign-in stopped working: every reply would fail the same way, so the Page says so.
        await executeCommand(
          ctx.db,
          metaAccountFail,
          {
            workspaceId: scope.workspaceId,
            accountId: account.id,
            problem: 'reauth',
            reason: err.message.slice(0, 2000),
          },
          systemActor(scope),
          metaOf,
        );
        return void (await fail('account'));
      case 'permission':
        return void (await fail('account'));
      case 'window':
        return void (await fail('window_closed'));
      case 'human_agent':
        ctx.log.error(
          'Meta refused the Human Agent tag: META_HUMAN_AGENT is on, but Meta hasn’t approved it for this app',
        );
        return void (await fail('human_agent'));
      case 'unavailable':
      case 'not_found':
        return void (await fail('unavailable'));
      case 'attachment':
        return void (await fail('attachment'));
      case 'too_long':
        return void (await fail('too_long'));
      case 'rate_limit':
        return void (await fail(partly ? 'partial' : 'rate_limit'));
      default:
        return void (await fail(partly ? 'partial' : retryable ? 'unreachable' : 'refused'));
    }
  }
}
