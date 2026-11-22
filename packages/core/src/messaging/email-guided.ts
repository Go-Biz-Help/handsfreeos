/**
 * The guided email setup (the owner, 22 Nov 2026): Settings → Email's "Set it up" and Home's card, one question at
 * a time. Which email (the business's own website name, or a free HandsFreeOS address), which addresses, who reads
 * each one (only me, or the team), which one customers hear from, and where the mail arrives. Then "Check it over",
 * and nothing changes until "Set it up". Browser-safe: the web, the phone and the command all work from these.
 *
 * The answers save as they're given (guided-setup/index.ts keeps them), so someone who leaves comes back to them.
 *
 * What the questions never do: change an address that is already set up. Who reads an existing address, and
 * removing one, stay in Settings → Email, where its own person is asked. The questions add.
 */
import { z } from 'zod';
import {
  emailDomainName,
  emailLocalPart,
  type EmailMxRecord,
  isConsumerMailDomain,
  isHandsFreeOsDomain,
  isReservedLocalPart,
  normalizeEmailDomain,
} from '../schemas/email';
import {
  dnsHostFor,
  EMAIL_PLAN_ADDRESSES_MAX,
  EMAIL_SETUP_WITH,
  emailOldMailRecords,
  emailSetupDomainOf,
  emailSetupSuggestedDomain,
  freeAddressLooksRandom,
  freeLocalPartFor,
  MAIL_HOST_LABELS,
  personLocalPartFor,
  type EmailDomainPlan,
  type EmailSetupDomain,
  type EmailSetupProblem,
  type EmailSetupState,
  type MailHost,
} from './email-setup';

// ---------- the answers ----------

/** The screens, in order. With a free address only the first and the last are asked. */
export const EMAIL_GUIDED_SCREENS = [
  'which',
  'addresses',
  'readers',
  'sender',
  'receive',
  'review',
] as const;
export type EmailGuidedScreen = (typeof EMAIL_GUIDED_SCREENS)[number];

/** Who reads an address the questions add: only the person answering, or the team. */
export const EMAIL_GUIDED_READERS = ['me', 'team'] as const;
export type EmailGuidedReader = (typeof EMAIL_GUIDED_READERS)[number];

export const EmailGuidedAddress = z.object({
  /** Its name before the @, as typed: "office". */
  local: z.string().max(300).default(''),
  reader: z.enum(EMAIL_GUIDED_READERS).default('team'),
  /** "Let Ava read this mail", for one only the person reads. */
  aiReads: z.boolean().default(false),
  /** The person picked who reads it; until then our pick from its name follows the name. */
  picked: z.boolean().default(false),
});
export type EmailGuidedAddress = z.infer<typeof EmailGuidedAddress>;

/**
 * The answers so far, as typed. Loose on purpose: they're saved while someone is part way through and read
 * forgivingly, so each screen checks its own (`emailGuidedProblems`) before Next.
 */
export const EmailGuidedAnswers = z.object({
  /** Own website name or the free address; null until picked. */
  with: z.enum(EMAIL_SETUP_WITH).nullable().default(null),
  /** "Your website name", as typed: "burroughs.digital". */
  domain: z.string().max(300).default(''),
  /** The free address's name on the shared subdomain: "burroughsdigital". */
  freeLocal: z.string().max(300).default(''),
  /** "Name customers see". */
  name: z.string().max(300).default(''),
  /** The addresses to add at the website name. */
  addresses: z.array(EmailGuidedAddress).max(EMAIL_PLAN_ADDRESSES_MAX).default([]),
  /** The one customers hear from, by its name before the @; empty leaves it to our pick. */
  sender: z.string().max(300).default(''),
  /** Read the mail in HandsFreeOS (true) or keep it where it is (false); null until picked. */
  receive: z.boolean().nullable().default(null),
  /** The screen they were on, so coming back starts there. */
  at: z.enum(EMAIL_GUIDED_SCREENS).default('which'),
  /** Who is answering: "Only me" means them. */
  by: z.string().max(64).nullable().default(null),
});
export type EmailGuidedAnswers = z.infer<typeof EmailGuidedAnswers>;
export type EmailGuidedAnswersInput = z.input<typeof EmailGuidedAnswers>;

/** Saved answers, read forgivingly: null for anything that no longer parses, or that someone else was giving. */
export function emailGuidedAnswersFrom(
  raw: unknown,
  userId: string | null,
): EmailGuidedAnswers | null {
  const r = EmailGuidedAnswers.safeParse(raw ?? null);
  if (!r.success || !r.data.with) return null;
  return r.data.by && userId && r.data.by !== userId ? null : r.data;
}

type GuidedState = Pick<
  EmailSetupState,
  | 'sharedDomain'
  | 'inboundMxHost'
  | 'domains'
  | 'addresses'
  | 'lookup'
  | 'myFirstName'
  | 'myEmail'
  | 'aiTeammate'
