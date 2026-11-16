import type { BusinessRules } from '@hfos/core/addons/outreach/automation';
import {
  HANDS_OFF_KEYS,
  HANDS_OFF_WORDS as H,
  handsOffAllowed,
  NETWORK_PAGE_WORDS as P,
  type HandsOff,
} from '@hfos/core/addons/outreach/hands-off';
import {
  NETWORK_STATUS_WORDS as NS,
  networkTone,
  type NetworkStatus,
} from '@hfos/core/addons/outreach/network-status';
import type { Platform } from '@hfos/core/addons/outreach/networks';
import * as React from 'react';
import { Pressable, View } from 'react-native';

import { ChevronDown, ChevronUp } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';

import { Note } from './kit';

/**
 * The parts of a network's page in Settings on the phone that decision 170 brought (docs/outreach.md; the owner, 16 Nov
 * 2026), as on the web (apps/web/src/addons/outreach/network-settings.tsx): the status card at the top
 * (`networkStatus`), How hands-off? in place of the Sending, Replies and helpful posts lists (`withHandsOff`), and More
 * settings, folded, for the rest. Settings → You has How hands-off on every network.
 */

const TONE: Record<ReturnType<typeof networkTone>, { card: string; chip: string }> = {
  good: { card: 'border-border', chip: 'bg-success-soft text-success-text' },
  waiting: { card: 'border-border', chip: 'bg-accent-soft text-accent-text' },
  warn: { card: 'border-warning-soft', chip: 'bg-warning-soft text-warning-text' },
  plain: { card: 'border-border', chip: 'bg-card-2 text-text-2' },
};

/** The status card (decision 170): one of a few states, what's going on, and a button when there's something to do. */
export function NetworkStatusCard({
  status,
  onAct,
  onToday,
  testID,
}: {
  status: NetworkStatus;
  /** The card's button: Needs you, the person's computer, or Today. */
  onAct: ((act: NonNullable<NetworkStatus['act']>) => void) | null;
  onToday: (() => void) | null;
  testID: string;
}) {
  const tone = TONE[networkTone(status.state)];
  const act = status.act;
  const label =
    act === 'review'
      ? NS.review
      : act === 'people'
        ? NS.people
        : act === 'computer'
          ? NS.computer
          : act === 'today'
            ? NS.today
            : null;
  return (
    <Card className={cn('gap-2.5 border px-4 py-3.5', tone.card)} testID={testID}>
      <View className="flex-row flex-wrap items-center justify-between gap-2">
        <Text className="flex-1 text-[16px] font-semibold" testID={`${testID}-title`}>
          {status.title}
        </Text>
        <Text
          className={cn('rounded-md px-2 py-0.5 text-[12px] font-semibold', tone.chip)}
          testID={`${testID}-chip`}
        >
          {status.chip}
        </Text>
      </View>
      <Note testID={`${testID}-line`}>{status.line}</Note>
      <View className="flex-row flex-wrap gap-2">
        {act && label && onAct ? (
          <Button size="sm" variant="secondary" onPress={() => onAct(act)} testID={`${testID}-act`}>
            {label}
          </Button>
        ) : null}
        {onToday ? (
          <Button size="sm" variant="ghost" onPress={onToday} testID={`${testID}-today`}>
            {NS.seeWhat}
          </Button>
        ) : null}
      </View>
    </Card>
  );
}

/**
 * How hands-off? (decision 170): four buttons, safest first, two to a row, with a line under the one picked. A level
 * the business doesn't allow can't be pressed, and says so; choices that match none read as the person's own mix.
 */
export function HandsOffPart({
  platform,
  level,
  onPick,
  rules,
  manages,
  title = H.title,
  about,
  note,
  disabled = false,
  testID,
}: {
  /** The network it's for, for the line's words; null on Settings → You. */
  platform: Platform | null;
  level: HandsOff | null;
  onPick: (level: HandsOff) => void;
  rules: Pick<BusinessRules, 'sendingAllowed' | 'repliesAllowed' | 'autopilotAllowed'>;
  manages: boolean;
  title?: string;
  about?: string;
  note?: string | null;
  disabled?: boolean;
  testID: string;
}) {
  const shown = HANDS_OFF_KEYS.filter((l) => handsOffAllowed(l, rules) || l === level);
  const hidden = HANDS_OFF_KEYS.filter((l) => !shown.includes(l));
  return (
    <Card className="gap-3 px-4 py-4" testID={testID}>
      <View className="gap-1">
        <Text className="text-[16px] font-semibold">{title}</Text>
        {about ? <Note>{about}</Note> : null}
      </View>
      <View role="radiogroup" className="flex-row flex-wrap gap-2">
        {shown.map((l) => {
          const picked = level === l;
          const allowed = handsOffAllowed(l, rules);
          return (
            <Pressable
              key={l}
              role="radio"
              aria-checked={picked}
              disabled={disabled || !allowed}
              onPress={() => (picked ? undefined : onPick(l))}
              className={cn(
                'min-h-[56px] min-w-[46%] flex-1 justify-center gap-0.5 rounded-menu border px-3 py-2',
                picked ? 'border-accent bg-accent-soft' : 'border-border-strong bg-card',
                (disabled || !allowed) && 'opacity-50',
              )}
              testID={`${testID}-${l}`}
            >
              <Text className={cn('text-[14.5px] font-semibold', picked && 'text-accent-text')}>
                {H.levels[l]}
              </Text>
              <Text className={cn('text-[12px]', picked ? 'text-accent-text' : 'text-text-3')}>
                {H.short[l]}
              </Text>
            </Pressable>
          );
        })}
      </View>
      <Note testID={`${testID}-about`}>
        {level === null
          ? platform
            ? H.mixAbout
            : H.differs
          : H.about(level, platform ?? 'facebook')}
      </Note>
      {level === null && platform ? (
        <Text className="text-[13px] font-medium" testID={`${testID}-mix`}>
          {H.mix}
        </Text>
      ) : null}
      {note ? <Note testID={`${testID}-note`}>{note}</Note> : null}
      {hidden.length ? (
        <Note testID={`${testID}-not-allowed`}>
          {hidden.map((l) => H.notAllowed(l, manages)).join(' ')}
        </Note>
      ) : null}
    </Card>
  );
}

/** More settings (decision 170): folded to start, the rest of a network's choices inside. */
export function MoreSettings({
  name,
  helpful,
  testID,
  children,
}: {
  name: string;
  helpful: boolean;
  testID: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = React.useState(false);
  return (
    <Card className="px-4 py-1" testID={testID}>
      <Pressable
        role="button"
        aria-expanded={open}
        onPress={() => setOpen((o) => !o)}
        className="min-h-[52px] flex-row items-center justify-between gap-3"
        testID={`${testID}-toggle`}
      >
        <View className="flex-1 gap-0.5">
          <Text className="text-[16px] font-semibold">{P.more}</Text>
          {open ? null : <Note>{P.moreAbout(name, helpful)}</Note>}
        </View>
        <Icon as={open ? ChevronUp : ChevronDown} className="size-5 text-text-2" />
      </Pressable>
      {open ? <View className="gap-4 border-t border-border pb-4 pt-3">{children}</View> : null}
    </Card>
  );
}
