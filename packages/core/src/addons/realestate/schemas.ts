/**
 * Real Estate Agent's operations, as the API, the screens and the Assistant see them: every input checked here and
 * every answer's shape. Browser-safe.
 */
import { z } from 'zod';
import { isoDateTime, uuid } from '../../schemas/common';
import { DEAL_FACTS, type DealEvent, type DealFact } from './catalog/types';
import { TERM_SOURCES } from './dates/key-dates';
import { DEAL_LINK_KINDS_LIST, PARTY_ROLES_LIST, TEAM_ROLES } from './words';
import { DEAL_SIDES, DUTY_STATUSES } from './states';
import { TERM_KEYS } from './terms';

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
      actorType: z.enum(['person', 'system', 'ai']),
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

export const OverviewInput = z.object({ workspaceId: uuid });
export const OverviewOutput = z.object({
  name: z.string(),
  version: z.string(),
  openDeals: z.number().int(),
  myOpenDeals: z.number().int(),
  overdueDuties: z.number().int(),
  dueThisWeek: z.number().int(),
});
