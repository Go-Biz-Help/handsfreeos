import { money } from '@hfos/core';
import { FINANCING_STEPS, INSPECTION_KINDS } from '@hfos/core/addons/realestate/closing';
import { CLIENT_TASK_PRESETS } from '@hfos/core/addons/realestate/client-words';
import {
  CONTINGENCY_KINDS,
  type ContingencyKind,
} from '@hfos/core/addons/realestate/contingencies';
import { DOCUMENT_KINDS, type DocumentKind } from '@hfos/core/addons/realestate/catalog/types';
import { HOME_STATUSES } from '@hfos/core/addons/realestate/homes';
import { STAGE_LABELS } from '@hfos/core/addons/realestate/states';

import type { ChangeIcon } from './describe';
import type { SqlRunner } from './outbox';

/**
 * Words for Real Estate's changes made on the phone (round six, board 79's last panel): "Marked done: get the insurance
 * binder to the lender", "Note on “Attend inspection”", "Inspection contingency resolved", each about its deal, so
 * Changes on this phone groups them under it ("3 changes for Smith purchase"). Every Real Estate command the phone may
 * send says what it did in a few words from its input, and names what it points at from the phone's copy: the deal's
 * record, and the duty, contingency, finding, home, showing or other row it points at (a tour stop's home too).
 */

export interface RealestateNames {
  /** A deal's name. */
  deal(id: string | null): string | null;
  /** One of Real Estate's rows on a deal (`duties`, `contingencies`, `drafts`…): its deal and its columns. */
  row(
    source: string,
    id: string | null,
  ): { readonly dealId: string | null; readonly data: Readonly<Record<string, unknown>> } | null;
}

export const NO_REALESTATE_NAMES: RealestateNames = { deal: () => null, row: () => null };

type Input = Readonly<Record<string, unknown>>;
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const lower = (s: string) => (/^[A-Z][a-z]/.test(s) ? s[0]!.toLowerCase() + s.slice(1) : s);
const quoted = (s: string | null, otherwise: string) => (s ? `“${s}”` : otherwise);

/** The phone's rows a change's input points at, by the input's key (`addon_phone_rows` sources). */
const POINTS = {
  dutyId: 'duties',
  contingencyId: 'contingencies',
  draftId: 'drafts',
  inspectionId: 'inspections',
  findingId: 'inspection_findings',
  homeId: 'homes',
  matchId: 'feed_matches',
  offerId: 'offers',
  openHouseId: 'open_houses',
  showingId: 'showings',
  suggestionId: 'listing_suggestions',
  stopId: 'tour_stops',
  tourId: 'tours',
  taskId: 'client_tasks',
  cmaId: 'cmas',
  readId: 'contract_reads',
  pickId: 'duty_vendors',
  walkthroughId: 'walkthroughs',
  itemId: 'walkthrough_items',
  vendorId: 'vendors',
} as const;

/** What a row points at in turn: a tour stop's or a match's home, a vendor pick's duty. */
const THEN = { home_id: 'homes', duty_id: 'duties' } as const;

export interface RealestateWords {
  readonly title: string;
  readonly part: string;
  readonly icon: ChangeIcon;
  /** The deal it's about. */
  readonly deal: { readonly id: string; readonly name: string } | null;
  readonly heldUntil: string;
}

/** "Seen: 418 Maple Ave" and the like: what a tour stop's visit did. */
const VISIT_WORDS = { visited: 'Seen', skipped: 'Skipped' } as const;
const DUTY_STATUS_WORDS: Readonly<Record<string, string>> = {
  not_started: 'Not started',
  in_progress: 'Started',
  waiting_external: 'Waiting',
  blocked: 'Blocked',
};
const ITEM_STATE_WORDS: Readonly<Record<string, string>> = {
  ok: 'OK',
  not_ok: 'Not OK',
  unsure: 'Not sure',
  unchecked: 'Unchecked',
};
const SHOWING_DECISION_WORDS: Readonly<Record<string, string>> = {
  confirm: 'Showing confirmed',
  decline: 'Showing declined',
  cancel: 'Showing cancelled',
};

