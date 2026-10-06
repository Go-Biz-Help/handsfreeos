import type { SocialChannel } from '@hfos/core';
import type { LucideIcon, LucideProps } from 'lucide-react-native';
import * as React from 'react';
import type { ColorValue } from 'react-native';
import Svg, { Circle, Path, Rect, type NumberProp } from 'react-native-svg';

/**
 * Messenger's and Instagram's marks (20261025000200), drawn as the web draws them: line icons beside Lucide's, which
 * carry no brands. Each takes what a Lucide icon takes, so `<Icon as={Messenger} className="size-3.5 text-text-2" />`
 * sizes and colours it like any other.
 */

interface Paint {
  readonly fill: 'none';
  readonly stroke: ColorValue;
  readonly strokeWidth: NumberProp;
  readonly strokeLinecap: 'round';
  readonly strokeLinejoin: 'round';
}

function lineIcon(name: string, draw: (paint: Paint) => React.ReactNode): LucideIcon {
  const Drawn = React.forwardRef<Svg, LucideProps>(function Drawn(
    {
      color = 'currentColor',
      size = 24,
      width = size,
      height = size,
      strokeWidth = 2,
      absoluteStrokeWidth,
      nonScalingStroke: _nonScaling,
      'data-testid': testID,
      ...rest
    },
    ref,
  ) {
    // Each shape carries the paint itself, as Lucide's do: a shape doesn't always take it from the drawing.
    const paint: Paint = {
      fill: 'none',
      stroke: color,
      strokeWidth: absoluteStrokeWidth ? (Number(strokeWidth) * 24) / Number(size) : strokeWidth,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
    };
    return (
      <Svg ref={ref} width={width} height={height} viewBox="0 0 24 24" testID={testID} {...rest}>
        {draw(paint)}
      </Svg>
    );
  });
  Drawn.displayName = name;
  return Drawn;
}

/** Messenger: the speech bubble with its zigzag. */
export const Messenger = lineIcon('Messenger', (paint) => (
  <>
    <Path
      d="M12 2.75c-5.2 0-9.25 3.84-9.25 8.75 0 2.62 1.16 4.94 3.05 6.53v3.22l3.05-1.68c1 .29 2.06.43 3.15.43 5.2 0 9.25-3.84 9.25-8.75S17.2 2.75 12 2.75z"
      {...paint}
    />
    <Path d="m7.25 13.75 3.25-3.5 2.6 2.25 3.65-3.75" {...paint} />
  </>
));

/** Instagram: the rounded camera. */
export const Instagram = lineIcon('Instagram', (paint) => (
  <>
    <Rect x="3" y="3" width="18" height="18" rx="5" {...paint} />
    <Circle cx="12" cy="12" r="4" {...paint} />
    <Path d="M17.5 6.5h.01" {...paint} />
  </>
));

export const SOCIAL_ICONS: Readonly<Record<SocialChannel, LucideIcon>> = {
  messenger: Messenger,
  instagram: Instagram,
};
