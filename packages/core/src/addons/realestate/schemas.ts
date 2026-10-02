/**
 * Real Estate Agent's operations, as the API, the screens and the Assistant see them: every input checked here and
 * every answer's shape. Browser-safe.
 */
import { z } from 'zod';
import { CampaignAudience } from '../../schemas/campaign';
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
import {
  ALL_CLIENT_TASK_KIND_KEYS,
  CLIENT_TASK_KIND_KEYS,
  CLIENT_TASK_PRESET_KEYS,
} from './client-words';
import {
  CLIENT_PRIORITY_KEYS,
  FINANCING_STEP_KEYS,
  FINDING_ASK_KEYS,
  FINDING_SEVERITY_KEYS,
  INSPECTION_KIND_KEYS,
} from './closing';
import { FEED_STATUS_KEYS, MLS_STATE_KEYS, MlsSnapshotSchema } from './feed';
import { HOME_STATUS_KEYS, HOME_TYPE_KEYS, LISTING_FACT_KEYS } from './homes';
import { FACT_FROM_KEYS, LISTING_HOME_FACT_KEYS } from './listing';
import { SELLER_CHOICE_KEYS } from './net';
import { LOAN_TYPE_KEYS, OFFER_STATUS_KEYS } from './offer-words';
import { MEMORY_KIND_KEYS } from './memory';
import { DEAL_SIDES, DUTY_STATUSES } from './states';
import { CONTRACT_DATE_KEYS, CONTRACT_KEYS, READ_KINDS } from './contract-read';
import { CONTINGENCY_ENDINGS, CONTINGENCY_KIND_KEYS, CONTINGENCY_STATES } from './contingencies';
import { ESIGN_PROVIDER_KEYS, ESIGN_STATE_KEYS, SIGNER_STATE_KEYS } from './esign';
import { PRICE_FEEL_KEYS, SHOWING_SOURCE_KEYS, SHOWING_STATE_KEYS } from './showings';
import { TERM_KEYS } from './terms';
import { VENDOR_SERVICE_KEYS } from './vendors';
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
  /** Round four: one agent's deals, a stage, closing within so many days, or waiting on someone. */
  agentUserId: uuid.optional(),
  stage: z.string().max(40).optional(),
  closingWithinDays: z.number().int().min(0).max(365).optional(),
  waitingOn: z.enum(['outside', 'blocked', 'either']).optional(),
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
  /** Round four: the first thing it's waiting on outside, or blocked by. */
  waiting: z.object({ title: z.string(), who: z.string() }).nullable(),
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
      /** Round four: only what crosses the link: its health, its agent and its key dates. */
      stageLabel: z.string(),
      health: z.enum(['green', 'yellow', 'red']),
      agentName: z.string().nullable(),
      keyDates: z.array(
        z.object({ key: z.string(), label: z.string(), date: z.string(), confirmed: z.boolean() }),
      ),
      /** The person can open the other deal too. */
      canOpen: z.boolean(),
    }),
  ),
  /** Round four: what the linked deal breaks, from this deal's side. */
  linkedProblems: z.array(z.object({ words: z.string(), next: z.string() })),
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
    /** Waiting on someone: the day to chase them (round four); two business days on when not given. */
    chaseOn: localDate.optional(),
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
const WaitLine = z.object({
  dutyId: uuid,
  title: z.string(),
  status: z.enum(DUTY_STATUSES),
  accountableName: z.string().nullable(),
  dueAt: isoDateTime.nullable(),
  overdue: z.boolean(),
  /** Waiting on someone outside: who. */
  waitingOn: z.string().nullable(),
  /** In every deal; otherwise who said so. */
  builtIn: z.boolean(),
  addedByName: z.string().nullable(),
});
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
    /** Round four: waiting on someone outside since, and the day to chase them. */
    waitingSince: isoDateTime.nullable(),
    chaseAt: isoDateTime.nullable(),
    finishedAt: isoDateTime.nullable(),
    finishReason: z.string().nullable(),
    exception: z.boolean(),
    acknowledgedAt: isoDateTime.nullable(),
  }),
  /** Round four: what it waits on, what waits on it, and what moves if it slips. */
  waitsOn: z.array(WaitLine),
  waitingOnThis: z.array(WaitLine),
  ifItSlips: z.object({ waiting: z.array(z.string()), sameDate: z.array(z.string()) }),
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
      /** Round four: at risk for a business day with nobody acknowledging it, so the alert people hear too. */
      escalated: z.boolean(),
    }),
  ),
  /**
   * Round four: what else on a deal needs someone, each its own alert, cleared once it's gone: a contingency past its
   * end with nothing recorded, a blocker past its review, a wait past its chase, a linked deal that disagrees.
   */
  risks: z.array(
    z.object({
      dealId: uuid,
      key: z.string().regex(/^(contingency|blocker|chase|linked):[0-9a-f-]{36}$/),
      severity: z.enum(['attention', 'at_risk', 'critical']),
      title: z.string(),
      detail: z.string(),
      href: z.string(),
      audienceUserIds: z.array(uuid),
      assigneeUserId: uuid.nullable(),
      dueAt: isoDateTime.nullable(),
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
  /** Its MLS number, when the agent has it: the listing feed looks it up by that (round five). */
  mlsNumber: z.string().trim().min(1).max(80).optional(),
  note: optionalNote,
});
export const HomeAddOutput = z.object({
  homeId: uuid,
  /** The AI is reading the pasted text for its facts. */
  filling: z.boolean(),
  /** The listing feed is looking it up (round five). */
  looking: z.boolean().default(false),
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
/** What a listing feed said about a home, a listing or a comp, for the screens (round five). */
export const MlsOut = z.object({
  mlsNumber: z.string(),
  status: z.enum(FEED_STATUS_KEYS),
  statusWords: z.string(),
  /** "From the MLS (Unlock MLS, through Repliers)" */
  sourceWords: z.string(),
  listPriceCents: z.number().int().nullable(),
  soldPriceCents: z.number().int().nullable(),
  soldOn: z.string().nullable(),
  daysOnMarket: z.number().int().nullable(),
  facts: ListingFactsIn,
  photos: z.array(z.object({ url: z.string(), caption: z.string().nullable() })),
  description: z.string().nullable(),
  /** The facts where the feed and what's kept disagree, for a person to pick. */
  differs: z.array(z.enum(LISTING_FACT_KEYS)),
  display: z.object({
    notice: z.string().nullable(),
    logoUrl: z.string().nullable(),
    courtesy: z.string().nullable(),
  }),
  checkedAt: isoDateTime,
});

export const HomeLookupInput = z.object({
  workspaceId: uuid,
  homeId: uuid,
  /** Look it up by this MLS number rather than its address. */
  mlsNumber: z.string().trim().min(1).max(80).optional(),
});
export const HomeLookupOutput = z.object({ homeId: uuid, looking: z.literal(true) });

/** The worker: what the listing feed found for a home or a listing, or why it couldn't look. */
export const MlsFoundInput = z.object({
  workspaceId: uuid,
  /** A home's id, or a listing's deal. */
  homeId: uuid.optional(),
  dealId: uuid.optional(),
  listing: MlsSnapshotSchema.nullable(),
  /** No feed is connected (or HandsFreeOS's own account has no key here): back to as it was. */
  noFeed: z.boolean().default(false),
  failure: z.string().trim().min(1).max(500).optional(),
});
export const MlsFoundOutput = z.object({
  state: z.enum([...MLS_STATE_KEYS, 'skipped']),
  /** Facts the feed filled in that were empty. */
  filled: z.array(z.enum(LISTING_FACT_KEYS)),
});

export const ListingLookupInput = z.object({
  ...inDeal,
  mlsNumber: z.string().trim().min(1).max(80).optional(),
});
export const ListingLookupOutput = z.object({ dealId: uuid, looking: z.literal(true) });

export const CmaFindCompsInput = z.object({
  workspaceId: uuid,
  cmaId: uuid,
  /** How far from the home. */
  miles: z.number().min(0.25).max(10).default(1),
  /** Sold in the last this many months. */
  months: z.int().min(1).max(24).default(6),
});
export const CmaFindCompsOutput = z.object({ cmaId: uuid, finding: z.literal(true) });

/** The worker: sold homes the feed found near a CMA's home, or why it couldn't look. */
export const CmaCompsFoundInput = z.object({
  workspaceId: uuid,
  cmaId: uuid,
  comps: z
    .array(
      z.object({
        listing: MlsSnapshotSchema,
        distanceMiles: z.number().min(0).max(500).nullable(),
      }),
    )
    .max(40),
  noFeed: z.boolean().default(false),
  failure: z.string().trim().min(1).max(500).optional(),
});
export const CmaCompsFoundOutput = z.object({
  cmaId: uuid,
  state: z.enum(['none', 'found', 'none_found', 'failed', 'skipped']),
  added: z.int(),
});

export const HomeOut = z.object({
  id: uuid,
  address: z.string(),
  source: z.enum(['agent', 'client', 'mls', 'our_listing']),
  link: z.string().nullable(),
  status: z.enum(HOME_STATUS_KEYS),
  statusNote: z.string().nullable(),
  facts: ListingFactsIn,
  /** Each suggested fact's words in the pasted text, while the agent checks them. */
  factSources: z.record(z.string(), z.string()),
  factsState: z.enum(['none', 'filling', 'suggested', 'confirmed', 'failed']),
  factsFailure: z.string().nullable(),
  hasPastedText: z.boolean(),
  /** What the listing feed says about it (round five): null until it's been found there. */
  mls: MlsOut.nullable(),
  mlsState: z.enum(MLS_STATE_KEYS),
  /** Where looking it up stands, in words; null when there's nothing to say. */
  mlsWords: z.string().nullable(),
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
  /** Suggestions fair housing rules left out (about who lives there, or a protected class): how many, never what. */
  protectedDropped: z.number().int(),
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
  /** One of a buyer deal's homes; on a listing, left out (the CMA is for the listing's own home). */
  homeId: uuid.optional(),
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
  /** A comp from the feed (round five): its MLS number, first photo, and what its MLS asks to be shown with it. */
  mls: z
    .object({
      mlsNumber: z.string(),
      sourceWords: z.string(),
      photoUrl: z.string().nullable(),
      courtesy: z.string().nullable(),
      notice: z.string().nullable(),
    })
    .nullable(),
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
  /** Finding comps on the business's listing feed (round five). */
  findComps: z.object({
    state: z.enum(['none', 'finding', 'found', 'none_found', 'failed']),
    words: z.string().nullable(),
    asked: z.object({ miles: z.number(), months: z.number().int() }).nullable(),
    at: isoDateTime.nullable(),
  }),
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

// ---------- offers and counters (round two) ----------

const money0 = z.int().min(0).max(100_000_000_000);
export const OfferTermsIn = z
  .object({
    priceCents: z.int().min(1, 'Enter the price.').max(100_000_000_000),
    emdCents: money0.nullable().default(null),
    emdDays: z.int().min(0).max(60).nullable().default(null),
    sellerCreditCents: money0.default(0),
    inspectionDays: z.int().min(0).max(90).nullable().default(null),
    loanType: z.enum(LOAN_TYPE_KEYS).nullable().default(null),
    financingDays: z.int().min(0).max(120).nullable().default(null),
    appraisalContingency: z.boolean().nullable().default(null),
    closingDate: localDate.nullable().default(null),
    otherTerms: z
      .string()
      .trim()
      .max(2000, 'Keep it under 2,000 characters.')
      .nullable()
      .default(null),
    // Round three: what a seller weighs.
    downPaymentPct: z.number().min(0).max(100).nullable().default(null),
    homeSaleContingency: z.boolean().nullable().default(null),
    escalationCapCents: z.int().min(1).max(100_000_000_000).nullable().default(null),
    escalationStepCents: z.int().min(1).max(100_000_000_000).nullable().default(null),
    possession: z.string().trim().min(1).max(200).nullable().default(null),
    /** What the buyer's agent asks the seller to pay: a share of the price (basis points), or an amount. */
    buyerAgentFeeBp: z.int().min(0).max(10_000).nullable().default(null),
    buyerAgentFeeCents: money0.nullable().default(null),
  })
  .refine((t) => t.loanType !== 'cash' || t.financingDays === null, {
    error: 'A cash offer has no financing days.',
    path: ['financingDays'],
  })
  .refine((t) => t.buyerAgentFeeBp === null || t.buyerAgentFeeCents === null, {
    error: 'Give their agent’s fee as a share of the price or an amount, not both.',
    path: ['buyerAgentFeeCents'],
  });

const VersionIn = {
  terms: OfferTermsIn,
  /** The time it must be answered by. */
  respondBy: isoDateTime.nullable().optional(),
  /** When it was sent or came in; now when not given. */
  at: isoDateTime.optional(),
  /** The uploaded contract or counter it is: one of the deal's documents. */
  documentId: uuid.optional(),
  note: z.string().trim().max(1000).optional(),
};

export const OfferStartInput = z.object({
  ...inDeal,
  /** One of a buyer's homes; on a listing, left out (the offer is on the listing itself). */
  homeId: uuid.optional(),
  /** On a listing: who the buyers are. */
  buyerNames: z.string().trim().min(1).max(200).optional(),
  theirAgentName: z.string().trim().max(200).optional(),
  theirBrokerage: z.string().trim().max(200).optional(),
  theirEmail: z.email().max(320).optional(),
  theirPhone: z.string().trim().max(40).optional(),
  ...VersionIn,
});
export const OfferStartOutput = z.object({ offerId: uuid, versionId: uuid, number: z.int() });

export const OfferAddVersionInput = z.object({
  workspaceId: uuid,
  offerId: uuid,
  /** Ours (a counter, or a better offer), or the seller's counter. */
  side: z.enum(['us', 'them']),
  ...VersionIn,
});
export const OfferAddVersionOutput = z.object({
  offerId: uuid,
  versionId: uuid,
  number: z.int(),
  status: z.enum(OFFER_STATUS_KEYS),
});

export const OfferAttachDocumentInput = z.object({
  workspaceId: uuid,
  versionId: uuid,
  documentId: uuid,
});
export const OfferInput = z.object({ workspaceId: uuid, offerId: uuid });
export const OfferRespondInput = z.object({
  workspaceId: uuid,
  offerId: uuid,
  /** Accepted by them (our version) or by us (theirs); declined; or it passed with no answer. */
  outcome: z.enum(['accepted', 'declined', 'expired']),
  /** The version accepted; the newest when not given. */
  versionId: uuid.optional(),
  /** When it was accepted; now when not given. */
  at: isoDateTime.optional(),
  note: z.string().trim().max(500).optional(),
});
export const OfferWithdrawInput = z.object({ workspaceId: uuid, offerId: uuid, reason });
export const OfferChangeOutput = z.object({
  offerId: uuid,
  status: z.enum(OFFER_STATUS_KEYS),
  /** Accepted: the terms entered on the deal for a person to confirm. */
  termsEntered: z.int().default(0),
  /** The deal moved on (accepted) or back (lost). */
  dealStage: z.string().nullable().default(null),
});

const OfferSummaryOut = z.object({
  title: z.string(),
  note: z.string(),
  lines: z.array(z.object({ label: z.string(), value: z.string() })),
  next: z.string(),
});
const OfferVersionOut = z.object({
  id: uuid,
  number: z.int(),
  side: z.enum(['us', 'them']),
  at: isoDateTime,
  priceCents: z.number().int(),
  emdCents: z.number().int().nullable(),
  emdDays: z.number().int().nullable(),
  sellerCreditCents: z.number().int(),
  inspectionDays: z.number().int().nullable(),
  loanType: z.enum(LOAN_TYPE_KEYS).nullable(),
  financingDays: z.number().int().nullable(),
  appraisalContingency: z.boolean().nullable(),
  closingDate: z.string().nullable(),
  otherTerms: z.string().nullable(),
  downPaymentPct: z.number().nullable(),
  homeSaleContingency: z.boolean().nullable(),
  escalationCapCents: z.number().int().nullable(),
  escalationStepCents: z.number().int().nullable(),
  possession: z.string().nullable(),
  buyerAgentFeeBp: z.number().int().nullable(),
  buyerAgentFeeCents: z.number().int().nullable(),
  respondBy: isoDateTime.nullable(),
  note: z.string().nullable(),
  /** The uploaded document it is, as it stands now (its newest version). */
  document: z
    .object({ id: uuid, title: z.string(), status: z.string(), signed: z.boolean() })
    .nullable(),
});
export const OfferOut = z.object({
  id: uuid,
  number: z.int(),
  homeId: uuid.nullable(),
  buyerNames: z.string().nullable(),
  address: z.string(),
  status: z.enum(OFFER_STATUS_KEYS),
  theirAgentName: z.string().nullable(),
  theirBrokerage: z.string().nullable(),
  theirEmail: z.string().nullable(),
  theirPhone: z.string().nullable(),
  versions: z.array(OfferVersionOut),
  acceptedVersionId: uuid.nullable(),
  endedAt: isoDateTime.nullable(),
  endedReason: z.string().nullable(),
  /** Who answers next and by when, while it's open. */
  clock: z
    .object({
      waitingOn: z.enum(['them', 'us']),
      respondBy: isoDateTime.nullable(),
      words: z.string().nullable(),
    })
    .nullable(),
  shared: z.object({ versionId: uuid, at: isoDateTime, current: z.boolean() }).nullable(),
  /** The newest version's one-page summary, as the client would see it. */
  summary: OfferSummaryOut,
});
export const OffersInput = z.object({ ...inDeal });
export const OffersOutput = z.object({ offers: z.array(OfferOut) });

// ---------- financing, inspections and repairs (round two) ----------

export const FinancingInput = z.object({ ...inDeal });
export const FinancingSetLenderInput = z.object({
  ...inDeal,
  lenderName: z.string().trim().max(200).nullable().optional(),
  officerName: z.string().trim().max(200).nullable().optional(),
  officerEmail: z.email().max(320).nullable().optional(),
  officerPhone: z.string().trim().max(40).nullable().optional(),
  loanType: z.enum(LOAN_TYPE_KEYS).nullable().optional(),
  loanAmountCents: z.int().min(1).max(100_000_000_000).nullable().optional(),
});
const StepFields = {
  startedOn: localDate.nullable().optional(),
  expectedOn: localDate.nullable().optional(),
  amountCents: z.int().min(1).max(100_000_000_000).nullable().optional(),
  rate: z.number().min(0).max(30).nullable().optional(),
  expiresOn: localDate.nullable().optional(),
  note: z.string().trim().max(1000).nullable().optional(),
};
export const FinancingUpdateStepInput = z.object({
  ...inDeal,
  step: z.enum(FINANCING_STEP_KEYS),
  ...StepFields,
});
export const StepProof = z.object({ kind: z.enum(['document', 'file', 'message']), id: uuid });
export const FinancingMarkDoneInput = z.object({
  ...inDeal,
  step: z.enum(FINANCING_STEP_KEYS),
  /** When it was done; today when not given. */
  doneOn: localDate.optional(),
  /** The lender's letter or email, or one of the deal's documents. */
  proof: StepProof,
  ...StepFields,
});
export const FinancingReopenInput = z.object({
  ...inDeal,
  step: z.enum(FINANCING_STEP_KEYS),
  reason,
});
export const FinancingChangeOutput = z.object({
  dealId: uuid,
  step: z.enum(FINANCING_STEP_KEYS).nullable(),
  /** Dates entered on the deal from it (a rate lock's end, the Closing Disclosure received). */
  termsEntered: z.int().default(0),
});
export const FinancingOutput = z.object({
  lender: z.object({
    lenderName: z.string().nullable(),
    officerName: z.string().nullable(),
    officerEmail: z.string().nullable(),
    officerPhone: z.string().nullable(),
    loanType: z.enum(LOAN_TYPE_KEYS).nullable(),
    loanAmountCents: z.number().int().nullable(),
  }),
  closing: z.string().nullable(),
  /** The day the Closing Disclosure must reach the buyers by, once closing is known. */
  cdDeadline: z.string().nullable(),
  steps: z.array(
    z.object({
      step: z.enum(FINANCING_STEP_KEYS),
      label: z.string(),
      status: z.enum(['not_started', 'in_progress', 'done']),
      startedOn: z.string().nullable(),
      expectedOn: z.string().nullable(),
      doneOn: z.string().nullable(),
      amountCents: z.number().int().nullable(),
      rate: z.number().nullable(),
      expiresOn: z.string().nullable(),
      note: z.string().nullable(),
      proof: z
        .object({ kind: z.enum(['document', 'file', 'message']), id: uuid, label: z.string() })
        .nullable(),
      doneBy: z.object({ id: uuid, fullName: z.string() }).nullable(),
      line: z.string(),
      warning: z.string().nullable(),
    }),
  ),
});

export const InspectionAddInput = z.object({
  ...inDeal,
  kind: z.enum(INSPECTION_KIND_KEYS),
  inspector: z.string().trim().max(200).optional(),
  scheduledAt: isoDateTime.optional(),
  reportExpectedOn: localDate.optional(),
  note: z.string().trim().max(1000).optional(),
});
export const InspectionAddOutput = z.object({ inspectionId: uuid });
export const InspectionUpdateInput = z.object({
  workspaceId: uuid,
  inspectionId: uuid,
  inspector: z.string().trim().max(200).nullable().optional(),
  scheduledAt: isoDateTime.nullable().optional(),
  reportExpectedOn: localDate.nullable().optional(),
  note: z.string().trim().max(1000).nullable().optional(),
});
export const InspectionReportInInput = z.object({
  workspaceId: uuid,
  inspectionId: uuid,
  /** The report, uploaded as one of the deal's documents. */
  documentId: uuid.optional(),
  reportInOn: localDate.optional(),
  pages: z.int().min(1).max(2000).optional(),
});
export const InspectionCancelInput = z.object({ workspaceId: uuid, inspectionId: uuid, reason });
export const InspectionChangeOutput = z.object({
  inspectionId: uuid,
  status: z.enum(['scheduled', 'report_in', 'canceled']),
});

const FindingFields = {
  title: z.string().trim().min(1, 'Say what was found.').max(200),
  location: z.string().trim().max(200).nullable().optional(),
  severity: z.enum(FINDING_SEVERITY_KEYS),
  estimateCents: z.int().min(0).max(100_000_000_000).nullable().optional(),
  clientPriority: z.enum(CLIENT_PRIORITY_KEYS).nullable().optional(),
  ask: z.enum(FINDING_ASK_KEYS).optional(),
  creditCents: z.int().min(0).max(100_000_000_000).nullable().optional(),
  note: z.string().trim().max(1000).nullable().optional(),
};
export const FindingAddInput = z.object({
  workspaceId: uuid,
  inspectionId: uuid,
  ...FindingFields,
});
export const FindingAddOutput = z.object({ findingId: uuid });
export const FindingUpdateInput = z.object({
  workspaceId: uuid,
  findingId: uuid,
  ...FindingFields,
  title: FindingFields.title.optional(),
  severity: FindingFields.severity.optional(),
});
export const FindingRemoveInput = z.object({ workspaceId: uuid, findingId: uuid });
export const FindingChangeOutput = z.object({ findingId: uuid });

export const RepairSendInput = z.object({
  ...inDeal,
  /** The request's words, as sent (the draft, edited). */
  words: z.string().trim().min(1, 'Write the request.').max(4000),
  /** The findings it asks about; the draft's when not given. */
  findingIds: z.array(uuid).max(100).optional(),
  respondBy: isoDateTime.nullable().optional(),
  at: isoDateTime.optional(),
  note: z.string().trim().max(1000).optional(),
});
export const RepairAnswerInput = z.object({
  ...inDeal,
  outcome: z.enum(['agreed', 'countered', 'refused']),
  /** The seller's answer in words: what they'll do. */
  words: z.string().trim().min(1, 'Say what the seller answered.').max(4000),
  creditCents: z.int().min(0).max(100_000_000_000).optional(),
  respondBy: isoDateTime.nullable().optional(),
  at: isoDateTime.optional(),
  note: z.string().trim().max(1000).optional(),
  /** The signed answer (a repair agreement or an amendment), one of the deal's documents. */
  documentId: uuid.optional(),
});
/** On a listing: the buyers' repair request, as it came in. */
export const RepairReceiveInput = z.object({
  ...inDeal,
  words: z.string().trim().min(1, 'Write what the buyers ask for.').max(4000),
  /** A credit they ask for instead of, or as well as, repairs. */
  creditCents: z.int().min(0).max(100_000_000_000).optional(),
  respondBy: isoDateTime.nullable().optional(),
  at: isoDateTime.optional(),
  note: z.string().trim().max(1000).optional(),
  /** Their request as a document on the deal. */
  documentId: uuid.optional(),
});
export const RepairChangeOutput = z.object({
  dealId: uuid,
  repairId: uuid,
  number: z.int(),
  /** Duties that came with it (repairs agreed). */
  dutiesCreated: z.int().default(0),
});
export const InspectionsInput = z.object({ ...inDeal });
const FindingOut = z.object({
  id: uuid,
  title: z.string(),
  location: z.string().nullable(),
  severity: z.enum(FINDING_SEVERITY_KEYS),
  estimateCents: z.number().int().nullable(),
  clientPriority: z.enum(CLIENT_PRIORITY_KEYS).nullable(),
  ask: z.enum(FINDING_ASK_KEYS),
  creditCents: z.number().int().nullable(),
  note: z.string().nullable(),
});
export const InspectionsOutput = z.object({
  /** When the inspection period ends, from the deal's key dates. */
  periodEnds: z.string().nullable(),
  inspections: z.array(
    z.object({
      id: uuid,
      kind: z.enum(INSPECTION_KIND_KEYS),
      label: z.string(),
      inspector: z.string().nullable(),
      scheduledAt: isoDateTime.nullable(),
      reportExpectedOn: z.string().nullable(),
      status: z.enum(['scheduled', 'report_in', 'canceled']),
      reportDocument: z.object({ id: uuid, title: z.string() }).nullable(),
      reportInOn: z.string().nullable(),
      pages: z.number().int().nullable(),
      note: z.string().nullable(),
      findings: z.array(FindingOut),
    }),
  ),
  repairs: z.array(
    z.object({
      id: uuid,
      number: z.number().int(),
      side: z.enum(['us', 'them']),
      at: isoDateTime,
      words: z.string(),
      creditCents: z.number().int(),
      respondBy: isoDateTime.nullable(),
      outcome: z.enum(['agreed', 'countered', 'refused']).nullable(),
      items: z.array(
        z.object({
          findingId: uuid,
          title: z.string(),
          ask: z.string(),
          creditCents: z.number().int().nullable(),
        }),
      ),
    }),
  ),
  /** The request as the findings would draft it now. */
  draft: z.object({ words: z.string(), creditCents: z.number().int(), items: z.number().int() }),
});

// ---------- the client's tasks and portal (round two) ----------

export const ClientTaskAddInput = z
  .object({
    ...inDeal,
    /** One of the usual tasks, ready made; its words can still be changed below. */
    preset: z.enum(CLIENT_TASK_PRESET_KEYS).optional(),
    kind: z.enum(CLIENT_TASK_KIND_KEYS).optional(),
    title: z.string().trim().min(1).max(200).optional(),
    detail: z.string().trim().max(2000).optional(),
    signOffWords: z.string().trim().min(1).max(2000).optional(),
    /** One client's; every client's on the deal when not given. */
    forPersonId: uuid.optional(),
    dueOn: localDate.optional(),
    /** An upload becomes one of the deal's documents of this kind. */
    documentKind: z.enum(DOCUMENT_KIND_KEYS).optional(),
  })
  .refine((i) => !!i.preset || (!!i.kind && !!i.title), {
    error: 'Pick one of the usual tasks, or say what kind it is and give it a title.',
    path: ['title'],
  });
export const ClientTaskAddOutput = z.object({ taskId: uuid });
export const ClientTaskCancelInput = z.object({ workspaceId: uuid, taskId: uuid, reason });
export const ClientTaskMarkDoneInput = z.object({
  workspaceId: uuid,
  taskId: uuid,
  /** The client it was done for. */
  personId: uuid,
  note: z.string().trim().min(1, 'Say how it was done.').max(500),
  fileId: uuid.optional(),
});
export const ClientTaskChangeOutput = z.object({
  taskId: uuid,
  status: z.enum(['open', 'done', 'canceled']),
});
const ClientTaskOut = z.object({
  id: uuid,
  kind: z.enum(ALL_CLIENT_TASK_KIND_KEYS),
  title: z.string(),
  detail: z.string().nullable(),
  signOffWords: z.string().nullable(),
  forPersonId: uuid.nullable(),
  dueOn: z.string().nullable(),
  status: z.enum(['open', 'done', 'canceled']),
  doneAt: isoDateTime.nullable(),
  /** "Waiting on Tuan", while it's open. */
  waiting: z.string().nullable(),
  completions: z.array(
    z.object({
      personId: uuid,
      name: z.string(),
      at: isoDateTime,
      file: z.object({ id: uuid, name: z.string() }).nullable(),
      signedWords: z.string().nullable(),
      /** Marked done by someone on the team, with their note. */
      recordedBy: z.object({ id: uuid, fullName: z.string() }).nullable(),
      note: z.string().nullable(),
    }),
  ),
});
export const ClientTasksInput = z.object({
  ...inDeal,
  includeCanceled: z.boolean().default(false),
});
export const ClientTasksOutput = z.object({
  tasks: z.array(ClientTaskOut),
  /** The deal's clients, and whether each has the portal. */
  clients: z.array(
    z.object({
      personId: uuid,
      name: z.string(),
      email: z.string().nullable(),
      portal: z.enum(['none', 'invited', 'signed_in', 'revoked']),
      /** When they were let in, while they're in. */
      portalSince: isoDateTime.nullable(),
    }),
  ),
});

// The portal's own (customer) operations.

export const PortalDealsInput = z.object({ workspaceId: uuid });
const PortalKeyDate = z.object({
  key: z.string(),
  label: z.string(),
  date: z.string(),
  time: z.string().nullable(),
});
export const PortalDealsOutput = z.object({
  deals: z.array(
    z.object({
      dealId: uuid,
      name: z.string(),
      side: z.enum(DEAL_SIDES),
      stage: z.string(),
      step: z.number().int(),
      steps: z.array(z.string()),
      agentName: z.string().nullable(),
      nextDate: PortalKeyDate.nullable(),
      openTasks: z.number().int(),
      closed: z.boolean(),
    }),
  ),
});
export const PortalDealInput = z.object({ workspaceId: uuid, dealId: uuid });
export const PortalDealOutput = z.object({
  deal: z.object({
    dealId: uuid,
    name: z.string(),
    side: z.enum(DEAL_SIDES),
    stage: z.string(),
    step: z.number().int(),
    steps: z.array(z.string()),
    agentName: z.string().nullable(),
    closed: z.boolean(),
  }),
  keyDates: z.array(PortalKeyDate),
  /** Round four: their contingencies, when each ends and how each ended. */
  contingencies: z.array(
    z.object({
      id: uuid,
      label: z.string(),
      meaning: z.string(),
      state: z.enum(['open', 'satisfied', 'waived', 'expired']),
      endsOn: z.string().nullable(),
      words: z.string(),
    }),
  ),
  tasks: z.array(ClientTaskOut.omit({ completions: true }).extend({ mine: z.boolean() })),
  homes: z.array(
    z.object({
      id: uuid,
      address: z.string(),
      link: z.string().nullable(),
      facts: z.record(z.string(), z.unknown()),
      status: z.string(),
      /** What the MLS says of it, with its MLS's notice (round five); null when the feed hasn't brought it. */
      mls: z
        .object({
          statusWords: z.string().nullable(),
          listPriceCents: z.number().int().nullable(),
          photos: z.array(z.object({ url: z.string(), caption: z.string().nullable() })),
          description: z.string().nullable(),
          courtesy: z.string().nullable(),
          notice: z.string().nullable(),
          logoUrl: z.string().nullable(),
        })
        .nullable(),
      addedByMe: z.boolean(),
      mine: z.enum(['saved', 'passed']).nullable(),
      others: z.array(z.object({ name: z.string(), reaction: z.enum(['saved', 'passed']) })),
    }),
  ),
  tours: z.array(
    z.object({
      id: uuid,
      status: z.string(),
      startsAt: isoDateTime,
      endsAt: isoDateTime,
      stops: z.array(
        z.object({
          id: uuid,
          homeId: uuid,
          address: z.string(),
          position: z.number().int(),
          status: z.string(),
          myFeedback: z
            .object({
              interest: z.string(),
              rating: z.number().int().nullable(),
              words: z.string().nullable(),
            })
            .nullable(),
        }),
      ),
    }),
  ),
  cmas: z.array(
    z.object({
      id: uuid,
      address: z.string(),
      lowCents: z.number().int(),
      likelyCents: z.number().int(),
      highCents: z.number().int(),
      summary: z.string().nullable(),
      sharedAt: isoDateTime,
    }),
  ),
  offers: z.array(
    z.object({
      id: uuid,
      address: z.string(),
      status: z.string(),
      summary: z.object({
        title: z.string(),
        note: z.string(),
        lines: z.array(z.object({ label: z.string(), value: z.string() })),
        next: z.string(),
      }),
    }),
  ),
  financing: z.array(
    z.object({
      step: z.string(),
      label: z.string(),
      status: z.string(),
      date: z.string().nullable(),
    }),
  ),
});

export const PortalHomeAddInput = z.object({
  workspaceId: uuid,
  dealId: uuid,
  address: z.string().trim().min(3, 'Enter the home’s address.').max(300),
  link: z
    .string()
    .trim()
    .max(2000)
    .regex(/^https?:\/\//i, { error: 'Paste the whole link, starting with https://' })
    .optional(),
  note: z.string().trim().max(1000).optional(),
});
export const PortalHomeAddOutput = z.object({ homeId: uuid });
export const PortalHomeReactInput = z.object({
  workspaceId: uuid,
  homeId: uuid,
  reaction: z.enum(['saved', 'passed']),
  note: z.string().trim().max(1000).optional(),
});
export const PortalHomeReactOutput = z.object({
  homeId: uuid,
  reaction: z.enum(['saved', 'passed']),
});
export const PortalTourFeedbackInput = z.object({
  workspaceId: uuid,
  stopId: uuid,
  interest: z.enum(TOUR_INTEREST_KEYS),
  rating: z.int().min(1).max(5).nullable().optional(),
  words: z.string().trim().max(2000).optional(),
});
export const PortalTourFeedbackOutput = z.object({ feedbackId: uuid });
export const PortalTaskCompleteInput = z.object({
  workspaceId: uuid,
  taskId: uuid,
  /** A sign-off: the words as the client read them; they must be the task's own. */
  signedWords: z.string().max(2000).optional(),
});
export const PortalTaskAttachInput = z.object({ workspaceId: uuid, taskId: uuid, fileId: uuid });
export const PortalTaskOutput = z.object({
  taskId: uuid,
  status: z.enum(['open', 'done', 'canceled']),
});

// ---------- round three: the listing ----------

/** A listing's own facts: a home's, without a price (the list price is the deal's `list_price`). */
export const ListingHomeFactsIn = ListingFactsIn.omit({ price_cents: true });

export const ListingInput = z.object({ ...inDeal });

export const ListingPasteInput = z.object({
  ...inDeal,
  /** The old listing's words: the AI finds the home's facts in them, each with its words, for the agent to confirm. */
  text: z
    .string()
    .trim()
    .min(20, 'Paste the old listing’s words, at least a sentence.')
    .max(20_000, 'Paste up to 20,000 characters of the listing.'),
});
export const ListingPasteOutput = z.object({ dealId: uuid, filling: z.boolean() });

export const ListingFillFactsInput = z.object({
  workspaceId: uuid,
  dealId: uuid,
  facts: ListingHomeFactsIn.default({}),
  /** Each fact's words in the pasted text. */
  sources: z.record(z.string(), z.string().max(300)).default({}),
  dropped: z.number().int().min(0).default(0),
  model: z.string().max(100).optional(),
  /** Why it couldn't be read, instead. */
  failure: z.string().max(500).optional(),
});
export const ListingFillFactsOutput = z.object({
  dealId: uuid,
  state: z.enum(['read', 'failed', 'skipped']),
});

export const ListingConfirmFactsInput = z.object({
  ...inDeal,
  facts: ListingHomeFactsIn,
  /** Where each one came from; anything not named was typed by the agent. */
  sources: z.partialRecord(z.enum(LISTING_HOME_FACT_KEYS), z.enum(FACT_FROM_KEYS)).default({}),
  /** The agent's notes for the description: what's been updated, what stands out. */
  highlights: z.string().trim().max(2000, 'Keep it under 2,000 characters.').nullable().optional(),
});
export const ListingConfirmFactsOutput = z.object({ dealId: uuid, confirmedAt: isoDateTime });

export const ListingPhotoAddInput = z.object({
  ...inDeal,
  /** One of the deal's files: a photo already uploaded to it. */
  fileId: uuid,
  caption: z.string().trim().max(120, 'Keep a caption under 120 characters.').optional(),
  public: z.boolean().default(true),
});
export const ListingPhotosArrangeInput = z.object({
  ...inDeal,
  /** Every photo, in the order they're shown, with its caption and whether the page shows it. */
  photos: z
    .array(
      z.object({
        id: uuid,
        caption: z.string().trim().max(120, 'Keep a caption under 120 characters.').nullable(),
        public: z.boolean(),
      }),
    )
    .max(100),
});
export const ListingPhotoRemoveInput = z.object({ ...inDeal, photoId: uuid });
export const ListingPhotosOutput = z.object({ dealId: uuid, photos: z.number().int() });

export const ListingQuestionnaireRequestInput = z.object({
  ...inDeal,
  /** One seller; left out, every seller on the deal fills in the one questionnaire. */
  forPersonId: uuid.optional(),
});
export const ListingQuestionnaireRequestOutput = z.object({ taskId: uuid, created: z.boolean() });

const FactCandidateOut = z.object({
  from: z.enum(FACT_FROM_KEYS),
  value: z.unknown(),
  quote: z.string().nullable(),
  words: z.string(),
});
export const ListingOut = z.object({
  dealId: uuid,
  address: z.string().nullable(),
  street: z.string().nullable(),
  facts: ListingHomeFactsIn,
  factsConfirmedAt: isoDateTime.nullable(),
  factsConfirmedBy: z.object({ id: uuid, fullName: z.string() }).nullable(),
  /** Each fact: what's confirmed, what the seller and the old listing say, and whether they disagree. */
  choices: z.array(
    z.object({
      key: z.enum(LISTING_HOME_FACT_KEYS),
      label: z.string(),
      confirmed: FactCandidateOut.nullable(),
      candidates: z.array(FactCandidateOut),
      disagree: z.boolean(),
    }),
  ),
  pasted: z.object({
    state: z.enum(['none', 'filling', 'read', 'failed']),
    failure: z.string().nullable(),
    found: z.number().int(),
  }),
  highlights: z.string().nullable(),
  questionnaire: z.object({
    state: z.enum(['none', 'asked', 'draft', 'submitted']),
    taskId: uuid.nullable(),
    submittedAt: isoDateTime.nullable(),
    updates: z.string().nullable(),
    loves: z.string().nullable(),
  }),
  photos: z.array(
    z.object({
      id: uuid,
      fileId: uuid,
      name: z.string(),
      position: z.number().int(),
      caption: z.string().nullable(),
      public: z.boolean(),
    }),
  ),
  /** Live on the MLS: nothing public goes before it. */
  mls: z.object({ number: z.string(), liveOn: z.string() }).nullable(),
  /** The listing as the business's feed has it (round five): looked up, and what it says. */
  feed: z.object({
    state: z.enum(MLS_STATE_KEYS),
    words: z.string().nullable(),
    mls: MlsOut.nullable(),
    /** Where the MLS and the deal disagree (its price or where it stands), for a person to fix. */
    differences: z.array(z.object({ key: z.enum(['price', 'status']), words: z.string() })),
  }),
  page: z.object({
    state: z.enum(['none', 'published', 'down']),
    slug: z.string().nullable(),
    publishedAt: isoDateTime.nullable(),
  }),
  /** The deal's list price now, if it has one. */
  listPriceCents: z.number().int().nullable(),
  /** How many of the business's buyers it was suggested to, and how many added it; never who. */
  matches: z.object({
    suggested: z.number().int(),
    added: z.number().int(),
    at: isoDateTime.nullable(),
  }),
  /** The description: the one signed off and in use, and the one being worked on. */
  description: z.object({
    inUse: z
      .object({
        id: uuid,
        version: z.number().int(),
        words: z.string(),
        signedAt: isoDateTime,
        /** Signed by the seller in their portal, or let through by an owner or admin with a reason. */
        how: z.enum(['portal', 'let_through']),
        reason: z.string().nullable(),
      })
      .nullable(),
    working: z
      .object({
        id: uuid,
        version: z.number().int(),
        words: z.string().nullable(),
        source: z.enum(['ai', 'person']),
        state: z.enum(['drafting', 'ready', 'failed', 'sent']),
        failure: z.string().nullable(),
        flags: z.array(FlagOut),
        checked: z.object({ words: z.boolean(), model: z.boolean() }),
        acknowledged: z.object({ reason: z.string(), at: isoDateTime }).nullable(),
        sentAt: isoDateTime.nullable(),
        /** Why it can't be sent yet, in words; null when it can. */
        blocked: z.object({ rule: z.string(), words: z.string() }).nullable(),
      })
      .nullable(),
    /** Earlier versions, newest first: who wrote each and what became of it. */
    history: z.array(
      z.object({
        id: uuid,
        version: z.number().int(),
        source: z.enum(['ai', 'person']),
        state: z.enum(['drafting', 'ready', 'failed', 'sent', 'signed', 'replaced']),
        words: z.string().nullable(),
        at: isoDateTime,
      }),
    ),
  }),
  /** Whether this person may let a description or a price through without the seller's sign-off. */
  can: z.object({ letThrough: z.boolean() }),
});
export const ListingOutput = z.object({ listing: ListingOut });

// ---------- the listing's description (round three, step 4) ----------

export const ListingDescriptionRequestInput = z.object({ ...inDeal });
export const ListingDescriptionSaveInput = z.object({
  ...inDeal,
  words: z
    .string()
    .trim()
    .min(40, 'Write at least a sentence or two.')
    .max(2000, 'Keep it under 2,000 characters: the seller signs off these exact words.'),
});
export const ListingDescriptionRef = z.object({ workspaceId: uuid, descriptionId: uuid });
export const ListingDescriptionAcknowledgeInput = z.object({
  workspaceId: uuid,
  descriptionId: uuid,
  reason,
});
export const ListingDescriptionLetThroughInput = z.object({
  workspaceId: uuid,
  descriptionId: uuid,
  /** Why the seller's sign-off in the portal isn't needed: "Maria signed it on paper at the office". */
  reason,
});
export const ListingDescriptionDraftedInput = z.object({
  workspaceId: uuid,
  descriptionId: uuid,
  words: z.string().max(6000).optional(),
  model: z.string().max(100).optional(),
  failure: z.string().max(2000).optional(),
  checks: z.array(CheckIn).max(2).default([]),
});
export const ListingDescriptionCheckedInput = z.object({
  workspaceId: uuid,
  descriptionId: uuid,
  textHash: z.string().regex(/^[0-9a-f]{64}$/),
  version: z.string().min(1).max(100),
  status: z.enum(['passed', 'flagged', 'unavailable']),
  flags: z.array(FlagOut).max(50),
});
export const ListingDescriptionOutput = z.object({
  descriptionId: uuid,
  version: z.number().int(),
  state: z.enum(['drafting', 'ready', 'failed', 'sent', 'signed', 'replaced']),
  /** What the fixed list found in the words, at once. */
  flags: z.array(FlagOut).default([]),
});

// ---------- live on the MLS, and marketing (round three, steps 5 and 6) ----------

export const ListingMarkLiveInput = z.object({
  ...inDeal,
  mlsNumber: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9-]{1,30}$/, 'Enter the MLS number as the MLS shows it, like 4821937.'),
  liveOn: localDate,
  /** The MLS page, uploaded to the deal's documents: proof for "Enter listing into MLS". */
  documentId: uuid.optional(),
});
export const ListingMarkLiveOutput = z.object({
  dealId: uuid,
  liveOn: z.string(),
  /** The stage it moved to, if it was before Active. */
  movedTo: z.string().nullable(),
});

export const ListingPageOutput = z.object({
  dealId: uuid,
  state: z.enum(['none', 'published', 'down']),
  site: z.string().nullable(),
  slug: z.string().nullable(),
  /** `/a/<site>/realestate/<slug>`, on HandsFreeOS's address or the business's own. */
  path: z.string().nullable(),
});

const FactWordsOut = z.object({ label: z.string(), words: z.string() });
export const ListingFlyerOutput = z.object({
  street: z.string(),
  cityLine: z.string().nullable(),
  priceCents: z.number().int().nullable(),
  facts: z.array(FactWordsOut),
  description: z.string(),
  photos: z.array(z.object({ fileId: uuid, caption: z.string().nullable() })),
  agentName: z.string().nullable(),
  mlsNumber: z.string(),
  /** The public page, for the flyer's QR code, once it's published. */
  page: z.object({ site: z.string(), slug: z.string(), path: z.string() }).nullable(),
});

export const ListingCampaignInput = z.object({
  ...inDeal,
  channel: z.enum(['sms', 'email']),
  audience: CampaignAudience,
  /** The listing's public page as the person sees it (their address for it), for the words to link to. */
  pageUrl: z.string().trim().max(500).url('That isn’t a link.'),
});
export const ListingCampaignOutput = z.object({
  campaignId: uuid,
  recipients: z.number().int(),
  skipped: z.number().int(),
});

// ---------- the public page (round three, step 6) ----------

export const PublicListingInput = z.object({ workspaceId: uuid, slug: z.string().trim().max(80) });
export const PublicListingOutput = z.object({
  slug: z.string(),
  street: z.string(),
  cityLine: z.string().nullable(),
  status: z.enum(['for_sale', 'under_contract', 'sold']),
  priceCents: z.number().int().nullable(),
  facts: z.array(FactWordsOut),
  description: z.string().nullable(),
  /** The worker adds each photo's `url`, good for an hour. */
  photos: z.array(z.object({ publicFileId: uuid, caption: z.string().nullable() })),
  openHouses: z.array(
    z.object({ id: uuid, startsAt: isoDateTime, endsAt: isoDateTime, signInOpen: z.boolean() }),
  ),
  agentName: z.string().nullable(),
  mlsNumber: z.string(),
});

export const PublicListingAskInput = z
  .object({
    workspaceId: uuid,
    slug: z.string().trim().max(80),
    firstName: z.string().trim().min(1, 'Enter your first name.').max(80),
    lastName: z.string().trim().max(80).default(''),
    email: z.string().trim().max(254).email('That doesn’t look like an email address.').optional(),
    phone: z.string().trim().max(40).optional(),
    question: z
      .string()
      .trim()
      .min(2, 'Ask your question.')
      .max(1000, 'Keep it under 1,000 characters.'),
    /** They ticked "Text me about this home and others like it". */
    smsConsent: z.boolean().default(false),
  })
  .refine((i) => !!i.email || !!i.phone, {
    error: 'Leave an email or a phone number, so the agent can answer.',
    path: ['email'],
  });
export const PublicListingAskOutput = z.object({ sent: z.literal(true) });

// ---------- the marketing page, and social posts (round three, step 6) ----------

const PostOut = z.object({
  id: uuid,
  position: z.number().int(),
  words: z.string().nullable(),
  flags: z.array(FlagOut),
  checked: z.object({ words: z.boolean(), model: z.boolean() }),
  edited: z.boolean(),
});
export const ListingMarketingOutput = z.object({
  dealId: uuid,
  /** Live on the MLS; until then, why nothing public goes (the hold). */
  mls: z.object({ number: z.string(), liveOn: z.string() }).nullable(),
  hold: z.string().nullable(),
  page: ListingPageOutput,
  /** What's still missing before the page, the flyer or a campaign can go. */
  ready: z.object({ facts: z.boolean(), description: z.boolean(), photos: z.number().int() }),
  posts: z.object({
    state: z.enum(['none', 'drafting', 'ready', 'failed']),
    failure: z.string().nullable(),
    items: z.array(PostOut),
  }),
});

export const ListingPostsRequestInput = z.object({ ...inDeal });
export const ListingPostsOutput = z.object({
  dealId: uuid,
  batch: z.number().int(),
  state: z.enum(['drafting', 'ready', 'failed']),
});
export const ListingPostsDraftedInput = z.object({
  workspaceId: uuid,
  dealId: uuid,
  batch: z.number().int().min(1),
  posts: z
    .array(z.object({ words: z.string().max(1000), checks: z.array(CheckIn).max(2) }))
    .max(3)
    .default([]),
  model: z.string().max(100).optional(),
  failure: z.string().max(2000).optional(),
});
export const ListingPostSaveInput = z.object({
  workspaceId: uuid,
  postId: uuid,
  words: z
    .string()
    .trim()
    .min(1, 'Write the post.')
    .max(1000, 'Keep a post under 1,000 characters.'),
});
export const ListingPostCheckedInput = z.object({
  workspaceId: uuid,
  postId: uuid,
  textHash: z.string().regex(/^[0-9a-f]{64}$/),
  version: z.string().min(1).max(100),
  status: z.enum(['passed', 'flagged', 'unavailable']),
  flags: z.array(FlagOut).max(50),
});
export const ListingPostOutput = z.object({ postId: uuid, flags: z.array(FlagOut) });

// ---------- open houses (round three, step 7) ----------

export const OpenHousePlanInput = z.object({
  ...inDeal,
  startsAt: isoDateTime,
  durationMinutes: z
    .number()
    .int()
    .min(30, 'An open house is at least half an hour.')
    .max(720)
    .default(180),
  /** Who hosts it; the person planning it when left out. */
  hostUserId: uuid.optional(),
  /** The calendar it goes on: the one tours go on (Settings → Real Estate) when left out. */
  calendarId: uuid.optional(),
  acknowledgeWarnings: z.boolean().default(false),
});
export const OpenHousePlanOutput = z.object({
  openHouseId: uuid,
  appointmentId: uuid,
  startsAt: isoDateTime,
  endsAt: isoDateTime,
  warnings: z.array(z.object({ code: z.string(), message: z.string() })),
});
export const OpenHouseCancelInput = z.object({
  workspaceId: uuid,
  openHouseId: uuid,
  reason: z.string().trim().max(500).optional(),
});
export const OpenHouseChangeOutput = z.object({
  openHouseId: uuid,
  state: z.enum(['planned', 'cancelled']),
});
export const OpenHouseFollowUpInput = z.object({
  workspaceId: uuid,
  visitorId: uuid,
  note: z.string().trim().max(500).optional(),
});
export const OpenHouseFollowUpOutput = z.object({ visitorId: uuid, followedUpAt: isoDateTime });

export const OpenHousesOutput = z.object({
  dealId: uuid,
  /** Live on the MLS: the sign-in page opens only once it is. */
  live: z.boolean(),
  openHouses: z.array(
    z.object({
      id: uuid,
      startsAt: isoDateTime,
      endsAt: isoDateTime,
      state: z.enum(['planned', 'cancelled']),
      host: z.object({ id: uuid, fullName: z.string() }).nullable(),
      /** The sign-in page under the business's site, once it has a public address and the listing is live. */
      signInPath: z.string().nullable(),
      visitors: z.array(
        z.object({
          id: uuid,
          firstName: z.string(),
          lastName: z.string().nullable(),
          email: z.string().nullable(),
          phone: z.string().nullable(),
          withAgent: z.boolean(),
          agentName: z.string().nullable(),
          smsConsent: z.boolean(),
          signedInAt: isoDateTime,
          personId: uuid.nullable(),
          followedUpAt: isoDateTime.nullable(),
        }),
      ),
    }),
  ),
});

export const PublicOpenHouseInput = z.object({
  workspaceId: uuid,
  slug: z.string().trim().max(80),
  openHouseId: uuid,
});
export const PublicOpenHouseOutput = z.object({
  street: z.string(),
  cityLine: z.string().nullable(),
  startsAt: isoDateTime,
  endsAt: isoDateTime,
  hostName: z.string().nullable(),
  /** Sign-in is open from an hour before to an hour after. */
  opensAt: isoDateTime,
  closesAt: isoDateTime,
  open: z.boolean(),
  cancelled: z.boolean(),
  photo: z.object({ publicFileId: uuid }).nullable(),
});
export const PublicOpenHouseSignInInput = z
  .object({
    workspaceId: uuid,
    slug: z.string().trim().max(80),
    openHouseId: uuid,
    firstName: z.string().trim().min(1, 'Enter your first name.').max(80),
    lastName: z.string().trim().max(80).default(''),
    email: z.string().trim().max(254).email('That doesn’t look like an email address.').optional(),
    phone: z.string().trim().max(40).optional(),
    withAgent: z.boolean().default(false),
    agentName: z.string().trim().max(160).optional(),
    /** They ticked "Text me about this home and others like it". */
    smsConsent: z.boolean().default(false),
  })
  .refine((i) => !!i.email || !!i.phone, {
    error: 'Leave an email or a phone number.',
    path: ['email'],
  });
export const PublicOpenHouseSignInOutput = z.object({
  signedIn: z.literal(true),
  firstName: z.string(),
});

// ---------- offers on a listing, side by side (round three, step 8) ----------

export const NetSheetSaveInput = z
  .object({
    ...inDeal,
    payoffCents: money0.default(0),
    /** The listing's fee: a share of the price (basis points), or an amount. */
    listingFeeBp: z.int().min(0).max(10_000).nullable().default(null),
    listingFeeCents: money0.nullable().default(null),
    titleEscrowCents: money0.default(0),
    transferTaxBp: z.int().min(0).max(10_000).default(0),
    otherCents: money0.default(0),
    otherNote: z.string().trim().max(300).nullable().default(null),
    note: z.string().trim().max(500).nullable().default(null),
  })
  .refine((f) => f.listingFeeBp === null || f.listingFeeCents === null, {
    error: 'Give the listing fee as a share of the price or an amount, not both.',
    path: ['listingFeeCents'],
  });
const NetFiguresOut = z.object({
  version: z.number().int(),
  payoffCents: z.number().int(),
  listingFeeBp: z.number().int().nullable(),
  listingFeeCents: z.number().int().nullable(),
  titleEscrowCents: z.number().int(),
  transferTaxBp: z.number().int(),
  otherCents: z.number().int(),
  otherNote: z.string().nullable(),
  note: z.string().nullable(),
  savedAt: isoDateTime,
  savedBy: z.object({ id: uuid, fullName: z.string() }).nullable(),
});
export const NetSheetSaveOutput = z.object({ dealId: uuid, version: z.number().int() });
const NetLineOut = z.object({ key: z.string(), label: z.string(), cents: z.number().int() });
const CompareRow = z.object({
  offerId: uuid,
  number: z.number().int(),
  buyers: z.string().nullable(),
  agent: z.string().nullable(),
  brokerage: z.string().nullable(),
  status: z.enum(OFFER_STATUS_KEYS),
  versionId: uuid,
  versionNumber: z.number().int(),
  priceCents: z.number().int(),
  /** "Cash", "Conventional · 20% down". */
  paying: z.string(),
  emdCents: z.number().int().nullable(),
  sellerCreditCents: z.number().int(),
  buyerAgentFee: z.string().nullable(),
  inspection: z.string().nullable(),
  financing: z.string().nullable(),
  homeSale: z.boolean().nullable(),
  escalation: z.string().nullable(),
  closingDate: z.string().nullable(),
  possession: z.string().nullable(),
  respondBy: isoDateTime.nullable(),
  net: z.object({ lines: z.array(NetLineOut), netCents: z.number().int() }),
  /** The most the seller would take home of these. */
  best: z.boolean(),
});
export const OffersCompareOutput = z.object({
  dealId: uuid,
  figures: NetFiguresOut.nullable(),
  /** The figures before, newest first. */
  figureHistory: z.array(NetFiguresOut),
  rows: z.array(CompareRow),
  shared: z.object({ comparisonId: uuid, at: isoDateTime }).nullable(),
  choices: z.array(
    z.object({
      offerId: uuid,
      name: z.string(),
      choice: z.enum(SELLER_CHOICE_KEYS),
      words: z.string().nullable(),
      at: isoDateTime,
    }),
  ),
});
export const OffersShareComparisonOutput = z.object({
  comparisonId: uuid,
  offers: z.number().int(),
});
export const PortalOfferChoiceInput = z.object({
  workspaceId: uuid,
  comparisonId: uuid,
  offerId: uuid,
  choice: z.enum(SELLER_CHOICE_KEYS),
  words: z.string().trim().max(1000, 'Keep it under 1,000 characters.').optional(),
});
export const PortalOfferChoiceOutput = z.object({ choiceId: uuid });
export type CompareRowOut = z.infer<typeof CompareRow>;

// ---------- round three, step 10: a listing's price changes ----------

export const ListingPriceProposeInput = z.object({
  ...inDeal,
  /** The new list price. */
  priceCents: z.int().min(1, 'Enter the new price.').max(100_000_000_000),
  note: z.string().trim().max(500).optional(),
});
export const ListingPriceProposeOutput = z.object({ priceId: uuid, taskId: uuid });
export const ListingPriceChangeInput = z.object({
  workspaceId: uuid,
  priceId: uuid,
  /** Why: "Maria signed the change on paper", "They want to wait a week". */
  reason,
});
const ListingPriceOut = z.object({
  id: uuid,
  fromCents: z.number().int(),
  toCents: z.number().int(),
  /** The words the seller signs off. */
  words: z.string(),
  note: z.string().nullable(),
  state: z.enum(['waiting', 'applied', 'withdrawn']),
  /** Applied: signed in the portal, or let through by an owner or admin. */
  how: z.enum(['portal', 'let_through']).nullable(),
  signedBy: z.string().nullable(),
  overrideBy: z.object({ id: uuid, fullName: z.string() }).nullable(),
  overrideReason: z.string().nullable(),
  appliedAt: isoDateTime.nullable(),
  withdrawnReason: z.string().nullable(),
  taskId: uuid.nullable(),
  proposedAt: isoDateTime,
  proposedBy: z.object({ id: uuid, fullName: z.string() }).nullable(),
});
export const ListingPriceChangeOutput = ListingPriceOut;
export const ListingPricesOutput = z.object({
  dealId: uuid,
  /** The list price in use now. */
  currentCents: z.number().int().nullable(),
  /** The change waiting on the seller, if there is one. */
  waiting: ListingPriceOut.nullable(),
  /** Every change asked for, newest first. */
  history: z.array(ListingPriceOut),
  /** What showings say about it (round five): how many, how interested, and how the price felt. */
  showings: z.object({
    showings: z.number().int(),
    answered: z.number().int(),
    averageInterest: z.number().nullable(),
    priceHigh: z.number().int(),
    words: z.string(),
  }),
});

// ---------- round three, step 11: our listings suggested to our buyers ----------

export const MatchRunInput = z
  .object({ workspaceId: uuid, listingDealId: uuid.optional(), buyerDealId: uuid.optional() })
  .refine((m) => !!m.listingDealId !== !!m.buyerDealId, {
    error: 'Match one listing or one buyer.',
    path: ['listingDealId'],
  });
export const MatchRunOutput = z.object({
  suggested: z.number().int(),
  refreshed: z.number().int(),
  gone: z.number().int(),
});
const SuggestionOut = z.object({
  id: uuid,
  address: z.string(),
  priceCents: z.number().int().nullable(),
  facts: z.record(z.string(), z.unknown()),
  fit: z.array(z.object({ key: z.string(), met: z.boolean().nullable(), words: z.string() })),
  mlsNumber: z.string().nullable(),
  pageSlug: z.string().nullable(),
  state: z.enum(['new', 'added', 'not_a_fit', 'gone']),
  homeId: uuid.nullable(),
  decidedBy: z.object({ id: uuid, fullName: z.string() }).nullable(),
  decidedAt: isoDateTime.nullable(),
  decidedReason: z.string().nullable(),
  createdAt: isoDateTime,
});
export const SuggestionsOutput = z.object({ dealId: uuid, suggestions: z.array(SuggestionOut) });
export const SuggestionInput = z.object({ workspaceId: uuid, suggestionId: uuid });
export const SuggestionNotAFitInput = z.object({
  workspaceId: uuid,
  suggestionId: uuid,
  reason: z.string().trim().min(1).max(500).optional(),
});
export const SuggestionChangeOutput = z.object({
  suggestionId: uuid,
  state: z.enum(['new', 'added', 'not_a_fit', 'gone']),
  homeId: uuid.nullable(),
});

// ---------- round three, step 12: the seller's own listing in the portal ----------

export const PortalListingOutput = z.object({
  dealId: uuid,
  address: z.string().nullable(),
  street: z.string().nullable(),
  /** The list price as it stands. */
  priceCents: z.number().int().nullable(),
  /** Each change asked of them, newest first, and how it ended. */
  priceChanges: z.array(
    z.object({
      id: uuid,
      fromCents: z.number().int(),
      toCents: z.number().int(),
      words: z.string(),
      state: z.enum(['waiting', 'applied', 'withdrawn']),
      appliedAt: isoDateTime.nullable(),
      proposedAt: isoDateTime,
    }),
  ),
  mls: z.object({ number: z.string(), liveOn: z.string() }).nullable(),
  /** Its public page, once it's up: "/a/hill-country-realty/realestate/2207-juniper-trail". */
  pagePath: z.string().nullable(),
  facts: z.record(z.string(), z.unknown()),
  /** The description in use: the words they signed off. */
  description: z.object({ words: z.string(), signedAt: isoDateTime.nullable() }).nullable(),
  openHouses: z.array(z.object({ id: uuid, startsAt: isoDateTime, endsAt: isoDateTime })),
  questionnaire: z.object({
    state: z.enum(['none', 'asked', 'draft', 'submitted']),
    taskId: uuid.nullable(),
    answers: z.object({
      facts: z.record(z.string(), z.unknown()),
      updates: z.string().nullable(),
      loves: z.string().nullable(),
    }),
    savedAt: isoDateTime.nullable(),
    submittedAt: isoDateTime.nullable(),
  }),
  /** The offers side by side, as their agent last shared them. */
  comparison: z
    .object({
      id: uuid,
      sharedAt: isoDateTime,
      address: z.string(),
      rows: z.array(CompareRow),
      /** It's an estimate, and says so. */
      note: z.string(),
      myChoices: z.array(
        z.object({
          offerId: uuid,
          choice: z.enum(SELLER_CHOICE_KEYS),
          words: z.string().nullable(),
          at: isoDateTime,
        }),
      ),
    })
    .nullable(),
});
export const PortalQuestionnaireSaveInput = z.object({
  workspaceId: uuid,
  dealId: uuid,
  facts: ListingHomeFactsIn.default({}),
  updates: z.string().trim().max(2000, 'Keep it under 2,000 characters.').optional(),
  loves: z.string().trim().max(2000, 'Keep it under 2,000 characters.').optional(),
});
export const PortalQuestionnaireSubmitInput = z.object({ workspaceId: uuid, dealId: uuid });
export const PortalQuestionnaireOutput = z.object({
  dealId: uuid,
  state: z.enum(['draft', 'submitted']),
  savedAt: isoDateTime.nullable(),
  submittedAt: isoDateTime.nullable(),
});

// ---------- round four: reading contracts and amendments ----------

const ReadState = z.enum(['reading', 'read', 'failed']);
const ValueState = z.enum(['waiting', 'confirmed', 'rejected']);

export const DocumentReadInput = z.object({ workspaceId: uuid, documentId: uuid });
export const DocumentReadOutput = z.object({
  dealId: uuid,
  documentId: uuid,
  readId: uuid,
  state: ReadState,
});

const ReadValueIn = z.object({
  key: z.enum(CONTRACT_KEYS),
  date: localDate.nullable(),
  cents: cents.nullable(),
  text: z.string().trim().min(1).max(200).nullable(),
  worked: z
    .object({
      days: z.number().int().min(0).max(400),
      business: z.boolean(),
      from: z.enum(CONTRACT_DATE_KEYS),
      fromDate: localDate,
    })
    .nullable(),
  clause: z.string().trim().max(60).nullable(),
  page: z.number().int().min(1).nullable(),
  quote: z.string().trim().min(1).max(600),
});
const UnclearIn = z.object({
  what: z.string().trim().min(1).max(300),
  quote: z.string().trim().max(600).nullable(),
  page: z.number().int().min(1).nullable(),
  clause: z.string().trim().max(60).nullable(),
});

export const ContractReadDoneInput = z.object({
  workspaceId: uuid,
  readId: uuid,
  values: z.array(ReadValueIn).max(60).default([]),
  unclear: z.array(UnclearIn).max(30).default([]),
  dropped: z.number().int().min(0).default(0),
  scan: z.boolean().default(false),
  pages: z.number().int().min(0).nullable().default(null),
  model: z.string().max(200).optional(),
  /** Why it couldn't be read, instead. */
  failure: z.string().trim().min(1).max(500).optional(),
});
export const ContractReadDoneOutput = z.object({
  readId: uuid,
  state: z.enum(['read', 'failed', 'skipped']),
});

export const ContractReadQueryInput = z.object({ workspaceId: uuid, readId: uuid });

const ReadValueOut = z.object({
  id: uuid,
  key: z.enum(CONTRACT_KEYS),
  label: z.string(),
  /** What it says, as a sentence would: "Oct 10, 2026", "$412,000.00", the words. */
  value: z.string(),
  date: localDate.nullable(),
  cents: z.number().nullable(),
  text: z.string().nullable(),
  /** "9 days after the contract accepted (Sep 24, 2026)", when the contract counts it. */
  worked: z.string().nullable(),
  clause: z.string().nullable(),
  page: z.number().nullable(),
  quote: z.string(),
  state: ValueState,
  decidedByName: z.string().nullable(),
  decidedAt: isoDateTime.nullable(),
  reason: z.string().nullable(),
  /** The value that counts on the deal now, in words; null when there's none. */
  now: z.string().nullable(),
  /** Where that one came from: "the accepted offer", "typed by Dana". */
  nowFrom: z.string().nullable(),
  /** It says the same as what counts now. */
  same: z.boolean(),
});

const DueMove = z.object({
  dutyId: uuid,
  title: z.string(),
  /** Now and after, in the business's words: "Oct 9", "Oct 13". */
  from: z.string().nullable(),
  to: z.string().nullable(),
  /** "1 business day before closing". */
  why: z.string().nullable(),
  accountableName: z.string().nullable(),
});

export const ContractReadOutput = z.object({
  readId: uuid,
  dealId: uuid,
  dealName: z.string(),
  documentId: uuid,
  documentTitle: z.string(),
  fileId: uuid,
  kind: z.enum(READ_KINDS),
  state: ReadState,
  scan: z.boolean(),
  pages: z.number().nullable(),
  failure: z.string().nullable(),
  requestedAt: isoDateTime,
  readAt: isoDateTime.nullable(),
  requestedByName: z.string().nullable(),
  values: z.array(ReadValueOut),
  unclear: z.array(UnclearIn),
  dropped: z.number(),
  /** What confirming every waiting value would move: each open duty whose due changes. */
  moves: z.array(DueMove),
  /** Dates that wouldn't fit together once confirmed (a rate lock ending before closing). */
  problems: z.array(z.object({ check: z.string(), words: z.string() })),
  /** A newer reading of the same document exists. */
  newerReadId: uuid.nullable(),
});

export const ContractConfirmInput = z.object({
  workspaceId: uuid,
  readId: uuid,
  /** The values to confirm; none named confirms every one still waiting. */
  valueIds: z.array(uuid).max(60).optional(),
});
export const ContractConfirmOutput = z.object({
  readId: uuid,
  dealId: uuid,
  confirmed: z.number().int(),
  dutiesCreated: z.number().int(),
  dutiesActivated: z.number().int(),
  dutiesRedated: z.number().int(),
});

export const ContractRejectInput = z.object({
  workspaceId: uuid,
  readId: uuid,
  valueId: uuid,
  reason: reason,
});
export const ContractRejectOutput = z.object({ readId: uuid, dealId: uuid });

export const ContractReadsInput = z.object({ ...inDeal });
export const ContractReadsOutput = z.object({
  reads: z.array(
    z.object({
      readId: uuid,
      documentId: uuid,
      documentTitle: z.string(),
      kind: z.enum(READ_KINDS),
      state: ReadState,
      scan: z.boolean(),
      waiting: z.number().int(),
      confirmed: z.number().int(),
      unclear: z.number().int(),
      requestedAt: isoDateTime,
    }),
  ),
});

// ---------- round four: contingencies ----------

export const ContingencyAddInput = z
  .object({
    ...inDeal,
    kind: z.enum(CONTINGENCY_KIND_KEYS),
    /** What it is, for one the agent names. */
    label: z.string().trim().min(1).max(120).optional(),
    /** When one the agent names ends. */
    endsOn: localDate.optional(),
    /** When a named kind ends, if its key date isn't entered yet: entered on the key dates, confirmed. */
    date: localDate.optional(),
  })
  .refine((i) => i.kind !== 'other' || (!!i.label && !!i.endsOn), {
    error: 'Say what it is and when it ends.',
    path: ['label'],
  });
export const ContingencyOutput = z.object({ dealId: uuid, contingencyId: uuid });

export const ContingencyResolveInput = z.object({
  workspaceId: uuid,
  contingencyId: uuid,
  how: z.enum(CONTINGENCY_ENDINGS),
  /** The signed removal form, one of the deal's documents. */
  documentId: uuid.optional(),
  note: optionalNote,
  /** Recorded without the form: why (owners and admins only). */
  reason: reason.optional(),
});

export const ContingenciesInput = z.object({ ...inDeal });
const ContingencyOut = z.object({
  id: uuid,
  kind: z.enum(CONTINGENCY_KIND_KEYS),
  label: z.string(),
  endKey: z.string().nullable(),
  endsOn: localDate.nullable(),
  /** A person confirmed the date it ends. */
  endConfirmed: z.boolean(),
  state: z.enum(CONTINGENCY_STATES),
  /** "Open · ends Oct 8", "Satisfied Oct 1". */
  stateWords: z.string(),
  clock: z.enum(['unknown', 'passed', 'ending', 'open']),
  source: z.enum(['offer', 'contract', 'typed']),
  resolvedAt: isoDateTime.nullable(),
  resolvedByName: z.string().nullable(),
  document: z.object({ id: uuid, title: z.string() }).nullable(),
  note: z.string().nullable(),
  overrideReason: z.string().nullable(),
});
export const ContingenciesOutput = z.object({
  dealId: uuid,
  contingencies: z.array(ContingencyOut),
  can: z.object({ except: z.boolean() }),
});
export type ContingencyOut = z.infer<typeof ContingencyOut>;

// ---------- round four: what a duty waits on ----------

export const DutyLinkInput = z.object({
  ...inDuty,
  /** The duty it can't be done before. */
  waitsOnId: uuid,
});
export const DutyLinkOutput = z.object({ dealId: uuid, dutyId: uuid, waitsOnId: uuid });
export const DutyChasedInput = z.object({
  ...inDuty,
  /** The next day to chase them; two business days on when not given. */
  nextOn: localDate.optional(),
  note: optionalNote,
});

// ---------- round four: the coordinator's views ----------

export const CoordinateInput = z.object({
  workspaceId: uuid,
  /** Only what they answer for or are on. */
  mine: z.boolean().optional(),
  /** Only one agent's deals. */
  agentUserId: uuid.optional(),
});
const Health = z.enum(['green', 'yellow', 'red']);
const TodayDuty = z.object({
  dutyId: uuid,
  dealId: uuid,
  dealName: z.string(),
  title: z.string(),
  status: z.enum(DUTY_STATUSES),
  materiality: z.enum(MATERIALITIES),
  accountableName: z.string().nullable(),
  dueAt: isoDateTime.nullable(),
  health: Health,
  /** At risk for a business day with nobody acknowledging it. */
  escalated: z.boolean(),
  acknowledged: z.boolean(),
});
export const TodayOutput = z.object({
  today: z.string(),
  atRisk: z.array(
    z.object({
      kind: z.enum(['duty', 'reason']),
      dealId: uuid,
      dealName: z.string(),
      dutyId: uuid.nullable(),
      words: z.string(),
      next: z.string(),
      level: z.enum(['red', 'yellow']),
      health: Health,
    }),
  ),
  overdue: z.array(TodayDuty),
  dueToday: z.array(TodayDuty),
});
export const ExceptionsOutput = z.object({
  reads: z.array(
    z.object({
      dealId: uuid,
      dealName: z.string(),
      readId: uuid,
      documentTitle: z.string(),
      waiting: z.number().int(),
      scan: z.boolean(),
    }),
  ),
  disagree: z.array(
    z.object({
      dealId: uuid,
      dealName: z.string(),
      words: z.string(),
      next: z.string(),
      linked: z.boolean(),
    }),
  ),
  nobodyAccountable: z.array(
    z.object({ dealId: uuid, dealName: z.string(), dutyId: uuid, title: z.string() }),
  ),
  noProof: z.array(
    z.object({
      dealId: uuid,
      dealName: z.string(),
      dutyId: uuid,
      title: z.string(),
      dueAt: isoDateTime.nullable(),
      accountableName: z.string().nullable(),
    }),
  ),
  contingencies: z.array(
    z.object({
      dealId: uuid,
      dealName: z.string(),
      contingencyId: uuid,
      label: z.string(),
      endedOn: z.string(),
    }),
  ),
  blocked: z.array(
    z.object({
      dealId: uuid,
      dealName: z.string(),
      dutyId: uuid,
      title: z.string(),
      blocker: z.string(),
      owner: z.string().nullable(),
      reviewAt: isoDateTime,
    }),
  ),
});
export const WaitingRoomOutput = z.object({
  items: z.array(
    z.object({
      dutyId: uuid,
      dealId: uuid,
      dealName: z.string(),
      title: z.string(),
      status: z.enum(['waiting_external', 'blocked']),
      /** Who it's waiting on, or whose it is to clear. */
      waitingOn: z.string(),
      blocker: z.string().nullable(),
      since: isoDateTime,
      /** When to chase them, or look at the blocker again. */
      next: isoDateTime.nullable(),
      past: z.boolean(),
      accountableName: z.string().nullable(),
    }),
  ),
});
export const WorkloadOutput = z.object({
  people: z.array(
    z.object({
      userId: uuid,
      name: z.string(),
      role: z.string(),
      deals: z.number().int(),
      openDuties: z.number().int(),
      overdue: z.number().int(),
      dueSoon: z.number().int(),
      atRiskDeals: z.number().int(),
    }),
  ),
});

// ---------- saved searches and new matches (round five, step 5) ----------

export const SearchSetInput = z.object({ ...inDeal, on: z.boolean() });
export const SearchSetOutput = z.object({ dealId: uuid, on: z.boolean(), changed: z.boolean() });

/** The worker: what one check of a buyer's search found. */
export const SearchFoundInput = z.object({
  ...inDeal,
  listings: z.array(MlsSnapshotSchema).max(100).default([]),
  /** No feed is connected (or answers here): nothing changes but the time. */
  noFeed: z.boolean().default(false),
  failure: z.string().trim().min(1).max(500).optional(),
});
export const SearchFoundOutput = z.object({
  dealId: uuid,
  added: z.int(),
  changed: z.int(),
  /** New ones came, and today's Home card for this buyer hasn't gone up yet. */
  cardDue: z.boolean(),
  /** How many wait on the agent now. */
  waiting: z.int(),
});

export const MatchSendInput = z.object({ workspaceId: uuid, matchId: uuid });
export const MatchSendOutput = z.object({ matchId: uuid, homeId: uuid });
export const MatchDismissInput = z.object({ workspaceId: uuid, matchId: uuid });
export const MatchDismissOutput = z.object({ matchId: uuid, changed: z.boolean() });

export const MatchesInput = z.object({
  ...inDeal,
  state: z.enum(['new', 'sent', 'dismissed']).optional(),
});
export const MatchesOutput = z.object({
  search: z.object({
    /** The buyer's profile is asked of the feed while the deal is open. */
    on: z.boolean(),
    /** It can't be asked yet: what the profile needs. */
    missing: z.string().nullable(),
    words: z.string(),
    feedConnected: z.boolean(),
    checkedAt: isoDateTime.nullable(),
    failure: z.string().nullable(),
  }),
  matches: z.array(
    z.object({
      id: uuid,
      state: z.enum(['new', 'sent', 'dismissed']),
      address: z.string(),
      mls: MlsOut,
      fit: z.object({
        lines: z.array(FitLineOut),
        met: z.number().int(),
        missed: z.number().int(),
        unknown: z.number().int(),
      }),
      foundAt: isoDateTime,
      /** The MLS changed it since it was found. */
      changedAt: isoDateTime.nullable(),
      homeId: uuid.nullable(),
      decidedBy: z.object({ id: uuid, fullName: z.string() }).nullable(),
      decidedAt: isoDateTime.nullable(),
    }),
  ),
  counts: z.object({ new: z.int(), sent: z.int(), dismissed: z.int() }),
});

/** The worker: what the listing feed says of our own listing now (round five, step 6). */
export const ListingFeedStatusInput = z.object({
  ...inDeal,
  listing: MlsSnapshotSchema.nullable(),
  noFeed: z.boolean().default(false),
  failure: z.string().trim().min(1).max(500).optional(),
});
export const ListingFeedStatusOutput = z.object({
  dealId: uuid,
  state: z.enum([...MLS_STATE_KEYS, 'skipped']),
  /** The MLS showed it Active, so it's marked live here now. */
  live: z.boolean(),
  differences: z.array(z.object({ key: z.enum(['price', 'status']), words: z.string() })),
});

// ---------- round five, step 7: e-sign through DocuSign or Dotloop ----------

const EsignSignerIn = z.object({
  name: z.string().trim().min(1, 'Enter the signer’s name.').max(120),
  email: z.email({ error: 'Enter the signer’s email, like sam@example.com.' }).max(254),
  /** Who signs first: 1, 2… Left out, they sign in the order listed. */
  order: z.number().int().min(1).max(10).optional(),
});
export const EsignSignerSchema = z.object({
  name: z.string().min(1).max(120),
  email: z.string().min(1).max(254),
  order: z.number().int().min(1).max(10),
  state: z.enum(SIGNER_STATE_KEYS),
  signedAt: isoDateTime.nullable(),
});
const inEnvelope = { workspaceId: uuid, envelopeId: uuid };

export const EsignPrepareInput = z.object({
  ...inDocument,
  /** DocuSign or Dotloop. Left out: the one that's connected. */
  provider: z.enum(ESIGN_PROVIDER_KEYS).optional(),
  /** The email's subject line. Left out: “Please sign: <the document's title>”. */
  subject: z.string().trim().min(1).max(200).optional(),
  message: z.string().trim().max(2000, 'Keep the message under 2,000 characters.').optional(),
  signers: z
    .array(EsignSignerIn)
    .min(1, 'Add at least one person to sign it.')
    .max(10, 'Up to 10 people can sign one document.'),
});
export const EsignOutput = z.object({
  envelopeId: uuid,
  dealId: uuid,
  documentId: uuid,
  provider: z.enum(ESIGN_PROVIDER_KEYS),
  state: z.enum(ESIGN_STATE_KEYS),
});
/** Worker: the envelope or loop made at the service, or why it couldn't be. */
export const EsignPreparedInput = z.object({
  ...inEnvelope,
  externalId: z.string().trim().min(1).max(200).optional(),
  openUrl: z
    .url({ protocol: /^https?$/ })
    .max(2000)
    .optional(),
  failure: z.string().trim().min(1).max(500).optional(),
});
/** Worker: where it stands at the service now. Final states stay as they are; a failure to ask is kept as words. */
export const EsignStatusInput = z.object({
  ...inEnvelope,
  state: z.enum(['draft', 'sent', 'declined', 'voided']).optional(),
  signers: z.array(EsignSignerSchema).max(10).optional(),
  sentAt: isoDateTime.optional(),
  /** Why it couldn't be asked, fetched or voided just now; null clears it. */
  failure: z.string().trim().min(1).max(500).nullable().optional(),
});
export const EsignStatusOutput = z.object({
  envelopeId: uuid,
  state: z.enum(ESIGN_STATE_KEYS),
  changed: z.boolean(),
});
/** Worker: everyone signed; the signed copy (and DocuSign's certificate) are on the deal as files. */
export const EsignCompletedInput = z.object({
  ...inEnvelope,
  signedFileId: uuid,
  certificateFileId: uuid.optional(),
  completedAt: isoDateTime.optional(),
});
export const EsignCompletedOutput = z.object({
  envelopeId: uuid,
  state: z.enum(ESIGN_STATE_KEYS),
  signedDocumentId: uuid.nullable(),
  certificateDocumentId: uuid.nullable(),
});
export const EsignMarkSignedInput = z.object({ ...inEnvelope });
export const EsignVoidInput = z.object({ ...inEnvelope, reason });

export const EsignListInput = z.object({ ...inDeal });
export const EsignListOutput = z.object({
  dealId: uuid,
  /** The e-signature services connected here, healthy or not. */
  connected: z.array(
    z.object({
      provider: z.enum(ESIGN_PROVIDER_KEYS),
      label: z.string(),
      account: z.string().nullable(),
      failing: z.boolean(),
    }),
  ),
  envelopes: z.array(
    z.object({
      id: uuid,
      documentId: uuid,
      documentTitle: z.string(),
      provider: z.enum(ESIGN_PROVIDER_KEYS),
      providerLabel: z.string(),
      state: z.enum(ESIGN_STATE_KEYS),
      stateLabel: z.string(),
      words: z.string(),
      subject: z.string(),
      message: z.string().nullable(),
      signers: z.array(EsignSignerSchema),
      signersWords: z.string(),
      failure: z.string().nullable(),
      preparedAt: isoDateTime.nullable(),
      sentAt: isoDateTime.nullable(),
      completedAt: isoDateTime.nullable(),
      checkedAt: isoDateTime.nullable(),
      signedDocumentId: uuid.nullable(),
      certificateDocumentId: uuid.nullable(),
      createdByName: z.string().nullable(),
      createdAt: isoDateTime,
      can: z.object({
        open: z.boolean(),
        markSigned: z.boolean(),
        void: z.boolean(),
      }),
    }),
  ),
});

// ---------- round five, step 8: showings of our listings ----------

const inShowing = { workspaceId: uuid, showingId: uuid };
const agentName = z.string().trim().min(1, 'Enter the agent’s name.').max(120);
const brokerage = z.string().trim().min(1).max(120);
const agentEmail = z.email({ error: 'Enter an email like ana@brokerage.com.' }).max(254);
const agentPhone = z.string().trim().min(7, 'Enter a phone number.').max(40);
const words500 = z.string().trim().min(1).max(500, 'Keep it under 500 characters.');
export const ShowingFeedbackSchema = z.object({
  interest: z.number().int().min(1).max(5).nullable(),
  liked: z.string().trim().min(1).max(1000).nullable(),
  pause: z.string().trim().min(1).max(1000).nullable(),
  price: z.enum(PRICE_FEEL_KEYS).nullable(),
});
const ShowingThemeSchema = z.object({
  theme: z.string().trim().min(1).max(120),
  count: z.number().int().min(1).max(500),
  quotes: z.array(z.string().trim().min(1).max(300)).max(5),
});
export const ShowingThemesSchema = z.object({
  liked: z.array(ShowingThemeSchema).max(6),
  disliked: z.array(ShowingThemeSchema).max(6),
});
export const ShowingSettingsSchema = z.object({
  open: z.boolean(),
  confirm: z.enum(['seller', 'auto']),
  days: z.array(z.number().int().min(0).max(6)).max(7),
  from: clock,
  to: clock,
  minutes: z.number().int().min(15).max(120),
  accessHours: z.number().int().min(0).max(24),
  feedbackHours: z.number().int().min(0).max(48),
});

export const ShowingSettingsInput = z
  .object({
    ...inDeal,
    ...ShowingSettingsSchema.partial().shape,
    /** The lockbox code and how to get in; null clears it. */
    access: z.string().trim().min(1).max(1000).nullable().optional(),
  })
  .refine((i) => !i.from || !i.to || i.from < i.to, {
    path: ['to'],
    message: 'The last time ends after the first. Pick a later time.',
  });
export const ShowingSettingsOutput = z.object({
  dealId: uuid,
  settings: ShowingSettingsSchema.extend({ access: z.string().nullable() }),
});

export const ShowingAddInput = z.object({
  ...inDeal,
  startsAt: isoDateTime,
  minutes: z.number().int().min(15).max(240).optional(),
  agentName,
  brokerage: brokerage.optional(),
  license: z.string().trim().min(1).max(40).optional(),
  agentEmail: agentEmail.optional(),
  agentPhone: agentPhone.optional(),
});
export const ShowingOutput = z.object({
  showingId: uuid,
  dealId: uuid,
  state: z.enum(SHOWING_STATE_KEYS),
});
export const ShowingDecideInput = z.object({
  ...inShowing,
  decision: z.enum(['confirm', 'decline', 'cancel']),
  note: words500.optional(),
});
export const ShowingCheckInput = z.object({
  ...inShowing,
  /** The right time, when the email was read wrong. */
  startsAt: isoDateTime.optional(),
  agentName: agentName.optional(),
});
export const ShowingFeedbackInput = z.object({
  ...inShowing,
  ...ShowingFeedbackSchema.partial().shape,
});
export const ShowingShareInput = z.object({ ...inShowing });

export const ShowingListInput = z.object({ ...inDeal });
const ShowingRow = z.object({
  id: uuid,
  source: z.enum(SHOWING_SOURCE_KEYS),
  sourceLabel: z.string(),
  state: z.enum(SHOWING_STATE_KEYS),
  stateWords: z.string(),
  startsAt: isoDateTime,
  endsAt: isoDateTime,
  when: z.string(),
  agentName: z.string(),
  brokerage: z.string().nullable(),
  license: z.string().nullable(),
  agentEmail: z.string().nullable(),
  agentPhone: z.string().nullable(),
  checked: z.boolean(),
  requestedAt: isoDateTime,
  decidedAt: isoDateTime.nullable(),
  decisionNote: z.string().nullable(),
  accessSentAt: isoDateTime.nullable(),
  feedbackAskedAt: isoDateTime.nullable(),
  feedback: ShowingFeedbackSchema.nullable(),
  feedbackAt: isoDateTime.nullable(),
  feedbackSource: z.enum(SHOWING_SOURCE_KEYS).nullable(),
  feedbackSharedAt: isoDateTime.nullable(),
  can: z.object({
    confirm: z.boolean(),
    decline: z.boolean(),
    cancel: z.boolean(),
    check: z.boolean(),
    feedback: z.boolean(),
    share: z.boolean(),
  }),
});
export const ShowingListOutput = z.object({
  dealId: uuid,
  street: z.string().nullable(),
  /** The page a buyer's agent asks for a showing on, once the listing's page is up. */
  requestPath: z.string().nullable(),
  sellerFirstName: z.string().nullable(),
  settings: ShowingSettingsSchema.extend({ access: z.string().nullable() }),
  showings: z.array(ShowingRow),
  summary: z.object({
    showings: z.number().int(),
    answered: z.number().int(),
    averageInterest: z.number().nullable(),
    interestWords: z.string(),
    price: z.object({ low: z.number().int(), right: z.number().int(), high: z.number().int() }),
    words: z.string(),
  }),
  themes: ShowingThemesSchema.extend({
    likedWords: z.string(),
    dislikedWords: z.string(),
    at: isoDateTime,
  }).nullable(),
});

// The listing's public page: a buyer's agent asks for a time, and says how it went.
const inPage = { workspaceId: uuid, slug: z.string().trim().max(80) };
export const PublicShowingTimesInput = z.object({ ...inPage });
export const PublicShowingTimesOutput = z.object({
  street: z.string(),
  open: z.boolean(),
  /** Why it isn't open, in words, when it isn't. */
  closedWords: z.string().nullable(),
  times: z.array(isoDateTime),
  minutes: z.number().int(),
  timeZone: z.string(),
  confirm: z.enum(['seller', 'auto']),
});
export const PublicShowingRequestInput = z.object({
  ...inPage,
  startsAt: isoDateTime,
  agentName,
  brokerage,
  license: z.string().trim().min(1, 'Enter your license number.').max(40),
  email: agentEmail,
  phone: agentPhone.optional(),
});
export const PublicShowingRequestOutput = z.object({
  state: z.enum(['requested', 'confirmed']),
  startsAt: isoDateTime,
});
export const PublicShowingFeedbackFormInput = z.object({
  ...inPage,
  token: z
    .string()
    .regex(/^[A-Za-z0-9_-]{43}$/, 'That link isn’t complete. Open it from the email again.'),
});
export const PublicShowingFeedbackFormOutput = z.object({
  street: z.string(),
  startsAt: isoDateTime,
  agentName: z.string(),
  answered: z.boolean(),
});
export const PublicShowingFeedbackInput = z.object({
  ...PublicShowingFeedbackFormInput.shape,
  interest: z.number().int().min(1, 'Pick how interested your buyers were.').max(5),
  liked: z.string().trim().max(1000).optional(),
  pause: z.string().trim().max(1000).optional(),
  price: z.enum(PRICE_FEEL_KEYS).optional(),
});
export const PublicShowingFeedbackOutput = z.object({ sent: z.literal(true) });

// The seller, in their portal.
export const PortalShowingsInput = z.object({ ...inDeal });
export const PortalShowingsOutput = z.object({
  dealId: uuid,
  waiting: z.array(
    z.object({
      id: uuid,
      startsAt: isoDateTime,
      endsAt: isoDateTime,
      agentName: z.string(),
      brokerage: z.string().nullable(),
      source: z.enum(SHOWING_SOURCE_KEYS),
      requestedAt: isoDateTime,
    }),
  ),
  upcoming: z.array(
    z.object({
      id: uuid,
      startsAt: isoDateTime,
      endsAt: isoDateTime,
      agentName: z.string(),
      brokerage: z.string().nullable(),
      source: z.enum(SHOWING_SOURCE_KEYS),
    }),
  ),
  /** Feedback their agent shared with them. */
  feedback: z.array(
    z.object({
      id: uuid,
      startsAt: isoDateTime,
      feedback: ShowingFeedbackSchema,
      sharedAt: isoDateTime,
    }),
  ),
  /** Whether a showing waits for their yes, or is confirmed on its own. */
  confirm: z.enum(['seller', 'auto']),
});
export const PortalShowingAnswerInput = z.object({
  ...inShowing,
  answer: z.enum(['yes', 'no', 'another']),
  words: words500.optional(),
});

// The worker's.
export const ShowingSentInput = z.object({
  ...inShowing,
  what: z.enum(['access', 'feedback']),
  /** The feedback link's token, hashed (hex), with `feedback`. */
  tokenHash: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
});
export const ShowingSentOutput = z.object({ showingId: uuid, changed: z.boolean() });
export const ShowingFromEmailInput = z.object({
  ...inDeal,
  /** The email it was read from. */
  messageId: uuid.optional(),
  kind: z.enum(['requested', 'confirmed', 'cancelled', 'feedback']),
  /** ShowingTime's own reference for it, when the email has one. */
  externalId: z.string().trim().min(1).max(200).optional(),
  startsAt: isoDateTime.optional(),
  endsAt: isoDateTime.optional(),
  agentName: agentName.optional(),
  brokerage: brokerage.optional(),
  agentEmail: z.string().trim().max(254).optional(),
  agentPhone: z.string().trim().max(40).optional(),
  feedback: ShowingFeedbackSchema.optional(),
});
export const ShowingFromEmailOutput = z.object({
  showingId: uuid.nullable(),
  state: z.enum([...SHOWING_STATE_KEYS, 'skipped']),
});
export const ShowingThemesSaveInput = z.object({ ...inDeal, themes: ShowingThemesSchema });
export const ShowingThemesSaveOutput = z.object({ dealId: uuid });

// ---------- round five, step 9: the vendors directory ----------

const vendorService = z.enum(VENDOR_SERVICE_KEYS);
export const VendorSaveInput = z
  .object({
    workspaceId: uuid,
    /** Changing one already here. */
    vendorId: uuid.optional(),
    /** A company already in Contacts; or its name, to add one. */
    companyId: uuid.optional(),
    name: z.string().trim().min(1, 'Enter the vendor’s name.').max(120).optional(),
    email: z.email({ error: 'Enter an email like hello@vendor.com.' }).max(254).optional(),
    phone: z.string().trim().min(7, 'Enter a phone number.').max(40).optional(),
    services: z.array(vendorService).min(1, 'Pick at least one thing they do.').max(9),
    areas: z.array(z.string().trim().min(1).max(60)).max(20).default([]),
    disclosure: z.string().trim().min(1).max(500).nullable().optional(),
    note: z.string().trim().min(1).max(1000).nullable().optional(),
  })
  .refine((v) => !!v.vendorId || !!v.companyId || !!v.name, {
    path: ['name'],
    message: 'Enter the vendor’s name, or pick a company from Contacts.',
  });
export const VendorOutput = z.object({
  vendorId: uuid,
  companyId: uuid,
  approved: z.boolean(),
});
export const VendorApproveInput = z.object({
  workspaceId: uuid,
  vendorId: uuid,
  approved: z.boolean(),
});
export const VendorArchiveInput = z.object({
  workspaceId: uuid,
  vendorId: uuid,
  reason: z.string().trim().min(1).max(500).optional(),
});
const VendorRow = z.object({
  id: uuid,
  companyId: uuid,
  name: z.string(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  services: z.array(vendorService),
  servicesWords: z.string(),
  areas: z.array(z.string()),
  approved: z.boolean(),
  approvedAt: isoDateTime.nullable(),
  disclosure: z.string().nullable(),
  disclosureWords: z.string(),
  note: z.string().nullable(),
  archived: z.boolean(),
  uses: z.number().int(),
  lastUsedAt: isoDateTime.nullable(),
});
export const VendorListInput = z.object({
  workspaceId: uuid,
  service: vendorService.optional(),
  includeArchived: z.boolean().default(false),
});
export const VendorListOutput = z.object({ vendors: z.array(VendorRow) });

export const DutyVendorsInput = z.object({ ...inDuty, service: vendorService.optional() });
export const DutyVendorsOutput = z.object({
  dutyId: uuid,
  dealId: uuid,
  /** What the duty needs, from its title or as asked; null when the agent should say. */
  service: vendorService.nullable(),
  serviceLabel: z.string().nullable(),
  address: z.string().nullable(),
  /** Every approved vendor that does it, those working where the home is first. */
  fits: z.array(VendorRow.extend({ inArea: z.boolean().nullable() })),
  picks: z.array(
    z.object({
      pickId: uuid,
      vendor: VendorRow,
      service: vendorService,
      serviceLabel: z.string(),
      quoteCents: z.number().int().nullable(),
      quoteWords: z.string().nullable(),
      quoteDocument: z.object({ id: uuid, title: z.string() }).nullable(),
      appointment: z
        .object({ id: uuid, title: z.string().nullable(), startsAt: isoDateTime })
        .nullable(),
      note: z.string().nullable(),
      pickedAt: isoDateTime,
      pickedByName: z.string().nullable(),
      removedAt: isoDateTime.nullable(),
      removedReason: z.string().nullable(),
    }),
  ),
});
export const DutyPickVendorInput = z.object({
  ...inDuty,
  vendorId: uuid,
  service: vendorService.optional(),
  note: z.string().trim().min(1).max(1000).optional(),
});
const inPick = { workspaceId: uuid, pickId: uuid };
export const DutyVendorQuoteInput = z.object({
  ...inPick,
  cents: cents.nullable(),
  /** The quote itself, one of the deal's documents. */
  documentId: uuid.nullable().optional(),
});
export const DutyVendorAppointmentInput = z.object({ ...inPick, appointmentId: uuid.nullable() });
export const DutyUnpickVendorInput = z.object({ ...inPick, reason });
export const DutyVendorOutput = z.object({ pickId: uuid, dutyId: uuid, vendorId: uuid });

// ---------- round five, step 10: what the connections are used for ----------

export const RealestateConnectionsUsesInput = z.object({ workspaceId: uuid });
export const RealestateConnectionsUsesOutput = z.object({
  listingData: z.object({
    listings: z.number().int(),
    searches: z.number().int(),
    words: z.string(),
  }),
  esign: z.object({ out: z.number().int(), words: z.string() }),
  showingTime: z.object({ on: z.boolean(), readThisMonth: z.number().int(), words: z.string() }),
});
