/**
 * Emails the engine sends the team through the worker's mailer: an approval is waiting, a run failed, a
 * workflow's "Notify the team" step, and a "Send to me" test's texts and emails. Plain and short, in the same
 * shape as the worker's other team emails.
 */
import { escapeHtml, type EmailContent } from '../emails/templates';

const shell = (inner: string) =>
  `<div style="font-family: system-ui, -apple-system, 'Segoe UI', sans-serif; color: #191d25; background: #ffffff; max-width: 520px; padding: 32px 36px;">${inner}</div>`;
const wordmark = `<div style="margin-bottom: 20px; font-size: 14px; font-weight: 600;">HandsFree<span style="color: #2d69d8;">OS</span></div>`;
const para = (text: string) =>
  `<p style="font-size: 15px; line-height: 1.5;">${escapeHtml(text).replace(/\n/g, '<br>')}</p>`;
const quote = (text: string) =>
  `<blockquote style="margin: 16px 0; padding: 12px 16px; border-left: 3px solid #d7dbe0; color: #3b4048; font-size: 15px; line-height: 1.5;">${escapeHtml(text).replace(/\n/g, '<br>')}</blockquote>`;
const small = (text: string) =>
  `<p style="font-size: 13px; color: #5b616a; line-height: 1.5;">${escapeHtml(text)}</p>`;
const button = (href: string, label: string) =>
  `<p style="margin: 24px 0;"><a href="${escapeHtml(href)}" style="display: inline-block; background: #2d69d8; color: #ffffff; text-decoration: none; padding: 12px 18px; border-radius: 8px; font-weight: 600;">${escapeHtml(label)}</a></p>`;

/** An approval step is waiting for a decision. */
export function approvalRequestEmail(input: {
  workflow: string;
  customer: string | null;
  message: string;
  preview: string | null;
  expiresAt: string | null;
  link: string;
}): EmailContent {
  const who = input.customer ? ` for ${input.customer}` : '';
  const subject = `Approval needed: ${input.workflow}${who}`;
  const lines = [
    `The workflow “${input.workflow}” is waiting for your OK before it goes on${who}.`,
    input.message,
  ].filter(Boolean);
  const expires = input.expiresAt
    ? `If nobody decides by ${input.expiresAt}, it follows the step’s setting.`
    : '';
  return {
    subject,
    text: [
      ...lines,
      '',
      input.preview ? `What goes out:\n${input.preview}` : '',
      '',
      `Approve or reject it: ${input.link}`,
      expires,
    ]
      .filter((l, i, all) => l !== '' || all[i - 1] !== '')
      .join('\n'),
    html: shell(
      [
        wordmark,
        ...lines.map(para),
        input.preview ? quote(input.preview) : '',
        button(input.link, 'Review it'),
        expires ? small(expires) : '',
      ].join(''),
    ),
  };
}

/** A run stopped on a step that kept failing. */
export function runFailedEmail(input: {
  workflow: string;
  customer: string | null;
  step: string;
  error: string;
  link: string;
}): EmailContent {
  const who = input.customer ? ` for ${input.customer}` : '';
  const subject = `A workflow stopped: ${input.workflow}${who}`;
  const intro = `“${input.workflow}” couldn’t finish the step “${input.step}”${who} after several tries, so the run stopped there.`;
  const next = 'Open the run to try the step again or skip it.';
  return {
    subject,
    text: [intro, '', `What went wrong: ${input.error}`, '', `${next} ${input.link}`].join('\n'),
    html: shell(
      [
        wordmark,
        para(intro),
        quote(input.error),
        para(next),
        button(input.link, 'Open the run'),
      ].join(''),
    ),
  };
}

/** A workflow's "Notify the team" step. */
export function notifyTeamEmail(input: {
  workflow: string;
  business: string;
  message: string;
  link: string | null;
}): EmailContent {
  const subject = `${input.workflow}: ${input.message.split('\n')[0]!.slice(0, 120)}`;
  const footer = `Sent by the workflow “${input.workflow}” at ${input.business}.`;
  return {
    subject,
    text: [input.message, '', input.link ? `Open it: ${input.link}` : '', footer]
      .filter(Boolean)
      .join('\n'),
    html: shell(
      [
        wordmark,
        para(input.message),
        input.link ? button(input.link, 'Open it') : '',
        small(footer),
      ].join(''),
    ),
  };
}

/** "Send to me": what the customer would get, delivered to the person testing instead. */
export function testMessageEmail(input: {
  workflow: string;
  channel: 'sms' | 'email';
  subject: string | null;
  body: string;
}): EmailContent {
  const what = input.channel === 'sms' ? 'text' : 'email';
  const subject = `[Test] ${input.subject ?? `A ${what} from “${input.workflow}”`}`;
  const intro = `This is a test of “${input.workflow}”. A customer would get this ${what}:`;
  return {
    subject,
    text: [intro, '', input.body].join('\n'),
    html: shell([wordmark, para(intro), quote(input.body)].join('')),
  };
}
