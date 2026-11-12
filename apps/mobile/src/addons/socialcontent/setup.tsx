import {
  setupDone,
  setupSteps,
  type SetupFacts,
  type SetupStep,
} from '@hfos/core/addons/socialcontent/picking';
import { SOCIALCONTENT_WORDS as W } from '@hfos/core/addons/socialcontent/words';
import { View } from 'react-native';

import { Check, Circle, CircleDashed, Minus } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';

import { Part } from './kit';

/**
 * Setting up on its own on the phone (docs/socialcontent.md, "Setting up on its own"; decisions 28 to 33), on top of
 * Creators as on the web: each step with where it stands, from core's `setupSteps`, and a press to fix what one waits
 * on. Shown until every step is done or turned off.
 */

const ICONS = { done: Check, doing: CircleDashed, waiting: Circle, off: Minus } as const;

export function SetupPart({
  setup,
  now,
  mayManage,
  onFix,
}: {
  setup: SetupFacts | undefined;
  now: number;
  mayManage: boolean;
  onFix: (fix: NonNullable<SetupStep['fix']>) => void;
}) {
  if (!setup) return null;
  const steps = setupSteps(setup, now);
  if (setupDone(steps)) return null;
  return (
    <Part title={W.setup.title} about={W.setup.intro} testID="socialcontent-setup">
      {steps.map((s) => (
        <View
          key={s.key}
          className="flex-row items-start gap-2.5"
          testID={`socialcontent-setup-${s.key}`}
        >
          <Icon
            as={ICONS[s.state]}
            accessibilityLabel={W.setup.states[s.state]}
            className={cn(
              'mt-0.5 size-4',
              s.state === 'done' ? 'text-success-text' : null,
              s.state === 'doing' ? 'text-accent-text' : null,
              s.state === 'waiting' || s.state === 'off' ? 'text-text-3' : null,
            )}
          />
          <View className="flex-1 gap-0.5">
            <Text className="text-[13.5px] font-medium">{s.title}</Text>
            <Text className="text-[13px] leading-[18px] text-text-2">{s.line}</Text>
            {s.fix && s.fix !== 'niches' && mayManage ? (
              <Button
                size="sm"
                variant="secondary"
                className="mt-1 self-start"
                onPress={() => onFix(s.fix!)}
                testID={`socialcontent-setup-fix-${s.key}`}
              >
                {W.setup.fix[s.fix]}
              </Button>
            ) : null}
          </View>
        </View>
      ))}
    </Part>
  );
}
