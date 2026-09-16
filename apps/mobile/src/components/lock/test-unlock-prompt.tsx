import * as React from 'react';
import { View } from 'react-native';

import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { testBiometrics } from '@/lib/biometrics';

/**
 * Test builds only (EXPO_PUBLIC_E2E=1): stands in for the phone's Face ID or fingerprint prompt, so Maestro can press
 * Match or No match. Drawn over the app rather than as a native modal: iOS doesn't always show a modal presented a
 * second time to UI tests.
 */
export function TestUnlockPrompt() {
  const asking = React.useSyncExternalStore(
    testBiometrics.subscribe,
    testBiometrics.isAsking,
    testBiometrics.isAsking,
  );
  if (!asking) return null;
  return (
    <View
      className="absolute inset-0 items-center justify-center bg-scrim px-8"
      accessibilityViewIsModal
    >
      <View className="w-full gap-3 rounded-dialog bg-card p-5" testID="test-unlock-prompt">
        <Text variant="sheetTitle">Test unlock</Text>
        <Text className="text-sm text-text-2">
          Stands in for Face ID or a fingerprint in test builds.
        </Text>
        <Button onPress={() => testBiometrics.answer('unlocked')} testID="test-unlock-match">
          Match
        </Button>
        <Button
          variant="secondary"
          onPress={() => testBiometrics.answer('failed')}
          testID="test-unlock-no-match"
        >
          No match
        </Button>
        <Button
          variant="ghost"
          onPress={() => testBiometrics.answer('cancelled')}
          testID="test-unlock-cancel"
        >
          Cancel
        </Button>
      </View>
    </View>
  );
}
