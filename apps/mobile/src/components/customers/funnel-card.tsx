import { FUNNEL_PERSON_WORDS as W, funnelWhereWords, holds } from '@hfos/core';
import * as React from 'react';
import { View } from 'react-native';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { funnelCalls, type FunnelOfPersonOut } from '@/funnels/calls';
import { errorMessage } from '@/lib/api';
import { useGrants } from '@/lib/grants';
import { useNetwork } from '@/lib/network';

/**
 * A customer's funnel on the phone (HANDSFREEOS_TEAMMATE_FUNNELS_IMPLEMENTATION_PLAN.md, "The phone app"), the web's
 * line in core's words: which funnel and stage they're at and what it sends next, with Pause or Resume and Remove;
 * or the teammate's suggestion of one, with Yes and No. It's asked for while there's signal and stays out of the way
 * without, and for a customer in no funnel.
 */
export function FunnelCard({ workspaceId, personId }: { workspaceId: string; personId: string }) {
  const { online } = useNetwork();
  const canChange = holds(useGrants(), 'records.write');
  const calls = React.useMemo(() => funnelCalls(workspaceId), [workspaceId]);
  const [got, setGot] = React.useState<FunnelOfPersonOut | null>(null);
  const [round, setRound] = React.useState(0);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (!online) return;
    let cancelled = false;
    calls
      .ofPerson(personId)
      .then((r) => {
        if (!cancelled) setGot(r);
      })
      .catch(() => {
        // A side card: what can't load stays out of the way.
      });
    return () => {
      cancelled = true;
    };
  }, [online, calls, personId, round]);

  async function act(run: () => Promise<unknown>, done: string) {
    setBusy(true);
    try {
      await run();
      toast.show(done);
      setRound((r) => r + 1);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const current = got?.current;
  if (current) {
    const paused = current.status === 'paused';
    const next = current.next[0];
    return (
      <Card className="gap-2 p-4" testID="funnel-card">
        <Text className="text-[15px] font-semibold">{current.funnelName}</Text>
        <Text className="text-[13px] text-text-2" testID="funnel-card-where">
          {funnelWhereWords(
            current.stageName ?? 'their stage',
            current.booking ? { startsAt: new Date(current.booking.startsAt).getTime() } : null,
            got.timeZone,
          )}
        </Text>
        {paused ? (
          <Badge variant="pending">{W.paused(current.pausedReason)}</Badge>
        ) : next ? (
          <Text className="text-[13px] leading-[18px] text-text-2">
            {W.next(next.text, new Date(next.dueAt).getTime(), got.timeZone)}
          </Text>
        ) : null}
        {canChange ? (
          <View className="flex-row gap-2 pt-1">
            <Button
              variant="secondary"
              size="sm"
              disabled={busy}
              onPress={() =>
                void act(
                  () => calls.pause(current.id, !paused),
                  paused
                    ? W.resumedDone(current.funnelName, current.personName)
                    : W.pausedDone(current.funnelName, current.personName),
                )
              }
              testID="funnel-card-pause"
            >
              {paused ? W.resume : W.pause}
            </Button>
            <Button
              variant="ghostDanger"
              size="sm"
              disabled={busy}
              onPress={() =>
                void act(
                  () => calls.remove(current.id),
                  W.removedDone(current.funnelName, current.personName),
                )
              }
              testID="funnel-card-remove"
            >
              {W.remove(current.funnelName)}
            </Button>
          </View>
        ) : null}
      </Card>
    );
  }

  const suggestion = got?.suggestion;
  if (!suggestion) return null;
  return (
    <Card className="gap-2 p-4" testID="funnel-card-suggestion">
      <Text className="text-[13.5px] leading-[19px]">
        {W.suggested(suggestion.funnelName, suggestion.suggestedWhy)}
      </Text>
      {canChange ? (
        <View className="flex-row gap-2 pt-1">
          <Button
            size="sm"
            loading={busy}
            onPress={() =>
              void act(() => calls.decide(suggestion.id, true), W.addedDone(suggestion.funnelName))
            }
            testID="funnel-card-yes"
          >
            {W.yes}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onPress={() =>
              void act(
                () => calls.decide(suggestion.id, false),
                W.declinedDone(suggestion.funnelName),
              )
            }
            testID="funnel-card-no"
          >
            {W.no}
          </Button>
        </View>
      ) : null}
    </Card>
  );
}
