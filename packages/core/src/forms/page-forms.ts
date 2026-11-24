/**
 * The forms on a web page, read so the form builder can make them (the owner, 2026-11-24: "send a link, have the AI
 * see the form(s) on the page and be able to create those as well, including if the form has drop down options or
 * things not viewable until opened").
 *
 * **Read from the page's HTML, not a screen.** A dropdown's choices, a later step of a form that goes a step at a
 * time, and a part that shows only once something is picked are all in the HTML before anyone opens them, so the
 * outline has every one of them, marked for what it is. A form a site draws with code after the page loads (Typeform,
 * Wix) has nothing in its HTML to read: `formsOnPage` then finds nothing, and the person is asked for a screenshot.
 * A Google Form keeps every question, its sections included, in the page's data, which is read instead of its HTML.
 *
 * **An outline, not markup.** Each form becomes lines of its words and its boxes ("[dropdown, required: Lawn |
 * Snow]"), which reads well to a model and survives being quoted as data. Split like `messaging/site-forms.ts`: the
 * worker fetches the page and the forms framed on it (`apps/worker/src/forms/page-forms.ts`), this only reads, so all
 * of it can be tested without a network. Browser-safe.
 */

/** One form found on a page. */
export interface PageForm {
  /** 1, 2, 3… in the order they are on the page (and its frames after it). */
  readonly number: number;
  /** What the page calls it: the heading above it, its legend, its label or the page's title. Null when none says. */
  readonly title: string | null;
  /** How many boxes it has for a person to fill in or pick in. */
  readonly fields: number;
  /** A line to tell it apart from the page's other forms ("Name · Email · Service"). */
  readonly summary: string;
  /** The form as the builder reads it: its words, its boxes, every dropdown's choices, steps and hidden parts marked. */
  readonly outline: string;
  /** Where it was read: the page, or the form framed on it. */
  readonly url: string;
}

/** The longest outline kept for one form: a long form's questions fit many times over. */
export const PAGE_FORM_OUTLINE_MAX = 20_000;
/** The most forms read from one page (its frames included). */
export const PAGE_FORMS_MAX = 8;

const VOID = new Set([
  'input',
  'br',
  'img',
  'hr',
  'meta',
  'link',
  'source',
  'wbr',
  'area',
  'col',
  'embed',
  'param',
  'track',
  'base',
]);
/** Tags that start a new line in the outline. */
const BLOCK = new Set([
  'p',
  'div',
  'li',
  'br',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'label',
  'fieldset',
  'legend',
  'tr',
  'section',
  'form',
  'ul',
  'ol',
  'table',
  'hr',
  'dt',
  'dd',
  'article',
  'header',
  'footer',
]);
/** Kinds of input box nobody fills in. */
const NOT_FILLED = new Set(['hidden', 'submit', 'button', 'image', 'reset']);
const INPUT_WORDS: Readonly<Record<string, string>> = {
  text: 'short answer box',
  email: 'email box',
  tel: 'phone box',
  number: 'number box',
  date: 'date box',
  'datetime-local': 'date and time box',
  time: 'time box',
  month: 'month box',
  week: 'week box',
  url: 'website box',
  file: 'file upload',
  range: 'slider',
  color: 'color picker',
  search: 'search box',
  password: 'password box',
};

/** The few entities a page's words are written with, and numbered ones. */
export function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]{1,6});/gi, (_, hex: string) => safeChar(parseInt(hex, 16)))
    .replace(/&#(\d{1,7});/g, (_, dec: string) => safeChar(Number(dec)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&rsquo;|&lsquo;/gi, '’')
    .replace(/&rdquo;|&ldquo;/gi, '"')
    .replace(/&ndash;/gi, '–')
    .replace(/&mdash;/gi, '—')
    .replace(/&hellip;/gi, '…')
    .replace(/&amp;/gi, '&');
}

