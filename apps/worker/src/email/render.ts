/**
 * Email content: the HTML for what people typed, and received HTML made safe to show (sanitized here; the
 * browser also renders it in a sandboxed frame with remote images off until someone asks for them).
 */
import { emailHtml, type EmailBlocksDraw, type EmailBrand } from '@hfos/core';
import { convert } from 'html-to-text';
import sanitizeHtml from 'sanitize-html';

/** A business's look on the emails HandsFreeOS sends for it automatically (look/public.ts). */
export type { EmailBrand };

/**
 * What people type is plain text: paragraphs and line breaks, links made clickable, nothing else. An email the
 * business sends automatically (a confirmation, a reminder, an invoice, a campaign) has its look: the logo at the top,
 * links and buttons in its colour, and the layout picked in Settings → Email (core's look/email.ts, which Settings'
 * preview draws too). A campaign written in blocks passes them.
 */
export function renderEmailHtml(
  text: string,
  brand?: EmailBrand | null,
  blocks?: EmailBlocksDraw | null,
): string {
  return emailHtml(text, brand, blocks);
}

const omit = (attribs: Record<string, string>, ...names: string[]) =>
  Object.fromEntries(Object.entries(attribs).filter(([k]) => !names.includes(k)));

/**
 * Received HTML, safe to show: no scripts, forms, frames or event handlers; links open in a new tab;
 * remote images wait behind "Load images" (data-remote-src); `cid:` images point at our stored copies by
 * their place in the message's media list (data-hfos-media).
 */
export function sanitizeInboundHtml(html: string, cids: ReadonlyMap<string, number>): string {
  return sanitizeHtml(html, {
    allowedTags: [
      ...sanitizeHtml.defaults.allowedTags,
      'img',
      'span',
      'font',
      'center',
      'u',
      's',
      'small',
      'sup',
      'sub',
      'hr',
    ],
    allowedAttributes: {
      '*': ['style', 'align', 'valign', 'width', 'height', 'bgcolor', 'color', 'dir', 'title'],
      a: ['href', 'name', 'target', 'rel'],
      img: ['alt', 'width', 'height', 'data-remote-src', 'data-hfos-media'],
      td: ['colspan', 'rowspan'],
      th: ['colspan', 'rowspan'],
      table: ['border', 'cellpadding', 'cellspacing'],
      font: ['face', 'size', 'color'],
    },
    allowedSchemes: ['http', 'https', 'mailto', 'tel'],
    allowProtocolRelative: false,
    transformTags: {
      a: (tagName, attribs) => ({
        tagName,
        attribs: { ...attribs, target: '_blank', rel: 'noopener noreferrer nofollow' },
      }),
      img: (tagName, attribs) => {
        const src = (attribs['src'] ?? '').trim();
        const rest = omit(attribs, 'src');
        if (/^cid:/i.test(src)) {
          const index = cids.get(src.slice(4).replace(/^<|>$/g, ''));
          return {
            tagName,
            attribs: index === undefined ? rest : { ...rest, 'data-hfos-media': String(index) },
          };
        }
        if (/^https:\/\//i.test(src))
          return { tagName, attribs: { ...rest, 'data-remote-src': src } };
        return { tagName, attribs: rest };
      },
    },
  });
}

/** Plain text for mail that came only as HTML. */
export const htmlToText = (html: string): string =>
  convert(html, {
    wordwrap: false,
    selectors: [
      { selector: 'img', format: 'skip' },
      { selector: 'a', options: { ignoreHref: true } },
    ],
  }).trim();

export interface MailHeader {
  readonly Name: string;
  readonly Value: string;
}

export const headerOf = (headers: readonly MailHeader[], name: string): string | null =>
  headers.find((h) => h.Name.toLowerCase() === name.toLowerCase())?.Value?.trim() || null;

/** The `<id@host>` values in a Message-ID, In-Reply-To or References header. */
export const messageIds = (value: string | null): string[] =>
  (value?.match(/<[^<>\s]+>/g) ?? []).slice(-50);

/**
 * What the mail service's spam filter scored a message (Postmark's X-Spam-Score, from SpamAssassin), or null when it
 * didn't say. A stranger's mail at SPAM_SCORE or more goes to Spam (M19).
 */
export function spamScoreOf(headers: readonly MailHeader[]): number | null {
  const n = Number.parseFloat(headerOf(headers, 'X-Spam-Score') ?? '');
  return Number.isFinite(n) ? Math.max(-1000, Math.min(1000, n)) : null;
}

/**
 * Out-of-office replies, list and bulk mail never open or reopen a customer's conversation. A stranger's goes to
 * Other mail (M19).
 */
export function isAutomatic(headers: readonly MailHeader[]): boolean {
  const auto = headerOf(headers, 'Auto-Submitted');
  if (auto && auto.toLowerCase() !== 'no') return true;
  const precedence = headerOf(headers, 'Precedence')?.toLowerCase();
  if (precedence && ['bulk', 'list', 'junk', 'auto_reply'].includes(precedence)) return true;
  return !!(
    headerOf(headers, 'X-Autoreply') ||
    headerOf(headers, 'X-Autorespond') ||
    headerOf(headers, 'List-Id')
  );
}
