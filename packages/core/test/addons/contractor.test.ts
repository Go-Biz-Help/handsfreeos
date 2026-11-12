/**
 * Contractor Operations's manifest and operations, held to the add-on rules (docs/addon-architecture.md). Pure: no database.
 */
import { describe, expect, it } from 'vitest';
import {
  addonAiIssues,
  addonModuleIssues,
  addonSearchIssues,
  commands,
  manifestIssues,
  queries,
} from '../../src/server';
import {
  BUDGET_ADVICE_SYSTEM,
  budgetAdviceAsk,
  budgetAlertWords,
  BudgetAdviceAnswer,
  checkedBudgetAdvice,
  WATCH,
  watchBudget,
  watchIsNews,
} from '../../src/addons/contractor/budget-watch';
import {
  checklistForNewVisit,
  checklistProgress,
  checklistWords,
  PLAIN_CHECKLIST,
  STARTER_CHECKLISTS,
} from '../../src/addons/contractor/checklists';
import {
  checkedReport,
  REPORT_LIMITS,
  REPORT_SYSTEM,
  reportAsk,
  reportDayWords,
  reportDueAt,
  reportHasEnough,
  type ReportSource,
} from '../../src/addons/contractor/daily-report';
import {
  checkedEstimateDraft,
  DRAFT_LIMITS,
  draftHasEnough,
  ESTIMATE_DRAFT_SCHEMA,
  ESTIMATE_DRAFT_SYSTEM,
  EstimateDraftAnswer,
  estimateDraftAsk,
  guessedLines,
  type DraftItem,
  type DraftSource,
} from '../../src/addons/contractor/estimate-draft';
import {
  checkMargin,
  costOption,
  defaultCostKind,
  marginBpOf,
  marginWords,
  markupBpOf,
  priceFromMarkup,
  type CostedLine,
} from '../../src/addons/contractor/estimating';
import {
  costJob,
  groupProfit,
  headsUnderMargin,
  periodOf,
  profitTotal,
  type CostingActual,
  type CostingBudget,
  type ProfitJob,
} from '../../src/addons/contractor/job-costing';
import { contractorAddon } from '../../src/addons/contractor/manifest';
import {
  noteAddedWords,
  noteLine,
  NOTE_LIMITS,
  type NoteParts,
} from '../../src/addons/contractor/notes';
import { clockOfSeconds, CONTRACTOR_PHONE_WORDS } from '../../src/addons/contractor/phone-words';
import { leavesPhonesAt, PHONE_DAYS } from '../../src/addons/contractor/progress';
import {
  amountWords,
  costMaterials,
  DEFAULT_MATERIALS_ALERT_HOURS,
  isMissing,
  leftOf,
  materialCostCents,
  MATERIALS_ALERT_HOURS,
  materialsCheckAt,
  materialState,
  materialWords,
  missingFor,
  neededOn,
  nextStep,
  shortOf,
  takenOf,
  toOrderOf,
  type MaterialCounts,
} from '../../src/addons/contractor/materials';
import {
  ContractorSettingsSchema,
  EstimateDraftBody,
  MaterialCountInput,
  NoteAddInput,
  ReportBody,
} from '../../src/addons/contractor/schemas';
import { contractorAddonServer } from '../../src/addons/contractor/server';
import {
  clockFor,
  durationWords,
  fixProblem,
  hoursOf,
  isPaid,
  limitOf,
  MAX_RUNNING_HOURS,
  secondsOf,
  stretchCostCents,
  totalsOf,
} from '../../src/addons/contractor/time';
import { TRADES } from '../../src/addons/contractor/trades';
import {
  alertHoursWords,
  materialChangeWords,
  materialsAlertWords,
  materialsMissingWords,
  namesWords,
  okNeededWords,
  REFUSALS,
  FIX_PROBLEM_WORDS,
  stretchWords,
  subTextWords,
  timeAmountWords,
  timeStoppedAlertWords,
} from '../../src/addons/contractor/words';

describe('Contractor Operations', () => {
  it('has a valid manifest', () => {
    expect(manifestIssues(contractorAddon)).toEqual([]);
  });

  it('joins core’s operations cleanly', () => {
    const core = {
      commands: commands.filter((c) => c.addon?.id !== 'contractor'),
      queries: queries.filter((q) => q.addon?.id !== 'contractor'),
    };
    expect(addonModuleIssues(core, [contractorAddonServer])).toEqual([]);
  });

  it('offers the AI only what it may use', () => {
    expect(addonAiIssues([contractorAddonServer])).toEqual([]);
  });

  it('answers searches only as core runs them', () => {
    expect(addonSearchIssues([contractorAddonServer])).toEqual([]);
  });
});

describe('estimating', () => {
  const line = (over: Partial<CostedLine>): CostedLine => ({
    quantity: 1,
    unitPriceCents: 0,
    discountCents: 0,
    kind: 'material',
    unitCostCents: null,
    ...over,
  });
  const labor = line({ quantity: 4, unitPriceCents: 100_00, kind: 'labor', unitCostCents: 40_00 });
  const breaker = line({ unitPriceCents: 200_00, unitCostCents: 100_00 });
  const permit = line({ unitPriceCents: 75_00, kind: 'other' });

  it('prices a cost with a markup, and reads the markup and the margin back', () => {
    expect(priceFromMarkup(40_00, 5_000)).toBe(60_00);
    expect(markupBpOf(60_00, 40_00)).toBe(5_000);
    expect(markupBpOf(60_00, null)).toBeNull();
    expect(markupBpOf(60_00, 0)).toBeNull();
    // A 50% markup is a 33.3% margin: they are not the same number.
    expect(marginBpOf(60_00, 40_00)).toBe(3_333);
    expect(marginBpOf(0, 40_00)).toBeNull();
    expect(marginWords(3_333)).toBe('33.3%');
    expect(marginWords(2_000)).toBe('20%');
  });

  it('costs a price list item by what it is until someone says', () => {
    expect(defaultCostKind('service')).toBe('labor');
    expect(defaultCostKind('fee')).toBe('other');
    expect(defaultCostKind('product')).toBe('material');
    expect(defaultCostKind(null)).toBe('material');
  });

  it('adds an option up by labor, materials and other, against its price before tax', () => {
    expect(costOption([labor, breaker, permit], 675_00)).toEqual({
      priceCents: 675_00,
      laborCents: 160_00,
      materialsCents: 100_00,
      otherCents: 0,
      costCents: 260_00,
      laborHours: 4,
      profitCents: 415_00,
      marginBp: 6_148,
      // A permit with no cost is fine; labor or a material with none isn’t.
      uncosted: 0,
    });
    expect(costOption([labor, line({ unitPriceCents: 50_00 })], 450_00).uncosted).toBe(1);
    expect(costOption([line({ kind: 'labor', unitCostCents: 0 })], 100_00).uncosted).toBe(1);
  });

  it('holds an estimate for an OK when any option is under the lowest margin (decision 6)', () => {
    const option = (name: string | null, priceCents: number, lines: CostedLine[]) => ({
      name,
      costing: costOption(lines, priceCents),
    });
    const thin = option('Good', 100_00, [line({ unitPriceCents: 100_00, unitCostCents: 90_00 })]);
    const fat = option('Best', 1_000_00, [
      line({ unitPriceCents: 1_000_00, unitCostCents: 400_00 }),
    ]);
    const check = checkMargin([fat, thin], 2_000);
    expect(check).toMatchObject({
      lowest: { name: 'Good', marginBp: 1_000 },
      needsOk: 'margin',
      uncosted: 0,
    });
    expect(okNeededWords(check)).toBe(
      'The “Good” option’s margin is 10%, under your lowest margin of 20%.',
    );
    // Right on the line is enough.
    expect(checkMargin([thin], 1_000).needsOk).toBeNull();
    expect(checkMargin([fat], 2_000)).toMatchObject({ needsOk: null, lowest: { marginBp: 6_000 } });
    expect(okNeededWords(checkMargin([fat], 2_000))).toBeNull();
    // Losing money is under any margin.
    const loss = option(null, 50_00, [line({ unitPriceCents: 50_00, unitCostCents: 80_00 })]);
    expect(okNeededWords(checkMargin([loss], 0))).toBe(
      'This estimate’s margin is -60%, under your lowest margin of 0%.',
    );
  });

  it('holds one whose labor or materials have no cost, since its margin can’t be trusted', () => {
    const bare = { name: null, costing: costOption([line({ unitPriceCents: 500_00 })], 500_00) };
    const check = checkMargin([bare], 2_000);
    expect(check).toMatchObject({ needsOk: 'uncosted', uncosted: 1 });
    expect(okNeededWords(check)).toBe(
      'One labor or material line has no cost yet, so the margin can’t be checked.',
    );
    expect(okNeededWords({ ...check, uncosted: 3 })).toMatch(/^3 labor or material lines have/);
    // Nothing to send for: no margin to rate, and nothing to hold it on.
    expect(checkMargin([], 2_000)).toMatchObject({ lowest: null, needsOk: null });
  });

  it('tells whoever is refused what to do next', () => {
    expect(REFUSALS.marginNeedsOk('Why.', true)).toMatch(/OK it first/);
    expect(REFUSALS.marginNeedsOk('Why.', false)).toMatch(/Ask an owner or admin/);
  });

  it('starts a visit’s checklist from the business’s own list, else its trade’s, else the plain one', () => {
    const own = [{ label: 'Boot covers on', kind: 'check' as const, required: true }];
    expect(checklistForNewVisit({ trades: ['roofing'], checklist: own }, 'plumbing')).toBe(own);
    // The job's trade before the business's first one.
    expect(checklistForNewVisit({ trades: ['roofing'] }, 'plumbing')).toBe(
      STARTER_CHECKLISTS.plumbing,
    );
    expect(checklistForNewVisit({ trades: ['roofing'] }, null)).toBe(STARTER_CHECKLISTS.roofing);
    expect(checklistForNewVisit({ trades: [] }, 'not a trade')).toBe(PLAIN_CHECKLIST);
    // Every trade's list has something required, so decision 8 has something to hold on.
    for (const trade of TRADES) {
      expect(
        STARTER_CHECKLISTS[trade].some((i) => i.required),
        trade,
      ).toBe(true);
      const labels = STARTER_CHECKLISTS[trade].map((i) => i.label.toLowerCase());
      expect(new Set(labels).size, trade).toBe(labels.length);
    }
  });

  it('counts what holds a job’s Done: required items neither done nor passed over', () => {
    const item = (required: boolean, done = false, skipped = false) => ({
      required,
      done,
      skipped,
    });
    const progress = checklistProgress([
      item(true, true),
      item(true),
      item(true, false, true),
      item(false),
      item(false, true),
    ]);
    expect(progress).toEqual({ total: 5, done: 2, requiredLeft: 1 });
    expect(checklistWords(progress)).toBe('2 of 5 done · 1 required left');
    expect(checklistWords({ total: 2, done: 2, requiredLeft: 0 })).toBe('2 of 2 done');
    expect(checklistWords(checklistProgress([]))).toBe('No checklist');
  });

  it('says what’s left when a job isn’t ready, and who can pass it over', () => {
    const left = ['Photo of the panel', 'Circuits tested', 'Permit posted', 'Walkthrough'];
    const mine = REFUSALS.jobNotReady('Panel swap', left, false);
    expect(mine).toContain('“Panel swap” can’t be marked done yet: 4 required items');
    expect(mine).toContain('Photo of the panel, Circuits tested, Permit posted and 1 more');
    expect(mine).toMatch(/ask an owner or admin/);
    expect(REFUSALS.jobNotReady('Panel swap', left.slice(0, 1), true)).toMatch(
      /1 required item still left .*Finish it on .*or mark the job done anyway with a reason\./,
    );
    expect(namesWords(['Ana', 'Ben'])).toBe('Ana and Ben');
    expect(namesWords(['Ana'])).toBe('Ana');
  });

  it('texts a subcontractor everything they need, since they don’t sign in', () => {
    const text = subTextWords({
      firstName: 'Sam',
      business: 'Bright Line Electric',
      job: 'Panel swap',
      address: '12 Oak St',
      when: 'Fri, Sep 18 at 10:00 AM',
      instructions: 'Swap the 100A panel for a 200A.',
      bring: 'A 200A panel',
      note: 'Park on the street.',
    });
    expect(text.split('\n')).toEqual([
      'Hi Sam, Bright Line Electric has you on a job: Panel swap at 12 Oak St, Fri, Sep 18 at 10:00 AM.',
      'Work to do: Swap the 100A panel for a 200A.',
      'Bring: A 200A panel',
      'Park on the street.',
      'Reply here with any questions.',
    ]);
    // With nothing written yet it's still a whole message, and long instructions are cut, not sent in pieces.
    const bare = subTextWords({
      firstName: null,
      business: 'Bright Line Electric',
      job: 'Panel swap',
      address: null,
      when: 'Fri, Sep 18 at 10:00 AM',
      instructions: 'x'.repeat(2_000),
      bring: null,
      note: null,
    });
    expect(bare.startsWith('Bright Line Electric has you on a job: Panel swap, Fri')).toBe(true);
    expect(bare.length).toBeLessThan(700);
  });
});

