/**
 * How a business's emails look (design tools, part 5): the HTML of an email, drawn the same way by the worker that
 * sends it and by Settings → Email's preview. Browser-safe.
 *
 * - **Plain** (an email a person or the AI teammate wrote in a conversation, as people's own emails are): paragraphs,
 *   line breaks and links, nothing else. Its HTML is exactly what it always was.
 * - **Automatic** (a confirmation, a reminder, an invoice, a campaign): the logo at the top and links in the business's
 *   colour, as before; now a line that is only "Some words: https://…" is a real button in the colour (the first
 *   filled, the rest outlined), and what follows a line that is only "--" is the small print (why they get it, how to
 *   stop).
 * - **With a layout** (Settings → Email → How your emails look): a white card on grey, 600 pixels across at most, a
 *   band of the colour across its top if wanted, the logo (or the name, without one) on the left or in the centre, and
 *   a footer with the address, phone, website and social links if wanted. Corners follow the brand kit's.
 * - **A campaign written in blocks** draws its blocks where the paragraphs would be.
 *
 * Built from tables and inline styles, which every mail app reads.
 */
import { ITEM_ALIGNS, PICTURE_SIZE_SHARE, type ItemAlign } from '../forms/questions';
import { EMAIL_SPACE_PX, emailButtonOf, type EmailBlock } from '../campaigns/email-blocks';
import { buttonColorFor } from './colour';
import {
  LOOK_SOCIAL_NAMES,
  type LookCorners,
  type LookEmailLayout,
  type LookSocialLink,
} from './look';

/** The business's details an email's footer shows, each null or empty when it has none. */
export interface EmailContact {
  readonly address: readonly string[];
  /** As shown, like (512) 555-0134. */
  readonly phone: string | null;
  readonly website: string | null;
  readonly socials: readonly LookSocialLink[];
}

/** A business's look on an email HandsFreeOS sends for it automatically. */
export interface EmailBrand {
  readonly name: string;
  readonly look: {
    readonly logo: { readonly url: string; readonly width: number; readonly height: number } | null;
    /** Its colour as #rrggbb; null for HandsFreeOS's own. */
    readonly color: string | null;
    readonly corners?: LookCorners | null;
  };
  /** How its emails look; null or left out: as they looked before (the logo on the left, no band, no footer). */
  readonly layout?: LookEmailLayout | null;
  readonly contact?: EmailContact | null;
}

/** A campaign's blocks, its words already filled for the person, and where its pictures are. */
export interface EmailBlocksDraw {
  readonly blocks: readonly EmailBlock[];
  readonly pictureUrl: (path: string) => string;
}

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";
const PLAIN_LINK = '#2f5bd3';
const INK = '#191d25';
const MUTED = '#6b7280';
const RULE = '#e5e7eb';
/** The card's width, and the words' width inside it. */
export const EMAIL_WIDTH = 600;
const PAD = 28;
export const EMAIL_CONTENT_WIDTH = EMAIL_WIDTH - PAD * 2;

const CARD_RADIUS: Readonly<Record<LookCorners, string>> = {
  square: '0',
  slight: '8px',
  round: '16px',
};
const BUTTON_RADIUS: Readonly<Record<LookCorners, string>> = {
  square: '0',
  slight: '6px',
  round: '22px',
};
const PICTURE_RADIUS: Readonly<Record<LookCorners, string>> = {
  square: '0',
  slight: '6px',
  round: '14px',
};

export const escapeEmailHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const esc = escapeEmailHtml;

const linkify = (escaped: string, color: string) =>
  escaped.replace(
    /\bhttps?:\/\/[^\s<]+[^\s<.,;:!?)]/g,
    (url) => `<a href="${url}" style="color:${color}">${url}</a>`,
  );

/** How big a logo is drawn at the top of an email: 48 pixels high, at most 240 across, its shape kept. */
export function emailLogoSize(logo: { readonly width: number; readonly height: number }): {
  width: number;
  height: number;
} {
  const scale = Math.min(48 / logo.height, 240 / logo.width, 1);
  return {
    width: Math.max(1, Math.round(logo.width * scale)),
    height: Math.max(1, Math.round(logo.height * scale)),
  };
}

/** The colour of a business's links and buttons in its emails: its own, deep enough for white words on it. */
export const emailColorOf = (color: string | null | undefined): string | null =>
  color ? buttonColorFor(color) : null;

/** The small print: what follows the last line that is only "--". */
function splitSmallPrint(text: string): { main: string; small: string } {
  const lines = text.split('\n');
  let at = -1;
  for (let i = lines.length - 1; i >= 0; i--)
    if (lines[i]!.trim() === '--') {
      at = i;
      break;
    }
  if (at < 0) return { main: text, small: '' };
  return { main: lines.slice(0, at).join('\n'), small: lines.slice(at + 1).join('\n') };
}

interface Drawing {
  readonly color: string;
  readonly corners: LookCorners | null;
  /** Buttons drawn so far: the first is filled, the rest outlined. */
  buttons: number;
}

