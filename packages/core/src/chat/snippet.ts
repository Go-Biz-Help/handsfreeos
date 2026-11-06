/**
 * The website chat's snippet, the one line a business pastes into its own site. Written once, here: Settings → Website
 * chat and a chat's page under Forms copy it, the texting registration's helper shows it, and the Assistant hands out
 * the same. Browser-safe.
 */

/** Where the snippet loads from: the business's own domain when one is serving, otherwise the app's address. */
export const chatSnippetSrc = (origin: string, publicKey: string): string =>
  `${origin}/embed/v1/${publicKey}.js`;

/** The snippet a business pastes: `<script async src="…/embed/v1/<key>.js"></script>`. */
export const chatSnippet = (src: string): string => `<script async src="${src}"></script>`;
