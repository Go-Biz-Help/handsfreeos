/**
 * The checks that stand between a business and a three-to-seven-day rejection.
 *
 * Each assertion here is a real reason The Campaign Registry turns a brand or a campaign down, so these are
 * not style preferences either. What the wizard says may change freely; what it refuses to submit may not.
 *
 * The severity split is the point of the file: a `blocker` costs the business one minute of correcting a
 * form, and letting it through costs weeks. A `warning` is something often turned down but sometimes
 * genuinely right, and a wizard that blocks those strands the honest odd case.
 */
import { describe, expect, it } from 'vitest';
import {
  checkDraft,
  checkSample,
  hasBlockers,
  issuesFor,
  sampleHasOptOut,
  sampleNamesBusiness,
  sampleSuggestions,
  type A2pDraft,
} from '../src/messaging/a2p';
import { optInDescriptionFor, liveSurfaces } from '../src/messaging/consent';

const BUSINESS = 'Lone Star HVAC';

/** A draft with nothing wrong with it, for each test to break one thing in. */
const good: A2pDraft = {
  legalName: 'Lone Star HVAC LLC',
  businessType: 'llc',
  ein: '12-3456789',
  website: 'https://lonestarhvac.com',
  useCase: 'customer_care',
  messageSamples: [
    'Lone Star HVAC: your appointment is confirmed for Thursday at 10am. Reply STOP to stop texts.',
    "Hi, it's Lone Star HVAC. Your estimate is ready — reply here and we'll send it over.",
  ],
  optInDescription: optInDescriptionFor(BUSINESS, 'hosted'),
  optInPath: 'hosted',
  monthlyVolume: 'under_1000',
};

describe('a clean draft goes through', () => {
  it('finds nothing that would stop the carrier taking it', () => {
    expect(hasBlockers(checkDraft(good, BUSINESS))).toBe(false);
  });
});

describe('the example texts, which a reviewer reads one by one', () => {
  it('blocks a sample that never says who is texting', () => {
    const issues = checkSample('Your appointment is confirmed for Thursday at 10am.', BUSINESS);
    expect(issues.some((i) => i.severity === 'blocker' && /business name/i.test(i.message))).toBe(
      true,
    );
  });

  it('accepts a business that shortens its own name', () => {
    expect(sampleNamesBusiness('Lone Star: running 20 minutes late.', BUSINESS)).toBe(true);
  });

  it('blocks a shared link shortener, because the carriers block them outright', () => {
    const issues = checkSample(
      `${BUSINESS}: your estimate is ready, see bit.ly/abc123 for details.`,
      BUSINESS,
    );
    expect(issues.some((i) => i.severity === 'blocker' && /bit\.ly/.test(i.message))).toBe(true);
  });

  it('blocks a fragment, because the carrier reads these as real messages', () => {
    expect(checkSample('Confirmed', BUSINESS).some((i) => i.severity === 'blocker')).toBe(true);
  });

  it('needs two examples: one does not show a pattern', () => {
    const issues = checkDraft({ ...good, messageSamples: [good.messageSamples![0]!] }, BUSINESS);
    expect(issuesFor(issues, 'messageSamples').some((i) => i.severity === 'blocker')).toBe(true);
  });

  it('needs STOP somewhere in the set, not in every one', () => {
    const noStop = good.messageSamples!.map((s) => s.replace(' Reply STOP to stop texts.', ''));
    expect(noStop.some(sampleHasOptOut)).toBe(false);
    const issues = checkDraft({ ...good, messageSamples: noStop }, BUSINESS);
    expect(issues.some((i) => i.severity === 'blocker' && /STOP/.test(i.message))).toBe(true);
  });

  it('does not read "send" as the END keyword, or a set with no way out slips through', () => {
    expect(sampleHasOptOut("Hi, it's Lone Star HVAC — we'll send it over.")).toBe(false);
    expect(sampleHasOptOut('Reply STOP to stop texts.')).toBe(true);
    expect(sampleHasOptOut('Reply END to stop texts.')).toBe(true);
  });

  it('warns when customer-care samples read like promotions, and does not block', () => {
    const issues = checkDraft(
      {
        ...good,
        messageSamples: [
          `${BUSINESS}: 20% off any service booked this week. Reply STOP to stop texts.`,
          good.messageSamples![1]!,
        ],
      },
      BUSINESS,
    );
    const mismatch = issuesFor(issues, 'useCase');
    expect(mismatch).toHaveLength(1);
    expect(mismatch[0]!.severity).toBe('warning');
  });
});

