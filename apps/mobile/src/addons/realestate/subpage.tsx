import { addDays, fmtDateShort, fmtTime, localDayOf } from '@hfos/core';
import { RE_PHOTO_WORDS, RE_WHEN_WORDS } from '@hfos/core/addons/realestate/phone-words-closing';
import { RE_PHONE_WORDS } from '@hfos/core/addons/realestate/phone-words';
import { holdsWhole } from '@hfos/core/addons/realestate/views/deal-facts';
import type { CopyDeal, RealestateCopy } from '@hfos/core/addons/realestate/views/synced';
import type { LucideIcon } from 'lucide-react-native';
import * as React from 'react';
import { ActivityIndicator, Pressable, View } from 'react-native';

import { changes, newId } from '@/changes';
import { isOnline } from '@/changes/commands';
import { takePhoto, type PhotoSource } from '@/changes/photo-device';
import { Check, Image as ImageIcon, Signal } from '@/components/icons';
import { Screen } from '@/components/shell/screen';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';

import { useRealestateCopy } from './copy';
import {
  NeedsSignalCard,
  reHref,
  SignalButton,
  SummaryChip,
  useLiveAnswer,
  useReContext,
  type LiveAnswer,
  type ReContext,
} from './kit';

/**
 * What the closing and listing pages of a deal share (boards 85–89): the deal's copy and who's looking, the screen
 * with the deal's name under the title and Back to the deal, a deal kept as its summary answered by the server with
 * signal, the board's small parts (a tick box, the note with the signal mark, chips, a photo's frame), and a photo
 * taken on the spot for the deal, kept on the phone until it uploads.
 */

export interface DealPage {
  readonly ctx: ReContext;
  readonly copy: RealestateCopy;
  readonly deal: CopyDeal | null;
  /** The phone holds the deal whole (the person is on it); else it keeps its summary. */
  readonly whole: boolean;
}

/** One deal's copy, read for one of its pages. */
export function useDealPage(dealId: string): DealPage {
  const ctx = useReContext();
  const copy = useRealestateCopy(ctx.workspaceId, { kind: 'deal', dealId });
  const deal = copy.deals.get(dealId) ?? null;
  return { ctx, copy, deal, whole: holdsWhole(copy, dealId, ctx.userId) };
}

/** A page of a deal: its title, the deal's name under it, Back to the deal; and a deal this phone doesn't have. */
export function DealSubpage({
  workspaceId,
  dealId,
  deal,
  title,
  subtitle,
  trailing,
  testID,
  children,
}: {
  workspaceId: string;
  dealId: string;
  deal: CopyDeal | null;
  title: string;
  subtitle?: string;
  trailing?: React.ReactNode;
  testID?: string;
  children?: React.ReactNode;
}) {
  return (
    <Screen
      title={title}
      subtitle={subtitle ?? deal?.name}
      leading="back"
      back={reHref(workspaceId, `deals/${dealId}`)}
      trailing={trailing}
      testID={testID}
    >
      {deal ? (
        children
      ) : (
        <NeedsSignalCard words={RE_PHONE_WORDS.notOnPhone} testID="re-not-on-phone" />
      )}
    </Screen>
  );
}

/**
 * The server's answer for a page of a deal the phone keeps as its summary, asked with signal; nothing is asked while
 * the phone holds the deal whole. `what` names the page's things: "This deal's financing loads with signal…".
 */
export function useSummaryAnswer<T>(
  needed: boolean,
  ask: () => Promise<T>,
  key: string,
  what: string,
): LiveAnswer<T> {
  return useLiveAnswer(needed ? ask : null, key, RE_PHONE_WORDS.summaryNeedsSignal(what));
}

/** A summary deal's page: the chip and the server's answer, loading, or why it waits for signal. */
export function SummaryAnswer<T>({
  answer,
  what,
  children,
}: {
  answer: LiveAnswer<T>;
  what: string;
  children: (data: T) => React.ReactNode;
}) {
  return (
    <View className="gap-3" testID="re-summary-page">
      <SummaryChip />
      {answer.data !== null ? (
        children(answer.data)
      ) : answer.loading ? (
        <ActivityIndicator className="py-8" testID="re-summary-loading" />
      ) : (
        <NeedsSignalCard
          words={answer.error ?? RE_PHONE_WORDS.summaryNeedsSignal(what)}
          onRetry={answer.reload}
        />
      )}
    </View>
  );
}

