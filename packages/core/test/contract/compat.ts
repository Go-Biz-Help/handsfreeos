/**
 * What an old app build can still send (M10, "Old app builds"). Phones stay on old builds for weeks, so the
 * inputs of the commands and queries the phone uses, their offline classes, and the shape of the tables it syncs
 * may only grow: a new optional field, a wider enum, a longer limit. `incompatibilities` names everything that
 * isn't growth between the recorded contract and today's.
 */

/** A JSON Schema, as zod's toJSONSchema writes it (only what the comparison reads). */
export interface Schema {
  readonly type?: string | readonly string[];
  readonly properties?: Readonly<Record<string, Schema>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean | Schema;
  readonly items?: Schema;
  readonly anyOf?: readonly Schema[];
  readonly oneOf?: readonly Schema[];
  readonly enum?: readonly unknown[];
  readonly const?: unknown;
  readonly default?: unknown;
  readonly format?: string;
  readonly pattern?: string;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly exclusiveMinimum?: number;
  readonly exclusiveMaximum?: number;
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly multipleOf?: number;
}

export type ContractOffline = 'anytime' | 'online' | { readonly freshMinutes: number };

export interface Contract {
  readonly about?: string;
  readonly commands: Readonly<
    Record<string, { readonly offline: ContractOffline; readonly input: Schema }>
  >;
  readonly queries: Readonly<Record<string, { readonly input: Schema }>>;
  /** Synced tables: column name → its type, as the streams deliver them (filled by apps/sync). */
  readonly tables: Readonly<Record<string, { readonly columns: Readonly<Record<string, string>> }>>;
}

const json = (v: unknown) => JSON.stringify(v);

const TYPES_ANY = ['string', 'number', 'integer', 'boolean', 'object', 'array', 'null'];

/** The JSON types a schema accepts; everything when it names none. */
function typesOf(s: Schema): Set<string> {
  if (s.const !== undefined) return new Set([s.const === null ? 'null' : typeof s.const]);
  if (s.enum) return new Set(s.enum.map((v) => (v === null ? 'null' : typeof v)));
  if (s.type === undefined) return new Set(TYPES_ANY);
  const listed = Array.isArray(s.type) ? s.type : [s.type as string];
  // An integer is a number: a field that took any number and now takes only integers is narrower, not the reverse.
  return new Set(listed.flatMap((t) => (t === 'number' ? ['number', 'integer'] : [t])));
}

const branchesOf = (s: Schema): readonly Schema[] => s.anyOf ?? s.oneOf ?? [s];

