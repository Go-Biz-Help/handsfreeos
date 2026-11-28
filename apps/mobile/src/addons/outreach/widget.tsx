import type { AddonWidgetFacts } from '@hfos/core';
import { outreachWidgetFacts } from '@hfos/core/addons/outreach/widget';
import { OUTREACH_WORDS as W } from '@hfos/core/addons/outreach/words';
import * as React from 'react';

import { api, unwrap } from '@/lib/api';

import { useOutreachWaiting } from './copy';
import { useOutreachAnswer, useOutreachContext } from './kit';
import { useNetworksOn } from './networks';

/**
 * What Social Outreach puts on its home-screen widget (docs/phone-widgets.md): today's first messages against the
 * goal on every network the person works (`outreach.today`'s `goal`, asked when the business opens and on Update
 * now), and the replies and messages waiting for their OK, from the phone's copy. Draws nothing: the business's widget
 * keeper renders it for someone who holds `outreach.use`, and it reports what the widget says.
 */
export function OutreachWidgetFacts({ onFacts }: { onFacts: (facts: AddonWidgetFacts) => void }) {
  const ctx = useOutreachContext();
  const ws = ctx.workspaceId;
  const networks = useNetworksOn();
  const waiting = useOutreachWaiting(ws, ctx.userId);
  const goals = useOutreachAnswer(
    async () =>
      Promise.all(
        networks.map(async (platform) => {
          const today = unwrap(
            await api.POST('/v1/queries/outreach.today', { body: { workspaceId: ws, platform } }),
          );
          return today.goal;
        }),
      ),
    `widget-goals:${ws}:${networks.join(',')}`,
    W.rows.today,
  );

  const facts = React.useMemo(
    () =>
      outreachWidgetFacts({
        goals: goals.data
          ? goals.data.flatMap((g) => (g ? [{ done: g.done, most: g.most }] : []))
          : null,
        replies: waiting.kinds.reply.count,
        messages: waiting.kinds.message.count,
      }),
    [goals.data, waiting.kinds.reply.count, waiting.kinds.message.count],
  );

  React.useEffect(() => onFacts(facts), [facts, onFacts]);
  return null;
}
