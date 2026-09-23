import { describe, expect, it } from 'vitest';
import {
  addOptions,
  cardinalityOf,
  cardinalitySentences,
  checkCustomValue,
  customValueText,
  endFullWords,
  groupPairs,
  keyFromLabel,
  manyFor,
  pluralOf,
  RECORD_KIND_STARTERS,
  RELATIONSHIP_CARDINALITIES,
  RELATIONSHIP_STARTERS,
  relatedWords,
  relationshipTypeName,
  type RelationshipCardinality,
} from '../src/index';
import type { RelationshipOut, RelationshipTypeOut } from '../src/schemas/relationship';

const pet = {
  id: 'kind-pet',
  key: 'pet',
  singular: 'Pet',
  plural: 'Pets',
  nameLabel: 'Pet’s name',
  icon: 'paw',
  archived: false,
};

const type = (
  over: Partial<RelationshipTypeOut> & Pick<RelationshipTypeOut, 'id'>,
): RelationshipTypeOut => ({
  a: { end: 'person', recordType: null, label: 'Owner' },
  b: { end: 'custom_record', recordType: pet, label: 'Pet' },
  cardinality: 'many_to_many',
  mutual: false,
  position: 0,
  archivedAt: null,
  pairCount: 0,
  ...over,
});

const pair = (
  over: Partial<RelationshipOut> & Pick<RelationshipOut, 'id' | 'typeId'>,
): RelationshipOut => ({
  side: 'a',
  label: 'Pet',
  ownLabel: 'Owner',
  mutual: false,
  cardinality: 'many_to_many',
  other: {
    kind: 'custom_record',
    id: `rec-${over.id}`,
    name: 'Max',
    detail: null,
    archived: false,
    recordType: pet,
  },
  note: null,
  createdBy: null,
  createdAt: '2026-09-01T00:00:00.000Z',
  ...over,
});

describe('how many each end may have', () => {
  it('reads both answers back from every cardinality', () => {
    for (const c of RELATIONSHIP_CARDINALITIES)
      expect(cardinalityOf(manyFor(c, 'a'), manyFor(c, 'b'))).toBe<RelationshipCardinality>(c);
  });

  it('says it from both sides, and once for a mutual type', () => {
    const a = { end: 'person' as const, label: 'Owner' };
    const b = { end: 'custom_record' as const, label: 'Pet', kind: pet };
    expect(cardinalitySentences({ a, b, cardinality: 'many_to_many', mutual: false })).toEqual([
      'Each owner can have many pets.',
      'Each pet can have many owners.',
    ]);
    expect(cardinalitySentences({ a, b, cardinality: 'one_to_many', mutual: false })).toEqual([
      'Each owner can have many pets.',
      'Each pet can have one owner.',
    ]);
    const spouse = { end: 'person' as const, label: 'Spouse' };
    expect(
      cardinalitySentences({ a: spouse, b: spouse, cardinality: 'one_to_one', mutual: true }),
    ).toEqual(['Each customer can have one spouse.']);
  });

  it('starts every kind many-to-many, and only spouses and branches say otherwise', () => {
    expect(RECORD_KIND_STARTERS.every((s) => s.link.cardinality === 'many_to_many')).toBe(true);
    expect(
      RELATIONSHIP_STARTERS.filter((s) => s.cardinality !== 'many_to_many').map((s) => s.key),
    ).toEqual(['spouse', 'location']);
  });
});

