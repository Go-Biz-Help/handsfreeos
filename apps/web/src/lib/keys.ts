/**
 * Keyboard shortcuts' one question: is this a Mac? There ⌘ is the modifier, Ctrl everywhere else. ⌘J (the Assistant)
 * and ⌘K (Search everything) both ask it. Only in the browser: on the server there's no keyboard to ask about.
 */
export function isMac(): boolean {
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  return /mac|iphone|ipad|ipod/i.test(nav.userAgentData?.platform || nav.platform || '');
}

/**
 * Whether a key press is the shortcut's modifier and `key`: ⌘ on a Mac, Ctrl elsewhere, never both, and never with
 * Alt or Shift or a held key repeating, so ⌘⇧K and AltGr combinations stay the browser's or the keyboard's.
 */
export function isShortcut(e: KeyboardEvent, key: string, onMac: boolean): boolean {
  if (e.key.toLowerCase() !== key || e.altKey || e.shiftKey || e.repeat) return false;
  return onMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
}
