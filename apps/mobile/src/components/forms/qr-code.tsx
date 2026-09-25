import * as React from 'react';
import { View } from 'react-native';
import Svg, { Path, Rect } from 'react-native-svg';

import { QUIET, qrPath } from '@/forms/qr';

/**
 * A QR code for a link, for somebody to scan straight off this phone. Always dark squares on white, whatever the
 * phone's appearance: a scanner reads a light code on dark badly or not at all.
 */
export function QrCode({
  value,
  size = 208,
  label,
  testID,
}: {
  value: string;
  size?: number;
  label: string;
  testID?: string;
}) {
  const code = React.useMemo(() => qrPath(value), [value]);
  const box = code.size + QUIET * 2;
  // A whole number of points per square, so neighbouring rows meet cleanly rather than with a faint seam between.
  const side = Math.max(box, Math.floor(size / box) * box);
  return (
    <View
      className="self-center overflow-hidden rounded-menu"
      accessible
      role="img"
      accessibilityLabel={label}
      testID={testID}
    >
      <Svg width={side} height={side} viewBox={`${-QUIET} ${-QUIET} ${box} ${box}`}>
        <Rect x={-QUIET} y={-QUIET} width={box} height={box} fill="#ffffff" />
        <Path d={code.d} fill="#000000" />
      </Svg>
    </View>
  );
}