describe('the business the carrier looks up', () => {
  it('blocks a company with no EIN, because there is nothing to verify it against', () => {
    const issues = checkDraft({ ...good, ein: '' }, BUSINESS);
    expect(issuesFor(issues, 'ein').some((i) => i.severity === 'blocker')).toBe(true);
  });

  it('lets a sole proprietor through without one', () => {
    const issues = checkDraft(
      { ...good, businessType: 'sole_proprietor', ein: '', legalName: 'Dale Rivera' },
      BUSINESS,
    );
    expect(issuesFor(issues, 'ein')).toHaveLength(0);
  });

  it('blocks a mistyped EIN', () => {
    expect(
      issuesFor(checkDraft({ ...good, ein: '123456' }, BUSINESS), 'ein').some(
        (i) => i.severity === 'blocker',
      ),
    ).toBe(true);
  });

  it('warns when a company name carries no LLC or Inc, and does not block', () => {
    const issues = issuesFor(
      checkDraft({ ...good, legalName: 'Lone Star Heating' }, BUSINESS),
      'legalName',
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]!.severity).toBe('warning');
  });

  it('blocks a registration with no website for the reviewer to open', () => {
    expect(
      issuesFor(checkDraft({ ...good, website: '' }, BUSINESS), 'website').some(
        (i) => i.severity === 'blocker',
      ),
    ).toBe(true);
  });
});

describe('every issue teaches, because "invalid" teaches nobody', () => {
  it('says why the carrier asks, on every single one', () => {
    const issues = checkDraft({ legalName: 'x' }, BUSINESS);
    expect(issues.length).toBeGreaterThan(0);
    for (const issue of issues) expect(issue.why.length).toBeGreaterThan(20);
  });
});

describe('the suggested examples pass our own checks', () => {
  for (const useCase of ['customer_care', 'mixed', 'marketing']) {
    it(`${useCase}: names the business and carries STOP`, () => {
      const samples = sampleSuggestions(BUSINESS, useCase);
      expect(samples.length).toBeGreaterThanOrEqual(2);
      for (const sample of samples) expect(checkSample(sample, BUSINESS)).toHaveLength(0);
      expect(samples.some(sampleHasOptOut)).toBe(true);
    });
  }
});

describe('the sentence the carrier reads describes the box it will look for', () => {
  it('names the URLs a reviewer can open, when we host the opt-in', () => {
    const description = optInDescriptionFor(BUSINESS, 'hosted', {
      formUrl: 'https://handsfreeos.com/f/lonestar/contact',
      chatUrl: 'https://handsfreeos.com/chat/abc',
    });
    expect(description).toContain('https://handsfreeos.com/f/lonestar/contact');
    expect(description).toContain('https://handsfreeos.com/chat/abc');
  });

  it('promises no web page at all when consent is taken in person', () => {
    const description = optInDescriptionFor(BUSINESS, 'in_person');
    expect(description).not.toMatch(/https?:\/\//);
    expect(description).toMatch(/in person|over the phone/i);
  });

  it('carries the six disclosures whichever way consent is collected', () => {
    for (const path of ['hosted', 'own_site', 'in_person'] as const) {
      const description = optInDescriptionFor(BUSINESS, path);
      expect(description).toContain(BUSINESS);
      expect(description).toMatch(/not a condition/i);
      expect(description).toMatch(/rates may apply/i);
      expect(description).toMatch(/STOP/);
      expect(description).toMatch(/HELP/);
    }
  });

  it('orders surfaces so the reviewer meets a visible checkbox first', () => {
    expect(
      liveSurfaces({ chatUrl: 'https://c', formUrl: 'https://f', bookingUrl: 'https://b' }),
    ).toEqual(['https://f', 'https://b', 'https://c']);
  });

  it('leaves out surfaces that are not live', () => {
    expect(liveSurfaces({ chatUrl: '', formUrl: null, bookingUrl: 'https://b' })).toEqual([
      'https://b',
    ]);
  });
});
