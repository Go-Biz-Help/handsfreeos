/**
 * Pasting on a made-up page (decision 158): jsdom has no clipboard, so a page gets the two parts a paste needs, as
 * Chrome has them; and a box can take a paste as Facebook's does, each line a paragraph and a blank line an empty one,
 * or as LinkedIn's does, dropping the blank lines and throwing a web page's copy (HTML) away.
 */

/** Gives the page Chrome's DataTransfer and ClipboardEvent, as far as a paste of words needs them. */
export function canPaste(doc: Document): void {
  const view = doc.defaultView!;
  class Transfer {
    readonly #data = new Map<string, string>();
    setData(type: string, value: string) {
      this.#data.set(type, value);
    }
    getData(type: string) {
      return this.#data.get(type) ?? '';
    }
  }
  class Pasted extends view.Event {
    readonly clipboardData: Transfer | null;
    constructor(type: string, init?: EventInit & { clipboardData?: Transfer | null }) {
      super(type, init);
      this.clipboardData = init?.clipboardData ?? null;
    }
  }
  Object.assign(view, { DataTransfer: Transfer, ClipboardEvent: Pasted });
}

/** The box takes a paste as Facebook's does: each line its own paragraph, a blank line an empty one. */
export function pastesLikeFacebook(box: Element): void {
  box.addEventListener('paste', (event) => {
    event.preventDefault();
    const data = (event as Event & { clipboardData: DataTransfer }).clipboardData;
    asParagraphs(box, data.getData('text/plain').split('\n'));
  });
}

/** The box's paragraphs, as the post shows once it's up. */
export const paragraphs = (box: Element): string[] =>
  [...box.querySelectorAll('p')].map((p) => p.textContent ?? '');

/** Each line its own paragraph, an empty one holding a line break. */
export function asParagraphs(box: Element, lines: string[]): void {
  const doc = box.ownerDocument;
  box.replaceChildren(
    ...lines.map((line) => {
      const p = doc.createElement('p');
      p.append(line ? doc.createTextNode(line) : doc.createElement('br'));
      return p;
    }),
  );
}

/**
 * The box takes a paste as LinkedIn's did in its own box on 18 Nov 2026 (Tiptap, on ProseMirror): plain words a line
 * to a paragraph with the blank lines dropped. A web page's copy (HTML) it throws away, as LinkedIn's page lets no
 * script but its own read pasted HTML.
 */
export function pastesLikeLinkedIn(box: Element): void {
  box.addEventListener('paste', (event) => {
    const data = (event as Event & { clipboardData: DataTransfer }).clipboardData;
    if (data.getData('text/html')) return;
    event.preventDefault();
    asParagraphs(box, data.getData('text/plain').split(/\n+/));
  });
}
