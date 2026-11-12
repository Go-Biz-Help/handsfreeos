/**
 * The changes a business's website needs before the carriers approve its texting, written for whoever looks after the
 * site (the owner, 2026-11-12): "Email your web person" sends them, each in its own text file, so the web person gets
 * one short email rather than one long one.
 *
 * Three fixes, as the owner named them: **add the form** (ours, framed on the contact page, or the box and its words
 * on a form of their own), **the privacy policy and terms** (the part about texts, word for word, and where the links
 * go) and **add the chat** (one line in the footer). The checks before a registration goes (`preflight.ts`) say which
 * ones are missing (`fixesMissing`), and the dialog ticks those.
 *
 * Written once, here: the dialog shows each file before it goes, and the worker writes the same files when it sends
 * them. Plain text on purpose: anyone can open it, and code pasted from it is exactly the code. Browser-safe.
 */
import type { PreflightCheck } from './preflight';
import { offersConsentWords, smsConsentWords } from './consent';
import { textingSection, type PolicyBusiness } from './policies';

export const WEBSITE_FIX_IDS = ['form', 'policy', 'chat'] as const;
export type WebsiteFixId = (typeof WEBSITE_FIX_IDS)[number];

/** Each fix's file, and how the dialog names it. */
export const WEBSITE_FIXES: Readonly<
  Record<WebsiteFixId, { readonly filename: string; readonly label: string; readonly hint: string }>
> = {
  form: {
    filename: 'add-the-form.txt',
    label: 'Add the sign-up form',
    hint: 'The form with the box to agree to texts, on the contact page.',
  },
  policy: {
    filename: 'privacy-policy-and-terms.txt',
    label: 'Update the privacy policy and terms',
    hint: 'The part about texts, word for word, and links to both pages.',
  },
  chat: {
    filename: 'add-the-chat.txt',
    label: 'Add the website chat',
    hint: 'One line of code in the footer, so it’s on every page.',
  },
};

/** The most web-person emails one person sends for one business in a day (`registration.email_web_person`). */
export const WEB_PERSON_EMAILS_A_DAY = 10;

/** Where a framed form goes on each site builder: an HTML or embed block, in each one's own words. */
export const FORM_EMBED_BUILDERS: readonly { readonly name: string; readonly steps: string }[] = [
  {
    name: 'WordPress',
    steps: 'Edit the page, add a “Custom HTML” block, paste the code, and press Update.',
  },
  {
    name: 'Wix',
    steps:
      'Edit the page, press Add (+), then Embed Code, then “Embed HTML”. Paste the code, then Publish.',
  },
  {
    name: 'Squarespace',
    steps: 'Edit the page, add a “Code” block, paste the code, and save.',
  },
  {
    name: 'GoDaddy',
    steps: 'Edit the page, add a section, search for “HTML”, paste the code into it, then Publish.',
  },
  {
    name: 'GoHighLevel',
    steps:
      'Open the page in the builder, add a “Custom JS/HTML” element, paste the code, then Publish.',
  },
  {
    name: 'Webflow',
    steps: 'Drag an “Embed” element onto the page, paste the code, save, then Publish.',
  },
  {
    name: 'Something else',
    steps: 'Paste the code into the page’s HTML where the form should show.',
  },
];

/** Where the chat's one line goes on each site builder: the footer, on every page. */
export const CHAT_FOOTER_BUILDERS: readonly { readonly name: string; readonly steps: string }[] = [
  {
    name: 'WordPress',
    steps:
      'Install a header and footer plugin (like WPCode), paste the line into its footer box, and save.',
  },
  {
    name: 'Wix',
    steps:
      'Go to Settings, then Custom code. Add the line, choose “All pages” and “Body - end”, apply, then Publish.',
  },
  {
    name: 'Squarespace',
    steps:
      'Go to Settings, Advanced, then Code injection. Paste the line into the Footer box and save. (It needs a business plan or higher.)',
  },
  {
    name: 'GoDaddy',
    steps:
      'Go to Settings, then Site-wide code (or add an HTML section to the footer). Paste the line, then Publish.',
  },
  {
    name: 'GoHighLevel',
    steps:
      'Open the site’s Settings, paste the line into “Footer tracking code”, save, then Publish.',
  },
  {
    name: 'Webflow',
    steps:
      'Open Site settings, then Custom code. Paste the line into “Footer code”, save, then Publish.',
  },
  {
    name: 'Something else',
    steps:
      'Paste the line just before </body> on every page. If the site uses a template, add it to the template once.',
  },
];

