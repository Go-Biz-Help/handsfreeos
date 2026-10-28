/**
 * The AI placing the fields on a template's PDF (docs/documents.md, answer 4a), without the database: where the
 * spots are found on a page, what the model is asked, and its answer checked into fields that sit on their spots.
 */
import { describe, expect, it } from 'vitest';
import {
  addPlacedFields,
  blankDocumentDefinition,
  DocumentDefinition,
  findDocumentSpots,
  PLACE_FIELDS_ASK,
  placedFields,
  placeFieldsPrompt,
  type DocumentPageFindings,
  type DocumentRole,
} from '../src';

const LETTER = { width: 612, height: 792 };
const pt = { x: 1 / LETTER.width, y: 1 / LETTER.height };
/** A box in points, as fractions of a letter page. */
const at = (x: number, y: number, w: number, h: number) => ({
  x: x * pt.x,
  y: y * pt.y,
  w: w * pt.x,
  h: h * pt.y,
});
const words = (text: string, x: number, y: number, w: number, h = 12) => ({
  text,
  ...at(x, y, w, h),
});

const page = (p: Partial<DocumentPageFindings> = {}): DocumentPageFindings => ({
  page: 0,
  size: LETTER,
  lines: [],
  pieces: [],
  rules: [],
  boxes: [],
  ...p,
});

const roles: DocumentRole[] = [
  { key: 'customer', label: 'Client', kind: 'customer' },
  { key: 'us', label: 'Contractor', kind: 'team' },
];
const definition = () =>
  DocumentDefinition.parse({ ...blankDocumentDefinition(), roles, pages: [LETTER, LETTER] });

describe('finding the spots', () => {
  it('finds underscores, lines drawn, boxes and the room after a label, in reading order', () => {
    const sign = words('Client signature: ____________________', 72, 600, 300);
    const found = findDocumentSpots([
      page({
        lines: [
          words('SERVICE AGREEMENT', 200, 60, 200, 16),
          words('Name', 72, 500, 30),
          sign,
          words('Date:', 72, 650, 28),
          words('I have a pet', 92, 700, 80),
        ],
        pieces: [sign],
        rules: [
          // Under "SERVICE AGREEMENT": its underline.
          at(200, 77, 200, 1),
          // A rule across the page between sections.
          at(20, 300, 572, 1),
          // A line to write a name on.
          at(110, 510, 200, 1),
        ],
        boxes: [at(72, 700, 10, 10)],
      }),
    ]);
    expect(found.start).toContain('SERVICE AGREEMENT');
    expect(found.spots.map((s) => [s.id, s.kind])).toEqual([
      ['s1', 'line'],
      ['s2', 'line'],
      ['s3', 'after'],
      ['s4', 'box'],
    ]);
    const [name, signature, date, pet] = found.spots;
    expect(name).toMatchObject({ left: 'Name' });
    expect(signature!.left).toBe('Client signature:');
    // The underscores, not the whole line of words.
    expect(signature!.x).toBeGreaterThan(sign.x + sign.w * 0.4);
    expect(date).toMatchObject({ left: 'Date:' });
    expect(pet).toMatchObject({ right: 'I have a pet' });
  });

  it('counts a run of underscores drawn as a line once', () => {
    const blank = words('Phone ________________', 72, 400, 200);
    const found = findDocumentSpots([
      page({ lines: [blank], pieces: [blank], rules: [at(120, 409, 150, 1)] }),
    ]);
    expect(found.spots).toHaveLength(1);
  });
});

describe('what the model is asked', () => {
  it('names the roles and the spots, with the words around them as data', () => {
    const blank = words('Client <b>initials</b>: ______', 72, 400, 200);
    const prompt = placeFieldsPrompt(
      roles,
      findDocumentSpots([page({ lines: [blank], pieces: [blank] })]),
    );
    expect(prompt).toContain('- customer: “Client” (someone the business sends it to)');
    expect(prompt).toContain('- us: “Contractor” (someone from the business, signing too)');
    expect(prompt).toContain('- sender: the business');
    expect(prompt).toMatch(/s1 · page 1 · a line · left: “Client &lt;b&gt;initials&lt;\/b&gt;:”/);
    expect(prompt).toContain('customer.name: Customer, full name');
    expect(prompt.endsWith(PLACE_FIELDS_ASK)).toBe(true);
  });
});

