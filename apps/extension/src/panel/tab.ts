/**
 * The Facebook tab the panel works in when the person asks it to press something for them: getting their file
 * (./fbfile.ts), cancelling old requests and unfriending (./tidy.ts), or scrolling their groups for Find posts
 * (./posts.ts). One tab per job, in view, reused from step to step while it's open. A quiet one opens out of view
 * and closes after: looking someone up before drafting (./lookup.ts), where nothing is pressed.
 */
import type { Answer, Ask, BrowseAnswer, BrowseAsk, FetchAnswer, FetchAsk } from '../messages';

const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** After a page loads, while Facebook draws it. */
const DRAW_MS = 2_400;

export class WorkTab {
  private id: number | null = null;

  constructor(private readonly quiet = false) {}

  /** The tab's number, while it's open. */
  get tabId(): number | null {
    return this.id;
  }

  /** Opens an address in the tab: the one opened before when it's still there, else a new one. */
  async open(url: string): Promise<number> {
    if (this.id !== null) {
      try {
        const tab = await chrome.tabs.update(this.id, { url, active: !this.quiet });
        if (tab?.id !== undefined) return await this.loaded(tab.id);
      } catch {
        // Closed since.
      }
    }
    const tab = await chrome.tabs.create({ url, active: !this.quiet });
    this.id = tab.id ?? null;
    if (this.id === null) throw new Error('Chrome didn’t open the tab.');
    return this.loaded(this.id);
  }

  /** Waits for a tab to finish loading, and for Facebook to draw the page. */
  async loaded(id: number): Promise<number> {
    const until = Date.now() + 30_000;
    while (Date.now() < until) {
      const tab = await chrome.tabs.get(id);
      if (tab.status === 'complete') break;
      await pause(300);
    }
    await pause(DRAW_MS);
    return id;
  }

  /** Closes the tab, when it's still open. */
  async close(): Promise<void> {
    const id = this.id;
    this.id = null;
    if (id !== null) await chrome.tabs.remove(id).catch(() => undefined);
  }

  /** Asks the tab's script, loading it first into a tab opened before the extension was. */
  async ask(message: FetchAsk): Promise<FetchAnswer>;
  async ask(message: BrowseAsk): Promise<BrowseAnswer | Answer>;
  async ask(message: Ask): Promise<Answer>;
  async ask(message: FetchAsk | BrowseAsk | Ask): Promise<FetchAnswer | BrowseAnswer | Answer> {
    if (this.id === null) return { ok: false, error: 'The Facebook tab was closed.' };
    const id = this.id;
    try {
      return (await chrome.tabs.sendMessage(id, message)) as FetchAnswer | BrowseAnswer | Answer;
    } catch {
      try {
        await chrome.scripting.executeScript({ target: { tabId: id }, files: ['content.js'] });
        return (await chrome.tabs.sendMessage(id, message)) as FetchAnswer | BrowseAnswer | Answer;
      } catch {
        return {
          ok: false,
          error:
            'Facebook took the tab somewhere else. Check you’re signed in to Facebook in this browser, then try again.',
        };
      }
    }
  }
}
