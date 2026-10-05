import { findAddon, BUILT_ADDONS, type Grants } from '@hfos/core';
import * as React from 'react';
import { View } from 'react-native';

import { ADDON_PHONE_WORDS } from '@/add-ons/words';
import { PowerOff } from '@/components/icons';
import { Screen } from '@/components/shell/screen';
import { Card } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { useGrants } from '@/lib/grants';

/**
 * The door every add-on screen on the phone opens through, as `addonPage` is on the web. Its permission is only ever
 * in the person's list while the add-on runs in the business (`private.permissions_for`), so the phone's own copy of
 * their access answers both questions with no signal: is it on here, and may they open it. When it isn't, the screen
 * says so and who can help; its records have already left the phone (records_v1 follows the same permission).
 */

/** Whether the person holds one of an add-on's permissions here. An older copy without a list holds none. */
export function holdsAddon(grants: Grants, permission: string): boolean {
  return grants.permissions?.includes(permission) ?? false;
}

export function AddonGate({
  addonId,
  permission,
  children,
}: {
  addonId: string;
  permission: string;
  children: React.ReactNode;
}) {
  const grants = useGrants();
  if (holdsAddon(grants, permission)) return <>{children}</>;
  const name = findAddon(BUILT_ADDONS, addonId)?.name ?? 'This add-on';
  return (
    <Screen title={name} back="/app" testID="addon-unavailable">
      <Card className="items-center gap-3 px-5 py-8">
        <View className="size-11 items-center justify-center rounded-full bg-card-2">
          <Icon as={PowerOff} className="size-5 text-text-2" />
        </View>
        <Text className="text-center text-lg font-semibold">
          {ADDON_PHONE_WORDS.unavailableTitle}
        </Text>
        <Text className="text-center text-[14.5px] leading-[21px] text-text-2">
          {ADDON_PHONE_WORDS.unavailable(name)}
        </Text>
      </Card>
    </Screen>
  );
}
