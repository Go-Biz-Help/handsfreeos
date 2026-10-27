import {
  addonAlertOfSynced,
  attentionRowOfSynced,
  BELL_WORDS as W,
  bellCount,
  bellTime,
  newestSent,
  type ItemHints,
  type SyncedAttentionRow,
} from '@hfos/core';
import { useQuery } from '@powersync/react-native';
import { router, type Href } from 'expo-router';
import * as React from 'react';
import { Pressable, View } from 'react-native';

import { Bell, ChevronRight } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Sheet } from '@/components/ui/sheet';
import { Text } from '@/components/ui/text';
import { openWebPath } from '@/home/open';
import { useAddonAlertHints } from '@/home/use-home';
import { useGrants } from '@/lib/grants';
import { cn } from '@/lib/utils';
import { pendingLinks } from '@/links/pending';
import {
  BELL_PAGE,
  BELL_SQL,
  BELL_UNSEEN_SQL,
  bellNotificationOf,
  isRead,
  isSeen,
  markRead,
  markSeen,
  useBellMarks,
  type BellNotification,
} from '@/push/bell';
import type { NotificationsRow } from '@/sync/schema';

import { businessHref, useBusiness } from './business-context';

/** The add-ons' alerts still open for this person: the copy keeps each for exactly whom it's for. */
export const OPEN_ALERTS_SQL = `
  SELECT * FROM attention_items
  WHERE workspace_id = ? AND kind = 'addon_alert' AND state = 'open'
  ORDER BY opened_at DESC`;

export interface OpenAlert {
  readonly id: string;
  /** The add-on's alert itself (the item's subject): its push, under the bell, is the same thing. */
  readonly alertId: string | null;
  readonly title: string;
  readonly detail: string | null;
  /** Its add-on and the page it opens; null when the phone can't tell which add-on raised it yet. */
  readonly alert: ItemHints['addonAlert'];
}

/**
 * The add-ons' alerts still open for this person, newest first: Social Outreach's "Alignable emailed you a code" stays
 * here until the code is typed in or runs out (decision 82). Where each opens is HandsFreeOS's answer, as on Home.
 */
export function useOpenAlerts(): readonly OpenAlert[] {
  const { business } = useBusiness();
  const { permissions } = useGrants();
  const { data } = useQuery<SyncedAttentionRow>(OPEN_ALERTS_SQL, [business.id]);
  const server = useAddonAlertHints(data);
  return React.useMemo(
    () =>
      data.map((r) => {
        const row = attentionRowOfSynced(r);
        return {
          id: r.id,
          alertId: row.subjectId,
          title: row.title,
          detail: row.detail,
          alert: addonAlertOfSynced(row, permissions ?? null, {
            server: server.get(r.id) ?? null,
          }),
        };
      }),
    [data, server, permissions],
  );
}

const bellRows = (rows: readonly NotificationsRow[]): BellNotification[] =>
  rows.flatMap((r) => {
    const n = bellNotificationOf(r);
    return n ? [n] : [];
  });

/**
 * The bell's notifications from the person's copy (me_v1): the newest `limit` of the business's (and the person's own
 * about no business), and every one of those not seen yet, for the count.
 */
export function useBellNotifications(
  workspaceId: string,
  limit: number,
): {
  readonly list: readonly BellNotification[];
  readonly unseen: readonly BellNotification[];
} {
  const { data: page } = useQuery<NotificationsRow>(BELL_SQL, [workspaceId, limit]);
  const { data: unseen } = useQuery<NotificationsRow>(BELL_UNSEEN_SQL, [workspaceId]);
  return React.useMemo(() => ({ list: bellRows(page), unseen: bellRows(unseen) }), [page, unseen]);
}

/**
 * The bell beside Ask HandsFreeOS (20261027012600, packages/core/src/bell.ts), for the business on screen only. Its
 * count is what's new there: the notifications not seen yet and the add-ons' alerts still open. Its sheet keeps those
 * alerts at the top, under Needs you, until each is done, then lists every push about the business this person's
 * phones were handed in the last 30 days (and their own about no business), newest first, the unread ones marked.
 * Opening it sees them; pressing one reads it and opens the screen its push opens (the route map, as a tap on the push
 * does).
 */
