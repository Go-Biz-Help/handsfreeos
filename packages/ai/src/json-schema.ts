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
