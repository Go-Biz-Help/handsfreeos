/**
 * Changing a template's definition, the same in the web's editor and the phone's (docs/documents.md): what's placed
 * where the page was touched, kept on the page; the PDF's words typed over (26c); moving and resizing; who signs; and
 * taking things off with what goes with them.
 */
import { describe, expect, it } from 'vitest';
import {
  boxOnPage,
  coveredBy,
  documentRoleColour,
  documentRoleName,
  DocumentDefinition,
  fieldTypesFor,
  MAX_DOCUMENT_ROLES,
  movedBox,
  newDocumentField,
  newDocumentRoleKey,
  newDocumentTextBox,
  retypedField,
  SENDER_ROLE,
  typeOverLine,
  withField,
  withoutPick,
  withoutRole,
  withRoleAdded,
  withRoleMoved,
} from '../src';

const LETTER = { width: 612, height: 792 };

const definition = () =>
  DocumentDefinition.parse({
    version: 1,
    pages: [LETTER, LETTER],
    roles: [
      { key: 'customer', label: 'Customer', kind: 'customer' },
      { key: 'us', label: 'Us', kind: 'team' },
    ],
    fields: [
      { id: 'f_name', type: 'name', role: 'customer', page: 0, x: 0.1, y: 0.1, w: 0.3, h: 0.03 },
      { id: 'f_ours', type: 'signature', role: 'us', page: 1, x: 0.5, y: 0.8, w: 0.3, h: 0.05 },
      { id: 'f_start', type: 'date', role: SENDER_ROLE, page: 0, x: 0.1, y: 0.2, w: 0.2, h: 0.03 },
    ],
    presets: { f_start: { kind: 'date', date: '2026-11-01' } },
  });

describe('placing', () => {
  it('centres a new field where the page was touched, at its kind’s size, and keeps it on the page', () => {
    const f = newDocumentField('signature', 'customer', LETTER, 1, { x: 0.5, y: 0.5 });
    expect(f).toMatchObject({ type: 'signature', role: 'customer', page: 1, required: true });
    expect(f.w).toBeCloseTo(170 / 612, 4);
    expect(f.h).toBeCloseTo(42 / 792, 4);
    expect(f.x + f.w / 2).toBeCloseTo(0.5, 4);
    // Touched at the corner, it stays on the page.
    const corner = boxOnPage(LETTER, 0, { x: 0.99, y: 0.01 }, [170, 42]);
    expect(corner.x + corner.w).toBeLessThanOrEqual(1);
    expect(corner.y).toBe(0);
    // A tick isn't required; a choice starts with two.
    expect(newDocumentField('checkbox', 'customer', LETTER, 0, { x: 0.5, y: 0.5 }).required).toBe(
      false,
    );
    expect(newDocumentField('choice', 'customer', LETTER, 0, { x: 0.5, y: 0.5 }).options).toEqual([
      'Yes',
      'No',
    ]);
    expect(newDocumentTextBox(LETTER, 0, { x: 0.5, y: 0.5 })).toMatchObject({
      text: '',
      original: '',
      background: '#ffffff',
    });
  });

  it('types over a line of the PDF’s words in their size, font and colours', () => {
    const line = {
      text: 'Net 30',
      x: 0.1,
      y: 0.4,
      w: 0.2,
      h: 0.02,
      size: 120,
      font: 'serif' as const,
      bold: true,
    };
    expect(typeOverLine(0, line, { background: '#fffdf5', color: '#1a1a1a' })).toMatchObject({
      page: 0,
      text: 'Net 30',
      original: 'Net 30',
      size: 72,
      font: 'serif',
      bold: true,
      background: '#fffdf5',
      color: '#1a1a1a',
    });
    // A line mostly under words already changed can't be typed over again.
    expect(coveredBy(line, { x: 0.1, y: 0.4, w: 0.15, h: 0.02 })).toBe(true);
    expect(coveredBy(line, { x: 0.25, y: 0.4, w: 0.2, h: 0.02 })).toBe(false);
  });
});

describe('moving and resizing', () => {
  it('keeps what moves on the page, and what resizes at least a sliver', () => {
    const box = { x: 0.8, y: 0.1, w: 0.15, h: 0.05 };
    expect(movedBox(box, 'move', 0.2, -0.5)).toEqual({ x: 0.85, y: 0, w: 0.15, h: 0.05 });
    expect(movedBox(box, 'resize', 0.5, -1)).toEqual({ x: 0.8, y: 0.1, w: 0.2, h: 0.005 });
  });
});

describe('changing a field', () => {
  it('drops what the new kind can’t have', () => {
    const d = definition();
    const name = d.fields[0]!;
    const filled = { ...name, fillFrom: 'customer.name' as const };
    expect(retypedField(filled, 'signature')).toMatchObject({ type: 'signature', fillFrom: null });
    expect(retypedField(filled, 'choice').options).toEqual(['Yes', 'No']);
    expect(withField(d, 'f_name', (f) => ({ ...f, label: 'Full name' })).fields[0]!.label).toBe(
      'Full name',
    );
  });

  it('never lets the business sign before it sends', () => {
    expect(fieldTypesFor(SENDER_ROLE)).not.toContain('signature');
    expect(fieldTypesFor(SENDER_ROLE)).not.toContain('date_signed');
    expect(fieldTypesFor('customer')).toContain('signature');
  });

  it('takes a field off with what was filled in it', () => {
    const d = withoutPick(definition(), { kind: 'field', id: 'f_start' });
    expect(d.fields.map((f) => f.id)).toEqual(['f_name', 'f_ours']);
    expect(d.presets).toEqual({});
  });
});

describe('who signs', () => {
  it('adds the next customer or the team, names them, and stops at the most', () => {
    const d = definition();
    expect(newDocumentRoleKey(d, 'customer')).toBe('customer_1');
    const added = withRoleAdded(d, 'customer');
    expect(added.key).toBe('customer_1');
    expect(added.definition.roles.at(-1)).toEqual({
      key: 'customer_1',
      label: 'Customer 2',
      kind: 'customer',
    });
    expect(withRoleAdded(d, 'team').definition.roles.at(-1)).toMatchObject({ label: 'Us' });
    let full = d;
    while (full.roles.length < MAX_DOCUMENT_ROLES)
      full = withRoleAdded(full, 'customer').definition;
    expect(withRoleAdded(full, 'customer').definition).toBe(full);
  });

  it('changes who signs first, and takes one off with their fields', () => {
    const d = definition();
    expect(withRoleMoved(d, 'us', -1).roles.map((r) => r.key)).toEqual(['us', 'customer']);
    expect(withRoleMoved(d, 'us', 1)).toBe(d);
    const without = withoutRole(d, 'us');
    expect(without.roles.map((r) => r.key)).toEqual(['customer']);
    expect(without.fields.map((f) => f.id)).toEqual(['f_name', 'f_start']);
  });

  it('gives each their colour and name, the business before it sends its own', () => {
    const d = definition();
    expect(documentRoleColour(d, 'customer')).not.toBe(documentRoleColour(d, 'us'));
    expect(documentRoleColour(d, SENDER_ROLE)).toBe('#475569');
    expect(documentRoleName(d, SENDER_ROLE)).toBe('You, before sending');
    expect(documentRoleName(d, 'us')).toBe('Us');
  });
});
