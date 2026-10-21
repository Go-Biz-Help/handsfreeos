import type { Href } from 'expo-router';
import * as React from 'react';
import { ScrollView, View } from 'react-native';

import { CheckInBanner } from '@/components/safety/check-in-banner';
import { ViewStrip } from '@/components/view-as/view-strip';
import { cn } from '@/lib/utils';

import { AppBar, type Leading } from './app-bar';
import { StatusStrip } from './status-strip';
import { touches } from './touches';

/**
 * One screen of the signed-in app: the top bar, the status strip when there's something to say, then the content on
 * the page colour. Scrolls unless `scroll={false}`. It tells the strip when a finger is on the screen, so the strip
 * opens and closes only once the finger lifts.
 */
export function Screen({
  title,
  subtitle,
  leading,
  back,
  trailing,
  ask,
  search,
  scroll = true,
  contentClassName,
  header,
  children,
  testID,
  scrollRef,
}: {
  title?: string;
  subtitle?: string;
  leading?: Leading;
  back?: Href;
  trailing?: React.ReactNode;
  ask?: boolean;
  /** Search everything's button in the top bar: on by default where the business mark leads. */
  search?: boolean;
  scroll?: boolean;
  contentClassName?: string;
  /** Sits between the strip and the scrolling content (Home's summary band). */
  header?: React.ReactNode;
  children?: React.ReactNode;
  testID?: string;
  /** The scrolling content, for a screen that scrolls to a row (settings search's flash). */
  scrollRef?: React.Ref<ScrollView>;
}) {
  return (
    <View
      className="flex-1 bg-bg"
      testID={testID}
      onTouchStart={touches.start}
      onTouchEnd={touches.end}
      onTouchCancel={touches.end}
    >
      <AppBar
        title={title}
        subtitle={subtitle}
        leading={leading}
        back={back}
        trailing={trailing}
        ask={ask}
        search={search}
      />
      <StatusStrip />
      <ViewStrip />
      {/* Checked in for showing safety: on every screen until they check out (round six). */}
      <CheckInBanner />
      {scroll ? (
        <ScrollView
          ref={scrollRef}
          className="flex-1"
          contentContainerClassName={cn('gap-3 p-3 pb-8', contentClassName)}
          keyboardShouldPersistTaps="handled"
        >
          {header}
          {children}
        </ScrollView>
      ) : (
        <View className={cn('flex-1', contentClassName)}>
          {header}
          {children}
        </View>
      )}
    </View>
  );
}
