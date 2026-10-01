import { VIEW_AS_WORDS, type TeammateViewBy, type TeammateViewLens } from '@hfos/core';
import * as React from 'react';

import { session } from '@/lib/auth';
import { deviceStore } from '@/lib/device-store';

/**
 * Viewing the app as a teammate on this phone (20261018000100). One view at a time, kept on the phone so the banner and
 * the teammate's view of the copy outlast the app closing. Every request through `api` names it (`x-hfos-view-as`), so
 * what the phone asks HandsFreeOS is answered as the teammate; what it reads from its own copy it shows through the lens
 * the API gave; and no change is made in that business until it stops (`viewRefusal`, asked by the queue of changes).
 */
export interface PhoneView {
  /** Who is looking: the person signed in when it started. Anyone else signed in on the phone isn't in it. */
  readonly viewerId: string;
  readonly workspaceId: string;
  readonly viewId: string;
  readonly by: TeammateViewBy;
  /** The teammate: their role and what they may do, which the screens follow while the view lasts. */
  readonly person: TeammateViewLens['person'];
  /** What they see where it's fewer than the copy holds; null where they see all of it. */
  readonly conversationIds: readonly string[] | null;
  readonly attentionItemIds: readonly string[] | null;
  readonly estimateIds: readonly string[] | null;
  readonly invoiceIds: readonly string[] | null;
  readonly fetchedAt: number;
}

const KEY = 'teammateView';

/** The view open on this phone for whoever is signed in, or null. */
export function currentView(): PhoneView | null {
  const view = deviceStore.get<PhoneView>(KEY) ?? null;
  if (!view) return null;
  const state = session.getState();
  return state.status === 'signedIn' && state.person.userId === view.viewerId ? view : null;
}

export function keepView(view: PhoneView): void {
  deviceStore.set(KEY, view);
}

export function dropView(): void {
  deviceStore.remove(KEY);
}

/** The view open in this business for this person, or null; follows starting and stopping one. */
export function useView(viewerId: string, workspaceId: string): PhoneView | null {
  const view = React.useSyncExternalStore(deviceStore.subscribe, readKept, readKept);
  return view && view.viewerId === viewerId && view.workspaceId === workspaceId ? view : null;
}

const readKept = (): PhoneView | null => deviceStore.get<PhoneView>(KEY) ?? null;

/** Why a change for this input can't be made: it's for the business being viewed as someone. Null otherwise. */
export function viewRefusal(input: unknown): string | null {
  const view = currentView();
  const workspaceId =
    input && typeof input === 'object' ? (input as { workspaceId?: unknown }).workspaceId : null;
  return view && workspaceId === view.workspaceId ? VIEW_AS_WORDS.readOnly(view.person) : null;
}

/** What the teammate sees of the copy, as sets: null where they see all of it. */
export interface Lens {
  readonly conversations: ReadonlySet<string> | null;
  readonly attention: ReadonlySet<string> | null;
  readonly estimates: ReadonlySet<string> | null;
  readonly invoices: ReadonlySet<string> | null;
}

export function lensOf(view: PhoneView | null | undefined): Lens | null {
  if (!view) return null;
  const set = (ids: readonly string[] | null) => (ids ? new Set(ids) : null);
  return {
    conversations: set(view.conversationIds),
    attention: set(view.attentionItemIds),
    estimates: set(view.estimateIds),
    invoices: set(view.invoiceIds),
  };
}

/** Whether the teammate sees this: always outside a view, and wherever the view doesn't list what they see. */
export function sees(
  list: ReadonlySet<string> | null | undefined,
  id: string | null | undefined,
): boolean {
  return !list || (!!id && list.has(id));
}

/** Whether the teammate sees this thread: listed for them, and never somebody else's own mail (M19). */
export function seesThread(
  lens: Lens | null,
  row: { readonly id: string; readonly private_to?: string | null },
  personId: string,
): boolean {
  if (!lens) return true;
  return sees(lens.conversations, row.id) && (!row.private_to || row.private_to === personId);
}
