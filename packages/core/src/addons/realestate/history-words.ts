/**
 * A deal's history and a duty's, in words (HANDSFREEOS_REAL_ESTATE_IMPLEMENTATION_PLAN.md, "Screens"): each line the
 * add-on keeps names what changed as a code with its before and after; these say it as a sentence, without who did
 * it (the screen adds that). Browser-safe and pure: the web, the phone and the Assistant say the same thing.
 */
import { CONTINGENCY_KINDS, inSentence, type ContingencyKind } from './contingencies';
import { DOCUMENT_KINDS } from './catalog/types';
import {
  FINANCING_STEPS,
  INSPECTION_KINDS,
  type FinancingStep,
  type InspectionKind,
} from './closing';
import { HOME_STATUSES, type HomeStatus } from './homes';
import type { SellerChoice } from './net';
import { KEY_DATES } from './dates/key-dates';
import { STAGE_LABELS, DUTY_STATUS_LABELS, type DealStage, type DutyStatus } from './states';
import { DEAL_ROLE_LABELS, EVENT_WORDS, PARTY_ROLES, type DealRole, type PartyRole } from './words';
import { MONEY_TERMS, TEXT_TERMS } from './terms';
import { TOUR_INTEREST, type TourInterest } from './tours';
import { money } from '../../money/format';

type Bag = Readonly<Record<string, unknown>> | null | undefined;

const str = (v: unknown): string =>
  typeof v === 'string' ? v : typeof v === 'number' && Number.isFinite(v) ? String(v) : '';
const stage = (v: unknown) => STAGE_LABELS[str(v) as DealStage] ?? str(v);
const homeStatus = (v: unknown) => HOME_STATUSES[str(v) as HomeStatus]?.toLowerCase() ?? str(v);
const termName = (k: unknown) => {
  const key = str(k);
  const all: Readonly<Record<string, { label: string }>> = {
    ...KEY_DATES,
    ...MONEY_TERMS,
    ...TEXT_TERMS,
  };
  return all[key]?.label.toLowerCase() ?? key;
};
const financingStep = (v: unknown) =>
  FINANCING_STEPS[str(v) as FinancingStep]?.label.toLowerCase() ?? str(v);
const inspectionKind = (v: unknown) =>
  INSPECTION_KINDS[str(v) as InspectionKind]?.toLowerCase() ?? 'inspection';
const SELLER_CHOICE_SAID: Readonly<Record<SellerChoice, string>> = {
  accept: 'accept',
  counter: 'counter',
  decline: 'decline',
  talk: 'let’s talk',
};
const eventWords = (v: unknown) =>
  (Array.isArray(v) ? v : [])
    .map((e) => (EVENT_WORDS as Readonly<Record<string, string>>)[str(e)])
    .filter(Boolean)
    .join(', ');

/** A contingency as a sentence names it. */
const contingencyWords = (a: Record<string, unknown>) =>
  inSentence(
    a.kind === 'other'
      ? str(a.label)
      : (CONTINGENCY_KINDS[a.kind as ContingencyKind]?.label ?? str(a.kind)),
  );

