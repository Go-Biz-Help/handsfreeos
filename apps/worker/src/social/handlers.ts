/**
 * What the worker does when something changes with Facebook and Instagram (20261025000200).
 */
import { rows, sql } from '@hfos/db/client';
import { metaAccounts } from '@hfos/db/schema';
import { and, eq } from 'drizzle-orm';
import type { EventHandler } from '../handlers/types';
import { errorMessage } from '../outbox';
import { tenantOf } from '../services';
import { loadMetaAccount } from './accounts';
import { MetaError } from './graph';

/**
 * A Page or Instagram account let go here: Meta is asked to stop sending its Page's messages, once no business
 * answers through that Page any more (its Instagram account may still be), and the token kept for that goes.
 */
export const onMetaAccountDisconnected: EventHandler = async (ctx) => {
  const id = ctx.event.entityId;
  if (!id) return;
  const scope = tenantOf(ctx.scope);
  const loaded = await loadMetaAccount(ctx.tx, ctx.sealer, scope.workspaceId, id);
  // Connected again since: it answers here, token and all.
  if (!loaded || loaded.account.status !== 'disconnected') return;
  const { account, pageToken } = loaded;
  const [page] = await rows<{ live: boolean }>(
    ctx.tx,
    sql`select private.meta_page_live(${account.pageId}) as live`,
  );
  if (pageToken && !page?.live)
    try {
      await ctx.social.graph.unsubscribe(account.pageId, pageToken);
    } catch (e) {
      if (e instanceof MetaError && e.retryable && ctx.attempt < ctx.maxAttempts) throw e;
      // A token that stopped working (the app was removed on Facebook) has no subscription left to end.
      ctx.log.info(
        { accountId: account.id, err: errorMessage(e) },
        'Meta wasn’t asked to stop sending a Page’s messages',
      );
    }
  await ctx.tx
    .update(metaAccounts)
    .set({ tokenEnc: null, tokenKeyId: null })
    .where(and(eq(metaAccounts.id, account.id), eq(metaAccounts.status, 'disconnected')));
};

/** A message the customer took back on Messenger or Instagram: the copies of its files go too, as Meta asks. */
export const onMessageEdited: EventHandler = async (ctx) => {
  const p = ctx.event.payload as { unsent?: boolean; mediaPaths?: unknown };
  if (!p.unsent || !Array.isArray(p.mediaPaths)) return;
  const scope = tenantOf(ctx.scope);
  for (const path of p.mediaPaths)
    if (typeof path === 'string' && path.startsWith(`${scope.workspaceId}/`))
      await ctx.store.remove('telephony', path);
};
