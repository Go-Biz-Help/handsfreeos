/**
 * Approving a sign-in to the browser extension from the phone or the web, with a matching number (20261027002900,
 * apps/extension/README.md "Signing in with a prompt"). Browser-safe: the extension, the web prompt, the phone's
 * screen and the worker all read these.
 *
 * 1. The extension sends the email (`POST /public/extension-sign-in/start` on the worker) and shows the number.
 * 2. The person's phones get a push (`extension_sign_in`) and any open HandsFreeOS tab asks, offering three numbers.
 * 3. The right number approves it (`extension_sign_in.answer`); a wrong one, or "That wasn't me", refuses it.
 * 4. The extension asks every couple of seconds with its secret (`…/collect`) and, once approved, gets a one-time
 *    sign-in token that it redeems with Supabase Auth.
 *
 * No zod here, so the extension stays small: the shapes on the wire are in ./extension-sign-in.ts.
 */

/** How long a request can be answered. */
export const EXTENSION_SIGN_IN_TTL_MS = 2 * 60_000;
/** How often the extension asks whether it was answered. */
export const EXTENSION_SIGN_IN_POLL_MS = 2_000;
/** How often an open HandsFreeOS tab looks for a request to answer, while it is in front. */
export const EXTENSION_SIGN_IN_WATCH_MS = 4_000;

/**
 * The number the extension shows (10–99) and the three a prompt offers: it and two others, in a random order. `rand`
 * answers a whole number from 0 up to (not including) its argument; the worker passes crypto's.
 */
export function extensionSignInNumbers(rand: (below: number) => number): {
  readonly number: number;
  readonly choices: readonly [number, number, number];
} {
  const number = 10 + rand(90);
  const picked = new Set([number]);
  while (picked.size < 3) picked.add(10 + rand(90));
  const choices = [...picked];
  // Fisher–Yates, so the right one is anywhere.
  for (let i = choices.length - 1; i > 0; i -= 1) {
    const j = rand(i + 1);
    [choices[i], choices[j]] = [choices[j]!, choices[i]!];
  }
  return { number, choices: choices as [number, number, number] };
}

/** The browser the request names, as people call it ("Chrome"); anything unknown is just "your browser". */
export function extensionBrowserName(browser: string | null | undefined): string {
  const b = (browser ?? '').trim();
  return b ? b.slice(0, 40) : 'your browser';
}

/** The prompt's words, on the web and the phone alike. */
export const EXTENSION_SIGN_IN_WORDS = {
  question: (browser: string) => `Signing in to the extension on ${extensionBrowserName(browser)}?`,
  pick: 'Pick the number you see.',
  notMe: 'That wasn’t me',
  approved: 'Done. The extension is signing in now.',
  refused: 'That number didn’t match, so the sign-in was stopped. Nobody got in.',
  denied: 'Stopped. Nobody got in.',
  gone: 'That sign-in already ended. If it was you, press Send me a prompt in the extension again.',
} as const;

/** The push's words: who it's for is the person themselves, so it names the browser alone. */
export function extensionSignInPushWords(browser: string): { title: string; body: string } {
  return {
    title: EXTENSION_SIGN_IN_WORDS.question(browser),
    body: 'Open to pick the number the extension shows. It ends in 2 minutes.',
  };
}

/** What the extension says while it waits, and when it can't go on. */
export const EXTENSION_SIGN_IN_STATUS_WORDS = {
  waiting: 'Pick this number on your phone or in HandsFreeOS.',
  refused:
    'The number picked didn’t match, so this sign-in was stopped. Send another prompt, or use an emailed code.',
  expired: 'This prompt ran out. Send another, or use an emailed code.',
} as const;
