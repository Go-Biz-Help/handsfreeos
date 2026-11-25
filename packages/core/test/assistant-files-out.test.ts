/**
 * The table a file the Assistant makes is drawn from (assistant/files-out.ts): cells that keep their kind, the list in
 * a look-up's answer, totals, the CSV, and the file's name.
 */
import { describe, expect, it } from 'vitest';
import {
  buildFileTable,
  cellOf,
  cellWords,
  fileDetail,
  fileNameOf,
  fileTableCsv,
  listOf,
  valueAt,
} from '../src/assistant/files-out';

const TZ = 'America/Chicago';

describe('cells', () => {
  it('keeps money, days, moments and numbers as what they are', () => {
    expect(cellOf(12_345, 'cents', TZ)).toEqual({ kind: 'money', cents: 12_345 });
    expect(cellOf('$1,250.50', 'dollars', TZ)).toEqual({ kind: 'money', cents: 125_050 });
    expect(cellOf('2026-11-25', undefined, TZ)).toEqual({ kind: 'date', y: 2026, m: 11, d: 25 });
    // A moment just after midnight UTC is still the evening before in Texas.
    expect(cellOf('2026-11-25T03:00:00.000Z', 'date', TZ)).toEqual({
      kind: 'date',
      y: 2026,
      m: 11,
      d: 24,
    });
    expect(cellOf('2026-11-25T21:30:00Z', undefined, TZ)).toEqual({
      kind: 'datetime',
      at: Date.parse('2026-11-25T21:30:00Z'),
    });
    expect(cellOf(true, undefined, TZ)).toEqual({ kind: 'text', text: 'Yes' });
    expect(cellOf(null, 'cents', TZ)).toEqual({ kind: 'empty' });
    // A word where a number was expected stays the word, rather than a wrong number.
    expect(cellOf('call first', 'number', TZ)).toEqual({ kind: 'text', text: 'call first' });
  });

  it('names a nested thing, and lists a list', () => {
    expect(cellOf({ id: 'x', fullName: 'Bob Ortiz' }, undefined, TZ)).toEqual({
      kind: 'text',
      text: 'Bob Ortiz',
    });
    expect(cellOf(['VIP', { name: 'Roofing' }], undefined, TZ)).toEqual({
      kind: 'text',
      text: 'VIP, Roofing',
    });
  });

  it('says each one as a person reads it', () => {
    expect(cellWords({ kind: 'money', cents: 125_050 }, TZ)).toBe('$1,250.50');
    expect(cellWords({ kind: 'date', y: 2026, m: 11, d: 25 }, TZ)).toBe('Nov 25, 2026');
    expect(cellWords({ kind: 'datetime', at: Date.parse('2026-11-25T21:30:00Z') }, TZ)).toBe(
      'Nov 25, 2026, 3:30 PM',
    );
    expect(cellWords({ kind: 'number', n: 1234.5 }, TZ)).toBe('1,234.5');
  });
});

describe('a look-up’s rows', () => {
  it('finds the list in an answer', () => {
    expect(listOf([{ a: 1 }])).toEqual([{ a: 1 }]);
    expect(listOf({ items: [{ a: 1 }], nextCursor: null })).toEqual([{ a: 1 }]);
    expect(listOf({ total: 3, customers: [{ a: 1 }] })).toEqual([{ a: 1 }]);
    expect(listOf({ page: { rows: [{ a: 1 }] } })).toEqual([{ a: 1 }]);
    expect(listOf({ items: [] })).toEqual([]);
    expect(listOf({ person: { fullName: 'Bob' } })).toBeNull();
  });

  it('reads a path into each row', () => {
    const row = { person: { fullName: 'Bob' }, lines: [{ name: 'Tune-up' }] };
    expect(valueAt(row, 'person.fullName')).toBe('Bob');
    expect(valueAt(row, 'lines.0.name')).toBe('Tune-up');
    expect(valueAt(row, 'person.phone')).toBeUndefined();
  });
});

describe('the table', () => {
  const table = buildFileTable(
    {
      title: ' Who owes money ',
      intro: ['As of today', ' '],
      columns: [
        { label: 'Customer', path: 'person.fullName' },
        { label: 'Owes', path: 'balanceCents', as: 'cents', total: true },
        { label: 'Since', path: 'dueOn' },
      ],
      records: [
        { person: { fullName: 'Bob Ortiz' }, balanceCents: 12_000, dueOn: '2026-11-01' },
        { person: { fullName: '=SUM(A1)' }, balanceCents: 8_050, dueOn: null },
      ],
    },
    TZ,
  );

  it('adds up the columns asked for, in money', () => {
    expect(table.title).toBe('Who owes money');
    expect(table.intro).toEqual(['As of today']);
    expect(table.totals).toEqual([
      { kind: 'empty' },
      { kind: 'money', cents: 20_050 },
      { kind: 'empty' },
    ]);
  });

  it('writes a CSV a spreadsheet reads, where nothing runs as a formula', () => {
    const csv = fileTableCsv(table, TZ);
    expect(csv.startsWith('\uFEFFCustomer,Owes,Since\r\n')).toBe(true);
    expect(csv).toContain('Bob Ortiz,120.00,2026-11-01\r\n');
    expect(csv).toContain("'=SUM(A1),80.50,\r\n");
    expect(csv.endsWith('Total,200.50,\r\n')).toBe(true);
  });

  it('takes rows the Assistant wrote, cell by cell', () => {
    const given = buildFileTable(
      {
        title: 'Jobs',
        columns: [{ label: 'Month' }, { label: 'Jobs', as: 'number', total: true }],
        given: [
          ['October', 12],
          ['November', '9'],
        ],
      },
      TZ,
    );
    expect(given.rows[1]).toEqual([
      { kind: 'text', text: 'November' },
      { kind: 'number', n: 9 },
    ]);
    expect(given.totals![1]).toEqual({ kind: 'number', n: 21 });
  });
});

describe('the file’s name', () => {
  it('is the title and the day, with nothing a computer refuses in a name', () => {
    const at = Date.parse('2026-11-25T16:00:00Z');
    expect(fileNameOf('Who owes: money?', 'excel', at, TZ)).toBe('Who owes money 2026-11-25.xlsx');
    expect(fileNameOf('///', 'pdf', at, TZ)).toBe('Report 2026-11-25.pdf');
    expect(fileDetail('csv', 1)).toBe('CSV · 1 row · Kept 30 days');
    expect(fileDetail('excel', 1200)).toBe('Excel · 1,200 rows · Kept 30 days');
  });
});