/** The words for one of Real Estate's changes, or null for a change that isn't one. */
export function describeRealestate(
  name: string,
  input: Input,
  names: RealestateNames,
): RealestateWords | null {
  if (!name.startsWith('realestate.')) return null;
  const at = (key: keyof typeof POINTS) => names.row(POINTS[key], str(input[key]));
  const duty = at('dutyId');
  const contingency = at('contingencyId');
  // The deal: the input's, or the one of the row it points at.
  const pointed = (Object.keys(POINTS) as (keyof typeof POINTS)[]).map(at);
  const dealId = str(input.dealId) ?? pointed.find((r) => r?.dealId)?.dealId ?? null;
  const dealName = names.deal(dealId);
  const deal = dealId && dealName ? { id: dealId, name: dealName } : null;
  const title = str(duty?.data.title);
  const words = (
    t: string,
    part: string,
    icon: RealestateWords['icon'],
    heldUntil = `${lower(t)} goes through`,
  ): RealestateWords => ({ title: t, part, icon, deal, heldUntil });
  const onDeal = deal?.name ?? 'a deal';
  /** A home's address: the one the input names, a tour stop's or a match's. */
  const homeOf = (row: ReturnType<RealestateNames['row']>) =>
    str(row?.data.address) ?? str(names.row('homes', str(row?.data.home_id))?.data.address);
  const home = homeOf(at('homeId')) ?? homeOf(at('stopId'));
  const finding = at('findingId');
  const step = str(input.step) as keyof typeof FINANCING_STEPS | null;
  const stepLabel = (step && FINANCING_STEPS[step]?.label) ?? 'A loan step';
  const kindOf = (k: unknown) => {
    const kind = str(k) as keyof typeof INSPECTION_KINDS | null;
    return (kind && INSPECTION_KINDS[kind]) ?? 'Inspection';
  };
  const contingencyLabel = (row: Input | undefined) => {
    const kind = str(row?.kind) as ContingencyKind | null;
    return kind === 'other'
      ? str(row?.label)
      : kind
        ? (CONTINGENCY_KINDS[kind]?.label ?? null)
        : null;
  };

  switch (name) {
    // ---------- duties ----------
    case 'realestate.duty.complete':
      return words(
        `Marked done: ${title ? lower(title) : 'a duty'}`,
        'marked done',
        'task',
        `${quoted(title, 'the duty')} is marked done`,
      );
    case 'realestate.duty.complete_with_exception':
      return words(
        `Marked done without its proof: ${title ? lower(title) : 'a duty'}`,
        'marked done without its proof',
        'task',
      );
    case 'realestate.duty.add_evidence': {
      const kind = str(input.kind);
      const on = quoted(title, 'a duty');
      return kind === 'note'
        ? words(`Note on ${on}`, 'a note', 'note')
        : kind === 'attestation'
          ? words(`Your word on ${on}`, 'your word', 'note')
          : words(`Proof on ${on}`, 'proof added', 'note');
    }
    case 'realestate.duty.withdraw_evidence':
      return words(`Proof taken off ${quoted(title, 'a duty')}`, 'proof taken off', 'note');
    case 'realestate.duty.acknowledge':
      return words(`Acknowledged ${quoted(title, 'a duty')}`, 'acknowledged', 'task');
    case 'realestate.duty.set_status': {
      const status = DUTY_STATUS_WORDS[str(input.status) ?? ''];
      return status
        ? words(`${status}: ${title ? lower(title) : 'a duty'}`, lower(status), 'task')
        : words(`${quoted(title, 'A duty')} updated`, 'a duty updated', 'task');
    }
    case 'realestate.duty.pick_vendor':
      return words(`Vendor picked for ${quoted(title, 'a duty')}`, 'a vendor picked', 'item');
    case 'realestate.duty.vendor_quote': {
      const forDuty = str(names.row('duties', str(at('pickId')?.data.duty_id))?.data.title);
      const cents = num(input.cents);
      return words(
        `${cents === null ? 'A quote' : `Quote of ${money(cents)}`} for ${quoted(forDuty, 'a duty')}`,
        'a vendor’s quote',
        'money',
      );
    }

    // ---------- dates, contingencies and the contract ----------
    case 'realestate.contingency.add': {
      const label = contingencyLabel(input);
      return words(
        `${label ?? 'A'} contingency added`,
        'a contingency added',
        'task',
        `the ${label ? `${lower(label)} ` : ''}contingency is added`,
      );
    }
    case 'realestate.contingency.resolve': {
      const label = contingencyLabel(contingency?.data);
      const how = str(input.how);
      return words(
        `${label ?? 'A'} contingency ${how === 'waived' || how === 'expired' ? how : 'resolved'}`,
        'a contingency resolved',
        'task',
      );
    }
    case 'realestate.contract.confirm':
      return words('Contract’s values confirmed', 'contract values confirmed', 'task');
    case 'realestate.deal.move_stage': {
      const stage = STAGE_LABELS[str(input.stage) as keyof typeof STAGE_LABELS];
      return words(
        stage ? `Moved to ${stage}` : 'Moved to another stage',
        stage ? `moved to ${stage}` : 'moved',
        'lead',
      );
    }
    case 'realestate.deal.export':
      return words(`Export of ${onDeal}`, 'an export', 'item');

    // ---------- documents, notes and the client ----------
    case 'realestate.document.add': {
      const kind = str(input.kind) as DocumentKind | null;
      const doc = str(input.title) ?? (kind ? DOCUMENT_KINDS[kind] : null) ?? 'a document';
      return words(`Document: ${doc}`, 'a document', 'item', `${doc} is added`);
    }
    case 'realestate.field_note.add': {
      const spoken = !!str(input.audioFileId);
      const typed = !!str(input.body);
      const what = typed ? 'Note' : spoken ? 'Voice note' : 'Photos';
      return words(`${what} on ${onDeal}`, typed || spoken ? `a ${lower(what)}` : 'photos', 'note');
    }
    case 'realestate.memory.add':
      return words(
        `Remembered: ${str(input.words) ?? 'something the client said'}`,
        'something remembered',
        'note',
      );
    case 'realestate.buyer_profile.save':
      return words('What the buyer wants', 'what the buyer wants', 'person');
    case 'realestate.client_task.add': {
      const preset = str(input.preset) as keyof typeof CLIENT_TASK_PRESETS | null;
      const task = str(input.title) ?? (preset ? CLIENT_TASK_PRESETS[preset]?.title : null);
      return words(
        `For the client: ${task ?? 'a task'}`,
        'a task for the client',
        'task',
        task ? `the client’s task “${task}” is saved` : 'the client’s task is saved',
      );
    }
    case 'realestate.client_task.mark_done':
      return words(
        `Client’s task done: ${str(at('taskId')?.data.title) ?? 'a task'}`,
        'a client’s task done',
        'task',
      );
    case 'realestate.status_email.request':
      return words(
        `Client update asked for${deal ? ` on ${deal.name}` : ''}`,
        'a client update',
        'email',
      );
    case 'realestate.status_email.save':
      return words('Client update changed', 'a client update changed', 'email');
    case 'realestate.status_email.send':
      // Not "email": "Still send?" would name the deal as who it's to.
      return words(
        `Client update for ${deal?.name ?? 'a client'}`,
        'a client update',
        'inbox',
        'the client update goes',
      );

    // ---------- financing and inspections ----------
    case 'realestate.financing.mark_done':
      return words(`${stepLabel} done`, `${lower(stepLabel)} done`, 'money');
    case 'realestate.financing.reopen_step':
      return words(`${stepLabel} reopened`, `${lower(stepLabel)} reopened`, 'money');
    case 'realestate.financing.update_step':
      return words(`${stepLabel} updated`, `${lower(stepLabel)} updated`, 'money');
    case 'realestate.inspection.add':
      return words(
        `Inspection added: ${kindOf(input.kind)}`,
        'an inspection added',
        'calendar',
        `the ${lower(kindOf(input.kind))} is added`,
      );
    case 'realestate.inspection.update':
      return words(
        `Inspection changed: ${kindOf(at('inspectionId')?.data.kind)}`,
        'an inspection changed',
        'calendar',
      );
    case 'realestate.finding.add': {
      const what = str(input.title);
      return words(
        `Finding: ${what ?? 'something the inspection found'}`,
        'a finding',
        'item',
        what ? `the finding “${what}” is saved` : 'the finding is saved',
      );
    }
    case 'realestate.finding.update':
      return words(
        `Finding changed: ${str(finding?.data.title) ?? str(input.title) ?? 'a finding'}`,
        'a finding changed',
        'item',
      );
    case 'realestate.finding.remove':
      return words(
        `Finding taken off: ${str(finding?.data.title) ?? 'a finding'}`,
        'a finding taken off',
        'item',
      );
    case 'realestate.repair.send':
      return words('Repair request sent', 'a repair request', 'email');

    // ---------- homes, tours and offers ----------
    case 'realestate.home.add': {
      const address = str(input.address) ?? 'A home';
      return words(`Home added: ${address}`, 'a home added', 'item', `${address} is added`);
    }
    case 'realestate.home.lookup':
      return words(`MLS look-up: ${home ?? 'a home'}`, 'an MLS look-up', 'item');
    case 'realestate.home.set_status': {
      const status = HOME_STATUSES[str(input.status) as keyof typeof HOME_STATUSES];
      return words(
        `${status ?? 'Changed'}: ${home ?? 'a home'}`,
        status ? lower(status) : 'a home changed',
        'item',
      );
    }
    case 'realestate.match.send':
    case 'realestate.match.dismiss': {
      const mls = str(at('matchId')?.data.mls_number);
      const which = mls ? `MLS #${mls}` : 'A match';
      return name === 'realestate.match.send'
        ? words(`${which} sent to the client`, 'a match sent', 'inbox')
        : words(`${which} set aside`, 'a match set aside', 'item');
    }
    case 'realestate.suggestion.add':
    case 'realestate.suggestion.not_a_fit': {
      const address = str(at('suggestionId')?.data.address) ?? 'a listing';
      return name === 'realestate.suggestion.add'
        ? words(`Added to the buyer’s homes: ${address}`, 'a listing added', 'item')
        : words(`Not a fit: ${address}`, 'a listing set aside', 'item');
    }
    case 'realestate.tour.plan': {
      const n = Array.isArray(input.homeIds) ? input.homeIds.length : 0;
      return words(
        n ? `Tour of ${n === 1 ? '1 home' : `${n} homes`} planned` : 'Tour planned',
        'a tour planned',
        'calendar',
      );
    }
    case 'realestate.tour.set_stops':
      return words('Tour’s homes changed', 'a tour’s homes changed', 'calendar');
    case 'realestate.tour.record_visit': {
      const visit = VISIT_WORDS[str(input.status) as keyof typeof VISIT_WORDS] ?? 'Visit';
      return words(`${visit}: ${home ?? 'a home on the tour'}`, lower(visit), 'calendar');
    }
    case 'realestate.tour.feedback':
      return words(
        `What the client thought of ${home ?? 'a home'}`,
        'the client’s feedback',
        'note',
      );
    case 'realestate.cma.find_comps':
    case 'realestate.cma.request_summary': {
      const subject = str(at('cmaId')?.data.subject_address);
      return name === 'realestate.cma.find_comps'
        ? words(`Comps for ${subject ?? 'a CMA'}`, 'comps asked for', 'item')
        : words(`CMA summary${subject ? ` for ${subject}` : ''}`, 'a CMA summary', 'item');
    }
    case 'realestate.offer.add_version':
    case 'realestate.offer.share_summary': {
      const n = num(at('offerId')?.data.number);
      const offer = n ? `offer ${n}` : 'an offer';
      return name === 'realestate.offer.add_version'
        ? words(
            str(input.side) === 'them' ? `Their answer on ${offer}` : `Your terms on ${offer}`,
            'an offer’s new terms',
            'money',
          )
        : words(`Summary of ${offer} shared`, 'an offer’s summary shared', 'money');
    }

    // ---------- the listing ----------
    case 'realestate.listing.photo_add': {
      const caption = str(input.caption);
      return words(
        caption ? `Listing photo: ${caption}` : 'Listing photo',
        'a listing photo',
        'photo',
      );
    }
    case 'realestate.listing.photos_arrange':
      return words('Listing photos arranged', 'listing photos arranged', 'photo');
    case 'realestate.listing.confirm_facts':
      return words('Listing facts confirmed', 'listing facts confirmed', 'task');
    case 'realestate.listing.lookup':
      return words('MLS look-up for the listing', 'an MLS look-up', 'item');
    case 'realestate.listing.mark_live': {
      const mls = str(input.mlsNumber);
      return words(`Live on the MLS${mls ? ` · #${mls}` : ''}`, 'live on the MLS', 'task');
    }
    case 'realestate.listing.description.request':
      return words('Listing description asked for', 'a listing description', 'item');
    case 'realestate.listing.posts_request':
      return words('Listing posts asked for', 'listing posts', 'item');
    case 'realestate.listing.price.propose': {
      const cents = num(input.priceCents);
      return words(
        cents === null ? 'New price for the seller' : `New price for the seller: ${money(cents)}`,
        'a new price',
        'money',
      );
    }
    case 'realestate.net_sheet.save':
      return words('Net sheet saved', 'a net sheet', 'money');
    case 'realestate.open_house.plan':
      return words('Open house planned', 'an open house planned', 'calendar');
    case 'realestate.open_house.sign_in': {
      const visitor =
        [str(input.firstName), str(input.lastName)].filter(Boolean).join(' ') || 'A visitor';
      return words(
        `${visitor} signed in`,
        'a visitor signed in',
        'newPerson',
        `${visitor === 'A visitor' ? 'the visitor' : visitor}’s sign-in goes through`,
      );
    }
    case 'realestate.showing.add': {
      const agent = str(input.agentName);
      return words(agent ? `Showing for ${agent}` : 'Showing added', 'a showing added', 'calendar');
    }
    case 'realestate.showing.decide': {
      const agent = str(at('showingId')?.data.agent_name);
      const decided = SHOWING_DECISION_WORDS[str(input.decision) ?? ''] ?? 'Showing answered';
      return words(`${decided}${agent ? `: ${agent}` : ''}`, lower(decided), 'calendar');
    }
    case 'realestate.showing.feedback': {
      const agent = str(at('showingId')?.data.agent_name);
      return words(`Feedback from ${agent ?? 'a showing'}`, 'showing feedback', 'note');
    }

    // ---------- vendors ----------
    case 'realestate.vendor.save': {
      const vendor = str(input.name);
      return str(input.vendorId)
        ? words(`Vendor changed${vendor ? ` · ${vendor}` : ''}`, 'a vendor changed', 'item')
        : words(`New vendor · ${vendor ?? 'a vendor'}`, 'a vendor', 'item');
    }
    case 'realestate.vendor.approve':
      return input.approved === false
        ? words('Vendor no longer approved', 'a vendor’s approval taken back', 'item')
        : words('Vendor approved', 'a vendor approved', 'item');

    // ---------- the walkthrough ----------
    case 'realestate.walkthrough.plan':
      return words('Walkthrough planned', 'a walkthrough planned', 'calendar');
    case 'realestate.walkthrough.start':
      return words('Walkthrough started', 'the walkthrough started', 'task');
    case 'realestate.walkthrough.add_item': {
      const item = str(input.title) ?? 'something to check';
      return words(`Added to the walkthrough: ${item}`, 'a walkthrough item', 'task');
    }
    case 'realestate.walkthrough.check_item': {
      const state = ITEM_STATE_WORDS[str(input.state) ?? ''] ?? 'Checked';
      const item = str(at('itemId')?.data.title) ?? 'a walkthrough item';
      return words(`${state}: ${item}`, `checked ${lower(state)}`, 'task');
    }
    case 'realestate.walkthrough.finish':
      return words('Walkthrough finished', 'the walkthrough finished', 'task');

    default:
      return words(
        deal ? `A change to ${deal.name}` : 'A change in Real Estate',
        'a change',
        'change',
      );
  }
}

/** Looks up the deals and rows Real Estate's changes point at, from the phone's copy. */
export async function loadRealestateNames(
  runner: SqlRunner,
  inputs: readonly Input[],
): Promise<RealestateNames> {
  const rowIds = new Set<string>();
  const dealIds = new Set<string>();
  for (const input of inputs) {
    for (const [key, source] of Object.entries(POINTS)) {
      const id = str(input[key]);
      if (id) rowIds.add(`${source}:${id}`);
    }
    const deal =
      str(input.dealId) ?? (input.recordType === 'custom_record' ? str(input.recordId) : null);
    if (deal) dealIds.add(deal);
  }
  if (rowIds.size === 0 && dealIds.size === 0) return NO_REALESTATE_NAMES;
  const select = <T>(sql: string, set: Set<string>): Promise<T[]> =>
    set.size === 0
      ? Promise.resolve([])
      : runner.getAll<T>(sql.replace('(?)', `(${[...set].map(() => '?').join(', ')})`), [...set]);
  type Row = { id: string; record_id: string | null; data: string | null };
  const byRow = new Map<string, { dealId: string | null; data: Record<string, unknown> }>();
  const keep = (rows: readonly Row[]) => {
    for (const r of rows) {
      let data: Record<string, unknown> = {};
      try {
        const parsed: unknown = JSON.parse(r.data ?? '{}');
        if (parsed && typeof parsed === 'object') data = parsed as Record<string, unknown>;
      } catch {
        data = {};
      }
      byRow.set(r.id, { dealId: r.record_id, data });
      if (r.record_id) dealIds.add(r.record_id);
    }
  };
  const ROWS = 'SELECT id, record_id, data FROM addon_phone_rows WHERE id IN (?)';
  keep(await select<Row>(ROWS, rowIds));
  // What those rows point at in turn: a tour stop's home, a vendor pick's duty.
  const then = new Set<string>();
  for (const { data } of byRow.values())
    for (const [column, source] of Object.entries(THEN)) {
      const id = str(data[column]);
      if (id && !byRow.has(`${source}:${id}`)) then.add(`${source}:${id}`);
    }
  keep(await select<Row>(ROWS, then));
  const deals = await select<{ id: string; name: string | null }>(
    'SELECT id, name FROM custom_records WHERE id IN (?)',
    dealIds,
  );
  const byDeal = new Map(deals.map((d) => [d.id, d.name]));
  return {
    deal: (id) => (id ? (byDeal.get(id) ?? null) : null),
    row: (source, id) => (id ? (byRow.get(`${source}:${id}`) ?? null) : null),
  };
}