export function BellButton() {
  const { business, userId } = useBusiness();
  const alerts = useOpenAlerts();
  const [limit, setLimit] = React.useState(BELL_PAGE);
  const { list, unseen } = useBellNotifications(business.id, limit);
  const marks = useBellMarks(userId);
  const [open, setOpen] = React.useState(false);
  const opening = React.useRef<(() => void) | null>(null);
  const fresh = unseen.filter((n) => !isSeen(n, marks));
  const count = bellCount(
    fresh.map((n) => ({ seenAt: null, alertId: n.alertId })),
    alerts.flatMap((a) => (a.alertId ? [a.alertId] : [])),
  );
  const empty = alerts.length === 0 && list.length === 0;
  const now = Date.now();

  // Everything the bell showed is seen: as it opens, and again as it closes, for any that came in meanwhile.
  const see = () => {
    if (fresh.length > 0) markSeen(userId, business.id, newestSent([...list, ...fresh]));
  };
  const show = () => {
    setOpen(true);
    see();
  };
  const hide = () => {
    setOpen(false);
    see();
  };
  // What a press opens waits until the sheet is gone: iOS opens nothing while a modal is still up.
  const go = (then: () => void) => {
    opening.current = then;
    hide();
  };
  const closed = () => {
    const then = opening.current;
    opening.current = null;
    then?.();
  };
  const openAlert = (a: OpenAlert) =>
    go(() => {
      if (a.alert) openWebPath(`/app/w/${business.id}${a.alert.href}`);
      else router.navigate(businessHref(business.id) as Href);
    });
  const openNotification = (n: BellNotification) => {
    markRead(userId, { id: n.id });
    go(() => pendingLinks.open(n.path));
  };

  return (
    <>
      <Pressable
        role="button"
        accessibilityLabel={W.label(count)}
        testID="bell-button"
        onPress={show}
        className="size-11 items-center justify-center rounded-full active:bg-card-2"
      >
        <Icon as={Bell} className="size-[22px] text-text-2" />
        {count > 0 ? (
          <View
            className="absolute right-1 top-1 h-[18px] min-w-[18px] items-center justify-center rounded-full bg-danger px-1"
            testID="bell-count"
          >
            <Text className="text-[11px] font-bold leading-[14px] text-on-solid">
              {count > 9 ? '9+' : count}
            </Text>
          </View>
        ) : null}
      </Pressable>
      <Sheet
        open={open}
        onClose={hide}
        onClosed={closed}
        title={W.title}
        description={empty ? undefined : W.about}
        scroll
        testID="bell-sheet"
      >
        {empty ? (
          <Text className="py-4 text-center text-[14.5px] text-text-2" testID="bell-none">
            {W.none}
          </Text>
        ) : (
          <View className="mt-3">
            {alerts.length > 0 ? (
              <>
                <Text variant="group" className="mb-2">
                  {W.needsYou}
                </Text>
                <View className="gap-2">
                  {alerts.map((a) => (
                    <AlertRow key={a.id} alert={a} onPress={() => openAlert(a)} />
                  ))}
                </View>
                {list.length > 0 ? (
                  <Text variant="group" className="mb-1 mt-5">
                    {W.recent}
                  </Text>
                ) : null}
              </>
            ) : null}
            {list.map((n) => (
              <NotificationRow
                key={n.id}
                n={n}
                unread={!isRead(n, marks)}
                now={now}
                onPress={() => openNotification(n)}
              />
            ))}
            {list.length >= limit ? (
              <Button
                variant="ghost"
                className="mt-1"
                onPress={() => setLimit(limit + BELL_PAGE)}
                testID="bell-older"
              >
                {W.older}
              </Button>
            ) : null}
          </View>
        )}
      </Sheet>
    </>
  );
}

function AlertRow({ alert: a, onPress }: { alert: OpenAlert; onPress: () => void }) {
  return (
    <Pressable
      role="button"
      onPress={onPress}
      testID="bell-alert"
      className="flex-row items-center gap-3 rounded-xl border border-border bg-card px-4 py-3 active:bg-card-2"
    >
      <View className="min-w-0 flex-1 gap-0.5">
        {a.alert ? (
          <Text className="text-xs font-semibold uppercase tracking-[0.4px] text-text-3">
            {a.alert.addonName}
          </Text>
        ) : null}
        <Text className="text-[15px] font-semibold leading-[20px]">{a.title}</Text>
        {a.detail ? (
          <Text className="text-[13px] leading-[18px] text-text-2">{a.detail}</Text>
        ) : null}
      </View>
      <Icon as={ChevronRight} className="size-5 text-text-3" />
    </Pressable>
  );
}

/** One notification: its words as the push said them (the subtitle names the business), and when it came. */
function NotificationRow({
  n,
  unread,
  now,
  onPress,
}: {
  n: BellNotification;
  unread: boolean;
  now: number;
  onPress: () => void;
}) {
  const when = bellTime(n.sentAt, now);
  return (
    <Pressable
      role="button"
      accessibilityLabel={[unread ? W.unread : null, n.title, n.subtitle, n.body, when]
        .filter(Boolean)
        .join('. ')}
      onPress={onPress}
      testID="bell-item"
      className={cn(
        'flex-row gap-2.5 rounded-xl px-3 py-3 active:bg-card-2',
        unread && 'bg-accent-soft',
      )}
    >
      <View className="w-2 pt-[7px]">
        {unread ? <View className="size-2 rounded-full bg-accent" testID="bell-unread" /> : null}
      </View>
      <View className="min-w-0 flex-1">
        <View className="flex-row items-center gap-2">
          <Text
            numberOfLines={1}
            className={cn(
              'flex-1 text-[15px] leading-[20px]',
              unread ? 'font-semibold' : 'font-medium',
            )}
          >
            {n.title}
          </Text>
          <Text
            className={cn(
              'text-[12.5px]',
              unread ? 'font-semibold text-accent-text' : 'text-text-3',
            )}
          >
            {when}
          </Text>
        </View>
        {n.subtitle ? (
          <Text numberOfLines={1} className="text-[13px] leading-[18px] text-text-3">
            {n.subtitle}
          </Text>
        ) : null}
        <Text
          numberOfLines={2}
          className={cn('mt-0.5 text-[14px] leading-[19px]', unread ? 'text-text' : 'text-text-2')}
        >
          {n.body}
        </Text>
      </View>
    </Pressable>
  );
}
