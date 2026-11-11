/**
 * A JSON Schema reduced to what Claude's structured outputs accept: every object closed
 * (`additionalProperties: false`), and the keywords the API doesn't support (lengths, number ranges,
 * patterns, array sizes other than minItems 0 or 1, unknown formats) moved into the description, so the
 * model still reads them while the caller's zod schema enforces them. It does what the SDK's
 * transformJSONSchema does, except that it keeps `enum` and `const`, which the API supports and the SDK's
 * version moves into the description.
 */

type Schema = Record<string, unknown>;

const FORMATS = new Set([
  'date-time',
  'time',
  'date',
  'duration',
  'email',
  'hostname',
  'uri',
  'ipv4',
  'ipv6',
  'uuid',
]);

const mapValues = (value: unknown, fn: (s: Schema) => Schema): Schema =>
  Object.fromEntries(Object.entries(value as Record<string, Schema>).map(([k, v]) => [k, fn(v)]));

function strict(node: Schema): Schema {
  const out: Schema = {};
  const rest: Schema = {};
  for (const [key, value] of Object.entries(node)) {
    switch (key) {
      case 'type':
      case 'description':
      case 'title':
      case 'enum':
      case 'const':
      case 'required':
      case '$ref':
        out[key] = value;
        break;
      case 'properties':
      case '$defs':
        out[key] = mapValues(value, strict);
        break;
      case 'items':
        out.items = strict(value as Schema);
        break;
      case 'anyOf':
      case 'allOf':
        out[key] = (value as Schema[]).map(strict);
        break;
      case 'oneOf':
        out.anyOf = (value as Schema[]).map(strict);
        break;
      case 'format':
        if (FORMATS.has(String(value))) out.format = value;
        else rest.format = value;
        break;
      case 'minItems':
        if (value === 0 || value === 1) out.minItems = value;
        else rest.minItems = value;
        break;
      case 'additionalProperties':
      case '$schema':
        break;
      default:
        rest[key] = value;
    }
  }
  const types = Array.isArray(out.type) ? (out.type as unknown[]) : [out.type];
  if (types.includes('object')) {
    out.properties ??= {};
    out.additionalProperties = false;
  }
  const extra = Object.entries(rest);
  if (extra.length) {
    const note = `{${extra.map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join(', ')}}`;
    out.description = typeof out.description === 'string' ? `${out.description}\n\n${note}` : note;
  }
  return nullableEnum(out);
}

/**
 * A choice that may also be null, written `type: ['string', 'null'], enum: ['up', 'down', null]`, sent as
 * `anyOf: [{ type: 'string', enum: ['up', 'down'] }, { type: 'null' }]`. The API turned down every request whose
 * schema had null inside an enum (the outreach helper and the like picker, 2026-11-02), and the anyOf form is the
 * one its docs show for a nullable value.
 */
function nullableEnum(node: Schema): Schema {
  const values = node.enum;
  if (!Array.isArray(values) || !values.includes(null)) return node;
  const types = Array.isArray(node.type) ? (node.type as unknown[]) : [node.type];
  const others = types.filter((t) => t !== 'null' && t !== undefined);
  if (others.length === 0) return node;
  const { type: _type, enum: _enum, description, title, ...kept } = node;
  return {
    ...(title !== undefined ? { title } : {}),
    ...(description !== undefined ? { description } : {}),
    anyOf: [
      {
        ...kept,
        type: others.length === 1 ? others[0] : others,
        enum: values.filter((v) => v !== null),
      },
      { type: 'null' },
    ],
  };
}

export function structuredOutputSchema(schema: Record<string, unknown>): Record<string, unknown> {
  return strict(schema);
}

/**
 * Claude's limits on strict schemas, counted across everything one request holds to a schema: its strict tools and
 * its `responseFormat` (platform.claude.com, "Structured outputs", Schema complexity limits). Past any of them the
 * API turns the whole request down ("Schema is too complex for compilation"), every time, not now and then: the form
 * builder's tools had 21 fields that could be null, for 16, and never got an answer (2026-11-11).
 */
export const STRICT_LIMITS = { tools: 20, optional: 24, unions: 16 } as const;

/** What a schema adds to a request's strict load. */
export interface StrictLoad {
  /** Properties left out of `required`. */
  readonly optional: number;
  /** Values that are one of several types: an `anyOf`, or a list of types (`['string', 'null']`). */
  readonly unions: number;
}

/** A schema's share of the limits above, counted the way the API counts them: at every depth. */
export function strictLoad(schema: Record<string, unknown>): StrictLoad {
  let optional = 0;
  let unions = 0;
  const walk = (node: unknown, isValue: boolean) => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return;
    const n = node as Schema;
    if (isValue && (Array.isArray(n.anyOf) || Array.isArray(n.type))) unions += 1;
    const properties = (n.properties ?? {}) as Record<string, unknown>;
    const required = new Set(Array.isArray(n.required) ? (n.required as string[]) : []);
    for (const [key, value] of Object.entries(properties)) {
      if (!required.has(key)) optional += 1;
      walk(value, true);
    }
    for (const value of Object.values((n.$defs ?? {}) as Record<string, unknown>))
      walk(value, true);
    if (n.items) walk(n.items, true);
    // A branch of a union is part of the value it belongs to, not another one.
    for (const branch of (Array.isArray(n.anyOf) ? n.anyOf : []) as unknown[]) walk(branch, false);
  };
  walk(schema, false);
  return { optional, unions };
}

/**
 * Which tools can be held to their schemas in one request: each in turn while all of them together, and the
 * request's own `responseFormat`, stay within `STRICT_LIMITS`. One that would go past is sent without `strict`, so
 * the request is answered rather than refused; whoever runs a tool checks its input either way. The same tools
 * always give the same answer, so the provider's cache still finds them.
 */
export function strictWithinLimits(
  tools: readonly {
    readonly name: string;
    readonly inputSchema: Record<string, unknown>;
    readonly strict?: boolean;
  }[],
  responseFormat?: Record<string, unknown> | null,
): ReadonlySet<string> {
  const used = responseFormat ? strictLoad(responseFormat) : { optional: 0, unions: 0 };
  let optional = used.optional;
  let unions = used.unions;
  const kept = new Set<string>();
  for (const tool of tools) {
    if (!tool.strict) continue;
    const load = strictLoad(tool.inputSchema);
    if (
      kept.size + 1 > STRICT_LIMITS.tools ||
      optional + load.optional > STRICT_LIMITS.optional ||
      unions + load.unions > STRICT_LIMITS.unions
    )
      continue;
    kept.add(tool.name);
    optional += load.optional;
    unions += load.unions;
  }
  return kept;
}
