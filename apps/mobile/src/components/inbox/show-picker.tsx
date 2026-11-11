import {
  INBOX_SHOW,
  INBOX_SHOW_LABELS,
  INBOX_SHOW_NOTES,
  unreadLabel,
  type InboxShowKey,
} from '@hfos/core';
import * as React from 'react';
import { Pressable, View } from 'react-native';

import { Check, ChevronDown, Inbox, ShieldAlert } from '@/components/icons';
import { FilterChip } from '@/components/ui/filter-chip';
import { Icon } from '@/components/ui/icon';
import { Sheet } from '@/components/ui/sheet';
import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';

/** The phone's choices: the web's, less Archived, since archived conversations never reach the phone. */
const PHONE_SHOW = INBOX_SHOW.filter((k) => k !== 'archived');
const ICONS: Partial<Record<InboxShowKey, typeof Inbox>> = { other: Inbox, spam: ShieldAlert };

/**
 * What the Inbox shows, from one chip (Chris, 2026-11-11), as the web's menu beside its search: Open, Snoozed and
 * Closed, then Other mail and Spam. The person's own mail is in each beside the team's, marked "Only you", so nothing
 * here opens a page of its own. A dot on the chip means something unread waits in Other mail.
 */
export function ShowPicker({
  value,
  counts,
  onPick,
}: {
  value: InboxShowKey;
  counts: { other: number; spam: number };
  onPick: (key: InboxShowKey) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const put = value === 'other' || value === 'spam';
  const PutIcon = ICONS[value];
  const dot = counts.other > 0 && value !== 'other';
  return (
    <>
      <FilterChip
        label={INBOX_SHOW_LABELS[value]}
        on={put}
        onPress={() => setOpen(true)}
        accessibilityLabel={`Show: ${INBOX_SHOW_LABELS[value]}${dot ? `. ${INBOX_SHOW_NOTES.otherUnread}` : ''}`}
        icon={PutIcon ? <Icon as={PutIcon} className="size-3.5 text-accent-text" /> : undefined}
        trailing={
          <>
            {dot ? (
              <View className="size-[7px] rounded-full bg-accent" testID="inbox-show-dot" />
            ) : null}
            <Icon
              as={ChevronDown}
              className={cn('size-3.5', put ? 'text-accent-text' : 'text-text-3')}
            />
          </>
        }
        testID="inbox-show"
      />
      <Sheet open={open} onClose={() => setOpen(false)} title="Show" testID="inbox-show-sheet">
        <View className="mt-2 overflow-hidden rounded-card border border-border bg-card">
          {PHONE_SHOW.map((key, i) => {
            const on = key === value;
            const KeyIcon = ICONS[key];
            const count = key === 'other' ? counts.other : key === 'spam' ? counts.spam : 0;
            return (
              <Pressable
                key={key}
                role="radio"
                accessibilityState={{ checked: on }}
                onPress={() => {
                  setOpen(false);
                  if (!on) onPick(key);
                }}
                testID={`inbox-show-${key}`}
                className={cn(
                  'min-h-12 flex-row items-center gap-3 px-4 active:bg-card-2',
                  i > 0 && 'border-t border-border',
                )}
              >
                {KeyIcon ? <Icon as={KeyIcon} className="size-[18px] text-text-3" /> : null}
                <Text className={cn('min-w-0 flex-1 text-base', on && 'font-semibold')}>
                  {INBOX_SHOW_LABELS[key]}
                </Text>
                {count > 0 ? (
                  <View
                    className={cn(
                      'h-[22px] min-w-[22px] items-center justify-center rounded-full px-1.5',
                      key === 'spam' ? 'bg-border' : 'bg-accent',
                    )}
                    testID={`inbox-show-${key}-count`}
                  >
                    <Text
                      className={cn(
                        'text-xs font-semibold',
                        key === 'spam' ? 'text-text-2' : 'text-white',
                      )}
                    >
                      {unreadLabel(count)}
                    </Text>
                  </View>
                ) : null}
                {on ? <Icon as={Check} className="size-[18px] text-accent-text" /> : null}
              </Pressable>
            );
          })}
        </View>
      </Sheet>
    </>
  );
}