/** "Today 4:00 PM", "Tomorrow 4:00 PM", "Thu, Oct 8 · 4:00 PM", where the business is. */
export function whenWords(at: string, today: string, timeZone: string): string {
  const day = localDayOf(at, timeZone);
  const time = fmtTime(at, timeZone);
  if (day === today) return RE_WHEN_WORDS.today(time);
  if (day === addDays(today, 1)) return RE_WHEN_WORDS.tomorrow(time);
  return RE_WHEN_WORDS.day(fmtDateShort(day), time);
}

/**
 * The button for a change: one that waits on the phone presses with no signal; one that needs signal (its command is
 * online) says so with no signal, and why.
 */
export function ChangeButton({
  command,
  label,
  why,
  onPress,
  loading,
  disabled,
  variant = 'primary',
  testID,
}: {
  command: string;
  label: string;
  why: string;
  onPress: () => void;
  loading?: boolean;
  disabled?: boolean;
  variant?: 'primary' | 'secondary';
  testID?: string;
}) {
  if (isOnline(command))
    return (
      <SignalButton
        label={label}
        why={why}
        onPress={onPress}
        disabled={disabled || loading}
        variant={variant}
        testID={testID}
      />
    );
  return (
    <Button
      variant={variant}
      loading={loading}
      disabled={disabled}
      onPress={onPress}
      testID={testID}
    >
      {label}
    </Button>
  );
}

// ---------- the board's small parts ----------

/** A step, a task or a thing to check: ticked green, or an empty box. */
export function TickBox({ checked, testID }: { checked: boolean; testID?: string }) {
  return (
    <View
      className={cn(
        'size-[22px] items-center justify-center rounded-[6px] border',
        checked ? 'border-success bg-success' : 'border-border-strong bg-card',
      )}
      testID={testID}
      accessibilityState={{ checked }}
    >
      {checked ? <Icon as={Check} className="size-3.5 text-white" /> : null}
    </View>
  );
}

/** A row on a list card: a tick box (or an icon), the words and the line under them, and what sits at the end. */
export function CheckRow({
  checked,
  icon,
  label,
  line,
  warning,
  end,
  onPress,
  waiting,
  testID,
}: {
  checked?: boolean;
  icon?: LucideIcon;
  label: string;
  line?: string | null;
  warning?: string | null;
  end?: React.ReactNode;
  onPress?: () => void;
  /** Done on this phone, not sent yet: a dashed edge, as the boards draw it. */
  waiting?: boolean;
  testID?: string;
}) {
  const body = (
    <>
      {checked !== undefined ? (
        <TickBox checked={checked} />
      ) : icon ? (
        <Icon as={icon} className="size-5 text-text-2" />
      ) : null}
      <View className="min-w-0 flex-1 gap-px">
        <Text className="text-base">{label}</Text>
        {line ? <Text className="text-[13px] leading-[18px] text-text-3">{line}</Text> : null}
        {warning ? (
          <Text className="text-[13px] leading-[18px] text-warning-text">{warning}</Text>
        ) : null}
      </View>
      {typeof end === 'string' ? <Text className="text-sm text-text-3">{end}</Text> : end}
    </>
  );
  const className = cn(
    'min-h-14 flex-row items-center gap-3.5 px-4 py-2.5',
    waiting && 'border border-dashed border-warning',
  );
  if (!onPress)
    return (
      <View className={className} testID={testID}>
        {body}
      </View>
    );
  return (
    <Pressable
      role="button"
      accessibilityLabel={[label, line].filter(Boolean).join('. ')}
      onPress={onPress}
      className={cn(className, 'active:bg-card-2')}
      testID={testID}
    >
      {body}
    </Pressable>
  );
}

/** The quiet note under a page with the signal mark: what works with no signal, and what waits for it. */
export function SignalNote({ children, testID }: { children: string; testID?: string }) {
  return (
    <View className="flex-row gap-2 px-1" testID={testID}>
      <Icon as={Signal} className="mt-0.5 size-3.5 text-text-3" />
      <Text className="flex-1 text-[12.5px] leading-[17px] text-text-3">{children}</Text>
    </View>
  );
}

/** A label over a field in a sheet. */
export function FieldLabel({ children }: { children: string }) {
  return <Text className="text-[13px] font-medium text-text-2">{children}</Text>;
}

/** A refusal under a field. */
export function FieldError({ children, testID }: { children?: string | null; testID?: string }) {
  if (!children) return null;
  return (
    <Text className="text-[13px] text-danger-text" testID={testID}>
      {children}
    </Text>
  );
}

