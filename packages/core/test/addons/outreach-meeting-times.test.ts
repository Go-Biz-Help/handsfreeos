/**
 * Times to meet, in the chat (docs/outreach.md, decision 149): which links are booking pages, their time zone from a
 * "Lives in", which three times a message offers and how they read (the owner's examples: "tomorrow at 11 ct", "this
 * friday at noon ct", "tues 3pm ct"), the open times a reply reads to find the one they picked, who the invite goes to,
 * and what the AI is told.
 */
import { describe, expect, it } from 'vitest';
import {
  bookingPageOf,
  clockWords,
  contactIn,
  isTimeKind,
  openLines,
  openTimeOf,
  pickTimes,
  sayTime,
  TIME_ASK,
  TIME_WORDS,
  TimeBooking,
  timeKey,
  timesLines,
  TIMES_SAY,
  tomorrowIn,
  zoneFromLines,
  zoneWord,
  type OpenTime,
} from '../../src/addons/outreach/meeting-times';
import { todayDraftPrompt } from '../../src/addons/outreach/today';

const CT = 'America/Chicago';
const HOUR = 3_600_000;
// Tuesday 3 November 2026, 10 AM in Chicago (16:00 UTC, standard time).
const tuesday10 = Date.UTC(2026, 10, 3, 16);
/** An open time, by its day in November and its hour in Chicago. */
const at = (day: number, hour: number, minute = 0): number =>
  Date.UTC(2026, 10, day, hour + 6, minute);
const open = (day: number, hour: number, minute = 0, userIds = ['u1']): OpenTime => ({
  at: at(day, hour, minute),
  sessionId: null,
  userIds,
});

describe('booking pages', () => {
  it('reads /book/<site>/<calendar> and /book/c/<id> on any host', () => {
    expect(bookingPageOf('https://app.handsfreeos.com/book/acme/demo?ref=d_1')).toEqual({
      site: 'acme',
      calendar: 'demo',
    });
    expect(bookingPageOf('https://acme.com/book/Acme/Quick-Call')).toEqual({
      site: 'acme',
      calendar: 'quick-call',
    });
    const id = '6f1c1d9e-1f3a-4b5c-8d7e-9f0a1b2c3d4e';
    expect(bookingPageOf(`https://app.handsfreeos.com/book/c/${id}`)).toEqual({
      site: 'c',
      calendar: id,
    });
  });

  it('is no booking page for anything else', () => {
    expect(bookingPageOf(null)).toBeNull();
    expect(bookingPageOf('not a link')).toBeNull();
    expect(bookingPageOf('https://calendly.com/acme/demo')).toBeNull();
    expect(bookingPageOf('https://app.handsfreeos.com/f/acme/quiz')).toBeNull();
    expect(bookingPageOf('https://app.handsfreeos.com/book/acme')).toBeNull();
    expect(bookingPageOf('https://app.handsfreeos.com/book/c/not-an-id')).toBeNull();
    expect(bookingPageOf('javascript:alert(1)')).toBeNull();
  });

  it('offers times in the link, its follow-up, another time and a reply', () => {
    expect(['pitch', 'rebook', 'follow_up', 'reply'].every(isTimeKind)).toBe(true);
    expect(isTimeKind('opener')).toBe(false);
    expect(isTimeKind('video')).toBe(false);
  });
});

describe('their time zone', () => {
  it('comes from a "Lives in" with a state', () => {
    expect(zoneFromLines(['Lives in Austin, Texas'])).toBe('America/Chicago');
    expect(zoneFromLines(['Works at Acme', 'Lives in Tampa, FL'])).toBe('America/New_York');
    expect(zoneFromLines(['Lives in Denver, Colorado, United States'])).toBe('America/Denver');
    expect(zoneFromLines(['Lives in Phoenix, Arizona'])).toBe('America/Phoenix');
    expect(zoneFromLines(['Lives in Seattle, Washington'])).toBe('America/Los_Angeles');
    expect(zoneFromLines(['Lives in California'])).toBe('America/Los_Angeles');
  });

  it('is unknown without one, or a country with many zones', () => {
    expect(zoneFromLines(['From Austin, Texas'])).toBeNull();
    expect(zoneFromLines(['Lives in Springfield'])).toBeNull();
    expect(zoneFromLines([])).toBeNull();
    expect(zoneFromLines(['Lives in Toronto, Ontario'], 'CA')).toBeNull();
  });

  it('is a country’s own when it has one', () => {
    expect(zoneFromLines(['Lives in London'], 'GB')).toBe('Europe/London');
  });

  it('is said the way people text it', () => {
    expect(zoneWord('America/Chicago')).toBe('ct');
    expect(zoneWord('America/New_York')).toBe('et');
    expect(zoneWord('America/Denver')).toBe('mt');
    expect(zoneWord('America/Los_Angeles')).toBe('pt');
    expect(zoneWord('Europe/London')).toBe('london time');
  });
});

