/**
 * A form's answers as a spreadsheet: the columns, the time zone, and the cells a spreadsheet would otherwise get wrong
 * (commas, quotes, line breaks) or run (a customer's `=HYPERLINK(…)`).
 */
import { describe, expect, it } from 'vitest';
import {
  csvCell,
  formAnswersCsv,
  formAnswersFileName,
  spreadsheetTime,
  type AnswersSheet,
} from '../src/forms/export';

const TZ = 'America/Chicago';

describe('a cell', () => {
  it('is left alone when it is plain', () => {
    expect(csvCell('On time and tidy')).toBe('On time and tidy');
    expect(csvCell('')).toBe('');
    expect(csvCell('-5')).toBe('-5');
    expect(csvCell('+15125550301')).toBe('+15125550301');
  });

  it('is quoted when it holds a comma, a quote or a line break', () => {
    expect(csvCell('Late, but fixed it')).toBe('"Late, but fixed it"');
    expect(csvCell('They said "soon"')).toBe('"They said ""soon"""');
    expect(csvCell('Line one\nLine two')).toBe('"Line one\nLine two"');
    expect(csvCell(' leading space')).toBe('" leading space"');
  });

  it('never runs as a formula', () => {
    expect(csvCell('=HYPERLINK("http://x","click")')).toBe(
      '"\'=HYPERLINK(""http://x"",""click"")"',
    );
    expect(csvCell('+1 (512) 555-0301')).toBe("'+1 (512) 555-0301");
    expect(csvCell('-2+3')).toBe("'-2+3");
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
  });
});

describe('the file', () => {
  const sheet: AnswersSheet = {
    columns: [
      { questionId: 'q_rating00', title: 'How did we do?' },
      { questionId: 'q_notes000', title: 'Anything else?' },
    ],
    rows: [
      {
        personName: 'Maria Lopez',
        source: 'qr',
        completedAt: '2026-09-17T15:02:00.000Z',
        scorePercent: null,
        passed: null,
        answers: { q_rating00: '5', q_notes000: 'Late, but fixed it' },
      },
      {
        personName: null,
        source: 'app',
        completedAt: '2026-09-16T20:30:00.000Z',
        scorePercent: null,
        passed: null,
        answers: { q_rating00: '4' },
      },
    ],
  };

  it('has a row per answer sheet under a column per question, in the business’s time zone', () => {
    const csv = formAnswersCsv(sheet, TZ);
    expect(csv.startsWith('\uFEFF')).toBe(true);
    expect(csv.slice(1).split('\r\n')).toEqual([
      'Answered,Name,From,How did we do?,Anything else?',
      '2026-09-17 10:02,Maria Lopez,QR code,5,"Late, but fixed it"',
      '2026-09-16 15:30,,Phone app,4,',
      '',
    ]);
  });

  it('adds the score and whether they passed only when something was scored', () => {
    const quiz = {
      ...sheet,
      rows: [{ ...sheet.rows[0]!, scorePercent: 80, passed: true }, sheet.rows[1]!],
    };
    const lines = formAnswersCsv(quiz, TZ).slice(1).split('\r\n');
    expect(lines[0]).toBe('Answered,Name,From,Score %,Passed,How did we do?,Anything else?');
    expect(lines[1]).toBe('2026-09-17 10:02,Maria Lopez,QR code,80,Yes,5,"Late, but fixed it"');
    expect(lines[2]).toBe('2026-09-16 15:30,,Phone app,,,4,');
  });

  it('is just the heading when nobody has answered', () => {
    expect(formAnswersCsv({ columns: sheet.columns, rows: [] }, TZ)).toBe(
      '\uFEFFAnswered,Name,From,How did we do?,Anything else?\r\n',
    );
  });

  it('is named for the form and the day where the business is', () => {
    // 1:00 AM on the 25th in UTC is still the 24th in Chicago.
    expect(formAnswersFileName('job-feedback', Date.parse('2026-09-25T01:00:00Z'), TZ)).toBe(
      'job-feedback-answers-2026-09-24.csv',
    );
    expect(formAnswersFileName('', 0, TZ)).toMatch(/^form-answers-/);
    expect(spreadsheetTime('2026-01-05T06:07:00.000Z', TZ)).toBe('2026-01-05 00:07');
  });
});
