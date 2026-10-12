/**
 * The build of the extension HandsFreeOS hands out (docs/outreach.md, decision 60), written by
 * `pnpm --filter @hfos/extension release` (apps/extension/scripts/release.mjs): its version, and where the web app
 * serves it. The address keeps its name from version to version, so a newer zip unzips over the same folder; the
 * version on the end only makes browsers fetch the newer one. Don't change it by hand.
 */
export const EXTENSION_RELEASE = {
  version: '0.26.0',
  /** On the web app, beside the page that links to it. */
  path: '/downloads/hfos-social.zip?v=0.26.0',
  /** How big the download is, for the line beside the button. */
  bytes: 580517,
} as const;
