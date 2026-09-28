import { ADDON_STATE_WORDS, type AddonStateWords } from '@hfos/core';
import * as React from 'react';
import { ActivityIndicator, Pressable, View } from 'react-native';

import { ChevronRight, CloudOff, Puzzle } from '@/components/icons';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import type { AddonView } from '@/add-ons/rules';
import { ADDON_PHONE_WORDS } from '@/add-ons/words';
import { cn } from '@/lib/utils';
import { useColors } from '@/theme';

/**
 * The small pieces the Add-ons screens share: an add-on's square, where it stands in core's words (with a spinner
 * while the worker is still moving it), one row of the list, a coloured note, and the two cards a live screen shows
 * before it has anything (getting it, or needing signal).
 */

type Tone = AddonStateWords['tone'];

const BADGE: Readonly<Record<Tone, 'ok' | 'gray' | 'accent' | 'member'>> = {
  on: 'ok',
  off: 'gray',
  busy: 'accent',
  gone: 'member',
};

/** Where it stands: "On", "Off", "Setting up" with a spinner, "Uninstalled"; or Coming soon for a planned one. */
export function StateBadge({ view, testID }: { view: AddonView; testID?: string }) {
  const colors = useColors();
  if (!view.state)
    return view.offer === 'coming_soon' ? (
      <Badge variant="gray" testID={testID}>
        <Text>{ADDON_PHONE_WORDS.comingSoon}</Text>
      </Badge>
    ) : null;
  const words = ADDON_STATE_WORDS[view.state];
  return (
    <Badge variant={BADGE[words.tone]} testID={testID}>
      {words.tone === 'busy' ? (
        <ActivityIndicator
          size="small"
          color={colors.accentText}
          style={{ transform: [{ scale: 0.7 }] }}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
        />
      ) : null}
      <Text>{words.label}</Text>
    </Badge>
  );
}

const TILE: Readonly<Record<Tone | 'new', { bg: string; fg: string }>> = {
  on: { bg: 'bg-accent-soft', fg: 'text-accent-text' },
  busy: { bg: 'bg-accent-soft', fg: 'text-accent-text' },
  off: { bg: 'bg-card-2', fg: 'text-text-2' },
  gone: { bg: 'bg-card-2', fg: 'text-text-3' },
  new: { bg: 'bg-card-2', fg: 'text-text-2' },
};

/** An add-on's square: blue while it's on or on its way, grey otherwise. */
export function AddonTile({
  state,
  size = 'md',
}: {
  state: AddonView['state'];
  size?: 'md' | 'lg';
}) {
  const look = TILE[state ? ADDON_STATE_WORDS[state].tone : 'new'];
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      className={cn(
        'shrink-0 items-center justify-center',
        size === 'lg' ? 'size-[42px] rounded-menu' : 'size-[34px] rounded-control',
        look.bg,
      )}
    >
      <Icon
        as={Puzzle}
        strokeWidth={1.75}
        className={cn(size === 'lg' ? 'size-5' : 'size-[17px]', look.fg)}
      />
    </View>
  );
}

/**
 * One add-on in the list: its square, its name and what it's for, why its last move hasn't finished or how it could
 * be added, then where it stands and a chevron to its own screen.
 */
export function AddonRow({
  view,
  onPress,
  testID,
}: {
  view: AddonView;
  onPress: () => void;
  testID?: string;
}) {
  const state = view.state ? ADDON_STATE_WORDS[view.state].label : null;
  // Its trouble, first; else that HandsFreeOS switched it off, or how it could come here when that isn't Install.
  const note =
    view.trouble[0] ??
    (view.state === 'enabled' && !view.running && !view.retired
      ? ADDON_PHONE_WORDS.paused(view.name)
      : view.offer === 'paid'
        ? ADDON_PHONE_WORDS.paid
        : view.offer === 'support'
          ? ADDON_PHONE_WORDS.support
          : null);
  return (
    <Pressable
      role="button"
      accessibilityLabel={[
        view.name,
        state ?? (view.offer === 'coming_soon' ? ADDON_PHONE_WORDS.comingSoon : null),
        view.summary,
        note,
      ]
        .filter(Boolean)
        .join('. ')}
      onPress={onPress}
      testID={testID}
      className="min-h-14 flex-row items-center gap-3 px-4 active:bg-card-2"
    >
      <AddonTile state={view.state} />
      <View className="min-w-0 flex-1 gap-px py-2.5">
        <Text className="text-base" numberOfLines={1}>
          {view.name}
        </Text>
        {view.summary ? (
          <Text className="text-[13px] leading-[18px] text-text-3" numberOfLines={2}>
            {view.summary}
          </Text>
        ) : null}
        {note ? (
          <Text
            className={cn(
              'text-[13px] leading-[18px]',
              view.trouble.length ? 'text-warning-text' : 'text-text-2',
            )}
            numberOfLines={2}
          >
            {note}
          </Text>
        ) : null}
      </View>
      <StateBadge view={view} />
      <Icon as={ChevronRight} className="size-4 text-text-3" />
    </Pressable>
  );
}

const NOTE = {
  danger: { bg: 'bg-danger-soft', fg: 'text-danger-text' },
  warning: { bg: 'bg-warning-soft', fg: 'text-warning-text' },
  info: { bg: 'bg-card-2', fg: 'text-text-2' },
} as const;

/** A coloured note: why a move hasn't finished, what support can do, what only an owner may do. */
export function Note({
  tone,
  lines,
  children,
  testID,
}: {
  tone: keyof typeof NOTE;
  lines: readonly string[];
  children?: React.ReactNode;
  testID?: string;
}) {
  const look = NOTE[tone];
  return (
    <View
      className={cn('gap-1 rounded-[10px] px-3 py-[11px]', look.bg)}
      role={tone === 'info' ? undefined : 'alert'}
      testID={testID}
    >
      {lines.map((line) => (
        <Text key={line} className={cn('text-[13px] leading-[19px]', look.fg)}>
          {line}
        </Text>
      ))}
      {children}
    </View>
  );
}

/** While the first answer is on its way. */
export function AddonsLoading({ testID }: { testID?: string }) {
  return (
    <Card className="items-center gap-2 px-5 py-8" testID={testID ?? 'add-ons-loading'}>
      <Icon as={Puzzle} className="size-6 text-text-3" />
      <Text className="text-[14.5px] text-text-2">{ADDON_PHONE_WORDS.loading}</Text>
    </Card>
  );
}

/** Nothing to show: no signal, or HandsFreeOS said no. Try again asks once more. */
export function AddonsNeedSignal({
  error,
  onRetry,
  testID,
}: {
  error: string | null;
  onRetry: () => void;
  testID?: string;
}) {
  return (
    <Card className="items-center gap-3 px-5 py-8" testID={testID ?? 'add-ons-error'}>
      <Icon as={CloudOff} className="size-6 text-text-3" />
      <Text className="text-center text-[14.5px] leading-[21px] text-text-2">
        {error ?? ADDON_PHONE_WORDS.needsSignal}
      </Text>
      <Button variant="secondary" className="self-stretch" onPress={onRetry} testID="add-ons-retry">
        {ADDON_PHONE_WORDS.retry}
      </Button>
    </Card>
  );
}