function safeChar(code: number): string {
  try {
    return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : ' ';
  } catch {
    return ' ';
  }
}

/** One attribute of a tag, quoted or not, entities undone; null when it isn't there. */
function attr(tag: string, name: string): string | null {
  const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  if (m) return decodeEntities(m[1] ?? m[2] ?? m[3] ?? '').trim();
  return new RegExp(`\\s${name}(?=[\\s/>])`, 'i').test(tag) ? '' : null;
}

const has = (tag: string, name: string): boolean => attr(tag, name) !== null;

/** Comments, scripts, styles, pictures drawn in code and the page's head, taken out. */
function cleaned(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|template|head|iframe)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ');
}

const squash = (text: string): string => decodeEntities(text).replace(/\s+/g, ' ').trim();

/** Whether a tag hides what's inside it until something happens. */
function hiddenTag(tag: string): boolean {
  if (has(tag, 'hidden')) return true;
  const style = attr(tag, 'style') ?? '';
  if (/display\s*:\s*none|visibility\s*:\s*hidden/i.test(style)) return true;
  const classes = (attr(tag, 'class') ?? '').toLowerCase().split(/\s+/);
  return classes.some((c) => /^(hidden|d-none|is-hidden|hide|gf_hidden|elementor-hidden)$/.test(c));
}

/** A box a page hides to catch robots ("leave this field empty"): never one of the form's questions. */
function robotTrap(tag: string): boolean {
  const classes = (attr(tag, 'class') ?? '').toLowerCase();
  return /gform_validation_container|honeypot|\bhp-field|ohnohoney|wpforms-field-hp|ak_hp|cf7-hp|nf-field-hp/.test(
    classes,
  );
}

/** Whether a tag is one step of a form that goes a step at a time. */
function stepTag(tag: string): boolean {
  if (has(tag, 'data-step') || has(tag, 'data-page')) return true;
  const classes = (attr(tag, 'class') ?? '').toLowerCase().split(/\s+/);
  return classes.some((c) =>
    /^(gform_page|wpforms-page|form-step|step|formstep|multi-step-page|jf-page|e-form__step|fluentform-step|ff-step-body)$|^(step|page)-\d+$/.test(
      c,
    ),
  );
}

/** Whether a tag holds a part that shows only when an earlier answer fits. */
function conditionalTag(tag: string): boolean {
  const classes = (attr(tag, 'class') ?? '').toLowerCase();
  return (
    /conditional|has-condition|ff_excluded|dependent/.test(classes) ||
    has(tag, 'data-conditional-logic')
  );
}

/** What a box says about itself, beyond its kind: its name, placeholder, limits and whether it must be filled in. */
function boxDetails(tag: string): string {
  const parts: string[] = [];
  const label = attr(tag, 'aria-label') || attr(tag, 'title');
  if (label) parts.push(`labelled "${label}"`);
  const placeholder = attr(tag, 'placeholder');
  if (placeholder) parts.push(`placeholder "${placeholder}"`);
  const name = attr(tag, 'name');
  if (name && !/^(input_\d+|field\d*|wpforms\[fields\]\[\d+\])/i.test(name) && name.length <= 60)
    parts.push(`name "${name}"`);
  const min = attr(tag, 'min');
  const max = attr(tag, 'max');
  if (min) parts.push(`at least ${min}`);
  if (max) parts.push(`at most ${max}`);
  const accept = attr(tag, 'accept');
  if (accept) parts.push(`takes ${accept}`);
  if (has(tag, 'multiple')) parts.push('more than one');
  if (
    has(tag, 'required') ||
    /^true$/i.test(attr(tag, 'aria-required') ?? '') ||
    /^true$/i.test(attr(tag, 'data-required') ?? '')
  )
    parts.push('required');
  return parts.length ? `, ${parts.join(', ')}` : '';
}

