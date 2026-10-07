import {
  ONBOARDING_SETUP_STOP_NAMES,
  ONBOARDING_SETUP_WORDS as W,
  type OnboardingSetupStop,
} from '@hfos/core';
import * as React from 'react';
import { Platform, Pressable, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Check, Sparkles } from '@/components/icons';
import type { Leading } from '@/components/shell/app-bar';
import { useKeyboardHeight } from '@/components/shell/keyboard';
import { Screen } from '@/components/shell/screen';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Sheet } from '@/components/ui/sheet';
import { Text } from '@/components/ui/text';
import { ONBOARDING_SETUP_PHONE_WORDS as P } from '@/onboarding-setup/words';

/**
 * The onboarding setup's frame on the phone (HANDSFREEOS_ONBOARDING_QUICK_SETUP_IMPLEMENTATION_PLAN.md §8), as the
 * web's components/onboarding-setup/frame.tsx at phone size: the stop it's on and how far along, one screen's
 * question and its answers, Back and Next at the bottom, and the summary of the setup so far on a "See the summary"
 * sheet. Closing it is "Finish later": the answers so far are kept.
 */
export function SetupFrame({
  screen,
  progress,
  title,
  hint,
  banner,
  summary,
  footer,
  leading = 'close',
  trailing,
  scroller,
  children,
}: {
  /** The screen's key, for its testID: `onboarding-setup-step-goal`. */
  screen: string;
  progress: { readonly stop: OnboardingSetupStop; readonly at: number; readonly of: number };
  title: string;
  hint: string;
  /** Over the question: "Carry on where you left off". */
  banner?: React.ReactNode;
  /** The summary's lines; null where there's none (the last screen is the summary). */
  summary: readonly string[] | null;
  /** Back and Next, or nothing where the screen has its own buttons. */
  footer: React.ReactNode | null;
  leading?: Leading;
  trailing?: React.ReactNode;
  scroller?: React.RefObject<ScrollView | null>;
  children: React.ReactNode;
}) {
  const insets = useSafeAreaInsets();
  const keyboard = useKeyboardHeight();
  const [open, setOpen] = React.useState(false);
  const bottom = keyboard ? keyboard + (Platform.OS === 'android' ? insets.bottom : 0) : 0;
  return (
    <Screen
      title={W.position(progress.at, progress.of)}
      subtitle={ONBOARDING_SETUP_STOP_NAMES[progress.stop]}
      leading={leading}
      trailing={trailing}
      ask={false}
      scroll={false}
      testID="onboarding-setup"
    >
      <View
        className="h-1 bg-card-2"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={progress.of}
        aria-valuenow={progress.at}
      >
        <View
          className="h-full bg-accent"
          style={{ width: `${(progress.at / Math.max(progress.of, 1)) * 100}%` }}
        />
      </View>
      <View className="flex-1" style={{ paddingBottom: bottom }}>
        <ScrollView
          ref={scroller}
          className="flex-1"
          contentContainerClassName="gap-5 px-4 pb-8 pt-5"
          keyboardShouldPersistTaps="handled"
          testID="onboarding-setup-scroll"
        >
          {banner}
          <View className="gap-1.5" testID={`onboarding-setup-step-${screen}`}>
            <Text variant="heading">{title}</Text>
            {hint ? <Text variant="lead">{hint}</Text> : null}
          </View>
          {children}
          {summary ? (
            <Pressable
              role="button"
              onPress={() => setOpen(true)}
              className="flex-row items-center gap-1.5 self-start py-1.5"
              testID="onboarding-setup-see-summary"
            >
              <Icon as={Sparkles} className="size-3.5 text-accent-text" />
              <Text className="text-[13.5px] font-medium text-accent-text">{W.seeSummary}</Text>
            </Pressable>
          ) : null}
        </ScrollView>
        {footer ? (
          <View
            className="gap-2 border-t border-border bg-card px-4 pt-3"
            style={{ paddingBottom: keyboard ? 12 : Math.max(insets.bottom, 12) }}
          >
            {footer}
          </View>
        ) : (
          <View style={{ height: keyboard ? 0 : insets.bottom }} />
        )}
      </View>
      <Sheet
        open={open}
        onClose={() => setOpen(false)}
        title={W.summary}
        scroll
        testID="onboarding-setup-summary"
      >
        <View className="mt-3 gap-2">
          {(summary ?? []).map((line) => (
            <Text key={line} className="text-[14.5px] leading-[21px]">
              {line}
            </Text>
          ))}
        </View>
        <Button variant="secondary" className="mt-4" onPress={() => setOpen(false)}>
          {P.close}
        </Button>
      </Sheet>
    </Screen>
  );
}

/** What already works, on the last screen: one line each, ticked. */
export function DoneLines({ lines }: { lines: readonly string[] }) {
  return (
    <View className="gap-2.5" testID="onboarding-setup-done">
      {lines.map((line) => (
        <View
          key={line}
          className="flex-row items-start gap-2.5 rounded-menu bg-card-2 px-3.5 py-3"
        >
          <Icon as={Check} className="mt-0.5 size-4 text-success-text" strokeWidth={2} />
          <Text className="min-w-0 flex-1 text-[14.5px] leading-[20px]">{line}</Text>
        </View>
      ))}
    </View>
  );
}
