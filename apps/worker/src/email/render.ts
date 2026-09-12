/**
 * Email content: the HTML for what people typed, and received HTML made safe to show (sanitized here; the
 * browser also renders it in a sandboxed frame with remote images off until someone asks for them).
 */
import { convert } from 'html-to-text';
import sanitizeHtml from 'sanitize-html';

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const linkify = (escaped: string) =>
  escaped.replace(
    /\bhttps?:\/\/[^\s<]+[^\s<.,;:!?)]/g,
    (url) => `<a href="${url}" style="color:#2f5bd3">${url}</a>`,
  );

/** What people type is plain text: paragraphs and line breaks, links made clickable, nothing else. */
export function renderEmailHtml(text: string): string {
  const paragraphs = text
    .trim()
    .split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 12px">${linkify(escapeHtml(p)).replace(/\n/g, '<br>')}</p>`)
    .join('');
  return (
    '<!doctype html><html><body style="margin:0;padding:16px;font-family:-apple-system,BlinkMacSystemFont,' +
    `'Segoe UI',Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5;color:#191d25">${paragraphs}</body></html>`
  );
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

/** Out-of-office replies, list and bulk mail never open or reopen a conversation. */
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
