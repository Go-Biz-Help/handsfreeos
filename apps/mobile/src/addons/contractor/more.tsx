import { addDays, startOfLocalDay } from '@hfos/core';
import { CONTRACTOR_PHONE_WORDS as P } from '@hfos/core/addons/contractor/phone-words';
import { phoneDayVisits, phoneJobList } from '@hfos/core/addons/contractor/views/phone';
import * as React from 'react';
import { View } from 'react-native';

import { Wrench } from '@/components/icons';
import { List, ListLabel, ListRow } from '@/components/shell/list';
import { openWebPath } from '@/home/open';

import { useContractorCopy } from './copy';
import { useCoContext } from './kit';

/**
 * Contractor Operations' one row at the top of More: Jobs, with how many are open and how many visits the person has
 * today, worked out from the phone's copy so it reads the same with no signal. It opens through the route map, so
 * it's the phone's screen in this build and the web in an older one.
 */
export function ContractorMore() {
  const ctx = useCoContext();
  const copy = useContractorCopy(ctx.workspaceId, { kind: 'lists' });
  const counts = React.useMemo(() => {
    const from = startOfLocalDay(ctx.today, ctx.timeZone);
    const to = startOfLocalDay(addDays(ctx.today, 1), ctx.timeZone);
    return {
      open: phoneJobList(copy, { filter: 'all', me: ctx.userId }, ctx).jobs.length,
      today: phoneDayVisits(copy, { from, to, me: ctx.userId }).length,
    };
  }, [copy, ctx]);
  return (
    <ContractorMoreRow workspaceId={ctx.workspaceId} open={counts.open} today={counts.today} />
  );
}

export function ContractorMoreRow({
  workspaceId,
  open,
  today,
}: {
  workspaceId: string;
  open: number;
  today: number;
}) {
  return (
    <View className="gap-1.5" testID="more-contractor">
      <ListLabel>{P.more.section}</ListLabel>
      <List>
        <ListRow
          icon={Wrench}
          label={P.more.jobs}
          detail={P.more.detail(open, today)}
          onPress={() => openWebPath(`/app/w/${workspaceId}/a/contractor`)}
          testID="more-contractor-jobs"
        />
      </List>
    </View>
  );
}