function buttonHtml(d: Drawing, label: string, url: string, align: ItemAlign = 'left'): string {
  const radius = BUTTON_RADIUS[d.corners ?? 'slight'];
  const filled = d.buttons++ === 0;
  const margin = align === 'center' ? '0 auto' : align === 'right' ? '0 0 0 auto' : '0';
  const cell = filled
    ? `border-radius:${radius};background:${d.color}" bgcolor="${d.color}`
    : `border-radius:${radius};border:2px solid ${d.color}`;
  const words = filled ? '#ffffff' : d.color;
  return (
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="${align}" style="margin:${margin};border-collapse:separate">` +
    `<tr><td style="${cell}"><a href="${esc(url)}" style="display:inline-block;padding:${filled ? '12px 22px' : '10px 20px'};` +
    `font-family:${FONT};font-size:15px;font-weight:600;line-height:1.2;color:${words};text-decoration:none;border-radius:${radius}">` +
    `${esc(label)}</a></td></tr></table>`
  );
}

/** A button on its own row, with room around it. */
const buttonRow = (d: Drawing, label: string, url: string, align: ItemAlign = 'left') =>
  `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 16px"><tr><td align="${align}">${buttonHtml(d, label, url, align)}</td></tr></table>`;

const paragraph = (lines: readonly string[], color: string, align?: ItemAlign) =>
  `<p style="margin:0 0 12px${align && align !== 'left' ? `;text-align:${align}` : ''}">${linkify(
    esc(lines.join('\n')),
    color,
  ).replace(/\n/g, '<br>')}</p>`;

/** Words as paragraphs, with a line that's only "Words: address" drawn as a button when `d` is given. */
function wordsHtml(text: string, color: string, d: Drawing | null, align?: ItemAlign): string {
  return (
    text
      .trim()
      .split(/\n{2,}/)
      // A plain email keeps every paragraph, as it always has.
      .filter((p) => (!d && !align) || p.trim())
      .map((p) => {
        if (!d) return paragraph([p], color, align);
        let out = '';
        let run: string[] = [];
        for (const line of p.split('\n')) {
          const button = emailButtonOf(line);
          if (!button) {
            run.push(line);
            continue;
          }
          if (run.length) out += paragraph(run, color, align);
          run = [];
          out += buttonRow(d, button.label, button.url, align);
        }
        if (run.length) out += paragraph(run, color, align);
        return out;
      })
      .join('')
  );
}

function blockHtml(b: EmailBlock, d: Drawing, draw: EmailBlocksDraw, width: number): string {
  switch (b.kind) {
    case 'words':
      return wordsHtml(b.text, d.color, null, b.align);
    case 'button':
      return buttonRow(d, b.label, b.url, b.align);
    case 'line':
      return `<hr style="border:0;border-top:1px solid ${RULE};margin:20px 0">`;
    case 'space': {
      const px = EMAIL_SPACE_PX[b.size];
      return `<div style="height:${px}px;line-height:${px}px;font-size:0">&nbsp;</div>`;
    }
    case 'picture': {
      const w = Math.min(b.picture.width, Math.round(width * PICTURE_SIZE_SHARE[b.size]));
      const h = Math.max(1, Math.round((w * b.picture.height) / b.picture.width));
      const radius = PICTURE_RADIUS[d.corners ?? 'slight'];
      const img =
        `<img src="${esc(draw.pictureUrl(b.picture.path))}" alt="${esc(b.words)}" width="${w}" height="${h}" ` +
        `style="display:inline-block;width:${w}px;max-width:100%;height:auto;border:0;border-radius:${radius}">`;
      const align = ITEM_ALIGNS.includes(b.align) ? b.align : 'center';
      return (
        `<div style="margin:0 0 16px;text-align:${align}">` +
        (b.link ? `<a href="${esc(b.link)}" style="text-decoration:none">${img}</a>` : img) +
        (b.words
          ? `<div style="margin:6px 0 0;font-size:13px;line-height:1.4;color:${MUTED}">${esc(b.words)}</div>`
          : '') +
        '</div>'
      );
    }
  }
}

const smallPrintHtml = (lines: readonly string[], color: string) =>
  lines.join('\n').trim()
    ? lines
        .join('\n')
        .trim()
        .split(/\n{2,}/)
        .filter((p) => p.trim())
        .map(
          (p) =>
            `<p style="margin:0 0 8px">${linkify(esc(p.trim()), color).replace(/\n/g, '<br>')}</p>`,
        )
        .join('')
    : '';

function logoHtml(brand: EmailBrand, inline: boolean): string {
  const logo = brand.look.logo;
  if (!logo) return '';
  const size = emailLogoSize(logo);
  return (
    `<img src="${esc(logo.url)}" alt="${esc(brand.name)}" width="${size.width}" height="${size.height}" ` +
    `style="display:${inline ? 'inline-block' : 'block'};border:0;width:${size.width}px;height:${size.height}px">`
  );
}

