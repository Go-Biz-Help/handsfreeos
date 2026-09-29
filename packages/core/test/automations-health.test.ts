/**
 * Automations' health and quality (stage 4b), without a database: when a channel goes quiet, a connection breaks
 * or goes silent, nobody reviews the AI, a lesson waits (and what it goes against), the website changed and a
 * question keeps coming up; how a lesson joins the policies or takes the place of what says otherwise; and where
 * each card opens.
 */
import { describe, expect, it } from 'vitest';
import {
  attentionTargetOf,
  defaultAttentionSettings,
  DETECTORS,
  gapWords,
  lessonKnowsOtherwise,
  textingRejectedWords,
  type AiCorrectionsFacts,
  type AiUnreviewedFacts,
  type ChannelQuietFacts,
  type ConnectionFacts,
  type FaqSuggestionsFacts,
  type TextingRejectedFacts,
  type WebsiteChangedFacts,
} from '../src/attention/index';
import { openDayMs } from '../src/attention/load-health';
import { withLesson } from '../src/commands/teammate-lesson';
import { saysWords, swapWords } from '../src/knowledge/lessons';
import { ago, business, DAY, HOUR, later, NOW, uid, WEEKDAYS_8_TO_5 } from './attention-fixtures';

const settings = defaultAttentionSettings();

describe('channel_quiet', () => {
  const facts = (over: Partial<ChannelQuietFacts['channel']> = {}): ChannelQuietFacts => ({
    business,
    channel: {
      id: uid(1),
      kind: 'text',
      count: 40,
      lastInboundAt: ago(DAY),
      usualGapMs: 2 * HOUR,
      quietAt: ago(3 * HOUR),
      ...over,
    },
  });
  const d = DETECTORS.channel_quiet;

  it('opens once it has been quiet for three usual gaps, saying how long', () => {
    const found = d.detect(facts(), settings, NOW)!;
    expect(found.reasons.map((r) => r.label)).toEqual([
      'Texts usually every 2 h',
      'nothing for 1 day',
    ]);
    expect(found.urgentFrom).toBeNull();
  });

  it('waits until then, and leaves a channel that hardly gets anything alone', () => {
    expect(d.detect(facts({ quietAt: later(HOUR) }), settings, NOW)).toBeNull();
    expect(d.wakeAt(facts({ quietAt: later(HOUR) }), settings, NOW)).toBe(later(HOUR));
    expect(d.detect(facts({ count: 9 }), settings, NOW)).toBeNull();
  });

  it('a typical open day is the week’s open hours over its open days', () => {
    expect(openDayMs(WEEKDAYS_8_TO_5)).toBe(9 * HOUR);
    expect(openDayMs([])).toBe(DAY);
    expect(gapWords(40 * 60_000)).toBe('40 min');
    expect(gapWords(3 * DAY)).toBe('3 days');
  });
});

describe('connection_error and connection_silent', () => {
  const facts = (over: Partial<ConnectionFacts['connection']> = {}): ConnectionFacts => ({
    business,
    connection: {
      id: uid(2),
      system: 'payments',
      name: 'Stripe',
      problem: 'reauth',
      brokenSince: ago(HOUR),
      lastDataAt: null,
      usualGapMs: null,
      userId: null,
      ...over,
    },
  });

  it('a broken one is urgent at once, and never silent too', () => {
    const found = DETECTORS.connection_error.detect(facts(), settings, NOW)!;
    expect(found.urgentFrom).toBe(ago(HOUR));
    expect(found.reasons[0]).toMatchObject({ code: 'broken', label: 'Sign-in expired' });
    expect(DETECTORS.connection_silent.detect(facts(), settings, NOW)).toBeNull();
  });

  it('a syncing one is silent after three gaps and at least two hours, and it’s its owner’s', () => {
    const syncing = (lastDataAt: string, usualGapMs: number) =>
      facts({
        system: 'calendar',
        name: 'Google Calendar · Dale',
        problem: null,
        brokenSince: null,
        lastDataAt,
        usualGapMs,
        userId: uid(9),
      });
    // 15-minute syncs: three gaps is 45 minutes, but it waits two hours.
    expect(
      DETECTORS.connection_silent.detect(syncing(ago(HOUR), 15 * 60_000), settings, NOW),
    ).toBeNull();
    const silent = DETECTORS.connection_silent.detect(
      syncing(ago(3 * HOUR), 15 * 60_000),
      settings,
      NOW,
    )!;
    expect(silent.assignee).toBe(uid(9));
    expect(silent.reasons[0]).toMatchObject({ code: 'silent', label: 'nothing for 3 h' });
    expect(
      DETECTORS.connection_error.detect(syncing(ago(3 * HOUR), 15 * 60_000), settings, NOW),
    ).toBeNull();
  });

  it('can’t be turned off: a broken connection always shows', () => {
    const off = defaultAttentionSettings();
    expect(off.kinds.connection_error).toBe(true);
  });
});

