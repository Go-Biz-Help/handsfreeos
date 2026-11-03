/**
 * The words customers read about a booking nobody works (a calendar without staff): no "with", no "who",
 * no "is coming".
 */
import { describe, expect, it } from 'vitest';
import {
  cancelledEmail,
  cancelledText,
  confirmationEmail,
  confirmationText,
  movedEmail,
  movedText,
  offerEmail,
  offerText,
  reassignedEmail,
  reassignedText,
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
      "Glow Red Light Studio: You're booked for Fri, Sep 18 at 10:00 AM CT (Red light session).",
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
      'Reminder from Glow Red Light Studio: your appointment is tomorrow, Fri, Sep 18 at 10:00 AM.',
    );
    expect(
      reminderText({
        ...base,
        reminder: { kind: 'before', minutes: 120 },
        now: START - 2 * 3_600_000,
      }),
    ).toBe('Glow Red Light Studio: Your appointment is today at 10:00 AM.');
    const email = reminderEmail({ ...base, reminder: dayBefore, now: DAY_BEFORE_4PM });
    expect(email.subject).toBe('Reminder: Red light session tomorrow at 10:00 AM');
    expect(email.body).not.toMatch(/meet with|is coming|are coming|will call/);
  });
});

/**
 * The owner, 2026-11-03: a calendar with no services books under its own name, and "your chris's calendar is
 * today" made no sense. The title never sits in a sentence: "your appointment", with the title on its own line.
 */
describe('messages about a booking named after its calendar', () => {
  const chris: Visit = {
    ...bed,
    title: 'Chris’s Calendar',
    endsAt: START + 60 * 60_000,
    locationKind: 'virtual',
    meetingUrl: 'https://app.handsfreeos.com/j/abc',
    staff: ['Chris'],
  };
  const base = {
    visit: chris,
    business: glow,
    firstName: 'Lynn',
    manageUrl: 'https://app.handsfreeos.com/m/xyz',
    first: false,
  };
  const notInASentence = (s: string) => {
    expect(s).not.toMatch(/chris’s|chris's/);
    expect(s).not.toMatch(/(your|a|an) Chris/);
  };

  it('reminds by email the way the owner asked', () => {
    const email = reminderEmail({
      ...base,
      reminder: { kind: 'before', minutes: 120 },
      now: START - 2 * 3_600_000,
      why: null,
    });
    expect(email.body).toContain(
      'Hi Lynn, your appointment is today, Friday, September 18, 10:00–11:00 AM Central Time, online at https://app.handsfreeos.com/j/abc. You’ll meet with Chris.',
    );
    expect(email.body).toContain('What: Chris’s Calendar · 1 hour');
    notInASentence(email.body);
  });

  it('keeps the name out of every text and email sentence', () => {
    const confirm = { ...base, icsUrl: null, policies, fromWaitlist: false };
    expect(confirmationText(confirm)).toBe(
      "Glow Red Light Studio: You're booked for Fri, Sep 18 at 10:00 AM CT (Chris's Calendar). Change or cancel: https://app.handsfreeos.com/m/xyz",
    );
    expect(
      reminderText({
        ...base,
        reminder: { kind: 'day_before', at: '16:00' },
        now: DAY_BEFORE_4PM,
        why: null,
      }),
    ).toBe(
      'Reminder from Glow Red Light Studio: your appointment is tomorrow, Fri, Sep 18 at 10:00 AM. Join here: https://app.handsfreeos.com/j/abc',
    );
    const moved = { ...base, from: START - 86_400_000, icsUrl: null, policies };
    expect(movedText(moved)).toBe(
      'Glow Red Light Studio: Your appointment is now Fri, Sep 18 at 10:00 AM CT. Change or cancel: https://app.handsfreeos.com/m/xyz',
    );
    const cancelled = { ...base, byCustomer: false };
    expect(cancelledText(cancelled)).toBe(
      'Glow Red Light Studio: Your appointment on Fri, Sep 18 at 10:00 AM CT is cancelled.',
    );
    expect(cancelledEmail(cancelled).body).toContain('What: Chris’s Calendar · 1 hour');
    expect(reassignedText(base)).toBe(
      'Glow Red Light Studio: Your appointment on Fri, Sep 18 at 10:00 AM CT is now with Chris. Change or cancel: https://app.handsfreeos.com/m/xyz',
    );
    const offer = {
      title: chris.title,
      startsAt: START,
      endsAt: chris.endsAt,
      timeZone: TZ,
      until: DAY_BEFORE_4PM + 3_600_000,
      now: DAY_BEFORE_4PM,
      url: 'https://app.handsfreeos.com/w/q',
      business: glow,
      firstName: 'Lynn',
      first: false,
    };
    expect(offerText(offer)).toBe(
      "Glow Red Light Studio: A time opened on Fri, Sep 18 at 10:00 AM (Chris's Calendar). It's held for you until 5:00 PM: https://app.handsfreeos.com/w/q",
    );
    expect(offerEmail(offer).body).toContain('What: Chris’s Calendar');
    for (const body of [
      confirmationEmail(confirm).body,
      movedEmail(moved).body,
      cancelledEmail(cancelled).body,
      reassignedEmail(base).body,
      offerEmail(offer).body,
    ])
      notInASentence(body);
  });

  it('calls a seat in a session a booking', () => {
    const seat = { ...base, visit: { ...chris, kind: 'session' as const }, byCustomer: true };
    expect(cancelledText(seat)).toBe(
      'Glow Red Light Studio: Your booking on Fri, Sep 18 at 10:00 AM CT is cancelled.',
    );
  });
});
