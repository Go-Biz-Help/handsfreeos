/**
 * Webinars' rules (HANDSFREEOS_WEBINARS_IMPLEMENTATION_PLAN.md, part 1), without a database: who may send what in
 * the room, how many it holds, what each person carries, and the messages' words.
 */
import { describe, expect, it } from 'vitest';
import {
  attendeeSeenBy,
  isWebinarDoorKey,
  maxPeopleOf,
  mayPublish,
  roomRightsOf,
  VIDEO_CALL_ATTRIBUTES,
  VIDEO_CALL_MAX_PEOPLE,
  videoCallAttributes,
  WEBINAR_MAX_PEOPLE,
  webinarDoorPath,
  webinarJoinLinkWords,
  webinarMissedWords,
  webinarStartingWords,
  webinarWaitingPushWords,
} from '../src/meetings/video-calls';

const ALL = { camera: true, microphone: true, screen: true };

describe('who may send what', () => {
  it('lets everyone in a meeting send everything, as calls always have', () => {
    for (const kind of ['team', 'customer', 'guest'] as const)
      expect(mayPublish({ format: 'meeting', kind, onStage: false, attendeeVideo: 'off' })).toEqual(
        ALL,
      );
  });

  it('lets the team present in a webinar, and attendees only watch', () => {
    expect(
      mayPublish({ format: 'webinar', kind: 'team', onStage: false, attendeeVideo: 'off' }),
    ).toEqual(ALL);
    expect(
      mayPublish({ format: 'webinar', kind: 'customer', onStage: false, attendeeVideo: 'off' }),
    ).toEqual({ camera: false, microphone: false, screen: false });
    expect(
      mayPublish({ format: 'webinar', kind: 'guest', onStage: false, attendeeVideo: 'off' }),
    ).toEqual({ camera: false, microphone: false, screen: false });
  });

  it('gives attendees a camera only when the presenter allows one, and never a microphone', () => {
    for (const attendeeVideo of ['team', 'everyone'] as const)
      expect(
        mayPublish({ format: 'webinar', kind: 'customer', onStage: false, attendeeVideo }),
      ).toEqual({ camera: true, microphone: false, screen: false });
  });

  it('lets someone on stage talk and be on camera, but not share a screen', () => {
    expect(
      mayPublish({ format: 'webinar', kind: 'customer', onStage: true, attendeeVideo: 'off' }),
    ).toEqual({ camera: true, microphone: true, screen: false });
  });

  it('shows an attendee’s camera to everyone only when the presenter says so or they’re on stage', () => {
    expect(attendeeSeenBy({ onStage: false, attendeeVideo: 'team' })).toBe('team');
    expect(attendeeSeenBy({ onStage: false, attendeeVideo: 'everyone' })).toBe('everyone');
    expect(attendeeSeenBy({ onStage: true, attendeeVideo: 'team' })).toBe('everyone');
  });
});

describe('the room', () => {
  it('holds 500 in a webinar and 10 in a meeting', () => {
    expect(WEBINAR_MAX_PEOPLE).toBe(500);
    expect(maxPeopleOf('webinar')).toBe(500);
    expect(maxPeopleOf('meeting')).toBe(VIDEO_CALL_MAX_PEOPLE);
  });

  it('puts a webinar’s format, camera choice and stage on each person, and nothing on a meeting’s', () => {
    expect(
      videoCallAttributes({ format: 'meeting', attendeeVideo: 'team', onStage: true }),
    ).toEqual({});
    const attrs = videoCallAttributes({ format: 'webinar', attendeeVideo: 'team', onStage: true });
    expect(attrs).toEqual({
      [VIDEO_CALL_ATTRIBUTES.format]: 'webinar',
      [VIDEO_CALL_ATTRIBUTES.video]: 'team',
      [VIDEO_CALL_ATTRIBUTES.stage]: 'on',
    });
    // Every page reads them back the same way.
    expect(roomRightsOf({ ...attrs, [VIDEO_CALL_ATTRIBUTES.kind]: 'customer' })).toEqual({
      format: 'webinar',
      kind: 'customer',
      onStage: true,
      attendeeVideo: 'team',
      publish: { camera: true, microphone: true, screen: false },
    });
  });

  it('reads anyone without attributes as a meeting’s guest, who may send everything', () => {
    expect(roomRightsOf(undefined)).toMatchObject({
      format: 'meeting',
      kind: 'guest',
      publish: ALL,
    });
    expect(
      roomRightsOf({
        [VIDEO_CALL_ATTRIBUTES.format]: 'webinar',
        [VIDEO_CALL_ATTRIBUTES.video]: 'odd',
      }),
    ).toMatchObject({ attendeeVideo: 'off', publish: { camera: false, microphone: false } });
  });
});

describe('the link anyone can use', () => {
  it('is /live/ and 24 letters and digits', () => {
    expect(isWebinarDoorKey('AbCd1234EfGh5678IjKl9012')).toBe(true);
    expect(isWebinarDoorKey('AbCd1234EfGh5678IjKl901')).toBe(false);
    expect(isWebinarDoorKey('AbCd1234EfGh5678IjKl901-')).toBe(false);
    expect(webinarDoorPath('AbCd1234EfGh5678IjKl9012')).toBe('/live/AbCd1234EfGh5678IjKl9012');
  });
});

describe('the words', () => {
  it('says it’s starting now, with their own link', () => {
    const w = webinarStartingWords({
      title: 'Grow with HandsFreeOS',
      business: 'Go Biz Help',
      firstName: 'Ana',
      link: 'https://example.com/j/abc',
    });
    expect(w.text).toBe(
      'Grow with HandsFreeOS is starting now. Join here: https://example.com/j/abc',
    );
    expect(w.email).toContain('Hi Ana,');
  });

  it('follows up a missed webinar with the next one, or says there’ll be another', () => {
    const next = webinarMissedWords({
      title: 'Grow with HandsFreeOS',
      business: 'Go Biz Help',
      firstName: null,
      next: { when: 'Tue, Nov 3 at 7:00 PM', link: 'https://example.com/live/k' },
    });
    expect(next.text).toBe(
      'Sorry we missed you at Grow with HandsFreeOS. The next one is Tue, Nov 3 at 7:00 PM. Save your seat: https://example.com/live/k',
    );
    expect(next.email).toContain('Hi there,');
    const none = webinarMissedWords({
      title: 'Grow with HandsFreeOS',
      business: 'Go Biz Help',
      firstName: 'Ana',
      next: null,
    });
    expect(none.text).toContain('We’ll let you know when there’s another one.');
  });

  it('sends their own Join link again, with when it is', () => {
    const w = webinarJoinLinkWords({
      title: 'Grow with HandsFreeOS',
      business: 'Go Biz Help',
      firstName: 'Ana',
      when: 'Tue, Nov 3 at 7:00 PM',
      link: 'https://example.com/j/abc',
    });
    expect(w.text).toBe(
      'Your own Join link for Grow with HandsFreeOS (Tue, Nov 3 at 7:00 PM): https://example.com/j/abc',
    );
  });

  it('tells the team about the crowd waiting, not each person', () => {
    expect(webinarWaitingPushWords({ waiting: 1, title: 'Demo' }).title).toBe(
      'Someone is waiting for your webinar',
    );
    expect(webinarWaitingPushWords({ waiting: 40, title: 'Demo' }).title).toBe(
      '40 people are waiting for your webinar',
    );
  });
});
