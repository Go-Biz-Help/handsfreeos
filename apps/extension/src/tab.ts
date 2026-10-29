/**
 * The tab the extension works in, on one network's pages (its kit's `workUrl`): each network's asks have their own
 * (asks/run.ts), and the runner Facebook's. What the person asks of it from HandsFreeOS that they may need to finish
 * themselves (getting their file, where they type their password; cancelling old requests, withdrawing invitations and
 * unfriending)
 * goes in a tab in view, reused from step to step while it's open, and brought to the front when a step is handed to
 * them. A quiet one opens out of view and closes after. The runner that works on its own (auto/run.ts), and the rest of
 * what's asked, have a window of their own, which opens beside the person's without taking their attention. A read that
 * needs the screen brings it in front: a Check right away, anything else only while the person is away from their
 * computer (decision 120, ./away.ts), stepping back the moment they're back.
 */
import { awayNow, type Hold, markDark, NotAway, onBack } from './away';
import { catchCopiesIn } from './networks/copies';
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
  StoryAnswer,
  StoryAsk,
  CommentLikeAnswer,
  CommentLikeAsk,
  TheirCommentAnswer,
  TheirCommentAsk,
  GroupFeedAnswer,
  GroupFeedAsk,
  GroupLikeAsk,
  PostPeopleAnswer,
  PostPeopleAsk,
  FetchAnswer,
  FetchAsk,
  GroupPostAnswer,
  GroupPostAsk,
  PostLinksAnswer,
  PostLinksAsk,
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
/** While a read waits for the person to be away, it looks again this often. */
const AWAY_LOOK_MS = 5_000;
/** Its own window's size: the layout every network's readers were tuned on. */
const WIDTH = 1100;
const HEIGHT = 900;

/** Where a work tab opens: in the person's window, in view or out of it; or in a window of its own. */
export type TabPlace = 'view' | 'quiet' | 'window';

/** When a read that needs the screen brings its window in front: right away (a Check), or only while they're away. */
export type FrontWhen = 'now' | 'away';

export interface TabOptions {
  /** A Check comes in front right away; the rest only while the person is away (decision 120). Right away unless said. */
  readonly front?: FrontWhen;
  /** Whether such a read waits for them to be away (an ask's), or is put off for later (the runner's, `NotAway`). */
  readonly waits?: boolean;
}

/** The person's window Chrome last had in front, when it says. */
const lastFocused = () =>
  Promise.resolve()
    .then(() => chrome.windows.getLastFocused())
    .catch(() => null);

/** Whose window is in front for a read: one at a time, so two networks' never take turns over each other. */
let onScreen: symbol | null = null;

export class WorkTab {
  private id: number | null = null;
  /** What holds the screen for its reads, while it does (`onScreen`). */
  private readonly key = Symbol('work tab');
  /** While `inFront` runs: a window it opens then opens in front. */
  private front = false;
  /** While `inFront` runs: the person's window, put back in front after. */
  private back: number | null = null;
  /** While `inFront` runs: what says a read waits for the person to be away, and whether it was stopped. */
  private hold: Hold | null = null;
  /** While `inFront` runs, once the person was back: its window stepped back behind theirs. */
  private stepped = false;
  private readonly place: TabPlace;
  private readonly kit: Kit;
  private readonly when: FrontWhen;
  private readonly waits: boolean;

  constructor(
    place: TabPlace = 'view',
    kit: Kit = facebook,
    { front = 'now', waits = true }: TabOptions = {},
  ) {
    this.place = place;
    this.kit = kit;
    this.when = front;
    this.waits = waits;
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
      // Beside the person's, not in front of it, so they keep working while it does; unless it's to be in front. At
      // their window's right, so where it shows over theirs it leaves its left in view.
      const theirs = await lastFocused();
      const beside =
        theirs?.left !== undefined && theirs.top !== undefined && theirs.width !== undefined
          ? { left: Math.max(theirs.left, theirs.left + theirs.width - WIDTH), top: theirs.top }
          : {};
      const made = await chrome.windows.create({
        url,
        focused: this.front,
        width: WIDTH,
        height: HEIGHT,
        ...beside,
      });
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
    await this.keepInFront();
    return id;
  }

