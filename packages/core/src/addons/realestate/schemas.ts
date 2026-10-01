/**
 * Real Estate Agent's operations, as the API, the screens and the Assistant see them: every input checked here and
 * every answer's shape. Browser-safe.
 */
import { z } from 'zod';
import { isoDateTime, uuid } from '../../schemas/common';
import {
  DEAL_FACTS,
  DOCUMENT_KINDS,
  MATERIALITIES,
  TRACKER_CODES,
  type DealEvent,
  type DealFact,
  type DocumentKind,
} from './catalog/types';
import { FAIR_HOUSING_CATEGORIES, type FairHousingCategory } from './fair-housing';
import { RUNGS } from './ladder';
import { OWN_PROOF } from './own-duties';
import { TERM_SOURCES } from './dates/key-dates';
import { DEAL_LINK_KINDS_LIST, PARTY_ROLES_LIST, TEAM_ROLES } from './words';
import { CMA_STATUS_KEYS, COMP_STATUS_KEYS } from './cma';
import { HOME_STATUS_KEYS, HOME_TYPE_KEYS } from './homes';
import { MEMORY_KIND_KEYS } from './memory';
import { DEAL_SIDES, DUTY_STATUSES } from './states';
import { TERM_KEYS } from './terms';
import { MAX_TOUR_STOPS, STOP_STATUS_KEYS, TOUR_INTEREST_KEYS, TOUR_STATUS_KEYS } from './tours';

const reason = z
  .string()
  .trim()
  .min(1, 'Say why, in a few words.')
  .max(500, 'Keep it under 500 characters.');
const optionalNote = z.string().trim().max(1000, 'Keep it under 1,000 characters.').optional();
const localDate = z.iso.date({ error: 'Enter a date like 2026-10-06.' });
const clock = z
  .string()
  .regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/, { error: 'Enter a time like 17:00.' });
const cents = z.number().int().min(0).max(100_000_000_000);
const bp = z.number().int().min(0).max(10_000);

export const DEAL_FACT_KEYS = Object.keys(DEAL_FACTS) as [DealFact, ...DealFact[]];
/** The moments a person records on a deal that aren't a stage move, a loss or a closing. */
export const RECORDED_EVENTS = [
  'offer_received',
  'inspection_report',
  'repair_request',
  'repairs_agreed',
  'low_appraisal',
  'amendment',
  'search_changed',
] as const satisfies readonly DealEvent[];

const inDeal = { workspaceId: uuid, dealId: uuid };

// ---------- deals ----------

export const DealOpenInput = z.object({
  workspaceId: uuid,
  side: z.enum(DEAL_SIDES),
  name: z.string().trim().min(1, 'Name the deal.').max(160, 'Keep it under 160 characters.'),
  /** Where it starts: its side's first stage unless said. Stages before it get their duties too. */
  stage: z.string().optional(),
  /** The client, one of the business's customers. */
  clientPersonId: uuid.optional(),
  /** The Pipeline lead it came from. */
  leadId: uuid.optional(),
  /** The home: one already here, or a new one by its address. */
  propertyId: uuid.optional(),
  newPropertyAddress: z.string().trim().min(1).max(160).optional(),
  facts: z.array(z.enum(DEAL_FACT_KEYS)).max(DEAL_FACT_KEYS.length).default([]),
  /** Its main agent, when not the person opening it (owners and admins only). */
  mainAgentUserId: uuid.optional(),
  notes: z.string().trim().max(10_000).optional(),
});
export const DealOpenOutput = z.object({
  dealId: uuid,
  propertyId: uuid.nullable(),
  dutiesCreated: z.number().int(),
});

export const DealMoveStageInput = z.object({ ...inDeal, stage: z.string(), note: optionalNote });
export const DealChangeOutput = z.object({
  dealId: uuid,
  stage: z.string(),
  dutiesCreated: z.number().int(),
  dutiesCancelled: z.number().int(),
});

export const DealRecordEventInput = z.object({
  ...inDeal,
  event: z.enum(RECORDED_EVENTS),
  note: optionalNote,
});

export const DealOfferLostInput = z.object({ ...inDeal, reason });
export const DealTerminateInput = z.object({ ...inDeal, reason });
export const DealCloseInput = z.object({
  ...inDeal,
  /** Also mark the Pipeline lead it came from won. */
  markLeadWon: z.boolean().default(false),
  note: optionalNote,
});
export const DealCloseOutput = DealChangeOutput.extend({ leadWon: z.boolean() });
export const DealEndInput = z.object({
  ...inDeal,
  /** A listing withdrawn, expired or cancelled; a buyer who stopped looking or went elsewhere. */
  how: z.enum(['withdrawn', 'expired', 'cancelled', 'lost']),
  reason,
});
export const DealReopenInput = z.object({ ...inDeal, reason });

export const DealSetFactsInput = z.object({
  ...inDeal,
  facts: z.array(z.enum(DEAL_FACT_KEYS)).max(DEAL_FACT_KEYS.length),
});
export const DealSetFactsOutput = z.object({
  dealId: uuid,
  facts: z.array(z.string()),
  dutiesCreated: z.number().int(),
  dutiesCancelled: z.number().int(),
});

// ---------- the team ----------

export const DealAddPersonInput = z.object({
  ...inDeal,
  userId: uuid,
  role: z.enum(TEAM_ROLES).default('co_agent'),
});
export const DealRemovePersonInput = z.object({ ...inDeal, userId: uuid });
export const DealSetRoleInput = z.object({
  ...inDeal,
  userId: uuid,
  /** `agent` makes them its main agent (owners and admins only); the one they replace stays on as co-agent. */
  role: z.enum(['agent', ...TEAM_ROLES]),
});
const TeamMember = z.object({
  userId: uuid,
  name: z.string(),
  role: z.string(),
  main: z.boolean(),
});
export const DealTeamOutput = z.object({
  dealId: uuid,
  team: z.array(TeamMember),
  changed: z.boolean(),
  dutiesHandedOver: z.number().int(),
});

// ---------- links, the property and outside parties ----------

export const DealLinkInput = z.object({
  ...inDeal,
  otherDealId: uuid,
  kind: z.enum(DEAL_LINK_KINDS_LIST),
});
export const DealUnlinkInput = DealLinkInput;
export const DealLinkOutput = z.object({ dealId: uuid, otherDealId: uuid, changed: z.boolean() });

export const DealSetPropertyInput = z
  .object({
    ...inDeal,
    propertyId: uuid.optional(),
    newPropertyAddress: z.string().trim().min(1).max(160).optional(),
  })
  .refine((i) => (i.propertyId ? 1 : 0) + (i.newPropertyAddress ? 1 : 0) === 1, {
    error: 'Pick a property, or type the address of a new one.',
    path: ['propertyId'],
  });
export const DealSetPropertyOutput = z.object({ dealId: uuid, propertyId: uuid });

export const PartyAddInput = z
  .object({
    ...inDeal,
    role: z.enum(PARTY_ROLES_LIST),
    personId: uuid.optional(),
    companyId: uuid.optional(),
    note: z.string().trim().max(200).nullable().optional(),
  })
  .refine((i) => (i.personId ? 1 : 0) + (i.companyId ? 1 : 0) === 1, {
    error: 'Pick one person or one company.',
    path: ['personId'],
  });
