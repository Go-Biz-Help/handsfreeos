import type { Href } from 'expo-router';
import * as React from 'react';
import { ScrollView, View } from 'react-native';

import { cn } from '@/lib/utils';

import { AppBar, type Leading } from './app-bar';
import { StatusStrip } from './status-strip';

/**
 * One screen of the signed-in app: the top bar, the status strip when there's something to say, then the content on
 * the page colour. Scrolls unless `scroll={false}`.
 */
export function Screen({
  title,
  leading,
  back,
  trailing,
  ask,
  scroll = true,
  contentClassName,
  header,
  children,
  testID,
}: {
  title?: string;
  leading?: Leading;
  back?: Href;
  trailing?: React.ReactNode;
  ask?: boolean;
  scroll?: boolean;
  contentClassName?: string;
  /** Sits between the strip and the scrolling content (Home's summary band). */
  header?: React.ReactNode;
  children?: React.ReactNode;
  testID?: string;
}) {
  return (
    <View className="flex-1 bg-bg" testID={testID}>
      <AppBar title={title} leading={leading} back={back} trailing={trailing} ask={ask} />
      <StatusStrip />
      {scroll ? (
        <ScrollView
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