describe('the times a message offers (4a)', () => {
  it('takes one a day from tomorrow, a morning, an afternoon and around midday', () => {
    const times = [
      // Today: never offered.
      open(3, 14),
      open(4, 9),
      open(4, 11),
      open(4, 15),
      open(5, 9),
      open(5, 14, 30),
      open(5, 16),
      open(6, 12),
      open(6, 13),
      open(9, 11),
    ];
    const picked = pickTimes(times, CT, tuesday10);
    expect(picked.map((t) => t.at)).toEqual([at(4, 11), at(5, 14, 30), at(6, 12)]);
  });

  it('skips days with nothing open, and offers fewer when fewer days have any', () => {
    const picked = pickTimes([open(6, 10), open(10, 15)], CT, tuesday10);
    expect(picked.map((t) => t.at)).toEqual([at(6, 10), at(10, 15)]);
    expect(pickTimes([], CT, tuesday10)).toEqual([]);
  });

  it('starts tomorrow in their zone', () => {
    expect(tomorrowIn(tuesday10, CT)).toBe(Date.UTC(2026, 10, 4, 6));
  });
});

describe('how a time reads (the owner’s examples)', () => {
  it('says the clock plainly', () => {
    expect(clockWords(11, 0)).toBe('11am');
    expect(clockWords(12, 0)).toBe('noon');
    expect(clockWords(15, 0)).toBe('3pm');
    expect(clockWords(10, 30)).toBe('10:30am');
    expect(clockWords(0, 0)).toBe('12am');
  });

  it('says tomorrow, the weekday this week, and the date further out, with the zone short', () => {
    expect(sayTime(at(4, 11), CT, tuesday10)).toBe('tomorrow at 11am ct');
    expect(sayTime(at(6, 12), CT, tuesday10)).toBe('friday at noon ct');
    expect(sayTime(at(3, 15), CT, tuesday10)).toBe('today at 3pm ct');
    expect(sayTime(at(17, 15), CT, tuesday10)).toBe('tuesday the 17th at 3pm ct');
    // In their zone: 11 AM Chicago is noon in New York.
    expect(sayTime(at(4, 11), 'America/New_York', tuesday10)).toBe('tomorrow at noon et');
  });

  it('tells the AI to say them naturally, never as a list or in numbers', () => {
    expect(TIMES_SAY).toContain('tomorrow at 11 ct');
    expect(TIMES_SAY).toContain('this friday at noon ct');
    expect(TIMES_SAY).toContain('tues 3pm ct');
    expect(TIMES_SAY).toContain('never as a list');
  });
});

describe('the time they picked', () => {
  const times = [open(4, 9), open(4, 9, 30), open(4, 15), open(5, 11)];

  it('lists the open times a day a line, in their zone', () => {
    const lines = openLines(times, CT, tuesday10);
    expect(lines).toEqual([
      '2026-11-04 (wednesday, november 4th): 09:00, 09:30, 15:00',
      '2026-11-05 (thursday, november 5th): 11:00',
    ]);
  });

  it('finds the one the AI gave back, and nothing that isn’t open', () => {
    expect(timeKey(at(4, 15), CT)).toBe('2026-11-04 15:00');
    expect(openTimeOf('2026-11-04 15:00', times, CT)?.at).toBe(at(4, 15));
    expect(openTimeOf('2026-11-04T15:00', times, CT)?.at).toBe(at(4, 15));
    expect(openTimeOf('2026-11-04 16:00', times, CT)).toBeNull();
    expect(openTimeOf('', times, CT)).toBeNull();
    expect(openTimeOf(null, times, CT)).toBeNull();
  });

  it('books the email they wrote, else their mobile number', () => {
    expect(contactIn(['Sounds good', 'sure, it’s Jane.Doe@Example.com.'])).toEqual({
      email: 'jane.doe@example.com',
      phone: null,
    });
    expect(contactIn(['text me at (512) 555-0134'])).toEqual({
      email: null,
      phone: '+15125550134',
    });
    expect(contactIn(['jane@old.com', 'actually use jane@new.com'])).toEqual({
      email: 'jane@new.com',
      phone: null,
    });
    expect(contactIn(['wednesday works'])).toEqual({ email: null, phone: null });
  });

  it('needs an email or a number to book', () => {
    const base = {
      at: new Date(at(4, 15)).toISOString(),
      says: 'tomorrow at 3pm ct',
      name: 'Jane',
    };
    expect(TimeBooking.safeParse({ ...base, email: 'jane@example.com' }).success).toBe(true);
    expect(TimeBooking.safeParse({ ...base, phone: '+15125550134' }).success).toBe(true);
    expect(TimeBooking.safeParse(base).success).toBe(false);
  });
});

