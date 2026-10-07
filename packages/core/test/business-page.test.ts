/**
 * The business's simple page (HANDSFREEOS_ONBOARDING_QUICK_SETUP_IMPLEMENTATION_PLAN.md §4, "A simple page"): how
 * its hours read, and what it calls the business's services.
 */
import { describe, expect, it } from 'vitest';
import { businessPageHours, businessPageServicesTitle } from '../src';

describe('the simple page', () => {
  it('lists the hours Monday first, with days alike together and closed days said so', () => {
    const weekdays = [1, 2, 3, 4, 5].map((day) => ({ day, start: '07:00', end: '18:00' }));
    expect(businessPageHours([...weekdays, { day: 6, start: '09:00', end: '12:00' }])).toEqual([
      { days: 'Mon–Fri', times: '7:00 AM–6:00 PM' },
      { days: 'Sat', times: '9:00 AM–12:00 PM' },
      { days: 'Sun', times: 'Closed' },
    ]);
  });

  it('keeps a day with a break as one line, and runs to midnight', () => {
    expect(
      businessPageHours([
        { day: 1, start: '13:00', end: '17:00' },
        { day: 1, start: '08:00', end: '12:00' },
        { day: 0, start: '18:00', end: '24:00' },
      ]),
    ).toEqual([
      { days: 'Mon', times: '8:00 AM–12:00 PM, 1:00 PM–5:00 PM' },
      { days: 'Tue–Sat', times: 'Closed' },
      { days: 'Sun', times: '6:00 PM–midnight' },
    ]);
  });

  it('leaves the hours out when it’s closed every day', () => {
    expect(businessPageHours([])).toEqual([]);
  });

  it('calls the services what the kind of business calls them, in its own voice', () => {
    expect(businessPageServicesTitle('hvac')).toBe('Services');
    expect(businessPageServicesTitle('real_estate')).toBe('How we help');
    expect(businessPageServicesTitle(null)).toBe('Services');
  });
});