  /**
   * While `inFront` runs: brings its window back in front when the person put another over it meanwhile, as Chrome
   * draws nothing in a window hidden behind another (the owner's Check of LinkedIn, 28 Oct 2026: once another window
   * went over it, the box of who reacted drew nobody). Else nothing. Done for each page it opens, and before each step a
   * Check tries.
   */
  async keepInFront(): Promise<void> {
    if (!this.front || this.id === null) return;
    const id = this.id;
    // Away (decision 120): the person came back meanwhile, so it waits till they're away again, or is put off.
    if (this.when === 'away' && this.stepped) return this.comeBack();
    if ((await this.seen(id)) !== 'hidden') return;
    if (this.when === 'away' && !(await awayNow())) {
      this.stepped = true;
      return this.comeBack();
    }
    // The window they put over it is the one they get back after.
    const [tab, now] = await Promise.all([chrome.tabs.get(id).catch(() => null), lastFocused()]);
    if (now?.id !== undefined && now.id !== tab?.windowId) this.back = now.id;
    await this.focus();
    await pause(DRAW_MS);
    // Still not drawn in front while they're away: their screen is asleep or locked, so it waits till it's lit.
    if (this.when === 'away' && (await this.seen(id)) === 'hidden') {
      markDark();
      this.stepped = true;
      return this.comeBack();
    }
  }

  /** Whether Chrome draws the page in the tab: `visible` or `hidden`, as the page says; null when it can't be asked. */
  private async seen(id: number): Promise<unknown> {
    try {
      const [ran] = await chrome.scripting.executeScript({
        target: { tabId: id },
        func: () => document.visibilityState,
      });
      return ran?.result ?? null;
    } catch {
      // A page the extension can't look at: left as it is.
      return null;
    }
  }

  /**
   * Till the person is away from their computer (decision 120), with no other window in front for a read: an ask
   * waits, saying so, and ends when it's stopped meanwhile; the runner's read is put off for later (`NotAway`).
   */
  private async untilAway(hold: Hold | null): Promise<void> {
    const free = async () => (onScreen === null || onScreen === this.key) && (await awayNow());
    if (await free()) return;
    if (!this.waits) throw new NotAway();
    hold?.say(new NotAway().message);
    for (;;) {
      if (hold?.stopped()) throw new NotAway();
      await pause(AWAY_LOOK_MS);
      if (await free()) return;
    }
  }

  /** After the person was back: in front again once they're away again, or put off for the runner. */
  private async comeBack(): Promise<void> {
    await this.untilAway(this.hold);
    this.stepped = false;
    await this.focus();
    await pause(DRAW_MS);
  }

  /** The person is back while its window is in front for a read: theirs goes back in front of it right away. */
  private async stepBack(): Promise<void> {
    if (!this.front || this.stepped) return;
    this.stepped = true;
    await this.giveBack();
  }

  /**
   * Puts back the window the person had in front: only while its own is still in front, as a person who went on to
   * another window keeps it. Away, when they weren't in Chrome, its own steps back behind whatever was next: theirs.
   */
  private async giveBack(): Promise<void> {
    const tab = this.id === null ? null : await chrome.tabs.get(this.id).catch(() => null);
    const now = await lastFocused();
    if (tab?.windowId === undefined || now?.id !== tab.windowId || now.focused === false) return;
    if (this.back !== null && this.back !== tab.windowId)
      await chrome.windows.update(this.back, { focused: true }).catch(() => undefined);
    else if (this.when === 'away' && this.back === null)
      await chrome.windows.update(tab.windowId, { focused: false }).catch(() => undefined);
  }

  /** Brings the tab, and its window, to the front: a step is handed to the person there. */
  async focus(): Promise<void> {
    if (this.id === null) return;
    const tab = await chrome.tabs.update(this.id, { active: true }).catch(() => null);
    if (tab?.windowId !== undefined)
      await chrome.windows.update(tab.windowId, { focused: true }).catch(() => undefined);
  }