>;

const lower = (v: string) => v.trim().toLowerCase();

/**
 * The website name as typed, cleaned up: "https://www.Burroughs.Digital/contact" is "burroughs.digital". Nobody's
 * email is at www, so it goes too.
 */
export const emailGuidedDomain = (typed: string): string =>
  normalizeEmailDomain(typed).replace(/^www\./, '');

/** The screens these answers go through: all six on the business's own website name, two with a free address. */
export const emailGuidedScreensFor = (
  answers: Pick<EmailGuidedAnswers, 'with'>,
): readonly EmailGuidedScreen[] =>
  answers.with === 'free' ? (['which', 'review'] as const) : EMAIL_GUIDED_SCREENS;

/** "Question 3 of 5": which question a screen is; null for Check it over. */
export function emailGuidedQuestionOf(
  screen: EmailGuidedScreen,
  answers: Pick<EmailGuidedAnswers, 'with'>,
): { readonly n: number; readonly of: number } | null {
  if (screen === 'review') return null;
  const asked = emailGuidedScreensFor(answers).filter((s) => s !== 'review');
  const at = asked.indexOf(screen);
  return at < 0 ? null : { n: at + 1, of: asked.length };
}

/** The screen after this one, and before it; null at either end. */
export function emailGuidedStep(
  screen: EmailGuidedScreen,
  answers: Pick<EmailGuidedAnswers, 'with'>,
  by: 1 | -1,
): EmailGuidedScreen | null {
  const all = emailGuidedScreensFor(answers);
  const at = all.indexOf(screen);
  return at < 0 ? (all[0] ?? null) : (all[at + by] ?? null);
}

// ---------- what was found about the website name ----------

/** What the worker records as where a name's records are looked after when DNS says there is no such name. */
export const EMAIL_LOOKUP_NO_SUCH_NAME = 'none';

/** Where a website name's mail goes and where its records are looked after, as far as anyone has looked. */
export interface EmailGuidedFound {
  readonly domain: string;
  readonly mailHost: MailHost | null;
  /** A key of `DNS_HOSTS`, or "other"; null when nobody could tell. */
  readonly dnsHost: string | null;
  readonly mxRecords: readonly EmailMxRecord[] | null;
  /** DNS answered, and the name has no records at all: most likely a slip of the keyboard. */
  readonly missing: boolean;
}

/** What's known about the name in the answers: from the business's own domain once added, else from the look-up. */
export function emailGuidedFound(
  state: Pick<EmailSetupState, 'domains' | 'lookup'>,
  answers: Pick<EmailGuidedAnswers, 'domain'>,
): EmailGuidedFound | null {
  const domain = emailGuidedDomain(answers.domain);
  if (!domain) return null;
  const d = emailSetupDomainOf(state, { domain });
  const from =
    d && (d.mailHost || d.dnsHost)
      ? { mailHost: d.mailHost, dnsHost: d.dnsHost, mxRecords: d.mxRecords }
      : state.lookup?.domain === domain
        ? state.lookup
        : null;
  if (!from) return null;
  return {
    domain,
    mailHost: from.mailHost,
    dnsHost: from.dnsHost,
    mxRecords: from.mxRecords,
    missing: from.dnsHost === EMAIL_LOOKUP_NO_SUCH_NAME,
  };
}

/** The place its records are looked after, by name: "SiteGround"; null when we don't know it. */
export const emailGuidedDnsLabel = (
  found: Pick<EmailGuidedFound, 'dnsHost'> | null,
): string | null => dnsHostFor(found?.dnsHost)?.label ?? null;

/** Where its mail goes today, by name: the mail service when we know it, else where its records are. */
export function emailGuidedMailLabel(
  found: Pick<EmailGuidedFound, 'mailHost' | 'dnsHost'> | null,
): string | null {
  if (!found?.mailHost || found.mailHost === 'none' || found.mailHost === 'handsfreeos')
    return null;
  if (found.mailHost !== 'other') return MAIL_HOST_LABELS[found.mailHost];
  return emailGuidedDnsLabel(found);
}

// ---------- the addresses ----------

/** An address as the questions show it: one already set up, or one being added. */
export interface EmailGuidedRow {
  readonly local: string;
  readonly address: string;
  /** Only the person answering, the team, or (already set up) only someone else. */
  readonly reader: 'me' | 'team' | 'other';
  readonly aiReads: boolean;
  /** Its id when it's already set up: the questions leave it as it is. */
  readonly existingId: string | null;
  /** Its place in the answers' addresses, for one being added. */
  readonly index: number | null;
  /** Customers hear from it today. */
  readonly isDefault: boolean;
}

/** Who most likely reads an address, from its name: the person's own name is theirs, anything else is shared. */
export function emailGuidedReaderPick(
  local: string,
  state: Pick<EmailSetupState, 'myFirstName' | 'myEmail'>,
): EmailGuidedReader {
  const name = lower(local);
  if (!name) return 'team';
  const mine = [personLocalPartFor(state.myFirstName), lower(state.myEmail?.split('@')[0] ?? '')];
  return mine.includes(name) ? 'me' : 'team';
}