/** One line of a deal's history: "Moved it to Under contract", "Confirmed closing: Oct 14, 2026". */
export function dealHistoryWords(what: string, before: Bag, after: Bag): string {
  const a = after ?? {};
  const b = before ?? {};
  switch (what) {
    case 'opened':
      return `Opened the deal at ${stage(a.stage)}`;
    case 'stage':
      return `Moved it from ${stage(b.stage)} to ${stage(a.stage)}`;
    case 'event': {
      const w = eventWords(a.events);
      return w ? `Recorded that ${w}` : 'Recorded what happened';
    }
    case 'offer_lost':
      return `The offer was lost; back to ${stage(a.stage)}`;
    case 'terminated':
      return `Terminated the contract; back to ${stage(a.stage)}`;
    case 'closed':
      return 'Closed the deal';
    case 'ended':
      return a.how === 'lost'
        ? 'Ended the deal: the buyer stopped looking'
        : `Ended the listing: ${str(a.how)}`;
    case 'reopened':
      return `Reopened the deal at ${stage(a.stage)}`;
    case 'facts':
      return 'Changed what’s true about the deal';
    // Round two: the buyer's profile and their homes.
    case 'buyer_profile':
      return 'Saved what the buyer wants';
    case 'home_added':
      return a.source === 'client'
        ? `The client added ${str(a.address)}`
        : `Added ${str(a.address)} to the homes`;
    case 'suggestion_not_a_fit':
      return `Set aside ${str(a.address)}, one of our listings: not a fit`;
    case 'home_facts':
      return `Confirmed the facts for ${str(a.address)}`;
    // Round three: the listing.
    case 'description_sent':
      return `Sent the description (version ${str(a.version)}) to the seller to sign off`;
    case 'description_signed':
      return a.how === 'let_through'
        ? `Put the description (version ${str(a.version)}) in use without the seller’s sign-off in the portal`
        : `The seller signed off the description (version ${str(a.version)})`;
    case 'listing_live':
      return b.mlsNumber
        ? `Changed the MLS listing to #${str(a.mlsNumber)}, live since ${str(a.liveOn)}`
        : `Marked it live on the MLS: #${str(a.mlsNumber)}, since ${str(a.liveOn)}`;
    case 'page_published':
      return 'Put the listing’s page up';
    case 'page_taken_down':
      return 'Took the listing’s page down';
    case 'listing_campaign':
      return a.channel === 'email'
        ? `Started an email about the listing to ${str(a.recipients)} contacts`
        : `Started a text about the listing to ${str(a.recipients)} contacts`;
    case 'price_proposed':
      return `Asked the seller to sign off a new price: ${str(b.price)} to ${str(a.price)}`;
    case 'price_changed':
      return a.how === 'let_through'
        ? `Changed the price from ${str(b.price)} to ${str(a.price)} without the seller’s sign-off in the portal`
        : `The seller signed off the new price: ${str(b.price)} to ${str(a.price)}`;
    case 'price_withdrawn':
      return `Withdrew the price change to ${str(a.price)}`;
    case 'open_house_planned':
      return `Planned an open house for ${str(a.when)}, hosted by ${str(a.host)}`;
    case 'open_house_cancelled':
      return `Cancelled the open house on ${str(a.when)}`;
    case 'questionnaire_sent':
      return `${str(a.name)} sent their answers about the home`;
    case 'listing_facts':
      return `Confirmed ${Number(a.count)} ${Number(a.count) === 1 ? 'fact' : 'facts'} about ${str(a.address)}`;
    case 'memory_confirmed':
      return `Remembered: ${str(a.words)}`;
    case 'memory_retired':
      return `No longer true: ${str(a.words)}`;
    case 'home_status':
      return `${str(a.address)}: ${homeStatus(b.status)} to ${homeStatus(a.status)}`;
    // The client's to-do and their portal.
    case 'client_task_added':
      return `Gave the client a task: ${str(a.title)}`;
    case 'client_task_canceled':
      return `Took back the client’s task: ${str(a.title)}`;
    case 'client_task_part':
      return a.kind === 'sign_off'
        ? `${str(a.name)} signed off: ${str(a.title)}`
        : a.kind === 'upload'
          ? `${str(a.name)} uploaded for: ${str(a.title)}`
          : `${str(a.name)} did: ${str(a.title)}`;
    case 'home_reacted':
      return a.reaction === 'passed'
        ? `The client passed on ${str(a.address)}`
        : `The client saved ${str(a.address)}`;
    // Financing, inspections and repairs.
    case 'financing_step_done':
      return `Marked ${financingStep(a.step)} done${a.proof ? `, with ${str(a.proof)}` : ''}`;
    case 'financing_step_reopened':
      return `Took back ${financingStep(a.step)} as done`;
    case 'inspection_added':
      return `Added the ${inspectionKind(a.kind)}`;
    case 'inspection_report_in':
      return `The ${inspectionKind(a.kind)} report is in`;
    case 'field_note_added':
      return a.spoken
        ? 'Recorded a voice note in the field'
        : a.typed
          ? 'Wrote a note in the field'
          : 'Took photos in the field';
    case 'export_requested':
      return 'Asked for the whole transaction as an export';
    case 'exported':
      return a.state === 'ready'
        ? 'The whole transaction was exported'
        : 'The whole transaction couldn’t be exported';
    case 'walkthrough_planned':
      return `Planned the final walkthrough, ${Number(a.items) || 0} things to check`;
    case 'walkthrough_started':
      return 'Started the final walkthrough';
    case 'walkthrough_finished':
      return Number(a.dutiesAdded) > 0
        ? `Finished the final walkthrough, ${Number(a.dutiesAdded)} to fix before closing`
        : 'Finished the final walkthrough, all as agreed';
    case 'inspection_canceled':
      return `Canceled the ${inspectionKind(a.kind)}`;
    case 'repair_requested':
      return Number(a.number) > 1 ? 'Sent a new repair request' : 'Sent the repair request';
    case 'repair_received':
      return Number(a.number) > 1
        ? 'The buyers sent a new repair request'
        : 'The buyers’ repair request came in';
    case 'repair_answered':
      return a.outcome === 'agreed'
        ? 'The seller agreed to the repairs'
        : a.outcome === 'countered'
          ? 'The seller countered the repair request'
          : 'The seller refused the repair request';
    // Offers.
    case 'offer_made':
      return `Made an offer of ${str(a.price)} on ${str(a.address)}`;
    case 'offer_countered':
      if (a.listing)
        return a.side === 'them'
          ? `The buyers came back at ${str(a.price)} on offer ${str(a.number)}`
          : `Countered offer ${str(a.number)} at ${str(a.price)}`;
      return a.side === 'them'
        ? `The seller countered at ${str(a.price)} on ${str(a.address)}`
        : `Countered at ${str(a.price)} on ${str(a.address)}`;
    case 'offer_answered':
      return a.outcome === 'accepted'
        ? `The offer on ${str(a.address)} was accepted at ${str(a.price)}`
        : a.outcome === 'declined'
          ? `The offer on ${str(a.address)} was declined`
          : a.outcome === 'expired'
            ? `The offer on ${str(a.address)} passed with no answer`
            : a.listing
              ? `The buyers withdrew their offer on ${str(a.address)}`
              : `Withdrew the offer on ${str(a.address)}`;
    case 'offer_shared':
      return `Shared the offer on ${str(a.address)} with the client`;
    // Offers on a listing.
    case 'offer_received':
      return a.buyers
        ? `Offer ${str(a.number)} came in from ${str(a.buyers)} at ${str(a.price)}`
        : `Offer ${str(a.number)} came in at ${str(a.price)}`;
    case 'net_sheet':
      return `Saved the figures for the seller’s estimate (version ${str(a.version)})`;
    case 'offers_shared':
      return Number(a.count) === 1
        ? 'Shared the offer with the seller, with their estimate'
        : `Shared ${Number(a.count)} offers side by side with the seller, with their estimates`;
    case 'seller_chose':
      return `${str(a.name)} said ${SELLER_CHOICE_SAID[str(a.choice) as SellerChoice] ?? str(a.choice)} on offer ${str(a.number)}${a.buyers ? ` from ${str(a.buyers)}` : ''}`;
    // The CMA.
    case 'cma_started':
      return `Started CMA ${str(a.number)} for ${str(a.address)}`;
    case 'cma_finalized':
      return `Finalized CMA ${str(a.number)}: ${str(a.range)}`;
    case 'cma_reopened':
      return `Reopened CMA ${str(a.number)}`;
    case 'cma_shared':
      return `Shared CMA ${str(a.number)} with the client: ${str(a.range)}`;
    // Tours.
    case 'tour_planned':
      return Number(a.homes) > 1
        ? `Planned a tour of ${Number(a.homes)} homes for ${str(a.when)}`
        : `Planned a tour of ${str(a.first) || 'a home'} for ${str(a.when)}`;
    case 'tour_exception':
      return `Let the tour on ${str(a.when)} go ahead without a current buyer agreement`;
    case 'tour_stops':
      return `Changed the homes on the tour for ${str(a.when)}`;
    case 'tour_moved':
      return a.by
        ? `The tour moved from ${str(b.when)} to ${str(a.when)}, by ${str(a.by)}`
        : `Moved the tour from ${str(b.when)} to ${str(a.when)}`;
    case 'tour_canceled':
      return a.by
        ? `The tour for ${str(a.when)} was canceled, by ${str(a.by)}`
        : `Canceled the tour for ${str(a.when)}`;
    case 'tour_visited':
      return a.status === 'skipped'
        ? `Skipped ${str(a.address)} on the tour`
        : `Saw ${str(a.address)} on the tour`;
    case 'tour_feedback':
      return `${str(a.name)} on ${str(a.address)}: ${TOUR_INTEREST[str(a.interest) as TourInterest] ?? str(a.interest)}`;
    case 'team':
      if (a.added)
        return `Added someone to the deal as ${DEAL_ROLE_LABELS[str(a.role) as DealRole]?.toLowerCase() ?? 'a teammate'}`;
      if (a.removed) return 'Took someone off the deal';
      return `Changed someone’s part to ${DEAL_ROLE_LABELS[str(a.role) as DealRole]?.toLowerCase() ?? str(a.role)}`;
    case 'property':
      return b.propertyId ? 'Changed the property' : 'Set the property';
    case 'linked':
      return 'Linked it to another deal';
    case 'unlinked':
      return 'Unlinked it from another deal';
    case 'party_added':
      return `Added a ${PARTY_ROLES[str(a.role) as PartyRole]?.label.toLowerCase() ?? 'contact'}`;
    case 'party_removed':
      return `Took off a ${PARTY_ROLES[str(b.role) as PartyRole]?.label.toLowerCase() ?? 'contact'}`;
    case 'commission':
      return 'Changed the commission';
    case 'final_commission':
      return `Set the final commission: ${typeof a.cents === 'number' ? money(a.cents) : ''}`;
    case 'archived':
      return 'Archived the deal';
    case 'restored':
      return 'Restored the deal';
    case 'term_entered':
      return `${a.confirmed ? 'Entered and confirmed' : 'Entered'} ${termName(a.key)}: ${str(a.value)}${a.conflict ? ' (it disagrees with another value)' : ''}`;
    case 'term_confirmed':
      return `Confirmed ${termName(a.key)}: ${str(a.value)}`;
    case 'term_rejected':
      return `Set aside ${termName(b.key)}: ${str(b.value)}`;
    case 'conflict_resolved':
      return `Settled ${termName(a.key)}: ${str(a.value)} counts`;
    case 'document_added':
      return `Added ${(DOCUMENT_KINDS as Readonly<Record<string, string>>)[str(a.kind)] ?? 'a document'}${typeof a.version === 'number' && a.version > 1 ? ` (version ${a.version})` : ''}`;
    case 'document_signed':
      return 'Marked a document signed; it’s kept for good';
    case 'document_controlling':
      return 'Marked a document as the one that counts';
    case 'document_voided':
      return 'Voided a document';
    case 'duty_added':
      return `Added a duty: ${str(a.title)}`;
    case 'wire_change':
      return 'Reported changed wiring instructions';
    case 'template_applied':
      return `Moved it to version ${String(a.version ?? '')} of the duty list`;
    case 'fair_housing_confirmed':
      return a.cmaId
        ? 'Kept flagged words in a CMA’s summary, with a reason'
        : 'Kept flagged words in a client update, with a reason';
    case 'client_update_sent':
      return 'Sent a client update';
    case 'health':
      return 'Its health changed';
    // Round four: contracts read, and what was confirmed from them.
    case 'contract_read':
      return a.failed
        ? `Couldn’t read “${str(a.title)}”`
        : `Read “${str(a.title)}”${a.scan ? ' from its scanned pages' : ''}: ${str(a.found)} to confirm`;
    case 'contract_confirmed':
      return `Confirmed values read from “${str(a.title)}”`;
    case 'contract_value_rejected':
      return 'Set aside a value read from a contract';
    case 'contingency_added':
      return `Started tracking the ${contingencyWords(a)} contingency${a.source === 'offer' ? ', from the accepted offer' : a.source === 'contract' ? ', from the contract' : ''}`;
    case 'contingency_resolved':
      return `Recorded the ${contingencyWords(a)} contingency as ${str(a.state)}${a.withoutForm ? ', without the signed form' : ''}`;
    default:
      return what.replace(/_/g, ' ');
  }
}

