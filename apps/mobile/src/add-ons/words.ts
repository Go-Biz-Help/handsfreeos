import { ADDON_PAGE_WORDS } from '@hfos/core';

/**
 * The Add-ons screens' words. Everything the web's page also says is core's (`ADDON_PAGE_WORDS`, and the state, move
 * and check words and sentence helpers in `packages/core/src/addons/words.ts`), so the two say exactly the same
 * thing; the phone adds only what comes of working without signal.
 */
export const ADDON_PHONE_WORDS = {
  ...ADDON_PAGE_WORDS,
  loading: 'Getting add-ons…',
  needsSignal: 'Add-ons need signal. Try again when you’re back online.',
  retry: 'Try again',
  cancel: 'Cancel',
  cantNow: 'That can’t be done right now.',
  notFound: 'That add-on isn’t here. It may have been taken out of HandsFreeOS.',
  /** An add-on's screen for someone who doesn't have it here (off, or not given to them): the phone can't tell which. */
  unavailableTitle: 'This isn’t available here',
  unavailable: (name: string) =>
    `${name} isn’t on for you in this business. If you need it, ask an owner or an admin.`,
} as const;