/** What the files are written from: the business, as the registration has it now, and what's set up for it here. */
export interface WebsiteFixFacts {
  /** The name customers know the business by: the sender in every box. */
  readonly business: string;
  /** The business's website, with its https://, when it has one. */
  readonly website: string | null;
  /** It texts offers too, so its box has a second one under it for them. */
  readonly offers: boolean;
  /**
   * The form: one of ours, framed on their page (its name, link and the code to paste), or `own`, a form of their own
   * that needs the box and its words.
   */
  readonly form:
    | {
        readonly kind: 'ours';
        readonly name: string;
        readonly publicUrl: string;
        readonly embed: string;
      }
    | { readonly kind: 'own' };
  /** The page the form goes on (the registration's page with the tick box), when it's been given. */
  readonly formPage: string | null;
  /** The business's own privacy policy and terms, when it has them; otherwise the ones we host are the ones. */
  readonly ownPrivacyUrl: string | null;
  readonly ownTermsUrl: string | null;
  /** The privacy policy and terms we host for the business (`/legal/<site>/…`), when it has a public page here. */
  readonly hostedPrivacyUrl: string | null;
  readonly hostedTermsUrl: string | null;
  /** What our policy and terms are written from, for the part about texts. */
  readonly policyBusiness: PolicyBusiness;
  /** The chat: the one line to paste, and whether it's hidden until texting is approved. */
  readonly chat: { readonly snippet: string; readonly hidden: boolean } | null;
}

/** One file, as it's attached. */
export interface WebsiteFixFile {
  readonly id: WebsiteFixId;
  readonly filename: string;
  readonly label: string;
  readonly text: string;
}

/** Why the business needs it at all, said once at the top of each file. */
const why = (business: string): string =>
  `${business} is getting its texting approved by the phone carriers. A carrier reviewer opens the website and checks it before they say yes. If something here is missing, the registration is turned down and has to wait another week or two.`;

const rule = (title: string): string => `${title}\n${'-'.repeat(title.length)}`;

const done =
  'Reply to the email this came with once it’s done, or if anything here doesn’t fit the site. We’ll check it again.';

/** The privacy policy and terms the box links to: the business's own, or else ours. */
export const privacyLinkOf = (f: WebsiteFixFacts): string | null =>
  f.ownPrivacyUrl ?? f.hostedPrivacyUrl;
export const termsLinkOf = (f: WebsiteFixFacts): string | null => f.ownTermsUrl ?? f.hostedTermsUrl;

/** Why a fix can't be written for this business yet, in words for the person sending it; null when it can. */
export function fixUnavailable(id: WebsiteFixId, f: WebsiteFixFacts): string | null {
  if (id === 'chat' && !f.chat)
    return `${f.business} has no website chat yet. Set one up in Settings → Website chat, then send this again.`;
  if (id === 'policy' && !privacyLinkOf(f))
    return `${f.business}’s privacy policy isn’t set up yet. Pick ours or give yours in the texting registration’s “Your privacy policy and terms” step, then send this again.`;
  return null;
}

