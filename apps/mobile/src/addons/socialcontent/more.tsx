import { SOCIALCONTENT_WORDS as W } from '@hfos/core/addons/socialcontent/words';
import * as React from 'react';
import { View } from 'react-native';

import { Sparkles } from '@/components/icons';
import { useBusiness } from '@/components/shell/business-context';
import { List, ListRow } from '@/components/shell/list';

import { openSocialcontent } from './kit';

/**
 * AI Social Media Content Creator's one place at the top of More (the owner's decision of 2026-10-09: one row for each
 * add-on, its pages opening from it): it opens the add-on's first screen, which lists Creators, Standouts, the
 * Playbook, Ideas and Settings. It asks nothing, so More draws the same with no signal.
 */
export function SocialcontentMore() {
  const { business } = useBusiness();
  return <SocialcontentMoreRow workspaceId={business.id} />;
}

export function SocialcontentMoreRow({ workspaceId }: { workspaceId: string }) {
  return (
    <View testID="more-socialcontent">
      <List>
        <ListRow
          icon={Sparkles}
          label={W.title}
          detail={W.phone.more}
          onPress={() => openSocialcontent(workspaceId)}
          testID="more-socialcontent-open"
        />
      </List>
    </View>
  );
}
