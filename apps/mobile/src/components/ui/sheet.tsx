import * as React from 'react';
import {
  AccessibilityInfo,
  Animated,
  Easing,
  Modal,
  PanResponder,
  Platform,
  Pressable,
  ScrollView,
  TextInput,
  View,
  useWindowDimensions,
  type PanResponderGestureState,
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
  /**
   * Called once the sheet is gone: its slide-down has finished and, on iOS, its modal has been dismissed. Anything
   * that opens another sheet (or anything else modal) waits for this, since iOS presents nothing while a modal is
   * still going.
   */
  onClosed?: () => void;
  title?: string;
  description?: React.ReactNode;
  children?: React.ReactNode;
  /** Scrolls when its content is taller than most of the screen (a long list of businesses). */
  scroll?: boolean;
  testID?: string;
  className?: string;
}

/** How far a finger goes down before it's dragging the sheet rather than pressing what's under it. */
const DRAG_SLOP = 8;
/** Let go this far down (or a third of the way, for a short sheet) and it closes; short of that, it goes back up. */
const CLOSE_DISTANCE = 120;
/** Or let go still moving down this fast, in points a millisecond: a flick closes it from anywhere. */
const CLOSE_SPEED = 0.5;

/** One finger, going mostly down, past the slop. */
function draggingDown(g: PanResponderGestureState): boolean {
  return g.numberActiveTouches === 1 && g.dy > DRAG_SLOP && g.dy > Math.abs(g.dx) * 1.5;
}

/** Whether letting go with the sheet `dy` down, moving at `vy`, puts it away. */
function closesAt(dy: number, vy: number, sheetHeight: number): boolean {
  if (vy >= CLOSE_SPEED) return dy > 0;
  if (vy <= -CLOSE_SPEED) return false;
  return dy >= (sheetHeight > 0 ? Math.min(CLOSE_DISTANCE, sheetHeight / 3) : CLOSE_DISTANCE);
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
 * closes it, and so does dragging it down from anywhere on it, as the phone's own sheets do: a third of the way down
 * (120 points at most), or a flick. One that scrolls drags only once its list is back at the top, a list inside it
 * that starts scrolling takes the finger back, and so does the field being typed in. On Android a list long enough to scroll keeps a drag that starts on
 * it (the phone hands it the touch before the app can ask), so there its handle drags it. Built on React Native's
 * Modal, so it sits above everything, the tab bar included; a toast shown while it's open appears over it.
 *
 * Only one modal can be up at a time on iOS: a second one asked to present while the first is still being dismissed
 * never appears. So a sheet that leads to another (the conversation's Details and actions) opens the next from
 * `onClosed`, which fires once this one's modal is really gone. On iOS the Modal says when that is through
 * `onDismiss`; elsewhere the modal goes with the sheet's unmount, so it fires right after.
 */
function Sheet({
  open,
  onClose,
  onClosed,
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
  const closed = React.useRef(onClosed);
  closed.current = onClosed;
  // True while the modal is being dismissed on iOS, until it says it's gone.
  const dismissing = React.useRef(false);

  // How far a finger has dragged the sheet down, on top of its slide.
  const drag = React.useRef(new Animated.Value(0)).current;
  const sheetHeight = React.useRef(0);
  // How far its own list is scrolled: it drags down only from the top.
  const scrolled = React.useRef(0);
  // The finger went down on the field being typed in, whose own text it may be scrolling.
  const onField = React.useRef(false);
  // Let go on its way down: it carries on down at speed, rather than easing off as a tap on the scrim does.
  const flung = React.useRef(false);
  // The drag is set up once; this is what it reads as it goes.
  const latest = React.useRef({ open, onClose, reduceMotion });
  latest.current = { open, onClose, reduceMotion };
  const [pan] = React.useState(() => {
    const back = () =>
      (latest.current.reduceMotion
        ? Animated.timing(drag, { toValue: 0, duration: 0, useNativeDriver: true })
        : Animated.spring(drag, { toValue: 0, bounciness: 0, speed: 18, useNativeDriver: true })
      ).start();
    return PanResponder.create({
      onStartShouldSetPanResponderCapture: (e) => {
        const typing = TextInput.State.currentlyFocusedInput();
        onField.current = typing != null && e.target === typing;
        return false;
      },
      // Asked as the finger moves, after whatever it's on (a row, a field) has had the chance to keep it.
      onMoveShouldSetPanResponder: (_e, g) =>
        !onField.current && scrolled.current <= 0 && draggingDown(g),
      onPanResponderGrant: () => drag.stopAnimation(),
      onPanResponderMove: (_e, g) => drag.setValue(Math.max(0, g.dy)),
      onPanResponderRelease: (_e, g) => {
        if (!closesAt(g.dy, g.vy, sheetHeight.current)) {
          back();
          return;
        }
        flung.current = true;
        latest.current.onClose();
        // One whose owner keeps it open (it's still saving, say) goes back up.
        setTimeout(() => {
          if (!latest.current.open) return;
          flung.current = false;
          back();
        }, 0);
      },
      onPanResponderTerminate: back,
      // A list inside it that starts scrolling takes the finger back.
      onPanResponderTerminationRequest: () => true,
    });
  });

  React.useEffect(() => {
    if (open) {
      dismissing.current = false;
      flung.current = false;
      scrolled.current = 0;
      drag.setValue(0);
      setMounted(true);
    }
    const animation = Animated.timing(progress, {
      toValue: open ? 1 : 0,
      duration: reduceMotion ? 0 : open ? 240 : 180,
      easing: open || flung.current ? Easing.out(Easing.cubic) : Easing.in(Easing.cubic),
      useNativeDriver: true,
    });
    animation.start(({ finished }) => {
      if (!finished || open) return;
      setMounted(false);
      drag.setValue(0);
      if (Platform.OS === 'ios') dismissing.current = true;
      else closed.current?.();
    });
    return () => animation.stop();
  }, [open, progress, drag, reduceMotion]);

  // The scrim thins as the sheet is dragged down, so it's gone as the sheet is.
  const scrim = React.useMemo(
    () =>
      Animated.multiply(
        progress,
        drag.interpolate({ inputRange: [0, height], outputRange: [1, 0], extrapolate: 'clamp' }),
      ),
    [progress, drag, height],
  );
  const slide = React.useMemo(
    () =>
      Animated.add(
        progress.interpolate({ inputRange: [0, 1], outputRange: [height * 0.6, 0] }),
        drag,
      ),
    [progress, drag, height],
  );

  const onDismiss = () => {
    if (!dismissing.current) return;
    dismissing.current = false;
    closed.current?.();
  };

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
      onDismiss={onDismiss}
      statusBarTranslucent
      navigationBarTranslucent
    >
      <Animated.View className="absolute inset-0 bg-scrim" style={{ opacity: scrim }}>
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
            transform: [{ translateY: slide }],
          }}
          onLayout={(e) => {
            sheetHeight.current = e.nativeEvent.layout.height;
          }}
          {...pan.panHandlers}
        >
          <View className="mb-3 h-1 w-10 self-center rounded-full bg-border-strong" />
          {scroll ? (
            <ScrollView
              bounces={false}
              showsVerticalScrollIndicator={false}
              scrollEventThrottle={16}
              onScroll={(e) => {
                scrolled.current = e.nativeEvent.contentOffset.y;
              }}
              testID={testID ? `${testID}-scroll` : undefined}
            >
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