/** Counts the boxes a person fills in or picks in. Radio buttons sharing a name count once. */
export function countFields(html: string): number {
  const clean = cleaned(html);
  let n = 0;
  const radios = new Set<string>();
  for (const m of clean.matchAll(/<(input|select|textarea)\b[^>]*>/gi)) {
    const tag = m[0];
    const kind = m[1]!.toLowerCase();
    if (kind !== 'input') {
      n++;
      continue;
    }
    const type = (attr(tag, 'type') ?? 'text').toLowerCase();
    if (NOT_FILLED.has(type)) continue;
    if (type === 'radio') {
      const name = attr(tag, 'name') ?? `#${m.index}`;
      if (radios.has(name)) continue;
      radios.add(name);
    }
    n++;
  }
  return n;
}

/**
 * A stretch of HTML as an outline: its words, a line per block, each box in square brackets, a dropdown with all its
 * choices, and the parts a person can't see yet marked where they start and end.
 */
export function pageFormOutline(html: string): string {
  const clean = cleaned(html);
  const out: string[] = [];
  let line = '';
  const flush = () => {
    const t = line.replace(/\s+/g, ' ').trim();
    if (t) out.push(t);
    line = '';
  };
  const say = (text: string) => {
    line += text;
  };
  /** Open elements, and what to say when each closes (only the ones that said something as they opened). */
  const stack: { name: string; closing: string | null }[] = [];
  let steps = 0;
  /** A dropdown being read: its tag and choices so far. */
  let select: {
    tag: string;
    choices: string[];
    group: string | null;
    option: string | null;
  } | null = null;
  /**
   * Inside something whose words aren't the form's own: a text area's starting text, a button's words (said once it
   * closes), or a box a page hides from robots (said not at all). `depth` counts the same tag opened inside it.
   */
  let skipping: { name: string; words: string; depth: number; button: boolean } | null = null;

  const tokens = clean.matchAll(/<(\/?)([a-zA-Z][\w:-]*)\b[^>]*>|[^<]+/g);
  for (const m of tokens) {
    const raw = m[0];
    if (!raw.startsWith('<')) {
      const text = decodeEntities(raw);
      if (select) {
        if (select.option !== null) select.option += text;
      } else if (skipping) skipping.words += text;
      else say(text);
      continue;
    }
    const closing = m[1] === '/';
    const name = m[2]!.toLowerCase();

    if (select) {
      if (name === 'option' && !closing) {
        if (select.option !== null) endOption(select);
        select.option = '';
        if (has(raw, 'disabled') && !attr(raw, 'value')) select.option = '\u0000';
      } else if (name === 'option' && closing) endOption(select);
      else if (name === 'optgroup' && !closing) select.group = attr(raw, 'label');
      else if (name === 'select' && closing) {
        if (select.option !== null) endOption(select);
        const pickAny = has(select.tag, 'multiple');
        say(
          ` [${pickAny ? 'list to pick any of' : 'dropdown'}${boxDetails(select.tag).replace(', more than one', '')}: ${
            select.choices.join(' | ') || 'no choices'
          }] `,
        );
        select = null;
      }
      continue;
    }
    if (skipping) {
      if (name === skipping.name && !closing && !VOID.has(name)) skipping.depth++;
      else if (name === skipping.name && closing && --skipping.depth <= 0) {
        if (skipping.button) {
          const words = squash(skipping.words);
          if (words) say(` [button: ${words}] `);
        }
        skipping = null;
      }
      continue;
    }

    if (closing) {
      // Close back to the matching element, saying the end of any part that was marked.
      const at = stack.map((s) => s.name).lastIndexOf(name);
      if (at < 0) continue;
      while (stack.length > at) {
        const open = stack.pop()!;
        if (open.closing) {
          flush();
          out.push(open.closing);
        }
      }
      // A label's box usually comes right after it: they stay on one line, and the next block starts a new one.
      if (BLOCK.has(name) && name !== 'label') flush();
      continue;
    }

    if (BLOCK.has(name)) flush();
    if (!VOID.has(name) && robotTrap(raw)) {
      skipping = { name, words: '', depth: 1, button: false };
      continue;
    }
    switch (name) {
      case 'input': {
        const type = (attr(raw, 'type') ?? 'text').toLowerCase();
        if (type === 'hidden') break;
        if (type === 'submit' || type === 'button' || type === 'image' || type === 'reset') {
          const words = attr(raw, 'value') || attr(raw, 'alt');
          if (words && type !== 'reset') say(` [button: ${words}] `);
          break;
        }
        const required = boxDetails(raw).includes('required') ? ' (required)' : '';
        if (type === 'checkbox') say(` [tick box${checked(raw)}${required}] `);
        else if (type === 'radio') say(` (pick one${checked(raw)}${required}) `);
        else say(` [${INPUT_WORDS[type] ?? 'short answer box'}${boxDetails(raw)}] `);
        break;
      }
      case 'select':
        select = { tag: raw, choices: [], group: null, option: null };
        break;
      case 'textarea':
        say(` [long answer box${boxDetails(raw)}] `);
        skipping = { name, words: '', depth: 1, button: false };
        break;
      case 'button':
        skipping = {
          name,
          words: '',
          depth: 1,
          button: (attr(raw, 'type') ?? 'submit').toLowerCase() !== 'reset',
        };
        break;
      case 'img': {
        const alt = attr(raw, 'alt');
        if (alt) say(` (picture: ${alt}) `);
        break;
      }
      default:
        break;
    }
    if (VOID.has(name) || name === 'select' || name === 'textarea' || name === 'button') continue;

    // An element that hides what's inside it, or is one step of several: said where it starts and ends.
    let opening: string | null = null;
    let ending: string | null = null;
    if (stepTag(raw)) {
      steps++;
      opening = `--- Step ${steps}${hiddenTag(raw) && steps > 1 ? ' (shows after Next is pressed)' : ''} ---`;
    } else if (conditionalTag(raw)) {
      opening = '{Shows only when an earlier answer fits:';
      ending = '}';
    } else if (hiddenTag(raw)) {
      opening = '{Hidden until something on the form shows it:';
      ending = '}';
    }
    if (opening) {
      flush();
      out.push(opening);
    }
    stack.push({ name, closing: ending });
  }
  flush();
  const text = out
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text.length > PAGE_FORM_OUTLINE_MAX
    ? `${text.slice(0, PAGE_FORM_OUTLINE_MAX)}\n…(the rest of the form was cut)`
    : text;

  function endOption(s: NonNullable<typeof select>) {
    const words = squash(s.option ?? '');
    s.option = null;
    if (!words || words.startsWith('\u0000')) return;
    // "Select one…", "-- Choose --": what the box says before anything is picked, not a choice.
    if (/^(-+\s*)?(please\s+)?(select|choose|pick)\b|^-+$|^…$/i.test(words) && !s.choices.length)
      return;
    s.choices.push(s.group ? `${s.group}: ${words}` : words);
  }
}

