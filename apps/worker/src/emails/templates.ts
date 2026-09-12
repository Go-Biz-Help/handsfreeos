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
  `<div style="font-family: system-ui, -apple-system, 'Segoe UI', sans-serif; color: #191d25; background: #ffffff; max-width: 520px; padding: 32px 36px;">${inner}</div>`;
/** The line mail apps show next to the subject; hidden in the message itself. */
const preheader = (text: string) =>
  text
    ? `<div style="display: none; max-height: 0; overflow: hidden; opacity: 0;">${escapeHtml(text)}</div>`
    : '';
const wordmark = `<div style="margin-bottom: 20px; font-size: 14px; font-weight: 600;">HandsFree<span style="color: #2d69d8;">OS</span></div>`;
const para = (inner: string) => `<p style="font-size: 15px; line-height: 1.5;">${inner}</p>`;
const small = (inner: string) =>
  `<p style="font-size: 13px; color: #5b616a; line-height: 1.5;">${inner}</p>`;
const button = (href: string, label: string) =>
  `<p style="margin: 24px 0;"><a href="${escapeHtml(href)}" style="display: inline-block; background: #2d69d8; color: #ffffff; text-decoration: none; padding: 12px 18px; border-radius: 8px; font-weight: 600;">${escapeHtml(label)}</a></p>`;

const waited = (minutes: number) => {
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h} hour${h === 1 ? '' : 's'}${m ? ` ${m} minute${m === 1 ? '' : 's'}` : ''}`;
};

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
  /** Photos in the customer's latest message. */
  photos?: number;
}): EmailContent {
  const subject = `${input.customer} is waiting for a reply`;
  const why = input.assignedToYou
    ? 'You’re getting this because the conversation is assigned to you. We send one reminder per message.'
    : 'You’re getting this because you’re an owner or admin and nobody is assigned to the conversation. We send one reminder per message.';
  const photos = input.photos ?? 0;
  const meta = `${input.receivedAt} · ${input.contact}${photos > 0 ? ` · with ${photos === 1 ? '1 photo' : `${photos} photos`}` : ''}`;
  const text = [
    `${input.customer} texted ${input.business} ${waited(input.minutesWaiting)} ago, and nobody has replied yet.`,
    '',
    input.preview ? `“${input.preview}”` : '',
    meta,
    '',
    `Reply to ${input.firstName}: ${input.link}`,
    '',
    why,
    'To stop these emails, open HandsFreeOS and go to Settings, then Account.',
  ]
    .filter((l, i, all) => l !== '' || all[i - 1] !== '')
    .join('\n');
  const html = shell(
    preheader(input.preview) +
      wordmark +
      `<p style="font-size: 15px; line-height: 1.5; margin: 0 0 16px;"><strong>${escapeHtml(input.customer)}</strong> texted <strong>${escapeHtml(input.business)}</strong> ${escapeHtml(waited(input.minutesWaiting))} ago, and nobody has replied yet.</p>` +
      (input.preview
        ? `<div style="background: #f2f4f8; border-radius: 10px; padding: 14px 16px; font-size: 14px; line-height: 1.5; margin-bottom: 8px;">${escapeHtml(input.preview)}</div>`
        : '') +
      `<p style="font-size: 12.5px; color: #5b616a; margin: 0 0 22px;">${escapeHtml(meta)}</p>` +
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

/** A connected mailbox lost access: new mail with customers stops until someone reconnects it. */
export function mailboxReconnectEmail(input: {
  provider: 'microsoft' | 'google';
  account: string;
  lostAt: Date;
  timeZone: string;
  link: string;
}): EmailContent {
  const name = input.provider === 'google' ? 'Gmail' : 'Outlook';
  const when = input.lostAt.toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    timeZone: input.timeZone,
  });
  const subject = `Reconnect your ${name} mailbox`;
  const text = `HandsFreeOS lost access to ${input.account} on ${when}, so new email with customers isn’t reaching the inbox. Reconnecting takes a minute.\n\nReconnect ${name}: ${input.link}\n\nNothing was lost. Mail from the gap comes in once you reconnect.`;
  const html = shell(
    para(
      `HandsFreeOS lost access to <strong>${escapeHtml(input.account)}</strong> on ${escapeHtml(when)}, so new email with customers isn’t reaching the inbox. Reconnecting takes a minute.`,
    ) +
      button(input.link, `Reconnect ${name}`) +
      small('Nothing was lost. Mail from the gap comes in once you reconnect.'),
  );
  return { subject, text, html };
}
