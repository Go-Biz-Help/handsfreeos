/**
 * The side panel's drawing helpers. Everything a page or HandsFreeOS said goes in as text, never as HTML.
 */
import { facebookUrl } from '../facebook/urls';

export type Child = Node | string | null | undefined | false;

/** An element with attributes and children. Text goes in as text, never as HTML. */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attributes: Record<string, string | undefined> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes))
    if (value !== undefined) element.setAttribute(name, value);
  for (const child of children)
    if (child !== null && child !== undefined && child !== false) element.append(child);
  return element;
}

/** A link to Facebook, opened in a new tab. Only Facebook's own addresses become links. */
export function link(text: string, url: string | null | undefined): Node {
  if (!url || !facebookUrl(url)) return document.createTextNode(text);
  return h('a', { href: url, target: '_blank', rel: 'noreferrer' }, text);
}

/** A link into HandsFreeOS, opened in a new tab. */
export function hfosLink(text: string, url: string): HTMLAnchorElement {
  return h('a', { href: url, target: '_blank', rel: 'noreferrer' }, text);
}

export function chip(text: string, tone: 'plain' | 'warn' | 'saved' = 'plain'): HTMLElement {
  return h('span', { class: `chip ${tone}` }, text);
}

export function button(
  text: string,
  onClick: () => void,
  options: { primary?: boolean; disabled?: boolean } = {},
): HTMLButtonElement {
  const element = h(
    'button',
    { type: 'button', class: options.primary ? 'primary' : undefined },
    text,
  );
  element.disabled = options.disabled ?? false;
  element.addEventListener('click', onClick);
  return element;
}

export function clip(text: string, length: number): string {
  return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}
