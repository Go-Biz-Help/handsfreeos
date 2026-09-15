import { describe, expect, it } from 'vitest';
import {
  affectedCents,
  foldCandidates,
  type AttentionCandidate,
  type AttentionKind,
  type Detection,
} from '../src/attention/index';
import { ago, MARIA, MIN, uid } from './attention-fixtures';

const LEAD = uid(1);
const OTHER_LEAD = uid(11);

const detection = (over: Partial<Detection> = {}): Detection => ({
  fingerprint: 'fp',
  since: null,
  urgentFrom: null,
  dueAt: null,
  value: 1_850_000,
  valueIsEstimate: false,
  moneyKey: `lead:${LEAD}`,
  probability: 0.5,
  confidence: 0.8,
  reasons: [{ code: 'value', label: '$18,500' }],
  assignee: null,
  recheckAt: null,
  ...over,
});

const candidate = (
  kind: AttentionKind,
  over: Omit<Partial<AttentionCandidate>, 'detection'> & { detection?: Partial<Detection> } = {},
): AttentionCandidate => ({
  kind,
  subjectId: over.leadId ?? LEAD,
  leadId: LEAD,
  personId: MARIA,
  ...over,
  detection: detection({ fingerprint: `${kind}|${over.leadId ?? LEAD}`, ...over.detection }),
});

const waiting = (personId: string | null = MARIA) =>
  candidate('customer_waiting', {
    subjectId: uid(400),
    leadId: null,
    personId,
    detection: {
      moneyKey: null,
      value: 50_000,
      valueIsEstimate: true,
      urgentFrom: ago(MIN),
      reasons: [{ code: 'waiting', label: 'waiting 11 min', since: ago(11 * MIN) }],
    },
  });

describe('folding', () => {
  it('keeps only the highest-precedence kind on a lead; the others become its chips', () => {
    const out = foldCandidates([
      candidate('missing_next_action', {
        detection: { reasons: [{ code: 'no_next_action', label: 'no next action' }] },
      }),
      candidate('stale_opportunity', {
        detection: { reasons: [{ code: 'last_contact', label: 'Last contact 9 days ago' }] },
      }),
      candidate('hot_lead', {
        detection: {
          reasons: [
            { code: 'value', label: '$18,500' },
            { code: 'ready_to_book', label: 'ready to book' },
          ],
        },
      }),
      candidate('unanswered_lead', {
        detection: { reasons: [{ code: 'not_contacted', label: 'not contacted yet' }] },
      }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.kind).toBe('hot_lead');
    expect(out[0]!.folded.map((f) => f.kind)).toEqual([
      'unanswered_lead',
      'stale_opportunity',
      'missing_next_action',
    ]);
    expect(out[0]!.detection.reasons.map((r) => r.code)).toEqual([
      'value',
      'ready_to_book',
      'not_contacted',
      'last_contact',
      'no_next_action',
    ]);
  });

  it('keeps a lower lead kind that is the only one holding', () => {
    const out = foldCandidates([candidate('missing_next_action'), candidate('stale_opportunity')]);
    expect(out.map((c) => c.kind)).toEqual(['stale_opportunity']);
  });

  it('keeps separate leads separate', () => {
    const out = foldCandidates([
      candidate('hot_lead'),
      candidate('stale_opportunity', { leadId: OTHER_LEAD }),
    ]);
    expect(out.map((c) => [c.kind, c.leadId])).toEqual([
      ['hot_lead', LEAD],
      ['stale_opportunity', OTHER_LEAD],
    ]);
  });

  it('keeps a dismissed card’s facts when only a lower lead kind comes and goes', () => {
    const alone = foldCandidates([candidate('hot_lead')])[0]!;
    const withLower = foldCandidates([candidate('hot_lead'), candidate('missing_next_action')])[0]!;
    expect(withLower.detection.fingerprint).toBe(alone.detection.fingerprint);
  });

  it('folds a waiting conversation into the customer’s lead card', () => {
    const stale = candidate('stale_opportunity');
    const out = foldCandidates([stale, waiting()]);
    expect(out).toHaveLength(1);
    const card = out[0]!;
    expect(card.kind).toBe('stale_opportunity');
    expect(card.folded).toEqual([{ kind: 'customer_waiting', subjectId: uid(400) }]);
    expect(card.detection.reasons.map((r) => r.code)).toEqual(['value', 'waiting']);
    // The card turns urgent when the wait does, and a customer who starts waiting brings back a dismissed card.
    expect(card.detection.urgentFrom).toBe(ago(MIN));
    expect(card.detection.fingerprint).not.toBe(stale.detection.fingerprint);
    expect(card.detection.fingerprint.length).toBeLessThanOrEqual(200);
    expect(card.detection.value).toBe(1_850_000);
  });

  it('lets a waiting conversation stand alone when the customer has no lead card', () => {
    const out = foldCandidates([candidate('hot_lead'), waiting(uid(77)), waiting(null)]);
    expect(out.map((c) => c.kind)).toEqual(['hot_lead', 'customer_waiting', 'customer_waiting']);
    expect(out[1]!.folded).toEqual([]);
  });

  it('joins the higher-precedence card when the customer has two leads', () => {
    const out = foldCandidates([
      candidate('stale_opportunity'),
      candidate('hot_lead', { leadId: OTHER_LEAD }),
      waiting(),
    ]);
    const hot = out.find((c) => c.kind === 'hot_lead')!;
    const stale = out.find((c) => c.kind === 'stale_opportunity')!;
    expect(hot.folded.map((f) => f.kind)).toEqual(['customer_waiting']);
    expect(stale.folded).toEqual([]);
  });

  it('passes the other kinds through', () => {
    const out = foldCandidates([
      candidate('hot_lead'),
      candidate('unconfirmed_appointment', { subjectId: uid(301) }),
      candidate('ai_approval', { subjectId: uid(500) }),
      candidate('overdue_task', { subjectId: uid(600) }),
    ]);
    expect(out.map((c) => c.kind)).toEqual([
      'hot_lead',
      'unconfirmed_appointment',
      'ai_approval',
      'overdue_task',
    ]);
  });

  it('counts a lead’s dollars once in "$ affected"', () => {
    const out = foldCandidates([
      candidate('hot_lead'),
      candidate('missing_next_action'),
      candidate('unconfirmed_appointment', { subjectId: uid(301) }),
      waiting(),
    ]);
    expect(affectedCents(out.map((c) => c.detection))).toBe(1_850_000);
  });
});
