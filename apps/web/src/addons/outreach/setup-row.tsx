'use client';
/**
 * Set up in the side menu (docs/outreach.md, decision 129): first among Social Outreach's pages, with how many steps are
 * done ("6 of 9"), while anything's left and the reminder isn't hidden (`setUpInMenu`); then gone, and Settings → You
 * opens it. Every row drawn shares one answer for the business, asked again when the setup changes, and when the menu
 * is drawn again after half a minute.
 */
import {
  SET_UP_PAGE_WORDS as U,
  setUpInMenu,
  setupDoneOf,
} from '@hfos/core/addons/outreach/set-up-page';
import { useEffect, useSyncExternalStore } from 'react';
import type { NavRowProps } from '@/addons/registry';
import { useLiveVersion } from '@/lib/realtime/live-provider';
import { getSetup, laidOut } from './setup-api';

/** How long an answer had is used without asking again, when nothing changed. */
const FRESH_MS = 30_000;

interface Had {
  /** Shown in the menu, with how far it's come. */
  readonly shown: { readonly done: number; readonly of: number } | null;
  readonly at: number;
}

/** Each business's answer, and when it was had. */
const had = new Map<string, Had>();
const asking = new Set<string>();
const listeners = new Set<() => void>();

function ask(workspaceId: string) {
  if (asking.has(workspaceId)) return;
  asking.add(workspaceId);
  void getSetup(workspaceId)
    .then((setup) => {
      had.set(workspaceId, {
        shown: setUpInMenu(setup) ? setupDoneOf(laidOut(setup)) : null,
        at: Date.now(),
      });
      for (const listener of listeners) listener();
    })
    // Not had (offline, or the add-on just turned off): the row stays as it was.
    .catch(() => undefined)
    .finally(() => asking.delete(workspaceId));
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export default function OutreachSetupRow({ workspaceId, lit, row }: NavRowProps) {
  // What the setup's steps are worked out from (./setup-view.tsx's banner).
  const changed = useLiveVersion(
    ['outreach_setup', 'outreach_automation', 'outreach_playbook', 'outreach_day', 'main_offer'],
    1500,
  );
  const got = useSyncExternalStore(
    subscribe,
    () => had.get(workspaceId),
    () => undefined,
  );
  useEffect(() => {
    const last = had.get(workspaceId);
    if (changed === 0 && last && Date.now() - last.at < FRESH_MS) return;
    ask(workspaceId);
  }, [workspaceId, changed]);
  const shown = got?.shown ?? null;
  if (!shown) return lit ? row() : null;
  return row(
    <span
      className="text-[12px] font-normal tabular-nums text-text-3"
      data-testid="addon-menu-setup"
    >
      <span aria-hidden>{U.menuCount(shown.done, shown.of)}</span>
      <span className="sr-only">{U.menuCountLabel(shown.done, shown.of)}</span>
    </span>,
  );
}
