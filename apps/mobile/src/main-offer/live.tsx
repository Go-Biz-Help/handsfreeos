import {
  clearsBar,
  formatDate,
  MAIN_OFFER_BAR,
  MAIN_OFFER_TRY_WORDS as TW,
  MAIN_OFFER_WORDS as W,
  partSays,
  SCORED_PART_LABELS,
  SCORED_PARTS,
} from '@hfos/core';
import * as React from 'react';
import { View } from 'react-native';

import { Check, CircleAlert, Compass, Megaphone } from '@/components/icons';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';

import type { MainOffer } from './calls';
import { WithDirection } from './review';

type Live = NonNullable<MainOffer['live']>;

/**
 * The live version, to read (design/main-offer, 16): its line, each part with what's working and what's holding it
 * back, the owner's direction, and who uses it. For everyone who can't change the offer, as Settings → Main offer on
 * the web shows them.
 */
export function LiveOffer({
  live,
  direction,
  comesWith,
}: {
  live: Live;
  direction: string | null;
  comesWith: readonly string[];
}) {
  const clears = clearsBar(live.score);
  return (
    <>
      <Card className="gap-2.5 px-4 py-3.5" testID="main-offer-live">
        <View className="flex-row flex-wrap items-center justify-between gap-2">
          <Text className="text-[11.5px] font-semibold uppercase tracking-[0.46px] text-text-3">
            {W.liveLine(live.version, formatDate(live.publishedAt), live.publishedBy?.name ?? null)}
          </Text>
          <Badge variant={clears ? 'ok' : 'pending'}>
            {clears ? W.allClearBadge : W.underBarBadge}
          </Badge>
        </View>
        <Text className="text-[17px] font-medium leading-[25px]">{live.line}</Text>
        <View className="flex-row flex-wrap items-center gap-1.5">
          <Text className="text-[13.5px] text-text-3">{W.inMessages}</Text>
          {[live.parts.inAFewWords.outcome, live.parts.inAFewWords.guarantee]
            .filter((x): x is string => !!x?.trim())
            .map((x) => (
              <Badge key={x}>{x}</Badge>
            ))}
        </View>
      </Card>

      <Card testID="main-offer-parts">
        <Text className="px-4 py-3.5 text-[16px] font-semibold">{W.byPart}</Text>
        {SCORED_PARTS.map((p) => {
          const part = live.score.parts[p];
          const ok = part.score >= MAIN_OFFER_BAR;
          return (
            <View
              key={p}
              className="flex-row items-start gap-3 border-t border-border px-4 py-3"
              testID={`main-offer-part-${p}`}
            >
              <View className="min-w-0 flex-1 gap-1.5">
                <Text className="font-semibold">{SCORED_PART_LABELS[p]}</Text>
                <Text className="text-[13.5px] leading-[19px]">{partSays(live.parts, p)}</Text>
                {part.good?.map((g) => (
                  <View key={g} className="flex-row items-start gap-1.5">
                    <Icon
                      as={Check}
                      className="mt-0.5 size-3.5 text-success"
                      accessibilityLabel={TW.working}
                    />
                    <Text className="flex-1 text-[12.5px] text-text-2">{g}</Text>
                  </View>
                ))}
                {part.holding?.map((h) => (
                  <View key={h} className="flex-row items-start gap-1.5">
                    <Icon
                      as={CircleAlert}
                      className="mt-0.5 size-3.5 text-warning"
                      accessibilityLabel={TW.holding}
                    />
                    <Text className="flex-1 text-[12.5px] text-text-2">{h}</Text>
                  </View>
                ))}
                {part.followedDirection ? <WithDirection /> : null}
              </View>
              <Badge variant={ok ? 'ok' : 'pending'}>{part.score}</Badge>
            </View>
          );
        })}
      </Card>

      {direction ? (
        <Card className="gap-2 px-4 py-3.5" testID="main-offer-direction">
          <View className="flex-row items-center gap-2">
            <Icon as={Compass} className="size-4 text-accent-text" />
            <Text className="font-semibold">{TW.directionKept}</Text>
          </View>
          <Text className="text-[13.5px] leading-[19px]">{direction}</Text>
          <Text className="text-[12.5px] text-text-3">{TW.directionKeptHint}</Text>
        </Card>
      ) : null}

      <Card className="gap-2 px-4 py-3.5">
        <Text className="font-semibold">{W.usedBy}</Text>
        {comesWith.map((name) => (
          <View key={name} className="flex-row items-center gap-2">
            <Icon as={Megaphone} className="size-4 text-text-2" />
            <Text className="font-medium">{name}</Text>
          </View>
        ))}
        <Text className="text-[12.5px] text-text-3">{W.whoChanges}</Text>
      </Card>
    </>
  );
}
