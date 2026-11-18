/**
 * Every form on a business's website, read the way a carrier's reviewer reads them (owner, 2026-11-18).
 *
 * **Why.** A reviewer doesn't stop at the page the registration names. Shop Your Solar's campaign named its home page
 * form, which was fine, and was turned down anyway (Twilio 30923, "forced consent"): the reviewer clicked through to
 * /instant-quote and found a HighLevel form whose two texting boxes both had to be ticked, one of them for marketing
 * texts on a customer care campaign. The site's Create Account page asked for a phone number too, under "By creating
 * an account, you may receive newsletters or promotions." Neither was in the registration. So before it goes, the
 * worker opens every page of the site (and the forms framed on them) and this says which forms a reviewer would hold
 * against it.
 *
 * **What counts.** A form that asks for a phone number, or has a box to agree to texts. A search box, a sign-in or an
 * email-only newsletter isn't how anybody agrees to texts, so it doesn't count. A form that counts must be one the
 * registration names (its page, or the framed form's own address), and wherever it is:
 * - its texting boxes start empty and can be left empty;
 * - it doesn't ask for marketing texts when the registration says customer care only;
 * - it doesn't say that sending it is agreeing ("By creating an account, you may receive…").
 *
 * Split like `preflight.ts`: the worker fetches (`apps/worker/src/http/site-forms.ts`), this reads and judges, so all
 * of it can be tested without a network.
 */
import { boxRequired, plainText, tagAttr, withoutScripts, type PreflightCheck } from './preflight';

/** One box on a form that asks to send texts. */
export interface TextingBox {
  /** What it says, as the page says it. */
  readonly words: string;
  /** The form can't be sent without ticking it. */
  readonly required: boolean;
  /** It is ticked before anyone touches it. */
  readonly preTicked: boolean;
  /** It asks to send offers, promotions or marketing. */
  readonly marketing: boolean;
}

/** One form as a page carries it (`formsOn`). */
export interface FoundForm {
  /** It has a field for a phone number. */
  readonly asksPhone: boolean;
  readonly boxes: readonly TextingBox[];
  /**
   * Words that make sending the form the same as agreeing to texts or promotions, quoted as the page has them ("By
   * creating an account, you may receive newsletters or promotions."). Null when there are none.
   */
  readonly tiedWords: string | null;
  /** The same form reads the same wherever it is: a footer form on every page is one form. */
  readonly key: string;
}

/** A form found on the site: the page it is on, and the framed form's own address when it is framed there. */
export interface SiteForm extends FoundForm {
  readonly page: string;
  readonly framedUrl?: string | null;
}

/** What the worker found going through the site. */
export interface SiteScan {
  /** Pages of the site that opened (framed forms aren't counted). */
  readonly opened: number;
  /** It stopped at its page or time limit, so some of the site wasn't looked at. */
  readonly cut: boolean;
  /** Every form that counts (`formCounts`), on every page it was found on. */
  readonly forms: readonly SiteForm[];
  /** Pages that showed a robot check instead of themselves, and who showed it (`robotCheckWho`). */
  readonly blocked: readonly { readonly url: string; readonly who: string }[];
}

// ---------- reading a page ----------

/** Types of input that are never a phone number, whatever they're called. */
const NOT_TYPED_IN =
  /^(hidden|checkbox|radio|submit|button|reset|image|file|password|email|date|time|color|range|search)$/i;

/** Is this `<input>` where a phone number goes? */
function phoneField(tag: string): boolean {
  const type = (tagAttr(tag, 'type') ?? 'text').trim();
  if (/^tel$/i.test(type)) return true;
  if (NOT_TYPED_IN.test(type)) return false;
  if (/^tel/i.test(tagAttr(tag, 'autocomplete') ?? '')) return true;
  const said = ['name', 'id', 'placeholder', 'aria-label', 'data-q', 'data-aid']
    .map((a) => tagAttr(tag, a) ?? '')
    .join(' ');
  return /phone|mobile|\bcell\b|cellphone|\bsms\b/i.test(said);
}

/** Does a box's wording ask to send texts? It names texts and asks for a yes (or tells how to stop). */
const isTexting = (words: string): boolean =>
  /\b(sms|texts?|texting|text messages?|messages?|messaging)\b/.test(words) &&
  /\b(stop|consent|agree|receive|opt|text me|send me)\b/.test(words);

