import { router } from 'expo-router';
import * as React from 'react';
import { AccessibilityInfo, Animated, Easing, Pressable, View } from 'react-native';

import { ChevronRight, CloudOff, CloudUpload } from '@/components/icons';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { stripText, useSyncStatus, type SyncStatus } from '@/lib/sync-status';
import { cn } from '@/lib/utils';

import { businessHref, useOptionalBusiness } from './business-context';
import { useSettledWhileTouched } from './touches';

/** The strip's height with one line of words: what it opens to before it has measured itself. */
export const STRIP_HEIGHT = 40;
/** How long it takes to open or close. */
export const STRIP_MOTION_MS = 200;

interface Shown {
  readonly text: string;
  readonly offline: boolean;
}

function useReduceMotion(): boolean {
  const [reduce, setReduce] = React.useState(false);
  React.useEffect(() => {
    let alive = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((v) => alive && setReduce(v));
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduce);
    return () => {
      alive = false;
      sub.remove();
    };
  }, []);
  return reduce;
}

function shownOf(status: SyncStatus): Shown | null {
  const text = stripText(status);
  if (!text) return null;
  return {
    text,
    offline: status.connection === 'offline' || status.connection === 'unreachable',
  };
}

/**
 * The strip under the top bar while the phone has no signal, can't connect, or has changes still to go: "Offline — 4
 * changes waiting" or "Can’t connect to HandsFreeOS" in amber, or "4 changes waiting to send" in blue once it's
 * connected. It opens Changes on this phone. Otherwise there's no strip; Home and More say "Up to date" instead.
 *
 * It never moves what's under a finger: opening or closing waits until no finger is on the screen (`Screen` reports
 * touches), then slides over 200 ms, so what's below moves with it rather than jumping. New words in a strip already
 * open change at once, since they don't move anything.
 */
export function StatusStrip() {
  const status = useSyncStatus();
  const live = shownOf(status);
  // Compare by value, so a status that says the same thing doesn't count as a change.
  const key = live ? `${live.offline ? 'o' : 'c'}:${live.text}` : null;
  const settledKey = useSettledWhileTouched(key);
  const shown = React.useMemo<Shown | null>(
    () =>
      settledKey === null
        ? null
        : { offline: settledKey.startsWith('o:'), text: settledKey.slice(2) },
    [settledKey],
  );
  return <StripFrame shown={shown} />;
}

/** The strip's frame: opens to its measured height and closes to nothing, keeping its last words while it closes. */
export function StripFrame({ shown }: { shown: Shown | null }) {
  const ctx = useOptionalBusiness();
  const reduceMotion = useReduceMotion();
  const progress = React.useRef(new Animated.Value(shown ? 1 : 0)).current;
  const [height, setHeight] = React.useState(STRIP_HEIGHT);
  const [last, setLast] = React.useState<Shown | null>(shown);
  const open = shown !== null;

  if (shown && (shown.text !== last?.text || shown.offline !== last?.offline)) setLast(shown);

  React.useEffect(() => {
    const animation = Animated.timing(progress, {
      toValue: open ? 1 : 0,
      duration: reduceMotion ? 0 : STRIP_MOTION_MS,
      easing: open ? Easing.out(Easing.cubic) : Easing.in(Easing.cubic),
      useNativeDriver: false,
    });
    animation.start(({ finished }) => {
      if (finished && !open) setLast(null);
    });
    return () => animation.stop();
  }, [open, progress, reduceMotion]);

  const words = shown ?? last;
  if (!words) return null;
  const offline = words.offline;
  return (
    <Animated.View
      testID="status-strip-frame"
      style={{
        height: progress.interpolate({ inputRange: [0, 1], outputRange: [0, height] }),
        overflow: 'hidden',
      }}
    >
      <View
        className="absolute bottom-0 left-0 right-0"
        onLayout={(e) => {
          const next = Math.round(e.nativeEvent.layout.height);
          if (next > 0 && next !== height) setHeight(next);
        }}
      >
        <Pressable
          role="button"
          testID={open ? 'status-strip' : undefined}
          accessibilityLabel={`${words.text}. Open changes on this phone.`}
          accessibilityElementsHidden={!open}
          importantForAccessibility={open ? 'auto' : 'no-hide-descendants'}
          onPress={
            ctx && open ? () => router.push(businessHref(ctx.business.id, 'changes')) : undefined
          }
          disabled={!ctx || !open}
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
            testID={open ? 'status-strip-text' : undefined}
            className={cn(
              'flex-1 text-[13.5px] font-semibold',
              offline ? 'text-warning-text' : 'text-accent-text',
            )}
          >
            {words.text}
          </Text>
          {ctx ? (
            <Icon
              as={ChevronRight}
              className={cn('size-4', offline ? 'text-warning-text' : 'text-accent-text')}
            />
          ) : null}
        </Pressable>
      </View>
    </Animated.View>
  );
}
