/**
 * Indeed by email (funnels): which emails are Indeed telling a business somebody applied, and what one says without
 * the AI.
 */
import { describe, expect, it } from 'vitest';
import {
  indeedLeadTitle,
  isIndeedAddress,
  isIndeedApplicantEmail,
  isIndeedMachine,
  readIndeedApplicant,
} from '../src/index';

const indeed = { address: 'noreply@indeed.com' };

describe('spotting an applicant', () => {
  it('knows Indeed’s addresses, and its relay for an applicant from Indeed itself', () => {
    expect(isIndeedAddress('noreply@indeed.com')).toBe(true);
    expect(isIndeedAddress('alerts@mail.indeed.com')).toBe(true);
    expect(isIndeedAddress('no-reply@indeed.co.uk')).toBe(true);
    expect(isIndeedAddress('jordan-4kq@indeedemail.com')).toBe(true);
    expect(isIndeedAddress('someone@notindeed.com')).toBe(false);
    expect(isIndeedAddress('indeed@gmail.com')).toBe(false);
    expect(isIndeedMachine('noreply@indeed.com')).toBe(true);
    expect(isIndeedMachine('jordan-4kq@indeedemail.com')).toBe(false);
  });

  it('takes Indeed’s applicant subjects, and none of its others', () => {
    for (const subject of [
      'Jordan Reyes applied to Sales Associate',
      'New application: Sales Associate - Jordan Reyes',
      'Application for Crew Lead from Sam Ortiz',
      'New applicant for Sales Associate',
    ])
      expect(isIndeedApplicantEmail({ from: indeed, subject })).toBe(true);
    for (const subject of [
      'Your job post is now live: Sales Associate',
      'Your Indeed invoice',
      'Your weekly job performance report',
      'Sponsored job: applications are up 20%',
    ])
      expect(isIndeedApplicantEmail({ from: indeed, subject })).toBe(false);
    expect(
      isIndeedApplicantEmail({
        from: { address: 'jordan@example.com' },
        subject: 'Jordan Reyes applied to Sales Associate',
      }),
    ).toBe(false);
  });
});

describe('reading an applicant without the AI', () => {
  it('finds their relay address, a phone, and the name and job in the subject', () => {
    expect(
      readIndeedApplicant({
        subject: 'Jordan Reyes applied for your Sales Associate job',
        bodyText:
          'Reply to noreply@indeed.com? No: write to jordanreyes-4kq@indeedemail.com. Call (512) 555-0801.',
        ours: ['team@brightteam.com'],
      }),
    ).toEqual({
      name: 'Jordan Reyes',
      email: 'jordanreyes-4kq@indeedemail.com',
      phone: '+15125550801',
      job: 'Sales Associate',
      location: null,
    });
    expect(
      readIndeedApplicant({ subject: 'New application: Crew Lead - Sam Ortiz', bodyText: '' }),
    ).toMatchObject({ name: 'Sam Ortiz', job: 'Crew Lead', email: null });
  });

  it('takes the applicant from Indeed’s relay when Indeed writes as them', () => {
    expect(
      readIndeedApplicant({
        from: { address: 'Riley-9x@indeedemail.com', name: 'Riley Park' },
        subject: 'New applicant for Sales Associate',
      }),
    ).toMatchObject({ name: 'Riley Park', email: 'riley-9x@indeedemail.com' });
  });

  it('names the lead by the job', () => {
    expect(indeedLeadTitle({ name: 'Jordan Reyes', job: 'Sales Associate' }, 'Jordan Reyes')).toBe(
      'Jordan Reyes (Indeed: Sales Associate)',
    );
    expect(indeedLeadTitle({ name: null, job: null }, 'An applicant')).toBe(
      'An applicant (Indeed)',
    );
  });
});