/**
 * The addresses at the website name in the answers: the ones already set up there, then the ones being added
 * (named, and not already there). A row never named isn't one yet.
 */
export function emailGuidedRows(
  answers: Pick<EmailGuidedAnswers, 'domain' | 'addresses'>,
  state: Pick<EmailSetupState, 'addresses'>,
): EmailGuidedRow[] {
  const domain = emailGuidedDomain(answers.domain);
  const existing: EmailGuidedRow[] = state.addresses
    .filter((a) => a.domain === domain)
    .map((a) => ({
      local: a.localPart,
      address: a.address,
      reader: a.reader,
      aiReads: a.aiReads,
      existingId: a.id,
      index: null,
      isDefault: a.isDefault,
    }));
  const taken = new Set(existing.map((r) => r.local));
  const added: EmailGuidedRow[] = [];
  answers.addresses.forEach((a, index) => {
    const local = lower(a.local);
    if (!local || taken.has(local)) return;
    taken.add(local);
    added.push({
      local,
      address: `${local}@${domain}`,
      reader: a.reader,
      aiReads: a.reader === 'me' && a.aiReads,
      existingId: null,
      index,
      isDefault: false,
    });
  });
  return [...existing, ...added];
}

/** Names for the chips under "Add another address": the person's own first, then the usual shared ones. */
export function emailGuidedIdeas(
  answers: Pick<EmailGuidedAnswers, 'domain' | 'addresses'>,
  state: Pick<EmailSetupState, 'addresses' | 'myFirstName'>,
): string[] {
  const have = new Set(emailGuidedRows(answers, state).map((r) => r.local));
  const me = personLocalPartFor(state.myFirstName);
  return [
    ...new Set([...(me ? [me] : []), 'info', 'hello', 'office', 'bookings', 'billing', 'sales']),
  ]
    .filter((n) => !have.has(n))
    .slice(0, 6);
}

/**
 * The address customers hear from: the one picked when the team reads it, else the one they hear from today when
 * it's here, else the first one the team reads. Null when the team reads none.
 */
export function emailGuidedSender(
  answers: Pick<EmailGuidedAnswers, 'domain' | 'addresses' | 'sender'>,
  state: Pick<EmailSetupState, 'addresses'>,
): EmailGuidedRow | null {
  const team = emailGuidedRows(answers, state).filter((r) => r.reader === 'team');
  const picked = lower(answers.sender);
  return team.find((r) => r.local === picked) ?? team.find((r) => r.isDefault) ?? team[0] ?? null;
}

// ---------- where the mail arrives ----------

/** The website name in the answers, as the business has it. */
const domainOf = (
  state: Pick<EmailSetupState, 'domains'>,
  answers: Pick<EmailGuidedAnswers, 'domain'>,
) => emailSetupDomainOf(state, { domain: emailGuidedDomain(answers.domain) });

/**
 * Where the mail will arrive. `fixed` when it already comes here, so there's nothing to pick. Else as picked, and
 * until then "In HandsFreeOS" for a name nobody gets email at yet (nothing is moved); a name whose mail goes
 * somewhere today is the person's to pick, never ours.
 */
export function emailGuidedReceive(
  answers: Pick<EmailGuidedAnswers, 'domain' | 'receive'>,
  state: Pick<EmailSetupState, 'domains' | 'lookup'>,
): { readonly fixed: boolean; readonly value: boolean | null } {
  const d = domainOf(state, answers);
  if (d && d.receiving !== 'off') return { fixed: true, value: true };
  if (answers.receive !== null) return { fixed: false, value: answers.receive };
  const found = emailGuidedFound(state, answers);
  return { fixed: false, value: found?.mailHost === 'none' ? true : null };
}

// ---------- what each screen needs ----------

const W_LATER = 'Go back and fix it, then come back to this screen.';

