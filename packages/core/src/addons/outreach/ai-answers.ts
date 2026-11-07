/**
 * What the Assistant reads of Social Outreach's answers (each operation's `ai.answer` and `ai.outcome`, in
 * ../../kernel/types.ts): the links its screens build, written out whole, and the short facts ahead of the long lists.
 * They only reshape what the kernel gave the person, so they never show more than the screens do.
 *
 * Browser-safe and pure.
 */
import { CLIENT_CAUSE_WORDS, CLIENT_TAG, type ClientCause } from '../../crm/record-words';
import { chatUrlOn, networkOfUrl, tidyWordsOn } from './network-words';
import { PLATFORM_KEYS, type Platform } from './networks';
import { OUTREACH_PAGE_PATHS, OUTREACH_PAGES } from './pages';
import { SETUP_WORDS, CHROME_EXTENSIONS_URL } from './setup';
import { retriedWords } from './waiting-words';
import { OUTREACH_WORDS } from './words';

const isPlatform = (v: unknown): v is Platform =>
  typeof v === 'string' && (PLATFORM_KEYS as readonly string[]).includes(v);
const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Each chat in an answer with its link to open it on its network (`chatUrl`), beside the `threadKey` the screens build
 * Open in Messenger, Open in LinkedIn messaging and the rest from (`chatUrlOn`). Its network is the row's own, else the
 * one asked about, else the one its profile's link is on.
 */
