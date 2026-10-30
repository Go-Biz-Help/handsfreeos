'use client';
/**
 * The count on Needs you in the side menu (docs/outreach.md, decision 127), and on Social Outreach's row while its
 * pages are closed: how many things wait for the person (`outreach.waiting`, counted only). Every count drawn shares
 * one number for the business, asked again when something that waits changes, and when the menu is drawn again after
 * half a minute.
 */
import { waitingWords } from '@hfos/core/addons/outreach/waiting-words';
import { useEffect, useSyncExternalStore } from 'react';
import { MenuCount } from '@/components/shell/nav-links';
import { apiBrowser, unwrap } from '@/lib/api/client';
import { useLiveVersion } from '@/lib/realtime/live-provider';

/** How long a number had is shown without asking again, when nothing changed. */
const FRESH_MS = 30_000;

/** Each business's number, and when it was had. */
const had = new Map<string, { readonly count: number; readonly at: number }>();
const asking = new Set<string>();
const listeners = new Set<() => void>();

function ask(workspaceId: string) {
  if (asking.has(workspaceId)) return;
  asking.add(workspaceId);
  void apiBrowser()
    .POST('/v1/queries/outreach.waiting', { body: { workspaceId, items: false } })
    .then(unwrap)
    .then((waiting) => {
      had.set(workspaceId, { count: waiting.count, at: Date.now() });
      for (const listener of listeners) listener();
    })
    // Not had (offline, or the add-on just turned off): the number shown stays.
    .catch(() => undefined)
    .finally(() => asking.delete(workspaceId));
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export default function OutreachMenuCount({ workspaceId }: { workspaceId: string }) {
  // What Needs you follows (./waiting-view.tsx).
  const changed = useLiveVersion(
    ['outreach_profile', 'outreach_need', 'outreach_ask', 'outreach_automation', 'addon'],
    1500,
  );
  const count = useSyncExternalStore(
    subscribe,
    () => had.get(workspaceId)?.count ?? 0,
    () => 0,
  );
  useEffect(() => {
    const last = had.get(workspaceId);
    if (changed === 0 && last && Date.now() - last.at < FRESH_MS) return;
    ask(workspaceId);
  }, [workspaceId, changed]);
  return <MenuCount count={count} label={waitingWords(count)} />;
}