/** What a screen still needs before Next. `review` checks every screen: it's what "Set it up" runs on. */
export function emailGuidedProblems(
  screen: EmailGuidedScreen,
  answers: EmailGuidedAnswers,
  state: GuidedState,
): EmailSetupProblem[] {
  const out: EmailSetupProblem[] = [];
  const all = screen === 'review';
  const add = (path: string, message: string) => out.push({ path, message });

  if (screen === 'which' || all) {
    if (!answers.with) add('email.with', W.pickOne);
    else if (answers.with === 'free') {
      const r = emailLocalPart.safeParse(answers.freeLocal);
      if (!r.success) add('email.freeLocal', r.error.issues[0]!.message);
      else if (isReservedLocalPart(r.data))
        add(
          'email.freeLocal',
          `“${r.data}” is kept for HandsFreeOS itself on ${state.sharedDomain}. Pick another name.`,
        );
    } else {
      const r = emailDomainName.safeParse(emailGuidedDomain(answers.domain));
      if (!r.success) add('email.domain', W.domainMissing);
      else if (isConsumerMailDomain(r.data)) add('email.domain', W.consumerDomain(r.data));
      else if (isHandsFreeOsDomain(r.data)) add('email.domain', W.ourDomain);
    }
  }
  if (answers.with !== 'domain') {
    if (all) nameProblem(answers, add);
    return out;
  }

  const rows = emailGuidedRows(answers, state);
  if (screen === 'addresses' || all) {
    const existing = new Set(rows.filter((r) => r.existingId).map((r) => r.local));
    const seen = new Set<string>();
    let named = 0;
    answers.addresses.forEach((a, i) => {
      const path = `email.addresses.${i}.local`;
      if (!a.local.trim()) return;
      named += 1;
      const r = emailLocalPart.safeParse(a.local);
      if (!r.success) return add(path, r.error.issues[0]!.message);
      if (existing.has(r.data)) return add(path, W.alreadySetUp(r.data));
      if (seen.has(r.data)) return add(path, W.twice(r.data));
      seen.add(r.data);
    });
    if (!named && !existing.size) add('email.addresses', W.addressMissing);
  }
  if (screen === 'readers' || screen === 'sender' || all) {
    if (rows.length && !rows.some((r) => r.reader === 'team'))
      add('email.readers', screen === 'sender' ? `${W.teamMissing} ${W_LATER}` : W.teamMissing);
  }
  if (screen === 'receive' || all) {
    if (emailGuidedReceive(answers, state).value === null) add('email.receive', W.receiveMissing);
  }
  if (all) nameProblem(answers, add);
  return out;
}

function nameProblem(answers: EmailGuidedAnswers, add: (path: string, message: string) => void) {
  const name = answers.name.trim();
  if (!name) add('email.name', W.nameMissing);
  else if (name.length > 120)
    add('email.name', 'Keep the name customers see under 120 characters.');
}

/** The first screen that still needs something, so "Set it up" can send the person back to it. */
export function emailGuidedFirstProblemScreen(
  answers: EmailGuidedAnswers,
  state: GuidedState,
): EmailGuidedScreen | null {
  for (const s of emailGuidedScreensFor(answers))
    if (s !== 'review' && emailGuidedProblems(s, answers, state).length) return s;
  return null;
}

// ---------- the answers to start from ----------

/**
 * The answers before anyone answers: the website name the business already uses (or is waiting on), with what's
 * planned there, else the one it most likely owns, else the free address.
 */
export function startingEmailGuidedAnswers(state: EmailSetupState): EmailGuidedAnswers {
  const freeLocal =
    state.free && !freeAddressLooksRandom(state)
      ? state.free.localPart
      : freeLocalPartFor(state.businessName);
  const name = (state.sender?.displayName || state.businessName).trim().slice(0, 120);
  const base = { freeLocal, name, by: state.myUserId };
  const pending = state.domains.find((d) => d.status !== 'verified' && d.plan.team) ?? null;
  if (pending?.plan.team) {
    const planned = [
      { local: pending.plan.team.localPart, reader: 'team' as const },
      ...(pending.plan.addresses ?? []).map((a) => ({
        local: a.localPart,
        // Someone else's own address stays in the plan; it isn't this person's to answer for.
        reader: a.userId ? ('me' as const) : ('team' as const),
        aiReads: !!a.aiReads,
        theirs: !!a.userId && a.userId !== state.myUserId,
      })),
    ].filter((a) => !('theirs' in a && a.theirs));
    return EmailGuidedAnswers.parse({
      ...base,
      with: 'domain',
      domain: pending.domain,
      name: pending.plan.team.displayName,
      addresses: planned.map((a) => ({
        local: a.local,
        reader: a.reader,
        aiReads: 'aiReads' in a ? a.aiReads : false,
        picked: true,
      })),
      sender: pending.plan.team.localPart,
      receive: pending.plan.receive ?? null,
    });
  }
  if (state.sender?.domain)
    return EmailGuidedAnswers.parse({
      ...base,
      with: 'domain',
      domain: state.sender.domain,
      sender: state.sender.localPart,
    });
  const suggested = emailSetupSuggestedDomain(state);
  return EmailGuidedAnswers.parse({
    ...base,
    with: suggested ? 'domain' : 'free',
    domain: suggested ?? '',
    addresses: suggested ? [{ local: 'hello', reader: 'team' }] : [],
  });
}

// ---------- "Set it up" ----------

/**
 * What the website name does once its records check out, from the answers: the address customers hear from, the
 * other new addresses (the person's own with "Let Ava read this mail" as they set it), and where the mail arrives.
 * Addresses already set up are left alone, so they aren't in it; someone else's planned address stays as it was.
 */