export const PartyAddOutput = z.object({ dealId: uuid, relationshipId: uuid });
export const PartyRemoveInput = z.object({ ...inDeal, relationshipId: uuid });
export const PartyRemoveOutput = z.object({ dealId: uuid, relationshipId: uuid });

// ---------- commission ----------

export const DealSetCommissionInput = z
  .object({
    ...inDeal,
    rateBp: bp.nullable(),
    flatCents: cents.nullable(),
    creditCents: cents.default(0),
    splitBp: bp.nullable(),
  })
  .refine((i) => i.rateBp === null || i.flatCents === null, {
    error: 'Use a rate or a flat amount, not both.',
    path: ['flatCents'],
  });
const CommissionOut = z.object({
  rateBp: z.number().int().nullable(),
  flatCents: z.number().int().nullable(),
  creditCents: z.number().int(),
  splitBp: z.number().int().nullable(),
  grossCents: z.number().int().nullable(),
  expectedCents: z.number().int().nullable(),
  agentShareCents: z.number().int().nullable(),
  finalCents: z.number().int().nullable(),
  finalAt: isoDateTime.nullable(),
});
export const DealCommissionOutput = z.object({ dealId: uuid, commission: CommissionOut });
export const DealSetFinalCommissionInput = z.object({ ...inDeal, cents, note: optionalNote });

// ---------- archive ----------

export const DealArchiveInput = z.object(inDeal);
export const DealArchiveOutput = z.object({ dealId: uuid, archived: z.boolean() });

// ---------- terms ----------

export const TermEnterInput = z
  .object({
    ...inDeal,
    key: z.enum(TERM_KEYS),
    date: localDate.optional(),
    time: clock.optional(),
    cents: cents.optional(),
    text: z.string().trim().min(1).max(500).optional(),
    source: z.enum(TERM_SOURCES).default('typed'),
    /** Where in the document ("§7(b)", "page 3"). */
    sourceRef: z.string().trim().max(200).optional(),
    documentId: uuid.optional(),
    note: optionalNote,
    /** The entry this one replaces (an amendment, a correction). */
    replaces: uuid.optional(),
    /** Saved by a person is confirmed; false leaves it for someone else to confirm. */
    confirm: z.boolean().default(true),
  })
  .refine(
    (i) =>
      (i.date !== undefined ? 1 : 0) + (i.cents !== undefined ? 1 : 0) + (i.text ? 1 : 0) === 1,
    { error: 'Enter one value: a date, an amount or words.', path: ['date'] },
  )
  .refine((i) => i.time === undefined || i.date !== undefined, {
    error: 'A time goes with a date.',
    path: ['time'],
  });
const TermDatesOut = z.object({
  dutiesCreated: z.number().int(),
  dutiesActivated: z.number().int(),
  dutiesRedated: z.number().int(),
});
export const TermEnterOutput = TermDatesOut.extend({
  dealId: uuid,
  entryId: uuid,
  conflict: z.boolean(),
});
export const TermConfirmInput = z.object({ ...inDeal, entryId: uuid });
export const TermRejectInput = z.object({ ...inDeal, entryId: uuid, reason });
export const TermResolveInput = z.object({
  ...inDeal,
  key: z.enum(TERM_KEYS),
  /** The entry that counts; every other live one is set aside. */
  keepEntryId: uuid,
  reason,
});
export const TermChangeOutput = TermDatesOut.extend({ dealId: uuid, entryId: uuid });

// ---------- reading ----------

export const DealListInput = z.object({
  workspaceId: uuid,
  /** Only the deals they're on. */
  mine: z.boolean().default(false),
  side: z.enum(DEAL_SIDES).optional(),
  status: z.enum(['open', 'closed', 'ended', 'archived', 'all']).default('open'),
  search: z.string().trim().max(100).optional(),
  limit: z.number().int().min(1).max(200).default(100),
});
const DealRow = z.object({
  dealId: uuid,
  name: z.string(),
  side: z.enum(DEAL_SIDES),
  stage: z.string(),
  stageLabel: z.string(),
  outcome: z.string().nullable(),
  archived: z.boolean(),
  health: z.enum(['green', 'yellow', 'red']),
  mainAgent: z.object({ userId: uuid, name: z.string() }).nullable(),
  client: z.object({ personId: uuid, name: z.string() }).nullable(),
  property: z.object({ propertyId: uuid, address: z.string() }).nullable(),
  openDuties: z.number().int(),
  overdueDuties: z.number().int(),
  nextDue: z.object({ dutyId: uuid, title: z.string(), dueAt: isoDateTime }).nullable(),
  closing: z.string().nullable(),
  /** The first thing wrong, in a sentence: its top health reason. */
  headline: z.string().nullable(),
  /** They're its main agent or on its team. */
  mine: z.boolean(),
  /** Dates and terms typed in that nobody has confirmed yet. */
  datesToConfirm: z.number().int(),
  updatedAt: isoDateTime,
});
export const DealListOutput = z.object({ deals: z.array(DealRow) });

export const DealGetInput = z.object(inDeal);
const Duty = z.object({
  dutyId: uuid,
  key: z.string(),
  pass: z.number().int(),
  title: z.string(),
  tracker: z.string(),
  status: z.enum(DUTY_STATUSES),
  overdue: z.boolean(),
  materiality: z.string(),
  automation: z.string(),
  accountableRole: z.string(),
  accountable: z.object({ userId: uuid, name: z.string() }).nullable(),
  startedBy: z.string(),
  dueState: z.enum(['due', 'none', 'waiting']),
  dueAt: isoDateTime.nullable(),
  dueDate: z.string().nullable(),
  dueTime: z.string().nullable(),
  needsDates: z.array(z.string()),
  warnings: z.array(z.unknown()),
  /** What finishes it, in words; empty when saying it's done is enough. */
  proof: z.string(),
  /** What's still missing before it can be marked done, in words; empty when nothing is (or it's finished). */
  proofMissing: z.string(),
  /** Waiting on someone: who. */
  waitingOn: z.string().nullable(),
  /** Blocked: by what. */
  blocked: z.string().nullable(),
});
const Term = z.object({
  key: z.string(),
  label: z.string(),
  kind: z.enum(['date', 'money', 'text']),
  conflict: z.boolean(),
  confirmed: z.boolean(),
  entries: z.array(
    z.object({
      entryId: uuid,
      date: z.string().nullable(),
      time: z.string().nullable(),
      cents: z.number().int().nullable(),
      text: z.string().nullable(),
      source: z.string(),
      sourceRef: z.string().nullable(),
      enteredAt: isoDateTime,
      confirmed: z.boolean(),
    }),
  ),
});
export const DealGetOutput = z.object({
  deal: z.object({
    dealId: uuid,
    name: z.string(),
    notes: z.string().nullable(),
    side: z.enum(DEAL_SIDES),
    stage: z.string(),
    stageLabel: z.string(),
    stageEnteredAt: isoDateTime,
    outcome: z.string().nullable(),
    outcomeAt: isoDateTime.nullable(),
    outcomeReason: z.string().nullable(),
    archived: z.boolean(),
    leadId: uuid.nullable(),
    facts: z.array(z.string()),
    health: z.enum(['green', 'yellow', 'red']),
    healthReasons: z.array(z.unknown()),
    catalogVersion: z.number().int(),
    templateSetId: uuid.nullable(),
    createdAt: isoDateTime,
  }),
  /** What a person may do here, so a screen shows only what works. */
  can: z.object({
    changeTeam: z.boolean(),
    chooseMainAgent: z.boolean(),
    except: z.boolean(),
    archive: z.boolean(),
  }),
  team: z.array(TeamMember),
  property: z.object({ propertyId: uuid, address: z.string() }).nullable(),
  parties: z.array(
    z.object({
      relationshipId: uuid,
      role: z.string(),
      label: z.string(),
      personId: uuid.nullable(),
      companyId: uuid.nullable(),
      name: z.string(),
      note: z.string().nullable(),
    }),
  ),
  links: z.array(
    z.object({
      otherDealId: uuid,
      kind: z.enum(DEAL_LINK_KINDS_LIST),
      name: z.string(),
      side: z.enum(DEAL_SIDES),
      stage: z.string(),
    }),
  ),
  terms: z.array(Term),
  dateProblems: z.array(
    z.object({
      check: z.string(),
      severity: z.enum(['problem', 'warning']),
      keys: z.array(z.string()),
      words: z.string(),
    }),
  ),
  commission: CommissionOut,
  duties: z.array(Duty),
});