describe('the words', () => {
  it('makes plurals the way people say them', () => {
    expect(pluralOf('Owner')).toBe('Owners');
    expect(pluralOf('Property')).toBe('Properties');
    expect(pluralOf('Child')).toBe('Children');
    expect(pluralOf('Parent or guardian')).toBe('Parents or guardians');
    expect(pluralOf('Equipment')).toBe('Equipment');
    expect(pluralOf('Bus')).toBe('Buses');
    expect(pluralOf('Shelf')).toBe('Shelves');
    expect(pluralOf('VIN')).toBe('VINs');
  });

  it('names a type, a full end and a timeline pair', () => {
    expect(
      relationshipTypeName({ a: { label: 'Owner' }, b: { label: 'Pet' }, mutual: false }),
    ).toBe('Owner ↔ Pet');
    expect(
      relationshipTypeName({ a: { label: 'Spouse' }, b: { label: 'Spouse' }, mutual: true }),
    ).toBe('Spouse');
    expect(endFullWords('Max', 'Owner', 'Pet')).toBe(
      'Max already has an owner. Each pet can have only one.',
    );
    expect(
      relatedWords(
        'related',
        { name: 'John Smith', label: 'Owner' },
        { name: 'Max', label: 'Pet' },
        false,
      ),
    ).toBe('added a relationship: John Smith (Owner) and Max (Pet)');
    expect(
      relatedWords(
        'unrelated',
        { name: 'Ann Lee', label: 'Spouse' },
        { name: 'Bo Lee', label: 'Spouse' },
        true,
      ),
    ).toBe('removed a relationship: Ann Lee and Bo Lee (spouses)');
  });
});

describe('a record page’s choices', () => {
  const ownerPet = type({ id: 't-pet' });
  const spouse = type({
    id: 't-spouse',
    a: { end: 'person', recordType: null, label: 'Spouse' },
    b: { end: 'person', recordType: null, label: 'Spouse' },
    cardinality: 'one_to_one',
    mutual: true,
  });
  const parent = type({
    id: 't-parent',
    a: { end: 'person', recordType: null, label: 'Parent' },
    b: { end: 'person', recordType: null, label: 'Child' },
  });

  it('offers each end the record can sit on, and greys out a full one', () => {
    const person = { kind: 'person' as const };
    const married = [
      pair({ id: '1', typeId: 't-spouse', mutual: true, label: 'Spouse', ownLabel: 'Spouse' }),
    ];
    const options = addOptions([ownerPet, spouse, parent], person, married);
    expect(options.map((o) => [o.label, o.full])).toEqual([
      ['Pet', false],
      ['Spouse', true],
      ['Child', false],
      ['Parent', false],
    ]);
    // A pet's page offers its owners, and nothing between people.
    const onPet = addOptions(
      [ownerPet, spouse, parent],
      {
        kind: 'custom_record',
        recordTypeId: pet.id,
      },
      [],
    );
    expect(onPet.map((o) => [o.label, o.side])).toEqual([['Owner', 'b']]);
    // An archived type isn't offered.
    expect(
      addOptions([{ ...ownerPet, archivedAt: '2026-09-01T00:00:00.000Z' }], person, []),
    ).toEqual([]);
  });

  it('groups pairs under what they are, in the plural when there are more than one', () => {
    const groups = groupPairs([
      pair({ id: '1', typeId: 't-pet' }),
      pair({ id: '2', typeId: 't-pet' }),
      pair({ id: '3', typeId: 't-parent', label: 'Child', side: 'a' }),
    ]);
    expect(groups.map((g) => [g.title, g.items.length])).toEqual([
      ['Pets', 2],
      ['Child', 1],
    ]);
  });
});

describe('fields a business makes up', () => {
  const field = (type: Parameters<typeof checkCustomValue>[0]['type'], options: string[] = []) => ({
    id: 'f1',
    label: 'Field',
    type,
    options: options.map((o) => ({ value: o.toLowerCase(), label: o })),
  });

  it('makes keys from names, and a new one when taken', () => {
    expect(keyFromLabel('Gate code')).toBe('gate_code');
    expect(keyFromLabel('Gate code', ['gate_code'])).toBe('gate_code_2');
    expect(keyFromLabel('Café hours')).toBe('cafe_hours');
  });

  it('checks and tidies values by type', () => {
    expect(checkCustomValue(field('number'), '1,200')).toEqual({ ok: true, value: 1200 });
    expect(checkCustomValue(field('choice', ['Dog', 'Cat']), 'dog')).toEqual({
      ok: true,
      value: 'dog',
    });
    expect(checkCustomValue(field('choice', ['Dog', 'Cat']), 'horse').ok).toBe(false);
    expect(checkCustomValue(field('date'), '2026-02-30').ok).toBe(false);
    expect(customValueText(field('multi_choice', ['Dog', 'Cat']), ['dog', 'cat'])).toBe('Dog, Cat');
  });
});
