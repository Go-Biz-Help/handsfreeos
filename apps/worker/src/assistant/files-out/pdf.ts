/**
 * A PDF report of one table (assistant/files-out.ts in core): the title, who it's for and when it was made, the lines
 * above the table, then the table with its headings on every page, amounts lined up on the right, and a bold Total
 * row. Letter paper, turned sideways when it has more than five columns. Page numbers at the foot.
 *
 * The standard fonts only write Western European letters (documents/pdf.ts, `writable`): anything else is "?".
 */
import { PDFDocument, rgb, StandardFonts, type PDFFont, type PDFPage } from 'pdf-lib';
import { cellWords, type FileCell, type FileTable } from '@hfos/core/server';
import { wrap, writable } from '../../documents/pdf';

const INK = rgb(0.07, 0.09, 0.15);
const GREY = rgb(0.42, 0.45, 0.5);
const RULE = rgb(0.85, 0.87, 0.9);
const HEAD_FILL = rgb(0.95, 0.96, 0.97);

const MARGIN = 40;
const SIZE = 9;
const LINE = 11.5;
const PAD = 4;
/** A cell shows this many lines at most; the rest is cut with "…". */
const CELL_LINES = 3;

/** Words on one line, as the standard fonts measure and write them. */
const oneLine = (text: string) => writable(text).replace(/\n/g, ' ');

const rightAligned = (c: FileCell) => c.kind === 'money' || c.kind === 'number';

interface Fonts {
  readonly regular: PDFFont;
  readonly bold: PDFFont;
}

/** Each column's share of the width: what its heading and cells need, within limits, scaled to fit. */
function columnWidths(table: FileTable, timeZone: string, fonts: Fonts, room: number): number[] {
  const want = table.columns.map((c, i) => {
    let w = fonts.bold.widthOfTextAtSize(oneLine(c.label), SIZE);
    for (const row of table.rows.slice(0, 200)) {
      const text = oneLine(cellWords(row[i]!, timeZone));
      w = Math.max(w, fonts.regular.widthOfTextAtSize(text.slice(0, 60), SIZE));
    }
    return Math.min(Math.max(w + PAD * 2, 40), 220);
  });
  const sum = want.reduce((a, b) => a + b, 0);
  return want.map((w) => (w / sum) * room);
}

function cellLines(text: string, font: PDFFont, width: number): string[] {
  const lines = wrap(text, font, SIZE, Math.max(width - PAD * 2, 10));
  if (lines.length <= CELL_LINES) return lines;
  const kept = lines.slice(0, CELL_LINES);
  kept[CELL_LINES - 1] = `${kept[CELL_LINES - 1]!.replace(/.$/, '')}…`;
  return kept;
}

export interface ReportHeading {
  readonly business: string;
  /** "Made Nov 25, 2026, 3:05 PM for Dale Ortiz". */
  readonly made: string;
}

/** The table as a PDF report. */
export async function fileTablePdf(
  table: FileTable,
  timeZone: string,
  heading: ReportHeading,
): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.setTitle(oneLine(table.title));
  doc.setAuthor(oneLine(heading.business));
  doc.setCreator('HandsFreeOS');
  const fonts: Fonts = {
    regular: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
  };
  const [pageW, pageH] = table.columns.length > 5 ? [792, 612] : [612, 792];
  const room = pageW - MARGIN * 2;
  const widths = columnWidths(table, timeZone, fonts, room);
  const pages: PDFPage[] = [];
  let page!: PDFPage;
  let y = 0;

  const newPage = () => {
    page = doc.addPage([pageW, pageH]);
    pages.push(page);
    y = pageH - MARGIN;
  };

  const drawRow = (
    cells: readonly { text: string; right: boolean }[],
    font: PDFFont,
    fill: boolean,
  ) => {
    const lines = cells.map((c, i) => cellLines(c.text, font, widths[i]!));
    const height = Math.max(1, ...lines.map((l) => l.length)) * LINE + PAD * 2;
    if (fill)
      page.drawRectangle({ x: MARGIN, y: y - height, width: room, height, color: HEAD_FILL });
    let x = MARGIN;
    lines.forEach((ls, i) => {
      ls.forEach((line, n) => {
        const w = font.widthOfTextAtSize(line, SIZE);
        page.drawText(line, {
          x: cells[i]!.right ? x + widths[i]! - PAD - w : x + PAD,
          y: y - PAD - SIZE - n * LINE + 1,
          size: SIZE,
          font,
          color: INK,
        });
      });
      x += widths[i]!;
    });
    y -= height;
    page.drawLine({
      start: { x: MARGIN, y },
      end: { x: MARGIN + room, y },
      thickness: 0.5,
      color: RULE,
    });
    return height;
  };

  const headCells = table.columns.map((c, i) => ({
    text: c.label,
    right: table.rows.length > 0 && rightAligned(table.rows[0]![i]!),
  }));
  const rowHeight = (cells: readonly FileCell[], font: PDFFont) =>
    Math.max(
      1,
      ...cells.map((c, i) => cellLines(cellWords(c, timeZone), font, widths[i]!).length),
    ) *
      LINE +
    PAD * 2;

  // The heading, then the lines above the table.
  newPage();
  for (const line of wrap(table.title, fonts.bold, 16, room)) {
    page.drawText(line, { x: MARGIN, y: y - 16, size: 16, font: fonts.bold, color: INK });
    y -= 20;
  }
  page.drawText(oneLine(`${heading.business} · ${heading.made}`), {
    x: MARGIN,
    y: y - 9,
    size: 9,
    font: fonts.regular,
    color: GREY,
  });
  y -= 22;
  for (const para of table.intro) {
    for (const line of wrap(para, fonts.regular, 10, room)) {
      if (y < MARGIN + 40) newPage();
      page.drawText(line, { x: MARGIN, y: y - 10, size: 10, font: fonts.regular, color: INK });
      y -= 13;
    }
    y -= 3;
  }
  y -= 8;

  if (!table.rows.length) {
    page.drawText('Nothing to show here.', {
      x: MARGIN,
      y: y - 10,
      size: 10,
      font: fonts.regular,
      color: GREY,
    });
  } else {
    drawRow(headCells, fonts.bold, true);
    const footRoom = MARGIN + 18;
    for (const row of table.rows) {
      if (y - rowHeight(row, fonts.regular) < footRoom) {
        newPage();
        drawRow(headCells, fonts.bold, true);
      }
      drawRow(
        row.map((c) => ({ text: cellWords(c, timeZone), right: rightAligned(c) })),
        fonts.regular,
        false,
      );
    }
    if (table.totals) {
      if (y - rowHeight(table.totals, fonts.bold) < footRoom) {
        newPage();
        drawRow(headCells, fonts.bold, true);
      }
      drawRow(
        table.totals.map((c, i) => ({
          text: i === 0 && c.kind === 'empty' ? 'Total' : cellWords(c, timeZone),
          right: rightAligned(c),
        })),
        fonts.bold,
        false,
      );
    }
  }

  // Page numbers, once there are all of them.
  pages.forEach((p, i) => {
    const words = oneLine(`${table.title} · Page ${i + 1} of ${pages.length}`);
    const w = fonts.regular.widthOfTextAtSize(words, 8);
    p.drawText(words, {
      x: pageW - MARGIN - w,
      y: MARGIN / 2,
      size: 8,
      font: fonts.regular,
      color: GREY,
    });
  });
  return Buffer.from(await doc.save());
}
