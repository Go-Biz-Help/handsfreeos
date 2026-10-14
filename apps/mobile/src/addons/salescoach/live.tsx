import type { CardKind } from '@hfos/core/addons/salescoach/coach';
import { SALESCOACH_WORDS as W } from '@hfos/core/addons/salescoach/words';
import * as React from 'react';
import { View } from 'react-native';

import { Headset, ShieldAlert, Sparkles } from '@/components/icons';
import { useBusiness } from '@/components/shell/business-context';
import { Screen } from '@/components/shell/screen';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { openWebPath } from '@/home/open';
import { api, errorMessage, unwrap } from '@/lib/api';
import { useLiveAnswer } from '@/lib/live-answer';

/**
 * AI Sales Coach on the phone (docs/salescoach.md): the call the coach hears now, for a rep on their cell. The phone
 * belongs to the call, so the rep goes on speaker and opens this (the push about an objection brings them here too).
 * It asks again every few seconds while it's open, the newest card on top in big type, with where the call is in the
 * script. It needs signal: the call does too.
 */

/** How often the screen asks again during a call. */
export const LIVE_EVERY_SECONDS = 3;

const KIND_ICON: Record<CardKind, typeof Sparkles> = {
  objection: ShieldAlert,
  fact: Sparkles,
  step: Sparkles,
  question: Sparkles,
};

type Live = Awaited<ReturnType<typeof readLive>>;
type Call = NonNullable<Live['call']>;

const readLive = async (workspaceId: string) =>
  unwrap(await api.POST('/v1/queries/salescoach.live', { body: { workspaceId } }));

function CoachCard({
  workspaceId,
  card,
  top,
  onGone,
}: {
  workspaceId: string;
  card: Call['cards'][number];
  top: boolean;
  onGone: () => void;
}) {
  const dismiss = async () => {
    try {
      unwrap(
        await api.POST('/v1/commands/salescoach.card.dismiss', {
          body: { workspaceId, cardId: card.id },
        }),
      );
      onGone();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  return (
    <Card
      className={top ? 'gap-2 border-accent bg-accent-soft p-4' : 'gap-1.5 p-3.5'}
      testID="coach-card"
    >
      <View className="flex-row items-center gap-2">
        <Icon as={KIND_ICON[card.kind]} className="size-4 text-accent-text" />
        <Badge variant={card.kind === 'objection' ? 'pending' : 'accent'}>
          <Text>{W.cardKinds[card.kind]}</Text>
        </Badge>
        <Text className="flex-1 text-[15px] font-semibold" numberOfLines={1}>
          {card.title}
        </Text>
      </View>
      <Text className={top ? 'text-[20px] leading-[28px]' : 'text-[15px] leading-[21px]'}>
        {card.say}
      </Text>
      {top && card.heard ? (
        <Text className="text-[13px] text-text-3">
          {W.live.heard}: “{card.heard}”
        </Text>
      ) : null}
      <Button variant="ghost" size="sm" className="self-start" onPress={() => void dismiss()}>
        <Text>{W.live.dismiss}</Text>
      </Button>
    </Card>
  );
}

export function SalescoachLiveScreen() {
  const { business } = useBusiness();
  const ws = business.id;
  const live = useLiveAnswer(() => readLive(ws), `salescoach-live:${ws}`, W.live.none, {
    everySeconds: LIVE_EVERY_SECONDS,
  });
  const call = live.data?.call ?? null;
  const stop = async () => {
    if (!call) return;
    try {
      unwrap(
        await api.POST('/v1/commands/salescoach.call.stop', {
          body: { workspaceId: ws, coachedCallId: call.id },
        }),
      );
      live.reload();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  const steps = call?.playbook?.details.steps ?? [];
  const at = steps.findIndex((s) => s.id === call?.step);
  return (
    <Screen title={W.title} back="/app" testID="salescoach-live">
      {!call ? (
        <Card className="items-center gap-3 px-5 py-8" testID="coach-idle">
          <Icon as={Headset} className="size-6 text-text-3" />
          <Text className="text-center text-[15px] leading-[21px]">
            {live.error ?? W.live.none}
          </Text>
          <Text className="text-center text-[13.5px] leading-[19px] text-text-2">
            {W.live.noneHow}
          </Text>
        </Card>
      ) : (
        <View className="gap-3">
          <View className="flex-row items-center gap-2">
            <View
              className={
                call.state === 'live'
                  ? 'size-2 rounded-full bg-success'
                  : 'size-2 rounded-full bg-text-3'
              }
            />
            <Text className="font-semibold">
              {call.state === 'live'
                ? W.live.listening
                : call.state === 'writing'
                  ? W.live.writing
                  : call.state === 'stopped'
                    ? W.live.stopped
                    : W.live.ended}
            </Text>
            {call.person ? (
              <Text className="flex-1 text-right text-text-2" numberOfLines={1}>
                {call.person.name}
              </Text>
            ) : null}
          </View>
          {steps.length ? (
            <Text className="text-[13.5px] text-text-2" testID="coach-step">
              {W.live.step}: {(at >= 0 ? steps[at] : steps[0])!.title} ({Math.max(1, at + 1)}/
              {steps.length})
            </Text>
          ) : null}
          {call.state === 'stopped' ? null : call.cards.length ? (
            call.cards.map((c, i) => (
              <CoachCard key={c.id} workspaceId={ws} card={c} top={i === 0} onGone={live.reload} />
            ))
          ) : call.state === 'live' ? (
            <Text className="text-[14px] text-text-2">
              {call.playbook ? W.live.waiting : W.live.noPlaybook}
            </Text>
          ) : null}
          {call.state === 'live' ? (
            <Button variant="ghost" size="sm" className="self-start" onPress={() => void stop()}>
              <Text>{W.live.stop}</Text>
            </Button>
          ) : null}
          {call.state !== 'live' && call.state !== 'stopped' ? (
            <Button
              variant="secondary"
              onPress={() => openWebPath(`/app/w/${ws}/a/salescoach?view=calls&call=${call.id}`)}
            >
              <Text>{W.live.seeCall}</Text>
            </Button>
          ) : null}
        </View>
      )}
    </Screen>
  );
}
