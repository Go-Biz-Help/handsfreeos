/**
 * The kit of a network still looked at (../kit.ts; ./site.ts): Instagram's and Alignable's, built from their sites.
 * Their sites are asked for when the person turns the network on (an optional host permission), and their script runs
 * only while both Chrome allows it and HandsFreeOS says the network is on for them (../on.ts). There it reads only the
 * network's warnings as the person goes, notes none of their steps, and answers only Check <network>'s asks: a page
 * read and outlined, and a look for a step's button, never pressed.
 */
import { NETWORKS } from '@hfos/core/addons/outreach/networks';
import type {
  CodeAnswer,
  CodeAsk,
  OwnProfileAnswer,
  OwnProfileAsk,
  TryAnswer,
  TryAsk,
} from '../../messages';
import { isWholeAddress, type Kit } from '../kit';
import { outlineLooking, readLooking, readWarnings } from './read';
import type { LookingSite } from './site';

/** Answers a look (`hfos-try`), only on the kinds of page its step is for. */
async function look(site: LookingSite, ask: TryAsk): Promise<TryAnswer> {
  const step = site.looks[ask.step];
  if (!step) return { ok: false, error: `The extension doesn’t look for that on ${site.name}.` };
  const url = site.url(location.href);
  const kind = url ? site.kindOf(url) : 'other';
  if (!step.on.includes('*') && !step.on.includes(kind))
    return { ok: false, error: `${site.name} didn’t open the page that step is on.` };
  return { ok: true, tried: await step.look(document, location.href) };
}

/**
 * The person's own profile (decision 80): read it for the AI's check, or put the bio or the About in, where the site
 * has one, and a code it emailed where it asks for one (decision 82).
 */
async function ownProfile(site: LookingSite, ask: OwnProfileAsk): Promise<OwnProfileAnswer> {
  const own = site.ownProfile;
  if (!own)
    return { ok: false, error: `The extension doesn’t read your ${site.name} profile yet.` };
  if (ask.type === 'hfos-own-profile') return { ok: true, read: own.read(document, location.href) };
  if (ask.type === 'hfos-write-about')
    return own.writeAbout
      ? { ok: true, result: await own.writeAbout(document, ask.about) }
      : { ok: false, error: `${site.name} has no About to put in.` };
  if (!own.writeBio)
    return { ok: false, error: `The extension doesn’t put your ${site.name} bio in yet.` };
  return { ok: true, result: await own.writeBio(document, ask.bio) };
}

/** A code the network emailed them, put in where it asks for it (decision 82). */
async function putCode(site: LookingSite, ask: CodeAsk): Promise<CodeAnswer> {
  const put = site.ownProfile?.putCode;
  if (!put) return { ok: false, error: `${site.name} asks for no code here.` };
  return { ok: true, code: await put(document, ask.code) };
}

const OWN_PROFILE_ASKS = new Set(['hfos-own-profile', 'hfos-write-bio', 'hfos-write-about']);

export function lookingKit(site: LookingSite): Kit {
  return {
    platform: site.platform,
    network: NETWORKS[site.platform],
    hosts: site.hosts,
    optional: true,
    startsOn: false,
    owns: (href) => isWholeAddress(href) && site.url(href) !== null,
    workUrl: (href) => site.url(href)?.toString() ?? null,
    kindOf: (href) => {
      const url = site.url(href);
      return url ? site.kindOf(url) : 'other';
    },
    profileKey: (profile) =>
      `${site.platform}:${(profile.username ?? profile.id ?? profile.url).toLowerCase()}`,
    readPage: (doc, href) => readLooking(doc, href, site),
    readWarnings: (doc, href) => readWarnings(doc, href, site),
    readReplies: () => [],
    lookFor: () => 'warnings',
    noticer: () => site.noticer?.() ?? { click: () => null, enter: () => null },
    outline: (doc, href, options = {}) => outlineLooking(doc, href, site, options),
    work: (ask) =>
      ask.type === 'hfos-try'
        ? look(site, ask as TryAsk)
        : OWN_PROFILE_ASKS.has(ask.type)
          ? ownProfile(site, ask as OwnProfileAsk)
          : ask.type === 'hfos-put-code'
            ? putCode(site, ask as CodeAsk)
            : null,
  };
}
