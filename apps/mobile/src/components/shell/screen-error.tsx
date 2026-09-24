import type { ErrorBoundaryProps } from 'expo-router';
import * as React from 'react';
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';

/** Enough of the error to say what broke, never a wall of text. */
const DETAIL_MAX = 300;

/** The error's own words, whatever was thrown. */
export function errorDetail(error: unknown): string {
  const text =
    error instanceof Error ? error.message || error.name : String(error ?? 'Unknown error');
  return text.length > DETAIL_MAX ? `${text.slice(0, DETAIL_MAX - 1)}…` : text;
}

/**
 * What a screen shows when drawing it threw, in place of the app closing. Routes export it as `ErrorBoundary`.
 *
 * Without it, one screen that can't draw closes the whole app: React hands the error to React Native as fatal, and
 * expo-updates, which is watching the first seconds after launch, aborts once it has no older update to go back to.
 * TestFlight build 8 did that on 23 September (a card kind it didn't know) and build 9 the same night, each within two
 * seconds of opening, with nothing on the phone saying why. Here the rest of the app keeps working, Try again draws
 * the screen afresh (the copy may have changed since), and the error's words are on screen to pass on.
 */
export function ScreenError({ error, retry }: ErrorBoundaryProps) {
  const insets = useSafeAreaInsets();
  return (
    <View
      className="flex-1 items-center justify-center gap-3 bg-bg px-8"
      style={{ paddingTop: insets.top, paddingBottom: insets.bottom }}
      testID="screen-error"
    >
      <Text variant="heading" className="text-center">
        This screen didn’t open
      </Text>
      <Text className="text-center leading-[22px] text-text-2">
        Nothing on this phone was lost. Try again, and if it keeps happening, send us the words
        below.
      </Text>
      <Text variant="small" selectable className="text-center" testID="screen-error-detail">
        {errorDetail(error)}
      </Text>
      <Button onPress={() => void retry()} testID="screen-error-retry">
        Try again
      </Button>
    </View>
  );
}
