import {
  doubleTapped,
  fingersAt,
  keptOnScreen,
  MOST_ZOOM,
  panned,
  pinched,
  UNZOOMED,
} from '@/components/inbox/photo-zoom';

/**
 * Zooming a photo with fingers on Android, where the scroll view can't: points are measured from the middle of a
 * 400 × 800 screen.
 */

const screen = { width: 400, height: 800 };

test('spreading two fingers zooms in about the spot between them', () => {
  const zoom = pinched(
    UNZOOMED,
    { focus: { x: 100, y: 50 }, distance: 100 },
    { focus: { x: 100, y: 50 }, distance: 200 },
    screen,
  );
  expect(zoom).toEqual({ scale: 2, x: -100, y: -50 });
  // The spot that was under the fingers (100, 50 on the photo) is still under them.
  expect(zoom.scale * 100 + zoom.x).toBe(100);
  expect(zoom.scale * 50 + zoom.y).toBe(50);
});

test('the pinch carries on from where the photo already is, and moves with the fingers', () => {
  const zoom = pinched(
    { scale: 2, x: -100, y: -50 },
    { focus: { x: 100, y: 50 }, distance: 200 },
    { focus: { x: 120, y: 50 }, distance: 300 },
    screen,
  );
  expect(zoom.scale).toBe(3);
  // Photo spot 100 (under the fingers at the start) follows them to 120.
  expect(zoom.scale * 100 + zoom.x).toBe(120);
});

test('a pinch never goes smaller than the screen or past the most zoom', () => {
  expect(
    pinched(
      { scale: 2, x: -100, y: 0 },
      { focus: { x: 0, y: 0 }, distance: 200 },
      { focus: { x: 0, y: 0 }, distance: 20 },
      screen,
    ),
  ).toEqual(UNZOOMED);
  expect(
    pinched(
      UNZOOMED,
      { focus: { x: 0, y: 0 }, distance: 10 },
      { focus: { x: 0, y: 0 }, distance: 1000 },
      screen,
    ).scale,
  ).toBe(MOST_ZOOM);
});

test('a zoomed-in photo moves with one finger, but no further than its edges', () => {
  expect(panned({ scale: 2, x: 0, y: 0 }, { x: 30, y: -40 }, screen)).toEqual({
    scale: 2,
    x: 30,
    y: -40,
  });
  // Twice the size, the photo can go half a screen either way and no more.
  expect(panned({ scale: 2, x: 0, y: 0 }, { x: 900, y: -900 }, screen)).toEqual({
    scale: 2,
    x: 200,
    y: -400,
  });
  expect(keptOnScreen({ scale: 1, x: 50, y: 50 }, screen)).toEqual(UNZOOMED);
});

test('a double tap zooms in on the tapped spot, and another goes back to the whole photo', () => {
  const zoom = doubleTapped(UNZOOMED, { x: 40, y: -80 }, screen);
  expect(zoom).toEqual({ scale: 2.5, x: -100, y: 200 });
  // The tapped spot comes to the middle.
  expect(zoom.scale * 40 + zoom.x).toBe(0);
  expect(doubleTapped(zoom, { x: 0, y: 0 }, screen)).toEqual(UNZOOMED);
});

test('fingers are found from the middle of the screen', () => {
  expect(fingersAt([{ pageX: 250, pageY: 400 }], screen)).toEqual({
    focus: { x: 50, y: 0 },
    distance: 0,
  });
  expect(
    fingersAt(
      [
        { pageX: 100, pageY: 400 },
        { pageX: 300, pageY: 400 },
      ],
      screen,
    ),
  ).toEqual({ focus: { x: 0, y: 0 }, distance: 200 });
});
