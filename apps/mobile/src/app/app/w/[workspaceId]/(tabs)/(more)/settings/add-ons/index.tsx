import { ADDON_CATALOG } from '@hfos/core';
import { router, useFocusEffect } from 'expo-router';
import * as React from 'react';

import { Puzzle } from '@/components/icons';
import { AddonRow, AddonsLoading, AddonsNeedSignal, Note } from '@/components/add-ons/addon-bits';
import { businessHref, useBusiness } from '@/components/shell/business-context';
import { List, ListLabel } from '@/components/shell/list';
import { Screen } from '@/components/shell/screen';
import { Card } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { groupAddons, isEmptyGroups, type AddonView } from '@/add-ons/rules';
import { useAddonGrants, useAddonList } from '@/add-ons/use-add-ons';
import { ADDON_PHONE_WORDS } from '@/add-ons/words';

/**
 * Settings → Add-ons, for owners and admins (the owner's decision, 2026-09-28: they manage add-ons on the phone too).
 * What this business has and where each stands, what could be added, and what's coming; each add-on's own screen
 * has what it does and its moves. Live, as the balance is: nothing here is in the phone's copy, so with no signal it
 * says so. While an add-on is still on its way somewhere the list asks again every few seconds.
 */
export default function Addons() {
  const { business } = useBusiness();
  const grants = useAddonGrants();
  const list = useAddonList(business.id, grants.manage);
  const groups = React.useMemo(
    () => (list.data ? groupAddons(list.data, ADDON_CATALOG, grants) : null),
    [list.data, grants],
  );

  // Coming back from an add-on's own screen asks again: a move there changed where things stand.
  const { reload } = list;
  const first = React.useRef(true);
  useFocusEffect(
    React.useCallback(() => {
      if (first.current) {
        first.current = false;
        return;
      }
      reload();
    }, [reload]),
  );

  const open = (view: AddonView) =>
    router.push(businessHref(business.id, `settings/add-ons/${view.addonId}`));
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
        isEmptyGroups(groups) ? (
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
              <Card className="px-4 py-3.5" testID="add-ons-none-here">
                <Text className="text-[14px] leading-5 text-text-2">
                  {ADDON_PHONE_WORDS.noneHere}
                </Text>
              </Card>
            )}
            {groups.addable.length ? (
              <>
                <ListLabel>{ADDON_PHONE_WORDS.couldAdd}</ListLabel>
                <List testID="add-ons-addable">{rows(groups.addable)}</List>
              </>
            ) : null}
            {groups.comingSoon.length ? (
              <>
                <ListLabel>{ADDON_PHONE_WORDS.comingSoon}</ListLabel>
                <List testID="add-ons-coming-soon">{rows(groups.comingSoon)}</List>
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
          {ADDON_PHONE_WORDS.footnote}
        </Text>
      ) : null}
    </Screen>
  );
}
