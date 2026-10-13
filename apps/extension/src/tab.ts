/**
 * The Facebook tab the extension works in. What the person asks of it from HandsFreeOS (asks/run.ts) that they may
 * need to finish themselves (getting their file, where they type their password; cancelling old requests and
 * unfriending) goes in a tab in view, reused from step to step while it's open, and brought to the front when a step
 * is handed to them. A quiet one opens out of view and closes after. The runner that works on its own (auto/run.ts),
 * and the rest of what's asked, have a window of their own, which opens without taking the person's attention.
 */
import { workUrl } from './facebook/urls';
import type {
  Answer,
  Ask,
  AutoAnswer,
  PostsAnswer,
  PostsAsk,
  AutoAsk,
  BrowseAnswer,
  BrowseAsk,
  FetchAnswer,
  FetchAsk,
  GroupPostAnswer,
  GroupPostAsk,
  JoinAnswer,
  JoinAsk,
} from './messages';

const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** After a page loads, while Facebook draws it. */
const DRAW_MS = 2_400;

/** Where a work tab opens: in the person's window, in view or out of it; or in a window of its own. */
export type TabPlace = 'view' | 'quiet' | 'window';

export class WorkTab {
  private id: number | null = null;
  private readonly place: TabPlace;

  constructor(place: TabPlace = 'view') {
    this.place = place;
  }

  /** The tab's number, while it's open. */
  get tabId(): number | null {
    return this.id;
  }

  /** Takes over a tab opened before (the runner's, after the background restarted), when it's still open. */
  async adopt(id: number | null): Promise<void> {
    if (id === null) return;
    this.id = await chrome.tabs.get(id).then(
      (tab) => tab.id ?? null,
      () => null,
    );
  }

  /**
   * Opens an address in the tab: the one opened before when it's still there, else a new one. Only Facebook's own
   * pages (`workUrl`): anything else is refused, so a bad link kept or read never sends the tab elsewhere.
   */
  async open(href: string): Promise<number> {
    const url = workUrl(href);
    if (url === null)
      throw new Error(
        'That link isn’t a Facebook page, so the extension didn’t open it. Check the link in HandsFreeOS, then try again.',
      );
    const active = this.place === 'view';
    if (this.id !== null) {
      try {
        const tab = await chrome.tabs.update(this.id, { url, ...(active ? { active } : {}) });
        if (tab?.id !== undefined) return await this.loaded(tab.id);
      } catch {
        // Closed since.
      }
    }
    if (this.place === 'window') {
      // Beside the person's, not in front of it: they keep working while it does.
      const made = await chrome.windows.create({ url, focused: false, width: 1100, height: 900 });
      this.id = made?.tabs?.[0]?.id ?? null;
      if (this.id === null) throw new Error('Chrome didn’t open the window.');
      return this.loaded(this.id);
    }
    const tab = await chrome.tabs.create({ url, active });
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

  /** Brings the tab, and its window, to the front: a step is handed to the person there. */
  async focus(): Promise<void> {
    if (this.id === null) return;
    const tab = await chrome.tabs.update(this.id, { active: true }).catch(() => null);
    if (tab?.windowId !== undefined)
      await chrome.windows.update(tab.windowId, { focused: true }).catch(() => undefined);
  }

  /** Closes the tab, when it's still open; for the runner, its whole window. */
  async close(): Promise<void> {
    const id = this.id;
    this.id = null;
    if (id === null) return;
    if (this.place === 'window') {
      const tab = await chrome.tabs.get(id).catch(() => null);
      if (tab) {
        const all = await chrome.tabs.query({ windowId: tab.windowId }).catch(() => []);
        if (all.length <= 1)
          return void (await chrome.windows.remove(tab.windowId).catch(() => undefined));
      }
    }
    await chrome.tabs.remove(id).catch(() => undefined);
  }

  /** Asks the tab's script, loading it first into a tab opened before the extension was. */
  async ask(message: FetchAsk): Promise<FetchAnswer>;
  async ask(message: PostsAsk): Promise<PostsAnswer>;
  async ask(message: AutoAsk): Promise<AutoAnswer>;
  async ask(message: JoinAsk): Promise<JoinAnswer>;
  async ask(message: GroupPostAsk): Promise<GroupPostAnswer>;
  async ask(message: BrowseAsk): Promise<BrowseAnswer | Answer>;
  async ask(message: Ask): Promise<Answer>;
  async ask(
    message: FetchAsk | AutoAsk | JoinAsk | GroupPostAsk | BrowseAsk | Ask,
  ): Promise<FetchAnswer | AutoAnswer | JoinAnswer | GroupPostAnswer | BrowseAnswer | Answer> {
    if (this.id === null) return { ok: false, error: 'The Facebook tab was closed.' };
    const id = this.id;
    try {
      return (await chrome.tabs.sendMessage(id, message)) as
        FetchAnswer | AutoAnswer | JoinAnswer | GroupPostAnswer | BrowseAnswer | Answer;
    } catch {
      try {
        await chrome.scripting.executeScript({ target: { tabId: id }, files: ['content.js'] });
        return (await chrome.tabs.sendMessage(id, message)) as
          FetchAnswer | AutoAnswer | JoinAnswer | GroupPostAnswer | BrowseAnswer | Answer;
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