export const DealHistoryInput = z.object({
  ...inDeal,
  limit: z.number().int().min(1).max(200).default(50),
  before: isoDateTime.optional(),
});
export const DealHistoryOutput = z.object({
  lines: z.array(
    z.object({
      at: isoDateTime,
      what: z.string(),
      actorType: z.enum(['person', 'system', 'ai', 'client']),
      actor: z.object({ userId: uuid, name: z.string() }).nullable(),
      before: z.record(z.string(), z.unknown()).nullable(),
      after: z.record(z.string(), z.unknown()).nullable(),
      note: z.string().nullable(),
    }),
  ),
});

export const TermHistoryInput = z.object({ ...inDeal, key: z.enum(TERM_KEYS).optional() });
export const TermHistoryOutput = z.object({
  entries: z.array(
    z.object({
      entryId: uuid,
      key: z.string(),
      label: z.string(),
      date: z.string().nullable(),
      time: z.string().nullable(),
      cents: z.number().int().nullable(),
      text: z.string().nullable(),
      source: z.string(),
      sourceRef: z.string().nullable(),
      documentId: uuid.nullable(),
      note: z.string().nullable(),
      enteredBy: z.object({ userId: uuid, name: z.string() }).nullable(),
      enteredAt: isoDateTime,
      confirmedBy: z.object({ userId: uuid, name: z.string() }).nullable(),
      confirmedAt: isoDateTime.nullable(),
      supersededAt: isoDateTime.nullable(),
      rejectedAt: isoDateTime.nullable(),
      rejectedReason: z.string().nullable(),
      live: z.boolean(),
    }),
  ),
});

/** The deals of one customer, company, lead or property: a panel on its page. */
export const DealsForInput = z
  .object({
    workspaceId: uuid,
    personId: uuid.optional(),
    companyId: uuid.optional(),
    leadId: uuid.optional(),
    propertyId: uuid.optional(),
  })
  .refine((i) => [i.personId, i.companyId, i.leadId, i.propertyId].filter(Boolean).length === 1, {
    error: 'Ask about one customer, company, lead or property.',
    path: ['personId'],
  });
export const DealsForOutput = DealListOutput;

/** Properties already here, by address: to start a deal on a home the business knows. */
export const PropertySearchInput = z.object({
  workspaceId: uuid,
  q: z.string().trim().min(1).max(100),
  limit: z.number().int().min(1).max(20).default(8),
});
export const PropertySearchOutput = z.object({
  properties: z.array(z.object({ propertyId: uuid, address: z.string(), deals: z.number().int() })),
});

export const OverviewInput = z.object({ workspaceId: uuid });
export const OverviewOutput = z.object({
  name: z.string(),
  version: z.string(),
  openDeals: z.number().int(),
  myOpenDeals: z.number().int(),
  overdueDuties: z.number().int(),
  dueThisWeek: z.number().int(),
});

// ---------- duties (step 9) ----------

const inDuty = { workspaceId: uuid, dutyId: uuid };

export const DutySetStatusInput = z
  .object({
    ...inDuty,
    status: z.enum(['not_started', 'in_progress', 'waiting_external', 'blocked']),
    /** Waiting on someone: who. */
    waitingOn: z.string().trim().min(1).max(200).optional(),
    /** Blocked: by what, whose it is to clear, what it holds up, and when to look again. */
    blocker: z
      .object({
        what: z.string().trim().min(1, 'Say what’s in the way.').max(500),
        owner: z.string().trim().min(1, 'Say whose it is to clear.').max(200),
        impact: z.string().trim().min(1, 'Say what it holds up.').max(500),
        reviewAt: isoDateTime,
      })
      .optional(),
    note: optionalNote,
  })
  .refine((i) => i.status !== 'waiting_external' || !!i.waitingOn, {
    error: 'Say who it’s waiting on.',
    path: ['waitingOn'],
  })
  .refine((i) => i.status !== 'blocked' || !!i.blocker, {
    error: 'Say what’s in the way, whose it is to clear, what it holds up, and when to look again.',
    path: ['blocker'],
  });
export const DutyOutput = z.object({ dealId: uuid, dutyId: uuid, status: z.enum(DUTY_STATUSES) });

export const EVIDENCE_KINDS = [
  'document',
  'file',
  'note',
  'attestation',
  'appointment',
  'message',
] as const;
export const DutyAddEvidenceInput = z
  .object({
    ...inDuty,
    kind: z.enum(EVIDENCE_KINDS),
    documentId: uuid.optional(),
    fileId: uuid.optional(),
    appointmentId: uuid.optional(),
    messageId: uuid.optional(),
    /** A note's words, or the words attested. */
    body: z.string().trim().min(1).max(4000).optional(),
  })
  .refine(
    (i) =>
      (i.kind === 'document' && !!i.documentId) ||
      (i.kind === 'file' && !!i.fileId) ||
      (i.kind === 'appointment' && !!i.appointmentId) ||
      (i.kind === 'message' && !!i.messageId) ||
      ((i.kind === 'note' || i.kind === 'attestation') && !!i.body),
    {
      error: 'Pick the document, file, appointment or message, or write the note.',
      path: ['kind'],
    },
  );
export const DutyEvidenceOutput = z.object({
  dealId: uuid,
  dutyId: uuid,
  evidenceId: uuid,
  /** What's still missing before it can be marked done, in words; empty when nothing is. */
  missing: z.string(),
});
export const DutyWithdrawEvidenceInput = z.object({ ...inDuty, evidenceId: uuid, reason });

export const DutyAssignInput = z.object({ ...inDuty, userId: uuid.nullable() });
export const DutyAcknowledgeInput = z.object(inDuty);
export const DutyCompleteInput = z.object({ ...inDuty, note: optionalNote });
export const DutyReasonInput = z.object({ ...inDuty, reason });
export const DutySetDueInput = z
  .object({
    ...inDuty,
    /** A new due date (and time), or clear: back to what its rule says. */
    date: localDate.optional(),
    time: clock.optional(),
    clear: z.boolean().default(false),
    reason: reason.optional(),
  })
  .refine((i) => i.clear || (!!i.date && !!i.reason), {
    error: 'Pick the new due date and say why.',
    path: ['date'],
  });

