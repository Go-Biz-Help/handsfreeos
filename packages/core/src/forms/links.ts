/**
 * Where a published form lives: `/f/<site>/<form>`, on HandsFreeOS's own address or the business's domain (M17).
 *
 * The shape is a promise to every customer already holding a link, so it is written once, here: the web's Share tab
 * and the phone's share sheet both build from it. Browser-safe.
 */
export const publicFormPath = (site: string, slug: string): string => `/f/${site}/${slug}`;

/**
 * The code a business pastes into its own website to show a form there (Share → On your own website): the form in a
 * frame, and the line that fits the frame to the form. The frame opens the form's public link (`publicUrl`, on the
 * business's own domain when one is serving); the line always loads from the app's own address (`appOrigin`), since a
 * business's domain serves its pages, not our scripts. The Share tab copies it, and the Assistant hands out the same.
 */
export const formEmbedSnippet = (f: {
  readonly publicUrl: string;
  readonly appOrigin: string;
  readonly name: string;
}): string =>
  `<iframe src="${f.publicUrl}?embed=1" title="${f.name}" width="100%" height="720" style="border:0" loading="lazy"></iframe>\n<script src="${f.appOrigin}/embed/v1/form.js" async></script>`;