const checked = (tag: string): string => (has(tag, 'checked') ? ', already ticked' : '');

/** The words of the last heading before `at`, within a stretch of page, or null. */
function headingBefore(html: string, at: number): string | null {
  const before = html.slice(Math.max(0, at - 3000), at);
  const all = [...before.matchAll(/<h([1-4])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi)];
  const last = all[all.length - 1];
  const words = last ? squash(last[2]!.replace(/<[^>]+>/g, ' ')) : '';
  return words && words.length <= 120 ? words : null;
}

function formTitle(page: string, at: number, block: string): string | null {
  const open = /^<form\b[^>]*>/i.exec(block)?.[0] ?? '';
  const own = attr(open, 'aria-label') || attr(open, 'title') || attr(open, 'data-form-name');
  if (own) return own.slice(0, 120);
  // A heading inside it, then the one above it; a legend only names one group of its questions, so it comes last.
  const inside = /<h([1-4])\b[^>]*>([\s\S]*?)<\/h\1\s*>/i.exec(block);
  const words = squash((inside?.[2] ?? '').replace(/<[^>]+>/g, ' '));
  if (words && words.length <= 120) return words;
  const above = headingBefore(page, at);
  if (above) return above;
  const legend = /<legend\b[^>]*>([\s\S]*?)<\/legend\s*>/i.exec(block);
  const named = squash((legend?.[1] ?? '').replace(/<[^>]+>/g, ' '));
  return named && named.length <= 120 ? named : null;
}

