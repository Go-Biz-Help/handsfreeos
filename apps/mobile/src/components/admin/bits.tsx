import * as React from 'react';
import { Pressable, ScrollView, View } from 'react-native';

import { DESK_PHONE_WORDS } from '@/admin/words';
import { Check, CloudOff, Headset, Search, X } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { Input } from '@/components/ui/input';
import { Sheet } from '@/components/ui/sheet';
import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';

/**
 * The small pieces every screen of the phone's Support desk is made of, so the tickets, the businesses and the rest
 * look like one place, and like the web's /admin drawn at phone width.
 */

/** While the first answer is on its way. */
export function DeskLoading({ testID }: { testID?: string }) {
  return (
    <Card className="items-center gap-2 px-5 py-8" testID={testID ?? 'desk-loading'}>
      <Icon as={Headset} className="size-6 text-text-3" />
      <Text className="text-[14.5px] text-text-2">{DESK_PHONE_WORDS.loading}</Text>
    </Card>
  );
}

/** Nothing to show: no signal, or HandsFreeOS said no. Try again asks once more. */
export function DeskNeedSignal({
  error,
  onRetry,
  testID,
}: {
  error: string | null;
  onRetry: () => void;
  testID?: string;
}) {
  return (
    <Card className="items-center gap-3 px-5 py-8" testID={testID ?? 'desk-error'}>
      <Icon as={CloudOff} className="size-6 text-text-3" />
      <Text className="text-center text-[14.5px] leading-[21px] text-text-2">
        {error ?? DESK_PHONE_WORDS.needsSignal}
      </Text>
      <Button variant="secondary" className="self-stretch" onPress={onRetry} testID="desk-retry">
        {DESK_PHONE_WORDS.retry}
      </Button>
    </Card>
  );
}

/** Loading, or why there's nothing: what a screen shows before its first answer. */
export function DeskWaiting({
  live,
  testID,
}: {
  live: { readonly loading: boolean; readonly error: string | null; reload(): void };
  testID?: string;
}) {
  return (
    <View className="p-3">
      {live.loading ? (
        <DeskLoading testID={testID ? `${testID}-loading` : undefined} />
      ) : (
        <DeskNeedSignal
          error={live.error}
          onRetry={live.reload}
          testID={testID ? `${testID}-error` : undefined}
        />
      )}
    </View>
  );
}

