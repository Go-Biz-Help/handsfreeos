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
  /** How they wrote: a text (the default), an email, or the website chat. */
  channel?: string;
}): EmailContent {
  const subject = `${input.customer} is waiting for a reply`;
  const wrote =
    input.channel === 'chat'
      ? { text: 'wrote to', after: ' in the website chat' }
      : input.channel === 'email'
        ? { text: 'emailed', after: '' }
        : { text: 'texted', after: '' };
  const why = input.assignedToYou
    ? 'You’re getting this because the conversation is assigned to you. We send one reminder per message.'
    : 'You’re getting this because you’re an owner or admin and nobody is assigned to the conversation. We send one reminder per message.';
  const photos = input.photos ?? 0;
  const meta = `${input.receivedAt} · ${input.contact}${photos > 0 ? ` · with ${photos === 1 ? '1 photo' : `${photos} photos`}` : ''}`;
  const text = [
    `${input.customer} ${wrote.text} ${input.business}${wrote.after} ${waited(input.minutesWaiting)} ago, and nobody has replied yet.`,
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
      `<p style="font-size: 15px; line-height: 1.5; margin: 0 0 16px;"><strong>${escapeHtml(input.customer)}</strong> ${wrote.text} <strong>${escapeHtml(input.business)}</strong>${escapeHtml(wrote.after)} ${escapeHtml(waited(input.minutesWaiting))} ago, and nobody has replied yet.</p>` +
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

/** The business's own domain passed both checks: addresses on it can send. */
export function emailDomainVerifiedEmail(input: {
  business: string;
  domain: string;
  link: string;
}): EmailContent {
  const subject = `${input.domain} is verified`;
  const text = `The DNS records for ${input.domain} check out, so ${input.business} can send email from addresses on it. Add one, or make one the default, in Settings → Email.\n\nOpen Settings → Email: ${input.link}`;
  const html = shell(
    para(
      `The DNS records for <strong>${escapeHtml(input.domain)}</strong> check out, so ${escapeHtml(input.business)} can send email from addresses on it. Add one, or make one the default, in Settings → Email.`,
    ) +
      button(input.link, 'Open Settings → Email') +
      small(`Sent to the owners and admins of ${escapeHtml(input.business)}.`),
  );
  return { subject, text, html };
}

/** A verified domain's records stopped verifying: its mail goes out from the shared address until they're back. */
export function emailDomainLapsedEmail(input: {
  business: string;
  domain: string;
  /** "DKIM record", "Return-Path record" or "DKIM and Return-Path records". */
  records: string;
  sharedAddress: string;
  link: string;
}): EmailContent {
  const subject = `${input.domain} stopped verifying`;
  const them = input.records.endsWith('records') ? 'the records' : 'the record';
  const text = `The ${input.records} for ${input.domain} stopped verifying, so email from ${input.business} now goes out from ${input.sharedAddress} until the records are fixed. Put ${them} back at your DNS provider, then press Check now in Settings → Email.\n\nOpen Settings → Email: ${input.link}\n\nCustomers’ replies still reach the inbox.`;
  const html = shell(
    para(
      `The ${escapeHtml(input.records)} for <strong>${escapeHtml(input.domain)}</strong> stopped verifying, so email from ${escapeHtml(input.business)} now goes out from <strong>${escapeHtml(input.sharedAddress)}</strong> until the records are fixed.`,
    ) +
      para(`Put ${them} back at your DNS provider, then press Check now in Settings → Email.`) +
      button(input.link, 'Open Settings → Email') +
      small('Customers’ replies still reach the inbox.'),
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

const detailRow = (label: string, value: string) =>
  `<tr><td style="padding: 6px 0; color: #676c75; width: 52px; vertical-align: top; border-top: 1px solid #e4e8ee;">${escapeHtml(label)}</td><td style="padding: 6px 0; border-top: 1px solid #e4e8ee;">${escapeHtml(value)}</td></tr>`;

/** A customer booked or cancelled online: one email to each person on the appointment. */
export function teamBookingEmail(input: {
  about: 'booked' | 'cancelled';
  customer: string;
  /** "booked an AC tune-up with you online", "cancelled their AC tune-up online". */
  sentence: string;
  title: string;
  /** "Fri 1:00 PM" */
  whenShort: string;
  /** "Fri, Sep 18, 1:00–2:00 PM Central Time" */
  when: string;
  where: string | null;
  /** "(713) 555-0188 · texts OK" */
  phone: string | null;
  email: string | null;
  reason: string | null;
  link: string;
}): EmailContent {
  const subject = `${input.about === 'booked' ? 'New booking' : 'Cancelled'}: ${input.customer}, ${input.title}, ${input.whenShort}`;
  const rows: [string, string | null][] = [
    ['When', input.when],
    ['Where', input.where],
    ['Phone', input.phone],
    ['Email', input.phone ? null : input.email],
    ['Why', input.reason],
  ];
  const shown = rows.filter((r): r is [string, string] => !!r[1]);
  const off = 'Turn these off in Settings, then Account.';
  const text = [
    `${input.customer} ${input.sentence}.`,
    '',
    ...shown.map(([k, v]) => `${k}: ${v}`),
    '',
    `Open in HandsFreeOS: ${input.link}`,
    '',
    off,
  ].join('\n');
  const html = shell(
    wordmark +
      `<p style="font-size: 15px; line-height: 1.5; margin: 0 0 12px;"><strong>${escapeHtml(input.customer)}</strong> ${escapeHtml(input.sentence)}.</p>` +
      `<table style="width: 100%; border-collapse: collapse; font-size: 13px; margin: 0 0 14px;">${shown.map(([k, v]) => detailRow(k, v)).join('')}</table>` +
      button(input.link, 'Open in HandsFreeOS') +
      small(off),
  );
  return { subject, text, html };
}

/** A connected calendar lost access: one email to the person whose calendar it is. */
export function calendarReconnectEmail(input: {
  provider: 'microsoft' | 'google';
  account: string;
  lostAt: Date;
  timeZone: string;
  link: string;
}): EmailContent {
  const name = input.provider === 'google' ? 'Google Calendar' : 'Outlook calendar';
  const when = input.lostAt.toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    timeZone: input.timeZone,
  });
  const subject = 'Reconnect your calendar';
  const lost = (account: string) =>
    `HandsFreeOS lost access to your ${name} (${account}) on ${when}. Until you reconnect it, the times you’re busy there don’t block bookings, and new appointments aren’t added to it. Reconnecting takes a minute.`;
  const text = `${lost(input.account)}\n\nReconnect your calendar: ${input.link}\n\nNothing was lost. Your appointments are all still in HandsFreeOS.`;
  const html = shell(
    para(lost(`<strong>${escapeHtml(input.account)}</strong>`)) +
      button(input.link, 'Reconnect your calendar') +
      small('Nothing was lost. Your appointments are all still in HandsFreeOS.'),
  );
  return { subject, text, html };
}

/** One business in the daily agency digest: what needs a look there, each with where to look. */
export interface DigestBusiness {
  readonly name: string;
  /** The business in HandsFreeOS. */
  readonly link: string;
  /** Runs that failed in the last 24 hours. */
  readonly failedRuns: { readonly count: number; readonly link: string } | null;
  readonly approvals: {
    readonly count: number;
    /** How long the oldest has waited. */
    readonly oldestMinutes: number;
    readonly link: string;
  } | null;
  readonly paused: { readonly names: readonly string[]; readonly link: string } | null;
  /** Agency templates with a newer version than the business has. */
  readonly updates: { readonly names: readonly string[]; readonly link: string } | null;
  readonly suggestions: { readonly count: number; readonly link: string } | null;
}

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "25 minutes", "5 hours", "3 days". */
const waitedFor = (minutes: number) => {
  if (minutes < 60) return count(Math.max(1, minutes), 'minute');
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? count(hours, 'hour') : count(Math.floor(hours / 24), 'day');
};

/** "Estimate follow-up", "A and B", "A, B, C and 2 more". */
const names = (list: readonly string[]) => {
  const shown = list.slice(0, 3);
  const more = list.length - shown.length;
  if (more > 0) return `${shown.join(', ')} and ${more} more`;
  return shown.length <= 1
    ? shown.join('')
    : `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}`;
};

function digestLines(b: DigestBusiness): { text: string; link: string }[] {
  const lines: { text: string; link: string }[] = [];
  if (b.failedRuns)
    lines.push({
      text: `${count(b.failedRuns.count, 'workflow run')} failed in the last 24 hours`,
      link: b.failedRuns.link,
    });
  if (b.approvals)
    lines.push({
      text:
        b.approvals.count === 1
          ? `1 approval waiting, for ${waitedFor(b.approvals.oldestMinutes)}`
          : `${b.approvals.count} approvals waiting, the oldest for ${waitedFor(b.approvals.oldestMinutes)}`,
      link: b.approvals.link,
    });
  if (b.paused) lines.push({ text: `Paused: ${names(b.paused.names)}`, link: b.paused.link });
  if (b.updates)
    lines.push({ text: `Update available: ${names(b.updates.names)}`, link: b.updates.link });
  if (b.suggestions)
    lines.push({
      text: `${count(b.suggestions.count, 'knowledge suggestion')} waiting`,
      link: b.suggestions.link,
    });
  return lines;
}

/** Once a day: an organization's businesses that need a look, for one of its owners or admins. */
export function agencyDigestEmail(input: {
  organization: string;
  businesses: readonly DigestBusiness[];
  /** The organization's agency area. */
  agencyLink: string;
}): EmailContent {
  const n = input.businesses.length;
  const subject = `${input.organization}: ${count(n, 'business', 'businesses')} need${n === 1 ? 's' : ''} a look today`;
  const sum = (pick: (b: DigestBusiness) => number) =>
    input.businesses.reduce((total, b) => total + pick(b), 0);
  const summary = [
    [sum((b) => b.failedRuns?.count ?? 0), 'failed run'],
    [sum((b) => b.approvals?.count ?? 0), 'approval waiting', 'approvals waiting'],
    [sum((b) => b.paused?.names.length ?? 0), 'paused workflow'],
    [sum((b) => b.updates?.names.length ?? 0), 'update available', 'updates available'],
  ] as const;
  const preview = summary
    .filter(([total]) => total > 0)
    .map(([total, one, many]) => count(total, one, many))
    .join(', ');
  const intro = `Here’s what needs a look today across ${input.organization}.`;
  const why = `You get this because you’re an owner or admin of ${input.organization}. Businesses where you’re an owner or admin yourself are left out, since you hear about those as it happens.`;
  const stop = 'To stop these emails, open HandsFreeOS and go to Settings, then Account.';
  const text = [
    intro,
    '',
    ...input.businesses.flatMap((b) => [
      b.name,
      ...digestLines(b).map((l) => `- ${l.text}: ${l.link}`),
      `Open ${b.name}: ${b.link}`,
      '',
    ]),
    `Open the agency area: ${input.agencyLink}`,
    '',
    why,
    stop,
  ].join('\n');
  const link = (href: string, label: string, color = '#2d69d8') =>
    `<a href="${escapeHtml(href)}" style="color: ${color}; text-decoration: none;">${escapeHtml(label)}</a>`;
  const block = (b: DigestBusiness) =>
    `<div style="border-top: 1px solid #e4e8ee; padding: 14px 0 6px;">` +
    `<p style="font-size: 15px; font-weight: 600; line-height: 1.4; margin: 0 0 6px;">${link(b.link, b.name, '#191d25')}</p>` +
    `<ul style="margin: 0 0 8px; padding-left: 18px; font-size: 14px; line-height: 1.6;">${digestLines(
      b,
    )
      .map((l) => `<li>${link(l.link, l.text)}</li>`)
      .join('')}</ul></div>`;
  const html = shell(
    preheader(preview) +
      wordmark +
      para(escapeHtml(intro)) +
      input.businesses.map(block).join('') +
      button(input.agencyLink, 'Open the agency area') +
      small(escapeHtml(why)) +
      small(stop),
  );
  return { subject, text, html };
}