export function withChatLinks(value: unknown, platform?: Platform | null): unknown {
  if (Array.isArray(value)) return value.map((v) => withChatLinks(v, platform));
  if (!isObject(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) out[k] = withChatLinks(v, platform);
  const key = value['threadKey'];
  if (typeof key === 'string' && key && !('chatUrl' in value)) {
    const own = value['platform'];
    const link = value['profileUrl'] ?? value['url'];
    const on = isPlatform(own)
      ? own
      : (platform ?? networkOfUrl(typeof link === 'string' ? link : null));
    out['chatUrl'] = chatUrlOn(on, key);
  }
  return out;
}

/** The network an operation's input asks about, when it names one. */
export const platformOf = (input: unknown): Platform | null =>
  isObject(input) && isPlatform(input['platform']) ? input['platform'] : null;

/** An answer with its chats' links, on the network the input asks about when its rows don't say. */
export const chatLinksAnswer = (output: unknown, input: unknown): unknown =>
  withChatLinks(output, platformOf(input));

/**
 * The answer's short facts first and its long lists last (each key's order is what the model reads first), so a long
 * day's list never pushes why nothing new is on it, the goal or the limits out of reach.
 */
export function listsLast(output: unknown): unknown {
  if (!isObject(output)) return output;
  const entries = Object.entries(output);
  return Object.fromEntries([
    ...entries.filter(([, v]) => !Array.isArray(v)),
    ...entries.filter(([, v]) => Array.isArray(v)),
  ]);
}

/** Today's list as the model reads it: its chats' links whole, and the facts ahead of the people. */
export const todayAnswer = (output: unknown, input: unknown): unknown =>
  listsLast(chatLinksAnswer(output, input));

/**
 * Where HandsFreeOS's own build of the extension downloads from, on the web app's address (decision 71): the worker
 * writes it out whole. The same name every version, so a newer zip unzips over the same folder.
 */
export const EXTENSION_DOWNLOAD_PATH = '/downloads/hfos-social.zip';

/**
 * The setup as the model reads it: with where to get the extension, as Download it gives it (the business's own link,
 * else HandsFreeOS's build), and the install and update steps the screens show, a step at a time.
 */
export function setupAnswer(output: unknown): unknown {
  if (!isObject(output)) return output;
  const own = typeof output['extensionLink'] === 'string' ? output['extensionLink'] : null;
  return {
    ...output,
    download: {
      link: own ?? EXTENSION_DOWNLOAD_PATH,
      whose: own ? 'The business’s own link' : 'HandsFreeOS’s own build, for Chrome on a computer',
      steps: [
        ...SETUP_WORDS.install.map((s, i) =>
          i === 1
            ? `${s.title}: open ${CHROME_EXTENSIONS_URL} in Chrome’s address bar; the switch is at the top right.`
            : `${s.title}: ${s.text}`,
        ),
        `${SETUP_WORDS.signIn.title}: press the extension and sign in with their HandsFreeOS email. A number shows in HandsFreeOS: pick the same one.`,
      ],
      update: SETUP_WORDS.update,
      stuck: SETUP_WORDS.stuck.items.map((i) => `${i.q}: ${i.a}`),
      note: 'Installing it is the person’s own, on their computer: give them the link and the steps.',
    },
  };
}

/**
 * What the screens' "Is this one of these?" does before anyone goes in Contacts, said to the model on each tool that
 * can add someone there (Add to Contacts, Mark as client, Save to their card), so it never makes a second customer
 * where the screen would have tied the one there.
 */
export const SAME_NAME_FIRST =
  'Before it adds anyone to Contacts, look there for a customer with their name (search_customers), as the screen’s “Is this one of these?” does: if one could be them, ask the person whether it’s them and pass that customer’s personId; add someone new only when the person says nobody there is them.';

type Outcome = { readonly words: string; readonly path?: string | null } | null;

const P = OUTREACH_WORDS.person;
const n = (count: number) => count.toLocaleString('en-US');
/** A customer's page in Contacts, under the business's address. */
const customerPath = (id: unknown): string | null =>
  typeof id === 'string' && id ? `customers/people/${id}` : null;
/** One of Social Outreach's pages, under the business's address. */
const pagePath = (path: string) => `a/outreach/${path}`;

/** Add to Contacts, confirmed: added, tied to the customer the person named, or there already, as its toast says. */
export function contactOutcome(output: unknown, input: unknown): Outcome {
  if (!isObject(output) || typeof output['personName'] !== 'string') return null;
  const name = output['personName'];
  const tied = isObject(input) && typeof input['personId'] === 'string';
  return {
    words: tied ? P.tied(name) : output['addedPerson'] === true ? P.added(name) : P.already(name),
    path: customerPath(output['personId']),
  };
}

/**
 * Mark as client, or Not a client after all, confirmed: what the menu's toast says, without the name the card already
 * shows, with how many waiting messages were skipped and why Contacts may still count them a client.
 */
export function clientOutcome(output: unknown, input: unknown): Outcome {
  if (!isObject(output)) return null;
  const path = customerPath(output['personId']);
  if (isObject(input) && input['client'] === true) {
    const skipped = typeof output['skipped'] === 'number' ? output['skipped'] : 0;
    return {
      words: [
        `A client now: nobody here sends them outreach, and their replies still come to ${OUTREACH_PAGES['needs-you']}.`,
        output['addedPerson'] === true ? 'They were added to Contacts.' : '',
        skipped
          ? `${n(skipped)} ${skipped === 1 ? 'message' : 'messages'} to them waiting for an OK ${skipped === 1 ? 'was' : 'were'} skipped.`
          : '',
      ]
        .filter(Boolean)
        .join(' '),
      path,
    };
  }
  if (output['client'] !== true)
    return {
      words: 'Not a client any more. Messages skipped when they were marked stay skipped.',
      path,
    };
  const cause = output['because'] as ClientCause | null;
  return {
    words:
      cause && cause in CLIENT_CAUSE_WORDS
        ? `The ${CLIENT_TAG} tag is off, but Contacts still counts them a client: ${CLIENT_CAUSE_WORDS[cause]}. To change that, open them in Contacts.`
        : `The ${CLIENT_TAG} tag is off, but they have the same name on this network as a client in Contacts, so Social Outreach still leaves them alone.`,
    path,
  };
}

/** Retry, or Retry all, confirmed: how many go again and how many were passed over, as Needs you says it. */
export function retryOutcome(output: unknown): Outcome {
  if (!isObject(output) || !Array.isArray(output['retried'])) return null;
  const passed = typeof output['passed'] === 'number' ? output['passed'] : 0;
  return {
    words: retriedWords(output['retried'].length, passed),
    path: pagePath(OUTREACH_PAGE_PATHS['needs-you']),
  };
}

/** Cancel all, confirmed: how many it's cancelling, the oldest first, or that it stopped, as its toast says. */
export function cancelAllOutcome(output: unknown, input: unknown): Outcome {
  const platform = platformOf(input) ?? 'facebook';
  const all = tidyWordsOn(platform).all;
  if (!all || !isObject(output)) return null;
  const on = !isObject(input) || input['on'] !== false;
  const marked = typeof output['marked'] === 'number' ? output['marked'] : 0;
  return {
    words: on ? all.started(marked) : all.stopped,
    path: pagePath(`${OUTREACH_PAGE_PATHS.people}/friends`),
  };
}
