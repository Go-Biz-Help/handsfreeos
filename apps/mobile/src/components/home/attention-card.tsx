import {
  ATTENTION_KIND_LABELS,
  ATTENTION_WORDS,
  autoActionAt,
  cardChipsOf,
  firstNameOr,
  goesStripWords,
  handleButtonOf,
  isDraftItem,
  letHandleOffReason,
  splitItemTitle,
  type AttentionItemOut,
  type TeammateDraftShape,
} from '@hfos/core';
import * as React from 'react';
import { Pressable, View } from 'react-native';

import { useAiColors, useDraftDecision } from '@/components/drafts';
import { CircleAlert, Ellipsis, Zap } from '@/components/icons';
import { BrandMark } from '@/components/shell/brand';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { changes } from '@/changes';
import { cn } from '@/lib/utils';
import { HOME_PHONE_WORDS, refusedLine } from '@/home/words';
import { useColors, useThemeName } from '@/theme';
import { shadows } from '@/theme/tokens';

import { AssigneeMark, Chips, HANDLE_ICONS, KindLabel, KindTile } from './bits';
import { useHomeEnv } from './home-context';

type Item = AttentionItemOut;

/** An urgent card's edge and soft ring, as the web mixes them. */
const URGENT = {
  light: { border: '#dfa29f', ring: '#ffebe9b3' },
  dark: { border: '#805152', ring: '#301816b3' },
} as const;

/** The card's frame: the card colour, a hairline, the 12 px radius, and red when it's urgent. */
export function CardFrame({
  urgent,
  highlight,
  children,
  testID,
}: {
  urgent?: boolean;
  highlight?: boolean;
  children: React.ReactNode;
  testID: string;
}) {
  const theme = useThemeName();
  const colors = useColors();
  const ring = urgent ? `0 0 0 3px ${URGENT[theme].ring}, ` : '';
  return (
    <View
      testID={testID}
      className="gap-[3px] rounded-card border bg-card p-3.5"
      style={{
        borderColor: highlight ? colors.accent : urgent ? URGENT[theme].border : colors.border,
        borderWidth: highlight ? 2 : 1,
        boxShadow: `${ring}${shadows[theme].shadow1}`,
      }}
    >
      {children}
    </View>
  );
}

/** ⋯ on a card: a 44 px square that opens the item's sheet. */
export function MoreButton({ onPress }: { onPress: () => void }) {
  return (
    <Pressable
      role="button"
      accessibilityLabel="More"
      testID="attention-more"
      onPress={onPress}
      className="size-11 shrink-0 items-center justify-center rounded-control border border-border-strong bg-card active:bg-card-2"
    >
      <Icon as={Ellipsis} className="size-[18px] text-text-2" />
    </Pressable>
  );
}

/** Let HandsFreeOS Handle, greyed out where it can't (approvals, tasks). */
export function LetHandleButton({ item, className }: { item: Item; className?: string }) {
  const env = useHomeEnv();
  const off = letHandleOffReason(item);
  return (
    <Pressable
      role="button"
      accessibilityLabel={off ? `${ATTENTION_WORDS.letHandle}. ${off}` : ATTENTION_WORDS.letHandle}
      accessibilityState={{ disabled: !!off }}
      testID="attention-let-handle"
      onPress={off ? undefined : () => env.act.letHandle(item)}
      className={cn(
        'h-11 flex-row items-center justify-center gap-2 rounded-menu border border-border-strong bg-card px-3',
        off ? 'opacity-50' : 'active:bg-card-2',
        className,
      )}
    >
      <BrandMark size={16} />
      <Text numberOfLines={1} className="text-[14.5px] font-medium">
        {ATTENTION_WORDS.letHandle}
      </Text>
    </Pressable>
  );
}

/** Approve, for an AI teammate's draft: decided through the drafts' own hook, so it waits for signal like any change. */
function ApproveDraftButton({
  draft,
  label,
  className,
  variant,
}: {
  draft: TeammateDraftShape;
  label: string;
  className?: string;
  variant?: 'primary' | 'secondary';
}) {
  const env = useHomeEnv();
  const d = useDraftDecision({
    workspaceId: env.workspaceId,
    draft,
    who: firstNameOr(draft.person?.fullName, 'them'),
  });
  return (
    <Button
      icon={HANDLE_ICONS.check}
      variant={variant}
      loading={d.busy === 'approve'}
      disabled={!draft.canDecide}
      onPress={() => {
        d.approve();
        // The card leaves at once (the decision stands in for the draft), so Home says what it did, in the web's words.
        const done = ATTENTION_WORDS.approvedToast(
          env.teammateName,
          firstNameOr(draft.person?.fullName, 'them'),
        );
        toast.show(env.online ? done : HOME_PHONE_WORDS.queued(done));
      }}
      className={className}
      testID="attention-handle"
    >
      {label}
    </Button>
  );
}

/** The main button: it fits the item (Call Maria, Reply, Confirm by text, Approve, Open task). */
export function HandleButton({
  item,
  variant = 'primary',
  className,
}: {
  item: Item;
  variant?: 'primary' | 'secondary';
  className?: string;
}) {
  const env = useHomeEnv();
  if (!item.actions.handle) return null;
  const look = handleButtonOf(item, true);
  const draft =
    item.kind === 'ai_approval' && isDraftItem(item) ? env.drafts.get(item.subject.id) : undefined;
  if (draft)
    return (
      <ApproveDraftButton
        draft={draft}
        label={look.label}
        variant={variant}
        className={className}
      />
    );
  const calls = look.icon === 'phone';
  return (
    <Button
      icon={HANDLE_ICONS[look.icon]}
      variant={variant}
      disabled={calls && !env.online}
      onPress={() => env.act.handle(item)}
      className={className}
      testID="attention-handle"
    >
      {look.label}
    </Button>
  );
}

