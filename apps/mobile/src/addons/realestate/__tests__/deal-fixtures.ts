import type { DealListItem } from '@hfos/core/addons/realestate/views/deal-list';
import type { DealPage, DealRisksView } from '@hfos/core/addons/realestate/views/deal-page';
import type { DutyListItem } from '@hfos/core/addons/realestate/views/duty-list';
import type { DutySheet, ProofChecklist } from '@hfos/core/addons/realestate/views/duty-sheet';

/**
 * Boards 76–81's deals as core's views give them: the Smith purchase (Dana's, at risk, closing Oct 14), the Alvarez
 * listing, and the Okafor purchase, Jordan Lee's, which an owner's phone keeps as its summary. At 10:42 AM in Austin on
 * Saturday, October 3, 2026.
 */

export const WS = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const DANA = '22222222-2222-4222-8222-222222222222';
export const JORDAN = '44444444-4444-4444-8444-444444444444';
export const ANN = '11111111-1111-4111-8111-111111111111';
export const SMITH = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
export const ALVAREZ = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
export const OKAFOR = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
export const TZ = 'America/Chicago';
export const NOW = Date.parse('2026-10-03T15:42:00.000Z');
export const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

export function dealItem(over: Partial<DealListItem> = {}): DealListItem {
  return {
    dealId: SMITH,
    name: 'Smith purchase',
    side: 'buyer',
    stage: 'inspection',
    stageLabel: 'Inspections',
    outcome: null,
    archived: false,
    health: 'red',
    mainAgent: { userId: DANA, name: 'Dana Reyes' },
    client: { personId: ANN, name: 'Ann Smith' },
    property: { propertyId: id(90), address: '123 Main St' },
    openDuties: 18,
    overdueDuties: 1,
    nextDue: { dutyId: id(1), title: 'Insurance binder', dueAt: '2026-10-04T04:59:00.000Z' },
    closing: '2026-10-14',
    headline: 'Rate lock ends Oct 13, a day before closing',
    mine: true,
    datesToConfirm: 0,
    updatedAt: '2026-10-03T14:00:00.000Z',
    waiting: null,
    ...over,
  };
}

export function risks(dealId = SMITH, reds = 3): DealRisksView {
  return {
    dealId,
    name: 'Smith purchase',
    health: reds ? 'red' : 'green',
    reasons: [
      {
        code: 'date_problem',
        level: 'red',
        words: 'Rate lock ends Oct 13, a day before closing',
        next: 'ask about an extension',
        keys: ['rate_lock_end', 'closing'],
        accountable: null,
      },
      {
        code: 'material_not_moving',
        level: 'red',
        words: 'Insurance binder not received',
        next: 'Start it now.',
        dutyId: id(1),
        dueAt: '2026-10-04T04:59:00.000Z',
        accountable: { userId: DANA, name: 'Dana' },
      },
      {
        code: 'contingency_ending',
        level: 'red',
        words: 'Inspection period ends Oct 3; the repair request isn’t drafted',
        next: 'Draft the repair request.',
        accountable: { userId: DANA, name: 'Dana' },
      },
    ].slice(0, reds) as DealRisksView['reasons'],
  };
}

export function duty(over: Partial<DutyListItem> = {}): DutyListItem {
  return {
    dutyId: id(1),
    dealId: SMITH,
    dealName: 'Smith purchase',
    key: 'insurance_binder',
    title: 'Get the insurance binder to the lender',
    status: 'in_progress',
    overdue: false,
    materiality: 'critical',
    accountable: { userId: DANA, name: 'Dana' },
    dueAt: '2026-10-04T04:59:00.000Z',
    dueState: 'due',
    ...over,
  };
}

export function sheet(over: Partial<DutySheet['duty']> = {}, full = true): DutySheet {
  return {
    full,
    duty: {
      dutyId: id(1),
      dealId: SMITH,
      dealName: 'Smith purchase',
      key: 'insurance_binder',
      pass: 0,
      title: 'Get the insurance binder to the lender',
      behavior: 'deliverable',
      phase: 'contract',
      tracker: 'INSURANCE',
      status: 'waiting_external',
      overdue: false,
      materiality: 'critical',
      automation: 'manual',
      accountableRole: 'agent',
      accountable: { userId: DANA, name: 'Dana Reyes' },
      performers: ['client'],
      startedBy: 'stage:under_contract',
      startedAt: '2026-09-24T17:00:00.000Z',
      dueState: 'due',
      dueAt: '2026-10-04T04:59:00.000Z',
      dueDate: '2026-10-03',
      dueTime: '23:59',
      dueTrace: [],
      dueRule: '10 days after contract accepted',
      warnings: [],
      needsDates: [],
      dueSetByHand: null,
      blocker: null,
      waitingOn: 'Lone Oak Insurance',
      waitingSince: '2026-09-27T15:00:00.000Z',
      chaseAt: null,
      finishedAt: null,
      finishReason: null,
      exception: false,
      acknowledgedAt: null,
      ...over,
    },
    waitsOn: [],
    waitingOnThis: [],
    ifItSlips: { waiting: [], sameDate: [] },
    proof: {
      needs: 'an Insurance binder and your word that “Sent to Summit Lending”',
      missing: 'an Insurance binder and your word that “Sent to Summit Lending”',
      attestations: ['Sent to Summit Lending'],
    },
    evidence: [],
    log: [],
  } as DutySheet;
}

