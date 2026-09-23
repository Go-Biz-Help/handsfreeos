/**
 * Deal in the wrong stage (Automations' pipeline rows): something happened to a deal that its stage doesn't show
 * (a quote went out, a visit was booked, the customer said yes) and a day later it still hasn't moved. Either
 * "Move deals along for you" is off, the deal was moved back by hand before it happened, or the move failed.
 * One press moves it.
 *
 * It holds until the deal moves (or closes), and never for something that happened before the deal entered the
 * stage it's in: a deal someone moved back on purpose after the fact is theirs to place.
 */
import { chip } from '../chips';
import { leadValue, type BusinessFacts, type LinkedLeadFacts } from '../facts';
import { fingerprintOf } from '../fingerprint';
import type { AttentionSettings } from '../settings';
import { DAY, defineDetector, detection, ms, type Assessment } from './define';

/** How long a deal may be behind before a person is asked: long enough for the automatic move to have run. */
export const PIPELINE_MISMATCH_AFTER_MS = DAY;

export interface PipelineMismatchFacts {
  readonly business: BusinessFacts;
  readonly lead: LinkedLeadFacts;
  readonly deal: {
    readonly stageName: string;
    /** Where what happened says it belongs, and why; null when its stage is right. */
    readonly target: {
      readonly stageId: string;
      readonly stageName: string;
      readonly why: string;
      readonly at: string;
    } | null;
  };
  readonly assigneeUserId: string | null;
}

function assess(f: PipelineMismatchFacts, settings: AttentionSettings, now: number): Assessment {
  const t = f.deal.target;
  if (f.lead.status !== 'open' || !t) return null;
  const since = ms(t.at);
  const opens = since + PIPELINE_MISMATCH_AFTER_MS;
  if (now < opens) return { wakeAt: opens };
  return detection({
    fingerprint: fingerprintOf('pipeline_mismatch', { lead: f.lead.id, to: t.stageId }),
    since,
    urgentFrom: null,
    dueAt: null,
    value: leadValue(f.lead, f.business, settings),
    probability: 0.4,
    confidence: 0.8,
    reasons: [chip('stage', `Says ${f.deal.stageName} · ${t.why.toLowerCase()}`)],
    assignee: f.assigneeUserId,
    recheckAt: null,
  });
}

export const { detect, wakeAt } = defineDetector<PipelineMismatchFacts>(
  'pipeline_mismatch',
  assess,
);
