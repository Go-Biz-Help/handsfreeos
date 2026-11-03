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

/**
 * Catches what the page copies while its root says to: its clipboard's writeText and write, and a copy command. In
 * one of the page's frames too (decision 138: LinkedIn's newer pages draw parts in frames of their own), where the
 * top page's root says, as the tab's script waits there; and on Clipboard's own prototype and a copy's DataTransfer,
 * as a page may keep the clipboard's methods from before this ran.
 */
export function catchCopiesIn(view: Window = window): boolean {
  const page = view as Window & { __hfosCopies?: boolean };
  const doc = view.document;
  // The top page's root, where the frame can reach it; else its own.
  let root = doc.documentElement;
  try {
    if (view.top && view.top !== view && view.top.document)
      root = view.top.document.documentElement;
  } catch {
    // A frame from another site can't reach the top page: it catches nothing.
    return false;
  }
  // The tab's script presses nothing that copies till it sees this.
  root.setAttribute('data-hfos-copies', '');
  if (page.__hfosCopies) return true;
  page.__hfosCopies = true;
  const catching = () => root.hasAttribute('data-hfos-catch');
  const caught = (text: string): boolean => {
    if (!catching()) return false;
    root.setAttribute('data-hfos-copied', text);
    return true;
  };
  const textOf = async (items: ClipboardItems): Promise<string | null> => {
    for (const item of items)
      for (const type of ['text/plain', 'text/uri-list'])
        if (item.types.includes(type)) return (await item.getType(type)).text();
    return null;
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
      if (!catching()) return write(items);
      const text = await textOf(items);
      if (text !== null) caught(text);
    };
  }
  const proto = (view as Window & { Clipboard?: { prototype: Clipboard } }).Clipboard?.prototype;
  if (proto?.writeText) {
    const writeText = proto.writeText;
    proto.writeText = function (this: Clipboard, text: string) {
      return caught(String(text)) ? Promise.resolve() : writeText.call(this, text);
    };
  }
  if (proto?.write) {
    const write = proto.write;
    proto.write = async function (this: Clipboard, items: ClipboardItems) {
      if (!catching()) return write.call(this, items);
      const text = await textOf(items);
      if (text !== null) caught(text);
    };
  }
  const transfer = (view as Window & { DataTransfer?: { prototype: DataTransfer } }).DataTransfer
    ?.prototype;
  if (transfer?.setData) {
    const setData = transfer.setData;
    transfer.setData = function (this: DataTransfer, format: string, data: string) {
      if (/^(text|text\/plain|text\/uri-list)$/i.test(String(format)) && caught(String(data)))
        return;
      setData.call(this, format, data);
    };
  }
  if (typeof doc.execCommand === 'function') {
    const execCommand = doc.execCommand.bind(doc);
    doc.execCommand = (command: string, ui?: boolean, value?: string) => {
      if (String(command).toLowerCase() === 'copy' && catching()) {
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