describe('what the AI is told', () => {
  const times = { offer: ['tomorrow at 11am ct', 'thursday at 3pm ct'], zone: 'ct' };

  it('offers the times with the link for any other time', () => {
    const lines = timesLines('pitch', times, 'https://acme.com/book/acme/demo?ref=d_1').join('\n');
    expect(lines).toContain('- tomorrow at 11am ct');
    expect(lines).toContain('- thursday at 3pm ct');
    expect(lines).toContain('The link for any other time');
    expect(lines).toContain('https://acme.com/book/acme/demo?ref=d_1');
    expect(lines).not.toContain('<open_times');
  });

  it('gives a reply what’s open, and asks for the email before it confirms', () => {
    const open = ['2026-11-04 (wednesday, november 4th): 11:00, 15:00'];
    const asks = timesLines('reply', { ...times, open, contact: null }, null).join('\n');
    expect(asks).toContain('<open_times zone="ct">');
    expect(asks).toContain('2026-11-04 (wednesday, november 4th): 11:00, 15:00');
    expect(asks).toContain('ask for the best email');
    expect(asks).toContain(TIME_ASK);
    const confirms = timesLines(
      'reply',
      { ...times, open, contact: 'jane@example.com' },
      null,
    ).join('\n');
    expect(confirms).toContain('jane@example.com');
    expect(confirms).toContain('confirmation that they’re booked');
  });

  const prompt = { business: 'Acme', name: 'Jane Doe', facts: [], recent: [], playbook: null };

  it('puts them in Send the link’s prompt, and never to someone who said no', () => {
    const offered = todayDraftPrompt({ ...prompt, kind: 'pitch', times });
    expect(offered).toContain('<times>');
    expect(offered).toContain('tomorrow at 11am ct');
    expect(todayDraftPrompt({ ...prompt, kind: 'reply', times })).toContain('<times>');
    expect(
      todayDraftPrompt({ ...prompt, kind: 'reply', times, declined: { why: null } }),
    ).not.toContain('<times>');
    expect(todayDraftPrompt({ ...prompt, kind: 'pitch', times: null })).not.toContain('<times>');
  });

  it('offers them in a follow-up only after the link', () => {
    const after = (step: 'link' | 'video') =>
      todayDraftPrompt({
        ...prompt,
        kind: 'follow_up',
        times,
        conversation: { step, sent: 1, followUps: 5 },
      });
    expect(after('link')).toContain('<times>');
    expect(after('video')).not.toContain('<times>');
  });

  it('says what happened in plain words', () => {
    expect(TIME_WORDS.books('tomorrow at 11am ct')).toBe(
      'Sending this books them in for tomorrow at 11am ct.',
    );
    expect(TIME_WORDS.takenNow('tomorrow at 11am ct')).toMatch(
      /^Tomorrow at 11am ct was just taken/,
    );
    expect(
      TIME_WORDS.notBooked('friday at noon ct', 'that calendar isn’t taking bookings right now.'),
    ).toContain('Book it yourself');
  });
});

describe('a day after the clocks change', () => {
  it('keeps the hour in their zone', () => {
    // Saturday 31 October 2026, 10 AM in Chicago (daylight time, 15:00 UTC); Monday 2 November is standard time.
    const saturday = Date.UTC(2026, 9, 31, 15);
    const monday11 = Date.UTC(2026, 10, 2, 17);
    expect(sayTime(monday11, CT, saturday)).toBe('monday at 11am ct');
    expect(pickTimes([{ at: monday11, sessionId: null, userIds: [] }], CT, saturday)).toHaveLength(
      1,
    );
    expect(monday11 - saturday).toBeGreaterThan(48 * HOUR);
  });
});
