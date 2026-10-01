import { deskSectionLabel, type DeskSectionKey } from '@hfos/core';
import * as React from 'react';
import { View } from 'react-native';

import { MONEY_DESK_WORDS } from '@/admin/money-desk-words';
import { deskHref } from '@/components/admin/staff-context';
import { Lock } from '@/components/icons';
import { Screen } from '@/components/shell/screen';
import { Card } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';

/**
 * What Add-on votes, Rates and Founding share on the phone's Support desk. Each is for support admins only, as the
 * menu says by leaving it out for anyone else; a person here from an old link is told so, and nothing is asked of
 * HandsFreeOS, which would refuse them anyway.
 */
export function OnlyAdmins({ section }: { section: DeskSectionKey }) {
  const label = deskSectionLabel(section);
  return (
    <Screen title={label} leading="back" back={deskHref()} testID={`desk-${section}-not-yours`}>
      <Card className="items-center gap-3 px-5 py-8">
        <Icon as={Lock} className="size-6 text-text-3" />
        <Text className="text-center text-[14.5px] leading-[21px] text-text-2">
          {MONEY_DESK_WORDS.onlyAdmins(label)}
        </Text>
      </Card>
    </Screen>
  );
}

/** One row of a section's list, with the rule above every row but the first, as the web's lists have. */
export function Row({
  first,
  children,
  className,
  testID,
}: {
  first: boolean;
  children: React.ReactNode;
  className?: string;
  testID?: string;
}) {
  return (
    <View
      className={cn('gap-1', !first && '-mx-4 border-t border-border px-4 pt-3', className)}
      testID={testID}
    >
      {children}
    </View>
  );
}
