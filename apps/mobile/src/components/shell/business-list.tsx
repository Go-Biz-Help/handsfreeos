import { Pressable, View } from 'react-native';

import { Check, ChevronRight, Lock } from '@/components/icons';
import { Icon } from '@/components/ui/icon';
import { Switch } from '@/components/ui/switch';
import { Text } from '@/components/ui/text';
import { ROLE_LABELS, isKept, setKept, useKeepChoices, type Business } from '@/lib/businesses';
import { businessMark, cn } from '@/lib/utils';

/** Soft backgrounds for business marks other than the open one (the open one is always the accent). */
const MARK_TONES = [
  { box: 'bg-success-soft', text: 'text-success-text' },
  { box: 'bg-warning-soft', text: 'text-warning-text' },
  { box: 'bg-card-3', text: 'text-text' },
] as const;

function toneFor(id: string) {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return MARK_TONES[h % MARK_TONES.length]!;
}

export function BusinessMarkTile({ business, current }: { business: Business; current: boolean }) {
  const tone = current
    ? { box: 'bg-accent-soft-2', text: 'text-accent-text' }
    : toneFor(business.id);
  return (
    <View className={cn('size-10 items-center justify-center rounded-menu', tone.box)}>
      <Text className={cn('text-[13px] font-bold tracking-[0.3px]', tone.text)}>
        {businessMark(business.name)}
      </Text>
    </View>
  );
}

/**
 * Each business with its "Keep on this phone" switch, as the switcher and Settings → Businesses on this phone show
 * them. A kept business is stored on the phone and works with no signal; the one opened last is kept unless its switch
 * is turned off.
 */
export function BusinessList({
  userId,
  businesses,
  currentId,
  onOpen,
  offline,
}: {
  userId: string;
  businesses: readonly Business[];
  currentId: string | null;
  /** Opens a business; without it the rows only carry the switches. */
  onOpen?: (business: Business) => void;
  offline: boolean;
}) {
  const choices = useKeepChoices(userId);
  return (
    <View
      className="overflow-hidden rounded-card border border-border bg-card"
      testID="business-list"
    >
      {businesses.map((business, i) => {
        const current = business.id === currentId;
        const kept = isKept(choices, business.id);
        const unreachable = offline && !kept && !current;
        return (
          <View key={business.id} className={cn(i > 0 && 'border-t border-border')}>
            <Pressable
              role={onOpen ? 'button' : undefined}
              disabled={!onOpen}
              testID={`business-${business.id}`}
              accessibilityLabel={business.name}
              accessibilityState={{ selected: current }}
              onPress={onOpen ? () => onOpen(business) : undefined}
              className={cn(
                'min-h-[64px] flex-row items-center gap-3 px-3.5 py-3',
                current ? 'bg-accent-soft' : onOpen && 'active:bg-card-2',
              )}
            >
              <BusinessMarkTile business={business} current={current} />
              <View className="min-w-0 flex-1 gap-px">
                <Text numberOfLines={1} className="text-[15px] font-semibold">
                  {business.name}
                </Text>
                <Text numberOfLines={1} className="text-[12.5px] text-text-3">
                  {business.organizationName} · you are {ROLE_LABELS[business.role]}
                </Text>
              </View>
              {current ? (
                <View className="flex-row items-center gap-1">
                  <Icon as={Check} strokeWidth={2} className="size-4 text-accent-text" />
                  <Text className="text-[13px] font-semibold text-accent-text">Open</Text>
                </View>
              ) : onOpen ? (
                <Icon
                  as={ChevronRight}
                  className={cn('size-4 text-text-3', unreachable && 'opacity-40')}
                />
              ) : null}
            </Pressable>
            <View className="flex-row items-center gap-2.5 border-t border-border py-2.5 pl-[66px] pr-3.5">
              <View className="min-w-0 flex-1">
                <Text className="text-[13.5px] font-medium">Keep on this phone</Text>
                <Text className="text-xs text-text-3">
                  {kept ? 'Works with no signal' : 'Opens only with signal'}
                </Text>
              </View>
              <Switch
                size="sm"
                label={`Keep ${business.name} on this phone`}
                testID={`keep-${business.id}`}
                checked={kept}
                onCheckedChange={(next) => setKept(userId, business.id, next)}
              />
            </View>
          </View>
        );
      })}
    </View>
  );
}

export function KeepNote() {
  return (
    <View className="flex-row items-start gap-2.5 rounded-menu bg-card-2 px-3 py-[11px]">
      <Icon as={Lock} className="mt-px size-4 text-text-2" />
      <Text className="flex-1 text-[13.5px] leading-5 text-text-2">
        A business kept on this phone is stored here, locked to you, and works with no signal. The
        one you opened last is kept unless you turn it off.
      </Text>
    </View>
  );
}
