import { THREAD_WORDS, type MediaShape } from '@hfos/core';
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { StatusBar } from 'expo-status-bar';
import { useEvent } from 'expo';
import { useVideoPlayer, VideoView } from 'expo-video';
import * as React from 'react';
import {
  ActivityIndicator,
  Animated,
  Image,
  Modal,
  PanResponder,
  Platform,
  Pressable,
  ScrollView,
  View,
  useWindowDimensions,
  type NativeTouchEvent,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Share, X } from '@/components/icons';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { toast, ToastLayer } from '@/components/ui/toast';

import {
  DOUBLE_TAP_ZOOM,
  doubleTapped,
  fingersAt,
  MOST_ZOOM,
  panned,
  pinched,
  UNZOOMED,
  type Point,
  type Size,
  type Zoom,
} from './photo-zoom';

/** How far a drag goes, or how fast it's moving when let go, before it closes the photo rather than putting it back. */
const CLOSE_DISTANCE = 120;
const CLOSE_SPEED = 1;
/** Two taps closer together than this are a double tap; a single tap waits this long to be sure it is one. */
const DOUBLE_TAP_MS = 250;
/** A finger that moves less than this is tapping, not dragging. */
const TAP_SLOP = 10;

/** Putting the photo away by dragging it: shared by both phones' gestures. */
interface Swipe {
  move(dy: number): void;
  release(dy: number, vy: number): void;
  cancel(): void;
}

/**
 * A photo or a video from a message, full screen over the thread, as the phone's own Messages app shows one: black
 * all round, fitted to the screen, Close and Share at the top. Share hands it to the phone's share sheet, where Save
 * Image or Save Video puts it in Photos without the app asking for the photo library.
 *
 * A photo: pinch or double-tap to zoom, tap to hide or show the buttons, and drag it up or down to put it away. An
 * iPhone's scroll view zooms natively; Android's can't, so there the photo follows the fingers itself.
 *
 * A video plays straight away with the phone's own controls (expo-video), under the buttons rather than behind them.
 *
 * Kept mounted while it closes, so it fades out; whoever shows it gives it a new `key` each time it opens, so every
 * opening starts unzoomed, in place and from the beginning.
 */