export const DutyAddInput = z.object({
  workspaceId: uuid,
  dealId: uuid,
  title: z.string().trim().min(1, 'Name the duty.').max(80, 'Keep it under 80 characters.'),
  details: z.string().trim().max(1000).optional(),
  tracker: z.enum(TRACKER_CODES).default('HEALTH'),
  accountableUserId: uuid.optional(),
  materiality: z.enum(MATERIALITIES).default('standard'),
  proof: z.enum(OWN_PROOF).default('none'),
  attestation: z.string().trim().max(200).optional(),
  dueDate: localDate.optional(),
  dueTime: clock.optional(),
});

export const DealReportWireChangeInput = z.object({
  ...inDeal,
  /** How the change came in. */
  how: z.enum(['email', 'text', 'phone', 'other']),
  /** Who it said it was from. */
  from: z.string().trim().max(200).optional(),
  note: optionalNote,
});
export const DealReportWireChangeOutput = z.object({ dealId: uuid, dutyId: uuid });

export const DutyGetInput = z.object(inDuty);
export const DutyGetOutput = z.object({
  duty: z.object({
    dutyId: uuid,
    dealId: uuid,
    dealName: z.string(),
    key: z.string(),
    pass: z.number().int(),
    title: z.string(),
    behavior: z.string(),
    phase: z.string(),
    tracker: z.string(),
    status: z.enum(DUTY_STATUSES),
    overdue: z.boolean(),
    materiality: z.string(),
    automation: z.string(),
    accountableRole: z.string(),
    accountable: z.object({ userId: uuid, name: z.string() }).nullable(),
    performers: z.array(z.string()),
    startedBy: z.string(),
    startedAt: isoDateTime,
    dueState: z.enum(['due', 'none', 'waiting']),
    dueAt: isoDateTime.nullable(),
    dueDate: z.string().nullable(),
    dueTime: z.string().nullable(),
    dueTrace: z.array(z.unknown()),
    /** Its due rule in words: "5 business days before closing". */
    dueRule: z.string(),
    warnings: z.array(z.unknown()),
    needsDates: z.array(z.string()),
    dueSetByHand: z.object({ at: isoDateTime, reason: z.string() }).nullable(),
    blocker: z
      .object({
        what: z.string(),
        owner: z.string(),
        impact: z.string().nullable(),
        reviewAt: isoDateTime.nullable(),
      })
      .nullable(),
    waitingOn: z.string().nullable(),
    finishedAt: isoDateTime.nullable(),
    finishReason: z.string().nullable(),
    exception: z.boolean(),
    acknowledgedAt: isoDateTime.nullable(),
  }),
  proof: z.object({
    /** What finishes it, in words; empty when marking it done is enough. */
    needs: z.string(),
    missing: z.string(),
    /** Attestations it asks for, word for word. */
    attestations: z.array(z.string()),
  }),
  evidence: z.array(
    z.object({
      evidenceId: uuid,
      kind: z.string(),
      documentId: uuid.nullable(),
      fileId: uuid.nullable(),
      appointmentId: uuid.nullable(),
      messageId: uuid.nullable(),
      body: z.string().nullable(),
      label: z.string(),
      addedBy: z.object({ userId: uuid, name: z.string() }).nullable(),
      addedAt: isoDateTime,
      withdrawnAt: isoDateTime.nullable(),
      withdrawnReason: z.string().nullable(),
    }),
  ),
  log: z.array(
    z.object({
      at: isoDateTime,
      what: z.string(),
      actorType: z.enum(['person', 'system', 'ai', 'client']),
      actor: z.object({ userId: uuid, name: z.string() }).nullable(),
      before: z.record(z.string(), z.unknown()).nullable(),
      after: z.record(z.string(), z.unknown()).nullable(),
      note: z.string().nullable(),
    }),
  ),
  can: z.object({ except: z.boolean() }),
});

export const DutyListInput = z.object({
  workspaceId: uuid,
  /** Only those they answer for. */
  mine: z.boolean().default(true),
  status: z.enum(['open', 'overdue', 'drafts', 'all']).default('open'),
  dealId: uuid.optional(),
  limit: z.number().int().min(1).max(500).default(200),
});
export const DutyListOutput = z.object({
  duties: z.array(
    z.object({
      dutyId: uuid,
      dealId: uuid,
      dealName: z.string(),
      key: z.string(),
      title: z.string(),
      status: z.enum(DUTY_STATUSES),
      overdue: z.boolean(),
      materiality: z.string(),
      accountable: z.object({ userId: uuid, name: z.string() }).nullable(),
      dueAt: isoDateTime.nullable(),
      dueState: z.enum(['due', 'none', 'waiting']),
    }),
  ),
});

// ---------- documents (step 9) ----------

export const DOCUMENT_KIND_KEYS = Object.keys(DOCUMENT_KINDS) as [DocumentKind, ...DocumentKind[]];
const inDocument = { workspaceId: uuid, documentId: uuid };

export const DocumentAddInput = z.object({
  ...inDeal,
  /** A file already on the deal. */
  fileId: uuid,
  kind: z.enum(DOCUMENT_KIND_KEYS),
  title: z.string().trim().min(1).max(200).optional(),
  /** The document this is a newer version of. */
  supersedesId: uuid.optional(),
  status: z.enum(['draft', 'sent']).default('draft'),
});
export const DocumentOutput = z.object({
  dealId: uuid,
  documentId: uuid,
  version: z.number().int(),
  status: z.enum(['draft', 'sent', 'signed', 'superseded', 'void']),
  controlling: z.boolean(),
});
export const DocumentUpdateInput = z.object({
  ...inDocument,
  title: z.string().trim().min(1).max(200).optional(),
  kind: z.enum(DOCUMENT_KIND_KEYS).optional(),
  status: z.enum(['draft', 'sent']).optional(),
});
export const DocumentSignedInput = z.object(inDocument);
export const DocumentVoidInput = z.object({ ...inDocument, reason });

export const DocumentListInput = z.object(inDeal);
export const DocumentListOutput = z.object({
  documents: z.array(
    z.object({
      documentId: uuid,
      fileId: uuid,
      fileName: z.string(),
      kind: z.string(),
      kindLabel: z.string(),
      title: z.string(),
      lineageId: uuid,
      version: z.number().int(),
      status: z.enum(['draft', 'sent', 'signed', 'superseded', 'void']),
      controlling: z.boolean(),
      locked: z.boolean(),
      signedAt: isoDateTime.nullable(),
      voidedAt: isoDateTime.nullable(),
      voidReason: z.string().nullable(),
      createdAt: isoDateTime,
    }),
  ),
});

// ---------- health and the sweep (step 10) ----------

const HealthReasonOut = z.object({
  code: z.string(),
  level: z.enum(['red', 'yellow']),
  words: z.string(),
  next: z.string(),
  dutyId: uuid.optional(),
  keys: z.array(z.string()).optional(),
  dueAt: isoDateTime.nullable().optional(),
  accountable: z.object({ userId: uuid, name: z.string() }).nullable(),
});

