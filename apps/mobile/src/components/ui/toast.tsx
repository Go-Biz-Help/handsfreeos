import { Portal } from '@rn-primitives/portal';
import * as React from 'react';
import { AccessibilityInfo, Animated, Platform, Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';
import { useThemeName } from '@/theme';
import { shadows } from '@/theme/tokens';

export type ToastTone = 'default' | 'danger';

export interface ToastMessage {
  readonly id: number;
  readonly message: string;
  readonly tone: ToastTone;
  readonly action?: { readonly label: string; readonly onPress: () => void };
}

/** How long a toast stays, as on the web (2.6 s); one with a button stays a little longer. */
const DURATION_MS = 2600;
const WITH_ACTION_MS = 5000;

let current: ToastMessage | null = null;
let nextId = 1;
let timer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

function publish(next: ToastMessage | null) {
  current = next;
  for (const listener of listeners) listener();
}

/**
 * A short note about what just happened ("Lone Star HVAC & Roofing kept on this phone"). On a phone the bottom
 * belongs to the tab bar, so toasts come in from the top, under the top bar, as the web's do at phone width. One at
 * a time; a new one replaces the last.
 */
export const toast = {
  show(message: string, options: { tone?: ToastTone; action?: ToastMessage['action'] } = {}) {
    if (timer) clearTimeout(timer);
    const item: ToastMessage = {
      id: nextId++,
      message,
      tone: options.tone ?? 'default',
      action: options.action,
    };
    publish(item);
    if (Platform.OS === 'ios') AccessibilityInfo.announceForAccessibility(message);
    timer = setTimeout(() => publish(null), options.action ? WITH_ACTION_MS : DURATION_MS);
    return item.id;
  },
  error(message: string) {
    return this.show(message, { tone: 'danger' });
  },
  dismiss() {
    if (timer) clearTimeout(timer);
    publish(null);
  },
};

export function useToast(): ToastMessage | null {
  return React.useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
    () => current,
  );
}

/** Renders the toast into the app's PortalHost, above every screen. Put it once, in the root layout. */
function Toaster() {
  const item = useToast();
  if (!item) return null;
  return (
    <Portal name="toast">
      <ToastLayer />
    </Portal>
  );
}

/**
 * The toast itself, for a layer of its own: the Toaster's portal, and each open Sheet, whose native modal would
 * otherwise cover a toast shown while it's open.
 */
function ToastLayer() {
  const item = useToast();
  const insets = useSafeAreaInsets();
  const theme = useThemeName();
  const opacity = React.useRef(new Animated.Value(0)).current;

  React.useEffect(() => {
    if (!item) return;
    opacity.setValue(0);
    Animated.timing(opacity, { toValue: 1, duration: 160, useNativeDriver: true }).start();
  }, [item, opacity]);

  if (!item) return null;
  const danger = item.tone === 'danger';
  return (
    <View
      pointerEvents="box-none"
      className="absolute left-0 right-0 items-center px-4"
      style={{ top: insets.top + 60 }}
    >
      <Animated.View
        accessibilityLiveRegion="polite"
        role="alert"
        testID="toast"
        className={cn(
          'w-full max-w-[420px] flex-row items-center gap-3 rounded-menu border px-3.5 py-3',
          danger ? 'border-transparent bg-danger' : 'border-border bg-card',
        )}
        style={{
          opacity,
          boxShadow: shadows[theme].shadow2,
          transform: [
            { translateY: opacity.interpolate({ inputRange: [0, 1], outputRange: [-8, 0] }) },
          ],
        }}
      >
        <Text
          className={cn('flex-1 text-[14px] leading-5', danger ? 'text-on-solid' : 'text-text')}
        >
          {item.message}
        </Text>
        {item.action ? (
          <Pressable
            role="button"
            hitSlop={10}
            onPress={() => {
              item.action?.onPress();
              toast.dismiss();
            }}
          >
            <Text className={cn('font-semibold', danger ? 'text-on-solid' : 'text-accent-text')}>
              {item.action.label}
            </Text>
          </Pressable>
        ) : null}
      </Animated.View>
    </View>
  );
}

export { ToastLayer, Toaster };
