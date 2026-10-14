import { SALESCOACH_WORDS as W } from '@hfos/core/addons/salescoach/words';
import * as React from 'react';
import { View } from 'react-native';

import { Headset } from '@/components/icons';
import { useBusiness } from '@/components/shell/business-context';
import { List, ListRow } from '@/components/shell/list';
import { openWebPath } from '@/home/open';

/** AI Sales Coach's one place at the top of More: the live call, for a rep on their cell. */
export function SalescoachMore() {
  const { business } = useBusiness();
  return (
    <View testID="more-salescoach">
      <List>
        <ListRow
          icon={Headset}
          label={W.title}
          detail={W.tabs.live}
          onPress={() => openWebPath(`/app/w/${business.id}/a/salescoach`)}
          testID="more-salescoach-open"
        />
      </List>
    </View>
  );
}
