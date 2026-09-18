import type { LucideIcon } from 'lucide-react-native';
import * as React from 'react';
import { Pressable, View } from 'react-native';

import { ChevronRight, ExternalLink } from '@/components/icons';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';

/** A group of rows on a card, as More and Settings draw them. */
export function List({ children, testID }: { children: React.ReactNode; testID?: string }) {
  const rows = React.Children.toArray(children).filter(Boolean);
  return (
    <View className="overflow-hidden rounded-card border border-border bg-card" testID={testID}>
      {rows.map((row, i) => (
        <View key={i} className={cn(i > 0 && 'border-t border-border')}>
          {row}
        </View>
      ))}
    </View>
  );
}

/** "THIS PHONE", "YOU": the label over a group. */
export function ListLabel({ children }: { children: string }) {
  return (
    <Text variant="group" className="px-1 pt-2">
      {children}
    </Text>
  );
}

/**
 * One row: an icon, the words (and a line under them), then what it shows at the end and a chevron, or an arrow out
 * for a page on the web. At least 56 px tall.
 */
export function ListRow({
  icon,
  label,
  detail,
  end,
  onPress,
  external,
  danger,
  chevron = true,
  testID,
  disabled,
}: {
  icon?: LucideIcon;
  label: string;
  detail?: string;
  end?: React.ReactNode;
  onPress?: () => void;
  external?: boolean;
  danger?: boolean;
  chevron?: boolean;
  testID?: string;
  disabled?: boolean;
}) {
  const content = (
    <>
      {icon ? (
        <Icon
          as={icon}
          className={cn('size-[22px]', danger ? 'text-danger-text' : 'text-text-2')}
        />
      ) : null}
      <View className="min-w-0 flex-1 gap-px py-2">
        <Text className={cn('text-base', danger && 'text-danger-text')}>{label}</Text>
        {detail ? <Text className="text-[13px] leading-[18px] text-text-3">{detail}</Text> : null}
      </View>
      {typeof end === 'string' ? <Text className="text-sm text-text-3">{end}</Text> : end}
      {onPress && chevron ? (
        <Icon as={external ? ExternalLink : ChevronRight} className="size-4 text-text-3" />
      ) : null}
    </>
  );
  const className = 'min-h-14 flex-row items-center gap-3.5 px-4';
  if (!onPress)
    return (
      <View className={className} testID={testID}>
        {content}
      </View>
    );
  return (
    <Pressable
      role={external ? 'link' : 'button'}
      // The row's own words, the value on the right included: "Appearance. Dark", not "Appearance", so a screen
      // reader says what the setting is set to and the flows can assert it off the row itself.
      accessibilityLabel={[label, detail, typeof end === 'string' ? end : null]
        .filter(Boolean)
        .join('. ')}
      disabled={disabled}
      onPress={onPress}
      testID={testID}
      className={cn(className, 'active:bg-card-2', disabled && 'opacity-50')}
    >
      {content}
    </Pressable>
  );
}
