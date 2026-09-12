/** The emails the worker sends the team (Mailpit locally, the production provider elsewhere). Plain and short. */

export interface EmailContent {
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}

export function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}

const shell = (inner: string) =>
  `<div style="font-family: system-ui, -apple-system, 'Segoe UI', sans-serif; color: #191d25; max-width: 520px;">${inner}</div>`;
const para = (inner: string) => `<p style="font-size: 15px; line-height: 1.5;">${inner}</p>`;
const small = (inner: string) =>
  `<p style="font-size: 13px; color: #5b616a; line-height: 1.5;">${inner}</p>`;
const button = (href: string, label: string) =>
  `<p style="margin: 24px 0;"><a href="${escapeHtml(href)}" style="display: inline-block; background: #2d69d8; color: #ffffff; text-decoration: none; padding: 12px 18px; border-radius: 8px; font-weight: 600;">${escapeHtml(label)}</a></p>`;

const waited = (minutes: number) =>
  minutes >= 60
    ? `${Math.floor(minutes / 60)} h ${minutes % 60 ? `${minutes % 60} min` : ''}`.trim()
    : `${minutes} minutes`;

/** One reminder when a customer's message sits without a reply. */
export function unansweredEmail(input: {
  customer: string;
  firstName: string;
  business: string;
  minutesWaiting: number;
  preview: string;
  receivedAt: string;
  contact: string;
  link: string;
  assignedToYou: boolean;
}): EmailContent {
  const subject = `${input.customer} is waiting for a reply`;
  const why = input.assignedToYou
    ? 'You’re getting this because the conversation is assigned to you. We send one reminder per message.'
    : 'Nobody is assigned to this conversation, so every owner and admin gets this reminder.';
  const text = [
    `${input.customer} wrote to ${input.business} ${waited(input.minutesWaiting)} ago, and nobody has replied yet.`,
    '',
    input.preview ? `“${input.preview}”` : '',
    `${input.receivedAt} · ${input.contact}`,
    '',
    `Reply to ${input.firstName}: ${input.link}`,
    '',
    why,
    'To stop these emails, open HandsFreeOS and go to Settings, then Account.',
  ]
    .filter((l, i, all) => l !== '' || all[i - 1] !== '')
    .join('\n');
  const html = shell(
    para(
      `<strong>${escapeHtml(input.customer)}</strong> wrote to <strong>${escapeHtml(input.business)}</strong> ${escapeHtml(waited(input.minutesWaiting))} ago, and nobody has replied yet.`,
    ) +
      (input.preview
        ? `<div style="background: #f2f4f8; border-radius: 10px; padding: 14px 16px; font-size: 14px; line-height: 1.5;">${escapeHtml(input.preview)}</div>`
        : '') +
      `<p style="font-size: 12.5px; color: #5b616a;">${escapeHtml(input.receivedAt)} · ${escapeHtml(input.contact)}</p>` +
      button(input.link, `Reply to ${input.firstName}`) +
      small(escapeHtml(why)) +
      small('To stop these emails, open HandsFreeOS and go to Settings, then Account.'),
  );
  return { subject, text, html };
}

/** The carriers approved texting. */
export function textingApprovedEmail(input: {
  business: string;
  number: string;
  link: string;
}): EmailContent {
  const subject = `Texting is on for ${input.business}`;
  const text = `The carriers approved your registration. Customers can text ${input.number} now, and your team can text them back from the inbox.\n\nOpen the inbox: ${input.link}`;
  const html = shell(
    para(
      `The carriers approved your registration. Customers can text <strong>${escapeHtml(input.number)}</strong> now, and your team can text them back from the inbox.`,
    ) +
      button(input.link, 'Open the inbox') +
      small(`Sent to the owners and admins of ${escapeHtml(input.business)}.`),
  );
  return { subject, text, html };
}

/** The carriers turned the registration down. */
export function textingRejectedEmail(input: {
  business: string;
  reason: string | null;
  link: string;
}): EmailContent {
  const subject = `The carriers need a change before ${input.business} can text`;
  const reason = input.reason ? `Their reason: “${input.reason}”` : 'They did not give a reason.';
  const text = `The carriers turned down the texting registration for ${input.business}. ${reason}\n\nFix it and send it again: ${input.link}\n\nCalls keep working in the meantime.`;
  const html = shell(
    para(
      `The carriers turned down the texting registration for <strong>${escapeHtml(input.business)}</strong>.`,
    ) +
      para(escapeHtml(reason)) +
      button(input.link, 'Fix and send again') +
      small('Calls keep working in the meantime.'),
  );
  return { subject, text, html };
}
