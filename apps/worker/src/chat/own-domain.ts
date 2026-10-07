import { chatWidgetUpdate, executeCommandIn, normalizeChatOrigins } from '@hfos/core/server';
import { chatWidgets } from '@hfos/db/schema';
import { eq } from 'drizzle-orm';
import type { EventHandler } from '../handlers/types';
import { systemActor, tenantOf, workerMeta } from '../services';

/**
 * A website chat on the business's pages here follows them to its own domain (M17, and the simple page:
 * HANDSFREEOS_ONBOARDING_QUICK_SETUP_IMPLEMENTATION_PLAN.md §4).
 *
 * A business with no website gets its chat on its simple page, so the chat lists our own address. Once its own
 * domain is serving, the same page opens there too (its start page), and the chat window only shows on the sites
 * its chat lists. So on `branded_domain.status_changed` with the domain now serving, each chat listing our address
 * gets the domain added, and the page's Chat button works on either name. Nothing is taken off when a domain stops
 * serving: that address simply stops opening. A chat already at its limit of sites (MAX_CHAT_ORIGINS) is left as it is.
 */
export const onDomainServing: EventHandler = async (ctx) => {
  const payload = (ctx.event.payload ?? {}) as { domain?: unknown; serving?: unknown };
  if (payload.serving !== true || typeof payload.domain !== 'string' || !payload.domain) return;
  const scope = tenantOf(ctx.scope);
  const ours = new URL(ctx.webUrl).origin;
  const domain = `https://${payload.domain.toLowerCase()}`;
  const chats = await ctx.tx
    .select({ id: chatWidgets.id, origins: chatWidgets.allowedOrigins })
    .from(chatWidgets)
    .where(eq(chatWidgets.workspaceId, scope.workspaceId));
  for (const chat of chats) {
    if (!chat.origins.includes(ours) || chat.origins.includes(domain)) continue;
    // Refused past MAX_CHAT_ORIGINS, counting the www twin a bare domain brings.
    const next = normalizeChatOrigins([...chat.origins, domain]);
    if (next.issues.length) continue;
    await executeCommandIn(
      ctx.tx,
      chatWidgetUpdate,
      { workspaceId: scope.workspaceId, widgetId: chat.id, allowedOrigins: next.origins },
      systemActor(scope),
      workerMeta(ctx.event.correlationId, ctx.event.id),
    );
  }
};
