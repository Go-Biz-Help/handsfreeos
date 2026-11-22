/**
 * The version, at the top of the panel (docs/outreach.md, decision 189; the owner, 22 Nov 2026): "Version 0.151.0",
 * in the same words as beside the download in HandsFreeOS, so the person can hold the two side by side and see
 * whether theirs is the newest. It's the manifest's, so it's this build's whether they're signed in or not.
 */
import { extensionVersionWords } from '@hfos/core/extension-download';

export function showVersion(into: HTMLElement): void {
  into.textContent = extensionVersionWords(chrome.runtime.getManifest().version);
}