export function MediaViewer({
  media,
  url,
  open,
  onClose,
}: {
  media: MediaShape;
  url: string;
  open: boolean;
  onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const video = media.contentType.startsWith('video/');
  const kind = video ? 'video' : 'photo';
  const [buttons, setButtons] = React.useState(true);
  const [sharing, setSharing] = React.useState(false);
  const drag = React.useRef(new Animated.Value(0)).current;

  // The gestures are set up once; these are what they read when they end.
  const latest = React.useRef({ height, onClose });
  React.useEffect(() => {
    latest.current = { height, onClose };
  });
  const [swipe] = React.useState<Swipe>(() => ({
    move: (dy) => drag.setValue(dy),
    release: (dy, vy) => {
      if (Math.abs(dy) > CLOSE_DISTANCE || Math.abs(vy) > CLOSE_SPEED) {
        Animated.timing(drag, {
          toValue: (dy < 0 ? -1 : 1) * latest.current.height,
          duration: 180,
          useNativeDriver: true,
        }).start(() => latest.current.onClose());
      } else {
        Animated.spring(drag, { toValue: 0, bounciness: 0, useNativeDriver: true }).start();
      }
    },
    cancel: () =>
      Animated.spring(drag, { toValue: 0, bounciness: 0, useNativeDriver: true }).start(),
  }));
  const toggleButtons = React.useCallback(() => setButtons((shown) => !shown), []);

  async function share() {
    setSharing(true);
    try {
      await shareMedia(media, url);
    } catch {
      toast.error(video ? THREAD_WORDS.videoWontShare : THREAD_WORDS.photoWontShare);
    } finally {
      setSharing(false);
    }
  }

  // The black thins and the buttons go as the photo is dragged away, so the thread shows through.
  const backdrop = drag.interpolate({
    inputRange: [-height, 0, height],
    outputRange: [0, 1, 0],
    extrapolate: 'clamp',
  });
  const barFade = drag.interpolate({
    inputRange: [-80, 0, 80],
    outputRange: [0, 1, 0],
    extrapolate: 'clamp',
  });

  const bar = (
    <>
      <Pressable
        role="button"
        accessibilityLabel={THREAD_WORDS.closePhoto}
        onPress={onClose}
        hitSlop={6}
        className="size-11 items-center justify-center"
        testID={`${kind}-viewer-close`}
      >
        <Icon as={X} className="size-6 text-white" />
      </Pressable>
      <Text numberOfLines={1} className="flex-1 text-center text-[15px] font-semibold text-white">
        {media.name}
      </Text>
      <Pressable
        role="button"
        accessibilityLabel={THREAD_WORDS.sharePhoto}
        accessibilityState={{ busy: sharing }}
        disabled={sharing}
        onPress={() => void share()}
        hitSlop={6}
        className="size-11 items-center justify-center"
        testID={`${kind}-viewer-share`}
      >
        <Icon
          as={Share}
          className={sharing ? 'size-[22px] text-white/50' : 'size-[22px] text-white'}
        />
      </Pressable>
    </>
  );

  const Photo = Platform.OS === 'ios' ? ScrollZoomPhoto : TouchZoomPhoto;
  return (
    <Modal
      transparent
      visible={open}
      animationType="fade"
      onRequestClose={onClose}
      statusBarTranslucent
      navigationBarTranslucent
      supportedOrientations={['portrait', 'landscape']}
    >
      <StatusBar style="light" hidden={!buttons} />
      <Animated.View className="absolute inset-0 bg-black" style={{ opacity: backdrop }} />
      <View className="flex-1" accessibilityViewIsModal testID={`${kind}-viewer`}>
        {video ? (
          // The phone's own controls take the video's taps and drags, so it has no swipe or tap of ours: the
          // buttons sit above it, and Close or the back button puts it away.
          <View className="flex-1" style={{ paddingBottom: insets.bottom }}>
            <View
              className="flex-row items-center gap-1 px-1.5 pb-1.5"
              style={{ paddingTop: insets.top + 4 }}
            >
              {bar}
            </View>
            <PlayingVideo url={url} name={media.name} />
          </View>
        ) : (
          <>
            <Animated.View className="flex-1" style={{ transform: [{ translateY: drag }] }}>
              <Photo url={url} name={media.name} swipe={swipe} onTap={toggleButtons} />
            </Animated.View>
            {buttons ? (
              <Animated.View
                className="absolute left-0 right-0 top-0 flex-row items-center gap-1 bg-black/50 px-1.5 pb-1.5"
                style={{ paddingTop: insets.top + 4, opacity: barFade }}
              >
                {bar}
              </Animated.View>
            ) : null}
          </>
        )}
        <ToastLayer />
      </View>
    </Modal>
  );
}

/**
 * The video, playing from the start with the phone's own controls. One the phone can't play (an iPhone with a
 * carrier's 3GP from before they were kept as MP4s) says so, and Share still hands it to an app that can.
 */
function PlayingVideo({ url, name }: { url: string; name: string }) {
  const player = useVideoPlayer(url, (p) => p.play());
  const { status } = useEvent(player, 'statusChange', { status: player.status });
  if (status === 'error')
    return (
      <View className="flex-1 items-center justify-center px-8">
        <Text className="text-center text-[15px] text-white/80" testID="video-viewer-unplayable">
          {THREAD_WORDS.videoWontPlayShare}
        </Text>
      </View>
    );
  return (
    <View className="flex-1">
      <VideoView
        player={player}
        nativeControls
        contentFit="contain"
        accessibilityLabel={name}
        style={{ flex: 1 }}
        testID="video-viewer-player"
      />
      {status === 'loading' ? (
        <View className="absolute inset-0 items-center justify-center" pointerEvents="none">
          <ActivityIndicator color="white" />
        </View>
      ) : null}
    </View>
  );
}

interface PhotoProps {
  url: string;
  name: string;
  swipe: Swipe;
  onTap: () => void;
}

/**
 * One tap calls `single`, after waiting long enough to know no second tap is coming; two quick taps in about the same
 * spot call `double` with where the second one was.
 */
function useTaps(single: () => void, double: (at: Point) => void): (at: Point) => void {
  const last = React.useRef<{ time: number; at: Point } | null>(null);
  const waiting = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  React.useEffect(() => () => clearTimeout(waiting.current), []);
  return (at) => {
    const now = Date.now();
    const before = last.current;
    clearTimeout(waiting.current);
    if (
      before &&
      now - before.time < DOUBLE_TAP_MS &&
      Math.hypot(at.x - before.at.x, at.y - before.at.y) < 40
    ) {
      last.current = null;
      double(at);
      return;
    }
    last.current = { time: now, at };
    waiting.current = setTimeout(single, DOUBLE_TAP_MS);
  };
}

/**
 * An iPhone's: the scroll view pinches, pans and bounces natively, and zooms to a rectangle on a double tap. Unzoomed,
 * a drag up or down is taken from it to put the photo away; zoomed in, a drag looks around the photo.
 */
function ScrollZoomPhoto({ url, name, swipe, onTap }: PhotoProps) {
  const { width, height } = useWindowDimensions();
  const scroll = React.useRef<ScrollView>(null);
  const [zoomed, setZoomed] = React.useState(false);
  const zoomedNow = React.useRef(false);
  const [pan] = React.useState(() =>
    PanResponder.create({
      onMoveShouldSetPanResponderCapture: (_, g) =>
        !zoomedNow.current &&
        g.numberActiveTouches === 1 &&
        Math.abs(g.dy) > TAP_SLOP &&
        Math.abs(g.dy) > Math.abs(g.dx) * 1.5,
      onPanResponderMove: (_, g) => swipe.move(g.dy),
      onPanResponderRelease: (_, g) => swipe.release(g.dy, g.vy),
      onPanResponderTerminate: () => swipe.cancel(),
    }),
  );
  const tap = useTaps(onTap, (at) =>
    scroll.current?.scrollResponderZoomTo(
      zoomedNow.current
        ? { x: 0, y: 0, width, height }
        : {
            x: at.x - width / DOUBLE_TAP_ZOOM / 2,
            y: at.y - height / DOUBLE_TAP_ZOOM / 2,
            width: width / DOUBLE_TAP_ZOOM,
            height: height / DOUBLE_TAP_ZOOM,
          },
    ),
  );
  return (
    <View className="flex-1" {...pan.panHandlers}>
      <ScrollView
        ref={scroll}
        maximumZoomScale={MOST_ZOOM}
        minimumZoomScale={1}
        centerContent
        bouncesZoom
        scrollEnabled={zoomed}
        showsHorizontalScrollIndicator={false}
        showsVerticalScrollIndicator={false}
        scrollEventThrottle={16}
        onScroll={(e) => {
          zoomedNow.current = e.nativeEvent.zoomScale > 1.01;
          setZoomed(zoomedNow.current);
        }}
        contentContainerStyle={{ width, height }}
      >
        <Pressable
          accessible
          accessibilityRole="image"
          accessibilityLabel={name}
          onPress={(e) => tap({ x: e.nativeEvent.locationX, y: e.nativeEvent.locationY })}
          style={{ width, height }}
        >
          <Image
            source={{ uri: url }}
            accessibilityIgnoresInvertColors
            resizeMode="contain"
            style={{ width, height }}
          />
        </Pressable>
      </ScrollView>
    </View>
  );
}

/** Where a gesture on Android's photo started, and what it has turned out to be so far. */
interface Touching {
  fingers: number;
  start: Zoom;
  focus: Point;
  distance: number;
  startedAt: number;
  moved: boolean;
  /** Two fingers were down at some point: letting one go doesn't turn the pinch into a swipe. */
  pinched: boolean;
  /** Decided on the first real movement: a mostly up-or-down drag on an unzoomed photo puts it away. */
  swiping: boolean | null;
}

/**
 * Android's: its scroll view can't zoom, so the photo follows the fingers (the arithmetic is in `photo-zoom.ts`).
 * Two fingers pinch, one moves a zoomed-in photo or, unzoomed, drags it away; taps go through `useTaps`.
 */
function TouchZoomPhoto({ url, name, swipe, onTap }: PhotoProps) {
  const size = React.useRef<Size>({ width: 0, height: 0 });
  const zoom = React.useRef<Zoom>(UNZOOMED);
  const touching = React.useRef<Touching | null>(null);
  const [scale] = React.useState(() => new Animated.Value(1));
  const [x] = React.useState(() => new Animated.Value(0));
  const [y] = React.useState(() => new Animated.Value(0));

  const tap = useTaps(onTap, (at) => {
    zoom.current = doubleTapped(zoom.current, at, size.current);
    Animated.parallel(
      (
        [
          [scale, zoom.current.scale],
          [x, zoom.current.x],
          [y, zoom.current.y],
        ] as const
      ).map(([value, toValue]) =>
        Animated.timing(value, { toValue, duration: 220, useNativeDriver: true }),
      ),
    ).start();
  });
  const latestTap = React.useRef(tap);
  React.useEffect(() => {
    latestTap.current = tap;
  });

  const [pan] = React.useState(() => {
    const show = (next: Zoom) => {
      zoom.current = next;
      scale.setValue(next.scale);
      x.setValue(next.x);
      y.setValue(next.y);
    };
    // A finger landing or lifting starts the gesture again from where the photo is now.
    const begin = (touches: readonly NativeTouchEvent[]) => {
      const was = touching.current;
      if (was?.swiping) swipe.cancel();
      const at = fingersAt(touches, size.current);
      touching.current = {
        fingers: touches.length,
        start: zoom.current,
        focus: at.focus,
        distance: at.distance,
        startedAt: was?.startedAt ?? Date.now(),
        moved: was?.moved ?? false,
        pinched: (was?.pinched ?? false) || touches.length > 1,
        swiping: was ? false : null,
      };
    };
    return PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: (e) => {
        touching.current = null;
        begin(e.nativeEvent.touches);
      },
      onPanResponderMove: (e, g) => {
        const touches = e.nativeEvent.touches;
        const now = touching.current;
        if (!now || touches.length === 0) return;
        if (touches.length !== now.fingers) return begin(touches);
        const at = fingersAt(touches, size.current);
        if (touches.length > 1) {
          now.moved = true;
          return show(pinched(now.start, now, at, size.current));
        }
        const by = { x: at.focus.x - now.focus.x, y: at.focus.y - now.focus.y };
        if (!now.moved && Math.hypot(by.x, by.y) < TAP_SLOP) return;
        now.moved = true;
        if (zoom.current.scale > 1.01) return show(panned(now.start, by, size.current));
        if (now.swiping === null)
          now.swiping = !now.pinched && Math.abs(by.y) > Math.abs(by.x) * 1.5;
        if (now.swiping) swipe.move(g.dy);
      },
      onPanResponderRelease: (_, g) => {
        const now = touching.current;
        touching.current = null;
        if (!now) return;
        if (now.swiping) swipe.release(g.dy, g.vy);
        else if (!now.moved && Date.now() - now.startedAt < 300) latestTap.current(now.focus);
      },
      onPanResponderTerminate: () => {
        if (touching.current?.swiping) swipe.cancel();
        touching.current = null;
      },
    });
  });

  return (
    <View
      className="flex-1 overflow-hidden"
      accessible
      accessibilityRole="image"
      accessibilityLabel={name}
      onLayout={(e) => {
        size.current = e.nativeEvent.layout;
      }}
      testID="photo-viewer-photo"
      {...pan.panHandlers}
    >
      <Animated.Image
        source={{ uri: url }}
        accessibilityIgnoresInvertColors
        resizeMode="contain"
        testID="photo-viewer-zoom"
        style={{
          width: '100%',
          height: '100%',
          transform: [{ translateX: x }, { translateY: y }, { scale }],
        }}
      />
    </View>
  );
}

/**
 * The photo or video into the phone's cache and on to its share sheet: Save Image or Save Video, Messages, Mail, Files.
 * Nothing is kept; the cache is the phone's to clear, and sharing the same one again writes over it.
 */
async function shareMedia(media: MediaShape, url: string): Promise<void> {
  if (!(await Sharing.isAvailableAsync())) throw new Error('This phone can’t save or share files.');
  const base = media.name.replace(/[^\w.-]+/g, '-').replace(/^[-.]+/, '') || 'photo';
  const name = /\.\w+$/.test(base) ? base : `${base}.${media.contentType.split('/')[1] || 'jpg'}`;
  const file = await File.downloadFileAsync(url, new File(Paths.cache, name), {
    idempotent: true,
  });
  await Sharing.shareAsync(file.uri, { mimeType: media.contentType, dialogTitle: media.name });
}
