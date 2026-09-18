import { router, type Href } from 'expo-router';
import type { LucideIcon } from 'lucide-react-native';
import * as React from 'react';
import { Pressable, View } from 'react-native';

import { ChevronRight } from '@/components/icons';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { routeFor } from '@/links/route-map';
import { openWeb } from '@/lib/open-web';
import { cn } from '@/lib/utils';

/**
 * The pieces every answer card is built from, as the web's `card-parts.tsx` builds them: the card itself, its rows,
 * the round icon at its head, and the line under one that did something. Rows are 48 px, so a finger can hit them.
 */

export function CardShell({
  children,
  className,
  testID,
}: {
  children: React.ReactNode;
  className?: string;
  testID?: string;
}) {
  return (
    <View
      testID={testID}
      className={cn('overflow-hidden rounded-card border border-border bg-card', className)}
    >
      {children}
    </View>
  );
}

export function CardHead({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <View className={cn('flex-row items-center gap-2.5 px-3.5 py-3', className)}>{children}</View>
  );
}

export function CardTitle({ children }: { children: React.ReactNode }) {
  return (
    <Text className="min-w-0 flex-1 text-[15px] font-semibold leading-[20px]">{children}</Text>
  );
}

/** A card's own row, split from what's above it by a hairline. */
export function CardRow({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <View
      className={cn(
        'min-h-12 flex-row items-center gap-2.5 border-t border-border px-3.5 py-2.5',
        className,
      )}
    >
      {children}
    </View>
  );
}

/** Where a card's row goes: the phone's own screen for it, or the web for the desk work it leaves out. */
export function openAppPath(path: string): void {
  const target = routeFor(path);
  if (target.kind === 'screen') router.push(target.href as Href);
  else void openWeb(path);
}

/** A row that opens a page. */
export function RowLink({
  href,
  children,
  testID,
}: {
  href: string;
  children: React.ReactNode;
  testID?: string;
}) {
  return (
    <Pressable
      role="link"
      testID={testID}
      onPress={() => openAppPath(href)}
      className="min-h-12 flex-row items-center gap-2.5 border-t border-border px-3.5 py-2.5 active:bg-card-2"
    >
      {children}
      <Icon as={ChevronRight} className="size-4 shrink-0 text-text-3" />
    </Pressable>
  );
}

/** The accent-coloured words on a row that only opens something ("Open lead"). */
export function LinkLabel({ children }: { children: string }) {
  return (
    <Text numberOfLines={1} className="min-w-0 flex-1 font-medium text-accent-text">
      {children}
    </Text>
  );
}

const TILE = {
  accent: 'bg-accent-soft',
  success: 'bg-success-soft',
  warning: 'bg-warning-soft',
  danger: 'bg-danger-soft',
  neutral: 'bg-card-2',
} as const;
const TILE_ICON: Record<keyof typeof TILE, string> = {
  accent: 'text-accent-text',
  success: 'text-success-text',
  warning: 'text-warning-text',
  danger: 'text-danger-text',
  neutral: 'text-text-2',
};

/** The round icon at the start of a card. */
export function Tile({
  icon,
  tone,
  size = 32,
}: {
  icon: LucideIcon;
  tone: keyof typeof TILE;
  size?: 32 | 40;
}) {
  return (
    <View
      className={cn(
        'shrink-0 items-center justify-center rounded-full',
        size === 40 ? 'size-10' : 'size-8',
        TILE[tone],
      )}
    >
      <Icon
        as={icon}
        className={cn(size === 40 ? 'size-[18px]' : 'size-[15px]', TILE_ICON[tone])}
      />
    </View>
  );
}

const DOT_TONE = {
  accent: 'bg-accent',
  warning: 'bg-warning',
  danger: 'bg-danger',
  muted: 'bg-border-strong',
} as const;

export function Dot({ tone }: { tone: keyof typeof DOT_TONE }) {
  return <View className={cn('size-2 shrink-0 rounded-full', DOT_TONE[tone])} />;
}

/** The line under a card once it's answered: done, not done, or stopped by a rule. */
export function Result({
  tone,
  icon,
  children,
  action,
  testID,
}: {
  tone: 'ok' | 'no' | 'bad';
  icon: LucideIcon;
  children: React.ReactNode;
  action?: React.ReactNode;
  testID?: string;
}) {
  const box = tone === 'ok' ? 'bg-success-soft' : tone === 'bad' ? 'bg-danger-soft' : 'bg-card-2';
  const text =
    tone === 'ok' ? 'text-success-text' : tone === 'bad' ? 'text-danger-text' : 'text-text-2';
  return (
    <View
      role="status"
      testID={testID ?? 'assistant-result'}
      className={cn(
        'min-h-11 flex-row items-center gap-2 border-t border-border px-3.5 py-2.5',
        box,
      )}
    >
      <Icon as={icon} className={cn('size-4 shrink-0', text)} />
      <Text className={cn('min-w-0 flex-1 text-[13px] leading-[18px]', text)}>{children}</Text>
      {action}
    </View>
  );
}
