/**
 * AI Social Media Content Creator's reading tab (docs/socialcontent.md; ./run.ts): a window of its own beside the
 * person's, on one network's pages (src/tab.ts's `WorkTab`, which refuses any other address), and its hands there
 * (./page.ts, research.js), loaded into it by Chrome's `executeScript` and called the same way, in that script's own
 * world. Social Outreach's script in the tab never hears these.
 */
import type { Kit } from '../networks';
import { WorkTab } from '../tab';
import type { ResearchHands } from './page';

type Hands = ResearchHands;
type Answer<K extends keyof Hands> = Awaited<ReturnType<Hands[K]>>;

export class ResearchTab {
  private readonly tab: WorkTab;

  constructor(readonly kit: Kit) {
    this.tab = new WorkTab('window', kit, { front: 'away', waits: false });
  }

  get tabId(): number | null {
    return this.tab.tabId;
  }

  /** Opens one of its network's pages, and waits for it to draw. */
  open(url: string): Promise<number> {
    return this.tab.open(url);
  }

  close(): Promise<void> {
    return this.tab.close();
  }

  /**
   * Runs `work` with its window in front, for a page that draws only what's on screen: only once the person has been
   * away for two minutes (decision 120), else it throws `NotAway` (src/away.ts) and the read goes on without it.
   */
  inFront<T>(work: () => Promise<T>): Promise<T> {
    return this.tab.inFront(work);
  }

  /**
   * Holds back the computer's file picker in the tab's page (part 9, ./post-here.ts): a file field the page asks to
   * open is marked (`data-hfos-picked`) and kept on the page for the hands to give the post's files to, instead of a
   * window opening on the person's screen. Only in this tab, until it opens another page. In the page's own world, as
   * the page asks for the picker there.
   */
  async holdPicker(): Promise<boolean> {
    const tabId = this.tab.tabId;
    if (tabId === null) return false;
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: () => {
          const page = globalThis as { hfosPickerHeld?: boolean };
          if (page.hfosPickerHeld) return;
          page.hfosPickerHeld = true;
          const keep = (input: HTMLInputElement) => {
            input.setAttribute('data-hfos-picked', '1');
            if (!input.isConnected) {
              input.style.display = 'none';
              document.body.appendChild(input);
            }
          };
          const click = HTMLInputElement.prototype.click;
          HTMLInputElement.prototype.click = function (this: HTMLInputElement) {
            if (this.type === 'file') return keep(this);
            return click.call(this);
          };
          const picker = HTMLInputElement.prototype.showPicker;
          if (picker)
            HTMLInputElement.prototype.showPicker = function (this: HTMLInputElement) {
              if (this.type === 'file') return keep(this);
              return picker.call(this);
            };
        },
      });
      return true;
    } catch (error) {
      console.warn('HandsFreeOS Social couldn’t hold back the file picker', error);
      return false;
    }
  }

  /** Calls its hands in the tab, loading them first when the page is new. Null when the tab couldn't be asked. */
  async hands<K extends keyof Hands>(
    name: K,
    ...args: Parameters<Hands[K]>
  ): Promise<Answer<K> | null> {
    const tabId = this.tab.tabId;
    if (tabId === null) return null;
    try {
      const [there] = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => typeof (globalThis as { hfosResearch?: unknown }).hfosResearch === 'object',
      });
      if (!there?.result)
        await chrome.scripting.executeScript({ target: { tabId }, files: ['research.js'] });
      const [ran] = await chrome.scripting.executeScript({
        target: { tabId },
        func: (call: string, given: unknown[]) => {
          const hands = (
            globalThis as { hfosResearch?: Record<string, (...a: unknown[]) => unknown> }
          ).hfosResearch;
          return hands?.[call] ? hands[call](...given) : null;
        },
        args: [name, args as unknown[]],
      });
      return (ran?.result ?? null) as Answer<K> | null;
    } catch (error) {
      console.warn('HandsFreeOS Social couldn’t reach its reading tab', error);
      return null;
    }
  }
}