/** "HandsFreeOS will follow up at 9:05 AM · Cancel": the card stays until it goes, so you can still act first. */
function GoesStrip({ item, at }: { item: Item; at: number | null }) {
  const env = useHomeEnv();
  const words = at === null ? null : goesStripWords(item, at, env.timeZone);
  return (
    <View
      testID="attention-goes"
      className="mt-2.5 flex-row items-center gap-2.5 rounded-[10px] bg-accent-soft px-3.5 py-[11px]"
    >
      <Icon as={Zap} strokeWidth={1.75} className="size-4 text-accent-text" />
      <Text className="min-w-0 flex-1 text-[13.5px] text-accent-text">
        {words ? (
          <>
            <Text className="text-[13.5px] font-semibold text-accent-text">{words.strong}</Text>
            {words.rest}
          </>
        ) : (
          HOME_PHONE_WORDS.handingOnline
        )}
      </Text>
      {words ? (
        <Pressable
          role="button"
          hitSlop={10}
          testID="attention-cancel-auto"
          onPress={() => env.act.cancelAuto(item)}
        >
          <Text className="text-[13.5px] font-semibold text-accent-text underline">
            {ATTENTION_WORDS.cancel}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/** A change made here that HandsFreeOS refused: why, in its words, and OK to clear it. */
function RefusedNote({ itemId }: { itemId: string }) {
  const env = useHomeEnv();
  const change = env.refused.get(itemId);
  if (!change) return null;
  return (
    <View
      role="alert"
      testID="attention-refused"
      className="mt-2.5 flex-row items-start gap-2.5 rounded-[10px] bg-danger-soft px-3 py-2.5"
    >
      <Icon as={CircleAlert} strokeWidth={1.75} className="mt-px size-4 text-danger-text" />
      <Text
        className="min-w-0 flex-1 text-[13px] leading-[19px] text-danger-text"
        testID="attention-refused-text"
      >
        {refusedLine(change)}
      </Text>
      <Pressable
        role="button"
        hitSlop={10}
        testID="attention-refused-ok"
        onPress={() => void changes.discard([change.row.id])}
      >
        <Text className="text-[13px] font-semibold text-danger-text">
          {HOME_PHONE_WORDS.dismissNote}
        </Text>
      </Pressable>
    </View>
  );
}

/**
 * One thing that needs attention, as the web's card at phone width: the kind, the customer and job, up to three chips
 * that say why it ranks where it does, and whose it is. The main button fits the item and goes full width; Let
 * HandsFreeOS Handle and ⋯ (Snooze, Assign, Dismiss) sit under it, 44 px tall.
 */
export function AttentionCard({ item }: { item: Item }) {
  const env = useHomeEnv();
  const ai = useAiColors();
  const { head, rest } = splitItemTitle(item.title);
  const chips = cardChipsOf(item, env.now, env.timeZone);
  const at = autoActionAt(item);
  const handing = env.handing.has(item.id);
  const draft = item.kind === 'ai_approval' && isDraftItem(item);
  const calls = item.actions.handle && handleButtonOf(item, true).icon === 'phone';
  return (
    <CardFrame testID="attention-card" urgent={item.urgent} highlight={env.highlightId === item.id}>
      <View className="flex-row items-start gap-3">
        <KindTile kind={item.kind} />
        <View className="min-w-0 flex-1 gap-px">
          <Text className="text-[15.5px] font-semibold leading-[20px]" testID="attention-title">
            {head}
            {rest ? <Text className="text-[15.5px] font-normal text-text-2"> · {rest}</Text> : null}
          </Text>
          <KindLabel kind={item.kind}>{ATTENTION_KIND_LABELS[item.kind]}</KindLabel>
        </View>
        <AssigneeMark assignee={item.assignee} />
      </View>
      {item.detail ? (
        <Text className="mt-1 text-[13px] leading-[19px] text-text-2" testID="attention-detail">
          {draft && env.teammateName ? (
            <Text className="text-[13px] font-semibold" style={{ color: ai.text }}>
              {env.teammateName}:{' '}
            </Text>
          ) : null}
          {draft ? `“${item.detail}”` : item.detail}
        </Text>
      ) : null}
      {chips.length ? (
        <View className="mt-2">
          <Chips chips={chips} />
        </View>
      ) : null}
      <View className="mt-2.5 gap-2">
        <HandleButton item={item} className="w-full" />
        {calls && !env.online ? (
          <Text className="text-center text-xs text-text-3" testID="attention-calls-need-signal">
            {HOME_PHONE_WORDS.callsNeedSignal}
          </Text>
        ) : null}
        <View className="flex-row items-center gap-2">
          <LetHandleButton item={item} className="flex-1" />
          <MoreButton onPress={() => env.act.more(item)} />
        </View>
      </View>
      {at !== null ? (
        <GoesStrip item={item} at={at} />
      ) : handing ? (
        <GoesStrip item={item} at={null} />
      ) : null}
      <RefusedNote itemId={item.id} />
    </CardFrame>
  );
}
