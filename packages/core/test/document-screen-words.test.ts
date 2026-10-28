/**
 * What the web's and the phone's Documents screens share (docs/documents.md, part 3): a document's badge, sending a
 * corrected one again, what the Send screen asks the team to fill in, and the words, in plain words with curly
 * apostrophes.
 */
import { describe, expect, it } from 'vitest';
import {
  DOCUMENT_SCREEN_WORDS,
  DocumentDefinition,
  documentBadge,
  PHONE_HAND_BACK,
  sendAgainQuery,
  sendFillable,
} from '../src';

const DOC = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const TEMPLATE = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const DANA = '22222222-2222-4222-8222-222222222222';

describe('a document’s badge', () => {
  it('says where it is, and that the signed copy is being made once everyone signed', () => {
    expect(documentBadge('out')).toEqual({ label: 'Out for signing', tone: 'pending' });
    expect(documentBadge('out', true)).toEqual({ label: 'Making the signed copy', tone: 'accent' });
    expect(documentBadge('completed')).toEqual({ label: 'Signed', tone: 'ok' });
    expect(documentBadge('declined').tone).toBe('danger');
    expect(documentBadge('voided').tone).toBe('gray');
    expect(documentBadge('expired')).toEqual({ label: 'Out of time', tone: 'gray' });
  });
});

describe('sending one again', () => {
  const about = { kind: 'person' as const, id: DANA };
  it('starts the Send screen from a voided, declined or out-of-time one, for the same customer', () => {
    for (const status of ['voided', 'declined', 'expired'] as const)
      expect(sendAgainQuery({ id: DOC, status, templateId: TEMPLATE, about })).toBe(
        `template=${TEMPLATE}&from=${DOC}&person=${DANA}`,
      );
    expect(
      sendAgainQuery({
        id: DOC,
        status: 'voided',
        templateId: TEMPLATE,
        about: { kind: 'custom_record', id: DANA },
      }),
    ).toBe(`template=${TEMPLATE}&from=${DOC}&record=${DANA}`);
  });

  it('isn’t offered while it’s out, once it’s signed, or when its template is gone', () => {
    expect(sendAgainQuery({ id: DOC, status: 'out', templateId: TEMPLATE, about })).toBeNull();
    expect(
      sendAgainQuery({ id: DOC, status: 'completed', templateId: TEMPLATE, about }),
    ).toBeNull();
    expect(sendAgainQuery({ id: DOC, status: 'voided', templateId: null, about })).toBeNull();
  });
});

describe('what the Send screen asks the team to fill in', () => {
  it('is the business’s own part and what HandsFreeOS filled in, top to bottom, never a signature', () => {
    const d = DocumentDefinition.parse({
      pages: [
        { width: 612, height: 792 },
        { width: 612, height: 792 },
      ],
      roles: [{ key: 'customer', label: 'Customer', kind: 'customer' }],
      fields: [
        {
          id: 'sig',
          type: 'signature',
          role: 'customer',
          page: 1,
          x: 0.1,
          y: 0.8,
          w: 0.3,
          h: 0.05,
        },
        {
          id: 'when',
          type: 'date_signed',
          role: 'customer',
          page: 1,
          x: 0.5,
          y: 0.8,
          w: 0.2,
          h: 0.03,
        },
        { id: 'start', type: 'date', role: 'sender', page: 0, x: 0.1, y: 0.3, w: 0.2, h: 0.03 },
        {
          id: 'name',
          type: 'name',
          role: 'customer',
          page: 0,
          x: 0.1,
          y: 0.1,
          w: 0.3,
          h: 0.03,
          fillFrom: 'customer.name',
        },
        { id: 'notes', type: 'text', role: 'customer', page: 0, x: 0.1, y: 0.5, w: 0.3, h: 0.03 },
        { id: 'kept', type: 'text', role: 'customer', page: 1, x: 0.1, y: 0.1, w: 0.3, h: 0.03 },
      ],
    });
    expect(
      sendFillable(d, { kept: { kind: 'text', text: 'From before' } }).map((f) => f.id),
    ).toEqual(['name', 'start', 'kept']);
  });
});

describe('the words', () => {
  it('are plain, with curly apostrophes', () => {
    const all: string[] = [];
    const walk = (v: unknown) => {
      if (typeof v === 'string') all.push(v);
      else if (typeof v === 'function') all.push(String(v.length ? v('Dana', 'today', 'x') : v()));
      else if (v && typeof v === 'object') Object.values(v).forEach(walk);
    };
    walk(DOCUMENT_SCREEN_WORDS);
    for (const words of all) {
      expect(words).not.toMatch(/'/);
      expect(words).not.toMatch(/ — /);
    }
  });

  it('give the phone’s Sign now a way back only the app answers', () => {
    expect(PHONE_HAND_BACK).toMatch(/^handsfreeos:\/\//);
    expect(PHONE_HAND_BACK).not.toMatch(/\/app\//);
  });
});