function footerLines(brand: EmailBrand, color: string): string[] {
  const c = brand.contact;
  const lines = [`<strong style="color:${INK}">${esc(brand.name)}</strong>`];
  if (c?.address.length) lines.push(c.address.map(esc).join(', '));
  const reach = [
    c?.phone ? esc(c.phone) : '',
    c?.website
      ? `<a href="${esc(c.website)}" style="color:${color}">${esc(c.website.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, ''))}</a>`
      : '',
  ].filter(Boolean);
  if (reach.length) lines.push(reach.join(' &nbsp;·&nbsp; '));
  if (c?.socials.length)
    lines.push(
      c.socials
        .map(
          (s) =>
            `<a href="${esc(s.url)}" style="color:${color};text-decoration:none">${LOOK_SOCIAL_NAMES[s.kind]}</a>`,
        )
        .join(' &nbsp;·&nbsp; '),
    );
  return lines;
}

/**
 * An email's HTML: plain without a brand, the business's look with one. `blocks`, for a campaign written in blocks,
 * replace the words above the small print; the plain words still give the small print.
 */
export function emailHtml(
  text: string,
  brand?: EmailBrand | null,
  blocks?: EmailBlocksDraw | null,
): string {
  if (!brand) {
    const paragraphs = wordsHtml(text, PLAIN_LINK, null);
    return (
      '<!doctype html><html><body style="margin:0;padding:16px;font-family:-apple-system,BlinkMacSystemFont,' +
      `'Segoe UI',Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5;color:${INK}">${paragraphs}</body></html>`
    );
  }
  const color = emailColorOf(brand.look.color) ?? PLAIN_LINK;
  const corners = brand.look.corners ?? null;
  const d: Drawing = { color, corners, buttons: 0 };
  const { main, small } = splitSmallPrint(text);
  const layout = brand.layout ?? null;
  const width = layout ? EMAIL_CONTENT_WIDTH : EMAIL_WIDTH - 32;
  const content = blocks?.blocks.length
    ? blocks.blocks.map((b) => blockHtml(b, d, blocks, width)).join('')
    : wordsHtml(main, color, d);
  let smallLines = small.split('\n');

  if (!layout) {
    const logo = logoHtml(brand, false);
    const header = logo ? `<div style="margin:0 0 20px">${logo}</div>` : '';
    const print = smallPrintHtml(smallLines, color);
    return (
      `<!doctype html><html><body style="margin:0;padding:16px;font-family:${FONT};font-size:15px;line-height:1.5;color:${INK}">` +
      header +
      content +
      (print
        ? `<div style="margin:24px 0 0;padding:16px 0 0;border-top:1px solid ${RULE};font-size:12px;line-height:1.5;color:${MUTED}">${print}</div>`
        : '') +
      '</body></html>'
    );
  }

  const align = layout.logo === 'center' ? 'center' : 'left';
  const band = brand.look.color ?? color;
  const logo = logoHtml(brand, true);
  const head = logo
    ? logo
    : `<div style="font-family:${FONT};font-size:19px;font-weight:700;line-height:1.3;color:${INK}">${esc(brand.name)}</div>`;
  let foot = '';
  if (layout.footer) {
    // What the footer already shows isn't said twice in the small print (a campaign's name and address).
    const shown = new Set(
      [brand.name, ...(brand.contact?.address ?? [])].map((l) => l.trim().toLowerCase()),
    );
    smallLines = smallLines.filter((l) => !shown.has(l.trim().toLowerCase()));
    foot = footerLines(brand, color).join('<br>');
  }
  const print = smallPrintHtml(smallLines, color);
  const footer =
    foot || print
      ? `<tr><td align="${align}" style="padding:18px ${PAD}px 24px;border-top:1px solid ${RULE};font-family:${FONT};font-size:12px;line-height:1.6;color:${MUTED}">` +
        (foot ? `<div>${foot}</div>` : '') +
        (print ? `<div style="${foot ? 'margin:12px 0 0' : ''}">${print}</div>` : '') +
        '</td></tr>'
      : '';
  return (
    '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta name="color-scheme" content="light only"></head>' +
    '<body style="margin:0;padding:0;background:#f3f4f6">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f3f4f6"><tr><td align="center" style="padding:24px 12px">' +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:${EMAIL_WIDTH}px;background:#ffffff;border-radius:${CARD_RADIUS[corners ?? 'slight']};border-collapse:separate;overflow:hidden">` +
    (layout.band
      ? `<tr><td height="6" style="height:6px;line-height:6px;font-size:0;background:${band}" bgcolor="${band}">&nbsp;</td></tr>`
      : '') +
    `<tr><td align="${align}" style="padding:24px ${PAD}px 0">${head}</td></tr>` +
    `<tr><td style="padding:20px ${PAD}px 12px;font-family:${FONT};font-size:15px;line-height:1.5;color:${INK}">${content}</td></tr>` +
    footer +
    '</table></td></tr></table></body></html>'
  );
}
