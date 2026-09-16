import { router } from 'expo-router';
import * as React from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ChevronLeft } from '@/components/icons';
import { Icon } from '@/components/ui/icon';
import { cn } from '@/lib/utils';

/**
 * The frame of a sign-in screen: the page colour, an optional bar with Back, and the content padded as the boards
 * draw it (28 px above, 22 px at the sides). The content moves up with the keyboard.
 */
export function AuthScreen({
  back,
  children,
  footer,
  testID,
  className,
}: {
  back?: boolean;
  children: React.ReactNode;
  /** Sits at the bottom (a "use my password instead" button). */
  footer?: React.ReactNode;
  testID?: string;
  className?: string;
}) {
  const insets = useSafeAreaInsets();
  return (
    <View className="flex-1 bg-bg" testID={testID}>
      {back ? (
        <View className="border-b border-border bg-card" style={{ paddingTop: insets.top }}>
          <View className="h-[52px] flex-row items-center pl-0.5">
            <Pressable
              role="button"
              accessibilityLabel="Back"
              testID="back"
              onPress={() => (router.canGoBack() ? router.back() : router.replace('/sign-in'))}
              className="size-11 items-center justify-center rounded-full active:bg-card-2"
            >
              <Icon as={ChevronLeft} className="size-[22px] text-text-2" />
            </Pressable>
          </View>
        </View>
      ) : (
        <View className="bg-bg" style={{ height: insets.top }} />
      )}
      <KeyboardAvoidingView
        className="flex-1"
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          className="flex-1"
          contentContainerClassName={cn('grow gap-4 px-[22px] pt-7', className)}
          contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 16) + 24 }}
          keyboardShouldPersistTaps="handled"
        >
          {children}
          {footer ? (
            <>
              <View className="flex-1" />
              {footer}
            </>
          ) : null}
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}
