import { CONTRACTOR_PHONE_WORDS as P } from '@hfos/core/addons/contractor/phone-words';
import { useQuery } from '@powersync/react-native';
import { router, type Href } from 'expo-router';
import * as React from 'react';
import { View } from 'react-native';

import { CloudOff } from '@/components/icons';
import { businessHref, useBusiness } from '@/components/shell/business-context';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { useGrants } from '@/lib/grants';
import { useNetwork } from '@/lib/network';
import { clockTime, useSyncStatus } from '@/lib/sync-status';
import { cn } from '@/lib/utils';

import { useBusinessToday } from './copy';

/**
 * What every Contractor Operations screen on the phone shares (docs/contractor.md, "On the phone"): who is looking
 * and when, where its screens live, and how a screen says what the phone holds and what waits for signal. Screens
 * read the phone's copy (`copy.ts`) and hand it to core's views; this is the rest.
 */

/** Contractor Operations' permissions, as its manifest names them. */
export const CO_USE = 'contractor.use';
export const CO_MANAGE = 'contractor.manage';

/** One of its screens' address on the phone: the web's own, `/app/w/<business>/a/contractor/<path>`. */
export const coHref = (workspaceId: string, path = ''): Href =>
  businessHref(workspaceId, `a/contractor${path ? `/${path}` : ''}`) as Href;

/** Opens one of its screens. */
export const openCo = (workspaceId: string, path = '') => router.push(coHref(workspaceId, path));

export interface CoContext {
  readonly workspaceId: string;
  /** Who the screens are for (the teammate, while viewing as one). */
  readonly userId: string;
  /** The minute now, moving on by itself, so "late" and a running clock turn over while a screen stays open. */
  readonly now: number;
  /** The business's today, where the business is (YYYY-MM-DD). */
  readonly today: string;
  readonly timeZone: string;
  /** Whether the person holds one of the add-on's permissions here. */
  holds(permission: string): boolean;
}

function useMinute(): number {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);
  return now;
}

export function useCoContext(): CoContext {
  const { business, me } = useBusiness();
  const grants = useGrants();
  const now = useMinute();
  const today = useBusinessToday(business.id, business.timezone, now);
  const permissions = grants.permissions;
  return React.useMemo(() => {
    const holds = (p: string) => permissions?.includes(p) ?? false;
    return {
      workspaceId: business.id,
      userId: me.user.id,
      now,
      today,
      timeZone: business.timezone || 'UTC',
      holds,
    };
  }, [business.id, business.timezone, me.user.id, now, today, permissions]);
}

// ------------------------------------------------------------------------------------------ the phone's own changes

/** One of Contractor Operations' changes made on this phone, not through yet. */
export interface CoChange {
  readonly id: string;
  readonly name: string;
  readonly input: Readonly<Record<string, unknown>>;
}

export const CO_OUTBOX_SQL = `
  SELECT id, name, input FROM outbox
  WHERE workspace_id = ? AND name LIKE 'contractor.%' AND state != 'sent'
  ORDER BY seq`;

const parse = (s: unknown): Record<string, unknown> => {
  try {
    const v: unknown = JSON.parse(String(s ?? ''));
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

/** Its changes on this phone that haven't reached HandsFreeOS: what "Waiting to send" marks are made of. */
export function useCoChanges(workspaceId: string): readonly CoChange[] {
  const { data } = useQuery<{ id: string; name: string; input: string }>(CO_OUTBOX_SQL, [
    workspaceId,
  ]);
  return React.useMemo(
    () => data.map((r) => ({ id: r.id, name: r.name, input: parse(r.input) })),
    [data],
  );
}

/** The ids a kind of change still waiting points at (`itemId`, `materialId`, `id` of a note…). */
export const waitingIds = (changes: readonly CoChange[], key: string): ReadonlySet<string> =>
  new Set(
    changes.map((c) => c.input[key]).filter((id): id is string => typeof id === 'string' && !!id),
  );

/**
 * "No signal. Kept on this phone as of 2:14 PM", and how many of the add-on's changes wait: over a screen with no
 * signal, so a tech in a basement knows what they see is the phone's copy and that their work is safe on it.
 */
export function KeptStrip({ waiting = 0 }: { waiting?: number }) {
  const { online } = useNetwork();
  const status = useSyncStatus();
  if (online) return null;
  return <KeptStripView waiting={waiting} asOf={status.asOf} />;
}

export function KeptStripView({ waiting, asOf }: { waiting: number; asOf: number | null }) {
  return (
    <View
      className={cn(
        'flex-row items-center gap-2 rounded-menu border border-border bg-card-2 px-3.5 py-2',
      )}
      testID="co-kept-strip"
    >
      <Icon as={CloudOff} className="size-4 text-text-3" />
      <Text className="flex-1 text-[13px] leading-[18px] text-text-2">
        {waiting > 0
          ? P.kept.waiting(waiting)
          : asOf
            ? P.kept.keptAt(clockTime(asOf))
            : P.kept.noSignal}
      </Text>
    </View>
  );
}

/** A small heading over a card: "Checklist", "Materials for this visit". */
export function SectionLabel({ children, end }: { children: string; end?: React.ReactNode }) {
  return (
    <View className="flex-row items-center justify-between px-1">
      <Text className="text-[11.5px] font-semibold uppercase tracking-[0.04em] text-text-3">
        {children}
      </Text>
      {end}
    </View>
  );
}

/** A label and what it says, one over the other, for a card of facts. */
export function Fact({
  label,
  children,
  testID,
}: {
  label: string;
  children: React.ReactNode;
  testID?: string;
}) {
  return (
    <View className="gap-0.5" testID={testID}>
      <Text className="text-[12.5px] text-text-3">{label}</Text>
      {typeof children === 'string' ? (
        <Text className="text-[14.5px] leading-[20px]">{children}</Text>
      ) : (
        children
      )}
    </View>
  );
}
