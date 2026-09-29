/** The emails the worker sends the team (Mailpit locally, the production provider elsewhere). Plain and short. */
import {
  IDEA_STATUS_MEANING,
  ideaUpdateHeadline,
  moneyLabel,
  PAYMENT_METHOD_WORDS,
  type IdeaStatus,
  type PaymentMethod,
} from '@hfos/core/server';

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

/** One visit on today's list: "9:00 AM · Maria Lopez · AC tune-up". */
export interface MorningJob {
  readonly time: string;
  readonly customers: string;
  readonly title: string;
  /** The customer hasn't confirmed it. */
  readonly unconfirmed: boolean;
  readonly link: string;
}

/**
 * Once a day, at 7 AM where the business is (Automations' "Morning brief"): today's jobs, who to call, and
 * whatever else needs this person, urgent first. Only sent to someone who has something.
 */
export function attentionMorningEmail(input: {
  readonly business: string;
  readonly firstName: string;
  /** "$18,500 affected", in cents; 0 leaves the amount out. */
  readonly affectedCents: number;
  /** Today's visits, earliest first. */
  readonly jobs?: readonly MorningJob[];
  /** Who to call today: follow-ups due, hot leads, quotes waiting, visits not confirmed. */
  readonly call?: readonly MorningItem[];
  readonly urgent: readonly MorningItem[];
  /** The rest, ranked; the email lists the top few. */
  readonly rest: readonly MorningItem[];
  /** Everything open for this person, however many are listed. */
  readonly total: number;
  readonly homeLink: string;
  /** They see everyone's items (an owner or admin), not just their own. */
  readonly everyone: boolean;
}): EmailContent {
  const jobs = input.jobs ?? [];
  const call = input.call ?? [];
  const n = input.total;
  const urgent = input.urgent.length;
  const subject = [
    jobs.length ? `${count(jobs.length, 'job')} today` : '',
    call.length ? `${count(call.length, 'call')} to make` : '',
    n > 0 ? `${count(n, 'thing')} need${n === 1 ? 's' : ''} your attention today` : '',
    urgent > 0 ? `${urgent} urgent` : '',
  ]
    .filter(Boolean)
    .join(', ');
  const tally = [
    input.affectedCents > 0 ? `${moneyLabel(input.affectedCents)} affected` : '',
    jobs.length ? count(jobs.length, 'job') : '',
    n > 0 ? `${count(n, 'thing')} to look at` : '',
    urgent > 0 ? `${urgent} urgent` : '',
  ]
    .filter(Boolean)
    .join(' · ');
  const hello = `Good morning${input.firstName ? `, ${input.firstName}` : ''}.`;
  const scope = input.everyone
    ? `Here’s the day at ${input.business}.`
    : `Here’s your day at ${input.business}, plus anything nobody has taken.`;
  const line = (i: MorningItem) =>
    `${i.kind}: ${i.title}${i.chips.length ? ` (${i.chips.join(' · ')})` : ''}`;
  const jobLine = (j: MorningJob) =>
    `${j.time} · ${j.customers} · ${j.title}${j.unconfirmed ? ' (not confirmed)' : ''}`;
  const why = `You’re getting this because Morning summary is on for your account.`;
  const section = (heading: string, items: readonly MorningItem[]) =>
    items.length ? [heading, ...items.map((i) => `- ${line(i)}: ${i.link}`), ''] : [];
  const text = [
    `${hello} ${scope}`,
    '',
    tally,
    '',
    ...(jobs.length ? ['Today’s jobs', ...jobs.map((j) => `- ${jobLine(j)}: ${j.link}`), ''] : []),
    ...section('Who to call today', call),
    ...section('Urgent', input.urgent),
    ...section(input.urgent.length ? 'Also needs you' : 'Needs you', input.rest),
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
  const heading = (h: string) =>
    `<p style="font-size: 12.5px; font-weight: 600; color: #5b616a; margin: 18px 0 6px;">${escapeHtml(h)}</p>`;
  const list = (inner: string) =>
    `<ul style="margin: 0; padding-left: 18px; font-size: 14px; line-height: 1.5;">${inner}</ul>`;
  const htmlSection = (h: string, items: readonly MorningItem[]) =>
    items.length ? heading(h) + list(htmlItems(items)) : '';
  const htmlJobs = jobs.length
    ? heading('Today’s jobs') +
      list(
        jobs
          .map(
            (j) =>
              `<li style="margin-bottom: 6px;"><a href="${escapeHtml(j.link)}" style="color: #2d69d8; text-decoration: none;">${escapeHtml(
                `${j.time} · ${j.customers}`,
              )}</a> · ${escapeHtml(j.title)}${
                j.unconfirmed
                  ? ' <span style="font-size: 12.5px; color: #b45309;">not confirmed</span>'
                  : ''
              }</li>`,
          )
          .join(''),
      )
    : '';
  const html = shell(
    preheader(tally) +
      wordmark +
      para(`${escapeHtml(hello)} ${escapeHtml(scope)}`) +
      `<p style="font-size: 12.5px; color: #5b616a; margin: 0 0 4px;">${escapeHtml(tally)}</p>` +
      htmlJobs +
      htmlSection('Who to call today', call) +
      htmlSection('Urgent', input.urgent) +
      htmlSection(input.urgent.length ? 'Also needs you' : 'Needs you', input.rest) +
      button(input.homeLink, 'Open the Action Center') +
      small(escapeHtml(why)) +
      small(STOP_THESE),
  );
  return { subject: subject || 'Your day', text, html };
}

/** The day in numbers, as the evening email counts it. */
export interface EveningNumbers {
  readonly newLeads: number;
  readonly leadsReached: number;
  readonly jobsBooked: number;
  readonly jobsDone: number;
  readonly noShows: number;
  readonly paidCents: number;
  readonly payments: number;
  readonly invoicesSent: number;
  readonly estimatesSent: number;
  /** Null: no AI teammate, so no AI line. */
  readonly ai: { readonly answered: number; readonly draftsWaiting: number } | null;
}

/**
 * At the end of the day (Automations' "End-of-day email", 6 PM by default), to owners and admins: what's still
 * open, today's jobs nobody marked done, and the day in numbers.
 */
export function eveningBriefEmail(input: {
  readonly business: string;
  readonly firstName: string;
  readonly numbers: EveningNumbers;
  /** Today's visits whose time has passed and nobody marked done or a no-show. */
  readonly notMarked: readonly MorningJob[];
  /** Open Action Center items, urgent first; the email lists the top few. */
  readonly open: readonly MorningItem[];
  readonly openTotal: number;
  readonly urgent: number;
  readonly homeLink: string;
}): EmailContent {
  const m = input.numbers;
  const subject = [
    `${count(m.newLeads, 'new lead')}`,
    `${count(m.jobsDone, 'job')} done`,
    m.paidCents > 0 ? `${moneyLabel(m.paidCents)} in` : '',
    input.openTotal > 0 ? `${input.openTotal} still open` : 'nothing left open',
  ]
    .filter(Boolean)
    .join(' · ');
  const hello = `Good evening${input.firstName ? `, ${input.firstName}` : ''}.`;
  const scope = `Here’s how today went at ${input.business}.`;
  const lines = [
    `Leads: ${count(m.newLeads, 'new lead')}${m.newLeads ? `, ${m.leadsReached} reached` : ''}`,
    `Jobs: ${m.jobsBooked} booked, ${m.jobsDone} done${m.noShows ? `, ${count(m.noShows, 'no-show')}` : ''}${
      input.notMarked.length ? `, ${input.notMarked.length} not marked done` : ''
    }`,
    `Money: ${moneyLabel(m.paidCents)} in${m.payments ? ` (${count(m.payments, 'payment')})` : ''}, ${count(
      m.invoicesSent,
      'invoice',
    )} and ${count(m.estimatesSent, 'estimate')} sent`,
    ...(m.ai
      ? [
          `AI teammate: answered ${count(m.ai.answered, 'conversation')}${
            m.ai.draftsWaiting ? `, ${count(m.ai.draftsWaiting, 'draft')} waiting for you` : ''
          }`,
        ]
      : []),
  ];
  const why = 'You’re getting this because End-of-day email is on for your account.';
  const text = [
    `${hello} ${scope}`,
    '',
    ...lines,
    '',
    ...(input.notMarked.length
      ? [
          'Not marked done yet',
          ...input.notMarked.map((j) => `- ${j.time} · ${j.customers} · ${j.title}: ${j.link}`),
          '',
        ]
      : []),
    ...(input.open.length
      ? [
          `Still open (${input.openTotal}${input.urgent ? `, ${input.urgent} urgent` : ''})`,
          ...input.open.map(
            (i) =>
              `- ${i.kind}: ${i.title}${i.chips.length ? ` (${i.chips.join(' · ')})` : ''}: ${i.link}`,
          ),
          '',
        ]
      : ['Nothing is left open on Home.', '']),
    `Open HandsFreeOS: ${input.homeLink}`,
    '',
    why,
    STOP_THESE,
  ].join('\n');
  const heading = (h: string) =>
    `<p style="font-size: 12.5px; font-weight: 600; color: #5b616a; margin: 18px 0 6px;">${escapeHtml(h)}</p>`;
  const li = (href: string, label: string, after = '') =>
    `<li style="margin-bottom: 6px;"><a href="${escapeHtml(href)}" style="color: #2d69d8; text-decoration: none;">${escapeHtml(label)}</a>${after}</li>`;
  const ul = (inner: string) =>
    `<ul style="margin: 0; padding-left: 18px; font-size: 14px; line-height: 1.5;">${inner}</ul>`;
  const html = shell(
    preheader(subject) +
      wordmark +
      para(`${escapeHtml(hello)} ${escapeHtml(scope)}`) +
      heading('The day in numbers') +
      `<ul style="margin: 0; padding-left: 18px; font-size: 14px; line-height: 1.6;">${lines
        .map((l) => `<li>${escapeHtml(l)}</li>`)
        .join('')}</ul>` +
      (input.notMarked.length
        ? heading('Not marked done yet') +
          ul(
            input.notMarked
              .map((j) => li(j.link, `${j.time} · ${j.customers}`, ` · ${escapeHtml(j.title)}`))
              .join(''),
          )
        : '') +
      (input.open.length
        ? heading(
            `Still open (${input.openTotal}${input.urgent ? `, ${input.urgent} urgent` : ''})`,
          ) + ul(input.open.map((i) => li(i.link, `${i.kind}: ${i.title}`)).join(''))
        : para('Nothing is left open on Home.')) +
      button(input.homeLink, 'Open HandsFreeOS') +
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

/** The carriers approved the business's RCS sender (0103): texts go as RCS where phones can show it. */
export function rcsLiveEmail(input: {
  business: string;
  sender: string;
  link: string;
}): EmailContent {
  const subject = `RCS is on for ${input.business}`;
  const text = `The carriers approved ${input.sender}. Your texts now go as RCS — with your name, your logo and buttons customers can tap — to every phone that can show it, and as ordinary texts to the phones that can't. Nothing changes in the inbox.

See RCS in Settings: ${input.link}`;
  const html = shell(
    para(
      `The carriers approved <strong>${escapeHtml(input.sender)}</strong>. Your texts now go as RCS — with your name, your logo and buttons customers can tap — to every phone that can show it, and as ordinary texts to the phones that can't.`,
    ) +
      para('Nothing changes in the inbox: the thread shows which way each message went.') +
      button(input.link, 'See RCS in Settings') +
      small(`Sent to the owners and admins of ${escapeHtml(input.business)}.`),
  );
  return { subject, text, html };
}

/** The business's RCS sender stopped (0103): texts go as SMS and MMS until it is back. */
export function rcsStoppedEmail(input: {
  business: string;
  sender: string;
  reason: string | null;
  link: string;
}): EmailContent {
  const subject = `RCS stopped for ${input.business}`;
  const reason = input.reason ? `Twilio says: “${input.reason}”` : 'Twilio did not say why.';
  const text = `${input.sender} stopped taking messages. ${reason}

Your texts still go out, as ordinary texts, until it is back.

See RCS in Settings: ${input.link}`;
  const html = shell(
    para(`<strong>${escapeHtml(input.sender)}</strong> stopped taking messages.`) +
      para(escapeHtml(reason)) +
      para('Your texts still go out, as ordinary texts, until it is back.') +
      button(input.link, 'See RCS in Settings') +
      small(`Sent to the owners and admins of ${escapeHtml(input.business)}.`),
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

/**
 * An invoice was settled: the short "you've been paid" to whoever is on it and to the owners and admins (M9).
 * It never says what a way of paying costs the business — naming it is a fact, pricing it is a decision Chris
 * cut from everything anyone reads.
 */
export function invoicePaidEmail(input: {
  customer: string;
  /** The invoice number, or null for one that somehow went out without one. */
  invoice: string | null;
  title: string | null;
  /** The payment that settled it. */
  amountCents: number;
  /** What the invoice came to in all; the same figure when it was paid in one go. */
  totalCents: number;
  /** 'card', 'ach', 'cash', 'check', 'other'; null when we don't know. */
  method: string | null;
  link: string;
}): EmailContent {
  const noun = input.invoice ? `invoice ${input.invoice}` : 'their invoice';
  const how = input.method
    ? ` by ${PAYMENT_METHOD_WORDS[input.method as PaymentMethod] ?? input.method}`
    : '';
  const subject = `You’ve been paid: ${input.customer}, ${moneyLabel(input.totalCents)}`;
  const opening =
    input.amountCents >= input.totalCents
      ? `${input.customer} paid ${noun} — ${moneyLabel(input.totalCents)}${how}.`
      : `${input.customer} has now paid ${noun} in full — ${moneyLabel(input.totalCents)}. The last payment was ${moneyLabel(input.amountCents)}${how}.`;
  const rows: [string, string | null][] = [
    ['Invoice', input.invoice],
    ['For', input.title],
    ['Paid', `${moneyLabel(input.totalCents)}${how}`],
  ];
  const shown = rows.filter((r): r is [string, string] => !!r[1]);
  const off = 'Turn these off in Settings, then Account.';
  const text = [
    opening,
    '',
    ...shown.map(([k, v]) => `${k}: ${v}`),
    '',
    `Open in HandsFreeOS: ${input.link}`,
    '',
    off,
  ].join('\n');
  const html = shell(
    wordmark +
      `<p style="font-size: 15px; line-height: 1.5; margin: 0 0 12px;"><strong>${escapeHtml(input.customer)}</strong>${escapeHtml(
        opening.slice(input.customer.length),
      )}</p>` +
      `<table style="width: 100%; border-collapse: collapse; font-size: 13px; margin: 0 0 14px;">${shown
        .map(([k, v]) => detailRow(k, v))
        .join('')}</table>` +
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

/**
 * "Email me a link" in the phone app: the page that does one Getting started step, to open on a computer. Only ever
 * sent to the person who asked, from their own phone.
 */
export function onboardingLinkEmail(input: {
  /** The step's title, like "Bring in your customers". */
  step: string;
  business: string;
  link: string;
}): EmailContent {
  const subject = `Your link: ${input.step}`;
  const lead = (business: string) =>
    `Here’s the link you asked for in the HandsFreeOS app, to do this for ${business} on your computer.`;
  const after = 'You asked for this from the app. If that wasn’t you, ignore it: nothing changes.';
  const text = `${lead(input.business)}\n\n${input.step}: ${input.link}\n\n${after}`;
  const html = shell(
    para(lead(`<strong>${escapeHtml(input.business)}</strong>`)) +
      button(input.link, input.step) +
      small(after),
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
 * A hand-off still waiting (Automations' "Hand-off nobody picked up"): four hours on, the owners and admins hear
 * that nobody has picked it up.
 */
export function handoffWaitingEmail(input: {
  customer: string;
  /** "4 hours". */
  waiting: string;
  /** Who it was handed to, or null when nobody. */
  handedTo: string | null;
  link: string;
}): EmailContent {
  const subject = `${input.customer} is still waiting for a person`;
  const opening = `The AI teammate handed ${input.customer} to ${input.handedTo ?? 'your team'} ${input.waiting} ago, and nobody has picked it up yet.`;
  const why =
    'You’re getting this because you’re an owner or admin and the hand-off has waited this long. Replying takes it over.';
  const text = [opening, '', `Open the conversation: ${input.link}`, '', why, STOP_THESE].join(
    '\n',
  );
  const html = shell(
    preheader(opening) +
      wordmark +
      `<p style="font-size: 15px; line-height: 1.5; margin: 0;">${escapeHtml(opening)}</p>` +
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

/**
 * A top-up bigger than the business chose, sent **before** the card is charged (M16 step 6, disclosed in the
 * terms at step 10). Repeated top-ups in a few days raise the amount, and the one thing that fixes it is
 * raising their own top-up — so that is the sentence, and the button goes straight to the setting.
 */
export function topUpRaisedEmail(input: {
  business: string;
  amountCents: number;
  chosenCents: number;
  recharges: number;
  link: string;
}): EmailContent {
  const dollars = (c: number) => `$${(c / 100).toFixed(2)}`;
  const amount = dollars(input.amountCents);
  const chosen = dollars(input.chosenCents);
  const subject = `We’re about to top up ${input.business} by ${amount}`;
  const why = `${input.business} has topped up ${input.recharges} times in the last few days, so this one is ${amount} instead of ${chosen}. We are charging the card on file now.`;
  const fix = `If this keeps happening, raise your own top-up amount: one ${amount} charge instead of several small ones, and the amount stops climbing.`;
  const foot = `Sent to the owners and admins of ${input.business} before the card is charged.`;
  const text = [why, '', fix, '', `Change your top-up: ${input.link}`, '', foot].join('\n');
  const html = shell(
    wordmark +
      para(escapeHtml(why)) +
      para(escapeHtml(fix)) +
      button(input.link, 'Change your top-up') +
      small(escapeHtml(foot)),
  );
  return { subject, text, html };
}

/**
 * The balance has run out (M16). One of the two emails a business gets about its own balance, and the reason
 * they exist at all: the push switch for these can be turned off, and at zero we deliberately do **not** send
 * a text — spending money to tell somebody they have none is absurd, and on an empty balance it would not go
 * out anyway. Without an email a business whose phone had stopped could have nothing but a card in an app
 * nobody had opened. The terms say we tell them why rather than failing quietly; this is how.
 *
 * `stopping` is the wallet's stage. At `warn` nothing has stopped yet and the email says so — that stretch
 * exists so a business can put a card on before any of this costs it a customer.
 */
export function walletEmptyEmail(input: {
  business: string;
  balanceCents: number;
  hasCard: boolean;
  autoTopup: boolean;
  stopping: boolean;
  link: string;
}): EmailContent {
  const left =
    input.balanceCents < 0
      ? `$${(Math.abs(input.balanceCents) / 100).toFixed(2)} over`
      : `$${(input.balanceCents / 100).toFixed(2)} left`;
  const subject = input.stopping
    ? `Texts and calls have stopped for ${input.business}`
    : `${input.business} is out of balance — texts and calls still work`;
  const what = input.stopping
    ? `${input.business}'s usage balance has run out (${left}), so outgoing texts and calls have stopped. Calls coming in still reach you, and messages coming in are still received and filed — nothing is lost.`
    : `${input.business}'s usage balance has run out (${left}). Nothing has stopped: texts and calls still work for now. This is the warning before they don't.`;
  const fix = !input.hasCard
    ? 'There is no card on this balance yet. Add one and it tops itself up from now on.'
    : !input.autoTopup
      ? 'There is a card on this balance, but automatic top-up is off. Turn it on and this stops happening.'
      : 'The card on file has not covered it. Check that it is still good, or top up by hand.';
  const foot = `Sent to the owners and admins of ${input.business}. This is about what you pay HandsFreeOS, not about money your own customers owe you.`;
  const text = [what, '', fix, '', `Top up: ${input.link}`, '', foot].join('\n');
  const html = shell(
    wordmark +
      para(escapeHtml(what)) +
      para(escapeHtml(fix)) +
      button(input.link, 'Top up') +
      small(escapeHtml(foot)),
  );
  return { subject, text, html };
}

/**
 * The card on the balance has stopped working and the retries have run out (M16). Harder than the one above,
 * because there is nothing automatic left to try: the ladder waited six hours, a day and three days, and the
 * bank said no each time. What it needs is a different card, which only a person can provide.
 */
export function walletCardDeclinedEmail(input: {
  business: string;
  reason: string | null;
  stopping: boolean;
  link: string;
}): EmailContent {
  const subject = `The card for ${input.business} was declined`;
  const what = `We tried to top up ${input.business}'s usage balance and the card was declined. ${
    input.reason ?? 'The bank did not say why.'
  }`;
  const tried =
    'We tried again after six hours, after a day and after three days. It has been declined each time, so we have stopped trying rather than keep asking the bank.';
  const now = input.stopping
    ? 'Outgoing texts and calls have stopped until there is a working card. Calls coming in still reach you.'
    : 'Nothing has stopped yet, so there is time to sort it out.';
  const foot = `Sent to the owners and admins of ${input.business}.`;
  const text = [what, '', tried, '', now, '', `Add a card: ${input.link}`, '', foot].join('\n');
  const html = shell(
    wordmark +
      para(escapeHtml(what)) +
      para(escapeHtml(tried)) +
      para(escapeHtml(now)) +
      button(input.link, 'Add a card') +
      small(escapeHtml(foot)),
  );
  return { subject, text, html };
}

/** M18: the code a website chat visitor types back to prove they're the customer (sent to the email on file). */
export function chatCodeEmail(input: {
  business: string;
  code: string;
  minutes: number;
}): EmailContent {
  const subject = `Your ${input.business} code: ${input.code}`;
  const text = `Your code for the ${input.business} chat is ${input.code}. It expires in ${input.minutes} minutes.\n\nIf you didn’t ask for it, ignore this email: nobody can see your details without it.`;
  const html = shell(
    preheader(`Your code is ${input.code}`) +
      para(`Your code for the <strong>${escapeHtml(input.business)}</strong> chat is:`) +
      `<p style="font-size: 28px; font-weight: 700; letter-spacing: 4px; margin: 16px 0;">${escapeHtml(input.code)}</p>` +
      para(`It expires in ${input.minutes} minutes.`) +
      small('If you didn’t ask for it, ignore this email: nobody can see your details without it.'),
  );
  return { subject, text, html };
}

/** The same code by text. */
export const chatCodeText = (business: string, code: string, minutes: number): string =>
  `${business}: your chat code is ${code}. It expires in ${minutes} minutes. If you didn’t ask for it, ignore this text.`;

// ---- Ideas, the roadmap and What's new (0102) ----

const IDEA_FOOT =
  'You get these because you follow this idea. To stop, open it and turn off “Email me updates”.';

/**
 * Somebody following an idea hears when the team moves it along the roadmap, ships it in What's new, or folds it
 * into another idea that asks for the same thing. Whoever shared it is told it was theirs.
 */
export function ideaUpdateEmail(input: {
  firstName: string;
  title: string;
  number: number;
  /** They shared it. */
  yours: boolean;
  /** Where it went: its new status, or the idea it was merged into. */
  change:
    | { kind: 'status'; status: IdeaStatus; whatsNewTitle: string | null }
    | { kind: 'merged'; intoNumber: number; intoTitle: string };
  /** What the team said about it, and who. */
  note: string;
  by: string;
  link: string;
}): EmailContent {
  const which = input.yours ? 'The idea you shared' : 'An idea you follow';
  const quoted = `“${input.title}” (#${input.number})`;
  const change = input.change;
  const subject =
    change.kind === 'status'
      ? `“${input.title}” ${ideaUpdateHeadline(change.status)}`
      : `“${input.title}” joined a matching idea`;
  const what =
    change.kind === 'status'
      ? `${which}, ${quoted}, ${ideaUpdateHeadline(change.status)}. ${IDEA_STATUS_MEANING[change.status]}`
      : `${which}, ${quoted}, asks for the same thing as #${change.intoNumber}, “${change.intoTitle}”, so we put them together. Its votes went with it, and from now on you will hear about #${change.intoNumber}.`;
  const shipped =
    change.kind === 'status' && change.whatsNewTitle
      ? `It is in What’s new: “${change.whatsNewTitle}”.`
      : '';
  const said = input.note ? `${input.by || 'The HandsFreeOS team'} wrote: “${input.note}”` : '';
  const hello = input.firstName ? `Hi ${input.firstName},` : 'Hi,';
  const text = [hello, '', what, shipped, said, '', `See the idea: ${input.link}`, '', IDEA_FOOT]
    .filter((l, i, all) => l !== '' || all[i - 1] !== '')
    .join('\n');
  const html = shell(
    preheader(what) +
      wordmark +
      para(escapeHtml(hello)) +
      para(escapeHtml(what)) +
      (shipped ? para(escapeHtml(shipped)) : '') +
      (said
        ? `<div style="background: #f2f4f8; border-radius: 10px; padding: 14px 16px; font-size: 14px; line-height: 1.5; margin: 8px 0;">${escapeHtml(said)}</div>`
        : '') +
      button(input.link, 'See the idea') +
      small(escapeHtml(IDEA_FOOT)),
  );
  return { subject, text, html };
}

/** Whoever shared an idea hears when the team answers it in the comments: often it is a question for them. */
export function ideaTeamAnswerEmail(input: {
  firstName: string;
  title: string;
  number: number;
  by: string;
  comment: string;
  link: string;
}): EmailContent {
  const who = input.by ? `${input.by} from the HandsFreeOS team` : 'The HandsFreeOS team';
  const subject = `${who} answered your idea “${input.title}”`;
  const hello = input.firstName ? `Hi ${input.firstName},` : 'Hi,';
  const what = `${who} answered your idea “${input.title}” (#${input.number}):`;
  const text = [
    hello,
    '',
    what,
    '',
    `“${input.comment}”`,
    '',
    `Reply: ${input.link}`,
    '',
    IDEA_FOOT,
  ].join('\n');
  const html = shell(
    preheader(input.comment) +
      wordmark +
      para(escapeHtml(hello)) +
      para(escapeHtml(what)) +
      `<div style="background: #f2f4f8; border-radius: 10px; padding: 14px 16px; font-size: 14px; line-height: 1.5; margin: 8px 0; white-space: pre-wrap;">${escapeHtml(input.comment)}</div>` +
      button(input.link, 'Reply') +
      small(escapeHtml(IDEA_FOOT)),
  );
  return { subject, text, html };
}

// ---- Voting on what's next (0109) ----

const ADDON_VOTE_FOOT =
  'You get this because your business voted for this add-on on the Add-ons page in HandsFreeOS.';

/**
 * The owners and admins of a business that voted for an add-on hear when it is picked: it won the week's vote, or
 * the team chose it when a week had no winner. Either way it's next to be built.
 */
export function addonPickedEmail(input: {
  firstName: string;
  name: string;
  summary: string;
  business: string;
  link: string;
}): EmailContent {
  const subject = `${input.name} is coming soon`;
  const hello = input.firstName ? `Hi ${input.firstName},` : 'Hi,';
  const what = `${input.business} voted for ${input.name}, and it’s next to be built. We’ll email you again when you can add it.`;
  const text = [
    hello,
    '',
    what,
    '',
    input.summary,
    '',
    `See what’s coming: ${input.link}`,
    '',
    ADDON_VOTE_FOOT,
  ].join('\n');
  const html = shell(
    preheader(what) +
      wordmark +
      para(escapeHtml(hello)) +
      para(escapeHtml(what)) +
      `<div style="background: #f2f4f8; border-radius: 10px; padding: 14px 16px; font-size: 14px; line-height: 1.5; margin: 8px 0;"><strong>${escapeHtml(input.name)}</strong><br>${escapeHtml(input.summary)}</div>` +
      button(input.link, 'See what’s coming') +
      small(escapeHtml(ADDON_VOTE_FOOT)),
  );
  return { subject, text, html };
}

/** The same people hear again when the add-on they voted for can be added. */
export function addonShippedEmail(input: {
  firstName: string;
  name: string;
  summary: string;
  business: string;
  link: string;
}): EmailContent {
  const subject = `${input.name} is ready to add`;
  const hello = input.firstName ? `Hi ${input.firstName},` : 'Hi,';
  const what = `${input.business} voted for ${input.name}, and it’s ready. You can add it now on the Add-ons page.`;
  const text = [
    hello,
    '',
    what,
    '',
    input.summary,
    '',
    `Add it: ${input.link}`,
    '',
    ADDON_VOTE_FOOT,
  ].join('\n');
  const html = shell(
    preheader(what) +
      wordmark +
      para(escapeHtml(hello)) +
      para(escapeHtml(what)) +
      `<div style="background: #f2f4f8; border-radius: 10px; padding: 14px 16px; font-size: 14px; line-height: 1.5; margin: 8px 0;"><strong>${escapeHtml(input.name)}</strong><br>${escapeHtml(input.summary)}</div>` +
      button(input.link, 'Add it') +
      small(escapeHtml(ADDON_VOTE_FOOT)),
  );
  return { subject, text, html };
}

/**
 * The team who choose what comes next hear when a week's vote closed with no winner: nothing voted for, or a tie.
 * Nothing becomes Coming soon until one of them chooses.
 */
export function addonPickNeededEmail(input: {
  firstName: string;
  outcome: 'no_votes' | 'tie';
  /** For a tie, the names that tied. */
  tied: readonly string[];
  votes: number;
  link: string;
}): EmailContent {
  const tied =
    input.tied.length <= 2
      ? input.tied.join(' and ')
      : `${input.tied.slice(0, -1).join(', ')} and ${input.tied.at(-1)}`;
  const subject =
    input.outcome === 'tie'
      ? 'This week’s add-on vote is a tie'
      : 'Nobody voted for an add-on this week';
  const what =
    input.outcome === 'tie'
      ? `This week’s vote ended in a tie between ${tied}, with ${input.votes} ${input.votes === 1 ? 'vote' : 'votes'} each. Choose which one comes next.`
      : 'This week’s vote closed with no votes, so nothing new is Coming soon. Choose what HandsFreeOS builds next.';
  const hello = input.firstName ? `Hi ${input.firstName},` : 'Hi,';
  const text = [hello, '', what, '', `Choose it: ${input.link}`].join('\n');
  const html = shell(
    preheader(what) +
      wordmark +
      para(escapeHtml(hello)) +
      para(escapeHtml(what)) +
      button(input.link, 'Choose it'),
  );
  return { subject, text, html };
}

/** What Claude's status page says about the Claude API, in the words the email uses. */
const CLAUDE_STATUS_WORDS: Readonly<Record<string, string>> = {
  degraded_performance: 'slow',
  partial_outage: 'partly down',
  major_outage: 'down',
  under_maintenance: 'under maintenance',
};

/**
 * HandsFreeOS's own people hear when every AI feature moves to OpenAI because Claude is in trouble, and when
 * it comes back (ai/switch.ts). Nothing for them to do: it's so a surprise in the logs has an explanation.
 */
export function aiSwitchEmail(input: {
  to: 'openai' | 'claude';
  /** Why it moved to OpenAI. */
  reason?: 'status' | 'errors';
  /** What Claude's status page said (operational, degraded_performance, …). */
  claudeStatus?: string | null;
  /** How long it was on OpenAI, when it comes back. */
  minutes?: number | null;
  link: string;
}): EmailContent {
  const subject = input.to === 'openai' ? 'The AI switched to OpenAI' : 'The AI is back on Claude';
  const status = CLAUDE_STATUS_WORDS[input.claudeStatus ?? ''] ?? 'having trouble';
  const why =
    input.reason === 'errors'
      ? 'Claude’s answers kept failing'
      : `Claude’s status page says the Claude API is ${status}`;
  const how =
    input.minutes == null
      ? ''
      : ` It was on OpenAI for ${input.minutes} ${input.minutes === 1 ? 'minute' : 'minutes'}.`;
  const what =
    input.to === 'openai'
      ? `${why}, so every AI feature is answering with OpenAI. It goes back to Claude on its own after two good checks in a row, 5 minutes apart.`
      : `Claude has been well for two checks in a row, so every AI feature is answering with Claude again.${how}`;
  const next =
    'Nothing for you to do. To keep it on one of them, open Admin → Health → Which AI answers.';
  const text = [what, '', next, '', `Open Health: ${input.link}`].join('\n');
  const html = shell(
    preheader(what) +
      wordmark +
      para(escapeHtml(what)) +
      para(escapeHtml(next)) +
      button(input.link, 'Open Health'),
  );
  return { subject, text, html };
}
