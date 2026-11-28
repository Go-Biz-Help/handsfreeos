/**
 * A form or booking page in a pop-up on the business's own website (HANDSFREEOS_DESIGN_TOOLS_IMPLEMENTATION_PLAN.md,
 * part 3; ideas 6 and 9): the second way to embed, beside the box in the page. A button on the site opens it in a
 * centred window, or it opens by itself after a number of seconds, or when a visitor on a computer goes to leave.
 * Someone who closes one that opened by itself isn't shown it again for 7 days; a button always opens it.
 *
 * The code is one element and the line that loads `/embed/v1/popup.js` (apps/web/src/lib/forms/popup-script.ts),
 * always from the app's own address. The window shows the same `?embed=1` page the box in the page does, so the same
 * Sites allowed to show it list decides where it can show. Everything the pop-up needs is in the code itself, so
 * nothing is saved: the Share tab, the calendar's Embed and the Assistant all build it here. Browser-safe.
 */

export const POPUP_OPENS = ['button', 'after', 'leave'] as const;
export type PopupOpens = (typeof POPUP_OPENS)[number];

/** How long one that opened by itself stays away after it's closed. */
export const POPUP_QUIET_DAYS = 7;
export const POPUP_SECONDS_DEFAULT = 10;
export const POPUP_SECONDS_MIN = 1;
export const POPUP_SECONDS_MAX = 300;
export const POPUP_LABEL_MAX = 60;

/** The script's attributes, read by popup-script.ts. */
export const POPUP_ATTR = {
  url: 'data-hfos-popup',
  title: 'data-hfos-title',
  opens: 'data-hfos-open',
  seconds: 'data-hfos-seconds',
} as const;

/** What the pop-up's choices are called, the same on the form's Share tab and the calendar's Embed. */
export const POPUP_WORDS = {
  title: 'Pop-up on your website',
  hint: 'It opens in a window over your site. Only the sites you list can show it.',
  opens: 'How it opens',
  button: 'From a button',
  after: 'After a few seconds',
  leave: 'When they go to leave',
  label: 'Words on the button',
  seconds: 'Seconds before it opens',
  code: 'The code to paste',
  buttonNote:
    'Paste it where the button should go, in an HTML or embed block. Your own button or link can open it too: give it the same data-hfos-popup part.',
  autoNote: `Paste it anywhere on the page, in an HTML or embed block. Someone who closes it isn’t shown it again for ${POPUP_QUIET_DAYS} days.`,
  leaveNote: `Paste it anywhere on the page. It opens when someone on a computer moves to close the tab or leave, once. Someone who closes it isn’t shown it again for ${POPUP_QUIET_DAYS} days. Phones don’t have this, so it never opens there.`,
} as const;

/** The button's look: the page's own button colour, words and corners, so it matches what it opens. */
export interface PopupButtonLook {
  readonly background: string;
  readonly color: string;
  readonly radius: string;
}

/** The button's look from a page's design, as core's formLook works it out (its `vars`). */
export const popupLookOf = (vars: Readonly<Record<string, string>>): PopupButtonLook => ({
  background: vars['--accent'] ?? '#2563eb',
  color: vars['--form-on-accent'] ?? '#ffffff',
  radius: vars['--radius-control'] ?? '8px',
});

const COLOR = /^#[0-9a-f]{3,8}$/i;
const RADIUS = /^\d{1,3}px$/;

export const popupSnippet = (p: {
  /** The page's public link, without `?embed=1`. */
  readonly url: string;
  readonly appOrigin: string;
  /** The form's or calendar's name, said to screen readers as the window's name. */
  readonly name: string;
  readonly opens: PopupOpens;
  /** For `after`: how long the page has been open first. */
  readonly seconds?: number;
  /** For `button`: its words. */
  readonly label?: string;
  readonly look?: PopupButtonLook | null;
}): string => {
  const src = `${p.appOrigin}/embed/v1/popup.js`;
  const page = `${p.url}${p.url.includes('?') ? '&' : '?'}embed=1`;
  const named = `${POPUP_ATTR.url}="${escapeAttr(page)}" ${POPUP_ATTR.title}="${escapeAttr(p.name)}"`;
  if (p.opens === 'button') {
    const words = (p.label ?? '').trim().slice(0, POPUP_LABEL_MAX) || 'Open';
    const look = p.look;
    // Colours and corners checked before they go in a style: they come from a design, but the code is pasted elsewhere.
    const background = look && COLOR.test(look.background) ? look.background : '#2563eb';
    const color = look && COLOR.test(look.color) ? look.color : '#ffffff';
    const radius = look && RADIUS.test(look.radius) ? look.radius : '8px';
    const style = `background:${background};color:${color};border:0;border-radius:${radius};padding:12px 22px;font:inherit;font-size:16px;font-weight:600;line-height:1.2;cursor:pointer`;
    return `<button type="button" ${named} style="${style}">${escapeText(words)}</button>\n<script src="${src}" async></script>`;
  }
  const when =
    p.opens === 'after'
      ? ` ${POPUP_ATTR.opens}="after" ${POPUP_ATTR.seconds}="${popupSeconds(p.seconds)}"`
      : ` ${POPUP_ATTR.opens}="leave"`;
  return `<script src="${src}" ${named}${when} async></script>`;
};

/**
 * The three ways a pop-up opens, as the Assistant hands them out: the code's button (with the page's own colours
 * when they're known), or the script alone, opening after 10 seconds or when someone on a computer goes to leave.
 */
export const popupCodesFor = (
  url: string,
  appOrigin: string,
  name: string,
  label: string,
  look: PopupButtonLook | null = null,
): { readonly button: string; readonly afterTenSeconds: string; readonly whenLeaving: string } => ({
  button: popupSnippet({ url, appOrigin, name, opens: 'button', label, look }),
  afterTenSeconds: popupSnippet({ url, appOrigin, name, opens: 'after', seconds: 10 }),
  whenLeaving: popupSnippet({ url, appOrigin, name, opens: 'leave' }),
});

/** What the Assistant is told about the pop-up's codes. */
export const POPUP_NOTE = `A pop-up opens the same page in a window over their website, on the same sites as the embed code (sitesAllowedToShowIt). button: a button that opens it (the words between the tags can change, and their own button or link opens it if it gets the same data-hfos-popup part). afterTenSeconds: opens by itself; the number in data-hfos-seconds can be 1 to 300. whenLeaving: opens when someone on a computer moves to leave, never on phones. One that opened by itself and was closed stays away ${POPUP_QUIET_DAYS} days.`;

/** Seconds as the code keeps them: whole, and between 1 and 300. */
export const popupSeconds = (s: number | undefined): number =>
  Number.isFinite(s)
    ? Math.min(POPUP_SECONDS_MAX, Math.max(POPUP_SECONDS_MIN, Math.round(s as number)))
    : POPUP_SECONDS_DEFAULT;

/** A name or address in an attribute: quotes and angle brackets can't end it early. */
const escapeAttr = (v: string): string =>
  v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeText = (v: string): string =>
  v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
