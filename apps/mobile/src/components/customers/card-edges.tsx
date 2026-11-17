import { BUSINESS_CARD_WORDS as W, type CardCorners, type CardPoint } from '@hfos/core';
import * as React from 'react';
import { Image, Modal, PanResponder, View, type LayoutChangeEvent } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Polygon } from 'react-native-svg';

import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { useColors } from '@/theme';
import type { CardPhoto } from '@/customers/card-scan';

/** Where the corners start when nothing found them: a card-shaped box in the middle. */
const START: CardCorners = [
  { x: 0.12, y: 0.25 },
  { x: 0.88, y: 0.25 },
  { x: 0.88, y: 0.75 },
  { x: 0.12, y: 0.75 },
];

/** A corner's handle: big enough to grab with a thumb. */
const HANDLE = 44;

interface Fit {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** Where the picture sits inside the space for it, whole and centred. */
function contain(photo: CardPhoto, room: { w: number; h: number }): Fit {
  const scale = Math.min(room.w / photo.width, room.h / photo.height);
  const w = photo.width * scale;
  const h = photo.height * scale;
  return { x: (room.w - w) / 2, y: (room.h - h) / 2, w, h };
}

const clamp = (v: number) => Math.min(1, Math.max(0, v));

/**
 * Fix the edges: the picture the person took, with a handle on each corner of the card to drag onto the card's real
 * corner. Crop straightens the card from those corners (no AI; the worker only pulls it flat).
 */
export function CardEdges({
  open,
  photo,
  corners,
  busy,
  onCancel,
  onCrop,
}: {
  open: boolean;
  photo: CardPhoto | null;
  corners: CardCorners | null;
  busy: boolean;
  onCancel: () => void;
  onCrop: (corners: CardCorners) => void;
}) {
  const insets = useSafeAreaInsets();
  const colors = useColors();
  const [room, setRoom] = React.useState<{ w: number; h: number } | null>(null);
  const [points, setPoints] = React.useState<CardCorners>(corners ?? START);
  React.useEffect(() => {
    if (open) setPoints(corners ?? START);
  }, [open, corners]);

  const fit = photo && room ? contain(photo, room) : null;
  const onLayout = (e: LayoutChangeEvent) =>
    setRoom({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height });

  const move = React.useCallback((index: number, to: CardPoint) => {
    setPoints((all) => all.map((p, i) => (i === index ? to : p)) as unknown as CardCorners);
  }, []);

  return (
    <Modal visible={open} animationType="slide" onRequestClose={onCancel} statusBarTranslucent>
      <View
        className="flex-1"
        style={{
          backgroundColor: '#000',
          paddingTop: insets.top + 12,
          paddingBottom: insets.bottom + 12,
        }}
        testID="card-edges"
      >
        <View className="gap-1 px-4 pb-3">
          <Text className="text-[17px] font-semibold text-white">{W.edgesTitle}</Text>
          <Text className="text-[13px] text-white/70">{W.edgesHint}</Text>
        </View>
        <View className="mx-3 flex-1" onLayout={onLayout}>
          {photo && fit ? (
            <>
              <Image
                source={{ uri: `data:image/jpeg;base64,${photo.base64}` }}
                style={{
                  position: 'absolute',
                  left: fit.x,
                  top: fit.y,
                  width: fit.w,
                  height: fit.h,
                }}
                resizeMode="stretch"
                accessibilityIgnoresInvertColors
              />
              <Svg
                width={room?.w ?? 0}
                height={room?.h ?? 0}
                style={{ position: 'absolute', left: 0, top: 0 }}
                pointerEvents="none"
              >
                <Polygon
                  points={points
                    .map((p) => `${fit.x + p.x * fit.w},${fit.y + p.y * fit.h}`)
                    .join(' ')}
                  fill={`${colors.accent}33`}
                  stroke={colors.accent}
                  strokeWidth={2}
                />
              </Svg>
              {points.map((p, i) => (
                <Corner key={i} index={i} point={p} fit={fit} color={colors.accent} onMove={move} />
              ))}
            </>
          ) : null}
        </View>
        <View className="flex-row gap-2 px-4 pt-3">
          <Button
            variant="secondary"
            className="flex-1"
            onPress={onCancel}
            testID="card-edges-cancel"
          >
            {W.edgesCancel}
          </Button>
          <Button
            className="flex-1"
            loading={busy}
            onPress={() => onCrop(points)}
            testID="card-edges-crop"
          >
            {W.edgesDone}
          </Button>
        </View>
      </View>
    </Modal>
  );
}

/** One corner's handle, dragged by a thumb. */
function Corner({
  index,
  point,
  fit,
  color,
  onMove,
}: {
  index: number;
  point: CardPoint;
  fit: Fit;
  color: string;
  onMove: (index: number, to: CardPoint) => void;
}) {
  const latest = React.useRef({ point, fit, onMove });
  latest.current = { point, fit, onMove };
  const responder = React.useMemo(() => {
    let start: CardPoint = { x: 0, y: 0 };
    return PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: () => {
        start = latest.current.point;
      },
      onPanResponderMove: (_e, gesture) => {
        const { fit: f, onMove: move } = latest.current;
        move(index, { x: clamp(start.x + gesture.dx / f.w), y: clamp(start.y + gesture.dy / f.h) });
      },
    });
  }, [index]);
  return (
    <View
      {...responder.panHandlers}
      accessibilityLabel={W.corner[index]}
      testID={`card-edges-corner-${index}`}
      style={{
        position: 'absolute',
        left: fit.x + point.x * fit.w - HANDLE / 2,
        top: fit.y + point.y * fit.h - HANDLE / 2,
        width: HANDLE,
        height: HANDLE,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <View
        style={{
          width: 24,
          height: 24,
          borderRadius: 12,
          borderWidth: 3,
          borderColor: color,
          backgroundColor: 'white',
        }}
      />
    </View>
  );
}