export const DealRisksInput = z.object(inDeal);
export const DealRisksOutput = z.object({
  dealId: uuid,
  name: z.string(),
  health: z.enum(['green', 'yellow', 'red']),
  reasons: z.array(HealthReasonOut),
  /** Every open material or critical duty: what could stop the closing, with who, when, and what's missing. */
  openWork: z.array(
    z.object({
      dutyId: uuid,
      title: z.string(),
      status: z.enum(DUTY_STATUSES),
      materiality: z.string(),
      overdue: z.boolean(),
      dueAt: isoDateTime.nullable(),
      accountable: z.object({ userId: uuid, name: z.string() }).nullable(),
      missing: z.string(),
      next: z.string(),
    }),
  ),
});

export const SweepInput = z.object({ workspaceId: uuid });
export const SweepOutput = z.object({
  deals: z.number().int(),
  /** Who hears about critical alerts besides the deal's team: the business's alert person, else its owners. */
  alertPersonUserIds: z.array(uuid),
  /** Each open duty on the ladder now, for the worker to raise its alert. */
  alerts: z.array(
    z.object({
      dealId: uuid,
      dealName: z.string(),
      dutyId: uuid,
      key: z.string(),
      title: z.string(),
      status: z.enum(DUTY_STATUSES),
      materiality: z.enum(MATERIALITIES),
      dueAt: isoDateTime,
      dueDate: z.string().nullable(),
      rung: z.enum(RUNGS),
      accountableUserId: uuid.nullable(),
      mainAgentUserId: uuid.nullable(),
      coordinatorUserIds: z.array(uuid),
    }),
  ),
});

// ---------- client updates (step 13) ----------

export const MILESTONES = [
  'under_contract',
  'inspection_done',
  'clear_to_close',
  'closed',
  'asked',
] as const;
const FlagOut = z.object({
  phrase: z.string().max(200),
  category: z.enum(
    Object.keys(FAIR_HOUSING_CATEGORIES) as [FairHousingCategory, ...FairHousingCategory[]],
  ),
  reason: z.string(),
  safer: z.string(),
});
const inDraft = { workspaceId: uuid, draftId: uuid };

export const StatusEmailRequestInput = z.object({
  ...inDeal,
  milestone: z.enum(MILESTONES).default('asked'),
});
export const StatusEmailOutput = z.object({
  dealId: uuid,
  draftId: uuid,
  status: z.enum(['drafting', 'ready', 'sent', 'discarded', 'failed']),
});
export const StatusEmailDraftedInput = z.object({
  ...inDraft,
  subject: z.string().max(200).optional(),
  body: z.string().max(10000).optional(),
  model: z.string().max(100).optional(),
  facts: z.record(z.string(), z.unknown()).optional(),
  failure: z.string().max(500).optional(),
  checks: z
    .array(
      z.object({
        source: z.enum(['words', 'model']),
        version: z.string().min(1).max(100),
        status: z.enum(['passed', 'flagged', 'unavailable']),
        flags: z.array(FlagOut).max(50),
      }),
    )
    .max(4)
    .default([]),
});
export const StatusEmailCheckedInput = z.object({
  ...inDraft,
  /** The digest of the words the model read: a check of older words is set aside. */
  textHash: z.string().regex(/^[0-9a-f]{64}$/),
  version: z.string().min(1).max(100),
  status: z.enum(['passed', 'flagged', 'unavailable']),
  flags: z.array(FlagOut).max(50),
});
export const StatusEmailSaveInput = z.object({
  ...inDraft,
  subject: z.string().trim().min(1, 'Write a subject.').max(200),
  body: z.string().trim().min(1, 'Write the email.').max(10000),
});
export const StatusEmailSavedOutput = StatusEmailOutput.extend({ flags: z.array(FlagOut) });
export const StatusEmailAcknowledgeInput = z.object({ ...inDraft, reason });
export const StatusEmailDraftInput = z.object(inDraft);

export const StatusEmailListInput = z.object(inDeal);
const DraftOut = z.object({
  draftId: uuid,
  dealId: uuid,
  milestone: z.enum(MILESTONES),
  status: z.enum(['drafting', 'ready', 'sent', 'discarded', 'failed']),
  subject: z.string().nullable(),
  body: z.string().nullable(),
  failure: z.string().nullable(),
  to: z.object({ personId: uuid, name: z.string(), email: z.string().nullable() }).nullable(),
  requestedAt: isoDateTime,
  sentAt: isoDateTime.nullable(),
});
export const StatusEmailListOutput = z.object({ drafts: z.array(DraftOut) });
export const StatusEmailGetOutput = z.object({
  draft: DraftOut,
  /** The flags on the words as they are now, from the list and the model. */
  flags: z.array(FlagOut),
  /** The model's check of these words is still running. */
  checking: z.boolean(),
  acknowledged: z.object({ at: isoDateTime, reason: z.string() }).nullable(),
  canSend: z.boolean(),
  checks: z.array(
    z.object({
      source: z.enum(['words', 'model']),
      version: z.string(),
      status: z.enum(['passed', 'flagged', 'unavailable']),
      flags: z.array(FlagOut),
      checkedAt: isoDateTime,
      current: z.boolean(),
    }),
  ),
});

// ---------- round two: the buyer's profile and their homes ----------

const shortList = (max: number, words: number) =>
  z
    .array(z.string().trim().min(1).max(words, `Keep each one under ${words} characters.`))
    .max(max, `Keep it to ${max}.`)
    .default([]);

/** What the buyer wants. Every field is optional: a profile fills in as the agent learns it. */
export const BuyerProfileFields = z
  .object({
    budgetMinCents: cents.nullable().default(null),
    budgetMaxCents: cents.nullable().default(null),
    /** Towns, ZIP codes or neighborhoods, as the client named them. */
    areas: shortList(20, 80),
    homeTypes: z.array(z.enum(HOME_TYPE_KEYS)).max(6).default([]),
    bedsMin: z.number().int().min(0).max(20).nullable().default(null),
    bathsMin: z
      .number()
      .min(0)
      .max(20)
      .refine((n) => Number.isInteger(n * 2), 'Baths go in halves, like 2.5.')
      .nullable()
      .default(null),
    sqftMin: z.number().int().min(0).max(100_000).nullable().default(null),
    moveBy: localDate.nullable().default(null),
    mustHaves: shortList(20, 120),
    dealBreakers: shortList(20, 120),
  })
  .refine(
    (p) =>
      p.budgetMinCents === null ||
      p.budgetMaxCents === null ||
      p.budgetMinCents <= p.budgetMaxCents,
    { path: ['budgetMinCents'], error: 'The lowest price is more than the highest.' },
  );
