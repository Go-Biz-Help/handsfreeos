/**
 * The Action Center's "After the job" cards (Automations stage 2b): a customer nobody could thank, and a
 * referral a customer mentioned. Pure detectors, no database.
 */
import { describe, expect, it } from 'vitest';
import {
  defaultAttentionSettings,
  DETECTORS,
  letHandleModeOf,
  THANK_YOU_CARD_DAYS,
  MAINTENANCE_CARD_DAYS,
  REFERRAL_CARD_DAYS,
  type JobNotThankedFacts,
  type MaintenanceDueFacts,
  type ReferralMentionedFacts,
} from '../src/attention/index';
import { ago, business, DALE, DAY, HOUR, NOW, uid } from './attention-fixtures';

const settings = defaultAttentionSettings();
const codes = (d: { reasons: readonly { code: string }[] } | null) =>
  d?.reasons.map((r) => r.code) ?? null;

describe('job_not_thanked', () => {
  const facts = (
    over: Partial<JobNotThankedFacts['thankYou']> = {},
    switchOn = true,
  ): JobNotThankedFacts => ({
    business,
    thankYou: {
      id: uid(700),
      completedAt: ago(2 * HOUR),
      outcome: 'card',
      contactedAt: null,
      personArchived: false,
      ...over,
    },
    switchOn,
    lead: null,
    assigneeUserId: DALE,
  });
  const detect = (f: JobNotThankedFacts, now = NOW) =>
    DETECTORS.job_not_thanked.detect(f, settings, now);

  it('opens when the thank-you couldn’t go, and says how long ago the job was done', () => {
    const d = detect(facts());
    expect(codes(d)).toEqual(['job_done']);
    expect(d!.reasons[0]!.label).toBe('job done 2 h ago');
    expect(d!.assignee).toBe(DALE);
    // Looked at again when the offer runs out.
    expect(Date.parse(d!.recheckAt!)).toBe(Date.parse(ago(2 * HOUR)) + THANK_YOU_CARD_DAYS * DAY);
    // A person thanks them: HandsFreeOS already tried.
    expect(letHandleModeOf('job_not_thanked')).toBe('none');
  });

  it('stays shut when a thank-you went, somebody wrote to them, the switch is off, or it’s too late', () => {
    expect(detect(facts({ outcome: 'sent' }))).toBeNull();
    expect(detect(facts({ outcome: 'drafted' }))).toBeNull();
    expect(detect(facts({ outcome: 'skipped' }))).toBeNull();
    expect(detect(facts({ contactedAt: ago(HOUR) }))).toBeNull();
    expect(detect(facts({ personArchived: true }))).toBeNull();
    expect(detect(facts({}, false))).toBeNull();
    expect(detect(facts({ completedAt: ago(THANK_YOU_CARD_DAYS * DAY + HOUR) }))).toBeNull();
  });
});

describe('referral_mentioned', () => {
  const facts = (
    over: Partial<ReferralMentionedFacts['referral']> = {},
  ): ReferralMentionedFacts => ({
    business,
    referral: {
      id: uid(800),
      status: 'mentioned',
      createdAt: ago(HOUR),
      relation: 'neighbor',
      need: 'AC looked at',
      ...over,
    },
    assigneeUserId: null,
  });
  const detect = (f: ReferralMentionedFacts, now = NOW) =>
    DETECTORS.referral_mentioned.detect(f, settings, now);

  it('opens with who they are and what they need', () => {
    const d = detect(facts());
    expect(d!.reasons).toEqual([{ code: 'referral', label: 'neighbor · AC looked at' }]);
    // Somebody new: the typical job, never counted as money in hand.
    expect(d!.valueIsEstimate).toBe(true);
    expect(letHandleModeOf('referral_mentioned')).toBe('none');
  });

  it('clears once it’s a lead or dismissed, lets go after its days, and can be switched off', () => {
    expect(detect(facts({ status: 'lead_created' }))).toBeNull();
    expect(detect(facts({ status: 'dismissed' }))).toBeNull();
    expect(detect(facts({ createdAt: ago(REFERRAL_CARD_DAYS * DAY + HOUR) }))).toBeNull();
    const off = { ...settings, kinds: { ...settings.kinds, referral_mentioned: false } };
    expect(DETECTORS.referral_mentioned.detect(facts(), off, NOW)).toBeNull();
    // Nothing said about them but that they exist: no chip, still a card.
    expect(detect(facts({ relation: null, need: null }))!.reasons).toEqual([]);
  });
});

describe('maintenance_due', () => {
  const facts = (over: Partial<MaintenanceDueFacts['reminder']> = {}): MaintenanceDueFacts => ({
    business,
    reminder: {
      id: uid(900),
      status: 'card',
      cardAt: ago(DAY),
      label: 'AC tune-up due Oct 5',
      booked: false,
      contactedAt: null,
      ...over,
    },
    lead: null,
    assigneeUserId: DALE,
  });
  const detect = (f: MaintenanceDueFacts, now = NOW) =>
    DETECTORS.maintenance_due.detect(f, settings, now);

  it('asks a person once the texts ran out, and says which service and when', () => {
    const d = detect(facts());
    expect(d!.reasons).toEqual([{ code: 'maintenance', label: 'AC tune-up due Oct 5' }]);
    expect(d!.assignee).toBe(DALE);
    expect(letHandleModeOf('maintenance_due')).toBe('none');
  });

  it('clears once they book or someone gets in touch, and lets go after its days', () => {
    expect(detect(facts({ status: 'reminding', cardAt: null }))).toBeNull();
    expect(detect(facts({ booked: true }))).toBeNull();
    expect(detect(facts({ contactedAt: ago(HOUR) }))).toBeNull();
    expect(detect(facts({ cardAt: ago(MAINTENANCE_CARD_DAYS * DAY + HOUR) }))).toBeNull();
  });
});
