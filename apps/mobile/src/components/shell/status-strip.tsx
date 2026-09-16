import { router } from 'expo-router';
import { Pressable } from 'react-native';

import { ChevronRight, CloudOff, CloudUpload } from '@/components/icons';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { stripText, useSyncStatus } from '@/lib/sync-status';
import { cn } from '@/lib/utils';

import { businessHref, useOptionalBusiness } from './business-context';

/**
 * The strip under the top bar while the phone has no signal or changes are still to go: "Offline — 4 changes
 * waiting" in amber, or "4 changes waiting to send" in blue once signal is back. It opens Changes on this phone.
 * With signal and nothing waiting there's no strip; Home and More say "Up to date" instead.
 */
export function StatusStrip() {
  const status = useSyncStatus();
  const ctx = useOptionalBusiness();
  const text = stripText(status);
  if (!text) return null;
  const offline = !status.online;
  return (
    <Pressable
      role="button"
      testID="status-strip"
      accessibilityLabel={`${text}. Open changes on this phone.`}
      onPress={ctx ? () => router.push(businessHref(ctx.business.id, 'changes')) : undefined}
      disabled={!ctx}
      className={cn(
        'min-h-10 flex-row items-center gap-2 border-b pl-3.5 pr-2.5',
        offline ? 'border-warning-soft bg-warning-soft' : 'border-accent-soft bg-accent-soft',
      )}
    >
      <Icon
        as={offline ? CloudOff : CloudUpload}
        className={cn('size-[17px]', offline ? 'text-warning-text' : 'text-accent-text')}
      />
      <Text
        testID="status-strip-text"
        className={cn(
          'flex-1 text-[13.5px] font-semibold',
          offline ? 'text-warning-text' : 'text-accent-text',
        )}
      >
        {text}
      </Text>
      {ctx ? (
        <Icon
          as={ChevronRight}
          className={cn('size-4', offline ? 'text-warning-text' : 'text-accent-text')}
        />
      ) : null}
    </Pressable>
  );
}
