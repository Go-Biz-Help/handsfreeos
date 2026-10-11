import { OUTREACH_WORDS as W } from '@hfos/core/addons/outreach/words';
import * as React from 'react';
import { View } from 'react-native';

import { Handshake } from '@/components/icons';
import { List, ListRow } from '@/components/shell/list';

import { useOutreachWaiting } from './copy';
import { openOutreach, useOutreachContext } from './kit';

/**
 * Social Outreach's one place at the top of More (decision 44): its row says how many messages wait for the person's
 * OK, from the phone's own copy, so it reads the same with no signal, and opens the add-on's screen.
 */
export function OutreachMore() {
  const ctx = useOutreachContext();
  const waiting = useOutreachWaiting(ctx.workspaceId, ctx.userId);
  return (
    <OutreachMoreRow
      workspaceId={ctx.workspaceId}
      messages={waiting.kinds.message.count + waiting.kinds.reply.count}
    />
  );
}

export function OutreachMoreRow({
  workspaceId,
  messages,
}: {
  workspaceId: string;
  /** Messages waiting for the person's OK, replies handed over among them. */
  messages: number;
}) {
  return (
    <View testID="more-outreach">
      <List>
        <ListRow
          icon={Handshake}
          label={W.title}
          detail={W.waitingMore(messages)}
          onPress={() => openOutreach(workspaceId)}
          testID="more-outreach-open"
        />
      </List>
    </View>
  );
}
