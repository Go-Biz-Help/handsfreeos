/**
 * What the background asks a tab on Accounts Center for **Put these in** (docs/outreach.md, decision 89), the same for
 * Facebook's tabs (../facebook/work.ts) and Instagram's (../looking/kit.ts): the person's own profile among Profiles,
 * the new username or name on that profile's own page, and the network's warnings there. A tab answers only on its own
 * network's Accounts Center, and types only on the page of the profile whose number the ask carries.
 *
 * Runs in the tab, on the page in front of it: it uses the tab's own document and address.
 */
import { PLATFORMS } from '@hfos/core/addons/outreach/networks';
import type {
  AccountWarningsAnswer,
  AccountWarningsAsk,
  UsernamePageAnswer,
  UsernamePageAsk,
  WriteCenterNameAnswer,
  WriteCenterNameAsk,
  WriteUsernameAnswer,
  WriteUsernameAsk,
} from '../../messages';
import { writeName } from './name';
import {
  askingHere,
  centerAddress,
  centerPageOf,
  centerWarnings,
  onAccountsCenter,
  profileRowOn,
  profilesPage,
  type CenterNetwork,
} from './pages';
import { writeUsername } from './username';

/** The asks a tab answers on Accounts Center. */
export const CENTER_ASKS: ReadonlySet<string> = new Set([
  'hfos-write-username',
  'hfos-write-center-name',
  'hfos-username-page',
  'hfos-account-warnings',
]);

export type CenterAsk =
  WriteUsernameAsk | WriteCenterNameAsk | UsernamePageAsk | AccountWarningsAsk;
type CenterAnswer =
  WriteUsernameAnswer | WriteCenterNameAnswer | UsernamePageAnswer | AccountWarningsAnswer;

/** The network's warnings on any other page of its, after the person carried on there. */
type WarningsElsewhere = (doc: Document, href: string) => string[];

/**
 * Does one of the background's Accounts Center asks in this tab, on this network's own Accounts Center, and answers how
 * it went. `elsewhere` reads the network's warnings on its other pages.
 */
export async function centerWork(
  network: CenterNetwork,
  ask: CenterAsk,
  elsewhere: WarningsElsewhere,
): Promise<CenterAnswer> {
  const name = PLATFORMS[network];
  const href = location.href;
  switch (ask.type) {
    case 'hfos-write-username':
      // Only the username page of the profile whose number the job found as theirs, never another's.
      if (!ask.profile || centerPageOf(href, network, 'username') !== ask.profile)
        return { ok: false, error: `${name} didn’t open Accounts Center’s username page.` };
      return {
        ok: true,
        ...(await writeUsername(document, ask.username, { network, was: ask.was })),
      };
    case 'hfos-write-center-name':
      if (!ask.profile || centerPageOf(href, network, 'name') !== ask.profile)
        return { ok: false, error: `${name} didn’t open Accounts Center’s name page.` };
      return { ok: true, ...(await writeName(document, ask.name, network)) };
    case 'hfos-username-page': {
      // Its warnings are read only while the network asks the person for nothing: its "Confirm it's you" there is no
      // warning (decision 25).
      if (!profilesPage(href, network))
        return { ok: false, error: `${name} didn’t open Accounts Center’s Profiles.` };
      const asking = askingHere(document);
      if (asking) return { ok: true, url: null, profile: null, warnings: [], asking };
      const profile = profileRowOn(document, network, ask.username);
      return {
        ok: true,
        url: centerAddress(network, profile, 'username'),
        profile,
        warnings: centerWarnings(document, href, network),
        asking: null,
      };
    }
    case 'hfos-account-warnings': {
      // On Accounts Center, none while the network asks them for something, and never its answer about the name.
      if (!onAccountsCenter(href, network))
        return { ok: true, asking: null, warnings: elsewhere(document, href) };
      const asking = askingHere(document);
      return { ok: true, asking, warnings: asking ? [] : centerWarnings(document, href, network) };
    }
  }
}