describe('texting_rejected', () => {
  const facts = (
    over: Partial<TextingRejectedFacts['registration']> = {},
  ): TextingRejectedFacts => ({
    business,
    registration: {
      id: uid(3),
      status: 'rejected',
      rejectionReason: 'The business address doesn’t match the EIN record.',
      submittedAt: ago(9 * DAY),
      rejectedAt: ago(2 * HOUR),
      current: true,
      ...over,
    },
  });

  it('is urgent from the moment the carriers turned it down', () => {
    const found = DETECTORS.texting_rejected.detect(facts(), settings, NOW)!;
    expect(found.urgentFrom).toBe(ago(2 * HOUR));
    expect(found.reasons[0]).toMatchObject({
      code: 'broken',
      label: 'Turned down by the carriers',
    });
  });

  it('goes once the details are sent again or approved, or it isn’t the business’s newest', () => {
    for (const status of ['submitted', 'in_review', 'approved'])
      expect(DETECTORS.texting_rejected.detect(facts({ status }), settings, NOW)).toBeNull();
    expect(DETECTORS.texting_rejected.detect(facts({ current: false }), settings, NOW)).toBeNull();
  });

  it('comes back when new details are turned down too', () => {
    const first = DETECTORS.texting_rejected.detect(facts(), settings, NOW)!;
    const again = DETECTORS.texting_rejected.detect(
      facts({ submittedAt: ago(DAY), rejectionReason: 'The website doesn’t mention texting.' }),
      settings,
      NOW,
    )!;
    expect(again.fingerprint).not.toBe(first.fingerprint);
  });

  it('quotes the carriers, and says what to do after', () => {
    expect(
      textingRejectedWords('The address doesn’t match the EIN record.', '(512) 555-0148'),
    ).toEqual({
      title: 'The carriers turned down texting for (512) 555-0148',
      detail:
        'Their reason: “The address doesn’t match the EIN record.” Fix your details in Settings → Texting & calls and send them again. Calls keep working meanwhile.',
    });
    expect(textingRejectedWords(null, null).detail).toMatch(/^They didn’t give a reason\. Fix/);
    const long = textingRejectedWords('x'.repeat(500), null).detail;
    expect(long).toMatch(/…” Fix your details/);
    expect(long.length).toBeLessThanOrEqual(300);
  });

  it('can’t be turned off, and opens Texting & calls', () => {
    expect(defaultAttentionSettings().kinds.texting_rejected).toBe(true);
    const item = {
      kind: 'texting_rejected' as const,
      subject: { type: 'registration', id: uid(3) },
      leadId: null,
      conversationId: null,
      appointmentId: null,
      reasons: [],
      personId: null,
    };
    expect(attentionTargetOf(item, uid(8)).href).toBe(`/app/w/${uid(8)}/settings/texting`);
  });
});