/** A few plain choices as chips (due today, tomorrow…), the chosen one filled. */
export function Chips<T extends string>({
  value,
  onChange,
  options,
  testID,
}: {
  value: T;
  onChange: (value: T) => void;
  options: readonly (readonly [T, string])[];
  testID?: string;
}) {
  return (
    <View className="flex-row flex-wrap gap-2" testID={testID}>
      {options.map(([key, label]) => (
        <Pressable
          key={key}
          role="button"
          accessibilityState={{ selected: value === key }}
          onPress={() => onChange(key)}
          className={cn(
            'h-9 justify-center rounded-full px-3.5',
            value === key ? 'bg-accent' : 'border border-border-strong bg-card',
          )}
          testID={testID ? `${testID}-${key}` : undefined}
        >
          <Text
            className={cn('text-[13px] font-medium', value === key ? 'text-white' : 'text-text')}
          >
            {label}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

/** A photo's frame: the files stay at HandsFreeOS, so the phone shows where each is and its place. */
export function PhotoFrame({
  label,
  waiting,
  selected,
  onPress,
  className,
  testID,
}: {
  label?: string;
  waiting?: boolean;
  selected?: boolean;
  onPress?: () => void;
  className?: string;
  testID?: string;
}) {
  const body = (
    <>
      <Icon as={ImageIcon} className="size-5 text-text-3" />
      {label || waiting ? (
        <Text className="absolute bottom-1.5 left-2 text-[11.5px] text-text-3">
          {waiting ? RE_PHOTO_WORDS.waiting : label}
        </Text>
      ) : null}
    </>
  );
  const frame = cn(
    'aspect-square items-center justify-center rounded-[10px] bg-card-2',
    waiting && 'border border-dashed border-warning',
    selected && 'border-2 border-accent',
    className,
  );
  if (!onPress)
    return (
      <View className={frame} testID={testID}>
        {body}
      </View>
    );
  return (
    <Pressable
      role="button"
      accessibilityLabel={waiting ? RE_PHOTO_WORDS.waiting : label}
      onPress={onPress}
      className={cn(frame, 'active:opacity-80')}
      testID={testID}
    >
      {body}
    </Pressable>
  );
}

// ---------- a photo for the deal ----------

/** A photo taken or picked, kept on the phone and not yet on its way. */
export interface KeptDealPhoto {
  /** The file's id, made here. */
  readonly fileId: string;
  readonly localName: string;
  readonly sizeBytes: number;
}

export type DealPhoto =
  | {
      readonly kind: 'kept';
      readonly fileId: string;
      /** The upload's change, for what waits for it. */
      readonly changeId: string;
    }
  | { readonly kind: 'cancelled' };

/** Takes a photo (or picks one) and keeps it on the phone; null when it wasn't taken. */
export async function keepDealPhoto(
  userId: string,
  source: PhotoSource,
): Promise<KeptDealPhoto | null> {
  const fileId = newId();
  const taken = await takePhoto({ userId, source, fileId });
  if (taken.kind === 'no-camera-permission') {
    toast.error(RE_PHOTO_WORDS.noCamera);
    return null;
  }
  if (taken.kind !== 'kept') return null;
  return { fileId, localName: taken.photo.localName, sizeBytes: taken.photo.sizeBytes };
}

/** Puts a kept photo on the deal's files: it uploads on its own track when there's signal. Returns its change. */
export async function uploadDealPhoto(input: {
  readonly workspaceId: string;
  readonly dealId: string;
  readonly photo: KeptDealPhoto;
  readonly name?: string;
}): Promise<string> {
  const added = await changes.addPhoto(
    { workspaceId: input.workspaceId, recordType: 'custom_record', recordId: input.dealId },
    { localName: input.photo.localName, sizeBytes: input.photo.sizeBytes },
    { fileId: input.photo.fileId, ...(input.name ? { name: input.name } : {}) },
  );
  return added.id;
}

/**
 * Takes a photo (or picks one) for the deal's files: kept on the phone at once and uploaded on its own track when
 * there's signal. A change that points at it waits for `changeId`.
 */
export async function takeDealPhoto(input: {
  readonly workspaceId: string;
  readonly userId: string;
  readonly dealId: string;
  readonly source: PhotoSource;
  readonly name?: string;
}): Promise<DealPhoto> {
  const photo = await keepDealPhoto(input.userId, input.source);
  if (!photo) return { kind: 'cancelled' };
  const changeId = await uploadDealPhoto({ ...input, photo });
  return { kind: 'kept', fileId: photo.fileId, changeId };
}
