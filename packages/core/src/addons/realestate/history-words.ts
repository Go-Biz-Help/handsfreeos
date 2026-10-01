/**
 * A deal's history and a duty's, in words (HANDSFREEOS_REAL_ESTATE_IMPLEMENTATION_PLAN.md, "Screens"): each line the
 * add-on keeps names what changed as a code with its before and after; these say it as a sentence, without who did
 * it (the screen adds that). Browser-safe and pure: the web, the phone and the Assistant say the same thing.
 */
import { DOCUMENT_KINDS } from './catalog/types';
import { HOME_STATUSES, type HomeStatus } from './homes';
import { KEY_DATES } from './dates/key-dates';
import { STAGE_LABELS, DUTY_STATUS_LABELS, type DealStage, type DutyStatus } from './states';
import { DEAL_ROLE_LABELS, EVENT_WORDS, PARTY_ROLES, type DealRole, type PartyRole } from './words';
import { MONEY_TERMS, TEXT_TERMS } from './terms';
import { money } from '../../money/format';

type Bag = Readonly<Record<string, unknown>> | null | undefined;

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
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
const eventWords = (v: unknown) =>
  (Array.isArray(v) ? v : [])
    .map((e) => (EVENT_WORDS as Readonly<Record<string, string>>)[str(e)])
    .filter(Boolean)
    .join(', ');

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
    case 'home_facts':
      return `Confirmed the facts for ${str(a.address)}`;
    case 'memory_confirmed':
      return `Remembered: ${str(a.words)}`;
    case 'memory_retired':
      return `No longer true: ${str(a.words)}`;
    case 'home_status':
      return `${str(a.address)}: ${homeStatus(b.status)} to ${homeStatus(a.status)}`;
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
      return 'Kept flagged words in a client update, with a reason';
    case 'client_update_sent':
      return 'Sent a client update';
    case 'health':
      return 'Its health changed';
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
    default:
      return what.replace(/_/g, ' ');
  }
}