describe('ai_unreviewed', () => {
  const facts = (over: Partial<AiUnreviewedFacts['teammate']> = {}): AiUnreviewedFacts => ({
    business,
    teammate: {
      id: uid(3),
      name: 'Ava',
      status: 'training',
      modeSince: ago(30 * DAY),
      work: 14,
      lastLookAt: ago(8 * DAY),
      ...over,
    },
  });
  const d = DETECTORS.ai_unreviewed;

  it('opens after a week with nobody looking, in training or automatic', () => {
    expect(d.detect(facts(), settings, NOW)?.reasons[0]?.label).toBe(
      '14 drafts · none reviewed in 7 days',
    );
    expect(
      d.detect(facts({ status: 'automatic', work: 5 }), settings, NOW)?.reasons[0]?.label,
    ).toBe('5 conversations · nobody looked in 7 days');
  });

  it('waits a week after someone looked or it changed mode, and needs some work to look at', () => {
    expect(d.detect(facts({ lastLookAt: ago(6 * DAY) }), settings, NOW)).toBeNull();
    expect(
      d.detect(facts({ modeSince: ago(3 * DAY), lastLookAt: null }), settings, NOW),
    ).toBeNull();
    expect(d.detect(facts({ work: 2 }), settings, NOW)).toBeNull();
    expect(d.detect(facts({ status: 'off' }), settings, NOW)).toBeNull();
  });
});

describe('ai_corrections, website_changed and faq_suggestions', () => {
  it('a lesson shows while it’s open', () => {
    const f = (status: AiCorrectionsFacts['lesson']['status']): AiCorrectionsFacts => ({
      business,
      lesson: {
        id: uid(4),
        teammateId: uid(3),
        line: 'We don’t work Sundays.',
        why: null,
        corrections: 3,
        status,
        createdAt: ago(HOUR),
      },
    });
    expect(DETECTORS.ai_corrections.detect(f('open'), settings, NOW)?.reasons[0]?.label).toBe(
      'Corrected 3 times · “We don’t work Sundays.”',
    );
    expect(DETECTORS.ai_corrections.detect(f('applied'), settings, NOW)).toBeNull();
  });

  it('a lesson shows from its first correction, and says where what the AI knows says otherwise', () => {
    const f = (conflict: AiCorrectionsFacts['lesson']['conflict']): AiCorrectionsFacts => ({
      business,
      lesson: {
        id: uid(4),
        teammateId: uid(3),
        line: 'We don’t work Sundays.',
        why: null,
        corrections: 1,
        status: 'open',
        createdAt: ago(HOUR),
        conflict,
      },
    });
    expect(
      DETECTORS.ai_corrections.detect(f(null), settings, NOW)?.reasons.map((r) => r.label),
    ).toEqual(['Corrected once · “We don’t work Sundays.”']);
    const clash = DETECTORS.ai_corrections.detect(
      f({ where: 'Hours', existing: 'Open 7 days a week' }),
      settings,
      NOW,
    );
    expect(clash?.reasons.map((r) => [r.code, r.label])).toEqual([
      ['knows_otherwise', 'Hours says “Open 7 days a week”'],
      ['corrected', 'Corrected once · “We don’t work Sundays.”'],
    ]);
    const card = { kind: 'ai_corrections' as const, reasons: clash!.reasons };
    expect(lessonKnowsOtherwise(card)).toBe(true);
    expect(lessonKnowsOtherwise({ ...card, reasons: clash!.reasons.slice(1) })).toBe(false);
  });

  it('the weekly re-read opens a card while its updates wait; a person’s own scan doesn’t', () => {
    const f = (over: Partial<WebsiteChangedFacts['scan']> = {}): WebsiteChangedFacts => ({
      business,
      scan: {
        id: uid(5),
        automatic: true,
        finishedAt: ago(HOUR),
        pagesChanged: 2,
        waiting: 3,
        ...over,
      },
    });
    expect(DETECTORS.website_changed.detect(f(), settings, NOW)?.reasons[0]?.label).toBe(
      '2 pages changed · 3 updates to review',
    );
    expect(DETECTORS.website_changed.detect(f({ waiting: 0 }), settings, NOW)).toBeNull();
    expect(DETECTORS.website_changed.detect(f({ automatic: false }), settings, NOW)).toBeNull();
  });

  it('a question shows from its third ask until it’s answered', () => {
    const f = (asked: number, status: 'pending' | 'accepted' = 'pending'): FaqSuggestionsFacts => ({
      business,
      suggestion: {
        id: uid(6),
        question: 'Do you work Sundays?',
        asked,
        status,
        createdAt: ago(DAY),
      },
    });
    expect(DETECTORS.faq_suggestions.detect(f(2), settings, NOW)).toBeNull();
    expect(DETECTORS.faq_suggestions.detect(f(3), settings, NOW)?.reasons[0]?.label).toBe(
      '“Do you work Sundays?” · asked 3 times',
    );
    expect(DETECTORS.faq_suggestions.detect(f(4, 'accepted'), settings, NOW)).toBeNull();
  });
});

