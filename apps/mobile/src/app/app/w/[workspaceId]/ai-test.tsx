import { holds } from '@hfos/core';
import { useQuery } from '@powersync/react-native';
import * as React from 'react';
import { Platform, Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useCustomers } from '@/calendar/use-calendar';
import { TestConsoleView } from '@/components/ai-team/test-console';
import { RotateCcw } from '@/components/icons';
import { useKeyboardHeight } from '@/components/shell/keyboard';
import { useBusiness } from '@/components/shell/business-context';
import { Screen } from '@/components/shell/screen';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Segmented } from '@/components/ui/segmented';
import { Text } from '@/components/ui/text';
import { useTestConsole } from '@/ai-team/use-test-console';
import { TEAMMATE_SQL } from '@/home/queries';
import { useGrants } from '@/lib/grants';
import { openWeb } from '@/lib/open-web';
import { cn } from '@/lib/utils';

/**
 * The AI teammate's test console, full screen, from More (people who manage the teammate): the web's console on the
 * phone. It tests the saved settings; changing them is the builder's, on the web.
 */
export default function AiTest() {
  const { business } = useBusiness();
  const grants = useGrants();
  const insets = useSafeAreaInsets();
  const keyboard = useKeyboardHeight();
  const { data } = useQuery<{ id: string; name: string | null; status: string }>(TEAMMATE_SQL, [
    business.id,
  ]);
  const teammate = data[0] ?? null;
  const name = teammate?.name?.trim() || 'Your AI teammate';
  const customers = useCustomers();
  const state = useTestConsole(business.id, name);
  const [pane, setPane] = React.useState<'chat' | 'log'>('chat');
  const allowed = holds(grants, 'ai_team.manage');

  return (
    <Screen
      title="Test console"
      leading="close"
      ask={false}
      scroll={false}
      testID="ai-test"
      contentClassName="flex-1"
      trailing={
        allowed && teammate ? (
          <Pressable
            role="button"
            accessibilityLabel="Start over"
            accessibilityState={{ disabled: !state.turns.length && !state.busy }}
            disabled={!state.turns.length && !state.busy}
            testID="test-console-start-over"
            onPress={state.startOver}
            className={cn(
              'size-11 items-center justify-center rounded-full active:bg-card-2',
              !state.turns.length && !state.busy && 'opacity-40',
            )}
          >
            <Icon as={RotateCcw} className="size-[20px] text-text-2" />
          </Pressable>
        ) : null
      }
    >
      {!allowed || !teammate ? (
        <View className="gap-3 p-4" testID="ai-test-unavailable">
          <Text className="text-[15px] font-semibold">
            {!allowed
              ? 'Only people who manage the AI teammate can test it.'
              : 'Set up your AI teammate first.'}
          </Text>
          <Text className="text-[13px] leading-[18px] text-text-2">
            {!allowed
              ? 'Ask an owner or admin of this business.'
              : 'Pick how it works on the web, under AI teammate. Then you can test it here.'}
          </Text>
          {allowed ? (
            <Button
              variant="secondary"
              className="self-start"
              onPress={() => void openWeb(`/app/w/${business.id}/ai-team`)}
            >
              Open on the web
            </Button>
          ) : null}
        </View>
      ) : (
        <View
          className="flex-1"
          style={{
            paddingBottom: keyboard
              ? keyboard + (Platform.OS === 'android' ? insets.bottom : 0)
              : insets.bottom,
          }}
        >
          <View className="bg-card px-3.5 pb-2.5 pt-1">
            <Segmented
              label="Show"
              value={pane}
              onChange={setPane}
              options={[
                { value: 'chat', label: state.phone ? 'Call' : 'Chat', testID: 'test-pane-chat' },
                { value: 'log', label: `What ${name} did`, testID: 'test-pane-log' },
              ]}
            />
          </View>
          <TestConsoleView
            state={state}
            name={name}
            timeZone={business.timezone || 'UTC'}
            customers={customers}
            pane={pane}
          />
        </View>
      )}
    </Screen>
  );
}
