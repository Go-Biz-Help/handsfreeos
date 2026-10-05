/**
 * What Social Outreach's saves take (docs/outreach.md): how long, how many, and the shape of a network's ids. The
 * commands hold what's sent to these (./saves.ts), and the browser extension cuts what it read to fit them before it
 * sends. Plain values with no zod, so the extension takes them without carrying zod along.
 */

/** A chat keeps this many of its most recent messages, and a save sends at most this many. */
export const KEPT_MESSAGES = 100;
/** A person's name, and a sender's on a message. */
export const NAME_MOST = 200;
/** The lines under a profile's name, and how long each. */
export const INTRO_LINES = 30;
export const INTRO_LINE_MOST = 300;
/** One message's words. */
export const MESSAGE_MOST = 2000;
/** When a message was sent, as the network printed it. */
export const WHEN_MOST = 100;
/** What one look-up asks about. */
export const LOOKUP_PROFILES = 200;
export const LOOKUP_THREADS = 50;
export const LOOKUP_NAMES = 10;

/** A profile's number, its username, and a chat's own number, as their links show them. */
export const PROFILE_ID = /^\d{1,30}$/;
export const USERNAME = /^[A-Za-z0-9.]{1,100}$/;
export const THREAD_KEY = /^[A-Za-z0-9._-]{1,64}$/;
