/**
 * HandsFreeOS video calls on a calendar's Online place (docs/video-calls.md): what an appointment gets, with the
 * business's video calls on and off, and the names the worker and the web share for a call's room.
 */
import { describe, expect, it } from 'vitest';
import { locationFor } from '../../src/calendar/booking';
import { parseConfig } from '../../src/calendar/index';
import {
  callIdOfRoom,
  callLengthLabel,
  effectiveVideo,
  hostFirstName,
  isInAppBrowser,
  isPersonIdentity,
  LISTENER_IDENTITY,
  videoCallLinkOpens,
  videoCallRoom,
  videoCallWaitingPushWords,
} from '../../src/meetings/video-calls';

const SERVICE = '11111111-1111-4111-8111-111111111111';

const online = (place: Record<string, unknown>, overrides: Record<string, unknown> = {}) =>
  parseConfig({
    version: 1,
    services: { mode: 'choice', items: [{ serviceId: SERVICE, overrides }] },
    locations: { options: [{ kind: 'virtual', record: false, ...place }] },
  });

describe('what an Online place makes', () => {
  it('makes a HandsFreeOS call when it’s chosen and the business has calls on', () => {
    const at = locationFor(online({ video: 'handsfree' }), 'virtual', undefined, SERVICE, true);
    expect(at).toMatchObject({
      kind: 'virtual',
      video: 'handsfree',
      meetingUrl: null,
      record: false,
    });
  });

  it('makes nothing while the business has calls off, even when it’s chosen', () => {
    const at = locationFor(online({ video: 'handsfree' }), 'virtual', undefined, SERVICE, false);
    expect(at).toMatchObject({ video: null, meetingUrl: null });
  });

  it('makes one for a place with no link of its own while calls are on (4a)', () => {
    expect(
      locationFor(online({ video: 'none' }), 'virtual', undefined, SERVICE, true),
    ).toMatchObject({ video: 'handsfree' });
    // Calls off: as before, no link.
    expect(
      locationFor(online({ video: 'none' }), 'virtual', undefined, SERVICE, false),
    ).toMatchObject({ video: null });
  });

  it('keeps a pasted link, a Zoom link and a Meet link as they are', () => {
    const pasted = locationFor(
      online({ video: 'none', meetingUrl: 'https://example.com/room/7' }),
      'virtual',
      undefined,
      SERVICE,
      true,
    );
    expect(pasted).toMatchObject({ video: null, meetingUrl: 'https://example.com/room/7' });
    for (const video of ['zoom', 'google_meet'] as const)
      expect(locationFor(online({ video }), 'virtual', undefined, SERVICE, true)).toMatchObject({
        video,
      });
  });

  it('follows a service set to a HandsFreeOS call over the place’s Zoom link', () => {
    const at = locationFor(
      online({ video: 'zoom' }, { video: 'handsfree' }),
      'virtual',
      undefined,
      SERVICE,
      true,
    );
    expect(at).toMatchObject({ video: 'handsfree' });
  });

  it('never makes one for a visit that isn’t online, or a link the caller gave', () => {
    expect(
      locationFor(online({ video: 'handsfree' }), 'phone', undefined, SERVICE, true),
    ).toMatchObject({
      video: null,
    });
    const given = locationFor(
      online({ video: 'handsfree' }),
      'virtual',
      { meetingUrl: 'https://example.com/mine' },
      SERVICE,
      true,
    );
    expect(given).toMatchObject({ video: null, meetingUrl: 'https://example.com/mine' });
  });

  it('works the rule out the same way for the settings note', () => {
    expect(effectiveVideo('handsfree', null, true)).toBe('handsfree');
    expect(effectiveVideo('handsfree', null, false)).toBe('none');
    expect(effectiveVideo('none', null, true)).toBe('handsfree');
    expect(effectiveVideo(undefined, null, true)).toBe('handsfree');
    expect(effectiveVideo('none', 'https://example.com/r', true)).toBe('none');
    expect(effectiveVideo('zoom', null, true)).toBe('zoom');
  });
});

describe('a call’s room', () => {
  const id = '6f1d2c3b-4a59-4e8f-9a0b-1c2d3e4f5a6b';

  it('is named after the call, and only our own rooms give a call back', () => {
    expect(videoCallRoom(id)).toBe(`hf-${id}`);
    expect(callIdOfRoom(videoCallRoom(id))).toBe(id);
    expect(callIdOfRoom(`hf-${id.toUpperCase()}`)).toBe(id);
    expect(callIdOfRoom('hf-not-a-call')).toBeNull();
    expect(callIdOfRoom(`other-${id}`)).toBeNull();
    expect(callIdOfRoom(null)).toBeNull();
  });

  it('opens a customer’s link an hour before, and keeps it open while the call runs over', () => {
    const at = {
      startsAt: Date.UTC(2026, 10, 3, 15),
      endsAt: Date.UTC(2026, 10, 3, 16),
      live: false,
    };
    const min = 60_000;
    expect(videoCallLinkOpens(at, at.startsAt - 61 * min)).toBe('early');
    expect(videoCallLinkOpens(at, at.startsAt - 60 * min)).toBe('open');
    expect(videoCallLinkOpens(at, at.endsAt)).toBe('open');
    expect(videoCallLinkOpens(at, at.endsAt + min)).toBe('over');
    expect(videoCallLinkOpens({ ...at, live: true }, at.endsAt + 30 * min)).toBe('open');
  });

  it('tells a person in it from the AI’s listener', () => {
    expect(isPersonIdentity(id)).toBe(true);
    expect(isPersonIdentity(LISTENER_IDENTITY)).toBe(false);
    expect(isPersonIdentity('')).toBe(false);
  });
});

describe('the words', () => {
  it('spots the apps whose own browsers can block the camera', () => {
    expect(
      isInAppBrowser(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/480.0]',
      ),
    ).toBe(true);
    expect(isInAppBrowser('Mozilla/5.0 (Linux; Android 15) Instagram 350.0.0.0')).toBe(true);
    expect(
      isInAppBrowser(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
      ),
    ).toBe(false);
    expect(isInAppBrowser(null)).toBe(false);
  });

  it('says who they’re waiting for by first name, and how long someone was in', () => {
    expect(hostFirstName('Dana Rivera')).toBe('Dana');
    expect(hostFirstName('dana@example.com')).toBe('dana');
    expect(hostFirstName('  ')).toBeNull();
    expect(callLengthLabel(20)).toBe('under a minute');
    expect(callLengthLabel(4 * 60)).toBe('4 min');
    expect(callLengthLabel(65 * 60)).toBe('1 hr 5 min');
    expect(callLengthLabel(120 * 60)).toBe('2 hr');
  });

  it('tells the team a customer is waiting apart from someone asking to join', () => {
    expect(
      videoCallWaitingPushWords({ name: 'Ana', kind: 'customer', title: 'Consultation' }),
    ).toEqual({
      title: 'Ana is waiting in the video call',
      body: 'Consultation',
    });
    expect(
      videoCallWaitingPushWords({ name: 'Sam', kind: 'guest', title: 'Consultation' }).title,
    ).toBe('Sam is asking to join the video call');
  });
});