export const BuyerProfileSaveInput = z.object({ ...inDeal, profile: BuyerProfileFields });
export const BuyerProfileOut = z.object({
  budgetMinCents: z.number().nullable(),
  budgetMaxCents: z.number().nullable(),
  areas: z.array(z.string()),
  homeTypes: z.array(z.string()),
  bedsMin: z.number().nullable(),
  bathsMin: z.number().nullable(),
  sqftMin: z.number().nullable(),
  moveBy: z.string().nullable(),
  mustHaves: z.array(z.string()),
  dealBreakers: z.array(z.string()),
  version: z.number().int(),
  updatedAt: isoDateTime,
  updatedBy: z.object({ id: uuid, fullName: z.string() }).nullable(),
});
export const BuyerProfileSaveOutput = z.object({
  dealId: uuid,
  version: z.number().int(),
  changed: z.boolean(),
});
export const BuyerProfileGetInput = z.object({ ...inDeal });
export const BuyerProfileGetOutput = z.object({ profile: BuyerProfileOut.nullable() });

/** A home's facts, as a person confirms them (money in cents). */
export const ListingFactsIn = z.object({
  price_cents: cents.optional(),
  beds: z.number().int().min(0).max(100).optional(),
  baths: z
    .number()
    .min(0)
    .max(100)
    .refine((n) => Number.isInteger(n * 2), 'Baths go in halves, like 2.5.')
    .optional(),
  sqft: z.number().int().min(0).max(10_000_000).optional(),
  lot_sqft: z.number().int().min(0).max(1_000_000_000).optional(),
  year_built: z.number().int().min(1700).max(2100).optional(),
  hoa_monthly_cents: cents.optional(),
  property_type: z.enum(HOME_TYPE_KEYS).optional(),
  garage_spaces: z.number().int().min(0).max(100).optional(),
});

