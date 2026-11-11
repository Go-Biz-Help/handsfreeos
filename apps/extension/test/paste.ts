/**
 * Pasting on a made-up page (decision 158): jsdom has no clipboard, so a page gets the two parts a paste needs, as
 * Chrome has them; and a box can take a paste as Facebook's does, each line a paragraph and a blank line an empty one.
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
