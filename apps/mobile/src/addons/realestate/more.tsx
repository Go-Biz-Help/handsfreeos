import { localDateOf } from '@hfos/core';
import { RE_MORE_WORDS } from '@hfos/core/addons/realestate/phone-words';
import { dealListOfCopy } from '@hfos/core/addons/realestate/views/deal-list';
import { dutyListOfCopy } from '@hfos/core/addons/realestate/views/duty-list';
import { vendorListOfCopy } from '@hfos/core/addons/realestate/views/vendors';
import * as React from 'react';
import { View } from 'react-native';

import { Globe, House, ListChecks, Radar, Wrench } from '@/components/icons';
import { List, ListLabel, ListRow } from '@/components/shell/list';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { openWebPath } from '@/home/open';

import { useRealestateCopy } from './copy';
import { RE_MANAGE, useReContext } from './kit';

/** Each row's line in More, worked out from the phone's copy so it reads the same with no signal. */
export interface MoreCounts {
  readonly openDeals: number;
  readonly atRisk: number;
  readonly dueToday: number;
  readonly late: number;
  readonly approvedVendors: number;
}

/**
 * Real Estate's places at the top of More (board 76): Deals, My duties, Coordinate and Vendors, each with what's in it
 * now. Each opens through the route map, so it's the phone's screen once this build has it and the web until then.
 * Deal settings stays on the web, and says so to those who may change it.
 */
export function RealestateMore() {
  const ctx = useReContext();
  const copy = useRealestateCopy(ctx.workspaceId, { kind: 'lists' });
  const counts = React.useMemo<MoreCounts>(() => {
    const deals = dealListOfCopy(copy, { status: 'open', limit: 200 }, ctx);
    const duties = dutyListOfCopy(copy, { mine: true, status: 'open', limit: 500 }, ctx);
    return {
      openDeals: deals.length,
      atRisk: deals.filter((d) => d.health === 'red').length,
      dueToday: duties.filter(
        (t) =>
          !t.overdue && t.dueAt && localDateOf(Date.parse(t.dueAt), ctx.timeZone) === ctx.today,
      ).length,
      late: duties.filter((t) => t.overdue).length,
      approvedVendors: vendorListOfCopy(copy, {}, ctx).vendors.filter((v) => v.approved).length,
    };
  }, [copy, ctx]);
  return (
    <RealestateMoreRows
      workspaceId={ctx.workspaceId}
      counts={counts}
      manages={ctx.holds(RE_MANAGE)}
    />
  );
}

export function RealestateMoreRows({
  workspaceId,
  counts,
  manages,
}: {
  workspaceId: string;
  counts: MoreCounts;
  manages: boolean;
}) {
  const open = (path: string) => openWebPath(`/app/w/${workspaceId}/a/realestate${path}`);
  return (
    <View className="gap-1.5" testID="more-realestate">
      <ListLabel>{RE_MORE_WORDS.section}</ListLabel>
      <List>
        <ListRow
          icon={House}
          label="Deals"
          detail={RE_MORE_WORDS.deals(counts.openDeals, counts.atRisk)}
          onPress={() => open('')}
          testID="more-re-deals"
        />
        <ListRow
          icon={ListChecks}
          label="My duties"
          detail={RE_MORE_WORDS.duties(counts.dueToday, counts.late)}
          onPress={() => open('/duties')}
          testID="more-re-duties"
        />
        <ListRow
          icon={Radar}
          label="Coordinate"
          detail={RE_MORE_WORDS.coordinate}
          onPress={() => open('/coordinate')}
          testID="more-re-coordinate"
        />
        <ListRow
          icon={Wrench}
          label="Vendors"
          detail={RE_MORE_WORDS.vendors(counts.approvedVendors)}
          onPress={() => open('/vendors')}
          testID="more-re-vendors"
        />
      </List>
      {manages ? (
        <View className="flex-row gap-2 px-1 pt-1">
          <Icon as={Globe} className="mt-0.5 size-3.5 text-text-3" />
          <Text className="flex-1 text-[12.5px] leading-[17px] text-text-3">
            {RE_MORE_WORDS.settingsOnTheWeb}
          </Text>
        </View>
      ) : null}
    </View>
  );
}