/** Everything an old app could send under `before` that `after` refuses (empty when `after` only grew). */
export function schemaIncompatibilities(before: Schema, after: Schema, path = ''): string[] {
  const at = path || '(input)';
  // A union: every shape the old one took must still be taken by some shape of the new one.
  if (before.anyOf || before.oneOf || after.anyOf || after.oneOf) {
    const problems: string[] = [];
    for (const b of branchesOf(before)) {
      const fits = branchesOf(after).map((a) => schemaIncompatibilities(b, a, path));
      if (!fits.some((f) => f.length === 0))
        problems.push(
          ...(fits.length === 1 ? fits[0]! : [`${at}: no longer takes ${json(b.type ?? b)}`]),
        );
    }
    return problems;
  }
  const problems: string[] = [];
  const was = typesOf(before);
  const now = typesOf(after);
  const lost = [...was].filter((t) => !now.has(t));
  if (lost.length) problems.push(`${at}: no longer takes ${lost.join(', ')}`);
  if (after.enum || after.const !== undefined) {
    const allowed = after.enum ?? [after.const];
    const before_ = before.enum ?? (before.const !== undefined ? [before.const] : null);
    if (!before_) problems.push(`${at}: now limited to ${json(allowed)}`);
    else {
      const dropped = before_.filter((v) => !allowed.some((x) => json(x) === json(v)));
      if (dropped.length) problems.push(`${at}: no longer takes ${json(dropped)}`);
    }
  }
  if (json(before.default) !== json(after.default))
    problems.push(
      `${at}: its default changed from ${json(before.default)} to ${json(after.default)}`,
    );
  const tighter = (key: keyof Schema, larger: boolean, words: string) => {
    const b = before[key] as number | undefined;
    const a = after[key] as number | undefined;
    if (a === undefined) return;
    if (b === undefined || (larger ? a > b : a < b))
      problems.push(`${at}: ${words} ${b ?? 'none'} → ${a}`);
  };
  tighter('minLength', true, 'minimum length');
  tighter('maxLength', false, 'maximum length');
  tighter('minimum', true, 'minimum');
  tighter('maximum', false, 'maximum');
  tighter('exclusiveMinimum', true, 'exclusive minimum');
  tighter('exclusiveMaximum', false, 'exclusive maximum');
  tighter('minItems', true, 'fewest items');
  tighter('maxItems', false, 'most items');
  if (after.multipleOf !== undefined && after.multipleOf !== before.multipleOf)
    problems.push(`${at}: now a multiple of ${after.multipleOf}`);
  if (after.format !== undefined && after.format !== before.format)
    problems.push(`${at}: its format changed from ${before.format ?? 'none'} to ${after.format}`);
  // A format's own pattern (a uuid's) may be written differently by a newer zod; a bare pattern may not change.
  if (after.format === undefined && after.pattern !== undefined && after.pattern !== before.pattern)
    problems.push(`${at}: its pattern changed`);
  if (before.properties || after.properties) {
    const bp = before.properties ?? {};
    const ap = after.properties ?? {};
    for (const [key, schema] of Object.entries(bp)) {
      if (!(key in ap)) problems.push(`${path ? `${path}.` : ''}${key}: removed`);
      else
        problems.push(...schemaIncompatibilities(schema, ap[key]!, path ? `${path}.${key}` : key));
    }
    const required = new Set(before.required ?? []);
    for (const key of after.required ?? [])
      if (!required.has(key))
        problems.push(
          `${path ? `${path}.` : ''}${key}: ${key in bp ? 'now required' : 'new and required'}`,
        );
    if (after.additionalProperties === false && before.additionalProperties !== false)
      problems.push(`${at}: now refuses fields it doesn't know`);
  }
  if (before.items && after.items)
    problems.push(...schemaIncompatibilities(before.items, after.items, `${path}[]`));
  return problems;
}

const RANK = (o: ContractOffline): number => (o === 'anytime' ? 0 : o === 'online' ? 2 : 1);

/** Everything in `before` that `after` breaks for an app built against it. */
export function incompatibilities(before: Contract, after: Contract): string[] {
  const problems: string[] = [];
  for (const [name, was] of Object.entries(before.commands)) {
    const now = after.commands[name];
    if (!now) {
      problems.push(`command ${name}: removed`);
      continue;
    }
    if (RANK(now.offline) > RANK(was.offline))
      problems.push(
        `command ${name}: can wait less on a phone (${json(was.offline)} → ${json(now.offline)})`,
      );
    else if (
      typeof was.offline === 'object' &&
      typeof now.offline === 'object' &&
      now.offline.freshMinutes < was.offline.freshMinutes
    )
      problems.push(
        `command ${name}: fresh for fewer minutes (${was.offline.freshMinutes} → ${now.offline.freshMinutes})`,
      );
    problems.push(
      ...schemaIncompatibilities(was.input, now.input).map((p) => `command ${name}: ${p}`),
    );
  }
  for (const [name, was] of Object.entries(before.queries)) {
    const now = after.queries[name];
    if (!now) problems.push(`query ${name}: removed`);
    else
      problems.push(
        ...schemaIncompatibilities(was.input, now.input).map((p) => `query ${name}: ${p}`),
      );
  }
  for (const [name, was] of Object.entries(before.tables)) {
    const now = after.tables[name];
    if (!now) {
      problems.push(`table ${name}: no longer synced`);
      continue;
    }
    for (const [column, type] of Object.entries(was.columns)) {
      if (!(column in now.columns)) problems.push(`table ${name}: column ${column} removed`);
      else if (now.columns[column] !== type)
        problems.push(
          `table ${name}: column ${column} changed from ${type} to ${now.columns[column]}`,
        );
    }
  }
  return problems;
}
