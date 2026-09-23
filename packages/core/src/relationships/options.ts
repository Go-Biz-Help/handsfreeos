/**
 * What a record's page offers and shows for its relationships (0101): the things it can have added ("Pet",
 * "Spouse", "Employer"), each greyed out when the record already has the only one it may have, and its pairs
 * grouped under what they are to it ("Pets · 2", "Owner"). Browser-safe, for the web's card and the phone's.
 */
import type {
  RelationshipEndOut,
  RelationshipOut,
  RelationshipTypeOut,
} from '../schemas/relationship';
import { endPlural, manyFor, type RelationshipEndKind, type RelationshipSide } from './words';

/** The record a page is about: a person, a company, or a record of one of the business's own kinds. */
export interface RelatableRecord {
  readonly kind: RelationshipEndKind;
  /** Its kind, when it's a record of a kind the business made up. */
  readonly recordTypeId?: string | null;
}

export interface AddOption {
  /** `typeId:side`, unique on the page. */
  readonly key: string;
  readonly typeId: string;
  /** The end this page's record sits on. */
  readonly side: RelationshipSide;
  /** What the record being added is to this one ("Pet"). */
  readonly label: string;
  /** What that end is: the kind of record to look for, or to make. */
  readonly other: RelationshipEndOut;
  readonly mutual: boolean;
  /** This record already has the one it may have. */
  readonly full: boolean;
}

const fits = (e: RelationshipEndOut, r: RelatableRecord) =>
  e.end === r.kind && (r.kind !== 'custom_record' || e.recordType?.id === r.recordTypeId);

/**
 * Everything that can be related to this record, one choice per end it can sit on: a person on both ends of
 * "Parent ↔ Child" can have a child added or a parent added. Archived types aren't offered.
 */
export function addOptions(
  types: readonly RelationshipTypeOut[],
  record: RelatableRecord,
  pairs: readonly RelationshipOut[],
): AddOption[] {
  const out: AddOption[] = [];
  for (const t of types) {
    if (t.archivedAt) continue;
    const has = (side: RelationshipSide) =>
      pairs.some((p) => p.typeId === t.id && (t.mutual || p.side === side));
    const add = (side: RelationshipSide, other: RelationshipEndOut) =>
      out.push({
        key: `${t.id}:${side}`,
        typeId: t.id,
        side,
        label: other.label,
        other,
        mutual: t.mutual,
        full: !manyFor(t.cardinality, side) && has(side),
      });
    if (t.mutual) {
      if (fits(t.a, record)) add('a', t.a);
      continue;
    }
    if (fits(t.a, record)) add('a', t.b);
    if (fits(t.b, record)) add('b', t.a);
  }
  return out;
}

export interface PairGroup {
  readonly key: string;
  readonly typeId: string;
  /** "Pets" for two, "Pet" for one. */
  readonly title: string;
  readonly items: readonly RelationshipOut[];
}

/** A record's pairs under what they are to it, in the order the business put its relationship types. */
export function groupPairs(pairs: readonly RelationshipOut[]): PairGroup[] {
  const groups = new Map<string, RelationshipOut[]>();
  for (const p of pairs) {
    const key = `${p.typeId}:${p.mutual ? 'a' : p.side}`;
    groups.set(key, [...(groups.get(key) ?? []), p]);
  }
  return [...groups.entries()].map(([key, items]) => {
    const first = items[0]!;
    const kind = first.other.recordType;
    return {
      key,
      typeId: first.typeId,
      title:
        items.length > 1
          ? endPlural({ end: first.other.kind, label: first.label, kind })
          : first.label,
      items,
    };
  });
}