describe('materials (the owner’s decision 9)', () => {
  const m = (c: Partial<MaterialCounts>): MaterialCounts => ({
    needed: 0,
    ordered: 0,
    delivered: 0,
    used: 0,
    wasted: 0,
    returned: 0,
    ...c,
  });

  it('works out what’s short, what’s still to order and what’s left from the six counts', () => {
    const wire = m({ needed: 100, ordered: 60, delivered: 40, used: 25, wasted: 5 });
    expect(shortOf(wire)).toBe(60);
    expect(toOrderOf(wire)).toBe(40);
    expect(leftOf(wire)).toBe(10);
    // What arrived counts as ordered, however it came: picked up at the counter with no order.
    expect(toOrderOf(m({ needed: 4, delivered: 4 }))).toBe(0);
    // More used than arrived is a count the office hasn't caught up with, never a negative.
    expect(leftOf(m({ needed: 4, delivered: 2, used: 3 }))).toBe(0);
    expect(shortOf(m({ needed: 2.5, delivered: 2.125 }))).toBe(0.375);
  });

  it('says where a material stands: to order, on order, here, used up', () => {
    expect(materialState(m({ needed: 10 }))).toBe('to_order');
    expect(materialState(m({ needed: 10, ordered: 6 }))).toBe('to_order');
    expect(materialState(m({ needed: 10, ordered: 10 }))).toBe('ordered');
    expect(materialState(m({ needed: 10, ordered: 10, delivered: 4 }))).toBe('ordered');
    expect(materialState(m({ needed: 10, ordered: 10, delivered: 10 }))).toBe('here');
    expect(materialState(m({ needed: 10, delivered: 10, used: 8, wasted: 1, returned: 1 }))).toBe(
      'used',
    );
    // Nothing needed and nothing here isn't "used up".
    expect(materialState(m({}))).toBe('here');
  });

  it('moves a material along one press at a time', () => {
    expect(nextStep(m({ needed: 10, ordered: 4 }))).toEqual({
      step: 'order',
      change: { ordered: 10 },
    });
    expect(nextStep(m({ needed: 10, ordered: 10, delivered: 3 }))).toEqual({
      step: 'deliver',
      change: { delivered: 10 },
    });
    // Everything left is used: what was wasted or sent back isn't counted twice.
    expect(nextStep(m({ needed: 10, delivered: 10, used: 2, wasted: 1 }))).toEqual({
      step: 'use',
      change: { used: 9 },
    });
    expect(nextStep(m({ needed: 10, delivered: 10, used: 10 }))).toBeNull();
  });

  it('counts a visit missing what’s for it and what’s for any visit, never another visit’s', () => {
    const list = [
      { id: 'any', appointmentId: null, ...m({ needed: 2, delivered: 1 }) },
      { id: 'mine', appointmentId: 'v1', ...m({ needed: 1 }) },
      { id: 'theirs', appointmentId: 'v2', ...m({ needed: 1 }) },
      { id: 'here', appointmentId: 'v1', ...m({ needed: 1, delivered: 1 }) },
    ];
    expect(missingFor(list, 'v1').map((x) => x.id)).toEqual(['any', 'mine']);
    expect(neededOn({ appointmentId: 'v2' }, 'v1')).toBe(false);
    expect(isMissing(m({ needed: 1, delivered: 1 }))).toBe(false);
  });

  it('says amounts the way people write them', () => {
    expect(amountWords(12, 'ft')).toBe('12 ft');
    expect(amountWords(4, 'each')).toBe('4');
    expect(amountWords(2.5, ' box ')).toBe('2.5 box');
    expect(amountWords(1500, null)).toBe('1,500');
    expect(materialWords(20, 'ft', '12/2 wire')).toBe('20 ft of 12/2 wire');
    expect(materialWords(4, 'each', 'GFCI outlet')).toBe('4 × GFCI outlet');
  });

  it('costs what’s needed and what the job has taken, and says how many have no cost', () => {
    const costing = costMaterials([
      // Delivered and not sent back: 8 of them, at $2.50.
      { ...m({ needed: 10, delivered: 10, returned: 2, used: 5 }), unitCostCents: 250 },
      // The crew says it used more than the office says arrived: the job took what was used.
      { ...m({ needed: 3, delivered: 1, used: 2, wasted: 1 }), unitCostCents: 1000 },
      { ...m({ needed: 5, delivered: 5 }), unitCostCents: null },
    ]);
    expect(costing).toEqual({ plannedCents: 2500 + 3000, takenCents: 2000 + 3000, uncosted: 1 });
    expect(takenOf(m({ delivered: 4, returned: 4 }))).toBe(0);
    expect(materialCostCents(0.333, 999)).toBe(333);
  });

  it('looks at a visit’s materials that long before it, never in the past, and never when it’s off', () => {
    const start = Date.UTC(2026, 10, 20, 15);
    const hour = 3_600_000;
    expect(materialsCheckAt(start, 24, start - 72 * hour)).toBe(start - 24 * hour);
    // Booked inside the window: now.
    expect(materialsCheckAt(start, 24, start - 2 * hour)).toBe(start - 2 * hour);
    expect(materialsCheckAt(start, 0, start - 72 * hour)).toBeNull();
    expect(MATERIALS_ALERT_HOURS).toContain(DEFAULT_MATERIALS_ALERT_HOURS);
    expect(alertHoursWords(0)).toBe('Never');
    expect(alertHoursWords(2)).toBe('2 hours before');
    expect(alertHoursWords(24)).toBe('The day before');
    expect(alertHoursWords(72)).toBe('3 days before');
    expect(alertHoursWords(168)).toBe('A week before');
  });

  it('tells the people going what’s short and what to do, with no money in it', () => {
    const one = materialsAlertWords({
      job: 'Panel upgrade',
      when: 'Fri, Nov 20 at 9:00 AM',
      missing: [{ name: '200A panel', unitLabel: 'each', short: 1 }],
    });
    expect(one.title).toBe(
      '“Panel upgrade” is still missing 1 material for Fri, Nov 20 at 9:00 AM',
    );
    expect(one.detail).toContain('Still short: 1 × 200A panel.');
    expect(one.detail).toContain('mark it delivered under Materials on the job');
    const many = materialsAlertWords({
      job: 'Panel upgrade',
      when: 'Fri, Nov 20 at 9:00 AM',
      missing: Array.from({ length: 8 }, (_, i) => ({
        name: `Part ${i + 1}`,
        unitLabel: 'ft',
        short: 2,
      })),
    });
    expect(many.title).toContain('8 materials');
    expect(many.detail).toContain('2 ft of Part 5 and 3 more');
    expect(many.detail).not.toContain('$');
    // An alert's title and detail have limits of their own (the worker's alerts).
    const long = materialsAlertWords({
      job: 'J'.repeat(200),
      when: 'Fri, Nov 20 at 9:00 AM',
      missing: Array.from({ length: 300 }, () => ({
        name: 'N'.repeat(200),
        unitLabel: 'each',
        short: 1,
      })),
    });
    expect(long.title.length).toBeLessThanOrEqual(200);
    expect(long.detail.length).toBeLessThanOrEqual(1000);
  });

  it('writes what moved on a material for the job’s timeline, and nothing when no count did', () => {
    const before = m({ needed: 20, ordered: 20 });
    expect(
      materialChangeWords('12/2 wire', 'ft', before, { ...before, delivered: 20, used: 12 }),
    ).toBe('12/2 wire: 20 ft delivered, 12 ft used');
    expect(materialChangeWords('12/2 wire', 'ft', before, before)).toBe('');
    expect(materialsMissingWords(1)).toBe('1 material missing');
    expect(materialsMissingWords(3)).toBe('3 materials missing');
  });

  it('keeps its tables, its job and its events in the manifest', () => {
    expect(contractorAddon.tables).toEqual(expect.arrayContaining(['materials', 'material_costs']));
    expect(contractorAddon.jobs).toEqual(expect.arrayContaining(['contractor.materials_check']));
    expect(contractorAddon.events?.consumes).toEqual(
      expect.arrayContaining([
        'appointment.rescheduled',
        'appointment.cancelled',
        'contractor.material.added',
        'contractor.material.updated',
        'contractor.material.removed',
        'contractor.materials.filled',
      ]),
    );
    // The setting has a default, so businesses that saved their settings before it are still valid.
    expect(ContractorSettingsSchema.parse({ trades: ['electrical'] }).materialsAlertHours).toBe(24);
    expect(ContractorSettingsSchema.safeParse({ materialsAlertHours: 1000 }).success).toBe(false);
  });

  it('asks before the AI removes a material or sets a cost, and lets it keep the counts', () => {
    const tool = (name: string) =>
      (contractorAddonServer.commands ?? []).find((c) => c.name === name)?.ai as
        { autonomy?: string } | undefined;
    expect(tool('contractor.material.remove')?.autonomy).toBe('confirm');
    expect(tool('contractor.material.set_cost')?.autonomy).toBe('confirm');
    expect(tool('contractor.material.add')).toBeDefined();
    expect(tool('contractor.material.add')?.autonomy).toBeUndefined();
    expect(tool('contractor.material.update')?.autonomy).toBeUndefined();
    // The worker's own command is no tool of the AI's.
    expect(tool('contractor.material.stamp_cost')).toBeUndefined();
  });
});

