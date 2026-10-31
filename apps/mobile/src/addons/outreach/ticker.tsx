import {
  tickerOf,
  tickerSeconds,
  TICKER_ASK_SECONDS,
  TICKER_WORDS as TW,
  WATCH_EVERY_SECONDS,
  type Ticker,
} from '@hfos/core/addons/outreach/tallies';
import * as React from 'react';
import {
  AccessibilityInfo,
  Animated,
  AppState,
  Easing,
  Pressable,
  ScrollView,
  View,
} from 'react-native';

import { Pause, Play } from '@/components/icons';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { api, unwrap } from '@/lib/api';
import { cn } from '@/lib/utils';

import { useOutreachAnswer, useOutreachContext } from './kit';

/**
 * The ticker along the bottom of every Social Outreach screen on the phone (docs/outreach.md, decision 140), as the
 * web's: what the person's computer is doing that very second, then today's newest steps going past like the news
 * line along the bottom of a TV (`outreach.ticker`, words from core's `tickerOf`). A tap holds it still, and so does
 * Reduce Motion, where the steps scroll by hand instead. Each person sees only their own.
 *
 * While it's on screen with the app open it says so every minute (`outreach.live.watch`), so the person's computer
 * tells what it's doing every few seconds, and it asks again every few seconds itself (`TICKER_ASK_SECONDS`): the
 * phone hears nothing live. The route's layout puts it under every screen.
 */
export function OutreachTicker() {
  const ctx = useOutreachContext();
  const ws = ctx.workspaceId;
  const answer = useOutreachAnswer(
    async () =>
      unwrap(await api.POST('/v1/queries/outreach.ticker', { body: { workspaceId: ws } })),
    `ticker:${ws}`,
    TW.label,
    { everySeconds: TICKER_ASK_SECONDS },
  );
  const { online } = ctx;
  React.useEffect(() => {
    if (!online) return;
    const watch = () => {
      if (AppState.currentState !== 'active') return;
      void api
        .POST('/v1/commands/outreach.live.watch', { body: { workspaceId: ws } })
        .catch(() => undefined);
    };
    watch();
    const t = setInterval(watch, WATCH_EVERY_SECONDS * 1000);
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') watch();
    });
    return () => {
      clearInterval(t);
      sub.remove();
    };
  }, [ws, online]);
  // Ticks on its own, so a computer that goes quiet shows offline without asking again.
  const [, setTick] = React.useState(0);
  React.useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 15_000);
    return () => clearInterval(t);
  }, []);
  const out = answer.data;
  if (!out) return null;
  // The server's clock, moved on by how long ago it answered.
  const now = Date.parse(out.now) + (answer.at ? Date.now() - answer.at : 0);
  return <TickerBody ticker={tickerOf(out, now)} />;
}

function useReduceMotion(): boolean {
  const [reduce, setReduce] = React.useState(false);
  React.useEffect(() => {
    let alive = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((v) => alive && setReduce(v));
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduce);
    return () => {
      alive = false;
      sub.remove();
    };
  }, []);
  return reduce;
}

const DOT = {
  live: 'bg-success',
  quiet: 'bg-text-3',
  warn: 'bg-warning',
} as const;

/** The ticker drawn from its words: the tests draw it with props. */
export function TickerBody({ ticker }: { ticker: Ticker }) {
  const reduce = useReduceMotion();
  const [paused, setPaused] = React.useState(false);
  const still = reduce || paused;
  // One copy's width: the words go past by that much, then start again, a second copy behind them.
  const [width, setWidth] = React.useState(0);
  const x = React.useRef(new Animated.Value(0)).current;
  const steps = ticker.steps.map((s) => s.at + s.line).join('\n');
  React.useEffect(() => {
    if (still || width <= 0) {
      x.stopAnimation();
      if (reduce) x.setValue(0);
      return;
    }
    const duration = tickerSeconds(width) * 1000;
    let run: Animated.CompositeAnimation | null = null;
    let gone = false;
    // Carries on from where it was held.
    x.stopAnimation((at) => {
      if (gone) return;
      const from = at > 0 || at <= -width ? 0 : at;
      x.setValue(from);
      const pass = (ms: number) =>
        Animated.timing(x, {
          toValue: -width,
          duration: ms,
          easing: Easing.linear,
          useNativeDriver: true,
        });
      run = Animated.sequence([
        pass(duration * ((width + from) / width)),
        Animated.loop(
          Animated.sequence([
            Animated.timing(x, { toValue: 0, duration: 0, useNativeDriver: true }),
            pass(duration),
          ]),
        ),
      ]);
      run.start();
    });
    return () => {
      gone = true;
      run?.stop();
    };
  }, [still, reduce, width, steps, x]);

  const line = (n: number) => (
    <View
      key={n}
      className="flex-row pr-8"
      onLayout={n === 0 ? (e) => setWidth(e.nativeEvent.layout.width) : undefined}
      importantForAccessibility={n === 1 ? 'no-hide-descendants' : undefined}
      accessibilityElementsHidden={n === 1}
    >
      {ticker.steps.map((s, i) => (
        <View key={i} className="mr-8 flex-row items-baseline gap-2">
          <Text className="text-[13px] text-text-3" numberOfLines={1}>
            {s.at}
          </Text>
          <Text className="text-[13px] text-text-2" numberOfLines={1}>
            {s.line}
          </Text>
        </View>
      ))}
    </View>
  );

  return (
    <View
      className="border-t border-border bg-card"
      testID="outreach-ticker"
      accessibilityLabel={TW.label}
    >
      <View className="min-h-11 flex-row items-center gap-2.5 px-3">
        <View
          className="flex-row items-center gap-1.5 rounded-full bg-card-2 px-2 py-0.5"
          testID="ticker-live"
        >
          <View className={cn('size-2 rounded-full', DOT[ticker.head.tone])} />
          <Text className="text-[11.5px] font-semibold uppercase tracking-[0.5px] text-text-2">
            {TW.live}
          </Text>
        </View>
        <Text
          className="min-w-0 flex-1 text-[13px] font-medium"
          numberOfLines={1}
          testID="ticker-head"
        >
          {ticker.head.words}
        </Text>
        {ticker.steps.length && !reduce ? (
          <Pressable
            role="button"
            accessibilityLabel={paused ? TW.play : TW.pause}
            accessibilityState={{ selected: paused }}
            onPress={() => setPaused((p) => !p)}
            hitSlop={8}
            className="size-8 items-center justify-center rounded-full active:bg-card-2"
            testID="ticker-pause"
          >
            <Icon as={paused ? Play : Pause} className="size-4 text-text-3" />
          </Pressable>
        ) : null}
      </View>
      <View className="overflow-hidden pb-2" testID="ticker-steps">
        {ticker.steps.length ? (
          <ScrollView
            horizontal
            scrollEnabled={reduce}
            showsHorizontalScrollIndicator={false}
            contentContainerClassName="px-3"
          >
            <Pressable onPress={() => setPaused((p) => !p)} disabled={reduce}>
              <Animated.View style={{ flexDirection: 'row', transform: [{ translateX: x }] }}>
                {reduce ? line(0) : [line(0), line(1)]}
              </Animated.View>
            </Pressable>
          </ScrollView>
        ) : (
          <Text className="px-3 text-[13px] text-text-3" numberOfLines={1}>
            {ticker.empty}
          </Text>
        )}
      </View>
    </View>
  );
}
