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
  checklistForNewVisit,
  checklistProgress,
  checklistWords,
  PLAIN_CHECKLIST,
  STARTER_CHECKLISTS,
} from '../../src/addons/contractor/checklists';
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
import { ContractorSettingsSchema } from '../../src/addons/contractor/schemas';
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
