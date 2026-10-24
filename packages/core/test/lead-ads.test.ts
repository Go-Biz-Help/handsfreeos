/**
 * Facebook and Instagram lead ads' answers, tick boxes and access, in words (funnels): what the worker files and
 * what Settings and "Where they came from" say.
 */
import { describe, expect, it } from 'vitest';
import {
  attributionSummary,
  isTextConsentBox,
  leadAgreedToTexts,
  leadPayload,
  leadQuestionWords,
  leadsAccessWords,
  textConsentKeys,
  touchFacts,
  touchKindWords,
  touchTitle,
  type AttributionTouchRow,
} from '../src/index';

describe('a lead’s answers', () => {
  it('fills the customer from Meta’s own questions and keeps the rest in the form’s words', () => {
    const p = leadPayload(
      [
        { name: 'full_name', values: ['Morgan Lee'] },
        { name: 'phone_number', values: ['+15125550701'] },
        { name: 'email', values: ['  morgan@example.com '] },
        { name: 'zip_code', values: ['78701'] },
        { name: 'what_brings_you_here?', values: ['Extra income'] },
        { name: 'best_time_to_call', values: ['Evenings', 'Weekends'] },
        { name: 'job_title', values: ['Nurse'] },
        { name: 'empty', values: ['  '] },
      ],
      [{ key: 'what_brings_you_here?', label: 'What brings you here?' }],
    );
    expect(p).toEqual({
      name: 'Morgan Lee',
      firstName: null,
      lastName: null,
      email: 'morgan@example.com',
      phone: '+15125550701',
      address: { line1: null, city: null, state: null, postalCode: '78701' },
      extra: {
        'What brings you here?': 'Extra income',
        'Best time to call': 'Evenings, Weekends',
        'Job title': 'Nurse',
      },
    });
  });

  it('names a question by its key when the form’s words aren’t known', () => {
    expect(leadQuestionWords('how_soon_can_you_start?')).toBe('How soon can you start?');
    expect(leadQuestionWords('___')).toBe('Answer');
  });
});

describe('a lead form’s tick boxes', () => {
  it('counts a box as the OK to text only when its words are about texts', () => {
    expect(isTextConsentBox('Yes, text me. Msg & data rates may apply.')).toBe(true);
    expect(isTextConsentBox('I agree to receive SMS updates')).toBe(true);
    expect(isTextConsentBox('I agree to the privacy policy')).toBe(false);
    expect(isTextConsentBox('Contextual offers by email')).toBe(false);
    const keys = textConsentKeys([
      { key: 'texts', text: 'Text me about this' },
      { key: 'terms', text: 'I agree to the terms' },
    ]);
    expect(keys).toEqual(['texts']);
    expect(leadAgreedToTexts([{ key: 'texts', checked: true }], keys)).toBe(true);
    expect(leadAgreedToTexts([{ key: 'texts', checked: false }], keys)).toBe(false);
    expect(leadAgreedToTexts([{ key: 'terms', checked: true }], keys)).toBe(false);
  });
});

describe('a Page’s leads, in Settings', () => {
  it('says what to do when they can’t be read', () => {
    expect(leadsAccessWords('unknown', 'Bright Team')).toBeNull();
    expect(leadsAccessWords('ok', 'Bright Team')?.ok).toBe(true);
    expect(leadsAccessWords('blocked', 'Bright Team')?.words).toMatch(
      /Settings → Leads Access and add HandsFreeOS\.$/,
    );
    expect(leadsAccessWords('not_allowed', 'Bright Team')?.words).toMatch(/Connect again/);
  });
});

describe('where they came from', () => {
  const touch = (over: Partial<AttributionTouchRow>): AttributionTouchRow => ({
    id: '11111111-1111-4111-8111-111111111111',
    touchedAt: '2026-10-27T15:00:00.000Z',
    kind: 'lead_form',
    platform: 'facebook',
    channel: 'messenger',
    source: 'LEAD_FORM',
    referralType: null,
    ref: null,
    adId: '120200000000001',
    adTitle: null,
    adPhotoUrl: null,
    postId: null,
    refererUri: null,
    conversationId: null,
    personId: null,
    leadId: null,
    accountName: 'Bright Team',
    formName: 'Meet the team',
    ad: null,
    ...over,
  });

  it('says a lead ad and its form', () => {
    const t = touch({});
    expect(touchTitle(t)).toBe('Facebook lead ad');
    expect(touchKindWords(t)).toBe('Sent its form');
    expect(touchFacts(t)).toEqual(
      expect.arrayContaining([{ label: 'Form', value: 'Meet the team' }]),
    );
    expect(attributionSummary([t], t.id, 1)).toBe('Came from a Facebook lead ad.');
    expect(touchTitle(touch({ adId: null, platform: 'instagram' }))).toBe('Instagram lead form');
  });
});
