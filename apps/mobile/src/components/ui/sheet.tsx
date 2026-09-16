import * as React from 'react';
import {
  AccessibilityInfo,
  Animated,
  Easing,
  Modal,
  Pressable,
  ScrollView,
  View,
  useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Text } from '@/components/ui/text';
import { ToastLayer } from '@/components/ui/toast';
import { cn } from '@/lib/utils';
import { shadows } from '@/theme/tokens';
import { useThemeName } from '@/theme';

export interface SheetProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  description?: React.ReactNode;
  children?: React.ReactNode;
  /** Scrolls when its content is taller than most of the screen (a long list of businesses). */
  scroll?: boolean;
  testID?: string;
  className?: string;
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

/**
 * A bottom sheet, as the phone boards draw them and the web's sheet does at phone width: the scrim, a card with a
 * 16 px top radius and a grab handle, sliding up from the bottom. Tapping the scrim or the phone's back button
 * closes it. Built on React Native's Modal, so it sits above everything, the tab bar included; a toast shown while
 * it's open appears over it.
 */
function Sheet({
  open,
  onClose,
  title,
  description,
  children,
  scroll,
  testID,
  className,
}: SheetProps) {
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const theme = useThemeName();
  const reduceMotion = useReduceMotion();
  const [mounted, setMounted] = React.useState(open);
  const progress = React.useRef(new Animated.Value(open ? 1 : 0)).current;

  React.useEffect(() => {
    if (open) setMounted(true);
    const animation = Animated.timing(progress, {
      toValue: open ? 1 : 0,
      duration: reduceMotion ? 0 : open ? 240 : 180,
      easing: open ? Easing.out(Easing.cubic) : Easing.in(Easing.cubic),
      useNativeDriver: true,
    });
    animation.start(({ finished }) => {
      if (finished && !open) setMounted(false);
    });
    return () => animation.stop();
  }, [open, progress, reduceMotion]);

  const body = (
    <>
      {title ? <Text variant="sheetTitle">{title}</Text> : null}
      {description ? (
        typeof description === 'string' ? (
          <Text className="mt-1 text-sm leading-5 text-text-2">{description}</Text>
        ) : (
          description
        )
      ) : null}
      {children}
    </>
  );

  return (
    <Modal
      transparent
      visible={mounted}
      animationType="none"
      onRequestClose={onClose}
      statusBarTranslucent
      navigationBarTranslucent
    >
      <Animated.View className="absolute inset-0 bg-scrim" style={{ opacity: progress }}>
        <Pressable
          className="flex-1"
          accessibilityLabel="Close"
          accessibilityRole="button"
          onPress={onClose}
          testID={testID ? `${testID}-scrim` : undefined}
        />
      </Animated.View>
      {/* The sheet, and a toast shown while it's open; screen readers stay in here and skip the scrim. */}
      <View className="absolute inset-0" pointerEvents="box-none" accessibilityViewIsModal>
        <Animated.View
          testID={testID}
          className={cn(
            'absolute bottom-0 left-0 right-0 rounded-t-2xl bg-card px-4 pt-2.5',
            className,
          )}
          style={{
            maxHeight: height * 0.9,
            paddingBottom: Math.max(insets.bottom, 12) + 12,
            boxShadow: shadows[theme].shadow3,
            transform: [
              {
                translateY: progress.interpolate({
                  inputRange: [0, 1],
                  outputRange: [height * 0.6, 0],
                }),
              },
            ],
          }}
        >
          <View className="mb-3 h-1 w-10 self-center rounded-full bg-border-strong" />
          {scroll ? (
            <ScrollView bounces={false} showsVerticalScrollIndicator={false}>
              {body}
            </ScrollView>
          ) : (
            body
          )}
        </Animated.View>
        <ToastLayer />
      </View>
    </Modal>
  );
}

export { Sheet };