export function checklist(met: readonly boolean[] = [false, false], full = true): ProofChecklist {
  const items = [
    {
      item: { kind: 'document' as const, documents: ['insurance_binder' as const] },
      words: 'An Insurance binder',
      met: met[0] ?? false,
    },
    {
      item: { kind: 'attestation' as const, words: 'Sent to Summit Lending' },
      words: 'Your word that “Sent to Summit Lending”',
      met: met[1] ?? false,
    },
  ];
  return { mode: 'all', items, complete: items.every((i) => i.met), full };
}

export function page(over: Partial<DealPage['deal']> = {}, full = true): DealPage {
  return {
    full,
    deal: {
      dealId: SMITH,
      name: 'Smith purchase',
      notes: null,
      side: 'buyer',
      stage: 'inspections',
      stageLabel: 'Inspections',
      stageEnteredAt: '2026-09-30T15:00:00.000Z',
      outcome: null,
      outcomeAt: null,
      outcomeReason: null,
      archived: false,
      leadId: null,
      facts: [],
      health: 'red',
      healthReasons: [],
      catalogVersion: 1,
      templateSetId: null,
      createdAt: '2026-09-01T15:00:00.000Z',
      ...over,
    },
    team: [{ userId: DANA, name: 'Dana Reyes', role: 'agent', main: true }],
    property: { propertyId: id(90), address: '123 Main St' },
    parties: [
      {
        relationshipId: id(70),
        role: 'client',
        label: 'Client',
        personId: ANN,
        companyId: null,
        name: 'Ann Smith',
        note: null,
      },
      {
        relationshipId: id(71),
        role: 'lender',
        label: 'Lender',
        personId: null,
        companyId: id(72),
        name: 'Summit Lending',
        note: null,
      },
    ],
    terms: [
      {
        key: 'closing',
        label: 'Closing',
        kind: 'date',
        conflict: false,
        confirmed: true,
        entries: [
          {
            entryId: id(80),
            date: '2026-10-14',
            time: null,
            cents: null,
            text: null,
            source: 'amendment',
            sourceRef: null,
            enteredAt: '2026-09-29T15:00:00.000Z',
            confirmed: true,
          },
        ],
      },
      {
        key: 'inspection_end',
        label: 'Inspection period ends',
        kind: 'date',
        conflict: false,
        confirmed: true,
        entries: [
          {
            entryId: id(81),
            date: '2026-10-03',
            time: '17:00',
            cents: null,
            text: null,
            source: 'contract',
            sourceRef: '§7',
            enteredAt: '2026-09-24T15:00:00.000Z',
            confirmed: true,
          },
        ],
      },
      {
        key: 'acceptance',
        label: 'Contract accepted',
        kind: 'date',
        conflict: false,
        confirmed: true,
        entries: [
          {
            entryId: id(82),
            date: '2026-09-24',
            time: null,
            cents: null,
            text: null,
            source: 'contract',
            sourceRef: null,
            enteredAt: '2026-09-24T15:00:00.000Z',
            confirmed: true,
          },
        ],
      },
    ],
    duties: [
      {
        dutyId: id(2),
        key: 'repair_request',
        pass: 0,
        title: 'Draft the repair request',
        tracker: 'INSPECTION',
        status: 'not_started',
        overdue: false,
        materiality: 'material',
        automation: 'manual',
        accountableRole: 'agent',
        accountable: { userId: DANA, name: 'Dana' },
        startedBy: 'event:inspection_report',
        dueState: 'due',
        dueAt: '2026-10-03T04:59:00.000Z',
        dueDate: '2026-10-02',
        dueTime: '23:59',
        needsDates: [],
        warnings: [],
        proof: 'A Repair request',
        proofMissing: 'a Repair request',
        waitingOn: null,
        blocked: null,
      },
      {
        dutyId: id(3),
        key: 'emd',
        pass: 0,
        title: 'Earnest money receipt',
        tracker: 'ESCROW',
        status: 'completed',
        overdue: false,
        materiality: 'critical',
        automation: 'manual',
        accountableRole: 'agent',
        accountable: { userId: DANA, name: 'Dana' },
        startedBy: 'stage:under_contract',
        dueState: 'due',
        dueAt: '2026-09-27T04:59:00.000Z',
        dueDate: '2026-09-26',
        dueTime: '23:59',
        needsDates: [],
        warnings: [],
        proof: 'An Earnest money receipt',
        proofMissing: '',
        waitingOn: null,
        blocked: null,
      },
    ],
  } as DealPage;
}
