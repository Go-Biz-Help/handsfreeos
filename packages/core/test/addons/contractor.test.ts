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
import { okNeededWords, REFUSALS } from '../../src/addons/contractor/words';

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
});
