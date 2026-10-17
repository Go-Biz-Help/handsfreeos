import {
  goingInto,
  lowestScore,
  MAIN_OFFER_BAR,
  MAIN_OFFER_PHONE_WORDS as PW,
  MAIN_OFFER_TRY_WORDS as TW,
  partSays,
  SCORED_PART_LABELS,
  SCORED_PARTS,
  type MainOfferScore,
  type ScoredPart,
} from '@hfos/core';
import * as React from 'react';
import { View } from 'react-native';

import { ArrowRight, ExternalLink, Lock, Sparkles } from '@/components/icons';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';

import type { MainOfferTry } from './calls';

/**
 * Try N is ready (design/main-offer, 13): how each part scored in the draft and in the try, a part kept as is, a blank
 * in [brackets] the owner fills in, and what the try followed. Comparing it and taking parts from it is the web's
 * (answered: compare on a computer); Compare on the web opens the builder on it.
 */

/** A blank the AI left for the owner ("[days]"): it never guesses a number. */
const blankIn = (words: string): string | null => /\[[^\]]+\]/.exec(words)?.[0] ?? null;

const scoreBadge = (n: number) => (
  <Badge variant={n >= MAIN_OFFER_BAR ? 'ok' : 'pending'}>{n}</Badge>
);

export function TryReady({
  made,
  draftScore,
  onCompare,
  onBack,
}: {
  made: MainOfferTry;
  draftScore: MainOfferScore | null;
  onCompare: () => void;
  onBack: () => void;
}) {
  const name = TW.tryName(made.number);
  const followed = goingInto(made.direction ?? '', made.notes, made.keep);
  const row = (p: ScoredPart) => {
    const label = SCORED_PART_LABELS[p];
    const to = made.score.parts[p].score;
    const from = draftScore?.parts[p].score ?? null;
    const blank = made.keep.includes(p) ? null : blankIn(partSays(made.parts, p));
    return (
      <View
        key={p}
        className="flex-row items-center gap-3 border-t border-border px-4 py-2.5"
        testID={`try-ready-${p}`}
      >
        <View className="min-w-0 flex-1">
          <Text className="font-medium">{label}</Text>
          {blank ? (
            <Text className="text-[12.5px] text-warning-text">{PW.blankForYou(blank)}</Text>
          ) : null}
        </View>
        {made.keep.includes(p) ? (
          <View className="h-[22px] flex-row items-center gap-1 rounded-[6px] bg-card-2 px-[7px]">
            <Icon as={Lock} className="size-3 text-text-2" />
            <Text className="text-xs font-medium text-text-2">{TW.keptAsIs}</Text>
          </View>
        ) : (
          <View
            className="flex-row items-center gap-1.5"
            accessible
            accessibilityLabel={
              from === null ? PW.tryScored(label, to) : PW.scoreFromTo(label, from, to)
            }
          >
            {from === null ? null : (
              <>
                {scoreBadge(from)}
                <Icon as={ArrowRight} className="size-3.5 text-text-3" />
              </>
            )}
            {scoreBadge(to)}
          </View>
        )}
      </View>
    );
  };

  return (
    <View className="gap-3.5" testID="try-ready">
      <View className="gap-2">
        <Text className="text-[11.5px] font-semibold uppercase tracking-[0.46px] text-text-3">
          {TW.versions}
        </Text>
        <Version
          name={TW.yourDraft}
          sub={draftScore ? TW.lowest(lowestScore(draftScore)) : TW.notScored}
        />
        <Version name={name} sub={TW.lowest(made.lowest)} current ai />
      </View>

      <Card>
        <View className="gap-1.5 p-4">
          <Text className="text-lg font-semibold tracking-[-0.18px]" role="heading">
            {PW.tryReady(name)}
          </Text>
          <Text className="text-[13.5px] leading-[19px] text-text-2">{PW.tryReadyHint}</Text>
        </View>
        {SCORED_PARTS.map(row)}
        {followed.length ? (
          <View className="gap-1.5 border-t border-border px-4 pb-4 pt-3">
            <Text className="text-[11.5px] font-semibold uppercase tracking-[0.46px] text-text-3">
              {TW.followed(name)}
            </Text>
            <View className="flex-row flex-wrap gap-1.5">
              {followed.map((g) => (
                <View
                  key={g.key}
                  className={cn(
                    'h-[22px] justify-center rounded-[6px] px-[7px]',
                    g.kept ? 'bg-card-2' : 'bg-accent-soft',
                  )}
                >
                  <Text
                    className={cn(
                      'text-xs font-medium',
                      g.kept ? 'text-text-2' : 'text-accent-text',
                    )}
                  >
                    {g.text}
                  </Text>
                </View>
              ))}
            </View>
          </View>
        ) : null}
      </Card>

      <View className="gap-2.5">
        <Button onPress={onCompare} testID="try-ready-compare">
          <Text className="text-[15px] font-medium text-white">{PW.compareOnWeb}</Text>
          <Icon as={ExternalLink} className="size-4 text-white" />
        </Button>
        <Button variant="secondary" onPress={onBack} testID="try-ready-back">
          {TW.backToReview}
        </Button>
        <Text className="text-center text-[12.5px] leading-[17px] text-text-3">
          {PW.compareNote(name)}
        </Text>
      </View>
    </View>
  );
}

function Version({
  name,
  sub,
  current = false,
  ai = false,
}: {
  name: string;
  sub: string;
  current?: boolean;
  ai?: boolean;
}) {
  return (
    <View
      className={cn(
        'min-h-14 flex-row items-center gap-3 rounded-menu border px-3.5 py-2',
        current ? 'border-accent bg-accent-soft' : 'border-border bg-card',
      )}
    >
      {ai ? <Icon as={Sparkles} className="size-4 text-accent-text" /> : null}
      <View className="flex-1">
        <Text className="font-semibold">{name}</Text>
        <Text className="text-[12.5px] tabular-nums text-text-2">{sub}</Text>
      </View>
    </View>
  );
}
