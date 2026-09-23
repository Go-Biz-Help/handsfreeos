import {
  attentionToday,
  type AttentionScope,
  type SyncedApproval,
  type SyncedAttentionRow,
  type SyncedHintRows,
} from '@hfos/core';
import { useQuery } from '@powersync/react-native';
import * as React from 'react';

import { decisionStands, useDraftDecisions } from '@/components/drafts';
import { useBusiness } from '@/components/shell/business-context';
import type { OutboxRow } from '@/changes/outbox';
import { SENT_SHOWN_MS } from '@/changes/rules';
import { api } from '@/lib/api';
import { useGrants } from '@/lib/grants';
import { useNetwork } from '@/lib/network';

import { buildHome, type HomeList } from './build';
import {
  ADDRESSES_SQL,
  APPROVAL_OUTBOX_SQL,
  APPROVALS_SQL,
  ATTENTION_SQL,
  CONVERSATIONS_SQL,
  HOME_OUTBOX_SQL,
  MEMBERS_SQL,
  NUMBERS_SQL,
  OPT_OUTS_SQL,
  PEOPLE_SQL,
  SEATS_SQL,
  SUPPRESSIONS_SQL,
  TEAMMATE_SQL,
  USERS_SQL,
  WORKSPACE_SQL,
} from './queries';

/** How often Home is worked out again, so the ranking and the waiting chips stay current (the web's 30 seconds). */
export const TICK_MS = 30_000;

/** Now, moved on every `everyMs`. */
export function useNow(everyMs = TICK_MS): number {
  const [now, setNow] = React.useState(Date.now());
  React.useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(timer);
  }, [everyMs]);
  return now;
}

/** The business's settings and time zone, from its synced row. */
export function useWorkspaceRow(): { settings: string | null; timezone: string | null } {
  const { business } = useBusiness();
  const { data } = useQuery<{ settings: string | null; timezone: string | null }>(WORKSPACE_SQL, [
    business.id,
  ]);
  return data[0] ?? { settings: null, timezone: business.timezone };
}

export interface Member {
  readonly id: string;
  readonly fullName: string;
  readonly role: 'owner' | 'admin' | 'member';
}

/** Who an item can be assigned to. */
export function useMembers(): readonly Member[] {
  const { business } = useBusiness();
  const { data } = useQuery<{
    id: string;
    full_name: string | null;
    email: string | null;
    role: string;
  }>(MEMBERS_SQL, [business.id]);
  return React.useMemo(
    () =>
      data.map((m) => ({
        id: m.id,
        fullName: m.full_name || m.email || 'Someone',
        role: m.role === 'owner' || m.role === 'admin' ? m.role : 'member',
      })),
    [data],
  );
}

/** The business's AI teammate's name, or null when it has none. */
export function useTeammateName(): string | null {
  const { business } = useBusiness();
  const { data } = useQuery<{ name: string | null }>(TEAMMATE_SQL, [business.id]);
  return data[0]?.name ?? null;
}

/** Workflow approvals decided on this phone, by approval id: every one not through, and those sent just now. */
export function useApprovalDecisions(): readonly OutboxRow[] {
  const { business } = useBusiness();
  const since = React.useMemo(() => new Date(Date.now() - SENT_SHOWN_MS).toISOString(), []);
  const { data } = useQuery<OutboxRow>(APPROVAL_OUTBOX_SQL, [business.id, since]);
  return data;
}

/** The approval a workflow decision is about. */
export function approvalIdOf(row: OutboxRow): string | null {
  try {
    const input = JSON.parse(row.input) as { approvalId?: unknown };
    return typeof input.approvalId === 'string' ? input.approvalId : null;
  } catch {
    return null;
  }
}

/** Every approval and draft a decision on this phone stands in for (anything but a refusal). */
export function useDecidedHere(): ReadonlySet<string> {
  const { business } = useBusiness();
  const drafts = useDraftDecisions(business.id);
  const flows = useApprovalDecisions();
  return React.useMemo(() => {
    const out = new Set<string>();
    for (const [id, d] of drafts) if (decisionStands(d)) out.add(id);
    for (const row of flows) {
      const id = approvalIdOf(row);
      if (id && row.state !== 'refused') out.add(id);
    }
    return out;
  }, [drafts, flows]);
}

/**
 * Home for the business on screen: its Action Center items ranked for Mine or Everyone at `now`, with this phone's
 * changes over them, the hints each card needs, and the counts, all from the phone's copy.
 */
