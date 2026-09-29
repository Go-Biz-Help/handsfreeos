import { TOUR_WORDS, tourStopWords, type TourStop } from '@hfos/core';
import * as React from 'react';
import { Modal, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useBusiness } from '@/components/shell/business-context';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';

/**
 * The bottom bar's first four tabs, in order; More is the fifth. Ask HandsFreeOS isn't on the bar, so the phone's
 * tour leaves it out, as the web's does at phone width.
 */
const STOPS: readonly TourStop[] = ['home', 'inbox', 'pipeline', 'calendar'];
/** The bar (components/shell/tab-bar.tsx): five tabs of equal width, 52 px tall above the phone's own inset. */
const TABS = 5;
const TAB_HEIGHT = 52;
const EDGE = 16;
const GAP = 14;

/**
 * The tour of the bottom bar on the phone (HANDSFREEOS_ONBOARDING_IMPLEMENTATION_PLAN.md §6, boards 7 and 10): each
 * tab lit in turn, with a card above it. Done or Skip tour records it as taken (`onboarding.set_view`), so the card
 * stops offering it, on the web too.
 */
export function PhoneTour({
  open,
  onClose,
  onTaken,
}: {
  open: boolean;
  onClose: () => void;
  /** Once it's recorded as taken. */
  onTaken: () => void;
}) {
  const { business } = useBusiness();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const [at, setAt] = React.useState(0);

  React.useEffect(() => {
    if (open) setAt(0);
  }, [open]);

  const end = () => {
    onClose();
    void api
      .POST('/v1/commands/onboarding.set_view', {
        body: { workspaceId: business.id, tourDone: true },
      })
      // Taken either way: it's only offered, never opened by itself.
      .catch(() => undefined)
      .then(onTaken);
  };

  const stop = STOPS[at]!;
  const words = tourStopWords(stop);
  const last = at === STOPS.length - 1;
  const inset = Math.max(insets.bottom, 6);
  const tab = width / TABS;
  const left = at * tab;
  const bar = inset + TAB_HEIGHT;

  return (
    <Modal
      transparent
      visible={open}
      animationType="fade"
      onRequestClose={end}
      statusBarTranslucent
      navigationBarTranslucent
    >
      {/* Dimmed everywhere but the lit tab. */}
      <View className="absolute left-0 right-0 top-0 bg-scrim" style={{ bottom: bar }} />
      <View className="absolute bottom-0 left-0 bg-scrim" style={{ height: bar, width: left }} />
      <View
        className="absolute bottom-0 right-0 bg-scrim"
        style={{ height: bar, left: left + tab }}
      />
      <View className="absolute bottom-0 bg-scrim" style={{ height: inset, left, width: tab }} />
      <View
        pointerEvents="none"
        className="absolute rounded-[10px] border-2 border-accent"
        style={{ bottom: inset, height: TAB_HEIGHT, left, width: tab }}
      />

      <View
        accessibilityViewIsModal
        testID="tour"
        className="absolute rounded-[14px] bg-card px-[18px] pb-3.5 pt-4"
        style={{ bottom: bar + GAP, left: EDGE, right: EDGE }}
      >
        <View
          className="absolute -bottom-[7px] size-3.5 rotate-45 rounded-[2px] bg-card"
          style={{ left: Math.min(Math.max(left + tab / 2 - EDGE - 7, 16), width - 2 * EDGE - 30) }}
        />
        <View className="flex-row items-center justify-between">
          <Text className="text-[11.5px] font-semibold uppercase tracking-[0.5px] text-text-3">
            {TOUR_WORDS.position(at + 1, STOPS.length)}
          </Text>
          <Button variant="ghost" size="sm" onPress={end} testID="tour-skip">
            {TOUR_WORDS.skip}
          </Button>
        </View>
        <Text className="mt-0.5 text-[17px] font-semibold" testID={`tour-stop-${stop}`}>
          {words.title}
        </Text>
        <Text className="mt-1.5 text-[13.5px] leading-[19px] text-text-2">{words.body}</Text>
        <View className="mt-3.5 flex-row items-center justify-between">
          <View className="flex-row gap-[5px]" aria-hidden>
            {STOPS.map((s, j) => (
              <View
                key={s}
                className={cn(
                  'h-1.5 rounded-full',
                  j === at ? 'w-4 bg-accent' : 'w-1.5 bg-border-strong',
                )}
              />
            ))}
          </View>
          <View className="flex-row gap-1.5">
            {at > 0 ? (
              <Button variant="ghost" size="sm" onPress={() => setAt(at - 1)} testID="tour-back">
                {TOUR_WORDS.back}
              </Button>
            ) : null}
            <Button
              size="sm"
              onPress={() => (last ? end() : setAt(at + 1))}
              testID={last ? 'tour-done' : 'tour-next'}
            >
              {last ? TOUR_WORDS.done : TOUR_WORDS.next}
            </Button>
          </View>
        </View>
      </View>
    </Modal>
  );
}
