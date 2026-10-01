import { THREAD_WORDS, type MediaShape } from '@hfos/core';
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { StatusBar } from 'expo-status-bar';
import * as React from 'react';
import {
  Animated,
  Image,
  Modal,
  PanResponder,
  Pressable,
  ScrollView,
  View,
  useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Share, X } from '@/components/icons';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { toast, ToastLayer } from '@/components/ui/toast';

/** How far a drag goes, or how fast it's moving when let go, before it closes the photo rather than putting it back. */
const CLOSE_DISTANCE = 120;
const CLOSE_SPEED = 1;
const MOST_ZOOM = 4;

/**
 * A photo from a message, full screen over the thread, as the phone's own Messages app shows one: black all round,
 * the photo fitted to the screen, Close and Share at the top. Pinch to zoom (on an iPhone, where the scroll view does
 * it natively), tap to hide or show the buttons, and drag it up or down to put it away. Share hands the photo to the
 * phone's share sheet, where Save Image puts it in Photos without the app asking for the photo library.
 *
 * Kept mounted while it closes, so it fades out; whoever shows it gives it a new `key` each time it opens, so every
 * opening starts unzoomed and in place.
 */
export function PhotoViewer({
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
  const { width, height } = useWindowDimensions();
  const [buttons, setButtons] = React.useState(true);
  const [zoomed, setZoomed] = React.useState(false);
  const [sharing, setSharing] = React.useState(false);
  const drag = React.useRef(new Animated.Value(0)).current;

  // The drag is set up once; these are what it reads when it moves.
  const latest = React.useRef({ zoomed, height, onClose });
  React.useEffect(() => {
    latest.current = { zoomed, height, onClose };
  });

  const pan = React.useRef(
    PanResponder.create({
      // One finger, mostly up or down, on a photo that isn't zoomed in: zoomed in, a drag looks around the photo.
      onMoveShouldSetPanResponderCapture: (_, g) =>
        !latest.current.zoomed &&
        g.numberActiveTouches === 1 &&
        Math.abs(g.dy) > 10 &&
        Math.abs(g.dy) > Math.abs(g.dx) * 1.5,
      onPanResponderMove: (_, g) => drag.setValue(g.dy),
      onPanResponderRelease: (_, g) => {
        if (Math.abs(g.dy) > CLOSE_DISTANCE || Math.abs(g.vy) > CLOSE_SPEED) {
          Animated.timing(drag, {
            toValue: (g.dy < 0 ? -1 : 1) * latest.current.height,
            duration: 180,
            useNativeDriver: true,
          }).start(() => latest.current.onClose());
        } else {
          Animated.spring(drag, { toValue: 0, bounciness: 0, useNativeDriver: true }).start();
        }
      },
      onPanResponderTerminate: () =>
        Animated.spring(drag, { toValue: 0, bounciness: 0, useNativeDriver: true }).start(),
    }),
  ).current;

  async function share() {
    setSharing(true);
    try {
      await sharePhoto(media, url);
    } catch {
      toast.error(THREAD_WORDS.photoWontShare);
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
      <View className="flex-1" accessibilityViewIsModal testID="photo-viewer">
        <Animated.View
          className="flex-1"
          style={{ transform: [{ translateY: drag }] }}
          {...pan.panHandlers}
        >
          <ScrollView
            maximumZoomScale={MOST_ZOOM}
            minimumZoomScale={1}
            centerContent
            bouncesZoom
            scrollEnabled={zoomed}
            showsHorizontalScrollIndicator={false}
            showsVerticalScrollIndicator={false}
            scrollEventThrottle={16}
            onScroll={(e) => setZoomed(e.nativeEvent.zoomScale > 1.01)}
            contentContainerStyle={{ width, height }}
          >
            <Pressable
              accessible
              accessibilityRole="image"
              accessibilityLabel={media.name}
              onPress={() => setButtons((shown) => !shown)}
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
        </Animated.View>
        {buttons ? (
          <Animated.View
            className="absolute left-0 right-0 top-0 flex-row items-center gap-1 bg-black/50 px-1.5 pb-1.5"
            style={{ paddingTop: insets.top + 4, opacity: barFade }}
          >
            <Pressable
              role="button"
              accessibilityLabel={THREAD_WORDS.closePhoto}
              onPress={onClose}
              hitSlop={6}
              className="size-11 items-center justify-center"
              testID="photo-viewer-close"
            >
              <Icon as={X} className="size-6 text-white" />
            </Pressable>
            <Text
              numberOfLines={1}
              className="flex-1 text-center text-[15px] font-semibold text-white"
            >
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
              testID="photo-viewer-share"
            >
              <Icon
                as={Share}
                className={sharing ? 'size-[22px] text-white/50' : 'size-[22px] text-white'}
              />
            </Pressable>
          </Animated.View>
        ) : null}
        <ToastLayer />
      </View>
    </Modal>
  );
}

/**
 * The photo into the phone's cache and on to its share sheet: Save Image, Messages, Mail, Files, a printer. Nothing is
 * kept; the cache is the phone's to clear, and sharing the same photo again writes over it.
 */
async function sharePhoto(media: MediaShape, url: string): Promise<void> {
  if (!(await Sharing.isAvailableAsync())) throw new Error('This phone can’t save or share files.');
  const base = media.name.replace(/[^\w.-]+/g, '-').replace(/^[-.]+/, '') || 'photo';
  const name = /\.\w+$/.test(base) ? base : `${base}.${media.contentType.split('/')[1] || 'jpg'}`;
  const file = await File.downloadFileAsync(url, new File(Paths.cache, name), {
    idempotent: true,
  });
  await Sharing.shareAsync(file.uri, { mimeType: media.contentType, dialogTitle: media.name });
}
