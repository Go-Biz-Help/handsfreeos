import type {
  KnowledgeItemKind,
  KnowledgeItemSource,
  KnowledgeItemStatus,
  KnowledgeSuggestion,
} from '@/lib/api/types';

/**
 * Words and tints the Knowledge screens share. The AI and teal tints mix a fixed hue into the card and text
 * colours, the same mixes as the workflow chips (components/workflows/chips.tsx): the app has no tokens for
 * them yet, and these follow light and dark.
 */
export const AI_TINT =
  'bg-[color-mix(in_oklab,#7c3aed_13%,var(--card))] text-[color-mix(in_oklab,#7c3aed_72%,var(--text))]';
export const TEAL_TINT =
  'bg-[color-mix(in_oklab,#0e7490_13%,var(--card))] text-[color-mix(in_oklab,#0e7490_70%,var(--text))]';

export const KIND_LABEL: Record<KnowledgeItemKind, string> = {
  faq: 'FAQ',
  article: 'Article',
  fact: 'Fact',
  document: 'Document',
};
export const KIND_PLURAL: Record<KnowledgeItemKind, string> = {
  faq: 'FAQs',
  article: 'Articles',
  fact: 'Facts',
  document: 'Documents',
};
export const STATUS_LABEL: Record<KnowledgeItemStatus, string> = {
  draft: 'Draft',
  published: 'Published',
  archived: 'Archived',
};
export const SOURCE_LABEL: Record<KnowledgeItemSource, string> = {
  manual: 'Added by hand',
  website_scan: 'From your website',
  ai_suggestion: 'From a question the AI couldn’t answer',
  agency_pack: 'From a Go Biz Help pack',
};

/** An address without its scheme and trailing slash, for small print ("lonestarhvac.com/faq"). */
export function shortUrl(url: string): string {
  return url.replace(/^https?:\/\//i, '').replace(/\/$/, '') || url;
}

/** The path of an address on the scanned site ("/faq"), or the address when it can't be read. */
export function pagePath(url: string): string {
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}` || '/';
  } catch {
    return url;
  }
}

/** Where a suggestion came from, in a few words. */
export function suggestionFrom(s: KnowledgeSuggestion): string {
  const src = s.source as Record<string, unknown>;
  if (s.reason === 'scan')
    return typeof src.url === 'string' ? `From ${shortUrl(src.url)}` : 'From your website';
  if (s.reason === 'pack') return 'From a Go Biz Help starter pack';
  const via =
    src.via === 'try_it'
      ? 'Try it'
      : typeof src.threadId === 'string'
        ? 'the Assistant'
        : typeof src.runId === 'string'
          ? 'a workflow'
          : null;
  const times = s.similarCount > 1 ? ` · asked ${s.similarCount} times` : '';
  return `${via ? `Asked in ${via}` : 'A question the AI couldn’t answer'}${times}`;
}

/** One problem a website scan ran into, in plain words. */
export function scanProblemText(p: { readonly code: string; readonly message: string }): string {
  switch (p.code) {
    case 'blocked_address':
      return p.message.includes('points to')
        ? p.message
        : 'It points to a private address, so it wasn’t read.';
    case 'other_host':
      return 'It sends visitors to another website, so it wasn’t read.';
    case 'timeout':
      return 'It took too long to answer.';
    case 'network':
      return 'It couldn’t be reached.';
    case 'too_many_redirects':
      return 'It redirected too many times.';
    case 'not_https':
      return 'It isn’t a secure (https) address.';
    case 'http_404':
    case 'http_410':
      return 'The page wasn’t found.';
    default:
      return /^http_\d{3}$/.test(p.code)
        ? `The page answered with an error (${p.code.slice(5)}).`
        : p.message;
  }
}
