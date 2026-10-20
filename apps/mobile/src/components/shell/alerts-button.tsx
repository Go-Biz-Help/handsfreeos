import {
  addonAlertOfSynced,
  attentionRowOfSynced,
  type ItemHints,
  type SyncedAttentionRow,
} from '@hfos/core';
import { useQuery } from '@powersync/react-native';
import { router, type Href } from 'expo-router';
import * as React from 'react';
import { Pressable, View } from 'react-native';

import { Bell, ChevronRight } from '@/components/icons';
import { Icon } from '@/components/ui/icon';
import { Sheet } from '@/components/ui/sheet';
import { Text } from '@/components/ui/text';
import { openWebPath } from '@/home/open';
import { useAddonAlertHints } from '@/home/use-home';
import { HOME_PHONE_WORDS as W } from '@/home/words';
import { useGrants } from '@/lib/grants';

import { businessHref, useBusiness } from './business-context';

/** The add-ons' alerts still open for this person: the copy keeps each for exactly whom it's for. */
export const OPEN_ALERTS_SQL = `
  SELECT * FROM attention_items
  WHERE workspace_id = ? AND kind = 'addon_alert' AND state = 'open'
  ORDER BY opened_at DESC`;

export interface OpenAlert {
  readonly id: string;
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

/**
 * The bell beside Ask HandsFreeOS: how many of the add-ons' alerts are still open, and a sheet of them. Pressing one
 * opens its page (a code's own screen), so an alert left behind is always one tap away.
 */
export function AlertsButton() {
  const { business } = useBusiness();
  const alerts = useOpenAlerts();
  const [open, setOpen] = React.useState(false);
  const opening = React.useRef<OpenAlert | null>(null);
  const count = alerts.length;
  const go = (a: OpenAlert) => {
    opening.current = a;
    setOpen(false);
  };
  // Once the sheet is gone: iOS opens nothing while a modal is still up.
  const closed = () => {
    const a = opening.current;
    opening.current = null;
    if (!a) return;
    if (a.alert) openWebPath(`/app/w/${business.id}${a.alert.href}`);
    else router.navigate(businessHref(business.id) as Href);
  };
  return (
    <>
      <Pressable
        role="button"
        accessibilityLabel={W.alertsLabel(count)}
        testID="alerts-button"
        onPress={() => setOpen(true)}
        className="size-11 items-center justify-center rounded-full active:bg-card-2"
      >
        <Icon as={Bell} className="size-[22px] text-text-2" />
        {count > 0 ? (
          <View
            className="absolute right-1 top-1 h-[18px] min-w-[18px] items-center justify-center rounded-full bg-danger px-1"
            testID="alerts-count"
          >
            <Text className="text-[11px] font-bold leading-[14px] text-on-solid">
              {count > 9 ? '9+' : count}
            </Text>
          </View>
        ) : null}
      </Pressable>
      <Sheet
        open={open}
        onClose={() => setOpen(false)}
        onClosed={closed}
        title={W.alertsTitle}
        description={count ? W.alertsAbout : undefined}
        scroll
        testID="alerts-sheet"
      >
        {count === 0 ? (
          <Text className="py-4 text-center text-[14.5px] text-text-2" testID="alerts-none">
            {W.alertsNone}
          </Text>
        ) : (
          <View className="gap-2">
            {alerts.map((a) => (
              <Pressable
                key={a.id}
                role="button"
                onPress={() => go(a)}
                testID="alerts-item"
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
            ))}
          </View>
        )}
      </Sheet>
    </>
  );
}
