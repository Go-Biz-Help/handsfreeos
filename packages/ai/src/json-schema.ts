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
  return out;
}

export function structuredOutputSchema(schema: Record<string, unknown>): Record<string, unknown> {
  return strict(schema);
}