function formFile(f: WebsiteFixFacts): string {
  const where = f.formPage ?? (f.website ? `the contact page on ${f.website}` : 'the contact page');
  const privacy = privacyLinkOf(f);
  const terms = termsLinkOf(f);
  if (f.form.kind === 'ours') {
    return [
      `Add the sign-up form: ${f.business}`,
      '',
      why(f.business),
      'They look for a form where customers agree to get texts. This form has that box, worded the way the carriers want.',
      '',
      rule('Where it goes'),
      `On ${where}.`,
      'If there’s no contact page, the home page is fine. Tell us which page it ends up on.',
      '',
      rule('The code'),
      'Paste this where the form should show, in an HTML or embed block:',
      '',
      f.form.embed,
      '',
      `To see the form on its own: ${f.form.publicUrl}`,
      '',
      rule('How to add it'),
      ...FORM_EMBED_BUILDERS.map((b) => `${b.name}: ${b.steps}`),
      '',
      rule('Please don’t'),
      '- Add another tick box about texts. The form already has the right one.',
      '- Make its “Text me” box ticked or required. It has to start empty and stay optional.',
      '- Leave another form on the page that asks for a phone number without that box. Take it off, or swap it for this one.',
      '',
      done,
      '',
    ].join('\n');
  }
  const care = smsConsentWords(f.business, 'form');
  const box = [`☐ ${care.title}`, `${care.detail} Privacy policy · Terms`];
  if (f.offers) {
    const extra = offersConsentWords(f.business);
    box.push('', `☐ ${extra.title}`, extra.detail);
  }
  return [
    `Add the box to agree to texts: ${f.business}`,
    '',
    why(f.business),
    'They look for a tick box beside the phone number on the website’s form, with the words below next to it.',
    '',
    rule('Where it goes'),
    `On the form on ${where}, right under the phone number field.`,
    '',
    rule('The box and its words'),
    'Copy these word for word:',
    '',
    ...box,
    '',
    `Link “Privacy policy” to ${privacy ?? 'the site’s privacy policy page'}`,
    `Link “Terms” to ${terms ?? 'the site’s terms page'}`,
    '',
    rule('The rules'),
    '- The box starts empty. Customers tick it themselves.',
    '- It isn’t required. The form sends with or without it.',
    '- The words sit right beside the box, not in a pop-up or a footnote.',
    '- Don’t add a second box about texts anywhere else on the form.',
    ...(f.offers ? ['- Offers get their own box, under the first, and it starts empty too.'] : []),
    '',
    done,
    '',
  ].join('\n');
}

function policyFile(f: WebsiteFixFacts): string {
  const privacy = textingSection('privacy', f.policyBusiness);
  const terms = textingSection('terms', f.policyBusiness);
  const part = (
    what: 'privacy policy' | 'terms',
    own: string | null,
    hosted: string | null,
    section: { heading: string; paragraphs: readonly string[] },
  ): string[] => {
    const words = [section.heading, '', ...section.paragraphs.flatMap((p) => [p, ''])];
    const title = what === 'privacy policy' ? 'Privacy policy' : 'Terms';
    if (own)
      return [rule(title), `Add this part to the ${what} at ${own}, word for word:`, '', ...words];
    if (hosted)
      return [
        rule(title),
        `We host ${f.business}’s ${what} here: ${hosted}`,
        `Put a link to it, called “${title}”, in the footer of every page.`,
        `If the site has a ${what} page of its own, add the part below to it as well, so the two agree:`,
        '',
        ...words,
      ];
    return [
      rule(title),
      `Add a ${what} page to the site with this part in it, word for word, and link it in the footer of every page:`,
      '',
      ...words,
    ];
  };
  return [
    `Update the privacy policy and terms: ${f.business}`,
    '',
    why(f.business),
    'The reviewer reads the privacy policy and terms for what they say about texts. Their wording matters, so please don’t change it.',
    '',
    ...part('privacy policy', f.ownPrivacyUrl, f.hostedPrivacyUrl, privacy),
    ...part('terms', f.ownTermsUrl, f.hostedTermsUrl, terms),
    'The last paragraph of the privacy policy part is the one reviewers look for, sentence by sentence.',
    '',
    done,
    '',
  ].join('\n');
}

