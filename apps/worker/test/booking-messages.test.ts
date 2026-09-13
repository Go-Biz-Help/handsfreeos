/**
 * The words customers read about a booking nobody works (a calendar without staff): no "with", no "who",
 * no "is coming".
 */
import { describe, expect, it } from 'vitest';
import {
  confirmationEmail,
  confirmationText,
  reminderEmail,
  reminderText,
  type Business,
  type Policies,
  type Visit,
} from '../src/booking/messages';

const TZ = 'America/Chicago';
/** Fri, Sep 18 2026, 10:00 AM in Chicago. */
const START = Date.parse('2026-09-18T15:00:00Z');
const DAY_BEFORE_4PM = Date.parse('2026-09-17T21:00:00Z');
const glow: Business = {
  name: 'Glow Red Light Studio',
  phone: null,
  phoneDisplay: null,
  bookingUrl: null,
};
const bed: Visit = {
  title: 'Red light session',
  startsAt: START,
  endsAt: START + 20 * 60_000,
  timeZone: TZ,
  kind: 'booking',
  seats: 1,
  locationKind: null,
  address: null,
  meetingUrl: null,
  staff: [],
};
const policies: Policies = {
  cancel: { allowed: true, cutoffHours: 24 },
  reschedule: { allowed: true, cutoffHours: 24 },
};

describe('messages about a booking nobody works', () => {
  it('confirms without naming anyone', () => {
    const input = {
      visit: bed,
      business: glow,
      firstName: 'Ava',
      manageUrl: null,
      icsUrl: null,
      policies,
      fromWaitlist: false,
      first: false,
    };
    expect(confirmationText(input)).toBe(
      "Glow Red Light Studio: You're booked for a red light session on Fri, Sep 18 at 10:00 AM CT.",
    );
    const email = confirmationEmail(input);
    expect(email.body).toContain('What: Red light session · 20 min');
    expect(email.body).not.toContain('Who:');
  });

  it('reminds without naming anyone', () => {
    const base = {
      visit: bed,
      business: glow,
      firstName: 'Ava',
      manageUrl: null,
      first: false,
      why: null,
    };
    const dayBefore = { kind: 'day_before' as const, at: '16:00' };
    expect(reminderText({ ...base, reminder: dayBefore, now: DAY_BEFORE_4PM })).toBe(
      'Reminder from Glow Red Light Studio: your red light session is tomorrow, Fri, Sep 18 at 10:00 AM.',
    );
    expect(
      reminderText({
        ...base,
        reminder: { kind: 'before', minutes: 120 },
        now: START - 2 * 3_600_000,
      }),
    ).toBe('Glow Red Light Studio: Your red light session is today at 10:00 AM.');
    const email = reminderEmail({ ...base, reminder: dayBefore, now: DAY_BEFORE_4PM });
    expect(email.subject).toBe('Reminder: Red light session tomorrow at 10:00 AM');
    expect(email.body).not.toMatch(/meet with|is coming|are coming|will call/);
  });
});