describe('time on a job (the owner’s decision 10)', () => {
  const at = (hhmm: string) => Date.parse(`2026-11-10T${hhmm}:00Z`);

  it('starts travel at On the way and work at Started, and stops at anything else', () => {
    expect(clockFor('on_the_way')).toBe('travel');
    expect(clockFor('in_progress')).toBe('work');
    for (const s of ['scheduled', 'waiting_on_parts', 'done', 'cancelled', 'anything'])
      expect(clockFor(s)).toBeNull();
    expect(isPaid('work')).toBe(true);
    expect(isPaid('travel')).toBe(true);
    expect(isPaid('break')).toBe(false);
  });

  it('measures a stretch up to now while it runs, never below nothing', () => {
    expect(secondsOf({ startedAt: at('09:00'), endedAt: at('11:30') }, at('15:00'))).toBe(9000);
    expect(secondsOf({ startedAt: at('09:00'), endedAt: null }, at('09:45'))).toBe(2700);
    expect(secondsOf({ startedAt: at('09:00'), endedAt: at('08:00') }, at('09:45'))).toBe(0);
    expect(hoursOf(9000)).toBe(2.5);
    expect(hoursOf(100)).toBe(0.03);
    expect(limitOf(at('09:00'))).toBe(at('09:00') + MAX_RUNNING_HOURS * 3_600_000);
  });

  it('adds up work, travel and breaks, and counts only work and travel as labor', () => {
    const t = totalsOf(
      [
        { kind: 'travel', startedAt: at('08:30'), endedAt: at('09:00') },
        { kind: 'work', startedAt: at('09:00'), endedAt: at('12:00') },
        { kind: 'break', startedAt: at('12:00'), endedAt: at('12:30') },
        { kind: 'work', startedAt: at('12:30'), endedAt: null },
      ],
      at('13:00'),
    );
    expect(t).toEqual({
      workSeconds: 3 * 3600 + 1800,
      travelSeconds: 1800,
      breakSeconds: 1800,
      paidSeconds: 4 * 3600,
      running: 1,
    });
  });

  it('says how long in plain words', () => {
    expect(durationWords(0)).toBe('under a minute');
    expect(durationWords(59)).toBe('under a minute');
    expect(durationWords(45 * 60)).toBe('45 min');
    expect(durationWords(3 * 3600)).toBe('3 h');
    expect(durationWords(2 * 3600 + 15 * 60 + 40)).toBe('2 h 15 min');
    expect(timeAmountWords('work', 8100)).toBe('2 h 15 min of work');
    expect(timeAmountWords('break', 1800)).toBe('30 min of break');
    expect(stretchWords('travel', '8:30 AM', '9:00 AM')).toBe('travel from 8:30 AM to 9:00 AM');
    expect(stretchWords('work', '9:00 AM', null)).toBe('work from 9:00 AM, still running');
  });

  it('costs a stretch at what its hour cost: nothing for a break or with no cost', () => {
    expect(stretchCostCents('work', 9000, 4000)).toBe(10_000);
    expect(stretchCostCents('travel', 1800, 4000)).toBe(2000);
    expect(stretchCostCents('work', 100, 4000)).toBe(111);
    expect(stretchCostCents('break', 1800, 4000)).toBe(0);
    expect(stretchCostCents('work', 9000, null)).toBe(0);
  });

  it('refuses a fixed time that ends first, runs over a day, or is still to come', () => {
    const now = at('15:00');
    expect(fixProblem(at('09:00'), at('11:00'), now)).toBeNull();
    expect(fixProblem(at('09:00'), at('09:00'), now)).toBe('ends_first');
    expect(fixProblem(at('11:00'), at('09:00'), now)).toBe('ends_first');
    expect(fixProblem(at('09:00') - 25 * 3_600_000, at('09:00'), now)).toBe('too_long');
    expect(fixProblem(at('14:00'), at('15:30'), now)).toBe('in_future');
    // A minute's grace for a clock that runs a little ahead.
    expect(fixProblem(at('14:00'), now + 30_000, now)).toBeNull();
    for (const k of ['ends_first', 'too_long', 'in_future'] as const)
      expect(FIX_PROBLEM_WORDS[k].length).toBeGreaterThan(20);
  });

  it('tells the people who fix time whose ran over, in a title and detail that fit, with no money', () => {
    const words = timeStoppedAlertWords({
      job: 'Kitchen remodel',
      names: ['Dana Reyes', 'Sam Lee'],
    });
    expect(words.title).toBe('Time on “Kitchen remodel” ran 12 hours and was stopped');
    expect(words.detail).toContain('Dana Reyes and Sam Lee’s time');
    expect(words.detail).toContain('press Fix');
    expect(`${words.title} ${words.detail}`).not.toMatch(/\$|cost/i);
    const long = timeStoppedAlertWords({
      job: 'J'.repeat(400),
      names: Array.from({ length: 60 }, (_, i) => `Person ${i} ${'x'.repeat(80)}`),
    });
    expect(long.title.length).toBeLessThanOrEqual(200);
    expect(long.detail.length).toBeLessThanOrEqual(1000);
  });

  it('keeps its tables, job, events and permission in the manifest', () => {
    expect(contractorAddon.tables).toEqual(
      expect.arrayContaining(['time_entries', 'time_costs', 'labor_rates', 'other_costs']),
    );
    expect(contractorAddon.jobs).toEqual(expect.arrayContaining(['contractor.time_check']));
    expect(contractorAddon.events?.consumes).toEqual(
      expect.arrayContaining([
        'job.status_changed',
        'appointment.cancelled',
        'contractor.time.tracked',
        'contractor.time.break_set',
        'contractor.time.fixed',
        'contractor.time.added',
        'contractor.time.removed',
        'contractor.labor_rate.set',
        'contractor.estimating.saved',
      ]),
    );
    const fix = contractorAddon.permissions.find((p) => p.key === 'contractor.fix_time');
    expect(fix?.defaultRoles).toEqual(['admin']);
    expect(fix?.requires).toEqual(['contractor.use']);
    expect(contractorAddon.ui?.nav?.find((n) => n.key === 'profit')?.permission).toBe(
      'contractor.costs',
    );
  });

  it('lets the AI start a break on its own, asks before it fixes time, and keeps costs to people who may see them', () => {
    const all = [
      ...(contractorAddonServer.commands ?? []),
      ...(contractorAddonServer.queries ?? []),
    ];
    const op = (name: string) => all.find((c) => c.name === name);
    const tool = (name: string) => op(name)?.ai as { autonomy?: string } | undefined;
    expect(tool('contractor.time.set_break')).toBeDefined();
    expect(tool('contractor.time.set_break')?.autonomy).toBeUndefined();
    for (const name of [
      'contractor.time.fix',
      'contractor.time.add',
      'contractor.time.remove',
      'contractor.labor_rate.set',
      'contractor.other_cost.add',
      'contractor.other_cost.remove',
    ])
      expect(tool(name)?.autonomy, name).toBe('confirm');
    for (const name of ['contractor.time.fix', 'contractor.time.add', 'contractor.time.remove'])
      expect(op(name)?.permission, name).toBe('contractor.fix_time');
    expect(op('contractor.labor_rate.set')?.permission).toBe('contractor.approve');
    for (const name of [
      'contractor.labor_rate.list',
      'contractor.job.costing',
      'contractor.profit',
      'contractor.other_cost.add',
      'contractor.other_cost.remove',
    ])
      expect(op(name)?.permission, name).toBe('contractor.costs');
    // Time itself is everyone's who uses the add-on, and never carries what it cost.
    expect(op('contractor.time.list')?.permission).toBe('contractor.use');
    // The worker's own commands are no tools of the AI's.
    for (const name of [
      'contractor.time.follow_status',
      'contractor.time.stamp_costs',
      'contractor.time.stop_overrun',
    ])
      expect(tool(name), name).toBeUndefined();
  });
});