export function emailGuidedPlan(
  answers: EmailGuidedAnswers,
  state: Pick<EmailSetupState, 'domains' | 'addresses' | 'lookup'>,
  userId: string,
): EmailDomainPlan {
  const rows = emailGuidedRows(answers, state);
  const sender = emailGuidedSender(answers, state);
  const d = domainOf(state, answers);
  const others = (d?.plan.addresses ?? []).filter((a) => a.userId && a.userId !== userId);
  const added = rows
    .filter((r) => !r.existingId && r.local !== sender?.local)
    .map((r) => ({
      localPart: r.local,
      ...(r.reader === 'me' ? { userId, ...(r.aiReads ? { aiReads: true } : {}) } : {}),
    }));
  const taken = new Set(added.map((a) => a.localPart));
  const addresses = [...added, ...others.filter((a) => !taken.has(a.localPart))].slice(
    0,
    EMAIL_PLAN_ADDRESSES_MAX,
  );
  const receive = emailGuidedReceive(answers, state);
  return {
    ...(sender
      ? { team: { localPart: sender.local, displayName: answers.name.trim().slice(0, 120) } }
      : {}),
    ...(addresses.length ? { addresses } : {}),
    ...(!receive.fixed && receive.value !== null ? { receive: receive.value } : {}),
  };
}

// ---------- the last step, and where things stand ----------

/**
 * What's left once "Set it up" ran, for the website name's last step:
 * - `records`: its sending records aren't all found yet, so its addresses wait (mail goes from the free address);
 * - `mail`: sending works, and its mail record still has to change for mail to arrive here;
 * - `done`: nothing left.
 */
export type EmailGuidedLeft = 'records' | 'mail' | 'done';

export function emailGuidedLeft(
  d: Pick<EmailSetupDomain, 'status' | 'receiving' | 'plan'> | null,
): EmailGuidedLeft {
  if (!d) return 'done';
  if (d.status !== 'verified') return 'records';
  return d.receiving === 'pending' || d.receiving === 'lapsed' ? 'mail' : 'done';
}

/** The old mail records still to delete at the website name, for the last step: every one that isn't ours. */
export const emailGuidedOldRecords = (
  d: Pick<EmailSetupDomain, 'mxRecords'>,
  state: Pick<EmailSetupState, 'inboundMxHost'>,
): EmailMxRecord[] => emailOldMailRecords(d, state.inboundMxHost);

/** Whether our own mail record is among the name's records yet. */
export const emailGuidedOurRecordFound = (
  d: Pick<EmailSetupDomain, 'mxRecords' | 'receiving'>,
  state: Pick<EmailSetupState, 'inboundMxHost'>,
): boolean =>
  d.receiving === 'on' ||
  (d.mxRecords ?? []).some((r) => r.host === state.inboundMxHost.toLowerCase());

// ---------- "Your email so far" ----------