/** Does a box's wording ask to send offers rather than texts about the customer's own business? */
const MARKETING_RE =
  /\b(marketing|promotions?|promotional|promos?|offers?|discounts?|deals|coupons?|newsletters?|specials|sales events?)\b/;

/**
 * Words that make sending a form the agreement: "By creating an account, you may receive newsletters or promotions",
 * "By submitting this form you agree to receive text messages". Tick-box wording ("By checking this box, I consent…")
 * isn't this: a box can be left unticked.
 */
const TIED_RE =
  /\bby (creating|signing up|submitting|registering|clicking|pressing|tapping|continuing|providing|entering|completing|joining|subscribing|giving|sharing)\b[^.!?]{0,200}?\b(agree|consent|may receive|will receive|to receive|accept|authori[sz]e|opt(ing)? in)\b[^.!?]{0,200}?\b(texts?|sms|text messages?|messages|newsletters?|promotions?|promotional|marketing|offers|calls)\b[^.!?]*[.!?]?/i;

/** What a tick box says: its own label, else the words that follow it up to the next field. */
function boxWords(clean: string, at: number, tag: string): string {
  const aria = tagAttr(tag, 'aria-label');
  if (aria && aria.trim().length > 20) return plainText(aria);
  const id = tagAttr(tag, 'id');
  if (id) {
    const safe = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const label = new RegExp(
      `<label\\b[^>]*\\sfor\\s*=\\s*["']?${safe}["']?[^>]*>([\\s\\S]*?)</label>`,
      'i',
    ).exec(clean);
    if (label?.[1] && plainText(label[1])) return plainText(label[1]);
  }
  // A box inside its label, or followed by its words.
  const after = clean.slice(at + tag.length, at + tag.length + 1500);
  const end = after.search(/<input\b|<\/form>|<button\b|<select\b|<textarea\b/i);
  return plainText(end < 0 ? after : after.slice(0, end)).slice(0, 600);
}

