import {
  answerWords,
  FORM_SOURCE_WORDS,
  publicFormPath,
  whenLabel,
  type AnswerInput,
} from '@hfos/core';

/**
 * What the phone says about a form's answers and its link (M17): the words, and the small sums that turn what the
 * API sends into a line on a screen. No React here, so the tests can read them straight.
 */
export const FORM_WORDS = {
  loading: 'Getting the answers…',
  needsSignal: 'Answers need a signal. Try again when you’re back online.',
  retry: 'Try again',
  showMore: 'Show more',
  none: 'Nobody has answered yet.',
  anonymous: 'Someone (anonymous)',
  linkNeedsSignal: 'The link needs a signal. Try again when you’re back online.',
  noSite:
    'This business has no link name yet, so the form has no address. Pick one on the web under Settings → Calendars → Booking site.',
  share: 'Share the link or QR code',
  shareNeedsSignal: 'Share the link or QR code — needs signal',
  linkWhat:
    'Hold up the QR code for them to scan, or send the link: text it, email it, put it in a signature. Save the QR code for a flyer, a truck door or the counter. They keep working if you rename the form.',
  saveQr: 'Save the QR code',
  delete: 'Delete these answers',
  deleteTitle: 'Delete these answers?',
  deleteWhat:
    'For a test of your own, or a customer asking to be forgotten. Every answer on this sheet goes, for good. Anything the form already did, like adding them as a customer, stays.',
  deleteConfirm: 'Delete',
  keep: 'Keep them',
  deleted: 'Deleted.',
  export: 'Export to CSV',
  exportNeedsSignalButton: 'Export to CSV — needs signal',
  exportTitle: 'Export the answers',
  exportNeedsSignal: 'Exporting needs a signal. Try again when you’re back online.',
  exportCapped: (most: number) =>
    `The newest ${most.toLocaleString('en-US')} answer sheets are in the file.`,
} as const;

/** One row of `form.response_list`, as much of it as the line needs. */
export interface ResponseLineInput {
  readonly completedAt: string | null;
  readonly startedAt: string;
  readonly scorePercent: number | null;
  readonly passed: boolean | null;
  readonly source: string;
}

/** "Thu, Sep 17 at 10:00 AM · 80% · passed · from the link", in the business's time zone. */
export function responseLine(response: ResponseLineInput, timeZone: string): string {
  return [
    response.completedAt
      ? whenLabel(Date.parse(response.completedAt), timeZone)
      : `Not finished · started ${whenLabel(Date.parse(response.startedAt), timeZone)}`,
    response.scorePercent !== null ? `${response.scorePercent}%` : null,
    response.passed === null ? null : response.passed ? 'passed' : 'not passed',
    FORM_SOURCE_WORDS[response.source] ?? null,
  ]
    .filter(Boolean)
    .join(' · ');
}

// An answer in words is core's, so the Assistant reads an answer sheet out as the phone shows it.
export { answerWords, type AnswerInput };

/** What `branded_domain.get` sends, as much as the link needs. */
export interface DomainInput {
  readonly domain: string;
  readonly status: string;
  readonly certificateReady: boolean;
}

/**
 * The form's public link: on the business's own domain once it is serving (as the web's Share tab shows it), else on
 * HandsFreeOS's own address. Null when the business has no link name yet, since there is no address to send.
 */
export function formLink(
  siteSlug: string | null,
  formSlug: string,
  domain: DomainInput | null,
  webUrl: string,
): string | null {
  if (!siteSlug || !formSlug) return null;
  const origin =
    domain && domain.status === 'verified' && domain.certificateReady
      ? `https://${domain.domain}`
      : webUrl;
  return `${origin}${publicFormPath(siteSlug, formSlug)}`;
}
