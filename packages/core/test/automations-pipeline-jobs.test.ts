/**
 * Automations' pipeline and jobs (stage 3b), without a database: which stage means what, the move a deal is owed,
 * and when the five new cards open and let go.
 */
import { describe, expect, it } from 'vitest';
import {
  defaultAttentionSettings,
  DETECTORS,
  JOB_NEVER_COMPLETED_DAYS,
  morningAfter,
  type JobNoAddressFacts,
  type JobUnconfirmedFacts,
  type PipelineMismatchFacts,
  type QuietAfterPriceFacts,
} from '../src/attention/index';
import { priceIn } from '../src/attention/load-pipeline-jobs';
import {
  dealMoveOf,
  guessStageRole,
  stepStages,
  type DealEvidence,
  type RoleStage,
} from '../src/automations/pipeline-roles';
import { ago, business, DALE, DAY, HOUR, later, lead, NOW, TZ, uid } from './attention-fixtures';

const settings = defaultAttentionSettings();

describe('which stage means what', () => {
  it('guesses from the stage’s name', () => {
    expect(guessStageRole('Contacted')).toBe('contacted');
    expect(guessStageRole('Responded')).toBe('contacted');
    expect(guessStageRole('Estimate sent')).toBe('quoted');
    expect(guessStageRole('Quote after site visit')).toBe('quoted');
    expect(guessStageRole('Proposal')).toBe('quoted');
    expect(guessStageRole('Site visit booked')).toBe('booked');
    expect(guessStageRole('Scheduled')).toBe('booked');
    expect(guessStageRole('New')).toBeNull();
    expect(guessStageRole('Qualified')).toBeNull();
  });

  const stages: RoleStage[] = [
    { id: 'new', name: 'New', kind: 'open', position: 0 },
    { id: 'contacted', name: 'Contacted', kind: 'open', position: 1 },
    { id: 'quoted', name: 'Estimate sent', kind: 'open', position: 2 },
    { id: 'won', name: 'Won', kind: 'won', position: 3 },
    { id: 'lost', name: 'Lost', kind: 'lost', position: 4 },
  ];
  const deal = (stageId: string, enteredAt = 0) => ({
    status: 'open' as const,
    stageId,
    stageEnteredAt: enteredAt,
  });
  const e = (step: DealEvidence['step'], at: number, why: string = step): DealEvidence => ({
    step,
    at,
    why,
  });

  it('finds each step’s stage, and a business’s own choice beats the guess', () => {
    expect(stepStages(stages, {})).toMatchObject({
      contacted: { id: 'contacted' },
      quoted: { id: 'quoted' },
      won: { id: 'won' },
    });
    expect(stepStages(stages, {}).booked).toBeUndefined();
    const chosen = stepStages(stages, { new: 'booked', quoted: 'none' });
    expect(chosen.booked?.id).toBe('new');
    expect(chosen.quoted).toBeUndefined();
  });

  it('moves a deal to the furthest stage what happened says, forward only', () => {
    expect(
      dealMoveOf(deal('new'), stages, {}, [e('contacted', 10), e('quoted', 20)]),
    ).toMatchObject({
      stage: { id: 'quoted' },
      step: 'quoted',
    });
    expect(
      dealMoveOf(deal('quoted'), stages, {}, [e('won', 30, 'Quote 1042 accepted')]),
    ).toMatchObject({
      stage: { id: 'won' },
      why: 'Quote 1042 accepted',
    });
    // Never back.
    expect(dealMoveOf(deal('quoted'), stages, {}, [e('contacted', 30)])).toBeNull();
    // Nothing that happened before it entered its stage (someone moved it back by hand afterwards).
    expect(dealMoveOf(deal('new', 50), stages, {}, [e('quoted', 20)])).toBeNull();
    // A stage the business said nothing moves into.
    expect(dealMoveOf(deal('new'), stages, { quoted: 'none' }, [e('quoted', 20)])).toBeNull();
    // Closed deals stay closed.
    expect(dealMoveOf({ ...deal('won'), status: 'won' }, stages, {}, [e('won', 20)])).toBeNull();
  });

  it('reads a price out of what somebody wrote', () => {
    expect(priceIn('It would be $1,450 installed')).toBe('$1,450');
    expect(priceIn('About $ 89.50 for the part')).toBe('$89.50');
    expect(priceIn('Call me at 713-555-0100')).toBeNull();
    expect(priceIn('$0')).toBeNull();
  });
});

