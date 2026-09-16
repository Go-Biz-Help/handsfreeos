/** The emails the worker sends the team (Mailpit locally, the production provider elsewhere). Plain and short. */
import { moneyLabel } from '@hfos/core/server';

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

/** "1 approval", "3 approvals", "2 businesses". */
const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const STOP_THESE = 'To stop these emails, open HandsFreeOS and go to Settings, then Account.';

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

// ---- The Action Center (M8) ----

/** What one urgent email is about: a lead nobody has got to, or a customer waiting for a reply. */
export interface AttentionUrgentInput {
  /** The item's kind: hot_lead, unanswered_lead, or customer_waiting (today's unanswered-message email). */
  readonly kind: 'hot_lead' | 'unanswered_lead' | 'customer_waiting';
  readonly customer: string;
  readonly firstName: string;
  readonly business: string;
  readonly minutesWaiting: number;
  /** The lead's own value in cents, never an estimate; null leaves the amount out. */
  readonly valueCents: number | null;
  /** Up to three reason chips in their own words ("ready to book", "qualified"). */
  readonly chips: readonly string[];
  /** The customer's last message, when there is one. */
  readonly preview: string;
  /** When they wrote, where the business is ("9:14 AM"). */
  readonly receivedAt: string;
  /** How to reach them: a number, an address, or "Website visitor". */
  readonly contact: string;
  readonly link: string;
  /** The button ("Reply to Maria", "Open in HandsFreeOS"). */
  readonly action: string;
  readonly assignedToYou: boolean;
  readonly photos?: number;
  readonly channel?: string;
}

/**
 * One email when something urgent is waiting: a hot lead, a new lead nobody answered, or (today's wording,
 * unchanged) a customer waiting for a reply. At most one per item.
 */
export function attentionUrgentEmail(input: AttentionUrgentInput): EmailContent {
  if (input.kind === 'customer_waiting')
    return unansweredEmail({
      customer: input.customer,
      firstName: input.firstName,
      business: input.business,
      minutesWaiting: input.minutesWaiting,
      preview: input.preview,
      receivedAt: input.receivedAt,
      contact: input.contact,
      link: input.link,
      assignedToYou: input.assignedToYou,
      photos: input.photos ?? 0,
      channel: input.channel,
    });
  const hot = input.kind === 'hot_lead';
  const subject = hot
    ? `Hot lead: ${input.customer} is waiting`
    : `New lead: ${input.customer} hasn’t heard back`;
  const worth = input.valueCents !== null ? `, a ${moneyLabel(input.valueCents)} lead,` : '';
  const opening = `${input.customer}${worth} has been waiting ${waited(input.minutesWaiting)}${
    hot ? ' and looks ready to go' : ' and nobody has reached out'
  }.`;
  const why = input.assignedToYou
    ? 'You’re getting this because the lead is assigned to you. We send one email per item.'
    : 'You’re getting this because you’re an owner or admin and nobody is assigned to it. We send one email per item.';
  const photos = input.photos ?? 0;
  const meta = [
    input.receivedAt,
    input.contact,
    photos > 0 ? `with ${photos === 1 ? '1 photo' : `${photos} photos`}` : '',
  ]
    .filter(Boolean)
    .join(' · ');
  const chips = input.chips.join(' · ');
  const text = [
    opening,
    '',
    chips,
    input.preview ? `“${input.preview}”` : '',
    meta,
    '',
    `${input.action}: ${input.link}`,
    '',
    why,
    STOP_THESE,
  ]
    .filter((l, i, all) => l !== '' || all[i - 1] !== '')
    .join('\n');
  const html = shell(
    preheader(chips || input.preview) +
      wordmark +
      `<p style="display: inline-block; margin: 0 0 12px; padding: 2px 8px; border-radius: 6px; background: #fde8e8; color: #b42318; font-size: 12px; font-weight: 700;">Urgent</p>` +
      `<p style="font-size: 15px; line-height: 1.5; margin: 0 0 12px;"><strong>${escapeHtml(input.customer)}</strong>${escapeHtml(
        worth,
      )} has been waiting ${escapeHtml(waited(input.minutesWaiting))}${escapeHtml(
        hot ? ' and looks ready to go' : ' and nobody has reached out',
      )}.</p>` +
      (chips
        ? `<p style="font-size: 12.5px; color: #5b616a; margin: 0 0 12px;">${escapeHtml(chips)}</p>`
        : '') +
      (input.preview
        ? `<div style="background: #f2f4f8; border-radius: 10px; padding: 14px 16px; font-size: 14px; line-height: 1.5; margin-bottom: 8px;">${escapeHtml(input.preview)}</div>`
        : '') +
      (meta
        ? `<p style="font-size: 12.5px; color: #5b616a; margin: 0 0 22px;">${escapeHtml(meta)}</p>`
        : '') +
      button(input.link, input.action) +
      small(escapeHtml(why)) +
      small(STOP_THESE),
  );
  return { subject, text, html };
}

