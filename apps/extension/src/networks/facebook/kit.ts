/**
 * Facebook's kit (../kit.ts): the network the extension has always worked on, on from the start, on the sites the
 * manifest asks for at install. Its readers, the person's steps there, what to look at as they go and its outline are
 * the files beside this one; so are the runner's and the asks' steps (./work.ts).
 */
import { NETWORKS } from '@hfos/core/addons/outreach/networks';
import { isWholeAddress, type Kit, type Noticed } from '../kit';
import { answerFromClick, seenFromClick, stepFromClick, stepFromEnter } from './actions';
import { lookFor } from './looking';
import { FACEBOOK_OUTLINE, outlinePage } from './outline';
import { readPage } from './page';
import { readReplies } from './replies';
import type { PageKind, ReadResult } from './types';
import { classifyUrl, facebookUrl, profileKey, workUrl } from './urls';
import { readWarnings } from './warnings';
import { work } from './work';

/**
 * Facebook's pages, where its script runs from install: www and web, and Accounts Center, where Facebook makes the
 * person's download file (./fetch.ts) and where their username and name are changed (../accounts-center/username.ts,
 * ../accounts-center/name.ts). scripts/build.mjs writes
 * the same into the manifest; test/manifest.test.ts holds the two together.
 */
export const FACEBOOK_HOSTS = [
  'https://www.facebook.com/*',
  'https://web.facebook.com/*',
  'https://accountscenter.facebook.com/*',
] as const;

export const facebook: Kit = {
  platform: 'facebook',
  network: NETWORKS.facebook,
  hosts: FACEBOOK_HOSTS,
  registered: false,
  startsOn: true,
  owns: (href) => isWholeAddress(href) && facebookUrl(href) !== null,
  workUrl,
  kindOf: (href) => classifyUrl(href).kind,
  profileKey,
  readPage: (doc, href) => readPage(doc, href),
  readWarnings,
  readReplies: (doc, href) => readReplies(doc, href),
  lookFor: (kind, on) => lookFor(kind as PageKind, on),
  noticer: () => ({
    click(target, doc, href, keyed = false): Noticed | null {
      const step = stepFromClick(target, doc, href);
      if (step) return { kind: 'step', step };
      const answered = answerFromClick(target, doc, href);
      if (answered) return { kind: 'answer', answered };
      if (keyed) return null;
      const seen = seenFromClick(target, doc, href);
      return seen ? { kind: 'seen', seen } : null;
    },
    enter(target, doc, href): Noticed | null {
      const step = stepFromEnter(target, doc, href);
      return step ? { kind: 'step', step } : null;
    },
  }),
  outline: (doc, href, options = {}) =>
    outlinePage(doc, href, { ...options, found: options.found as ReadResult | undefined }),
  outlineSite: FACEBOOK_OUTLINE,
  work,
};