describe('job costing and profit (the owner’s decisions 10 and 11)', () => {
  const budget = (b: Partial<CostingBudget> = {}): CostingBudget => ({
    priceCents: 500_000,
    laborCents: 120_000,
    materialsCents: 80_000,
    otherCents: null,
    laborHours: 30,
    ...b,
  });
  const actual = (a: Partial<CostingActual> = {}): CostingActual => ({
    laborCents: 0,
    laborSeconds: 0,
    uncostedSeconds: 0,
    materialsCents: 0,
    materialsPlannedCents: 0,
    uncostedMaterials: 0,
    otherCents: 0,
    ...a,
  });

  it('heads for the plan until there’s something to go on', () => {
    const c = costJob({ status: 'scheduled', percentDone: 0 }, budget(), actual());
    expect(c.total).toEqual({ budgetCents: 200_000, actualCents: 0, headingCents: 200_000 });
    expect(c.profit.plannedCents).toBe(300_000);
    expect(c.profit.plannedMarginBp).toBe(6000);
    expect(c.profit.soFarCents).toBe(500_000);
    expect(c.profit.headingCents).toBe(300_000);
    expect(c.overCents).toBe(0);
    expect(c.finished).toBe(false);
    expect(c.hours).toEqual({ budget: 30, actual: 0, heading: 30 });
  });

  it('paces labor by the job’s % done, and materials and other costs by the larger of plan and spent', () => {
    const c = costJob(
      { status: 'in_progress', percentDone: 40 },
      budget(),
      actual({
        laborCents: 80_000,
        laborSeconds: 20 * 3600,
        materialsCents: 50_000,
        materialsPlannedCents: 90_000,
        otherCents: 15_000,
      }),
    );
    // 40% done for $800 of labor heads for $2,000; 20 hours heads for 50.
    expect(c.labor).toEqual({ budgetCents: 120_000, actualCents: 80_000, headingCents: 200_000 });
    expect(c.hours).toEqual({ budget: 30, actual: 20, heading: 50 });
    // The list would cost more than the budget, so that's where materials are heading.
    expect(c.materials.headingCents).toBe(90_000);
    // No budget for other costs: they head for what's spent.
    expect(c.other).toEqual({ budgetCents: null, actualCents: 15_000, headingCents: 15_000 });
    expect(c.total).toEqual({ budgetCents: 200_000, actualCents: 145_000, headingCents: 305_000 });
    expect(c.overCents).toBe(105_000);
    expect(c.profit.headingCents).toBe(195_000);
    expect(c.profit.headingMarginBp).toBe(3900);
    expect(headsUnderMargin(c, 4000)).toBe(true);
    expect(headsUnderMargin(c, 2000)).toBe(false);
  });

  it('doesn’t trust a pace from a job that has barely started', () => {
    const c = costJob(
      { status: 'in_progress', percentDone: 5 },
      budget(),
      actual({ laborCents: 30_000, laborSeconds: 8 * 3600 }),
    );
    // 5% done says nothing yet: labor heads for the plan, or what's spent when that's more.
    expect(c.labor.headingCents).toBe(120_000);
    const over = costJob(
      { status: 'in_progress', percentDone: 5 },
      budget(),
      actual({ laborCents: 150_000, laborSeconds: 40 * 3600 }),
    );
    expect(over.labor.headingCents).toBe(150_000);
  });

  it('counts a finished job at exactly what it cost', () => {
    const c = costJob(
      { status: 'done', percentDone: 100 },
      budget(),
      actual({
        laborCents: 100_000,
        laborSeconds: 26 * 3600,
        uncostedSeconds: 3600,
        materialsCents: 60_000,
        materialsPlannedCents: 90_000,
        uncostedMaterials: 2,
        otherCents: 5000,
      }),
    );
    expect(c.finished).toBe(true);
    expect(c.total).toEqual({ budgetCents: 200_000, actualCents: 165_000, headingCents: 165_000 });
    expect(c.profit.headingCents).toBe(335_000);
    expect(c.overCents).toBe(0);
    expect(c.uncostedHours).toBe(1);
    expect(c.uncostedMaterials).toBe(2);
    // A cancelled job is finished too.
    expect(costJob({ status: 'cancelled', percentDone: 30 }, budget(), actual()).finished).toBe(
      true,
    );
  });

  it('says nothing about profit or going over when no price or cost was planned', () => {
    const c = costJob(
      { status: 'in_progress', percentDone: 50 },
      {
        priceCents: null,
        laborCents: null,
        materialsCents: null,
        otherCents: null,
        laborHours: null,
      },
      actual({ laborCents: 40_000, laborSeconds: 10 * 3600 }),
    );
    expect(c.total.budgetCents).toBeNull();
    expect(c.overCents).toBeNull();
    expect(c.profit).toEqual({
      plannedCents: null,
      plannedMarginBp: null,
      soFarCents: null,
      headingCents: null,
      headingMarginBp: null,
    });
    expect(c.labor.headingCents).toBe(80_000);
    expect(c.hours).toEqual({ budget: null, actual: 10, heading: 20 });
    expect(headsUnderMargin(c, 2000)).toBe(false);
  });

  it('covers whole calendar months, quarters and years in the business’s today', () => {
    expect(periodOf('month', '2026-11-10')).toEqual({ from: '2026-11-01', to: '2026-11-30' });
    expect(periodOf('month', '2028-02-29')).toEqual({ from: '2028-02-01', to: '2028-02-29' });
    expect(periodOf('last_month', '2026-11-10')).toEqual({ from: '2026-10-01', to: '2026-10-31' });
    expect(periodOf('last_month', '2026-01-05')).toEqual({ from: '2025-12-01', to: '2025-12-31' });
    expect(periodOf('quarter', '2026-11-10')).toEqual({ from: '2026-10-01', to: '2026-12-31' });
    expect(periodOf('quarter', '2026-02-10')).toEqual({ from: '2026-01-01', to: '2026-03-31' });
    expect(periodOf('year', '2026-11-10')).toEqual({ from: '2026-01-01', to: '2026-12-31' });
    expect(periodOf('all', '2026-11-10')).toBeNull();
    expect(periodOf('open', '2026-11-10')).toBeNull();
  });

  it('splits profit by job, customer, crew or service, each job counted once, the most profit first', () => {
    const job = (j: Partial<ProfitJob> & Pick<ProfitJob, 'jobId'>): ProfitJob => ({
      name: `Job ${j.jobId}`,
      priceCents: 100_000,
      costCents: 60_000,
      laborSeconds: 3600,
      customer: null,
      crew: null,
      trade: null,
      ...j,
    });
    const dana = { id: 'c1', name: 'Dana Reyes' };
    const crewA = { id: 'k1', name: 'Crew A' };
    const list = [
      job({ jobId: 'a', customer: dana, crew: crewA, trade: 'electrical' }),
      job({
        jobId: 'b',
        customer: dana,
        trade: 'electrical',
        priceCents: 50_000,
        costCents: 70_000,
      }),
      job({ jobId: 'c', crew: crewA, trade: 'plumbing', priceCents: 300_000, costCents: 100_000 }),
    ];
    const total = profitTotal(list);
    expect(total).toMatchObject({
      jobs: 3,
      priceCents: 450_000,
      costCents: 230_000,
      profitCents: 220_000,
      marginBp: 4889,
      laborHours: 3,
    });
    const byJob = groupProfit(list, 'job');
    expect(byJob.map((r) => r.key)).toEqual(['c', 'a', 'b']);
    expect(byJob[2]).toMatchObject({ profitCents: -20_000, marginBp: -4000 });
    const byCustomer = groupProfit(list, 'customer');
    expect(byCustomer.map((r) => [r.name, r.jobs, r.profitCents])).toEqual([
      [null, 1, 200_000],
      ['Dana Reyes', 2, 20_000],
    ]);
    const byCrew = groupProfit(list, 'crew');
    expect(byCrew.map((r) => [r.name, r.jobs, r.profitCents])).toEqual([
      ['Crew A', 2, 240_000],
      [null, 1, -20_000],
    ]);
    const byTrade = groupProfit(list, 'trade');
    expect(byTrade.map((r) => [r.key, r.jobs, r.profitCents])).toEqual([
      ['plumbing', 1, 200_000],
      ['electrical', 2, 20_000],
    ]);
    // Every split adds up to the same total.
    for (const rows of [byJob, byCustomer, byCrew, byTrade])
      expect(rows.reduce((n, r) => n + r.profitCents, 0)).toBe(total.profitCents);
    expect(groupProfit([], 'job')).toEqual([]);
    expect(profitTotal([])).toMatchObject({ jobs: 0, profitCents: 0, marginBp: null });
  });
});

