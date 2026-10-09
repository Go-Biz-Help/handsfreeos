/**
 * The Facebook tab the panel works in when the person asks it to press something for them: getting their file
 * (./fbfile.ts), or cancelling old requests and unfriending (./tidy.ts). One tab per job, in view, reused from step to
 * step while it's open.
 */
import type { Answer, Ask, FetchAnswer, FetchAsk } from '../messages';

const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** After a page loads, while Facebook draws it. */
const DRAW_MS = 2_400;

export class WorkTab {
  private id: number | null = null;

  /** Opens an address in the tab: the one opened before when it's still there, else a new one. */
  async open(url: string): Promise<number> {
    if (this.id !== null) {
      try {
        const tab = await chrome.tabs.update(this.id, { url, active: true });
        if (tab?.id !== undefined) return await this.loaded(tab.id);
      } catch {
        // Closed since.
      }
    }
    const tab = await chrome.tabs.create({ url, active: true });
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

  /** Asks the tab's script, loading it first into a tab opened before the extension was. */
  async ask(message: FetchAsk): Promise<FetchAnswer>;
  async ask(message: Ask): Promise<Answer>;
  async ask(message: FetchAsk | Ask): Promise<FetchAnswer | Answer> {
    if (this.id === null) return { ok: false, error: 'The Facebook tab was closed.' };
    const id = this.id;
    try {
      return (await chrome.tabs.sendMessage(id, message)) as FetchAnswer | Answer;
    } catch {
      try {
        await chrome.scripting.executeScript({ target: { tabId: id }, files: ['content.js'] });
        return (await chrome.tabs.sendMessage(id, message)) as FetchAnswer | Answer;
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
