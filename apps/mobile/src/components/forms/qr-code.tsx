import QRCode from 'qrcode';
import * as React from 'react';
import { View } from 'react-native';
import Svg, { Path, Rect } from 'react-native-svg';

/** The empty border round the code that scanners need to find it: four squares, as the standard asks. */
const QUIET = 4;

/**
 * A QR code's dark squares as one SVG path, a rectangle per run of dark squares along each row, so a code of a few
 * hundred squares is one short path rather than hundreds of shapes. Made from the same library the web's Share tab
 * uses, at the same error correction.
 */
export function qrPath(text: string): { readonly size: number; readonly d: string } {
  const { size, data } = QRCode.create(text, { errorCorrectionLevel: 'M' }).modules;
  let d = '';
  for (let y = 0; y < size; y++) {
    let x = 0;
    while (x < size) {
      if (!data[y * size + x]) {
        x++;
        continue;
      }
      const start = x;
      while (x < size && data[y * size + x]) x++;
      d += `M${start} ${y}h${x - start}v1h-${x - start}z`;
    }
  }
  return { size, d };
}

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