describe('pipeline_mismatch', () => {
  const facts = (target: PipelineMismatchFacts['deal']['target']): PipelineMismatchFacts => ({
    business,
    lead: { id: uid(1), valueCents: 90_000, status: 'open' },
    deal: { stageName: 'New', target },
    assigneeUserId: DALE,
  });
  const target = (at: string) => ({
    stageId: uid(2),
    stageName: 'Estimate sent',
    why: 'Quote 1042 went out',
    at,
  });
  it('opens a day after what happened, if the deal still hasn’t moved', () => {
    const d = DETECTORS.pipeline_mismatch;
    expect(d.detect(facts(target(ago(2 * HOUR))), settings, NOW)).toBeNull();
    expect(d.wakeAt(facts(target(ago(2 * HOUR))), settings, NOW)).toBe(
      new Date(Date.parse(ago(2 * HOUR)) + DAY).toISOString(),
    );
    const open = d.detect(facts(target(ago(DAY + HOUR))), settings, NOW);
    expect(open?.reasons[0]).toMatchObject({
      code: 'stage',
      label: 'Says New · quote 1042 went out',
    });
    expect(d.detect(facts(null), settings, NOW)).toBeNull();
  });
});

describe('quiet_after_price', () => {
  const facts = (over: Partial<QuietAfterPriceFacts> = {}): QuietAfterPriceFacts => ({
    business,
    lead: lead(),
    price: { at: ago(2 * DAY + HOUR), amount: '$450', via: 'text', open: true },
    heardFromAt: ago(3 * DAY),
    estimateWaitingDays: 5,
    ...over,
  });
  const detect = (f: QuietAfterPriceFacts) => DETECTORS.quiet_after_price.detect(f, settings, NOW);

  it('opens two days after a price they didn’t answer', () => {
    expect(detect(facts())?.reasons[0]).toMatchObject({ code: 'price', label: '$450 by text' });
    expect(
      detect(facts({ price: { at: ago(DAY), amount: '$450', via: 'text', open: true } })),
    ).toBeNull();
  });

  it('stands down when they answer, the quote is decided or "Quotes with no decision" takes it', () => {
    expect(detect(facts({ heardFromAt: ago(HOUR) }))).toBeNull();
    expect(
      detect(facts({ price: { at: ago(3 * DAY), amount: '$450', via: 'quote', open: false } })),
    ).toBeNull();
    expect(
      detect(facts({ price: { at: ago(3 * DAY), amount: '$450', via: 'quote', open: true } })),
    ).not.toBeNull();
    expect(
      detect(facts({ price: { at: ago(6 * DAY), amount: '$450', via: 'quote', open: true } })),
    ).toBeNull();
  });
});

describe('the job cards', () => {
  const appointment = (
    startsAt: string,
    endsAt: string,
    status: 'scheduled' | 'completed' = 'scheduled',
  ) => ({
    id: uid(40),
    status,
    startsAt,
    endsAt,
    label: 'AC tune-up · Mon at 2:00 PM',
  });
  const job = (endedAgo: number, jobCheckOn = true): JobUnconfirmedFacts => ({
    business,
    appointment: appointment(ago(endedAgo + HOUR), ago(endedAgo)),
    lead: null,
    assigneeUserId: DALE,
    jobCheckOn,
  });

  it('asks from 6 AM the day after, then hands over to "never marked done" three days on', () => {
    const f = job(20 * HOUR);
    const opens = morningAfter(Date.parse(f.appointment.endsAt), TZ);
    const unconfirmed = DETECTORS.job_unconfirmed;
    const never = DETECTORS.job_never_completed;
    expect(unconfirmed.detect(f, settings, new Date(opens - 60_000))).toBeNull();
    expect(unconfirmed.detect(f, settings, new Date(opens + 60_000))).not.toBeNull();
    expect(never.detect(f, settings, new Date(opens + 60_000))).toBeNull();
    const handover = new Date(
      Date.parse(f.appointment.endsAt) + JOB_NEVER_COMPLETED_DAYS * DAY + 1,
    );
    expect(unconfirmed.detect(f, settings, handover)).toBeNull();
    expect(never.detect(f, settings, handover)).not.toBeNull();
    // With the check off, only the three-day card.
    expect(
      unconfirmed.detect(job(20 * HOUR, false), settings, new Date(opens + 60_000)),
    ).toBeNull();
    // Marked: nothing.
    expect(
      never.detect(
        { ...f, appointment: { ...f.appointment, status: 'completed' } },
        settings,
        handover,
      ),
    ).toBeNull();
  });

  it('flags a visit at their place two days out with no address', () => {
    const f = (over: Partial<JobNoAddressFacts> = {}): JobNoAddressFacts => ({
      business,
      appointment: appointment(later(DAY), later(DAY + HOUR)),
      lead: null,
      assigneeUserId: DALE,
      locationKind: 'customer_address',
      hasAddress: false,
      ...over,
    });
    const d = DETECTORS.job_no_address;
    expect(d.detect(f(), settings, NOW)?.reasons[0]?.code).toBe('no_address');
    expect(d.detect(f({ hasAddress: true }), settings, NOW)).toBeNull();
    expect(d.detect(f({ locationKind: 'business' }), settings, NOW)).toBeNull();
    expect(
      d.detect(
        f({ appointment: appointment(later(3 * DAY), later(3 * DAY + HOUR)) }),
        settings,
        NOW,
      ),
    ).toBeNull();
  });
});