function pageTitle(html: string): string | null {
  const m = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html);
  const words = m ? squash(m[1]!) : '';
  return words ? words.slice(0, 120) : null;
}

/** "Name · Email · Service": the outline's first few lines, short, to tell forms apart. */
function summaryOf(outline: string): string {
  const lines = outline
    .split('\n')
    .map((l) =>
      l
        .replace(/\[[^\]]*\]|\([^)]*\)|[{}]|---/g, ' ')
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .filter((l) => l && !/^step \d+/i.test(l));
  const short = lines.slice(0, 8).map((l) => (l.length > 40 ? `${l.slice(0, 39)}…` : l));
  const joined = short.join(' · ');
  return joined.length > 220 ? `${joined.slice(0, 219)}…` : joined;
}

/** A form nobody would want built: a site search, or a sign-in. */
function notWanted(block: string): boolean {
  const clean = cleaned(block);
  if (/<input\b[^>]*type\s*=\s*["']?password/i.test(clean)) return true;
  const boxes = [...clean.matchAll(/<(input|select|textarea)\b[^>]*>/gi)].filter((m) => {
    const type = (attr(m[0], 'type') ?? 'text').toLowerCase();
    return m[1]!.toLowerCase() !== 'input' || !NOT_FILLED.has(type);
  });
  // A search is one box to type in: a lone dropdown or text area is a question.
  if (boxes.length !== 1 || boxes[0]![1]!.toLowerCase() !== 'input') return false;
  const tag = boxes[0]![0];
  const type = (attr(tag, 'type') ?? '').toLowerCase();
  const name = (attr(tag, 'name') ?? '').toLowerCase();
  const open = /^<form\b[^>]*>/i.exec(block)?.[0] ?? '';
  return (
    type === 'search' ||
    ['s', 'q', 'search', 'query', 'keyword', 'keywords'].includes(name) ||
    /search/i.test(attr(open, 'role') ?? '') ||
    /search/i.test(attr(open, 'action') ?? '')
  );
}

/**
 * The forms on a page. Each `<form>` with a box to fill in (a site search and a sign-in left out); with none, a page
 * whose boxes sit outside any `<form>` (as page builders often write them) is read as one form. A Google Form is read
 * from its data, sections and all. Numbered from `first`.
 */
export function formsOnPage(html: string, url: string, first = 1): PageForm[] {
  const google = googleForm(html, url, first);
  if (google) return [google];
  const clean = cleaned(html);
  const found: PageForm[] = [];
  for (const m of clean.matchAll(/<form\b[^>]*>[\s\S]*?<\/form\s*>/gi)) {
    const block = m[0];
    const fields = countFields(block);
    if (!fields || notWanted(block)) continue;
    const outline = pageFormOutline(block);
    if (!outline) continue;
    found.push({
      number: first + found.length,
      title: formTitle(clean, m.index ?? 0, block),
      fields,
      summary: summaryOf(outline),
      outline,
      url,
    });
    if (found.length >= PAGE_FORMS_MAX) break;
  }
  if (found.length) return found;
  // No <form>: boxes a page builder laid out on their own still make a form, when there are a few of them.
  const body = /<body\b[^>]*>([\s\S]*)<\/body\s*>/i.exec(clean)?.[1] ?? clean;
  const fields = countFields(body);
  if (fields < 2) return [];
  const outline = pageFormOutline(body);
  return outline
    ? [
        {
          number: first,
          title: pageTitle(html),
          fields,
          summary: summaryOf(outline),
          outline,
          url,
        },
      ]
    : [];
}

// ---- Google Forms ----

/** Google's question kinds, by the number its data gives each. */
const GOOGLE_KINDS: Readonly<Record<number, string>> = {
  0: 'short answer box',
  1: 'long answer box',
  2: 'pick one',
  3: 'dropdown',
  4: 'pick any (checkboxes)',
  5: 'scale',
  7: 'grid',
  9: 'date box',
  10: 'time box',
  13: 'file upload',
};

/**
 * A Google Form, from the data its page carries (`FB_PUBLIC_LOAD_DATA_`): every question with its kind, choices and
 * whether it must be answered, and each section break as a new step. Null when the page isn't one, or its data can't
 * be read (its HTML is read as usual then).
 */
export function googleForm(html: string, url: string, number = 1): PageForm | null {
  const m = /FB_PUBLIC_LOAD_DATA_\s*=\s*(\[[\s\S]*?\]);\s*<\/script>/.exec(html);
  if (!m) return null;
  let data: unknown;
  try {
    data = JSON.parse(m[1]!);
  } catch {
    return null;
  }
  const root = Array.isArray(data) ? data : null;
  const info = Array.isArray(root?.[1]) ? (root[1] as unknown[]) : null;
  const items = Array.isArray(info?.[1]) ? (info[1] as unknown[]) : null;
  if (!info || !items) return null;
  const text = (v: unknown): string => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '');
  const title = text(info[8]) || text(root?.[3]) || null;
  const lines: string[] = [];
  const intro = text(info[0]);
  if (title) lines.push(title);
  if (intro) lines.push(intro);
  let fields = 0;
  let step = 1;
  for (const raw of items) {
    if (!Array.isArray(raw)) continue;
    const question = text(raw[1]);
    const help = text(raw[2]);
    const kind = typeof raw[3] === 'number' ? raw[3] : -1;
    if (kind === 8) {
      step++;
      lines.push(`--- Step ${step}${question ? `: ${question}` : ''} ---`);
      if (help) lines.push(help);
      continue;
    }
    if (kind === 6) {
      if (question) lines.push(question);
      if (help) lines.push(help);
      continue;
    }
    const words = GOOGLE_KINDS[kind];
    if (!words) continue;
    const parts = Array.isArray(raw[4]) ? (raw[4] as unknown[]) : [];
    const first = Array.isArray(parts[0]) ? (parts[0] as unknown[]) : [];
    const required = first[2] === 1 || first[2] === true;
    const choices = Array.isArray(first[1])
      ? (first[1] as unknown[]).flatMap((c) => {
          const label = Array.isArray(c) ? text(c[0]) : '';
          return label ? [label] : [];
        })
      : [];
    let detail = '';
    if (kind === 5 && choices.length) detail = `: ${choices[0]} to ${choices[choices.length - 1]}`;
    else if (kind === 7) {
      const rows = parts.flatMap((r) => {
        const label = Array.isArray(r) && Array.isArray(r[3]) ? text(r[3][0]) : '';
        return label ? [label] : [];
      });
      detail = `${rows.length ? `, rows: ${rows.join(' | ')}` : ''}${choices.length ? `, columns: ${choices.join(' | ')}` : ''}`;
    } else if (choices.length) detail = `: ${choices.join(' | ')}`;
    fields++;
    lines.push(
      `${question || 'Untitled question'} [${words}${required ? ', required' : ''}${detail}]${help ? ` (${help})` : ''}`,
    );
  }
  if (!fields) return null;
  const outline = lines.join('\n').slice(0, PAGE_FORM_OUTLINE_MAX);
  return { number, title, fields, summary: summaryOf(outline), outline, url };
}