describe('on the phone (part 6)', () => {
  const note = (n: Partial<NoteParts>): NoteParts => ({
    body: null,
    spoken: false,
    transcript: null,
    transcriptState: 'none',
    photos: 0,
    ...n,
  });

  it('says a note in one line: what was typed, else what was said, with its photos', () => {
    expect(noteLine(note({ body: 'The shutoff  valve is\nbehind the heater.' }))).toBe(
      'The shutoff valve is behind the heater.',
    );
    expect(noteLine(note({ body: 'Gate code 4411', photos: 2 }))).toBe('Gate code 4411 (2 photos)');
    expect(
      noteLine(
        note({ spoken: true, transcript: 'The coil is iced over.', transcriptState: 'done' }),
      ),
    ).toBe('The coil is iced over.');
    // What was typed wins over what was said.
    expect(
      noteLine(note({ body: 'Typed', spoken: true, transcript: 'Said', transcriptState: 'done' })),
    ).toBe('Typed');
    expect(noteLine(note({ spoken: true, transcriptState: 'waiting' }))).toBe(
      'Voice note, its words are on their way',
    );
    expect(noteLine(note({ spoken: true, transcriptState: 'failed', photos: 1 }))).toBe(
      'Voice note (1 photo)',
    );
    expect(noteLine(note({ photos: 3 }))).toBe('3 photos');
    expect(noteLine(note({}))).toBe('Note');
    const long = noteLine(note({ body: 'word '.repeat(100) }), 40);
    expect(long.length).toBeLessThanOrEqual(40);
    expect(long.endsWith('…')).toBe(true);
  });

  it('puts a note on the job’s timeline without its recording', () => {
    expect(noteAddedWords({ body: 'Gate code 4411', spoken: false, photos: 0 })).toBe(
      'added a note: “Gate code 4411”',
    );
    expect(noteAddedWords({ body: null, spoken: true, photos: 2 })).toBe(
      'added a voice note with 2 photos',
    );
    expect(noteAddedWords({ body: null, spoken: false, photos: 1 })).toBe('added 1 photo');
    expect(noteAddedWords({ body: null, spoken: false, photos: 0 })).toBe('added a note');
  });

  it('takes a note that says something, and a count that counts something', () => {
    const file = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
    const on = { workspaceId: file(1), jobId: file(2) };
    expect(NoteAddInput.safeParse(on).success).toBe(false);
    expect(NoteAddInput.safeParse({ ...on, body: '   ' }).success).toBe(false);
    expect(NoteAddInput.safeParse({ ...on, body: 'Gate code 4411' }).success).toBe(true);
    expect(NoteAddInput.safeParse({ ...on, audioFileId: file(3) }).success).toBe(true);
    expect(NoteAddInput.safeParse({ ...on, photoFileIds: [file(4)] }).success).toBe(true);
    expect(
      NoteAddInput.safeParse({
        ...on,
        photoFileIds: Array.from({ length: NOTE_LIMITS.photos + 1 }, (_, i) => file(i + 10)),
      }).success,
    ).toBe(false);
    const material = { workspaceId: file(1), materialId: file(5) };
    expect(MaterialCountInput.safeParse(material).success).toBe(false);
    expect(MaterialCountInput.safeParse({ ...material, used: 0 }).success).toBe(false);
    expect(MaterialCountInput.safeParse({ ...material, used: 2, wasted: 0.5 }).success).toBe(true);
    // Below nothing takes some back: a slip of the thumb can be undone.
    expect(MaterialCountInput.safeParse({ ...material, used: -1 }).success).toBe(true);
  });

  it('keeps an open job on phones, and a closed one a month', () => {
    const at = Date.UTC(2026, 8, 16);
    for (const status of ['new', 'scheduled', 'in_progress', 'on_hold'] as const)
      expect(leavesPhonesAt({ status, statusAt: at }), status).toBeNull();
    for (const status of ['done', 'cancelled'] as const)
      expect(leavesPhonesAt({ status, statusAt: at }), status).toBe(at + PHONE_DAYS * 86_400_000);
    expect(PHONE_DAYS).toBe(30);
  });

  it('says how many changes wait, and how long a recording ran', () => {
    const P = CONTRACTOR_PHONE_WORDS;
    expect(P.kept.waiting(1)).toBe(
      'No signal. 1 change waits on this phone and will send on its own.',
    );
    expect(P.kept.waiting(3)).toBe(
      'No signal. 3 changes wait on this phone and will send on their own.',
    );
    expect(P.more.detail(4, 0)).toBe('4 open');
    expect(P.more.detail(4, 1)).toBe('4 open · 1 visit for you today');
    expect(P.more.detail(0, 2)).toBe('0 open · 2 visits for you today');
    expect(clockOfSeconds(0)).toBe('0:00');
    expect(clockOfSeconds(65.9)).toBe('1:05');
    expect(clockOfSeconds(-3)).toBe('0:00');
    // Where a fix is on the phone itself, the words name the setting.
    expect(P.visit.noCamera).toContain('Settings → HandsFreeOS → Camera');
    expect(P.notes.noMicrophone).toContain('Settings → HandsFreeOS → Microphone');
  });

  it('keeps its table, jobs, events, phone pages and what phones hold in the manifest, with no money', () => {
    expect(contractorAddon.tables).toEqual(expect.arrayContaining(['notes']));
    expect(contractorAddon.jobs).toEqual(expect.arrayContaining(['contractor.phone_check']));
    expect(contractorAddon.events?.consumes).toEqual(
      expect.arrayContaining(['contractor.note.added', 'contractor.job.status_changed']),
    );
    expect(contractorAddon.ui?.phone).toEqual([
      { path: '', query: ['filter', 'q'] },
      { path: 'jobs/:jobId' },
      { path: 'visits/:appointmentId' },
    ]);
    const kept = contractorAddon.offline?.tables ?? [];
    expect(contractorAddon.offline?.permission).toBe('contractor.use');
    expect(kept.map((t) => t.table).sort()).toEqual([
      'crews',
      'jobs',
      'materials',
      'notes',
      'phases',
      'team',
      'time_entries',
      'work_order_items',
      'work_order_subs',
      'work_orders',
    ]);
    // Every table a phone keeps is one of the add-on's own.
    for (const t of kept) expect(contractorAddon.tables, t.table).toContain(t.table);
    // The owner's decision 11: no price, budget or cost leaves for a phone.
    expect(
      kept.flatMap((t) => t.columns).filter((c) => /cents|cost|price|rate|margin|budget/.test(c)),
    ).toEqual([]);
  });

  it('lets the AI add a note and a count on its own, asks before it removes a note, and waits where phones can', () => {
    const all = [
      ...(contractorAddonServer.commands ?? []),
      ...(contractorAddonServer.queries ?? []),
    ];
    const op = (name: string) => all.find((c) => c.name === name);
    const tool = (name: string) => op(name)?.ai as { autonomy?: string } | undefined;
    for (const name of ['contractor.note.add', 'contractor.material.count']) {
      expect(tool(name), name).toBeDefined();
      expect(tool(name)?.autonomy, name).toBeUndefined();
    }
    expect(tool('contractor.note.remove')?.autonomy).toBe('confirm');
    expect(tool('contractor.note.list')).toBeDefined();
    // The worker's own: a recording's words.
    expect(tool('contractor.note.transcribed')).toBeUndefined();
    for (const name of ['contractor.note.add', 'contractor.note.remove', 'contractor.note.list'])
      expect(op(name)?.permission, name).toBe('contractor.use');
    // What a tech does with no signal waits on the phone; what must be checked against everything else doesn't.
    const offline = (name: string) => (op(name) as { offline?: unknown } | undefined)?.offline;
    for (const name of [
      'contractor.note.add',
      'contractor.material.count',
      'contractor.work_order.item_set',
      'contractor.time.set_break',
      'contractor.job.set_percent',
      'contractor.phase.update',
    ])
      expect(offline(name), name).toBe('anytime');
    for (const name of ['contractor.job.set_status', 'contractor.note.remove'])
      expect(offline(name), name).toBe('online');
  });
});

