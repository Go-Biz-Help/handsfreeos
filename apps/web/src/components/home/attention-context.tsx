'use client';
import { createContext, useContext } from 'react';
import type { AttentionItem } from '@/lib/api/types';

/** Someone an item can be assigned to. */
export interface MemberOption {
  readonly id: string;
  readonly fullName: string;
  readonly role: 'owner' | 'admin' | 'member';
}

/** What a scheduled automatic action is, for Cancel and its toast. */
export interface AutoRef {
  readonly itemId: string;
  /** The customer's name, for "Olivia won't get a confirmation request". */
  readonly name: string | null;
  readonly action: 'confirm_request' | 'nudge' | null;
}

/** Everything a card can do. The Action Center owns the dialogs, the toasts and the reloads. */
export interface ItemActions {
  /** The main button: call, reply, set a next action, ask to confirm, approve, open the task. */
  handle(item: AttentionItem): void;
  /** Opens the dialer for the item's customer. */
  call(item: AttentionItem): void;
  /** Opens the Let HandsFreeOS Handle sheet. */
  letHandle(item: AttentionItem): void;
  snooze(item: AttentionItem, until: number): void;
  /** Opens "Snooze until" with a day and a time. */
  pickTime(item: AttentionItem): void;
  /** Opens "Dismiss this?". */
  dismiss(item: AttentionItem): void;
  dismissNow(item: AttentionItem, reason: string | null): void;
  assign(item: AttentionItem, userId: string | null): void;
  cancelAuto(ref: AutoRef): void;
  /** An add-on's alert that asks for it: "I've seen this". */
  acknowledge(item: AttentionItem): void;
  /** On a phone, ⋯ opens a bottom sheet. */
  more(item: AttentionItem): void;
}

export interface AttentionEnv {
  readonly workspaceId: string;
  readonly timeZone: string;
  /** The moment the chips are worded for (ticks every 30 seconds). */
  readonly now: number;
  readonly myUserId: string;
  readonly members: readonly MemberOption[];
  /** The business's AI teammate ("Ava"), or null. */
  readonly teammateName: string | null;
  /** Browser calling works here. */
  readonly callsAvailable: boolean;
  /** Items with a command running. */
  readonly busy: ReadonlySet<string>;
  /** The card the Assistant linked to (`?item=`), marked for a moment. */
  readonly highlightId: string | null;
  readonly act: ItemActions;
}

const AttentionEnvContext = createContext<AttentionEnv | null>(null);

export const AttentionEnvProvider = AttentionEnvContext.Provider;

export function useAttentionEnv(): AttentionEnv {
  const env = useContext(AttentionEnvContext);
  if (!env) throw new Error('useAttentionEnv is for the Action Center');
  return env;
}
