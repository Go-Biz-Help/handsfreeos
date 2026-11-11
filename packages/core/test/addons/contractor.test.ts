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
import { TRADES } from '../../src/addons/contractor/trades';
import {
  alertHoursWords,
  materialChangeWords,
  materialsAlertWords,
  materialsMissingWords,
  namesWords,
  okNeededWords,
  REFUSALS,
  subTextWords,
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
    expect(contractorAddon.jobs).toEqual(['contractor.materials_check']);
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
