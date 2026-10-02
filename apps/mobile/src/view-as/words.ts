import { VIEW_AS_WORDS } from '@hfos/core';

/**
 * Viewing as a teammate on the phone (20261018000100): core's words, which the web says too, and the few only the
 * phone needs.
 */
export const VIEW_AS_PHONE_WORDS = {
  ...VIEW_AS_WORDS,
  moreDetail: 'See the app the way they see it',
  loading: 'Finding your team…',
  stopFirst: (name: string) =>
    `You’re viewing as ${name}. Stop viewing (at the top) to pick someone else.`,
} as const;