/** One item in the morning summary. */
export interface MorningItem {
  /** Its kind in plain words ("Hot lead", "Not confirmed"). */
  readonly kind: string;
  /** "Maria Lopez · AC replacement". */
  readonly title: string;
  /** Up to three reason chips ("$18,500", "waiting 11 min", "qualified"). */
  readonly chips: readonly string[];
  readonly link: string;
}

/**
 * Once a day, at 7 AM where the business is: what needs this person's attention, urgent first. Only sent to
 * someone who has something waiting.
 */
export function attentionMorningEmail(input: {
  readonly business: string;
  readonly firstName: string;
  /** "$18,500 affected", in cents; 0 leaves the amount out. */
  readonly affectedCents: number;
  readonly urgent: readonly MorningItem[];
  /** The rest, ranked; the email lists the top few. */
  readonly rest: readonly MorningItem[];
  /** Everything open for this person, however many are listed. */
  readonly total: number;
  readonly homeLink: string;
  /** They see everyone's items (an owner or admin), not just their own. */
  readonly everyone: boolean;
}): EmailContent {
  const n = input.total;
  const urgent = input.urgent.length;
  const subject = `${count(n, 'thing')} need${n === 1 ? 's' : ''} your attention today${
    urgent > 0 ? `, ${urgent} urgent` : ''
  }`;
  const tally = [
    input.affectedCents > 0 ? `${moneyLabel(input.affectedCents)} affected` : '',
    `${count(n, 'thing')} to look at`,
    urgent > 0 ? `${urgent} urgent` : '',
  ]
    .filter(Boolean)
    .join(' · ');
  const hello = `Good morning${input.firstName ? `, ${input.firstName}` : ''}.`;
  const scope = input.everyone
    ? `Here’s what needs attention at ${input.business}.`
    : `Here’s what needs you at ${input.business}, plus anything nobody has taken.`;
  const line = (i: MorningItem) =>
    `${i.kind}: ${i.title}${i.chips.length ? ` (${i.chips.join(' · ')})` : ''}`;
  const why = `You’re getting this because Morning summary is on for your account.`;
  const section = (heading: string, items: readonly MorningItem[]) =>
    items.length ? [heading, ...items.map((i) => `- ${line(i)}: ${i.link}`), ''] : [];
  const text = [
    `${hello} ${scope}`,
    '',
    tally,
    '',
    ...section('Urgent', input.urgent),
    ...section(input.urgent.length ? 'Also today' : 'Today', input.rest),
    `Open the Action Center: ${input.homeLink}`,
    '',
    why,
    STOP_THESE,
  ].join('\n');
  const htmlItems = (items: readonly MorningItem[]) =>
    items
      .map(
        (i) =>
          `<li style="margin-bottom: 6px;"><a href="${escapeHtml(i.link)}" style="color: #2d69d8; text-decoration: none;">${escapeHtml(
            `${i.kind}: ${i.title}`,
          )}</a>${
            i.chips.length
              ? `<br /><span style="font-size: 12.5px; color: #5b616a;">${escapeHtml(i.chips.join(' · '))}</span>`
              : ''
          }</li>`,
      )
      .join('');
  const htmlSection = (heading: string, items: readonly MorningItem[]) =>
    items.length
      ? `<p style="font-size: 12.5px; font-weight: 600; color: #5b616a; margin: 18px 0 6px;">${escapeHtml(heading)}</p>` +
        `<ul style="margin: 0; padding-left: 18px; font-size: 14px; line-height: 1.5;">${htmlItems(items)}</ul>`
      : '';
  const html = shell(
    preheader(tally) +
      wordmark +
      para(`${escapeHtml(hello)} ${escapeHtml(scope)}`) +
      `<p style="font-size: 12.5px; color: #5b616a; margin: 0 0 4px;">${escapeHtml(tally)}</p>` +
      htmlSection('Urgent', input.urgent) +
      htmlSection(input.urgent.length ? 'Also today' : 'Today', input.rest) +
      button(input.homeLink, 'Open the Action Center') +
      small(escapeHtml(why)) +
      small(STOP_THESE),
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

const CONVERSATION_NOUN: Readonly<Record<string, string>> = {
  sms: 'a text conversation',
  email: 'an email conversation',
  chat: 'a website chat',
};

/** A labelled box: the teammate's note, the customer's last message, what was sent. */
const quoted = (label: string, body: string) =>
  `<p style="font-size: 12.5px; font-weight: 600; color: #5b616a; margin: 18px 0 6px;">${escapeHtml(label)}</p>` +
  `<div style="background: #f2f4f8; border-radius: 10px; padding: 14px 16px; font-size: 14px; line-height: 1.5; white-space: pre-wrap;">${escapeHtml(body)}</div>`;

/**
 * The AI teammate (or a workflow) handed a conversation to a person: to its assignee, or to the teammate's
 * hand-off list when nobody is assigned (users.settings.notifications.aiHandoff, on unless turned off).
 */
export function handoffEmail(input: {
  /** "Ava"; null when a workflow or HandsFreeOS itself handed it over. */
  teammate: string | null;
  channel: string;
  customer: string;
  firstName: string;
  /** When it was handed over: "10:25 AM". */
  at: string;
  note: string | null;
  lastMessage: { text: string; at: string } | null;
  link: string;
  assignedToYou: boolean;
}): EmailContent {
  const subject = `${input.customer} needs a person`;
  const noun = CONVERSATION_NOUN[input.channel] ?? 'a conversation';
  const to = input.assignedToYou ? 'you' : 'your team';
  const opening = input.teammate
    ? `${input.teammate} handed ${noun} to ${to} at ${input.at}.`
    : `${noun.charAt(0).toUpperCase()}${noun.slice(1)} was handed to ${to} at ${input.at}.`;
  const waiting = `${input.customer} is waiting for a reply.`;
  const noteLabel = input.teammate ? `${input.teammate}’s note` : 'The note';
  const lastLabel = input.lastMessage
    ? `${input.firstName}’s last message · ${input.lastMessage.at}`
    : '';
  const why =
    (input.assignedToYou
      ? 'You’re getting this because the conversation is assigned to you.'
      : 'You’re getting this because nobody is assigned to the conversation and you’re on the list for hand-offs.') +
    (input.teammate ? ` Replying takes it over from ${input.teammate}.` : '');
  const text = [
    `${opening} ${waiting}`,
    '',
    ...(input.note ? [`${noteLabel}:`, input.note, ''] : []),
    ...(input.lastMessage ? [`${lastLabel}:`, `“${input.lastMessage.text}”`, ''] : []),
    `Open the conversation: ${input.link}`,
    '',
    why,
    STOP_THESE,
  ].join('\n');
  const html = shell(
    preheader(input.note ?? input.lastMessage?.text ?? '') +
      wordmark +
      `<p style="font-size: 15px; line-height: 1.5; margin: 0;">${escapeHtml(opening)} <strong>${escapeHtml(input.customer)}</strong> is waiting for a reply.</p>` +
      (input.note ? quoted(noteLabel, input.note) : '') +
      (input.lastMessage ? quoted(lastLabel, input.lastMessage.text) : '') +
      button(input.link, 'Open the conversation') +
      small(escapeHtml(why)) +
      small(STOP_THESE),
  );
  return { subject, text, html };
}

/**
 * An emergency: sent marked urgent to the assignee and every owner and admin, whatever their settings. It says
 * what the customer wrote and the safety text they got, word for word.
 */
export function urgentHandoffEmail(input: {
  teammate: string | null;
  customer: string;
  firstName: string;
  /** "Kendra Lee texted at 9:52 PM on Sunday about a possible gas smell." */
  opening: string;
  /** "may smell gas" */
  subjectAbout: string;
  wrote: string | null;
  sent: string | null;
  link: string;
}): EmailContent {
  const subject = `Urgent: ${input.customer} ${input.subjectAbout}`;
  const who = input.teammate ?? 'The AI teammate';
  const after = input.sent
    ? `${who} sent the safety steps right away and stopped answering.`
    : `${who} stopped answering and handed it to your team.`;
  const sentLabel = `${who} sent, word for word`;
  const note = 'Emergencies go to every owner and admin, and this email can’t be turned off.';
  const text = [
    `${input.opening} ${after}`,
    '',
    ...(input.wrote ? [`${input.firstName} wrote:`, `“${input.wrote}”`, ''] : []),
    ...(input.sent ? [`${sentLabel}:`, `“${input.sent}”`, ''] : []),
    `Open the conversation: ${input.link}`,
    '',
    note,
  ].join('\n');
  const html = shell(
    preheader(input.wrote ?? '') +
      wordmark +
      `<p style="display: inline-block; margin: 0 0 12px; padding: 2px 8px; border-radius: 6px; background: #fde8e8; color: #b42318; font-size: 12px; font-weight: 700;">Urgent</p>` +
      `<p style="font-size: 15px; line-height: 1.5; margin: 0;">${escapeHtml(input.opening)} ${escapeHtml(after)}</p>` +
      (input.wrote ? quoted(`${input.firstName} wrote`, input.wrote) : '') +
      (input.sent ? quoted(sentLabel, input.sent) : '') +
      button(input.link, 'Open the conversation') +
      small(escapeHtml(note)),
  );
  return { subject, text, html };
}

/** Once a day, to the owners: the AI teammate used its share of the daily AI limit, so it stopped answering. */
export function teammateLimitEmail(input: {
  teammate: string;
  business: string;
  sharePercent: number;
  link: string;
}): EmailContent {
  const subject = `${input.teammate} reached its share of today’s AI limit`;
  const used = `${input.teammate} used its share of ${input.business}’s AI for today (${input.sharePercent}% of the daily limit), so it stopped answering.`;
  const meanwhile =
    'Until the limit resets at midnight, customers who write get your hand-off message once, and their conversations go to Needs a person.';
  const foot = `You can change its share in Limits. Sent once a day to the owners of ${input.business}.`;
  const text = [
    used,
    '',
    meanwhile,
    '',
    `Open ${input.teammate}’s settings: ${input.link}`,
    '',
    foot,
  ].join('\n');
  const html = shell(
    wordmark +
      para(escapeHtml(used)) +
      para(escapeHtml(meanwhile)) +
      button(input.link, `Open ${input.teammate}’s settings`) +
      small(escapeHtml(foot)),
  );
  return { subject, text, html };
}
