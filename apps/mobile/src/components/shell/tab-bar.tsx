import type { BottomTabBarProps } from 'expo-router/js-tabs';
import type { LucideIcon } from 'lucide-react-native';
import { Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { CalendarDays, Ellipsis, House, Inbox, SquareKanban } from '@/components/icons';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';

const TABS: Record<string, { label: string; icon: LucideIcon; testID: string }> = {
  index: { label: 'Home', icon: House, testID: 'tab-home' },
  inbox: { label: 'Inbox', icon: Inbox, testID: 'tab-inbox' },
  pipeline: { label: 'Pipeline', icon: SquareKanban, testID: 'tab-pipeline' },
  calendar: { label: 'Calendar', icon: CalendarDays, testID: 'tab-calendar' },
  '(more)': { label: 'More', icon: Ellipsis, testID: 'tab-more' },
};

/**
 * The five tabs, as the web's phone bottom bar draws them: Home, Inbox, Pipeline, Calendar and More, the chosen one in
 * the accent colour. The counts on Home and Inbox arrive with those screens.
 */
export function TabBar({ state, navigation }: BottomTabBarProps) {
  const insets = useSafeAreaInsets();
  return (
    <View
      role="tablist"
      className="flex-row border-t border-border bg-card"
      style={{ paddingBottom: Math.max(insets.bottom, 6) }}
    >
      {state.routes.map((route, index) => {
        const tab = TABS[route.name];
        if (!tab) return null;
        const focused = state.index === index;
        return (
          <Pressable
            key={route.key}
            role="tab"
            accessibilityLabel={tab.label}
            accessibilityState={{ selected: focused }}
            testID={tab.testID}
            onPress={() => {
              const event = navigation.emit({
                type: 'tabPress',
                target: route.key,
                canPreventDefault: true,
              });
              if (!focused && !event.defaultPrevented)
                navigation.navigate(route.name, route.params);
            }}
            className="h-[52px] flex-1 items-center justify-center gap-[3px]"
          >
            <Icon
              as={tab.icon}
              strokeWidth={focused ? 2 : 1.5}
              className={cn('size-6', focused ? 'text-accent-text' : 'text-text-3')}
            />
            <Text
              className={cn(
                'text-[11px] font-medium',
                focused ? 'text-accent-text' : 'text-text-3',
              )}
            >
              {tab.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}
