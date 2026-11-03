/**
 * Marks on a shared screen, on the phone (docs/video-calls.md, "Marks on a shared screen"). The phone watches a
 * screen shared from a computer, so it shows what people point at and draw on it, as the web does: each pointer as a
 * bright dot with their name, a ring where they click, and lines that fade a few seconds after they stop. The board
 * and the rules are core's (`meetings/screen-marks.ts`). Making marks from the phone comes later.
 */
import {
  MARK_PRESS_MS,
  MarksStore,
  SCREEN_MARK_WORDS,
  VIDEO_CALL_MARKS_TOPIC,
  fitIn,
  markFrom,
  type Rect,
  type ScreenMarksView,
  type VideoCallFormat,
} from '@hfos/core';
import { useDataChannel, useRoomContext } from '@livekit/react-native';
import { RoomEvent, Track, type Participant, type TrackPublication } from 'livekit-client';
import * as React from 'react';
import { Animated, StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import Svg, { Polyline } from 'react-native-svg';

import { Text } from '@/components/ui/text';

const MarksContext = React.createContext<MarksStore | null>(null);

/** Listens on the marks topic once for the whole call, and keeps the board each shared screen draws from. */
export function MarksProvider({
  format,
  children,
}: {
  format: VideoCallFormat;
  children: React.ReactNode;
}) {
  const room = useRoomContext();
  const [store] = React.useState(() => new MarksStore());
  useDataChannel(VIDEO_CALL_MARKS_TOPIC, (msg) => {
    const m = markFrom(msg.payload, msg.from, format, (identity) =>
      identity === room.localParticipant.identity
        ? room.localParticipant
        : room.getParticipantByIdentity(identity),
    );
    if (m && msg.from)
      store.apply({ identity: msg.from.identity, name: msg.from.name || 'Guest' }, m);
  });
  React.useEffect(() => {
    const left = (p: Participant) => store.leave(p.identity);
    const unshared = (pub: TrackPublication, p: Participant) => {
      if (pub.source === Track.Source.ScreenShare) store.clear(p.identity);
    };
    room.on(RoomEvent.ParticipantDisconnected, left);
    room.on(RoomEvent.TrackUnpublished, unshared);
    return () => {
      room.off(RoomEvent.ParticipantDisconnected, left);
      room.off(RoomEvent.TrackUnpublished, unshared);
      store.stop();
    };
  }, [room, store]);
  return <MarksContext.Provider value={store}>{children}</MarksContext.Provider>;
}

/**
 * What's marked on one shared screen, over its video. `picture` is the screen's own size, as LiveKit has it, so the
 * marks land on the picture inside the tile's dark bands.
 */
export function ScreenMarks({
  on,
  picture,
}: {
  on: string;
  picture: { readonly width: number; readonly height: number } | undefined;
}) {
  const store = React.useContext(MarksContext);
  const [box, setBox] = React.useState<{ width: number; height: number } | null>(null);
  const layout = (e: LayoutChangeEvent) =>
    setBox({ width: e.nativeEvent.layout.width, height: e.nativeEvent.layout.height });
  const subscribe = React.useCallback(
    (fn: () => void) => store?.subscribe(fn) ?? (() => undefined),
    [store],
  );
  React.useSyncExternalStore(subscribe, () => store?.getVersion() ?? 0);
  if (!store) return null;
  const pic = box && picture ? fitIn(box, picture) : null;
  return (
    <View
      style={StyleSheet.absoluteFill}
      pointerEvents="none"
      onLayout={layout}
      testID="call-marks"
    >
      {pic ? <Marks pic={pic} view={store.view(on)} /> : null}
    </View>
  );
}

function Marks({ pic, view }: { pic: Rect; view: ScreenMarksView }) {
  return (
    <View
      style={{
        position: 'absolute',
        left: pic.left,
        top: pic.top,
        width: pic.width,
        height: pic.height,
      }}
    >
      <Svg width={pic.width} height={pic.height} style={StyleSheet.absoluteFill}>
        {view.lines.map((l) => {
          const pts = l.pts.length === 2 ? [...l.pts, ...l.pts] : l.pts;
          let points = '';
          for (let i = 0; i < pts.length; i += 2)
            points += `${i ? ' ' : ''}${pts[i]! * pic.width},${pts[i + 1]! * pic.height}`;
          return (
            <React.Fragment key={l.id}>
              <Polyline
                points={points}
                fill="none"
                stroke="rgba(0,0,0,0.35)"
                strokeWidth={6}
                strokeLinecap="round"
                strokeLinejoin="round"
                opacity={l.fading ? 0.3 : 1}
              />
              <Polyline
                points={points}
                fill="none"
                stroke={l.color}
                strokeWidth={3}
                strokeLinecap="round"
                strokeLinejoin="round"
                opacity={l.fading ? 0.3 : 1}
              />
            </React.Fragment>
          );
        })}
      </Svg>
      {view.presses.map((p) => (
        <Press key={p.id} x={p.x * pic.width} y={p.y * pic.height} color={p.color} />
      ))}
      {view.pointers.map((p) => (
        <View
          key={p.who}
          style={{ position: 'absolute', left: p.x * pic.width, top: p.y * pic.height }}
          accessibilityLabel={SCREEN_MARK_WORDS.pointerOf(p.name)}
          testID="call-mark-pointer"
        >
          <View
            style={{
              position: 'absolute',
              left: -7,
              top: -7,
              width: 14,
              height: 14,
              borderRadius: 7,
              borderWidth: 2,
              borderColor: '#ffffff',
              backgroundColor: p.color,
            }}
          />
          <View
            style={{ position: 'absolute', left: 9, top: 6, borderColor: p.color }}
            className="rounded-full border-2 bg-[#191d25]/90 px-1.5 py-px"
          >
            <Text className="text-[11px] font-medium text-white" numberOfLines={1}>
              {p.name}
            </Text>
          </View>
        </View>
      ))}
    </View>
  );
}

/** A ring spreading from where someone clicked. */
function Press({ x, y, color }: { x: number; y: number; color: string }) {
  const grow = React.useRef(new Animated.Value(0)).current;
  React.useEffect(() => {
    Animated.timing(grow, { toValue: 1, duration: MARK_PRESS_MS, useNativeDriver: true }).start();
  }, [grow]);
  return (
    <Animated.View
      style={{
        position: 'absolute',
        left: x - 18,
        top: y - 18,
        width: 36,
        height: 36,
        borderRadius: 18,
        borderWidth: 3,
        borderColor: color,
        opacity: grow.interpolate({ inputRange: [0, 1], outputRange: [1, 0] }),
        transform: [{ scale: grow.interpolate({ inputRange: [0, 1], outputRange: [0.3, 1.6] }) }],
      }}
    />
  );
}
