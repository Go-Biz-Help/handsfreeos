import {
  contrastRatio,
  FORM_FONTS,
  hslOf,
  isColorful,
  type FormDesignInput,
} from '@hfos/core/server';
import { hexOf, tagsOf, type Tag } from './website';

/**
 * A website's look, for a form's Match my website (core's forms/design.ts): the colour of its buttons and the words on
 * them, its background and words, its font, and how round its buttons are. All pure: the page's HTML and its
 * stylesheets in, the design out.
 *
 * It reads the page the way its builder writes it. Sites made with GoDaddy, Wix and the like style each element with
 * short made-up class names (`.c1-a4`), so the buttons are found in the HTML first (a <button>, or something its
 * builder or its classes call a button) and their classes looked up in the stylesheets, rather than guessing from
 * selectors like `.btn`. Both work.
 */

export interface WebsiteStyle {
  /** The colour most of its buttons are filled with. */
  readonly button: string | null;
  /** The words on those buttons. */
  readonly buttonText: string | null;
  /** Behind its pages. */
  readonly background: string | null;
  /** Its words. */
  readonly text: string | null;
  /** Its font as the site names it, and whether Google Fonts has it. */
  readonly font: { readonly name: string; readonly google: boolean } | null;
  /** How round its buttons are. */
  readonly corners: 'square' | 'slight' | 'round' | null;
}

interface Rule {
  /** The last part of each selector, as written (".a.b", "button", "a.btn"), pseudo-classes taken off. */
  readonly targets: readonly string[];
  /** The whole selectors, for body and html. */
  readonly selectors: readonly string[];
  readonly decls: Readonly<Record<string, string>>;
}

/** Comments out, then every rule, the ones inside @media and @supports included. @font-face and @keyframes are skipped. */
export function rulesOf(css: string): Rule[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const out: Rule[] = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    const open = text.indexOf('{', i);
    if (open < 0) break;
    const head = text.slice(i, open).trim();
    // A whole block: find its end by counting braces.
    let depth = 1;
    let j = open + 1;
    while (j < n && depth > 0) {
      const ch = text[j];
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      j++;
    }
    const body = text.slice(open + 1, j - 1);
    const at = /^@([a-z-]+)/i.exec(head.replace(/^[;}\s]+/, ''));
    if (at) {
      const name = at[1]!.toLowerCase();
      if (name === 'media' || name === 'supports' || name === 'layer' || name === 'container') {
        // Rules for print, or dark mode only, aren't what most visitors see.
        if (!/print|prefers-color-scheme:\s*dark/i.test(head)) out.push(...rulesOf(body));
      }
    } else {
      const selectors = head
        .replace(/^[;}\s]+/, '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (selectors.length) {
        out.push({
          selectors,
          targets: selectors.map(lastCompound).filter((t): t is string => t !== null),
          decls: declsOf(body),
        });
      }
    }
    i = j;
  }
  return out;
}

/** `a { b: c; d: e }`'s inside as a map, later ones winning, property names lower case. */
export function declsOf(body: string): Record<string, string> {
  const decls: Record<string, string> = {};
  for (const part of body.split(';')) {
    const colon = part.indexOf(':');
    if (colon < 0) continue;
    const prop = part.slice(0, colon).trim().toLowerCase();
    const value = part
      .slice(colon + 1)
      .replace(/!important/i, '')
      .trim();
    if (prop && value) decls[prop] = value;
  }
  return decls;
}

/**
 * The part of a selector that names the element itself: ".c1-a.c1-b" of ".x .c1-a.c1-b". Null for one that only
 * applies on hover, focus and the like, which isn't how a button usually looks.
 */
function lastCompound(selector: string): string | null {
  const parts = selector.split(/\s*[\s>+~]\s*/).filter(Boolean);
  const last = parts[parts.length - 1];
  if (!last) return null;
  if (/:(hover|focus|active|visited|focus-visible|focus-within|disabled)\b/i.test(last))
    return null;
  return last.replace(/::?[a-z-]+(\([^)]*\))?/gi, '').trim() || null;
}