describe('its answer, as fields', () => {
  const find = {
    spots: [
      { id: 's1', page: 0, kind: 'line' as const, ...at(72, 600, 200, 1) },
      { id: 's2', page: 0, kind: 'box' as const, ...at(72, 700, 10, 10) },
      { id: 's3', page: 1, kind: 'after' as const, ...at(110, 650, 150, 12) },
      { id: 's4', page: 1, kind: 'line' as const, ...at(300, 600, 300, 1) },
    ].map((s) => ({ ...s, left: '', right: '', above: '', below: '' })),
  };
  const answer = (...fields: Record<string, unknown>[]) => ({
    fields: fields.map((f) => ({
      type: 'text',
      role: 'customer',
      label: '',
      fillFrom: '',
      required: true,
      ...f,
    })) as never,
  });

  it('puts each on its own spot, for a role there is, filled in only from what fits', () => {
    const fields = placedFields(
      answer(
        { spot: 's1', type: 'signature' },
        { spot: 's2', type: 'text', label: 'Pets — any' },
        { spot: 's3', type: 'name', fillFrom: 'customer.name' },
        { spot: 's4', type: 'date', role: 'sender', fillFrom: 'today' },
      ),
      find,
      definition(),
      () => 0.5,
    );
    expect(fields.map((f) => [f.type, f.role, f.page, f.fillFrom])).toEqual([
      ['signature', 'customer', 0, null],
      // A small box holds a tick, whatever it was called.
      ['checkbox', 'customer', 0, null],
      ['name', 'customer', 1, 'customer.name'],
      ['date', 'sender', 1, 'today'],
    ]);
    const [signature, box] = fields;
    // Standing on its line, as a pen would.
    expect(signature!.y + signature!.h).toBeCloseTo(find.spots[0]!.y + pt.y, 4);
    expect(signature!.h).toBeCloseTo(30 * pt.y, 4);
    expect(box).toMatchObject({ required: false, label: 'Pets, any' });
  });

  it('leaves out what it can’t use', () => {
    const fields = placedFields(
      answer(
        { spot: 's9' },
        { spot: 's1', role: 'landlord' },
        { spot: 's3', type: 'checkbox' },
        { spot: 's4', type: 'stamp' },
        { spot: 's1', type: 'email', fillFrom: 'customer.phone' },
        { spot: 's1', type: 'text' },
      ),
      find,
      definition(),
    );
    // Only the email, once, and not filled in from a phone number.
    expect(fields.map((f) => [f.type, f.fillFrom])).toEqual([['email', null]]);
  });

  it('gives the business’s own signature to its signer, or leaves it out', () => {
    const ours = answer({ spot: 's4', type: 'signature', role: 'sender' });
    expect(placedFields(ours, find, definition()).map((f) => f.role)).toEqual(['us']);
    const customerOnly = DocumentDefinition.parse({
      ...blankDocumentDefinition(),
      pages: [LETTER, LETTER],
    });
    expect(placedFields(ours, find, customerOnly)).toEqual([]);
  });

  it('goes on beside the fields already there, never on one', () => {
    const d = definition();
    const fields = placedFields(
      answer({ spot: 's1', type: 'signature' }, { spot: 's3', type: 'name' }),
      find,
      d,
    );
    const once = addPlacedFields(d, fields.slice(0, 1));
    expect(once).toMatchObject({ added: 1, skipped: 0 });
    const twice = addPlacedFields(once.definition, fields);
    expect(twice).toMatchObject({ added: 1, skipped: 1 });
    expect(twice.definition.fields).toHaveLength(2);
    expect(DocumentDefinition.safeParse(twice.definition).success).toBe(true);
    expect(addPlacedFields(twice.definition, []).definition).toBe(twice.definition);
  });
});
