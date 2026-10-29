/**
 * Catching what a page copies (docs/outreach.md, decision 123): LinkedIn's newer post search shows no link to any post,
 * and a post's menu has Copy link to post. While the tab's script says so (`CATCH` on the page's root), what the page
 * copies is kept on the root (`COPIED`) and never goes to the person's clipboard; else the page copies as it always
 * does. Run once in the page's own world (src/tab.ts `catchCopies`), as the page's own code is what copies, and a
 * content script's world can't change what the page's sees. Running it again changes nothing.
 *
 * It must stand alone: Chrome sends the function's source to the page, so it uses nothing from outside it.
 */

/** On the page's root while the tab's script waits for a copy: what the page copies then is caught. */
export const CATCH = 'data-hfos-catch';
/** On the page's root: what it copied while caught. */
export const COPIED = 'data-hfos-copied';
/** On the page's root once it catches copies. */
export const CATCHING = 'data-hfos-copies';

/** Catches what the page copies while its root says to: its clipboard's writeText and write, and a copy command. */
export function catchCopiesIn(view: Window = window): boolean {
  const page = view as Window & { __hfosCopies?: boolean };
  const doc = view.document;
  const root = doc.documentElement;
  // The tab's script presses nothing that copies till it sees this.
  root.setAttribute('data-hfos-copies', '');
  if (page.__hfosCopies) return true;
  page.__hfosCopies = true;
  const caught = (text: string): boolean => {
    if (!root.hasAttribute('data-hfos-catch')) return false;
    root.setAttribute('data-hfos-copied', text);
    return true;
  };
  const clipboard = view.navigator.clipboard as Clipboard | undefined;
  if (clipboard?.writeText) {
    const writeText = clipboard.writeText.bind(clipboard);
    clipboard.writeText = (text: string) =>
      caught(String(text)) ? Promise.resolve() : writeText(text);
  }
  if (clipboard?.write) {
    const write = clipboard.write.bind(clipboard);
    clipboard.write = async (items: ClipboardItems) => {
      if (!root.hasAttribute('data-hfos-catch')) return write(items);
      for (const item of items)
        for (const type of ['text/plain', 'text/uri-list'])
          if (item.types.includes(type)) {
            caught(await (await item.getType(type)).text());
            return;
          }
    };
  }
  if (typeof doc.execCommand === 'function') {
    const execCommand = doc.execCommand.bind(doc);
    doc.execCommand = (command: string, ui?: boolean, value?: string) => {
      if (String(command).toLowerCase() === 'copy' && root.hasAttribute('data-hfos-catch')) {
        const field = doc.activeElement as HTMLInputElement | HTMLTextAreaElement | null;
        const text =
          field && typeof field.value === 'string' && field.value
            ? field.value
            : String(view.getSelection() ?? '');
        return caught(text);
      }
      return execCommand(command, ui, value);
    };
  }
  return true;
}
