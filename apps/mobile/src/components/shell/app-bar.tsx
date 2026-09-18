import { router, type Href } from 'expo-router';
import * as React from 'react';
import { Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ChevronLeft, X } from '@/components/icons';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { businessMark, cn } from '@/lib/utils';

import { askHref, usePhonePageRecord } from '@/assistant/page-record';

import { BrandMark } from './brand';
import { businessHref, useOptionalBusiness } from './business-context';

export type Leading = 'business' | 'back' | 'close' | 'none';

/**
 * The top bar of every screen, as the phone boards draw it: the business mark at the left (it opens the switcher),
 * or Back or Close on a screen opened from another; the title; and Ask HandsFreeOS at the right, always one tap away.
 */
export function AppBar({
  title,
  subtitle,
  leading = 'business',
  back,
  trailing,
  ask = true,
  testID,
}: {
  title?: string;
  /** A second line under the title: "New customer · made 9:51 AM". */
  subtitle?: string;
  leading?: Leading;
  /** Where Back goes when there's no screen to go back to (opened from a link). */
  back?: Href;
  trailing?: React.ReactNode;
  ask?: boolean;
  testID?: string;
}) {
  const insets = useSafeAreaInsets();
  const ctx = useOptionalBusiness();
  // Ask HandsFreeOS is asked from somewhere: the customer, lead or conversation on screen goes with the question.
  const record = usePhonePageRecord(ctx?.business.id ?? '');
  const goBack = () => {
    if (router.canGoBack()) router.back();
    else if (back) router.replace(back);
    else if (ctx) router.replace(businessHref(ctx.business.id));
  };
  return (
    <View
      className="border-b border-border bg-card"
      style={{ paddingTop: insets.top }}
      testID={testID}
    >
      <View
        className={cn(
          'h-[52px] flex-row items-center pr-1.5',
          leading === 'business' ? 'pl-3' : 'pl-0.5',
        )}
      >
        {leading === 'business' && ctx ? (
          <Pressable
            role="button"
            accessibilityLabel={`Switch business. Now: ${ctx.business.name}`}
            testID="business-mark"
            hitSlop={5}
            onPress={ctx.openSwitcher}
            className="mr-2.5 size-[34px] items-center justify-center rounded-[9px] bg-accent-soft-2 active:opacity-80"
          >
            <Text className="text-xs font-bold tracking-[0.3px] text-accent-text">
              {businessMark(ctx.business.name)}
            </Text>
          </Pressable>
        ) : leading === 'back' || leading === 'close' ? (
          <Pressable
            role="button"
            accessibilityLabel={leading === 'back' ? 'Back' : 'Close'}
            testID={leading === 'back' ? 'back' : 'close'}
            onPress={goBack}
            className="size-11 items-center justify-center rounded-full active:bg-card-2"
          >
            <Icon as={leading === 'back' ? ChevronLeft : X} className="size-[22px] text-text-2" />
          </Pressable>
        ) : null}
        <View className="min-w-0 flex-1">
          <Text
            role="heading"
            numberOfLines={1}
            className="text-[17px] font-semibold tracking-[-0.17px]"
            testID="app-bar-title"
          >
            {title ?? ''}
          </Text>
          {subtitle ? (
            <Text numberOfLines={1} className="text-xs text-text-3" testID="app-bar-subtitle">
              {subtitle}
            </Text>
          ) : null}
        </View>
        {trailing}
        {ask && ctx ? (
          <Pressable
            role="button"
            accessibilityLabel="Ask HandsFreeOS"
            testID="ask-handsfreeos"
            onPress={() => router.push(askHref(ctx.business.id, record) as Href)}
            className="size-11 items-center justify-center rounded-full active:bg-card-2"
          >
            <BrandMark size={24} />
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}
