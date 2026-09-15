/** Website chat's fixed limits, shared by core, the worker's chat routes and Settings. */

/** A visitor's previous token keeps working this long after the chat window gets a new one. */
export const CHAT_TOKEN_GRACE_MS = 10 * 60_000;
/** A visitor's token is replaced once it's this old. */
export const CHAT_TOKEN_ROTATE_MS = 7 * 86_400_000;
/** "Block their network too" lasts this long. */
export const CHAT_NETWORK_BLOCK_MS = 7 * 86_400_000;
/** "On the site now": their chat window checked in this recently. */
export const CHAT_ON_SITE_MS = 2 * 60_000;
/** The longest message a visitor can send. */
export const CHAT_MESSAGE_MAX = 1000;
/** The name a customer gets when a chat visitor leaves a phone or email but no name. */
export const CHAT_VISITOR_NAME = 'Website visitor';
/** The source on customers a website chat adds. */
export const CHAT_PERSON_SOURCE = 'Website chat';