/** One line of a duty's history: "Created", "Marked Waiting on someone", "Moved the due date". */
export function dutyLogWords(what: string, _before: Bag, after: Bag): string {
  const a = after ?? {};
  switch (what) {
    case 'created':
      return 'Created';
    case 'activated':
      return 'Started, once its dates were confirmed';
    case 'status':
      return `Marked ${DUTY_STATUS_LABELS[str(a.status) as DutyStatus]?.toLowerCase() ?? str(a.status)}`;
    case 'evidence_added':
      return 'Added proof';
    case 'evidence_withdrawn':
      return 'Took back proof';
    case 'reassigned':
      return 'Handed over';
    case 'acknowledged':
      return 'Acknowledged';
    case 'completed':
      return 'Marked done';
    case 'completed_with_exception':
      return 'Marked done without its proof';
    case 'waived':
      return 'Waived';
    case 'cancelled':
      return 'Cancelled';
    case 'reopened':
      return 'Reopened';
    case 'due_set':
      return a.date ? 'Moved the due date' : 'Put the due date back to its rule';
    case 'due_changed':
      return 'Due date changed with the deal’s dates';
    case 'redefined':
      return 'Changed by a newer duty list';
    // Round four.
    case 'waits_on_added':
      return `Said it waits on “${str(a.title)}”`;
    case 'waits_on_removed':
      return 'Took back what it waits on';
    case 'chased':
      return a.waitingOn ? `Chased ${str(a.waitingOn)}` : 'Chased whoever it waits on';
    case 'escalated':
      return 'Went to the business’s alert people: nobody acknowledged it within a business day';
    default:
      return what.replace(/_/g, ' ');
  }
}
