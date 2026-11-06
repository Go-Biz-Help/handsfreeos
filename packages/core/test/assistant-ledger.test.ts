/**
 * The Assistant's checklist (src/assistant/ledger): every area file is listed and well formed, and the table on Admin
 * → Assistant coverage finds what isn't marked off: items not covered yet, items whose screen changed since their
 * check, screens nobody has checked, and files that are gone.
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  LEDGER_AREAS,
  LEDGER_FINGERPRINTS,
  type LedgerAreaFile,
} from '../src/assistant/ledger/index';
import { ledgerReport } from '../src/assistant/ledger/report';
import { AssistantLedgerInput, LEDGER_COVERED } from '../src/schemas/assistant-ledger';

const DIR = join(__dirname, '../src/assistant/ledger');
const PRINT = /^[0-9a-f]{12}$/;

const AreaFile = z.strictObject({
  area: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),
  title: z.string().min(1),
  checkedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  files: z.record(z.string().regex(/^(apps|packages)\/\S+$/), z.string().regex(PRINT)),
  items: z.array(
    z.strictObject({
      path: z.string().min(1),
      kind: z.enum(['see', 'do']),
      file: z.string().min(1),
      covered: z.enum(LEDGER_COVERED),
      by: z.string(),
    }),
  ),
  gaps: z.array(
    z.strictObject({
      id: z.string().min(1),
      severity: z.enum(['high', 'medium', 'low']),
      kind: z.string(),
      where: z.string().min(1),
      gap: z.string().min(1),
      fix: z.string(),
      status: z.enum(['open', 'fixed', 'never']),
      pr: z.number().int().nullable(),
    }),
  ),
});

describe('the checklist files', () => {
  it('lists every area file, once, by its own name', () => {
    const files = readdirSync(DIR)
      .filter((f) => f.endsWith('.json') && f !== 'fingerprints.json')
      .map((f) => f.slice(0, -'.json'.length))
      .sort();
    expect(LEDGER_AREAS.map((a) => a.area).sort()).toEqual(files);
  });

  it('keeps every area well formed', () => {
    for (const area of LEDGER_AREAS) {
      const parsed = AreaFile.safeParse(area);
      expect(parsed.success ? null : `${area.area}: ${parsed.error.message}`).toBeNull();
    }
  });

  it('gives each audit gap its own id in its area', () => {
    const ids = LEDGER_AREAS.flatMap((a) => a.gaps.map((g) => `${a.area}/${g.id}`));
    expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([]);
  });

  it('fingerprints every screen file the areas list', () => {
    for (const [file, print] of Object.entries(LEDGER_FINGERPRINTS)) {
      expect(file).toMatch(/^(apps|packages)\/\S+$/);
      expect(print).toMatch(PRINT);
    }
  });
});

const area = (over: Partial<LedgerAreaFile> & Pick<LedgerAreaFile, 'area'>): LedgerAreaFile => ({
  title: `${over.area}: its pages`,
  checkedOn: '2026-11-06',
  files: {},
  items: [],
  gaps: [],
  ...over,
});

const money = area({
  area: 'money',
  files: { 'apps/web/money.tsx': 'aaaaaaaaaaaa', 'apps/web/invoice.tsx': 'bbbbbbbbbbbb' },
  items: [
    {
      path: 'Money → New invoice',
      kind: 'do',
      file: 'apps/web/money.tsx:10',
      covered: 'yes',
      by: 'write_invoice',
    },
    {
      path: 'Money → Copy link',
      kind: 'see',
      file: 'apps/web/invoice.tsx:20',
      covered: 'partly',
      by: 'a path only',
    },
    {
      path: 'Money → Refund',
      kind: 'do',
      file: 'apps/web/invoice.tsx:30',
      covered: 'yes',
      by: 'refund_payment',
    },
    {
      path: 'Money → Pay on Stripe',
      kind: 'do',
      file: 'apps/web/invoice.tsx:40',
      covered: 'person',
      by: 'their card',
    },
  ],
  gaps: [
    {
      id: 'money-2',
      severity: 'low',
      kind: 'words',
      where: 'Money',
      gap: 'Small',
      fix: '',
      status: 'open',
      pr: null,
    },
    {
      id: 'money-1',
      severity: 'high',
      kind: 'read',
      where: 'Money',
      gap: 'Big',
      fix: '',
      status: 'open',
      pr: null,
    },
    {
      id: 'money-3',
      severity: 'medium',
      kind: 'do',
      where: 'Money',
      gap: 'Done',
      fix: '',
      status: 'fixed',
      pr: 600,
    },
  ],
});
const inbox = area({
  area: 'inbox',
  files: { 'apps/web/inbox.tsx': 'cccccccccccc', 'apps/web/old.tsx': 'dddddddddddd' },
  items: [
    {
      path: 'Inbox → Reply',
      kind: 'do',
      file: 'apps/web/inbox.tsx:5',
      covered: 'no',
      by: 'nothing yet',
    },
  ],
});
// The invoice screen changed since its check, a new screen arrived, and old.tsx is gone.
const now = {
  'apps/web/money.tsx': 'aaaaaaaaaaaa',
  'apps/web/invoice.tsx': 'eeeeeeeeeeee',
  'apps/web/inbox.tsx': 'cccccccccccc',
  'apps/web/new.tsx': 'ffffffffffff',
};
const ask = (input: Partial<AssistantLedgerInput>) =>
  ledgerReport([money, inbox], now, AssistantLedgerInput.parse(input));

describe('the table', () => {
  it('counts every area and the whole', () => {
    const r = ask({});
    expect(r.areas.map((a) => [a.key, a.items, a.changed, a.unmarked, a.gapsOpen])).toEqual([
      ['money', 4, 3, 3, 2],
      ['inbox', 1, 0, 1, 0],
    ]);
    expect(r.totals).toMatchObject({
      items: 5,
      yes: 2,
      partly: 1,
      no: 1,
      person: 1,
      changed: 3,
      unmarked: 4,
      gapsOpen: 2,
      gapsFixed: 1,
      newScreens: 1,
      goneFiles: 1,
    });
  });

  it('lists what isn’t marked off: not yet, partly, or changed since its check', () => {
    expect(ask({}).items.map((i) => i.path)).toEqual([
      'Money → Copy link',
      'Money → Refund',
      'Money → Pay on Stripe',
      'Inbox → Reply',
    ]);
    expect(ask({ itemState: 'changed' }).items.every((i) => i.changed)).toBe(true);
    expect(ask({ itemState: 'yes', area: 'money' }).items.map((i) => i.path)).toEqual([
      'Money → New invoice',
      'Money → Refund',
    ]);
    expect(ask({ itemState: 'all', q: 'stripe' }).items.map((i) => i.path)).toEqual([
      'Money → Pay on Stripe',
    ]);
  });

  it('pages through them', () => {
    const r = ask({ itemState: 'all', offset: 1, limit: 2 });
    expect(r.total).toBe(5);
    expect(r.items.map((i) => i.path)).toEqual(['Money → Copy link', 'Money → Refund']);
  });

  it('lists the audit’s gaps, serious first', () => {
    expect(ask({ view: 'gaps' }).gaps.map((g) => g.id)).toEqual(['money-1', 'money-2']);
    expect(ask({ view: 'gaps', gapState: 'fixed' }).gaps).toMatchObject([
      { id: 'money-3', pr: 600 },
    ]);
  });

  it('lists the screens nobody has checked, and the files that are gone', () => {
    expect(ask({ view: 'screens' }).screens).toEqual([
      { file: 'apps/web/new.tsx', state: 'new', area: null },
      { file: 'apps/web/old.tsx', state: 'gone', area: 'inbox' },
    ]);
    // A new screen belongs to no area yet, so one area's list has only its own gone files.
    expect(ask({ view: 'screens', area: 'money' }).screens).toEqual([]);
  });
});
