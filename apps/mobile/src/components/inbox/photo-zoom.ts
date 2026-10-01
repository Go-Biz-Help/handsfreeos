/**
 * The arithmetic of zooming a photo with fingers, for phones whose scroll view can't zoom by itself (Android; an
 * iPhone's does it natively). A zoom is how much bigger the photo is and how far it has moved, with points measured
 * from the middle of the screen, as a transform of translate-then-scale about the middle draws it.
 */

export interface Zoom {
  readonly scale: number;
  readonly x: number;
  readonly y: number;
}

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface Size {
  readonly width: number;
  readonly height: number;
}

export const UNZOOMED: Zoom = { scale: 1, x: 0, y: 0 };
export const MOST_ZOOM = 4;
/** How far two quick taps zoom in, as the Photos app does. */
export const DOUBLE_TAP_ZOOM = 2.5;

// `|| 0`: an unzoomed photo sits at 0, not -0.
const within = (value: number, most: number) => Math.min(Math.max(value, -most), most) || 0;

/** Never smaller than the screen or bigger than the most, and never moved so far that a zoomed edge comes away. */
export function keptOnScreen(zoom: Zoom, size: Size): Zoom {
  const scale = Math.min(Math.max(zoom.scale, 1), MOST_ZOOM);
  return {
    scale,
    x: within(zoom.x, ((scale - 1) * size.width) / 2),
    y: within(zoom.y, ((scale - 1) * size.height) / 2),
  };
}

/** Two fingers spreading or closing: the spot that was between them stays between them. */
export function pinched(
  start: Zoom,
  from: { readonly focus: Point; readonly distance: number },
  to: { readonly focus: Point; readonly distance: number },
  size: Size,
): Zoom {
  if (from.distance <= 0) return start;
  const scale = Math.min(Math.max((start.scale * to.distance) / from.distance, 1), MOST_ZOOM);
  return keptOnScreen(
    {
      scale,
      x: to.focus.x - (scale * (from.focus.x - start.x)) / start.scale,
      y: to.focus.y - (scale * (from.focus.y - start.y)) / start.scale,
    },
    size,
  );
}

/** One finger moving a zoomed-in photo around. */
export function panned(start: Zoom, by: Point, size: Size): Zoom {
  return keptOnScreen({ ...start, x: start.x + by.x, y: start.y + by.y }, size);
}

/** Two quick taps: zoomed in, back to the whole photo; otherwise in, with the tapped spot brought to the middle. */
export function doubleTapped(now: Zoom, at: Point, size: Size): Zoom {
  if (now.scale > 1.01) return UNZOOMED;
  return keptOnScreen(
    { scale: DOUBLE_TAP_ZOOM, x: -DOUBLE_TAP_ZOOM * at.x, y: -DOUBLE_TAP_ZOOM * at.y },
    size,
  );
}

/** Where fingers are, from the middle of the screen: between them when there are two. */
export function fingersAt(
  touches: readonly { readonly pageX: number; readonly pageY: number }[],
  size: Size,
): { readonly focus: Point; readonly distance: number } {
  const [a, b] = touches;
  if (!a) return { focus: { x: 0, y: 0 }, distance: 0 };
  const middle = { x: size.width / 2, y: size.height / 2 };
  if (!b) return { focus: { x: a.pageX - middle.x, y: a.pageY - middle.y }, distance: 0 };
  return {
    focus: { x: (a.pageX + b.pageX) / 2 - middle.x, y: (a.pageY + b.pageY) / 2 - middle.y },
    distance: Math.hypot(a.pageX - b.pageX, a.pageY - b.pageY),
  };
}
