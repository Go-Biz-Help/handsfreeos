/**
 * Pasting on a made-up page (decision 158): jsdom has no clipboard, so a page gets the two parts a paste needs, as
 * Chrome has them; and a box can take a paste as Facebook's does, each line a paragraph and a blank line an empty one,
 * or as LinkedIn's does, dropping the blank lines from plain words but keeping a web page's empty paragraphs.
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
  const doc = box.ownerDocument;
  box.addEventListener('paste', (event) => {
    event.preventDefault();
    const words = (event as Event & { clipboardData: DataTransfer }).clipboardData.getData(
      'text/plain',
    );
    box.replaceChildren(
      ...words.split('\n').map((line) => {
        const p = doc.createElement('p');
        p.append(line ? doc.createTextNode(line) : doc.createElement('br'));
        return p;
      }),
    );
  });
}

/** The box's paragraphs, as the post shows once it's up. */
export const paragraphs = (box: Element): string[] =>
  [...box.querySelectorAll('p')].map((p) => p.textContent ?? '');

/**
 * The box takes a paste as LinkedIn's does (ProseMirror's way, the owner's post of 15 Nov 2026): plain words a line to
 * a paragraph with the blank lines dropped, and a web page's copy (HTML) paragraph by paragraph, an empty one too.
 * `html: false` makes it a box that ignores a page's copy, to show the plain words come back.
 */
export function pastesLikeLinkedIn(box: Element, { html = true } = {}): void {
  const doc = box.ownerDocument;
  box.addEventListener('paste', (event) => {
    event.preventDefault();
    const data = (event as Event & { clipboardData: DataTransfer }).clipboardData;
    const page = data.getData('text/html');
    if (page && !html) return;
    let lines: string[];
    if (page) {
      const copy = doc.createElement('template');
      copy.innerHTML = page;
      lines = [...copy.content.querySelectorAll('p')].map((p) => p.textContent ?? '');
    } else lines = data.getData('text/plain').split(/\n+/);
    box.replaceChildren(
      ...lines.map((line) => {
        const p = doc.createElement('p');
        p.append(line ? doc.createTextNode(line) : doc.createElement('br'));
        return p;
      }),
    );
  });
}
