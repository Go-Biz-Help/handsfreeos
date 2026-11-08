/**
 * AI Social Media Content Creator's hands in its reading tab (docs/socialcontent.md; ./run.ts), built as research.js.
 * The background loads it into the one tab it reads in, and only there: it's never a content script of its own on any
 * site, and it isn't Social Outreach's (src/content.ts), so the two add-ons never share a tab's work (decision 1). It
 * answers through `globalThis.hfosResearch`, which the background calls with Chrome's `executeScript` in this script's
 * own world, so no other script in the tab hears what it's asked.
 *
 * - `get`: one of the answers the network's own pages load (./instagram.ts `INSTAGRAM_READS`), on the person's own
 *   signed-in account, as the page asks for it. Nothing else: it never posts, and never asks another site.
 * - `read`: the page as its network's readers see it (Facebook's and LinkedIn's: a profile, its posts, a search's
 *   people and posts), for the reads that go by the page itself (./page-read.ts). `scroll`: one screen further down,
 *   as a person scrolls, for the network to load more.
 * - `warnings`: the network's warnings on the page now ("Try again later"), which stop the network for the day.
 * - `outline`: the page, read by its network's readers, with its outline (everything a person wrote as "[2 words]"),
 *   for the read's problem report.
 * - `watch`: a standout video watched for the AI (./watch.ts): a few frames from it, and its sound.
 * - `view` and `move`: the AI helper's (core's addons/socialcontent/helper.ts), as Social Outreach's steps have
 *   (src/networks/helper-view.ts): a view of the page with everything a person wrote hidden, and one move on it that
 *   clears the way. Never a press: a read has no button of its own.
 */
import { kitHere } from '../networks';
import { HelperHands, type HelperMoveAsk, type HelperMoveDone } from '../networks/helper-view';
import { INSTAGRAM_APP_ID, INSTAGRAM_READS } from './instagram';
import { watchVideo, type WatchAsk, type Watched } from './watch';

/** What the background gets back from `get`: the answer's status and body, or why there's none. */
export interface ResearchGot {
  readonly ok: boolean;
  readonly status: number;
  readonly json: unknown;
  readonly error?: string;
}

/** The page as its network's readers see it, for a report. */
export interface ResearchOutline {
  readonly result: Record<string, unknown> & {
    readonly kind: string;
    readonly warnings: readonly string[];
  };
  readonly outline: string;
  readonly shown: boolean;
}

/** Where `scroll` got to. */
export interface ResearchScrolled {
  readonly moved: boolean;
  readonly atEnd: boolean;
}

export interface ResearchHands {
  get(path: string): Promise<ResearchGot>;
  /** The page as its network's readers see it (a kit's `readPage`). */
  read(): unknown;
  scroll(): ResearchScrolled;
  outline(): ResearchOutline;
  /** The network's warnings on the page now. */
  warnings(): string[];
  view(fresh: boolean): string;
  move(ask: HelperMoveAsk): Promise<HelperMoveDone>;
  watch(ask: WatchAsk): Promise<Watched>;
}

/** What each network's pages send with what they ask for. */
function headersFor(platform: string): Record<string, string> | null {
  if (platform !== 'instagram') return null;
  const csrf = /(?:^|;\s*)csrftoken=([^;]+)/.exec(document.cookie)?.[1];
  return {
    accept: '*/*',
    'x-ig-app-id': INSTAGRAM_APP_ID,
    'x-requested-with': 'XMLHttpRequest',
    ...(csrf ? { 'x-csrftoken': csrf } : {}),
  };
}

const here = globalThis as { hfosResearch?: ResearchHands };
const kit = kitHere(location.href);

if (kit && !here.hfosResearch) {
  const hands = new HelperHands(kit.outlineSite, () => null);
  here.hfosResearch = {
    async get(path) {
      const headers = headersFor(kit.platform);
      if (!headers || !INSTAGRAM_READS.test(path))
        return { ok: false, status: 0, json: null, error: 'Not something it reads.' };
      try {
        const response = await fetch(`${location.origin}${path}`, {
          credentials: 'include',
          headers,
        });
        const body = await response.text();
        let json: unknown = null;
        try {
          json = JSON.parse(body);
        } catch {
          // A page in place of an answer: Instagram sent it to sign in, most often.
        }
        return { ok: response.ok && json !== null, status: response.status, json };
      } catch (error) {
        return {
          ok: false,
          status: 0,
          json: null,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
    outline() {
      const result = kit.readPage(document, location.href) as unknown as ResearchOutline['result'];
      const outline = kit.outline(document, location.href, {
        version: chrome.runtime.getManifest().version,
        found: result as never,
        window: { width: innerWidth, height: innerHeight },
      });
      return { result, outline, shown: document.visibilityState === 'visible' };
    },
    read: () => JSON.parse(JSON.stringify(kit.readPage(document, location.href))) as unknown,
    scroll() {
      const before = scrollY;
      scrollBy({ top: Math.round(innerHeight * 0.9) });
      return {
        moved: scrollY !== before,
        atEnd: innerHeight + scrollY >= document.documentElement.scrollHeight - 40,
      };
    },
    warnings: () => kit.readWarnings(document, location.href),
    view: (fresh) => hands.look(document, location.href, fresh),
    move: (ask) => hands.move(document, { ...ask, do: ask.do === 'press' ? 'wait' : ask.do }, null),
    watch: (ask) => watchVideo(ask),
  };
}
