/**
 * A template changed a piece at a time, as the Assistant asks for it (docs/documents.md): what the change names
 * changes and nothing else does, roles first so a new field can be for someone added in the same change, what can't
 * be is refused naming what's wrong, and each change is said in the editor's words for the card.
 */
import { describe, expect, it } from 'vitest';
import {
  applyTemplateChange,
  DocumentDefinition,
  DocumentTemplateChange,
  SENDER_ROLE,
  templateChangeWords,
  type DocumentTemplateChange as Change,
} from '../src';

const LETTER = { width: 612, height: 792 };

const definition = () =>
  DocumentDefinition.parse({
    pages: [LETTER, LETTER],
    roles: [
      { key: 'customer', label: 'Customer', kind: 'customer' },
      { key: 'us', label: 'Us', kind: 'team' },
    ],
    fields: [
      { id: 'f_name', type: 'name', role: 'customer', page: 0, x: 0.1, y: 0.1, w: 0.3, h: 0.03 },
      {
        id: 'f_sign',
        type: 'signature',
        role: 'customer',
        page: 1,
        x: 0.1,
        y: 0.7,
        w: 0.3,
        h: 0.05,
      },
      { id: 'f_ours', type: 'signature', role: 'us', page: 1, x: 0.5, y: 0.8, w: 0.3, h: 0.05 },
      { id: 'f_start', type: 'date', role: SENDER_ROLE, page: 0, x: 0.1, y: 0.2, w: 0.2, h: 0.03 },
    ],
    edits: [
      {
        id: 'e_rent',
        page: 0,
        x: 0.1,
        y: 0.3,
        w: 0.4,
        h: 0.02,
        text: 'Rent: $1,450',
        original: 'Rent: $1,400',
      },
    ],
  });

/** Fixed ids, so what's added can be found. */
const seq = () => {
  let n = 0;
  return () => ((n++ * 7) % 36) / 36;
};
const change = (c: Change) => DocumentTemplateChange.parse(c);

