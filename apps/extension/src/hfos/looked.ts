/**
 * What the content script read as the person went, in the Facebook tab in front of them (docs/outreach.md, decision
 * 43; src/facebook/looking.ts), which the side panel used to read beside them:
 *
 * - **Facebook's warnings** are noted in HandsFreeOS, once a day for the same words (decision 25): the extension then
 *   does nothing more on Facebook that day, and the person's daily limits are halved for a week.
 * - **A chat they opened**, with Read chats I open on, is sent for the AI to read (../jobs/chats.ts), when there's
 *   something new in it.
 * - **A group's posts as they scroll**, with Look for posts as I scroll on, are sent for the AI to check (decision
 *   18); the good ones go on Today's list. Each post at most every half hour.
 *
 * Nothing after a warning that day. Never throws.
 */
import { chatMemory, sendChat } from '../jobs/chats';
import type { Hfos } from '../jobs/job';
import type { TabNote } from '../messages';
import { postsSave } from './saves';
import { answer, savingTo } from './session';
import { keepWarning, warnedNow, warningInput } from './warned';

type Looked = Extract<TabNote, { type: 'hfos-looked' }>;

/** A post sent to be checked isn't sent again for this long, as the person keeps scrolling. */
const POST_AGAIN_MS = 30 * 60_000;
const POSTS_REMEMBERED = 2_000;
const postsSent = new Map<string, number>();

/**
 * Notes Facebook's warning words in HandsFreeOS, once a day for the same words, in the business it saves to. Never
 * throws: a warning that couldn't be sent still stops the extension for the day.
 */
export async function noteWarnings(
  businessId: string | null,
  words: readonly string[],
  url: string | null,
): Promise<void> {
  if (!words.length) return;
  try {
    const fresh = await keepWarning(words);
    if (fresh.length && businessId)
      await answer({ type: 'hfos-warning', input: warningInput(businessId, fresh, url) });
  } catch (error) {
    console.error('HandsFreeOS Social couldn’t note a Facebook warning', error);
  }
}

/** The posts on a group's page not sent in the last half hour, sent for the AI to check. */
async function sendPosts(note: Looked, businessId: string): Promise<void> {
  if (!note.result) return;
  const built = postsSave(note.result, businessId, 'scroll');
  if (!built.ok) return;
  const now = Date.now();
  const due = built.input.posts.filter(
    (post) => now - (postsSent.get(post.url) ?? 0) > POST_AGAIN_MS,
  );
  if (!due.length) return;
  const sent = await answer({ type: 'hfos-save-posts', input: { ...built.input, posts: due } });
  if (!sent.ok) return;
  for (const post of due) postsSent.set(post.url, now);
  if (postsSent.size > POSTS_REMEMBERED)
    for (const [url] of [...postsSent].sort((a, b) => a[1] - b[1]).slice(0, POSTS_REMEMBERED / 2))
      postsSent.delete(url);
}

/** Whether a tab's note has the shape of one: the tab's script is the extension's own; what it read was a page's. */
export function isLooked(note: unknown): note is Looked {
  const n = note as Partial<Looked> | null;
  return (
    !!n &&
    n.type === 'hfos-looked' &&
    typeof n.url === 'string' &&
    Array.isArray(n.warnings) &&
    n.warnings.every((w) => typeof w === 'string') &&
    (n.result === null || (typeof n.result === 'object' && n.result !== undefined))
  );
}

/** What the person's front tab showed: noted and saved as above. */
export async function looked(note: Looked): Promise<void> {
  try {
    const place = await savingTo().catch(() => null);
    if (note.warnings.length)
      return await noteWarnings(place?.businessId ?? null, note.warnings, note.url);
    if (!place || !note.result || (await warnedNow())) return;
    const page = note.result;
    if (page.kind === 'chat' && page.chat) {
      const listed = page.chats?.find((c) => c.thread.id === page.chat?.thread?.id) ?? null;
      await sendChat(answer as Hfos, place.businessId, chatMemory, page.chat, listed);
    } else if (page.kind === 'group') await sendPosts(note, place.businessId);
  } catch (error) {
    console.debug('HandsFreeOS Social couldn’t save what you looked at', error);
  }
}
