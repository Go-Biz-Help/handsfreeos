import { NO_SUCH_ROUTE, VIEW_AS_HEADER } from '@hfos/core';

import { api, ApiError, unwrap } from '@/lib/api';

import { currentView, dropView, keepView, type PhoneView } from './state';

/** Asks HandsFreeOS, through the view, what the teammate sees of the business. */
async function lensFor(workspaceId: string, viewId: string) {
  return unwrap(
    await api.POST('/v1/queries/teammate_view.lens', {
      body: { workspaceId },
      headers: { [VIEW_AS_HEADER]: viewId },
    }),
  );
}

/**
 * Starts viewing the business as a teammate (needs signal): HandsFreeOS decides whether this person may, and says why
 * not; then the phone keeps the view and what the teammate sees, and the business's screens follow it.
 */
export async function startView(
  viewerId: string,
  workspaceId: string,
  userId: string,
): Promise<PhoneView> {
  const { view } = unwrap(
    await api.POST('/v1/commands/teammate_view.start', { body: { workspaceId, userId } }),
  );
  const lens = await lensFor(workspaceId, view.id);
  const kept: PhoneView = {
    viewerId,
    workspaceId,
    viewId: view.id,
    by: view.by,
    person: lens.person,
    conversationIds: lens.conversationIds,
    attentionItemIds: lens.attentionItemIds,
    estimateIds: lens.estimateIds,
    invoiceIds: lens.invoiceIds,
    fetchedAt: Date.now(),
  };
  keepView(kept);
  return kept;
}

/**
 * Brings what the teammate sees up to date when there's signal. A view that has ended elsewhere, or that this person
 * may no longer see through, is dropped here too: `ended` says so.
 */
export async function refreshView(view: PhoneView): Promise<'kept' | 'ended'> {
  try {
    const lens = await lensFor(view.workspaceId, view.viewId);
    if (currentView()?.viewId !== view.viewId) return 'kept';
    keepView({
      ...view,
      person: lens.person,
      conversationIds: lens.conversationIds,
      attentionItemIds: lens.attentionItemIds,
      estimateIds: lens.estimateIds,
      invoiceIds: lens.invoiceIds,
      fetchedAt: Date.now(),
    });
    return 'kept';
  } catch (e) {
    // Read as the viewer again: the view no longer holds. Anything else (no signal) keeps it as it is.
    if (
      e instanceof ApiError &&
      e.status === 404 &&
      e.rule !== NO_SUCH_ROUTE &&
      currentView()?.viewId === view.viewId
    ) {
      dropView();
      return 'ended';
    }
    return 'kept';
  }
}

/** Stops viewing. The phone stops at once, signal or not; HandsFreeOS hears when it can. */
export async function stopView(view: PhoneView): Promise<void> {
  dropView();
  try {
    await api.POST('/v1/commands/teammate_view.end', { body: { viewId: view.viewId } });
  } catch {
    // No signal: the view no longer names any request from this phone, which is what stopping is.
  }
}
