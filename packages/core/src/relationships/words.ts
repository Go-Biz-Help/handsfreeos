/**
 * Relationships (0100, 0101): the words for kinds of records a business makes up, for how two records relate, and
 * for how many each end may have. Browser-safe, so the settings page, a customer's page and the timeline say the
 * same thing, and so the phone can say it too when it learns about relationships.
 *
 * A relationship type has two ends, A and B, each a person, a company or a record of one kind, and each with a label
 * that says what that end is to the other: A "Owner", B "Pet". On a customer's page the pet is listed as "Pet"; on
 * the pet's page the customer is listed as "Owner". A mutual type (spouses, siblings) has the same label on both
 * ends and no direction.
 */

/** The pictures a kind of record can wear. An app that doesn't know one draws a box. */
export const RECORD_ICONS = [
  'box',
  'paw',
  'car',
  'truck',
  'bike',
  'boat',
  'home',
  'building',
  'key',
  'student',
  'wrench',
  'plug',
  'tree',
  'heart',
  'briefcase',
  'file',
] as const;
export type RecordIcon = (typeof RECORD_ICONS)[number];

/** Each picture's name, for the picker. */
export const RECORD_ICON_LABELS: Readonly<Record<RecordIcon, string>> = {
  box: 'Box',
  paw: 'Paw print',
  car: 'Car',
  truck: 'Truck',
  bike: 'Bike',
  boat: 'Boat',
  home: 'House',
  building: 'Building',
  key: 'Key',
  student: 'Graduation cap',
  wrench: 'Wrench',
  plug: 'Plug',
  tree: 'Tree',
  heart: 'Heart',
  briefcase: 'Briefcase',
  file: 'Document',
};

export const recordIconOf = (icon: string | null | undefined): RecordIcon =>
  (RECORD_ICONS as readonly string[]).includes(icon ?? '') ? (icon as RecordIcon) : 'box';

export const RELATIONSHIP_ENDS = ['person', 'company', 'custom_record'] as const;
export type RelationshipEndKind = (typeof RELATIONSHIP_ENDS)[number];

export const RELATIONSHIP_CARDINALITIES = [
  'one_to_one',
  'one_to_many',
  'many_to_one',
  'many_to_many',
] as const;
export type RelationshipCardinality = (typeof RELATIONSHIP_CARDINALITIES)[number];

export type RelationshipSide = 'a' | 'b';

export const otherSide = (side: RelationshipSide): RelationshipSide => (side === 'a' ? 'b' : 'a');

/**
 * Whether one record on this side may be related to many on the other: one A with many Bs is `one_to_many`, so
 * `manyFor('one_to_many', 'a')` is true and `manyFor('one_to_many', 'b')` is false (each B has one A).
 */
export function manyFor(cardinality: RelationshipCardinality, side: RelationshipSide): boolean {
  if (cardinality === 'many_to_many') return true;
  if (cardinality === 'one_to_one') return false;
  return side === 'a' ? cardinality === 'one_to_many' : cardinality === 'many_to_one';
}

/** The cardinality from the two answers in the editor: may each A have many Bs, and may each B have many As. */
export function cardinalityOf(
  eachAHasManyB: boolean,
  eachBHasManyA: boolean,
): RelationshipCardinality {
  if (eachAHasManyB && eachBHasManyA) return 'many_to_many';
  if (eachAHasManyB) return 'one_to_many';
  if (eachBHasManyA) return 'many_to_one';
  return 'one_to_one';
}

const IRREGULAR: Readonly<Record<string, string>> = {
  person: 'people',
  child: 'children',
  man: 'men',
  woman: 'women',
  equipment: 'equipment',
  staff: 'staff',
  sheep: 'sheep',
  fish: 'fish',
  deer: 'deer',
  foot: 'feet',
  tooth: 'teeth',
  mouse: 'mice',
  goose: 'geese',
  ox: 'oxen',
};

/**
 * More than one, in plain English: "Owner" → "Owners", "Property" → "Properties", "Parent or guardian" → "Parents
 * or guardians", "Child" → "Children". Only the words a label is made of change, and their capitals are kept.
 */
export function pluralOf(label: string): string {
  const one = label.trim();
  if (!one) return one;
  // "Parent or guardian", "Owner / manager": each noun around the joining word.
  const joined = /^(.*?)(\s+(?:or|and|\/)\s+)(.*)$/i.exec(one);
  if (joined) return `${pluralOf(joined[1]!)}${joined[2]!}${pluralOf(joined[3]!)}`;
  const m = /^(.*?)([A-Za-z]+)([^A-Za-z]*)$/.exec(one);
  if (!m) return one;
  const [, head = '', word = '', tail = ''] = m;
  // Letters that stand for words keep their capitals, with a small s: "VIN" → "VINs".
  if (word.length > 1 && word === word.toUpperCase()) return `${head}${word}s${tail}`;
  const lower = word.toLowerCase();
  let plural: string;
  if (IRREGULAR[lower]) plural = IRREGULAR[lower]!;
  else if (/[^aeiou]y$/.test(lower)) plural = `${lower.slice(0, -1)}ies`;
  else if (/(s|x|z|ch|sh)$/.test(lower)) plural = `${lower}es`;
  else if (/(?:[^f]fe|[lr]f)$/.test(lower)) plural = lower.replace(/fe?$/, 'ves');
  else plural = `${lower}s`;
  const cased =
    word[0] === word[0]!.toUpperCase() ? plural[0]!.toUpperCase() + plural.slice(1) : plural;
  return `${head}${cased}${tail}`;
}