describe('a lesson joins the policies', () => {
  it('goes on a line of its own, once, and never past the field’s limit', () => {
    expect(withLesson('', 'We don’t work Sundays.')).toBe('We don’t work Sundays.');
    expect(withLesson('Deposits are 20%.', 'We don’t work Sundays.')).toBe(
      'Deposits are 20%.\nWe don’t work Sundays.',
    );
    expect(withLesson('- We don’t work Sundays.', 'We don’t work Sundays.')).toBe(
      '- We don’t work Sundays.',
    );
    expect(withLesson('x'.repeat(2990), 'We don’t work Sundays.')).toBeNull();
  });
});

describe('a lesson takes the place of what says otherwise', () => {
  it('finds the old words whatever their case, spacing or quotes', () => {
    expect(saysWords('Open  7 days a week, 8–6.', 'open 7 days a week')).toBe(true);
    expect(saysWords('We don’t do Sundays.', "We don't do Sundays")).toBe(true);
    expect(saysWords('Open 7 days a week.', 'Open 6 days')).toBe(false);
    expect(saysWords('Anything', '   ')).toBe(false);
  });

  it('swaps them for the new ones, or takes them out without leaving a bare bullet', () => {
    expect(
      swapWords('Open 7 days a week, 8–6.', 'Open 7 days a week', 'Open Monday to Saturday'),
    ).toBe('Open Monday to Saturday, 8–6.');
    expect(
      swapWords(
        'Deposits are 20%.\n- We work Sundays by appointment.\nNo pets.',
        'We work Sundays by appointment.',
        'We don’t work Sundays.',
      ),
    ).toBe('Deposits are 20%.\n- We don’t work Sundays.\nNo pets.');
    expect(
      swapWords('Deposits are 20%.\n- We work Sundays.\nNo pets.', 'We work Sundays.', ''),
    ).toBe('Deposits are 20%.\nNo pets.');
    expect(swapWords('Call us, we work Sundays too.', ' we work Sundays too', '')).toBe('Call us.');
    expect(swapWords('Open 7 days a week.', 'Closed Sundays', 'x')).toBeNull();
  });
});

describe('where the health cards open', () => {
  const item = (kind: 'channel_quiet' | 'connection_error', type: string) => ({
    kind,
    subject: { type, id: uid(7) },
    leadId: null,
    conversationId: null,
    appointmentId: null,
    reasons: [],
    personId: null,
  });
  it('the page that checks the channel or fixes the connection', () => {
    expect(attentionTargetOf(item('channel_quiet', 'channel_email'), uid(8)).href).toBe(
      `/app/w/${uid(8)}/settings/email`,
    );
    expect(attentionTargetOf(item('connection_error', 'payment_connection'), uid(8)).href).toBe(
      `/app/w/${uid(8)}/settings/payments`,
    );
  });
});
