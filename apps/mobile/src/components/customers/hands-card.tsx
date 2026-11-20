import { handsLine, HANDS_WORDS as W, holds, relativeTimeAgo } from '@hfos/core';
import * as React from 'react';
import { View } from 'react-native';

import { useBusiness } from '@/components/shell/business-context';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { handsCalls, type InHandsPerson } from '@/customers/hands';
import { errorMessage } from '@/lib/api';
import { useNetwork } from '@/lib/network';

/**
 * In your hands on a customer's page (core's messaging/hands.ts), the web's Details row in core's words: whether the
 * AI answers them or someone on the team has them, with Take over or Give back to the AI. It isn't in the phone's
 * copy, so it's asked for while there's signal and stays out of the way without.
 */
export function HandsCard({
  workspaceId,
  personId,
  name,
}: {
  workspaceId: string;
  personId: string;
  name: string;
}) {
  const { business, userId, viewing } = useBusiness();
  const { online } = useNetwork();
  const canChange = !viewing && holds(business, 'inbox.use');
  const calls = React.useMemo(() => handsCalls(workspaceId), [workspaceId]);
  const [got, setGot] = React.useState<{ hands: InHandsPerson | null } | null>(null);
  const [round, setRound] = React.useState(0);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (!online) return;
    let cancelled = false;
    calls
      .list({ personId, limit: 1 })
      .then((r) => {
        if (!cancelled) setGot({ hands: r.people[0] ?? null });
      })
      .catch(() => {
        // A side card: what can't load stays out of the way.
      });
    return () => {
      cancelled = true;
    };
  }, [online, calls, personId, round]);

  if (!got) return null;
  const hands = got.hands;

  async function act() {
    setBusy(true);
    try {
      if (hands) {
        await calls.giveBack({ personIds: [personId] });
        toast.show(W.gaveBackToast(1));
      } else {
        await calls.takeOver(personId);
        toast.show(W.tookOverToast(name));
      }
      setRound((r) => r + 1);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="gap-2 p-4" testID="hands-card">
      <Text className="text-[15px] font-semibold">{hands ? W.title : W.aiAnswers}</Text>
      <Text className="text-[13px] leading-[18px] text-text-2" testID="hands-card-line">
        {hands
          ? `${handsLine(hands, userId)} ${relativeTimeAgo(hands.lastAt)}. ${W.held}`
          : W.takeOverHint}
      </Text>
      {canChange ? (
        <View className="flex-row pt-1">
          <Button
            variant="secondary"
            size="sm"
            loading={busy}
            disabled={!online}
            onPress={() => void act()}
            testID={hands ? 'hands-card-give-back' : 'hands-card-take-over'}
          >
            {hands ? W.giveBack : W.takeOver}
          </Button>
        </View>
      ) : null}
    </Card>
  );
}
