import {
  addedLine,
  customerSince,
  money,
  owesWords,
  possibleDuplicateWords,
  recordTabLabel,
  RECORD_WORDS,
  type TagRef,
} from '@hfos/core';
import * as React from 'react';
import { Pressable, ScrollView, View } from 'react-native';

import {
  Building,
  CalendarPlus,
  Camera,
  ClipboardList,
  Mail,
  MessageCircle,
  Phone,
  SquareKanban,
  StickyNote,
  Tag as TagIcon,
  TriangleAlert,
} from '@/components/icons';
import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';

/**
 * The parts of a customer's, a company's or a lead's page on the phone, as `design/m10/Customer.dc.html` draws them:
 * the head with what they owe, the row of buttons (Call, Text and Email always in the same place and always 44 px),
 * the tabs with their counts, and the quiet marks for a change this phone hasn't sent yet.
 */

export type RecordTab = 'timeline' | 'money' | 'leads' | 'tasks' | 'files' | 'details';

export function RecordHead({
  name,
  seed,
  company,
  line,
  owed,
  archived,
  contact,
  tags,
  onTags,
  children,
}: {
  name: string;
  seed: string;
  /** A company's page shows a building instead of initials. */
  company?: boolean;
  line: string;
  owed: number;
  archived?: boolean;
  contact: readonly {
    readonly key: string;
    readonly text: string;
    readonly onPress?: () => void;
  }[];
  tags: readonly TagRef[];
  onTags: () => void;
  children?: React.ReactNode;
}) {
  const owes = owesWords(owed);
  return (
    <Card className="gap-3 px-3.5 py-3.5" testID="record-head">
      <View className="flex-row items-start gap-3">
        {company ? (
          <View className="size-12 items-center justify-center rounded-card bg-card-3">
            <Icon as={Building} className="size-6 text-text" />
          </View>
        ) : (
          <Avatar name={name} seed={seed} size="lg" />
        )}
        <View className="min-w-0 flex-1 gap-0.5">
          <Text className="text-[20px] font-semibold leading-tight" testID="record-name">
            {name}
          </Text>
          <Text className="text-[12.5px] text-text-3" testID="record-line">
            {line}
          </Text>
        </View>
        <View className="items-end gap-1.5">
          {archived ? <Badge variant="gray">{RECORD_WORDS.archived}</Badge> : null}
          {owes ? (
            <Badge variant="pending" testID="record-owes">
              <Text className="text-xs font-medium">{owes}</Text>
            </Badge>
          ) : null}
        </View>
      </View>
      {contact.length > 0 ? (
        <View className="gap-1">
          {contact.map((c) => (
            <Pressable
              key={c.key}
              role={c.onPress ? 'button' : undefined}
              onPress={c.onPress}
              disabled={!c.onPress}
              className="min-h-11 justify-center"
              testID={`record-${c.key}`}
            >
              <Text className={cn('text-[14.5px]', c.onPress ? 'text-accent-text' : 'text-text-2')}>
                {c.text}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : (
        <Text className="text-[13px] text-text-3">{RECORD_WORDS.noContact}</Text>
      )}
      <View className="flex-row flex-wrap items-center gap-1.5">
        {tags.map((t) => (
          <View
            key={t.id}
            className="h-[26px] flex-row items-center gap-1.5 rounded-full bg-card-2 px-2.5"
            testID={`record-tag-${t.name}`}
          >
            <View className="size-[7px] rounded-full" style={{ backgroundColor: t.color }} />
            <Text className="text-xs font-medium text-text-2">{t.name}</Text>
          </View>
        ))}
        <Button variant="ghost" size="sm" icon={TagIcon} onPress={onTags} testID="record-add-tag">
          {RECORD_WORDS.actions.tag}
        </Button>
      </View>
      {children}
    </Card>
  );
}

/** The line under a name: "Added today · Website form", or the web's "Customer since Sep 2025" when it's older. */
export function headLine(createdAt: string, source: string | null, now = Date.now()): string {
  const days = (now - Date.parse(createdAt)) / 86_400_000;
  return days < 30 ? addedLine(createdAt, source, now) : customerSince(createdAt);
}

export interface RecordAction {
  readonly key: string;
  readonly label: string;
  readonly icon: React.ComponentProps<typeof Icon>['as'];
  readonly onPress: () => void;
  readonly disabled?: boolean;
  readonly primary?: boolean;
}

/**
 * The buttons a record offers. Call, Text and Email sit on the top row and never move, so a thumb finds them without
 * looking; Book, Note, Photo, Task and Lead sit under them (the canvas's note).
 */
export function RecordActions({ actions }: { actions: readonly RecordAction[] }) {
  const top = actions.filter((a) => a.primary);
  const rest = actions.filter((a) => !a.primary);
  return (
    <View className="gap-2 border-t border-border pt-3" testID="record-actions">
      {top.length > 0 ? (
        <View className="flex-row gap-2">
          {top.map((a) => (
            <Button
              key={a.key}
              variant={a.key === 'call' ? 'primary' : 'secondary'}
              size="md"
              icon={a.icon}
              onPress={a.onPress}
              disabled={a.disabled}
              className="min-h-11 flex-1"
              testID={`record-${a.key}`}
            >
              {a.label}
            </Button>
          ))}
        </View>
      ) : null}
      {rest.length > 0 ? (
        <View className="flex-row flex-wrap gap-2">
          {rest.map((a) => (
            <Button
              key={a.key}
              variant="secondary"
              size="sm"
              icon={a.icon}
              onPress={a.onPress}
              disabled={a.disabled}
              className="min-h-11"
              testID={`record-${a.key}`}
            >
              {a.label}
            </Button>
          ))}
        </View>
      ) : null}
    </View>
  );
}

export const ACTION_ICONS = {
  call: Phone,
  text: MessageCircle,
  email: Mail,
  book: CalendarPlus,
  note: StickyNote,
  photo: Camera,
  task: ClipboardList,
  lead: SquareKanban,
} as const;

/** The tabs over a record, scrolling sideways because six of them never fit a phone. */
export function RecordTabs({
  tab,
  onChange,
  counts,
  money: hasMoney,
}: {
  tab: RecordTab;
  onChange: (tab: RecordTab) => void;
  counts: Readonly<Record<'leads' | 'tasks' | 'files', number>>;
  money?: boolean;
}) {
  const tabs: readonly { key: RecordTab; label: string }[] = [
    { key: 'timeline', label: recordTabLabel('timeline', null) },
    ...(hasMoney ? [{ key: 'money' as const, label: recordTabLabel('money', null) }] : []),
    { key: 'leads', label: recordTabLabel('leads', counts.leads) },
    { key: 'tasks', label: recordTabLabel('tasks', counts.tasks) },
    { key: 'files', label: recordTabLabel('files', counts.files) },
    { key: 'details', label: recordTabLabel('details', null) },
  ];
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerClassName="gap-1.5 px-0.5"
      testID="record-tabs"
    >
      {tabs.map((t) => (
        <Pressable
          key={t.key}
          role="tab"
          accessibilityState={{ selected: tab === t.key }}
          onPress={() => onChange(t.key)}
          className={cn(
            'min-h-11 justify-center rounded-full px-3.5',
            tab === t.key ? 'bg-accent' : 'border border-border-strong bg-card',
          )}
          testID={`record-tab-${t.key}`}
        >
          <Text
            className={cn('text-[13px] font-medium', tab === t.key ? 'text-white' : 'text-text')}
          >
            {t.label}
          </Text>
        </Pressable>
      ))}
    </ScrollView>
  );
}

/** A row of the Details tab. */
export function DetailRow({ label, value }: { label: string; value: string | null }) {
  return (
    <View className="flex-row gap-3 border-b border-border py-2.5">
      <Text className="w-[104px] flex-none text-[13px] text-text-2">{label}</Text>
      <Text className="min-w-0 flex-1 text-[13.5px] font-medium">{value || RECORD_WORDS.none}</Text>
    </View>
  );
}

/**
 * A record made with no signal that turns out to match one already saved. M10 keeps it and flags it rather than
 * merging: merging needs the server, and blocking it offline would lose the work.
 */
export function DuplicateBanner({
  other,
  onOpen,
}: {
  other: { readonly id: string; readonly name: string; readonly value: string | null };
  onOpen: (id: string) => void;
}) {
  const words = possibleDuplicateWords({
    name: other.name,
    matchedOn: 'phone',
    value: other.value,
  });
  return (
    <View className="gap-2 rounded-menu bg-warning-soft px-3.5 py-3" testID="record-duplicate">
      <View className="flex-row items-start gap-2">
        <Icon as={TriangleAlert} className="mt-0.5 size-4 text-warning-text" />
        <Text className="min-w-0 flex-1 text-[13.5px] font-semibold text-warning-text">
          {words.title}
        </Text>
      </View>
      <Text className="text-[13px] text-warning-text">{words.body}</Text>
      <Button
        variant="secondary"
        size="sm"
        onPress={() => onOpen(other.id)}
        className="self-start"
        testID="record-duplicate-open"
      >
        {words.open}
      </Button>
    </View>
  );
}

/** A change this phone hasn't sent yet, or one the API refused, over the row it was made on. */
export function ChangeMark({
  waiting,
  why,
  onClear,
}: {
  waiting: number;
  why: string | null;
  onClear?: () => void;
}) {
  if (why)
    return (
      <View
        className="flex-row items-center gap-2 rounded-menu bg-danger-soft px-3 py-2"
        testID="record-refused"
      >
        <Icon as={TriangleAlert} className="size-4 text-danger-text" />
        <Text className="min-w-0 flex-1 text-[13px] text-danger-text">{why}</Text>
        {onClear ? (
          <Button variant="ghost" size="sm" onPress={onClear} testID="record-refused-ok">
            OK
          </Button>
        ) : null}
      </View>
    );
  if (waiting <= 0) return null;
  return (
    <Text className="text-[12.5px] text-text-3" testID="record-waiting">
      {waiting === 1 ? '1 change waiting to send' : `${waiting} changes waiting to send`}
    </Text>
  );
}

/** What a customer owes, in the Money tab, with the way out to the money screens. */
export function OwedCard({ cents, onOpen }: { cents: number; onOpen: () => void }) {
  return (
    <Card className="gap-2 px-3.5 py-3.5" testID="record-money">
      <Text className="text-[13px] text-text-2">
        {cents > 0 ? owesWords(cents) : 'Nothing owed'}
      </Text>
      {cents > 0 ? <Text className="text-2xl font-semibold">{money(cents)}</Text> : null}
      <Button variant="secondary" size="sm" onPress={onOpen} className="self-start">
        Open their money
      </Button>
    </Card>
  );
}
