import {
  MAIN_OFFER_WORDS as W,
  SCORED_PART_LABELS,
  underBar,
  type MainOfferScore,
} from '@hfos/core';
import * as React from 'react';
import { View } from 'react-native';

import { TriangleAlert } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Input } from '@/components/ui/input';
import { Sheet } from '@/components/ui/sheet';
import { Text } from '@/components/ui/text';

/**
 * Use it anyway (design/main-offer, 15), as the web's dialog: going live under the bar takes a reason, kept with the
 * version so everyone sees why later.
 */
export function AnywaySheet({
  open,
  onClose,
  score,
  busy,
  onGo,
}: {
  open: boolean;
  onClose: () => void;
  score: MainOfferScore;
  busy: boolean;
  onGo: (why: string) => void;
}) {
  const [why, setWhy] = React.useState('');
  const [lowest] = underBar(score);
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={W.anywayTitle}
      description={
        lowest ? W.anywayScored(SCORED_PART_LABELS[lowest], score.parts[lowest].score) : undefined
      }
      testID="offer-anyway"
    >
      <View className="gap-3.5">
        <View className="flex-row items-start gap-2.5 rounded-menu bg-warning-soft px-3.5 py-3">
          <Icon as={TriangleAlert} className="mt-0.5 size-4 text-warning-text" />
          <Text className="flex-1 text-[14px] leading-[20px] text-warning-text">
            {W.anywayNote}
          </Text>
        </View>
        <View className="gap-2">
          <Text className="text-[14px] font-medium" nativeID="offer-anyway-label">
            {W.anywayWhy}
          </Text>
          <Input
            value={why}
            onChangeText={setWhy}
            maxLength={300}
            placeholder={W.anywayPlaceholder}
            accessibilityLabelledBy="offer-anyway-label"
            testID="offer-anyway-why"
          />
          <Text className="text-[12.5px] text-text-3">{W.anywayHint}</Text>
        </View>
        <Button
          variant="secondary"
          disabled={!why.trim()}
          loading={busy}
          onPress={() => onGo(why.trim())}
          testID="offer-anyway-go"
        >
          {W.anywayGo}
        </Button>
        <Button variant="ghost" onPress={onClose}>
          {W.cancel}
        </Button>
      </View>
    </Sheet>
  );
}
