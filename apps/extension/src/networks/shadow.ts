/**
 * What a page draws out of reach of its own look-ups: inside a shadow root, or in a frame of its own. LinkedIn's newer
 * pages draw some of their older parts that way, in the `interop-shadowdom` box at the foot of every page and the
 * iframe beside it (the owner's Check LinkedIn of 17 Oct 2026: Message on a profile opened nothing the page showed).
 * A content script may open a shadow root the page keeps closed, with Chrome's `chrome.dom`.
 */

interface DomApi {
  readonly openOrClosedShadowRoot?: (element: HTMLElement) => ShadowRoot | null;
}

/** An element's shadow root: an open one, or, with `closedToo`, a closed one as well. */
export function shadowOf(host: Element, closedToo = false): ShadowRoot | null {
  if (host.shadowRoot) return host.shadowRoot;
  if (!closedToo) return null;
  const dom = (globalThis as { chrome?: { dom?: DomApi } }).chrome?.dom;
  try {
    return dom?.openOrClosedShadowRoot?.(host as HTMLElement) ?? null;
  } catch {
    return null;
  }
}

/** A frame's own page, when it's the same site's and can be read. */
export function frameDocumentOf(frame: Element): Document | null {
  if (frame.tagName !== 'IFRAME') return null;
  try {
    return (frame as HTMLIFrameElement).contentDocument;
  } catch {
    return null;
  }
}