/** A row of filter chips that scrolls sideways, as the pipeline's stages do; a count beside one when it has one. */
export function FilterChips<K extends string>({
  options,
  value,
  onChange,
  testID,
}: {
  options: readonly { readonly key: K; readonly label: string; readonly count?: number | null }[];
  value: K;
  onChange: (key: K) => void;
  testID?: string;
}) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerClassName="gap-1.5 px-0.5"
      testID={testID}
    >
      {options.map((o) => {
        const on = o.key === value;
        return (
          <Pressable
            key={o.key}
            role="tab"
            accessibilityState={{ selected: on }}
            onPress={() => onChange(o.key)}
            className={cn(
              'min-h-11 flex-row items-center gap-2 rounded-full px-3.5',
              on ? 'bg-accent' : 'border border-border-strong bg-card',
            )}
            testID={testID ? `${testID}-${o.key}` : undefined}
          >
            <Text className={cn('text-[13px] font-medium', on ? 'text-white' : 'text-text')}>
              {o.label}
            </Text>
            {o.count ? (
              <Text className={cn('text-[12px]', on ? 'text-white/80' : 'text-text-3')}>
                {o.count}
              </Text>
            ) : null}
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

/** A search box that clears with one press. The screen decides when to search (a moment after the typing stops). */
export function SearchBox({
  value,
  onChange,
  placeholder,
  testID,
}: {
  value: string;
  onChange: (text: string) => void;
  placeholder: string;
  testID?: string;
}) {
  return (
    <Input
      value={value}
      onChangeText={onChange}
      placeholder={placeholder}
      accessibilityLabel={placeholder}
      returnKeyType="search"
      autoCorrect={false}
      autoCapitalize="none"
      testID={testID}
      className="h-11"
      trailing={
        value ? (
          <Pressable
            role="button"
            accessibilityLabel="Clear"
            onPress={() => onChange('')}
            hitSlop={8}
            className="size-11 items-center justify-center"
          >
            <Icon as={X} className="size-4 text-text-3" />
          </Pressable>
        ) : (
          <View className="size-11 items-center justify-center">
            <Icon as={Search} className="size-4 text-text-3" />
          </View>
        )
      }
    />
  );
}

/** The typed search, a moment after the typing stops. */
export function useSettled(text: string, ms = 400): string {
  const [settled, setSettled] = React.useState(text.trim());
  React.useEffect(() => {
    const timer = setTimeout(() => setSettled(text.trim()), ms);
    return () => clearTimeout(timer);
  }, [text, ms]);
  return settled;
}

/** The numbers across the top of a page: "On HandsFreeOS 212". Two to a row on a phone. */
export function Stats({
  items,
  testID,
}: {
  items: readonly { readonly label: string; readonly value: string | number }[];
  testID?: string;
}) {
  return (
    <View className="flex-row flex-wrap gap-2" testID={testID}>
      {items.map((s) => (
        <Card key={s.label} className="min-w-[46%] flex-1 gap-0.5 px-3.5 py-3">
          <Text className="text-[12.5px] text-text-3">{s.label}</Text>
          <Text className="text-xl font-semibold tabular-nums">{String(s.value)}</Text>
        </Card>
      ))}
    </View>
  );
}

/** A titled card, the web's `<section>` at phone width. */
export function Section({
  title,
  detail,
  end,
  children,
  testID,
  className,
}: {
  title: string;
  detail?: string;
  end?: React.ReactNode;
  children?: React.ReactNode;
  testID?: string;
  className?: string;
}) {
  return (
    <Card className={cn('gap-3 px-4 py-3.5', className)} testID={testID}>
      <View className="flex-row items-start gap-2">
        <View className="min-w-0 flex-1 gap-0.5">
          <Text className="text-[15px] font-semibold">{title}</Text>
          {detail ? <Text className="text-[13px] leading-[18px] text-text-3">{detail}</Text> : null}
        </View>
        {end}
      </View>
      {children}
    </Card>
  );
}

/** "Came in · Sep 30, 9:41 AM": a label and its value on one line. */
export function Line({
  label,
  value,
  tone,
  testID,
}: {
  label: string;
  value: React.ReactNode;
  tone?: 'danger' | 'ok' | 'muted';
  testID?: string;
}) {
  return (
    <View className="flex-row items-baseline justify-between gap-3" testID={testID}>
      <Text className="text-[13.5px] text-text-3">{label}</Text>
      {typeof value === 'string' || typeof value === 'number' ? (
        <Text
          className={cn(
            'min-w-0 flex-shrink text-right text-[13.5px]',
            tone === 'danger' && 'text-danger-text',
            tone === 'ok' && 'text-success-text',
            tone === 'muted' && 'text-text-3',
          )}
        >
          {String(value)}
        </Text>
      ) : (
        value
      )}
    </View>
  );
}

/** One choice out of a few (a ticket's status, who has it), as a sheet of rows with a tick on the current one. */
export function PickSheet<V extends string>({
  open,
  onClose,
  title,
  options,
  value,
  onPick,
  testID,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  options: readonly { readonly value: V; readonly label: string; readonly detail?: string }[];
  value: V;
  onPick: (value: V) => void;
  testID?: string;
}) {
  return (
    <Sheet open={open} onClose={onClose} title={title} scroll testID={testID}>
      <View className="overflow-hidden rounded-card border border-border bg-card">
        {options.map((o, i) => {
          const on = o.value === value;
          return (
            <Pressable
              key={o.value || `none-${i}`}
              role="radio"
              accessibilityState={{ checked: on }}
              onPress={() => {
                onClose();
                if (!on) onPick(o.value);
              }}
              testID={testID ? `${testID}-${o.value || 'none'}` : undefined}
              className={cn(
                'min-h-12 flex-row items-center gap-3 px-4 active:bg-card-2',
                i > 0 && 'border-t border-border',
              )}
            >
              <View className="min-w-0 flex-1 gap-px py-2">
                <Text className="text-base">{o.label}</Text>
                {o.detail ? <Text className="text-[13px] text-text-3">{o.detail}</Text> : null}
              </View>
              {on ? <Icon as={Check} className="size-5 text-accent" /> : null}
            </Pressable>
          );
        })}
      </View>
    </Sheet>
  );
}

/** A sentence in a card, for a page with nothing in it yet. */
export function Empty({ title, body, testID }: { title: string; body?: string; testID?: string }) {
  return (
    <Card className="items-center gap-1 px-5 py-10" testID={testID}>
      <Text className="text-[15px] font-medium">{title}</Text>
      {body ? <Text className="text-center text-[13.5px] text-text-3">{body}</Text> : null}
    </Card>
  );
}