describe('a template changed a piece at a time', () => {
  it('changes what it names and keeps every other field and word change', () => {
    const before = definition();
    const after = applyTemplateChange(
      before,
      change({ fields: [{ id: 'f_name', required: false, fillFrom: 'customer.name' }] }),
    );
    expect(after.fields).toHaveLength(4);
    expect(after.edits).toEqual(before.edits);
    expect(after.fields.find((f) => f.id === 'f_name')).toMatchObject({
      required: false,
      fillFrom: 'customer.name',
      x: 0.1,
    });
    expect(after.fields.filter((f) => f.id !== 'f_name')).toEqual(
      before.fields.filter((f) => f.id !== 'f_name'),
    );
    expect(templateChangeWords(before, after)).toEqual([
      'Name on page 1: Has to be filled in: no; Fill in from HandsFreeOS: Customer: Full name',
    ]);
  });

  it('turns reminders off and on as the switch does, and says the settings in the screen’s words', () => {
    const before = definition();
    const off = applyTemplateChange(before, change({ settings: { remindAfterDays: null } }));
    expect(off.settings).toMatchObject({ remindAfterDays: null, remindEveryDays: null });
    expect(templateChangeWords(before, off)).toEqual(['Send reminders: off']);
    // On again with only the first day: the other takes the usual.
    const on = applyTemplateChange(off, change({ settings: { remindAfterDays: 4 } }));
    expect(on.settings).toMatchObject({ remindAfterDays: 4, remindEveryDays: 3 });
    const all = applyTemplateChange(
      before,
      change({ settings: { order: 'together', askCode: true, expireDays: 10, message: 'Hi!' } }),
    );
    expect(templateChangeWords(before, all)).toEqual([
      'Who signs when: All at once',
      'Ask for a code: on',
      'Out of time after 10 days',
      'Note with the link: “Hi!”',
    ]);
  });

  it('adds someone to sign, with their field in the same change, and moves them in the order', () => {
    const before = definition();
    const after = applyTemplateChange(
      before,
      change({
        roles: [
          { key: 'customer_2', add: true, label: 'Co-signer' },
          { key: 'customer_2', move: 'earlier' },
        ],
        fields: [{ type: 'signature', role: 'customer_2', page: 1, x: 0.99, y: 0.5 }],
      }),
      seq(),
    );
    expect(after.roles.map((r) => r.key)).toEqual(['customer', 'customer_2', 'us']);
    const added = after.fields.find((f) => f.role === 'customer_2')!;
    // At its kind's size, kept on the page.
    expect(added.w).toBeCloseTo(170 / 612, 4);
    expect(added.x + added.w).toBeLessThanOrEqual(1);
    expect(added.required).toBe(true);
    expect(templateChangeWords(before, after)).toEqual([
      'Signs it too: Co-signer (a customer)',
      'Signing order: Customer, then Co-signer, then Us',
      'New Signature for Co-signer on page 2',
    ]);
  });

  it('takes someone off with their fields, said once', () => {
    const before = definition();
    const after = applyTemplateChange(before, change({ roles: [{ key: 'us', remove: true }] }));
    expect(after.roles.map((r) => r.key)).toEqual(['customer']);
    expect(after.fields.some((f) => f.role === 'us')).toBe(false);
    expect(templateChangeWords(before, after)).toEqual(['Take Us off, with their field']);
  });

  it('changes, adds and puts back the PDF’s words', () => {
    const before = definition();
    const after = applyTemplateChange(
      before,
      change({
        words: [
          { id: 'e_rent', text: 'Rent: $1,500' },
          {
            page: 1,
            x: 0.1,
            y: 0.1,
            w: 0.3,
            h: 0.02,
            text: 'Signed in Austin',
          },
        ],
      }),
    );
    expect(after.edits).toHaveLength(2);
    expect(after.edits[0]).toMatchObject({
      id: 'e_rent',
      text: 'Rent: $1,500',
      original: 'Rent: $1,400',
    });
    expect(templateChangeWords(before, after)).toEqual([
      'Words on page 1 “Rent: $1,400”: now says “Rent: $1,500”',
      'New words on page 2: “Signed in Austin”',
    ]);
    const back = applyTemplateChange(before, change({ words: [{ id: 'e_rent', remove: true }] }));
    expect(back.edits).toEqual([]);
    expect(templateChangeWords(before, back)).toEqual([
      'Put the original words back on page 1: “Rent: $1,400”',
    ]);
  });

  it('retypes a field, taking off what the new kind can’t keep', () => {
    const before = definition();
    const named = applyTemplateChange(
      before,
      change({ fields: [{ id: 'f_name', fillFrom: 'customer.name' }] }),
    );
    const ticked = applyTemplateChange(
      named,
      change({ fields: [{ id: 'f_name', type: 'checkbox' }] }),
    );
    expect(ticked.fields.find((f) => f.id === 'f_name')).toMatchObject({
      type: 'checkbox',
      fillFrom: null,
    });
    const picked = applyTemplateChange(
      before,
      change({ fields: [{ id: 'f_name', type: 'choice' }] }),
    );
    expect(picked.fields.find((f) => f.id === 'f_name')!.options).toEqual(['Yes', 'No']);
  });

  it('refuses what the template doesn’t have, or can’t be, naming what’s wrong', () => {
    const before = definition();
    const refused = (c: Change) => {
      try {
        applyTemplateChange(before, change(c));
      } catch (e) {
        return (e as Error).message;
      }
      throw new Error('It wasn’t refused.');
    };
    expect(refused({ fields: [{ id: 'f_gone', required: false }] })).toContain('no field f_gone');
    expect(refused({ roles: [{ key: 'tenant', label: 'Tenant' }] })).toContain('“tenant”');
    expect(refused({ roles: [{ key: 'customer', add: true }] })).toContain('another key');
    expect(refused({ fields: [{ type: 'text', page: 0, x: 0.1, y: 0.1 }] })).toContain(
      'who fills it in',
    );
    expect(refused({ fields: [{ id: 'f_sign', fillFrom: 'customer.name' }] })).toContain(
      'never fills in from HandsFreeOS',
    );
    expect(refused({ fields: [{ id: 'f_name', page: 5 }] })).toBe('That page isn’t in the PDF.');
    expect(refused({ fields: [{ id: 'f_start', type: 'signature' }] })).toContain(
      'A signature is for someone who signs',
    );
    expect(
      refused({
        roles: [
          { key: 'customer', remove: true },
          { key: 'us', remove: true },
        ],
      }),
    ).toBe('Someone has to sign it.');
    expect(refused({ words: [{ text: 'Somewhere' }] })).toContain('page and box');
  });

  it('says nothing when nothing changes', () => {
    const before = definition();
    expect(
      templateChangeWords(
        before,
        applyTemplateChange(before, change({ fields: [{ id: 'f_name', required: true }] })),
      ),
    ).toEqual([]);
  });
});