  /**
   * Brings its window to the front while `work` runs, opening it in front when it isn't open yet, then puts back the
   * window the person had in front: only while its own is still in front, as a person who went on to another window
   * keeps it. Some pages draw only what's on screen, and Chrome draws nothing in a window hidden behind another:
   * LinkedIn's profile drew nothing below Activity in one (the owner's test, 16 Oct 2026). Put behind another while it
   * works, it comes back in front for its next page (`keepInFront`), and that other window is the one put back after. A
   * tab in the person's window is left as it is.
   *
   * Outside a Check (decision 120) it comes in front only once the person has been away from their computer for two
   * minutes, with no other network's window in front: an ask waits till then, saying so through `hold`; the runner's
   * read is put off (`NotAway`). The moment they're back their window goes back in front of its own, and the read goes
   * on in front again only once they're away again (an ask's), or is put off at its next page or step (the runner's).
   */
  async inFront<T>(work: () => Promise<T>, hold?: Hold): Promise<T> {
    if (this.place !== 'window' || this.front) return work();
    const away = this.when === 'away';
    if (away) await this.untilAway(hold ?? null);
    const theirs = await lastFocused();
    // Away, when they weren't in Chrome, none of its windows is put over what they were in after.
    this.back = away && theirs?.focused === false ? null : (theirs?.id ?? null);
    this.front = true;
    this.hold = hold ?? null;
    this.stepped = false;
    onScreen = this.key;
    const listening = away ? onBack(() => void this.stepBack()) : null;
    await this.focus();
    try {
      return await work();
    } finally {
      listening?.();
      this.front = false;
      this.hold = null;
      if (onScreen === this.key) onScreen = null;
      if (!this.stepped) await this.giveBack();
      this.stepped = false;
      this.back = null;
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

  /**
   * Has the page catch what it copies while its tab's script says to (./networks/copies.ts): run in the page's own
   * world, as only that changes what the page's own code copies with. Whether it could.
   */
  async catchCopies(): Promise<boolean> {
    if (this.id === null) return false;
    try {
      const [ran] = await chrome.scripting.executeScript({
        target: { tabId: this.id },
        world: 'MAIN',
        func: catchCopiesIn,
      });
      return ran?.result === true;
    } catch {
      return false;
    }
  }

  /** Asks the tab's script, loading it first into a tab opened before the extension was. */
  async ask(message: FetchAsk): Promise<FetchAnswer>;
  async ask(message: PostLinksAsk): Promise<PostLinksAnswer>;
  async ask(message: PostsAsk): Promise<PostsAnswer>;
  async ask(message: AutoAsk): Promise<AutoAnswer>;
  async ask(message: ConnectAsk): Promise<AutoAnswer>;
  async ask(message: OpenMessageAsk): Promise<BrowseAnswer>;
  async ask(message: JoinAsk): Promise<JoinAnswer>;
  async ask(message: GroupPostAsk): Promise<GroupPostAnswer>;
  async ask(message: FeedPostAsk): Promise<FeedPostAnswer>;
  async ask(message: StoryAsk): Promise<StoryAnswer>;
  async ask(message: TheirCommentAsk): Promise<TheirCommentAnswer>;
  async ask(message: CommentLikeAsk): Promise<CommentLikeAnswer>;
  async ask(message: GroupFeedAsk): Promise<GroupFeedAnswer>;
  async ask(message: GroupLikeAsk): Promise<AutoAnswer>;
  async ask(message: PostPeopleAsk): Promise<PostPeopleAnswer>;
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
      | PostLinksAsk
      | FeedPostAsk
      | StoryAsk
      | TheirCommentAsk
      | CommentLikeAsk
      | GroupFeedAsk
      | GroupLikeAsk
      | PostPeopleAsk
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
    | PostLinksAnswer
    | FeedPostAnswer
    | StoryAnswer
    | TheirCommentAnswer
    | CommentLikeAnswer
    | GroupFeedAnswer
    | PostPeopleAnswer
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
    // The person came back while it read in front (decision 120): it waits till they're away again, or is put off.
    if (this.front && this.when === 'away' && this.stepped) await this.comeBack();
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
