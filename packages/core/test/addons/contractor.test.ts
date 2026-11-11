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
import { contractorAddonServer } from '../../src/addons/contractor/server';
import { TRADES } from '../../src/addons/contractor/trades';
import {
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