/** What a compound selector asks of an element: its tag (or none) and its classes. */
function partsOf(compound: string): { tag: string | null; classes: string[] } | null {
  // Ids and attribute selectors are left out: a rule that needs them isn't a plain style for an element.
  if (/[#[]/.test(compound)) return null;
  const tag = /^[a-z][a-z0-9-]*/i.exec(compound)?.[0]?.toLowerCase() ?? null;
  const classes = [...compound.matchAll(/\.([A-Za-z0-9_-]+)/g)].map((m) => m[1]!);
  if (!tag && !classes.length) return null;
  return { tag, classes };
}

/** The declarations every rule gives an element of this tag and these classes, later rules winning. */
function declsFor(
  rules: readonly Rule[],
  tag: string,
  classes: ReadonlySet<string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rule of rules) {
    const hit = rule.targets.some((t) => {
      const p = partsOf(t);
      if (!p) return false;
      if (p.tag && p.tag !== tag) return false;
      return p.classes.every((c) => classes.has(c));
    });
    if (hit) Object.assign(out, rule.decls);
  }
  return out;
}

/** The site's own variables (`--brand: #e85d04`), from :root, html and body. */
function variablesOf(rules: readonly Rule[]): Map<string, string> {
  const vars = new Map<string, string>();
  for (const rule of rules)
    if (rule.selectors.some((s) => /^(:root|html|body)$/i.test(s)))
      for (const [k, v] of Object.entries(rule.decls)) if (k.startsWith('--')) vars.set(k, v);
  return vars;
}

/** A value with its var(--x) filled in, a few levels deep. */
function resolve(value: string, vars: ReadonlyMap<string, string>): string {
  let out = value;
  for (let depth = 0; depth < 4 && out.includes('var('); depth++)
    out = out.replace(
      /var\(\s*(--[A-Za-z0-9_-]+)\s*(?:,\s*([^()]*(?:\([^()]*\))?[^()]*))?\)/g,
      (_, name, fallback) => vars.get(name) ?? fallback ?? '',
    );
  return out;
}

/** A colour from a declaration's value: the first one in it (a background shorthand has others), see-through ones never. */
function colourIn(value: string | undefined, vars: ReadonlyMap<string, string>): string | null {
  if (!value) return null;
  const v = resolve(value, vars).toLowerCase();
  if (/transparent|inherit|currentcolor|initial|unset/.test(v) && !/#|rgb/.test(v)) return null;
  // rgba() and #rrggbbaa that are mostly see-through don't count.
  const rgba = /rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*([\d.]+)\s*\)/.exec(v);
  if (rgba && Number(rgba[1]) < 0.6) return null;
  const spaced = /rgba?\(\s*(\d{1,3})\s+(\d{1,3})\s+(\d{1,3})(?:\s*\/\s*([\d.]+%?))?\s*\)/.exec(v);
  if (spaced) {
    const alpha = spaced[4];
    if (alpha && (alpha.endsWith('%') ? Number(alpha.slice(0, -1)) / 100 : Number(alpha)) < 0.6)
      return null;
    return hexOf(`rgb(${spaced[1]}, ${spaced[2]}, ${spaced[3]})`);
  }
  const hex8 = /#([0-9a-f]{6})([0-9a-f]{2})\b/.exec(v);
  if (hex8) return parseInt(hex8[2]!, 16) / 255 < 0.6 ? null : `#${hex8[1]}`;
  const found = /#[0-9a-f]{6}\b|#[0-9a-f]{3}\b|rgba?\([^)]*\)/.exec(v);
  return found ? hexOf(found[0]) : null;
}

/** Whether a tag is something people click to act: a button, or a link its builder or its classes call one. */
function isButton(tag: Tag): boolean {
  const a = tag.attrs;
  if (tag.name === 'button') return true;
  if (tag.name === 'input') return /^(submit|button)$/i.test(a['type'] ?? '');
  const says = `${a['class'] ?? ''} ${a['data-ux'] ?? ''} ${a['role'] ?? ''} ${a['id'] ?? ''}`;
  return /\b(btn|button|cta)\b|button/i.test(says) && tag.name === 'a';
}

/** The most common of these, the first one seen winning a tie. */
function mostCommon(values: readonly (string | null)[]): string | null {
  const counts = new Map<string, number>();
  for (const v of values) if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best: string | null = null;
  let most = 0;
  for (const [v, c] of counts)
    if (c > most) {
      best = v;
      most = c;
    }
  return best;
}

/** The fonts a page loads from Google: its <link>s and @imports, and GoDaddy's copy of Google Fonts. */
export function googleFontsOf(html: string, css: string): string[] {
  const out: string[] = [];
  const addresses = [
    ...tagsOf(html, ['link']).map((t) => t.attrs['href'] ?? ''),
    ...[...css.matchAll(/@import\s+(?:url\()?["']?([^"')\s;]+)/gi)].map((m) => m[1]!),
  ].filter((u) => /fonts\.googleapis\.com|wsimg\.com\/gfonts/i.test(u));
  for (const address of addresses) {
    const decoded = address.replace(/&amp;/g, '&');
    for (const m of decoded.matchAll(/[?&]family=([^&]+)/gi))
      for (const family of decodeURIComponent(m[1]!.replace(/\+/g, ' ')).split('|')) {
        const name = family.split(':')[0]!.trim();
        if (name && !out.includes(name)) out.push(name);
      }
  }
  return out;
}

/** The first font a font-family names, quotes off; null for the generic ones and the system's own. */
function firstFont(value: string | undefined, vars: ReadonlyMap<string, string>): string | null {
  if (!value) return null;
  for (const raw of resolve(value, vars).split(',')) {
    const name = raw
      .trim()
      .replace(/^["']|["']$/g, '')
      .trim();
    if (!name) continue;
    if (
      /^(serif|sans-serif|monospace|cursive|fantasy|system-ui|ui-[a-z-]+|-apple-system|blinkmacsystemfont|inherit|initial)$/i.test(
        name,
      )
    )
      continue;
    return name;
  }
  return null;
}

/** How round a border-radius is: square, slightly or round. */
function cornersOf(
  value: string | undefined,
  vars: ReadonlyMap<string, string>,
): WebsiteStyle['corners'] {
  if (!value) return null;
  const v = resolve(value, vars).trim().split(/\s+/)[0] ?? '';
  if (v.endsWith('%')) return Number(v.slice(0, -1)) >= 20 ? 'round' : 'slight';
  const px =
    v.endsWith('rem') || v.endsWith('em')
      ? Number(v.replace(/r?em$/, '')) * 16
      : Number(v.replace(/px$/, ''));
  if (!Number.isFinite(px)) return null;
  if (px < 2) return 'square';
  return px >= 16 ? 'round' : 'slight';
}

/** The look of a page from its HTML and the CSS it uses (its <style>s, its stylesheets, in order). */
export function websiteStyleOf(html: string, sheets: readonly string[]): WebsiteStyle {
  const inline = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi)].map((m) => m[1]!);
  const css = [...sheets, ...inline].join('\n');
  const rules = rulesOf(css);
  const vars = variablesOf(rules);

  // The buttons on the page and how each is filled.
  const buttons = tagsOf(html, ['button', 'a', 'input']).filter(isButton).slice(0, 40);
  const filled: { bg: string; color: string | null; radius: WebsiteStyle['corners'] }[] = [];
  for (const b of buttons) {
    const classes = new Set((b.attrs['class'] ?? '').split(/\s+/).filter(Boolean));
    const decls = { ...declsFor(rules, b.name, classes), ...declsOf(b.attrs['style'] ?? '') };
    const bg = colourIn(decls['background-color'] ?? decls['background'], vars);
    if (!bg || !(isColorful(bg) || hslOf(bg).l < 0.3)) continue;
    filled.push({
      bg,
      color: colourIn(decls['color'], vars),
      radius: cornersOf(decls['border-radius'], vars),
    });
  }
  const button = mostCommon(filled.map((f) => f.bg));
  const onButton = filled.filter((f) => f.bg === button);
  const buttonText = mostCommon(onButton.map((f) => f.color));

  // The page: body, then html.
  const page: Record<string, string> = {};
  for (const sel of ['html', 'body'])
    for (const rule of rules)
      if (rule.selectors.some((s) => s.toLowerCase() === sel)) Object.assign(page, rule.decls);
  const bodyTag = tagsOf(html, ['body'])[0];
  if (bodyTag) {
    const classes = new Set((bodyTag.attrs['class'] ?? '').split(/\s+/).filter(Boolean));
    Object.assign(page, declsFor(rules, 'body', classes), declsOf(bodyTag.attrs['style'] ?? ''));
  }
  const background = colourIn(page['background-color'] ?? page['background'], vars);
  // Words: the body's, or else what most paragraphs are in.
  const paragraphs = tagsOf(html, ['p']).slice(0, 40);
  const text =
    colourIn(page['color'], vars) ??
    mostCommon(
      paragraphs.map((p) =>
        colourIn(
          declsFor(rules, 'p', new Set((p.attrs['class'] ?? '').split(/\s+/).filter(Boolean)))[
            'color'
          ],
          vars,
        ),
      ),
    );

  // The font: the body's (or most paragraphs'), else the first Google font it loads.
  const google = googleFontsOf(html, css);
  const named =
    firstFont(page['font-family'], vars) ??
    mostCommon(
      paragraphs.map((p) =>
        firstFont(
          declsFor(rules, 'p', new Set((p.attrs['class'] ?? '').split(/\s+/).filter(Boolean)))[
            'font-family'
          ],
          vars,
        ),
      ),
    ) ??
    google[0] ??
    null;
  const font = named
    ? {
        name: named,
        google:
          google.some((g) => g.toLowerCase() === named.toLowerCase()) ||
          FORM_FONTS.some((f) => f.name.toLowerCase() === named.toLowerCase()),
      }
    : null;

  return {
    button,
    // Only when it reads on the button: a stylesheet's word colour for links in general often doesn't.
    buttonText: button && buttonText && contrastRatio(button, buttonText) >= 3 ? buttonText : null,
    background,
    text: text && background && contrastRatio(text, background) < 3 ? null : text,
    font,
    corners: mostCommon(onButton.map((f) => f.radius)) as WebsiteStyle['corners'],
  };
}

/** A font as a form can show it: the site's own when Google has it, else the free one most like it. */
export function formFontFor(font: WebsiteStyle['font']): { name: string; stoodIn: boolean } | null {
  if (!font) return null;
  const ours = FORM_FONTS.find((f) => f.name.toLowerCase() === font.name.toLowerCase());
  if (ours) return { name: ours.name, stoodIn: false };
  if (font.google) return { name: font.name, stoodIn: false };
  const serif =
    /serif|georgia|times|garamond|baskerville|didot|bodoni|caslon|palatino|cambria/i.test(
      font.name,
    ) && !/sans/i.test(font.name);
  return { name: serif ? 'Lora' : 'Inter', stoodIn: true };
}

/**
 * The design Match my website fills in: the site's button colour and words, its words, font and corners. The
 * background is left see-through, so the form takes on whatever part of the site it sits in; the light or dark is
 * the site's.
 */
export function designFromStyle(
  style: WebsiteStyle,
  site: string,
  at: Date,
): { patch: Partial<FormDesignInput>; fontNote: string | null; found: number } {
  const font = formFontFor(style.font);
  const dark = style.background ? hslOf(style.background).l < 0.35 : false;
  const patch: Partial<FormDesignInput> = {
    scheme: dark ? 'dark' : 'light',
    colors: {
      button: style.button,
      buttonText: style.buttonText,
      background: null,
      text: style.text,
      field: null,
      fieldBorder: null,
      error: null,
    },
    font: font?.name ?? null,
    ...(style.corners ? { corners: style.corners } : {}),
    matched: { site, at: at.toISOString() },
  };
  const found = [style.button, style.text, style.font, style.corners].filter(Boolean).length;
  return {
    patch,
    fontNote:
      font?.stoodIn && style.font
        ? `${style.font.name} isn’t a free font, so the form uses ${font.name}, the closest one.`
        : null,
    found,
  };
}
