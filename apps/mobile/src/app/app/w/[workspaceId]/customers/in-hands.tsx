import { handsLine, HANDS_WORDS as W, holds, relativeTimeAgo } from '@hfos/core';
import { router, type Href } from 'expo-router';
import * as React from 'react';
import { Pressable, View } from 'react-native';

import { businessHref, useBusiness } from '@/components/shell/business-context';
import { Screen } from '@/components/shell/screen';
import { Avatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Segmented } from '@/components/ui/segmented';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { handsCalls, type InHandsOut } from '@/customers/hands';
import { errorMessage } from '@/lib/api';
import { useNetwork } from '@/lib/network';

/**
 * Contacts → In your hands (core's messaging/hands.ts), the web's list in core's words: everyone someone on the team
 * messaged or called themselves, or took over, newest first, so the AI leaves them alone. Everyone's or only mine,
 * with Give back to the AI on each and Give all back. It's asked for with signal: none of it is in the phone's copy.
 */
export default function InHands() {
  const { business, userId, viewing } = useBusiness();
  const { online } = useNetwork();
  const canChange = !viewing && holds(business, 'inbox.use');
  const calls = React.useMemo(() => handsCalls(business.id), [business.id]);
  const [mine, setMine] = React.useState<'everyone' | 'mine'>('everyone');
  const [got, setGot] = React.useState<InHandsOut | null>(null);
  const [round, setRound] = React.useState(0);
  const [busy, setBusy] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!online) return;
    let cancelled = false;
    calls
      .list({ mine: mine === 'mine', limit: 200 })
      .then((r) => {
        if (!cancelled) setGot(r);
      })
      .catch((e) => {
        if (!cancelled) toast.error(errorMessage(e));
      });
    return () => {
      cancelled = true;
    };
  }, [online, calls, mine, round]);

  async function back(which: string | 'all') {
    setBusy(which);
    try {
      const done = await calls.giveBack(
        which === 'all' ? { all: true, mine: mine === 'mine' } : { personIds: [which] },
      );
      toast.show(W.gaveBackToast(Math.max(1, done.handedBack)));
      setRound((r) => r + 1);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  const people = got?.people ?? [];
  return (
    <Screen title={W.title} leading="back" testID="in-hands">
      <View className="gap-3 pb-8">
        <Text className="text-[13px] leading-[18px] text-text-2">{W.about}</Text>
        <Segmented
          value={mine}
          onChange={setMine}
          label="Whose"
          options={[
            { value: 'everyone', label: W.everyone, testID: 'in-hands-everyone' },
            { value: 'mine', label: W.mine, testID: 'in-hands-mine' },
          ]}
        />
        {!online && !got ? (
          <Text className="py-10 text-center text-[13px] text-text-3" testID="in-hands-offline">
            This list needs signal. It shows once the phone is back online.
          </Text>
        ) : got && people.length === 0 ? (
          <Text className="py-10 text-center text-[13px] text-text-3" testID="in-hands-empty">
            {W.empty}
          </Text>
        ) : (
          <View className="rounded-card border border-border bg-card">
            {people.map((p, i) => (
              <View
                key={p.personId}
                className={`flex-row items-center gap-3 px-3.5 py-2.5 ${i > 0 ? 'border-t border-border' : ''}`}
                testID="in-hands-person"
              >
                <Pressable
                  role="button"
                  onPress={() =>
                    router.push(businessHref(business.id, `customers/people/${p.personId}`) as Href)
                  }
                  className="min-w-0 flex-1 flex-row items-center gap-3"
                >
                  <Avatar name={p.name} seed={p.personId} size="md" />
                  <View className="min-w-0 flex-1 gap-0.5">
                    <Text className="text-[15px] font-medium" numberOfLines={1}>
                      {p.name}
                    </Text>
                    <Text className="text-[12.5px] text-text-3" numberOfLines={2}>
                      {`${handsLine(p, userId)} · ${relativeTimeAgo(p.lastAt)}${p.waitingSince ? ` · ${W.waiting}` : ''}`}
                    </Text>
                  </View>
                </Pressable>
                {canChange ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    loading={busy === p.personId}
                    disabled={busy !== null || !online}
                    onPress={() => void back(p.personId)}
                    accessibilityLabel={`${W.giveBack}: ${p.name}`}
                    testID="in-hands-give-back"
                  >
                    {W.giveBack}
                  </Button>
                ) : null}
              </View>
            ))}
          </View>
        )}
        {got && got.total > people.length ? (
          <Text className="text-[12.5px] text-text-3">
            {`Showing the latest ${people.length} of ${got.total}.`}
          </Text>
        ) : null}
        {canChange && people.length ? (
          <Button
            variant="secondary"
            loading={busy === 'all'}
            disabled={busy !== null || !online}
            onPress={() => void back('all')}
            testID="in-hands-give-all-back"
          >
            {W.giveAllBack}
          </Button>
        ) : null}
      </View>
    </Screen>
  );
}