export function useHome(
  scope: AttentionScope | null,
  now: number,
): HomeList & { loading: boolean } {
  const { business, userId } = useBusiness();
  const who = useGrants();
  const ws = business.id;
  const since = React.useMemo(() => new Date(Date.now() - SENT_SHOWN_MS).toISOString(), []);
  const items = useQuery<SyncedAttentionRow>(ATTENTION_SQL, [ws]);
  const approvals = useQuery<SyncedApproval>(APPROVALS_SQL, [ws, ws]);
  const users = useQuery<{ id: string; full_name: string | null; email: string | null }>(USERS_SQL);
  const outbox = useQuery<OutboxRow>(HOME_OUTBOX_SQL, [ws, since]);
  const seats = useQuery<SyncedHintRows['seats'][number]>(SEATS_SQL, [ws, ws]);
  const people = useQuery<SyncedHintRows['people'][number]>(PEOPLE_SQL, [ws, ws]);
  const conversations = useQuery<SyncedHintRows['conversations'][number]>(CONVERSATIONS_SQL, [
    ws,
    ws,
    ws,
  ]);
  const optOuts = useQuery<SyncedHintRows['optOuts'][number]>(OPT_OUTS_SQL, [ws]);
  const suppressions = useQuery<SyncedHintRows['suppressions'][number]>(SUPPRESSIONS_SQL, [ws]);
  const numbers = useQuery<SyncedHintRows['phoneNumbers'][number]>(NUMBERS_SQL, [ws]);
  const addresses = useQuery<SyncedHintRows['emailAddresses'][number]>(ADDRESSES_SQL, [ws]);
  const workspace = useWorkspaceRow();
  const decided = useDecidedHere();
  const timeZone = workspace.timezone || business.timezone || 'UTC';

  const home = React.useMemo(
    () =>
      buildHome({
        userId,
        role: who.role,
        permissions: who.permissions,
        timeZone,
        now,
        scope,
        items: items.data,
        approvals: approvals.data,
        users: users.data,
        hintRows: {
          seats: seats.data,
          people: people.data,
          conversations: conversations.data,
          optOuts: optOuts.data,
          suppressions: suppressions.data,
          phoneNumbers: numbers.data,
          emailAddresses: addresses.data,
          settings: workspace.settings,
          timezone: timeZone,
        },
        outbox: outbox.data,
        decided,
      }),
    [
      userId,
      who,
      timeZone,
      now,
      scope,
      items.data,
      approvals.data,
      users.data,
      seats.data,
      people.data,
      conversations.data,
      optOuts.data,
      suppressions.data,
      numbers.data,
      addresses.data,
      workspace.settings,
      outbox.data,
      decided,
    ],
  );
  return { ...home, loading: items.isLoading };
}

/** How often Home asks HandsFreeOS again how many items were cleared today, while it has signal. */
export const CLEARED_EVERY_MS = 5 * 60_000;

interface Cleared {
  readonly key: string;
  readonly today: number;
  readonly count: number;
  readonly at: number;
}
const clearedKept = new Map<string, Cleared>();

/**
 * Items someone's action cleared today (a reply, a decision, a payment), which count in "handled today" but never reach
 * phones (the streams leave cleared items out). Asked of HandsFreeOS (`attention.list`) when there's signal, at most
 * every five minutes; with no signal, the last answer from today stands.
 */
export function useClearedToday(scope: AttentionScope, timeZone: string, now: number): number {
  const { business } = useBusiness();
  const { online } = useNetwork();
  const key = `${business.id}:${scope}`;
  const today = attentionToday(now, timeZone);
  const [cleared, setCleared] = React.useState<Cleared | null>(() => clearedKept.get(key) ?? null);
  const fresh = cleared && cleared.key === key && cleared.today === today ? cleared : null;
  const stale = !fresh || now - fresh.at >= CLEARED_EVERY_MS;
  React.useEffect(() => {
    if (!online || !stale) return;
    let cancelled = false;
    void api
      .POST('/v1/queries/attention.list', {
        body: { workspaceId: business.id, scope, includeHandled: true },
      })
      .then((r) => {
        if (cancelled || !r.data) return;
        const next = {
          key,
          today,
          count: Math.max(0, r.data.handledToday - r.data.handled.length),
          at: Date.now(),
        };
        clearedKept.set(key, next);
        setCleared(next);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [online, stale, business.id, scope, key, today]);
  return fresh?.count ?? 0;
}
