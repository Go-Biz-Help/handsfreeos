import { describe, expect, it } from 'vitest';
import {
  MARK_FADE_MS,
  MARK_FADE_OUT_MS,
  MARK_POINTER_IDLE_MS,
  MARK_PRESS_MS,
  MarksBoard,
  MarksStore,
  fitIn,
  markFrom,
  markColorOf,
  marksOff,
  mayMark,
  mayShareScreen,
  readMark,
  toFraction,
  writeMark,
} from '../../src/meetings/screen-marks';

const dana = { identity: '11111111-1111-4111-8111-111111111111', name: 'Dana' };
const sam = { identity: '22222222-2222-4222-8222-222222222222', name: 'Sam' };
const screen = sam.identity;

describe('marks on a shared screen', () => {
  it('reads only marks that make sense, and writes them small', () => {
    const point = { k: 'point', on: screen, x: 0.123456, y: 0.5 } as const;
    expect(readMark(writeMark(point))).toEqual({ ...point, x: 0.1235 });
    expect(readMark(JSON.stringify({ k: 'press', on: screen, x: 1.2, y: 0.5 }))).toBeNull();
    expect(
      readMark(JSON.stringify({ k: 'line', on: screen, id: 'a', pts: [0.1, 0.2, 0.3] })),
    ).toBeNull();
    expect(
      readMark(JSON.stringify({ k: 'line', on: screen, id: 'a', pts: [0.1, 0.2] })),
    ).not.toBeNull();
    expect(readMark(JSON.stringify({ k: 'gone', on: '' }))).toBeNull();
    expect(readMark('not json')).toBeNull();
    expect(readMark(new TextEncoder().encode(JSON.stringify({ k: 'gone', on: screen })))).toEqual({
      k: 'gone',
      on: screen,
    });
  });

  it('finds the picture in its tile and a spot on it', () => {
    // A wide screen in a square tile sits in a band across the middle.
    const pic = fitIn({ width: 400, height: 400 }, { width: 1600, height: 900 })!;
    expect(pic).toEqual({ left: 0, top: 87.5, width: 400, height: 225 });
    expect(toFraction(pic, { x: 200, y: 200 })).toEqual({ x: 0.5, y: 0.5 });
    // Above the picture, in the dark band, is off it.
    expect(toFraction(pic, { x: 200, y: 40 })).toBeNull();
    expect(fitIn({ width: 400, height: 400 }, { width: 0, height: 0 })).toBeNull();
  });

  it('lets anyone mark in a meeting, and only those who may share a screen in a webinar', () => {
    expect(mayMark({ format: 'meeting', shareScreen: false })).toBe(true);
    expect(mayMark({ format: 'webinar', shareScreen: false })).toBe(false);
    expect(mayMark({ format: 'webinar', shareScreen: true })).toBe(true);
    // The team: everything (no list). An attendee on stage: camera and microphone only.
    expect(mayShareScreen({ canPublish: true, canPublishSources: [] })).toBe(true);
    expect(mayShareScreen({ canPublish: true, canPublishSources: [1, 2] })).toBe(false);
    expect(mayShareScreen({ canPublish: true, canPublishSources: [1, 2, 3, 4] })).toBe(true);
    expect(mayShareScreen({ canPublish: false, canPublishSources: [] })).toBe(false);
    expect(mayShareScreen(undefined)).toBe(false);
    expect(marksOff({ 'hfos.marks': 'off' })).toBe(true);
    expect(marksOff({})).toBe(false);
  });

  it('gives each person the same colour everywhere', () => {
    expect(markColorOf(dana.identity)).toBe(markColorOf(dana.identity));
    expect(markColorOf(dana.identity)).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('shows a pointer until it leaves or sits still too long', () => {
    const board = new MarksBoard();
    board.apply(dana, { k: 'point', on: screen, x: 0.2, y: 0.3 }, 0);
    expect(board.view(screen, 10).pointers).toEqual([
      { who: dana.identity, name: 'Dana', color: markColorOf(dana.identity), x: 0.2, y: 0.3 },
    ]);
    // On another screen, nothing.
    expect(board.view(dana.identity, 10).pointers).toEqual([]);
    expect(board.nextChange(10)).toBe(MARK_POINTER_IDLE_MS);
    board.prune(MARK_POINTER_IDLE_MS);
    expect(board.view(screen, MARK_POINTER_IDLE_MS).pointers).toEqual([]);

    board.apply(dana, { k: 'point', on: screen, x: 0.2, y: 0.3 }, 0);
    board.apply(dana, { k: 'gone', on: screen }, 5);
    expect(board.view(screen, 6).pointers).toEqual([]);

    board.apply(dana, { k: 'point', on: screen, x: 0.2, y: 0.3 }, 0);
    board.leave(dana.identity);
    expect(board.view(screen, 6).pointers).toEqual([]);
  });

  it('ripples a press for a moment', () => {
    const board = new MarksBoard();
    board.apply(dana, { k: 'press', on: screen, x: 0.5, y: 0.5 }, 0);
    expect(board.view(screen, 1).presses).toHaveLength(1);
    expect(board.prune(MARK_PRESS_MS)).toBe(true);
    expect(board.view(screen, MARK_PRESS_MS).presses).toHaveLength(0);
    expect(board.nextChange(MARK_PRESS_MS)).toBeNull();
  });

  it('grows a line as its stretches arrive, then fades it a few seconds after the last', () => {
    const board = new MarksBoard();
    board.apply(dana, { k: 'line', on: screen, id: 'a', pts: [0.1, 0.1, 0.2, 0.2] }, 0);
    board.apply(dana, { k: 'line', on: screen, id: 'a', pts: [0.3, 0.3] }, 1000);
    // The same id from someone else is their own line.
    board.apply(sam, { k: 'line', on: screen, id: 'a', pts: [0.9, 0.9] }, 1000);
    const lines = board.view(screen, 1000).lines;
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ pts: [0.1, 0.1, 0.2, 0.2, 0.3, 0.3], fading: false });

    expect(board.nextChange(1000)).toBe(1000 + MARK_FADE_MS);
    expect(board.view(screen, 1000 + MARK_FADE_MS).lines[0]?.fading).toBe(true);
    board.prune(1000 + MARK_FADE_MS + MARK_FADE_OUT_MS);
    expect(board.view(screen, 1000 + MARK_FADE_MS + MARK_FADE_OUT_MS).lines).toEqual([]);
  });

  it('forgets a screen that stopped, or turned marks off', () => {
    const board = new MarksBoard();
    board.apply(dana, { k: 'line', on: screen, id: 'a', pts: [0.1, 0.1] }, 0);
    board.clear(screen);
    expect(board.view(screen, 1).lines).toEqual([]);
    expect(board.nextChange(1)).toBeNull();
  });

  it('keeps only so much on one screen', () => {
    const board = new MarksBoard();
    for (let i = 0; i < 100; i++)
      board.apply(dana, { k: 'line', on: screen, id: `l${i}`, pts: [0.1, 0.1] }, 0);
    for (let i = 0; i < 100; i++) board.apply(dana, { k: 'press', on: screen, x: 0.5, y: 0.5 }, 0);
    const view = board.view(screen, 1);
    expect(view.lines.length).toBeLessThanOrEqual(40);
    expect(view.lines.at(-1)?.id).toBe(`${dana.identity}:l99`);
    expect(view.presses.length).toBeLessThanOrEqual(24);
  });

  it('takes a mark only from someone who may mark, on a screen that lets them', () => {
    const point = JSON.stringify({ k: 'point', on: screen, x: 0.5, y: 0.5 });
    const owners = (attrs: Record<string, string>) => (id: string) =>
      id === screen ? { attributes: attrs } : undefined;
    const team = { canPublish: true, canPublishSources: [] };
    const attendee = { canPublish: true, canPublishSources: [1] };
    expect(markFrom(point, { identity: dana.identity }, 'meeting', owners({}))).not.toBeNull();
    // The listener, nobody, or a screen nobody in the call has: no.
    expect(markFrom(point, { identity: 'hfos-listener' }, 'meeting', owners({}))).toBeNull();
    expect(markFrom(point, undefined, 'meeting', owners({}))).toBeNull();
    expect(
      markFrom(
        JSON.stringify({ k: 'point', on: dana.identity, x: 0.5, y: 0.5 }),
        dana,
        'meeting',
        owners({}),
      ),
    ).toBeNull();
    // Marks off on that screen.
    expect(markFrom(point, dana, 'meeting', owners({ 'hfos.marks': 'off' }))).toBeNull();
    // A webinar: the team's permissions, never an attendee's, whatever their page claims.
    expect(markFrom(point, { ...dana, permissions: team }, 'webinar', owners({}))).not.toBeNull();
    expect(markFrom(point, { ...dana, permissions: attendee }, 'webinar', owners({}))).toBeNull();
  });

  it('tells each screen when its marks change, and when they fade on their own', async () => {
    const store = new MarksStore();
    let heard = 0;
    const stop = store.subscribe(() => heard++);
    store.apply(dana, { k: 'press', on: screen, x: 0.5, y: 0.5 });
    expect(heard).toBe(1);
    expect(store.view(screen).presses).toHaveLength(1);
    await new Promise((r) => setTimeout(r, MARK_PRESS_MS + 80));
    expect(store.view(screen).presses).toHaveLength(0);
    expect(heard).toBe(2);
    stop();
    store.stop();
  });
});