/** A label inside a sentence: "pet", "owner", but "VIN" and "Max" keep their capitals when they are names. */
export const lowerLabel = (label: string): string =>
  label.length > 1 && label === label.toUpperCase()
    ? label
    : label.charAt(0).toLowerCase() + label.slice(1);

/** One end of a relationship type, as the words need it. */
export interface RelationshipEndWords {
  readonly end: RelationshipEndKind;
  readonly label: string;
  /** The kind's own names, when this end is a record of a kind the business made up. */
  readonly kind?: { readonly singular: string; readonly plural: string } | null;
}

/** More than one of an end: the kind's own plural when the label is just the kind's name ("Pet" → "Pets"). */
export function endPlural(e: RelationshipEndWords): string {
  if (e.kind && e.kind.singular.trim().toLowerCase() === e.label.trim().toLowerCase())
    return e.kind.plural;
  return pluralOf(e.label);
}

/** What an end is, in the settings list: "a customer", "a company", "a pet". */
export function endKindWords(e: Pick<RelationshipEndWords, 'end' | 'kind'>): string {
  if (e.end === 'person') return 'Customer';
  if (e.end === 'company') return 'Company';
  return e.kind?.singular ?? 'Record';
}

/**
 * How the type reads in settings, one sentence per end: "Each owner can have many pets." and "Each pet can have
 * one owner." A mutual type reads once: "Each person can have one spouse."
 */
export function cardinalitySentences(t: {
  readonly a: RelationshipEndWords;
  readonly b: RelationshipEndWords;
  readonly cardinality: RelationshipCardinality;
  readonly mutual: boolean;
}): readonly string[] {
  const one = (e: RelationshipEndWords) => lowerLabel(e.label);
  const many = (e: RelationshipEndWords) => lowerLabel(endPlural(e));
  if (t.mutual)
    return [
      `Each ${lowerLabel(endKindWords(t.a))} can have ${manyFor(t.cardinality, 'a') ? `many ${many(t.a)}` : `one ${one(t.a)}`}.`,
    ];
  return [
    `Each ${one(t.a)} can have ${manyFor(t.cardinality, 'a') ? `many ${many(t.b)}` : `one ${one(t.b)}`}.`,
    `Each ${one(t.b)} can have ${manyFor(t.cardinality, 'b') ? `many ${many(t.a)}` : `one ${one(t.a)}`}.`,
  ];
}

/** The type's name in lists: "Owner ↔ Pet", or just "Spouse" for a mutual one. */
export function relationshipTypeName(t: {
  readonly a: { readonly label: string };
  readonly b: { readonly label: string };
  readonly mutual: boolean;
}): string {
  return t.mutual ? t.a.label : `${t.a.label} ↔ ${t.b.label}`;
}

/** The button on a record's page that adds the other end: "Add pet", "Add owner", "Add spouse". */
export const addRelatedWords = (label: string): string => `Add ${lowerLabel(label)}`;

/** Why a record can't take another of these: "Max already has an owner. A pet can have only one." */
export function endFullWords(recordName: string, label: string, kindLabel: string): string {
  return `${recordName} already has ${articleFor(label)} ${lowerLabel(label)}. Each ${lowerLabel(kindLabel)} can have only one.`;
}

/** "a" or "an" before a word, by how it sounds most of the time. */
export function articleFor(word: string): 'a' | 'an' {
  return /^[aeiou]/i.test(word.trim()) && !/^(uni|use|eu|one)/i.test(word.trim()) ? 'an' : 'a';
}

/** One side of a related pair on the timeline: "John Smith (Owner)". */
interface TimelinePairEnd {
  readonly name: string;
  readonly label: string;
}

/**
 * The timeline's sentence for a pair made or taken apart (`related` and `unrelated` entries, whose meta holds both
 * ends as they were named then): "added a relationship: John Smith (Owner) and Max (Pet)", "removed a relationship:
 * Ann Lee and Bo Lee (spouses)". Neither end's point of view, so it reads the same on both pages.
 */
export function relatedWords(
  subtype: 'related' | 'unrelated',
  a: TimelinePairEnd,
  b: TimelinePairEnd,
  mutual: boolean,
): string {
  const verb = subtype === 'related' ? 'added a relationship' : 'removed a relationship';
  if (mutual) return `${verb}: ${a.name} and ${b.name} (${lowerLabel(pluralOf(a.label))})`;
  return `${verb}: ${a.name} (${a.label}) and ${b.name} (${b.label})`;
}

/** What the relationship pages and cards say, in one place. */
export const RELATIONSHIP_WORDS = {
  cardTitle: 'Relationships',
  add: 'Add',
  none: 'Nothing related yet.',
  noneHint: 'Connect pets, vehicles, properties, family members or businesses.',
  noTypes: 'No relationships are set up yet.',
  setUp: 'Set up relationships',
  company: 'Company',
  people: 'People',
  remove: 'Remove relationship',
  removeConfirm: (other: string) =>
    `Remove the relationship with ${other}? Neither record is deleted.`,
  editNote: 'Edit note',
  note: 'Note',
  notePlaceholder: 'Primary driver, lease ends in August…',
  createNew: (name: string, kind: string) => `Add “${name}” as a new ${lowerLabel(kind)}`,
  pickExisting: 'Or pick one already here',
  searchPlaceholder: 'Type a name',
  noMatch: 'Nothing matches.',
  archived: 'archived',
  recordKinds: 'Kinds of records',
  relationshipTypes: 'Relationship types',
  newKind: 'New kind of record',
  newType: 'New relationship type',
  starterHint: 'Start from one of these, or make your own.',
  mutualHint: 'The same on both sides, like spouses or siblings.',
  manyHint: 'Nothing is assumed to be one-to-one: say “one” only when there can never be more.',
} as const;
