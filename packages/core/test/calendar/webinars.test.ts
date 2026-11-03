import { describe, expect, it } from 'vitest';
import {
  applyPatch,
  configFromPreset,
  defaultConfig,
  expandRecurrence,
  isWebinarCalendar,
  RecurrenceRule,
  webinarRepeatLabel,
  webinarRepeatMax,
  webinarRepeatRule,
} from '../../src/calendar/index';
import { DALE, presetContext } from './fixtures';

describe('the Webinar preset', () => {
  const config = configFromPreset('webinar', presetContext);

  it('is a webinar calendar: fixed sessions on a HandsFreeOS video call, with you presenting', () => {
    expect(isWebinarCalendar(config)).toBe(true);
    expect(config.schedule.mode).toBe('sessions');
    expect(config.locations.options).toMatchObject([{ kind: 'virtual', video: 'handsfree' }]);
    expect(config.team.members.map((m) => m.userId)).toEqual([DALE]);
  });

  it('holds as many as the room, and lets staff repeat it weekly for a year', () => {
    expect(config.capacity.seats).toBe(500);
    expect(config.recurring).toMatchObject({ staffSeries: true, customerSeries: false });
    expect(config.recurring.maxOccurrences).toBe(webinarRepeatMax('week'));
  });
});

describe('a webinar calendar', () => {
  it('needs fixed sessions and a HandsFreeOS video call', () => {
    const video = {
      locations: { options: [{ kind: 'virtual' as const, video: 'handsfree' as const }] },
    };
    expect(isWebinarCalendar(defaultConfig())).toBe(false);
    expect(isWebinarCalendar(applyPatch(defaultConfig(), video))).toBe(false);
    expect(isWebinarCalendar(configFromPreset('event', presetContext))).toBe(false);
    expect(isWebinarCalendar(applyPatch(configFromPreset('event', presetContext), video))).toBe(
      true,
    );
    expect(
      isWebinarCalendar(
        applyPatch(configFromPreset('event', presetContext), {
          locations: { options: [{ kind: 'virtual', video: 'zoom' }] },
        }),
      ),
    ).toBe(false);
  });
});

describe('repeats', () => {
  // A Tuesday, the 2nd one of its month.
  const first = '2026-11-10';
  const dates = (every: 'week' | 'two_weeks' | 'month', count: number) =>
    expandRecurrence(
      RecurrenceRule.parse(webinarRepeatRule(every, count, '19:00')),
      first,
      'America/Chicago',
    ).map((o) => o.date);

  it('fall on the same weekday, a monthly one on the same one of the month', () => {
    expect(dates('week', 3)).toEqual(['2026-11-10', '2026-11-17', '2026-11-24']);
    expect(dates('two_weeks', 3)).toEqual(['2026-11-10', '2026-11-24', '2026-12-08']);
    expect(dates('month', 3)).toEqual(['2026-11-10', '2026-12-08', '2027-01-12']);
  });

  it('stop at a year', () => {
    expect(webinarRepeatRule('month', 40, '19:00').count).toBe(12);
    expect(dates('two_weeks', 52)).toHaveLength(26);
  });

  it('read as they repeat', () => {
    expect(webinarRepeatLabel('none', first)).toBe('Doesn’t repeat');
    expect(webinarRepeatLabel('week', first)).toBe('Every week on Tuesday');
    expect(webinarRepeatLabel('two_weeks', first)).toBe('Every 2 weeks on Tuesday');
    expect(webinarRepeatLabel('month', first)).toBe('Every month on the 2nd Tuesday');
    expect(webinarRepeatLabel('month', '2026-12-29')).toBe(
      'Every month on the 5th Tuesday, when there is one',
    );
    expect(webinarRepeatLabel('month', null)).toBe('Every month');
  });
});
