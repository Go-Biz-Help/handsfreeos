import {
  GOAL_TRIES,
  goalNote,
  type GoalTry,
  type TodayGoal,
} from '@hfos/core/addons/outreach/goal';
import type { Platform } from '@hfos/core/addons/outreach/networks';
import * as React from 'react';
import { View } from 'react-native';

import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';

/**
 * Today's note on a network short of the day's first messages, as the web's (decision 126, answer 7a): how many short,
 * the real reason, and two or three things to try, each a button to where it's done
 * (packages/core/src/addons/outreach/goal.ts `goalTryPlace`). Get ready says what's left before it starts, so it isn't
 * said twice.
 */
export function GoalNote({
  platform,
  goal,
  onTry,
}: {
  platform: Platform;
  goal: TodayGoal;
  onTry?: (t: GoalTry) => void;
}) {
  const words = goal.why === 'not_ready' ? null : goalNote(goal, platform);
  if (!words) return null;
  return (
    <View className="gap-2 rounded-menu bg-warning-soft px-3 py-2.5" testID="today-goal">
      <Text className="text-[13px] leading-[18px] text-warning-text">{words}</Text>
      {onTry && goal.tries.length ? (
        <View className="flex-row flex-wrap gap-2">
          {goal.tries.map((t) => (
            <Button
              key={t}
              size="md"
              variant="secondary"
              onPress={() => onTry(t)}
              testID={`today-goal-${t}`}
            >
              {GOAL_TRIES[t].label}
            </Button>
          ))}
        </View>
      ) : null}
    </View>
  );
}