describe('the AI helpers (part 7)', () => {
  describe('an estimate the AI drafts (the owner’s decision 6)', () => {
    const items: DraftItem[] = [
      {
        productId: '11111111-1111-4111-8111-111111111111',
        name: 'Cedar picket, 6 ft',
        description: null,
        unitLabel: 'each',
        unitPriceCents: 450,
        taxable: true,
        kind: 'material',
        costCents: 280,
      },
      {
        productId: '22222222-2222-4222-8222-222222222222',
        name: 'Gate kit',
        description: 'Hinges and a latch',
        unitLabel: 'kit',
        unitPriceCents: 9_500,
        taxable: true,
        kind: 'material',
        costCents: null,
      },
    ];
    const estimating = { markupBp: 5000, laborRateCents: 9_500, laborCostCents: 4_200 };
    const source = (options: 1 | 3 = 1) => ({ items, estimating, options });
    const line = (l: Record<string, unknown>) => ({
      item: '',
      name: '',
      description: '',
      quantity: 1,
      unitLabel: '',
      kind: 'material',
      unitCostCents: 0,
      ...l,
    });
    const answer = (lines: unknown[], more: Record<string, unknown> = {}) =>
      EstimateDraftAnswer.parse({
        title: 'North fence',
        options: [{ name: '', lines }],
        assumptions: [],
        questions: [],
        ...more,
      });

    it('keeps a price list item at the business’s own name, unit, price and cost', () => {
      const d = checkedEstimateDraft(
        answer([
          line({
            item: 'i1',
            name: 'Premium pickets',
            quantity: 80,
            unitLabel: 'box',
            unitCostCents: 1,
          }),
          line({ item: 'I2', quantity: 2 }),
        ]),
        source(),
      )!;
      expect(d.options).toHaveLength(1);
      expect(d.options[0]!.name).toBe('');
      expect(d.options[0]!.lines).toEqual([
        {
          productId: items[0]!.productId,
          name: 'Cedar picket, 6 ft',
          description: null,
          quantity: 80,
          unitLabel: 'each',
          unitPriceCents: 450,
          taxable: true,
          kind: 'material',
          unitCostCents: 280,
          guessed: false,
        },
        {
          productId: items[1]!.productId,
          name: 'Gate kit',
          description: 'Hinges and a latch',
          quantity: 2,
          unitLabel: 'kit',
          unitPriceCents: 9_500,
          taxable: true,
          kind: 'material',
          // The price list has no cost for it: that's the business's to put in, not the AI's to guess.
          unitCostCents: null,
          guessed: false,
        },
      ]);
      expect(guessedLines(d)).toBe(0);
    });

    it('prices labor at the business’s hourly price and cost, never the AI’s', () => {
      const d = checkedEstimateDraft(
        answer([
          line({
            name: 'Install labor',
            kind: 'labor',
            quantity: 12.5,
            unitLabel: 'day',
            unitCostCents: 99_999,
          }),
        ]),
        source(),
      )!;
      expect(d.options[0]!.lines[0]).toEqual({
        productId: null,
        name: 'Install labor',
        description: null,
        quantity: 12.5,
        unitLabel: 'hour',
        unitPriceCents: 9_500,
        taxable: false,
        kind: 'labor',
        unitCostCents: 4_200,
        guessed: false,
      });
    });

    it('marks anything on no price list as a guess, priced at the starting markup', () => {
      const d = checkedEstimateDraft(
        answer([
          line({ name: 'Concrete mix', quantity: 6, unitLabel: 'bag', unitCostCents: 700 }),
          line({ name: 'Fence permit', kind: 'other', unitCostCents: 7_500 }),
          line({ name: 'Post caps', quantity: 10 }),
          // An item the price list doesn't have is a line the AI named, so a guess.
          line({ item: 'I9', name: 'Stain', unitCostCents: 3_000 }),
        ]),
        source(),
      )!;
      const [mix, permit, caps, stain] = d.options[0]!.lines;
      expect(mix).toMatchObject({
        productId: null,
        unitLabel: 'bag',
        unitCostCents: 700,
        unitPriceCents: priceFromMarkup(700, 5000),
        taxable: true,
        guessed: true,
      });
      expect(permit).toMatchObject({ kind: 'other', taxable: false, guessed: true });
      // No guess at all: no cost and no price, still marked for the person to fill in.
      expect(caps).toMatchObject({
        unitLabel: 'each',
        unitCostCents: null,
        unitPriceCents: 0,
        guessed: true,
      });
      expect(stain).toMatchObject({ productId: null, name: 'Stain', guessed: true });
      expect(guessedLines(d)).toBe(4);
    });

    it('caps a guess, drops lines with no name or quantity, and says nothing came back when none are left', () => {
      const d = checkedEstimateDraft(
        answer([
          line({ name: 'Crane', unitCostCents: 9_999_999_999 }),
          line({ name: '', quantity: 3 }),
          line({ name: 'Nothing', quantity: 0 }),
          line({ name: 'Negative', quantity: -2 }),
        ]),
        source(),
      )!;
      expect(d.options[0]!.lines.map((l) => l.name)).toEqual(['Crane']);
      expect(d.options[0]!.lines[0]!.unitCostCents).toBe(DRAFT_LIMITS.guessCents);
      expect(checkedEstimateDraft(answer([line({ name: '', quantity: 3 })]), source())).toBeNull();
      expect(checkedEstimateDraft(answer([]), source())).toBeNull();
    });

    it('writes one price unless three were asked for, and names the three', () => {
      const three = answer([], {
        options: [
          { name: 'Repair', lines: [line({ item: 'I1', quantity: 10 })] },
          { name: '', lines: [line({ item: 'I1', quantity: 40 })] },
          { name: '', lines: [] },
          { name: 'Extra', lines: [line({ item: 'I1', quantity: 90 })] },
        ],
      });
      // One price asked for: only the first option, with no name.
      const one = checkedEstimateDraft(three, source(1))!;
      expect(one.options.map((o) => o.name)).toEqual(['']);
      // Three asked for: an empty option is dropped, and a missing name is Good, Better or Best by its place.
      const many = checkedEstimateDraft(three, source(3))!;
      expect(many.options.map((o) => o.name)).toEqual(['Repair', 'Better']);
    });

    it('keeps what the AI assumed and asked, short and once each', () => {
      const d = checkedEstimateDraft(
        answer([line({ item: 'I1', quantity: 5 })], {
          title: '  North   fence — 40 ft  ',
          assumptions: ['10% waste on pickets', '10% WASTE on pickets', '', 'x'.repeat(900)],
          questions: Array.from({ length: 9 }, (_, i) => `Question ${i + 1}?`),
        }),
        source(),
      )!;
      expect(d.title).not.toMatch(/—/);
      expect(d.assumptions).toHaveLength(2);
      expect(d.assumptions[1]!.length).toBeLessThanOrEqual(DRAFT_LIMITS.point);
      expect(d.questions).toHaveLength(DRAFT_LIMITS.questions);
    });

    it('fits what the builder and the draft’s table take', () => {
      const d = checkedEstimateDraft(
        answer([
          line({ item: 'I1', quantity: 80 }),
          line({ name: 'Install labor', kind: 'labor', quantity: 12 }),
          line({ name: 'Concrete mix', quantity: 6, unitLabel: 'bag', unitCostCents: 700 }),
        ]),
        source(),
      )!;
      expect(EstimateDraftBody.safeParse(d).success).toBe(true);
    });

    it('needs something to go on', () => {
      const none = { brief: null, notes: [], photos: 0, job: { details: null } };
      expect(draftHasEnough(none)).toBe(false);
      expect(draftHasEnough({ ...none, brief: '  ' })).toBe(false);
      expect(draftHasEnough({ ...none, brief: '40 ft of fence' })).toBe(true);
      expect(draftHasEnough({ ...none, photos: 1 })).toBe(true);
      expect(draftHasEnough({ ...none, job: { details: 'Replace the north fence' } })).toBe(true);
      expect(
        draftHasEnough({ ...none, notes: [{ by: null, when: 'Mon', text: '', photos: 0 }] }),
      ).toBe(false);
      expect(
        draftHasEnough({
          ...none,
          notes: [{ by: 'Sam', when: 'Mon', text: 'Rotten posts', photos: 0 }],
        }),
      ).toBe(true);
    });

    it('shows the AI the price list by short names, never an id, and what it costs', () => {
      const s: DraftSource = {
        job: {
          name: 'Fence at the Garcias’',
          kind: 'Service call',
          trade: 'Fencing',
          details: null,
          property: '12 Oak St',
        },
        brief: 'Replace 40 ft <b>of</b> fence',
        notes: [{ by: 'Sam', when: 'Monday 2:14 PM', text: 'Three posts are rotten', photos: 2 }],
        photos: 2,
        items,
        estimating,
        options: 3,
      };
      const ask = estimateDraftAsk(s);
      expect(ask).toContain('I1 | Cedar picket, 6 ft | material | $4.50 per each | costs $2.80');
      expect(ask).toContain('I2 | Gate kit | material | $95.00 per kit | cost not set');
      expect(ask).not.toContain(items[0]!.productId);
      expect(ask).toContain('Three posts are rotten');
      expect(ask).toContain('2 photos from the job are below.');
      expect(ask).toContain('Write three options: Good, Better and Best.');
      // The business's labor cost is its own: the AI is told the price only.
      expect(ask).toContain('Labor is $95.00 an hour to the customer.');
      expect(ask).not.toContain('42.00');
      expect(ESTIMATE_DRAFT_SYSTEM).toContain('A person at the company checks every line');
      expect(ESTIMATE_DRAFT_SYSTEM).toContain('never state that something meets code');
      // No nulls in the schema's enums: the model refuses those.
      expect(JSON.stringify(ESTIMATE_DRAFT_SCHEMA)).not.toContain('null');
    });
  });

  describe('a job heading over its budget', () => {
    const budget = (b: Partial<CostingBudget> = {}): CostingBudget => ({
      priceCents: 500_000,
      laborCents: 120_000,
      materialsCents: 80_000,
      otherCents: null,
      laborHours: 30,
      ...b,
    });
    const actual = (a: Partial<CostingActual> = {}): CostingActual => ({
      laborCents: 0,
      laborSeconds: 0,
      uncostedSeconds: 0,
      materialsCents: 0,
      materialsPlannedCents: 0,
      uncostedMaterials: 0,
      otherCents: 0,
      ...a,
    });
    const going = (
      percentDone: number,
      a: Partial<CostingActual>,
      b: Partial<CostingBudget> = {},
    ) => costJob({ status: 'in_progress', percentDone }, budget(b), actual(a));

    it('is fine on plan, and a little over isn’t worth telling', () => {
      expect(watchBudget(going(0, {}), 2000)).toEqual({ level: 'ok', overPercent: 0, band: 0 });
      // Heading for $2,080 against $2,000: 4% over.
      const c = going(50, { laborCents: 64_000, laborSeconds: 16 * 3600 });
      expect(c.total.headingCents).toBe(208_000);
      expect(watchBudget(c, 2000)).toEqual({ level: 'ok', overPercent: 4, band: 0 });
    });

    it('says over from 5% past the planned cost, by how much, in steps of ten', () => {
      // Heading for $2,400 against $2,000: 20% over, still well above a 20% lowest margin.
      const c = going(50, { laborCents: 80_000, laborSeconds: 20 * 3600 });
      expect(c.overCents).toBe(40_000);
      expect(watchBudget(c, 2000)).toEqual({ level: 'over', overPercent: 20, band: 2 });
      expect(WATCH.overPercent).toBe(5);
    });

    it('says under the lowest margin only when the plan was above it', () => {
      const c = going(40, { laborCents: 80_000, laborSeconds: 20 * 3600 });
      // Heading for 44% against a 60% plan.
      expect(c.profit.headingMarginBp).toBe(4400);
      expect(watchBudget(c, 5800).level).toBe('under_margin');
      // A job planned under the lowest margin was OK’d that way: being over is what’s told.
      expect(watchBudget(c, 7000).level).toBe('over');
    });

    it('says a loss when it’s heading below nothing', () => {
      const c = going(
        20,
        { laborCents: 120_000, laborSeconds: 30 * 3600 },
        { priceCents: 250_000 },
      );
      expect(c.profit.headingCents).toBeLessThan(0);
      expect(watchBudget(c, 2000).level).toBe('loss');
    });

    it('never watches a finished job', () => {
      const c = costJob(
        { status: 'done', percentDone: 100 },
        budget(),
        actual({ laborCents: 400_000, laborSeconds: 90 * 3600 }),
      );
      expect(c.finished).toBe(true);
      expect(watchBudget(c, 2000).level).toBe('ok');
    });

    it('tells people when it first goes off plan, gets worse, or goes another step over', () => {
      const over = (band: number) => ({ level: 'over' as const, overPercent: band * 10, band });
      expect(watchIsNews(over(0), null)).toBe(true);
      expect(watchIsNews(over(1), { level: 'ok', band: 0 })).toBe(true);
      // Still over by about as much: said once.
      expect(watchIsNews(over(1), { level: 'over', band: 1 })).toBe(false);
      expect(watchIsNews(over(2), { level: 'over', band: 1 })).toBe(true);
      // Getting better isn't news, and neither is being fine.
      expect(watchIsNews(over(1), { level: 'over', band: 3 })).toBe(false);
      expect(watchIsNews(over(1), { level: 'loss', band: 1 })).toBe(false);
      expect(
        watchIsNews({ level: 'loss', overPercent: 12, band: 1 }, { level: 'over', band: 1 }),
      ).toBe(true);
      expect(
        watchIsNews({ level: 'ok', overPercent: 0, band: 0 }, { level: 'over', band: 2 }),
      ).toBe(false);
    });

    it('keeps amounts out of the alert’s title, and puts the new profit in its detail', () => {
      const c = going(50, { laborCents: 80_000, laborSeconds: 20 * 3600 });
      const words = budgetAlertWords({
        job: 'Fence at the Garcias’',
        costing: c,
        watch: watchBudget(c, 2000),
        percentDone: 50,
        minMarginBp: 2000,
      });
      // A title goes on history, which everyone on the job reads (the owner’s decision 11).
      expect(words.title).toBe('“Fence at the Garcias’” is heading over budget');
      expect(words.title).not.toMatch(/\$|\d%/);
      expect(words.detail).toContain('$2,400 in costs against $2,000 planned (20% over)');
      expect(words.detail).toContain('Profit is heading for $2,600 (52%), down from $3,000 (60%)');
      expect(words.detail).toContain('Labor is the biggest part');
      expect(words.detail).toContain('Open the job and look at Costs so far');
    });

    it('says a loss as a loss, and the lowest margin when that’s the line crossed', () => {
      const lost = going(
        20,
        { laborCents: 120_000, laborSeconds: 30 * 3600 },
        { priceCents: 250_000 },
      );
      const loss = budgetAlertWords({
        job: 'Deck',
        costing: lost,
        watch: watchBudget(lost, 2000),
        percentDone: 20,
        minMarginBp: 2000,
      });
      expect(loss.title).toBe('“Deck” is heading for a loss');
      expect(loss.detail).toContain('that’s a loss of');
      const thin = going(40, { laborCents: 80_000, laborSeconds: 20 * 3600 });
      const under = budgetAlertWords({
        job: 'Deck',
        costing: thin,
        watch: watchBudget(thin, 5800),
        percentDone: 40,
        minMarginBp: 5800,
      });
      expect(under.title).toBe('“Deck” is heading under your lowest margin');
      expect(under.detail).toContain('Your lowest margin is 58%.');
    });

    it('asks the AI for suggestions only, and tidies what it says', () => {
      const c = going(50, { laborCents: 80_000, laborSeconds: 20 * 3600, otherCents: 15_000 });
      const ask = budgetAdviceAsk({
        job: 'Fence <at> the Garcias’',
        trade: 'Fencing',
        percentDone: 50,
        costing: c,
        minMarginBp: 2000,
        otherCosts: [{ name: 'Permit', amountCents: 15_000 }],
      });
      expect(ask).toContain('Labor: planned $1,200, so far $800, heading for $1,600');
      expect(ask).toContain('Other costs so far: Permit $150');
      expect(ask).not.toContain('<at>');
      expect(BUDGET_ADVICE_SYSTEM).toContain('You only suggest.');
      const said = checkedBudgetAdvice(
        BudgetAdviceAnswer.parse({
          why: '  Labor is ahead   of progress.  ',
          suggestions: [
            'Check the % done',
            'check the % DONE',
            '',
            'Talk to the customer',
            'A',
            'B',
          ],
        }),
      )!;
      expect(said.why).toBe('Labor is ahead of progress.');
      expect(said.suggestions).toEqual(['Check the % done', 'Talk to the customer', 'A']);
      expect(
        checkedBudgetAdvice(BudgetAdviceAnswer.parse({ why: '  ', suggestions: ['x'] })),
      ).toBeNull();
      // Whatever shape comes back, it parses to something safe.
      expect(BudgetAdviceAnswer.parse({ why: 7, suggestions: 'no' })).toEqual({
        why: '',
        suggestions: [],
      });
    });
  });

  describe('a daily report', () => {
    const source = (s: Partial<ReportSource> = {}): ReportSource => ({
      job: {
        name: 'Fence at the Garcias’',
        kind: 'Service call',
        trade: 'Fencing',
        percentDone: 40,
        customerFirstName: 'Maria',
      },
      business: 'Oak Fence Co.',
      day: 'Tuesday, November 10',
      notes: [
        {
          by: 'Sam',
          at: '2:14 PM',
          visit: null,
          text: 'Set 6 posts, ran out of concrete',
          photos: 2,
        },
        { by: 'Lee', at: '4:40 PM', visit: null, text: '', photos: 1 },
      ],
      ticked: ['Photo of the finished work'],
      crew: [{ name: 'Sam', hours: 6.5 }],
      visits: [{ title: 'Fence install', status: 'in progress' }],
      photos: 3,
      ...s,
    });

    it('needs a note with words or a photo: hours alone aren’t a report', () => {
      expect(reportHasEnough(source())).toBe(true);
      expect(reportHasEnough(source({ notes: [], photos: 0 }))).toBe(false);
      expect(
        reportHasEnough(
          source({
            notes: [{ by: 'Sam', at: '1 PM', visit: null, text: '  ', photos: 0 }],
            photos: 0,
          }),
        ),
      ).toBe(false);
      expect(reportHasEnough(source({ notes: [], photos: 1 }))).toBe(true);
    });

    it('gives the AI the day’s notes, ticks and hours, and never a cost', () => {
      const ask = reportAsk(source());
      expect(ask).toContain('Set 6 posts, ran out of concrete');
      expect(ask).toContain('(photos only)');
      expect(ask).toContain('Sam: 6.5 hours');
      expect(ask).toContain('Photo of the finished work');
      expect(ask).toContain('3 photos from that day are below.');
      expect(ask).not.toMatch(/\$|cost|price/i);
      expect(REPORT_SYSTEM).toContain('anything about cost or price');
      expect(REPORT_SYSTEM).toContain('Never invent work');
    });

    it('keeps the report’s words tidy, and its paragraphs', () => {
      const r = checkedReport({
        summary: '  Six posts are set.\n\n\n\nConcrete   ran out — more is needed.  ',
        done: [
          '- Set 6 posts',
          '• set 6 POSTS',
          '',
          ...Array.from({ length: 12 }, (_, i) => `Thing ${i}`),
        ],
        issues: ['x'.repeat(900)],
        materials: [],
        next: ['Pour the rest'],
        forCustomer: '  We set six posts today.  ',
      })!;
      expect(r.summary).toBe('Six posts are set.\n\nConcrete ran out, more is needed.');
      expect(r.done[0]).toBe('Set 6 posts');
      expect(r.done).toHaveLength(REPORT_LIMITS.points);
      expect(r.done.filter((d) => /set 6 posts/i.test(d))).toHaveLength(1);
      expect(r.issues[0]!.length).toBe(REPORT_LIMITS.point);
      expect(r.forCustomer).toBe('We set six posts today.');
      expect(ReportBody.safeParse(r).success).toBe(true);
    });

    it('is nothing without a summary, and has no customer update when there’s nothing to say', () => {
      const empty = {
        summary: ' ',
        done: ['x'],
        issues: [],
        materials: [],
        next: [],
        forCustomer: 'Hi',
      };
      expect(checkedReport(empty)).toBeNull();
      expect(
        checkedReport({ ...empty, summary: 'A quiet day.', forCustomer: '  ' })!.forCustomer,
      ).toBeNull();
      expect(
        checkedReport({ ...empty, summary: 'A quiet day.', forCustomer: null })!.forCustomer,
      ).toBeNull();
    });

    it('is due at 6 PM where the business is, summer and winter', () => {
      // Central time: UTC-6 in winter, UTC-5 in summer.
      expect(reportDueAt('2026-11-10', 'America/Chicago').toISOString()).toBe(
        '2026-11-11T00:00:00.000Z',
      );
      expect(reportDueAt('2026-07-10', 'America/Chicago').toISOString()).toBe(
        '2026-07-10T23:00:00.000Z',
      );
      expect(reportDueAt('2026-11-10', 'UTC').toISOString()).toBe('2026-11-10T18:00:00.000Z');
      expect(reportDueAt('2026-11-10', 'Asia/Tokyo').toISOString()).toBe(
        '2026-11-10T09:00:00.000Z',
      );
      expect(REPORT_LIMITS.writeHour).toBe(18);
    });

    it('names a day in words', () => {
      expect(reportDayWords('2026-11-10')).toBe('Tuesday, November 10');
    });
  });

  describe('what it may do on its own (the owner’s rule)', () => {
    const op = (name: string) =>
      [...(contractorAddonServer.commands ?? []), ...(contractorAddonServer.queries ?? [])].find(
        (o) => o.name === name,
      )!;

    it('keeps the AI’s own work to the worker', () => {
      for (const name of [
        'contractor.estimate_draft.source',
        'contractor.estimate_draft.keep',
        'contractor.budget.check',
        'contractor.budget.advise',
        'contractor.report.source',
        'contractor.report.keep',
      ]) {
        const o = op(name);
        expect(o, name).toBeDefined();
        expect(o.actors, name).toEqual(['system']);
        // Nobody's Assistant is offered the worker's own operations.
        expect(o.ai, name).toBeUndefined();
      }
    });

    it('asks a person before a customer is sent anything', () => {
      const send = op('contractor.report.send') as { risk?: number; ai?: { autonomy?: string } };
      expect(send.risk).toBe(2);
      expect(send.ai?.autonomy).toBe('confirm');
    });

    it('keeps where a job’s money stands off events', () => {
      for (const name of ['contractor.budget.check', 'contractor.budget.advise']) {
        const o = op(name) as { emits?: readonly string[] };
        expect(o.emits ?? [], name).toEqual([]);
      }
      expect((contractorAddon.events?.emits ?? []).some((e) => /budget/.test(e))).toBe(false);
    });

    it('holds drafts and the budget watch to people who may see job costs, and reports to everyone on the add-on', () => {
      for (const name of [
        'contractor.estimate_draft.source',
        'contractor.estimate_draft.keep',
        'contractor.estimate_draft.list',
        'contractor.estimate_draft.dismiss',
        'contractor.budget.check',
        'contractor.budget.advise',
      ])
        expect(op(name).permission, name).toBe('contractor.costs');
      for (const name of [
        'contractor.report.list',
        'contractor.report.update',
        'contractor.report.send',
      ])
        expect(op(name).permission, name).toBe('contractor.use');
    });

    it('is on unless the business turns it off', () => {
      const s = ContractorSettingsSchema.parse({});
      expect(s.budgetWarnings).toBe(true);
      expect(s.dailyReports).toBe(true);
      expect(
        ContractorSettingsSchema.parse({ budgetWarnings: false, dailyReports: false }),
      ).toMatchObject({ budgetWarnings: false, dailyReports: false });
    });

    it('declares its tables and jobs', () => {
      for (const t of ['estimate_drafts', 'budget_watch', 'daily_reports'])
        expect(contractorAddon.tables ?? [], t).toContain(t);
      for (const j of ['contractor.budget_check', 'contractor.report_write'])
        expect(contractorAddon.jobs ?? [], j).toContain(j);
    });
  });
});
