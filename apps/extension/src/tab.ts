/**
 * The tab the extension works in, on one network's pages (its kit's `workUrl`): each network's asks have their own
 * (asks/run.ts), and the runner Facebook's. What the person asks of it from HandsFreeOS that they may need to finish
 * themselves (getting their file, where they type their password; cancelling old requests, withdrawing invitations and
 * unfriending)
 * goes in a tab in view, reused from step to step while it's open, and brought to the front when a step is handed to
 * them. A quiet one opens out of view and closes after. The runner that works on its own (auto/run.ts), and the rest of
 * what's asked, have a window of their own, which opens without taking the person's attention.
 */
import { facebook, type Kit } from './networks';
import type {
  Answer,
  Ask,
  AutoAnswer,
  PostsAnswer,
  PostsAsk,
  AutoAsk,
  BrowseAnswer,
  BrowseAsk,
  ConnectAsk,
  OpenMessageAsk,
  FeedPostAnswer,
  FeedPostAsk,
  FetchAnswer,
  FetchAsk,
  GroupPostAnswer,
  GroupPostAsk,
  JoinAnswer,
  JoinAsk,
  CodeAnswer,
  CodeAsk,
  OwnProfileAnswer,
  OwnProfileAsk,
  PageThereAnswer,
  PageThereAsk,
  ProfileEditAnswers,
  ProfileEditAsk,
  WriteNameAsk,
  TryAnswer,
  TryAsk,
  UnfollowAnswer,
  UnfollowAsk,
  WithdrawAnswer,
  WithdrawAsk,
} from './messages';

const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** After a page loads, while Facebook draws it. */
const DRAW_MS = 2_400;

/** Where a work tab opens: in the person's window, in view or out of it; or in a window of its own. */
export type TabPlace = 'view' | 'quiet' | 'window';

export class WorkTab {
  private id: number | null = null;
  private readonly place: TabPlace;
  private readonly kit: Kit;

  constructor(place: TabPlace = 'view', kit: Kit = facebook) {
    this.place = place;
    this.kit = kit;
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
   * Opens an address in the tab: the one opened before when it's still there, else a new one. Only its network's own
   * pages (the kit's `workUrl`): anything else is refused, so a bad link kept or read never sends the tab elsewhere.
   */
  async open(href: string): Promise<number> {
    const url = this.kit.workUrl(href);
    if (url === null)
      throw new Error(
        `That link isn’t a ${this.kit.network.name} page, so the extension didn’t open it. Check the link in HandsFreeOS, then try again.`,
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

  /** Waits for a tab to finish loading, and for the network to draw the page. */
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

  /**
   * Brings its window to the front while `work` runs, then puts back the window the person had in front. Some pages
   * draw only what's on screen, and Chrome draws nothing in a window hidden behind another: LinkedIn's profile drew
   * nothing below Activity in one (the owner's test, 16 Oct 2026). A tab in the person's window is left as it is.
   */
  async inFront<T>(work: () => Promise<T>): Promise<T> {
    const id = this.id;
    if (id === null || this.place !== 'window') return work();
    const theirs = await chrome.windows.getLastFocused().catch(() => null);
    await this.focus();
    try {
      return await work();
    } finally {
      const tab = await chrome.tabs.get(id).catch(() => null);
      if (theirs?.id !== undefined && theirs.id !== tab?.windowId)
        await chrome.windows.update(theirs.id, { focused: true }).catch(() => undefined);
    }
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
  async ask(message: ConnectAsk): Promise<AutoAnswer>;
  async ask(message: OpenMessageAsk): Promise<BrowseAnswer>;
  async ask(message: JoinAsk): Promise<JoinAnswer>;
  async ask(message: GroupPostAsk): Promise<GroupPostAnswer>;
  async ask(message: FeedPostAsk): Promise<FeedPostAnswer>;
  async ask(message: OwnProfileAsk): Promise<OwnProfileAnswer>;
  async ask(message: WriteNameAsk): Promise<OwnProfileAnswer>;
  async ask<A extends ProfileEditAsk>(message: A): Promise<ProfileEditAnswers[A['type']]>;
  async ask(message: PageThereAsk): Promise<PageThereAnswer>;
  async ask(message: CodeAsk): Promise<CodeAnswer>;
  async ask(message: TryAsk): Promise<TryAnswer>;
  async ask(message: WithdrawAsk): Promise<WithdrawAnswer>;
  async ask(message: UnfollowAsk): Promise<UnfollowAnswer>;
  async ask(message: BrowseAsk): Promise<BrowseAnswer | Answer>;
  async ask(message: Ask): Promise<Answer>;
  async ask(
    message:
      | FetchAsk
      | AutoAsk
      | ConnectAsk
      | OpenMessageAsk
      | JoinAsk
      | GroupPostAsk
      | FeedPostAsk
      | OwnProfileAsk
      | WriteNameAsk
      | ProfileEditAsk
      | PageThereAsk
      | CodeAsk
      | TryAsk
      | WithdrawAsk
      | UnfollowAsk
      | BrowseAsk
      | Ask,
  ): Promise<
    | FetchAnswer
    | AutoAnswer
    | JoinAnswer
    | GroupPostAnswer
    | FeedPostAnswer
    | OwnProfileAnswer
    | ProfileEditAnswers[ProfileEditAsk['type']]
    | PageThereAnswer
    | CodeAnswer
    | TryAnswer
    | WithdrawAnswer
    | UnfollowAnswer
    | BrowseAnswer
    | Answer
  > {
    if (this.id === null)
      return { ok: false, error: `The ${this.kit.network.name} tab was closed.` };
    const id = this.id;
    try {
      return (await chrome.tabs.sendMessage(id, message)) as
        | FetchAnswer
        | AutoAnswer
        | JoinAnswer
        | GroupPostAnswer
        | OwnProfileAnswer
        | CodeAnswer
        | TryAnswer
        | WithdrawAnswer
        | UnfollowAnswer
        | BrowseAnswer
        | Answer;
    } catch {
      try {
        await chrome.scripting.executeScript({ target: { tabId: id }, files: ['content.js'] });
        return (await chrome.tabs.sendMessage(id, message)) as
          | FetchAnswer
          | AutoAnswer
          | JoinAnswer
          | GroupPostAnswer
          | OwnProfileAnswer
          | CodeAnswer
          | TryAnswer
          | WithdrawAnswer
          | UnfollowAnswer
          | BrowseAnswer
          | Answer;
      } catch {
        const name = this.kit.network.name;
        return {
          ok: false,
          error: `${name} took the tab somewhere else. Check you’re signed in to ${name} in this browser, then try again.`,
        };
      }
    }
  }
}