/** "blake@ and office@", "blake@, office@ and info@". */
export function emailGuidedList(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** One address's line under "Who reads each one": "blake@: only you, Ava off". */
export function emailGuidedReaderLine(
  r: Pick<EmailGuidedRow, 'local' | 'reader' | 'aiReads'>,
  state: Pick<EmailSetupState, 'aiTeammate'>,
): string {
  const ai = state.aiTeammate?.name ?? null;
  if (r.reader === 'team') return `${r.local}@: the team`;
  if (r.reader === 'other') return `${r.local}@: only its own person`;
  return `${r.local}@: only you${ai ? `, ${ai} ${r.aiReads ? 'on' : 'off'}` : ''}`;
}

/** The side list's answers so far, one entry a question; null where nothing was answered yet. */
export function emailGuidedSoFar(
  answers: EmailGuidedAnswers,
  state: GuidedState,
): Readonly<Record<Exclude<EmailGuidedScreen, 'review'>, readonly string[] | null>> {
  if (answers.with !== 'domain')
    return {
      which: answers.with === 'free' ? [W.soFarFree] : null,
      addresses: null,
      readers: null,
      sender: null,
      receive: null,
    };
  const domain = emailGuidedDomain(answers.domain);
  const rows = emailGuidedRows(answers, state);
  const sender = emailGuidedSender(answers, state);
  const receive = emailGuidedReceive(answers, state);
  const where = emailGuidedMailLabel(emailGuidedFound(state, answers));
  return {
    which: domain ? [W.soFarOwn(domain)] : null,
    addresses: rows.length ? [emailGuidedList(rows.map((r) => `${r.local}@`))] : null,
    readers: rows.length ? rows.map((r) => emailGuidedReaderLine(r, state)) : null,
    sender: sender ? [`${sender.local}@`] : null,
    receive:
      receive.value === null
        ? null
        : [receive.value ? 'HandsFreeOS' : where ? `Stays at ${where}` : 'Stays where it is'],
  };
}

// ---------- words ----------

const ai = (name: string | null | undefined) => name || 'your AI teammate';

export const EMAIL_GUIDED_WORDS = {
  settingUp: 'Setting up email for',
  kicker: 'Your email',
  soFar: 'Your email so far',
  steps: {
    which: 'Email',
    addresses: 'Addresses',
    readers: 'Who reads each one',
    sender: 'The one customers hear from',
    receive: 'Where your mail arrives',
  },
  soFarOwn: (domain: string) => `Your own, at ${domain}`,
  soFarFree: 'A free HandsFreeOS address',

  // Question 1
  whichTitle: 'Which email address do you want to use?',
  whichHint: 'Customers see it on booking emails, reminders and invoices.',
  own: 'My own, with my website name',
  best: 'Best',
  ownHint: (example: string) =>
    `Like ${example}. It looks the most trusted, so fewer emails land in spam.`,
  domainLabel: 'Your website name',
  domainPlaceholder: 'yourbusiness.com',
  looking: 'Looking it up…',
  foundAt: (host: string | null, mail: string | null) =>
    host && mail && mail !== host
      ? `Found it. It’s looked after at ${host}, and its mail goes to ${mail} today.`
      : host && mail
        ? `Found it. It’s looked after at ${host}, and its mail goes there today.`
        : host
          ? `Found it. It’s looked after at ${host}, and nobody gets email there yet.`
          : mail
            ? `Found it. Its mail goes to ${mail} today.`
            : 'Found it. Nobody gets email there yet.',
  foundHere: 'Found it. Its mail already comes to HandsFreeOS.',
  notFound: (domain: string) =>
    `We couldn’t find ${domain}. Check the spelling. If you just bought it, carry on: it can take a day to show up.`,
  free: 'A free HandsFreeOS address',
  freeHint: (address: string) =>
    `${address}. Works right now, with nothing to set up. You can switch to your own later.`,
  freeLabel: 'Your free address',
  pickOne: 'Pick which email you want to use.',
  domainMissing: 'Enter your website name, like yourbusiness.com, without www or https.',
  consumerDomain: (d: string) =>
    `${d} is a public email service, so it can’t send for your business. Enter a website name your business owns, or pick A free HandsFreeOS address.`,
  ourDomain: 'That website name is HandsFreeOS’s own. Enter one your business owns.',

  // Question 2
  addressesTitle: 'Which addresses do you want?',
  addressesHint: (domain: string) =>
    `Add each address you want at ${domain}. You can add more later.`,
  addAnother: 'Add another address',
  ideas: 'Ideas',
  remove: 'Remove',
  setUpAlready: 'Already set up',
  anyoneElse: (domain: string) => `Does anyone else get email at ${domain} today?`,
  anyoneElseHint: 'Add their address too, so their mail has a place to go.',
  addressMissing: 'Add at least one address, like hello or your first name.',
  alreadySetUp: (local: string) =>
    `${local}@ is already set up here, so it doesn’t need adding. Remove this row.`,
  twice: (local: string) => `${local}@ is here twice. Remove one of them.`,
  tooMany: `That’s the most a setup adds at once (${EMAIL_PLAN_ADDRESSES_MAX}). Add more later in Settings → Email.`,

  // Question 3
  readersTitle: 'Who reads each one?',
  readersHint: 'Pick who sees the mail that comes to each address.',
  whoReads: (address: string) => `Who reads ${address}`,
  onlyMe: 'Only me',
  onlyMeHint: 'Private. Nobody else can open it.',
  theTeam: 'The team',
  theTeamHint: (name: string | null) =>
    name ? `You, ${name} and anyone you add to your team.` : 'You and anyone you add to your team.',
  letAiRead: (name: string | null) => `Let ${ai(name)} read this mail`,
  letAiReadHint: (name: string | null) =>
    `Off: ${ai(name)} never sees it. On: ${ai(name)} can read it and help you answer. Your team still can’t open it.`,
  on: 'On',
  off: 'Off',
  pickedFromNames: 'We picked these from the names.',
  pickedMine: (local: string) => `${local}@ matches your name`,
  pickedShared: (local: string) => `${local}@ sounds shared`,
  changeEither: 'Change any of them.',
  changeLater: (name: string | null) =>
    `You can change all of this later in Settings → Email. Only the person an address belongs to can hand it to the team or let ${ai(name)} read it.`,
  existingReader: 'Already set up. To change who reads it, click Change on it in Settings → Email.',
  teamMissing:
    'Customers need one address the team reads, so whoever is working can answer. Make one of these The team’s, or add another address.',

  // Question 4
  senderTitle: 'Which address should customers hear from?',
  senderHint: (name: string | null) =>
    name
      ? `Booking emails, reminders, invoices and ${name}’s emails go out from it. Replies come back to it.`
      : 'Booking emails, reminders and invoices go out from it. Replies come back to it.',
  pickedForYou: 'Picked for you',
  senderTeam: 'The team reads it, so whoever is working can answer the replies.',
  senderMine:
    'Only you read this one, so it can’t send for the business. Nobody else could answer the replies.',
  senderTheirs:
    'Only one person reads this one, so it can’t send for the business. Nobody else could answer the replies.',
  preview: 'How it shows in their inbox',
  previewSubject: 'Your appointment is booked: Tue, Nov 24 at 2:00 PM',

  // Question 5
  receiveTitle: 'Where do you want to read your email?',
  goesToday: (domain: string, where: string | null) =>
    where
      ? `Mail to ${domain} goes to ${where} today.`
      : `Mail to ${domain} goes to a mailbox somewhere else today.`,
  nobodyToday: (domain: string) => `Nobody gets email at ${domain} yet.`,
  unknownToday: (domain: string) =>
    `We couldn’t tell where mail to ${domain} goes today. Pick what you want, and the last step shows what to change.`,
  hereAlready: (domain: string) =>
    `Mail to ${domain} already comes to HandsFreeOS. Nothing to pick.`,
  inHfos: 'In HandsFreeOS',
  inHfosHint: (domain: string) =>
    `All mail to ${domain} comes here. You don’t need Gmail or Outlook.`,
  showsOnlyYou: (local: string) => `${local}@ shows only to you.`,
  showsTeam: (local: string) => `${local}@ shows to the team, in the Inbox.`,
  showsTheirs: (local: string) => `${local}@ shows only to its own person.`,
  anyOther: (domain: string) =>
    `Mail to any other address at ${domain} goes to the team’s Inbox, so nothing gets lost.`,
  oldStays: (where: string | null) =>
    where
      ? `The mail you already have stays at ${where}.`
      : 'The mail you already have stays where it is.',
  onlyNew: 'Only new mail comes here, after you change one record. The last step shows you how.',
  onlyNewNone: 'Mail starts coming here after you add one record. The last step shows you how.',
  keepAt: (where: string | null) => (where ? `Keep it at ${where}` : 'Keep it where it is'),
  keepAtHint:
    'Nothing changes there. HandsFreeOS only sends, and replies to your booking emails still come to your Inbox.',
  notYet: 'Not yet',
  notYetHint:
    'HandsFreeOS only sends for now, and replies to your booking emails still come to your Inbox. You can bring mail in later from Settings → Email.',
  receiveMissing: 'Pick where you want to read your email.',

  // Check it over
  reviewKicker: 'Check it over',
  reviewTitle: 'Does this look right?',
  reviewHint:
    'Nothing changes until you click Set it up. Your answers are saved, so you can leave and come back.',
  reviewEmail: 'Your email',
  reviewAddresses: 'Addresses',
  reviewWhere: 'Where mail arrives',
  change: 'Change',
  hearFrom: 'Customers hear from this one',
  reviewOnlyYou: (name: string | null, aiReads: boolean) =>
    name
      ? aiReads
        ? `Only you read it. ${name} reads it too, and drafts answers only you see.`
        : `Only you read it. ${name} can’t read it.`
      : 'Only you read it.',
  reviewTeam: (name: string | null) =>
    name ? `The team reads it, and ${name} does too.` : 'The team reads it.',
  reviewTheirs: 'Only its own person reads it.',
  reviewNew: 'New',
  reviewOneRecord: (host: string | null) =>
    host
      ? `One record to change at ${host}. We’ll show you how on the next screen.`
      : 'One record to change where your website name is looked after. We’ll show you how on the next screen.',
  reviewRecords: (host: string | null) =>
    host
      ? `A few records to add at ${host}. We’ll show you how on the next screen.`
      : 'A few records to add where your website name is looked after. We’ll show you how on the next screen.',
  nameLabel: 'Name customers see',
  nameMissing: 'Enter the name customers see, like your business’s name.',
  backupStays: (free: string) =>
    `Your free address, ${free}, stays as a backup. Emails go out from it until your own address is ready.`,
  freeNow: (free: string) => `Emails go out from ${free} as soon as you click Set it up.`,
  setItUp: 'Set it up',

  // The last step
  lastStep: 'Last step',
  lastStepAt: (host: string | null) => (host ? `Last step · At ${host}` : 'Last step'),
  recordsTitle: (host: string | null) =>
    host ? `Add your records at ${host}` : 'Add your records',
  recordsHint: (domain: string, free: string) =>
    `Your answers are saved. These records let HandsFreeOS send as ${domain}. Until they’re found, emails go out from ${free}.`,
  mailTitle: 'Send your mail to HandsFreeOS',
  mailHint: (domain: string, where: string | null) =>
    where
      ? `Your addresses are saved. Mail to ${domain} still goes to ${where} until you swap the mail record there.`
      : `Your addresses are saved. Mail to ${domain} doesn’t come here until you add the mail record.`,
  openRecords: (host: string | null) =>
    host ? `Open your records at ${host}` : 'Open your website name’s records',
  openRecordsHow: (domain: string, host: string, where: string) =>
    `Sign in at ${host}, open ${domain}, then click ${where}.`,
  openRecordsAnywhere: (domain: string) =>
    `Sign in where ${domain} is looked after, usually where you bought it, and open its DNS records.`,
  openHost: (host: string) => `Open ${host}`,
  addSending: (n: number) => (n === 1 ? 'Add this record' : `Add these ${n} records`),
  addSendingHow: (add: string | null) =>
    add
      ? `Click ${add} for each one and copy these in. They let HandsFreeOS send as your website name.`
      : 'Add each one and copy these in. They let HandsFreeOS send as your website name.',
  addMail: 'Add our mail record',
  addMailHow: (add: string | null) =>
    add ? `Pick MX, fill these in, then click ${add}.` : 'Add an MX record and fill these in.',
  deleteOld: (n: number) =>
    n === 1 ? 'Delete the old mail record' : `Delete the ${n} old mail records`,
  deleteOldHow: (n: number, where: string | null) =>
    `${n === 1 ? 'It still sends' : 'They still send'} your mail to ${where ?? 'your old mailbox'}. Delete ${n === 1 ? 'it' : 'each one'} where your records are.`,
  type: 'Type',
  host: 'Name',
  pointsTo: 'Points to',
  value: 'Value',
  priority: 'Priority',
  found: 'Found',
  waiting: 'Waiting',
  stillThere: 'Still there',
  gone: 'Gone',
  copy: 'Copy',
  copied: 'Copied',
  notDone: 'Not done yet.',
  notDoneOld: (n: number, where: string | null) =>
    `${n === 1 ? 'The old record is' : `The ${n} old records are`} still there, so your mail still goes to ${where ?? 'your old mailbox'}. We check again on our own every few minutes.`,
  notDoneOurs: 'We haven’t found our mail record yet. We check again on our own every few minutes.',
  notDoneRecords: (found: number, of: number) =>
    `${found} of ${of} records found. We check again on our own, and you’ll get an email when they’re all in.`,
  sendSteps: 'Send these steps to the person who looks after your website',
  sendStepsTo: 'Their email',
  sendStepsSend: 'Send the steps',
  sentTo: (to: string) => `Sent to ${to}.`,
  later: 'I’ll do this later',
  checkNow: 'Check now',
  stand: 'Where things stand',
  standAddresses: 'Your addresses',
  standSaved: (names: string) => `${names} ${names.includes(' and ') ? 'are' : 'is'} saved`,
  standWaiting: (names: string) =>
    `${names} ${names.includes(' and ') ? 'are' : 'is'} made as soon as the records are found`,
  standSending: 'Sending',
  standSendingWorks: (local: string) => `Works. Customers hear from ${local}@.`,
  standSendingFree: (free: string) => `From ${free} until the records are found.`,
  standMail: 'Mail coming in',
  standMailOld: (where: string | null, n: number) =>
    `Still goes to ${where ?? 'your old mailbox'}. ${n} old ${n === 1 ? 'record' : 'records'} to delete.`,
  standMailOurs: 'Not here yet. Our mail record isn’t found.',
  standMailAfter: 'Starts once the records above are found.',
  standMailKept: (where: string | null) =>
    where ? `Stays at ${where}, as you picked.` : 'Stays where it is, as you picked.',
  nothingLost: 'Nothing is lost while you wait',
  nothingLostBody: (where: string | null) =>
    where
      ? `Mail keeps landing at ${where} like before. It starts landing here a few minutes after the old records are gone.`
      : 'It starts landing here a few minutes after the record is found.',

  // Done
  doneTitle: 'Your email is ready',
  doneMail: (domain: string, where: string | null) =>
    where
      ? `We found the change at ${where}. Mail to ${domain} now lands in HandsFreeOS.`
      : `Mail to ${domain} now lands in HandsFreeOS.`,
  doneSending: (address: string) => `Customers hear from ${address} from now on.`,
  doneOnlyYou: (name: string | null, aiReads: boolean) =>
    name
      ? aiReads
        ? `Only you read it. It sits in your Inbox, marked Only you. ${name} reads it and drafts answers for you.`
        : `Only you read it. It sits in your Inbox, marked Only you. ${name} can’t read it.`
      : 'Only you read it. It sits in your Inbox, marked Only you.',
  doneTeam: (name: string | null) =>
    name
      ? `The team reads it in the Inbox, and ${name} does too.`
      : 'The team reads it in the Inbox.',
  seeItWork: 'See it work',
  changeLaterLead: 'Want to change an address, add one, or change who reads it? It’s all in',
  settingsEmail: 'Settings → Email',
  emailSettings: 'Email settings',
  goToInbox: 'Go to the Inbox',

  // Coming back
  stoppedAtReview: 'You stopped at Check it over.',
} as const;
const W = EMAIL_GUIDED_WORDS;