function chatFile(f: WebsiteFixFacts): string {
  const chat = f.chat!;
  return [
    `Add the website chat: ${f.business}`,
    '',
    why(f.business),
    'The chat is how customers agree to texts on this site: after a visitor’s first message, it asks for their name, mobile and email, with the box to agree and links to the privacy policy and terms.',
    '',
    rule('The code'),
    'Paste this one line just before </body>, once, so it’s on every page:',
    '',
    chat.snippet,
    '',
    rule('How to add it'),
    ...CHAT_FOOTER_BUILDERS.map((b) => `${b.name}: ${b.steps}`),
    '',
    rule('Check it'),
    chat.hidden
      ? 'The chat stays hidden until texting is approved, then shows up by itself. That’s on purpose, so add the line now anyway.'
      : 'Open the site and press the chat button once. That tells us it’s on.',
    '',
    done,
    '',
  ].join('\n');
}

/** The files for the fixes picked, in the order the dialog lists them. A fix that can't be written is left out. */
export function websiteFixFiles(
  f: WebsiteFixFacts,
  picked: readonly WebsiteFixId[],
): WebsiteFixFile[] {
  return WEBSITE_FIX_IDS.filter((id) => picked.includes(id) && !fixUnavailable(id, f)).map(
    (id) => ({
      id,
      filename: WEBSITE_FIXES[id].filename,
      label: WEBSITE_FIXES[id].label,
      text: id === 'form' ? formFile(f) : id === 'policy' ? policyFile(f) : chatFile(f),
    }),
  );
}

/** The email the files go with: short, because the files say the rest. */
export function webPersonEmail(input: {
  readonly business: string;
  /** Their first name, when the sender typed one. */
  readonly recipientName?: string | null;
  /** Whoever pressed Send: the email says replies go to them. */
  readonly sender: { readonly name: string; readonly email: string };
  readonly files: readonly Pick<WebsiteFixFile, 'filename' | 'label'>[];
  readonly note?: string | null;
}): { subject: string; text: string } {
  const first = input.recipientName?.trim().split(/\s+/)[0];
  const many = input.files.length > 1;
  const note = input.note?.trim();
  const senderName = input.sender.name.trim() || input.sender.email;
  return {
    subject: `Website ${many ? 'changes' : 'change'} for ${input.business}’s texting approval`,
    text: [
      first ? `Hi ${first},` : 'Hi,',
      '',
      `${input.business} is getting its texting approved by the phone carriers. Before they say yes, the website needs ${many ? `${input.files.length} changes. Each one is in its own file, attached` : 'one change. It’s in the file attached'}:`,
      '',
      ...input.files.map((file, i) => `${many ? `${i + 1}. ` : ''}${file.label}: ${file.filename}`),
      ...(note ? ['', `A note from ${senderName}:`, note] : []),
      '',
      `Please reply to this email when it’s done, or with any questions. Your reply goes to ${senderName} (${input.sender.email}).`,
      '',
      'Thanks,',
      senderName,
      input.business,
    ].join('\n'),
  };
}

/**
 * Which fixes the checks before a registration goes found missing: the box (`opt_in_surface`, or another way on a
 * page of their own), the policy or terms, and the chat on the site. The dialog ticks these for the person.
 */
export function fixesMissing(
  checks: readonly Pick<PreflightCheck, 'id' | 'ok'>[],
  path: 'hosted' | 'own_site' | 'in_person' | null,
): WebsiteFixId[] {
  const failed = (id: string) => checks.some((c) => c.id === id && !c.ok);
  const out: WebsiteFixId[] = [];
  if (path === 'own_site' && failed('opt_in_surface')) out.push('form');
  if (failed('policy') || failed('terms')) out.push('policy');
  if (failed('chat_on_site') || (path === 'hosted' && failed('opt_in_surface'))) out.push('chat');
  return out;
}

/** What the dialog ticks with no checks to go by: what the way customers agree needs on the site. */
export function fixesForPath(path: 'hosted' | 'own_site' | 'in_person' | null): WebsiteFixId[] {
  if (path === 'own_site') return ['form', 'policy'];
  if (path === 'hosted') return ['chat', 'policy'];
  return ['policy'];
}
