/**
 * Which visits show their job, and which steps it offers (owner, 2026-11-11): only visits the team goes to, and
 * Waiting on parts only for trades, auto and repair. No database.
 */
import { describe, expect, it } from 'vitest';
import {
  JOB_ON_SITE_INDUSTRIES,
  JOB_PARTS_INDUSTRIES,
  jobFits,
  jobStepRefusal,
  jobSteps,
  placeKindOf,
} from '../src/calendar/job-steps';
import { INDUSTRY_IDS } from '../src/industries';

describe('job steps', () => {
  it('names only kinds of business the list has', () => {
    for (const id of [...JOB_ON_SITE_INDUSTRIES, ...JOB_PARTS_INDUSTRIES])
      expect(INDUSTRY_IDS).toContain(id);
  });

  it('shows the job where the team goes to the customer, whatever the business', () => {
    expect(jobFits({ locationKind: 'customer_address', industry: 'hair_salon' })).toBe(true);
    expect(jobFits({ locationKind: 'customer_address', industry: 'plumbing' })).toBe(true);
  });

  it('hides it at the business, online and by phone, even for a trade', () => {
    for (const locationKind of ['business', 'virtual', 'phone'])
      expect(jobFits({ locationKind, industry: 'hvac' })).toBe(false);
  });

  it('goes by the kind of business when no place is set', () => {
    expect(jobFits({ locationKind: null, industry: 'plumbing' })).toBe(true);
    expect(jobFits({ locationKind: null, industry: 'home_services' })).toBe(true);
    expect(jobFits({ locationKind: null, industry: 'pet_sitting' })).toBe(true);
    expect(jobFits({ locationKind: null, industry: 'hair_salon' })).toBe(false);
    expect(jobFits({ locationKind: null, industry: 'consulting' })).toBe(false);
    expect(jobFits({ locationKind: null, industry: null })).toBe(false);
  });

  it('keeps a job already moving, so it can be finished', () => {
    expect(
      jobFits({ locationKind: 'business', industry: 'hair_salon', status: 'in_progress' }),
    ).toBe(true);
    expect(jobFits({ locationKind: 'business', industry: 'hvac', status: 'cancelled' })).toBe(
      false,
    );
  });

  it('offers Waiting on parts only for trades, auto and repair', () => {
    expect(jobSteps({ industry: 'hvac' })).toEqual([
      'on_the_way',
      'in_progress',
      'waiting_on_parts',
      'done',
    ]);
    expect(jobSteps({ industry: 'auto_repair' })).toContain('waiting_on_parts');
    expect(jobSteps({ industry: 'house_cleaning' })).toEqual(['on_the_way', 'in_progress', 'done']);
    expect(jobSteps({ industry: 'pet_sitting' })).not.toContain('waiting_on_parts');
    // One already waiting keeps it.
    expect(jobSteps({ industry: 'house_cleaning', status: 'waiting_on_parts' })).toContain(
      'waiting_on_parts',
    );
  });

  it('reads the place as the server and the phone keep it', () => {
    expect(placeKindOf({ kind: 'virtual' })).toBe('virtual');
    expect(placeKindOf('{"kind":"customer_address","address":"9 Elm St"}')).toBe(
      'customer_address',
    );
    expect(placeKindOf({})).toBeNull();
    expect(placeKindOf(null)).toBeNull();
    expect(placeKindOf('not json')).toBeNull();
  });

  it('says why a step can’t go, naming the visit and where to fix it', () => {
    const online = jobStepRefusal({
      title: 'Strategy call',
      locationKind: 'virtual',
      industry: 'consulting',
      to: 'on_the_way',
    });
    expect(online?.rule).toBe('job_not_on_site');
    expect(online?.message).toContain('“Strategy call” is online');
    expect(
      jobStepRefusal({ title: 'Haircut', locationKind: null, industry: 'hair_salon', to: 'done' })
        ?.message,
    ).toContain('has no place set');
    const parts = jobStepRefusal({
      title: 'Deep clean',
      locationKind: 'customer_address',
      industry: 'house_cleaning',
      to: 'waiting_on_parts',
    });
    expect(parts?.rule).toBe('job_no_parts');
    expect(parts?.message).toContain('House cleaning');
    expect(parts?.message).toContain('Settings → Workspace');
  });

  it('lets the steps that fit through, and a job go back to scheduled', () => {
    expect(
      jobStepRefusal({
        title: 'AC tune-up',
        locationKind: 'customer_address',
        industry: 'hvac',
        to: 'waiting_on_parts',
      }),
    ).toBeNull();
    expect(
      jobStepRefusal({
        title: 'Haircut',
        locationKind: 'business',
        industry: 'hair_salon',
        status: 'on_the_way',
        to: 'scheduled',
      }),
    ).toBeNull();
    // Nothing changes: no refusal, even where the job doesn't show.
    expect(
      jobStepRefusal({
        title: 'Haircut',
        locationKind: 'business',
        industry: 'hair_salon',
        to: 'scheduled',
      }),
    ).toBeNull();
  });
});
