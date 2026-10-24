/**
 * Indeed by email (funnels): Indeed has no general way to send applicants to another app, but it emails the employer
 * for each one. An inbox HandsFreeOS already reads (a connected Gmail or Outlook, a hosted address, or one Indeed's
 * mail is forwarded to) brings that email here, and the applicant becomes a customer and a lead under Lead intake's
 * "Indeed" row.
 *
 * This file says which emails are Indeed's, which of those are about somebody applying, and what can be read from
 * one without the AI: the applicant's address (Indeed's relay, which reaches them), a phone, and the name and job
 * when the subject says them. The worker asks the AI first and falls back on this. Pure, and browser-safe.
 */
import { normalizePhone } from './phone';

/** Indeed's own domains and their mail subdomains: indeed.com, indeedemail.com, indeed.co.uk, mail.indeed.com … */
const INDEED_DOMAIN = /(^|\.)indeed(email|mail)?\.(com|co\.[a-z]{2}|com\.[a-z]{2}|[a-z]{2})$/i;

/** Whether an address is one of Indeed's. */
export function isIndeedAddress(address: string): boolean {
  const domain = address.split('@')[1]?.trim().toLowerCase() ?? '';
  return INDEED_DOMAIN.test(domain);
}

/** Indeed's relay for one applicant (`…@indeedemail.com`): mail to it reaches them. */
const isRelay = (address: string): boolean => /@indeedemail\.com$/i.test(address.trim());

/** Indeed itself writing, not an applicant through its relay: a machine, never a customer by itself. */
export const isIndeedMachine = (address: string): boolean =>
  isIndeedAddress(address) && !isRelay(address);

/** Subjects Indeed uses for somebody applying; its others (a job going live, an invoice, a summary) don't match. */
const APPLICANT_SUBJECT =
  /\b(new (job )?applica(nt|tion)s?|applied (to|for)|applica(nt|tion) (for|from|to)|new candidate|candidate (for|applied))\b/i;
const NOT_AN_APPLICANT =
  /\b(invoice|receipt|payment|budget|sponsor(ed)?|expir(e|es|ed|ing)|summary|digest|performance|report|your job (is|has)|post(ed|ing) (is|has)|password|verify|security)\b/i;

/** Whether an email is Indeed telling the business about somebody who applied. */
export function isIndeedApplicantEmail(e: {
  readonly from: { readonly address: string };
  readonly subject?: string | null;
}): boolean {
  if (!isIndeedAddress(e.from.address)) return false;
  const subject = (e.subject ?? '').trim();
  return APPLICANT_SUBJECT.test(subject) && !NOT_AN_APPLICANT.test(subject);
}

/** What an applicant email says about who applied. Every part may be missing. */
export interface IndeedApplicant {
  readonly name: string | null;
  readonly email: string | null;
  readonly phone: string | null;
  readonly job: string | null;
  readonly location: string | null;
}

const EMAILS = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const PHONES = /(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g;
const NOREPLY =
  /^(no[-_.]?reply|do[-_.]?not[-_.]?reply|alert|alerts|notifications?|support|help)@/i;

/** Indeed's usual subjects, and which part is the name and which the job. */
const SUBJECT_SHAPES: readonly (readonly [RegExp, 'name_job' | 'job_name'])[] = [
  // "Jordan Reyes applied to Sales Associate", "Jordan Reyes applied for your Sales Associate job"
  [
    /^(?:new application:?\s*)?(.+?)\s+applied\s+(?:to|for)\s+(?:your\s+)?(.+?)(?:\s+job)?$/i,
    'name_job',
  ],
  // "Application for Sales Associate from Jordan Reyes"
  [/^(?:new )?application (?:for|to)\s+(.+?)\s+from\s+(.+)$/i, 'job_name'],
  // "New application: Sales Associate - Jordan Reyes"
  [/^new (?:application|applicant):?\s*(.+?)\s+[-–—|]\s+(.+)$/i, 'job_name'],
];

const clean = (s: string | null | undefined, max: number): string | null => {
  const t = (s ?? '').replace(/\s+/g, ' ').trim();
  return t ? t.slice(0, max) : null;
};

/**
 * What can be read without the AI. The applicant's address is Indeed's relay (`…@indeedemail.com`) when there is
 * one, else any address that isn't Indeed's own or the business's; the subject names them in Indeed's usual shapes.
 */
export function readIndeedApplicant(e: {
  readonly from?: { readonly address: string; readonly name?: string | null };
  readonly subject?: string | null;
  readonly bodyText?: string | null;
  /** The business's own addresses, never the applicant's. */
  readonly ours?: readonly string[];
}): IndeedApplicant {
  const subject = clean(e.subject, 400) ?? '';
  const body = (e.bodyText ?? '').slice(0, 20_000);
  const ours = new Set((e.ours ?? []).map((a) => a.toLowerCase()));
  // Indeed sometimes writes from the applicant's own relay, under their name.
  const relay = e.from && isRelay(e.from.address) ? e.from.address.toLowerCase() : null;
  const addresses = [...new Set((body.match(EMAILS) ?? []).map((a) => a.toLowerCase()))].filter(
    (a) => !ours.has(a) && !NOREPLY.test(a),
  );
  const email =
    relay ?? addresses.find(isRelay) ?? addresses.find((a) => !isIndeedAddress(a)) ?? null;
  const phone = (body.match(PHONES) ?? []).map((p) => normalizePhone(p)).find(Boolean) ?? null;

  let name: string | null = null;
  let job: string | null = null;
  for (const [shape, order] of SUBJECT_SHAPES) {
    const m = shape.exec(subject);
    if (!m) continue;
    [name, job] = order === 'name_job' ? [m[1]!, m[2]!] : [m[2]!, m[1]!];
    break;
  }
  if (!name && relay && e.from?.name && !/indeed/i.test(e.from.name)) name = e.from.name;
  return {
    name: clean(name, 160),
    email,
    phone,
    job: clean(job?.replace(/^(the|a|an)\s+/i, ''), 160),
    location: null,
  };
}

/** How the lead reads on the board: "Jordan Reyes (Indeed: Sales Associate)". */
export function indeedLeadTitle(a: Pick<IndeedApplicant, 'name' | 'job'>, who: string): string {
  return `${who} (${a.job ? `Indeed: ${a.job}` : 'Indeed'})`.slice(0, 160);
}