export const HomeAddInput = z.object({
  ...inDeal,
  address: z.string().trim().min(3, 'Enter the home’s address.').max(300),
  /** A listing's link: kept for people to open, never read by HandsFreeOS. */
  link: z
    .string()
    .trim()
    .max(2000)
    .regex(/^https?:\/\//i, 'A link starts with https://.')
    .optional(),
  /** The listing's words, pasted: the AI fills in the home's facts from them, for the agent to confirm. */
  pastedText: z
    .string()
    .trim()
    .max(20_000, 'Paste up to 20,000 characters of the listing.')
    .optional(),
  note: optionalNote,
});
export const HomeAddOutput = z.object({
  homeId: uuid,
  /** The AI is reading the pasted text for its facts. */
  filling: z.boolean(),
});

export const HomeFillFactsInput = z.object({
  workspaceId: uuid,
  homeId: uuid,
  facts: ListingFactsIn.default({}),
  /** Each fact's words in the pasted text. */
  sources: z.record(z.string(), z.string().max(300)).default({}),
  dropped: z.number().int().min(0).default(0),
  model: z.string().max(100).optional(),
  /** Why it couldn't be read, instead. */
  failure: z.string().max(500).optional(),
});
export const HomeFillFactsOutput = z.object({
  homeId: uuid,
  state: z.enum(['suggested', 'failed', 'skipped']),
});

export const HomeConfirmFactsInput = z.object({
  workspaceId: uuid,
  homeId: uuid,
  facts: ListingFactsIn,
});
export const HomeConfirmFactsOutput = z.object({ homeId: uuid, confirmedAt: isoDateTime });

export const HomeSetStatusInput = z.object({
  workspaceId: uuid,
  homeId: uuid,
  status: z.enum(HOME_STATUS_KEYS),
  note: z.string().trim().max(500).optional(),
});
export const HomeSetStatusOutput = z.object({
  homeId: uuid,
  status: z.enum(HOME_STATUS_KEYS),
  changed: z.boolean(),
});

export const FitLineOut = z.object({
  key: z.enum(['budget', 'area', 'type', 'beds', 'baths', 'sqft']),
  met: z.boolean().nullable(),
  words: z.string(),
});
export const HomeOut = z.object({
  id: uuid,
  address: z.string(),
  source: z.enum(['agent', 'client', 'mls']),
  link: z.string().nullable(),
  status: z.enum(HOME_STATUS_KEYS),
  statusNote: z.string().nullable(),
  facts: ListingFactsIn,
  /** Each suggested fact's words in the pasted text, while the agent checks them. */
  factSources: z.record(z.string(), z.string()),
  factsState: z.enum(['none', 'filling', 'suggested', 'confirmed', 'failed']),
  factsFailure: z.string().nullable(),
  hasPastedText: z.boolean(),
  fit: z.object({
    lines: z.array(FitLineOut),
    met: z.number().int(),
    missed: z.number().int(),
    unknown: z.number().int(),
  }),
  reactions: z.array(
    z.object({
      personId: uuid,
      name: z.string(),
      reaction: z.enum(['saved', 'passed']),
      note: z.string().nullable(),
      at: isoDateTime,
    }),
  ),
  addedBy: z.object({ id: uuid, fullName: z.string() }).nullable(),
  addedByClient: z.object({ id: uuid, name: z.string() }).nullable(),
  addedAt: isoDateTime,
});
export const HomesInput = z.object({ ...inDeal, includeRemoved: z.boolean().default(false) });
export const HomesOutput = z.object({ homes: z.array(HomeOut) });

// ---------- buyer memory (round two) ----------

export const MemoryAddInput = z.object({
  ...inDeal,
  kind: z.enum(MEMORY_KIND_KEYS),
  words: z
    .string()
    .trim()
    .min(1, 'Say what to remember.')
    .max(300, 'Keep it under 300 characters.'),
});
export const MemoryAddOutput = z.object({
  itemId: uuid,
  status: z.enum(['suggested', 'confirmed']),
});

export const MemoryDecideInput = z.object({
  workspaceId: uuid,
  itemId: uuid,
  /** confirm or reject a suggestion; retire one that's no longer true. */
  decision: z.enum(['confirm', 'reject', 'retire']),
  /** Confirming: the words as the agent put them, when they changed them. */
  words: z.string().trim().min(1).max(300).optional(),
  note: z.string().trim().max(500).optional(),
});
export const MemoryDecideOutput = z.object({
  itemId: uuid,
  status: z.enum(['confirmed', 'rejected', 'retired']),
  /** Suggestions still waiting on this deal. */
  waiting: z.number().int(),
});

export const MemoryRequestInput = z.object({ ...inDeal });
export const MemoryRequestOutput = z.object({ dealId: uuid, requested: z.boolean() });

export const MemorySuggestInput = z.object({
  workspaceId: uuid,
  dealId: uuid,
  items: z
    .array(
      z.object({
        kind: z.enum(MEMORY_KIND_KEYS),
        words: z.string().trim().min(1).max(300),
        quote: z.string().trim().min(1).max(500),
        sourceKind: z.enum(['message', 'call', 'note']),
        sourceId: uuid,
      }),
    )
    .max(20),
  /** How far it read: the newest of the words it was given. */
  readThrough: isoDateTime,
  unquoted: z.number().int().min(0).default(0),
  protectedDropped: z.number().int().min(0).default(0),
});
export const MemorySuggestOutput = z.object({ added: z.number().int(), waiting: z.number().int() });

export const MemoryItemOut = z.object({
  id: uuid,
  kind: z.enum(MEMORY_KIND_KEYS),
  words: z.string(),
  quote: z.string().nullable(),
  sourceKind: z.enum(['message', 'call', 'note', 'typed']),
  sourceId: uuid.nullable(),
  status: z.enum(['suggested', 'confirmed', 'rejected', 'retired']),
  suggestedBy: z.enum(['ai', 'person']),
  createdBy: z.object({ id: uuid, fullName: z.string() }).nullable(),
  decidedBy: z.object({ id: uuid, fullName: z.string() }).nullable(),
  decidedAt: isoDateTime.nullable(),
  createdAt: isoDateTime,
});
export const MemoryListInput = z.object({ ...inDeal, includeClosed: z.boolean().default(false) });
export const MemoryListOutput = z.object({
  items: z.array(MemoryItemOut),
  waiting: z.number().int(),
});

// ---------- tours (round two) ----------

const homeIds = z
  .array(uuid)
  .min(1, 'Pick at least one home.')
  .max(MAX_TOUR_STOPS, `A tour can have up to ${MAX_TOUR_STOPS} homes. Split it into two.`)
  .refine((ids) => new Set(ids).size === ids.length, { error: 'Each home goes on a tour once.' });
const tourMinutes = z.int().min(15, 'At least 15 minutes.').max(720, 'At most 12 hours.');
/** An owner's or admin's reason for a tour without a signed, current buyer agreement. */
const TourException = z.object({ reason });

export const TourPlanInput = z.object({
  ...inDeal,
  /** The homes, in the order they'll be seen. */
  homeIds,
  startsAt: isoDateTime,
  /** Defaults to half an hour a home. */
  durationMinutes: tourMinutes.optional(),
  /** Defaults to the business's tour calendar (Settings → Real Estate), or the agent's only calendar. */
  calendarId: uuid.optional(),
  /** Who leads it; defaults to whoever plans it. */
  agentUserId: uuid.optional(),
  note: z.string().trim().max(2000, 'Keep it under 2,000 characters.').optional(),
  /** Send the client the calendar's confirmation; reminders follow the calendar either way. */
  notifyClient: z.boolean().default(true),
  acknowledgeWarnings: z.boolean().default(false),
  exception: TourException.optional(),
});
export const TourPlanOutput = z.object({
  tourId: uuid,
  appointmentId: uuid,
  startsAt: isoDateTime,
  endsAt: isoDateTime,
  /** The calendar's warnings (outside hours, busy…), already accepted. */
  warnings: z.array(z.object({ code: z.string(), message: z.string() })),
  /** It went ahead on an owner's or admin's exception. */
  exception: z.boolean(),
});

export const TourSetStopsInput = z.object({ workspaceId: uuid, tourId: uuid, homeIds });
export const TourRescheduleInput = z.object({
  workspaceId: uuid,
  tourId: uuid,
  startsAt: isoDateTime,
  durationMinutes: tourMinutes.optional(),
  notifyClient: z.boolean().default(true),
  acknowledgeWarnings: z.boolean().default(false),
  exception: TourException.optional(),
});
export const TourCancelInput = z.object({
  workspaceId: uuid,
  tourId: uuid,
  reason: z.string().trim().max(500, 'Keep it under 500 characters.').optional(),
  notifyClient: z.boolean().default(true),
});
export const TourChangeOutput = z.object({
  tourId: uuid,
  status: z.enum(TOUR_STATUS_KEYS),
  startsAt: isoDateTime,
  endsAt: isoDateTime,
});

export const TourRecordVisitInput = z.object({
  workspaceId: uuid,
  stopId: uuid,
  status: z.enum(['visited', 'skipped']),
  note: z.string().trim().max(1000, 'Keep it under 1,000 characters.').optional(),
});
export const TourRecordVisitOutput = z.object({
  tourId: uuid,
  stopId: uuid,
  /** Every home on it seen or skipped: the tour is done. */
  tourStatus: z.enum(TOUR_STATUS_KEYS),
});

export const TourFeedbackInput = z.object({
  workspaceId: uuid,
  stopId: uuid,
  /** The client it's from. */
  personId: uuid,
  interest: z.enum(TOUR_INTEREST_KEYS),
  rating: z.int().min(1).max(5).nullable().optional(),
  words: z.string().trim().max(2000, 'Keep it under 2,000 characters.').optional(),
});
export const TourFeedbackOutput = z.object({ feedbackId: uuid, updated: z.boolean() });

/** The appointment moved or canceled on the calendar: the worker's. */
export const TourFollowInput = z.object({
  workspaceId: uuid,
  appointmentId: uuid,
  change: z.enum(['rescheduled', 'cancelled']),
  startsAt: isoDateTime.optional(),
  endsAt: isoDateTime.optional(),
  by: z.string().max(40).optional(),
  reason: z.string().max(500).nullable().optional(),
});
export const TourFollowOutput = z.object({ tourId: uuid.nullable(), changed: z.boolean() });

export const AgreementOut = z.object({
  /** A tour today may go ahead. */
  ok: z.boolean(),
  rule: z.enum(['buyer_agreement_needed', 'buyer_agreement_expired']).nullable(),
  /** What's wrong and what to do, when it isn't. */
  words: z.string().nullable(),
  signedTitle: z.string().nullable(),
  endsOn: z.string().nullable(),
});
const TourFeedbackOut = z.object({
  id: uuid,
  personId: uuid,
  name: z.string(),
  interest: z.enum(TOUR_INTEREST_KEYS),
  rating: z.number().int().nullable(),
  words: z.string().nullable(),
  /** Typed in by someone on the team who heard it; null when the client gave it. */
  recordedBy: z.object({ id: uuid, fullName: z.string() }).nullable(),
  at: isoDateTime,
});
export const TourOut = z.object({
  id: uuid,
  status: z.enum(TOUR_STATUS_KEYS),
  startsAt: isoDateTime,
  endsAt: isoDateTime,
  appointmentId: uuid.nullable(),
  calendarId: uuid.nullable(),
  agent: z.object({ id: uuid, fullName: z.string() }).nullable(),
  note: z.string().nullable(),
  exception: z
    .object({
      reason: z.string(),
      by: z.object({ id: uuid, fullName: z.string() }).nullable(),
      at: isoDateTime,
    })
    .nullable(),
  canceledReason: z.string().nullable(),
  stops: z.array(
    z.object({
      id: uuid,
      homeId: uuid,
      address: z.string(),
      position: z.number().int(),
      status: z.enum(STOP_STATUS_KEYS),
      visitedAt: isoDateTime.nullable(),
      note: z.string().nullable(),
      feedback: z.array(TourFeedbackOut),
    }),
  ),
});
export const ToursInput = z.object({ ...inDeal, includeCanceled: z.boolean().default(false) });
export const ToursOutput = z.object({
  agreement: AgreementOut,
  tours: z.array(TourOut),
  can: z.object({ except: z.boolean() }),
});

// ---------- the CMA (round two) ----------

const beds = z.int().min(0).max(20);
const baths = z.number().min(0).max(20).multipleOf(0.5, { error: 'Baths go in halves, like 2.5.' });
const sqft = z.int().min(100, 'At least 100 square feet.').max(100_000);
const yearBuilt = z.int().min(1600).max(2100);
const CompAdjustmentIn = z.object({
  label: z.string().trim().min(1, 'Say what the adjustment is for.').max(80),
  /** Signed: what the comp is worth more (+) or less (−) for it, in cents. */
  cents: z.int().min(-100_000_000).max(100_000_000),
});

export const CmaStartInput = z.object({
  ...inDeal,
  /** One of the deal's homes. */
  homeId: uuid,
  /** Start from another CMA's comps on the deal ("another CMA"). */
  fromCmaId: uuid.optional(),
});
export const CmaStartOutput = z.object({ cmaId: uuid, number: z.int(), comps: z.int() });

export const CmaSetSubjectInput = z.object({
  workspaceId: uuid,
  cmaId: uuid,
  beds: beds.nullable(),
  baths: baths.nullable(),
  sqft: sqft.nullable(),
  listPriceCents: z.int().min(1).max(100_000_000_000).nullable(),
  yearBuilt: yearBuilt.nullable(),
});

const CompFields = {
  address: z.string().trim().min(3, 'Enter the comp’s address.').max(300),
  priceCents: z.int().min(1, 'Enter its price.').max(100_000_000_000),
  status: z.enum(COMP_STATUS_KEYS).default('sold'),
  soldOn: localDate.nullable().optional(),
  beds: beds.nullable().optional(),
  baths: baths.nullable().optional(),
  sqft: sqft.nullable().optional(),
  yearBuilt: yearBuilt.nullable().optional(),
  distanceMiles: z.number().min(0).max(500).nullable().optional(),
  note: z.string().trim().max(1000).optional(),
};
export const CmaAddCompInput = z
  .object({ workspaceId: uuid, cmaId: uuid, ...CompFields })
  .refine((c) => c.status !== 'sold' || !!c.soldOn, {
    error: 'Enter the date it sold.',
    path: ['soldOn'],
  });
export const CmaAddCompOutput = z.object({ cmaId: uuid, compId: uuid });
export const CmaUpdateCompInput = z.object({
  workspaceId: uuid,
  compId: uuid,
  address: CompFields.address.optional(),
  priceCents: CompFields.priceCents.optional(),
  status: z.enum(COMP_STATUS_KEYS).optional(),
  soldOn: localDate.nullable().optional(),
  beds: beds.nullable().optional(),
  baths: baths.nullable().optional(),
  sqft: sqft.nullable().optional(),
  yearBuilt: yearBuilt.nullable().optional(),
  distanceMiles: z.number().min(0).max(500).nullable().optional(),
  note: z.string().trim().max(1000).nullable().optional(),
  /** Whether it counts in the range. */
  used: z.boolean().optional(),
  adjustments: z.array(CompAdjustmentIn).max(8).optional(),
});
export const CmaRemoveCompInput = z.object({ workspaceId: uuid, compId: uuid });
export const CmaInput = z.object({ workspaceId: uuid, cmaId: uuid });
export const CmaChangeOutput = z.object({ cmaId: uuid, status: z.enum(CMA_STATUS_KEYS) });

export const CmaSaveSummaryInput = z.object({
  workspaceId: uuid,
  cmaId: uuid,
  summary: z.string().trim().min(1, 'Write the summary.').max(6000),
});
export const CmaSaveSummaryOutput = CmaChangeOutput.extend({
  /** What the word list found in it at once; the model reads it a moment later. */
  flags: z.array(FlagOut),
});
export const CmaAcknowledgeInput = z.object({ workspaceId: uuid, cmaId: uuid, reason });

const CheckIn = z.object({
  source: z.enum(['words', 'model']),
  version: z.string().max(100),
  status: z.enum(['passed', 'flagged', 'unavailable']),
  flags: z.array(FlagOut).max(50),
});
export const CmaSummaryDraftedInput = z.object({
  workspaceId: uuid,
  cmaId: uuid,
  summary: z.string().max(6000).optional(),
  model: z.string().max(100).optional(),
  failure: z.string().max(2000).optional(),
  /** The figures it was written from, as of when it was asked for. */
  checks: z.array(CheckIn).max(2).default([]),
});
export const CmaSummaryCheckedInput = z.object({
  workspaceId: uuid,
  cmaId: uuid,
  textHash: z.string().regex(/^[0-9a-f]{64}$/),
  version: z.string().min(1).max(100),
  status: z.enum(['passed', 'flagged', 'unavailable']),
  flags: z.array(FlagOut).max(50),
});

const RangeOut = z.object({
  lowCents: z.number().int(),
  likelyCents: z.number().int(),
  highCents: z.number().int(),
  perSqftCents: z.number().int(),
  counted: z.number().int(),
});
export const CmaCompOut = z.object({
  id: uuid,
  address: z.string(),
  priceCents: z.number().int(),
  status: z.enum(COMP_STATUS_KEYS),
  soldOn: z.string().nullable(),
  beds: z.number().int().nullable(),
  baths: z.number().nullable(),
  sqft: z.number().int().nullable(),
  yearBuilt: z.number().int().nullable(),
  distanceMiles: z.number().nullable(),
  adjustments: z.array(z.object({ label: z.string(), cents: z.number().int() })),
  used: z.boolean(),
  note: z.string().nullable(),
  source: z.enum(['agent', 'mls']),
  /** Its value for the home, and what it was adjusted by. */
  valueCents: z.number().int().nullable(),
  adjustmentCents: z.number().int().nullable(),
  weight: z.number(),
  counted: z.boolean(),
  why: z.string().nullable(),
  warnings: z.array(z.string()),
});
export const CmaOut = z.object({
  id: uuid,
  dealId: uuid,
  homeId: uuid.nullable(),
  number: z.number().int(),
  status: z.enum(CMA_STATUS_KEYS),
  asOf: z.string(),
  method: z.string(),
  subject: z.object({
    address: z.string(),
    beds: z.number().int().nullable(),
    baths: z.number().nullable(),
    sqft: z.number().int().nullable(),
    listPriceCents: z.number().int().nullable(),
    yearBuilt: z.number().int().nullable(),
  }),
  comps: z.array(CmaCompOut),
  /** As finalized, or as the comps give it now while a draft. */
  range: RangeOut.nullable(),
  /** Why there's no range yet. */
  missing: z.string().nullable(),
  summary: z.object({
    state: z.enum(['none', 'drafting', 'ready', 'failed']),
    text: z.string().nullable(),
    failure: z.string().nullable(),
    byAi: z.boolean(),
    /** Dollar amounts in it that nothing in the CMA supports: the agent checks them. */
    unsupportedAmounts: z.array(z.string()),
  }),
  fairHousing: z.object({
    /** Both checks have read the summary as it is now. */
    checked: z.boolean(),
    flags: z.array(FlagOut),
    acknowledged: z
      .object({ reason: z.string(), by: z.object({ id: uuid, fullName: z.string() }).nullable() })
      .nullable(),
  }),
  /** Why it can't be shared yet, when it can't. */
  shareBlocked: z.string().nullable(),
  finalizedAt: isoDateTime.nullable(),
  sharedAt: isoDateTime.nullable(),
  createdAt: isoDateTime,
});
export const CmasInput = z.object({ ...inDeal });
export const CmasOutput = z.object({
  cmas: z.array(
    z.object({
      id: uuid,
      number: z.number().int(),
      subjectAddress: z.string(),
      status: z.enum(CMA_STATUS_KEYS),
      likelyCents: z.number().int().nullable(),
      lowCents: z.number().int().nullable(),
      highCents: z.number().int().nullable(),
      comps: z.number().int(),
      createdAt: isoDateTime,
    }),
  ),
});
export const CmaGetOutput = z.object({ cma: CmaOut });
