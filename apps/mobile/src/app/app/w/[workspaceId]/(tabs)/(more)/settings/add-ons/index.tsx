import { ADDON_CATALOG } from '@hfos/core';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import * as React from 'react';
import { View } from 'react-native';

import { Puzzle } from '@/components/icons';
import { AddonRow, AddonsLoading, AddonsNeedSignal, Note } from '@/components/add-ons/addon-bits';
import { PlannedList } from '@/components/add-ons/planned-list';
import { businessHref, useBusiness } from '@/components/shell/business-context';
import { List, ListLabel } from '@/components/shell/list';
import { Screen } from '@/components/shell/screen';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { groupAddons, isEmptyGroups, type AddonView } from '@/add-ons/rules';
import { useAddonGrants, useAddonList, useAddonRoadmap } from '@/add-ons/use-add-ons';
import { ADDON_PHONE_WORDS } from '@/add-ons/words';

/**
 * Settings → Add-ons, for owners and admins (the owner's decision, 2026-09-28: they manage add-ons on the phone too).
 * What this business has and where each stands, what could be added, what's coming soon, and the vote on what comes
 * next (0109); each add-on's own screen has what it does and its moves. Live, as the balance is: nothing here is in
 * the phone's copy, so with no signal it says so. While an add-on is still on its way somewhere the list asks again
 * every few seconds.
 */
export default function Addons() {
  const { business } = useBusiness();
  const grants = useAddonGrants();
  const list = useAddonList(business.id, grants.manage);
  const roadmap = useAddonRoadmap(business.id, grants.manage);
  const had = React.useMemo(
    () => new Set(list.data?.installed.map((r) => r.addonId) ?? []),
    [list.data],
  );
  const coming = (roadmap.data?.comingSoon ?? []).filter((c) => !had.has(c.addonId));
  const planned = roadmap.data?.planned ?? [];
  const groups = React.useMemo(
    () => (list.data ? groupAddons(list.data, ADDON_CATALOG, grants) : null),
    [list.data, grants],
  );

  // Coming back from an add-on's own screen asks again: a move there changed where things stand.
  const { reload } = list;
  const { reload: reloadRoadmap } = roadmap;
  const first = React.useRef(true);
  useFocusEffect(
    React.useCallback(() => {
      if (first.current) {
        first.current = false;
        return;
      }
      reload();
      reloadRoadmap();
    }, [reload, reloadRoadmap]),
  );

  const open = (view: AddonView) =>
    router.push(businessHref(business.id, `settings/add-ons/${view.addonId}`));

  // A link to one add-on (`?addon=`, the web's "See it"): its own screen, once, over this list.
  const { addon } = useLocalSearchParams<{ addon?: string }>();
  const openedLink = React.useRef(false);
  React.useEffect(() => {
    if (!addon || !grants.manage || openedLink.current) return;
    openedLink.current = true;
    router.push(businessHref(business.id, `settings/add-ons/${addon}`));
  }, [addon, business.id, grants.manage]);
  const rows = (views: readonly AddonView[]) =>
    views.map((view) => (
      <AddonRow
        key={view.addonId}
        view={view}
        onPress={() => open(view)}
        testID={`add-on-row-${view.addonId}`}
      />
    ));

  return (
    <Screen
      title={ADDON_PHONE_WORDS.title}
      leading="back"
      back={businessHref(business.id, 'settings')}
      testID="add-ons"
      contentClassName="gap-2"
    >
      {!grants.manage ? (
        <Note tone="info" lines={[ADDON_PHONE_WORDS.notYours]} testID="add-ons-not-yours" />
      ) : groups ? (
        isEmptyGroups(groups) && !coming.length && !planned.length ? (
          <Card className="items-center gap-2 px-5 py-8" testID="add-ons-empty">
            <Icon as={Puzzle} className="size-6 text-text-3" />
            <Text className="text-[15px] font-semibold">{ADDON_PHONE_WORDS.emptyTitle}</Text>
            <Text className="text-center text-[14px] leading-[20px] text-text-2">
              {ADDON_PHONE_WORDS.empty}
            </Text>
          </Card>
        ) : (
          <>
            <ListLabel>{ADDON_PHONE_WORDS.inBusiness}</ListLabel>
            {groups.installed.length ? (
              <List testID="add-ons-installed">{rows(groups.installed)}</List>
            ) : (
              <Card className="gap-0.5 px-4 py-3.5" testID="add-ons-none-here">
                <Text className="text-[14.5px] font-semibold">
                  {ADDON_PHONE_WORDS.noneHereTitle}
                </Text>
                <Text className="text-[14px] leading-5 text-text-2">
                  {ADDON_PHONE_WORDS.noneHere}
                </Text>
              </Card>
            )}
            {groups.addable.length ? (
              <>
                <ListLabel>{ADDON_PHONE_WORDS.available}</ListLabel>
                <List testID="add-ons-addable">{rows(groups.addable)}</List>
              </>
            ) : null}
            {coming.length ? (
              <>
                <ListLabel>{ADDON_PHONE_WORDS.comingSoon}</ListLabel>
                <View className="gap-2" testID="add-ons-coming-soon">
                  {coming.map((c) => (
                    <Card
                      key={c.addonId}
                      className="gap-1.5 px-3.5 py-3"
                      testID={`coming-soon-${c.addonId}`}
                    >
                      <Text className="text-[15px] font-semibold">{c.name}</Text>
                      <View className="flex-row flex-wrap gap-1.5">
                        <Badge variant="accent">{ADDON_PHONE_WORDS.comingSoon}</Badge>
                        {c.voted ? (
                          <Badge variant="ok">{ADDON_PHONE_WORDS.comingSoonVoted}</Badge>
                        ) : null}
                      </View>
                      <Text className="text-[14px] leading-5 text-text-2">{c.summary}</Text>
                    </Card>
                  ))}
                </View>
              </>
            ) : null}
            {planned.length ? (
              <>
                <ListLabel>{ADDON_PHONE_WORDS.vote}</ListLabel>
                <Text className="px-1 text-[13px] leading-[18px] text-text-2">
                  {ADDON_PHONE_WORDS.voteDetail}
                </Text>
                <PlannedList workspaceId={business.id} planned={planned} />
              </>
            ) : null}
          </>
        )
      ) : list.loading ? (
        <AddonsLoading />
      ) : (
        <AddonsNeedSignal error={list.error} onRetry={list.reload} />
      )}
      {grants.manage ? (
        <Text className="px-1 pt-1 text-[12.5px] leading-[18px] text-text-3">
          {ADDON_PHONE_WORDS.intro}
        </Text>
      ) : null}
    </Screen>
  );
}
