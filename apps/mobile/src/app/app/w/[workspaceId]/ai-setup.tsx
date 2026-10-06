import { AI_SETUP_WORDS, holds } from '@hfos/core';
import { useLocalSearchParams } from 'expo-router';
import * as React from 'react';
import { ActivityIndicator, View } from 'react-native';

import { aiSetupCalls } from '@/ai-setup/calls';
import { useAiSetupStart } from '@/ai-setup/use-ai-setup';
import { AI_SETUP_PHONE_WORDS as P } from '@/ai-setup/words';
import { AiQuickSetup } from '@/components/ai-setup/quick-setup';
import { useBusiness } from '@/components/shell/business-context';
import { Screen } from '@/components/shell/screen';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { useGrants } from '@/lib/grants';
import { useColors } from '@/theme';

/**
 * Quick setup for the AI teammate, full screen (HANDSFREEOS_AI_QUICK_SETUP_IMPLEMENTATION_PLAN.md §8): from More,
 * Getting started's AI step, the test console while there's no teammate, and links to the web's
 * /ai-team/setup. It's for people who manage the teammate, and it needs signal: everything it asks and keeps is
 * HandsFreeOS's, so it can carry on what was started on the computer.
 */
export default function AiSetup() {
  const { business } = useBusiness();
  const { at } = useLocalSearchParams<{ at?: string }>();
  const grants = useGrants();
  const allowed = holds(grants, 'ai_team.manage');
  const calls = React.useMemo(() => aiSetupCalls(business.id), [business.id]);
  const { start, retry } = useAiSetupStart(calls, allowed);
  const colors = useColors();

  if (allowed && start.state === 'ready')
    return (
      <AiQuickSetup
        workspaceId={business.id}
        got={start.got}
        findings={start.findings}
        startAt={at === 'try' ? 'try' : null}
        calls={calls}
      />
    );

  return (
    <Screen title={AI_SETUP_WORDS.quickSetup} leading="close" ask={false} testID="ai-setup">
      {!allowed ? (
        <Waiting title={P.notAllowed} body={P.notAllowedHint} testID="ai-setup-not-allowed" />
      ) : start.state === 'loading' ? (
        <View className="items-center py-16" testID="ai-setup-loading">
          <ActivityIndicator color={colors.text3} />
        </View>
      ) : start.state === 'offline' ? (
        <Waiting title={P.needsSignal} testID="ai-setup-offline" />
      ) : (
        <Waiting
          title={start.state === 'failed' ? start.message : ''}
          action={{ label: P.tryAgain, onPress: retry }}
          testID="ai-setup-failed"
        />
      )}
    </Screen>
  );
}

function Waiting({
  title,
  body,
  action,
  testID,
}: {
  title: string;
  body?: string;
  action?: { label: string; onPress: () => void };
  testID: string;
}) {
  return (
    <View className="gap-3 p-1" testID={testID}>
      <Text className="text-[15px] font-semibold leading-[21px]">{title}</Text>
      {body ? <Text className="text-[13px] leading-[18px] text-text-2">{body}</Text> : null}
      {action ? (
        <Button variant="secondary" className="self-start" onPress={action.onPress}>
          {action.label}
        </Button>
      ) : null}
    </View>
  );
}