/** The forms in a page's HTML, with the pieces that decide whether a reviewer would hold one against it. */
export function formsOn(html: string): FoundForm[] {
  const clean = withoutScripts(html);
  const spans: { from: number; to: number }[] = [];
  const close = /<\/form\s*>/gi;
  for (const m of clean.matchAll(/<form\b[^>]*>/gi)) {
    const from = m.index ?? 0;
    if (spans.length && from < spans[spans.length - 1]!.to) continue;
    close.lastIndex = from;
    const end = close.exec(clean);
    spans.push({ from, to: end ? end.index + end[0].length : clean.length });
  }
  // Pages drawn by code often never wrap their fields in a <form>: those fields are read as one more form.
  const inside = (at: number) => spans.some((s) => at >= s.from && at < s.to);
  const loose = [...clean.matchAll(/<input\b[^>]*>/gi)].filter((m) => !inside(m.index ?? 0));
  const parts = spans.map((s) => ({ ...s, inputs: inputsIn(clean, s.from, s.to) }));
  if (loose.some((m) => phoneField(m[0]) || /type\s*=\s*["']?checkbox/i.test(m[0])))
    parts.push({
      from: loose[0]!.index ?? 0,
      to: (loose[loose.length - 1]!.index ?? 0) + loose[loose.length - 1]![0].length,
      inputs: loose.map((m) => ({ at: m.index ?? 0, tag: m[0] })),
    });

  return parts.map(({ from, to, inputs }) => {
    const boxes: TextingBox[] = [];
    for (const input of inputs) {
      if (!/type\s*=\s*["']?checkbox/i.test(input.tag)) continue;
      const words = boxWords(clean, input.at, input.tag);
      const said = words.toLowerCase();
      if (!isTexting(said)) continue;
      boxes.push({
        words,
        required: boxRequired(input.tag),
        preTicked: /\schecked(?=[\s=/>])/i.test(input.tag),
        marketing: MARKETING_RE.test(said),
      });
    }
    // The line tying the form to texts is often just above it ("By creating an account, you may receive…").
    const text = plainText(clean.slice(Math.max(0, from - 1500), to));
    // Quoted without its full stop, so the sentence it's quoted in can carry on.
    const tied =
      TIED_RE.exec(text)?.[0]
        ?.trim()
        .replace(/[.!?]+$/, '') ?? null;
    const names = inputs
      .filter((i) => !/type\s*=\s*["']?(hidden|submit|button)/i.test(i.tag))
      .map((i) => tagAttr(i.tag, 'name') ?? tagAttr(i.tag, 'type') ?? '')
      .join(',');
    return {
      asksPhone: inputs.some((i) => phoneField(i.tag)),
      boxes,
      tiedWords: tied && !boxes.some((b) => b.words.includes(tied)) ? tied.slice(0, 240) : null,
      key: `${names}|${boxes.map((b) => b.words.slice(0, 80)).join('|')}`.slice(0, 600),
    };
  });
}

function inputsIn(clean: string, from: number, to: number): { at: number; tag: string }[] {
  return [...clean.slice(from, to).matchAll(/<input\b[^>]*>/gi)].map((m) => ({
    at: from + (m.index ?? 0),
    tag: m[0],
  }));
}

/** Whether a form is one a reviewer looks at for agreeing to texts: it asks for a phone number or has a texting box. */
export const formCounts = (form: FoundForm): boolean => form.asksPhone || form.boxes.length > 0;

// ---------- addresses ----------

/** An address as two people would call it the same page: no www, no query, no fragment, no trailing slash. */
export function pageKey(raw: string | null | undefined): string | null {
  const value = (raw ?? '').trim();
  if (!value) return null;
  try {
    const u = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
    const path = u.pathname.replace(/\/+$/, '') || '/';
    return `${u.host.toLowerCase().replace(/^www\./, '')}${path.toLowerCase()}`;
  } catch {
    return null;
  }
}

/** How an address reads in a sentence: host without www, then the path ("shopyoursolar.com/instant-quote"). */
export function shortAddress(raw: string): string {
  const key = pageKey(raw);
  return key ? key.replace(/\/$/, '') : raw;
}

// ---------- the verdict ----------

/** The way the business picked "What you will text about" in the wizard, as the carriers are told. */
type UseCase = 'customer_care' | 'mixed' | 'marketing' | string;

/** Joins things the way a sentence lists them: "a, b and c". */
const sentenceList = (items: readonly string[]): string =>
  items.length <= 1
    ? (items[0] ?? '')
    : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;

/** The most rows of separate forms the review lists; the rest are counted on the last one. */
const MAX_ROWS = 6;

/**
 * What a reviewer would hold against the forms on the site, as review rows: one row per form with something wrong
 * (the same form on many pages is one row), or one green row when nothing is.
 *
 * `named` are the addresses the registration gives (the page with the box, each other way's page, and the framed
 * forms found on them). Returns nothing when no page opened: the website's own row already says so.
 */
export function checkSiteForms(
  scan: SiteScan | null,
  input: {
    readonly named: readonly (string | null | undefined)[];
    readonly useCase?: UseCase | null;
  },
): PreflightCheck[] {
  if (!scan || scan.opened === 0) return [];
  const named = new Set(input.named.map(pageKey).filter((k): k is string => !!k));
  const isNamed = (f: SiteForm) =>
    named.has(pageKey(f.page) ?? '') || (!!f.framedUrl && named.has(pageKey(f.framedUrl) ?? ''));

  // One form, wherever it shows: a framed form by its own address, any other by what it asks.
  const groups = new Map<string, SiteForm[]>();
  for (const form of scan.forms.filter(formCounts)) {
    const key = form.framedUrl ? `frame:${pageKey(form.framedUrl)}` : `form:${form.key}`;
    groups.set(key, [...(groups.get(key) ?? []), form]);
  }

  const rows: { form: SiteForm; pages: string[]; detail: string }[] = [];
  for (const forms of groups.values()) {
    const form = forms[0]!;
    const pages = [...new Set(forms.map((f) => f.page))];
    const known = forms.some(isNamed);
    const boxes = form.boxes;
    // A named page's one box is the main check's (`checkOptInSurface`); a second box there, or any box elsewhere, is ours.
    const ours = !known || boxes.length > 1;
    const wrong: string[] = [];
    const fixes: string[] = [];
    const subject = form.framedUrl
      ? `The form shown on this page (from ${new URL(form.framedUrl).host.replace(/^www\./, '')})`
      : 'The form on this page';
    if (!known)
      wrong.push(
        form.asksPhone
          ? `${subject} asks for a phone number, and your registration doesn’t name it.`
          : `${subject} has a box to agree to texts, and your registration doesn’t name it.`,
      );
    const many = boxes.length > 1;
    if (ours && boxes.some((b) => b.required))
      wrong.push(
        many
          ? 'Its boxes to agree to texts have to be ticked before it can be sent.'
          : 'Its box to agree to texts has to be ticked before it can be sent.',
      );
    if (ours && boxes.some((b) => b.preTicked))
      wrong.push(
        many
          ? 'Its boxes to agree to texts start ticked.'
          : 'Its box to agree to texts starts ticked.',
      );
    if (ours && (boxes.some((b) => b.required) || boxes.some((b) => b.preTicked)))
      fixes.push('Make every box to agree to texts optional, and empty to start.');
    const marketing = input.useCase === 'customer_care' && boxes.some((b) => b.marketing);
    if (marketing) {
      wrong.push(
        'It asks people to agree to marketing texts, but you registered for customer care texts only.',
      );
      fixes.push(
        'Take the marketing box off. If you do send offers, go back to “What you will text about” and pick “Customer care, and the odd promotion” instead.',
      );
    }
    if (form.tiedWords && form.asksPhone) {
      wrong.push(
        `It says “${form.tiedWords}”, so sending it counts as agreeing, and agreeing has to be a choice.`,
      );
      fixes.push('Take that line off, or swap it for a box people can leave empty.');
    }
    if (!known) {
      const then = fixes.length ? 'Then ' : '';
      fixes.push(
        boxes.length
          ? `${then}${then ? 'add' : 'Add'} this page under “Any other ways customers agree?” in the “How customers agree” step, or take the form off your site.`
          : `${then}${then ? 'take' : 'Take'} the phone number off this form, or take the form off your site. If customers should agree to texts here, add the box with the words from the “How customers agree” step, and list this page under “Any other ways customers agree?”.`,
      );
    }
    if (!wrong.length) continue;
    const also = pages.length > 1 ? ` It’s also on ${alsoOn(pages.slice(1))}.` : '';
    const fix = fixes.length ? ` ${fixes.join(' ')}` : '';
    rows.push({ form, pages, detail: `${wrong.join(' ')}${also}${fix}` });
  }

  const blocked = scan.blocked.length
    ? `${scan.blocked.length === 1 ? 'One page' : `${scan.blocked.length} pages`} showed us a robot check from ${scan.blocked[0]!.who} instead of ${scan.blocked.length === 1 ? 'itself' : 'themselves'}, so we couldn’t look for forms there.`
    : '';
  const cut = scan.cut
    ? ` We stopped after ${scan.opened} pages, so pages further in weren’t looked at.`
    : '';

  if (!rows.length) {
    const left = blocked
      ? ' Press “Ask HandsFreeOS to check it” below and we’ll look ourselves.'
      : '';
    return [
      {
        id: 'site_forms',
        label: 'No other forms on your site',
        severity: 'warning',
        ok: !blocked,
        detail: `We opened ${scan.opened === 1 ? 'one page' : `${scan.opened} pages`} of your site. Every form that asks for a phone number is one your registration names, and every box to agree to texts is optional.${cut}${blocked ? ` ${blocked}${left}` : ''}`,
        url: null,
      },
    ];
  }

  const shown = rows.slice(0, MAX_ROWS);
  const more = rows.length - shown.length;
  return shown.map((row, i) => ({
    id: `site_form_${i}` as const,
    label: `A form on ${shortAddress(row.pages[0]!)}`,
    severity: 'blocker' as const,
    ok: false,
    detail:
      row.detail +
      (i === shown.length - 1 && more
        ? ` We found ${more === 1 ? 'one more form' : `${more} more forms`} like this. Fix these and check again to see ${more === 1 ? 'it' : 'them'}.`
        : '') +
      (i === shown.length - 1 ? cut : ''),
    url: row.pages[0]!,
  }));
}

/** "/a", "/a and /b", or "/a, /b and 3 more pages". */
function alsoOn(pages: readonly string[]): string {
  const paths = pages.map((p) => shortAddress(p));
  if (paths.length <= 2) return sentenceList(paths);
  return `${paths.slice(0, 2).join(', ')} and ${paths.length - 2} more ${paths.length - 2 === 1 ? 'page' : 'pages'}`;
}
