/**
 * Settings → Add-ons: the add-on names and dependency lines its cards draw. Everything the page says is the words the
 * web and the phone share (`ADDON_PAGE_WORDS`, `ADDON_STATE_WORDS`, `ADDON_MOVE_WORDS`, `addonCheckWords` and the
 * sentence helpers in @hfos/core), so the two say exactly the same thing. Browser-safe and pure.
 */
import { ADDON_CATALOG, findAddon, type AddonManifest } from '@hfos/core';

/** An add-on's name, from the catalogue, or its id when this build has no such add-on. */
export const addonName = (id: string): string => findAddon(ADDON_CATALOG, id)?.name ?? id;

/** One add-on another needs or works with, as its card lists it. */
export interface NeedLine {
  readonly addonId: string;
  readonly name: string;
  readonly why: string;
  readonly required: boolean;
}

/** What an add-on needs (required) and what it works with when it's there (optional), from its manifest. */
export const needsOf = (m: AddonManifest | undefined): NeedLine[] =>
  (m?.requires ?? []).map((d) => ({
    addonId: d.addon,
    name: addonName(d.addon),
    why: d.why,
    required: d.kind === 'required',
  }));
